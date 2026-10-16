# Actual Electron-main ownership review, 2026-09-08

This source-only review rejects the first Playwright-owned app-loss harness. It does not report a new production failure or an executed PID-reuse test. The shipping macOS supervisor already uses retained native ownership; this finding determines how the qualification watchdog must own the actual Electron main process.

## Main-agent disposition

The first disposable-Mac Claude harness was source-authored and syntax-checked only. Its archive is SHA-256 `c04b0c2bc2440d2d3e7f8c7e416608d2e457a0cf591cd3643e0bfbd91e12ac06`, retained at `/private/tmp/freedom-app-loss-harness-claude-cce35bbb/app-loss-harness/` on macmini. The main agent verified the archive and five source-file hashes before review. No lifecycle case ran from it.

Execution was rejected because the source lacked registration acknowledgments before Quit/main loss, read the supervisor evidence from the wrong directory, set TMPDIR incompatibly with the product's user-data validation, and had assertions that could accept mere terminal presence or any command exit as supervisor-failure/expiry evidence. It also lacked an independent browser cleanup path if its Playwright driver died, did not enforce its declared live-role cap, and relied on ChildProcess numeric signaling without a demonstrated identity guarantee. Syntax success does not establish those properties.

The focused independent review below supplies a concrete reason to reject the ChildProcess assumption. A revised watchdog must directly create and retain the **actual Electron main** unreaped until all numeric signal paths are permanently retired. A separate inspector client can request native Quit and invoke the app-owned test harness, but must not independently launch/reap/signal the main process through Playwright cleanup. Source-only revision and mock checks are in progress; runtime qualification remains pending.

## Explicit independent review

The following is the explicit disposable-Mac Codex reply to `macmini/req-2b7d9313d8fcc76e8499557b5953dbe9`. It distinguishes installed launcher evidence, immutable upstream source, the counterexample inferred from that source, and binary-verification limits.

Do not accept ElectronApp.process().kill() as exact-instance authority for the upcoming main-loss harness. Use a sole direct native/Python owner of the ACTUAL Electron main process, retaining that child unreaped until every numeric signal path is permanently disabled. This is a source-based rejection of the handle guarantee, not an observed PID-reuse test. No browser/fixture was launched, no fault injected, and no checkout/source patch modified in this review.

Installed evidence: /Users/flobot/Git/freedom-dev/freedom-browser/node_modules/playwright-core/package.json reports1.61.1; electron/package.json reports43.0.0. The retained runtime receipt /private/tmp/freedom-final-candidate-he26qp5x/identity-checks.json:43 records Node24.17.0/libuv1.52.1/Electron43.0.0. No new runtime execution. The HANDLE implementation belongs to the Playwright LAUNCHER runtime, not the Electron child: the analysis below applies when launcher is the qualified Electron-as-Node24.17 runtime. Launching Playwright under installed Homebrew Node22 would require its separate implementation baseline; the child's Node24 version does not establish the parent's kill behavior.

Installed Playwright proof (all relative to the node_modules/playwright-core directory above):
- types/types.d.ts:17089–17092 promises only a ChildProcess for the Electron main process. There is no exact-instance signal guarantee.
- lib/coreBundle.js:61822–61823 forwards client process() to the in-process implementation;43354–43355 stores the supplied process;43402–43403 returns it. launchProcess at8751–8764 uses ordinary child_process.spawn;43466–43483 invokes it for Electron, and43536 passes launchedProcess into ElectronApplication.
- This is the ordinary Node ChildProcess, not a kernel process handle. coreBundle.js SHA2566be5c2ea035554e9b184b1dbc7aa5e7f1fb428dd1b5c202022858dcfae9bee27; types.d.ts SHA25660200590d8ecf247a6e9c769c6b79bd8e688c3af14ef208072d0c6954b25f125.

