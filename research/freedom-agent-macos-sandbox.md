# Freedom Agent macOS Seatbelt workspace sandbox spike

Date: 2026-09-01
Status: isolated runnable feasibility spike on `experiment/agent-workspace-sandbox-macos`
Starting point: `b6582dce214df15904a4b965e57df689294ca683`
Qualified host: macOS 15.6 build 24G84, Apple Silicon arm64

## Decision summary

The revised macOS boundary is credible enough for continued isolated backend research, but it is not product-ready. Seatbelt is the authority boundary for filesystem and network access. A dedicated process group provides operational timeout and cancellation with an explicitly **best-effort** guarantee.

Ordinary descendants remain in the launch process group and are terminated with `SIGTERM`, followed after a bounded grace period by `SIGKILL`. A hostile descendant can call `setsid()` and escape that group. It remains subject to the inherited Seatbelt profile, so it still cannot read or write forbidden filesystem paths or use external, localhost or DNS networking. It can continue using the selected writable workspace until separately terminated.

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

`/usr/bin/sandbox-exec` is invoked by absolute path with a generated profile file. The final trusted shell wrapper prints an unguessable readiness marker after Seatbelt application and before executing the requested argv. If the marker is absent, the result is `sandbox_denied`; there is no unsandboxed retry.

Stdout and stderr are continuously drained and independently bounded. Receipts distinguish completed, failed, cancelled, timed-out and sandbox-denied states. All runnable receipts expose `terminationGuarantee: best_effort`.

The launcher starts `sandbox-exec` in a dedicated process group/session. Cancellation and timeout send `SIGTERM` to the original group, wait one second, send `SIGKILL`, then resolve within another bounded interval even if a detached descendant retains resources. PID/PGID reuse remains a small signaling race and is documented rather than hidden.

## Capability detection

The exact OS-build allowlist was removed. Runtime detection now checks:

- Darwin platform;
- `/usr/bin/sandbox-exec` exists as a regular file; and
- a harmless deny-default representative profile using the required profile operations successfully launches `/usr/bin/true`.

Architecture and kernel release are diagnostics, not allowlist keys. Every real execution still has its own readiness proof, so an unsupported or changed profile fails closed before the requested command is classified as started.

`sandbox-exec` remains deprecated and its profile language unsupported as a stable public interface. Capability probing reduces, but does not eliminate, cross-release risk.

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
- best-effort cancellation of ordinary descendants in the original group; and
- continuous output draining and truncation.

The repository qualification runs focused Jest, full lint, a Babel transform and shell/Python/Git checks inside Seatbelt with installed `node_modules` protected read-only. No network or dependency download is available inside the sandbox.

Recorded results on the qualified host:

- `npm ci`: completed from the existing lockfile; npm reported 21 dependency audit findings (7 low, 5 moderate, 9 high), unrelated to this dependency-free spike.
- `npm run test:agent-sandbox:macos`: 2 suites, 12 tests passed.
- Doubly gated `npm run test:agent-sandbox:macos:destructive`: 1 test passed and cleaned the recorded detached PID.
- `npm run test:agent-sandbox:macos:qualification`: capability probe, focused Jest, full lint, Babel and shell/Python/Git workloads all completed inside Seatbelt.
- Shared execution-policy suite: 11 tests passed.
- Host `npm run lint`: passed.
- Full `npm test` outside the outer Codex sandbox: 210 suites and 3,818 tests passed; one Linux-only Bubblewrap unit suite had two pre-existing macOS expectation failures because it expects missing/setuid-binary denial codes before the backend's `UNSUPPORTED_PLATFORM` check. Eight suites and 25 tests skipped normally. The reviewed Linux implementation was not changed.

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
| Seatbelt application | yes | Per-launch readiness marker; initialization failure is sandbox-denied. |
| Exact workspace read/write | yes | Canonical host path; no neutral mount path on macOS. |
| `.git` and authorized metadata read-only | yes | Explicit deny-write precedence; common and worktree config prevalidated. |
| Outside file contents denied | yes | Shell/Python/generated/symlink corpus passes. |
| Network/DNS/localhost denied | yes | Explicit ordinary and detached-descendant coverage. |
| Descendant policy inheritance | yes | Demonstrated by detached-child adversarial test. |
| Per-execution private host storage | yes | Unique mode-0700 host-backed directory, cleaned best-effort. |
| Closed unrelated descriptors | yes | Node spawn exposes only configured standard streams. |
| Bounded output | yes | Streams remain drained after visible caps. |
| Wall timeout | yes | Same best-effort process-group semantics as cancellation. |
| Ordinary process-group cancellation | yes | TERM, bounded grace, KILL. |
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
6. Exact runtime dependency discovery currently targets the active Node Mach-O/Homebrew layout; other package managers and runtimes need qualification.
7. Broad read-only Apple system paths remain part of the trusted runtime surface; the qualified workloads require no explicit Mach-service grants.
8. `sandbox-exec` and SBPL are deprecated/private interfaces and can change between macOS releases.
9. This is not protection against a Seatbelt or kernel escape.

## Recommendation

Retain this as an isolated experimental backend. The filesystem/network boundary and explicit best-effort lifecycle model are credible enough for further backend qualification. Do not merge it into a feature branch or expose it to Pi/product surfaces until resource containment, detached-process lifecycle policy, broader macOS compatibility, runtime dependency discovery and same-UID workspace lifecycle races receive explicit product/security decisions.
