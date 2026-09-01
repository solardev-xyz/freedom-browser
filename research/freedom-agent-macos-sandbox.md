# Freedom Agent macOS Seatbelt workspace sandbox spike

Date: 2026-09-01
Status: isolated runnable, audit-hardened Electron-main and unsigned packaged-Electron qualification spike on `experiment/agent-workspace-sandbox-hardening`
Starting point: `b6582dce214df15904a4b965e57df689294ca683`
Electron qualification starting point: `576903a553d88920ce3bc0ef3a41d9c50e8bb488`
Packaged qualification starting point: `bce8c7a16e7d620936f0de2038aec3de460510fb`
Audit-hardening starting point: `2e7fa58c54466efcd8a38ee391c3cd6556db1f33`
Qualified host: macOS 15.6 build 24G84, Apple Silicon arm64

## Decision summary

The revised macOS boundary is credible enough for constrained managed-workspace product work, but it is not ready for general shell exposure. Seatbelt is the authority boundary for filesystem and network access. A dedicated process group provides operational timeout and cancellation with an explicitly **best-effort** guarantee.

Ordinary descendants remain in the launch process group. Cancellation and timeout send `SIGTERM`, followed after a bounded grace period by `SIGKILL`. Before resolving any spawned execution receipt, including normal completion, the backend also makes a final best-effort `SIGKILL` attempt against the original process group. A hostile descendant can call `setsid()` and escape that group. It remains subject to the inherited Seatbelt profile, so it still cannot read or write forbidden filesystem paths or use external, localhost or DNS networking. It can continue using the selected writable workspace until separately terminated.

This is intentionally the same architectural split demonstrated by the commit-pinned open-source Codex implementation: Seatbelt constrains authority, while process-group cleanup is best-effort lifecycle management. This is an inference from source, not a claim that OpenAI formally guarantees detached-descendant behavior.

The ordinary corpus now also passes from an actual unsigned, unpacked `Freedom.app` with `app.isPackaged === true` and application code loaded from `app.asar`. The spike remains backend-only. It adds no Pi tools, IPC channels, Agent UI, static preview, project creation, approval flow or Swarm publishing.

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

`createWorkspaceExecutionPolicy()` still performs canonical workspace and working-directory validation, bounded hardlink/special-file scanning, Git pointer/commondir authorization, `config` and `config.worktree` validation, environment scrubbing, request bounding and private WeakSet provenance. Hardlinks use the shared two-pass `(device, inode)` accounting rule: all reported links must be observed inside the workspace under one writable/protected authority, while unaccounted, mixed-count or protected/writable aliases fail closed. This permits ordinary internal native-build output without granting an inode path outside the selected workspace.

The cancellation contract now records `guarantee: backend_reported`. Linux Bubblewrap still provides its stronger PID-namespace teardown behavior. Every spawned macOS receipt machine-readably reports `terminationGuarantee: best_effort`, `survivorsPossible: true`, `completeDescendantTermination: false` and `terminationScope: original_process_group`; the nested capability data repeats the survivor warning. A request cancelled before launch reports `survivorsPossible: false`. Neither backend's actual behavior is weakened or overstated.

### Seatbelt profile

The generated profile is deny-by-default and allows:

- fork, exec, same-sandbox signaling and only `process-info-pidinfo` for same-sandbox targets;
- read/write access to the exact canonical workspace;
- read/write access to one canonical, mode-0700 per-execution private directory;
- read-only `/System`, `/usr`, `/bin`, `/sbin`;
- exact Apple and Command Line Tools paths that exist on the host;
- exact system account/network database and certificate files needed by command-line runtimes;
- the exact active standalone Node runtime root for the standalone corpus, including only its discovered dynamic dependencies; or
- the exact active Electron application bundle for Electron-main qualification.

