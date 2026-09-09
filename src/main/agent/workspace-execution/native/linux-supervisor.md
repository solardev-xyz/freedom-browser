# Linux workspace lifetime owner — review candidate

This is the Linux x64 implementation contract, not a runtime qualification report.
The September 8 namespace and packaged idle results remain historical evidence;
they do not qualify this new mechanism. No real owner, namespace or application
was executed during this implementation checkpoint. Myotis is unrelated.

## Authority and startup

```
browser B -- sole control writer --> native S
                                      |
                           clone3(CLONE_NEWPID | CLONE_PIDFD)
                                      |
                         lifetime PID1 I (never execs)
                                      |
                          clone3(CLONE_PIDFD)
                                      |
                         M = installed /usr/bin/bwrap
                                      |
                         bwrap PID1 -> native entry gate -> command
```

S is single threaded. It clears inherited signal dispositions/masks needed for
ownership, refuses root or mismatched real/effective credentials, sets NNP, opens
its own original-instance pidfd, and creates/maps an unprivileged user namespace.
The UID/GID mapping preserves the caller's numeric identity. All mappings precede
I creation. No setuid helper, host credential change, cgroup/VM, policy edit or
numeric signal fallback is provided.

After those mappings, but before creating any descendant, S arms its own
SIGKILL parent-death signal and checks that `getppid()` still equals the browser's
self-reported PID supplied in the fixed invocation. This is a check of S's own
original-parent relationship, never a PID lookup or signal target. Reparenting
cannot make a newly reused browser PID become S's already-existing ancestor.
S does not exec or change credentials after this arm. Parent-death notification
is tied to the creating thread: loss of that browser thread conservatively
cancels even if other browser threads survive. This is an additional backstop
to control EOF, not a replacement for the retained S-to-I handle handoff.

The clone syscall returns I and its pidfd atomically to S. I first arms SIGKILL
parent-death handling, checks the inherited pidfd of original S, acknowledges
the arm, waits for a private start byte, and checks S again. I cannot create M
before these steps. If S dies before the arm, the pidfd check or closed start
pipe prevents release; if it dies after the arm, parent-death signaling applies.
A child delayed before its first instruction may remain unarmed until scheduled,
but cannot launch Bubblewrap. This is not an instantaneous or hard-real-time
death guarantee. I performs no exec or credential transition after arming.

In run mode S starts Bubblewrap only after I's acknowledgement. The final gate
checks its descriptors and reports READY; only then can browser G release the
command. Cancellation, EOF or malformed control before release prevents G. A
release flag is set conservatively before the write: a failed release write can
therefore produce `sideEffects: unknown`, never a false no-effects claim.
In probe mode I stays behind its start gate until browser G; all version and
capability subprocesses still live below the lifetime namespace.

The browser's control endpoint is never copied into M/command. Browser death
closes its endpoint independently of the JS event loop; S polls it during setup/execution.
Unrelated browser fork children can transiently inherit a CLOEXEC writer before
exec; the pre-create S parent-death arm also covers that EOF-delaying interval.
JS Stop writes A and closes its endpoint, without signaling a ChildProcess.
Pre-spawn abort avoids creation; an abort during helper resolution is rechecked
before spawn. Pending controller operations and the existing five-second
shutdown wait remain unchanged. A hung host filesystem/kernel call or stopped
supervisor is not given an unqualified finite-time promise.

## Original-instance outcomes

S alone owns I's creation pidfd and destructive wait. I alone owns M's creation
pidfd and destructive wait. Neither adopts scan results or reopens a PID.
Readability is followed by `waitid(P_PIDFD, WEXITED|WNOHANG|WNOWAIT)`; that original
terminal status is stored, signal authority is irreversibly retired, then one
destructive wait is compared with the stored status. ECHILD retires lost
authority and fails. ESRCH from signaling is not an exit observation. A failed
or mismatched reap remains unknown; it is never repaired by numeric rediscovery.

Natural M completion is recorded by I before I exits. I's exit also tears down
output-holding/detached descendants still in its namespace. S waits for original
I's terminal completion/reap and drains the trusted I record before publishing.
On Stop, timeout, EOF or setup failure, S sends SIGKILL through the retained I
pidfd. It observes for at most two engineering seconds; if incomplete it makes
one final owned attempt, reports uncertainty and exits. Its exit/closed gates
provide the parent-loss backstop, **not** an observed completion receipt.
Permission failure does not cause early retirement of a still-owned live handle.

The gate's exec-failure F is informational: it does not itself kill I. M is allowed
to report its actual natural exit (normally127); the final exec_failed reason is
kept separate from ownership failure. Cancellation/deadlines still apply.
Requested cancellation and actual M status are separate. A racing zero remains
zero; cancellation does not fabricate SIGKILL. Killing I may prevent I from
recording M, in which case M's status stays unknown even when namespace teardown
is proven. Bubblewrap's own exit code may encode an inner signal as 128+signal;
it is not a raw wait status of the command. B->S remains libuv-owned: JS records
S's exit but never uses S's numeric PID or claims a native sole-reap record for S.

