# Standalone PR #295 Mac app driver

`app-driver.cjs` is source-only qualification tooling. Requiring it performs no
work. It is invoked once **inside the actual standalone Freedom main process**
by the coordinator's existing disposable-Mac inspector/DirectOwner harness.
It never launches, signals, reaps or closes a process, and imports no Agent code.
Do not execute it on the primary Mac.

The outer harness must first bind the exact standalone source archive/candidate,
source-built supervisor, already-present pinned v0.1.7 ABI22 addon (target,
size, SHA256 and pinned release sums provenance), installed Electron executable
and runtime versions to its evidence. `3ff2c3fc` and `2cbe4b89` have identical
product source; the Windows harness is not a real-addon qualification. An
Electron 43.0 runtime is distinct from the standalone lock's 43.6 runtime.
No artifact discovery, acquisition, activation or ABI bypass occurs here.

Create a new task-owned evidence directory and an isolated empty profile. Seed
other node autostarts off and Myotis chain 100 off. Start the real app without
`FREEDOM_TEST_MODE`, with the outer actual-OS-exit observer already installed.
The driver's `app.getAppPath()` must resolve the reviewed standalone source
root. Product Myotis profile policy must allow chain 1.

For driver-controlled startup, provide the approved ABI22 file at the existing
development addon path and leave `MYOTIS_NODE_PATH` unset, with Myotis autostart
off. `MYOTIS_NODE_PATH` otherwise **forces startup during app bootstrap** even
when that setting is off. The driver records `beforeStart`; if already running,
its one `startMyotis` call may reuse that generation, and lifecycle capture may
miss earlier events. Do not describe this as newly observed startup. Never
stop/restart solely to manufacture a fresh observation or reuse an active data
record. Artifact placement remains the coordinator's separate authorization.

Invoke through the inspector in main, using the transferred reviewed module's
absolute path (this is an interface example, not an execution instruction for
the primary host):

```js
const driver = require('/task-owned/reviewed/app-driver.cjs');
await driver.run({
  runId: 'pr295-mac-one-campaign',
  evidenceDir: '/task-owned/new-driver-evidence',
  deadlineAtMs: actualOuterLaunchTimeMs + 45000,
});
```

`deadlineAtMs` uses the host clock and must be derived from **actual app launch**,
not inspector attachment. The driver caps it at 45 seconds after entry, and
reports entry time, supplied/capped deadline and entry-relative elapsed time.
Omitting it is supported but explicitly labeled `driver-entry-only`; that does
not establish a launch-relative 45-second bound. The outer owner retains its
own launch-relative deadline, 20-second Quit observation and bounded emergency
failure handling. Driver timers do not prove a blocked main thread can progress.

The driver calls chain-1 `startMyotis` once, samples only cached status four
times over 1.5 seconds, then invokes `getAccount` once for the fixed public zero
address. A false Start result still permits the one manager read attempt and
records its rejection. Startup exceptions or an exhausted driver budget can
prevent the read: `readAttempted` reports this honestly. There are no retries,
transactions, readiness loops, policy changes or altered product deadlines.
A driver timeout does not cancel native work; Quit uses the existing shutdown
path. The pinned addon's cold-sync stall (issue #200) may prevent verified
reads. Unavailable, native-error, rejection, driver deadline and returned values
remain distinct. Only an actual returned `verified: true` is recorded as that
flag; driver completion is not a verified-read or whole-campaign pass.

Evidence is bounded: `driver-progress.json` is rewritten through one retained
file descriptor; `driver-result.json` records the attempt/outcome and cached
`beforeQuit` state. `lifecycle.jsonl` captures at most 32 deduplicated, allowlisted
mainnet lifecycle events from the existing logger hook, retaining actual
reported generation identities and terminal classifications. The hook leaves
application logging unchanged and stays active until `will-quit`. It does not
read raw addon logs or serialize arbitrary exception text, reasons or proofs.
Missing events remain missing evidence; no generation, ABI handshake or exit
receipt is invented. Files are retained, never deleted.

In `finally`, the driver writes the result, then claims the shared once-only
Quit state and writes `native-quit-request.json` **before** calling
`Menu.sendActionToFirstResponder('terminate:')`. Only a returning action produces
`native-quit-returned.json`. Neither marker proves application exit. A failed
marker write prevents the action and retains the claim, leaving failure
handling to the outer owner. Actual exit is never inferred from a callback,
disconnect, timeout, log line or missing process scan.

If the outer D fallback finds no request marker and main is responsive, invoke
`driver.requestNativeQuit({ runId, evidenceDir, reason: 'outer-fallback' })` in
that same main environment. This function shares the driver's
`Symbol.for('freedom.myotis.qualification.quit.v1')` state and refuses an existing
claim/marker. Do not directly issue a second Menu action, clear that state or
reuse it for another run. A fallback claim prevents subsequent new driver work.

The outer report must distinguish a live chain at Quit from a generation
already stopped by the product's read/status deadline. Native lifecycle logs
are reported evidence; the outer DirectOwner/kernel observer owns actual app
OS exit proof and any independently observed process identities. Supervisor
loss, aggregate resource containment, signing, ASAR and Windows real-addon
behavior remain outside this driver.
