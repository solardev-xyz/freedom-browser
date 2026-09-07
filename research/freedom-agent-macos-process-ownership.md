# macOS managed-process ownership and cleanup

Date: 2026-09-07

Status: native macOS implementation selected; VMs explicitly ruled out by the user. Source/architecture assessment and two bounded disposable-host API probes are complete. The first implementation adds bounded awaited shutdown and receipt persistence; the backend descendant-termination guarantee has not changed.

## Objective and current boundary

Improve ownership and cleanup of Freedom-managed commands on macOS, including descendants that call `setsid()` or change process groups. Separate three questions: discovering descendants, signaling the correct process instance, and maintaining supervision after the browser exits or crashes. Success at one does not establish the other two.

The inspected development branch is `feature/freedom-automation-kernel`, at `2a7661b6` (a documentation-only addition after merge `4f7950dd`). Main owns execution authority, process lifecycle, and storage; renderer state remains bounded and conversation-owned. No top-level responsibility change is needed to study the existing lifecycle.

Current macOS receipts remain `best_effort` / `original_process_group`, with `survivorsPossible: true` and `completeDescendantTermination: false`. A surviving descendant retains its original sandbox permissions. Stop/Quit is not revocation of filesystem or previously granted network access. Linux's namespace-scoped contract is separate and must remain unchanged.

## Local implementation findings

- `workspace-execution/seatbelt-backend.js` launches `sandbox-exec` with `detached: true`. The readiness wrapper replaces itself with the requested command; `freedom-seatbelt-supervisor` is an argument label, not an independent supervisor.
- Cancellation and timeout signal the original negative PGID with TERM, escalate after one second, and force receipt finalization after a further 250 ms. Finalization also attempts group KILL after ordinary direct-child close. There is no retained kernel process identity behind the numeric PGID.
- `managed-workspace-process-manager.js` tracks application session IDs and promises, not arbitrary native descendants. Its trusted `terminate()` path does not consume the model's output cursor. This behavior must survive a cleanup change.
- The initial assessment found synchronous manager/controller disposal without awaiting backend cleanup in the service/runtime. The shutdown-draining correction below addresses this ordering gap; it does not invalidate the earlier successful native-Quit observations.
- Startup's interrupted-command bookkeeping is not proof that native survivors were discovered or terminated. A future ownership journal must remain separate from renderer-facing session state and must never authorize signaling from stale PIDs alone.

## Mechanisms under assessment

| Mechanism | What it can contribute | Limitation or decision |
| --- | --- | --- |
| Original process group | Cheap ordinary shell-tree cancellation | `setsid()` and `setpgid()` can escape it; numeric group reuse must be considered. |
| kqueue process notifications | Observe fork/exec/exit activity for an already registered process | Darwin does not support automatic `NOTE_TRACK` / `NOTE_CHILD` descendant registration. Notification-driven enumeration is not complete ancestry capture. |
| libproc enumeration plus retained identities | Discover some descendants and retain observed ownership after reparenting | Enumeration races with spawning and parent exit. A second PID/start-time check before `kill()` still leaves a check-to-signal race. |
| Audit-token signaling | Kernel validation of the target process identity before signaling | Requires safely obtaining and maintaining the right identity; it does not establish descendant ownership. SDK presence alone is not a portability or product-support guarantee. |
| Independent trusted supervisor | Keep a browser-liveness channel and cleanup state outside the browser process | Does not automatically prevent descendant escape or cover supervisor failure. Native/helper packaging and failure behavior need qualification. |
| launchd / XPC | Supervise a service independently of the application | Documented launchd cleanup is scoped to the job's process group. Service supervision must not be described as whole-tree termination without stronger evidence. |
| Kernel coalitions | Kernel accounting and grouping exist | The inspected creation/management syscall checks privileged-coalition membership. Its terminate operation requests eventual empty-coalition termination, rather than killing every existing member. Not an established unprivileged replacement for a PID namespace. |
| Endpoint Security | OS event monitoring and authorization facilities | Requires an Apple-granted entitlement. A newer descendant-scoped client is a separate platform-dependent candidate; no whole-tree lifetime guarantee has been established here. |
| VM-backed execution | Excluded from this implementation | The user explicitly rejected VMs as excessive for this product. Continue with native macOS improvements without treating that decision as acceptance of surviving descendants. |