Profile generation filters both required and optional system-path candidates through the live filesystem before calling `stat`. Every required path that exists on macOS retains its previous read permission; absent macOS paths are simply omitted so platform-neutral profile-construction tests can run on Linux. Runtime capability detection still rejects every non-Darwin platform before launch.

Electron qualification adds no standalone-Node runtime root. Its child `PATH` is exactly `/usr/bin:/bin`; `/usr/local` receives an explicit read denial unless it is itself an authorized runtime root. The packaged corpus also attempts the canonical host Homebrew Node directly and confirms that it cannot start under the profile.

`.git`, configured protected paths and authorized external Git metadata receive explicit deny-write rules that take precedence over the writable workspace. The launcher fixes `GIT_OPTIONAL_LOCKS=0` and does not let the caller override it.

Networking is denied by the default posture and an explicit `deny network*`. Qualification covers localhost, an external address and DNS.

The previous blanket `(allow sysctl-read)` was removed from both the capability probe and execution profile. The qualified allowlist is exact-name-only; it contains no `sysctl-name-prefix`, `kern.proc.*`, `net.routetable.*` or `vm.loadavg` rule:

```text
hw.activecpu
hw.byteorder
hw.cacheconfig
hw.cachelinesize_compat
hw.cpufamily
hw.cputype
hw.l1dcachesize_compat
hw.l1icachesize_compat
hw.l2cachesize_compat
hw.l3cachesize_compat
hw.logicalcpu
hw.logicalcpu_max
hw.machine
hw.ncpu
hw.nperflevels
hw.optional.arm.FEAT_BF16
hw.optional.arm.FEAT_DotProd
hw.optional.arm.FEAT_FCMA
hw.optional.arm.FEAT_FHM
hw.optional.arm.FEAT_FP16
hw.optional.arm.FEAT_I8MM
hw.optional.arm.FEAT_JSCVT
hw.optional.arm.FEAT_LSE
hw.optional.arm.FEAT_RDM
hw.optional.arm.FEAT_SHA512
hw.optional.armv8_2_sha512
hw.packages
hw.pagesize
hw.pagesize_compat
hw.perflevel0.cpusperl2
hw.perflevel0.l1dcachesize
hw.perflevel0.l1icachesize
hw.perflevel0.l2cachesize
hw.perflevel0.logicalcpu
hw.perflevel0.logicalcpu_max
hw.perflevel0.name
hw.perflevel0.physicalcpu
hw.perflevel0.physicalcpu_max
hw.perflevel1.cpusperl2
hw.perflevel1.l1dcachesize
hw.perflevel1.l1icachesize
hw.perflevel1.l2cachesize
hw.perflevel1.logicalcpu
hw.perflevel1.logicalcpu_max
hw.perflevel1.name
hw.perflevel1.physicalcpu
hw.perflevel1.physicalcpu_max
hw.physicalcpu
hw.physicalcpu_max
hw.vectorunit
kern.argmax
kern.hostname
kern.maxfilesperproc
kern.osproductversion
kern.osrelease
kern.ostype
kern.osvariant_status
kern.osversion
kern.secure_kernel
kern.sysv.semmns
kern.tcsm_available
kern.tcsm_enable
kern.usrstack64
kern.version
sysctl.proc_cputype
```

This set was derived conservatively from the commit-pinned Codex and Chromium policies and then qualified against Freedom's Node, development Electron and packaged Electron workloads. Unlike the comparison policies, Freedom retained no broad ARM/performance, route-table or process-table prefix. A token-identified host-side Node sentinel was visible to the host `ps`; sandboxed `ps -p <sentinel> -o pid=,command=` returned exit 1, no stdout and the supervisor's exact `Operation not permitted` diagnostic without disclosing the token.

The profile allows global pathname metadata reads because dyld and common command-line runtimes probe parent directories before opening authorized files. It also allows read-data access to the literal root directory for runtime traversal. File contents outside allowed roots remain denied. Pathname existence and root directory entries are therefore residual disclosures.

### Private execution storage and environment

