# Myotis process isolation

Official Myotis v0.1.10 / ABI 26 is pinned. No downstream native patch is used. Every addon call, including init,
create, start, status, log draining and stop, runs outside Electron main.
Each enabled chain has its own native supervisor and Electron-as-Node child.
Main retains profile configuration and paths, chain routing policy, signing,
and existing renderer IPC. This fits the main service boundary; worker threads
would still share main's libuv pool. This is fault isolation, **not a security
sandbox** or an aggregate CPU/memory limit.

## Request and lifecycle contract

- Per chain: one native read/broadcast operation, sixteen queued requests,
  and one independent status request. Requests have a ten-second total budget,
  including queue time. Router reads retain their configured/interactive budget;
  expiration permits configured fallback without stopping the chain. The route
  slot remains held until the underlying manager request settles.
- The process manager's own deadlines govern native health. Expiring an unsent
  queued request removes only that request. An active caller expires after ten
  seconds without releasing its native slot or stopping the chain. Its late reply
  releases only that slot and cannot complete a newer caller. A separate fixed
  100-second native watchdog stops an unresponsive generation; this is a host
  availability policy, not a guarantee that native cancellation finishes on time.
  Native permits remain held until the matching reply or verified process exit. Status has a separate ten-second hard request deadline
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
  Both supervisors report ownership as soon as the child exists, including when
  control is revoked in that start window, so a terminal receipt is always
  attributable to a reported owner and a cleanly retired child is never
  quarantined for a stop that raced the child's creation.
- A failed native generation has a fifteen-second restart cooldown. Ordinary
  startup/process-failure recovery exposes **Retry sync**, which restarts using
  the same owned state directory and saved checkpoint. It does not fetch a new
  checkpoint merely because startup failed. Stale-checkpoint recovery has a
  separate bounded automatic flow described below.
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

## Automatic stale-checkpoint recovery

Myotis parks in `STALE_ANCHOR` when neither the embedded checkpoint nor saved
state is recent enough. Freedom then obtains an authenticated recent checkpoint
and restarts the affected chain from it. No consent dialog or risk bypass is
exposed, and the host does not call `acceptStaleAnchor`. Verified routing stays
unavailable until normal sync and execution-reader readiness return.

Each attempt runs Colibri's WASM verifier in a disposable worker with its own
empty store, separate from ENS verification. It verifies a recent block proof,
extracts the authenticated committee checkpoint header, recomputes its root,
and requires the configured checkpoint quorum to endorse that same slot/root
as finalized. The checkpoint must be at most one hour old and consistent with the
computer's clock. Worker results are validated again before lifecycle or storage
use. The whole verification attempt has a 90-second deadline; individual network
requests have 20-second deadlines and bounded response sizes.

Ethereum requires 2 of at most 3 participating checkpoint authorities, drawn
from seven configured candidates: Sigma Prime, EthStaker, ChainSafe, Attestant,
beaconcha.in, PietjePuk, and Stakely. The worker starts with the first three and
replaces unavailable candidates in a stable order, without revisiting a candidate
within the same lookup. Valid dissent and contradictory evidence retain their
seats; three conflicting responses cannot cause a search for agreeable reserves.
HTTP failures, malformed bodies and missing/lagging finality may be replaced.
Clock-invalid or contradictory evidence is not treated as mere unavailability.
The existing overall worker deadline bounds all replacement rounds. Gnosis requires
both `checkpoint.gnosischain.com` and `checkpoint-sync-gnosis.dappnode.net`.
Proofs still come from `mainnet1.colibri-proof.tech` and
`gnosis.colibri-proof.tech`, respectively, and Colibri proof verification is
mandatory. There is no reduced-threshold fallback to any prover or RPC server.

Each provider gets one vote for the exact requested slot/root only after an
explicit finality endorsement. If its latest checkpoint has advanced, the
Checkpointz finalized-history API can endorse the same older block. Mere block
existence is insufficient. Publication lag or missing history is retryable;
conflicting evidence that prevents quorum pauses recovery with an explanation
and Retry. Ethereum can tolerate a dissenting or unavailable third source;
Gnosis cannot recover while either source is unavailable.

