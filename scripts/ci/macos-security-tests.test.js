/**
 * Guard for scripts/ci/macos-security-tests.js, the `agent-macos-jest` job's
 * "ran, and was not skipped" check (#778). The job exists because a skipped
 * test reports green; a checker that let a skip through, or a list of
 * macOS-only tests that drifted from the sources, would put it straight back
 * there. Runs on every platform: the macOS job itself cannot tell you that it
 * stopped checking.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { SUITES, MACOS_ONLY, checkResults, main } = require('./macos-security-tests');

const repoRoot = path.join(__dirname, '..', '..');

/** A jest `--json` report in which every listed suite and test passed. */
const cleanReport = () => {
  const testResults = SUITES.map((file) => ({
    name: path.join(repoRoot, file),
    status: 'passed',
    message: '',
    assertionResults: [
      { fullName: `${file} unit`, status: 'passed' },
      ...MACOS_ONLY.filter(({ suite }) => suite === file).map(({ name }) => ({
        fullName: name,
        status: 'passed',
      })),
    ],
  }));
  return {
    success: true,
    numTotalTests: testResults.reduce((sum, suite) => sum + suite.assertionResults.length, 0),
    testResults,
  };
};

const secureFiles = 'src/main/agent/workspace-execution/secure-files.test.js';
const suiteOf = (report, file) =>
  report.testResults.find((suite) => suite.name === path.join(repoRoot, file));

