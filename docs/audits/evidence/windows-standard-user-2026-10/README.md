# Windows standard-user validation evidence (#779)

Write-up: [`../../windows-standard-user-validation-2026-10.md`](../../windows-standard-user-validation-2026-10.md).

Recorded on 2026-10-23 on a disposable clone of the `freedom-e2e-win11` VM. The
build is `main` at `42158f97d`
([run 39966495939](https://github.com/solardev-xyz/freedom-browser/actions/runs/39966495939)).
It was installed per-user as `freedomstd`, a member of `Users` only. The machine
names in the logs (`FREEDOM-E2E-WIN`, `tester`, `freedomstd`) belong to that
throwaway VM.

## Harness

The scripts assume the VM layout: a checkout of the same commit at `C:\e2e\repo`
and the scripts in `C:\e2e\std`. The host reached the VM over SSH as the
administrator, as `scripts/nightly-vm-e2e/` does.

| File | Runs as | What it does |
| --- | --- | --- |
| `harness/stdrun.ps1` | admin | Runs a script as `freedomstd` in its console session: a `LogonType Interactive`, `RunLevel Limited` scheduled task. |
| `harness/install.ps1` | standard | Silent per-user install. Lists the helpers, their hashes and the directory ACL. |
| `harness/marker-dll/` | — | Marker `netapi32.dll`/`fwpuclnt.dll` and the positive-control exe (mingw-w64). |
| `harness/plant.ps1`, `harness/control-elevated.ps1` | standard, admin | Plant the markers beside the helpers. Run the positive control both ways. |
| `harness/setup-l10.js` | standard | Administrator setup through `WindowsWorkspaceExecutor.setup()`, with the L10 tamper loop. |
| `harness/watchloop.ps1` | admin | Records the elevated setup helper's owner, token elevation and loaded modules. |
| `harness/typekeys.py` | host | Types the UAC credentials with `virsh send-key`, reading them from a file. |
| `harness/qualify.ps1` | standard | `scripts/qualify-windows-workspace.js --runtime <installed helpers>`. |
| `harness/race-probe.js` | standard | Runs the S1 cleanup race on its own, N times, with timings. |
| `harness/dns-admin.ps1`, `harness/dns-listener.js` | admin | The owned DNS listener and the temporary NRPT rule for S8. |
| `harness/s8.js`, `harness/ident.js` | standard | The S8 cases, and the identity a granted command runs as. |
| `harness/final.ps1` | admin | Direct elevated launch, the final marker check, and the sandbox accounts. |

## Logs

- `setup-run1.log`, `setup-run2.log`: setup plus L10, as the standard user.
- `setup-run2-admin-watch.log`: the elevated helper, seen by the admin observer.
- `qualify-NN-*.log`: the 13 full qualification runs, in order. 01 and 02 are the
  harness flake fixed in this PR.
- `race-probe-40.log`: 40 standalone S1 races, all `overlapped` and `preserved`.
- `s8.log`, `s8-dns-packets.log`: the S8 receipts, and every query the owned
  listener saw.
- `ident.log`: `whoami` from a granted command (`freedomsbxonline`).
- `final.log`: the planted files, the direct elevated launch, the absent
  `markers.log`, the positive-control log, and the sandbox accounts.
- `versions.log`: Windows, Defender, Node and Freedom versions.
- `uac-credential-prompt.png`: the standard user's UAC prompt for the setup
  helper, on the secure desktop.
