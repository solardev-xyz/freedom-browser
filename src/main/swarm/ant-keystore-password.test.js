/**
 * K-3: the Ant keystore password is sealed in the OS keychain (safeStorage)
 * instead of sitting in config.yaml beside keys/swarm.key, and reaches antd
 * only as a short-lived --password-file.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadMainModule } = require('../../../test/helpers/main-process-test-utils');

const posixTest = process.platform === 'win32' ? test.skip : test;
const linuxTest = process.platform === 'linux' ? test : test.skip;
const modeOf = (target) => fs.statSync(target).mode & 0o777;

// safeStorage's async API with a keyring behind it (`v11` ciphertexts, as
// Linux's Secret Service / KWallet ones; `v12` is the Secret Portal's),
// whose ciphertext is not the plaintext. `prefix: 'v10'` is Chromium's
// fixed fallback key. `backend` is the legacy label, which does not decide.
function fakeSafeStorage({ backend = 'gnome_libsecret', available = true, prefix = 'v11' } = {}) {
  return {
    isAsyncEncryptionAvailable: jest.fn(async () => available),
    getSelectedStorageBackend: jest.fn(() => backend),
    encryptStringAsync: jest.fn(async (text) =>
      Buffer.from(`${prefix}${Buffer.from(text).toString('hex')}`)
    ),
    decryptStringAsync: jest.fn(async (buffer) => {
      const text = buffer.toString();
      if (!/^v1[012][0-9a-f]+$/.test(text)) throw new Error('Error while decrypting the ciphertext');
      return { result: Buffer.from(text.slice(3), 'hex').toString(), shouldReEncrypt: false };
    }),
  };
}

// A seal record as sealPassword writes it, for a ciphertext and the
// keystore bytes it is bound to (null: no keystore).
function sealRecord(ciphertext, keystoreBytes = null) {
  const crypto = require('crypto');
  return JSON.stringify({
    version: 2,
    ciphertext: Buffer.from(ciphertext).toString('base64'),
    keystoreSha256:
      keystoreBytes === null ? null : crypto.createHash('sha256').update(keystoreBytes).digest('hex'),
  });
}

function loadWith(safeStorage, userDataDir = os.tmpdir()) {
  const { mod } = loadMainModule(require.resolve('./ant-keystore-password'), {
    userDataDir,
    electronOverrides: { safeStorage },
  });
  return mod;
}

describe('ant keystore password (K-3)', () => {
  let dataDir;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ant-keystore-'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('seals with a keychain-backed safeStorage and opens it again', async () => {
    const keystore = loadWith(fakeSafeStorage());
    expect(await keystore.sealPassword(dataDir, 'pw-123')).toBe(true);

    const file = keystore.sealedPasswordPath(dataDir);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('pw-123');
    if (process.platform !== 'win32') expect(modeOf(file)).toBe(0o600);
    expect(await keystore.unsealPassword(dataDir)).toBe('pw-123');
  });

  test('does not seal where safeStorage has no keyring, or none at all', async () => {
    const keyringless = [fakeSafeStorage({ available: false }), undefined];
    if (process.platform === 'linux') {
      // The fixed fallback key, whatever the legacy label says.
      keyringless.push(fakeSafeStorage({ prefix: 'v10' }));
      keyringless.push(fakeSafeStorage({ prefix: 'v10', backend: 'basic_text' }));
    }
    for (const storage of keyringless) {
      const keystore = loadWith(storage);
      expect(await keystore.sealPassword(dataDir, 'pw')).toBe(false);
      expect(keystore.hasSealedPassword(dataDir)).toBe(false);
      expect(await keystore.unsealPassword(dataDir)).toBeNull();
    }
  });

  // Electron 45's async providers, as the K-3 review measured them: the
  // legacy label describes the synchronous selection, not the key that
  // made the ciphertext.
  linuxTest('Linux: classified by the ciphertext, never by the legacy backend label', async () => {
    const keyed = [
      fakeSafeStorage({ backend: 'basic_text', prefix: 'v11' }), // Secret Service, unknown desktop
      fakeSafeStorage({ backend: 'gnome_libsecret', prefix: 'v12' }), // Secret Portal
      fakeSafeStorage({ backend: 'kwallet6', prefix: 'v11' }),
    ];
    for (const storage of keyed) {
      const keystore = loadWith(storage);
      expect(await keystore.sealPassword(dataDir, 'pw-keyed')).toBe(true);
      expect(await keystore.unsealPassword(dataDir)).toBe('pw-keyed');
      keystore.forgetSealedPassword(dataDir);
    }
  });

  linuxTest('Linux: a fallback-key (v10) seal on disk is never opened', async () => {
    const storage = fakeSafeStorage();
    const keystore = loadWith(storage);
    fs.mkdirSync(path.join(dataDir, 'keys'));
    const v10 = `v10${Buffer.from('pw-weak').toString('hex')}`;
    fs.writeFileSync(keystore.sealedPasswordPath(dataDir), sealRecord(v10), { mode: 0o600 });

    await expect(keystore.unsealPassword(dataDir)).rejects.toThrow(keystore.REINJECT_MESSAGE);
    expect(storage.decryptStringAsync).not.toHaveBeenCalled();
  });

  test('non-Linux platforms seal their keyed v10 ciphertexts', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      const keystore = loadWith(fakeSafeStorage({ prefix: 'v10' }));
      expect(await keystore.sealPassword(dataDir, 'pw-mac')).toBe(true);
      expect(await keystore.unsealPassword(dataDir)).toBe('pw-mac');
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  test('a sealed password that will not open is the re-inject error', async () => {
    const keystore = loadWith(fakeSafeStorage());
    fs.mkdirSync(path.join(dataDir, 'keys'));
    fs.writeFileSync(keystore.sealedPasswordPath(dataDir), Buffer.from('other-key').toString('base64'));
    await expect(keystore.unsealPassword(dataDir)).rejects.toThrow(
      keystore.KeystorePasswordUnavailableError
    );
    await expect(keystore.unsealPassword(dataDir)).rejects.toThrow(
      'Swarm key needs re-injecting: unlock your vault'
    );

    // The keychain went away.
    const keyringless = loadWith(fakeSafeStorage({ available: false }));
    await expect(keyringless.unsealPassword(dataDir)).rejects.toThrow(keystore.REINJECT_MESSAGE);
  });

  test('a keychain key rotation stores the password under the new key', async () => {
    const storage = fakeSafeStorage();
    const keystore = loadWith(storage);
    await keystore.sealPassword(dataDir, 'pw-789');
    storage.decryptStringAsync.mockResolvedValueOnce({ result: 'pw-789', shouldReEncrypt: true });
    expect(await keystore.unsealPassword(dataDir)).toBe('pw-789');
    expect(storage.encryptStringAsync).toHaveBeenCalledTimes(2);
    expect(await keystore.unsealPassword(dataDir)).toBe('pw-789');
  });

  // A seal is staged in a private sibling, read back and opened to the
  // exact password, and only then published: a failed or interrupted seal
  // leaves the previous state, never a file that won't open.
  const stagingLeft = () =>
    fs.readdirSync(path.join(dataDir, 'keys')).filter((name) => name !== 'keystore-password.sealed');

  test('a seal whose write fails part-way publishes nothing', async () => {
    const keystore = loadWith(fakeSafeStorage());
    expect(await keystore.sealPassword(dataDir, 'pw-before')).toBe(true);
    const before = fs.readFileSync(keystore.sealedPasswordPath(dataDir), 'utf8');

    const realWrite = fs.writeFileSync;
    jest.spyOn(fs, 'writeFileSync').mockImplementation((target, data, ...rest) => {
      if (typeof target === 'number') {
        realWrite(target, String(data).slice(0, 5), ...rest);
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      }
      return realWrite(target, data, ...rest);
    });
    expect(await keystore.sealPassword(dataDir, 'pw-after')).toBe(false);
    fs.writeFileSync.mockRestore();

    expect(fs.readFileSync(keystore.sealedPasswordPath(dataDir), 'utf8')).toBe(before);
    expect(await keystore.unsealPassword(dataDir)).toBe('pw-before');
    expect(stagingLeft()).toEqual([]);
  });

  test('a seal whose publication is interrupted keeps the previous one', async () => {
    const keystore = loadWith(fakeSafeStorage());
    expect(await keystore.sealPassword(dataDir, 'pw-before')).toBe(true);
    const sealed = keystore.sealedPasswordPath(dataDir);

    const realRename = fs.renameSync;
    // The rename goes through the held keys/ handle (/proc/self/fd/… on Linux).
    jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (path.basename(to) === path.basename(sealed)) {
        throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
      }
      return realRename(from, to);
    });
    expect(await keystore.sealPassword(dataDir, 'pw-after')).toBe(false);
    fs.renameSync.mockRestore();

    expect(await keystore.unsealPassword(dataDir)).toBe('pw-before');
    expect(stagingLeft()).toEqual([]);
  });

  // keys/ is held as a directory handle across the keychain awaits: one
  // swapped for a link meanwhile never receives the seal through the link.
  posixTest('a keys/ swapped for a link during the seal never gets it outside', async () => {
    const storage = fakeSafeStorage();
    const keystore = loadWith(storage);
    const keysDir = path.join(dataDir, 'keys');
    fs.mkdirSync(keysDir, { mode: 0o700 });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ant-keystore-outside-'));
    try {
      const decrypt = storage.decryptStringAsync.getMockImplementation();
      storage.decryptStringAsync.mockImplementationOnce(async (buffer) => {
        fs.renameSync(keysDir, `${keysDir}.moved`);
        fs.symlinkSync(outside, keysDir);
        return decrypt(buffer);
      });

      expect(await keystore.sealPassword(dataDir, 'pw-swapped')).toBe(false);
      expect(fs.readdirSync(outside)).toEqual([]);
      expect(fs.existsSync(path.join(`${keysDir}.moved`, 'keystore-password.sealed'))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('a seal that does not read back as the password is never published', async () => {
    const storage = fakeSafeStorage();
    const keystore = loadWith(storage);
    storage.decryptStringAsync.mockResolvedValueOnce({ result: 'something-else', shouldReEncrypt: false });

    expect(await keystore.sealPassword(dataDir, 'pw-exact')).toBe(false);
    expect(keystore.hasSealedPassword(dataDir)).toBe(false);
    expect(stagingLeft()).toEqual([]);
    // It read back what was on disk: the staged file, not the ciphertext in memory.
    expect(storage.decryptStringAsync).toHaveBeenCalledTimes(1);
  });

  test('staging files a crash left are removed, the seal is not', async () => {
    const keystore = loadWith(fakeSafeStorage());
    const keysDir = path.join(dataDir, 'keys');
    fs.mkdirSync(keysDir, { mode: 0o700 });
    fs.writeFileSync(path.join(keysDir, 'swarm.key'), '{}');
    expect(await keystore.sealPassword(dataDir, 'pw-kept')).toBe(true);
    for (const name of [
      '.keystore-password.staged',
      '..keystore-password.staged.4242.a1b2c3d4e5f6.tmp',
      '.keystore-password.sealed.4242.a1b2c3d4e5f6.tmp',
    ]) {
      fs.writeFileSync(path.join(keysDir, name), 'partial');
    }

    const keysHandle = require('../private-files').openPrivateDir(keysDir);
    try {
      keystore.removeStaleSealStaging(keysHandle);
    } finally {
      keysHandle.close();
    }
    expect(fs.readdirSync(keysDir).sort()).toEqual(['keystore-password.sealed', 'swarm.key']);
    expect(await keystore.unsealPassword(dataDir)).toBe('pw-kept');
  });

  posixTest('the --password-file is private, in the profile, and removed for good', () => {
    const keystore = loadWith(fakeSafeStorage());
    const file = keystore.writePasswordFile('pw-456', dataDir);
    expect(fs.readFileSync(file.path, 'utf8')).toBe('pw-456');
    expect(path.dirname(path.dirname(file.path))).toBe(path.join(dataDir, 'run', 'ant-handoff'));
    expect(modeOf(file.path)).toBe(0o600);
    expect(modeOf(path.dirname(file.path))).toBe(0o700);
    expect(modeOf(path.join(dataDir, 'run', 'ant-handoff'))).toBe(0o700);
    expect(modeOf(path.join(dataDir, 'run'))).toBe(0o700);

    expect(file.remove()).toBe(true);
    expect(fs.existsSync(path.dirname(file.path))).toBe(false);
    expect(() => file.remove()).not.toThrow();
  });

  test('a removal that failed is tried again', () => {
    const keystore = loadWith(fakeSafeStorage());
    const file = keystore.writePasswordFile('pw-retry', dataDir);
    const rmdir = jest.spyOn(fs, 'rmdirSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
    });

    expect(file.remove()).toBe(false);
    expect(fs.existsSync(path.dirname(file.path))).toBe(true);
    rmdir.mockRestore();
    expect(file.remove()).toBe(true);
    expect(fs.existsSync(path.dirname(file.path))).toBe(false);
  });

  // A launch killed before it removed its handoff (SIGKILL, a crash, power
  // loss) leaves the plaintext file; the profile's next start removes it,
  // and never one of its own starts' live handoffs.
  posixTest('a handoff a killed launch left is removed at the next start', async () => {
    const { spawn } = require('child_process');
    const modulePath = require.resolve('./ant-keystore-password');
    const writer = spawn(
      process.execPath,
      [
        '-e',
        `const k = require(${JSON.stringify(modulePath)});
         const f = k.writePasswordFile('pw-orphaned', ${JSON.stringify(dataDir)});
         process.stdout.write(f.path + '\\n');
         setInterval(() => {}, 1000);`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] }
    );
    const orphan = await new Promise((resolve, reject) => {
      let out = '';
      writer.stdout.on('data', (chunk) => {
        out += chunk;
        if (out.includes('\n')) resolve(out.trim());
      });
      writer.on('error', reject);
      writer.on('exit', (code) => reject(new Error(`writer exited early: ${code}`)));
    });
    writer.removeAllListeners('exit');
    const exited = new Promise((resolve) => writer.on('exit', resolve));
    writer.kill('SIGKILL');
    await exited;
    expect(fs.readFileSync(orphan, 'utf8')).toBe('pw-orphaned');

    // The next launch: a fresh module, with a live handoff of its own.
    const keystore = loadWith(fakeSafeStorage());
    const live = keystore.writePasswordFile('pw-live', dataDir);
    expect(keystore.sweepAbandonedHandoffs(dataDir)).toBe(1);
    expect(fs.existsSync(path.dirname(orphan))).toBe(false);
    expect(fs.readFileSync(live.path, 'utf8')).toBe('pw-live');

    // Once its own antd has read it, it is no longer live either.
    live.remove();
    expect(keystore.sweepAbandonedHandoffs(dataDir)).toBe(0);
  });
});

describe('Ant config.yaml and the sealed password (K-3)', () => {
  let userDataDir;
  let dataDir;
  let configPath;
  let swarmKeyPath;

  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ant-config-'));
    dataDir = path.join(userDataDir, 'ant-data');
    configPath = path.join(dataDir, 'config.yaml');
    swarmKeyPath = path.join(dataDir, 'keys', 'swarm.key');
    fs.mkdirSync(path.join(dataDir, 'keys'), { recursive: true });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  function loadAntManager(safeStorage) {
    const { mod } = loadMainModule(require.resolve('../ant-manager'), {
      userDataDir,
      electronOverrides: { safeStorage },
      extraMocks: {
        [require.resolve('../logger')]: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
        [require.resolve('../settings-store')]: () => ({
          loadSettings: jest.fn(() => ({})),
          saveSettings: jest.fn(() => true),
        }),
        [require.resolve('../networks/network-registry')]: () => ({
          getEndpoints: jest.fn(() => ['https://ethereum.example']),
          getEndpointSources: jest.fn(() => []),
        }),
      },
    });
    return {
      ant: mod,
      keystore: require('./ant-keystore-password'),
    };
  }

  const configText = () => fs.readFileSync(configPath, 'utf8');
  // A real Web3 v3 keystore for a fixed synthetic account (cheap scrypt).
  const { Wallet, encryptKeystoreJson } = require('ethers');
  const account = new Wallet('0x' + '11'.repeat(32));
  const writeRealKeystore = async (password) => {
    const json = await encryptKeystoreJson(
      { address: account.address, privateKey: account.privateKey },
      password,
      { scrypt: { N: 1 << 10 } }
    );
    fs.writeFileSync(swarmKeyPath, json, { mode: 0o600 });
  };
  const opensKeystore = async (password) =>
    (await Wallet.fromEncryptedJson(fs.readFileSync(swarmKeyPath, 'utf8'), password)).address ===
    account.address;

  test('a fresh node keeps its password sealed, out of config.yaml', async () => {
    const { ant, keystore } = loadAntManager(fakeSafeStorage());
    const { configPath: written, sealedPassword } = await ant.ensureConfig(dataDir, 1633, 1634);
    expect(written).toBe(configPath);
    expect(sealedPassword).toMatch(/^[0-9a-f]{64}$/);
    expect(configText()).not.toMatch(/^password:/m);
    expect(await keystore.unsealPassword(dataDir)).toBe(sealedPassword);
  });

  test('without a keyring the password stays in the owner-only config.yaml', async () => {
    const { ant, keystore } = loadAntManager(fakeSafeStorage({ available: false }));
    const { sealedPassword } = await ant.ensureConfig(dataDir, 1633, 1634);
    expect(sealedPassword).toBeNull();
    expect(configText()).toMatch(/^password: [0-9a-f]{64}$/m);
    expect(keystore.hasSealedPassword(dataDir)).toBe(false);
  });

  test("an older build's password moves out of config.yaml on first start", async () => {
    await writeRealKeystore('legacy-password');
    fs.writeFileSync(configPath, 'api-addr: 127.0.0.1:1633\npassword: legacy-password\n');
    const { ant, keystore } = loadAntManager(fakeSafeStorage());

    const { sealedPassword } = await ant.ensureConfig(dataDir, 1633, 1634);
    expect(sealedPassword).toBe('legacy-password');
    expect(configText()).not.toContain('legacy-password');
    expect(await keystore.unsealPassword(dataDir)).toBe('legacy-password');

    // And it stays sealed on later starts.
    expect((await ant.ensureConfig(dataDir, 1633, 1634)).sealedPassword).toBe('legacy-password');
    expect(configText()).not.toMatch(/^password:/m);
  });

  // Ant reads config.yaml with serde_yaml: the password is the decoded
  // scalar, and that is what must be sealed.
  test.each([
    ['double quotes', 'password: "quoted-password"', 'quoted-password'],
    ['single quotes', "password: 'single-quoted'", 'single-quoted'],
    ['a trailing comment', 'password: public-fixture-password # operator comment', 'public-fixture-password'],
    ['escapes', 'password: "tab\\tquote\\"back\\\\slash\\u00e9"  # note', 'tab\tquote"back\\slash\u00e9'],
    ["a doubled single quote", "password: 'it''s'", "it's"],
    ['a # inside the value', 'password: hash#inside', 'hash#inside'],
  ])("an older build's password with %s migrates as Ant decodes it", async (_label, line, decoded) => {
    await writeRealKeystore(decoded);
    fs.writeFileSync(configPath, `api-addr: 127.0.0.1:1633\n${line}\n`);
    const { ant, keystore } = loadAntManager(fakeSafeStorage());

    const { sealedPassword } = await ant.ensureConfig(dataDir, 1633, 1634);
    expect(sealedPassword).toBe(decoded);
    expect(await keystore.unsealPassword(dataDir)).toBe(decoded);
    expect(configText()).not.toMatch(/^password:/m);
  });

  test('without a keyring a quoted password is written back as the same YAML value', async () => {
    fs.writeFileSync(swarmKeyPath, '{}');
    fs.writeFileSync(configPath, 'password: "with space # and hash"\n');
    const { ant } = loadAntManager(fakeSafeStorage({ available: false }));

    await ant.ensureConfig(dataDir, 1633, 1634);
    const { readConfigPassword } = require('./ant-config-password');
    expect(readConfigPassword(configText())).toEqual({ kind: 'value', value: 'with space # and hash' });
  });

  test('a password line it does not decode is left exactly as it is, unsealed', async () => {
    fs.writeFileSync(swarmKeyPath, '{}');
    fs.writeFileSync(configPath, 'api-addr: 127.0.0.1:1633\npassword: !!str tagged-value\n');
    const storage = fakeSafeStorage();
    const { ant, keystore } = loadAntManager(storage);

    const { sealedPassword } = await ant.ensureConfig(dataDir, 1633, 1634);
    expect(sealedPassword).toBeNull();
    expect(configText()).toMatch(/^password: !!str tagged-value$/m);
    expect(keystore.hasSealedPassword(dataDir)).toBe(false);
    expect(storage.encryptStringAsync).not.toHaveBeenCalled();
  });

  test('the password line goes only once its seal is verified and published', async () => {
    await writeRealKeystore('still-valid');
    fs.writeFileSync(configPath, 'api-addr: 127.0.0.1:1633\npassword: still-valid\n');
    const { ant, keystore } = loadAntManager(fakeSafeStorage());
    const sealed = keystore.sealedPasswordPath(dataDir);
    const realRename = fs.renameSync;
    const rename = jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (path.basename(to) === path.basename(sealed)) {
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      }
      return realRename(from, to);
    });

    // This start keeps the password where Ant reads it...
    expect((await ant.ensureConfig(dataDir, 1633, 1634)).sealedPassword).toBeNull();
    expect(configText()).toMatch(/^password: still-valid$/m);
    expect(keystore.hasSealedPassword(dataDir)).toBe(false);

    // ...and the next one, with the disk back, migrates it.
    rename.mockRestore();
    expect((await ant.ensureConfig(dataDir, 1633, 1634)).sealedPassword).toBe('still-valid');
    expect(configText()).not.toMatch(/^password:/m);
  });

  test('a seal that will not open never shadows a password config.yaml still has', async () => {
    fs.writeFileSync(swarmKeyPath, '{}');
    const { ant, keystore } = loadAntManager(fakeSafeStorage());
    const unopenable = sealRecord('v11zz', '{}');
    fs.writeFileSync(keystore.sealedPasswordPath(dataDir), unopenable);
    fs.writeFileSync(configPath, 'password: from-config\n');

    expect((await ant.ensureConfig(dataDir, 1633, 1634)).sealedPassword).toBeNull();
    expect(configText()).toMatch(/^password: from-config$/m);
    // The seal is left as it was, not replaced.
    expect(fs.readFileSync(keystore.sealedPasswordPath(dataDir), 'utf8')).toBe(unopenable);
  });

  posixTest("a start removes the handoff a killed launch left, whatever it starts", async () => {
    const orphanDir = path.join(userDataDir, 'run', 'ant-handoff', 'h-killed');
    fs.mkdirSync(orphanDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(orphanDir, 'password'), 'pw-orphaned', { mode: 0o600 });
    const { ant } = loadAntManager(fakeSafeStorage());

    // Before anything else: here it then stops at the missing antd binary.
    await ant.startAnt();
    expect(fs.existsSync(orphanDir)).toBe(false);
    await ant.stopAnt();
  });

  test('a refused recovery is the node status, and unlocks stop retrying it', () => {
    const { ant, keystore } = loadAntManager(fakeSafeStorage());
    const lifecycle = ant.createAntLifecycle({ needsKeyReinjection: undefined });
    lifecycle.refuseKeyReinjection(keystore.IDENTITY_MISMATCH_MESSAGE);
    expect(ant.getStatus()).toEqual({ status: 'error', error: keystore.IDENTITY_MISMATCH_MESSAGE });
    expect(lifecycle.needsKeyReinjection()).toBe(false);
  });

  // The K-3 review's crash window, with real Web3 keystores: injection
  // wrote a new swarm.key (new password) and died before persisting that
  // password, so config.yaml still holds the old one. Sealing it would drop
  // the line and clear the re-injection; it is checked against the keystore
  // first, and the start asks for re-injection with everything kept.
  test('an old config.yaml password beside a new keystore is not sealed', async () => {
    await writeRealKeystore('old-config-password');
    fs.writeFileSync(configPath, 'api-addr: 127.0.0.1:1633\npassword: old-config-password\n');
    // The crash: a new keystore, its password never persisted.
    await writeRealKeystore('new-keystore-password');
    const keystoreBefore = fs.readFileSync(swarmKeyPath, 'utf8');
    const { ant, keystore } = loadAntManager(fakeSafeStorage());

    await expect(ant.ensureConfig(dataDir, 1633, 1634)).rejects.toThrow(keystore.REINJECT_MESSAGE);
    expect(configText()).toBe('api-addr: 127.0.0.1:1633\npassword: old-config-password\n');
    expect(keystore.hasSealedPassword(dataDir)).toBe(false);
    expect(fs.readFileSync(swarmKeyPath, 'utf8')).toBe(keystoreBefore);
    expect(await opensKeystore('new-keystore-password')).toBe(true);
  });

  test('the matching config.yaml password is sealed, and the seal opens the keystore', async () => {
    await writeRealKeystore('matching-password');
    fs.writeFileSync(configPath, 'password: matching-password\n');
    const { ant, keystore } = loadAntManager(fakeSafeStorage());

    expect((await ant.ensureConfig(dataDir, 1633, 1634)).sealedPassword).toBe('matching-password');
    expect(configText()).not.toMatch(/^password:/m);
    expect(await opensKeystore(await keystore.unsealPassword(dataDir))).toBe(true);
  });

  test('a keystore that is not one keeps its config.yaml password, unsealed', async () => {
    fs.writeFileSync(swarmKeyPath, '{"address":"' + '11'.repeat(20) + '"}');
    fs.writeFileSync(configPath, 'password: some-password\n');
    const { ant, keystore } = loadAntManager(fakeSafeStorage());

    await expect(ant.ensureConfig(dataDir, 1633, 1634)).rejects.toThrow(keystore.REINJECT_MESSAGE);
    expect(configText()).toBe('password: some-password\n');
    expect(keystore.hasSealedPassword(dataDir)).toBe(false);
  });

  // Where nothing would be sealed (no keyring, or Linux's fallback key) the
  // check never runs, so a keyring-less host pays no scrypt per start: the
  // stale password is not migrated, and the start goes on as before (had
  // the check run, it would have refused this password).
  test('without a keyring the check never runs: nothing is migrated anyway', async () => {
    await writeRealKeystore('new-keystore-password');
    fs.writeFileSync(configPath, 'password: old-config-password\n');
    const storage =
      process.platform === 'linux'
        ? fakeSafeStorage({ prefix: 'v10' })
        : fakeSafeStorage({ available: false });
    const { ant } = loadAntManager(storage);

    expect((await ant.ensureConfig(dataDir, 1633, 1634)).sealedPassword).toBeNull();
    expect(configText()).toMatch(/^password: old-config-password$/m);
  });

  // A crash between writing keys/swarm.key and republishing its seal: the
  // seal records the SHA-256 of the keystore it was made for, so a new
  // keystore beside an old seal is a broken pair. The sealed password never
  // reaches Ant, and the start asks for re-injection (identity check first).
  test('a new swarm.key without its seal republished is a broken pair', async () => {
    fs.writeFileSync(swarmKeyPath, '{"address":"aa","old":true}');
    const storage = fakeSafeStorage();
    const { ant, keystore } = loadAntManager(storage);
    expect(await keystore.sealPassword(dataDir, 'pw-for-old-keystore')).toBe(true);
    fs.writeFileSync(configPath, 'api-addr: 127.0.0.1:1633\n');
    // Injection wrote a new keystore, and the process died before the seal.
    fs.writeFileSync(swarmKeyPath, '{"address":"aa","new":true}');
    storage.decryptStringAsync.mockClear();

    await expect(ant.ensureConfig(dataDir, 1633, 1634)).rejects.toThrow(keystore.REINJECT_MESSAGE);
    expect(storage.decryptStringAsync).not.toHaveBeenCalled();
    expect(configText()).toBe('api-addr: 127.0.0.1:1633\n');
    expect(keystore.hasSealedPassword(dataDir)).toBe(true);
  });

  test('a seal made before any keystore does not open a keystore written later', async () => {
    const { keystore } = loadAntManager(fakeSafeStorage());
    expect(await keystore.sealPassword(dataDir, 'pw-before-keystore')).toBe(true);
    expect(await keystore.unsealPassword(dataDir)).toBe('pw-before-keystore');

    fs.writeFileSync(swarmKeyPath, '{}');
    await expect(keystore.unsealPassword(dataDir)).rejects.toThrow(keystore.REINJECT_MESSAGE);
    // Sealing again binds it to the keystore now on disk.
    expect(await keystore.sealPassword(dataDir, 'pw-after-keystore')).toBe(true);
    expect(await keystore.unsealPassword(dataDir)).toBe('pw-after-keystore');
  });

  test('a seal whose keystore is gone is replaced with a new password', async () => {
    fs.writeFileSync(swarmKeyPath, '{}');
    const { ant, keystore } = loadAntManager(fakeSafeStorage());
    expect(await keystore.sealPassword(dataDir, 'pw-orphaned')).toBe(true);
    fs.rmSync(swarmKeyPath);

    const { sealedPassword } = await ant.ensureConfig(dataDir, 1633, 1634);
    expect(sealedPassword).toMatch(/^[0-9a-f]{64}$/);
    expect(await keystore.unsealPassword(dataDir)).toBe(sealedPassword);
  });

  test('a keystore whose sealed password will not open is never given a new one', async () => {
    fs.writeFileSync(swarmKeyPath, '{}');
    const storage = fakeSafeStorage();
    const { ant, keystore } = loadAntManager(storage);
    expect(await keystore.sealPassword(dataDir, 'original')).toBe(true);
    fs.writeFileSync(configPath, 'api-addr: 127.0.0.1:1633\n');
    storage.decryptStringAsync.mockRejectedValue(new Error('Error while decrypting the ciphertext'));

    await expect(ant.ensureConfig(dataDir, 1633, 1634)).rejects.toThrow(keystore.REINJECT_MESSAGE);
    expect(configText()).toBe('api-addr: 127.0.0.1:1633\n');
    expect(keystore.hasSealedPassword(dataDir)).toBe(true);
  });

  test('without a keystore, a sealed password that will not open is replaced', async () => {
    const storage = fakeSafeStorage();
    const { ant, keystore } = loadAntManager(storage);
    fs.writeFileSync(keystore.sealedPasswordPath(dataDir), 'bm90LXNlYWxlZA==');

    const { sealedPassword } = await ant.ensureConfig(dataDir, 1633, 1634);
    expect(sealedPassword).toMatch(/^[0-9a-f]{64}$/);
    expect(await keystore.unsealPassword(dataDir)).toBe(sealedPassword);
  });
});
