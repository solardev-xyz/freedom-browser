#!/usr/bin/env bash
#
# Re-run the failed jobs of one CI/Release run — once, and only once.
#
# GitHub Actions has no native "retry a failed job", so a transient failure
# (a flaky Electron launch, a runner losing its network, a job hanging until
# `timeout-minutes` kills it) needs a human to open the run and press "Re-run
# failed jobs". This script is that press, driven by
# `.github/workflows/auto-retry.yml` on the `workflow_run` event.
#
# The rules, and why:
#
#   - Only `failure`, `cancelled` and `timed_out` runs. A job that hits
#     `timeout-minutes` reports as *cancelled* today (verified on run
#     35130040315), and a hang is exactly the case worth retrying; `timed_out`
#     is accepted alongside it because it is the conclusion the REST API
#     documents for that state and nothing but the accept-list decides whether
#     a hang is absorbed.
#   - Only `run_attempt == 1`. A run that fails twice is a real signal; a
#     retry loop would hide it and burn runner minutes.
#   - Not when a newer run for the same workflow, branch and event already
#     exists. `ci.yml` sets `cancel-in-progress` for every ref but `main`, so
#     the most common way to see a *cancelled* run here is a second push
#     superseding the first — resurrecting that run would re-test an
#     already-obsolete commit, and its attempt 2 would cancel the newer run
#     through the same concurrency group. Two checks: the newest run listed
#     for the branch, and — because that listing has lagged a newer run by a
#     minute or two — any job GitHub annotated "Canceling since a higher
#     priority waiting request … exists" (#535).
#   - `main` is retried like any other branch: `main` went red from a hang on
#     2026-09-16, which is precisely what this exists to absorb.
#   - One log line either way, naming the run URL and the jobs re-run. No PR
#     comments, no issues: the signal belongs on the run, not in someone's
#     notifications.
#   - Before re-running, one more line per job saying *why* it failed: the step
#     that failed (or "never started" when a job has no steps — a runner that
#     was never acquired, #535) and the job's failure annotation. Attempt 2
#     replaces attempt 1's log, but check-run annotations and this run's own
#     log and step summary survive, so this is the one durable record of what
#     flaked. `scripts/ci/flake-report.js` reads it back out across runs.
#     Needs `jq` (preinstalled on GitHub's Ubuntu runners); without it the
#     reasons and the annotation-based superseded check are simply skipped.
#
# Known limitation: a run a human cancelled on purpose looks identical to a
# timed-out one in the event payload, so it will be re-run once. Cancelling the
# second attempt sticks, since attempt 2 is never retried.
#
# Env (all supplied by the workflow):
#   GH_TOKEN      token with `actions: write`
#   GH_REPO       owner/name
#   RUN_ID, RUN_URL, RUN_ATTEMPT, CONCLUSION, WORKFLOW_ID, WORKFLOW_NAME,
#   HEAD_BRANCH, EVENT_NAME

set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN must be set}"
REPO="${GH_REPO:?GH_REPO must be set (owner/name)}"
RUN_ID="${RUN_ID:?RUN_ID must be set}"
RUN_URL="${RUN_URL:?RUN_URL must be set}"
RUN_ATTEMPT="${RUN_ATTEMPT:?RUN_ATTEMPT must be set}"
CONCLUSION="${CONCLUSION:?CONCLUSION must be set}"
WORKFLOW_ID="${WORKFLOW_ID:?WORKFLOW_ID must be set}"
WORKFLOW_NAME="${WORKFLOW_NAME:-workflow}"
HEAD_BRANCH="${HEAD_BRANCH:?HEAD_BRANCH must be set}"
EVENT_NAME="${EVENT_NAME:?EVENT_NAME must be set}"

log() { printf 'auto-retry: %s\n' "$*"; }

case "$CONCLUSION" in
  failure | cancelled | timed_out) ;;
  *)
    log "$WORKFLOW_NAME run $RUN_ID concluded '$CONCLUSION' — nothing to re-run. $RUN_URL"
    exit 0
    ;;
esac

if [ "$RUN_ATTEMPT" != "1" ]; then
  log "$WORKFLOW_NAME run $RUN_ID is attempt $RUN_ATTEMPT — a second failure is a real signal, leaving it red. $RUN_URL"
  exit 0
fi

# A newer run for the same workflow/branch/event means this one was superseded
# (the concurrency group cancels the older run), not that it broke.
latest_run_id="$(
  gh api --method GET "repos/$REPO/actions/workflows/$WORKFLOW_ID/runs" \
    -f branch="$HEAD_BRANCH" -f event="$EVENT_NAME" -f per_page=1 \
    --jq '.workflow_runs[0].id // empty'
)"
if [ -n "$latest_run_id" ] && [ "$latest_run_id" != "$RUN_ID" ]; then
  log "$WORKFLOW_NAME run $RUN_ID was superseded by run $latest_run_id on $HEAD_BRANCH — not re-running an obsolete commit. $RUN_URL"
  exit 0
fi