`namespace_scoped`, `survivorsPossible:false`, and complete namespace termination
are emitted only with a valid non-uncertain original I observation, retirement
and reap. This is a namespace-membership statement, not per-descendant exit
accounting, undoing command effects, aggregate resource limits, or a defense
against a compromised kernel/trusted supervisor. Capabilities advertise
the existing `best_effort` value with survivors possible, not an unconditional
future cleanup success; exact completed receipts carry the conditional evidence.

The native FINAL also separates init and monitor code/signal, stage/errno,
creation/arm/release/exec-attempt and observation/retirement/reap. The command
readiness marker and gate E are only readiness/exec-attempt observations. They
are not exec success or cleanup proof. Public controller receipt sanitization
remains responsible for excluding internal paths and diagnostics.

## Descriptor contract

| Channel | Writers / readers | Closure and meaning |
| --- | --- | --- |
| Browser control (S fd3) | browser / S | I closes it before handoff; never reaches M. EOF requests cleanup. |
| FINAL (S fd4) | S / browser | I closes before handoff; no descendant can forge terminal records. |
| Init report (high fd) | I / S | M closes before exec. Fixed bounded A/M/F records. |
| Init start (high fd) | S / I | I reads one G, then closes. S loss gives EOF. |
| Entry release (M/gate fd5) | S / gate | I closes its copy after M clone; gate closes after G. |
| Entry status (M/gate fd6) | gate / S | I closes after clone; CLOEXEC at gate. R/E/F only. |
| Owner ELF (fd8) | read-only inode | Bubblewrap copies bytes via `--perms 0555 --ro-bind-data 8`; closes input. |
| stdin/stdout/stderr | browser / command | S closes after I clone; I closes after M clone. Gate preserves 0–2. |

Before M exec, close_range removes all other inherited descriptors. Before gate
release, 5/6 must be FIFO endpoints with the proper access direction, 0–2 valid,
and all other descriptors closed. Gate closes 5 and marks 6 CLOEXEC before command
exec. Bubblewrap's init may hold a copy of 5/6 during its own setup; it is below I
and cannot keep the **browser** control writer alive. Gate descriptor behavior is
also checked by the owned native-gate capability probe before availability.

JS retains at most 4096 status bytes, at most 2048 per line, and rejects duplicate,
partial, unknown, impossible-terminal or wrong-build records. Output retention
uses existing caps while continuing to drain. There is at most 500ms transport
drain after terminal/EOF. Abort has its own 2500ms transport cutoff, including
long original wall budgets; it cannot extend the native deadline. Transport
expiration closes pipes and reports failure; it never supplies signal authority
or proof. These are scheduling-dependent engineering bounds, not realtime SLAs.

## Authoritative source review (upstream, not installed matching source)

