# macOS native lifecycle qualification — 2026-09-08

The disposable Mac completed one ordered four-case campaign with the integrated native supervisor. Idle Quit, running Quit and actual browser-main loss passed their cleanup assertions. Supervisor loss passed its **limitation** assertions: the command continued after the supervisor died, until the fixture's own expiry, and Freedom reported uncertain teardown. This completes the bounded original-root ownership implementation checkpoint; it does not establish complete descendant termination.

Request: `macmini/req-676112afd82ae6f78d2b5d1bdc4dedf4`. The explicit report was received by the main agent. Remote artifacts remain under `/private/tmp/freedom-keychain-isolated-identity-4b_h2g2u/attempt01`, campaign `execution-xnssdn1y`. No second campaign ran. No app-exit or fault fixture ran on the primary Mac.

## Candidate and test regime

Production source subtree `ac592c69a340d9eb477111d33a9d099bf2a553f1` matches test-support commit `2ea1250a`; config `4b92ebead9cd66346da12a06f1aab8d63b6ec16b`, scripts `18743216110ed329e19dac8994ad6d75f08a3194`, package blob `7ad2dce912ea545551c9343b26884da175800e0f`. These are source-subtree identities, not a claim that the remote checkout was at the primary's full commit. Both original remote checkouts remained clean and unchanged. Native source SHA-256 is `01d67c27e99220ebb37e3d1e07e962703ceab10b832cadd053abc7fd0b458cce`, helper `f7cb7da6b40562def145bee3576567403225fb99ae8d56a488d2ecf22b176671`, adjacent manifest `4f041593ff4ac95e1dbd8f6a952409c164dc34a228f0a833ac08f0fafeca7a88`. Pre/post source and artifact proofs match.

Runtime: macOS 15.6 (24G84), arm64, installed Electron 43.0.0 / Node 24.17.0 / libuv 1.52.1. The credential-free TEST_MODE preload makes Electron safeStorage unavailable, with encryption/decryption blocked and no native storage calls forwarded. It changes no workspace, sandbox, preview or process implementation. Exact test identity and isolation markers were checked in every case. **Real-keychain, live-provider and signed/notarized release behavior are not qualified by this campaign.** The earlier native sample and failed setup attempts remain in [the ownership review](macos-electron-main-ownership-review-2026-09-08.md).

## Actual case results

| Case | Seconds | Actual native outcome | Evidence |
| --- | ---: | --- | --- |
| Idle Quit | 0.722045 | Browser exited 0, no browser signal | Native `terminate:` marker, ordered shutdown, no drain warning; `quit-idle-7fi62vyh` |
| Running Quit | 1.502678 | Browser exited 0; command SIGTERM; supervisor exited 0 | Real preview HTTP 200 before Quit, command exit/reap before alarm, raw and mapped cancellation, heartbeat stopped and listener gone; `quit-running-u1wjyj8p` |
| Browser-main loss | 1.605897 | Actual browser SIGKILL; command SIGTERM; supervisor exited 125 | Watchdog killed its still-unreaped direct browser child; command and supervisor independently observed exiting before alarm; `main-loss-qyk9dzyh` |
| Supervisor loss | 15.910832 | Supervisor SIGKILL; command later SIGALRM; browser subsequently Quit 0 | Genuine preacquired supervisor audit identity, heartbeat growth after confirmed supervisor death, failed receipt and uncertain cleanup; `supervisor-loss-im6_a2bs` |

All cases have known kernel statuses bound to original registration keys and identities; errors, emergency cleanup and unconfirmed lists are empty. The fixed inspector controller was deliberately disposed with SIGKILL after each proof; that is harness disposal, not product cleanup evidence. Executed source and pure mocks enforce retirement of every direct browser/controller signal authority before sole reap; final retired/reaped state is retained, without separate runtime timestamps for each ordering step. The watchdog never signaled the command and used no framework emergency signals. All registered framework exits were observed. No complete census of transient descendants is claimed.

