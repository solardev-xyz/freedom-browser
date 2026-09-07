# Independent Claude review and main-agent disposition

Explicit reply to `macmini/req-8bce77797149f37540735e826c33ce09`, received 2026-09-07. Read-only review on the disposable Mac; no additional fixture run. The returned review is retained verbatim below. It is review input, not a source of new qualification results or accepted kernel guarantees.

## Main-agent disposition

Accept the retained-root mechanism for continued native integration design, subject to the following corrections and proofs. Do not ship the synthetic fixture as a product helper.

- **Adopt:** explicit gate-descriptor closure before untrusted exec, independent `getpgid`/`getsid` verification while the direct root is held at a trusted gate, bounded output drain with truthful truncation, nonblocking lifecycle writes, default worker signal state, and structural no-signal-after-reap state transitions. These are production requirements, not completed checks. Independent kernel verification strengthens the trusted gate; the prototype's trusted self-report was not untrusted model output.
- **Refine P1-1:** the two observed `EPERM` results remain raw failed signal attempts with known root-exit context. They do not prove an empty group or successful termination. Retaining that diagnostic is not itself a misreported failure: current code does not change a successful command state merely because final signaling returned `EPERM`. Do not adopt the review's unverified universal errno mapping or turn `EPERM` into success. Matching-source verification and an exact phase-aware result contract are still needed. A retained-phase `ESRCH` deserves investigation, not silent inheritance of the current JS helper's treatment.
- **Refine P1-2:** the proposed production gate is trusted native code after `sandbox-exec`, not the current shell marker script assumed in parts of this review. Spawn-time descriptor allowlisting and final payload-exec closure are separate steps. Both need a real exec-chain proof. Post-release status policy must distinguish any explicitly specified trusted exec-failure message from forbidden payload writes.
- **Refine P1-4:** root completion will end the original group without waiting for background work to finish; document that behavior. The review's `sleep 2; echo late` example would ordinarily reach output EOF after two seconds under the existing backend, not necessarily wait for the wall timeout. The valid concern is root/output lifetime separation and bounded preservation of already-produced output.
- **Adopt evidence limits:** the post-reap check is straight-line evidence, the sentinel is not a PID-recycling test, and the forged-output assertion does not exercise a production parser. The orphan's event establishes exit, not the cause of exit. Any future `NOTE_EXITSTATUS` assertion needs its own supported-host check.
- **Correct P3-3:** a persisted monotonic timestamp can become invalid across reboot; the cutoff subtraction need not fail closed if the new clock is lower. The persisted birth cap still bounds this fixture, and no reboot/retry occurred in the recorded run. Future reusable drivers must reject cross-boot budgets or start a separately owned run with an explicit fresh bound.
- **Do not authorize the suggested 20-iteration loop:** it exceeds the existing task's finite birth budget. Any additional run needs a new concrete bounded plan within the already authorized disposable-Mac task scope.
- Main review additionally found assertion-only setup failure handling and a post-spawn artifact write outside exception-safe cleanup in the driver. Successful cases do not validate those unexercised branches. Preserve the original source/results and fix these in any future harness rather than rewriting historical evidence.

The review did not inspect the primary branch's shutdown changes, packaged integration, matching XNU source, or actual Browser exit. Its strongest kernel statements remain unverified review inferences unless independently established in the ownership assessment. Public termination claims remain unchanged, with detached descendants and supervisor failure explicitly unresolved.

## Verbatim explicit reply

# Independent adversarial review: retained-root native supervisor prototype

Reviewer: Claude (independent, read-only). Nothing was executed, compiled, modified, installed or fetched. No fixture was launched. Both Freedom checkouts were left untouched; `/Users/flobot/Git/freedom-dev/freedom-browser` verified on `codex/agent-workspace-macos-qualification` at `11a863ecad4c02ed139040243d0ed657b7a1443b`, `git status --short` empty.

