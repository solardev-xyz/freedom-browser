/**
 * Quick unlock against the real freedom-cored (freedom-core design 0013,
 * PRF-2b, and PRF-2d: quick-unlock.dat removed once enrolled). Skipped unless FREEDOM_CORED_PATH points at a build, or
 * FREEDOM_CORED_KEYSTORE_TEST=1 asks for the binary `npm run core:download`
 * fetched (CI's e2e-desktop job, on each OS, next to
 * keystore.integration.test.js).
 *
 * quick-unlock.js runs as main runs it, with Electron's Touch ID prompt and
 * `safeStorage` stood in for, and vault-backend.js talking to the real core
 * through main's `shell.keystore` executor and the real helper.
 *
 * - **Every OS:** a `secrets.json` that doesn't read refuses a password
 *   change and a vault delete with main's wording, and changes nothing.
 * - **Linux:** with no key store in the core, a profile's quick-unlock.dat
 *   keeps unlocking through the file, byte for byte (the refused enroll
 *   removes nothing), and Quick Setup is refused with nothing written.
 * - **macOS,** only with FREEDOM_TEST_KEYCHAIN naming the job's temporary
 *   keychain, the user's default (as in keystore.integration.test.js):
 *   - **the migration suite:** a v2 and a legacy quick-unlock.dat each
 *     unlock once through the file and then through the core, and the file
 *     goes once the core confirms the enroll; **downgrade:** the reference
 *     quick-unlock.js then finds no file and asks for the password; disable
 *     removes the core's credential;
 *   - a crash between the enroll and the removal: the next unlock goes
 *     through the core, then removes the file;
 *   - a password change keeps quick unlock: re-wrapped in the core; a
 *     profile still on the file alone is enrolled first, under the old
 *     vault, the file removed, and the change's re-wrap carries it across;
 *   - Quick Setup: the vault and its credential, and no quick-unlock.dat; a
 *     key-store refusal leaves no vault and deletes nothing;
 *   - **a replace waiting on `forget`** (PRF-2a left it to this step): an
 *     enroll over a key removed by hand makes a new one and records the
 *     old; main killed while the old one's `forget` waits, the profile's
 *     next open finishes it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const mockState = { userData: null, client: null, prompts: [], decrypts: 0 };
const STUB_PREFIX = 'stub-safe-storage:';
jest.mock(
  'electron',
  () => ({
    app: { isPackaged: true, getPath: () => mockState.userData },
    ipcMain: { handle() {} },
    systemPreferences: {
      canPromptTouchID: () => true,
      promptTouchID: async (reason) => {
        mockState.prompts.push(reason);
      },
    },
    // Electron's safeStorage, stood in for: reversible, and counted.
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (text) => Buffer.from(`stub-safe-storage:${text}`),
      decryptString: (buffer) => {
        mockState.decrypts += 1;
        return String(buffer).replace(/^stub-safe-storage:/, '');
      },
    },
  }),
  { virtual: true }
);
jest.mock('./logger', () => ({ info() {}, warn() {}, error() {}, debug() {} }));
jest.mock('./core/core-process', () => ({ getCoreClient: () => mockState.client }));
jest.mock('./profile-resolver', () => ({
  getActiveProfile: () => ({ id: 'default', userDataDir: mockState.userData }),
}));
// identity-manager's vault steps, reduced to their core calls (its own
// suite tests the rest).
jest.mock('./identity-manager', () => {
  const { vaultBackend } = require('./core/vault-backend');
  return {
    unlockVault: async (password) => {
      await vaultBackend.unlock(password);
    },
    quickUnlockVault: async () => {
      await vaultBackend.quickUnlock();
    },
    exportMnemonic: (password) => vaultBackend.exportMnemonic(password),
    quickExportMnemonic: () => vaultBackend.quickExportMnemonic(),
    assertPrivateKeyExportable() {},
    exportPrivateKeyForAccount: (index, password) => vaultBackend.exportPrivateKey(password, index),
    quickExportPrivateKeyForAccount: (index) => vaultBackend.quickExportPrivateKey(index),
    importExistingMnemonic: async (password, mnemonic, _knows, { quickUnlock = false } = {}) => {
      await vaultBackend.importVault(password, mnemonic, { quickUnlock });
    },
  };
});

const { CoreClient } = require('./core/core-client');
const { createHelperRunner, registerKeystoreShell } = require('./core/keystore-shell');
const { vaultBackend, _internal: backendInternal } = require('./core/vault-backend');
const quickUnlock = require('./quick-unlock');
const reference = require('../../test/reference/quick-unlock');

const sourceBinary = (() => {
  if (process.env.FREEDOM_CORED_PATH) return process.env.FREEDOM_CORED_PATH;
  if (process.env.FREEDOM_CORED_KEYSTORE_TEST !== '1') return null;
  const os_ = { darwin: 'mac', linux: 'linux', win32: 'win' }[process.platform];
  const name = process.platform === 'win32' ? 'freedom-cored.exe' : 'freedom-cored';
  const bin = path.join(__dirname, '..', '..', 'freedom-cored-bin', `${os_}-${process.arch}`, name);
  if (!fs.existsSync(bin)) {
    throw new Error('FREEDOM_CORED_KEYSTORE_TEST=1 needs freedom-cored: run npm run core:download');
  }
  return bin;
})();

/** The job's temporary keychain, when it is the user's default (as in
 * keystore.integration.test.js): the only keychain these tests touch. */