This is an external checkpoint trust policy. Security depends on sufficiently
many independent operators being honest; domain names alone do not establish
independence. Public operator/upstream provenance and limits are documented in
[the quorum review](audits/myotis-checkpoint-quorum-2026-09.md). Colibri adds its
committee-history proof check, but does not independently establish canonical
finality or remove weak subjectivity.

A successful attempt waits for verified exit of the old native generation,
then creates a new per-profile, per-chain state directory and imports the
verified root and slot through `createWithCheckpoint`. It never copies,
rewrites or deletes the old snapshot. The immutable `anchor.json` and
`verified-sync.json` pointer bind the saved checkpoint to its native state
under `verified-sync/<generation>/`. On restart, only a generation with a valid
record is resumed; existing legacy state from builds that allowed risk consent
is preserved but not silently adopted. Saved checkpoints can be older than one
hour on restart because Myotis still evaluates its saved verified state against
the native weak-subjectivity bound; renewed staleness triggers another recovery.
New schema-v2 checkpoint records retain the distinct quorum voter origins;
worker and new-generation validation require the configured threshold. Historical
schema-v1 records retain their original single-authority provenance for migration;
patched ABI 25 generations are preserved and replaced, not resumed under ABI 26.
They cannot authorize a new recovery or be relabeled as quorum-verified. New
recovery always requires v2 acquisition.
Malformed records or unsafe state paths fail closed as storage failures.
Native ownership quarantine is independent and is never cleared by this flow.
Every load or replacement also checks the legacy base-directory ownership
record: an active, malformed or unknown record blocks migration to a fresh
state directory. Only an absent record or a validated native-retired record
permits migration. A new directory is not a way around an unconfirmed old exit.

Service unavailability, a checkpoint changing during verification, and an
outdated checkpoint receive at most three automatic attempts, with 15-second
and 60-second delays. Verification mismatch, clock disagreement, storage errors,
unconfirmed ownership, missing checkpoint-import capability, or restart failures
stop automatic retries.
Five minutes without read readiness shows **Syncing slowly** and explains that
the native node keeps trying. Its notice clears when full read readiness returns;
**Retry sync** remains available while waiting and restarts using the same
owned state directory. Retry after startup, storage access or ownership failure also
rechecks that state and its guards rather than acquiring a new checkpoint.
Inconsistent records instead offer **Repair sync data**, as described below.
Only native `STALE_ANCHOR` detection triggers fresh checkpoint verification.
Stopping the node, switching profile or shutting down cancels pending work and
invalidates late results. Ethereum and Gnosis recover independently.

While checking or restarting, the Nodes menu shows **Updating sync checkpoint…**
or **Checkpoint verified. Restarting sync…**. An ordinary restart instead shows
**Restarting node…**, without implying any new checkpoint was verified.
A pending retry shows its reason
and the remaining delay. After one minute of recovery, a quiet, dismissible
notice says it is still trying automatically. The timer spans automatic retry
delays, resets for a manual retry, and clears on recovery completion or stop.
Dismissing progress does not suppress a subsequent terminal failure. Ordinary
successful recovery raises no decision prompt. A final
failure leaves a persistent explanation and an appropriate recovery action; the switch
stays on and can turn the node off even while no native child exists. A
dismissible notice with **Open Nodes** makes failures visible when the menu is
closed; identical status updates do not repeat it. Clock, storage, update-required,
ownership and stale-response failures have specific guidance. Settings also points paused
nodes to the toolbar's Nodes menu. Retry requests are accepted only from the
browser chrome, not web pages or subframes. No user confirmation bypasses proof
verification. See the [both-theme UI evidence](audits/images/myotis-recovery/README.md)
and [failure-path UX checks](audits/evidence/myotis-recovery-ux-2026-09/README.md).

