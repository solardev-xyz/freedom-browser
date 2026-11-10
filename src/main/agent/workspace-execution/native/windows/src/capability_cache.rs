//! Remove expired per-command capabilities without changing workspace identities.
//! Publication and Codex's subsequent refresh/token creation share StartupLock.
use anyhow::{bail, Result};
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::io::{ErrorKind, Read};
use std::path::Path;
use super::startup_lock::StartupLock;

const PREFIX: &str = "freedom-win-workspace-";
const CLEANUP_TRIGGER: usize = 32;
const MAX_MISSING_ROOT_CHECKS: usize = 1024;

fn temporary_name(name: &str) -> bool {
    name.strip_prefix(PREFIX).is_some_and(|suffix|
        suffix.len() == 6 && suffix.bytes().all(|byte| byte.is_ascii_alphanumeric()))
}

fn path_key(path: &Path) -> String {
    codex_windows_sandbox::canonicalize_path(path).to_string_lossy()
        .replace('\\', "/").to_ascii_lowercase()
}

fn is_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

pub(super) fn prune(home: &Path, current_temp: &Path, guard: &StartupLock) -> Result<usize> {
    prune_with_writer(home, current_temp, guard, CLEANUP_TRIGGER, codex_windows_sandbox::write_file_atomically)
}

fn prune_with_writer(home: &Path, current_temp: &Path, guard: &StartupLock, minimum_entries: usize,
    publish: impl FnOnce(&Path, &[u8]) -> Result<()>) -> Result<usize> {
    if !guard.is_held() { bail!("Capability cleanup requires the startup lock"); }
    // Cleanup is optional. A busy file, unusual ACL, unavailable directory or
    // failed atomic replacement must leave ordinary startup available.
    Ok(prune_locked(home, current_temp, minimum_entries, publish).unwrap_or(0))
}

