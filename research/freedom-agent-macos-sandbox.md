# Freedom Agent macOS Seatbelt workspace sandbox spike

Date: 2026-09-01
Status: isolated runnable feasibility and Electron-main qualification spike on `experiment/agent-workspace-sandbox-electron-macos`
Starting point: `b6582dce214df15904a4b965e57df689294ca683`
Electron qualification starting point: `576903a553d88920ce3bc0ef3a41d9c50e8bb488`
Qualified host: macOS 15.6 build 24G84, Apple Silicon arm64

## Decision summary

The revised macOS boundary is credible enough for constrained managed-workspace product work, but it is not ready for general shell exposure. Seatbelt is the authority boundary for filesystem and network access. A dedicated process group provides operational timeout and cancellation with an explicitly **best-effort** guarantee.

Ordinary descendants remain in the launch process group. Cancellation and timeout send `SIGTERM`, followed after a bounded grace period by `SIGKILL`. Before resolving any spawned execution receipt, including normal completion, the backend also makes a final best-effort `SIGKILL` attempt against the original process group. A hostile descendant can call `setsid()` and escape that group. It remains subject to the inherited Seatbelt profile, so it still cannot read or write forbidden filesystem paths or use external, localhost or DNS networking. It can continue using the selected writable workspace until separately terminated.

This is intentionally the same architectural split demonstrated by the commit-pinned open-source Codex implementation: Seatbelt constrains authority, while process-group cleanup is best-effort lifecycle management. This is an inference from source, not a claim that OpenAI formally guarantees detached-descendant behavior.

The spike remains backend-only. It adds no Pi tools, IPC channels, Agent UI, static preview, project creation, approval flow or Swarm publishing.

## Threat model

The trusted caller selects an existing Freedom-created workspace. Future model-facing APIs must resolve opaque workspace IDs in trusted main-process code and never accept host paths from a model.

The command, generated scripts and every descendant are hostile. Seatbelt must retain across fork and exec. The protected assets are:

- files outside the selected workspace and exact read-only runtime/toolchain roots;
- `.git` and exactly authorized external Git metadata;
- other projects, Freedom/browser profiles, wallets, SSH and credential material;
- host temporary data and reusable caches; and
- external network, DNS, localhost and host services.

Process availability is a separate operational concern. The backend does not claim a PID namespace, durable tree ownership or complete teardown. A detached process remains a residual availability and workspace-integrity risk, not an escape from the Seatbelt authority boundary.

## Architecture

### Policy and provenance

`createWorkspaceExecutionPolicy()` still performs canonical workspace and working-directory validation, bounded hardlink/special-file scanning, Git pointer/commondir authorization, `config` and `config.worktree` validation, environment scrubbing, request bounding and private WeakSet provenance.

The cancellation contract now records `guarantee: backend_reported`. Linux Bubblewrap still provides its stronger PID-namespace teardown behavior. The macOS receipt and capability report say `cancellationGuarantee: best_effort`; neither backend's actual behavior is weakened or overstated.

### Seatbelt profile

The generated profile is deny-by-default and allows:

- fork, exec, same-sandbox signaling and same-sandbox process information;
- read/write access to the exact canonical workspace;
- read/write access to one canonical, mode-0700 per-execution private directory;
- read-only `/System`, `/usr`, `/bin`, `/sbin`;
- exact Apple and Command Line Tools paths that exist on the host;
- exact system account/network database and certificate files needed by command-line runtimes;
- the exact active Node runtime root;
- exact Homebrew runtime dependency subtrees discovered from the active Node binary with `/usr/bin/otool`; and
- the exact OpenSSL configuration subtree required by that Node runtime.

`.git`, configured protected paths and authorized external Git metadata receive explicit deny-write rules that take precedence over the writable workspace. The launcher fixes `GIT_OPTIONAL_LOCKS=0` and does not let the caller override it.

Networking is denied by the default posture and an explicit `deny network*`. Qualification covers localhost, an external address and DNS.

The profile allows global pathname metadata reads because dyld and common command-line runtimes probe parent directories before opening authorized files. It also allows read-data access to the literal root directory for runtime traversal. File contents outside allowed roots remain denied. Pathname existence and root directory entries are therefore residual disclosures.

### Private execution storage and environment

Every run creates a canonical mode-0700 directory with private `home`, `tmp`, `cache`, `config` and `data` children. `HOME`, `TMP*` and XDG variables point there. The directory is host-backed, not tmpfs or mount-namespace-private. Cleanup is best-effort and any failure is reported without suppressing the bounded receipt.

The child environment is built from the validated allowlist. Loader injection, language injection, credentials, host home/temp, display/session and Git authority variables remain scrubbed. Node spawns only stdin/stdout/stderr, so unrelated parent descriptors are not inherited.

