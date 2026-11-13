// Startup order around the profile gate (freedom-core design 0013, "The
// lock"): before `hold-profile` says `locked`, main writes none of the
// profile's stores and takes no hand-off, so a refused gate leaves the profile
// as it found it.
//
// The behavioural test is test-e2e/profile-gate-startup.spec.js: the real
// main process against a holder that withholds `locked`, then refuses or
// says it (Linux and macOS). src/main/index.js has no unit harness, so this
// is a source guard that keeps the same order in every platform's `test` job.

const fs = require('node:fs');
const path = require('node:path');

// index.js without its full-line and block comments, which name the calls
// this guard looks for.
function indexCode() {
  return fs
    .readFileSync(path.join(__dirname, 'index.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function count(source, text) {
  return source.split(text).length - 1;
}

describe('startup order around the profile gate', () => {
  const code = indexCode();
  const bootstrap = code.indexOf('async function bootstrap() {');
  const locked = code.indexOf('await profileGate.whenLocked();');
  const gateStart = code.indexOf('startProfileGate(activeProfile');

  test('bootstrap() waits for the gate', () => {
    expect(gateStart).toBeGreaterThan(-1);
    expect(bootstrap).toBeGreaterThan(gateStart);
    expect(locked).toBeGreaterThan(bootstrap);
    expect(count(code, 'await profileGate.whenLocked();')).toBe(1);
  });

  test('the settings are only peeked at before bootstrap(): loadSettings() writes migrations back', () => {
    const topLevel = code.slice(0, bootstrap);
    expect(topLevel).not.toMatch(/\bloadSettings\(/);
    expect(topLevel).toMatch(/webMcpBlinkFeatures\(peekSettings\(\)\)/);
  });

  test('the focus-request watcher, which consumes hand-offs, starts only once the gate is held', () => {
    // Its one start is the helper's body; the helper's one call is after
    // whenLocked() in bootstrap().
    expect(count(code, 'startProfileFocusRequestWatcher(')).toBe(1);
    const helper = code.indexOf('function startProfileFocusWatcher() {');
    expect(helper).toBeGreaterThan(-1);
    expect(code.indexOf('startProfileFocusRequestWatcher(')).toBeGreaterThan(helper);
    const calls = [...code.matchAll(/(?<!function )\bstartProfileFocusWatcher\(\)/g)];
    expect(calls).toHaveLength(1);
    expect(calls[0].index).toBeGreaterThan(locked);
  });
});
