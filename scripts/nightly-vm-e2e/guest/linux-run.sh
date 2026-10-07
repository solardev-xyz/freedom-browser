#!/usr/bin/env bash
# Runs inside the Ubuntu guest as `tester` (copied there by run-nightly.sh).
#
#   linux-run.sh <version> <commit> <deb url> <appimage url>
#
# Installs the published .deb with apt and makes the published AppImage
# executable, the way a user would, then runs the packaged suites against
# each from the logged-in GNOME session — Chromium sandbox on, no xvfb.
# Everything worth keeping ends up in ~/e2e/results; the exit code is the
# number of failed legs.
set -uo pipefail
version="$1" commit="$2" deb_url="$3" appimage_url="$4"
work=~/e2e
results=$work/results
rm -rf "$work"
mkdir -p "$results"
exec > >(tee "$results/run.log") 2>&1

step() { printf '\n== %s\n' "$*"; }
failed=0

step "guest: $(lsb_release -ds), kernel $(uname -r), node $(node --version)"

step "download release assets"
curl -fsSL --retry 3 -o "$work/freedom.deb" "$deb_url" || exit 90
curl -fsSL --retry 3 -o "$work/Freedom.AppImage" "$appimage_url" || exit 90

step "install .deb with apt"
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "$work/freedom.deb" >"$results/apt-install.log" 2>&1 ||
  { tail -40 "$results/apt-install.log"; exit 91; }
dpkg -s freedom-browser | grep -E '^(Version|Status):'
chmod +x "$work/Freedom.AppImage"

step "check out $commit"
git init -q "$work/repo" &&
  git -C "$work/repo" fetch -q --depth 1 "https://github.com/solardev-xyz/freedom-browser" "$commit" &&
  git -C "$work/repo" checkout -q FETCH_HEAD || exit 92
cd "$work/repo"
# Only Playwright and the specs are needed; the packaged binary brings its own
# Electron, so skip Electron's download along with the lifecycle scripts.
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --ignore-scripts --no-audit --no-fund >"$results/npm-ci.log" 2>&1 ||
  { tail -40 "$results/npm-ci.log"; exit 93; }

# The GNOME session's environment: its Wayland socket (and Xwayland as :0),
# its D-Bus session bus (keyring, portals, notifications).
uid=$(id -u)
export XDG_RUNTIME_DIR=/run/user/$uid
export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
export WAYLAND_DISPLAY=wayland-0 DISPLAY=:0 XDG_SESSION_TYPE=wayland
export FREEDOM_E2E_EXPECTED_VERSION="$version"

run_leg() { # name executable [playwright args...]
  local name="$1" exe="$2"
  shift 2
  step "packaged suites: $name ($exe)"
  FREEDOM_E2E_EXECUTABLE="$exe" \
    PLAYWRIGHT_JSON_OUTPUT_FILE="$results/$name.json" \
    PLAYWRIGHT_HTML_OUTPUT_DIR="$results/$name-report" PLAYWRIGHT_HTML_OPEN=never \
    npx playwright test --project=packaged --project=packaged-live \
    --reporter=list,json,html --output="$results/$name-artifacts" "$@" ||
    failed=$((failed + 1))
}

run_leg deb /opt/Freedom/freedom
# The AppImage is one self-mounting file, so the specs that inspect the
# artifact's layout on disk (fuse wire in the binary, NOTICES next to it) have
# nothing to read. The .deb leg above and release.yml's extracted-AppImage
# smoke cover those; this leg is about launching it the way users do.
run_leg appimage "$work/Freedom.AppImage" \
  --grep-invert 'configured fuses|own app\.asar|--inspect does not open|notices ship|licence and NOTICES'


step "done: $failed failed leg(s)"
exit "$failed"