Running Quit preserved final original-group SIGKILL `EPERM` and `nativeCleanupUncertain: true`, alongside native root-exit observation and reap. This error is not proof that the group was empty. Browser loss used the actual application's death, not a synthetic close of its control pipe. Its supervisor exit 125 is an observed status; no exact errno cause or dead-browser receipt is inferred.

In supervisor loss, S died at `141945766693000` CLOCK_MONOTONIC ns. The heartbeat grew from 18 bytes at `141945767403000` to 435 at `141960086438000`, before the earliest alarm bound `141960096237000`. C's SIGALRM was observed at `141960112042000`, 15.805 ms after that bound. Freedom reported `WORKSPACE_SUPERVISOR_FAILED`, root observation/reap false and cleanup uncertain. Self-expiry is a fixture safeguard, **not product cleanup**.

## Harness corrections and review

The fixed CLT Python launcher resolves to `Python3.framework/Versions/3.9/bin/python3.9`, but native `proc_pidpath(self)` reports `Resources/Python.app/Contents/MacOS/Python`. This relationship was measured before launch and rechecked inside W. Both installed files are root-owned 0755; launcher SHA-256 `5c5950c62eee5fd227a67e4bdfcde81c9add59799bba0949635f3d5ba9661c26`, native image `af6437511753f01fee16cfab68d092dfb207a68e78b8b330bb5408488d0465e2`. All three current C images and argv matched the fixed verified image, exact script and token, with parent/UID/start/PID checks retained before validation. This does not reconstruct the previous failed attempt's unrecorded values.

The main agent verified and reviewed the final identity/counting diff: 14,456 bytes, SHA-256 `65bba5c7ce299306e8f08e0c96ee548bd4d7a6fe6237e28dd867a8e0b772dabf`. Independent Claude request `macmini/req-9ca2c0e05579677aa3edea96eab18e65` reviewed the preceding keychain/job harness source without executing it. It found no evidence-fabrication path in those adapters and identified the composite identity assertion now corrected. Its absolute “hard guarantee” phrasing is treated as a scoped source-review finding, not a proof over all possible workloads. The bounded framework grace can still cause a conservative failure; no grace was widened to obtain this pass.

Focused checks passed 65 Python tests, 33 controller assertions, 13 preparation-job cases, 65 preload assertions, seven marker-wait cases, lint and actual helper resolution. The earlier 63-test run preceded two counting regressions; both records are retained. Ordinary primary-Mac validation remains 4,116 Jest tests across 238 suites, with 54 tests / seven suites skipped, and lint passed. No production code changed for these remote harness corrections.

The campaign totaled 19.741452 seconds and 35 per-case observed roles (8/9/9/9), maximum sampled live count nine. Including retained failed attempts gives 131 raw versus 132 registered-plus-watchdog roles over 53.356287 seconds; the prior one-command counting deficit is not rewritten. Earlier unidentified PIDs 77088, 77638 and 77949 remain separate unknown observations. Sampled 20-live / 40-observed thresholds are not OS resource limits or a historical birth bound.

Public guarantees remain `best_effort / original_process_group / survivorsPossible=true / completeDescendantTermination=false`. Escaped groups/sessions, supervisor failure, stale-process startup reclamation, aggregate resource limits and broader release approval remain open. The passing [89-assertion product campaign](macos-native-product-qualification-2026-09-08.md) and this lifecycle campaign are distinct evidence; five-minute handle expiry was skipped in the former.

## Retained receipt and clock excerpts

These JSON records are copied from the explicit remote report. The durable bundle linked below retains their underlying source and case artifacts separately.

