# macOS native execution supervisor

Repository destination: `src/main/agent/workspace-execution/native/`.
This directory contains a dependency-free libSystem C supervisor and mock unit tests.
It belongs to the main process Seatbelt backend. It is not a daemon, privileged
helper, IPC service, process scanner, or replacement for execution-policy validation.

## Contract and entry points

- `macos-supervisor --supervise TIMEOUT_MS PROFILE_ABSOLUTE -- COMMAND [ARGS...]`
- `macos-supervisor --gate -- COMMAND [ARGS...]` (private post-Seatbelt entry)
- `macos-supervisor --version`: `{"protocol":1,"build":"<source-sha256>"}` plus newline.

B validates canonical helper/profile paths, executable architecture/build, cwd and
policy environment before invoking S. S checks decimal timeout 1..1800000, a
canonical absolute regular profile file, fixed launcher `/usr/bin/sandbox-exec`,
its own `_NSGetExecutablePath` resolved with `realpath`, and rejects DYLD_/LD_
injection variables. That last check occurs after S's loader: B must already
filter its environment before starting any trusted helper or version probe.
No environment variable or CLI argument chooses a launcher, PID target or test mode.
B must protect the helper file AND its replacement-controlling ancestor directories
from sandbox workspace/private-directory writes. Realpath does not atomically bind
an executable vnode across an adversarial replacement; packaged path/integrity
validation remains B/build responsibility.

S is B's child, C is S's direct child. S uses `posix_spawn` with SETSID,
CLOEXEC_DEFAULT, SETSIGMASK and SETSIGDEF to launch sandbox-exec -> this same helper
--gate -> execvp(COMMAND, argv), all in the same root PID. No shell serialization
occurs. execvp intentionally retains PATH search and Darwin's ENOEXEC shell fallback.
The command arguments and inherited cwd/env are unchanged. Execution permission for
the exact trusted helper and its required loader dependencies must be part of the
validated Seatbelt profile. No broad helper-directory permission is implied.

The resulting contract remains `best_effort`, `original_process_group`,
`survivorsPossible=true`, `completeDescendantTermination=false`. Successful signal
syscalls, root exit, output EOF and gate messages are not descendant-completeness
proofs. Stop is not permission revocation. Group changes, detached descendants,
S crash/stall and startup recovery remain unresolved. No Linux code is changed.

## Descriptor and transport ownership

B spawns S detached with stdio `['pipe','pipe','pipe','pipe','pipe']`. These Node
streams can be full-duplex socketpairs; the protocol uses only one direction of
each lifecycle stream. Only B retains the peer endpoint whose write half keeps
S's control reader alive. Do not end that write half after sending G.

| Stage | Descriptors |
|---|---|
| S before spawn | 0/1/2 command stdio, 3 B control reader, 4 B status writer, own gate pipe ends and temporary source duplicates >=8. |
| sandbox-exec/C gate | Exactly 0/1/2 and 5 gate-release reader, 6 private gate-status writer are explicitly mapped. All other inherited descriptors are excluded with CLOEXEC_DEFAULT. |
| S after spawn | Close ALL 0/1/2 copies and child gate ends/staging copies immediately; retain 3/4 and own gate writer/reader. S does not buffer, consume or write command output. |
| C after release | Close5; 6 has FD_CLOEXEC and disappears in successful exec, including execvp's shell fallback. Payload retains only0/1/2. |

Every source descriptor is staged uniquely >=8 before ordered dup2/close file
actions. Native gate pipes are nonblocking and CLOEXEC in S; spawn's explicit
mappings preserve5/6 through the first exec. The trusted gate then marks5/6 CLOEXEC,
checks that3/4 were not inherited, sends fixed private readiness, and blocks finitely
for release. Exact sandbox-exec descriptor preservation and loader behavior still
need the separately authorized real-chain qualification: the existing no-exec
prototype and these mocks do not establish them. The first four real-chain cases
are now retained in `research/evidence/macos-native-supervisor-implementation-2026-09-07.md`;
their exact runtime/artifact scope is narrower than full-product qualification.

S only writes bounded FD4 lifecycle records, suppresses SIGPIPE, and resets SIGCHLD
to default without SA_NOCLDWAIT. It never installs a generic reaper. The gate resets
ordinary signal masks/defaults (including SIGPIPE) before requested exec. No test
expiry alarms exist in production. Native stdio is not made nonblocking by S.

## Protocol and timing

FD3 accepts one G and terminal A. EOF and transport errors are terminal. Unknown,
duplicate or excess bytes fail. Each drain has a fixed byte/syscall budget; it
collects a batch before acting, so coalesced G+A or G+EOF cannot release the gate.
A second drain immediately before gate release narrows, but cannot eliminate, a
concurrent browser-death race. A previously committed release can execute briefly
before a subsequent EOF is observed. Input arriving before public READY is rejected.
No public PID, signal operation or lifecycle data is read from stdout/stderr.

FD4 contains optional `{"v":1,"type":"ready"}` then one FINAL, newline framed,
<=1024 bytes per record and <=2 records/2048 bytes total. FINAL always has exactly
these keys:

```
v type reason spawned releaseIssued rootExitObserved rootReaped groupVerified
cleanupUncertain exitCode signal finalKillAttempted signalErrors setupError
```

Reasons are completed/cancelled/timed_out/setup_failed/supervisor_failed. Natural
root exit after release uses completed even for nonzero exit status; JS maps the
actual code to failed. Cancellation/timeout retain the actual observed root status.
A post-release private execvp-error record provides `setupError=errno` and actual
root exit127 with reason completed; it does not manufacture a pre-release failure
or successful exec claim. EOF on private FD6 is not itself an exec-success proof.
Before release, initialization errors are setup_failed. Protocol/observation errors
are supervisor_failed; they may supersede a previous cancellation reason. An
unwaitable root after settle remains the requested reason with cleanupUncertain;
a reap error additionally reports supervisor_failed. Signals failing with EPERM,
ESRCH or any other errno are retained literally, at most one term and one kill error.
They conservatively set cleanupUncertain even if only a zombie remained.

