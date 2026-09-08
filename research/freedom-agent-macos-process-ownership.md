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

### Selected next native slice — retain the execution root until final signaling

[The completed disposable-Mac design review](evidence/macos-native-supervisor-review-2026-09-07.md) recommends one trusted native supervisor per execution, outside the worker's Seatbelt profile. It directly owns the initial `sandbox-exec` root, which retains today's separate session/group layout and execs forward into the command. The supervisor observes root exit without immediately reaping it, performs its final original-group cleanup, disables further signaling, and only then reaps. This avoids adding a separate permanent group anchor to the first implementation.

The matching XNU allocator checks the process hash (including running and zombie entries), process groups and sessions before assigning a PID. Retaining the direct root with initial PGID equal to its PID therefore provides a source-supported reservation invariant while the supervisor remains its parent and has not reaped it. This is an inference from the [matching allocator](https://github.com/apple-oss-distributions/xnu/blob/43a90889846e00bfb5cf1d255cdc0a701a1e05a4/bsd/kern/kern_fork.c#L924), independently inspected by the main agent, not a PID-reuse stress result. Every signal timer must be disabled before reap. A missing group or a lost direct-child relationship never permits targeting another PID/group.

The bounded prototype request `macmini/req-6d2d121862ee7ddaf4d1260e2107c88e` covers a synthetic browser parent and self-expiring fixture commands, without product integration. Its required controls are:

- Browser-only liveness writer, supervisor-only reader; no inherited worker writer that could hide browser death.
- A trusted pre-execution gate, explicit per-role descriptor closure, independent readiness/control records, and terminal abort/EOF behavior. Untrusted stdout cannot authorize release or spoof lifecycle evidence.
- Root-exit observation independent of output EOF, with bounded forwarding/backpressure and TERM/KILL timing. A descendant retaining stdout must not indefinitely postpone cleanup.
- Cleanup ownership recorded before partial-setup failure, an unrelated owned sentinel, independent deadlines, finite births and verified cleanup on the disposable Mac.

This prototype is not product qualification. Integration still needs reviewed native source and protocol handling, a validated bundled executable path, architecture-specific compilation using installed tooling, nested signing without browser-level entitlements, and inclusion in both normal and qualification packages. Existing qualification packaging clears `extraResources`; adding a helper to only the normal package would leave a misleading coverage gap. Execution authority remains in main's existing backend; no renderer-facing PID/signal API or new top-level module responsibility is proposed. No third-party dependency, privileged service, private libproc API, extra anchor or VM is needed for this first slice.

A live supervisor can improve ordinary group cleanup after browser failure. Supervisor failure, a stalled supervisor, escaped groups/sessions and safe startup reclamation remain unresolved; no stale-PGID recovery is allowed. Neither this design nor a successful synthetic probe changes `best_effort` / `original_process_group` / `survivorsPossible: true` / `completeDescendantTermination: false`.

### Retained-root prototype — completed 2026-09-07

[The explicit disposable-Mac report](evidence/macos-retained-root-probe-2026-09-07.md) retains the prototype source, driver, per-case results and artifact inventory. The main agent checked the returned source byte counts and SHA-256 hashes without compiling or executing either file locally. One warning-free compile with installed clang and four successful cases produced 46 native assertions and 60 driver checks. There were 17 fixture births, at most five live native roles plus the Python driver, and a reported 0.593-second execution window. Independent seven-second fixture expiry and driver deadlines were present but were not exercised by the successful runs.

| Case | Observed result |
| --- | --- |
| Normal root exit with a same-group output holder | Root exit became observable through `waitid(...WNOWAIT)` while stdout remained open. Final group KILL preceded root reap; a pre-registered descendant `NOTE_EXIT` confirmed that known instance exited. Bounded forwarding tolerated a non-draining output consumer. |
| Control EOF before release | The trusted gate saw EOF and no payload began. The root was observed and reaped after the final signal attempt. |
| Control EOF during execution | The supervisor sent TERM without browser-side cleanup, observed the root's signal exit, and completed final signaling before reap. Closed output produced handled `EPIPE`. |
| Failure after root creation, before readiness | Ownership already existed; cleanup targeted only the unreaped direct child before group verification. No payload began. |

Sixteen owned direct instances have actual wait/reap receipts. The normal case's one orphaned descendant has a registered exit event, not a direct reap receipt or an observed OS reap timestamp. An unrelated owned sentinel responded after supervisor cleanup in every case and was then separately reaped. Final group KILL returned `EPERM` in the before-release and running-EOF cases after the root was already waitable; the evidence preserves those errors and does not reinterpret them as successful signals or justify a per-member PID fallback.

The synthetic browser stayed alive as an observation harness while closing its control pipe. These are EOF-path checks, not actual browser-crash or native-Quit tests. The prototype performs no exec or `sandbox-exec`, so it does not establish production descriptor isolation, gate protection after Seatbelt application, signing or packaging compatibility. The PID-reservation claim remains a source inference; no PID-recycling stress was performed. Successful runs also do not qualify the driver's unexercised exception/timeout cleanup paths.

Main-agent source review identified two items that must not be copied into production: the prototype records some setup failures as assertions without making them terminal before release, and the driver writes its post-spawn ownership artifact outside a guaranteed exception-cleanup scope. Independent fixture expiry limits the latter experiment, but it is not a substitute for cleanup verification on failure. Production setup needs explicit fail-closed transitions, and any expanded harness needs exception-safe ownership immediately after launch.

[The independent Claude review and main-agent disposition](evidence/macos-retained-root-claude-review-2026-09-07.md) support continued native integration design while requiring real exec-chain descriptor checks, kernel verification of group/session leadership, bounded output draining, default signal state and structural prevention of post-reap signaling. The main agent refined recommendations that assumed the old shell launcher or gave unverified errno interpretations. Raw `EPERM` remains a failed signal attempt with context, not proof of emptiness; a successful command receipt currently stays successful despite that diagnostic. The review supplied no new run evidence. Its suggested repeated fixture loop is not authorized under the completed probe's birth budget.

### Concrete integration contract — reviewed before implementation

[The completed production-protocol review](evidence/macos-supervisor-production-protocol-2026-09-07.md), request `macmini/req-cadd244e5185ef32f4670e0bcc92271c`, recommends direct command stdin/stdout/stderr between Browser and worker. The supervisor owns separate control/status streams and never forwards command output. Node's inherited streams may use socketpairs; the protocol must handle byte framing and directional EOF without assuming anonymous-pipe boundaries.

- Use at most one optional READY followed by exactly one FINAL, with bounded versioned records. Startup failure can legitimately send FINAL without READY. Kernel group/session verification and wait ownership precede release. Invalid setup, control EOF/abort and deadlines are terminal; a previously issued release cannot be atomically revoked.
- Supervisor exit can precede delivery of buffered FINAL bytes. Browser must separately bound status draining before diagnosing a missing receipt. Conversely, FINAL does not prove supervisor exit. Output drainage has its own short bound and truthful truncation; no receipt waits indefinitely on an inherited output writer.
- Browser sends cancellation only through the control stream; Node signal/timeout spawn options and the old JS numeric-group finalizer must not remain active alongside native ownership. An uncertain supervisor result never authorizes stale-PID recovery. Worker stdin availability follows execution state rather than the supervisor's `exitCode`.
- Native code owns the sole direct root, handles every setup/observation error explicitly, performs its final authorized signal, permanently disables signaling, and then reaps only if waitable. A missed settle deadline or lost wait ownership produces uncertainty. The total timeout starts at supervisor entry, with startup bounded inside it; implementation must define sleep behavior rather than promise scheduling guarantees.
- Preserve only worker descriptors 0/1/2/5/6 through `sandbox-exec` into the trusted gate; close the gate descriptors before successful payload exec. Keep the helper and its replacement-controlling ancestors outside writable roots. Add exact helper read/exec permission, preserve same-sandbox signal restrictions, and retain pre-launch environment filtering. Real exec-chain and composed-Seatbelt checks remain required.
- Build repository-owned native source with installed tooling and explicit target architecture/minOS; align the candidate with inspected Electron 43's macOS 12 minimum. A fixed private resolver must fail closed on missing/skewed artifacts. Include both normal and qualification packages. Installed electron-builder supports a custom signing hook wrapping per-file options; an explicit empty helper entitlement plist avoids inheriting the browser's JIT and disabled-library-validation privileges while preserving other components' signing behavior. No signing or build ran during this review.

At this review checkpoint no native helper had been integrated. The detailed review lists the required transport, exec, failure, architecture and packaging checks. The implementation checkpoint below supersedes that status without changing the prototype's evidence or unresolved guarantees.

### Native integration candidate — implemented, product qualification incomplete

The Seatbelt executor now launches the repository-owned helper through `macos-supervisor-process.js`. Native code owns the execution root, verifies its session/group before releasing a trusted post-Seatbelt gate, watches browser control EOF and a continuous-clock deadline, signals before relinquishing wait ownership, and reports bounded private lifecycle records. Command output cannot spoof readiness or completion. JavaScript cancellation closes the control channel; there is no JavaScript numeric-signal fallback. Startup/control failures remain failures rather than appearing as user cancellation. Root outcome, supervisor-exit uncertainty and output truncation remain distinct evidence.

`macos-supervisor-runtime.js` resolves a fixed architecture-specific development or packaged artifact, checks executable/source/manifest consistency and rejects workspace-writable placement. These hashes detect skew; the manifest is not an independent integrity trust root. The production app seal remains the packaging integrity boundary. Installed Apple tooling builds the helper without downloads. Both package configurations include it; the signing hook gives the leaf empty entitlements, verifies runtime/identity properties and updates its hash before sealing the containing app. Developer-ID signing/notarization is not yet qualified.

[The implementation evidence](evidence/macos-native-supervisor-implementation-2026-09-07.md) retains the exact native source/build identities, explicit disposable-Mac report, native fixtures and receipts, and primary-Mac benign checks. Four native exec/control cases passed once each, with registered exact-instance exit evidence and no observed owned survivors. These used a synthetic Electron-as-Node driver and the older checkout's policy builder plus literal helper rules; they do not qualify the primary's full JS/product integration. The optimized local helper separately passed fixed commands through Node, Electron and the unsigned packaged asar backend. No native Quit, browser-crash or detached fixture ran on the primary Mac.

The candidate improves who owns original-group cleanup. It does not discover or terminate every escaped descendant, survive failure of its own supervisor, reclaim stale processes at startup, or enforce aggregate resource limits. Keep `best_effort / original_process_group / survivorsPossible=true / completeDescendantTermination=false`. Current-product Stop/timeout/preview/conversation teardown, native Quit, browser crash and supervisor-failure cases still require bounded disposable-Mac qualification before calling this milestone complete.

### Current-product qualification follow-up — 2026-09-08

User-approved source transfer is complete. [The current-product evidence](evidence/macos-native-product-qualification-2026-09-08.md) retains source/artifact identities, the first aborted bounded group, and raw native receipts. Nine product assertions and three cleanup assertions passed before a test-monitor registration failure; no command was released after that failure, and all seven roots reported reaped. The corrected observer then supported a passing 89-assertion campaign across processes, reconciliation, previews and process controls, using the unchanged production implementation. All 53 command roots have independent exit observations and native reap receipts, with no watchdog intervention. Final group-KILL EPERM remains explicit uncertainty; five-minute handle expiry was skipped. Test-only finite app-exit support is committed as `dd96ec87`, with ordinary Jest/lint passing. Actual native Quit, browser-loss and supervisor-loss cases remain pending; this follow-up does not close the milestone.

### Actual Electron-main test ownership — 2026-09-08

[The independent launcher review](evidence/macos-electron-main-ownership-review-2026-09-08.md) rejected the first source-only Playwright app-loss harness. Node/libuv can reap multiple children before delivering their individual exit callbacks, while ChildProcess signaling still uses a stored numeric PID; Playwright also has independent numeric group-cleanup paths. This is a source-based counterexample, not a PID-reuse experiment or a production regression. The revised qualification watchdog must own the actual Electron main as its direct unreaped child, with a separate inspector client for test operations and native Quit. The original harness was not executed. The direct-owner replacement passed source review and pure mocks; independent Claude review prompted a bounded natural-exit grace for framework helpers. Test support `2ea1250a` adds explicit shared-clock alarm anchors. One disposable-Mac idle attempt then failed in inspector identity evaluation before preparation or Quit; its two direct children were observed exiting and reaped. The installed Playwright adapter supplies the missing default-context / `includeCommandLineAPI` compatibility options. A corrected bounded four-case campaign is in progress; no lifecycle pass is inferred from that aborted attempt.

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

The primary development Mac is restricted to source/documentation review and ordinary benign checks. Potentially harmful, detached-process and application-exit experiments belong on the designated disposable Mac. No downloaded software, OS privilege changes, service installation, or broader release is authorized by this investigation. The native helper's empty signing entitlements grant no additional privileges.

Before adopting an implementation, record the achievable contract and independently observe survivors before fixture cleanup. Use bounded fixtures, explicit ownership established before launch, finite spawn counts, deadlines, an independent watchdog and unrelated-process canaries. A deliberately demonstrated survivor is a limitation result, not a complete-cleanup pass. Never signal by process name, workspace-path resemblance, or an unvalidated stale PID.

Required scenarios for a chosen implementation: ordinary completion, Stop, timeout, conversation deletion, native Quit, browser crash, supervisor failure, startup recovery, rapid bounded fork/exec, double fork, session/group changes, and PID identity mismatch. Preserve filesystem/network isolation, preview revocation, terminal evidence and the non-consuming chrome Stop behavior. Aggregate CPU, memory, PID and disk containment remains separate.
