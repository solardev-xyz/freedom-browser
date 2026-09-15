//! Isolated checkpoint-bootstrap research. No anchor-risk override is enabled.
use myotis_net::{ChainConfig, SyncHandle, SyncState};
use std::{
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn root(value: &str) -> Result<[u8; 32], String> {
    let value = value.strip_prefix("0x").unwrap_or(value);
    if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("checkpoint root must contain exactly 32 hex bytes".into());
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[i * 2..i * 2 + 2], 16).unwrap();
    }
    if out == [0; 32] {
        return Err("zero checkpoint root refused".into());
    }
    Ok(out)
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

async fn run() -> Result<bool, String> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 6 && !(args.len() == 7 && args[6] == "--resume") {
        return Err(
            "usage: checkpoint_spike mainnet|gnosis ROOT SLOT DATA_DIR BUDGET_SECONDS [--resume]"
                .into(),
        );
    }
    for key in ["MYOTIS_CL_STATIC_PEERS", "MYOTIS_CL_DISABLE_DISCV5"] {
        if std::env::var_os(key).is_some() {
            return Err(format!("refusing source-selection override {key}"));
        }
    }
    let mut config = match args[1].as_str() {
        "mainnet" => ChainConfig::mainnet(),
        "gnosis" => ChainConfig::gnosis(),
        _ => return Err("chain must be mainnet or gnosis".into()),
    };
    config.checkpoint_root = root(&args[2])?;
    config.checkpoint_slot = args[3].parse().map_err(|_| "invalid checkpoint slot")?;
    if config.checkpoint_slot == 0 {
        return Err("zero checkpoint slot refused".into());
    }
    let budget: u64 = args[5].parse().map_err(|_| "invalid budget")?;
    if !(1..=1800).contains(&budget) {
        return Err("budget must be 1..1800 seconds".into());
    }
    let dir = PathBuf::from(&args[4]);
    if !dir.is_absolute() {
        return Err("data directory must be absolute".into());
    }
    let resume = args.len() == 7;
    let marker = format!(
        "myotis-checkpoint-spike-v1\nchain={}\nroot={}\nslot={}\n",
        config.chain_id,
        hex(&config.checkpoint_root),
        config.checkpoint_slot
    );
    let marker_path = dir.join("spike-owner.txt");
    if resume {
        let metadata = std::fs::symlink_metadata(&dir).map_err(|e| e.to_string())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("resume directory must be a real directory".into());
        }
        for file in ["spike-owner.txt", "sync-state.snapshot", "cl-peers.cache"] {
            if let Ok(metadata) = std::fs::symlink_metadata(dir.join(file)) {
                if !metadata.is_file() || metadata.file_type().is_symlink() {
                    return Err(format!("resume file is not a regular file: {file}"));
                }
            }
        }
        if std::fs::read_to_string(&marker_path).map_err(|e| e.to_string())? != marker {
            return Err("resume marker chain/root/slot mismatch".into());
        }
    } else {
        std::fs::create_dir(&dir).map_err(|e| format!("fresh data directory required: {e}"))?;
        std::fs::write(&marker_path, marker).map_err(|e| e.to_string())?;
    }
    let checkpoint_slot = config.checkpoint_slot;
    let checkpoint_period = checkpoint_slot / config.slots_per_period();
    let snapshot_present = dir.join("sync-state.snapshot").is_file();
    let snapshot_period = std::fs::read(dir.join("sync-state.snapshot"))
        .ok()
        .and_then(|bytes| {
            myotis_consensus::snapshot::deserialize(&bytes, &config.genesis_validators_root)
        })
        .map(|snapshot| snapshot.current_sync_committee_period);
    let snapshot_eligible = snapshot_period.is_some_and(|period| period > checkpoint_period);
    let snapshot_period_json = snapshot_period
        .map(|p| p.to_string())
        .unwrap_or_else(|| "null".into());
    println!("{{\"event\":\"storage\",\"resumeRequested\":{},\"snapshotPresentAtStart\":{},\"snapshotPeriod\":{},\"checkpointPeriod\":{},\"snapshotEligibleByPeriod\":{},\"expectedBootstrapPath\":\"{}\"}}", resume, snapshot_present, snapshot_period_json, checkpoint_period, snapshot_eligible, if snapshot_eligible { "snapshot-resume-subject-to-age-gate" } else { "checkpoint-rebootstrap" });
    config.snapshot_path = Some(dir.join("sync-state.snapshot"));
    config.cl_peer_cache_path = Some(dir.join("cl-peers.cache"));
    config.discv5_port = 0;
    let chain = config.chain_id;
    println!("{{\"event\":\"start\",\"unixTime\":{},\"chainId\":{},\"checkpointRoot\":\"0x{}\",\"checkpointSlot\":{},\"wsBoundPeriods\":{},\"acceptStaleAnchor\":false,\"budgetSeconds\":{}}}", now(), chain, hex(&config.checkpoint_root), config.checkpoint_slot, config.effective_ws_bound_periods(), budget);
    let handle = SyncHandle::start(config).map_err(|e| e.to_string())?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(budget);
    let mut synced = false;
    let mut first_synced_slot = None;
    loop {
        let status = handle.status();
        let execution = handle.exec_anchor().finalized_execution();
        let execution_json = match execution {
            Some(e) => format!(
                "{{\"number\":{},\"hash\":\"0x{}\",\"stateRoot\":\"0x{}\"}}",
                e.block_number,
                hex(&e.block_hash),
                hex(&e.state_root)
            ),
            None => "null".into(),
        };
        println!("{{\"event\":\"status\",\"unixTime\":{},\"chainId\":{},\"state\":\"{}\",\"period\":{},\"finalizedSlot\":{},\"finalizedRoot\":\"0x{}\",\"optimisticSlot\":{},\"peerCount\":{},\"hunting\":{},\"execution\":{}}}", now(), chain, status.state, status.period, status.finalized_slot, hex(&status.finalized_root), status.optimistic_slot, status.peer_count, status.hunting, execution_json);
        if status.state == SyncState::Synced
            && status.finalized_root != [0; 32]
            && execution.is_some()
        {
            if let Some(first_slot) = first_synced_slot {
                if status.finalized_slot > first_slot && status.finalized_slot > checkpoint_slot {
                    synced = true;
                    println!("{{\"event\":\"qualified-live-advancement\",\"firstSyncedSlot\":{},\"checkpointSlot\":{},\"finalizedSlot\":{}}}", first_slot, checkpoint_slot, status.finalized_slot);
                    break;
                }
            } else {
                first_synced_slot = Some(status.finalized_slot);
                println!("{{\"event\":\"first-bootstrapped-synced\",\"finalizedSlot\":{},\"checkpointSlot\":{}}}", status.finalized_slot, checkpoint_slot);
            }
        }
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
    let stopped = tokio::time::timeout(Duration::from_secs(15), handle.stop())
        .await
        .is_ok();
    println!("{{\"event\":\"finish\",\"unixTime\":{},\"chainId\":{},\"synced\":{},\"gracefulStop\":{},\"snapshotPresent\":{}}}", now(), chain, synced, stopped, dir.join("sync-state.snapshot").is_file());
    Ok(synced && stopped)
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .with_env_filter("info")
        .init();
    let code = match run().await {
        Ok(true) => 0,
        Ok(false) => 1,
        Err(error) => {
            eprintln!("checkpoint spike: {error}");
            2
        }
    };
    std::process::exit(code);
}
