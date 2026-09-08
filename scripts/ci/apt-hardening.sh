#!/usr/bin/env bash
#
# Deterministic apt / system-dependency installation for Linux CI runners.
#
# Why this exists
# ---------------
# GitHub's ubuntu runners resolve every apt URI through the
# `mirror+file:/etc/apt/apt-mirrors.txt` indirection to azure.archive.ubuntu.com,
# and apt pipelines an entire fetch over a single HTTP connection. When that one
# connection lands on a degraded mirror backend the whole download trickles
# instead of failing: on run 33618510222 the 114 MB `npx playwright install-deps`
# fetch that normally completes in 9s (13.3 MB/s) ran at ~35 kB/s for 13 minutes
# and was still going when the job's timeout-minutes cancelled it. apt's own
# `Acquire::*::Timeout` is an inactivity timeout, so it never fires while bytes
# keep trickling in — nothing bounded the step.
#
# What this script does about it
# ------------------------------
#   * Configures apt non-interactively with retries and connect/read timeouts
#     through a global /etc/apt/apt.conf.d drop-in, so apt-get invocations we do
#     not control inherit them too (Playwright shells out to its own
#     `sudo sh -c "apt-get update && apt-get install ..."`, which resets the
#     environment, so DEBIAN_FRONTEND alone would not reach it).
#   * Waits for the runner's unattended-upgrades to release the dpkg/apt locks
#     rather than racing it.
#   * Runs every invocation under a per-attempt wall-clock timeout and retries.
#     The timeout is the throughput floor apt lacks: a stalled or throttled
#     transfer is killed quickly and retried on a fresh connection instead of
#     eating the job's entire time budget. apt keeps partial downloads in
#     /var/cache/apt/archives/partial, so retries resume rather than restart.
#   * Falls back from the Azure regional mirror to archive.ubuntu.com on the
#     final attempt — the only lever that changes the network path itself.
#
# Usage:
#   apt-hardening.sh configure                 # write the apt drop-in only
#   apt-hardening.sh update                    # hardened `apt-get update`
#   apt-hardening.sh install <pkg>...          # hardened update + install
#   apt-hardening.sh run -- <command>...       # bounded/retried arbitrary command
#
# Tunables (environment):
#   FREEDOM_CI_APT_ATTEMPTS          attempts per invocation (default 3)
#   FREEDOM_CI_APT_ATTEMPT_TIMEOUT   seconds per attempt     (default 150)
#   FREEDOM_CI_APT_LOCK_TIMEOUT      seconds to wait for dpkg locks (default 180)

set -euo pipefail

APT_CONF_PATH=/etc/apt/apt.conf.d/99-freedom-ci
MIRROR_LIST=/etc/apt/apt-mirrors.txt
FALLBACK_MIRROR=http://archive.ubuntu.com/ubuntu/

ATTEMPTS="${FREEDOM_CI_APT_ATTEMPTS:-3}"
ATTEMPT_TIMEOUT="${FREEDOM_CI_APT_ATTEMPT_TIMEOUT:-150}"
LOCK_TIMEOUT="${FREEDOM_CI_APT_LOCK_TIMEOUT:-180}"

mirror_switched=0

log() {
  printf '[apt-hardening] %s\n' "$*"
}

warn() {
  printf '::warning::[apt-hardening] %s\n' "$*"
}

configure() {
  sudo tee "$APT_CONF_PATH" >/dev/null <<'APT_CONF'
// Written by scripts/ci/apt-hardening.sh. CI-only determinism knobs; a global
// drop-in so apt-get processes started by other tools (Playwright) inherit it.
APT::Get::Assume-Yes "true";
APT::Keep-Downloaded-Packages "true";
// Translated package descriptions are several MB of index nobody reads in CI.
Acquire::Languages "none";
Acquire::Retries "3";
Acquire::http::Timeout "20";
Acquire::https::Timeout "20";
Acquire::ftp::Timeout "20";
Dpkg::Use-Pty "0";
DPkg::Options { "--force-confdef"; "--force-confold"; };
APT_CONF

  # debconf reads its frontend from the debconf database as well as from
  # DEBIAN_FRONTEND. Set it in the database because `sudo` resets the
  # environment for the apt-get calls Playwright makes on our behalf.
  echo 'debconf debconf/frontend select Noninteractive' | sudo debconf-set-selections 2>/dev/null || true
}

