# Windows Agent: MXC feasibility

Date: 2026-10-09; updated 2026-10-10
Branch: `experiment/agent-windows-mxc`
Product baseline: `b97afeb3` (`feature/freedom-automation-kernel`)

## Result

**Policy decision, 2026-10-10:** the user accepts Codex-style broad reads on
Windows, with narrow writes and controlled networking. The project-only read
requirement used in the initial spike below is superseded. This does not grant
unrestricted writes or networking. The next reference is Codex's native MXC
backend where compatible, with its elevated restricted-token sandbox as the
preferred fallback. A separate AppContainer design, VM migration and MXC fork
are not selected.

MXC is not yet qualified as Freedom's Windows workspace executor. Its preferred
BaseContainer backend is available on the test machine, and basic filesystem
restrictions work. The user's interactive-desktop follow-up successfully ran
Node with `ui.disable: false`, while `true` still caused native initialization
failure. SSH runs failed with either value. The host also lacks the capability
for explicit host-loopback ingress. Adding a read-only volume-root grant lets
Node/npm run, but also permits reads of ungranted synthetic files. That candidate
policy was rejected under the earlier project-only read requirement. Broader
reads are now accepted, while write containment, UI qualification and preview
connectivity remain gates.

The initial spike made no Freedom runtime/dependency changes or host ACL changes.
The experimental implementation described below now adds a Windows executor;
it refuses execution until its separate administrator setup is complete.
The later Codex unelevated comparison uses Codex's scoped ACL setup in synthetic
workspaces. The user completed elevated provisioning, and that backend passed
the full reference suite in the standard user's desktop session. No OS update
was needed. The elevated backend is now the first implementation target; MXC
remains an optional path pending preview and process-lifetime qualification.

## Freedom integration and qualification — 2026-10-10

The experimental branch now implements `windows-elevated` behind the existing
workspace executor interface. A small native adapter reuses only the upstream
sandbox library and setup/runner helpers, pinned to Codex 0.162.1 source commit
`092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`. It does not run the Codex agent CLI.
Build inputs and helper binaries are hash checked. Freedom uses separate account,
firewall and setup-state names so it does not rotate Codex's credentials.

The backend supports explicit read-only and writable project policies, protected
Git metadata, private temporary storage, network-none/full, bounded output,
streaming stdin/stdout and cancellation. The approval UI discloses broad reads
and the one-time administrator setup. No automatic weaker fallback is enabled.
PowerShell is the Windows command shell. Cancellation receipts remain
conservative: a launch attempt does not certify that no side effects occurred,
or that every descendant has stopped.

Implementation checks: the native x64 build uses the pinned upstream lockfile
and emits `CODEX-LICENSE.txt`, `CODEX-NOTICE.txt` and a 524-package dependency
inventory/full notice text. Package tests validate binary hashes, PE architecture,
adapter source and archive contents. The native build cache is explicitly
excluded from app.asar on every platform.

Freedom's separate administrator provisioning completed successfully. Actual
Freedom qualification as the standard Windows user:

- Executor (`0af5d977`): read/write scope, `.git` protection, read-only after a
  previous writer, Node/npm build, direct network none/full, host localhost
  preview, server cancellation, abrupt owning-JS-process exit, junction write
  denial and unchanged outside/Git sentinels all pass.
- Electron controller (`589795b8`, `controller-mSUyEF`): normal/max-64-KiB files,
  long Unicode PowerShell scripts, npm build, reviewed checkpoint/history,
  localhost preview, stdin/Stop, external read-only and first approved write
  all pass. Windows DACL changes no longer invalidate unchanged file versions.
- Real app startup and scoped helper writes pass. A wider parallel external
  helper smoke failed once with a missing nested file; the focused rerun passed.
  Five additional consecutive external-helper runs passed. The initial
  intermittent failure remains recorded; no unsupported root-cause claim is made.