describe('checkResults', () => {
  it('accepts a report in which everything ran and passed', () => {
    expect(checkResults(cleanReport())).toEqual([]);
  });

  it.each(['pending', 'skipped', 'todo', 'disabled', 'focused', 'failed'])(
    'refuses a macOS-only test that came back %s',
    (status) => {
      const report = cleanReport();
      suiteOf(report, secureFiles).assertionResults.find(
        (test) => test.fullName === MACOS_ONLY[0].name
      ).status = status;
      expect(checkResults(report)).toEqual([
        `${secureFiles}: "${MACOS_ONLY[0].name}" ${status}`,
        `${secureFiles}: macOS-only "${MACOS_ONLY[0].name}" did not pass`,
      ]);
    }
  );

  it('refuses a skip in a suite with no macOS-only tests', () => {
    const report = cleanReport();
    const file = 'src/main/agent/workspace-execution/seatbelt-backend.test.js';
    suiteOf(report, file).assertionResults[0].status = 'pending';
    expect(checkResults(report)).toEqual([`${file}: "${file} unit" pending`]);
  });

  it('refuses a macOS-only test that was renamed or deleted', () => {
    const report = cleanReport();
    const suite = suiteOf(report, secureFiles);
    suite.assertionResults = suite.assertionResults.filter(
      (test) => test.fullName !== MACOS_ONLY[2].name
    );
    expect(checkResults(report)).toEqual([
      `${secureFiles}: macOS-only "${MACOS_ONLY[2].name}" did not pass`,
    ]);
  });

  it('refuses a suite that did not run, ran nothing, or failed to load', () => {
    const report = cleanReport();
    const [missing, empty, broken] = [SUITES[1], SUITES[2], SUITES[3]];
    report.testResults = report.testResults.filter(
      (suite) => suite.name !== path.join(repoRoot, missing)
    );
    suiteOf(report, empty).assertionResults = [];
    Object.assign(suiteOf(report, broken), {
      status: 'failed',
      message: 'Cannot find module',
      assertionResults: [],
    });
    expect(checkResults(report)).toEqual([
      `${missing}: did not run`,
      `${empty}: ran no tests`,
      `${broken}: suite failed\nCannot find module`,
      `${broken}: ran no tests`,
    ]);
  });

  it('refuses a report with no tests, or no report at all', () => {
    expect(checkResults(null)).toEqual(['no jest results to check']);
    expect(checkResults({})).toEqual(['no jest results to check']);
    expect(checkResults({ ...cleanReport(), numTotalTests: 0 })).toEqual([
      'jest reported no tests at all',
    ]);
  });

  it('reads a real jest report: the macOS-only tests are pending off macOS', () => {
    // The shape above is hand-written; this is jest's own, for the one suite
    // that carries the darwin gates.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'macos-security-tests-'));
    const output = path.join(dir, 'results.json');
    try {
      spawnSync(
        process.execPath,
        [
          require.resolve('jest/bin/jest'),
          '--ci',
          '--json',
          '--outputFile',
          output,
          '--runTestsByPath',
          secureFiles,
        ],
        { cwd: repoRoot, encoding: 'utf8' }
      );
      const problems = checkResults(JSON.parse(fs.readFileSync(output, 'utf8')), {
        suites: [secureFiles],
      });
      expect(problems).toEqual(
        process.platform === 'darwin'
          ? []
          : [
              ...MACOS_ONLY.map(({ suite, name }) => `${suite}: "${name}" pending`),
              ...MACOS_ONLY.map(({ suite, name }) => `${suite}: macOS-only "${name}" did not pass`),
            ]
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('main', () => {
  const runWith = (report, status = 0) => {
    const calls = [];
    const run = (command, args) => {
      calls.push(args);
      fs.writeFileSync(args[args.indexOf('--outputFile') + 1], JSON.stringify(report));
      return { status };
    };
    return { run, calls };
  };
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'macos-security-tests-'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const output = () => ['--output', path.join(dir, 'results.json')];

  it('refuses to run anywhere but macOS, where every gated test would skip', () => {
    const { run, calls } = runWith(cleanReport());
    expect(main(output(), { platform: 'linux', run })).toBe(1);
    expect(calls).toEqual([]);
  });

  it('runs exactly the listed suites, by path, in band', () => {
    const { run, calls } = runWith(cleanReport());
    expect(main(output(), { platform: 'darwin', run })).toBe(0);
    const [args] = calls;
    expect(args.slice(args.indexOf('--runTestsByPath') + 1)).toEqual(SUITES);
    expect(args).toEqual(expect.arrayContaining(['--ci', '--runInBand', '--json']));
  });

  it('fails on a skipped test even when jest itself exited 0', () => {
    const report = cleanReport();
    suiteOf(report, secureFiles).assertionResults.at(-1).status = 'pending';
    expect(main(output(), { platform: 'darwin', run: runWith(report).run })).toBe(1);
  });

  it('fails when jest failed, even with a clean-looking report', () => {
    expect(main(output(), { platform: 'darwin', run: runWith(cleanReport(), 1).run })).toBe(1);
  });

  it('fails when jest wrote no report', () => {
    const run = () => ({ status: 0 });
    expect(main(output(), { platform: 'darwin', run })).toBe(1);
  });
});

describe('the lists', () => {
  const source = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');

  // The gates a test in these suites may carry, each capturing the title. A darwin
  // gate makes a test macOS-only; a win32 skip still runs on macOS. Anything
  // else that can skip a test (an env-var gate, a bare `.skip`, `.todo`) has
  // to be classified here before it can land in a required suite.
  const DARWIN_ONLY = /\(process\.platform === 'darwin' \? (test|it) : \1\.skip\)\(\s*'([^']+)'/g;
  const NOT_ON_WINDOWS = /\(process\.platform === 'win32' \? (test|it)\.skip : \1\)\(\s*'([^']+)'/g;
  const ANY_SKIP = /\b(?:test|it|describe)\.(?:skip|todo|only)\b|\bx(?:it|test|describe)\b/g;

  it('names suites that exist', () => {
    expect(SUITES.filter((file) => !fs.existsSync(path.join(repoRoot, file)))).toEqual([]);
  });

  it('names every darwin-gated test in those suites as macOS-only, and nothing else', () => {
    const gated = SUITES.flatMap((file) =>
      [...source(file).matchAll(DARWIN_ONLY)].map(([, , name]) => ({ suite: file, name }))
    );
    expect(gated).not.toEqual([]);
    expect(MACOS_ONLY).toEqual(gated);
  });

  it('holds no skip it cannot account for', () => {
    expect(
      SUITES.map((file) => {
        const text = source(file);
        const known = [...text.matchAll(DARWIN_ONLY), ...text.matchAll(NOT_ON_WINDOWS)].length;
        return [file, (text.match(ANY_SKIP) || []).length - known];
      })
    ).toEqual(SUITES.map((file) => [file, 0]));
  });
});

describe('the agent-macos-jest job', () => {
  const workflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
  const block = workflow
    .split(/^ {2}agent-macos-jest:[ \t]*$/m)[1]
    ?.split(/^ {2}[A-Za-z0-9_-]+:[ \t]*$/m)[0];

  it('runs this checker on macOS', () => {
    expect(block).toBeTruthy();
    expect(block).toMatch(/^ {4}runs-on: macos-latest$/m);
    expect(block).toMatch(/^ {8}run: node scripts\/ci\/macos-security-tests\.js\b/m);
  });

  it('only reads the repository', () => {
    expect(block).toMatch(/^ {4}permissions:\n {6}contents: read$/m);
    expect(block).toMatch(/persist-credentials: false/);
  });
});