Time uses public `mach_continuous_time` (macOS10.12+, available at deployment12.0)
converted through mach_timebase_info, including system sleep. Total timeout begins
at S entry and is never reset at ready/release. Startup is min(5s,total timeout).
A pre-spawn control/deadline recheck follows action/path preparation. Individual
filesystem/spawn/kernel operations cannot be forcibly preempted by this event loop;
S suspension/stalls and scheduler latency remain disclosed limitations.

S polls WNOWAIT at10ms ticks. The private readiness identity must match C and
kernel getpgid/getsid, and successful waitid confirms direct ownership before READY.
Any mandatory validation failure is terminal. ECHILD permanently disables signal
authority immediately. Before group verification only direct unreaped C may be
signaled; afterward only the original group -PID(C). Natural exit triggers final
KILL promptly; cancellation sends TERM, waits up to1s, then final KILL. S retains C
unreaped through that last signal. It permanently disables all signaling at final
KILL, waits at most250ms for a waitable root, and performs a bounded WNOHANG reap
(max4 EINTR attempts). Unobserved/unreaped/lost ownership is explicit uncertainty;
there is no blocking reap, numeric rediscovery or stale retry after retirement.

Status writes use finite nonblocking batches. Pending READY backpressure is bounded
by startup; hard status errors trigger cleanup. After retirement FINAL flushing is
bounded at250ms, then S exits, using125 if its status could not be delivered. Early
failure to initialize a safe status FD can also exit125 without a record and without
spawning C. B must classify missing receipt as uncertainty. Natural success of the
supervisor process is never a substitute for a valid FINAL.

B must NOT supply Node spawn `signal`, `timeout`, or killSignal options, nor call
child.kill/process.kill on S/C. It sends A or closes control. At S 'exit', boundedly
drain FD4 before deciding FINAL is missing (status bytes may still be queued).
Do not use child 'close' as root-lifetime evidence. After FINAL, B independently
uses a250ms idle drain for command stdout/stderr, extended on progress within a
hard two-second bound; forced destruction needs explicit
output-drain/truncation uncertainty. S has no output forwarding or output policy.

## Build and tests

Only installed Apple clang/SDK/libSystem are required. Production compilation
requires `FREEDOM_SUPERVISOR_BUILD_ID` to be the lowercase SHA256 of the exact
macos-supervisor.c bytes, as a quoted C string. Missing macro is a compile error;
a malformed build ID cannot run production/version/gate entry points. Build-time
source identity is not a runtime code-signature substitute.

Normal development builds use `npm run build:workspace-supervisor` at the repository
root; `npm start` builds it automatically through `prestart`. Packaging calls the
same build hook. It uses installed Apple toolchain paths without launching installers.
The helper belongs outside app.asar and outside every workspace-writable root.

Low-level compile/mock examples (from this source directory, no download/install step;
select an already installed clang directly if the generic command is an installer shim):

```sh
source_sha=$(shasum -a 256 macos-supervisor.c | awk '{print $1}')
clang -std=c11 -Wall -Wextra -Werror -mmacosx-version-min=12.0 -arch arm64 \
  "-DFREEDOM_SUPERVISOR_BUILD_ID=\"$source_sha\"" macos-supervisor.c -o macos-supervisor
clang -std=c11 -Wall -Wextra -Werror -mmacosx-version-min=12.0 -arch x86_64 \
  "-DFREEDOM_SUPERVISOR_BUILD_ID=\"$source_sha\"" -c macos-supervisor.c -o macos-supervisor-x64.o
clang -std=c11 -Wall -Wextra -Werror -mmacosx-version-min=12.0 -arch arm64 \
  macos-supervisor.test.c -o macos-supervisor-tests
./macos-supervisor-tests
```

The unit translation unit includes the same implementation with main renamed and
an unbuilt unit-only build ID; it never calls that entry point or SYSTEM_OPS. All
kill/wait/group/I/O/clock operations in tests are injected local functions. There
is no runtime test backdoor, no fork/spawn/real signal, no filesystem fixture and
no actual sandbox in these tests. The tests cover state transitions, ownership
loss, abort/release priority, rejected frames, error receipt fields, interrupted
wait/reap, nonwaitable settle, and bounded status backpressure. Production entry,
spawn file actions and kernel sandbox/exec behavior require separate real tests.

Build binaries outside app.asar, architecture matched, through primary build/signing
integration. macOS12 is the selected deployment floor, matching inspected Electron
43. Both normal and qualification resource lists must contain the helper. Nested
code signing must use an explicit least-privilege helper entitlement selection;
never blindly copy the browser JIT/unsigned-memory/library-validation exceptions.
Unsigned compilation/mock success is not signed/notarized qualification.

## Local SDK references

MacOSX15.5.sdk/usr/include: sys/spawn.h:45–62 (flags), spawn.h:60–109 and173–180
(actions and availability), sys/wait.h:162–174,249 (WNOWAIT/waitid), sys/signal.h:303
(SA_NOCLDWAIT), sys/fcntl.h:351,355 (dup CLOEXEC), mach/mach_time.h:56–62 (continuous
time), mach-o/dyld.h:96–105 (_NSGetExecutablePath versus real path). These are public
installed APIs; SETSID/CLOEXEC_DEFAULT are Darwin extensions. The installed exec(3)
manual documents PATH and ENOEXEC compatibility. No private libproc/audit-token/ES
or privileged ownership mechanism is used.
