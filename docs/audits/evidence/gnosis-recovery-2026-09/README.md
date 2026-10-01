# Gnosis checkpoint availability and recovery (#413)

Gnosis now requires two agreeing authorities out of Gnosis Checkpointz, DAppNode
Checkpointz and PublicNode's Gnosis Beacon API. Colibri 3.0.0 WASM proof verification
remains mandatory. Ethereum's seven-candidate, three-seat policy is unchanged.

PublicNode publishes the endpoint at <https://gnosis.publicnode.com/>. Its block-root
response explicitly marks finalized chain history (`finalized: true`) and an
execution-verified response (`execution_optimistic: false`). The
[Beacon API specification](https://github.com/ethereum/beacon-APIs/blob/master/types/primitive.yaml)
defines those flags. The requested block can be older than the provider's current
finalized checkpoint; no Checkpointz history endpoint or historical-state scan is
needed for that provider. Missing or malformed flags fail closed. Freshness,
same-slot root agreement, same-epoch conflicts and proof/header binding remain.

These HTTPS responses are **authority assertions**, not cryptographic finality
proofs. PublicNode/Allnodes is a different public operator from Gnosis and DAppNode;
this is operator diversity, not an audit of shared hosting, backends or control.
Two compromised cooperating authorities remain a trust assumption. Colibri's
proof does not remove that external checkpoint assumption.

## Live verification

2026-09-24, 19:48:07–19:48:14 UTC, macOS arm64, production verifier and real
Colibri WASM. These checks acquire a checkpoint only; they do not launch Myotis,
access a user profile or measure subsequent ENS serving performance.

| Transport condition        | Verified checkpoint in | Agreeing sources             |
| -------------------------- | ---------------------: | ---------------------------- |
| All live                   |                3.937 s | Gnosis, DAppNode, PublicNode |
| Gnosis outage injected     |                0.970 s | DAppNode, PublicNode         |
| DAppNode outage injected   |                0.974 s | Gnosis, PublicNode           |
| PublicNode outage injected |                1.188 s | Gnosis, DAppNode             |

Only the named outage is simulated; the remaining metadata and prover replies
are live. All runs verified slot 30257136. In the retained capture, PublicNode's
current finalized epoch was 1891072 while the requested checkpoint's epoch was
1891071, exercising the new historical-finality path. DAppNode used Checkpointz
history for the same block. PublicNode received no Checkpointz request.

[live-results.json](live-results.json) records timing, voters and safe diagnostics.
[capture/](capture/) retains the Gnosis-outage proof and independent HTTP responses;
the unit suite replays them offline with the real WASM. Removing PublicNode's
finality endorsement rejects quorum; corrupting the proof rejects verification.
The recorded SHA-256 in the live results binds the proof bytes.

Reproduce from the repository root with a fresh output directory:

```sh
node docs/audits/evidence/gnosis-recovery-2026-09/capture.cjs /tmp/gnosis-capture
node docs/audits/evidence/gnosis-recovery-2026-09/capture.cjs /tmp/gnosis-outage 0
```

The optional index 0/1/2 injects a transport failure for Gnosis/DAppNode/PublicNode.
Point-in-time success is not a provider uptime or native serving-latency guarantee.

The production worker-to-parent API also verified a live checkpoint in 1.213 s
and delivered all three sanitized diagnostics; see
[worker-parent-result.json](worker-parent-result.json).

## Recovery and diagnostics

Transient service/quorum unavailability, publication races and stale responses
retry after 15 s, 60 s, then every 5 minutes. The Nodes menu keeps a countdown and
an immediate Retry sync button; after one minute the existing dismissible notice
explains that recovery is still trying automatically. Stop, shutdown and profile
change prevent queued work from starting. Quorum conflicts, proof mismatches,
clock errors and ownership/storage/install failures still pause for user action.

Main logs attempt number, failure reason, retry time or blocked status. Each worker
reports bounded source outcomes with chain, allowlisted source, slot, duration,
error category, and HTTP status/timeout where applicable. Main validates and strips
these records, caps them at 64 per attempt, and never logs response bodies, arbitrary
server error text, credentials or profile paths through this channel. Diagnostics
cannot turn a failed verification into success or terminate a successful attempt.

The logic stays in the existing worker, manager and renderer responsibilities;
there is no new IPC channel, dependency or native-engine patch.

## UI checks

`test-e2e/myotis-recovery.spec.js` uses the real Electron renderer in temporary
test profiles with synthetic service statuses. It checks manual retry routing,
the progress notice, and clearing on success in both themes. It does not simulate
cryptographic verification. Before images show the previous exhausted-retry
blocked state; after images show the new five-minute wait state, both using
the current renderer. They are state comparisons, not separate binary builds.

| Theme | Previous exhausted-retry state | New automatic wait       |
| ----- | ------------------------------ | ------------------------ |
| Dark  | [Before](before-dark.png)      | [After](after-dark.png)  |
| Light | [Before](before-light.png)     | [After](after-light.png) |

## Automated validation and limitations

- Lint and `git diff --check`: clean.
- Focused verifier, worker, manager and renderer tests: 236 passed, including the
  real WASM replay, flag/conflict/outage rejection, cancellation, slow retry,
  manual retry and diagnostic sanitization.
- Recovery Electron regression: 2 tests passed (dark/light); screenshots above
  were inspected. The new code adds no CSS or palette literals.
- Serial full suite: 255 suites / 5,501 tests passed, 4 suites / 25 tests skipped.
  The process nevertheless exited 1 because unrelated OpenLV/WebSocket code
  logged after its tests ended; this is not a clean full-run exit.
- Parallel `npm test`: the existing IPFS/Electron integration probe hit its
  120-second hook timeout. Its 11 tests passed in isolation and in the serial run.
- The broader theme-parity tour timed out waiting for Electron's first window
  before surface assertions; it was stopped after this setup failure. The Linux
  screenshot baseline suite reported its expected 12 skips on macOS.

These runner failures remain recorded; no tests were disabled or assertions
weakened to obtain a green result. The pre-existing native Myotis cold/warm
serving-latency limitations in PR #416 also remain separate from this change.
