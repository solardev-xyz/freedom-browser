#!/usr/bin/env bash
#
# Run one CI command under a wall-clock deadline, and when it blows the
# deadline, record what is still alive before killing it (#544).
#
#   scripts/ci/hang-watchdog.sh <seconds> <command> [args...]
#
# A step-level `timeout-minutes` already stops a hang, but it does so silently:
# the log ends, then "The operation was canceled", and the runner reaps the
# leftover process during job cleanup without saying what it was doing. That is
# all #544 had to go on — `npm run ant:download` printed its last line, called
# `process.exit(0)`, and sat for 19 minutes. This wrapper fails the step at the
# deadline instead, after printing:
#
#   - the process table (`ps`), so the log names what is still running —
#     npm, node, a tar/unzip child, something else holding the step's pipe;
#   - a stack sample of every process in the command's process tree: `sample`
#     on macOS (it ships with the OS), the kernel wait channel and stack on
#     Linux. A native hang (a thread join, a blocked syscall) is invisible
#     from JavaScript, so the stack is the only place it shows.
#
# Exit status: the command's own status, or 124 (as `timeout` uses) when the
# deadline expired. The command runs in its own process group so the whole
# tree, not just the top process, is signalled.
#
# Pair it with a step `timeout-minutes` a little above the deadline, as a
# backstop for a watchdog that cannot itself run (e.g. the runner losing the
# machine).

set -uo pipefail

if [ "$#" -lt 2 ] || ! [[ "$1" =~ ^[0-9]+$ ]]; then
  echo "usage: $0 <seconds> <command> [args...]" >&2
  exit 2
fi

deadline="$1"
shift

# `set -m` puts the background command in a process group of its own, whose id
# is its pid, so `kill -- -<pid>` reaches every descendant.
set -m
"$@" &
pid=$!
set +m

# Every pid whose ancestry leads back to $1 (including $1 itself).
descendants() {
  local root="$1"
  ps -axo pid=,ppid= 2>/dev/null | awk -v root="$root" '
    { parent[$1] = $2; pids[NR] = $1 }
    END {
      for (i in pids) {
        p = pids[i]
        for (q = p; q != "" && q != 0 && q != 1; q = parent[q]) {
          if (q == root) { print p; break }
        }
      }
    }'
}

# macOS: 2 s of samples of pid $1, every thread, symbolicated. Node's release
# binaries use the hardened runtime, which can refuse an unprivileged sampler;
# hosted runners have passwordless sudo for the retry. Whether the first try
# worked is judged by its output, not its exit status: `sample` is not
# documented to exit non-zero when it can only print "cannot examine process
# ... try running with sudo", and a missed retry loses the one stack this
# script exists to capture. A real report always has a "Call graph:" section.
sample_stack() {
  local out status=0
  out=$(sample "$1" 2 -mayDie 2>&1) || status=$?
  printf '%s\n' "$out"
  if [ "$status" -ne 0 ] || ! grep -q 'Call graph:' <<<"$out"; then
    echo "hang-watchdog: unprivileged sample gave no call graph (exit $status); retrying with sudo -n"
    sudo -n sample "$1" 2 -mayDie 2>&1
  fi
}

diagnose() {
  echo "::group::hang-watchdog: process table"
  ps -axo pid,ppid,pgid,etime,stat,%cpu,command 2>/dev/null || ps -ef || ps
  echo "::endgroup::"
  local p
  for p in $(descendants "$pid"); do
    echo "::group::hang-watchdog: stack of pid $p ($(ps -o command= -p "$p" 2>/dev/null))"
    if command -v sample >/dev/null 2>&1; then
      sample_stack "$p" | sed -n '1,400p'
    elif [ -r "/proc/$p/status" ]; then
      grep -E '^(State|Threads):' "/proc/$p/status"
      for t in /proc/"$p"/task/*; do
        echo "thread ${t##*/}: wchan=$(cat "$t/wchan" 2>/dev/null) $(cat "$t/stat" 2>/dev/null | awk '{print "state=" $3}')"
        cat "$t/stack" 2>/dev/null | sed 's/^/    /'
      done
    else
      echo "(no stack sampler on this platform)"
    fi
    echo "::endgroup::"
  done
}

start=$SECONDS
while kill -0 "$pid" 2>/dev/null; do
  if [ $((SECONDS - start)) -ge "$deadline" ]; then
    echo "::error title=hang-watchdog::'$*' still running after ${deadline}s; dumping processes and killing it (see #544)"
    diagnose
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
    sleep 5
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    exit 124
  fi
  sleep 1
done

wait "$pid"
