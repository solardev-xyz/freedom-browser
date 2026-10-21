#!/usr/bin/env bash
#
# Staple a notarization ticket to (or validate the ticket on) each path given,
# retrying with growing pauses before giving up (#757).
#
#   scripts/staple-with-retry.sh staple   <path>...
#   scripts/staple-with-retry.sh validate <path>...
#
# `xcrun stapler` fetches the ticket from Apple's ticket service
# (api.apple-cloudkit.com). Since about 2026-10-12 GitHub's macOS runners drop
# that connection now and then, and stapler exits 68 with NSURLErrorDomain
# -1005 "The network connection was lost." even though notarization itself
# succeeded (https://github.com/actions/runner-images/issues/14924). One drop
# used to fail the whole nightly. Both commands are safe to repeat: a staple
# that fails on the lookup writes nothing to the bundle, and validate only
# reads.
#
# Each path gets its own attempts. A failed attempt is logged with its exit
# status, then retried after the next pause; the path fails only once the
# last attempt has failed, and the script then exits with that attempt's
# status. Every kind of failure is retried, not just 68: stapler's exit codes
# do not separate "network dropped" from "no ticket", so a real "not
# notarized" also ends in a failure, just a few minutes later.
#
# Pauses, in seconds: STAPLE_RETRY_DELAYS (whitespace separated), default
# "20 40 80 160", i.e. five attempts over about five minutes. Tests set it to
# zeros.

set -uo pipefail

usage() {
  echo "usage: $0 <staple|validate> <path>..." >&2
  exit 2
}

[ $# -ge 2 ] || usage
action="$1"
shift
case "$action" in
  staple | validate) ;;
  *) usage ;;
esac

delays=()
for delay in ${STAPLE_RETRY_DELAYS-20 40 80 160}; do
  case "$delay" in
    '' | *[!0-9]*)
      echo "$0: STAPLE_RETRY_DELAYS must be whole seconds, got '$delay'" >&2
      exit 2
      ;;
  esac
  delays+=("$delay")
done
attempts=$((${#delays[@]} + 1))

for target in "$@"; do
  if [ ! -e "$target" ]; then
    echo "::error title=staple-with-retry::$target does not exist"
    exit 1
  fi

  attempt=1
  while :; do
    echo "staple-with-retry: xcrun stapler $action $target (attempt $attempt/$attempts, $(date -u +%H:%M:%SZ))"
    xcrun stapler "$action" "$target"
    status=$?
    if [ "$status" -eq 0 ]; then
      echo "staple-with-retry: $action succeeded for $target on attempt $attempt/$attempts"
      break
    fi
    if [ "$attempt" -ge "$attempts" ]; then
      echo "::error title=staple-with-retry::xcrun stapler $action $target failed on all $attempts attempts (last exit $status)"
      exit "$status"
    fi
    pause="${delays[$((attempt - 1))]}"
    echo "::warning title=staple-with-retry::xcrun stapler $action $target failed (exit $status) on attempt $attempt/$attempts; retrying in ${pause}s"
    sleep "$pause"
    attempt=$((attempt + 1))
  done
done
