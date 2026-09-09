// The screenshot spec skips itself unless it is launched the way its baselines
// were rendered. That keeps a bare `npm run test:e2e` green, but it also means
// a mis-invoked screenshot run *passes* by skipping — so the invocations that
// are supposed to enable it are asserted here alongside the gate itself.

const fs = require('fs');
const path = require('path');

const { screenshotGate, STABLE_TEXT_VAR } = require('./screenshot-gate');

const repoRoot = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

describe('screenshotGate', () => {
  const on = { [STABLE_TEXT_VAR]: '1' };

  it('enables a Linux run launched with stable text', () => {
    expect(screenshotGate(on, 'linux')).toEqual({ enabled: true, reason: '' });
  });

  it('skips a Linux run without stable text, naming the npm script', () => {
    const { enabled, reason } = screenshotGate({}, 'linux');
    expect(enabled).toBe(false);
    expect(reason).toContain('npm run test:e2e:screenshots');
  });

  it('skips off Linux, and lets FREEDOM_SCREENSHOTS=1 opt back in', () => {
    expect(screenshotGate(on, 'darwin').enabled).toBe(false);
    expect(screenshotGate(on, 'darwin').reason).toContain('Linux');
    expect(screenshotGate({ ...on, FREEDOM_SCREENSHOTS: '1' }, 'darwin').enabled).toBe(true);
  });

  it('trims both flags, so `set X=1 && npm run ...` still counts', () => {
    expect(screenshotGate({ [STABLE_TEXT_VAR]: '1 ' }, 'linux').enabled).toBe(true);
    expect(
      screenshotGate({ [STABLE_TEXT_VAR]: '1', FREEDOM_SCREENSHOTS: '1 ' }, 'darwin').enabled
    ).toBe(true);
  });

  it('treats any other value as off', () => {
    for (const value of ['', '0', 'false', 'yes', undefined]) {
      expect(screenshotGate({ [STABLE_TEXT_VAR]: value }, 'linux').enabled).toBe(false);
    }
  });
});

// A workflow with its comments stripped. `ci.yml` documents the local update
// command in prose (`Locally: xvfb-run -a npm run test:e2e:screenshots:update`),
// which contains every substring the assertions below look for — asserting
// against the raw file would pass on a job rewritten to a bare
// `npx playwright test …`, and the spec would then skip itself in CI forever
// while this test stayed green.
const workflowSteps = (relative) =>
  read(relative)
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

const workflowsDir = path.join(repoRoot, '.github/workflows');
const everyWorkflowStep = () =>
  fs
    .readdirSync(workflowsDir)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => workflowSteps(path.join('.github/workflows', name)))
    .join('\n');

describe('the invocations that are meant to enable it', () => {
  const scripts = JSON.parse(read('package.json')).scripts;

  it.each(['test:e2e:screenshots', 'test:e2e:screenshots:update'])(
    '%s sets stable text',
    (name) => {
      expect(scripts[name]).toContain(`${STABLE_TEXT_VAR}=1`);
    }
  );

  it('CI compares through the npm script rather than a bare playwright run', () => {
    // The `run:` step itself, so a job switched to `npx playwright test …`
    // (which would skip every screenshot, silently and greenly) fails here.
    // Anchored to the end of the line, because `test:e2e:screenshots:update`
    // — and any bare `--update-snapshots` argument — starts with the compare
    // script's name: a job pointed at the update variant would rewrite the
    // baselines in the runner's workspace and report success, comparing
    // nothing while this test stayed green on a prefix match.
    expect(workflowSteps('.github/workflows/ci.yml')).toMatch(
      /^\s*run: xvfb-run -a npm run test:e2e:screenshots[ \t]*$/m
    );
    // …and no step in any workflow adopts baselines instead of comparing them,
    // so the compare step can't be sidestepped by an extra update step either.
    // Matched against the whole comment-stripped workflow rather than against a
    // `run:` line: a block scalar puts the command on the *next* line (`run: |`
    // then `xvfb-run -a npm run test:e2e:screenshots:update`), which a
    // `/run:.*update/` pattern never reaches, and the compare-step assertion
    // above stays satisfied by the untouched step. `apply-screenshot-baselines`
    // is the same sidestep by another route.
    expect(everyWorkflowStep()).not.toMatch(
      /test:e2e:screenshots:update|--update-snapshots|apply-screenshot-baselines/
    );
  });

  it.each([
    ['the gate itself', 'screenshot-gate'],
    ['the screenshot baselines', 'test-e2e/__screenshots__/'],
    ['the contrast baseline', 'test-e2e/theme-contrast-baseline'],
    ['the npm scripts that launch them', 'package\\.json'],
  ])('a change to %s makes CI run the visual jobs', (_what, pattern) => {
    // `renderer-changed` decides whether the visual jobs run at all. Each of
    // these can decide what those jobs compare against — or turn them into
    // no-ops — so each belongs in that path filter; a baseline-adoption PR
    // touches nothing else at all.
    expect(workflowSteps('.github/workflows/ci.yml')).toContain(pattern);
  });

  it('the default harness suite does not set it, so the spec stays opt-in there', () => {
    expect(scripts['test:e2e']).not.toContain(STABLE_TEXT_VAR);
  });
});
