# Finite disposable-host Myotis supervisor qualification

This follow-up harness is **not executed on the primary Mac**. It is intended
for coordinator-managed disposable Linux/macOS hosts with existing Electron 43
and an already installed compiler. It loads no real Myotis addon and makes no
network/provider/blockchain request. It neither downloads software nor launches
the Freedom application. The disposable Mac checkpoint below qualifies only
the recorded finite campaign; the remaining product gates still apply.

## Disposable Mac checkpoint — 2026-09-08

Commit `098149e7155393b1ce719e7e71ad1c6a38c409e3` passed the original eight cases (1–8) below
in one campaign (exit 0, `inputsUnchanged: true`), using the benign JS fixture.
Runtime: Electron 43.0.0, Node 24.17.0, libuv 1.52.1, macOS 15.6 arm64;
compiler: Apple clang 17 with installed SDK 15.5. No primary-Mac runtime test
was performed.

The coordinator retained remote evidence at
`/private/tmp/freedom-myotis-qualification-1plan72i` and verified all 75 text
member hashes in the local `/tmp/freedom-mac-098149e7-evidence.json` export.
The hashes were also checked when recording this checkpoint.

| Artifact | SHA-256 |
| --- | --- |
| Native source | `ca4f72d62ca3b5d4b87078ee12e6f60682ac13589eca4742bbabf164423d684d` |
| Compiled helper | `217f71c48045ad982704a0ba7b72d234328e353fc796f1f09755aec59d6fcfb5` |
| Evidence archive | `a8c4360e06bd506122234495c21809ded8a3a5bdb465af0f57b37ea0645826cf` |

In the parent-controller-loss case, the harness asserted the generation-matched
old retired record before guarded reuse/lock release, but did **not** separately
snapshot that record: only the successor record is retained. The controller's
OS exit was observed; the old supervisor's OS exit was not. Control EOF is the
separate case with full native receipt and observed supervisor OS exit.

Native helper, process, child and harness sources are byte-identical between
`098149e7` and `e662127c`; this is **not** a full `e662127c` runtime pass. The
campaign does not qualify the real addon, Windows, signing/packaging, app Quit,
supervisor loss or the broader matrix below. No rerun was made for this update.

## Disposable Mac checkpoint — c915e138, 2026-09-08

Commit `c915e1384e6f3f3390458d3a168cf2c89b9fd486` passed all nine cases in
one authorized campaign (build exit 0, runner exit 0; no rerun). All 715 tracked
file hashes remained unchanged. Runtime: Electron 43.0.0, Node 24.17.0,
libuv 1.52.1, macOS 15.6 arm64; Apple clang 17 with installed SDK 15.5.
This is the real process wrapper/native supervisor with the benign JS fixture.

Both controller-loss cases retained `old-retired-record.json` before guarded
successor reuse. The isolated group controller's actual OS exit was SIGTERM
with a null exit code. Evidence for each old generation remains **controller
OS exit + generation-matched durable retirement snapshot + guarded reuse/lock
release**; the old supervisor OS exit was unobserved. A retired record does not
establish the old child's exit signal or graceful completion. Successors have
their own native terminal receipts and observed supervisor OS exits.

Retained remote root: `/private/tmp/freedom-myotis-c915-8o0ywmft`. Local report:
`/tmp/freedom-mac-c915e138-reply.md`; decoded export:
`/tmp/freedom-mac-c915e138-evidence.json` (`files[].text`). The coordinator
independently verified all 98 exported member hashes.

| Artifact | SHA-256 |
| --- | --- |
| Native C source | `a56be756bc14a7049f679ead1c0f272d2054ab83be5df91b3e5ec8a83a6a0516` |
| Compiled helper | `027c518fb4fa1c7a65b35cfa88e196ea8c1cfaf89f89f17e5461673f9a5c7f61` |
| Gzip export | `666916084d836bf19006c3a52d6279876f466faa384e0ee4ddee231bcc684bb2` |
| Decoded JSON export | `037f4ca252f55bd614562762204c94ff957a576618e971d5fe6f991c8251c905` |

No primary-Mac runtime test, real addon, actual application Quit, Windows,
signing/packaging or supervisor-loss qualification is claimed. Manager
freshness, UI and routing behavior are outside this narrow runtime campaign.
It does not establish a measured process peak or aggregate resource containment.
The earlier `098149e7` checkpoint remains a separate historical campaign.

