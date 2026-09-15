# Real Freedom recovery integration qualification

Run on 2026-09-14 on macOS arm64 with Electron 44.3.0 / Node 24.20.0, the pinned Myotis v0.1.9 checkpoint-import extension, actual native supervisor, actual Freedom manager/process/child, and actual isolated Colibri 2.0.6 WASM workers. There are no module replacements, networking mocks, unsafe stale-consent calls, dependency upgrades, or production configuration changes.

Both chains passed the full lifecycle: stale anchor detected; recent finalized checkpoint independently verified by the production worker; old child demonstrably reaped; a fresh state generation created; Myotis bootstrapped to SYNCED and the manager became ready; a read-only public zero-address account proof succeeded; stop confirmed; the same authenticated generation restarted and another proof succeeded; all native children exited with verified supervisor receipts. All four successful reads had `peerProofValid`, `blsVerified`, and `beaconChainVerified` true and `failReason` null. No signing or broadcasting occurred.

Ethereum completed in 92.1 seconds, including two ordinary 10-second caller timeouts before each successful read. Gnosis completed in 6.7 seconds without read timeouts. Those transient failures remain in the logs. Read readiness is not a guarantee that every remote proof request finishes inside the caller deadline.

The stale fixture uses genuine Myotis v0.1.7 August 9 roots and slots, sourced from the earlier spike evidence. Its persisted `verifiedAt`/source metadata is deliberately synthetic, structurally valid historical metadata used only to exercise the stale persisted-state lifecycle. It is not presented as a historical Colibri verification. The recovered checkpoints and account proofs are live real results. Fixture directories contain no snapshots. Both restarts are same-anchor rebootstrap; this run does not qualify restoring a persisted sync-committee snapshot, long-duration syncing, packaged application signing, other operating systems, or renderer interactions.

`summary.json` checks both successful proof flags and all stopped results, records source/addon hashes, and reports timings. `*-result.json` contain structured lifecycle observations and public proof results. `*-stdout.log` additionally contain native supervisor lifecycle receipts. The only address queried is the public all-zero address. No peer cache, private path, credential, or profile data is included.

## Reproduce

Build the native addon and supervisor through the normal repository scripts first. Start the supplied entry script with this checkout's Electron binary, passing the absolute repository path, a new empty temporary run directory, chain ID (`1` or `100`), and total budget in seconds (`600`). For example from the repository root on macOS:

```sh
run_dir=$(mktemp -d /private/tmp/freedom-recovery-live.XXXXXX)
./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  "$PWD/docs/audits/evidence/myotis-recovery-integration-2026-09/electron-main.js" \
  "$PWD" "$run_dir" 100 600
```

The harness sets Electron user data and logs under that fresh temporary directory, seeds an isolated fixture, and exits after stopping all Myotis processes. Existing fixture files are refused (`wx`); no existing profile is loaded. Network access to the configured checkpoint and Colibri services and ordinary Myotis peers is required. Timings and public roots will change. All temporary state is retained for inspection.

## Follow-up qualification

The [final-source campaign](final/README.md) repeats both live runs after the ownership guard and includes real active/unknown-owner rejection controls. The [ASAR worker check](asar/README.md) separately verifies actual worker/WASM loading from an archive under Electron. Earlier captures above remain unchanged.

The [review-fixed campaign](review-fixed/README.md) and [review-fixed ASAR run](asar/review-fixed/README.md) repeat qualification after the adversarial-review fixes. See the [review disposition](../../myotis-automatic-recovery-review-2026-09.md) for the final unit-tested stalled-to-stale guard added after those captures.