Every run creates a canonical mode-0700 directory with private `home`, `tmp`, `cache`, `config` and `data` children. `HOME`, `TMP*` and XDG variables point there. The directory is host-backed, not tmpfs or mount-namespace-private. Cleanup is best-effort and any failure is reported without suppressing the bounded receipt.

The child environment is built from the validated allowlist. Loader injection, language injection, credentials, host home/temp, display/session and Git authority variables remain scrubbed. Node spawns only stdin/stdout/stderr, so unrelated parent descriptors are not inherited.

### Launch, readiness and receipts

`/usr/bin/sandbox-exec` is invoked by absolute path with a generated profile file. The final trusted shell wrapper prints an unguessable marker after Seatbelt application and before executing the requested argv. If the marker is absent, the result is `sandbox_denied`; there is no unsandboxed retry. This marker proves profile application readiness, not the profile's filesystem or network denial semantics. Enforcement evidence comes from the qualified integration corpus.

Stdout and stderr are continuously drained and independently bounded. Receipts distinguish completed, failed, cancelled, timed-out and sandbox-denied states. All spawned receipts expose `terminationGuarantee: best_effort`, `sideEffects: unknown`, `survivorsPossible: true`, `completeDescendantTermination: false` and `terminationScope: original_process_group`. Sandbox denial and cancellation before launch expose `terminationGuarantee: not_applicable` and `sideEffects: none`.

The launcher starts `sandbox-exec` in a dedicated process group/session. Cancellation and timeout send `SIGTERM` to the original group, wait one second, send `SIGKILL`, then resolve within another bounded interval even if a detached descendant retains resources. Direct-child close no longer cancels cleanup: finalization first makes an additional best-effort group `SIGKILL` attempt, so an ordinary same-group background child cannot silently become untracked merely because the root exited. Non-`ESRCH` signal errors are retained in receipt diagnostics. PID/PGID reuse remains a small signaling race and is documented rather than hidden.

## Capability detection

The exact OS-build allowlist was removed. Runtime detection now checks:

- Darwin platform;
- `/usr/bin/sandbox-exec` exists as a regular file; and
- a harmless deny-default representative profile using the required profile operations successfully launches `/usr/bin/true`.

Architecture and kernel release are diagnostics, not allowlist keys. The probe and per-run marker establish profile application readiness. They do not synthetically retest denial semantics on every launch; those semantics are established by the qualification corpus. An unsupported profile or failed Seatbelt application still fails closed before the requested command is classified as started.

`sandbox-exec` remains deprecated and its profile language unsupported as a stable public interface. Capability probing reduces application failures, but qualified integration tests on each supported macOS/runtime layout remain necessary for enforcement confidence.

The `none` network posture denies loopback and in-sandbox Unix sockets on macOS; capability metadata reports `loopbackNetworking: denied`. Linux's private network namespace retains private loopback, so callers must not treat the two backends as behaviorally identical merely because neither can reach host or external networks.

Workspace contents remain hostile after execution. Trusted preview, publication, indexing, attachment, and VCS consumers must use bounded `lstat`-first traversal, reject symlinks and special files, and never execute workspace-controlled hooks. Seatbelt confinement of the producing command does not make later host-side traversal safe.

### Qualified toolchain scope

The standalone qualification supplies its canonical Node runtime root explicitly. A second development harness runs inside the actual Electron main process for Freedom `0.8.1-dev`, Electron `43.0.0`, embedded Node `24.17.0`, Chromium `150.0.7871.46`, with `app.isPackaged === false`. The same corpus now also runs from the unpacked packaged app with `app.isPackaged === true`:

- application: `/Users/flobot/Git/freedom-dev/freedom-browser/out/agent-sandbox-packaged/mac-arm64/Freedom.app`
- executable: `/Users/flobot/Git/freedom-dev/freedom-browser/out/agent-sandbox-packaged/mac-arm64/Freedom.app/Contents/MacOS/Freedom`
- entry: `Contents/Resources/app.asar/src/main/agent/workspace-execution/electron-qualification-main.js`
- packaged versions: Freedom `0.8.1-dev`, Electron `43.0.0`, embedded/helper Node `24.17.0`, Chromium `150.0.7871.46`

The Electron harness discovers and probes the active application executable, then uses Electron's `ELECTRON_RUN_AS_NODE=1` helper mode for JavaScript workloads. The only additional runtime authority is the exact active bundle for the current mode:

- `/Users/flobot/Git/freedom-dev/freedom-browser/node_modules/electron/dist/Electron.app` — read-only, required for the active Electron executable, frameworks and resources.
- `/Users/flobot/Git/freedom-dev/freedom-browser/out/agent-sandbox-packaged/mac-arm64/Freedom.app` — read-only, required for the packaged executable, frameworks, resources and `app.asar`.

The policy explicitly disables standalone-Node inference. It adds neither Homebrew nor a host Node root, uses only `/usr/bin:/bin` in `PATH`, explicitly denies `/usr/local`, and invokes the exact active Electron executable by canonical path. The packaged corpus directly attempts the launcher's `/opt/homebrew/Cellar/node@22/22.22.0/bin/node`; Seatbelt terminates it with `SIGABRT` rather than allowing a host-runtime fallback. The exact packaged app happens to live below the user's home on this throwaway checkout and is deliberately exposed read-only; no other home subtree is granted.

The shared runtime contract now records the canonical runtime root, canonical host executable, relative executable path, and backend sandbox executable path separately. On macOS those host and execution identities remain the same canonical path under the validated `.app`; Seatbelt permissions and fail-closed bundle validation are unchanged. The distinction exists so mount-based backends can derive a neutral execution path without asking product or model-facing code to guess one.

Read-only `@electron/fuses` inspection reported fuse wire v1 with `RunAsNode` enabled. The package therefore used its own `Freedom` executable successfully for every JavaScript workload. If that fuse is disabled in a future build, discovery fails with `ELECTRON_NODE_RUNTIME_UNAVAILABLE`; there is no broad-host fallback. Python remains layout-specific: `/usr/bin/python3` can delegate into paths under `/Applications/Xcode.app` on some Macs, which this profile does not currently grant.

Both the development and unsigned packaged Electron helpers write the same bounded `task_name_for_pid: (os/kern) failure (5)` code-signature diagnostic to stderr under Seatbelt. Their JavaScript workloads still complete and validate. The profile was not widened to grant task inspection.

The qualification-only Builder config inherits the real macOS packaging settings, overrides `main` to the harness, selects only the unpacked `dir` target, and sets `identity: null` plus `notarize: false`. The throwaway checkout does not contain the optional Ant, native IPFS, Myotis, Radicle or Arti payloads, so only those unrelated `extraResources` are omitted in the isolated config. The normal release configuration is unchanged. Electron Builder reported `skipped macOS code signing`; `codesign` identifies only the Electron binary's linker/ad-hoc signature, no Team ID, and strict deep verification fails as expected. No DMG, ZIP, signing identity, notarization or publication was used.

Exact commands:

- build: `npm run build:agent-sandbox:macos:packaged` (expands to `CSC_IDENTITY_AUTO_DISCOVERY=false electron-builder --mac --dir --config config/electron-builder.agent-sandbox-macos.js`)
- qualification: `npm run test:agent-sandbox:macos:packaged`
- fuse inspection: `node_modules/.bin/electron-fuses read --app /Users/flobot/Git/freedom-dev/freedom-browser/out/agent-sandbox-packaged/mac-arm64/Freedom.app`

The packaged launcher creates a fresh, canonical, mode-0700 direct child of the system temporary directory, requires it to be empty, sets it as Electron `userData` before `app.whenReady()`, and removes it after exit. It never resolves or opens an existing Freedom profile.

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

