/**
 * scripts/ci/flake-report.js (#535): the classification and ranking helpers,
 * and the whole script against a fake `gh` on PATH.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseArgs,
  failedStep,
  causeOf,
  summaryFlakyTitles,
  flakyTestsOf,
  render,
  createBudget,
  walkRuns,
  BudgetExhausted,
  attempt2Actor,
} = require('./flake-report');

const failure = (message, title = '') => ({ annotation_level: 'failure', message, title });

// Verbatim (bar the decoded %0A) from Playwright 1.63's github reporter, for a
// spec with one test failing all 3 tries and one passing on retry #1.
const REAL = '[harness] › a.spec.js:2:1 › really fails';
const FLAKY = '[harness] › a.spec.js:3:1 › flaky one';
const SUMMARY = {
  annotation_level: 'notice',
  title: '🎭 Playwright Run Summary',
  message:
    `  1 failed\n    ${REAL} ${'─'.repeat(55)}\n` +
    `  1 flaky\n    ${FLAKY} ${'─'.repeat(58)}\n` +
    '  1 passed (1.8s)',
};

describe('failedStep', () => {
  test('a job with no steps never reached a runner', () => {
    expect(failedStep({ steps: [] })).toBe('never started');
  });

  test('names the first failed, cancelled or timed-out step', () => {
    const steps = [
      { name: 'Install dependencies', conclusion: 'success' },
      { name: 'Run E2E', conclusion: 'cancelled' },
      { name: 'Upload', conclusion: 'failure' },
    ];
    expect(failedStep({ steps })).toBe('Run E2E');
  });
});

describe('causeOf', () => {
  test('a Playwright annotation names the test, ahead of the exit-code line', () => {
    const cause = causeOf({
      step: 'Run tabs E2E',
      annotations: [
        failure('Process completed with exit code 1.'),
        failure(
          'Error: boom',
          '[harness] › test-e2e/tabs.spec.js:163:1 › clicking a tab activates it'
        ),
      ],
    });
    expect(cause).toEqual({
      kind: 'test',
      label: '[harness] › test-e2e/tabs.spec.js:163:1 › clicking a tab activates it',
    });
  });

  test('a job no runner acquired is infra, not a hang (#535)', () => {
    const cause = causeOf({
      step: 'never started',
      annotations: [
        failure('The job was not acquired by Runner of type hosted even after multiple attempts'),
      ],
    });
    expect(cause.kind).toBe('infra');
    expect(cause.label).toMatch(/^runner: The job was not acquired by Runner/);
  });

  test('a job its concurrency group cancelled is superseded, even mid-test', () => {
    const cause = causeOf({
      step: 'Run tabs E2E',
      annotations: [
        failure(
          'Canceling since a higher priority waiting request for ci-CI-refs/pull/523/merge exists'
        ),
      ],
    });
    expect(cause).toEqual({ kind: 'superseded', label: 'cancelled for a newer run' });
  });

  test('no steps and no runner message: cancelled while queued, not infra', () => {
    expect(causeOf({ step: 'never started', annotations: [] })).toEqual({
      kind: 'cancelled',
      label: 'cancelled before it started',
    });
  });

  test('a test step that merely mentions downloads is not an infra step', () => {
    const cause = causeOf({
      step: 'Run find + tab-mute + downloads E2E',
      annotations: [failure('Process completed with exit code 1.')],
    });
    expect(cause.kind).toBe('unknown');
  });

  test("npm-ci-hardening's own test output is neither a hang nor the cause", () => {
    const cause = causeOf({
      step: 'Run test coverage',
      annotations: [
        failure(
          '[npm-ci-hardening] npm ci failed after 3 attempts. ... A run of timeouts points at the registry'
        ),
        failure('Process completed with exit code 1.'),
      ],
    });
    expect(cause).toEqual({ kind: 'unknown', label: 'Run test coverage' });
  });

  test('a failed install step is infra', () => {
    const cause = causeOf({
      step: 'Install dependencies',
      annotations: [failure('Process completed with exit code 1.')],
    });
    expect(cause).toEqual({ kind: 'infra', label: 'step: Install dependencies' });
  });

  test('a test step that ran out of time is a hang', () => {
    const cause = causeOf({
      step: 'Run E2E',
      annotations: [
        failure(
          'The job running on runner X has exceeded the maximum execution time of 15 minutes.'
        ),
      ],
    });
    expect(cause.kind).toBe('hang');
  });

  // R1-M3: the github reporter annotates a test that passed on a retry like
  // one that failed; it must neither share the blame nor split the key.
  test('a test that passed on a Playwright retry is not the cause', () => {
    const cause = causeOf({
      step: 'Run tabs E2E',
      annotations: [
        failure('Process completed with exit code 1.'),
        failure('1) ... Error: x', REAL),
        failure('1) ... Retry #1', REAL),
        failure('1) ... Retry #2', REAL),
        failure('2) ... Error: y', FLAKY),
        SUMMARY,
      ],
    });
    expect(cause).toEqual({ kind: 'test', label: REAL });
  });

  test('a job whose only test annotations are flaky falls through to its step', () => {
    const cause = causeOf({
      step: 'Run tabs E2E',
      annotations: [
        failure('Process completed with exit code 1.'),
        failure('2) ... y', FLAKY),
        SUMMARY,
      ],
    });
    expect(cause).toEqual({ kind: 'unknown', label: 'Run tabs E2E' });
  });

  // R2-M1: Playwright run twice over one spec in a job — flaky in one
  // summary, really failed in the other — still names the test.
  test('a test flaky in one summary but failed in another is still the cause', () => {
    const other = {
      ...SUMMARY,
      message: `  1 failed\n    ${FLAKY} ${'─'.repeat(9)}\n  2 passed (1.1s)`,
    };
    const cause = causeOf({
      step: 'Run harness E2E',
      annotations: [
        failure('Process completed with exit code 1.'),
        failure('2) ... y', FLAKY),
        SUMMARY,
        other,
      ],
    });
    expect(cause).toEqual({ kind: 'test', label: FLAKY });
  });

  test('otherwise the step and the first non-generic message', () => {
    const cause = causeOf({
      step: 'Run unit tests',
      annotations: [failure('Process completed with exit code 1.'), failure('jest: 1 failed | x')],
    });
    expect(cause).toEqual({ kind: 'unknown', label: 'Run unit tests: jest: 1 failed \\| x' });
  });
});

describe('summaryFlakyTitles', () => {
  test('reads only the flaky section, across every summary in the job', () => {
    const second = {
      ...SUMMARY,
      message: `  1 flaky\n    [x] › b.spec.js:1:1 › b ${'─'.repeat(9)}`,
    };
    expect([...summaryFlakyTitles([SUMMARY, failure('x', REAL), second])]).toEqual([
      FLAKY,
      '[x] › b.spec.js:1:1 › b',
    ]);
  });

  test('a title another summary lists as failed or interrupted is not flaky', () => {
    const failedHere = { ...SUMMARY, message: `  1 failed\n    ${FLAKY} ${'─'.repeat(9)}` };
    const interrupted = {
      ...SUMMARY,
      message:
        `  1 interrupted\n    [x] › b.spec.js:1:1 › b\n` +
        `  1 flaky\n    [x] › b.spec.js:1:1 › b ${'─'.repeat(9)}`,
    };
    expect([...summaryFlakyTitles([SUMMARY, failedHere, interrupted])]).toEqual([]);
  });

  test('no summary, no flaky titles', () => {
    expect(summaryFlakyTitles([failure('x', REAL)]).size).toBe(0);
  });
});

describe('flakyTestsOf', () => {
  test('keeps test-titled failure annotations, once each', () => {
    const t = '[harness] › test-e2e/a.spec.js:1:1 › a';
    expect(
      flakyTestsOf([
        failure('first try', t),
        failure('second try', t),
        { annotation_level: 'notice', title: '🎭 Playwright Run Summary', message: '1 flaky' },
        { annotation_level: 'warning', title: 'Slow Test', message: 'x took 3m' },
      ])
    ).toEqual([t]);
  });
});

describe('render', () => {
  test('ranks by count and links example runs', () => {
    const md = render({
      days: 7,
      since: '2026-09-28',
      runsScanned: 10,
      flakyRunsScanned: 4,
      retried: [
        {
          kind: 'infra',
          job: 'e2e-x (macos-latest)',
          cause: 'runner: not acquired',
          retry: 'success',
          url: 'u1',
        },
        {
          kind: 'infra',
          job: 'e2e-x (macos-latest)',
          cause: 'runner: not acquired',
          retry: 'success',
          url: 'u2',
        },
        { kind: 'test', job: 'e2e-tabs', cause: 't', retry: 'success', url: 'u3' },
      ],
      flaky: [{ test: 'a | b', job: 'e2e-tabs', url: 'u4' }],
    });
    const rows = md.split('\n').filter((l) => /^\| \d/.test(l));
    expect(rows[0]).toBe(
      '| 2 | infra | `e2e-x (macos-latest)` · runner: not acquired | success | [1](u1) [2](u2) |'
    );
    expect(rows[1]).toBe('| 1 | test | `e2e-tabs` · t | success | [1](u3) |');
    expect(rows[2]).toBe('| 1 | a \\| b | `e2e-tabs` | [1](u4) |');
    expect(md).toContain('only the newest 4 of 10 runs were scanned');
  });

  test('says None. for empty sections', () => {
    const md = render({ days: 7, since: 'x', runsScanned: 0, retried: [], flaky: [] });
    expect(md.match(/^None\.$/gm)).toHaveLength(2);
  });
});

describe('createBudget', () => {
  test('counts every page and refuses calls past the limit', () => {
    const api = createBudget(3, (p) => (p === 'two' ? [[1], [2]] : [[3]]));
    expect(api.get('two', (page) => page)).toEqual([1, 2]);
    expect(api.used).toBe(2);
    api.get('one');
    expect(api.used).toBe(3);
    expect(() => api.get('one')).toThrow(BudgetExhausted);
  });
});

describe('walkRuns', () => {
  const runs = [{ id: 1 }, { id: 3 }, { id: 2 }];

  test('newest first; a spent budget keeps the finished runs', () => {
    const seen = [];
    const walk = walkRuns(runs, (run) => {
      seen.push(run.id);
      if (run.id === 1) throw new BudgetExhausted('spent');
      return [run.id];
    });
    expect(seen).toEqual([3, 2, 1]);
    expect(walk).toEqual({ rows: [3, 2], scanned: 2, stopped: 'budget' });
  });

  test('a failing call stops the walk with its message, not the process', () => {
    const walk = walkRuns(runs, (run) => {
      if (run.id === 2) throw new Error('HTTP 403: API rate limit exceeded');
      return [run.id];
    });
    expect(walk).toEqual({ rows: [3], scanned: 1, stopped: 'HTTP 403: API rate limit exceeded' });
  });
});

describe('attempt2Actor', () => {
  test('attempt 2 is the latest: the listing already names its actor', () => {
    const api = { get: jest.fn() };
    expect(attempt2Actor(api, 'r', { id: 1, run_attempt: 2, actor: 'x' })).toBe('x');
    expect(api.get).not.toHaveBeenCalled();
  });

  test('attempt 3+: asks for attempt 2 itself', () => {
    const api = createBudget(5, (p) => [{ triggering_actor: { login: `actor of ${p}` } }]);
    expect(attempt2Actor(api, 'r', { id: 7, run_attempt: 3, actor: 'human' })).toBe(
      'actor of r/actions/runs/7/attempts/2'
    );
  });
});

describe('parseArgs', () => {
  test('defaults and validation', () => {
    expect(parseArgs(['--repo', 'o/r'])).toEqual({ days: 7, maxCalls: 800, repo: 'o/r' });
    expect(() => parseArgs(['--repo', 'o/r', '--days', '0'])).toThrow(/--days/);
    expect(() => parseArgs(['--repo', 'o/r', '--max-calls', '-1'])).toThrow(/--max-calls/);
    expect(() => parseArgs(['--repo', 'nope'])).toThrow(/--repo/);
  });
});

// The whole script against a fake `gh` that answers `api --paginate --slurp
// <path>` from a table and `api rate_limit` from FAKE_REMAINING.
describe('flake-report.js end to end', () => {
  const bot = { login: 'github-actions[bot]' };
  const human = { login: 'meinharrd' };
  const run = (id, run_attempt, actor) => ({
    id,
    run_attempt,
    check_suite_id: id * 10,
    html_url: `https://x/runs/${id}`,
    triggering_actor: actor,
  });
  const failedTabs = (id) => ({
    id,
    name: 'e2e-tabs',
    conclusion: 'failure',
    html_url: `https://x/jobs/${id}`,
    steps: [{ name: 'Run tabs E2E', conclusion: 'failure' }],
  });
  const tabs = (conclusion) => ({ jobs: [{ id: 0, name: 'e2e-tabs', conclusion }] });
  const ROUTES = {
    'workflows/ci.yml/runs': {
      workflow_runs: [
        run(101, 2, bot), // auto-retry
        run(102, 2, human), // a person pressed "Re-run" (R1-M1)
        run(103, 3, human), // auto-retry, then a person
        run(104, 1, bot),
      ],
    },
    'workflows/release.yml/runs': { workflow_runs: [] },
    'runs/103/attempts/2': { triggering_actor: bot },
    'runs/101/attempts/1/jobs': { jobs: [failedTabs(501)] },
    'runs/101/attempts/2/jobs': tabs('success'),
    'runs/103/attempts/1/jobs': { jobs: [failedTabs(503)] },
    'runs/103/attempts/2/jobs': tabs('failure'),
    'runs/103/attempts/3/jobs': tabs('success'),
    'check-runs/501/annotations': [failure('1) x', REAL), failure('2) y', FLAKY), SUMMARY],
    'check-runs/503/annotations': [failure('1) x', REAL), SUMMARY],
    'check-suites/1040/check-runs': {
      check_runs: [
        {
          id: 604,
          name: 'e2e-safe',
          conclusion: 'success',
          html_url: 'https://x/c/604',
          output: { annotations_count: 3 },
        },
      ],
    },
    'check-runs/604/annotations': [failure('1) z', FLAKY), SUMMARY],
  };

  function runScript(args, { remaining = 5000, fail = '', fail502 = '' } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flake-report-test-'));
    fs.writeFileSync(path.join(dir, 'routes.json'), JSON.stringify(ROUTES));
    fs.writeFileSync(
      path.join(dir, 'gh'),
      `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(dir, 'calls.log'))}, args.join(' ') + '\\n');
if (args[1] === 'rate_limit') { console.log(process.env.FAKE_REMAINING); process.exit(0); }
const target = args[args.length - 1].split('?')[0];
if (process.env.FAKE_FAIL && target.includes(process.env.FAKE_FAIL)) {
  console.error('gh: API rate limit exceeded (HTTP 403)'); process.exit(1);
}
const flaky = ${JSON.stringify(path.join(dir, 'flaked'))};
if (process.env.FAKE_502 && target.includes(process.env.FAKE_502) && !fs.existsSync(flaky)) {
  fs.writeFileSync(flaky, ''); console.error('gh: Server Error (HTTP 502)'); process.exit(1);
}
const routes = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(dir, 'routes.json'))}, 'utf8'));
const key = Object.keys(routes).find((k) => target.endsWith(k));
console.log(JSON.stringify([key ? routes[key] : (target.includes('check-runs') && !target.includes('annotations') ? { check_runs: [] } : [])]));
`,
      { mode: 0o755 }
    );
    const r = spawnSync(
      process.execPath,
      [path.join(__dirname, 'flake-report.js'), '--repo', 'o/r', ...args],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}${path.delimiter}${process.env.PATH}`,
          FAKE_REMAINING: String(remaining),
          FAKE_FAIL: fail,
          FAKE_502: fail502,
        },
      }
    );
    const calls = fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n');
    fs.rmSync(dir, { recursive: true, force: true });
    return { ...r, calls };
  }
  const tableRows = (md) => md.split('\n').filter((l) => /^\| \d/.test(l));
  const maybe = process.platform === 'win32' ? test.skip : test;

  maybe('counts only runs auto-retry re-ran, against attempt 2', () => {
    const r = runScript([]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('1 run(s) re-run by a person, not by auto-retry');
    // Run 103's attempt 2 failed again; attempt 3 (a person) passing is not the retry.
    expect(tableRows(r.stdout)).toEqual([
      `| 1 | test | \`e2e-tabs\` · ${REAL} | failure | [1](https://x/jobs/503) |`,
      `| 1 | test | \`e2e-tabs\` · ${REAL} | success | [1](https://x/jobs/501) |`,
      `| 1 | ${FLAKY} | \`e2e-safe\` | [1](https://x/c/604) |`,
    ]);
    expect(r.calls.some((c) => c.includes('runs/102/'))).toBe(false);
    // 2 run lists + run 103 (4) + run 101 (3) + 4 check-suites + 1 annotation.
    expect(r.stdout).toContain('_14 API call(s) of a 800 budget._');
  });

  maybe('one budget covers both halves; a cut still renders what it has (R1-M2)', () => {
    const r = runScript(['--max-calls', '6']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      'Auto-retried runs: only the newest 2 of 3 were read (API call budget of 6 spent).'
    );
    expect(r.stdout).toContain(
      'only the newest 0 of 4 runs were scanned (API call budget of 6 spent)'
    );
    expect(tableRows(r.stdout)).toHaveLength(1);
    expect(r.calls.filter((c) => c.startsWith('api --paginate'))).toHaveLength(6);
  });

  maybe("the token's remaining rate limit caps the budget too", () => {
    const r = runScript([], { remaining: 56 });
    expect(r.stdout).toContain('of a 6 budget');
  });

  maybe('a lone 5xx is retried once, and the retry is counted', () => {
    const r = runScript([], { fail502: 'check-suites/1030' });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('API error');
    expect(r.stdout).toContain('_15 API call(s) of a 800 budget._');
  });

  maybe('a failing call keeps the report and fails the run', () => {
    const r = runScript([], { fail: 'check-suites/1030' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('report above is partial');
    expect(r.stdout).toContain(
      'only the newest 1 of 4 runs were scanned (API error: repos/o/r/check-suites/1030/check-runs: ' +
        'gh: API rate limit exceeded (HTTP 403))'
    );
    // Both retried runs, and run 104's flaky test, read before the failure.
    expect(tableRows(r.stdout)).toHaveLength(3);
  });
});