Inputs read in full: `prototype.c`, `driver.py`, `SAFETY-PLAN.txt`, `manifest.json`, `compile-result.json`, `compiler-command.txt`, `birth-budget.json`, `identity-after.json`, all four `attempt-0N-*-{intent,browser-owned,result}.json` and `attempt-0N-*.jsonl`, the first ~60 lines of `reply.md` (narrative; the remainder is embedded copies of the above), the prior design review `/private/tmp/herdr-peer-native-supervisor-review-oamfaazr.md`, `src/main/agent/workspace-execution/seatbelt-backend.js`, `AGENTS.md`, `docs/agent-playbooks/architecture-boundaries.md`, plus local SDK headers (`sys/wait.h`, `sys/event.h`) and the installed `kill(2)` manual. The main agent's JS commits edd6a0d8 and f1eed269 are not on this checkout and were NOT reviewed. The cited XNU commit was not fetched; kernel statements below are marked as inference where they rest on memory of XNU rather than on a local artifact.

## Bottom line

The prototype does what it says and its evidence is honest. I found no unsafe cleanup action in it: every signal targets either the unreaped direct child by PID or a group whose ID is that same unreaped PID, and the trace proves ordering (signal, latch, reap) in all four cases. The four runs are single deterministic executions, not a race sweep, and several assertions are weaker than their names suggest (details below). The retained-root PID reservation inference is sound for every transition the root itself can make, and the run itself produced one piece of kernel evidence supporting it (EPERM rather than ESRCH on the sole-zombie group).

Recommendation: proceed with the proposed minimal S + retained C direction, but do not integrate until the six "must fix before integration" items are done. None requires a VM, a scanner, or a new dependency. The contract stays `best_effort / original_process_group / survivorsPossible=true / completeDescendantTermination=false`.

## A. Already-disclosed limitations (not re-counted as defects)

The main report correctly discloses: synthetic B rather than real crash/Quit; no exec, sandbox-exec, Seatbelt, hardened runtime or packaging; D's identity is a cooperative oracle; S crash/hang unresolved; escaped groups (descendant `setsid`) unresolved; `SIGPIPE` ignore and other dispositions inherited by the payload (default-restore needed); exact exec FD allowlist needed; output dropped under backpressure; trace writes blocking; "G buffered before EOF" release race not atomically revocable; EPERM not to be interpreted generally; no OS reap timestamp for D. I accept all of these as disclosed and do not repeat them as findings, except where a disclosed item has a concrete production consequence that the report does not draw out (marked "consequence of disclosed item").

## B. New findings, by severity

Severity scale: **P1** must fix before production integration; **P2** fix or add a targeted proof before shipping; **P3** evidence-quality or fixture nits.

### P1-1. Production will misreport EPERM on every clean completion once the root is retained (consequence of a disclosed item; production defect in waiting)

`seatbelt-backend.js:118-129` treats only `ESRCH` as benign and records every other errno, including `EPERM`, into `processGroupSignalErrors`, which is surfaced in receipts (`:781-784`, `:837-840`).

Evidence from the runs: `attempt-02-before.jsonl:18` and `attempt-03-running.jsonl:25` show the final group `SIGKILL` returning `rc=-1, errno=1 (EPERM)` when the only remaining member was the already-exited, unreaped root. `attempt-01-normal.jsonl:27` shows `rc=0` for the same call when a live member (D) existed. Under the retained-root design, "root exited, no survivors, final KILL before reap" is the *normal successful* outcome, so **EPERM becomes the expected result of the final KILL on most completed executions**, and `ESRCH` becomes impossible while the root is retained (the group object persists while its zombie leader is unreaped; that is exactly why the run got EPERM and not ESRCH).

Counterexample: run any successful `true` under the new S with the current `signalProcessGroup` mapping; every receipt carries `processGroupSignalErrors:[{phase:'finalization', code:'EPERM'}]`.

Required change: define the errno mapping for the *retained* phase explicitly: `EPERM` after root exit = "group found, zero live signalable members at signal time" (not proof of emptiness); `0` = at least one live member was signalled; `ESRCH` while the root is still retained = ownership invariant violated (someone else reaped the root, or the root was never a group leader) and must be reported as a fault, not swallowed. Keep raw errno in diagnostics. XNU inference (not verified against the cited commit): `killpg1` returns `nfound ? 0 : (posix ? EPERM : ESRCH)` after filtering zombie members, with libc `kill()` passing `posix=1`; the observed EPERM/ESRCH split matches that reading.