## Running on an authorized disposable host

Build the target supervisor from the candidate source using existing tools:

```sh
node scripts/build-myotis-supervisor.js
```

Then run with the installed Electron executable in Node mode, using an absolute
**new, nonexistent** task-owned evidence directory. For a disposable Mac with
the existing Electron dependency tree linked/materialized in this checkout:

```sh
FREEDOM_MYOTIS_DISPOSABLE=1 ELECTRON_RUN_AS_NODE=1 \
  node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  scripts/qualify-myotis-supervisor.js --disposable \
  --evidence-dir /private/tmp/freedom-myotis-supervisor-qualification-20260908-01
```

The Linux executable is `node_modules/electron/dist/electron`; use a fresh
`/tmp/freedom-myotis-supervisor-qualification-<run>` path. Never run either command
on the primary Mac. Do not reuse a previous evidence directory or delete it.
The runtime gate checks Electron major 43, Node mode, POSIX, the environment
opt-in and the explicit CLI opt-in. It does not independently attest that a
host is disposable; the coordinator supplies that authority.

## Cases and evidence

Nine sequential cases stop at the first failure. The `c915e138` checkpoint
above covers all nine on disposable macOS; the earlier `098149e7` campaign
covered cases 1–8 without the separate old-record snapshots:

1. Actual fd3 startup/read/status using `MyotisProcess`, the native helper and
   the benign JS addon; graceful exit; a new generation reuses a retired record.
2. Natural fixture exit, with native receipt and supervisor OS exit.
3. Blocked read, caller deadline, retained admission, forced native termination.
4. Blocked status, caller deadline, forced native termination.
5. Blocked graceful stop, forced native termination after the product grace.
6. Direct control EOF, retaining the full native receipt and supervisor OS exit.
7. An explicitly simulated prior active record rejects startup without loading
   the fixture. This is not a concurrent-owner or supervisor-crash experiment.
8. A task-owned controller starts a child, sends its generation, and exits
   itself without calling stop. The outer harness observes **controller OS exit
   + generation-matched native durable retirement + guarded new-generation
   reuse/lock release**. Direct observation of the old supervisor OS exit is
   unavailable. The new generation has full terminal receipt/OS-exit evidence.
   This tests parent-controller loss, not supervisor loss. Current harness source
   persists `old-retired-record.json` before any successor overwrites the native
   record; the historical `098149e7` campaign did not retain that snapshot.
9. A fresh task-owned controller is launched with POSIX `detached: true`, retaining
   IPC and OS-exit observation (no `unref`). libuv requests a new session; its
   macOS spawn path is covered by this campaign. The Linux fork fallback does
   not check the `setsid()` return value and remains separately unqualified.
   Only after generation-bound confirmation from this launcher does the
   controller call `process.kill(0, 'SIGTERM')` on its own current group. Missing
   confirmation expires without signaling; no stored PID/PGID or host-session
   fallback is used. The assertions are **controller OS exit + old generation's
   snapshotted retired record + guarded successor reuse/lock release**. The old
   supervisor OS exit is unobserved. This tests group-signal parent loss, not
   supervisor loss or any stronger exit proof.

The blocking fixture uses one timed native `Atomics.wait` for 15 seconds,
followed immediately by synchronous exit code 78. This does not rely on an
addon/controller event-loop timer callback to end the block. A fixture-expiry
exit is always a failed product cleanup result, never a pass. The helper should
terminate it through owned native authority well before that expiry. No loop,
resource-pressure fixture, real addon or arbitrary PID signal is used. Only
the explicit group-signal controller creates a fresh session; product processes
keep their normal spawn options. The parent-loss controller also has an 18-second self-disposal timer;
it executes no blocking fixture code in its own process.

Each action has a 25-second deadline, followed by bounded owned-control cleanup;
the overall run has a 180-second failure deadline. Cleanup requests product
stop/closes task-owned control pipes only. The overall failure path exits the
harness itself, retaining unknown generations as failures. It never uses
`ChildProcess.kill`, process-name matching or absence scans. The sole
`process.kill` exception is case 9's controller self-group signal with literal
PID argument 0, following its isolated-launch confirmation.
Unknown outcomes are not promoted by a timer, disconnect or fixture expiry.
The coordinator's disposable-host containment remains the outer backstop; its
cleanup must never be counted as product success.

