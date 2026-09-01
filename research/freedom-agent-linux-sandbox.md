# Freedom Agent Linux workspace sandbox spike

Date: 2026-09-01
Status: isolated experiment on `experiment/agent-workspace-sandbox`
Initial target: Ubuntu 24.04 x86-64 with distribution Bubblewrap

## Decision summary

The Linux boundary is credible enough to continue evaluating the shared execution-policy contract, but it is not product-ready. Bubblewrap can enforce the intended default filesystem, PID, IPC, UTS, user, cgroup-namespace, and network view before an arbitrary command starts, and the focused adversarial corpus demonstrates useful Node/npm-style execution without access to ordinary host data or services.

Productization remains blocked on two items that Bubblewrap does not supply by itself:

1. reviewed aggregate PID and memory containment through cgroup v2; and
2. a reviewed custom seccomp policy, or an explicit security decision documenting why one is unnecessary for the supported workload.

The spike deliberately contains no Pi tool, IPC, Workspace UI, preview server, publication adapter, or approval flow. The only new command-line entry point is a repository-local qualification script.

## Threat model

### Protected assets

- Files outside the one Freedom-managed project workspace.
- The host home directory, other projects, credentials, SSH agents, Git credential stores, browser/Freedom profiles, wallet data, node data, and reusable caches.
- Host processes, local services, D-Bus, display servers, container engines, browser debugging sockets, and unrelated Unix sockets.
- Workspace metadata that can persist execution authority, initially `.git` and its resolved external gitdir.
- Host availability, bounded only partially in this checkpoint.

### Attacker

The command, shell scripts, generated programs, their complete descendant process tree, and all stdout/stderr are untrusted. The attacker may use shell indirection, Python, Node, encoded paths, symlinks, subprocesses, sockets, environment inspection, inherited-descriptor guesses, and deliberate cancellation races. Command text is not inspected or classified.

Trusted components are the caller that selects the workspace, the normalized policy validator, the Bubblewrap argument generator, the distribution Bubblewrap binary, and the Linux kernel/AppArmor configuration. A future model-facing surface must refer to the workspace and operation by opaque IDs; it must not accept canonical host paths from the model.

### Security goals

- Apply isolation before any untrusted command begins and retain it for every descendant.
- Expose only the selected workspace read/write, protected metadata read-only, a fresh private `/tmp`, a minimal host toolchain read-only, a fresh `/proc`, and a minimal `/dev`.
- Leave `/home`, `/root`, `/run`, `/sys`, the host `/tmp`, session/display buses, and arbitrary host paths absent.
- Provide no external network, host loopback, DNS, or host-local abstract Unix sockets.
- Construct the environment from an allowlist after `--clearenv`.
- Close inherited file descriptors, including the launcher-owned status pipe, in trusted setup before command execution.
- Fail closed when Bubblewrap, user namespaces, a protected mount, a required limit, or another requested policy property cannot be enforced.
- Distinguish completed, failed, cancelled, timed-out, and sandbox-denied receipts.

### Explicit non-goals and residual trust

- This is not a kernel-escape boundary against a vulnerability in Linux namespaces, mount handling, or another exposed syscall.
- It does not protect against a separate, same-UID trusted host process concurrently changing the workspace. Freedom-managed workspace ownership and lifecycle must exclude that race in the product design.
- CPU, memory, PID-count, and file-size limits are represented but not yet enforced. Required requests fail closed. Disk exhaustion and fork/memory bombs are not qualified in the ordinary corpus.
- There is no network-enabled posture. Reserved `brokered` requests fail as unsupported.
- There is no setuid Bubblewrap path or unsandboxed fallback.
- Linux `/proc/*/mountinfo` reveals the backing path of bind mounts, including the canonical workspace path. Opaque IDs keep that path out of the API, but they do not make it confidential from a command already running inside the workspace. Avoid placing secrets in managed-project path components; eliminating this disclosure would require a different storage/mount design or a materially reduced `/proc` view.

## Backend-neutral policy contract

`createWorkspaceExecutionPolicy()` resolves and freezes this small contract:

