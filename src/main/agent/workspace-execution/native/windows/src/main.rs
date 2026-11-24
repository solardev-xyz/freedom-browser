//! Freedom's private, versioned control protocol. Workload output is always
//! base64 inside output frames; it can never impersonate a lifecycle frame.
use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use codex_protocol::config_types::{WindowsSandboxLevel, WindowsSandboxProxySettingsMode};
use codex_protocol::models::PermissionProfile;
use codex_protocol::permissions::{FileSystemSandboxPolicy, FileSystemSandboxEntry, FileSystemPath, FileSystemAccessMode};
use codex_protocol::protocol::NetworkSandboxPolicy;
use codex_utils_absolute_path::AbsolutePathBuf;
use codex_windows_sandbox::{WindowsSandboxProvisioningSettings, WindowsSandboxSessionRequest};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::time::Duration;
use std::os::windows::io::AsRawHandle;
use std::os::windows::fs::OpenOptionsExt;
use std::io::Read;

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetFinalPathNameByHandleW(handle: *mut std::ffi::c_void, path: *mut u16, length: u32, flags: u32) -> u32;
    fn GetFileInformationByHandle(handle: *mut std::ffi::c_void, information: *mut u32) -> i32;
    fn SetDefaultDllDirectories(flags: u32) -> i32;
}
const LOAD_LIBRARY_SEARCH_SYSTEM32: u32 = 0x800;

/// The helpers live in a user-writable install directory. Static imports are
/// resolved from System32 by the link-time /DEPENDENTLOADFLAG (see
/// scripts/build-windows-workspace.js); this covers every later runtime load.
fn restrict_dll_search() -> Result<()> {
    if unsafe { SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32) } == 0 {
        bail!("Cannot restrict the DLL search path");
    }
    Ok(())
}
#[link(name = "crypt32")]
unsafe extern "system" {
    fn CryptHashCertificate2(algorithm: *const u16, flags: u32, reserved: *mut std::ffi::c_void,
        input: *const u8, length: u32, output: *mut u8, output_length: *mut u32) -> i32;
}

