# Freedom Agent macOS Seatbelt workspace sandbox spike

Date: 2026-09-01
Status: isolated negative feasibility result on `experiment/agent-workspace-sandbox-macos`
Starting point: `fdf04df9c0973cc6f6c236fb86f71b21baf98c58`
Qualified host: macOS 15.6 build 24G84, Apple Silicon arm64

## Decision summary

The macOS Seatbelt boundary is **not credible enough to continue toward Pi or product exposure** under the reviewed execution-policy contract. `/usr/bin/sandbox-exec` initializes on the qualified host and applies inherited profiles, but Seatbelt does not provide a PID namespace or a qualified mechanism that keeps a hostile descendant tree under race-free cancellation ownership.

The decisive probe ran Python under Seatbelt with `process-info-setcontrol` denied. The hostile process successfully called `setsid()`. A process-group supervisor can therefore be escaped. Later signaling a recorded PID or process-group ID introduces a reuse race that could target an unrelated host process. macOS does not provide Linux's PID-namespace teardown behavior or a child-subreaper facility suitable for repairing this ownership loss. A small native helper would not change that kernel-level fact.

Complete descendant-tree cancellation is mandatory in the shared policy. The macOS backend consequently reports `DESCENDANT_CANCELLATION_UNAVAILABLE`, advertises `cancellation: false`, and never starts the requested command. This is an intentional fail-closed result, not a best-effort executor.

Do not merge this backend into a product-facing parent. The capability detector, profile-construction research, tests and this report are useful experiment evidence, but the execution boundary remains unavailable.

## Scope and threat model

The caller that resolves the Freedom-owned workspace is trusted. The command, scripts, generated programs and complete descendant process tree are hostile. A future model-facing API must use opaque workspace IDs and must never accept host paths.

Protected assets remain those identified by the Linux spike:

- all files outside one Freedom-created project workspace;
- `.git` plus exactly authorized external Git metadata;
- Freedom/browser profiles, wallets, node data, SSH and credential material;
- other projects, host temporary data and reusable caches;
- unrelated processes, local services, sockets and Mach services; and
- host availability beyond honestly enforceable limits.

This spike adds no Pi tool, IPC channel, renderer integration, project creation, preview server, publishing adapter, approval flow or unsandboxed fallback.

## Qualified platform and support status

Runtime detection requires all of:

- `process.platform === "darwin"`;
- architecture `arm64`;
- macOS product version `15.6`;
- build `24G84`;
- regular file `/usr/bin/sandbox-exec`; and
- successful execution of a harmless representative profile.

Intel Macs and every other macOS version/build are unqualified and fail with `UNQUALIFIED_MACOS_BUILD`.

Apple's installed `sandbox-exec(1)` manual labels the command **DEPRECATED** and recommends App Sandbox. The installed `sandbox(7)` manual states that restrictions are inherited by new processes but apply when resources are acquired; already-open writable descriptors remain usable. The profile language and several useful operation names are private/unsupported interfaces. This experiment relies on none of that behavior for a positive availability claim.

## Backend-neutral policy assessment

No shared policy weakening was made. Private WeakSet provenance, exact workspace selection, Git metadata validation, hardlink/special-file rejection, environment validation, request validation and aggregate-limit representation remain unchanged from the reviewed Linux spike.

The macOS profile builder accepts only a privately validated policy. It describes:

- default-deny behavior;
- read/write access to the exact canonical workspace;
- deny precedence for `.git` and authorized external Git metadata;
- exact read/write access to a per-execution private host directory;
- read-only `/System`, `/usr`, `/bin` and `/sbin` when the system toolchain is requested;
- exact read-only Node runtime roots selected by trusted policy construction; and
- denied networking.

The builder is retained as reviewable evidence and a basis for future research. It is not passed an untrusted command because the mandatory lifecycle capability fails first.

The backend would fix `GIT_OPTIONAL_LOCKS=0` in its launcher environment if execution became supportable. No launcher environment is currently constructed because doing so would imply a reachable execution path that the capability decision forbids.

## Seatbelt-specific findings

| Question | Evidence and result |
| --- | --- |
| Exact platform | macOS 15.6, build 24G84, arm64; `/usr/bin/sandbox-exec` is present and initializes successfully. |
| Descendant inheritance | Apple's local `sandbox(7)` documentation states that new processes inherit the parent's sandbox. This was not enough to solve lifecycle ownership. |
| `.git` carve-out | The generated profile uses deny rules for protected metadata beneath an allowed writable workspace. Syntax compilation is qualified, but mutation behavior is not claimed because execution is disabled by the earlier mandatory blocker. |
| System/toolchain surface | The candidate surface is `/System`, `/usr`, `/bin`, `/sbin`, plus exact policy-authorized runtime roots. Positive workload qualification did not run after the lifecycle failure. |
| Mach services | No service was allowlisted or claimed. The boundary fails before an application compatibility allowlist is justified. |
| Host process control | Basic PID visibility is an accepted macOS limitation. Sensitive inspection/signaling guarantees remain unqualified because no runnable backend is exposed. |
| Descendant cancellation | **Unavailable.** `setsid()` succeeds under Seatbelt even with `process-info-setcontrol` denied. Process-group killing is escapable and PID/PGID reuse makes later signaling unsafe. |
| Private temporary storage | A unique mode-0700 host-backed directory is an acceptable intended design, but cleanup and exclusivity are not claimed without a supportable executor. It would not be tmpfs or namespace-private. |
| Visible canonical paths | Seatbelt operates on canonical host paths and provides no mount namespace. The workspace, runtime and private-directory host paths would remain visible. |
| Deprecated technology | `sandbox-exec` works on the exact host but is explicitly deprecated by Apple. Other builds are unqualified. |
| Unavailable guarantees | Complete descendant cancellation, aggregate descendant resource limits, filesystem/network/process/Mach qualification, FD closure and positive workload support. |

