const fs = require('fs');
const os = require('os');
const path = require('path');
const { freedomPath } = require('./freedom-path');

describe('freedomPath: a moved entry in either layout (0013 PRF-9)', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-path-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('the root layout: under the profile directory, `freedom/` alone not counting', () => {
    expect(freedomPath(dir, 'settings.json')).toBe(path.join(dir, 'settings.json'));
    expect(freedomPath(dir, 'identity')).toBe(path.join(dir, 'identity'));
    fs.mkdirSync(path.join(dir, 'freedom'));
    // An unsettled move's journal isn't the marker either.
    fs.writeFileSync(path.join(dir, 'freedom', '.move.json'), '{}');
    expect(freedomPath(dir, 'ant-data')).toBe(path.join(dir, 'ant-data'));
  });

  test('the moved layout: under `freedom/` once its marker is there', () => {
    fs.mkdirSync(path.join(dir, 'freedom'));
    fs.writeFileSync(path.join(dir, 'freedom', 'layout.json'), '{"version":1}');
    expect(freedomPath(dir, 'settings.json')).toBe(path.join(dir, 'freedom', 'settings.json'));
    expect(freedomPath(dir, 'identity')).toBe(path.join(dir, 'freedom', 'identity'));
    expect(freedomPath(dir, 'ant-data')).toBe(path.join(dir, 'freedom', 'ant-data'));
  });

  test('an entry that stays at the root is refused', () => {
    for (const name of ['profile.json', 'logs', 'freedom', 'agent-history.sqlite']) {
      expect(() => freedomPath(dir, name)).toThrow(/isn't a moved entry/);
    }
  });
});
