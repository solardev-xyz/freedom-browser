# Nightly real-conditions E2E

Issue: [#559](https://github.com/solardev-xyz/freedom-browser/issues/559).

Every night this installs the **published** `nightly` release the way a tester would, on a clean Ubuntu 24.04 desktop and a clean Windows 11 machine. It then runs the `packaged` and `packaged-live` Playwright projects against the installed app.

The `release.yml` smoke jobs test the artifact on a CI runner before it is published, with xvfb, `--no-sandbox` and an extracted AppImage. This tests what people actually download, afterwards:

|                  | CI smoke (`release.yml`) | Real conditions (here)                     |
| ---------------- | ------------------------ | ------------------------------------------ |
| Artifact         | workflow artifact        | published release asset                    |
| Display          | xvfb                     | GNOME on Wayland / Windows desktop session |
| Chromium sandbox | off on Linux             | on                                         |
| AppImage         | extracted                | run as-is (FUSE, AppArmor)                 |
| Windows          | elevated runner          | standard UAC token, Defender on            |
| Machine          | warm runner image        | fresh snapshot of a stock install          |

## How it works

Both VMs are KVM guests on the e2e host, on libvirt's NAT network, so neither can be reached from outside. Each VM has a read-only `golden.qcow2` image. Every run boots a throwaway overlay on top of it, so nothing carries over from one night to the next.

`run-nightly.sh`:

1. Reads `version:` and `commit:` from the `nightly` release notes. It stops here if that version already has a result.
2. Boots both VMs from fresh overlays, in parallel.
3. Ubuntu (`guest/linux-run.sh`, over SSH):
   - `apt install`s the `.deb`, then runs the suites against `/opt/Freedom/freedom`.
   - Runs them again against the `.AppImage` itself.
   - Both legs run inside the auto-logged-in GNOME session.
4. Windows (`guest/windows-run.ps1`):
   - A scheduled task starts the script inside the auto-logged-in desktop session, with a non-elevated token. SSH sessions have no desktop.
   - The script runs the installer with `/S`, then runs the suites against the per-user `Freedom.exe`.
5. Each guest shallow-fetches the release's own commit for the specs, then runs `npm ci --ignore-scripts`.
6. Results are copied back to `/var/lib/freedom-nightly-e2e/runs/<version>/`. That covers `summary.md`, the run logs, the Playwright JSON and HTML reports, and traces.
7. Reporting:
   - On failure, it opens or comments on one `Nightly real-conditions E2E failed` issue (label `nightly`).
   - On a pass, it closes that issue.

`run-nightly.sh --release <tag>` tests a tagged release the same way: a candidate such as `v0.8.7-rc.2`, or a final. The assets come from that release, the commit is the one the tag points at, and results go to `runs/<version>/` as for a nightly. A failing release opens (or comments on) its own `Real-conditions E2E failed on v<version>` issue. A passing one reports nothing. `--release latest` picks the newest published release other than `nightly`.

No PR code runs on the host. Only published release assets and the commit they were built from are used, so this does not need a self-hosted Actions runner on a public repo.

## Setup (once per host)

You need a bare-metal Linux host with `/dev/kvm`. The user running this needs passwordless `sudo` and membership in the `libvirt` group. You also need `gh` authenticated with access to the repo.

```sh
sudo apt install qemu-system-x86 qemu-utils libvirt-daemon-system libvirt-clients \
  virtinst swtpm swtpm-tools ovmf cloud-image-utils genisoimage jq
sudo usermod -aG libvirt "$USER"   # then log in again
sudo install -d -o "$USER" -g "$USER" /var/lib/freedom-nightly-e2e

scripts/nightly-vm-e2e/provision-ubuntu.sh    # ~15 min
scripts/nightly-vm-e2e/provision-windows.sh   # ~30-45 min
scripts/nightly-vm-e2e/install-timer.sh       # nightly: hourly 00:20-11:20 UTC; releases: hourly
```

Each guest needs about 8 GB RAM and 4 vCPUs while it runs. The disks take ~10 GB (Ubuntu) and ~25 GB (Windows), plus the per-run overlays.

## Running by hand

```sh
scripts/nightly-vm-e2e/run-nightly.sh --force --no-report        # both VMs
scripts/nightly-vm-e2e/run-nightly.sh --force --no-report --vm ubuntu
scripts/nightly-vm-e2e/run-nightly.sh --release v0.8.7-rc.2       # a candidate
journalctl -u freedom-nightly-e2e.service                         # timer runs
```

To watch a guest, use `virsh vncdisplay freedom-e2e-win11`. VNC only listens on 127.0.0.1, so reach it through an SSH tunnel. `virsh screenshot <vm> out.png` also works.

## Timer

`install-timer.sh` installs `freedom-nightly-e2e.timer` and `.service`, and `freedom-release-e2e.timer` and `.service`, into `/etc/systemd/system/` and enables both timers. The release timer fires hourly at :50 and runs `run-nightly.sh --release latest`, so every candidate and release is tested once, within about an hour of being published. Both share one lock: a release check that finds a nightly run in progress skips that hour and tries again at the next one. The service runs `run-nightly.sh` as the user who installed it. Once that user has tested a version, the timer skips that version on later runs, so firing hourly costs one `gh release view` per hour.

```sh
systemctl list-timers freedom-nightly-e2e.timer               # enabled? next run?
journalctl -u freedom-nightly-e2e.service -n 200              # past runs
sudo systemctl start --no-block freedom-nightly-e2e.service   # check for a new nightly now
sudo systemctl disable --now freedom-nightly-e2e.timer        # pause (re-enable: enable --now)
sudo systemctl stop freedom-nightly-e2e.service               # abort a run in progress
```

Stopping a run in progress can leave a VM running. `virsh destroy <vm>` shuts it down. Nothing is lost, because the next run starts from a fresh overlay anyway.

To remove a timer completely, run `sudo systemctl disable --now freedom-nightly-e2e.timer` (or `freedom-release-e2e.timer`), then `sudo rm /etc/systemd/system/freedom-nightly-e2e.{timer,service}` (or the `freedom-release-e2e` pair) and `sudo systemctl daemon-reload`.

## Maintenance

- **The Windows evaluation licence lasts 90 days from install.** After that, Windows shuts itself down every hour. Re-run `provision-windows.sh` about every 80 days. It rebuilds from scratch, and the newest evaluation ISO also picks up Windows updates.
- **Refresh the Ubuntu golden image** (`provision-ubuntu.sh`) every month or two. Automatic updates are off inside the guests, so a run never fights apt or Windows Update for the machine.
- After changing anything in this directory, re-run `install-timer.sh`. The timer runs a copy in `/var/lib/freedom-nightly-e2e/bin`, not a working checkout.
