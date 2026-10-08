#!/usr/bin/env bash
# Nightly real-conditions E2E (#559): installs the published `nightly` release
# on clean Ubuntu and Windows VMs and runs the packaged suites against it.
#
#   scripts/nightly-vm-e2e/run-nightly.sh [--force] [--vm ubuntu|windows] [--no-report]
#                                         [--release <tag>|latest]
#
# --release tests a tagged release instead: a candidate such as v0.8.7-rc.2,
# or a final. `latest` picks the newest published (non-draft) release other
# than `nightly`, which is what the release timer runs. A failing release gets
# its own issue; a passing one reports nothing.
#
# Without --force a version that already has a result is skipped, so the timer
# can fire hourly through the window the nightly usually lands in. Results go
# to $STATE_DIR/runs/<version>/<vm>/; the summary goes to one GitHub issue.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/lib.sh"

force=0 report=1 only='' release=''
while [ $# -gt 0 ]; do
  case "$1" in
    --force) force=1 ;;
    --no-report) report=0 ;;
    --vm) only="$2"; shift ;;
    --release) release="$2"; shift ;;
    *) die "unknown argument $1" ;;
  esac
  shift
done

exec 9>"$STATE_DIR/run.lock"
flock -n 9 || { log "another run holds $STATE_DIR/run.lock"; exit 0; }

if [ -z "$release" ]; then
  kind=Nightly
  release_json="$(gh release view nightly --repo "$REPO_SLUG" --json body,assets)"
  body="$(jq -r .body <<<"$release_json")"
  version="$(sed -n 's/^version: //p' <<<"$body" | head -1)"
  commit="$(sed -n 's/^commit: //p' <<<"$body" | head -1)"
  [ -n "$version" ] && [ -n "$commit" ] || die "no version/commit line in the nightly release notes"
else
  kind=Release
  if [ "$release" = latest ]; then
    release="$(gh release list --repo "$REPO_SLUG" --exclude-drafts --limit 20 --json tagName,publishedAt \
      -q '[.[] | select(.tagName != "nightly")] | sort_by(.publishedAt) | last | .tagName')"
    [ -n "$release" ] || die "no published release besides nightly"
  fi
  release_json="$(gh release view "$release" --repo "$REPO_SLUG" --json assets,isDraft)"
  [ "$(jq -r .isDraft <<<"$release_json")" = false ] || die "$release is a draft"
  version="${release#v}"
  # The commit the tag points at, through an annotated tag; the guest checks
  # it out to run the suites from the same source the release was built from.
  commit="$(gh api "repos/$REPO_SLUG/commits/$release" -q .sha)"
  [ -n "$commit" ] || die "could not resolve the commit of $release"
fi
# x64 assets only: the arm64 AppImage is `...-arm64.AppImage`, the x64 one
# has no arch in its name.
asset() {
  jq -r --arg re "$1" '.assets[] | select((.name | test($re)) and (.name | test("arm64|aarch64") | not)) | .url' \
    <<<"$release_json" | head -1
}
deb_url="$(asset '_amd64\.deb$')"
appimage_url="$(asset '\.AppImage$')"
installer_url="$(asset '^Freedom-Setup-.*\.exe$')"

out="$STATE_DIR/runs/$version"
if [ -f "$out/summary.md" ] && [ $force -eq 0 ]; then
  log "$version already tested"; exit 0
fi
rm -rf "$out"
mkdir -p "$out"
log "testing $version ($commit)"

# Each leg writes $out/<vm>/status (exit code) and its logs; never fails the
# script itself, so one broken VM still lets the other report.
run_ubuntu() {
  local vm=$UBUNTU_VM dest="$out/ubuntu"
  mkdir -p "$dest"
  vm_reset_and_start "$vm"
  if ! wait_for_ssh "$vm" 600; then echo 80 >"$dest/status"; vm_shutdown "$vm" 0; return; fi
  # GNOME auto-login lags SSH by a few seconds; the suites need the session.
  for _ in $(seq 60); do
    vm_ssh "$vm" 'test -S /run/user/$(id -u)/wayland-0' 2>/dev/null && break
    sleep 2
  done
  if ! vm_scp_to "$vm" "$here/guest/linux-run.sh" /tmp/linux-run.sh; then
    echo 83 >"$dest/status"; vm_shutdown "$vm" 60; return
  fi
  local rc=0
  timeout 2h ssh "${SSH_OPTS[@]}" -i "$SSH_KEY" "$GUEST_USER@$(vm_ip "$vm")" \
    bash /tmp/linux-run.sh "$version" "$commit" "$deb_url" "$appimage_url" \
    >"$dest/console.log" 2>&1 </dev/null || rc=$?
  echo "$rc" >"$dest/status"
  vm_scp_from "$vm" '~/e2e/results' "$dest/" >/dev/null 2>&1 || true
  vm_shutdown "$vm" 60
}

