#!/usr/bin/env node
//
// What flaked in CI over the last N days (#535), as Markdown on stdout.
//
// Two sources, both of which outlive the job logs:
//
//   1. Runs `auto-retry.yml` re-ran. Attempt 2's log replaces attempt 1's, so
//      the evidence left is the attempt-1 job list (which job, which step, or
//      no steps at all when no runner ever picked the job up) and each job's
//      check-run annotations. Only runs whose attempt 2 was started by
//      `github-actions[bot]` (auto-retry's GITHUB_TOKEN) count: a human pressing
//      "Re-run" is not a flake signal, and attempt 3+ is always a human, since
//      auto-retry never re-runs an attempt 2. Attempt 1 is compared against
//      attempt 2, the retry auto-retry actually made.
//   2. Tests Playwright itself retried. `playwright.config.js` adds the
//      `github` reporter on Actions, which writes an error annotation for every
//      test that failed *or* passed only on a retry (`flaky`). A green job that
//      carries such an annotation hid a flake that auto-retry never saw.
//
// Usage:
//   node scripts/ci/flake-report.js [--days 7] [--max-calls 800] [--repo owner/name]
//
// `--max-calls` caps every REST call the report makes, each page of a
// paginated listing included. Both halves walk newest runs first and stop
// cleanly when the budget (or the token's remaining rate limit) runs out, and a
// failing API call stops only the half it happened in: whatever was gathered is
// still rendered, with a note saying where and why it stopped short.
//
// Needs `gh` authenticated with `actions: read` and `checks: read`.
// `.github/workflows/flake-report.yml` runs it weekly into its step summary.

const { execFileSync } = require('child_process');

const WORKFLOWS = ['ci.yml', 'release.yml'];
// A clean Playwright job has exactly one annotation: the github reporter's
// "Playwright Run Summary" notice. Anything above that is worth fetching.
const PLAYWRIGHT_BASELINE_ANNOTATIONS = 1;
// Jobs that run Playwright: every `e2e-*` job, `myotis-native-e2e`, and
// release.yml's `smoke-*` legs. Only these are worth an annotations call.
const PLAYWRIGHT_JOB = /e2e|smoke/i;
// The workflow's GITHUB_TOKEN gets 1,000 REST calls an hour, per repository,
// shared with every other workflow using it (auto-retry.yml among them). One
// budget covers every call, each page counted; the retry half (about 4 calls
// per re-run run, ~75 runs a week as of #535) spends it first, being the
// rarer signal, and the Playwright half gets what is left. The budget is also
// clamped to what `gh api rate_limit` (itself free) says is remaining.
const DEFAULT_MAX_CALLS = 800;
const RATE_LIMIT_RESERVE = 50;
// The actor GitHub records for a re-run made with a workflow's GITHUB_TOKEN —
// that is, by auto-retry.yml.
const AUTO_RETRY_ACTOR = 'github-actions[bot]';

function parseArgs(argv) {
  const opts = {
    days: 7,
    maxCalls: DEFAULT_MAX_CALLS,
    repo: process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '',
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--days') opts.days = Number(argv[++i]);
    else if (argv[i] === '--max-calls') opts.maxCalls = Number(argv[++i]);
    else if (argv[i] === '--repo') opts.repo = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!Number.isFinite(opts.days) || opts.days <= 0)
    throw new Error('--days must be a positive number');
  if (!Number.isInteger(opts.maxCalls) || opts.maxCalls <= 0)
    throw new Error('--max-calls must be a positive integer');
  if (!/^[^/\s]+\/[^/\s]+$/.test(opts.repo))
    throw new Error('--repo owner/name (or GH_REPO) is required');
  return opts;
}

class BudgetExhausted extends Error {}

// Every REST call goes through one of these, so every page is counted.
// `fetchPages(path, charge)` returns the parsed pages of one (paginated) GET
// and calls `charge(n)` for any call it made beyond those pages (a retry).
function createBudget(limit, fetchPages) {
  let used = 0;
  const charge = (n) => {
    used += n;
  };
  return {
    get used() {
      return used;
    },
    get limit() {
      return limit;
    },
    // Each page of `path`, as parsed JSON; `pick` maps one page to its items.
    get(path, pick = (page) => page) {
      if (used >= limit) throw new BudgetExhausted(`API call budget of ${limit} spent`);
      const pages = fetchPages(path, charge);
      used += Math.max(1, pages.length);
      return pages.flatMap((page) => pick(page));
    },
  };
}

