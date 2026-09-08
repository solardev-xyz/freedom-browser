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