## Primary source observations

Apple's XNU `event.h` marks `NOTE_TRACK`, `NOTE_TRACKERR`, and `NOTE_CHILD` unsupported since macOS 10.5. `filt_procattach()` rejects those flags with `ENOTSUP`. Ordinary fork notifications therefore cannot be treated as the recursive tracking facility described in older BSD material. Sources: [header](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/sys/event.h), [implementation](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/kern_event.c).

In the inspected XNU `proc_info.c`, audit-token signaling resolves a process identity, applies MAC policy, reacquires that identity and checks signaling permission before sending the signal. This is a materially stronger target check than separate userspace PID inspection followed by ordinary `kill()`. It still does not answer how every descendant is discovered, and compatibility with exec and supported host versions needs direct checks. Source: [process-information implementation](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/proc_info.c).

Apple's launchd manual describes cleanup of remaining members of the job's process group. XNU's coalition syscall requires privileged-coalition membership; its termination request does not prohibit existing members from forking. Neither inspected contract establishes complete unprivileged command-tree termination. Sources: [launchd manual](https://github.com/apple-oss-distributions/launchd/blob/main/man/launchd.plist.5), [coalition syscall](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/sys_coalition.c).

Apple documents `es_new_descendants_client` as a beta descendant-scoped Endpoint Security client without root or TCC requirements, but still requiring `com.apple.developer.endpoint-security.client`. Event monitoring is not itself a teardown primitive. SDK availability, entitlement acquisition, event loss, supervisor failure and cancellation races require a separate evaluation. Sources: [descendant client](https://developer.apple.com/documentation/endpointsecurity/es_new_descendants_client(_:_:)), [entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.endpoint-security.client).

Source revision `f6217f891ac0bb64f3d375211650a4c1ff8ca1ea` was resolved from Apple's public XNU repository during this investigation. It is source evidence, not a claim to be the exact kernel running on either Mac. The disposable-host assessment below separately checks installed headers and the matching kernel-family source.

## Disposable-Mac assessment

The explicit Herdr response for `macmini/req-c7c8af1d72dd0f4ea4bb29ea7246a2c4` independently checked the existing qualification checkout at `/Users/flobot/Git/freedom-dev/freedom-browser`, branch `codex/agent-workspace-macos-qualification`, HEAD `11a863ecad4c02ed139040243d0ed657b7a1443b`. Its worktree was clean before and after the assessment; nothing was fetched or installed. The responding agent had the existing files and logs, but not the previous qualification agent's conversation history.

Host: Mac16,10 / Apple M4 arm64, 16 GiB, uid 501, macOS 15.6 build 24G84, Darwin 24.6.0 / `xnu-11417.140.69~1`. Installed clang is 17.0.0; the SDK resolves to `MacOSX15.5.sdk`. The kernel-family source tag `xnu-11417.140.69` resolves to immutable [commit `43a90889846e00bfb5cf1d255cdc0a701a1e05a4`](https://github.com/apple-oss-distributions/xnu/tree/43a90889846e00bfb5cf1d255cdc0a701a1e05a4). This identifies the inspected source family, not a byte-for-byte attestation of the installed kernel.

The agent's conclusion matches the local review: none of the inspected supported, entitlement-free, unprivileged interfaces establishes both complete arbitrary-descendant discovery and safe whole-tree termination through the requested transitions. This is not proof that every possible Apple mechanism has been exhausted.

Additional findings:

- Installed `usr/include/libproc.h` explicitly describes its interfaces as private and subject to change. Stronger unique-ID definitions in `proc_info_private.h` are absent from the installed public SDK include inventory. A native implementation needs an explicit compatibility/private-interface decision, not copied private structs presented as public API.
- Exec can change the PID version and invalidate a saved audit token. A token must never be refreshed from a numeric PID alone after ownership has become ambiguous. Direct-child ownership and a still-unreaped child provide a bounded experimental way to test this without forcing PID reuse.
- The inspected Endpoint Security baseline exposes fork notifications, not a synchronous fork-authorization gate, and its headers document detectable dropped events. A future event-based solution must account for both facts.
- Apple's documentation metadata places the new descendant-scoped ES client at macOS 27.0 beta. It is unavailable in this host's SDK, still requires an Apple-granted entitlement, and supplies no documented atomic subtree-stop contract in the inspected description. [Availability metadata](https://developer.apple.com/tutorials/data/documentation/endpointsecurity/es_new_descendants_client(_:_:).json).
- Shell settings, executable-name filtering and injected library wrappers do not prevent arbitrary native code from changing groups/sessions. Removing fork/exec would change the accepted general coding environment. No such compatibility restriction was selected.

Exact installed references beneath `/Library/Developer/CommandLineTools/SDKs/MacOSX15.5.sdk/`: `usr/include/sys/event.h:354` (unsupported tracking flags), `usr/include/libproc.h:41` (private-interface notice), `usr/include/libproc.h:132` (audit-token signaling), `usr/include/sys/proc_info.h:50` (BSD process information), `usr/include/sys/spawn.h:60` (start-suspended extension), and `usr/include/EndpointSecurity/ESMessage.h:2784` (event sequencing/drop discussion). The matching `launchd.plist(5)` manual retains process-group cleanup semantics.

## Bounded native API probes — completed 2026-09-07

The explicit response to `macmini/req-309da218615885d92e02b58e85f956ef` reports two probes against installed APIs on the same macOS 15.6 / SDK 15.5 host. [The retained report and verbatim sources](evidence/macos-process-ownership-probes-2026-09-07.md) include the initial failed attempt, successful revision, compiler command, outcomes, cleanup and limitations. The primary agent independently checked that the returned source blocks match their reported SHA-256 hashes; it did not compile or run them locally.

| Probe | Observed result | What it establishes |
| --- | --- | --- |
| kqueue tracking | Revised probe: 10/10 assertions, exit 0. `NOTE_TRACK` registration produced an `EV_ERROR` receipt with `ENOTSUP` (45); ordinary `NOTE_FORK` and `NOTE_EXIT` controls worked. | Automatic descendant tracking is actually rejected on this host. Event coalescing and incomplete ancestry remain source findings, not stress-test results. |
| Audit-token signaling | 17/17 assertions, exit 0. Genuine token acquisition succeeded. A changed PID-version token and a pre-exec token returned `ESRCH` (3); current tokens delivered handled `SIGUSR1` before and after exec. | Identity-bound signaling is attainable for a known owned direct child without root on this host. Exec invalidates the stored token. |

Probe ownership came from keeping direct children unreaped until signaling finished, not from trusting ancestry scans or token possession. A separate owned sentinel remained unaffected until its own cleanup. There were three total fixture births across all attempts, at most two live fixtures, no grandchildren and no detachment. Each fixture had an independent eight-second alarm, including across controlled exec; the harness and driver had separate deadlines. The successful probes took approximately 0.19 and 0.48 seconds by the driver. All fixtures exited with code 0 and were reaped; no TERM/KILL cleanup or deadline was needed. These checks do not qualify arbitrary descendants, real PID recycling, browser/supervisor crashes, recovery, signed toolchains, the packaged app or the production Seatbelt policy.

The original Probe A attempt exited 1 before creating any child because a descriptor-sweep guard rejected the host's soft `RLIMIT_NOFILE` of 1,048,575. The revision closed only its tracked descriptors while the driver closed inherited descriptors; no host limit was changed. Original source, compiler result and failed run remain retained. Both source revisions compiled with installed clang using `-std=c11 -Wall -Wextra -Werror -O0 -g` and `-lproc`, with no diagnostics.

Exact remote evidence directory: `/private/tmp/freedom-native-discriminants-r88pkwsx`; run metadata is `result-manifest.json`. The earlier assessment reply remains `/private/tmp/herdr-peer-macos-ownership-8f9qydsp.md`. The new probe report/source is also retained in this repository; raw JSONL files and the manifest remain on macmini and are not represented as independently archived here.

| Evidence file on macmini | SHA-256 |
| --- | --- |
| `probe-v2.c` (11,874 bytes; source retained in the linked report) | `1c66a5010edbb6fd1f108caadf21bb7bc724b78e53aff6a57469e51f9109a48e` |
| `run-probe-v2.py` (1,306 bytes; source retained in the linked report) | `e03fab7bed4c7fa45e270ffbf2b783b1ab289e5d1df05cbe61d5194c29d1655c` |
| `probe-A-v2.jsonl` | `f7765c165178a552ea31abc653520a9751d9f76c0a74d09dc6ad5c226bcc05a6` |
| `probe-B-v2.jsonl` | `9c8a0cf32af2afd33461bda735c020066d283fbd1c131bf9d2109c2a62309fc5` |
| Original `probe.c` (11,663 bytes; source retained in the linked report) | `4b95984a3693fe1f6b57a462d49d468684def382092552ccb8ed55a784b7e583` |
| Original `probe-A.jsonl` | `ff15df03017af7b385f03736449c963b7a64f77683929e415b285a7f11e63241` |

## Implementation decision

The user selected native macOS process ownership and cleanup, and explicitly ruled out VMs. Continue with bounded asynchronous teardown, then evaluate trusted native supervision and root/group lifetime anchoring. Safe signaling of proven owned instances remains conditional on demonstrated host support. Missed descendants, supervisor failure and ambiguous recovery must remain explicit limitations. A scanner alone must not become signaling authority. Any helper's packaging, signing, private APIs, IPC authentication and startup behavior must be specified before adoption.

This direction preserves the existing main/renderer boundary, bounded public state, Linux guarantees, preview isolation and reviewed history. It does not waive broader-release policy or relabel existing macOS receipts as complete descendant teardown.

### Codex implementation reference

An existing clean checkout at `/Users/florian/Git/freedom-dev/codex` was inspected at `c9fecd3fa06af28011166207c596ad547e37abab` (2026-09-03). No clone, build, install or execution was needed. Its [process-group helpers](https://github.com/openai/codex/blob/c9fecd3fa06af28011166207c596ad547e37abab/codex-rs/utils/pty/src/process_group.rs) use group signaling and, on macOS permission denial, enumerate that group's members, recheck current group membership and signal individual numeric PIDs. This supplies a concrete same-group compatibility pattern; it does not discover session/group escapees or eliminate the separate membership-check/signal race. Parent-death signaling in that helper is Linux-only. Its [process lifecycle](https://github.com/openai/codex/blob/c9fecd3fa06af28011166207c596ad547e37abab/codex-rs/utils/pty/src/process.rs) also distinguishes termination requests from shutting down output readers, a useful separation for receipt draining. No Codex source was copied into the product in this correction.

### First correction — await workspace shutdown

- Controller disposal now prevents new command/file-helper execution, cancels pending preparation and active executions, and awaits their settlement before clearing grants and leases. The tracked command promise includes the durable ledger write.
- Process-manager disposal retains cleanup promises even after a record is consumed or removed from its conversation. It waits for backend receipts and terminal observers; trusted Stop still leaves the model's output cursor untouched.
- Service disposal keeps finished-turn terminal reconciliation available during draining, then disables callbacks and releases conversations. Service and controller disposal calls share their in-progress promise. Runtime awaits the controller before closing stores.
- A five-second workspace drain deadline prevents a wedged backend/observer from indefinitely blocking this phase. Timeout reports `drained: false` and logs a bounded uncertainty message. Late backend results cannot write to the closed command store or initiate new terminal callbacks. An unfinished ledger row is left for existing startup interruption reconciliation; the timeout does not fabricate an exit receipt or prove process death. This deadline is for workspace draining, not a bound on every other application shutdown subsystem.
- Local validation: four focused suites / 100 tests passed, followed by full `npm test` with ordinary fixture socket permissions: 234 suites / 4,051 tests passed, 7 suites / 54 tests skipped; exit 0. Lint and whitespace checks passed. Existing OpenLV/websocket-mqtt late-log diagnostics remained non-fatal. Regression tests cover delayed receipts, file helpers, cancellation during preparation, bounded shutdown, late writes/callback suppression, consumed-record observers, retained conversation history and store-close ordering.
- Follow-up review found that a command still preparing could outlive the drain deadline and later yield a live handle after its ownership records were cleared. The manager now rejects that late result; an end-to-end controller regression also checks that it cannot reread a closed store or launch the payload. Follow-up validation: lint and full Jest passed, 234 suites / 4,052 tests with 7 suites / 54 tests skipped.
- These are ordinary unit/integration checks on the primary Mac. No detached, destructive or native app-exit qualification was run there; native supervisor/crash behavior remains subsequent work.

## Existing qualification evidence recovered by inventory

The remote assessment located 53 existing `/private/tmp/freedom-*.log` files and the unsigned packaged app; it did not rerun them. Selected evidence locations on **macmini**, not the primary Mac:

| Existing path | Historical contents reported by the inventory |
| --- | --- |
| `/private/tmp/freedom-product-development-strict-receipts-green.log` | Nine-group development aggregate, 160 passed |
| `/private/tmp/freedom-packaged-product-strict-receipts.log` | Packaged aggregate, 169 passed |
| `/private/tmp/freedom-product-destructive-strict-receipts.log` | Detached product case, 6 passed |
| `/private/tmp/freedom-processes-slow.log` | Slow lifecycle, 27 passed |
| `/private/tmp/freedom-app-exit-three-state-final.log` | Earlier native-Quit corpus, 14 passed |
| `/private/tmp/freedom-app-exit-partial-setup-cleanup-final.log` | Later corpus with partial-setup cleanup, 17 passed; detached survivor reported before cleanup |
| `/private/tmp/freedom-app-exit-cleanup-full-test-final.log` | Historical final Jest evidence; inventory reports 232 suites / 4,037 passed and 9 suites / 61 skipped |

The surviving bundle is `/Users/flobot/Git/freedom-dev/freedom-browser/out/agent-sandbox-packaged/mac-arm64/Freedom.app`. Its current `Contents/Resources/app.asar` is 240,195,955 bytes and was hashed read-only during this inventory: SHA-256 `7d5b3ea1c46eedb8bd455ca33e7ee3345855919481d95586908d389d00c757a5`. Current signature inspection reports ad-hoc/linker signing, no TeamIdentifier or sealed resources. These are **current file measurements**, not recovered historical run hashes or signed-release evidence.

No immutable run-to-source-to-artifact manifest was found. Forty-character IDs in fixture history output are not qualification source revisions. Do not assign today's archive hash retroactively to an old run or infer qualification of the primary branch. Raw app-exit identities date to September 7, although the accumulated research section begins with a September 6 heading. Preserve both dates and the revision-specific account in the principal roadmap.

## Investigation and qualification boundaries

The primary development Mac is restricted to source/documentation review and ordinary benign checks. Potentially harmful, detached-process and application-exit experiments belong on the designated disposable Mac. No downloaded software, OS changes, entitlements, service installation, or broader release is authorized by this investigation.

Before adopting an implementation, record the achievable contract and independently observe survivors before fixture cleanup. Use bounded fixtures, explicit ownership established before launch, finite spawn counts, deadlines, an independent watchdog and unrelated-process canaries. A deliberately demonstrated survivor is a limitation result, not a complete-cleanup pass. Never signal by process name, workspace-path resemblance, or an unvalidated stale PID.

Required scenarios for a chosen implementation: ordinary completion, Stop, timeout, conversation deletion, native Quit, browser crash, supervisor failure, startup recovery, rapid bounded fork/exec, double fork, session/group changes, and PID identity mismatch. Preserve filesystem/network isolation, preview revocation, terminal evidence and the non-consuming chrome Stop behavior. Aggregate CPU, memory, PID and disk containment remains separate.