Packaged qualification additionally asserts `app.isPackaged`, `app.asar` entry loading, exact `Freedom.app` runtime selection, exact packaged-executable helper use, the single Electron runtime root, `/usr/bin:/bin` child `PATH`, forbidden host-Node denial and packaged user-data cleanup.

The separate Electron destructive command remains doubly gated. It records a token-bearing `setsid()` PID, demonstrates that the child survives group cancellation while file/network restrictions persist, and performs bounded token-checked cleanup in `finally`. The focused destructive Jest corpus also creates a separate process group using `/bin/sh` job control (`set -m`), proves its token-bearing child survives cancellation and continues its heartbeat, and always cleans the recorded PID with the same bounded ownership check. Freedom crash or quit cannot currently guarantee teardown of either kind of escaped descendant; this isolated backend intentionally adds no product-level quit manager.

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
- exact `.git/HEAD` hard-link denial, ordinary in-workspace hard-link behavior and case-folded Git-path denial;
- denial of host sentinel PID/argument enumeration;
- fresh HOME and temporary storage per execution;
- localhost, external-address and DNS denial;
- final group cleanup of redirected background descendants after normal root exit;
- cancellation cleanup of a same-group descendant that ignores `SIGTERM`;
- continuous output draining and truncation.

The repository qualification runs focused Jest, full lint, a Babel transform and shell/Python/Git checks inside Seatbelt with installed `node_modules` protected read-only. No network or dependency download is available inside the sandbox.

Recorded results on the qualified host:

- `npm ci`: completed from the existing lockfile; npm reported 21 dependency audit findings (7 low, 5 moderate, 9 high), unrelated to this dependency-free spike.
- `npm run test:agent-sandbox:macos`: 2 suites, 20 tests passed, including exact sysctl/profile checks, process visibility, APFS case folding, protected/ordinary hard links, normal-exit cleanup and cancellation/timeout same-group heartbeat regressions.
- Doubly gated `npm run test:agent-sandbox:macos:destructive`: 2 tests passed; both the `setsid()` and job-control PGID survivor PIDs were recorded, ownership checked and explicitly cleaned.
- `npm run test:agent-sandbox:macos:qualification`: capability probe, focused Jest, full lint, Babel and shell/Python/Git workloads all completed inside Seatbelt.
- `npm run test:agent-sandbox:macos:electron`: production-equivalent Electron-main website, boundary and lifecycle qualification passed.
- `npm run build:agent-sandbox:macos:packaged`: produced the unsigned unpacked arm64 `Freedom.app`; signing and notarization were explicitly skipped.
- `npm run test:agent-sandbox:macos:packaged`: packaged website, boundary and lifecycle corpus passed with `app.isPackaged === true`; cancellation escalated in 1,005 ms and the fresh Electron user-data directory was removed.
- Read-only `electron-fuses read`: fuse v1, `RunAsNode` enabled. The installed inspector prints one additional Electron 43 fuse as `undefined`; this does not affect the identified `RunAsNode` state.
- Doubly gated `npm run test:agent-sandbox:macos:electron:destructive`: detached `setsid()` child survived cancellation, remained confined, and was explicitly cleaned.
- Electron runtime/policy/backend-neutral focused contract: 5 suites and 33 tests passed.
- The policy race tests now compare canonical `/private/var/...` fixture paths on macOS rather than uncanonical `/var/...` aliases; the shared execution-policy suite passed as part of the 33 focused tests.
- Host `npm run lint`: passed.
- Full `npm test` outside the outer Codex sandbox: 213 suites and 3,834 tests passed; one Linux-only Bubblewrap unit suite had two pre-existing macOS expectation failures because it expects missing/setuid-binary denial codes before the backend's `UNSUPPORTED_PLATFORM` check. Eight suites and 31 tests skipped normally. The Linux execution behavior was not changed.