## Cancellation evidence

The qualification detector launches:

```text
/usr/bin/sandbox-exec
  -p (version 1)(allow default)(deny process-info-setcontrol)
  /usr/bin/python3 -c "import os; os.setsid()"
```

On macOS 15.6 build 24G84 this exits zero. The process can leave the launcher's session/process group despite the plausible Seatbelt control restriction.

The following alternatives were considered and rejected:

- **Kill a process group:** hostile descendants can call `setsid()` and escape it.
- **Remember and recursively signal PIDs:** discovery and signaling race with exits, forks and PID reuse, risking unrelated processes.
- **Native C supervisor:** macOS has no applicable PID namespace or child-subreaper mechanism; native code cannot manufacture durable ownership after a daemonizing escape.
- **Per-process rlimits:** useful for individual processes but not credible aggregate descendant-tree CPU, memory, PID or disk containment.
- **Treat inherited Seatbelt as sufficient:** escaped descendants remain restricted, but can continue modifying the authorized workspace and consuming resources after a cancelled receipt. That violates the required lifecycle contract.

## Capability matrix

`true` means the narrow mechanism is available; it does not override the overall unavailable result.

| Capability | Reported | Notes |
| --- | ---: | --- |
| Seatbelt profile initialization | true | Harmless profile launches on the exact qualified host. |
| Descendant profile inheritance | true | Documented locally by Apple. |
| Exact filesystem boundary | false | Candidate profile exists; adversarial runtime corpus was not promoted after the mandatory blocker. |
| No external/DNS/localhost network | false | Candidate deny exists; not claimed as fully qualified. |
| Unrelated process protection | false | Not fully qualified. No PID namespace exists. |
| Per-execution host-backed private storage | false | Design accepted, lifecycle not implemented. |
| Closed inherited descriptors | false | Requires a launcher path that is intentionally unreachable. |
| Wall timeout | true | Parent-side timer is representable, but cannot guarantee descendant cleanup. |
| Bounded/drained output | true | Shared Node pattern is representable, but no positive executor is exposed. |
| Complete cancellation | **false** | Mandatory blocker; confirmed `setsid()` escape. |
| Aggregate CPU/memory/PID/disk containment | false | No credible descendant-tree aggregate mechanism. |
| Product/backend availability | **false** | Every execution fails closed. |

## Tests and qualification

Added test coverage verifies:

- profile-string escaping;
- private policy provenance;
- default-deny profile construction;
- exact workspace/private-path authority and `.git` write denial;
- absence of broad home, `/Library` and `/Applications` grants;
- non-macOS and unqualified-build denial;
- exact-build initialization and confirmed `setsid()` escape reporting;
- a forged policy cannot reach profile construction;
- a requested command never runs after capability denial; and
- the doubly gated destructive test validates a fixed-prefix canonical synthetic root and proves both workspace and outside canaries survive because the payload never starts.

The destructive command requires both `FREEDOM_SANDBOX_DESTRUCTIVE=1` and `FREEDOM_REQUIRE_SEATBELT=1`, plus Darwin and the fixture invariants.

The macOS qualification script records each requested positive workload as `sandbox_denied` with `commandStarted: false`. Focused Jest, lint, Babel, shell, Node, Python and Git are deliberately not run inside an executor whose mandatory lifecycle property failed. This is the expected fail-closed qualification result, not a skipped success claim.

At the time of the spike, this checkout had no `node_modules`; no dependencies were downloaded or changed. Syntax checks and the standalone Seatbelt qualification probe can run without installing dependencies. Jest, ESLint and the full repository test suite therefore require the already-declared dependency tree to be restored before their host-side validation results can be recorded.

Recorded validation:

- `npm run test:agent-sandbox:macos:qualification`: passed; profile initialization passed, the `setsid()` escape was confirmed, and all four positive workload categories were denied before command start.
- Direct Node smoke of policy creation, profile construction and executor denial: passed.
- `node -c` for the backend, three test files and qualification script: passed.
- `git diff --check`: passed.
- `npm run test:agent-sandbox:macos`: not runnable because `jest` is absent.
- `npm run lint`: not runnable because `eslint` is absent.
- `npm test`: not runnable because `jest` is absent.
- Doubly gated destructive Jest qualification: not runnable for the same missing declared dependency tree; its fixture and gate logic is covered by source review and syntax validation only.

## Concrete limitations and blockers before Pi/product exposure

1. No race-free ownership and cancellation of the hostile descendant tree.
2. No credible aggregate descendant CPU, memory, PID-count or disk containment.
3. Deprecated and unsupported Seatbelt profile technology with qualification tied to one OS build.
4. No completed adversarial qualification for filesystem, network, Mach, process inspection/signaling, FD inheritance or private-directory cleanup.
5. No sandboxed positive repository workload, because fail-closed capability detection correctly prevents command launch.
6. Canonical host paths would remain visible because Seatbelt has no mount namespace.

## Recommendation

Do not merge a runnable macOS backend into the parent experiment, and do not expose this work to Pi or product code. Preserve the negative spike as evidence if useful. Reconsider macOS only if a supported isolation facility can provide durable descendant ownership and teardown—for example a materially different execution architecture rather than a more permissive Seatbelt profile.

Passing additional filesystem or network tests would not change this recommendation while complete descendant cancellation remains unavailable.