| Policy area          | Current contract and semantics                                                                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Readable roots       | Exact canonical workspace root plus backend-selected system/toolchain roots. The capability/launch plan records the concrete Linux paths.                                                                                                        |
| Writable roots       | Exactly one canonical Freedom-managed workspace mounted as `/workspace`.                                                                                                                                                                         |
| Protected carve-outs | Relative workspace paths with deny/read-only precedence. `.git` is required, resolved, and mounted read-only after the writable workspace mount. External metadata is denied unless trusted lifecycle state authorizes its exact canonical path. |
| Temporary storage    | Fresh tmpfs `/tmp` for every execution, with private home/config/cache directories beneath it. Nothing persists to the host.                                                                                                                     |
| Working directory    | An existing relative directory whose canonical target remains inside the workspace. The sandbox path is rooted at `/workspace`.                                                                                                                  |
| Environment          | `--clearenv`, safe locale/terminal inheritance, bounded trusted explicit values, and fixed private `HOME`, `TMP*`, and XDG locations. Loader, language injection, socket, display, Git override, and credential-shaped variables are rejected.   |
| Network              | `none` only. `brokered` is reserved and currently denied.                                                                                                                                                                                        |
| Wall/output limits   | Five-minute default wall timeout, thirty-minute maximum, and independent 1 MiB stdout/stderr defaults. Output is continuously drained after the visible cap and marked truncated.                                                                |
| Aggregate limits     | CPU time, memory, process count, and maximum file size are represented as optional requirements. Any required value is denied because this backend cannot yet enforce it.                                                                        |
| Cancellation         | An `AbortSignal` terminates the PID-namespace init/Bubblewrap supervisor; namespace teardown kills descendants.                                                                                                                                  |
| System toolchain     | Explicit boolean. The first backend currently requires the read-only platform toolchain view and fails if it is disabled.                                                                                                                        |
| Seccomp              | A required-custom-filter flag exists. It fails closed because no reviewed general filter ships in this spike.                                                                                                                                    |

Protected/denied paths cannot be reopened, and read-only paths override their writable parent. The validator rejects nested protected entries instead of relying on Bubblewrap argument order to resolve ambiguity.

Validated policy objects carry private in-process provenance in a module-scoped `WeakSet`. The backend refuses lookalike plain objects even when their public kind, version, and fields are structurally plausible. A future IPC surface must resolve an opaque workspace ID and invoke this validator in trusted main-process code; serialized policy objects are intentionally not executable authority.

## Path and metadata handling

The launcher mounts the host workspace at the neutral `/workspace` path. Absolute or relative symlinks that leave it resolve into an absent sandbox path; symlinks into an exposed system path reach only its read-only view.

Pre-existing hardlinks are different: a writable path and a hidden outside path can name the same inode. Pathname Unix sockets, FIFOs, and devices already placed in the workspace can also cross or distort the intended boundary. The policy therefore scans the writable tree, rejects special files, and rejects regular files with a link count greater than one. This intentionally sacrifices legitimate workspace hardlinks and special build artifacts until a stronger workspace-storage design exists. The scan is bounded to 500,000 entries. A same-UID host race after validation remains an unresolved product-lifecycle risk.

`.git` behavior is explicit:

- An ordinary `.git` directory is over-mounted read-only.
- A `.git` pointer file is parsed only after trusted lifecycle state supplies the exact canonical external gitdir and common-directory paths. Workspace-controlled pointer text cannot authorize a mount. Authorized pointers are replaced with path-neutral sandbox pointers under `/freedom-git-*`.
- The resolved gitdir and, when present, common directory are mounted read-only.
- A missing `.git`, a symlink, malformed pointer, nested protected path, or missing resolved directory fails closed. A future Freedom project creator can satisfy this invariant by initializing the managed project before shell authority is granted.
- Common and linked-worktree-specific Git configuration is bounded and rejected if it contains includes, credential sections, embedded URL credentials, HTTP credential-bearing files/headers, TLS key paths, or a worktree-controlled hooks path.