- Linux v6.8 [fork.c](https://raw.githubusercontent.com/torvalds/linux/v6.8/kernel/fork.c):
  `copy_process` installs the CLONE_PIDFD file before returning the child; fork
  clears inherited pdeath_signal. CLONE_PIDFD avoids spawn-then-open identity
  recovery. S's self-pidfd is acquired while S itself is necessarily alive.
- Linux v6.8 [cred.c](https://raw.githubusercontent.com/torvalds/linux/v6.8/kernel/cred.c):
  `commit_creds` clears pdeath_signal on relevant credential/capability changes.
  Thus mapping/setup is before I, and I never changes credentials or execs after
  its arm. The M child is intentionally not relied upon to inherit the arm.
- Linux v6.8 [signal.c](https://raw.githubusercontent.com/torvalds/linux/v6.8/kernel/signal.c):
  `send_signal_locked` handles ancestor-namespace SEND_SIG_NOINFO senders specially;
  SIGKILL from that context bypasses namespace-init's normal unkillable protection.
  S is outside I's new PID namespace and holds permission in the owning user namespace.
- Linux v6.8 [exit.c](https://github.com/torvalds/linux/blob/v6.8/kernel/exit.c):
  original-parent exit sends the configured parent-death signal using
  SEND_SIG_NOINFO. Together with the preceding signal path this supports the
  S-to-I arm; this does not assume PID1 treats every sender's SIGKILL identically.
- Linux v6.8 [sys.c](https://raw.githubusercontent.com/torvalds/linux/v6.8/kernel/sys.c):
  PR_SET_PDEATHSIG sets the calling task's arm; getppid reads real_parent under
  RCU. The exit path reparents before checking pdeath_signal. The candidate uses
  arm-then-parent-check before creating I, with EOF as a separate channel.
  Concurrent reparenting can produce a stale RCU observation; this review does
  not turn that source argument into measured scheduling or hard-time coverage.
  The exact creation/arm interleavings remain required disposable qualification.
- Linux v6.8 [pid_namespace.c](https://raw.githubusercontent.com/torvalds/linux/v6.8/kernel/pid_namespace.c):
  `zap_pid_ns_processes` disables allocation, kills remaining members and waits
  for them; original init's reap is the completion boundary. `pidns_install`
  prevents joining ancestors or another PID namespace tree. This supports nested
  lifetime containment, not host numeric-PID identity claims.
- Bubblewrap v0.9.0 [bubblewrap.c](https://raw.githubusercontent.com/containers/bubblewrap/v0.9.0/bubblewrap.c):
  die-with-parent arms at several points, not before all setup. `do_init` closes
  extra descriptors in its init path. Ordinary bind source resolution calls
  realpath and can turn a proc-fd reference back into a pathname. MAKE_RO_BIND_FILE
  instead copies fd bytes, sets the requested mode, mounts read-only, and closes
  the input descriptor. This candidate uses that path for the gate. Installed
  Ubuntu patches have not been compared with this upstream revision.

## Build, compatibility and deployment

Only Linux x64 is supported by this helper. Other Linux architecture packages
continue with a helper resource directory and workspace backend unavailable;
they are not advertised as qualified. Minimum kernel interface set:
unprivileged user namespaces and maps, PID namespaces, clone3 with CLONE_PIDFD,
pidfd_open, pidfd_send_signal, waitid(P_PIDFD), close_range, prctl NNP/PDEATHSIG,
procfs and ordinary pipes/poll. Version floor is Linux 5.9 (close_range), but a
version string is not availability proof: seccomp, namespace limits, LSM policy,
container restrictions and missing facilities still fail closed through probes.
No clone/pidfd_open race fallback, Node kill, numeric/group signal, privileged
helper, VM or downloaded replacement exists.

Build with `npm run build:linux-workspace-supervisor` using installed GCC/headers.
Development preparation accepts an exact prebuilt helper without GCC; without a
prebuilt helper or installed GCC it warns and allows application startup with
the workspace backend unavailable. Supported x64 packaging remains strict.
Linux beforePack includes the helper only for x64. No lock or
dependency change. Manifest binds protocol, source SHA256, ELF SHA256, x64 and
minimum kernel. Runtime hashes the opened O_NOFOLLOW binary and executes that
same inode through inherited fd5. Packaging copies binary+manifest outside asar;
C source remains archived for source-hash verification. Updates preserve previous
local build outputs. Trust assumes immutable installed inputs against sandbox
writes; helper location must be canonical and outside payload-writable roots.
Concurrent hostile same-UID host mutation is not solved by this mechanism.

This host's Ubuntu AppArmor userns restriction is enabled. The existing Freedom
profile covers `/opt/Freedom/freedom`; allowance for the new standalone executable
and proc-fd exec mediation is **not established**. Deployment needs independently
reviewed policy/path qualification; this candidate makes no automatic profile,
sysctl, capability, setuid, UID or OS changes. A denied owner reports a fixed stage
and errno (identity, user namespace, uid_map, setgroups, gid_map, parent_pidfd, browser_parent or
lifetime_clone) when its status channel is available. Missing/invalid helper or
transport failure remains unavailable/unknown, without weakening isolation.

## Required next disposable qualification — not executed here

Use a fresh separately reviewed independent owner envelope and one-use activation,
non-root product, offline loopback-only defaults, finite output/PID limits, and
30s outer maximum per short case. Product wall and 2s+500ms cleanup/drain stay
inside the existing 5s shutdown wait. Outer owner retains original handles and
can dispose the fixture tree, but any outer intervention/self-expiry is FAIL.
No broad stress, fork bombs or live providers are needed for this first matrix.

1. Facilities, helper packaging/hash mismatch, denied clone/map/close_range and
   failed bwrap/gate exec: no command release, no survivor credit without proof.
2. Pause at each finite source-instrumented pre-create, pre-arm, armed-awaiting-
   start and gate-awaiting-release boundary; cancel or close browser control.
   Verify no command marker before release, owned terminal records, sole reap.
3. Browser-creator loss before/after S arm (including a held pre-exec sibling
   writer), S loss before/after I arm and supervisor loss before/after M creation:
   original externally observed instances, namespace membership and canaries;
   no dependence on browser JS timers. S-loss cannot produce S's FINAL, so receipt
   must remain unknown even if independent evidence confirms kernel cleanup.
4. Benign direct/grandchild/session-changing output holders, natural completion,
   Stop before/after natural M exit, and wall timeout. Record actual original M
   status separately from request, original I terminal/reap and pipe completion.
5. Browser controller disposal/Quit with pending probe/setup and active command;
   verify no late launch/publication after store closure. App startup/shim work
   remains a separate reviewed harness, not an invitation to run existing scripts.
6. Fixed malformed/duplicate/oversized/partial record and lost-status fixtures,
   signal/wait failures: no successful cleanup or no-side-effect promotion from
   timeout, PID disappearance, readiness, requested signal, or outer cleanup.

For each case preserve exact source/binary/manifest/kernel/Bubblewrap hashes,
original owner receipts, request/release timeline, stdout/stderr, original terminal
statuses and sole-reap records, plus independently held unrelated canaries.
Deliberate test faults must use a separately identified test artifact; they cannot
quietly change the production binary's proof. Stop after any failure for diagnosis.
