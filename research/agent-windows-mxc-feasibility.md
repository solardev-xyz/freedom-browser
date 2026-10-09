# Windows Agent: MXC feasibility

Date: 2026-10-09; updated 2026-10-10
Branch: `experiment/agent-windows-mxc`
Product baseline: `b97afeb3` (`feature/freedom-automation-kernel`)

## Result

MXC is not yet qualified as Freedom's Windows workspace executor. Its preferred
BaseContainer backend is available on the test machine, and basic filesystem
restrictions work. The user's interactive-desktop follow-up successfully ran
Node with `ui.disable: false`, while `true` still caused native initialization
failure. SSH runs failed with either value. The host also lacks the capability
for explicit host-loopback ingress. Adding a read-only volume-root grant lets
Node/npm run, but also permits reads of ungranted synthetic files. That candidate
policy is rejected. Filesystem confidentiality, UI qualification and preview
connectivity remain separate gates.

No Freedom runtime code or dependencies changed. Windows workspace execution
continues to fail closed. No host-preparation script, ACL modification, elevated
execution, audit/allow mode, or OS update was performed.

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

## Upstream references

- [MXC Node SDK](https://github.com/microsoft/mxc/blob/main/sdk/node/README.md)
- [OS policy support](https://github.com/microsoft/mxc/blob/main/docs/backends/process-container/os-version-support.md)
- [Schema and fallback policy](https://github.com/microsoft/mxc/blob/main/docs/schema.md)
- [v1.0.0 Win32k mapping](https://github.com/microsoft/mxc/blob/v1.0.0/src/mxc-sdk/src/backends/process_container/common/base_container_helpers.rs)
- [v1.0.0 independent UI restrictions](https://github.com/microsoft/mxc/blob/v1.0.0/src/mxc-sdk/src/core/mxc_common/ui_policy.rs)

These moving references explain the design; the results above are specifically
for the published npm SDK 1.0.0. No upstream issue was filed during this spike.