Immutable official implementation references (line numbers from actual raw bytes read, not the web renderer's blank-line normalization):
1. Node24.17.0 commit413e874773eef1e27a8397ddc949dbbe19cadb31, lib/internal/child_process.js:271–295 and517–541. onexit sets status and closes/nulls _handle BEFORE emitting that child's exit. kill checks only _handle then calls its kill; killed is a successful-signal flag, not a reap/identity fence. Thus calls after this child's onexit handler are normally suppressed, but an existing handle before it is insufficient.
https://github.com/nodejs/node/blob/413e874773eef1e27a8397ddc949dbbe19cadb31/lib/internal/child_process.js#L271
SHA2560c2e2cc568bb1651aec25c8a9c7178380dfde9b4ac772b02c6286536ee4986b1.
Exact short excerpts:
    this._handle.close();
    this._handle = null;
    this.emit('exit', this.exitCode, this.signalCode);

2. Same Node commit src/process_wrap.cc:380–395 forwards Kill to uv_process_kill;398–413 invokes the JS onexit callback. No audit identity or kernel-bound signal primitive in this path.
https://github.com/nodejs/node/blob/413e874773eef1e27a8397ddc949dbbe19cadb31/src/process_wrap.cc#L380
SHA256dec142ab67f1e10d6d04a5d232f6f693031558efe1586ad4cfd11fc0d3896e97.
    int err = uv_process_kill(&wrap->process_, signal);

3. Same Node commit deps/uv/src/unix/process.c:101–177, especially131,150,153–174: first walk waitpid-reaps eligible children and queues them; only a SECOND walk invokes exit callbacks. macOS uses its kqueue REAP flag and waitpid options0; ECHILD continues without callback. At1097–1103 uv_process_kill delegates to stored numeric process->pid and kill(pid, signum), with no identity binding or reaped-state rejection. Queue removal/handle-stop does not make that stored PID a kernel capability.
https://github.com/nodejs/node/blob/413e874773eef1e27a8397ddc949dbbe19cadb31/deps/uv/src/unix/process.c#L101
SHA256e79f9bd90787011d59d9395f46658caca2ca01d1daad84c36e3b86eba50a4a52.
    pid = waitpid(process->pid, &status, options);
    return uv_kill(process->pid, signum);
Independent libuv1.52.1 release commit1cfa32ff59c076ffb6ed735bbc8c18361558661f has the same two-pass/numeric-signal behavior (src/unix/process.c; viewed tagged official source first). Prefer the Node-vendored immutable reference above for this runtime.

Concrete inference: libuv reaps child A and Electron main B into pending; it invokes A's callback before B's. A's synchronous JS exit listener calls B.kill(). B._handle still exists and B.exitCode/signalCode can still be null, although B has already been reaped. The OS may have reused B's PID; the signal targets that numeric PID. No JavaScript interleaving in the FIRST native reap loop is necessary for this counterexample. Async work/microtasks are not needed to prove the gap. Adding/prepending B's exit listener cannot run before B's own native callback; neither null-status checks, killed, promises, close events, nor ps/starttime-check-then-kill repair it. The short timing window is not an exact-instance guarantee.

Public API agrees with this limit: Node24.17.0 child_process documentation explicitly warns that signaling an exited child with a reassigned PID can affect another process, and killed does not mean terminated.
https://github.com/nodejs/node/blob/413e874773eef1e27a8397ddc949dbbe19cadb31/doc/api/child_process.md (subprocess.kill / subprocess.killed; tagged raw text viewed). This is an API warning; the two-pass implementation supplies the concrete source argument.

Electron baseline: release43.0.0 commit5147ac2d278f105ec0801c1ef021709979f6d428 DEPS selects Nodev24.17.0. I inspected its patch index and relevant feat_add_uv_loop_interrupt_on_io_change_option_to_uv_loop_configure.patch: it changes loop/async/core integration, not process.c, process_wrap.cc or internal/child_process.js. Immutable patch:
https://github.com/electron/electron/blob/5147ac2d278f105ec0801c1ef021709979f6d428/patches/node/feat_add_uv_loop_interrupt_on_io_change_option_to_uv_loop_configure.patch
SHA256e23a1a7e1415778bf9eab37f87c2377917693bddfd97f6e1bc2d1366fd112d3f.
Limits: installed native Node/libuv implementation source was absent; official pinned sources and retained versions establish this source assessment, not a binary disassembly/reproducible-build attestation. I did not inspect every Electron patch body. That does not supply any positive stronger guarantee permitting child.kill().

Additional harness blocker: Playwright lib/coreBundle.js:8797–8805 tracks processClosed on 'close', not native wait/exit;8833–8855 force-cleanup checks pid/killed/processClosed and uses process.kill(-spawnedProcess.pid,'SIGKILL') on macOS. Electron launch installs exit/SIGINT/SIGTERM/SIGHUP cleanup paths at43479–43482. 'close' can lag root exit while inherited stdio remains open. Do not assume Playwright finally/app.close()/runner-exit paths are free of independent numeric group signals. Even a direct owner around only the Playwright DRIVER does not retain the actual Electron main child identity.

Required next harness design: sole trusted owner directly creates B, registers ownership before exposing setup success, keeps SIGCHLD normal/no auto-reap, observes via NOTE_EXIT or qualified WNOWAIT, and serializes bounded numeric signals while B remains its unreaped direct child. It must retire ALL signal paths before sole reap (including failure/timeout/finally), never regain authority after ECHILD, and retain bounded observation/report uncertainty on failure. External Playwright control must attach without independently launching/reaping/signaling B, or use a deliberately reviewed adapter that leaves ownership with the native owner; do not claim an unreviewed wrapper is drop-in ElectronApp.process().

If Python is used, avoid Popen.poll/wait/communicate/context-exit/destructor/cleanup while numeric authority remains, and do not use Popen.send_signal/kill as the retained-root primitive: installed /Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/lib/python3.9/subprocess.py:2040–2069 calls self.poll() before os.kill; __del__ at1045 and _internal_poll at1837 can also reap. Keep a strong owned child reference and an explicit single-reaper state machine; signal via os.kill only under its retained-direct-child invariant, then disable signaling before wait. A C owner can make those rules clearer. A previously registered genuine kernel audit identity could be a separate test-only alternative, but it is not provided by ChildProcess, and this review does not newly qualify such a path.

Conclusion for the upcoming plan: only the retained actual-main direct-owner alternative is demonstrated here under the current no-check-then-kill policy. Reject a plan relying solely on Playwright's ChildProcess handle or listeners for main fault injection/cleanup. No further fixtures were run; original checkouts and both source patches remain unchanged.

## Payload expiry clock review

The declared disposable-Mac Python is 3.9.6. Upstream [CPython 3.9.6 `pytime.c`, Apple monotonic-clock branch](https://github.com/python/cpython/blob/v3.9.6/Python/pytime.c#L772) subtracts a process-local initial `mach_absolute_time` value. Therefore using the same Python version for watchdog and payload does not establish directly comparable monotonic timestamps. This is an upstream source finding; an Apple-specific binary patch was not investigated. The fixture already records wall-clock bounds around alarm installation. A strict observer can compare corresponding wall-clock bounds while detecting clock discontinuity against its own elapsed clock, or establish an explicit cross-process clock translation. It must not silently subtract the two processes' monotonic timestamps. No process or timer fixture ran during this source review.

## Review precision corrections

The controller's terminal result includes both top-level process state and the mapped `receipt`, plus a `workspace` projection; the initial correction task's suggestion that `terminal.receipt` is categorically absent was too strong. Assertions must follow `managed-workspace-controller.js:#processResult` and the actual raw error's `error.code`. Likewise a case-duration limit below the full payload-alarm interval can be a conservative pre-expiry bound when case start precedes alarm installation. The first harness's decisive problems were missing fault/status/registration requirements and failure to prove actual alarm termination, not simply use of a conservative case-duration bound. The replacement must retain the explicit per-payload timing evidence for precise attribution.


## Direct-owner replacement and independent review

The disposable-Mac Codex replacement directly owns the actual Electron main (B) and a separate fixed inspector controller (D) from a Python watchdog (W). Strong direct-child references remain unreaped while numeric signal authority exists; all such authority retires before the sole wait. The controller neither launches nor signals B. Supervisor and framework-helper fault/emergency authority requires a previously acquired genuine audit identity; the payload is observed, never signaled through a rediscovered PID. This is test infrastructure, not a change to the product's cleanup guarantee.

The main agent verified and read the source archive retained at `/private/tmp/freedom-direct-main-owner-y7hv5vm9` on macmini: 75,782 decoded bytes, SHA-256 `9ab8a73d6c79a7d89eabadce8719f199dfe62713e4591d84391d2c8d24575344`. The source-only explicit report records 32 pure Python tests and 12 inspector protocol assertions. Independent Claude review supports the direct-owner invariant but identifies a potential false failure: immediate emergency cleanup of framework helpers can precede their normal exit. The accepted correction is a bounded natural-exit grace within the existing deadline; emergency cleanup or unconfirmed owned helpers still prevents a pass. The review's suggestion that every helper-bearing run necessarily fails is not established by runtime evidence. Its 29-test count refers to an earlier source snapshot; the final author report records 32.

Test support commit `2ea1250a` uses explicit `clock_gettime(CLOCK_MONOTONIC)` anchors around payload alarm installation, with a declared clock domain and retained wall-clock anchors. This avoids assuming CPython 3.9.6 process-local monotonic origins are shared. Ordinary primary-Mac validation passed 4,116 tests across 238 suites; 54 tests in seven suites were skipped, and lint passed. No primary-Mac app-exit or fault fixture ran.

## First actual direct-owner idle attempt — aborted before Quit

The explicit disposable-Mac report for `macmini/req-a89ad5d6413d0f924c947053b126fcc8` records one attempt, retained under `/private/tmp/freedom-quit-idle-once-pq6ahf2e`. Product source subtree `ac592c69a340d9eb477111d33a9d099bf2a553f1` matches the current test-support candidate; the native helper remains SHA-256 `f7cb7da6b40562def145bee3576567403225fb99ae8d56a488d2ecf22b176671`. This establishes source-subtree equivalence, not the remote checkout's full commit identity. Both original remote checkouts remained clean and unchanged. Prelaunch checks passed 39 Python tests, 12 controller assertions, 13 product test-support tests, syntax and lint.

The attempt failed in inspector identity evaluation with `ReferenceError: require is not defined`, before preparation, native Quit, or any managed command. The watchdog recorded B and D's kernel SIGKILL exits, retired both numeric authorities, and reaped both with return code -9. No supervisor, payload or framework helper was registered. The attempt lasted 0.104170 seconds, with three observed instances including W. These sampled counts are not aggregate containment or a proof of every historical Chromium birth. This is neither a Quit pass nor a product browser-loss qualification.

The installed Playwright Electron adapter supplies a concrete compatibility correction: select the default Node execution context and pass `contextId` plus `includeCommandLineAPI: true` to `Runtime.evaluate`. Its source explicitly associates the option with access to `require` after Electron 28. The replacement controller omitted those options. The next disposable-Mac request authorizes this focused correction, pure mock coverage, bounded helper-exit grace, and one ordered four-case campaign stopping at its first unexpected failure. No result from that campaign is claimed here.

Selected raw first-attempt outcome follows; the full structured inspector exception and all streams remain in the remote `result.json`, `trace.json`, and `D-stdout.log` under `execution-zu1pr9hp/quit-idle-f9goa85x`.

```json
{
  "case": "quit-idle",
  "emergency": [
    {
      "role": "B",
      "signal": 9
    }
  ],
  "unconfirmed": [],
  "exits": {
    "D": {
      "monoNs": 136195758196000,
      "wallNs": 1788853517338737000,
      "statusKnown": true,
      "rawStatus": 9
    },
    "B": {
      "monoNs": 136195758205000,
      "wallNs": 1788853517338745000,
      "statusKnown": true,
      "rawStatus": 9
    }
  },
  "observedBirths": 3,
  "observedPeak": 3,
  "reaped": {
    "B": true,
    "D": true
  },
  "directOwnerOutcomes": {
    "B": {
      "signals": [
        {
          "signal": 9,
          "purpose": "finally-cleanup",
          "success": true
        }
      ],
      "authority": false,
      "reaped": true,
      "returncode": -9
    },
    "D": {
      "signals": [
        {
          "signal": 9,
          "purpose": "finally-cleanup",
          "success": true
        }
      ],
      "authority": false,
      "reaped": true,
      "returncode": -9
    }
  },
  "passed": false,
  "durationNs": 104170000
}
```


## Second idle attempt — inspector promise error before preparation

The corrected controller and cleanup grace passed 43 Python mock tests, 27 controller assertions, syntax and lint. The main agent verified the returned harness diff: 22,638 bytes, SHA-256 `8488669e8bf6d5dbe381dbe0b79bf2bdd5cc38e51a330eb7a07e7a8a664522b5`. The changes select and invalidate default execution contexts, retain exact identity checks, wait up to one second for natural framework-helper exits within the existing cleanup deadline, and require the browser-loss payload to terminate by SIGTERM or SIGKILL before its alarm. Emergency or unconfirmed framework outcomes still fail qualification.

The explicit report for `macmini/req-5bf4be1f22eca12d34de56f06533ebf0`, retained at `/private/tmp/freedom-lifecycle-corrected-4caucv3j`, records another first-case failure: CDP error `-32000`, `Promise was collected`, during the synchronous identity evaluation. Preparation and Quit were not reached; the remaining three cases were not launched. B and D both have known kernel status 9 and sole-reap return code -9, with signal authority retired. No S/C/F role was observed. The case took 0.117596 seconds; both failed idle attempts together account for six observed instances and 0.221766 seconds. There is no native Quit or product browser-loss pass.

The product source subtrees and native helper hash remain unchanged. Full result and stream evidence is retained under `execution-am1g_kwr/quit-idle-y4gw4b55`. The next focused correction distinguishes synchronous identity/Menu evaluation from asynchronous fixture preparation instead of requesting promise awaiting for every expression. This follows the installed adapter's synchronous module acquisition, but the report does not prove why V8 returned that error. Actual context and option diagnostics will be retained in the next bounded attempt.


## Third idle attempt — identity and preparation pass, action logging fails

Request `macmini/req-0c52d72dd7757683801034c23f678215` ran once under `/private/tmp/freedom-lifecycle-sync-xpd4gi_9`. Synchronous identity/Menu calls now use `awaitPromise: false`, while preparation uses `true`; actual context 1 and these options are retained in D's diagnostic stream. Identity returned the owned B PID, Electron 43.0.0, Node 24.17.0 and the Electron app. Idle preparation returned all three app-owned composition checks true. The source diff is 12,132 bytes, SHA-256 `dfe5c29ba6f26130ec53a54b6551a8b92a472192be7c0263961483b98eee366e`, verified by the main agent. Focused checks passed 43 Python mocks, 32 controller assertions, syntax and lint.

After the preparation/identity acknowledgment, W sent the Quit command but its action logger threw `dict() got multiple values for keyword argument 'monoNs'`: the call expanded action timestamps into a function already assigning those keys. No native-Quit marker or shutdown sequence was produced before emergency cleanup. This is a harness defect, not a native Quit pass. The next correction nests action evidence and adds mocks invoking the actual action-to-log path, rather than only its state predicates.

The watchdog retained B/D unreaped through successful emergency SIGKILL, retired numeric authority, then reaped both with -9; both kernel statuses are known 9. Three framework helpers had genuine preacquired audit identities and were observed exiting with status 0 during the bounded grace, without helper emergency signals. No S/C existed. All registered roles have exit accounting, while unknown historical short-lived helpers remain outside the claim. This attempt took 0.388901 seconds with six observed instances; the first three failed idle attempts total 0.610667 seconds and 12 observed instances. Full raw outcome is under `execution-zue2n99s/quit-idle-_j5ovy9i/result.json`; source/helper and original remote checkouts remain unchanged.


## Fourth idle attempt — native Quit invoked, observer intervenes

Request `macmini/req-60fda2c37690e43a4af49e3b5ae722f1` ran once under `/private/tmp/freedom-lifecycle-actionlog-uh7o7cvd`. The action-log correction passed actual action/log orchestration mocks for idle/running Quit, browser loss, supervisor loss and failed audit signaling. Focused validation passed 48 Python tests, 32 CDP assertions, syntax and lint. The main agent verified the returned source diff and reviewed the corrected nested action evidence.

The native `terminate:` marker was written by actual B. Shutdown phases were ordered, without a drain warning; application `quit`/`process_exit` logs reported zero. However, a registered framework helper exited between observer polls, and `proc_pidinfo` returned ESRCH during its ancestry recheck. The watchdog treated that as an error, then emergency-killed B/D. Their actual kernel statuses and sole-reap results are 9/-9. Consequently this attempt is **not** a Quit pass: app logs cannot substitute for OS process exit.

All five registered framework helpers were later observed exiting with known status zero during cleanup grace; no helper emergency signal was sent. Their genuine audit identities had been acquired before the fault. No S/C existed. The attempt took 0.509652 seconds with eight observed instances, bringing the four failed idle attempts to 1.120319 seconds and 20 observed instances. These are sampled counts, not complete historical descendant accounting. Raw evidence is retained under `execution-rwq43xuh/quit-idle-5yqom287`; the product source/helper and original checkouts remain unchanged.

The next observer correction will reconcile disappearance of an already registered post-action framework identity with its original kernel exit event, within a bounded interval. ESRCH alone will not establish exit, new signal authority, or a pass. Pre-action live checks and final accounting of all registered helpers remain required.


## Idle native Quit passes; running preparation exposes missing artifact metadata

Request `macmini/req-d3680cb24ee9f2a9f213267b31b54297` ran the next campaign under `/private/tmp/freedom-lifecycle-observer-dtoisrwy`. The main agent verified the observer diff (14,962 bytes, SHA-256 `cb8f078f610503711e87bfbb399f4a387a9a011d64461f701c8769b91f79e1cb`) and reviewed its original-registration/PID checks, bounded 250 ms exit reconciliation, retained pending framework accounting after confirmed B exit, and unchanged pre-action checks. Focused checks passed 59 Python tests, 32 controller assertions, syntax and lint.

**Idle Quit passed** in `execution-e4hh4w8b/quit-idle-rjftc9u9`: actual B kernel status zero and sole wait zero, native `terminate:` marker present, ordered shutdown with no drain warning, no B signal, no browser/framework emergency cleanup, and no unconfirmed registered role. Four framework helpers exited zero; one exited by SIGTERM, explicitly preserved as an application-teardown outcome rather than normalized to zero. D was separately disposed by SIGKILL and reaped. Original-key F3 and B exit events resolved observed ESRCH races; neither ESRCH alone nor log messages supplied exit proof. Duration was 0.664807 seconds with eight observed instances.

The following running-Quit case failed **during preparation** because the copied candidate omitted `out/macos-supervisor/arm64/manifest.json`, despite retaining the correct helper executable. The product failed closed with `WORKSPACE_SUPERVISOR_UNAVAILABLE` before its capability probe or managed S/C launch. No running preview, Quit action, browser-loss or supervisor-loss claim follows. The failed case lasted 0.377658 seconds with six observed instances; emergency B/D cleanup and natural framework exit observations accounted all registered roles. The preparation-incomplete historical-observation caveat remains recorded.

The existing qualified artifact's matching manifest is already present under `/private/tmp/freedom-final-candidate-he26qp5x/candidate/out/macos-supervisor/arm64`: 245 bytes, SHA-256 `4f041593ff4ac95e1dbd8f6a952409c164dc34a228f0a833ac08f0fafeca7a88`. It declares protocol 1, arm64, minimum macOS 12.0, and the unchanged native source/binary hashes. The next setup will copy this existing metadata with its binary and invoke the actual read-only runtime resolver before a browser launch. No new acquisition or rebuild is needed.

This campaign's per-case sum is 14 observed instances and 1.042465 seconds; it counts the shared watchdog twice. Across preceding app attempts the per-case sum is 34 observed instances and 2.162784 seconds, not an exact historical process-birth census. Full results, races and source/artifact diagnosis remain in the remote campaign and `artifact-diagnosis.json`. Production source and both original checkouts remain unchanged.


## Complete helper artifact — idle passes again; running preparation times out

Request `macmini/req-4601dd75c93b33b8a5c33e64e4159b7e` restored the existing matching manifest and invoked the actual candidate `resolveMacosSupervisor()` under installed Electron-as-Node before launching a browser. The resolver, required-file checks, 59 Python mocks, 32 controller assertions and lint passed. Manifest SHA-256 `4f041593ff4ac95e1dbd8f6a952409c164dc34a228f0a833ac08f0fafeca7a88` and native source/binary identities matched before and after. No helper rebuild, download or dependency change occurred.

One campaign ran under `/private/tmp/freedom-lifecycle-complete-z1sjhcns/attempt01/execution-l35o27fg`. Idle native Quit passed again (`quit-idle-teffmgp0`): actual B kernel/wait zero, no B signal, native marker, ordered shutdown without a drain warning, all five registered framework helpers observed exiting (four zero, one SIGTERM), no browser/helper emergency cleanup, and D separately disposed/reaped. Duration was 0.664534 seconds.

Running preparation (`quit-running-k52ugyen`) timed out at the controller's eight-second CDP deadline. Identity had succeeded; the asynchronous preparation request produced no reply, S/C registration, preview, alarm or terminal receipt. The reservation intent existed but the workspace table had no rows, locating the delay before workspace creation without establishing the exact pending step. The source's separate five-second capability/runtime probe limits do not alone diagnose the timeout. No unchanged retry or speculative deadline increase was performed; browser-loss and supervisor-loss were not reached.

Emergency B/D cleanup had known kernel statuses 9, sole waits -9 and retired numeric authority; three registered framework helpers were observed exiting zero. Cleanup also encountered PID 77088 from parent enumeration whose **first** identity read returned ESRCH. It was never identified or registered and was never signaled. Unlike the already-registered exit race, its disappearance is not independently established as a particular process exit. `unconfirmed: []` therefore refers only to registered roles, not complete historical child accounting. The timeout and incomplete-preparation caveat remain failures.

The explicit report's prose gives running observed peak six, while the raw result records one: ancestry aborted before its peak update. Retain that discrepancy rather than treating either as a measured live maximum. Six registered-observed roles are recorded for the running case. Per-case counts across app attempts sum to 48 registered-observed instances and 10.960332 seconds, with the unregistered enumeration PID separately noted; shared watchdogs are counted per case. These remain sampled counts, not aggregate containment or complete historical births. All raw artifacts and the unused second-attempt record remain remote; no source or original checkout changed. An independent read-only review of inspector scheduling and preparation is in progress.


## Independent preparation-timeout review and main-agent disposition

Claude's explicit read-only review (`macmini/req-aaeba7ae3abfc4002265a5ac2803dc3f`, remote `/private/tmp/freedom-lifecycle-diag-claude.md`) confirms that the eight-second CDP timer fired before the watchdog's ten-second readiness deadline. It recommends starting preparation once, retaining its promise/result, and polling for completion instead of holding a single awaited inspector call. The main agent accepts that harness correction while preserving the actual returned fixture, preview/identity/action barriers and existing deadlines.

Two review inferences are not accepted as established facts. A possible ten-second readiness wait does not explain this particular timeout, which occurred before workspace/script creation; no-progress evidence alone also cannot prove inspector event-loop starvation. In addition, PID 77088 was never identified, so the review's description of it as an already-exited Electron helper and proposed benign-ESRCH treatment are unsupported. The original unknown-first-read failure remains. The next adapter will record queued/entered/settled job stages, use synchronous inspector calls around a single scheduled preparation, and report the actual result rather than synthesizing readiness from partial files. This is qualification-controller work, not a change to production sandbox authority.


## Start-once preparation still stalls; native sample identifies keychain authorization

The start-once adapter (`macmini/req-cdd314becf20e783583866e576a6d906`) passed 59 Python tests, 33 controller assertions, 13 serialized-job/poll orchestration cases, lint and the actual resolver preflight. Main verified its source diff: 17,276 bytes, SHA-256 `682779f8bf282c18058d23513e66ad9b034d1a8fc16d46e23519241591a3b02a`. It retains the job/promise, schedules entry normally, and polls synchronously within unchanged readiness bounds. Idle native Quit passed again, but a later synchronous running-preparation poll timed out. The last successful job snapshot was stale; the written reservation proves the actual preparation function subsequently entered. That failure did not establish inspector starvation. All registered B/D/framework outcomes were accounted after emergency cleanup; a new unidentified enumeration PID 77638 remained separate from the earlier 77088. The per-case sum reached 62 observed instances / 13.071687 seconds. Full evidence remains under `/private/tmp/freedom-lifecycle-job-aonq6i51/attempt01`.

A single **diagnostic-only** running-preparation attempt (`macmini/req-204ae5a496909a54d0091051f6502f69`) then sampled retained actual B before cleanup. It invoked installed `/usr/bin/sample 77943 1 10 -file /dev/stdout` through a separately owned/reaped direct sampler child. The captured 264,036-byte report is `/private/tmp/freedom-prepare-sample-n9dcy0en/execution-xc58pcgf/quit-running-ep_ab2rz/Q-stdout.log`, SHA-256 `bfc9e7d81ac7f0043cc05ac6cba4406cf9329aaa97b74a3527de9f443331d345`.

B's main thread spent all 90 samples in `SecItemAdd` → `SecItemAdd_osx` → `SecKeychainItemCreateFromContent` → `StorageManager::defaultKeychainUI` → `makeLoginAuthUI` → `AuthorizationCopyRights` → synchronous XPC/Mach wait. This directly locates the blocker during the sample in **macOS keychain authentication/authorization**, not a sampled `uv_spawn`/exec handshake or filesystem wait. The four libuv workers were idle in condition waits. Stripped/nearest-symbol Electron labels and unknown JS frames prevent exact initiating-JS attribution; `provider-store.js:getPublicStatus` and quick-unlock safeStorage checks are source candidates only. No keychain credentials, UI controls or permissions were changed, and no Myotis-cause inference is made.

The sampler exited with kernel/wait zero, no signal; B/D were then explicitly emergency-killed and reaped with 9/-9, after numeric authority retirement. Three identified observation-only Electron helpers exited zero. A further enumeration PID 77949 could not be identified and was never signaled or labeled a helper/probe. All registered roles were accounted, without a complete historical-cleanup claim. The sample hold was 1.640423 seconds, and the entire diagnostic 3.126739 seconds. Focused validation passed 66 unique Python tests, 33 controller assertions, 13 job cases, lint and resolver preflight; an initial discovery run duplicated ten imported tests and is not the unique count. No qualification pass is claimed for this diagnostic. Cumulative per-case accounting is 69 observed instances / 16.198426 seconds, plus the three separately unidentified enumeration PIDs.

The next credential-free qualification isolates unrelated secure-storage access in the harness. Installed Playwright supplies a mock-keychain switch, but its applicability to Electron 43 synchronous safeStorage has not been established from the inspected source. A narrowly gated test preload may instead declare secure storage unavailable and reject encryption/decryption, avoiding real keychain access while preserving real workspace/process execution and all permission/termination checks. This narrows provider capability; it is neither fake encryption success nor provider/keychain/release qualification. Production source, helper and manifest remain unchanged.

## Secure-storage isolation clears preparation; payload identity evidence remains incomplete

Request `macmini/req-1f8f49b0a7fc23a5ca62029ba61ff579` used a credential-free harness preload under `/private/tmp/freedom-keychain-isolated-3tsry5a9`. It removes Electron safeStorage capability before application code: availability returns false, encryption/decryption fail, and no original native storage method is forwarded. The preload requires the fixed test-mode, canonical owned paths, private user-data directory, exact token and prelaunch intent; it does not change other Electron APIs, workspace execution, sandbox policy or ownership. This qualifies only the explicitly substituted storage regime, not real-keychain, provider or signed-release behavior. No keychain dialog or host credentials were accessed. The main agent verified the final 16,869-byte source diff, SHA-256 `957522567049fc5fb66543c470caed75caeb9a22500852d02377b02b2462cd67`, and reviewed the capability removal and bounded preload-readiness check.

Both permitted campaigns stopped at their first failure:

| Attempt / case | Result |
| --- | --- |
| 01 idle Quit | Passed in 0.730820 seconds: actual B kernel/wait status zero, native marker and ordered shutdown, no B/framework emergency signal, all five registered framework exits observed. |
| 01 running Quit | Aborted in 0.090935 seconds before preparation. Inspector identity ran inside `Module._preloadModules` before the isolation marker existed. No S/C existed; B/D emergency cleanup and sole reap were recorded. |
| 02 idle Quit | Passed in 0.735085 seconds with the same actual-exit requirements and no B/framework emergency signal. |
| 02 running Quit | Real preparation succeeded in 884 ms, with all three app-owned composition checks and preview HTTP 200 / `agent-exit-preview`. Before any Quit/fault action, W failed its composite C argv/token/Python-image identity assertion. The failed case lasted 15.859569 seconds including cleanup and independent payload expiry. |

Attempt 02 adds a bounded wait for the real preload marker before full identity verification; it does not fabricate readiness. Checks passed 59 pure Python tests, 33 controller assertions, 13 preparation-job cases, 65 preload assertions, seven marker-ordering cases, lint and actual supervisor resolution. Both original checkouts and production source/helper/manifest identities remain unchanged.

The failed composite assertion checked three conditions without retaining the actual argv or executable first. It therefore does **not** establish which comparison failed. Its expected Python path resolves to `/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/bin/python3.9`; an installed framework `Resources/Python.app/Contents/MacOS/Python` also exists. This is a concrete launcher/image distinction to verify, not evidence that the unrecorded C image was that file. The next harness correction must record actual identity values before validating them and establish any launcher-to-image relationship with a fixed installed-runtime preflight. Token, exact script, parent, UID, start identity, original kernel registration and shared-clock requirements remain mandatory.

Cleanup is failed-test evidence only: W emergency-killed its still-unreaped direct B/D, used the previously acquired genuine S audit authority, and never signaled C. C survived until its own SIGALRM 14, observed at `141140372458000` CLOCK_MONOTONIC ns, approximately 14.004 ms after the earliest 15-second alarm bound (`141125358454000` before / `141125358456000` after installation). Its heartbeat was stable for 255 ms after exit and the owned preview port refused connections. Four registered framework helpers exited zero naturally; all registered identities were accounted for, with no unconfirmed entries. No raw executor or mapped terminal receipt preceded B's emergency death. This is neither running-Quit qualification nor the required supervisor-loss assertion sequence.

Raw running evidence is retained in `attempt02/execution-or5_55b5/quit-running-4l53eyhe/{result.json,trace.json,fixture.json,postmortem.json,D-stdout.log,D-stderr.log}`. Its raw `observedBirths` is eight while peak is nine: C registration preceded the failed assertion, but the counter increment followed it. Eight native registrations plus W establish nine known roles; raw evidence is not rewritten. Across these two campaigns the raw sum is 27 versus 28 registered-plus-watchdog roles, over 17.416409 seconds. Cumulative sums are therefore **96 raw / 97 registered-plus-watchdog roles over 33.614835 seconds**, with the earlier unidentified PIDs 77088, 77638 and 77949 still separate. These counts can recount W and miss short-lived helpers; they are not aggregate OS containment or a complete historical birth census. Running Quit, browser loss and supervisor loss remain unqualified at this checkpoint.


## Final bounded campaign — passed with explicit limits

The installed Python self-image preflight and split identity validator resolved the remaining harness mismatch without loosening token, parent, UID, start, registration or clock checks. Request `macmini/req-676112afd82ae6f78d2b5d1bdc4dedf4` then passed all four cases in its first campaign. [The final lifecycle report](macos-native-lifecycle-qualification-2026-09-08.md) records actual Quit/browser-loss outcomes, the deliberately demonstrated supervisor-loss survivor, raw receipts, exact source/runtime identities, independent Claude review and cumulative accounting. No second campaign ran. Earlier failures and unknown observations in this document remain historical evidence, not retroactive passes. This closes the bounded original-root ownership checkpoint under unavailable-safeStorage TEST_MODE; it does not establish complete descendants, real-keychain/provider behavior or release qualification.