// `--slurp` wraps every page in one array, so the page count is known. A
// 5xx is retried once (a live run hit a lone HTTP 502 mid-scan); anything
// else, a 403 rate limit included, is final.
function ghPages(path, charge = () => {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return JSON.parse(
        execFileSync('gh', ['api', '--paginate', '--slurp', path], {
          encoding: 'utf8',
          maxBuffer: 256 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      );
    } catch (err) {
      // gh's own stderr ("API rate limit exceeded … (HTTP 403)") says why.
      const why = String(err.stderr || '').trim() || err.message;
      if (attempt === 1 && /\(HTTP 5\d\d\)/.test(why)) {
        charge(1);
        continue;
      }
      throw new Error(`${path.split('?')[0]}: ${why}`, { cause: err });
    }
  }
}

function ghRemaining() {
  try {
    const out = execFileSync('gh', ['api', 'rate_limit', '--jq', '.resources.core.remaining'], {
      encoding: 'utf8',
    });
    const n = Number(out.trim());
    return Number.isFinite(n) ? n : Infinity;
  } catch {
    return Infinity;
  }
}

// Runs `work(run)` for each run, newest first, keeping the rows of every run
// it finished. A spent budget or a failing call ends the walk there; what
// was gathered is kept and the reason returned, so one bad call cannot cost
// the whole report.
function walkRuns(runs, work) {
  const rows = [];
  let scanned = 0;
  let stopped = null;
  for (const run of [...runs].sort((a, b) => b.id - a.id)) {
    try {
      rows.push(...work(run));
    } catch (err) {
      stopped = err instanceof BudgetExhausted ? 'budget' : oneLine(err.message);
      break;
    }
    scanned++;
  }
  return { rows, scanned, stopped };
}

function failedStep(job) {
  if (!job.steps || job.steps.length === 0) return 'never started';
  const step = job.steps.find((s) => ['failure', 'cancelled', 'timed_out'].includes(s.conclusion));
  return step ? step.name : 'unknown step';
}

const FAILED = new Set(['failure', 'cancelled', 'timed_out']);
// ci.yml's `ci-ok` only reports whether the others passed; it fails whenever
// any of them did, so counting it would double every row.
const AGGREGATE_JOBS = new Set(['ci-ok']);

// Tests Playwright's run summary lists as flaky (failed, then passed on a
// retry). The github reporter writes a failure annotation for those exactly as
// for a test that really failed, titled the same way, so in a *failed* job the
// summary notice is the only place that tells the two apart:
//
//     "  1 failed\n    [harness] › a.spec.js:4:1 › x ───…\n  1 flaky\n    [harness] › …"
//
// A job can run Playwright more than once, so every summary counts — and the
// same test can be flaky in one invocation and really fail in another (two
// runs over one spec, `--repeat-each`). A title any summary lists as failed or
// interrupted is not "only flaky", so it stays out of this set and its failure
// annotation still names the cause.
const SUMMARY_SECTION =
  /^\s*\d+ (failed|interrupted|flaky|skipped|did not run|passed|errors? (?:was|were) not)\b/;
function summaryFlakyTitles(annotations) {
  const flaky = new Set();
  const failed = new Set();
  for (const a of annotations) {
    if (a.annotation_level !== 'notice' || !(a.title || '').includes('Playwright Run Summary'))
      continue;
    let section = null;
    for (const line of String(a.message || '').split('\n')) {
      const header = SUMMARY_SECTION.exec(line);
      if (header) section = header[1];
      else if (!line.trim()) continue;
      else if (section === 'flaky') flaky.add(summaryTitle(line));
      else if (section === 'failed' || section === 'interrupted') failed.add(summaryTitle(line));
    }
  }
  for (const title of failed) flaky.delete(title);
  return flaky;
}

function summaryTitle(line) {
  return line.replace(/[\s\u2500]+$/, '').trim();
}

// Short, stable cause for one failed job, from its failed step and its
// failure annotations. Playwright's github reporter titles its annotation with
// the test ("[harness] › test-e2e/x.spec.js:12:3 › describe › title"); GitHub's
// own runner annotations carry the message instead. Order matters: a job its
// concurrency group cancelled says so even when it had started a test step.
function causeOf({ step, annotations }) {
  // A test that passed on a Playwright retry did not fail the job: naming it
  // would blame it and split one cause into many ranking keys.
  const flaky = summaryFlakyTitles(annotations);
  const failures = annotations.filter(
    (a) => a.annotation_level === 'failure' && !flaky.has(a.title)
  );
  const superseded = failures.find((a) => /higher priority waiting request/.test(a.message));
  if (superseded) return { kind: 'superseded', label: 'cancelled for a newer run' };
  const tests = [...new Set(failures.map((a) => a.title).filter((t) => t && t.includes('›')))];
  if (tests.length) return { kind: 'test', label: tests.join(' ; ') };
  const runner = failures.find((a) =>
    /not acquired by Runner|lost communication|runner .* shutdown/i.test(a.message)
  );
  if (runner) return { kind: 'infra', label: `runner: ${oneLine(runner.message)}` };
  // No steps and no runner message: the run was cancelled while this job was
  // still queued, which is not something the job did.
  if (step === 'never started') return { kind: 'cancelled', label: 'cancelled before it started' };
  // Anchored: "Run find + … + downloads E2E" is a test step, not a download.
  if (/^(install|set up|check ?out|download|restore|cache)\b/i.test(step)) {
    return { kind: 'infra', label: `step: ${step}` };
  }
  const exceeded = failures.find((a) => /exceeded the maximum execution time/i.test(a.message));
  if (exceeded) return { kind: 'hang', label: `${step}: ${oneLine(exceeded.message)}` };
  // The jest job prints `::error::[npm-ci-hardening] …` from that script's own
  // unit tests; outside an install step those are output, not the cause.
  const other = failures.find(
    (a) =>
      !/^Process completed with exit code/.test(a.message) &&
      !/^\[npm-ci-hardening\]/.test(a.message)
  );
  return { kind: 'unknown', label: `${step}${other ? `: ${oneLine(other.message)}` : ''}` };
}

function oneLine(text) {
  return String(text || '')
    .split('\n')[0]
    .replace(/\|/g, '\\|')
    .slice(0, 160);
}

// Tests the github reporter flagged in a job that still ended green: those
// passed on a Playwright retry.
function flakyTestsOf(annotations) {
  return [
    ...new Set(
      annotations
        .filter((a) => a.annotation_level === 'failure' && a.title && a.title.includes('›'))
        .map((a) => a.title)
    ),
  ];
}

function rank(rows, keyOf) {
  const counts = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    const entry = counts.get(key) || { key, count: 0, examples: [] };
    entry.count++;
    if (entry.examples.length < 3) entry.examples.push(row.url);
    counts.set(key, entry);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function render({
  days,
  since,
  runsScanned,
  retried,
  flaky,
  retriedRuns = null,
  flakyRunsScanned = runsScanned,
  flakyWhy = 'API call budget',
  manualReruns = 0,
}) {
  const out = [];
  out.push(`## CI flake report — last ${days} day(s), since ${since}`, '');
  out.push(
    `Scanned ${runsScanned} CI/Release run(s). ${retried.length} job(s) failed on attempt 1 of a run ` +
      `auto-retry re-ran; ${flaky.length} green job(s) carried a test Playwright passed only on retry.`,
    ''
  );
  if (manualReruns > 0) {
    out.push(
      `${manualReruns} run(s) re-run by a person, not by auto-retry, are left out of the first table.`,
      ''
    );
  }
  if (retriedRuns && retriedRuns.scanned < retriedRuns.total) {
    out.push(
      `Auto-retried runs: only the newest ${retriedRuns.scanned} of ${retriedRuns.total} were read ` +
        `(${retriedRuns.why}).`,
      ''
    );
  }
  if (flakyRunsScanned < runsScanned) {
    out.push(
      `Playwright retries: only the newest ${flakyRunsScanned} of ${runsScanned} runs were scanned ` +
        `(${flakyWhy}); re-run locally with a larger \`--max-calls\` for the rest.`,
      ''
    );
  }
  out.push('### Ranked: jobs that needed an auto-retry', '');
  if (retried.length === 0) out.push('None.', '');
  else {
    out.push('| # | Kind | Job · cause | Attempt 2 | Runs |', '|---|---|---|---|---|');
    rank(retried, (r) => `${r.kind}\u0000${r.job}\u0000${r.cause}\u0000${r.retry}`).forEach((e) => {
      const [kind, job, cause, retry] = e.key.split('\u0000');
      out.push(
        `| ${e.count} | ${kind} | \`${job}\` · ${cause} | ${retry} | ${e.examples.map((u, i) => `[${i + 1}](${u})`).join(' ')} |`
      );
    });
    out.push('');
  }
  out.push('### Ranked: tests that passed only on a Playwright retry', '');
  if (flaky.length === 0) out.push('None.', '');
  else {
    out.push('| # | Test | Job | Runs |', '|---|---|---|---|');
    rank(flaky, (r) => `${r.test}\u0000${r.job}`).forEach((e) => {
      const [test, job] = e.key.split('\u0000');
      out.push(
        `| ${e.count} | ${test.replace(/\|/g, '\\|')} | \`${job}\` | ${e.examples.map((u, i) => `[${i + 1}](${u})`).join(' ')} |`
      );
    });
    out.push('');
  }
  return out.join('\n');
}

function stopReason(stopped, budget) {
  return stopped === 'budget'
    ? `API call budget of ${budget.limit} spent`
    : `API error: ${stopped}`;
}

// The auto-retry half for one re-run run: attempt 1's failed jobs, why each
// failed, and how the same job did on attempt 2. `actor` is who started
// attempt 2.
function retriedRowsOf(api, repo, run) {
  const first = api.get(
    `${repo}/actions/runs/${run.id}/attempts/1/jobs?per_page=100`,
    (p) => p.jobs
  );
  const second = api.get(
    `${repo}/actions/runs/${run.id}/attempts/2/jobs?per_page=100`,
    (p) => p.jobs
  );
  const rows = [];
  for (const job of first.filter((j) => FAILED.has(j.conclusion) && !AGGREGATE_JOBS.has(j.name))) {
    const annotations = api.get(`${repo}/check-runs/${job.id}/annotations?per_page=100`);
    const step = failedStep(job);
    const cause = causeOf({ step, annotations });
    const again = second.find((j) => j.name === job.name);
    rows.push({
      job: job.name,
      kind: cause.kind,
      cause: cause.label,
      retry: again ? again.conclusion || again.status : 'not re-run',
      url: job.html_url || run.html_url,
    });
  }
  return rows;
}

// Who started attempt 2. The run listing carries the *latest* attempt's
// actor, which is attempt 2's only when there is no attempt 3.
function attempt2Actor(api, repo, run) {
  if (run.run_attempt === 2) return run.actor;
  const [attempt] = api.get(`${repo}/actions/runs/${run.id}/attempts/2`, (p) => [p]);
  return attempt && attempt.triggering_actor ? attempt.triggering_actor.login : '';
}

function flakyRowsOf(api, repo, run) {
  const checks = api.get(
    `${repo}/check-suites/${run.check_suite_id}/check-runs?per_page=100`,
    (p) => p.check_runs
  );
  const rows = [];
  for (const check of checks.filter(
    (c) =>
      c.conclusion === 'success' &&
      PLAYWRIGHT_JOB.test(c.name) &&
      c.output.annotations_count > PLAYWRIGHT_BASELINE_ANNOTATIONS
  )) {
    const annotations = api.get(`${repo}/check-runs/${check.id}/annotations?per_page=100`);
    for (const test of flakyTestsOf(annotations))
      rows.push({ test, job: check.name, url: check.html_url });
  }
  return rows;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const since = new Date(Date.now() - opts.days * 86_400_000).toISOString().slice(0, 10);
  const repo = `repos/${opts.repo}`;
  const remaining = ghRemaining() - RATE_LIMIT_RESERVE;
  const api = createBudget(Math.max(0, Math.min(opts.maxCalls, remaining)), ghPages);

  // Without the run list there is nothing to report; let that one throw.
  const runs = WORKFLOWS.flatMap((wf) =>
    api
      .get(
        `${repo}/actions/workflows/${wf}/runs?created=>=${since}&per_page=100`,
        (p) => p.workflow_runs
      )
      .map((r) => ({
        id: r.id,
        run_attempt: r.run_attempt,
        check_suite_id: r.check_suite_id,
        html_url: r.html_url,
        actor: r.triggering_actor ? r.triggering_actor.login : '',
      }))
  );

  let manualReruns = 0;
  const rerun = runs.filter((r) => r.run_attempt >= 2);
  const retriedWalk = walkRuns(rerun, (run) => {
    if (attempt2Actor(api, repo, run) !== AUTO_RETRY_ACTOR) {
      manualReruns++;
      return [];
    }
    return retriedRowsOf(api, repo, run);
  });
  const flakyWalk = walkRuns(runs, (run) => flakyRowsOf(api, repo, run));

  const incomplete = [retriedWalk.stopped, flakyWalk.stopped].some((s) => s && s !== 'budget');
  process.stdout.write(
    render({
      days: opts.days,
      since,
      runsScanned: runs.length,
      retried: retriedWalk.rows,
      flaky: flakyWalk.rows,
      retriedRuns: {
        scanned: retriedWalk.scanned,
        total: rerun.length,
        why: retriedWalk.stopped && stopReason(retriedWalk.stopped, api),
      },
      flakyRunsScanned: flakyWalk.scanned,
      flakyWhy: flakyWalk.stopped ? stopReason(flakyWalk.stopped, api) : undefined,
      manualReruns,
    }) + `\n_${api.used} API call(s) of a ${api.limit} budget._\n`
  );
  // The report above is already written; a failed call still fails the run.
  if (incomplete) {
    console.error('flake-report: an API call failed; the report above is partial');
    process.exitCode = 1;
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`flake-report: ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  parseArgs,
  failedStep,
  causeOf,
  summaryFlakyTitles,
  flakyTestsOf,
  rank,
  render,
  createBudget,
  walkRuns,
  BudgetExhausted,
  attempt2Actor,
  AUTO_RETRY_ACTOR,
};