### P1-2. The gate's readiness/release descriptors cannot be handled by close-on-exec in the real exec chain (new; not addressed by the prototype or the proposal)

Prototype `root_child()` (`prototype.c:167-194`) never execs; it closes `status` and `release` by explicit `close()` before the payload. Production C is `sandbox-exec -> /bin/sh -c gate -> exec "$@"` (`seatbelt-backend.js:686-696`), i.e. **two execs before untrusted code**. A descriptor marked `FD_CLOEXEC` in S is closed at the *first* exec (sandbox-exec → sh), before the gate can write READY or read GO. A descriptor left inheritable survives into the untrusted command unless the gate closes it by hand.

Counterexample: implement the handshake with `POSIX_SPAWN_CLOEXEC_DEFAULT` plus `adddup2` for the gate fds; the `sh` gate blocks forever on a GO read from an fd that the command later inherits, or, if the fds are inherited, the command can write forged READY/PAYLOAD bytes into S's trusted status pipe after release.

Required change: the gate script must close both handshake fds itself immediately before `exec "$@"` (e.g. `exec 3>&- 4<&-` in sh), S must treat *any* status byte arriving after it has observed release as a protocol fault, and a targeted probe must confirm from inside the sandbox that the fds are absent post-exec (e.g. the command attempts `echo >&3` and S asserts no bytes arrive). Also confirm that `read` on a pipe fd inside the composed Seatbelt profile is permitted for the gate (`(deny default)` at `:314`; existing stdout writes show inherited-fd I/O is not mediated, but a read on an inherited pipe should be probed once).

### P1-3. Group/session verification trusts the child's self-report instead of the kernel (new)

`prototype.c:311` sets `group_verified` from `m.pid/m.pgid/m.sid` carried in the READY message written by C. In the prototype C is trusted code, so this is fine; in production the READY writer is `/bin/sh` inside the sandbox and cannot conveniently emit a struct, and even if it could, S should not derive signalling authority from bytes written by a sandboxed process. S can verify independently with `getpgid(root) == root` and `getsid(root) == root` and `getpgrp() != root` (all public, same-UID, no scanning). The check must be performed after `posix_spawn` with `POSIX_SPAWN_SETSID` returns, before any group-directed signal, exactly as the prototype orders it.

Counterexample: a gate bug that reports READY before the session is established (or a future launcher that drops `SETSID`) would let S send `kill(-pid)` into whatever group `pid` actually belongs to. With the current `detached:true` path that group is the root's own, but the design should not depend on that coincidence.

### P1-4. Output policy after root exit is undefined and the prototype's policy (drop, then KILL immediately, never drain to EOF) must not transfer as-is (partly disclosed; production consequence new)

Prototype behaviour: on `root_waitable` the loop breaks (`prototype.c:288`), final `SIGKILL` goes to the group immediately (`:327`), the settle loop drains only until D's NOTE_EXIT (`:329-331`), and S exits without ever reading output to EOF. `drain_output()` drops bytes on `EAGAIN` (`:231-234`); normal run: `drained=1507328, dropped=1441792` (`attempt-01-normal.jsonl:37`).

Production today (`seatbelt-backend.js:869`) finalizes on `close`, i.e. after stdout/stderr EOF, with `collectStream` enforcing byte limits with a `truncated` flag (`:494-`). So the current behaviour for `sh -c '(sleep 2; echo late) &'` is: receipt stalls until the wall timeout, then TERM/KILL, and "late" is captured if it arrives in time. Under the prototype's policy: root exits, group is KILLed within milliseconds, "late" never appears, and any bytes already in the pipe at that instant may be dropped rather than truncated-with-flag.

Required decisions and changes (small): (a) after the final signal, drain the output pipe to EOF with a short bound (the writers are dead or dying; EOF arrives fast), (b) never silently drop; use the existing bounded buffer + `stdoutTruncated`, and (c) document the behavioural change: output produced by same-group survivors after root exit is no longer awaited. A TERM-then-KILL grace on root exit (rather than straight KILL) is a policy choice; the current JS also goes straight to KILL at finalization, so straight KILL is consistent with today.

### P2-1. The "no signal after reap" property is proven only for a straight-line program; production S will be event-driven (new)