### Launch, readiness and receipts

`/usr/bin/sandbox-exec` is invoked by absolute path with a generated profile file. The final trusted shell wrapper prints an unguessable marker after Seatbelt application and before executing the requested argv. If the marker is absent, the result is `sandbox_denied`; there is no unsandboxed retry. This marker proves profile application readiness, not the profile's filesystem or network denial semantics. Enforcement evidence comes from the qualified integration corpus.

Stdout and stderr are continuously drained and independently bounded. Receipts distinguish completed, failed, cancelled, timed-out and sandbox-denied states. All runnable receipts expose `terminationGuarantee: best_effort`.

The launcher starts `sandbox-exec` in a dedicated process group/session. Cancellation and timeout send `SIGTERM` to the original group, wait one second, send `SIGKILL`, then resolve within another bounded interval even if a detached descendant retains resources. Direct-child close no longer cancels cleanup: finalization first makes an additional best-effort group `SIGKILL` attempt, so an ordinary same-group background child cannot silently become untracked merely because the root exited. Non-`ESRCH` signal errors are retained in receipt diagnostics. PID/PGID reuse remains a small signaling race and is documented rather than hidden.

## Capability detection

The exact OS-build allowlist was removed. Runtime detection now checks:

- Darwin platform;
- `/usr/bin/sandbox-exec` exists as a regular file; and
- a harmless deny-default representative profile using the required profile operations successfully launches `/usr/bin/true`.

Architecture and kernel release are diagnostics, not allowlist keys. The probe and per-run marker establish profile application readiness. They do not synthetically retest denial semantics on every launch; those semantics are established by the qualification corpus. An unsupported profile or failed Seatbelt application still fails closed before the requested command is classified as started.

`sandbox-exec` remains deprecated and its profile language unsupported as a stable public interface. Capability probing reduces application failures, but qualified integration tests on each supported macOS/runtime layout remain necessary for enforcement confidence.

### Qualified toolchain scope

The standalone qualification supplies its canonical Node runtime root explicitly. A second production-equivalent development harness now runs inside the actual Electron main process for Freedom `0.8.1-dev`, Electron `43.0.0`, embedded Node `24.17.0`, Chromium `150.0.7871.46`, with `app.isPackaged === false`.

The Electron harness discovers and probes the active application executable, then uses Electron's `ELECTRON_RUN_AS_NODE=1` helper mode for JavaScript workloads. The only additional runtime authority is the exact active bundle:

- `/Users/flobot/Git/freedom-dev/freedom-browser/node_modules/electron/dist/Electron.app` — read-only, required for the active Electron executable, frameworks and resources.

The policy explicitly disables standalone-Node inference for this path. It does not grant `/opt/homebrew`, `/usr/local`, the repository, the user home or arbitrary host toolchains. The executable is invoked by its canonical path rather than added to a broad `PATH`.

This is production-equivalent Electron-main evidence, not a signed packaged-Freedom result. A packaged build must rerun the same discovery and qualification because its executable/bundle path changes and an Electron fuse may disable `ELECTRON_RUN_AS_NODE`. That condition fails with `ELECTRON_NODE_RUNTIME_UNAVAILABLE`; there is no broad-host fallback. Python remains layout-specific: `/usr/bin/python3` can delegate into paths under `/Applications/Xcode.app` on some Macs, which this profile does not currently grant.

The development Electron helper writes a bounded `task_name_for_pid: (os/kern) failure (5)` code-signature diagnostic to stderr under Seatbelt. Its JavaScript workloads still complete and validate. The profile was not widened to grant task inspection; a signed packaged run must determine whether this diagnostic or behavior changes.

### Backend-neutral executor contract

`createWorkspaceExecutor()` now selects Seatbelt on macOS, Bubblewrap on Linux and a structured unavailable backend elsewhere. Callers use the same `detectCapabilities()` and `execute()` methods without importing a platform backend. Receipts identify their backend and termination guarantee. macOS reports `best_effort`; Linux reports `namespace_scoped`; no macOS code claims PID-namespace semantics.

This is deliberately a main-process module. No renderer dependency, IPC channel, Pi tool, shell UI or product exposure was added.

### Electron qualification harness

`electron-qualification-main.js` is a dedicated Electron main entry point. It does not mock Electron and does not start a renderer. It creates one validated temporary Freedom-owned website workspace and an outside sibling canary, initializes protected Git metadata, and invokes the backend-neutral executor from the Electron main process.