Storage access failures (disk full, read-only storage, permissions, I/O errors)
explain what to check and offer **Retry sync**. Inconsistent checkpoint metadata
and native anchor mismatch offer **Repair sync data** with a native confirmation.
Repair preserves every old generation and backs up the old pointer byte-for-byte,
then atomically selects a new bundled generation. It checks the base and **all**
generation ownership records, including orphans, again immediately before the
pointer switch. Linked or unknown generation paths, an unsafe pointer, and any
active/unknown ownership prevent repair. No native ownership receipt is edited.
If the bundled anchor is stale, the normal quorum and Colibri checks are required.
The confirmation is single-flight and invalidated by stop, profile change or
navigation away from browser chrome. Wallets and settings are untouched.

**Get help** opens a native dialog for storage, ownership and installation
failures. It explains the safe next step, links the support issue destination,
and can copy a small report containing only the node version/ABI, network,
platform, failure category and whether the addon was found. It does not send
anything or include paths, profile identifiers, wallet data or arbitrary logs.
Missing components show **Update or reinstall Freedom** even before a native
node has started; incompatible imports/ABI/methods receive the same guidance.
Settings directs the user to Nodes instead of giving a developer npm command.

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

The ownership **Retry sync** action rechecks the native ownership guard; it
cannot establish a missing exit proof or clear permanent unknown quarantine.
Closing another Freedom instance may allow that live owner to retire normally,
but closing instances does not repair an active or corrupt record left after
supervisor loss. The **Get help** dialog makes that limitation explicit and offers support details.
**Repair sync data** cannot clear this quarantine either.
An operator must first
establish that the old child cannot still run, for example by a complete host
reboot, then preserve the quarantined chain cache/record for investigation and
explicitly provision a fresh chain cache. Merely restarting Freedom is not
sufficient. Never remove or rewrite an active record to work around the guard
while the old process's outcome is unknown. This conservative manual recovery
requirement is a release limitation.

## Build and signing

`npm run myotis:download` downloads the official v0.1.10 Node addons for all
five supported targets (or one `MYOTIS_DOWNLOAD_TARGET`). The release checksum
manifest and each addon digest are pinned in `scripts/myotis-release.json`.
Packaging checks the actual bytes against these pins before signing; runtime
requires exactly ABI 26. No Rust build, downstream patch, or build-provenance
sidecar is required for Myotis. Other native components retain their own builds.

The official API is `createWithCheckpoint(network, dataDir, root, slot)`.
Myotis writes `sync-anchor[-gnosis].json` and allows only the same root/slot to
resume that directory; `-3 ANCHOR_MISMATCH` is a storage failure, never a fallback
to the embedded anchor. Freedom validates existing native markers against its
own authenticated checkpoint record. New generations record `nativeCheckpointApi:
26` in `anchor.json`. Pre-release generations made by our patched ABI 25 build
are preserved and replaced with a clean bundled generation, after checking
retired ownership. No old snapshot is copied or relabeled. If the bundled anchor
is stale, the usual quorum and Colibri recovery runs. Ordinary ABI 26 restarts
retain their generation and need no new external checkpoint unless native sync
reports a stale anchor.

Build the small supervisor from the checked-in C source with an already
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
a compiler. Myotis addons come from the pinned official release. `extraResources`
includes the helper. macOS explicitly signs only the added
`Contents/Resources/myotis-node/myotis-supervisor` through `mac.binaries`;
`scripts/sign-myotis-helper.js` overrides only that exact file's signing options
with hardened runtime and the empty `config/entitlements.myotis-supervisor.plist`.
Existing app/Electron-helper entitlements and other signing options are preserved.
RunAsNode fuse compatibility, ASAR script loading, native addon ABI/loading,
helper signing, and notarized
package behavior require qualification of the actual shipped artifact.

Current product-path evidence is recorded in the [final-source live campaign](audits/evidence/myotis-recovery-integration-2026-09/review-fixed/README.md): both chains recovered, served verified account reads, stopped and restarted, with four ownership rejection controls. Restarts rebootstrap from the authenticated checkpoint; no persisted committee snapshot was produced. The [ASAR worker campaign](audits/evidence/myotis-recovery-integration-2026-09/asar/review-fixed/README.md) passed separately. Full signed packages, other platforms and long-duration behavior remain separate checks.