`prototype.c:334-339` proves that one deliberate call after the latch is blocked. That is a property of linear code with no timers. Production S will have TERM-grace and KILL timers, an output drain loop and a control reader. The invariant must be structural: the reap is the *last* transition of a single state machine, all timers are destroyed before it, and the signalling function refuses once `reaped` is set. Add a targeted unit test with an injected late timer callback to prove no signal syscall can occur after reap.

### P2-2. Exercised paths are narrow; several error branches and the disclosed release race were never executed (new, evidence quality)

Never exercised in the four runs: `ownership_lost`/`ECHILD` (`prototype.c:110-112, :254-257`), `waitid_error`, `native_deadline` (`:324`, which also sends TERM and KILL back-to-back with no grace), `root_exit_observer_registered_before_release` failing (registration on an already-exited child returns ESRCH from `kevent`; the `waitid` poll covers it, which is the right redundancy and should transfer), the "G then EOF in one batch" ordering, and B dying (rather than closing) mid-setup. Each run is one execution with fixed sleeps. Treat the result as "the designed happy and three failure paths behave as specified once", not as race coverage. No further runs are requested here; if a later slice runs anything, a 20-iteration loop of the `running` case with jittered close timings is the cheapest addition.

### P2-3. D's exit cause is inferred from timing, not proven (new, cheap fix)

`register_exit()` (`prototype.c:216-219`) registers `NOTE_EXIT` only. `attempt-01-normal.jsonl:27-28`: KILL at seq 13, D's NOTE_EXIT 6 ms later. That D died *because of* the group KILL is a timing inference. `sys/event.h:265` documents `NOTE_EXITSTATUS` as valid "for child process or when allowed to signal target pid"; S may signal D (same UID), so it can request it and assert `WIFSIGNALED && WTERMSIG == SIGKILL` from `kevent.data`. Recommend adding to any future oracle; it turns the ownership evidence for the orphan from "it exited" into "it exited from our signal".

### P2-4. `untrusted_output_not_parsed_as_lifecycle` is trivially true (new, evidence quality)

The forged record written by the payload (`prototype.c:145-146`) goes to the S→B forward pipe, which B never reads (`:385`) and which never reaches the driver at all. The driver check (`driver.py:82,95`) therefore proves that two different pipes are different pipes. The design property (lifecycle records never multiplexed into stdout) is real and should transfer; the assertion just does not test parser hygiene. For production, the readiness marker currently *is* parsed from untrusted stdout (`seatbelt-backend.js:768`); moving READY to a dedicated fd (proposal) removes that, subject to P1-2.

### P2-5. The `sentinel_unaffected` oracle is weak (new, evidence quality)

E is in B's process group, never in C's. A wrong `kill(-C)` could never reach it; only a wrong `kill(-Bpgid)` would. It proves S did not signal its own group, which the `getpgrp() != root` check already guarantees. It does not exercise the PID-reuse scenario the design is about (that scenario cannot be exercised without reuse, which is fine; just do not cite E as evidence for it).

### P3-1. Ownership record is necessarily post-fork (new, minor, design note for B)

`prototype.c:273` logs `owned` after `fork()` returns. If S is killed between `fork` and the record, C is an unrecorded orphan. Unavoidable; the production consequence is that B must treat "launch attempted, no ownership acknowledgement within the setup deadline" as `survivorsPossible=true`, not as "nothing started".

### P3-2. Fixture timing nit

B's worst-case cleanup budget (`prototype.c:371-393`: loop to `deadline-1000`, then up to 600 ms + 500 ms + 600 ms) can exceed the shared 7 s alarm by ~0.7 s, in which case B is killed by `SIGALRM` mid-cleanup and relies on S/E self-expiry. Backstop only; irrelevant for production since self-expiry is not proposed as a product mechanism.

### P3-3. Driver budget uses `time.monotonic()` persisted across invocations

`driver.py:18-23`: monotonic is boot-relative on macOS, so the persisted 105 s launch cutoff is meaningless after a reboot (it would simply refuse). Safe direction of failure; fixture only.

## C. Is the root-reservation inference sound through supported transitions?

Yes, for every transition the root itself can make, with two dependencies stated explicitly.

