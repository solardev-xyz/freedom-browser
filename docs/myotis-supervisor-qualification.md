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

Nine sequential cases stop at the first failure. Case 9 and the old-record
snapshot added after the `098149e7` campaign are source/pure-unit checked only;
they require manual review before coordinator-authorized remote execution:

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
   IPC and OS-exit observation (no `unref`). libuv creates its own session or fails
   spawn. Only after generation-bound confirmation from this launcher does the
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