- macOS at integration: lint, **9,483 unit tests** (129 skipped), and all **110
  Agent/settings Electron tests** pass. The latter closed earlier PR failures,
  including an obscured takeover confirmation and outdated model-picker/history
  fixtures. Windows setup cancellation/retry is covered by controller tests;
  the physical administrator setup succeeded, but a real UAC cancellation was
  not injected.

Tests use synthetic fixtures and the standard-user desktop task over SSH,
without switching the visible administrator RDP session or using real model
credentials. These are Freedom implementation tests, not just Codex reference
results. Cancellation receipts remain best-effort, with possible survivors.

Packaged qualification (production code at `d490313f`, identical source tree
at merge `26848b0d`): `npm run dist -- --win --x64` succeeded. The unpacked tree,
extracted 281-MB ZIP and NSIS-installed application each passed **16/16 packaged
checks** and the full controller qualification as `freedomdev`. Checks include
fuses, SQLite history worker, persistence, site permissions, native helper hashes
and 524-package dependency notices. The fixed app.asar is 258 MB, contains only
`src`, `node_modules` and `package.json`, and all 543 packaged source files matched
the checkout. No RDP account switch was required. This local artifact does not
bundle Tor; normal release CI builds Tor separately.

The Windows CI workflow independently rebuilds and tests the native executor,
Electron controller and helper edits on a disposable hosted runner. Check PR #457
for current-head results. Its first native executor run passed; the controller's initial
11-second preview wait was shorter than observed cold PowerShell startup, so
it now has a bounded 45-second readiness wait and records the final process
receipt. The package uses the project's existing unsigned Windows distribution
policy. No Windows signing certificate is required for this feature merge.

Deferred extensions: Windows ARM64, cross-host helper staging and MXC. The
current build requires a Windows host with MSVC/Rust. MXC requires preview and
process-lifetime qualification before becoming an explicit alternative; it must
never silently replace the selected backend.

## Environment and sync

- Physical Windows 11 x64 machine, 25H2, build `26200.9457`.
- Standard user over OpenSSH; PowerShell 7.6.6; Git 2.55.0.windows.5.
- GitHub is the source of code synchronization. Both feature and experiment
  branches were pushed; Windows fetched and checked out the experiment at the
  same baseline. A previously copied Git bundle was not imported.
- Portable Node 24.21.0 / npm 11.19.0 installed in
  `C:\freedom-test\toolchains\node-v24.21.0-win-x64`. The official ZIP's SHA256
  matched Node's published checksums. System Node 24.18.1 was left unchanged.
- `npm ci --no-audit --no-fund` and `npm run lint` passed in the Windows checkout.
- Electron 44.7.0 starts in Node mode with Node 24.21.0. An in-memory SQLite
  query passed under both portable Node and Electron. No graphical Freedom
  startup or full Windows unit/E2E suite was run.
- `@microsoft/mxc-sdk@1.0.0` installed only in `C:\freedom-test\mxc-oct9`, with
  a scratch package-lock. It is not a Freedom dependency.

## Codex reference qualification — 2026-10-10

Reviewed local Codex source at `c9fecd3fa06af28011166207c596ad547e37abab` and
current upstream at `4aa94dce270de668eff6e2fa8585c82385e84455`. The source-level
`prefer_mxc` flag defaults off, but current product documentation says the desktop
app prefers MXC for eligible consumer devices. The preferred legacy fallback is
`elevated`: administrator-approved provisioning creates restricted accounts and
network rules; workload commands do not run as administrator. `unelevated` has
weaker network enforcement and is a comparison target, not the selected fallback.

Downloaded the official Codex `0.162.1` Windows x64 standalone package into
`C:\freedom-test\codex-oct10\package`, without global installation or Freedom
dependency changes. The archive SHA256 matched GitHub release metadata:
`3e993a82ff393f4530558dcaadb36bb4f0fd1ea7243e621348e40b469f900f6a`.
The scratch Codex home is `C:\freedom-test\codex-oct10\home`. No model request
or OpenAI authentication is involved in sandbox CLI probes.

