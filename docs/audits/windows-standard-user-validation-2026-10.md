# Windows sandbox: standard-user native validation (#779 item 3) — 2026-10-23

Issue: [#779](https://github.com/solardev-xyz/freedom-browser/issues/779), item 3. Items 1
and 2 (System32-only DLL loading for the helpers, and Windows network grants only
from a person) landed in [PR #457](https://github.com/solardev-xyz/freedom-browser/pull/457).
Item 3 asked to rerun S1, S8 and the L10 lock checks as a **standard user**. The
`agent-sandbox-windows.yml` runners can't do that, because they run elevated. This
run also covers the DLL-planting check from item 1 against a real UAC elevation.

Raw logs, harness scripts and the marker-DLL sources are in
[`evidence/windows-standard-user-2026-10/`](evidence/windows-standard-user-2026-10/).

## Result

| Check | Result |
| --- | --- |
| (a) Planted `netapi32.dll`/`fwpuclnt.dll` beside `freedom-windows-sandbox-setup.exe` | **Not loaded** during two UAC-elevated setups, nine qualification runs, S8 and a direct elevated launch. The positive control loads both, standard and elevated. |
| (b) S8: an offline command is refused without a grant; DNS works with one | **Pass.** It is refused before launch, and the owned DNS listener saw 0 queries from it. With a grant, the owned name reached the listener and `example.com` resolved. |
| (c) S1: cleanup with a junction swapped into the private directory | **Pass, no outside file deleted in any run.** The racing check itself failed to *race* in 2 of 6 runs with the old harness. That is a harness flake, now fixed with a regression test (below). |
| (d) L10: handle locks hold through elevation | **Pass.** Every write, rename and delete of the setup exe, and every rename of the helper directory, failed with `EBUSY` from the UAC prompt until setup returned (38 rounds, 2 setups). Two rounds overlapped the elevated helper's observed lifetime. Right after setup returned, all four succeeded. |

All four were exercised on the VM, so nothing is left for a physical machine. The
VM differs from a physical PC only in the virtual hardware. The checks depend on the
loader, file sharing, UAC, the sandbox accounts, WFP and the DNS Client service,
which are the same.

## Machine and build

- **Host and VM:** a disposable libvirt clone of `freedom-e2e-win11`, the nightly
  real-conditions E2E VM described in `scripts/nightly-vm-e2e/`.
  - It ran on its own qcow2 overlay over the read-only `golden.qcow2`, with its
    own UUID, MAC and NVRAM.
  - It was destroyed afterwards (`virsh undefine --nvram --tpm`, overlay deleted).
  - The golden image was never written: still `0444`, mtime Oct 6.
- **OS:** Windows 11 Enterprise Evaluation 24H2, build 26100.1742
  (`26100.1.amd64fre.ge_release.240331-1435`).
  - 4 vCPU (i9-12900K host) and 8 GB RAM.
  - UAC at its defaults: `EnableLUA=1`, `ConsentPromptBehaviorUser=3` (ask for
    credentials), `PromptOnSecureDesktop=1`.
  - Defender real-time protection on (platform 4.18.26090.9, engine 1.1.26090.9,
    signatures 1.461.165.0).
  - Neither `netapi32` nor `fwpuclnt` is in `KnownDLLs`, as the issue assumed.
- **Accounts:**
  - `tester` is the image's administrator. It was used only for the SSH control
    channel, for typing the UAC credentials, and for the admin-side observers.
  - `freedomstd` is a new account, a member of `Users` only. The console was
    switched to auto-log on as `freedomstd`.
  - Every product step ran as `freedomstd` in that console session, through an
    `Interactive`/`Limited` scheduled task (`harness/stdrun.ps1`).
  - `whoami /groups` there shows Medium Mandatory Level and no Administrators.
- **Build:** current `main`, `42158f97d` (the PR #457 merge).
  - It was built by an unsigned, no-publish Release pipeline test,
    [run 39966495939](https://github.com/solardev-xyz/freedom-browser/actions/runs/39966495939)
    (job `windows-x64` passed).
  - Installer: `Freedom-Setup-0.8.8-dev.exe`, sha256
    `5af3c4e325dadbf08fe3e9b99a8f19c5d3b922dd1b5b8c0b1eb73a1c61f1039d`.
  - It was installed with `/S` as `freedomstd`, into
    `C:\Users\freedomstd\AppData\Local\Programs\freedom-browser`. `freedomstd` has
    `(F)` on `resources\windows-workspace`, so that directory is user-writable.
  - Helper hashes match the installed `manifest.json`:

    | Helper | sha256 |
    | --- | --- |
    | `freedom-windows-sandbox-setup.exe` | `f3dc75e8f154d2081e972a5ae09ca37a50d7154792c27da5b8b41e4a22ca11e7` |
    | `freedom-windows-workspace.exe` | `11b1c492083d7b083e48b20ed2928fa6fbf57a6778cf3cb826cec033fdd63131` |
    | `freedom-workspace-runner.exe` | `cdfb3927c1cbcfca698e56963cadd52033ff79edc7ec24f50c9aaec0f2551573` |

    The adapter hash is `df782b1df5c404ef14e2e32dbd155a498f08445e45156a0e469e41f9db6cdc24`.
- **Driver:** the JS side (`WindowsWorkspaceExecutor`, policies,
  `qualify-windows-workspace.js`) ran from a checkout of the same commit with
  Node 24.21.0.
  - The checkout used Git for Windows' default `core.autocrlf=true`, so its CRLF
    `main.rs` hashes to the installed manifest's `adapterSha256`.
  - `--runtime` (added in this PR) points the qualification at the installed
    helpers rather than `out/`.

## Steps and results

### (a) DLL planting

1. **Build the markers** (`harness/marker-dll/`, mingw-w64 13). `netapi32.dll` and
   `fwpuclnt.dll` export exactly the names the setup exe imports:
   - `netapi32`: 6 names, from `NetUserAdd` to `NetApiBufferFree`;
   - `fwpuclnt`: 9 names, from `FwpmEngineOpen0` to `FwpmFilterDeleteByKey0`.

   On load, `DllMain` appends a line to
   `C:\ProgramData\freedom-dll-plant\markers.log` with the pid, user, token
   elevation and both module paths. Every export forwards to the real System32
   DLL, so a load is recorded without breaking the host process.
   - sha256 of `netapi32.dll`: `9ce42366bffb66bbe86253640882768789626d7bba2592839f3bf5a4e16205da`;
   - sha256 of `fwpuclnt.dll`: `521785c235440d23a8344519d0e437564a98d86ba97264df5d5fb1675d41af9f`;
   - sha256 of `plant-control.exe`: `574936f54deaa1a2e1e3e6e0052ea3766c598d850e1cfdb9bdba649bfb5c23e0`.
2. **Plant them.** As `freedomstd`, copy both into `resources\windows-workspace`,
   beside the setup exe (`harness/plant.ps1`).
3. **Positive control.** `plant-control.exe`, an ordinary mingw exe without
   `/DEPENDENTLOADFLAG` that statically imports both, was run from the same
   directory. The run as `freedomstd` logged `elevated=0`. The run as elevated
   `tester` logged `elevated=1, user=tester`. Both runs loaded both planted
   DLLs (`logs/final.log`).
   - So a default-search process, elevated or not, loads them from here. The log
     was then reset.
   - A first build of the markers resolved its own stub when forwarding, because
     a module with the same base name was already loaded, and spun. Loading the
     real DLL by full System32 path fixed that before any real check ran.
4. **Run the administrator setup** twice through Freedom's own
   `WindowsWorkspaceExecutor.setup()` (`setup-interactive`, the Settings entry
   point), with the markers still planted.
   - **The prompt:** the standard-user UAC credential prompt for
     `freedom-windows-sandbox-setup.exe` came up on the secure desktop
     ([screenshot](evidence/windows-standard-user-2026-10/uac-credential-prompt.png)).
   - **Answering it:** the admin password was typed with `virsh send-key`
     (`harness/typekeys.py`).
   - **The elevated helper:** an elevated observer (`harness/watchloop.ps1`) saw
     it as `owner=FREEDOM-E2E-WIN\tester token=elevated`, with `netapi32`
     and `fwpuclnt` loaded from `C:\WINDOWS\SYSTEM32`. The only module from
     outside System32 was the exe itself (`logs/setup-run2-admin-watch.log`).
   - **Outcome:** setup completed: probe `setupRequired: true → false`, and
     `FreedomSbxOffline`/`FreedomSbxOnline` were created.
5. **Direct launch.** The setup exe was also launched straight from an elevated
   shell, with no request. It exited 1 (request rejected), the same as the PR #457
   Rust test.
6. **Result:** after both setups, nine qualification runs, S8 and the direct
   launch, `markers.log` does not exist. The planted DLLs were never loaded by the
   setup helper (elevated), the workspace helper or the runner.

### (d) L10 locks through elevation

`harness/setup-l10.js`, as `freedomstd`, starts `setup()`. Until it returns, it
repeatedly tries four things:
- append to the setup exe;
- rename the setup exe and back;
- delete it, after making a backup copy;
- rename `resources\windows-workspace` and back.

Results (`logs/setup-run1.log`, `logs/setup-run2.log`):

- **Run 1** (first provisioning): 10 rounds, 16:46:38–16:46:57Z, all four `EBUSY`,
  through the UAC prompt and the elevated phase. Setup returned at 16:46:59.
- **Run 2:** 28 rounds at about 300 ms intervals, all four `EBUSY`.
  - The admin observer saw the elevated helper alive at 16:48:00.73 and
    16:48:01.02.
  - Rounds logged at 16:48:00.755 and 16:48:01.052 fall inside that window.
  - Setup returned at 16:48:01.309.
  - The in-script `tasklist` flag stayed `false` throughout, because the standard
    user's `tasklist` does not list the administrator's elevated process. The
    overlap comes from the admin observer's timestamps.
- **After setup returned** (both runs): all four attempts succeeded within 20 ms.
  The locks are held for exactly the setup call.

### (b) S8

`harness/dns-admin.ps1` set up the fixture as admin:
- an owned UDP listener on `127.0.0.1:53`, running as SYSTEM, that logs each
  query and answers NXDOMAIN;
- a namespace-only NRPT rule sending `.freedom-audit.test` to that listener.

Then `harness/s8.js` ran as `freedomstd` against the installed helpers
(`logs/s8.log`, `logs/s8-dns-packets.log`):

| Case | Result |
| --- | --- |
| Host control (outside the sandbox) | Reached the listener. |
| `network: 'none'`, lookup of a fresh owned name | `sandbox_denied`, `WINDOWS_FULL_NETWORK_PERMISSION_REQUIRED`, `sideEffects: none`. After 2.5 s, **0 queries** for that name. |
| `network: 'none'`, `example.com` | Refused the same way, no output. |
| `network: 'full'`, fresh owned name | `completed`. The listener got the query, and the command saw `ENOTFOUND`. |
| `network: 'full'`, `example.com` | `completed`, resolved to `104.20.23.154` and `172.66.147.243`. |
| Native helper, `operation: 'execute', network: false` | `WINDOWS_OFFLINE_COMMAND_UNAVAILABLE`. The helper refuses on its own, with no JS gate. |

- `logs/ident.log`: a granted command runs as `freedom-e2e-win\freedomsbxonline`
  (group `FreedomSbxUsers`, Medium), not as `freedomstd`.
- **Cleanup:** the NRPT rule was removed afterwards, and 0 rules remained.

### (c) S1 and the full qualification

`node scripts/qualify-windows-workspace.js --root %LOCALAPPDATA%\freedom-agent-tests
--runtime <install>\resources\windows-workspace` ran as `freedomstd` (`harness/qualify.ps1`).
Its 19 checks cover:
- filesystem: workspace write; denied outside and `.git` writes; denied write
  through a junction; opened-handle reads;
- network: refused offline write and offline socket; granted socket; npm build;
  host preview;
- process lifetime: cancel; abrupt parent exit;
- S1: `handle-relative-cleanup` (junction inside the private dir),
  `handle-relative-root-cleanup` (the private dir itself replaced by a junction) and
  `handle-relative-cleanup-race` (a surviving process keeps swapping `sub` between a
  directory and a junction to an outside directory full of decoy-named files);
- sentinels.

| Runs | Racer | Result |
| --- | --- | --- |
| 1, 2 | old | 18/19: `handle-relative-cleanup-race` reported `overlapped: false` (`preserved: true`, `removed: true`). |
| 3, 10, 11, 12 | old | 19/19 |
| 4–9, 13 (13 after a reboot) | fixed | 19/19; the race overlapped on attempt 1 every time. |

- **No outside file was ever deleted.** Every run reported `preserved: true`, and
  the outside, `.git` and junction sentinels stayed `untouched`.
- **Standalone race:** 40 more races in a row (`harness/race-probe.js`,
  `logs/race-probe-40.log`) all overlapped and preserved.
- **First invocation:** it stopped at `opened-handle-read`, because
  `readWindowsWorkspaceFile` resolved its own runtime from `out/`. This PR passes
  `--runtime` through to it too.

**What failed and the fix.**
- **The failure:** `raceCleanup` made a single cleanup attempt and called the race
  `overlapped` only if the racer swapped a link during it. On this machine a
  `remove-tree` attempt can fail in ~100 ms. That is less than one racer iteration
  (64 decoy writes plus a swap, under Defender), so the check sometimes never
  raced at all (`during: {directories: 2, links: 1}`).
- **What it means:** that says nothing about the cleanup, but it makes the
  qualification flaky. On a run that never raced, it would also wrongly report
  the race as tested.
- **The fix:** `raceCleanup` now retries the cleanup, up to `attempts` (default
  10). It stops at the first attempt that a swap overlapped, or once the target
  is gone. Every attempt still has to preserve the outside files. The report
  carries `attempts`.
- **Regression tests** in `cleanup-racer.test.js`:
  - a deterministic slow racer (`holdMs: 2000`) with a first attempt that fails
    at once. It must overlap on attempt 2.
  - a cleanup that always fails between swaps must report `overlapped: false`
    after exactly `attempts`.

  Both fail against the old racer.
- **Not seen natively:** after the fix, the race overlapped on the first attempt
  in all 7 runs, so the VM never exercised the retry path itself. The failing
  window didn't recur with the old racer either, in its last four runs including
  after a reboot.

## Not covered

- **The Settings button.** Setup was started through the executor that the
  Settings "Set up" button calls, not by clicking it.
- **WFP filters.** The installed filters were not enumerated (an L10 follow-up
  named in the triage). Only their effect on DNS was observed (S8).
