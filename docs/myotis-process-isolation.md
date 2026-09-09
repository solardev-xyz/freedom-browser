# Myotis process isolation

Myotis v0.1.7 / ABI 22 remains pinned. Every addon call, including init,
create, start, status, log draining and stop, runs outside Electron main.
Each enabled chain has its own native supervisor and Electron-as-Node child.
Main retains profile configuration and paths, chain routing policy, signing,
and existing renderer IPC. This fits the main service boundary; worker threads
would still share main's libuv pool. This is fault isolation, **not a security
sandbox** or an aggregate CPU/memory limit.

## Request and lifecycle contract

- Per chain: two native read/broadcast operations, sixteen queued requests,
  and one independent status request. Requests have a ten-second total budget,
  including queue time. Router reads retain their configured/interactive budget;
  expiration permits configured fallback without stopping the chain. The route
  slot remains held until the underlying manager request settles.
- The process manager's own deadlines govern native health. Expiring an unsent
  queued request removes only that request. Expiring active work makes the child unavailable, rejects pending callers, stops admission,
  and starts shutdown. Native permits remain held until the matching reply or
  verified process exit. Status has a separate ten-second hard request deadline
  and a six-second cache freshness limit. Staleness disables routing without
  stopping the generation or releasing its single pending status permit; a
  late status reply can restore readiness. Main's synchronous queries read only
  a small scalar snapshot.
- Startup is bounded to fifteen seconds. Graceful native stop gets 1.5 seconds,
  then main closes the native supervisor's control pipe. The supervisor owns
  termination; JavaScript never signals a PID or calls `ChildProcess.kill`.
  Stop waits at most five seconds and reports unconfirmed exit honestly.
- A random generation and monotonically increasing dispatch identities bind
  replies. Old/duplicate replies cannot complete new work. The supervisor's
  separate, bounded receipt stream also binds the generation. Main requires a
  native terminal receipt **and** successful OS supervisor exit before reuse.
  Native stop acknowledgements, IPC disconnect and a kill request are not exit.
- A failed generation has a fifteen-second restart cooldown. Recovery is manual
  through the existing Start control; there is no automatic restart loop.
  If exit is unconfirmed, Start remains blocked for that browser session and
  status and the chain control's tooltip report
  `Myotis exit unconfirmed; restart blocked`. Restarting the browser does not
  bypass a durable active record; see recovery below.
  Ethereum and Gnosis have separate failure domains and controls.
- App shutdown disables new work immediately, before closing windows, and awaits
  both chain stop results alongside other nodes. Read fallbacks still obey the
  configured chain order. No fallback is added when policy does not allow it.
- A dispatched signed transaction whose reply is lost is **outcome uncertain**.
  The router propagates `MYOTIS_BROADCAST_UNCERTAIN` without trying another
  broadcaster. The user must reconcile the original signed transaction hash;
  this error is not permission to create a replacement or retry a payment.
- Automatic wallet polling checks actual element visibility (including hidden
  ancestors) and document visibility. Startup cache IPC does not initiate fresh
  reads. A visible wallet with a startup cache miss refreshes immediately;
  cached startup data and hidden wallets do not trigger that refresh.
  Overlapping balance refreshes share work per address, including forced
  refresh and background refresh.

Main records bounded lifecycle facts once per event per generation: startup
attempt/result (configuration, load, ABI, create or start failure), unavailability,
stop request and supervisor exit classification/code/signal/receipt/forced status.
Raw addon logs, exception text, request arguments and profile paths are excluded.

## Native ownership and durable recovery

POSIX: the single-threaded supervisor is the sole waiter for its direct child.
It observes with `waitid(..., WNOWAIT)`, makes any final signal while the child
is still unreaped, permanently retires signal authority, then performs the sole
`waitpid`. No handler or second thread reaps it. The child waits behind a gate;
control and ownership exist before executable release. EOF/error on the parent
control pipe revokes the child. Supervisor loss itself does not promise POSIX
child cleanup; it leaves durable quarantine. Before creating an active record,
the supervisor ignores SIGINT, SIGTERM and SIGHUP so terminal/session group
signals cannot kill the sole wait owner; the execution child resets them to
default. Parent-control EOF still revokes the child. SIGKILL and other actual
supervisor-loss cases still require quarantine.

