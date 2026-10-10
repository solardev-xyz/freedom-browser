#!/usr/bin/env bash
# Installs the systemd timers that run run-nightly.sh as the invoking user:
# nightly builds, and each published release candidate or release.
# Copies these scripts to $STATE_DIR/bin first, so the timer never runs
# whatever branch a working checkout happens to be on; re-run after changes.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/lib.sh"
rm -rf "$STATE_DIR/bin"
cp -r "$here" "$STATE_DIR/bin"
for unit in freedom-nightly-e2e.service freedom-nightly-e2e.timer \
  freedom-release-e2e.service freedom-release-e2e.timer; do
  sed -e "s#@USER@#$(id -un)#" -e "s#@BIN@#$STATE_DIR/bin#" "$here/systemd/$unit" |
    sudo tee "/etc/systemd/system/$unit" >/dev/null
done
sudo systemctl daemon-reload
sudo systemctl enable --now freedom-nightly-e2e.timer freedom-release-e2e.timer
systemctl list-timers freedom-nightly-e2e.timer freedom-release-e2e.timer --no-pager