locks_busy() {
  local lock
  for lock in /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock \
    /var/lib/apt/lists/lock /var/cache/apt/archives/lock; do
    [ -e "$lock" ] || continue
    if sudo fuser "$lock" >/dev/null 2>&1; then
      return 0
    fi
  done
  return 1
}

wait_for_locks() {
  if ! command -v fuser >/dev/null 2>&1; then
    warn 'fuser is unavailable; skipping the dpkg/apt lock wait'
    return 0
  fi

  local waited=0
  while locks_busy; do
    if [ "$waited" -ge "$LOCK_TIMEOUT" ]; then
      warn "dpkg/apt locks still held after ${LOCK_TIMEOUT}s; continuing anyway"
      return 0
    fi
    log "dpkg/apt lock held (unattended-upgrades?); waited ${waited}s"
    sleep 5
    waited=$((waited + 5))
  done
}

# `timeout` only signals the command we start. Playwright's apt-get runs under
# its own `sudo sh -c`, so a killed attempt can leave a root-owned apt-get
# holding the dpkg lock. Terminate those leftovers and let any dpkg they
# started finish before the next attempt.
reset_apt_state() {
  sudo pkill -TERM -x apt-get >/dev/null 2>&1 || true
  sleep 3
  sudo pkill -KILL -x apt-get >/dev/null 2>&1 || true
  wait_for_locks
  sudo dpkg --configure -a >/dev/null 2>&1 || true
}

use_fallback_mirror() {
  if [ "$mirror_switched" -eq 1 ]; then
    return 0
  fi
  if [ ! -f "$MIRROR_LIST" ]; then
    warn "no ${MIRROR_LIST} on this runner; cannot switch mirrors"
    return 0
  fi

  mirror_switched=1
  log "switching apt to ${FALLBACK_MIRROR} (same archive, different network path)"
  printf '%s\n' "$FALLBACK_MIRROR" | sudo tee "$MIRROR_LIST" >/dev/null
  # Indices were fetched through the previous mirror; refresh them so the
  # retry can resolve packages against the fallback.
  timeout --kill-after=30s "${ATTEMPT_TIMEOUT}s" sudo apt-get update >/dev/null 2>&1 || true
}

run_bounded() {
  local label="$1"
  shift

  local attempt=1
  local rc started elapsed
  while :; do
    wait_for_locks

    # Last attempt: change the mirror, not just the connection.
    if [ "$attempt" -gt 1 ] && [ "$attempt" -ge "$ATTEMPTS" ]; then
      use_fallback_mirror
    fi

    log "${label}: attempt ${attempt}/${ATTEMPTS} (per-attempt timeout ${ATTEMPT_TIMEOUT}s)"
    started=$SECONDS
    rc=0
    timeout --kill-after=30s "${ATTEMPT_TIMEOUT}s" "$@" || rc=$?
    elapsed=$((SECONDS - started))

    if [ "$rc" -eq 0 ]; then
      log "${label}: succeeded in ${elapsed}s"
      return 0
    fi

    if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
      warn "${label}: exceeded ${ATTEMPT_TIMEOUT}s (attempt ${attempt}) — mirror connection stalled or throttled; retrying on a fresh connection"
    else
      warn "${label}: exited ${rc} after ${elapsed}s (attempt ${attempt})"
    fi

    reset_apt_state

    if [ "$attempt" -ge "$ATTEMPTS" ]; then
      printf '::error::[apt-hardening] %s failed after %s attempts\n' "$label" "$ATTEMPTS"
      return 1
    fi

    attempt=$((attempt + 1))
    sleep 5
  done
}

usage() {
  printf 'usage: %s {configure|update|install <pkg>...|run -- <command>...}\n' "$0" >&2
}

main() {
  local command="${1:-}"
  if [ "$#" -gt 0 ]; then
    shift
  fi

  case "$command" in
    configure)
      configure
      ;;
    update)
      configure
      run_bounded 'apt-get update' sudo apt-get update
      ;;
    install)
      if [ "$#" -eq 0 ]; then
        usage
        exit 2
      fi
      configure
      run_bounded 'apt-get update' sudo apt-get update
      run_bounded "apt-get install $*" sudo apt-get install -y "$@"
      ;;
    run)
      if [ "${1:-}" = '--' ]; then
        shift
      fi
      if [ "$#" -eq 0 ]; then
        usage
        exit 2
      fi
      configure
      run_bounded "$*" "$@"
      ;;
    *)
      usage
      exit 2
      ;;
  esac
}

main "$@"
