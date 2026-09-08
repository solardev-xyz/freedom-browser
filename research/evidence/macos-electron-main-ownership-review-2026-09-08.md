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