Transitions of C (pid = pgid = sid = C, parent S, S not in group C):

1. **Alive** → PID in use. Reserved.
2. **Exec chain** (sandbox-exec → sh → command) → PID, PGID, SID unchanged. Reserved.
3. **C tries to leave its group**: `setpgid` on a session leader fails with EPERM; `setsid` on a group leader fails with EPERM; `posix_spawn(SETEXEC|SETPGROUP)` on itself is subject to the same session-leader rule (XNU inference). So the root can never move itself out of group C. This is stronger than the report states and is worth writing into the design: **only descendants can escape, never the root**.
4. **C exits** → zombie. Run evidence (`attempt-02`, `attempt-03`: EPERM, not ESRCH, on `kill(-C)` with only zombie C left) shows the pgrp object still exists and still contains the zombie, i.e. the zombie retains its pid-hash and group membership until reaped. That is the property the reservation needs. `waitid(WEXITED|WNOHANG|WNOWAIT)` returned the exit without consuming it on macOS 15.6 (`attempt-01-normal.jsonl:25`), closing the prior review's open question about `WNOWAIT`.
5. **Live descendants remain in group C after C is a zombie** → pgrp C persists via their membership, session C too. `kill(-C)` reaches exactly them. Reserved twice over.
6. **S reaps C** → pid C leaves the hash. If survivors remain in group C, the number is still reserved as a PGID/SID by the allocator's group/session check, so `kill(-C)` still cannot reach a stranger. If no survivors remain, pgrp C is destroyed and pid C becomes allocatable; a new holder that calls `setsid`/`setpgid(0,0)` creates a *new* group C. Any original survivor that escaped earlier is by definition not in group C, so a post-reap `kill(-C)` can only reach strangers. Hence signalling after reap has zero benefit and nonzero risk; the permanent latch is the correct rule and the prototype enforces it (`prototype.c:334-339`, driver checks `signals_all_precede_root_reap`, `signal_latch_disabled_before_reap`).

Dependencies: (a) the allocator refuses PIDs matching a running or zombie pid, a live pgid, or a live sid. I could not open the cited kern_fork.c commit offline; this matches my understanding of `forkproc`'s scan of allproc+zombproc and pgrp/session ids in every XNU release I know of, and the EPERM evidence is consistent with it. It is still an inference about kernel policy, not a documented API guarantee, so keep it out of the receipt contract. (b) S is the *sole* reaper: `SIGCHLD` must stay `SIG_DFL` (never `SIG_IGN`/`SA_NOCLDWAIT`), S must never call `waitpid(-1)`/`wait()`, and no runtime inside S may reap on its behalf. The prototype satisfies both (`prototype.c:76-80`, `:104`). Electron/libuv cannot reap C because C is not Electron's child.

Not covered by the reservation, and correctly not claimed: descendant PIDs (never signalled by design), descendants that `setsid`, S death (C is reparented and reaped by launchd, after which the number is free; JS must never signal the old PGID afterwards).

## D. Direct-vs-orphan ownership evidence

- Direct children (W→B, B→S, B→E, S→C): each has an `owned` record with a pid and a matching `reap` record by the same parent with the same pid (`driver.py:67-71`). 16 receipts, arithmetic consistent (4+8+4). Solid.
- Orphan D: identity bound to a kernel knote registered while D was alive and gated (`attempt-01-normal.jsonl:19`, before release at `:22`), so the later NOTE_EXIT cannot be a pid-reuse artefact. Exit *cause* not proven (P2-3). Reap by launchd correctly not claimed.
- No scans were used anywhere; confirmed by reading every code path (`prototype.c`, `driver.py`).

## E. FD / control / output impersonation and backpressure