The new evidence directory retains the runtime executable/version, random run
identity, source/helper/fixture SHA-256 hashes, native receipt bytes, actual
supervisor OS exit events, generation identities, bounded fixture events,
per-case results and a summary. PIDs are diagnostic only, never signal authority.
Inputs are hashed again at the end. All files are preserved. A failed run needs
a new evidence directory after coordinated disposition; no auto-clearing of
active records or unverified reuse is attempted.

The harness does not qualify supervisor loss, arbitrary descendants, real
Myotis libuv behavior, Windows, exact-lock dependencies, signed/notarized
packaging, live chain fallback, or actual application Quit. See the separate
[product contract and remaining matrix](myotis-process-isolation.md).

## Windows Node-only campaign (source prepared; runtime pending)

The dedicated `myotis-supervisor-windows.yml` workflow runs only on relevant
pushes to `feature/myotis-process-isolation`, or a future manual dispatch. A
reviewed push is necessary while this new workflow is absent from the default
branch. It checks out the exact event SHA and uses runner-preinstalled Windows
x64 Node 22 or 24 and installed MSVC/SDK. There is no `setup-node`, npm install,
Electron/addon download, new action, or tool acquisition. Missing prerequisites
fail the job and retain early evidence. Only existing checkout/upload actions
access GitHub; fixture processes have no network or real-addon work.

The source-built helper runs the real `MyotisProcess` and `myotis-child.js`
against the task-owned benign JS fixture. Nine sequential cases cover fd3
start/read/status and retired reuse; natural exit; blocked read, status and
stop; control EOF; active-record rejection; parent-controller loss and guarded
reuse; and a fixed ABI-handshake rejection before create/start, followed by
verified retirement. Windows does not run the POSIX group-signal case. The
ABI rejection fixture returns 0; successful fixtures return 22. Neither loads
a native Myotis addon.

Commands in an **existing x64 MSVC developer shell on the disposable runner**:

```powershell
node scripts/build-myotis-supervisor.js x64
$env:ELECTRON_RUN_AS_NODE = '1'
$env:FREEDOM_MYOTIS_DISPOSABLE = '1'
$env:FREEDOM_MYOTIS_NODE_QUALIFICATION = '1'
node scripts/qualify-myotis-supervisor.js --disposable --evidence-dir C:\task-owned\new-campaign
```

The evidence directory must be new and its parent must already exist. Each
blocking fixture has a 15-second native timed wait followed by exit 78; idle
fixtures expire after 18 seconds. Expiry is always failure. Case/controller/
campaign deadlines remain 25/20/180 seconds, with bounded owned-control cleanup
and no PID signals. Evidence is retained without deleting files. No fixture,
helper or application is run on the primary Mac.

Normal cases require a generation-matched native terminal receipt, stdout EOF
and observed supervisor OS exit 0. Windows force evidence additionally requires
`forced: true`, child exit code 1 and signal 0; a natural exit 1 cannot pass as
forced cleanup. Controller loss records actual controller OS exit, snapshots
the old generation's durable retired record before reuse, and proves guarded
successor acquisition/exit. The old supervisor OS exit is **not observed** in
that case. Active-record rejection remains quarantine, not proof of child exit.

Successful Windows child startup exercises the mandatory suspended
`CreateProcess` job-list assignment, CRT fd3 inheritance and retained-HANDLE
wait/termination paths. This is not an independent supervisor-crash,
kill-on-job-close or descendant-cleanup test. Job setup failure must fail the
campaign; there is no fallback or automatic clearing of active records.

Artifacts include the event/candidate SHA, runner image/OS, exact Node versions
and executable hash, lockfile/source/fixture/helper hashes, compiler and SDK
identities, native receipt bytes, actual supervisor exit events, durable-record
snapshots and per-case results. Preflight/build/campaign transcripts are
uploaded even on failure. The manifest labels the transport `node-only`;
Electron 43, ASAR, RunAsNode fuses, real ABI22 native teardown, actual app Quit,
and signing remain separate qualification gates. Historical `098149e7` and
`c915e138` Mac results above retain their exact source/runtime attribution;
changes to this harness do not extend those passes.