# One TSV row per failed job: id, name, conclusion, first failed step (or
# "never started" for a job with no steps at all).
failed_rows="$(
  gh api --paginate "repos/$REPO/actions/runs/$RUN_ID/attempts/1/jobs?per_page=100" \
    --jq '.jobs[] | select(.conclusion == "failure" or .conclusion == "cancelled" or .conclusion == "timed_out")
      | [.id, .name, .conclusion,
         (if (.steps | length) == 0 then "never started"
          else ([.steps[] | select(.conclusion == "failure" or .conclusion == "cancelled" or .conclusion == "timed_out") | .name][0] // "unknown step") end)]
      | @tsv'
)"
failed_jobs="$(printf '%s\n' "$failed_rows" | cut -f2 | sed '/^$/d')"
if [ -z "$failed_jobs" ]; then
  log "$WORKFLOW_NAME run $RUN_ID has no failed, cancelled or timed-out jobs on attempt 1 — nothing to re-run. $RUN_URL"
  exit 0
fi

job_count="$(printf '%s\n' "$failed_jobs" | wc -l | tr -d ' ')"
job_list="$(printf '%s\n' "$failed_jobs" | paste -sd '|' -)"
# Why each job failed. Attempt 2 replaces attempt 1's log, so this is the one
# record of it that survives. Best effort: a lookup that fails must never stop
# the re-run below, so every call here is guarded. The reason preferred is the
# failing test's title from Playwright's `github` reporter, then any runner
# message other than the generic "Process completed with exit code N".
# The reporter annotates a test that passed on a Playwright retry ("flaky")
# exactly like one that failed; only the run summary notice tells them apart
# ("  1 failed\n    <title> ───\n  1 flaky\n    <title> ───"), so titles it
# lists under "flaky" are left out: they did not fail this job — unless some
# summary in the same job (Playwright run twice, `--repeat-each`) also lists
# the title as failed or interrupted. Mirrors summaryFlakyTitles() in
# scripts/ci/flake-report.js.
REASON_JQ='[.[] | select(.annotation_level == "notice" and ((.title // "") | contains("Playwright Run Summary")))
    | .message | split("\n")
    | reduce .[] as $l ({s: null, t: []};
        (($l | capture("^\\s*\\d+ (?<s>failed|interrupted|flaky|skipped|did not run|passed|errors? (was|were) not)\\b")) // null) as $h
        | if $h then .s = $h.s
          elif (.s == "flaky" or .s == "failed" or .s == "interrupted") and ($l | test("\\S"))
          then .t += [{s: (if .s == "flaky" then "flaky" else "failed" end),
                       t: ($l | sub("[\\s─]+$"; "") | sub("^\\s+"; ""))}]
          else . end)
    | .t[]] as $listed
  | ([$listed[] | select(.s == "failed") | .t]) as $failedTitles
  | [$listed[] | select(.s == "flaky") | .t | select(. as $t | any($failedTitles[]; . == $t) | not)] as $flaky
  | [.[] | select(.annotation_level == "failure")
      | select((.title // "") as $t | any($flaky[]; . == $t) | not)] as $f
  | ([$f[] | select((.title // "") | contains("›")) | .title] | unique) as $tests
  | if ($tests | length) > 0 then ($tests | join(" ; "))
    else ([$f[] | select(.message | startswith("Process completed with exit code") | not) | .message]
          + [$f[] | .message])[0] // "" end
  | gsub("[\\r\\n|]+"; " ")'
# GitHub's own note on a job its concurrency group cancelled for a newer run.
SUPERSEDED_JQ='[.[] | select(.annotation_level == "failure") | .message
  | select(test("higher priority waiting request"))][0] // ""'
job_lines=""
summary_rows=""
superseded_note=""
while IFS=$'\t' read -r job_id job_name job_conclusion job_step; do
  [ -n "$job_id" ] || continue
  annotations="$(gh api "repos/$REPO/check-runs/$job_id/annotations?per_page=100" 2>/dev/null || true)"
  reason="$(printf '%s' "${annotations:-[]}" | jq -r "$REASON_JQ" 2>/dev/null || true)"
  reason="${reason:0:300}"
  if [ -z "$superseded_note" ]; then
    superseded_note="$(printf '%s' "${annotations:-[]}" | jq -r "$SUPERSEDED_JQ" 2>/dev/null || true)"
  fi
  job_lines+="failed job: $job_name — $job_conclusion at step '$job_step'${reason:+ — $reason}"$'\n'
  summary_rows+="| $job_name | $job_conclusion | $job_step | ${reason:-—} |"$'\n'
done <<<"$failed_rows"

summary() {
  [ -n "${GITHUB_STEP_SUMMARY:-}" ] || return 0
  {
    printf '### %s [%s run %s](%s)\n\n' "$1" "$WORKFLOW_NAME" "$RUN_ID" "$RUN_URL"
    printf 'Branch `%s`, event `%s`, attempt 1 concluded `%s`.\n\n' "$HEAD_BRANCH" "$EVENT_NAME" "$CONCLUSION"
    printf '| Job | Conclusion | Failed step | Annotation |\n|---|---|---|---|\n%s\n' "$summary_rows"
  } >>"$GITHUB_STEP_SUMMARY" || true
}

# The newest-run lookup above can miss a run that already exists: the
# filtered listing has been seen lagging a newer run by 1-2 minutes, and five
# times between 2026-09-28 and 2026-10-05 this script re-ran a superseded run,
# whose attempt 2 then cancelled the newer run through the same concurrency
# group, which got re-run in turn (#535). A job cancelled for "a higher
# priority waiting request" is GitHub saying outright that a newer run exists.
if [ -n "$superseded_note" ]; then
  log "$WORKFLOW_NAME run $RUN_ID was superseded: its concurrency group cancelled it (\"$superseded_note\") — not re-running an obsolete commit. $RUN_URL"
  printf '%s' "$job_lines" | while IFS= read -r line; do log "$line"; done
  summary "Not re-running, superseded:"
  exit 0
fi

log "re-running $job_count job(s) from $WORKFLOW_NAME run $RUN_ID ($CONCLUSION on attempt 1, branch $HEAD_BRANCH, event $EVENT_NAME): $job_list"
printf '%s' "$job_lines" | while IFS= read -r line; do log "$line"; done
summary "Re-ran $job_count job(s) of"

gh run rerun "$RUN_ID" --failed
log "attempt 2 queued for $WORKFLOW_NAME run $RUN_ID — $RUN_URL"