const testKeychain = (() => {
  const keychain = process.env.FREEDOM_TEST_KEYCHAIN;
  if (process.platform !== 'darwin' || !keychain) return null;
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return null;
    }
  };
  const out = spawnSync('security', ['default-keychain', '-d', 'user'], { encoding: 'utf8' });
  const actual = real(String(out.stdout || '').trim().replace(/^"|"$/g, ''));
  const expected = [keychain, `${keychain}-db`].map(real).filter(Boolean);
  return actual && expected.includes(actual) ? actual : null;
})();

if (sourceBinary && process.env.FREEDOM_KEYSTORE_REQUIRE_KEYCHAIN === '1' && !testKeychain) {
  throw new Error(
    "FREEDOM_KEYSTORE_REQUIRE_KEYCHAIN=1 needs FREEDOM_TEST_KEYCHAIN, the user's default keychain"
  );
}

const describeIfBinary = sourceBinary ? describe : describe.skip;
const describeIfLinux = process.platform === 'linux' ? describe : describe.skip;
const describeIfKeychain = testKeychain ? describe : describe.skip;

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
const MAIN = path.join(__dirname, '..', '..', 'test', 'helpers', 'keystore-main.js');
const ABANDON =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'quick-unlock-pass-1';
const NEW_PASSWORD = 'quick-unlock-pass-2';
const KEYCHAIN_SERVICE = 'baby.freedom.keystore';
const UNLOCK_PROMPT = 'unlock Freedom Browser';
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      let ok;
      try {
        ok = predicate();
      } catch {
        ok = false;
      }
      if (ok) resolve();
      else if (Date.now() > deadline) reject(new Error(`timed out waiting for ${label}`));
      else setTimeout(poll, 100);
    };
    poll();
  });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readSecrets(identityDir) {
  const file = path.join(identityDir, 'secrets.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

/** The ids a profile's secrets file names, and the committed one. */
function secretsItems(identityDir) {
  const secrets = readSecrets(identityDir);
  if (!secrets) return { committed: null, pending: [], forget: [], entries: [] };
  const key = secrets.keys?.unattended;
  return {
    committed: key?.item ?? null,
    pending: key?.pending ? [key.pending.item] : [],
    forget: (secrets.forget || []).map((record) => record.item),
    entries: Object.keys(secrets.entries || {}),
  };
}

function inKeychain(item) {
  return (
    spawnSync(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', item, testKeychain],
      { stdio: 'ignore' }
    ).status === 0
  );
}

describeIfBinary('quick unlock through the real freedom-cored (0013, PRF-2b, PRF-2d)', () => {
  let root;
  let identity;
  let lockDir;
  let envBefore;
  const clients = [];
  const children = [];
  const pids = [];

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-quick-unlock-')));
    identity = path.join(root, 'identity');
    lockDir = path.join(root, 'locks');
    fs.mkdirSync(identity, { mode: 0o700 });
    fs.mkdirSync(lockDir);
    mockState.userData = path.join(root, 'userData');
    fs.mkdirSync(mockState.userData);
    mockState.client = null;
    mockState.prompts = [];
    mockState.decrypts = 0;
    envBefore = process.env.FREEDOM_IDENTITY_DATA;
    process.env.FREEDOM_IDENTITY_DATA = identity;
    backendInternal.reset();
  });

  afterEach(async () => {
    Object.defineProperty(process, 'platform', originalPlatform);
    if (envBefore === undefined) delete process.env.FREEDOM_IDENTITY_DATA;
    else process.env.FREEDOM_IDENTITY_DATA = envBefore;
    for (const child of children.splice(0)) child.kill('SIGKILL');
    for (const pid of pids.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Gone.
      }
    }
    for (const client of clients.splice(0)) await client.stop().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  /** The profile's core, with main's executor running `helper` for it. */
  async function startCore({ helper = sourceBinary } = {}) {
    const runs = [];
    const runner = createHelperRunner({
      command: helper,
      spawn: (command, args, options) => {
        runs.push(args);
        return spawn(command, args, options);
      },
    });
    const client = new CoreClient({
      spawn,
      command: sourceBinary,
      args: ['serve', '--data-dir', identity, '--lock-dir', lockDir],
      log: quietLog,
      shellVersion: 'jest',
      grantRoot: identity,
    });
    registerKeystoreShell(client, { runner });
    clients.push(client);
    await client.start();
    mockState.client = client;
    return { client, runs };
  }

  async function stopCore(client) {
    clients.splice(clients.indexOf(client), 1);
    await client.stop();
    mockState.client = null;
  }

  const credentialPath = () => path.join(identity, 'quick-unlock.dat');
  const vaultPath = () => path.join(identity, 'identity-vault.json');

  function writeHelper(name, text) {
    const file = path.join(root, name);
    fs.writeFileSync(file, text, { mode: 0o755 });
    return file;
  }

  describe('every OS: a secrets.json that does not read', () => {
    test('refuses a password change and a vault delete in main\'s words, and changes nothing', async () => {
      await startCore();
      await vaultBackend.importVault(PASSWORD, ABANDON);
      const damaged = Buffer.from('{"version":1');
      fs.writeFileSync(path.join(identity, 'secrets.json'), damaged, { mode: 0o600 });
      const vault = fs.readFileSync(vaultPath());
      const refusal = {
        code: 'storage',
        data: { kind: 'malformed', file: 'secrets' },
        message: expect.stringMatching(/secrets\.json.*damaged.*Contact support/s),
      };

      await expect(
        quickUnlock.changePasswordKeepingQuickUnlock(PASSWORD, NEW_PASSWORD)
      ).rejects.toMatchObject(refusal);
      await expect(vaultBackend.deleteVault(PASSWORD)).rejects.toMatchObject(refusal);

      expect(fs.readFileSync(vaultPath())).toEqual(vault);
      expect(fs.readFileSync(path.join(identity, 'secrets.json'))).toEqual(damaged);
      await expect(vaultBackend.verifyPassword(PASSWORD)).resolves.toBeUndefined();
    }, 60_000);
  });

  describeIfLinux('Linux: no key store in the core', () => {
    test('quick-unlock.dat keeps unlocking through the file, byte for byte; the enroll is refused, nothing removed', async () => {
      await startCore();
      await vaultBackend.importVault(PASSWORD, ABANDON);
      // Main's code as on a Mac; the core is this OS's, with no key store.
      Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
      await expect(reference.enableQuickUnlock(PASSWORD)).resolves.toEqual({ success: true });
      const bytes = fs.readFileSync(credentialPath());

      for (const round of [1, 2]) {
        await vaultBackend.lock();
        await expect(quickUnlock.unlockWithTouchId()).resolves.toEqual({ success: true });
        expect(mockState.decrypts).toBe(round);
        expect((await vaultBackend.status()).unlocked).toBe(true);
      }
      await expect(vaultBackend.quickUnlockStatus()).resolves.toMatchObject({ enabled: false });
      expect(fs.readFileSync(credentialPath())).toEqual(bytes);
      expect(fs.existsSync(path.join(identity, 'secrets.json'))).toBe(false);
    }, 60_000);

    test('Quick Setup refused by the core: no vault, no file, nothing written', async () => {
      await startCore();
      Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
      const result = await quickUnlock.quickSetup(ABANDON);
      expect(result.success).toBe(false);
      expect((await vaultBackend.status()).exists).toBe(false);
      expect(fs.existsSync(credentialPath())).toBe(false);
      expect(fs.existsSync(path.join(identity, 'secrets.json'))).toBe(false);
    }, 60_000);
  });

  describeIfKeychain('macOS, with the temporary keychain', () => {
    test.each([
      ['v2', 'reference'],
      ['legacy', 'raw'],
    ])(
      'a %s quick-unlock.dat unlocks once through it, then through the core; downgrade; disable',
      async (kind, how) => {
        const { runs } = await startCore();
        await vaultBackend.importVault(PASSWORD, ABANDON);
        if (how === 'reference') {
          // As an older build wrote it.
          await expect(reference.enableQuickUnlock(PASSWORD)).resolves.toEqual({ success: true });
          expect(JSON.parse(fs.readFileSync(credentialPath(), 'utf8')).version).toBe(2);
        } else {
          fs.writeFileSync(credentialPath(), Buffer.from(`${STUB_PREFIX}${PASSWORD}`), {
            mode: 0o600,
          });
        }
        const bytes = fs.readFileSync(credentialPath());
        expect(secretsItems(identity).committed).toBeNull();
        await expect(quickUnlock.isQuickUnlockEnabled()).resolves.toBe(true);

        // Once through the file, then the enroll: a key made through main.
        await vaultBackend.lock();
        mockState.prompts = [];
        await expect(quickUnlock.unlockWithTouchId()).resolves.toEqual({ success: true });
        expect(mockState.prompts).toEqual([UNLOCK_PROMPT]);
        expect(mockState.decrypts).toBe(1);
        await expect(vaultBackend.quickUnlockStatus()).resolves.toEqual({
          enabled: true,
          policy: 'unattended',
          available: true,
        });
        const { committed: item } = secretsItems(identity);
        expect(item).toMatch(/^[0-9a-f]{32}$/);
        expect(inKeychain(item)).toBe(true);
        expect(runs.some((args) => args.includes('create'))).toBe(true);
        // Enrolled and confirmed: the file is gone.
        expect(bytes.length).toBeGreaterThan(0);
        expect(fs.existsSync(credentialPath())).toBe(false);

        // Then through the core, behind Touch ID: nothing to unseal.
        await vaultBackend.lock();
        const before = runs.length;
        await expect(quickUnlock.unlockWithTouchId()).resolves.toEqual({ success: true });
        expect(mockState.prompts).toEqual([UNLOCK_PROMPT, UNLOCK_PROMPT]);
        expect(mockState.decrypts).toBe(1);
        expect((await vaultBackend.status()).unlocked).toBe(true);
        expect(runs.slice(before)).toEqual([
          expect.arrayContaining(['--op', 'open', '--item', item, '--reason', 'quick_unlock']),
        ]);
        await expect(quickUnlock.exportMnemonicWithTouchId()).resolves.toEqual({
          success: true,
          mnemonic: ABANDON,
        });
        expect(runs.at(-1)).toEqual(expect.arrayContaining(['--reason', 'export']));
        expect(mockState.decrypts).toBe(1);

        // Downgrade: an older build reads only the file, finds none, and
        // asks for the password (the accepted cost, PRF-2d).
        await vaultBackend.lock();
        mockState.prompts = [];
        expect(reference.isQuickUnlockEnabled()).toBe(false);
        await expect(reference.unlockWithTouchId()).resolves.toEqual({
          success: false,
          error: 'Quick unlock not enabled',
        });
        expect(mockState.prompts).toEqual([]);
        expect((await vaultBackend.status()).unlocked).toBe(false);

        // Disable removes the core's entry and key (the file is gone already).
        await expect(quickUnlock.disableQuickUnlock()).resolves.toEqual({ success: true });
        expect(fs.existsSync(credentialPath())).toBe(false);
        await waitFor(
          () => !inKeychain(item) && secretsItems(identity).forget.length === 0,
          30_000,
          'the forget'
        );
        expect(secretsItems(identity)).toMatchObject({ committed: null, entries: [] });
        await expect(quickUnlock.isQuickUnlockEnabled()).resolves.toBe(false);
      },
      120_000
    );

    // PRF-2d, as the row's test list asks: main stopped after its enroll
    // and before the removal leaves the core's credential and the file. The
    // next unlock goes through the core, then removes the file.
    test('a crash between the enroll and the removal: the next unlock goes through the core, then removes the file', async () => {
      await startCore();
      await vaultBackend.importVault(PASSWORD, ABANDON);
      await expect(reference.enableQuickUnlock(PASSWORD)).resolves.toEqual({ success: true });
      const bytes = fs.readFileSync(credentialPath());
      // The migration's enroll, and nothing after it.
      await vaultBackend.quickUnlockEnroll(PASSWORD);
      await expect(vaultBackend.quickUnlockStatus()).resolves.toMatchObject({ enabled: true });
      expect(fs.readFileSync(credentialPath())).toEqual(bytes);

      await vaultBackend.lock();
      mockState.prompts = [];
      await expect(quickUnlock.unlockWithTouchId()).resolves.toEqual({ success: true });
      expect(mockState.prompts).toEqual([UNLOCK_PROMPT]);
      expect(mockState.decrypts).toBe(0);
      expect((await vaultBackend.status()).unlocked).toBe(true);
      expect(fs.existsSync(credentialPath())).toBe(false);
      expect(inKeychain(secretsItems(identity).committed)).toBe(true);
    }, 120_000);

    test('a password change keeps quick unlock: re-wrapped in the core', async () => {
      await startCore();
      await vaultBackend.importVault(PASSWORD, ABANDON);
      await expect(quickUnlock.enableQuickUnlock(PASSWORD)).resolves.toEqual({ success: true });
      const { committed: item } = secretsItems(identity);
      // Enable writes no quick-unlock.dat (PRF-2d).
      expect(fs.existsSync(credentialPath())).toBe(false);

      await quickUnlock.changePasswordKeepingQuickUnlock(PASSWORD, NEW_PASSWORD);
      await vaultBackend.verifyPassword(NEW_PASSWORD);
      await vaultBackend.lock();
      await expect(quickUnlock.unlockWithTouchId()).resolves.toEqual({ success: true });
      expect(mockState.decrypts).toBe(0);
      // The same key, the entry bound to the new vault; still no file.
      expect(secretsItems(identity)).toMatchObject({ committed: item, entries: ['quick-unlock'] });
      expect(fs.existsSync(credentialPath())).toBe(false);
    }, 120_000);

    test('a password change keeps quick unlock: enrolled first, for a profile on the file alone, the file removed, then re-wrapped', async () => {
      await startCore();
      await vaultBackend.importVault(PASSWORD, ABANDON);
      await reference.enableQuickUnlock(PASSWORD);
      expect(fs.existsSync(credentialPath())).toBe(true);

      await quickUnlock.changePasswordKeepingQuickUnlock(PASSWORD, NEW_PASSWORD);
      expect(fs.existsSync(credentialPath())).toBe(false);
      await expect(vaultBackend.quickUnlockStatus()).resolves.toMatchObject({ enabled: true });
      // The re-wrap finished: one entry, bound to the new vault.
      expect(secretsItems(identity)).toMatchObject({ entries: ['quick-unlock'] });
      await vaultBackend.lock();
      await expect(quickUnlock.unlockWithTouchId()).resolves.toEqual({ success: true });
      expect(mockState.decrypts).toBe(0);
    }, 120_000);

    test('Quick Setup: the vault with its credential, and no quick-unlock.dat', async () => {
      await startCore();
      await expect(quickUnlock.quickSetup(ABANDON)).resolves.toEqual({ success: true });
      expect(mockState.prompts).toEqual(['set up Freedom Browser with Touch ID']);
      const { committed: item } = secretsItems(identity);
      expect(inKeychain(item)).toBe(true);
      expect(fs.existsSync(credentialPath())).toBe(false);
      await expect(vaultBackend.quickUnlockStatus()).resolves.toMatchObject({ enabled: true });

      await vaultBackend.lock();
      await expect(quickUnlock.unlockWithTouchId()).resolves.toEqual({ success: true });
      expect(mockState.decrypts).toBe(0);
    }, 120_000);

    test('Quick Setup refused by the key store: no vault, nothing deleted; then it works', async () => {
      const cancelling = writeHelper(
        'cancelling',
        `#!/bin/sh\nprintf '%s\\n' '{"ok":false,"error":"cancelled"}'\n`
      );
      const first = await startCore({ helper: cancelling });
      await expect(quickUnlock.quickSetup(ABANDON)).resolves.toEqual({
        success: false,
        error: expect.stringMatching(/keychain request was cancelled/),
      });
      expect((await vaultBackend.status()).exists).toBe(false);
      expect(fs.existsSync(vaultPath())).toBe(false);
      expect(fs.existsSync(credentialPath())).toBe(false);
      expect(secretsItems(identity)).toMatchObject({ committed: null, entries: [] });
      await stopCore(first.client);

      await startCore();
      await expect(quickUnlock.quickSetup(ABANDON)).resolves.toEqual({ success: true });
      expect(inKeychain(secretsItems(identity).committed)).toBe(true);
    }, 120_000);

    // PRF-2's row: "Main killed while a replace ... waits on forget: the
    // profile's next open finishes it." A replace needs a dead committed
    // key: its item removed by hand, then an enroll.
    test('main killed while a replace waits on its forget: the next open finishes it', async () => {
      const first = await startCore();
      await vaultBackend.importVault(PASSWORD, ABANDON, { quickUnlock: true });
      const { committed: dead } = secretsItems(identity);
      await stopCore(first.client);
      expect(
        spawnSync('security', [
          'delete-generic-password',
          '-s',
          KEYCHAIN_SERVICE,
          '-a',
          dead,
          testKeychain,
        ]).status
      ).toBe(0);
      expect(inKeychain(dead)).toBe(false);

      // The helper as main runs it, except that a `forget` is held.
      const heldMarker = path.join(root, 'held.pid');
      const helper = writeHelper(
        'held-forget',
        [
          '#!/bin/sh',
          'case " $* " in',
          `  *" --op forget "*) echo $$ > '${heldMarker}'; exec sleep 60 ;;`,
          'esac',
          `exec '${sourceBinary}' "$@"`,
          '',
        ].join('\n')
      );
      const main = spawn(
        process.execPath,
        [MAIN, 'core', sourceBinary, helper, identity, lockDir, 'enroll', PASSWORD],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      children.push(main);
      let out = '';
      main.stdout.on('data', (chunk) => {
        out += chunk;
      });
      await waitFor(
        () => fs.existsSync(heldMarker) && out.includes('answered\n'),
        60_000,
        'the held forget'
      );
      const heldPid = Number(fs.readFileSync(heldMarker, 'utf8'));
      pids.push(heldPid);
      // The replace committed: a new key in use, the dead one waiting in
      // the file's forget list.
      const replaced = secretsItems(identity);
      expect(replaced.committed).toMatch(/^[0-9a-f]{32}$/);
      expect(replaced.committed).not.toBe(dead);
      expect(replaced.forget).toEqual([dead]);
      expect(inKeychain(replaced.committed)).toBe(true);
      const corePid = Number(out.match(/^core (\d+)$/m)[1]);
      main.kill('SIGKILL');
      process.kill(heldPid, 'SIGKILL');
      await waitFor(() => !isAlive(corePid), 30_000, 'the core to exit');
      expect(secretsItems(identity).forget).toEqual([dead]);

      // The next open drains it (a forget of a missing item counts as done),
      // and quick unlock works with the new key.
      await startCore();
      await waitFor(() => secretsItems(identity).forget.length === 0, 30_000, 'the drain');
      expect(secretsItems(identity).committed).toBe(replaced.committed);
      expect(inKeychain(replaced.committed)).toBe(true);
      await vaultBackend.lock();
      await expect(quickUnlock.unlockWithTouchId()).resolves.toEqual({ success: true });
    }, 120_000);
  });
});