This allows `git status`, `diff`, `log`, and version inspection while preventing commits, ref/object/config mutation, checkout metadata changes, and hook installation.

## Linux Bubblewrap construction

The launcher uses:

- `--unshare-all` plus explicit `--unshare-user`;
- `--disable-userns` and `--assert-userns-disabled` to prevent nested user namespaces;
- `--cap-drop ALL`, `--new-session`, `--die-with-parent`, and a private hostname;
- a new PID namespace and `/proc`, IPC/network/UTS/cgroup namespaces, and minimal `/dev`;
- read-only `/usr`, `/bin`, `/sbin`, required `/lib*`, selected loader/public-certificate configuration, and an exact neutral mount for the active Node installation when it is outside system paths;
- no `/run`, host `/tmp`, host home, display, session bus, or socket mount;
- a sanitized passwd/group/NSS/hosts view rather than the host identity database; and
- one JSON status descriptor used by Bubblewrap, accepted only for the first valid child PID, and explicitly closed by the trusted readiness wrapper before the command starts.

Bubblewrap's child-PID status occurs before every mount has necessarily succeeded. The executor therefore launches a trusted positional-argument shell wrapper that emits a random readiness marker only after Bubblewrap has completed setup and reached the final command environment. The parent strips this marker from stdout. Without it, a bind failure is `sandbox_denied`, never an ordinary command failure and never a reason to retry unsandboxed.

No command string parser exists. Callers supply an executable and argument vector; a general shell request deliberately invokes `/bin/sh -c` as its executable/arguments.

## Receipt and lifecycle semantics

- `completed`: sandbox initialized and the command exited zero. Output truncation does not change this state.
- `failed`: sandbox initialized and the command exited nonzero.
- `cancelled`: the caller aborted and the process tree was terminated.
- `timed_out`: the wall limit expired and the process tree was terminated.
- `sandbox_denied`: capability detection, policy preparation, protected mounts, or sandbox initialization failed. The command was not started.

Stdout and stderr are separately capped and continuously drained. The receipt includes independent truncation flags. Raw Bubblewrap initialization diagnostics are retained only in internal capability diagnostics; execution denial receipts do not return host workspace paths.

Launcher staging cleanup is best-effort after the sandbox has stopped. A cleanup rejection is reduced to a bounded error code in `diagnostics.stagingCleanupFailed` and never prevents the execution receipt from resolving.

## Qualification results

### VM state before provisioning

- Ubuntu 24.04.3 LTS, kernel `6.8.0-90-generic`, x86-64.
- `kernel.unprivileged_userns_clone=1`.
- `kernel.apparmor_restrict_unprivileged_userns=1`.
- `user.max_user_namespaces=30830`.
- Bubblewrap absent.

### Provisioning and AppArmor finding

The approved distribution packages installed Bubblewrap `0.9.0` and AppArmor `4.0.1really4.0.1-0ubuntu0.24.04.7`. The `apparmor-profiles` package places `bwrap-userns-restrict` under `/usr/share/apparmor/extra-profiles`, disabled by default.

Before loading that profile, a non-root Bubblewrap probe reached the generic `unprivileged_userns` profile and failed on `setpcap`/`net_admin`, ending with `loopback: Failed RTM_NEWADDR: Operation not permitted`. Loading the distribution profile with `apparmor_parser` preserved the global restriction and made the same `nobody` probe pass with user, mount, PID, IPC, network, UTS, and cgroup namespaces plus nested-userns disabling. The root-session launcher corpus also passes. This is evidence for the unprivileged path, not a recommendation to run Freedom as root.

The loaded profile is VM runtime state, not a repository change and not persistent packaging. A production Debian package would need a reviewed AppArmor installation/reload path. An AppImage cannot assume that profile exists.

### Automated matrix

The ordinary focused suite uses only validated temporary fixture roots and covers:

- shell, generated scripts, nested children, Node, Python, workspace writes, and read-only Git inspection;
- direct and encoded forbidden reads/writes;
- symlinks leaving the workspace;
- rejection of pre-existing writable hardlinks;
- hidden host processes and failed signaling;
- sensitive environment scrubbing;
- inherited descriptor closure, including explicit `fstat(3)` and `write(3)` denial for the Bubblewrap status descriptor;
- pathname and abstract host Unix sockets, with descendant-only Unix IPC still working;
- rejection of host IPC endpoints pre-positioned inside the writable workspace;
- host loopback, external networking, and DNS denial;
- fresh private home/config/tmp behavior;
- output truncation without pipe blockage;
- ordinary nonzero command failure;
- descendant cleanup after timeout and explicit cancellation;
- protected ordinary and explicitly authorized external `.git` metadata, with workspace-controlled external pointers denied by default;
- rejection of unsafe `config.worktree` in an otherwise authorized linked-worktree layout;
- rejection of forged lookalike policy objects and later child-PID status replacements;
- receipt completion when synthetic staging cleanup fails; and
- sandbox initialization failure with proof that the command never ran outside Bubblewrap.

The VM-only destructive test requires `FREEDOM_SANDBOX_DESTRUCTIVE=1`, validates a fresh direct child of the system temporary directory with a fixed prefix, deletes only synthetic workspace content, and proves an outside sibling canary survives. It never targets the VM root, home, checkout, or another broad path.

The repository-local qualification command runs a focused Jest policy suite, `npm run lint`, and a representative Babel source transform inside the sandbox with installed dependencies and no network. It produces only compact JSON summaries. The checkout declares esbuild but does not contain its executable, so qualification uses the already-installed Babel build dependency instead of downloading or changing dependencies.

Final VM validation results:

- `npm run test:agent-sandbox`: 28 passed; the single destructive test skipped by default.
- `npm run test:agent-sandbox:destructive` with the explicit gate: 1 passed.
- `npm run test:agent-sandbox:qualification`: focused Jest, full lint, and Babel transform all completed inside Bubblewrap.
- `npm run lint`: passed on the host and inside Bubblewrap.
- Full `npm test`: 203 suites and 3,751 tests passed; seven unrelated suites failed because this pre-provisioned checkout lacks declared Ghostery, embedded Pi SDK, OpenLV, and Ledger packages. No dependency was installed or changed to hide that environmental limitation.

## Seccomp assessment

No general syscall filter is installed, and capability reports say so. `--disable-userns` does apply Bubblewrap's narrow nested-user-namespace prevention, and `--new-session` addresses the terminal-injection concern called out by Bubblewrap, but neither is represented as a general seccomp profile.

Before productization, review at least namespace creation/joining, mount APIs, `ptrace` and cross-process memory APIs, `bpf`, `perf_event_open`, keyring calls, `userfaultfd`, `io_uring`, device/ioctl exposure, and kernel/module/reboot operations. Many already fail because the process has no capability in its user namespace or no relevant device/path, but reducing reachable kernel attack surface is still useful. The filter must be tested against Node, Python, npm/Jest, compilers, and their child sandboxes rather than copied as an unreviewed generic denylist.

Linux seccomp filters are classic BPF programs evaluated on syscall metadata; they are not a pathname policy and must avoid time-of-check/time-of-use arguments. Bubblewrap accepts a filter by file descriptor. Freedom should add a small reviewed helper or generated filter only after its compatibility matrix is explicit.

## Aggregate resource-limit assessment

The VM uses unified cgroup v2 with `cpu`, `memory`, and `pids` controllers. Its systemd 255 user manager successfully created transient scopes with `MemoryMax`, `TasksMax`, and `CPUQuota`, demonstrating a viable direction. Kernel cgroup v2 supplies `memory.max`, `pids.max`, and CPU controller accounting; systemd transient units expose the corresponding controls.

The remaining design work is ownership and lifecycle: create a private transient scope without an approval-prone privileged API, place Bubblewrap in it before untrusted descendants fork, correlate OOM/PID-limit outcomes with the execution receipt, and guarantee scope removal on cancellation/crash. A systemd user manager may be absent in containers, minimal distributions, or unusual desktop sessions. Direct cgroup delegation is the alternative but also requires writable delegated controllers. Until one path is implemented and qualified, requested aggregate limits fail closed and resource-exhaustion payloads remain gated.

