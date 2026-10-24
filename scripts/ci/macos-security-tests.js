#!/usr/bin/env node
//
// The macOS-only Agent security regressions (#778), run by the
// `e2e-automation` job in .github/workflows/ci.yml (formerly `agent-macos-jest`).
//
// Several of these tests gate themselves on `process.platform === 'darwin'`,
// so on every other runner they are skipped, and a skipped test is green. That
// is how the S1 cleanup and S7 absent-`.git` regressions went unrun in CI. So
// this does not trust jest's exit code alone: it runs the suites below with
// `--json` and fails unless every suite ran, every test in them passed (none
// skipped, pending or todo), and each macOS-only test is among the passes by
// name.
//
// The macOS-only tests, and why each must run there:
//
//   secure-files.test.js
//   - "restricted cleanup removes links ..." (S1): `removeSandboxTree`'s
//     write-confined `sandbox-exec rm` must remove a link, and a substituted
//     root link, without deleting the outside target.
//   - "restricted cleanup keeps the outside target while a surviving process
//     swaps a subdirectory for a link" (S1): the same cleanup while a racer
//     process keeps swapping `sub` for a link to the outside directory.
//   - "the production missing-Git deny protects alternate-case names" (S7):
//     the seatbelt profile's absent-`.git` deny on a case-insensitive volume.
//
// The other skip in these files, secure-files.test.js's "kernel identity ..."
// (`process.platform === 'win32' ? test.skip : test`), skips only on Windows,
// so on macOS it has to run like any other test. It resolves the real
// workspace supervisor, so the job builds `out/macos-supervisor/<arch>/`
// (`npm run build:workspace-supervisor`) before running this. The suites that are pure
// unit tests (seatbelt-backend, seatbelt-environment, macos-supervisor-*,
// native-supervisors-integration, cleanup-racer) carry no platform gate and
// are here so the macOS runner exercises the code they cover with macOS's
// own `fs`, paths and `/usr/bin` tools.
//
// Not here, on purpose: seatbelt-integration.test.js and
// seatbelt-destructive.test.js are opt-in (`FREEDOM_REQUIRE_SEATBELT=1`, a
// built workspace supervisor, and for the destructive one a disposable VM);
// they run through `npm run test:agent-sandbox:macos*`, not on a shared
// hosted runner.
//
// `scripts/ci/macos-security-tests.test.js` keeps both lists honest against
// the test sources, so a new darwin-gated test in one of these files has to
// be added to MACOS_ONLY to land.
//
// Usage: node scripts/ci/macos-security-tests.js [--output <results.json>]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.join(__dirname, '..', '..');

const SUITES = [
  'src/main/agent/workspace-execution/secure-files.test.js',
  'src/main/agent/workspace-execution/seatbelt-backend.test.js',
  'src/main/agent/workspace-execution/seatbelt-environment.test.js',
  'src/main/agent/workspace-execution/macos-supervisor-process.test.js',
  'src/main/agent/workspace-execution/macos-supervisor-runtime.test.js',
  'src/main/agent/workspace-execution/__tests__/cleanup-racer.test.js',
  'scripts/native-supervisors-integration.test.js',
];

const MACOS_ONLY = [
  {
    suite: 'src/main/agent/workspace-execution/secure-files.test.js',
    name: 'restricted cleanup removes links without deleting their outside target, including a replaced root',
  },
  {
    suite: 'src/main/agent/workspace-execution/secure-files.test.js',
    name: 'restricted cleanup keeps the outside target while a surviving process swaps a subdirectory for a link',
  },
  {
    suite: 'src/main/agent/workspace-execution/secure-files.test.js',
    name: 'the production missing-Git deny protects alternate-case names',
  },
];

const relative = (file, root) => path.relative(root, file).split(path.sep).join('/');

/**
 * What is wrong with a jest `--json` report for `suites`, as messages; an
 * empty list means every suite ran and passed in full, and every `macosOnly`
 * test passed.
 */
function checkResults(results, { suites = SUITES, macosOnly = MACOS_ONLY, root = repoRoot } = {}) {
  if (!results || !Array.isArray(results.testResults)) return ['no jest results to check'];
  const problems = [];
  const bySuite = new Map(results.testResults.map((suite) => [relative(suite.name, root), suite]));
  for (const file of suites) {
    const suite = bySuite.get(file);
    if (!suite) {
      problems.push(`${file}: did not run`);
      continue;
    }
    const tests = suite.assertionResults || [];
    if (suite.status === 'failed' || suite.message) {
      problems.push(`${file}: suite failed${suite.message ? `\n${suite.message}` : ''}`);
    }
    if (!tests.length) problems.push(`${file}: ran no tests`);
    for (const test of tests) {
      if (test.status !== 'passed') problems.push(`${file}: "${test.fullName}" ${test.status}`);
    }
  }
  for (const { suite: file, name } of macosOnly) {
    const tests = bySuite.get(file)?.assertionResults || [];
    if (!tests.some((test) => test.fullName === name && test.status === 'passed')) {
      problems.push(`${file}: macOS-only "${name}" did not pass`);
    }
  }
  if (!(results.numTotalTests > 0)) problems.push('jest reported no tests at all');
  return problems;
}

function main(argv, { platform = process.platform, run = spawnSync } = {}) {
  const at = argv.indexOf('--output');
  const output =
    at === -1
      ? path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'macos-security-tests-')), 'results.json')
      : path.resolve(argv[at + 1]);
  if (platform !== 'darwin') {
    // Every macOS-only test would skip, and the check below would say so test
    // by test. Say it once instead.
    console.error(`macos-security-tests: needs macOS, running on ${platform}`);
    return 1;
  }
  // `--runTestsByPath`, so each entry names exactly one file rather than
  // being matched as a pattern that could also pick up, or miss, another.
  const jest = run(
    process.execPath,
    [
      require.resolve('jest/bin/jest'),
      '--ci',
      '--runInBand',
      '--json',
      '--outputFile',
      output,
      '--runTestsByPath',
      ...SUITES,
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  );
  let results = null;
  try {
    results = JSON.parse(fs.readFileSync(output, 'utf8'));
  } catch (error) {
    console.error(`macos-security-tests: could not read ${output}: ${error.message}`);
  }
  const problems = checkResults(results);
  if (jest.status !== 0) problems.push(`jest exited ${jest.status ?? jest.signal}`);
  for (const problem of problems) console.error(`macos-security-tests: ${problem}`);
  if (problems.length) return 1;
  console.log(
    `macos-security-tests: ${results.numPassedTests} tests in ${SUITES.length} suites passed, ` +
      `${MACOS_ONLY.length} of them macOS-only, none skipped`
  );
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { SUITES, MACOS_ONLY, checkResults, main };