fn sha256(bytes: &[u8]) -> Result<String> {
    let algorithm: Vec<u16> = "SHA256\0".encode_utf16().collect();
    let mut output = [0u8; 32];
    let mut length = 32u32;
    if unsafe { CryptHashCertificate2(algorithm.as_ptr(), 0, std::ptr::null_mut(), bytes.as_ptr(),
        bytes.len().try_into()?, output.as_mut_ptr(), &mut length) } == 0 || length != 32 {
        bail!("Cannot verify sandbox artifact");
    }
    Ok(output.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn lock_runtime(expected: &HashMap<String, String>) -> Result<Vec<std::fs::File>> {
    let executable = std::env::current_exe()?;
    let directory = executable.parent().context("Missing runtime directory")?;
    lock_runtime_directory(directory, expected)
}

fn lock_runtime_directory(directory: &std::path::Path, expected: &HashMap<String, String>) -> Result<Vec<std::fs::File>> {
    // Deny write and delete sharing through elevation. This pins both the
    // verified bytes and their containing directory until setup returns.
    let mut locks = vec![std::fs::OpenOptions::new().read(true).share_mode(1)
        .custom_flags(0x02000000).open(directory)?];
    for name in ["freedom-windows-workspace.exe", "freedom-windows-sandbox-setup.exe", "freedom-workspace-runner.exe"] {
        let mut file = std::fs::OpenOptions::new().read(true).share_mode(1).open(directory.join(name))?;
        if file.metadata()?.len() > 128 * 1024 * 1024 { bail!("Oversized sandbox artifact"); }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        if expected.get(name) != Some(&sha256(&bytes)?) { bail!("Sandbox artifact changed before elevation"); }
        locks.push(file);
    }
    Ok(locks)
}

fn read_workspace_file(root: &std::path::Path, relative: &std::path::Path, maximum: u64) -> Result<Vec<u8>> {
    if !root.is_absolute() || relative.is_absolute() || maximum > 50 * 1024 * 1024 ||
        relative.components().any(|part| !matches!(part, std::path::Component::Normal(_))) {
        bail!("Invalid workspace read");
    }
    let mut file = std::fs::OpenOptions::new().read(true).custom_flags(0x00200000).open(root.join(relative))?;
    let mut pathname = vec![0u16; 32768];
    let length = unsafe { GetFinalPathNameByHandleW(file.as_raw_handle(), pathname.as_mut_ptr(), pathname.len() as u32, 0) };
    let mut information = [0u32; 13];
    if length == 0 || length as usize >= pathname.len() ||
        unsafe { GetFileInformationByHandle(file.as_raw_handle(), information.as_mut_ptr()) } == 0 ||
        information[0] & (0x10 | 0x400) != 0 || information[10] != 1 {
        bail!("Unsafe workspace file");
    }
    let final_path = String::from_utf16(&pathname[..length as usize])?.trim_start_matches("\\\\?\\").to_lowercase();
    let root_path = root.to_string_lossy().trim_start_matches("\\\\?\\").trim_end_matches(['\\', '/']).to_lowercase();
    if !final_path.starts_with(&(root_path + "\\")) || file.metadata()?.len() > maximum {
        bail!("Opened file escaped its workspace or exceeded its size limit");
    }
    let mut bytes = Vec::new();
    file.take(maximum + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > maximum { bail!("Workspace file grew beyond its size limit"); }
    Ok(bytes)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Request {
    version: u32,
    operation: String,
    backend: String,
    home: PathBuf,
    #[serde(default)]
    cleanup_path: PathBuf,
    #[serde(default)]
    cleanup_parent: PathBuf,
    #[serde(default)]
    binary_hashes: HashMap<String, String>,
    #[serde(default)]
    read_path: PathBuf,
    #[serde(default)]
    max_read_bytes: u64,
    #[serde(default)]
    user: String,
    #[serde(default)]
    command: Vec<String>,
    #[serde(default)]
    cwd: PathBuf,
    #[serde(default)]
    workspace: PathBuf,
    #[serde(default)]
    writable_roots: Vec<PathBuf>,
    #[serde(default)]
    protected_paths: Vec<PathBuf>,
    #[serde(default)]
    environment: HashMap<String, String>,
    #[serde(default)]
    network: bool,
    #[serde(default = "default_timeout")]
    timeout_ms: u64,
}

fn default_timeout() -> u64 { 120_000 }

fn emit(value: serde_json::Value) -> Result<()> {
    let mut output = std::io::stdout().lock();
    serde_json::to_writer(&mut output, &value)?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
}

// Bound untrusted control input before allocating an entire line.
fn read_line(reader: &mut impl BufRead, limit: usize) -> Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    loop {
        let bytes = reader.fill_buf()?;
        if bytes.is_empty() { return Ok(if line.is_empty() { None } else { Some(line) }); }
        let count = bytes.iter().position(|byte| *byte == b'\n').map_or(bytes.len(), |i| i + 1);
        if line.len() + count > limit { bail!("Control frame is too large"); }
        let complete = bytes[count - 1] == b'\n';
        line.extend_from_slice(&bytes[..count]);
        reader.consume(count);
        if complete { return Ok(Some(line)); }
    }
}

fn validate_execution_network(operation: &str, network: bool) -> Result<()> {
    match (operation, network) {
        ("execute", true) | ("execute-file-helper", false) => Ok(()),
        ("execute", false) => bail!("WINDOWS_OFFLINE_COMMAND_UNAVAILABLE"),
        _ => bail!("Invalid execution operation and network policy"),
    }
}

async fn run(request: Request, mut controls: tokio::sync::mpsc::Receiver<Vec<u8>>) -> Result<()> {
    if request.version != 1 || request.backend != "elevated" || !request.home.is_absolute() {
        bail!("Unsupported sandbox request");
    }
    match request.operation.as_str() {
        "read-file" => {
            let bytes = read_workspace_file(&request.workspace, &request.read_path, request.max_read_bytes)?;
            let encoded = STANDARD.encode(bytes);
            emit(json!({"type":"ready"}))?;
            for part in encoded.as_bytes().chunks(65536) {
                emit(json!({"type":"stdout", "data":STANDARD.encode(part)}))?;
            }
            return emit(json!({"type":"exit", "exitCode":0, "reason":"exited"}));
        }
        "remove-tree" => {
            let target = &request.cleanup_path;
            let name = target.file_name().and_then(|name| name.to_str()).unwrap_or("");
            if !target.is_absolute() || !request.cleanup_parent.is_absolute()
                || target.parent() != Some(request.cleanup_parent.as_path())
                || !(name.starts_with("freedom-win-workspace-") || name.starts_with("workspace_"))
                || target.components().any(|part| matches!(part, std::path::Component::ParentDir)) {
                bail!("Invalid cleanup directory");
            }
            // Rust's Windows implementation opens children relative to parent
            // handles and removes reparse points as links (CVE-2022-21658 fix).
            match std::fs::remove_dir_all(target) {
                Ok(()) => {},
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
                Err(error) => return Err(error.into()),
            }
            return emit(json!({"type":"removed"}));
        }
        "probe" => return emit(json!({"type":"capabilities", "version":1, "backend":"elevated",
            "setupComplete":codex_windows_sandbox::sandbox_setup_is_complete(&request.home)})),
        "setup" => {
            if request.user.is_empty() { bail!("Setup requires the standard user's identity"); }
            codex_windows_sandbox::run_elevated_provisioning_setup(&request.home, &request.user,
                WindowsSandboxProvisioningSettings::default())?;
            return emit(json!({"type":"setup", "complete":true}));
        }
        "setup-interactive" => {
            let _runtime_locks = lock_runtime(&request.binary_hashes)?;
            std::fs::create_dir_all(&request.home)?;
            let permissions = codex_windows_sandbox::ResolvedWindowsSandboxPermissions::try_from_permission_profile(&PermissionProfile::read_only())?;
            codex_windows_sandbox::run_elevated_setup(codex_windows_sandbox::SandboxSetupRequest {
                permissions: &permissions, command_cwd: &request.home, env_map: &HashMap::new(),
                codex_home: &request.home, proxy_enforced: false,
            })?;
            return emit(json!({"type":"setup", "complete":true}));
        }
        "execute" | "execute-file-helper" => validate_execution_network(&request.operation, request.network)?,
        _ => bail!("Unsupported operation"),
    }
    // Provisioning is a separate explicit action, never an execution side effect.
    if !codex_windows_sandbox::sandbox_setup_is_complete(&request.home) {
        bail!("WINDOWS_SANDBOX_SETUP_REQUIRED");
    }
    if request.command.is_empty() || request.timeout_ms == 0 || request.timeout_ms > 1_800_000 {
        bail!("Invalid execution request");
    }
    let workspace = AbsolutePathBuf::try_from(request.workspace)?;
    let roots = vec![workspace];
    let writable: Vec<AbsolutePathBuf> = request.writable_roots.iter().cloned()
        .map(AbsolutePathBuf::try_from).collect::<Result<_, _>>()?;
    let denied: Vec<AbsolutePathBuf> = request.protected_paths.into_iter()
        .map(AbsolutePathBuf::try_from).collect::<Result<_, _>>()?;
    let network = if request.network { NetworkSandboxPolicy::Enabled } else { NetworkSandboxPolicy::Restricted };
    // Do not use the workspace-write preset: it implicitly grants the workspace
    // even for read-only file operations. Every write root must be explicit.
    let mut filesystem = FileSystemSandboxPolicy::read_only();
    for root in writable {
        filesystem.entries.push(FileSystemSandboxEntry::new(FileSystemPath::Path { path: root.into() }, FileSystemAccessMode::Write));
    }
    for root in &denied {
        filesystem.entries.push(FileSystemSandboxEntry::new(FileSystemPath::Path { path: root.clone().into() }, FileSystemAccessMode::Read));
    }
    let profile = PermissionProfile::from_runtime_permissions(&filesystem, network);
    let mut process = codex_windows_sandbox::spawn_windows_sandbox_session_for_level(WindowsSandboxSessionRequest {
        permission_profile: &profile,
        workspace_roots: &roots,
        codex_home: &request.home,
        command: request.command,
        cwd: &request.cwd,
        env_map: request.environment,
        windows_sandbox_level: WindowsSandboxLevel::Elevated,
        proxy_enforced: false,
        network_proxy_restricting_sid: None,
        proxy_settings_mode: WindowsSandboxProxySettingsMode::Preserve,
        timeout_ms: Some(request.timeout_ms),
        read_roots_override: None,
        read_roots_include_platform_defaults: true,
        write_roots_override: Some(&request.writable_roots),
        deny_read_paths_override: &[],
        deny_write_paths_override: &denied,
        tty: false,
        stdin_open: true,
    }).await?;
    emit(json!({"type":"ready"}))?;
    let deadline = tokio::time::sleep(Duration::from_millis(request.timeout_ms));
    tokio::pin!(deadline);
    let mut stdout_open = true;
    let mut stderr_open = true;
    let mut reason = "exited";
    let exit_code;
    loop {
        tokio::select! {
            output = process.stdout_rx.recv(), if stdout_open => match output {
                Some(bytes) => emit(json!({"type":"stdout", "data":STANDARD.encode(bytes)}))?,
                None => stdout_open = false,
            },
            output = process.stderr_rx.recv(), if stderr_open => match output {
                Some(bytes) => emit(json!({"type":"stderr", "data":STANDARD.encode(bytes)}))?,
                None => stderr_open = false,
            },
            control = controls.recv() => {
                let value = control.and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
                if value.as_ref().and_then(|v| v["type"].as_str()) == Some("stdin") {
                    let bytes = STANDARD.decode(value.as_ref().and_then(|v| v["data"].as_str()).unwrap_or(""))?;
                    process.session.writer_sender().send(bytes).await.ok();
                } else {
                    reason = "cancelled";
                    process.session.request_terminate();
                    exit_code = tokio::time::timeout(Duration::from_secs(5), &mut process.exit_rx).await.ok().and_then(Result::ok).unwrap_or(-1);
                    break;
                }
            },
            _ = &mut deadline => {
                reason = "timed_out";
                process.session.request_terminate();
                exit_code = tokio::time::timeout(Duration::from_secs(5), &mut process.exit_rx).await.ok().and_then(Result::ok).unwrap_or(-1);
                break;
            },
            code = &mut process.exit_rx => { exit_code = code.unwrap_or(-1); break; },
        }
    }
    // Drain final pipe messages before releasing the session. A crashed runner
    // must not make output drainage hang forever.
    let drain = async {
        while stdout_open || stderr_open {
            tokio::select! {
                output = process.stdout_rx.recv(), if stdout_open => match output {
                    Some(bytes) => emit(json!({"type":"stdout", "data":STANDARD.encode(bytes)}))?,
                    None => stdout_open = false,
                },
                output = process.stderr_rx.recv(), if stderr_open => match output {
                    Some(bytes) => emit(json!({"type":"stderr", "data":STANDARD.encode(bytes)}))?,
                    None => stderr_open = false,
                },
            }
        }
        Ok::<_, anyhow::Error>(())
    };
    let _ = tokio::time::timeout(Duration::from_secs(2), drain).await;
    process.session.terminate();
    emit(json!({"type":"exit", "exitCode":exit_code, "reason":reason}))
}

fn main() {
    let result = (|| -> Result<()> {
        restrict_dll_search()?;
        let mut reader = std::io::BufReader::new(std::io::stdin());
        let line = read_line(&mut reader, 32 * 1024 * 1024)?.context("Missing request")?;
        let request: Request = serde_json::from_slice(&line)?;
        let (tx, rx) = tokio::sync::mpsc::channel(8);
        std::thread::spawn(move || {
            while let Ok(Some(line)) = read_line(&mut reader, 256 * 1024) {
                if tx.blocking_send(line).is_err() { break; }
            }
        });
        tokio::runtime::Builder::new_multi_thread().enable_all().build()?.block_on(run(request, rx))
    })();
    if let Err(error) = result {
        let _ = emit(json!({"type":"error", "message":format!("{error:#}")}));
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetModuleHandleW(name: *const u16) -> *const u8;
        fn LoadLibraryW(name: *const u16) -> *mut std::ffi::c_void;
        fn LoadLibraryExW(name: *const u16, file: *mut std::ffi::c_void, flags: u32) -> *mut std::ffi::c_void;
        fn FreeLibrary(module: *mut std::ffi::c_void) -> i32;
        fn SetErrorMode(mode: u32) -> u32;
    }
    const LOAD_LIBRARY_SEARCH_APPLICATION_DIR: u32 = 0x200;

    fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain([0]).collect() }
    fn system32() -> PathBuf {
        PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into())).join("System32")
    }

    #[test]
    fn dll_search_skips_a_library_planted_beside_the_executable() -> Result<()> {
        let name = format!("freedom-planted-{}.dll", std::process::id());
        let planted = std::env::current_exe()?.parent().context("Missing executable directory")?.join(&name);
        std::fs::copy(system32().join("version.dll"), &planted)?;
        let result = (|| -> Result<()> {
            restrict_dll_search()?;
            let module = unsafe { LoadLibraryW(wide(&name).as_ptr()) };
            if !module.is_null() { unsafe { FreeLibrary(module) }; bail!("A planted DLL loaded from the executable directory"); }
            // Control: the planted copy itself is loadable when its directory is searched explicitly.
            let module = unsafe { LoadLibraryExW(wide(&name).as_ptr(), std::ptr::null_mut(),
                LOAD_LIBRARY_SEARCH_APPLICATION_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32) };
            if module.is_null() { bail!("The planted control DLL is not loadable"); }
            unsafe { FreeLibrary(module) };
            Ok(())
        })();
        std::fs::remove_file(&planted)?;
        result
    }

    fn image_dependent_load_flags(base: *const u8) -> u16 {
        unsafe {
            let header = base.add(std::ptr::read_unaligned(base.add(0x3c) as *const u32) as usize);
            assert_eq!(std::ptr::read_unaligned(header as *const u32), 0x4550);
            let optional = header.add(24);
            assert_eq!(std::ptr::read_unaligned(optional as *const u16), 0x20b);
            let rva = std::ptr::read_unaligned(optional.add(112 + 10 * 8) as *const u32) as usize;
            assert_ne!(rva, 0, "The image has no load configuration");
            let config = base.add(rva);
            assert!(std::ptr::read_unaligned(config as *const u32) >= 0x50);
            std::ptr::read_unaligned(config.add(0x4e) as *const u16)
        }
    }

    #[test]
    fn static_imports_resolve_from_system32_only() {
        let base = unsafe { GetModuleHandleW(std::ptr::null()) };
        assert_eq!(u32::from(image_dependent_load_flags(base)), LOAD_LIBRARY_SEARCH_SYSTEM32);
    }

    #[test]
    fn setup_helper_ignores_planted_static_import_dlls() -> Result<()> {
        let setup = std::env::current_exe()?.ancestors().skip(1).take(3)
            .map(|directory| directory.join("freedom-windows-sandbox-setup.exe"))
            .find(|candidate| candidate.is_file()).context("Build freedom-windows-sandbox-setup.exe first")?;
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos();
        let root = std::env::temp_dir().join(format!("freedom-dll-plant-{}-{nonce}", std::process::id()));
        std::fs::create_dir(&root)?;
        let copy = root.join("freedom-windows-sandbox-setup.exe");
        std::fs::copy(&setup, &copy)?;
        // Stand-ins without the expected exports: loading either aborts startup.
        for name in ["netapi32.dll", "fwpuclnt.dll"] { std::fs::copy(system32().join("version.dll"), root.join(name))?; }
        // Inherited by the child, so a loader failure exits instead of opening a dialog.
        unsafe { SetErrorMode(0x0001 | 0x0002) };
        let mut child = std::process::Command::new(&copy).env_remove("CODEX_HOME")
            .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn()?;
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        let status = loop {
            if let Some(status) = child.try_wait()? { break Some(status); }
            if std::time::Instant::now() > deadline { child.kill()?; child.wait()?; break None; }
            std::thread::sleep(Duration::from_millis(50));
        };
        std::fs::remove_dir_all(&root)?;
        // Without arguments the helper starts, rejects the request and exits 1.
        let code = status.context("The setup helper did not exit")?.code().context("Missing exit code")?;
        assert_eq!(code, 1, "Setup helper exited with {:#x}", code as u32);
        Ok(())
    }

    #[test]
    fn execution_classes_do_not_promote_offline_commands() {
        assert!(validate_execution_network("execute", true).is_ok());
        assert!(validate_execution_network("execute", false).is_err());
        assert!(validate_execution_network("execute-file-helper", false).is_ok());
        assert!(validate_execution_network("execute-file-helper", true).is_err());
        assert!(validate_execution_network("unknown", false).is_err());
    }

    #[test]
    fn elevation_locks_reject_changed_bytes_and_pin_files_and_directory() -> Result<()> {
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos();
        let root = std::env::temp_dir().join(format!("freedom-runtime-lock-{}-{nonce}", std::process::id()));
        std::fs::create_dir(&root)?;
        let directory = root.join("runtime");
        std::fs::create_dir(&directory)?;
        let mut hashes = HashMap::new();
        for name in ["freedom-windows-workspace.exe", "freedom-windows-sandbox-setup.exe", "freedom-workspace-runner.exe"] {
            std::fs::write(directory.join(name), name.as_bytes())?;
            hashes.insert(name.to_owned(), sha256(name.as_bytes())?);
        }
        let helper = directory.join("freedom-windows-sandbox-setup.exe");
        std::fs::write(&helper, b"changed")?;
        assert!(lock_runtime_directory(&directory, &hashes).is_err());
        std::fs::write(&helper, b"freedom-windows-sandbox-setup.exe")?;
        let locks = lock_runtime_directory(&directory, &hashes)?;
        assert!(std::fs::write(&helper, b"changed").is_err());
        assert!(std::fs::rename(&helper, directory.join("replaced.exe")).is_err());
        assert!(std::fs::remove_file(&helper).is_err());
        assert!(std::fs::rename(&directory, root.join("replaced-runtime")).is_err());
        assert_eq!(std::fs::read(&helper)?, b"freedom-windows-sandbox-setup.exe");
        drop(locks);
        std::fs::write(&helper, b"changed")?;
        std::fs::rename(&directory, root.join("replaced-runtime"))?;
        std::fs::remove_dir_all(root)?;
        Ok(())
    }
}