```json
{
  "case": "quit-running",
  "alarm": {
    "pid": 78824,
    "parentPid": 78823,
    "clockDomain": "clock_gettime:CLOCK_MONOTONIC",
    "alarmArmedBeforeMonotonicNs": 141942148852000,
    "alarmArmedAfterMonotonicNs": 141942148854000,
    "alarmArmedBeforeWallNs": 1788859263729392000,
    "alarmArmedAfterWallNs": 1788859263729394000,
    "expirySeconds": 15
  },
  "action": {
    "monoNs": 141942602750000,
    "wallNs": 1788859264183291000
  },
  "exits": {
    "B": {
      "monoNs": 141942890557000,
      "wallNs": 1788859264471097000,
      "statusKnown": true,
      "rawStatus": 0
    },
    "S": {
      "monoNs": 141942640862000,
      "wallNs": 1788859264221403000,
      "statusKnown": true,
      "rawStatus": 0
    },
    "C": {
      "monoNs": 141942615326000,
      "wallNs": 1788859264195867000,
      "statusKnown": true,
      "rawStatus": 15
    }
  },
  "heartbeatStopped": true,
  "listenerGone": true,
  "rawReceipt": {
    "backend": "macos-seatbelt",
    "state": "cancelled",
    "startedAt": 1788859263457,
    "finishedAt": 1788859264227,
    "durationMs": 770,
    "exitCode": null,
    "signal": "SIGTERM",
    "stdout": "",
    "stderr": "",
    "stdoutTruncated": false,
    "stderrTruncated": false,
    "terminationGuarantee": "best_effort",
    "sideEffects": "unknown",
    "survivorsPossible": true,
    "completeDescendantTermination": false,
    "terminationScope": "original_process_group",
    "capabilities": {
      "backend": "macos-seatbelt",
      "aggregateResourceLimits": false,
      "cancellationGuarantee": "best_effort",
      "executableRootsScoped": true,
      "networkPosture": "full",
      "publicNetworking": "host_network",
      "loopbackNetworking": "host_network",
      "privateNetworking": "host_network",
      "hostUnixSockets": "denied_unless_filesystem_authorized",
      "platformNetworkServices": "dns_tls_configuration",
      "survivorsPossible": true,
      "completeDescendantTermination": false
    },
    "diagnostics": {
      "nativeSupervisor": true,
      "processGroupFinalKillAttempted": true,
      "nativeRootExitObserved": true,
      "nativeRootReaped": true,
      "nativeCleanupUncertain": true,
      "nativeRootExitCode": null,
      "nativeRootSignal": "SIGTERM",
      "processGroupSignalErrors": [
        {
          "phase": "finalization",
          "signal": "SIGKILL",
          "code": "EPERM",
          "errno": 1
        }
      ]
    }
  },
  "mappedState": "cancelled"
}
```

```json
{
  "case": "main-loss",
  "alarm": {
    "pid": 78840,
    "parentPid": 78839,
    "clockDomain": "clock_gettime:CLOCK_MONOTONIC",
    "alarmArmedBeforeMonotonicNs": 141943455460000,
    "alarmArmedAfterMonotonicNs": 141943455462000,
    "alarmArmedBeforeWallNs": 1788859265036000000,
    "alarmArmedAfterWallNs": 1788859265036002000,
    "expirySeconds": 15
  },
  "action": {
    "monoNs": 141944162142000,
    "wallNs": 1788859265742683000,
    "role": "B",
    "success": true
  },
  "exits": {
    "B": {
      "monoNs": 141944196201000,
      "wallNs": 1788859265776742000,
      "statusKnown": true,
      "rawStatus": 9
    },
    "S": {
      "monoNs": 141944234899000,
      "wallNs": 1788859265815441000,
      "statusKnown": true,
      "rawStatus": 32000
    },
    "C": {
      "monoNs": 141944196209000,
      "wallNs": 1788859265776749000,
      "statusKnown": true,
      "rawStatus": 15
    }
  },
  "heartbeatStopped": true,
  "listenerGone": true
}
```