run_windows() {
  local vm=$WINDOWS_VM dest="$out/windows"
  mkdir -p "$dest"
  vm_reset_and_start "$vm"
  if ! wait_for_ssh "$vm" 900; then echo 80 >"$dest/status"; vm_shutdown "$vm" 0; return; fi
  if ! vm_scp_to "$vm" "$here/guest/windows-run.ps1" C:/e2e/windows-run.ps1; then
    echo 83 >"$dest/status"; vm_shutdown "$vm" 60; return
  fi
  # SSH sessions have no desktop. A scheduled task with an Interactive
  # principal runs in tester's auto-logged-in console session instead, with
  # the standard (UAC-filtered) token a user's double-click gets.
  vm_ssh "$vm" "
    Remove-Item -Recurse -Force C:\\e2e\\results -ErrorAction SilentlyContinue
    \$a = New-ScheduledTaskAction -Execute powershell.exe -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\\e2e\\windows-run.ps1 -Version $version -Commit $commit -InstallerUrl $installer_url'
    \$p = New-ScheduledTaskPrincipal -UserId tester -LogonType Interactive -RunLevel Limited
    \$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 2)
    Register-ScheduledTask -TaskName freedom-e2e -Action \$a -Principal \$p -Settings \$s -Force | Out-Null
    Start-ScheduledTask -TaskName freedom-e2e" </dev/null >"$dest/console.log" 2>&1
  local deadline=$((SECONDS + 2 * 3600)) rc=81
  while [ $SECONDS -lt $deadline ]; do
    if code="$(vm_ssh "$vm" 'Get-Content C:\e2e\results\exitcode.txt -ErrorAction Stop' </dev/null 2>/dev/null)"; then
      rc="$(tr -dc 0-9 <<<"$code")"; break
    fi
    sleep 30
  done
  echo "$rc" >"$dest/status"
  vm_scp_from "$vm" 'C:/e2e/results' "$dest/" >/dev/null 2>&1 || true
  vm_shutdown "$vm" 60
}

[ "$only" = windows ] || run_ubuntu &
[ "$only" = ubuntu ] || run_windows &
wait

# One line per leg from Playwright's JSON report, or the setup step that failed.
describe() { # dir
  local status json
  status="$(cat "$1/status" 2>/dev/null || echo 82)"
  case "$status" in
    80) echo "VM never came up (no SSH)"; return ;;
    81) echo "timed out after 2h"; return ;;
    82) echo "leg did not run"; return ;;
    83) echo "copying the runner script into the guest failed"; return ;;
    90) echo "downloading/installing the release failed" ;;
    92) echo "checking out $commit failed" ;;
    93) echo "npm ci failed" ;;
  esac
  for json in "$1"/results/*.json; do
    [ -f "$json" ] || continue
    jq -r --arg leg "$(basename "$json" .json)" \
      '"\($leg): \(.stats.expected) passed, \(.stats.unexpected) failed, \(.stats.flaky) flaky, \(.stats.skipped) skipped" +
       ([.suites[] | .. | objects | select(has("specs")) | .specs[] | select(.ok == false) | "\n  - ✗ \(.file):\(.line) \(.title)"] | join(""))' "$json"
  done
}

overall=pass
{
  echo "$kind \`$version\` (commit $commit)"
  echo
  for leg in ubuntu windows; do
    [ -d "$out/$leg" ] || continue
    status="$(cat "$out/$leg/status" 2>/dev/null || echo 82)"
    [ "$status" = 0 ] || overall=fail
    echo "**$leg** — $([ "$status" = 0 ] && echo pass || echo "FAIL (exit $status)")"
    echo '```'
    describe "$out/$leg"
    echo '```'
  done
  echo
  echo "Logs, traces and HTML reports: \`$out\` on the e2e host."
} >"$out/summary.md"
echo "$overall" >"$out/result"
cat "$out/summary.md"

[ $report -eq 1 ] || exit 0
if [ "$kind" = Release ]; then
  # One issue per failing release; a passing release needs no issue.
  [ "$overall" = fail ] || exit 0
  title="Real-conditions E2E failed on v$version"
  issue="$(gh issue list --repo "$REPO_SLUG" --state open --search "in:title \"$title\"" --json number -q '.[0].number')"
  if [ -n "$issue" ]; then
    gh issue comment "$issue" --repo "$REPO_SLUG" --body-file "$out/summary.md" >/dev/null
  else
    gh issue create --repo "$REPO_SLUG" --title "$title" --body-file "$out/summary.md" >/dev/null
  fi
  exit 0
fi
title='Nightly real-conditions E2E failed'
issue="$(gh issue list --repo "$REPO_SLUG" --label nightly --state open --search "in:title \"$title\"" --json number -q '.[0].number')"
if [ "$overall" = fail ]; then
  if [ -n "$issue" ]; then
    gh issue comment "$issue" --repo "$REPO_SLUG" --body-file "$out/summary.md" >/dev/null
  else
    gh issue create --repo "$REPO_SLUG" --label nightly --title "$title" --body-file "$out/summary.md" >/dev/null
  fi
elif [ -n "$issue" ]; then
  gh issue close "$issue" --repo "$REPO_SLUG" --comment "$(cat "$out/summary.md")" >/dev/null
fi