- Control (B→S): S reads bytes and acts only on `G` before release (`prototype.c:299-304`); any other byte, repeated `G`, or `G` after cancellation is ignored; late READY cannot resurrect (`:310`). Good; transfers.
- Status (C→S) and forward (S→B) are distinct from payload stdout; verified by the per-role `fd_inventory` records and by code reading of every `close_except` allowlist. Caveat: `inventory()` only reports descriptors the program itself registered, so it is a self-consistency check, not an audit of the fd table. Production must use `POSIX_SPAWN_CLOEXEC_DEFAULT` + explicit `adddup2` and then verify (P1-2).
- Impersonation: after release, the payload can write only to stdout/stderr (`attempt-01-normal.jsonl:21`, D holds fds 1,2,3 then closes 3 at `:22`). Good. The forged-record check itself is weak (P2-4).
- Backpressure: S survives B not reading (normal: 352 EAGAIN events) and B closing the reader (running: EPIPE handled with `SIGPIPE` ignored). Cleanup was not delayed in either case. Good; but the drop policy must not transfer (P1-4). S's own trace writes are blocking (disclosed); in production every S→B write must be nonblocking and bounded, or a stalled Electron main thread can wedge the supervisor precisely when cleanup matters.

## F. EOF / release / partial-setup races

- Before release: EOF closes the gate writer, C's gate read returns EOF, C exits 77 without `payload_begin` (`attempt-02-before.jsonl:14-15`); no signal was needed for the root but a final KILL was still sent before reap. Correct.
- After release: EOF → TERM to the verified group → root exits from signal 15 → final KILL (EPERM) → reap (`attempt-03-running.jsonl:21-28`). 120 ms grace is fixture-only; production keeps `TERMINATION_GRACE_MS`.
- Partial setup: failure injected after `owned` and observer registration but before READY; S signals the direct pid only, never the group (`attempt-04-partial.jsonl:11,14`, scope `unreaped_direct_root`). Correct, and it is the right rule for production: **group-directed signals only after kernel-verified pgid==sid==pid (P1-3); pid-directed before that**.
- Disclosed "G then EOF" race is real and correctly labelled `sideEffects:unknown`. Nothing to add.
- New: in the partial path the READY message can still arrive after cancellation; the prototype discards it (`:310`), and C then times out on `A`/gate and exits within its own bounds. Good.

## G. What transfers to production, what needs correction, what needs proof

Transfers as-is (mechanism, not code):
1. S retains the direct root unreaped; root exit is observed via `EVFILT_PROC NOTE_EXIT` **and** `waitid(P_PID, WEXITED|WNOHANG|WNOWAIT)` (keep both; the poll covers registration-after-exit).
2. Final original-group signal strictly before the single reap; permanent latch; no timer survives.
3. Group signalling gated on verified leadership and S ∉ group; pid-only signalling before that.
4. Root exit decoupled from output EOF; browser control EOF triggers bounded TERM/KILL without JS.
5. Lifecycle messages never share a descriptor with untrusted output.

Needs correction before integration: P1-1 (EPERM/ESRCH mapping in receipts), P1-2 (gate fd lifecycle across two execs), P1-3 (verify group by syscall), P1-4 (drain-to-EOF bound, no silent drop, documented behaviour change), default signal dispositions/mask via `posix_spawnattr_setsigdefault/setsigmask` (disclosed), nonblocking bounded S→B diagnostics (disclosed).

Needs a targeted proof (no VM, no scanner, disposable Mac only when authorised): (i) the real `posix_spawn(SETSID|CLOEXEC_DEFAULT)` → sandbox-exec → sh gate → exec chain with in-sandbox confirmation that handshake fds are gone post-exec; (ii) errno matrix for the final KILL: root-zombie-no-survivors (expect EPERM), root-zombie-with-survivor (expect 0), post-reap-no-survivors (expect ESRCH), and assert S never observes ESRCH while retaining; (iii) `NOTE_EXITSTATUS` on the descendant oracle; (iv) a signal-disposition probe run as the command (all dispositions default, mask empty); (v) an event-loop S unit test with an injected late timer proving no post-reap signal.

Remains unresolved by design (keep in contract): descendant `setsid` escapes, S crash/hang, host shutdown; `survivorsPossible=true`, `completeDescendantTermination=false`.

## H. Shipping recommendation

Do not ship the prototype (it is a fixture and is labelled as one). Do adopt its mechanism list above as the specification for the native helper. Smallest necessary set before production integration: P1-1 through P1-4 plus proofs (i) and (ii). Everything else is quality-of-evidence and can follow. Packaging, signing and the JS-side disposal changes are outside what I could review and are unchanged from the prior design review's position.