```json
{
  "case": "supervisor-loss",
  "alarm": {
    "pid": 78852,
    "parentPid": 78851,
    "clockDomain": "clock_gettime:CLOCK_MONOTONIC",
    "alarmArmedBeforeMonotonicNs": 141945096237000,
    "alarmArmedAfterMonotonicNs": 141945096239000,
    "alarmArmedBeforeWallNs": 1788859266676777000,
    "alarmArmedAfterWallNs": 1788859266676779000,
    "expirySeconds": 15
  },
  "action": {
    "monoNs": 141945753312000,
    "wallNs": 1788859267333852000,
    "role": "S",
    "rc": 0,
    "success": true
  },
  "exits": {
    "B": {
      "monoNs": 141960412674000,
      "wallNs": 1788859281993214000,
      "statusKnown": true,
      "rawStatus": 0
    },
    "S": {
      "monoNs": 141945766693000,
      "wallNs": 1788859267347233000,
      "statusKnown": true,
      "rawStatus": 9
    },
    "C": {
      "monoNs": 141960112042000,
      "wallNs": 1788859281692583000,
      "statusKnown": true,
      "rawStatus": 14
    }
  },
  "heartbeatStopped": true,
  "listenerGone": true,
  "postSupervisorGrowth": {
    "beforeNs": 141945767403000,
    "beforeBytes": 18,
    "afterNs": 141960086438000,
    "afterBytes": 435
  },
  "rawReceipt": {
    "backend": "macos-seatbelt",
    "state": "failed",
    "startedAt": 1788859266596,
    "finishedAt": 1788859267601,
    "durationMs": 1005,
    "exitCode": null,
    "signal": null,
    "stdout": "",
    "stderr": "",
    "stdoutTruncated": true,
    "stderrTruncated": true,
    "terminationGuarantee": "best_effort",
    "sideEffects": "unknown",
    "survivorsPossible": true,
    "completeDescendantTermination": false,
    "terminationScope": "original_process_group",
    "capabilities": {
      "backend": "macos-seatbelt",
      "aggregateResourceLimits": false,
      "cancellationGuarantee": "best_effort",
      "executableRootsScoped": true,
      "networkPosture": "full",
      "publicNetworking": "host_network",
      "loopbackNetworking": "host_network",
      "privateNetworking": "host_network",
      "hostUnixSockets": "denied_unless_filesystem_authorized",
      "platformNetworkServices": "dns_tls_configuration",
      "survivorsPossible": true,
      "completeDescendantTermination": false
    },
    "error": {
      "code": "WORKSPACE_SUPERVISOR_FAILED",
      "message": "The native workspace supervisor failed"
    },
    "diagnostics": {
      "nativeSupervisor": true,
      "processGroupFinalKillAttempted": false,
      "nativeRootExitObserved": false,
      "nativeRootReaped": false,
      "nativeCleanupUncertain": true,
      "supervisorProtocolFailed": true,
      "supervisorControlFailed": true,
      "supervisorExitedAbnormally": true,
      "supervisorOutputDrainExpired": true
    }
  },
  "mappedState": "failed"
}
```


## Durable source and evidence bundle

[The retained JSON bundle](macos-native-lifecycle-2026-09-08.bundle.json) is 551,650 UTF-8 bytes, SHA-256 `7c303a47305f75ea731802dfd79790e7ed6c830197920bdb817aaf7d80561572`. Read-only export request `macmini/req-3898a8d3e93db2ab98c03e1da32a291c` retained 131 file records: 125 raw, one explicitly transformed campaign copy and five derived review files. Each record includes its original remote path, relative path, representation, exact text, byte count and hash. The full final harness and pure tests, launch/setup guide, source proofs, installed runtime binding, checks, case mappings, native results, traces, receipts, clock anchors, markers and inspected logs are included. This archive is evidence, not a transferable execution grant.

Controller configurations and execution-permit files are excluded. Only the campaign JSON's `/authorization` field was removed in the labeled review copy; its original size/hash and transformation are recorded. Original files remain on the disposable Mac. Fixture identity tokens are labeled non-secret; no genuine audit token, controller permit, Herdr reply token, private keychain data, runtime binary or dependency is included. The earlier native keychain sample remains remote with its hash and report reference.

The main agent independently verified the compressed and decoded archive hashes, all 131 record sizes/hashes and relative paths, all four case mappings and known exit statuses, empty error/emergency/unconfirmed lists, final direct-owner state, exact command identity comparisons, source-proof equality, successful check statuses, and raw/mapped cancellation/failure evidence. Sensitive JSON field and private-key/bearer-pattern inspection was clear; the exporter separately checked for actual local permit values before transfer. No archived source or fixture was executed on the primary Mac.
