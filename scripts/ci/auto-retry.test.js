/**
 * scripts/ci/auto-retry.sh against a fake `gh` (#535).
 *
 * The script only ever runs from `main` under `workflow_run`, so a PR cannot
 * exercise it in CI. This drives the real script with a stand-in `gh` on PATH
 * that answers from canned JSON (applying `--jq` with the real `jq`, as `gh`
 * does) and records every call — enough to pin what #535 added: one line per
 * failed job naming the failed step and why, a step-summary table, and a
 * re-run that still happens when the annotation lookup fails.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, 'auto-retry.sh');
const hasTools =
  process.platform !== 'win32' && spawnSync('bash', ['-c', 'command -v jq']).status === 0;
const maybe = hasTools ? describe : describe.skip;

const JOBS = {
  jobs: [
    {
      id: 11,
      name: 'test',
      conclusion: 'success',
      steps: [{ name: 'Run', conclusion: 'success' }],
    },
    {
      id: 22,
      name: 'e2e-tabs',
      conclusion: 'failure',
      steps: [
        { name: 'Install dependencies', conclusion: 'success' },
        { name: 'Run tabs E2E', conclusion: 'failure' },
      ],
    },
    {
      id: 33,
      name: 'e2e-address-bar-clipboard (macos-latest)',
      conclusion: 'cancelled',
      steps: [],
    },
  ],
};

const ANNOTATIONS = {
  22: [
    { annotation_level: 'failure', title: '', message: 'Process completed with exit code 1.' },
    {
      annotation_level: 'failure',
      title: '[harness] › test-e2e/tabs.spec.js:163:1 › clicking a tab activates it',
      message: '1) [harness] › ...\nError: boom',
    },
  ],
  33: [
    {
      annotation_level: 'failure',
      title: '',
      message: 'The job was not acquired by Runner of type hosted even after multiple attempts',
    },
    { annotation_level: 'notice', title: '', message: 'Due to capacity constraints, ...' },
  ],
};

function setup({ failAnnotations = false, annotations = ANNOTATIONS } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-retry-test-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(dir, 'jobs.json'), JSON.stringify(JOBS));
  for (const [id, list] of Object.entries(annotations)) {
    fs.writeFileSync(path.join(dir, `ann-${id}.json`), JSON.stringify(list));
  }
  fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify({ workflow_runs: [{ id: 999 }] }));
  // Minimal `gh`: `gh api [--method GET] [--paginate] <path> [-f k=v]... --jq <expr>`
  // and `gh run rerun <id> --failed`.
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!/usr/bin/env bash
D=${JSON.stringify(dir)}
echo "$*" >> "$D/calls.log"
if [ "$1" = run ]; then exit 0; fi
jq_expr=""; target=""
while [ $# -gt 0 ]; do
  case "$1" in
    --jq) jq_expr="$2"; shift 2 ;;
    --method|-f) shift 2 ;;
    api|--paginate) shift ;;
    *) target="$1"; shift ;;
  esac
done
case "$target" in
  */workflows/*/runs) file="$D/latest.json" ;;
  */attempts/1/jobs*) file="$D/jobs.json" ;;
  */check-runs/*/annotations*)
    ${failAnnotations ? 'echo "HTTP 403" >&2; exit 1' : 'id="${target#*check-runs/}"; file="$D/ann-${id%%/*}.json"'} ;;
  *) echo "unexpected gh api $target" >&2; exit 2 ;;
esac
if [ -n "$jq_expr" ]; then jq -r "$jq_expr" "$file"; else cat "$file"; fi
`,
    { mode: 0o755 }
  );
  const summary = path.join(dir, 'summary.md');
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      GH_TOKEN: 'x',
      GH_REPO: 'o/r',
      RUN_ID: '999',
      RUN_URL: 'https://example.test/runs/999',
      RUN_ATTEMPT: '1',
      CONCLUSION: 'failure',
      WORKFLOW_ID: '7',
      WORKFLOW_NAME: 'CI',
      HEAD_BRANCH: 'main',
      EVENT_NAME: 'push',
      GITHUB_STEP_SUMMARY: summary,
    },
  });
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  const out = { ...result, calls: read(path.join(dir, 'calls.log')), summary: read(summary) };
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

maybe('auto-retry.sh', () => {
  test('logs the failed step and the reason for each job, then re-runs', () => {
    const r = setup();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      're-running 2 job(s) from CI run 999 (failure on attempt 1, branch main, event push): ' +
        'e2e-tabs|e2e-address-bar-clipboard (macos-latest)'
    );
    // A Playwright annotation wins over the generic exit-code line.
    expect(r.stdout).toContain(
      "failed job: e2e-tabs — failure at step 'Run tabs E2E' — " +
        '[harness] › test-e2e/tabs.spec.js:163:1 › clicking a tab activates it'
    );
    // A job with no steps never reached a runner (#535's original "hang").
    expect(r.stdout).toContain(
      "failed job: e2e-address-bar-clipboard (macos-latest) — cancelled at step 'never started' — " +
        'The job was not acquired by Runner of type hosted even after multiple attempts'
    );
    expect(r.summary).toContain('| Job | Conclusion | Failed step | Annotation |');
    expect(r.summary).toContain(
      '| e2e-address-bar-clipboard (macos-latest) | cancelled | never started |'
    );
    expect(r.calls).toMatch(/^run rerun 999 --failed$/m);
  });

  test('a failing annotation lookup still re-runs the jobs', () => {
    const r = setup({ failAnnotations: true });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("failed job: e2e-tabs — failure at step 'Run tabs E2E'\n");
    expect(r.calls).toMatch(/^run rerun 999 --failed$/m);
  });

  // R1-M3: the github reporter annotates a test that passed on a Playwright
  // retry exactly like the one that failed the job; the run summary notice is
  // what tells them apart (format verbatim from Playwright 1.63).
  test('leaves a test that passed on a Playwright retry out of the reason', () => {
    const real = '[harness] › test-e2e/onchain-apps.spec.js:460:3 › no visible webview';
    const flaky = '[harness] › test-e2e/page-context-menu.spec.js:233:3 › search';
    const r = setup({
      annotations: {
        ...ANNOTATIONS,
        22: [
          {
            annotation_level: 'failure',
            title: '',
            message: 'Process completed with exit code 1.',
          },
          { annotation_level: 'failure', title: flaky, message: '1) ...\nError: y' },
          { annotation_level: 'failure', title: real, message: '2) ...\nError: x' },
          { annotation_level: 'failure', title: real, message: '2) ...\n    Retry #1' },
          {
            annotation_level: 'notice',
            title: '🎭 Playwright Run Summary',
            message:
              `  1 failed\n    ${real} ${'─'.repeat(30)}\n` +
              `  1 flaky\n    ${flaky} ${'─'.repeat(30)}\n  40 passed (2.1m)`,
          },
        ],
      },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`failed job: e2e-tabs — failure at step 'Run tabs E2E' — ${real}\n`);
    expect(r.stdout).not.toContain('page-context-menu');
  });

  test('a job failed only by flaky tests is not blamed on them', () => {
    const flaky = '[harness] › test-e2e/page-context-menu.spec.js:233:3 › search';
    const r = setup({
      annotations: {
        ...ANNOTATIONS,
        22: [
          {
            annotation_level: 'failure',
            title: '',
            message: 'Process completed with exit code 1.',
          },
          { annotation_level: 'failure', title: flaky, message: '1) ...\nError: y' },
          {
            annotation_level: 'notice',
            title: '🎭 Playwright Run Summary',
            message: `  1 flaky\n    ${flaky} ${'─'.repeat(30)}\n  1 error was not a part of any test, see above for details`,
          },
        ],
      },
    });
    expect(r.stdout).toContain(
      "failed job: e2e-tabs — failure at step 'Run tabs E2E' — Process completed with exit code 1.\n"
    );
  });

  // R2-M1: one job ran Playwright twice; the test was flaky in one run and
  // really failed in the other, so it is still the reason.
  test('a test flaky in one summary but failed in another is still the reason', () => {
    const test1 = '[harness] › test-e2e/page-context-menu.spec.js:233:3 › search';
    const r = setup({
      annotations: {
        ...ANNOTATIONS,
        22: [
          {
            annotation_level: 'failure',
            title: '',
            message: 'Process completed with exit code 1.',
          },
          { annotation_level: 'failure', title: test1, message: '1) ...\nError: y' },
          {
            annotation_level: 'notice',
            title: '🎭 Playwright Run Summary',
            message: `  1 flaky\n    ${test1} ${'─'.repeat(30)}\n  40 passed (2.1m)`,
          },
          {
            annotation_level: 'notice',
            title: '🎭 Playwright Run Summary',
            message: `  1 failed\n    ${test1} ${'─'.repeat(30)}\n  40 passed (2.1m)`,
          },
        ],
      },
    });
    expect(r.stdout).toContain(
      `failed job: e2e-tabs — failure at step 'Run tabs E2E' — ${test1}\n`
    );
  });

  // #535: a run its concurrency group cancelled for a newer one, which the
  // newest-run lookup missed (here: the listing still names run 999 itself).
  test('does not re-run a run its concurrency group cancelled for a newer one', () => {
    const r = setup({
      annotations: {
        ...ANNOTATIONS,
        33: [
          {
            annotation_level: 'failure',
            title: '',
            message:
              'Canceling since a higher priority waiting request for ci-CI-refs/pull/420/merge exists',
          },
        ],
      },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      'CI run 999 was superseded: its concurrency group cancelled it ' +
        '("Canceling since a higher priority waiting request for ci-CI-refs/pull/420/merge exists")'
    );
    expect(r.stdout).not.toContain('re-running 2 job(s)');
    expect(r.summary).toContain('### Not re-running, superseded:');
    expect(r.calls).not.toMatch(/^run rerun/m);
  });
});