The positive workload inspects and modifies HTML/CSS/JavaScript, runs the workspace's existing `build.js` with Electron's embedded Node helper, validates the output and writes `dist/` entirely inside the managed fixture. Networking remains disabled throughout.

Ordinary qualification additionally verifies:

- direct, symlink, dynamically attempted hard-link, Electron-interpreter and shell-subprocess escapes;
- outside writes, localhost, external TCP, DNS and Unix-domain host IPC denial;
- private HOME/TMP/XDG paths and post-receipt cleanup;
- protected `.git` reads and write denial;
- completed and failed exit states, bounded stdout/stderr, timeout and cancellation receipts;
- final same-group cleanup after normal root exit; and
- bounded `SIGTERM` to `SIGKILL` escalation when the root and child ignore `SIGTERM`.

The separate Electron destructive command remains doubly gated. It records a token-bearing `setsid()` PID, demonstrates that the child survives group cancellation while file/network restrictions persist, and performs bounded token-checked cleanup in `finally`.

One preliminary grace-period run recorded an `EPERM` diagnostic from the redundant finalization `SIGKILL` after the scheduled group `SIGKILL` had already stopped the group; the final evidence run did not reproduce it. In both runs the descendant heartbeat stopped and the receipt resolved within the bound. Such errors remain visible rather than being silently discarded; they do not upgrade the best-effort guarantee.

## Qualification evidence

The ordinary focused corpus covers:

- shell commands, generated shell scripts and nested descendants;
- Python and Node;
- workspace creation/modification;
- read-only Git status, diff and log;
- direct, base64-encoded, generated-Python and symlink reads outside the workspace;
- writes outside the workspace;
- `.git` write denial and fixed optional-lock behavior;
- fresh HOME and temporary storage per execution;
- localhost, external-address and DNS denial;
- final group cleanup of redirected background descendants after normal root exit;
- cancellation cleanup of a same-group descendant that ignores `SIGTERM`;
- continuous output draining and truncation.

The repository qualification runs focused Jest, full lint, a Babel transform and shell/Python/Git checks inside Seatbelt with installed `node_modules` protected read-only. No network or dependency download is available inside the sandbox.

Recorded results on the qualified host:

- `npm ci`: completed from the existing lockfile; npm reported 21 dependency audit findings (7 low, 5 moderate, 9 high), unrelated to this dependency-free spike.
- `npm run test:agent-sandbox:macos`: 2 suites, 14 tests passed, including normal-exit and cancellation same-group survivor regressions.
- Doubly gated `npm run test:agent-sandbox:macos:destructive`: 1 test passed and cleaned the recorded detached PID.
- `npm run test:agent-sandbox:macos:qualification`: capability probe, focused Jest, full lint, Babel and shell/Python/Git workloads all completed inside Seatbelt.
- `npm run test:agent-sandbox:macos:electron`: production-equivalent Electron-main website, boundary and lifecycle qualification passed.
- Doubly gated `npm run test:agent-sandbox:macos:electron:destructive`: detached `setsid()` child survived cancellation, remained confined, and was explicitly cleaned.
- Electron runtime/policy/backend-neutral focused contract: 4 suites and 24 tests passed.
- Shared execution-policy suite: 11 tests passed.
- Host `npm run lint`: passed.
- Full `npm test` outside the outer Codex sandbox: 212 suites and 3,825 tests passed; one Linux-only Bubblewrap unit suite had two pre-existing macOS expectation failures because it expects missing/setuid-binary denial codes before the backend's `UNSUPPORTED_PLATFORM` check. Eight suites and 26 tests skipped normally. The Linux execution behavior was not changed; only backend-neutral receipt metadata was added.

The destructive/VM-only corpus requires both `FREEDOM_SANDBOX_DESTRUCTIVE=1` and `FREEDOM_REQUIRE_SEATBELT=1`. It validates a fresh canonical direct child of the system temporary directory with the fixed `freedom-seatbelt-destructive-` prefix. The test:

1. records the detached child's PID and unique ownership token;
2. calls `setsid()` in that child;
3. cancels the original process group;
4. proves the detached child remains alive;
5. proves it still cannot read an outside sibling canary or use localhost, external or DNS networking;
6. proves it can continue writing the authorized workspace;
7. verifies the outside sibling survives; and
8. explicitly cleans up with bounded `SIGTERM`/`SIGKILL`, rechecking the unique command token before every signal.

## Capability matrix

