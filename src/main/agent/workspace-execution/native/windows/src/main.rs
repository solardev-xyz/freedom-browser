//! Freedom's private, versioned control protocol. Workload output is always
//! base64 inside output frames; it can never impersonate a lifecycle frame.
use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use codex_protocol::config_types::{WindowsSandboxLevel, WindowsSandboxProxySettingsMode};
use codex_protocol::models::PermissionProfile;
use codex_protocol::protocol::NetworkSandboxPolicy;
use codex_utils_absolute_path::AbsolutePathBuf;
use codex_windows_sandbox::{WindowsSandboxProvisioningSettings, WindowsSandboxSessionRequest};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::time::Duration;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Request {
    version: u32,
    operation: String,
    backend: String,
    home: PathBuf,
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

async fn run(request: Request, mut controls: tokio::sync::mpsc::Receiver<Vec<u8>>) -> Result<()> {
    if request.version != 1 || request.backend != "elevated" || !request.home.is_absolute() {
        bail!("Unsupported sandbox request");
    }
    match request.operation.as_str() {
        "probe" => return emit(json!({"type":"capabilities", "version":1, "backend":"elevated",
            "setupComplete":codex_windows_sandbox::sandbox_setup_is_complete(&request.home)})),
        "setup" => {
            if request.user.is_empty() { bail!("Setup requires the standard user's identity"); }
            codex_windows_sandbox::run_elevated_provisioning_setup(&request.home, &request.user,
                WindowsSandboxProvisioningSettings::default())?;
            return emit(json!({"type":"setup", "complete":true}));
        }
        "execute" => {}
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
    let profile = PermissionProfile::workspace_write_with(&writable, network, true, true);
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
