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

describe('the invocations that are meant to enable it', () => {
  const scripts = JSON.parse(read('package.json')).scripts;

  it.each(['test:e2e:screenshots', 'test:e2e:screenshots:update'])(
    '%s sets stable text',
    (name) => {
      expect(scripts[name]).toContain(`${STABLE_TEXT_VAR}=1`);
    }
  );

  it('CI compares through the npm script rather than a bare playwright run', () => {
    expect(read('.github/workflows/ci.yml')).toContain('xvfb-run -a npm run test:e2e:screenshots');
  });

  it('the default harness suite does not set it, so the spec stays opt-in there', () => {
    expect(scripts['test:e2e']).not.toContain(STABLE_TEXT_VAR);
  });
});