The later Linux stabilization rerun exercised the platform-neutral Seatbelt contract without making Seatbelt available on Linux. Profile construction omitted absent `/System` and other missing candidates, retained the expected rule for existing `/usr`, and the focused Seatbelt unit suite passed 8 tests. Receipt assertions continue to distinguish `backend: macos-seatbelt` with `best_effort` runnable semantics from pre-launch `not_applicable` denial semantics; no macOS enforcement rule was widened.

Launching the packaged GUI binary from inside Codex's outer host sandbox aborted in AppKit `_RegisterApplication` before JavaScript startup. The same command passed in the normal host context, as did the development Electron comparison. This was a qualification-runner environment restriction, not a Freedom Seatbelt receipt or a packaged policy failure.

The destructive/VM-only corpus requires both user-facing gates, `FREEDOM_SANDBOX_DESTRUCTIVE=1` and `FREEDOM_SANDBOX_VM_ONLY=1`; the npm scripts then set the internal `FREEDOM_REQUIRE_SEATBELT=1` capability requirement themselves. It validates a fresh canonical direct child of the system temporary directory with the fixed `freedom-seatbelt-destructive-` prefix. The test:

1. records the detached child's PID and unique ownership token;
2. calls `setsid()` in that child;
3. cancels the original process group;
4. proves the detached child remains alive;
5. proves it still cannot read an outside sibling canary or use localhost, external or DNS networking;
6. proves it can continue writing the authorized workspace;
7. verifies the outside sibling survives; and
8. explicitly cleans up with bounded `SIGTERM`/`SIGKILL`, rechecking the unique command token before every signal.

Audit-hardening evidence on the ordinary case-insensitive APFS workspace volume:

- `.git` and `.GIT` resolved to the same `(device, inode)` identity.
- Sandboxed append attempts against `.GIT/config` and `.GiT/config` returned exact `EPERM`, leaving Git metadata unchanged.
- Renaming the on-disk metadata directory to `.GIT` caused policy construction to fail closed with `PROTECTED_PATH_CASE_MISMATCH`; it can no longer be misclassified as writable by the hard-link scanner.
- `/bin/ln .git/HEAD protected-head-alias` returned exit 1 with `Operation not permitted`, and the destination remained absent. No extra `file-link` denial was necessary because the explicit protected `file-write*` rule already covers the operation on this qualified host.
- `/bin/ln source.txt ordinary-source-alias` returned exit 0; source and destination had the same `(device, inode)`. This is the intended writable-workspace behavior and remains subject to policy-time two-pass link accounting on later executions.

## Capability matrix