fn prune_locked(home: &Path, current_temp: &Path, minimum_entries: usize,
    publish: impl FnOnce(&Path, &[u8]) -> Result<()>) -> Result<usize> {
    use std::os::windows::fs::OpenOptionsExt;
    if !current_temp.is_absolute() || !current_temp.file_name().and_then(|v| v.to_str()).is_some_and(temporary_name) {
        return Ok(0);
    }
    let metadata = match fs::symlink_metadata(current_temp) { Ok(value) => value, Err(_) => return Ok(0) };
    if !metadata.is_dir() || is_reparse(&metadata) { return Ok(0); }
    let current = codex_windows_sandbox::canonicalize_path(current_temp);
    let Some(parent) = current.parent() else { return Ok(0) };
    let prefix = format!("{}/", path_key(parent).trim_end_matches('/'));
    // No UNC/device roots. A failed or ambiguous parent read preserves entries.
    if prefix.starts_with("//") { return Ok(0); }
    // Resolve an AppData/profile junction before using the pinned writer,
    // which deliberately refuses reparse components in its destination path.
    let file = codex_windows_sandbox::canonicalize_path(home).join("cap_sid");
    let mut input = match fs::OpenOptions::new().read(true).custom_flags(0x00200000).open(&file) {
        Ok(value) => value,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error.into()),
    };
    let metadata = input.metadata()?;
    if !metadata.is_file() || is_reparse(&metadata) { bail!("Unsafe sandbox capability cache"); }
    let mut bytes = Vec::new();
    input.read_to_end(&mut bytes)?;
    drop(input);
    // Unsupported/legacy/corrupt data is not repaired or reset by cleanup.
    let Ok(mut cache) = serde_json::from_slice::<Value>(&bytes) else { return Ok(0) };
    if !cache.get("workspace").is_some_and(Value::is_string) || !cache.get("readonly").is_some_and(Value::is_string) {
        return Ok(0);
    }
    let Some(entries) = cache.get_mut("writable_root_by_path").and_then(Value::as_object_mut) else { return Ok(0) };
    if !entries.values().all(Value::is_string) { return Ok(0); }
    let eligible = |key: &str| key.strip_prefix(&prefix).is_some_and(temporary_name);
    // Batch normal cleanup so a small cache does not enumerate a busy system
    // TEMP directory or replace the cache on every command.
    if entries.keys().filter(|key| eligible(key)).count() < minimum_entries { return Ok(0); }
    // Match directory names case-insensitively even on a case-sensitive NTFS
    // directory: the pinned library lowercases every cache key. Keep links and
    // files too, including dangling links, and never traverse their contents.
    let directory = match fs::read_dir(parent) { Ok(value) => value, Err(_) => return Ok(0) };
    let children: std::io::Result<HashSet<String>> = directory.map(|entry|
        entry.map(|entry| entry.file_name().to_string_lossy().to_ascii_lowercase())).collect();
    let children = match children { Ok(value) => value, Err(_) => return Ok(0) };
    let before = entries.len();
    let mut missing_checks = 0;
    entries.retain(|key, _| {
        if !eligible(key) { return true; }
        let name = &key[prefix.len()..];
        if children.contains(name) { return true; }
        // A large pre-upgrade backlog must not monopolise the startup lock.
        // Remaining candidates are handled by later starts.
        if missing_checks == MAX_MISSING_ROOT_CHECKS { return true; }
        missing_checks += 1;
        // Only a definite absence is disposable. Access/IO errors retain it.
        !matches!(fs::symlink_metadata(key), Err(error) if error.kind() == ErrorKind::NotFound)
    });
    let removed = before - entries.len();
    if removed != 0 {
        // The pinned writer stages a fresh file and atomically renames it using
        // a pinned, non-reparse parent handle. It never truncates the original.
        publish(&file, &serde_json::to_vec(&cache)?)?;
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Content/error-path fixtures use a one-entry trigger. Production's batched
    // trigger is checked separately below and by the native workload qualifier.
    fn prune(home: &Path, temp: &Path, guard: &StartupLock) -> Result<usize> {
        prune_with_writer(home, temp, guard, 1, codex_windows_sandbox::write_file_atomically)
    }

    fn junction(link: &Path, target: &Path) -> Result<()> {
        let cmd = std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
            .join("System32").join("cmd.exe");
        let link = codex_windows_sandbox::canonicalize_path(link.parent().unwrap()).join(link.file_name().unwrap());
        let target = codex_windows_sandbox::canonicalize_path(target);
        let output = std::process::Command::new(cmd).args(["/d", "/c", "mklink", "/J"])
            .arg(&link).arg(&target).output()?;
        assert!(output.status.success(), "Owned junction fixture failed: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        Ok(())
    }

    struct Fixture { home: std::path::PathBuf, temp: std::path::PathBuf, guard: Option<StartupLock> }
    impl Fixture {
        fn new() -> Result<Self> {
            let home = std::env::temp_dir().join(format!("freedom-cap-cleanup-{}-{}", std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos()));
            fs::create_dir(&home)?;
            let temp = home.join("freedom-win-workspace-active");
            fs::create_dir(&temp)?;
            let mut guard = StartupLock::open(&home, None)?;
            assert!(guard.try_acquire()?);
            Ok(Self { home, temp, guard: Some(guard) })
        }
        fn key(&self, name: &str) -> String { path_key(&self.home).trim_end_matches('/').to_owned() + "/" + name }
        fn save(&self, entries: Value) -> Result<Value> {
            let value = json!({"workspace":"workspace-id","readonly":"read-id",
                "workspace_by_cwd":{"keep-project":"project-id"},"future_field":{"keep":true},
                "writable_root_by_path":entries});
            fs::write(self.home.join("cap_sid"), serde_json::to_vec(&value)?)?;
            Ok(value)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            drop(self.guard.take());
            let _ = fs::remove_dir_all(&self.home);
        }
    }

    #[test]
    fn prunes_only_missing_direct_owned_names_preserving_all_other_data() -> Result<()> {
        let fixture = Fixture::new()?;
        let active = fixture.key("freedom-win-workspace-active");
        let missing = fixture.key("freedom-win-workspace-gone01");
        let foreign = fixture.key("other-app-gone01");
        let nested = fixture.key("nested/freedom-win-workspace-gone02");
        let wrong_suffix = fixture.key("freedom-win-workspace-not-a-run");
        let elsewhere = path_key(fixture.home.parent().unwrap()) + "/freedom-win-workspace-gone03";
        let original = fixture.save(json!({active.clone():"active-id",missing.clone():"expired-id",foreign:"foreign-id",
            nested:"nested-id",wrong_suffix:"unknown-id",elsewhere:"elsewhere-id"}))?;
        assert_eq!(prune(&fixture.home, &fixture.temp, fixture.guard.as_ref().unwrap())?, 1);
        let mut expected = original;
        expected["writable_root_by_path"].as_object_mut().unwrap().remove(&missing);
        assert_eq!(serde_json::from_slice::<Value>(&fs::read(fixture.home.join("cap_sid"))?)?, expected);
        assert_eq!(prune(&fixture.home, &fixture.temp, fixture.guard.as_ref().unwrap())?, 0);
        Ok(())
    }

    #[test]
    fn keeps_existing_case_variant_files() -> Result<()> {
        let fixture = Fixture::new()?;
        fs::write(fixture.home.join("freedom-win-workspace-AbCd01"), "keep")?;
        let original = fixture.save(json!({fixture.key("freedom-win-workspace-abcd01"):"file-id"}))?;
        assert_eq!(prune(&fixture.home, &fixture.temp, fixture.guard.as_ref().unwrap())?, 0);
        assert_eq!(serde_json::from_slice::<Value>(&fs::read(fixture.home.join("cap_sid"))?)?, original);
        Ok(())
    }

    #[test]
    fn unsupported_or_malformed_cache_is_left_byte_for_byte_unchanged() -> Result<()> {
        let fixture = Fixture::new()?;
        for bytes in [b"{truncated".as_slice(), b"legacy-workspace-sid", b"{\"writable_root_by_path\":{}}"] {
            fs::write(fixture.home.join("cap_sid"), bytes)?;
            assert_eq!(prune(&fixture.home, &fixture.temp, fixture.guard.as_ref().unwrap())?, 0);
            assert_eq!(fs::read(fixture.home.join("cap_sid"))?, bytes);
        }
        Ok(())
    }

    #[test]
    fn failed_publication_never_truncates_the_cache() -> Result<()> {
        let fixture = Fixture::new()?;
        fixture.save(json!({fixture.key("freedom-win-workspace-gone01"):"expired-id"}))?;
        let before = fs::read(fixture.home.join("cap_sid"))?;
        assert_eq!(prune_with_writer(&fixture.home, &fixture.temp, fixture.guard.as_ref().unwrap(), 1,
            |_, _| bail!("Injected publication failure"))?, 0);
        assert_eq!(fs::read(fixture.home.join("cap_sid"))?, before);
        assert_eq!(prune(&fixture.home, &fixture.temp, fixture.guard.as_ref().unwrap())?, 1);
        Ok(())
    }

    #[test]
    fn cleanup_refuses_an_unheld_lock_and_ignores_unknown_temp_locations() -> Result<()> {
        let mut fixture = Fixture::new()?;
        fixture.save(json!({fixture.key("freedom-win-workspace-gone01"):"expired-id"}))?;
        let before = fs::read(fixture.home.join("cap_sid"))?;
        assert_eq!(prune(&fixture.home, &fixture.home, fixture.guard.as_ref().unwrap())?, 0);
        drop(fixture.guard.take());
        let unheld = StartupLock::open(&fixture.home, None)?;
        assert!(prune(&fixture.home, &fixture.temp, &unheld).is_err());
        assert_eq!(fs::read(fixture.home.join("cap_sid"))?, before);
        Ok(())
    }

    #[test]
    fn dangling_junction_is_preserved_without_following_it() -> Result<()> {
        let fixture = Fixture::new()?;
        let link = fixture.home.join("freedom-win-workspace-link01");
        let target = fixture.home.join("absent-target");
        fs::create_dir(&target)?;
        junction(&link, &target)?;
        fs::remove_dir(&target)?;
        let before = fixture.save(json!({fixture.key("freedom-win-workspace-link01"):"link-id"}))?;
        assert_eq!(prune(&fixture.home, &fixture.temp, fixture.guard.as_ref().unwrap())?, 0);
        assert_eq!(serde_json::from_slice::<Value>(&fs::read(fixture.home.join("cap_sid"))?)?, before);
        assert!(!target.exists());
        Ok(())
    }

    #[test]
    fn removes_an_accumulated_backlog_without_touching_other_fields() -> Result<()> {
        let fixture = Fixture::new()?;
        let entries: serde_json::Map<String, Value> = (0..1500).map(|i|
            (fixture.key(&format!("freedom-win-workspace-z{i:05}")), json!(format!("expired-{i}")))).collect();
        let before = fixture.save(Value::Object(entries))?;
        assert_eq!(super::prune(&fixture.home, &fixture.temp, fixture.guard.as_ref().unwrap())?, MAX_MISSING_ROOT_CHECKS);
        assert_eq!(super::prune(&fixture.home, &fixture.temp, fixture.guard.as_ref().unwrap())?, 1500 - MAX_MISSING_ROOT_CHECKS);
        let after: Value = serde_json::from_slice(&fs::read(fixture.home.join("cap_sid"))?)?;
        assert_eq!(after["workspace_by_cwd"], before["workspace_by_cwd"]);
        assert_eq!(after["future_field"], before["future_field"]);
        assert!(after["writable_root_by_path"].as_object().unwrap().is_empty());
        Ok(())
    }

    #[test]
    fn small_cache_skips_enumeration_and_publication_until_the_batch_trigger() -> Result<()> {
        let fixture = Fixture::new()?;
        fixture.save(json!({fixture.key("freedom-win-workspace-gone01"):"expired-id"}))?;
        let before = fs::read(fixture.home.join("cap_sid"))?;
        assert_eq!(super::prune(&fixture.home, &fixture.temp, fixture.guard.as_ref().unwrap())?, 0);
        assert_eq!(fs::read(fixture.home.join("cap_sid"))?, before);
        Ok(())
    }

    #[test]
    fn missing_cache_is_not_created_by_cleanup() -> Result<()> {
        let fixture = Fixture::new()?;
        assert_eq!(prune(&fixture.home, &fixture.temp, fixture.guard.as_ref().unwrap())?, 0);
        assert!(!fixture.home.join("cap_sid").exists());
        Ok(())
    }

    #[test]
    fn cache_held_open_without_delete_sharing_is_skipped_and_kept_intact() -> Result<()> {
        use std::os::windows::fs::OpenOptionsExt;
        let fixture = Fixture::new()?;
        fixture.save(json!({fixture.key("freedom-win-workspace-gone01"):"expired-id"}))?;
        let before = fs::read(fixture.home.join("cap_sid"))?;
        let held = fs::OpenOptions::new().read(true).share_mode(3).open(fixture.home.join("cap_sid"))?;
        assert_eq!(prune(&fixture.home, &fixture.temp, fixture.guard.as_ref().unwrap())?, 0);
        assert_eq!(fs::read(fixture.home.join("cap_sid"))?, before);
        assert!(!fs::read_dir(&fixture.home)?.any(|entry| entry.unwrap().file_name().to_string_lossy().starts_with("sandbox-")));
        drop(held);
        assert_eq!(prune(&fixture.home, &fixture.temp, fixture.guard.as_ref().unwrap())?, 1);
        Ok(())
    }

    #[test]
    fn resolves_a_junctioned_home_and_does_not_replace_a_reparse_cache() -> Result<()> {
        let fixture = Fixture::new()?;
        let alias = fixture.home.join("home-alias");
        junction(&alias, &fixture.home)?;
        fixture.save(json!({fixture.key("freedom-win-workspace-gone01"):"expired-id"}))?;
        assert_eq!(prune(&alias, &fixture.temp, fixture.guard.as_ref().unwrap())?, 1);
        fs::remove_file(fixture.home.join("cap_sid"))?;
        let target = fixture.home.join("owned-cache-target");
        fs::create_dir(&target)?;
        fs::write(target.join("sentinel"), "preserved")?;
        junction(&fixture.home.join("cap_sid"), &target)?;
        assert_eq!(prune(&fixture.home, &fixture.temp, fixture.guard.as_ref().unwrap())?, 0);
        assert!(is_reparse(&fs::symlink_metadata(fixture.home.join("cap_sid"))?));
        assert_eq!(fs::read_to_string(target.join("sentinel"))?, "preserved");
        Ok(())
    }

    #[test]
    #[ignore]
    fn interrupted_writer_child() -> Result<()> {
        let home = std::path::PathBuf::from(std::env::var_os("FREEDOM_CACHE_CLEANUP_FIXTURE").expect("Owned fixture"));
        let mut guard = StartupLock::open(&home, None)?;
        assert!(guard.try_acquire()?);
        prune_with_writer(&home, &home.join("freedom-win-workspace-active"), &guard, 1, |_, _| {
            fs::write(home.join("abandoned-test-stage.tmp"), b"{partial")?;
            // Fault injection before publication, after writing an incomplete
            // staging file. Process exit must release the OS startup lock.
            std::process::exit(91);
        })?;
        bail!("Interruption fixture did not reach publication")
    }

    #[test]
    fn interrupted_cleanup_preserves_original_and_next_start_can_finish() -> Result<()> {
        let mut fixture = Fixture::new()?;
        fixture.save(json!({fixture.key("freedom-win-workspace-gone01"):"expired-id"}))?;
        let before = fs::read(fixture.home.join("cap_sid"))?;
        drop(fixture.guard.take());
        let child_test = format!("{}::interrupted_writer_child", module_path!().split_once("::").unwrap().1);
        let status = std::process::Command::new(std::env::current_exe()?)
            .args(["--ignored", "--exact", &child_test, "--nocapture"])
            .env("FREEDOM_CACHE_CLEANUP_FIXTURE", &fixture.home).status()?;
        assert_eq!(status.code(), Some(91));
        assert_eq!(fs::read(fixture.home.join("cap_sid"))?, before);
        let mut guard = StartupLock::open(&fixture.home, None)?;
        assert!(guard.try_acquire()?);
        assert_eq!(prune(&fixture.home, &fixture.temp, &guard)?, 1);
        Ok(())
    }
}