Initial SSH probes: MXC `cmd.exe` echo succeeds; Node returns `0xC0000142` in
both MXC and unelevated mode, including unelevated with private desktop disabled.
Both backends run Node successfully in the test user's existing desktop session.
The failure is therefore not unique to MXC or a general Node incompatibility;
its exact SSH/session initialization cause remains unproven.

The desktop comparison ran through the on-demand scheduled task
`Freedom-Codex-Reference-Oct10`, with `InteractiveToken` and `LeastPrivilege` for
the standard test user. It has no automatic trigger. Task Scheduler's CLI worked
over SSH after the PowerShell CIM API denied access. Scripts and logs reside in
`C:\freedom-test\codex-oct10`; the task runs the GitHub-synchronized suite.

| Desktop check | Codex MXC | Codex unelevated | Codex elevated |
| --- | --- | --- | --- |
| Workspace write and broad outside read | Passed | Passed | Passed |
| Outside write blocked, sentinel unchanged | Passed | Passed | Passed |
| `.git` write blocked, sentinel unchanged | Passed | Passed | Passed |
| Write through host-created junction blocked | Passed | Passed | Passed |
| Node 24.21 startup | Passed | Passed | Passed |
| Synthetic npm build with Node child process | Passed | Passed | Passed |
| Direct TCP denied with networking disabled | Passed (`EACCES`) | **Failed: socket connected** | Passed (`EACCES`) |
| Direct TCP allowed with networking enabled | Passed | Passed | Passed |
| Host HTTP connection to localhost preview | **Failed: server starts but is unreachable** | Passed | Passed |
| Abrupt launcher exit | **Failed independent heartbeat/deadline check** | Passed heartbeat and HTTP checks | Passed heartbeat and HTTP checks |

The **elevated** backend passes the complete reference suite and is the first
Freedom implementation target. MXC's write/network enforcement works for these
cases, but the preview transport remains blocked on this host. The synthetic
npm build does not establish third-party dependency-install or full Next.js
compatibility, and the reference CLI is not yet a Freedom runtime adapter.

Elevated run: `desktop-runs\elevated-aoLBPh`, Codex 0.162.1, Node 24.21.0,
suite code `c283de31` (checkout `039321b9`), Task Scheduler exit `0`.
`desktop-elevated.log` and the run's `results.jsonl` retain every result. Both
synthetic outside and `.git` sentinels remained unchanged. The direct socket
control succeeded before the denied-network probe, and the preview returned
the expected response before launcher termination. No elevated command prompt
was used for the suite; only the prior provisioning required administrator
credentials. No model requests were made.

Initial desktop artifacts: `desktop-runs\mxc-EjP94C` and
`desktop-runs\unelevated-GlnDV8`. The first SSH run's junction assertion was too
narrow: Windows reported an untrusted mount point instead of ordinary access
denial. The updated harness recognizes both explicit denials. Its independent
heartbeat shutdown check avoids treating failed HTTP preview access as evidence
that cancellation failed or succeeded, and rejects observations after the server
watchdog could have fired.

The corrected suite was rerun in the desktop session at `c283de31`. MXC still
failed preview access and did not pass the independent abrupt-launcher-exit check;
unelevated passed preview and shutdown but still failed network denial. This is
an abrupt parent-exit test of the CLI process tree, not evidence that Codex's
normal interactive Stop/Ctrl+C is broken. A Freedom integration needs explicit
supervisor ownership and its own graceful/forced cancellation tests; do not
equate killing the outer CLI with terminating every sandbox descendant.

The reusable reference suite is `scripts/qualify-codex-windows-sandbox.js`.
It retains unique synthetic workspaces and JSONL results, tests broad reads,
narrow writes (including `.git` and a host-created junction), npm build execution,
raw outbound sockets with denied/allowed network profiles, HTTP preview access,
and abrupt launcher termination. It does not qualify graceful Ctrl+C, detached
server ownership, hostile process escape, packaged Freedom, or dependency
installation. Network checks require a successful unsandboxed control probe;
otherwise they fail rather than claim isolation. Servers have a 15-second
watchdog. No synthetic files are automatically deleted.

