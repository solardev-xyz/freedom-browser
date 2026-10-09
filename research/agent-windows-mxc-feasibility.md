# Windows Agent: MXC feasibility

Date: 2026-10-09
Branch: `experiment/agent-windows-mxc`
Product baseline: `b97afeb3` (`feature/freedom-automation-kernel`)

## Result

MXC is not yet qualified as Freedom's Windows workspace executor. Its preferred
BaseContainer backend is available on the test machine, and basic filesystem
restrictions work. Node and Windows PowerShell fail during native initialization;
the host also lacks the capability for explicit host-loopback ingress. These are
separate blockers, not a successful end-to-end Windows Agent qualification.

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
| Node with explicit Windows/runtime read grants and root metadata access | Same failure |
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

This comparison has not been run yet. It distinguishes an SSH-session-specific
failure from one also reproducible on the interactive desktop; it does not
diagnose the native failure by itself.

## Next gates

1. Compare the same launch matrix in an interactive desktop session. Preserve
   the exact published SDK and OS baseline; investigate native initialization
   with upstream before changing containment policy.
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

These moving references explain the design; the results above are specifically
for the published npm SDK 1.0.0. No upstream issue was filed during this spike.
