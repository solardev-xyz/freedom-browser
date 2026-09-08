# Finite disposable-host Myotis supervisor qualification

This follow-up harness is **not executed on the primary Mac**. It is intended
for coordinator-managed disposable Linux/macOS hosts with existing Electron 43
and an already installed compiler. It loads no real Myotis addon and makes no
network/provider/blockchain request. It neither downloads software nor launches
the Freedom application. The harness is currently source/pure-unit reviewed
only; its existence is not a qualification pass.

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

Eight sequential cases stop at the first failure:

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
   This tests parent-controller loss, not supervisor loss.

The blocking fixture uses one timed native `Atomics.wait` for 15 seconds,
followed immediately by synchronous exit code 78. This does not rely on an
addon/controller event-loop timer callback to end the block. A fixture-expiry
exit is always a failed product cleanup result, never a pass. The helper should
terminate it through owned native authority well before that expiry. No loop,
resource-pressure fixture, detached child, real addon or arbitrary PID signal
is used. The parent-loss controller also has an 18-second self-disposal timer;
it executes no blocking fixture code in its own process.

Each action has a 25-second deadline, followed by bounded owned-control cleanup;
the overall run has a 180-second failure deadline. Cleanup requests product
stop/closes task-owned control pipes only. The overall failure path exits the
harness itself, retaining unknown generations as failures. It never uses
`process.kill`, `ChildProcess.kill`, process-name matching or absence scans.
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
