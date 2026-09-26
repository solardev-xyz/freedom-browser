# PPv2 adapter compatibility and process host

Date: 2026-09-26. Continuation of [the source qualification](ppv2-sdk-qualification-2026-09-25.md). Main remains `2983dc62`, already merged; no new managed-node refresh was needed. Application dependencies and production activation are unchanged.

## Adapter update

Added a small [compatibility patch](../scripts/fixtures/kohaku-ppv2-compat.patch) for Kohaku PR #258 at `6fdc248b3d28942d9aaa35c49c1ac76dab89dc0e`, against PPv2 SDK `fe0244e3f14110efd83db02c60c96517dea9cd5a`. It applies only to freshly extracted scratch source when `spike-kohaku-ppv2-sdk.js` is run with `--compat`. It is not a published upstream change or a production-installed plugin.

The complete adapter source now passes strict typechecking against the SDK's declarations. The patch:

- Implements `getFinalizedBlockNumber()` with a validated `eth_getBlockByNumber("finalized", false)` observation. Errors, null results, malformed data, cancellation and permission refusals return a fixed `unavailable` result. They never activate the SDK's weaker `unsupported` confirmation-depth fallback. A genuinely unsupported endpoint conservatively cannot settle exits through this integration until an explicit policy is implemented.
- Keeps `EXIT_PENDING` visible and unspendable. A reorg can return it to active; it is not treated as terminal.
- Adds `unknown` to the association-set label type for pending/completed exits. Exit status alone does not establish ASP approval, because rejected notes can also ragequit.

Freedom's restricted provider grants only the finalized public block query and returns its number/hash. Arbitrary block queries, full transaction objects, receipts and signing remain refused. `verified: false` and the existing unverified-RPC trust metadata remain intact. This is remote finality evidence, not a cryptographic verification upgrade.

Tests execute the patched RPC/status modules with the actual SDK enum, including refusal/error cases and reversible status presentation. Separately, **87 upstream SDK discovery tests pass**, including pending exits, finality availability and reorg cases. These use controlled services; they do not prove live-chain recovery. The session's policy for irreversible state from an unverified RPC or unauthenticated ASP remains a release gate.

## Main-owned prover process

`src/main/wallet/privacy-process.js` uses Electron utility processes for reviewed one-job modules. Identity, policy, lifecycle and result acceptance remain under main-process control; no renderer-facing IPC channel is added, and no signer or vault capability is passed to the child.

The host:

- Requires a live private-account/prover context on the experimental Sepolia scope. Main chooses the absolute module path, input and synchronous result validator.
- Holds capacity and results until the child exits; drops late results after vault/profile revocation, caller cancellation, deadline or application quit. Two jobs may be active, including children still stopping.
- Sends inputs through the private process channel, not command-line arguments. Validates result shape through the main-supplied validator and rejects serialized results over 1 MiB. Child diagnostics/stdout/stderr are not forwarded.
- Requests graceful shutdown, then sends SIGKILL after 250 ms if the tracked child is still alive. A process that cannot be reaped keeps its capacity slot rather than being reported as safely stopped.
- Applies a V8 heap setting plus sampled process RSS budget. The default RSS threshold is 768 MiB, sampled every 100 ms. This is a soft limit with possible overshoot, not an OS memory quota or a bound on individual WASM allocations.

The bootstrap refuses common Node HTTP/fetch/socket/DNS/UDP/HTTP2/process-spawn paths and Electron network calls. Nested workers receive the same Node guards before running SDK code. These are safeguards for reviewed SDK code, not an OS sandbox against hostile Node/native code; filesystem authority and low-level bypasses have not been removed. No account secrets or real wallet witnesses are used in these tests.

Two actual runtime failures were caught and fixed during qualification:

1. Electron utility-process environments merge with the parent's environment: `env: {}` did not remove a synthetic secret marker. The host now explicitly blanks inherited names at spawn, and the bootstrap clears the remaining environment before loading SDK code.
2. Nested Node workers cannot import Electron APIs in the packaged app. The source checkout's npm Electron shim masked that error, causing a packaged proving timeout. The Electron-specific guard now runs only in the utility process; Node guards still run in all nested workers.

The process API and termination semantics were checked against the installed Electron declarations and [official utility-process documentation](https://www.electronjs.org/docs/latest/api/utility-process).

## Real SDK and packaging probe

`scripts/spike-ppv2-process.js` creates an isolated ASAR from the already-installed, pinned SDK. It preserves each resolved `web-worker` package as a separate bootstrap module rather than flattening it into the SDK bundle. It neither installs nor upgrades dependencies. Public deposit artifacts must match the SDK's recorded SHA-256 values.

The Electron test uses the real vault lifetime with a public test mnemonic; the proof itself uses unrelated synthetic witness values. It verifies the real deposit proof and rejects modified public signals, then tests environment isolation, main/nested-worker network refusals, a crash, a SIGTERM-ignoring deadline case, an actual RSS excess, vault lock after proving starts, OS process absence, and another successful proof after unlock. The SDK and fixture load from an isolated ASAR; packaged mode additionally loads the host/bootstrap from Freedom's own ASAR.

Final packaged results: deposit proving took **194 ms** (excluding startup/initialization), with approximately **498 MiB sampled peak RSS**. Another proof after vault unlock took 192 ms. These are observations from one synthetic deposit workload, not performance guarantees.

Validation: **5,573 unit tests passed, 25 skipped and the same 3 baseline failures** (two macOS shortcut-remap cases and the Safe fork case). After the final bootstrap fix, **36 focused tests** and lint pass. The SDK discovery suite has **87 passes**; source Electron has **1 pass**, and the final packaged run has **2 passes**, including its executable preflight. Logs are `/private/tmp/freedom-ppv2-{regression,focused,discovery,electron,packaged,build,lint}-sep26.log`; the packaged JSON report is `/private/tmp/freedom-ppv2-packaged-sep26.json`.

See [the qualification report](qualification/ppv2-adapter-process-2026-09-26.json) for final results and measurements. Measurements are macOS arm64 only. Deposit proving does not qualify transfer/withdrawal circuits, real-note persistence, recovery or platform support elsewhere.

## Reproduce and continue

With the earlier pinned checkouts/dependencies/artifacts prepared:

```sh
node scripts/spike-kohaku-ppv2-sdk.js /absolute/kohaku /absolute/ppv2 --compat
node scripts/spike-ppv2-process.js /absolute/ppv2
```

Use the first report's `rpc.cjs` and `status.cjs` paths as `FREEDOM_PP_V2_RPC_FIXTURE` and `FREEDOM_PP_V2_STATUS_FIXTURE` for the provider tests. Use the second report's `output` as `FREEDOM_PP_V2_PROCESS_ASAR` for `test-e2e/ppv2-process.spec.js`, first in the harness and then against the built app via `FREEDOM_E2E_EXECUTABLE`/the packaged project. The SDK-dependent tests explicitly skip if the private scratch fixtures are absent.

Next is assembling the controlled PPv2 session: restricted protocol signer, encrypted state, separate RPC/ASP/relayer capabilities, explicit deployment/artifact grants and durable relayer uncertainty. Exercise registration/shield/sync/unshield and restore after that. Preserve full-history/rotation discovery rather than sample shortcuts. Final `APP_IDENTIFIER`, audit/deployment matching, dependency distribution review, unverified state/reorg policy and remaining SDK egress are still gates before real production accounts. No UI decision is needed for this next technical slice.