Windows supervisor spawn uses `detached: true` to avoid libuv's parent-owned
kill-on-close job, retaining every pipe and the observed process handle without
`unref`. This lets the running native owner handle control EOF. The libuv
pre-resume parent-death window can still strand an unexecuted supervisor; this
is not full startup containment or ancestor-job escape. See the
[partial Windows campaign and correction](myotis-supervisor-qualification.md#windows-partial-runtime-checkpoint-and-scoped-correction--2026-09-09).

Windows: `CreateProcessW` creates the child suspended, with a mandatory
`PROC_THREAD_ATTRIBUTE_JOB_LIST` and explicit inherited-handle list. The private
job uses kill-on-close and assignment occurs at creation, before resume. No
fallback to unassigned execution exists. Termination uses the retained process
HANDLE, followed by `WaitForSingleObject` and `GetExitCodeProcess`. A job close
requests cleanup; the receipt proves only the trusted direct child's exit,
not completion of hypothetical descendants. The bounded receipt also records
`forced` separately from the child exit code. The Windows x64 helper compiled
successfully in PR CI for head `09989259`. A later
[nine-case Windows Node-only campaign at `fa14433f`](myotis-supervisor-qualification.md#windows-node-only-pass--fa14433f-2026-09-09)
passed under Node 22.23.2; Electron transport, real-addon behavior and the
remaining startup/supervisor-loss/packaging gates remain separate.

The addon child receives only null stdio and its Node IPC endpoint. It does not
inherit the native receipt writer, control endpoint, ownership lock or Windows
job handle. No signing keys or provider/model credentials are passed. Main uses
an environment allowlist and an explicit Electron executable, with
`ELECTRON_RUN_AS_NODE=1`; no host-Node fallback or inherited `NODE_OPTIONS`.

The native supervisor locks the stable per-chain `.freedom-myotis-owner` file
(POSIX `flock`; Windows exclusive write/delete sharing). The record is bounded,
versioned, validates the entire generation, and is never renamed/replaced while
locked. Native code durably writes `active` before releasing a child, and writes
`retired` only after the actual direct-child wait. POSIX flushes the containing
directory when establishing the record; Windows uses write-through and
`FlushFileBuffers`. Windows lacks the POSIX directory-flush step: new record creation durability
assumes the local filesystem's journaling/write-through guarantees (qualify on
NTFS). Its directory handle is checked separately from the text-based owner
path; same-user junction/path replacement races are not a security boundary.
Partial, corrupt, or active records fail closed. Retired is
proof of exit, **not proof of graceful shutdown or completed transactions**.

The existing browser profile lock remains in place. Its stale-lock recovery
never overrides this independent native ownership record. Supervisor loss,
including loss before its first receipt or after reap but before retirement,
can quarantine the chain across browser
restarts. No age, PID absence, or process-name scan clears quarantine. Native
parent-loss cleanup may persist a valid retired record even if main is gone.

There is currently no automated quarantine-recovery UI. An operator must first
establish that the old child cannot still run, for example by a complete host
reboot, then preserve the quarantined chain cache/record for investigation and
explicitly provision a fresh chain cache. Merely restarting Freedom is not
sufficient. Never remove or rewrite an active record to work around the guard
while the old process's outcome is unknown. This conservative manual recovery
requirement is a release limitation.

## Build and signing

No addon upgrade, npm dependency, download, install or rebuild is required by
this change. Build the small helper from the checked-in C source with an already
installed compiler:

```sh
npm run myotis:build-supervisor -- arm64  # native Linux or macOS; mac also accepts x64
npm run myotis:build-supervisor -- x64    # Windows: installed x64 MSVC developer shell
```

Output is in `myotis-bin/<os>-<arch>/`. `npm run build`/`npm run dist` build native-target helpers before preflight,
including each requested macOS architecture. Windows CI activates installed
MSVC; the live Myotis CI job also builds the helper before launching its tests.
The existing binary preflight requires
both addon and helper for supported Myotis targets. Cross-platform packagers
must supply helpers built on the corresponding host; the build never downloads
a compiler. Existing fetch scripts still fetch only the pinned addon.
`extraResources` includes the helper. macOS explicitly signs only the added
`Contents/Resources/myotis-node/myotis-supervisor` through `mac.binaries`;
`scripts/sign-myotis-helper.js` overrides only that exact file's signing options
with hardened runtime and the empty `config/entitlements.myotis-supervisor.plist`.
Existing app/Electron-helper entitlements and other signing options are preserved.
RunAsNode fuse compatibility, ASAR script loading, native addon ABI/loading,
helper signing, and notarized
package behavior require qualification of the actual shipped artifact.

## Source basis and remaining qualification

Electron 43.0.0's [DEPS](https://github.com/electron/electron/blob/v43.0.0/DEPS)
pins Node 24.17.0. Node's
[child bootstrap](https://github.com/nodejs/node/blob/v24.17.0/lib/internal/process/pre_execution.js)
and [`_forkChild`](https://github.com/nodejs/node/blob/v24.17.0/lib/child_process.js)
open `NODE_CHANNEL_FD` and initialize the IPC channel. A native execPath wrapper
can retain fd 3 for the eventual Node child; it need not implement Node IPC.
Windows recreates the CRT descriptor table described by
[libuv process-stdio](https://github.com/nodejs/node/blob/v24.17.0/deps/uv/src/win/process-stdio.c).
[Microsoft's process attributes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)
define explicit inherited handles and assignment to jobs at process creation.

The [Unix libuv waiter](https://github.com/nodejs/node/blob/v24.17.0/deps/uv/src/unix/process.c)
reaps children before delivering their callbacks; a retained JavaScript
ChildProcess object is not sufficient POSIX signal authority. Electron's
[utility-process implementation](https://github.com/electron/electron/blob/v43.0.0/shell/browser/api/electron_api_utility_process.cc)
also handles `process_exit_termination` notifications, so its `exit` event alone
was not selected as the native-reap proof for this fix.

Local evidence is deliberately limited to mocked JavaScript unit tests, lint,
and compilation of the POSIX source with Apple clang (`-std=c11 -O2 -Wall
-Wextra -Werror`, both `-arch arm64` and `-arch x86_64`). No child fixture, app, provider, blockchain or
Quit/hang/crash test ran on the primary Mac. Existing donor dependencies were
linked read-only: installed Jest 30.4.2 / babel-jest 30.4.1 differ from this base
lock's 30.5.1 versions; ESLint 10.6.0 and Electron 43.0.0 are installed. This is
provisional tooling evidence, not an exact-lock install or a packaged pass.

A separate disposable macOS arm64 campaign at `098149e7` passed the eight
benign-fixture supervisor cases once. See the [exact runtime, artifact hashes
and evidence limits](myotis-supervisor-qualification.md#disposable-mac-checkpoint--2026-09-08).
It is not a real-addon, Windows, signing, app-Quit or full `e662127c` runtime pass.

The later [disposable Mac checkpoint at `c915e138`](myotis-supervisor-qualification.md#disposable-mac-checkpoint--c915e138-2026-09-08)
passed nine cases once, including isolated controller-group SIGTERM, with old
retired-record snapshots retained before both controller-loss reuses. Old
supervisor OS exits remain unobserved; this is not real-addon, actual Quit,
Windows, signing/packaging or aggregate resource-containment qualification.

### CI checkpoint — 2026-09-08

For PR #295 with head `09989259ea693023c452da8f266a4b66c719cb20`,
[PR CI run 34271769830](https://github.com/solardev-xyz/freedom-browser/actions/runs/34271769830)
tested synthetic merge `13a23f6ad9d4e7dd03581aca8d2e142e24c102cb` into newer
main `584f7e08262a3b5348ea02a048e8659b450d1671`. Lint passed; the full test job
reported 208 suites / 3,845 tests passed, with 5 suites / 18 tests skipped.
This is merge-result evidence, not a standalone `09989259` test pass.

Separately, [push CI run 34274266660](https://github.com/solardev-xyz/freedom-browser/actions/runs/34274266660)
checked out actual head `c915e1384e6f3f3390458d3a168cf2c89b9fd486`: lint passed,
with 204 suites / 3,828 tests passed and 5 suites / 18 tests skipped. The differing
counts reflect different main baselines; this branch did not remove tests.
Both CI checkpoints are separate from the provisional primary-Mac dependency
reuse and the exact `c915e138` nine-case disposable runtime campaign.

The [Windows Myotis job](https://github.com/solardev-xyz/freedom-browser/actions/runs/34271769830/job/102214820294)
activated the installed MSVC developer shell and successfully ran
`npm run myotis:build-supervisor -- x64`, producing
`myotis-bin/win-x64/myotis-supervisor.exe`. This is **build-only Windows evidence**:
the single live resolver test was skipped. It establishes no runtime pass for
retained HANDLE ownership, CRT fd3 transport, job assignment/cleanup or durable
retirement. Signing/notarization, ASAR loading, RunAsNode fuse compatibility,
real-addon behavior and actual application Quit remain separate gates.

Reviewed logs: `/tmp/freedom-pr295-windows-myotis-job.log`, lines 491–510
(build) and 572–576 (skip); `/tmp/freedom-pr295-tests.log`, lines 3750–3751
(test totals) and lines 92/119 (synthetic merge checkout). The push run's log is
`/tmp/freedom-pr295-c915-tests.log`, lines 92/106 (actual head checkout) and
3718–3719 (test totals). No new tests were performed for this documentation
checkpoint.

Qualification and decision boundaries:

- **External review:** the PR may leave draft for external review after the
  agreed targeted runtime checks and source review, with exact evidence and
  unresolved limits disclosed. Completing every release-platform check below
  is not a prerequisite for requesting review.
- **Merge and rollout:** source review and the agreed targeted qualification
  inform a separate maintainer decision about the supported deployment scope.
  Opening review or passing one runtime campaign does not itself authorize
  merge or rollout. Unqualified behavior must remain explicit in that decision.
- **Release preparation:** packaged-runtime compatibility, helper inclusion,
  signing/notarization, RunAsNode fuses, ASAR loading and supported release
  targets require their applicable checks before shipping those artifacts.

The matrix tracks evidence and remaining work across these decisions; it is
not a blanket draft-status gate. Untested startup and supervisor-loss paths,
the Windows pre-resume residual, and resource/descendant-containment limits
remain unqualified. No change of review status waives ownership/quarantine
invariants or establishes guarantees beyond the recorded evidence.

| Area | Evidence and remaining qualification |
| --- | --- |
| POSIX helper | Linux/macOS compile; real fd3 transport; natural exit; blocked read/start/status/stop; parent-control loss at startup stages; unknown supervisor loss; verified terminal and durable quarantine/recovery |
| Windows helper | x64 MSVC and nine Node-only supervisor cases passed at `fa14433f`; still required: Electron transport and real-addon behavior, untested startup/job failure and supervisor-loss paths, unsigned and signed package behavior |
| Concurrency | Queue/caller timeouts never refill native admission; stale generation/reply rejection; independent chains and bounded polling; main DNS/file liveness |
| App lifecycle | Actual Quit reaches OS exit; chain stop/restart cannot reuse a live directory; profile stale-lock recovery cannot bypass quarantine |
| Packaging | Exact candidate/dependencies, helper inclusion/signatures, RunAsNode fuse, ASAR/native loading, all supported release targets |
| Live use | Coordinator-authorized Myotis-enabled comparable session and actual Quit; configured fallback and uncertain-broadcast reconciliation, with no blind transaction retry |

The original shutdown evidence strongly implicates Myotis involvement, but does
not prove the original streamed failure or the origins of all four native calls.
Upstream native cancellation/scheduler fixes remain separate work.