## v0.1.9 qualification

The release upgrade starts from main `b5fd764c`, retaining the Windows controller
exit fix and POSIX ownership-receipt race fix. ABI 25 scheduling, readiness and
result handling were ported selectively from the earlier Agent/Myotis test
branch; its Agent code and temporary debug-artifact activation are not included.
The earlier evidence below remains attributed to its original revisions.

The live ENS/read suite no longer skips the old v0.1.7 catch-up stall. Run the
CI workflow manually with `myotis_live: true` for the three-platform live matrix.
The direct-addon `myotis:smoke` harness still fails explicitly on a stale
embedded anchor; it does not drive the manager's automatic recovery. Qualifying
this product path requires a manager/app run that observes stale detection,
checkpoint verification, native generation replacement, verified reads and
restart persistence on both chains. The live matrix is manual because
third-party proof/checkpoint services and peers are external to a PR; normal CI
still checks addon capability and supervisor behavior. Release qualification
also includes actual Quit and packaged signing/loading checks. A successful ABI
handshake or mocked unit suite is not evidence of verified blockchain reads.

The initial v0.1.9 upgrade checks on 2026-09-14, before automatic recovery was
implemented, used main's unchanged lock: all five release addons
passed the pinned checksum manifest; the macOS arm64 addon loaded with ABI 25
and every required export under Electron 44.3.0, then exited normally. The Mac
supervisor compiled. Focused unit/style/license checks and lint passed; the
Nodes menu was inspected in both themes using mocked statuses and fresh test
profiles. Full unit execution reported 4,314 passing tests and three failures
(two settings shortcut tests and one Safe fork test), each reproduced separately
on unchanged main with the same dependencies. No real blockchain sync/read,
blocked-native lifecycle campaign or signed/package qualification is claimed.

## Source basis and remaining qualification

The evidence below describes earlier process-isolation revisions, with their
original runtime and campaign limits. It does not qualify the current automatic
checkpoint-recovery integration; see the current matrix in
[supervisor qualification](myotis-supervisor-qualification.md#current-checkpoint-recovery-integration).

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

The [standalone Mac checkpoint at `3ff2c3fc`](myotis-supervisor-qualification.md#standalone-mac-real-addon-and-native-quit-checkpoint--2026-09-09)
passed real ABI22 load/start, cached status, one native-error read and actual
native Menu Quit, with original browser/supervisor/addon-child OS exit 0.
It used Electron 43.0.0 and donor dependencies, not lock 43.6.0, and an
unavailable-only safeStorage substitution. It did not establish a verified
read, SYNCED readiness or native read occupancy at shutdown. The exact source,
receipt provenance, framework SIGTERM exit, three prior failed harness attempts
and other limits are retained in that checkpoint; the latest full PR head was
not runtime-tested by that campaign.

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

The agreed targeted checks for external review are now complete within their
disclosed scopes, including the standalone Mac and Windows Node-only campaigns.
This does not complete every matrix item or change merge, rollout or release
authority.

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
| App lifecycle | Standalone Mac `3ff2c3fc`: real ABI22 start and native Menu Quit reached original browser/supervisor/child OS exit 0; occupied-read shutdown and other runtime coverage remain unqualified; stop/restart and profile recovery must preserve data-directory quarantine |
| Packaging | Exact candidate/dependencies, helper inclusion/signatures, RunAsNode fuse, ASAR/native loading, all supported release targets |
| Live use | Standalone Mac: one native-error read while SYNCING, no verified data; longer synced use, configured fallback and uncertain-broadcast reconciliation remain separate, with no blind transaction retry |

The original shutdown evidence strongly implicates Myotis involvement, but does
not prove the original streamed failure or the origins of all four native calls.
Upstream native cancellation/scheduler fixes remain separate work.