| Capability | Result | Notes |
| --- | ---: | --- |
| Seatbelt profile application readiness | yes | Representative launch probe plus per-launch marker; application failure is sandbox-denied. |
| Electron main-process invocation | yes | Freedom 0.8.1-dev under Electron 43.0.0 development and packaged bundles. |
| Electron JavaScript helper | yes, constrained | Active canonical executable in `ELECTRON_RUN_AS_NODE` mode; exact `.app` bundle read-only. |
| Arbitrary host JavaScript runtime fallback | denied | No standalone-Node root, `/usr/bin:/bin` only, `/usr/local` denied; canonical Homebrew Node launch rejected. |
| Unsigned unpacked packaged Freedom | yes | `app.isPackaged`, `app.asar`, packaged executable and fresh user data qualified; `RunAsNode` enabled. |
| Signed/notarized Freedom | **not yet** | Would add release-integrity, Gatekeeper, hardened-runtime and entitlement evidence, not stronger child Seatbelt or process-tree semantics. |
| Exact workspace read/write | yes | Canonical host path; no neutral mount path on macOS. |
| `.git` and authorized metadata read-only | yes | Explicit deny-write precedence; common and worktree config prevalidated. |
| Case-folded Git metadata | fail closed | `.GIT`/`.GiT` writes return `EPERM`; noncanonical on-disk casing is rejected during policy construction. |
| Protected Git hard-link creation | denied | `.git/HEAD` alias creation returns exit 1/`Operation not permitted`; ordinary workspace hard links remain available. |
| Host process enumeration | denied | Token-bearing sentinel PID/arguments are not returned to sandboxed `ps`. |
| Outside file contents denied | yes | Shell/Python/generated/symlink corpus passes. |
| Network/DNS/localhost denied | yes | Explicit ordinary and detached-descendant coverage. |
| Descendant policy inheritance | yes | Demonstrated by detached-child adversarial test. |
| Per-execution private host storage | yes | Unique mode-0700 host-backed directory, cleaned best-effort. |
| Closed unrelated descriptors | yes | Node spawn exposes only configured standard streams. |
| Bounded output | yes | Streams remain drained after visible caps. |
| Wall timeout | yes | Same best-effort process-group semantics as cancellation. |
| Ordinary process-group cleanup | yes | TERM/grace/KILL for cancellation; final KILL attempt before every spawned receipt. |
| Complete descendant termination | **no** | `setsid()` and job-control PGID escapes are expected, explicitly qualified and recorded on every spawned receipt. |
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
- [Chromium common macOS policy at Codex's pinned comparison revision](https://chromium.googlesource.com/chromium/src/+/7b3962fe2e5fc9e2ee58000dc8fbf3429d84d3bd/sandbox/policy/mac/common.sb)
- [Chromium renderer macOS policy at the same revision](https://chromium.googlesource.com/chromium/src/+/7b3962fe2e5fc9e2ee58000dc8fbf3429d84d3bd/sandbox/policy/mac/renderer.sb)

The concepts adapted are deny-default Seatbelt confinement, same-sandbox process operations, protected Git metadata, dedicated process groups, best-effort cleanup and an explicit detached-child test. Freedom's JavaScript implementation, policy model, receipts, profile construction and tests were written independently. No Codex source was copied.

## Residual risks and blockers before product exposure

1. A hostile `setsid()` descendant or job-control-created process group can outlive cancellation and continue modifying the authorized workspace. Freedom crash/quit likewise cannot guarantee descendant teardown.
2. A bounded negative-PGID signal sequence has a small process-group reuse race.
3. There is no aggregate memory, CPU, PID-count or disk containment.
4. Host-backed private storage can consume host disk; cleanup can fail.
5. Canonical workspace/runtime/temp paths, pathname metadata and root directory entries are visible.
6. The unsigned unpacked package is qualified, but a signed/notarized Freedom bundle is not. Signing can still change launch, entitlement, hardened-runtime and task-inspection behavior even though it does not strengthen this child Seatbelt boundary.
7. Python resolution is host-layout-specific; system Python may delegate into ungranted Xcode application paths.
8. Broad read-only Apple system paths remain part of the trusted runtime surface; the qualified workloads require no explicit Mach-service grants.
9. The capability probe proves profile application readiness, while enforcement confidence depends on the qualified integration corpus for each supported host layout.
10. `sandbox-exec` and SBPL are deprecated/private interfaces and can change between macOS releases.
11. This is not protection against a Seatbelt or kernel escape.

## Recommendation

**Proceed with constraints.** The filesystem/network boundary, packaged Electron runtime path and explicit best-effort lifecycle model are sufficiently qualified to begin narrow managed-workspace product integration behind an experimental gate. Keep command authority in trusted main-process code and retain opaque managed workspace identities.

Before wider or release-facing exposure, rerun a smoke/corpus from the real signed/notarized artifact to cover its code-signing, Gatekeeper, hardened-runtime and entitlement behavior. That run would add distribution-integrity evidence but would not provide a stronger filesystem/network boundary or complete descendant teardown. Product/security decisions must still cover aggregate resource containment, detached-process policy, supported macOS/runtime layouts and same-UID workspace lifecycle races. Do not represent process-group cleanup as a security boundary.
