# Packaged workspace qualification — 2026-09-08

Status: preparation in progress; no current packaged macOS or Linux pass is claimed. The user selected packaged-app qualification, including bounded detached cases, and explicitly added Linux regression coverage. macOS runs belong on the disposable Mac; Linux runs use its existing disposable non-root identity. The primary Mac runs ordinary unit tests and source review only. No new third-party software, credentials, OS configuration, release publication or signed/notarized qualification is implied.

The existing platform qualification configurations replace the package's main entry point with `electron-qualification-main.js`. Those artifacts establish backend/asar evidence, but do not by themselves exercise the real browser's shutdown. The new qualification needs `src/main/index.js` in `app.asar`, actual packaged application identity, and platform-specific runtime/cleanup observation. Optional node payload omissions and any credential-free test substitutions must be reported explicitly.

## Bounded detached test support

The existing test-only `prepareAgentExitScenario` detached mode previously had unbounded heartbeat loops. Both parent and forked child now arm their own expiry alarms, with the child doing so before session changes or I/O. Each records shared `CLOCK_MONOTONIC` and wall-clock alarm anchors plus PID, parent, session and process-group identity. These are fixture safeguards and observations, not product termination guarantees. The fixture remains one parent and one child; the configured expiry is limited to 1–15 seconds.

Detached mode now reserves its token before workspace preparation, execs the fixed Python entry point, and retains raw executor, mapped terminal and native supervisor evidence through the existing observational wrapper. An exception after child creation leaves execution observation in place until the actual result settles. These changes stay in main's existing TEST_MODE harness; no renderer, IPC, sandbox policy or production execution authority changes. Pure mocks cover timer ordering, token replay, receipt preservation and partial-setup failure without executing Python or native processes.

Validation: focused 16 tests passed; ordinary full Jest passed 4,119 tests across 238 suites, with 54 tests / seven suites skipped, and lint passed. Logs on the primary Mac: `/private/tmp/freedom-packaged-detached-{focused,tests,lint}.log`. No actual detached/app-exit fixture ran there.

## Linux source-review finding

The Linux inventory reports installed Bubblewrap 0.9.0 and an existing dedicated `freedomqual` identity (uid 1001). Its newest relevant checkout is `fcd05dfcbed4a325a16003ca0686f12d1419a28d`, which does not contain the current source; no old run is assigned to the new candidate. Current dependency/asset compatibility and source transfer remain preparation gates.

Independent Claude request `local/req-aada700aa376b340471e41f297531238` identified a pre-existing cancellation race in `bubblewrap-backend.js`: it stores the reported namespace-init PID and signals that number while checking only the outer Bubblewrap child's JavaScript exit state. The outer Bubblewrap can reap the init before Node receives the outer process's exit callback, leaving a window in which that number could be reused. This is source-derived, not an observed PID-reuse exploit or a regression introduced by macOS supervision.

The main agent checked the matching [Bubblewrap 0.9.0 monitor and parent-death implementation](https://github.com/containers/bubblewrap/blob/v0.9.0/bubblewrap.c#L438) and [documented `--die-with-parent` behavior](https://github.com/containers/bubblewrap/blob/v0.9.0/bwrap.xml#L481). Removing the direct init signal may avoid that class of stale target, but must be reviewed against initialization races and verified namespace teardown before adoption. JavaScript ChildProcess signaling has a separate, narrower ownership concern from the retained Node/libuv review; it is not promoted to a kernel-bound handle by this finding. Namespace isolation and signal-target identity are distinct properties.

No Linux backend change or runtime qualification follows from this source finding alone. The concrete plan must retain it, establish safe test-only fault authority, and use the disposable UID. No PID-reuse stress, host-wide PID cleanup or arbitrary process-name signals are authorized.