Run from a normal PowerShell as the test user, using the GitHub-synchronized
checkout (replace `mxc` with `elevated` only after setup):

```powershell
& C:\freedom-test\toolchains\node-v24.21.0-win-x64\node.exe `
  C:\dev\freedom-browser\scripts\qualify-codex-windows-sandbox.js `
  --codex C:\freedom-test\codex-oct10\package\bin\codex.exe `
  --home C:\freedom-test\codex-oct10\home `
  --root C:\freedom-test\codex-oct10\runs --backend mxc
```

The administrator setup command, prepared as
`C:\freedom-test\codex-oct10\setup-elevated.ps1`, invokes official
`codex sandbox setup --elevated --user <standard-test-user> --codex-home <scratch-home>`.
It requires an Administrator PowerShell because SSH uses a standard account.
It creates machine-wide sandbox accounts/rules even though configuration is in
scratch; it is not a portable/no-host-change installation. The user completed it
successfully from the administrator account and returned to the standard-user
desktop. The test account's enabled `CodexSandboxOffline`/`CodexSandboxOnline`
accounts were observed, and the subsequent elevated suite completed successfully.

Sources: [Codex release](https://github.com/openai/codex/releases/tag/rust-v0.162.1),
[MXC adapter](https://github.com/openai/codex/blob/4aa94dce270de668eff6e2fa8585c82385e84455/codex-rs/mxc-sandbox/README.md),
[Windows sandbox modes](https://learn.chatgpt.com/docs/windows/windows-sandbox).

### Integration direction after elevated qualification

- Keep Pi and Freedom's permission/controller layer. Reuse/adapt the native
  execution pieces; do not launch another model agent or depend on a user's
  personal Codex configuration/authentication.
- Place a Windows adapter beside the existing Seatbelt/Bubblewrap executors.
  Match their process events, bounded output, timeouts, cancellation and preview
  lifecycle; do not mark Windows supported merely because a one-shot CLI works.
- If extracting the elevated helper, give Freedom its own identities, setup
  state and firewall rules so installation/uninstallation cannot interfere with
  a separately installed Codex. Review pinned upstream licensing/dependencies
  before introducing any production package.
- Select MXC only when its actual request capabilities and workload checks pass;
  otherwise use a qualified elevated backend. Never retry a failed workload
  automatically under weaker permissions.
- Preserve explicit write boundaries, read-only external project behavior and
  `.git` protection. Document that Windows command execution permits broad reads;
  this decision does not relax macOS/Linux read isolation.

## Native capability report

The published SDK reports `base-container`, `needsDaclAugmentation: false`, and
no warnings. Denied filesystem paths and native denial capture are supported.
Enumerate-only paths, host-loopback ingress allowance, and IsolationSession are
not supported. The advertised Hyperlight backend was not tested.

A capability report is a prerequisite, not evidence that a workload runs.
Request-specific probing rejected `network.ingress.hostLoopback: 'allow'`:

> host-loopback ingress requires native ProcessContainer support

Freedom must not silently substitute broad network access for this missing
permission. A future preview design needs a separately qualified route.

## Executed checks

The following checks ran over SSH, before the desktop comparison below:

| Check | Observed result |
| --- | --- |
| Contained `cmd.exe /d /c echo mxc-ok` | Exit 0, expected output |
| Write and read scratch workspace file | Passed |
| Read/write sibling outside workspace | Both denied; sentinel unchanged |
| Read/write explicitly denied workspace `.git` | Both denied; sentinel unchanged |
| Portable Node 24.21.0 `--version` | Exit `-1073741502` (`0xC0000142`), no output |
| System Node 24.18.1 `--version` | Same failure |
| Node launched through contained `cmd.exe` | Same failure |
| Windows PowerShell 5.1 harmless output command | Same failure |
| Node without an explicit UI policy | Same failure |
| Node with explicit Windows/runtime read grants and a read-only root grant | Same failure |
| Native capture with `mode: 'block'` | Same failure; zero recorded denials |
| Explicit localhost preview ingress policy | Rejected by request-specific probe |

The file checks used only synthetic sentinels. They do not establish resistance
to reparse points, hardlinks, handle inheritance, process escape, or other
adversarial cases. Network isolation, cancellation, descendant cleanup,
concurrency, npm/build workloads, and preview serving remain unqualified.

`0xC0000142` indicates DLL initialization failed. No root cause is established.
The zero-denial report does not prove that policy played no part. Omission of UI
policy and the extra read grants did not resolve it. One attempted clipboard
variant used an invalid enum and was rejected at validation; it provides no
runtime evidence. An explicit minimal environment initially omitted
`LOCALAPPDATA`; correcting that validation error did not resolve startup.

## Reproduction artifacts

The Windows scratch directory contains `probe.mjs`, `basic.mjs`,
`launch-matrix.mjs`, `launch-diagnostics.mjs`, `capability-check.mjs`, and
`launch-ui.mjs`, with corresponding `.log` files. `denials.*.json` records the
native capture, including its verbose companion. These are diagnostic artifacts,
not production adapters or a reusable qualification suite.

To repeat the harmless launch matrix from an interactive Windows terminal as
the same standard user:

```powershell
$env:PATH = 'C:\freedom-test\toolchains\node-v24.21.0-win-x64;' + $env:PATH
Set-Location C:\freedom-test\mxc-oct9
node launch-matrix.mjs
```

### Interactive desktop follow-up

The user ran that exact matrix in PowerShell 7.6.6 on the Windows desktop:

| Program | `ui.disable` | Result |
| --- | --- | --- |
| cmd | false | Exit 0, `mxc-ok` |
| cmd | true | Exit 0, `mxc-ok` |
| Node 24.21.0 | false | Exit 0, `v24.21.0` |
| Node 24.21.0 | true | Exit `0xC0000142`, no output |

All four request probes selected BaseContainer. This rules out the broader
claim that Node cannot run in MXC on this OS. It demonstrates a UI-policy
dependency on the desktop and a separate session-dependent difference; the
underlying SSH failure remains unexplained.

The published v1.0.0 source maps `ui.disable` directly to
`disallow_win32k_system_calls`. This is stronger than hiding windows: it blocks
the Win32k system-call interface. The failure is consistent with a runtime DLL
requiring that interface during initialization, but the responsible DLL has not
been identified. Omitting UI policy also defaults to this lockdown.

Setting `ui.disable: false` leaves the narrower clipboard, input injection,
external UI object, atom namespace, desktop control, and system-setting
restrictions independently configurable. It does not turn off filesystem or
network containment. It does permit GUI capability within the remaining limits,
so it is a candidate policy requiring qualification, not an equivalent no-UI
guarantee or a production fix.

The scratch `desktop-workload.mjs` follow-up explicitly retains those narrower
restrictions, offline policy, workspace-only writes, protected `.git`, and a
minimal environment. It checks request-specific BaseContainer support without
ACL augmentation, then attempts JavaScript file checks, npm `--version`, and a
two-second timeout of an idle Node process. It saves results to a fresh
`desktop-workload-*\results.jsonl` and modifies only synthetic scratch files.
The user's desktop run reached Node's JavaScript module loader but all three
workloads exited 1 with `EPERM: lstat 'C:\\'` during `realpathSync`. Neither the
file-check script nor npm nor the idle script executed. Unchanged sentinels
therefore do not establish confinement for this policy, and timeout behavior
was not exercised.

### Read-only root grant: rejected after confidentiality check

The follow-up added the working volume root to `readonlyPaths` and reported
`lstat` results for the known workspace/runtime ancestors. The user observed:

| Check | Desktop result with root read grant |
| --- | --- |
| Metadata for workspace/runtime ancestors | All accessible |
| JavaScript workspace write/read | Passed |
| Ungranted outside sentinel read | **Allowed: confidentiality check failed** |
| Ungranted outside sentinel write | Denied, `EPERM` |
| Explicitly denied `.git` read/write | Both denied, `EPERM` |
| npm `--version` | Exit 0, `11.19.0` |
| Idle Node two-second timeout | Printed `started`, `timedOut: true`, exit -1 |
| Sentinels unchanged | True; does not negate the unauthorized read |

An independent SSH reproduction (`root-grant-check.mjs` and its `.log`) uses
contained `cmd.exe` and two synthetic files: a workspace sibling and a file in
a separate directory under `C:\freedom-test`. With otherwise identical policies,
neither file is readable without the root grant; both become readable after
adding `C:\` to `readonlyPaths`. This removes Node and the interactive session
as necessary causes of the read exposure. It does not establish access to all
host files: only these synthetic files were tested, and no personal files were
read. No host ACL changes were used.

**Correction:** the previous report called this a non-recursive metadata grant.
That assurance was unsupported. The v1.0.0 schema's root exception specifically
describes `readwritePaths`; it cannot establish safe `readonlyPaths` behavior.
Observed results take precedence over that earlier interpretation. Do not adopt
this root read grant in Freedom or paper over it with a snapshot denylist of
currently existing host files. The scratch fixture remains a rejected-policy
reproducer, not a candidate production configuration.

The upstream [root/ancestor issue](https://github.com/microsoft/mxc/issues/1109)
contains a matching npm error. Enumeration-only grants, the relevant narrower
primitive, are unavailable on this host. A supported way to resolve script paths
while keeping ungranted content unreadable is still required. npm startup and
single-process timeout passed only under the rejected filesystem policy;
builds, process-tree cancellation and UI isolation remain unqualified.

## Next gates

1. Resolve the filesystem blocker before integrating this backend: qualify a
   metadata/enumeration-only primitive on a supported OS, or evaluate a different
   containment design. Retain the paired allowed-workspace/denied-outside checks.
   Preserve the published SDK and OS baseline for the existing reproduction;
   investigate SSH-session startup and the narrower UI policy separately.
2. Establish a supported localhost-preview route, or identify the specific OS
   capability/update required. Do not assume a newer SDK provides an absent OS
   feature. Published SDK 1.0.0 and GitHub main already differ.
3. Only after real Node/npm workloads run, build a Windows backend behind the
   existing workspace execution interface. Require request-aware capability
   checks and explicit prevention of an ACL-mutating fallback.
4. Qualify filesystem escapes, offline/network grants, cancellation and process
   trees, previews, external read-only projects, Electron and packaged installs
   on a disposable Windows environment before changing product support claims.

## OS requirements and alternatives — 2026-10-10

Reviewed upstream MXC at `c6f301d53a1430c4c921a05c57af838f7392348f`.
This is research against newer source, not a change to the installed 1.0.0 SDK.

### Immediate recommendation: update, then probe before executing

The host is still Windows 11 Pro 25H2 `26200.9457`. Microsoft's optional
[KB5124010](https://support.microsoft.com/en-us/servicing/os/windows-11/2026/09/kb5124010-windows-11-24h2-25h2-update)
was published September 22 and updates 25H2 to `26200.9550`. It is a non-security
preview cumulative update, not an Insider enrollment. MXC's
[current support table](https://github.com/microsoft/mxc/blob/c6f301d53a1430c4c921a05c57af838f7392348f/docs/backends/process-container/os-version-support.md)
names `.9278` for Process Isolation and `.9550` for Session Isolation.
That table does **not** guarantee `fs_enumerate` or host-loopback ingress at
either version. Do not infer those capabilities from general backend support.
An OS update is a useful controlled comparison, not a verified fix.

The new scratch `capability-gates.mjs` performs only platform and request probes;
it does not launch workloads or grant root read access. Its baseline log
`capability-gates-before-update.log` confirms both exact requests are rejected:

- `processContainer.filesystem.enumeratePaths`: unsupported by this Windows
  version; metadata-only access requires native support.
- `network.ingress.hostLoopback: 'allow'`: unsupported by this Windows version.

After an approved OS update and restart, re-run this probe over SSH. If the
filesystem request becomes supported, replace the rejected root read grant with
enumeration-only ancestors and repeat the positive and negative file tests in
the desktop session. Require actual preview connectivity testing separately:
even upstream's newer identity-less proxy support records an unresolved
host-to-container listener failure under its proxy mapping. Discovery success
alone cannot qualify preview serving.

No update, feature enablement or reboot was performed. Attempting a read-only
Windows Update COM query over SSH failed with `E_ACCESSDENIED`, so whether the
update is offered to this particular device must be checked in Windows Settings.

### Alternatives and their costs

| Route | Assessment for Freedom |
| --- | --- |
| Native BaseContainer with metadata-only grants | Preferred if actual host support and confinement tests pass. Closest fit to Windows tools and the existing host project model. Current OS rejects the necessary grant. |
| AppContainer / DACL fallback | Not a drop-in solution to the current policy: introduces host ACL management; explicit host-loopback allowance and directional rules have native-support requirements. Needs its own design and qualification, not automatic fallback. |
| Ordinary WSL distribution | Not a security sandbox by itself. Merely disabling drive automount and Windows interop does not establish isolation. A Linux sandbox inside it would require explicit qualification of WSL-specific host interfaces as well as the existing Linux tests. WSL is not installed on this machine. |
| MXC WSLC | Separate SDK/runtime packaging; requires WSL 2.9.9+. Network policy is isolated or unrestricted bridged, not independent directions. Cannot exclude `.git` inside a writable mount. Host port mapping currently requires raw development contract `1.1.0-alpha`, outside the typed 1.0.0 API. Not a direct reuse of our workspace policy. |
| MXC Windows Sandbox | Genuine Windows VM boundary, but current backend is experimental, fixes guest external networking off, cannot exclude nested paths within a writable share, and admits one execution at a time per VM. Does not supply our dependency-install/managed-preview flow unchanged. Windows Sandbox also excludes Windows Home. |
| Separately managed VM with a narrow guest bridge | A viable design to investigate if native support remains unsuitable, not implemented or qualified. Needs runtime image distribution, lifecycle/recovery, file transfer or scoped mounts, network authority, preview forwarding and cleanup. A Linux guest could reuse parts of our Linux executor but would run Linux tools; a Windows guest preserves native tools with greater packaging/licensing work. |

Microsoft's [WSL security model](https://github.com/microsoft/WSL/blob/master/doc/docs/technical-documentation/security.md)
explicitly distinguishes distro settings from security boundaries. Do not replace
the failed MXC policy with an ordinary `wsl.exe` execution path and call it safe.
The [WSLC policy table](https://github.com/microsoft/mxc/blob/c6f301d53a1430c4c921a05c57af838f7392348f/docs/backends/wslc/wslc-state-aware.md)
and [Windows Sandbox backend](https://github.com/microsoft/mxc/blob/c6f301d53a1430c4c921a05c57af838f7392348f/docs/backends/windows-sandbox/windows-sandbox.md)
describe the adapter limitations above. Microsoft documents Windows Sandbox's
[supported editions](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/).

If the OS update leaves the missing primitives unavailable, the next decision is
between a separately qualified native containment implementation and a managed
VM design. That is an architectural/product choice (native tools, installation
size and setup requirements), not another permission workaround. No additional
runtime dependency or fallback backend is selected by this research.

## Upstream references

- [MXC Node SDK](https://github.com/microsoft/mxc/blob/main/sdk/node/README.md)
- [OS policy support](https://github.com/microsoft/mxc/blob/main/docs/backends/process-container/os-version-support.md)
- [Schema and fallback policy](https://github.com/microsoft/mxc/blob/main/docs/schema.md)
- [v1.0.0 Win32k mapping](https://github.com/microsoft/mxc/blob/v1.0.0/src/mxc-sdk/src/backends/process_container/common/base_container_helpers.rs)
- [v1.0.0 independent UI restrictions](https://github.com/microsoft/mxc/blob/v1.0.0/src/mxc-sdk/src/core/mxc_common/ui_policy.rs)

These moving references explain the design; the results above are specifically
for the published npm SDK 1.0.0. No upstream issue was filed during this spike.