| Capability | Result | Notes |
| --- | ---: | --- |
| Seatbelt profile application readiness | yes | Representative launch probe plus per-launch marker; application failure is sandbox-denied. |
| Electron main-process invocation | yes | Freedom 0.8.1-dev under Electron 43.0.0 development bundle. |
| Electron JavaScript helper | yes, constrained | Active canonical executable in `ELECTRON_RUN_AS_NODE` mode; exact `.app` bundle read-only. |
| Packaged signed Freedom | **not yet** | Must rerun; disabled run-as-node fuse fails closed without host fallback. |
| Exact workspace read/write | yes | Canonical host path; no neutral mount path on macOS. |
| `.git` and authorized metadata read-only | yes | Explicit deny-write precedence; common and worktree config prevalidated. |
| Outside file contents denied | yes | Shell/Python/generated/symlink corpus passes. |
| Network/DNS/localhost denied | yes | Explicit ordinary and detached-descendant coverage. |
| Descendant policy inheritance | yes | Demonstrated by detached-child adversarial test. |
| Per-execution private host storage | yes | Unique mode-0700 host-backed directory, cleaned best-effort. |
| Closed unrelated descriptors | yes | Node spawn exposes only configured standard streams. |
| Bounded output | yes | Streams remain drained after visible caps. |
| Wall timeout | yes | Same best-effort process-group semantics as cancellation. |
| Ordinary process-group cleanup | yes | TERM/grace/KILL for cancellation; final KILL attempt before every spawned receipt. |
| Complete descendant termination | **no** | `setsid()` escape is expected and explicitly qualified. |
| Aggregate CPU/memory/PID/disk containment | **no** | Per-process mechanisms are not represented as aggregate controls. |

## Codex architectural comparison and provenance

The comparison used these commit-pinned sources without copying code:

- [Official Codex approvals and security overview](https://developers.openai.com/codex/agent-approvals-security)
- [Codex Seatbelt base policy](https://github.com/openai/codex/blob/3a04482645b695085f4daf7c6310ab8592653fea/codex-rs/sandboxing/src/seatbelt_base_policy.sbpl)
- [Codex Seatbelt profile construction](https://github.com/openai/codex/blob/3a04482645b695085f4daf7c6310ab8592653fea/codex-rs/sandboxing/src/seatbelt.rs)
- [Best-effort process-group signaling](https://github.com/openai/codex/blob/3a04482645b695085f4daf7c6310ab8592653fea/codex-rs/utils/pty/src/process_group.rs#L86-L111)
- [Pipe launcher and macOS termination](https://github.com/openai/codex/blob/3a04482645b695085f4daf7c6310ab8592653fea/codex-rs/utils/pty/src/pipe.rs)
- [Detached `setsid()` test](https://github.com/openai/codex/blob/3a04482645b695085f4daf7c6310ab8592653fea/codex-rs/utils/pty/src/tests.rs#L883-L968)
- [Codex core macOS platform notes](https://github.com/openai/codex/blob/3a04482645b695085f4daf7c6310ab8592653fea/codex-rs/core/README.md#macos)

The concepts adapted are deny-default Seatbelt confinement, same-sandbox process operations, protected Git metadata, dedicated process groups, best-effort cleanup and an explicit detached-child test. Freedom's JavaScript implementation, policy model, receipts, profile construction and tests were written independently. No Codex source was copied.

## Residual risks and blockers before product exposure

1. A hostile `setsid()` descendant can outlive cancellation and continue modifying the authorized workspace.
2. A bounded negative-PGID signal sequence has a small process-group reuse race.
3. There is no aggregate memory, CPU, PID-count or disk containment.
4. Host-backed private storage can consume host disk; cleanup can fail.
5. Canonical workspace/runtime/temp paths, pathname metadata and root directory entries are visible.
6. The production-equivalent Electron development bundle is qualified, but a signed packaged Freedom bundle is not. Packaging can change paths, code-signing behavior and the run-as-node fuse.
7. Python resolution is host-layout-specific; system Python may delegate into ungranted Xcode application paths.
8. Broad read-only Apple system paths remain part of the trusted runtime surface; the qualified workloads require no explicit Mach-service grants.
9. The capability probe proves profile application readiness, while enforcement confidence depends on the qualified integration corpus for each supported host layout.
10. `sandbox-exec` and SBPL are deprecated/private interfaces and can change between macOS releases.
11. This is not protection against a Seatbelt or kernel escape.

## Recommendation

**Proceed with constraints.** The filesystem/network boundary, Electron-main runtime path and explicit best-effort lifecycle model are credible enough to begin narrow managed-workspace product integration behind an experimental gate. Keep command authority in trusted main-process code and retain opaque managed workspace identities.

Do not expose general shell execution to Pi or user-facing Agent surfaces until the same corpus passes from a signed packaged Freedom build and product/security decisions cover aggregate resource containment, detached-process policy, supported macOS/runtime layouts and same-UID workspace lifecycle races. Do not represent process-group cleanup as a security boundary.
