# Disposable-Mac native supervisor design review

Explicit reply to `macmini/req-a0eda72693fc4da4a80592781eddedaa`, received 2026-09-07. This is a design assessment, not product qualification. The reviewer was asked not to implement or change packaging; statements about approval in the reply describe that review's scope. Main retains execution ownership under the existing architecture. The user has authorized native cleanup work and excluded VMs.

Native macOS supervisor design review — no implementation or fixtures run

State verified: /Users/flobot/Git/freedom-dev/freedom-browser is clean on codex/agent-workspace-macos-qualification, HEAD 11a863ecad4c02ed139040243d0ed657b7a1443b; git status --short remained empty. AGENTS.md, the architecture playbook, existing Seatbelt launch/signaling, disposal and packaging configuration were inspected. No existing Codex checkout was found at /Users/flobot/Git/codex or /Users/flobot/Git/freedom-dev/codex, nor process_group.rs beneath /Users/flobot/Git. I rely on your supplied Codex comparison, not an independently inspected remote Codex revision. No other-machine work occurred. The previous macOS 15.6 / arm64 / SDK 15.5 baseline applies. Both previous assessment/probe evidence directories remain retained.

Recommendation: a supervisor is useful, but the smallest worthwhile first slice does NOT need a separate anchor. Keep the original sandbox-exec root as the initial session/group leader, make a small native supervisor its direct parent, and deliberately retain the root unreaped until the final original-group signal is finished. This improves browser-crash cleanup and removes an avoidable numeric PGID-reuse window while that supervisor still owns the unreaped child. It needs no audit-token API, descendant scan, privileged helper, service registration or third-party dependency. It is a design inference to validate, not a newly qualified shipping guarantee.

