const fs = require('fs');
const path = require('path');
const {
  createTempUserDataDir,
  loadMainModule,
  removeTempUserDataDir,
} = require('../../../test/helpers/main-process-test-utils');

function loadStore(options = {}) {
  return loadMainModule(require.resolve('./permissions-store'), options);
}

function permissionsPath(userDataDir) {
  return path.join(userDataDir, 'permissions.json');
}

describe('permissions-store', () => {
  let userDataDir;

  beforeEach(() => {
    userDataDir = createTempUserDataDir();
  });

  afterEach(() => {
    removeTempUserDataDir(userDataDir);
  });

  test('returns null for unknown origin/permission', () => {
    const { mod } = loadStore({ userDataDir });
    expect(mod.getDecision('https://example.com', 'camera')).toBeNull();
  });

  test('stores and retrieves allow/deny decisions', () => {
    const { mod } = loadStore({ userDataDir });

    expect(mod.setDecision('https://example.com', 'camera', 'allow')).toBe(true);
    expect(mod.setDecision('https://example.com', 'notifications', 'deny')).toBe(true);

    expect(mod.getDecision('https://example.com', 'camera')).toBe('allow');
    expect(mod.getDecision('https://example.com', 'notifications')).toBe('deny');
    expect(mod.getDecision('https://example.com', 'geolocation')).toBeNull();
  });

  test('rejects invalid decisions and empty permissions', () => {
    const { mod } = loadStore({ userDataDir });

    expect(mod.setDecision('https://example.com', 'camera', 'maybe')).toBe(false);
    expect(mod.setDecision('https://example.com', '', 'allow')).toBe(false);
    expect(mod.setDecision('', 'camera', 'allow')).toBe(false);
    expect(fs.existsSync(permissionsPath(userDataDir))).toBe(false);
  });

  test('persists decisions to permissions.json and reloads them', () => {
    const first = loadStore({ userDataDir });
    first.mod.setDecision('https://example.com', 'camera', 'allow');

    const onDisk = JSON.parse(fs.readFileSync(permissionsPath(userDataDir), 'utf-8'));
    expect(onDisk).toEqual({ 'https://example.com': { camera: 'allow' } });

    // Fresh module load (new cache) reads the same decision back.
    const second = loadStore({ userDataDir });
    expect(second.mod.getDecision('https://example.com', 'camera')).toBe('allow');
  });

  test('keys decisions by the shared origin normalization', () => {
    const { mod } = loadStore({ userDataDir });

    // Paths, queries, and fragments collapse to the origin.
    mod.setDecision('https://example.com/deep/path?q=1#frag', 'camera', 'allow');
    expect(mod.getDecision('https://example.com/other', 'camera')).toBe('allow');

    // ENS-hosted transport URLs key by the name…
    mod.setDecision('bzz://myapp.eth/page', 'notifications', 'allow');
    expect(mod.getDecision('ens://myapp.eth', 'notifications')).toBe('allow');

    // …while raw hashes stay their own origin (bzz://name.eth ≠ hash).
    const hash = 'a'.repeat(64);
    expect(mod.getDecision(`bzz://${hash}`, 'notifications')).toBeNull();
    mod.setDecision(`bzz://${hash}/index`, 'notifications', 'deny');
    expect(mod.getDecision(`bzz://${hash}`, 'notifications')).toBe('deny');
    expect(mod.getDecision('bzz://myapp.eth', 'notifications')).toBe('allow');
  });

  test('removeDecision removes a single permission and prunes empty origins', () => {
    const { mod } = loadStore({ userDataDir });
    mod.setDecision('https://example.com', 'camera', 'allow');
    mod.setDecision('https://example.com', 'microphone', 'allow');

    expect(mod.removeDecision('https://example.com', 'camera')).toBe(true);
    expect(mod.getDecision('https://example.com', 'camera')).toBeNull();
    expect(mod.getDecision('https://example.com', 'microphone')).toBe('allow');

    expect(mod.removeDecision('https://example.com', 'microphone')).toBe(true);
    expect(mod.getAllDecisions()).toEqual({});

    expect(mod.removeDecision('https://example.com', 'camera')).toBe(false);
  });

  test('removeOrigin drops every decision for the origin', () => {
    const { mod } = loadStore({ userDataDir });
    mod.setDecision('https://example.com', 'camera', 'allow');
    mod.setDecision('https://example.com', 'notifications', 'deny');
    mod.setDecision('https://other.com', 'camera', 'allow');

    expect(mod.removeOrigin('https://example.com')).toBe(true);
    expect(mod.getAllDecisions()).toEqual({ 'https://other.com': { camera: 'allow' } });
    expect(mod.removeOrigin('https://example.com')).toBe(false);
  });

  test('clearAll empties the store', () => {
    const { mod } = loadStore({ userDataDir });
    mod.setDecision('https://example.com', 'camera', 'allow');
    mod.clearAll();
    expect(mod.getAllDecisions()).toEqual({});
    expect(JSON.parse(fs.readFileSync(permissionsPath(userDataDir), 'utf-8'))).toEqual({});
  });

  test('getAllDecisions returns a copy, not the live cache', () => {
    const { mod } = loadStore({ userDataDir });
    mod.setDecision('https://example.com', 'camera', 'allow');

    const copy = mod.getAllDecisions();
    copy['https://example.com'].camera = 'deny';
    expect(mod.getDecision('https://example.com', 'camera')).toBe('allow');
  });

  test('self-heals an origin mapped to a non-object', () => {
    fs.writeFileSync(
      permissionsPath(userDataDir),
      JSON.stringify({ 'https://example.com': 'allow' }),
      'utf-8'
    );
    const { mod } = loadStore({ userDataDir });
    expect(mod.setDecision('https://example.com', 'camera', 'allow')).toBe(true);
    expect(mod.getDecision('https://example.com', 'camera')).toBe('allow');
  });

  test('survives a corrupt permissions.json', () => {
    fs.writeFileSync(permissionsPath(userDataDir), 'not json', 'utf-8');
    const { mod } = loadStore({ userDataDir });
    expect(mod.getAllDecisions()).toEqual({});
    expect(mod.setDecision('https://example.com', 'camera', 'allow')).toBe(true);
    expect(mod.getDecision('https://example.com', 'camera')).toBe('allow');
  });
});
