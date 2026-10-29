const fs = require('fs');
const os = require('os');
const path = require('path');

const { createBeeConfig, injectBeeKey, injectRadicleKey } = require('./injection');

const posixTest = process.platform === 'win32' ? test.skip : test;
const modeOf = (target) => fs.statSync(target).mode & 0o777;

describe('createBeeConfig', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bee-config-'));
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  test('allows no browser origin to read the node API (security audit O-1)', () => {
    const configPath = createBeeConfig(dir, 'pw', 1633, 1634);
    const content = fs.readFileSync(configPath, 'utf8');
    expect(content).toContain('api-addr: 127.0.0.1:1633');
    expect(content).not.toMatch(/cors-allowed-origins/);
  });
});

describe('key files are owner-only (K-3)', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-keys-'));
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  posixTest('config.yaml, which holds the keystore password', () => {
    const configPath = createBeeConfig(dir, 'pw', 1633, 1634);
    expect(modeOf(configPath)).toBe(0o600);
    expect(modeOf(dir)).toBe(0o700);
  });

  posixTest('the Swarm keystore and its directory, also over an older 0644 one', async () => {
    const keysDir = path.join(dir, 'keys');
    fs.mkdirSync(keysDir, { mode: 0o755 });
    fs.chmodSync(keysDir, 0o755);
    fs.writeFileSync(path.join(keysDir, 'swarm.key'), '{}', { mode: 0o644 });
    fs.chmodSync(path.join(keysDir, 'swarm.key'), 0o644);

    const key = `0x${'11'.repeat(32)}`;
    await injectBeeKey(dir, key, 'password');
    expect(modeOf(keysDir)).toBe(0o700);
    expect(modeOf(path.join(keysDir, 'swarm.key'))).toBe(0o600);
  }, 30000);

  posixTest('a link planted at any managed key or config name is replaced, its target untouched', async () => {
    const outside = path.join(dir, 'outside.txt');
    fs.writeFileSync(outside, 'not yours');
    fs.chmodSync(outside, 0o644);
    fs.mkdirSync(path.join(dir, 'keys'));
    fs.chmodSync(path.join(dir, 'keys'), 0o700);
    for (const name of ['keys/swarm.key', 'config.yaml', 'keys/radicle']) {
      fs.symlinkSync(outside, path.join(dir, name));
    }

    await injectBeeKey(dir, `0x${'11'.repeat(32)}`, 'password');
    createBeeConfig(dir, 'pw', 1633, 1634);
    injectRadicleKey(dir, new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), 'Alias');

    for (const name of ['keys/swarm.key', 'config.yaml', 'keys/radicle']) {
      const file = path.join(dir, name);
      expect({ name, link: fs.lstatSync(file).isSymbolicLink() }).toEqual({ name, link: false });
      expect(modeOf(file)).toBe(0o600);
    }
    expect(fs.readFileSync(outside, 'utf8')).toBe('not yours');
    expect(modeOf(outside)).toBe(0o644);
  }, 30000);

  posixTest('a keys directory that is a link is refused', async () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'elsewhere-'));
    try {
      fs.symlinkSync(elsewhere, path.join(dir, 'keys'));
      await expect(injectBeeKey(dir, `0x${'11'.repeat(32)}`, 'password')).rejects.toThrow(
        'symbolic link'
      );
      expect(() =>
        injectRadicleKey(dir, new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), 'Alias')
      ).toThrow('symbolic link');
      expect(fs.readdirSync(elsewhere)).toEqual([]);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  posixTest('the Radicle key directory and secret key', () => {
    injectRadicleKey(dir, new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), 'Alias');
    expect(modeOf(path.join(dir, 'keys'))).toBe(0o700);
    expect(modeOf(path.join(dir, 'keys', 'radicle'))).toBe(0o600);
  });
});