Why the retained root matters: the inspected host-family XNU allocator refuses PIDs still present for running OR zombie processes, existing process groups or sessions (forkproc, kern_fork.c). With initial PGID equal to root PID, retaining that direct root keeps the number unavailable for unrelated PID reuse, even if the root exits or changes groups. Group membership itself can still change and the original group can cease to exist. A missing group yields no authority to invent a new target. After reaping, permanently disable every delayed signal/retry for that number. Source: [immutable XNU forkproc](https://raw.githubusercontent.com/apple-oss-distributions/xnu/43a90889846e00bfb5cf1d255cdc0a701a1e05a4/bsd/kern/kern_fork.c). Group creation/join restrictions are also described in the installed setpgid(2) manual.

Proposed minimal topology

  B = Electron browser (trusted)
       | anonymous control/liveness writer; bounded result/output reader
       v
  S = native supervisor (trusted, outside command Seatbelt; separate from worker group)
       | direct parent; owns wait/reap and all original-group signaling
       v
  C = sandbox-exec -> fixed trusted post-sandbox gate -> requested command
      initial SID = PGID = PID(C), matching today's detached:true behavior
      inherited Seatbelt filesystem/network authority for every descendant

C is the existing execution root, not another permanently resident wrapper process: sandbox-exec and the gate exec forward in the same PID. S is the only added process per execution. Use installed POSIX spawn APIs with explicit setsid/group configuration, not a late parent-side setpgid after exec. S must never be a member of C's group. New session creation prevents accidental linkage to unrelated browser/terminal groups. Restrict this first design to current pipe-based commands; PTY/job-control integration would be separate.

S observes root exit without reaping (EVFILT_PROC NOTE_EXIT, or waitid with WEXITED|WNOWAIT after checking platform behavior). Keep SIGCHLD at a disposition that retains zombies; no SIG_IGN, SA_NOCLDWAIT, generic waitpid(-1) reaper or libuv ownership of C. Native single-owner bookkeeping is essential. Root exit triggers the existing final group-KILL attempt even if stdout descendants keep pipes open. Cancellation retains bounded TERM/grace/KILL. Finish all group-signal timers before reaping; preserve exit status and bounded failure diagnostics. Do not infer empty descendants from the root exit, EOF or kill return value.

FD ownership and launch protocol

- B alone retains the B->S control/liveness write end; S alone reads it. A dedicated liveness pipe with no data is simplest; a framed control pipe can also carry ABORT, provided buffered messages cannot cause launch after terminal EOF/abort. No renderer, helper or command descendant may retain a writer.
- S creates worker stdin/stdout/stderr pipes, drains output independently of B and bounds forwarding. EPIPE or full browser output must not stall cleanup; suppress/handle SIGPIPE in S and continue to the deadline. Do not let a retained stdout writer define process lifetime.
- A trusted post-sandbox gate can use dedicated S->C release and C->S readiness descriptors; it closes both before exec of untrusted argv. Readiness proves the profile/gate was reached, not completion or continued browser life. Never multiplex trusted lifecycle records into untrusted stdout after release.
- Use close-on-exec at creation where available, POSIX_SPAWN_CLOEXEC_DEFAULT plus an explicit dup/inherit allowlist and close actions. CLOSE-ON-EXEC ALONE DOES NOT PREVENT FORK INHERITANCE: every native fork branch must close unrelated ends immediately, and Electron's spawn path must be checked too. Child masks/dispositions must be reset deliberately; an ignored TERM or blocked signal mask in a trusted helper must not silently propagate into commands.
- Before spawning C, S establishes control monitoring and a fixed setup deadline. Once C exists, S records its direct-child PID immediately and retains it unreaped. The gate stays blocked until S has initialized ownership, exit observation, output drains and cancellation state. C enters its final original group/session before any untrusted execution. Missing descriptors, malformed setup, failed group/session setup, early EOF or timeout fail closed.
- ABORT is idempotent and terminal for that launch ID; a late READY/GO cannot resurrect it. Browser death before C creation means no command launch; after C exists it means bounded cleanup. There is no atomic transaction combining “browser still alive” with exec: death concurrent with a committed release may allow brief execution before cleanup. Preserve sideEffects:unknown after launch; do not claim rollback or zero side effects in that race.
- A browser NOTE_EXIT watcher may supplement the pipe once registered during the trusted setup handshake; it must not become a PID-based restart cleanup facility. Do not extend that watcher into NOTE_TRACK/tree ownership claims.

Does a separate trusted anchor work?

Plausible second-stage topology, mainly to improve S-crash behavior:

  B -> S (new private session; S in group S)
         +-> A (trusted direct child, group leader A, same session as S)
         +-> C (direct child, POSIX_SPAWN_SETPGROUP into group A; then sandbox-exec)

A is a GROUP anchor, not a separate session leader. If A calls setsid(), sibling C cannot join A's session/group with setpgid; C would have to be spawned by A instead, changing who can reap/report the execution root. Do not accidentally combine C's existing detached/setsid launch with joining A's group. In this sibling layout the root C also ceases to be the session/group leader and can call setsid directly; that is an additional behavioral change, not stronger containment.

A reports ARMED only after group establishment, its S->A liveness reader and emergency cleanup state are ready. S is the sole writer of S->A liveness. C must inherit neither that writer nor any B->S writer. C cannot start until A is armed. On normal TERM escalation, A handles/ignores TERM long enough to remain an anchor. S sends final KILL to group A, including A and C, while S remains outside. S retains A unreaped until its LAST possible group signal has completed. A's PID then provides the same reservation invariant as the minimal root design; after reaping A there must be no delayed group retry.

If S dies, a live A sees EOF and performs its own bounded TERM/KILL against its own group, finally including itself. This can reduce orphaned intact-group workers. A must verify its fixed startup group invariant and never accept caller-supplied arbitrary PGIDs. No loop that discovers “descendants” creates authority. An A process stalled in SIGSTOP, crashed, killed, unscheduled under severe resource pressure, or losing its liveness invariant cannot provide this fallback. S and A failing together remains unresolved. A watchdog adds availability, not an OS-enforced death guarantee.

Can C signal A? Current generated policy is deny-default with `(allow signal (target same-sandbox))` (seatbelt-backend.js:314–317); placing A outside that particular sandbox is intended to deny C->A signals, including SIGKILL/SIGSTOP. This is a required qualification hypothesis, NOT established by the two earlier audit-token probes or by ordinary UNIX same-UID permissions. The SBPL primitive is itself a private/deprecated interface. Verify individual and group-directed signals with the exact composed policy, and ensure the helper has no same-sandbox signal-grant mistake or leaked control descriptors. Do not give A the worker sandbox merely because it shares the group.

Also, a live signallable A makes killpg success even less informative: success can reflect delivery to A while another member is denied. Matching XNU killpg1 checks members individually and reports success if any eligible target was found. Therefore return 0 never proves worker teardown or validates C->A isolation. Source: [matching XNU killpg1](https://raw.githubusercontent.com/apple-oss-distributions/xnu/xnu-11417.140.69/bsd/kern/kern_sig.c), killpg1_callback/killpg1. The separately proposed anchor isolation test remains necessary.

Concrete failure table

| Event | Minimal S + retained C | Extra A, if later adopted | Limit / required response |
|---|---|---|---|
| B exits/crashes before release | S sees liveness EOF, refuses release or tears down created C | Same, with A armed before C | Setup deadline; never label a raced spawned command side-effect-free |
| B crashes after command starts | S performs bounded original-group TERM/KILL without Electron JS | Same | Assumes S remains alive/scheduled and no writer leakage |
| C exits normally, same-group children retain output | NOTE_EXIT drives final group cleanup before C reap | A keeps group alive; S still observes/reaps C separately | Output EOF is not the trigger or completeness proof |
| C changes group / descendant setsid or job control | Original group gets cleanup; moved process may survive | Same; C itself can detach more directly in sibling topology | best_effort/original_process_group remains literal |
| C or A exits before final KILL | Preserve relevant direct child as zombie until last signal | Preserve A; react to premature A exit as cleanup fault | No automatic reaper; destroy all signal timers before reap |
| B liveness writer leaks into a long-lived child | EOF may be delayed; deadlines/root watcher help diagnose | Same hazard, plus S->A leakage | Explicit per-role FD inventory and closure are a release requirement |
| S crashes during C setup | C might exist; gate EOF may stop unreleased C | Live A can clean its group, but late spawn/join/commit races still need tests | Never claim that the gate alone covers all setup-crash windows |
| S crashes after release | Group can survive; B records interrupted/unresolved | Live A attempts group cleanup on S->A EOF | B must not blindly signal old PGID; S's unreaped reservation may disappear through reparenting/reaping |
| S hangs while alive | S's own event loop cannot enforce a deadline while wedged | A needs an independently enforced lease/deadline to notice a hang; EOF alone is insufficient | Availability still bounded by scheduler/resources; lease policy is a decision |
| A and S crash, host shutdown, or startup recovery | No durable reclamation guarantee | Still no guarantee | No persisted PGID kill; retain honest interruption/survivor diagnostics |
| killpg fails / only some members receive it | Report error and bounded expiry | A must not mask failure with an unqualified success claim | Do not import blind enumeration->getpgid->kill fallback |

Smallest next implementation/probe slice (proposal only)

1. Keep your awaited JavaScript disposal correction separate and land/validate it on its own merits. It closes orderly-shutdown waiting; it does not solve browser or native supervisor crash. The native adapter can later return a completion promise that awaited disposal joins without clearing state before receipts settle.
2. Author one small dependency-free C helper owning a single execution root, with a blocked launch handshake, explicit FD allowlist, public kqueue/wait interfaces, PID reservation through delayed reaping, monotonic TERM/KILL deadlines and bounded output. Preserve existing Seatbelt profile compilation/runtime attestation and receipt fields; do not add libproc enumeration or audit-token signaling to this slice.
3. Before product integration, choose a disposable synthetic-parent probe with a self-expiring intact-group worker: validate (a) root exit observed while root remains waitable, final group signal before reap, and no signal afterward; (b) parent control closure while gate blocked and while worker runs; (c) retained-output writer cannot delay receipt; (d) injected setup failure closes all ends. No real app Quit, detached/hostile tests, root or service registration is needed for this first targeted slice. Specify fresh fixture bounds and independent cleanup before authorizing it; nothing was run here.
4. Defer A until the minimal supervisor benefit is demonstrated. A needs separate proofs for sandbox signal isolation, distinct group/session setup, TERM survival, supervisor-death EOF and simultaneous setup teardown, and a decision on hang-detection leases. It is feasible enough to investigate, but not minimal and not yet established safe to ship.

Packaging / decisions

The helper can be compiled by existing clang against libSystem without a new third-party dependency or special entitlement for the proposed public APIs. A real executable must be shipped outside app.asar, architecture-matched (arm64/x86_64 or explicitly universal), signed as nested code in the normal Developer ID/hardened-runtime/notarization build, and launched by a validated absolute bundle path. Do not blindly copy the browser's broader entitlements or grant it a general signal-by-PID RPC. Capability probing must handle missing/invalid helper/runtime combinations honestly. Current package.json only unpacks native Node artifacts; the qualification builder clears extraResources, so BOTH product and qualification packaging need deliberate changes before this helper can be qualified there. No packaging change is authorized by this review.

Decisions remaining: approval for a native executable/process boundary and build integration; exact helper placement/supported deployment targets; native-unavailable behavior; setup/cleanup time budgets coordinated with awaited disposal; whether the extra anchor and its independent lease are worth the cost. Existing architecture playbook requires approval before boundary changes; this report merely proposes them. VMs are excluded as instructed. Private libproc APIs and the newer entitled macOS 27 ES option are not assumed shipping foundations.

Local API references: SDK /Library/Developer/CommandLineTools/SDKs/MacOSX15.5.sdk/usr/include/sys/spawn.h:46,61–62 (SETPGROUP, SETSID, CLOEXEC_DEFAULT); spawn.h:60–80 and :173 (spawn/file actions); sys/wait.h:162–174 (WEXITED/WNOWAIT), sys/signal.h:303 (SA_NOCLDWAIT); sys/fcntl.h:152,355 (O_CLOEXEC/FD_CLOEXEC); installed man2/pipe.2, setpgid.2 and setsid.2. This installation did not provide a standalone waitid manpage; WNOWAIT was inspected in the SDK and remains a native behavior to verify in the next chosen probe.

All product guarantees remain best_effort / original_process_group / survivorsPossible=true / completeDescendantTermination=false. Stop is not permission revocation, and no native lifetime improvement changes Linux namespace semantics. No files in either Freedom checkout were changed, and no fixture, implementation or qualification was launched for this review.