## Installation and distribution assessment

Initial recommendation: use `/usr/bin/bwrap` from the distribution and check it at runtime.

- Current Bubblewrap has removed setuid operation; Freedom rejects a setuid bit explicitly.
- Ubuntu 24.04 enables an AppArmor user-namespace restriction. The executable path matters to the allow profile, so a bundled binary at an application-specific path will not automatically receive the distribution exception.
- Debian/Ubuntu packages can declare or document a Bubblewrap dependency and install a reviewed profile. AppImage distribution needs an actionable unavailable result and host setup guidance; it must not disable AppArmor globally.
- Flatpak, Snap, Docker/Kubernetes, WSL, and other nested/container environments may block user namespaces, mount propagation, or fresh `/proc` even when the sysctl appears enabled. The executable probe is authoritative and must remain fail closed.
- ARM64 is a required later qualification target. No architecture-specific launcher logic was added.
- Landlock is not a fallback in this spike. It may be added only for an exactly representable policy, never as a silent semantic downgrade.

Bundling should be reconsidered only with an update strategy, exact executable-path AppArmor policy, security-response ownership, and multi-distribution testing. The observed Ubuntu behavior favors the system binary for the first product experiment.

## External implementation references

- [Bubblewrap upstream sandbox/security model](https://github.com/containers/bubblewrap/tree/2fb78e210734316a2765da5251646d411fe34e75) — inspected at commit `2fb78e210734316a2765da5251646d411fe34e75`. Upstream emphasizes that Bubblewrap is a policy construction toolkit and the generated arguments determine the boundary.
- [Ubuntu 24.04 unprivileged-user-namespace restriction](https://documentation.ubuntu.com/release-notes/24.04/#unprivileged-user-namespace-restrictions) — explains the default AppArmor restriction and per-application profile approach.
- [Linux cgroup v2 documentation](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html) — authoritative memory, PID, and CPU controller semantics.
- [Linux seccomp filter documentation](https://www.kernel.org/doc/html/latest/userspace-api/seccomp_filter.html) — BPF filter model and safety constraints.
- [systemd transient resource settings](https://github.com/systemd/systemd/blob/main/docs/TRANSIENT-SETTINGS.md#resource-control-settings) — lists `MemoryMax`, `TasksMax`, and `CPUQuota` for transient units.
- [Codex Linux sandbox](https://github.com/openai/codex/tree/82099786163f3c05facf09078136679e18b64279/codex-rs/linux-sandbox) — inspected at commit `82099786163f3c05facf09078136679e18b64279` as an architectural/behavioral reference only. Freedom code in this spike is independent and contains no copied Codex source.

## Unresolved risks and next decision

1. Implement and qualify cgroup v2 PID/memory containment before calling this a product boundary.
2. Review and qualify a custom seccomp posture; keep capability reporting honest if it remains absent.
3. Decide how packaged Freedom installs/enables the Ubuntu AppArmor profile, especially outside `.deb` packaging.
4. Move Freedom-managed projects onto a lifecycle that prevents same-UID host races after path/hardlink validation.
5. Decide whether every managed project is initialized with protected Git metadata or whether another mechanism can protect a nonexistent `.git` name inside a writable root.
6. Expand distro coverage to Debian, Fedora, ARM64 Ubuntu, WSL2, and representative nested/container failures.
7. Add disk/quota handling and reconcile OOM/PID-limit termination into stable receipts.
8. Review which `/usr` and TLS/loader paths packaged builds actually need; reduce the system view where positive evidence allows.
9. Decide whether the canonical workspace path disclosed by `/proc/*/mountinfo` is acceptable metadata or requires a different project-storage/mount design.

Recommendation: this is serious enough to continue toward a non-destructive macOS Seatbelt feasibility spike using the same contract. It is not serious enough to merge into the feature branch or expose to Pi until Linux cgroup containment, seccomp posture, and packaging diagnostics are resolved.
