/**
 * Main's key-store executor and the drain of the forget file, against the
 * real freedom-cored (freedom-core design 0013, PRF-2). Skipped unless
 * FREEDOM_CORED_PATH points at a build, or FREEDOM_CORED_KEYSTORE_TEST=1
 * asks for the binary `npm run core:download` fetched (CI's e2e-desktop job,
 * on each OS).
 *
 * - **Linux and Windows:** the core asks main nothing. With a stand-in
 *   executor listening, `quick_unlock.*` and a `vault.import` with
 *   `quick_unlock: true` answer as cored 0.17.0 says, and nothing reaches
 *   it; main registers no executor there. A forget file copied from a Mac:
 *   the start's drain runs the real `forget-list`, which drops the foreign
 *   record, and no helper runs.
 * - **macOS,** only with FREEDOM_TEST_KEYCHAIN naming the job's temporary
 *   keychain, the user's default (CI makes it, as freedom-core's keychain
 *   job does; the login keychain is never touched):
 *   - the executor end to end: a `create`, `open`s and a `forget` through
 *     the helper, the core's answers as for a key it holds;
 *   - **the drain, killed at each step,** on profiles whose items the core
 *     made through main and whose `profile delete` recorded them: main
 *     killed after the delete answered and before the helper ran; the helper
 *     held past its 10 s, or killed after the Keychain removed the item and
 *     before it answered; main killed between the helper's answer and
 *     `forget-done`. At the next start of another profile the drain runs, and
 *     the keychain holds none of the deleted profiles' items. Two mains
 *     draining at once: neither item is left, each answer is ok, not_found
 *     or (a forget racing the other's delete) the Keychain's `backend`,
 *     which keeps the record; the file is empty after one more drain at
 *     most, and a live profile's item stays;
 *   - main killed while a quick-unlock disable or a vault delete waits on
 *     its `forget`: the profile's next open finishes it.
 * - **Linux:** the same drain steps, with the real subcommands and a
 *   stand-in key store (one file per item) behind a stand-in helper, so
 *   every runner checks the steps; macOS checks them on the Keychain.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

jest.mock('electron', () => ({ app: { isPackaged: true } }), { virtual: true });
jest.mock('./logger', () => ({ info() {}, warn() {}, error() {}, debug() {} }));
let mockBinary = null;
let mockLockDir = null;
jest.mock('./core/cored-binary', () => ({ getCoredBinaryPath: () => mockBinary }));
jest.mock('./service-locks', () => ({ getLockDir: () => mockLockDir }));

const { CoreClient } = require('./core/core-client');
const { createHelperRunner, registerKeystoreShell } = require('./core/keystore-shell');
const { drainAfterFirstWindow, drainForgetFile } = require('./keystore-drain');
const { openProfile } = require('./profile-resolver');
const subcommands = require('./profile-subcommands');

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

/** The job's temporary keychain, when it is the user's default: the only
 * keychain these tests touch. Its file is the name macOS gives it (with
 * `-db`, as `create-keychain` makes it), compared by real path. */
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
const describeOffMacos = process.platform === 'darwin' ? describe.skip : describe;
const describeIfKeychain = testKeychain ? describe : describe.skip;
// Where the drain's steps run: the Keychain on macOS, a stand-in on Linux.
const describeIfDrainStore =
  testKeychain || process.platform === 'linux' ? describe : describe.skip;

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
const MAIN = path.join(__dirname, '..', '..', 'test', 'helpers', 'keystore-main.js');
const ABANDON =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ABANDON_WALLET = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const PASSWORD = 'keystore-pass-1';
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const KEYCHAIN_SERVICE = 'baby.freedom.keystore';
// The helper's answers to a forget that clear a record (0013, "Forgetting an
// item"): Done and NotFound.
const CLEARS = ['{"ok":true}', '{"ok":false,"error":"not_found"}'];

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

/** The ids a profile's secrets file names: keys in use, `pending`, `forget`. */
function namedItems(identityDir) {
  const file = path.join(identityDir, 'secrets.json');
  if (!fs.existsSync(file)) return [];
  const secrets = JSON.parse(fs.readFileSync(file, 'utf8'));
  const items = [];
  for (const key of Object.values(secrets.keys || {})) {
    if (key?.item) items.push(key.item);
    if (key?.pending) items.push(key.pending);
  }
  for (const record of secrets.forget || []) items.push(record.item);
  return items;
}

function forgetFile(appRoot) {
  return path.join(appRoot, 'profile-registry.json.forget');
}

/** The items the app's forget file names. */
function recordedItems(appRoot) {
  if (!fs.existsSync(forgetFile(appRoot))) return [];
  const file = JSON.parse(fs.readFileSync(forgetFile(appRoot), 'utf8'));
  return file.deleted.flatMap((record) => record.items.map((item) => item.item));
}

describeIfBinary('the key store through main, with the real freedom-cored (0013, PRF-2)', () => {
  let root;
  let appRoot;
  let app;
  const clients = [];
  const children = [];
  const pids = [];

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-keystore-')));
    appRoot = path.join(root, 'Freedom');
    mockBinary = sourceBinary;
    mockLockDir = path.join(root, 'locks');
    fs.mkdirSync(mockLockDir);
    app = { isPackaged: true, getPath: () => appRoot, setPath() {} };
  });

  afterEach(async () => {
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

  /** `profile open` for `id`, as a launch of it makes it. */
  function launch(id) {
    return openProfile(app, {
      backend: 'core',
      argv: ['freedom', '--profile', id],
      env: {},
      command: mockBinary,
      lockDir: mockLockDir,
    });
  }

  function core(identityDir, register) {
    const client = new CoreClient({
      spawn,
      command: sourceBinary,
      args: ['serve', '--data-dir', identityDir, '--lock-dir', mockLockDir],
      log: quietLog,
      shellVersion: 'jest',
      grantRoot: identityDir,
    });
    register(client);
    clients.push(client);
    return client;
  }

  async function stop(client) {
    clients.splice(clients.indexOf(client), 1);
    await client.stop();
  }

  describeOffMacos('Linux and Windows: the core asks main nothing', () => {
    test('quick unlock answers unsupported, and no request reaches an executor', async () => {
      const identity = path.join(root, 'identity');
      const asked = jest.fn();
      let registered = null;
      const client = core(identity, (c) => {
        registered = registerKeystoreShell(c, { runner: { run: asked } });
        // A stand-in executor, listening for any request the core sends.
        c.handle('shell.keystore', asked);
      });
      expect(registered).toBe(false);
      await client.start();
      const shell = { caller: 'shell' };
      const chrome = { caller: 'chrome' };

      await expect(client.request('quick_unlock.status', {}, chrome)).resolves.toEqual({
        enabled: false,
        policy: null,
        available: false,
      });
      await expect(
        client.request(
          'vault.import',
          { password_b64: b64(PASSWORD), mnemonic_b64: b64(ABANDON), quick_unlock: true },
          shell
        )
      ).rejects.toMatchObject({ code: 'key_store_unavailable', data: { reason: 'unsupported' } });
      await client.request(
        'vault.import',
        { password_b64: b64(PASSWORD), mnemonic_b64: b64(ABANDON) },
        shell
      );
      await expect(
        client.request('quick_unlock.enroll', { password_b64: b64(PASSWORD) }, shell)
      ).rejects.toMatchObject({ code: 'key_store_unavailable', data: { reason: 'unsupported' } });
      await expect(client.request('quick_unlock.unlock', {}, chrome)).rejects.toMatchObject({
        code: 'not_found',
      });
      await expect(client.request('quick_unlock.disable', {}, chrome)).resolves.toEqual({});
      // No credential: the change and the delete ask the key store nothing.
      await client.request(
        'vault.change_password',
        { password_b64: b64(PASSWORD), new_password_b64: b64(`${PASSWORD}x`) },
        shell
      );
      await client.request('vault.delete', { password_b64: b64(`${PASSWORD}x`) }, shell);

      expect(asked).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(identity, 'secrets.json'))).toBe(false);
    }, 60_000);

    test("a record copied from macOS: the drain's forget-list drops it, and no helper runs", async () => {
      launch('home');
      // A deleted profile's record from a Mac, as an app root copied from
      // one brings it: its backend isn't this OS's (0013, "An item already
      // gone").
      const item = crypto.randomBytes(16).toString('hex');
      const record = {
        version: 1,
        deleted: [
          {
            id: 'copied',
            dir: path.join(appRoot, 'Profiles', 'copied'),
            items: [{ backend: 'macos-keychain', policy: 'unattended', item }],
          },
        ],
      };
      fs.writeFileSync(forgetFile(appRoot), JSON.stringify(record, null, 2), { mode: 0o600 });

      const opened = launch('home');
      expect(opened.report.forgetPending).toBe(1);
      const runner = { run: jest.fn() };
      await expect(
        drainAfterFirstWindow({
          resolver: {
            getProfileLaunchReport: () => opened.report,
            getActiveProfile: () => opened.profile,
          },
          runner,
          log: quietLog,
        })
      ).resolves.toEqual({ forgotten: 0, kept: 0 });
      expect(runner.run).not.toHaveBeenCalled();
      expect(recordedItems(appRoot)).toEqual([]);
      // The next start has nothing pending.
      expect(launch('home').report.forgetPending).toBe(0);
    }, 60_000);
  });

  /**
   * The key store the drain's steps run against: the temporary keychain
   * and the real helper on macOS; on Linux a directory of item files and a
   * stand-in helper.
   */
  function drainStore() {
    const helpers = path.join(root, 'helpers');
    fs.mkdirSync(helpers, { recursive: true });
    const script = (name, text) => {
      const file = path.join(helpers, name);
      fs.writeFileSync(file, text, { mode: 0o755 });
      return file;
    };
    const heldMarker = path.join(root, 'held.pid');
    if (testKeychain) {
      return {
        has: (item) =>
          spawnSync(
            'security',
            ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', item, testKeychain],
            {
              stdio: 'ignore',
            }
          ).status === 0,
        helper(kind) {
          if (kind === 'real') return sourceBinary;
          if (kind === 'held')
            return script('held', `#!/bin/sh\necho $$ > '${heldMarker}'\nexec sleep 60\n`);
          // Killed after the Keychain removed the item, before it answered.
          return script('killed', `#!/bin/sh\n'${sourceBinary}' "$@" > /dev/null\nkill -9 $$\n`);
        },
        heldMarker,
        // What the Keychain gives a forget that races another process's
        // delete of the same item: an OSStatus outside the helper's table,
        // so `backend`. It keeps the record, as 0013 says any answer but ok
        // and not_found does, and a later drain finds the item gone.
        racedForget: ['{"ok":false,"error":"backend","reason":"status"}'],
        // A profile whose core made its quick-unlock item through main: the
        // profile, and the item its secrets file names.
        async makeLive(id) {
          const opened = launch(id);
          const identity = path.join(opened.profile.userDataDir, 'identity');
          const client = core(identity, (c) =>
            registerKeystoreShell(c, { runner: createHelperRunner({ command: sourceBinary }) })
          );
          await client.start();
          await client.request(
            'vault.import',
            { password_b64: b64(PASSWORD), mnemonic_b64: b64(ABANDON), quick_unlock: true },
            { caller: 'shell' }
          );
          await stop(client);
          const items = namedItems(identity);
          expect(items).toHaveLength(1);
          expect(this.has(items[0])).toBe(true);
          return { opened, item: items[0] };
        },
        async makeDeleted(id) {
          const { opened, item } = await this.makeLive(id);
          const { result } = await subcommands.run(
            sourceBinary,
            [
              'profile',
              'delete',
              '--app-root',
              appRoot,
              '--lock-dir',
              mockLockDir,
              '--id',
              id,
              '--confirm-display-name',
              opened.profile.displayName,
            ],
            { timeoutMs: 0 }
          );
          expect(result.forget).toEqual([{ policy: 'unattended', item }]);
          return result.forget;
        },
      };
    }
    const store = path.join(root, 'store');
    fs.mkdirSync(store);
    const prelude = [
      `#!${process.execPath}`,
      "const fs = require('fs');",
      "const path = require('path');",
      'const args = process.argv.slice(2);',
      'const flag = (name) => args[args.indexOf(name) + 1];',
      'fs.readFileSync(0);',
      `const file = path.join(${JSON.stringify(store)}, flag('--item'));`,
    ].join('\n');
    const remove = 'let gone = true; try { fs.unlinkSync(file); } catch { gone = false; }';
    return {
      has: (item) => fs.existsSync(path.join(store, item)),
      helper(kind) {
        if (kind === 'real') {
          return script(
            'stand-in',
            `${prelude}\nif (flag('--op') !== 'forget') { process.stdout.write('{"ok":false,"error":"backend"}\\n'); process.exit(0); }\n${remove}\nprocess.stdout.write(gone ? '{"ok":true}\\n' : '{"ok":false,"error":"not_found"}\\n');\n`
          );
        }
        if (kind === 'held') {
          return script(
            'held',
            `${prelude}\nfs.writeFileSync(${JSON.stringify(heldMarker)}, String(process.pid));\nAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);\n`
          );
        }
        return script('killed', `${prelude}\n${remove}\nprocess.kill(process.pid, 'SIGKILL');\n`);
      },
      heldMarker,
      // One unlink wins, and the other finds no file: never another answer.
      racedForget: [],
      // An item in the stand-in store that no record names.
      async makeLive() {
        const item = crypto.randomBytes(16).toString('hex');
        fs.writeFileSync(path.join(store, item), 'key');
        return { item };
      },
      // A deleted profile's record, as `profile delete` writes it, and its
      // item in the stand-in store.
      async makeDeleted(id) {
        const { item } = await this.makeLive();
        const file = fs.existsSync(forgetFile(appRoot))
          ? JSON.parse(fs.readFileSync(forgetFile(appRoot), 'utf8'))
          : { version: 1, deleted: [] };
        file.deleted.push({
          id,
          dir: path.join(appRoot, 'Profiles', id),
          items: [{ backend: 'secret-service', policy: 'unattended', item }],
        });
        fs.writeFileSync(forgetFile(appRoot), JSON.stringify(file, null, 2), { mode: 0o600 });
        return [{ policy: 'unattended', item }];
      },
    };
  }

  /** keystore-main.js as main, its stdout collected. */
  function runMain(args) {
    const child = spawn(process.execPath, [MAIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    child.out = '';
    child.err = '';
    child.stdout.on('data', (chunk) => {
      child.out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      child.err += chunk;
    });
    child.exited = new Promise((resolve) =>
      child.on('close', (code, signal) => resolve({ code, signal }))
    );
    return child;
  }

  async function killAt(child, step) {
    await waitFor(() => child.out.includes(`at ${step}\n`), 60_000, `main at ${step}`);
    child.kill('SIGKILL');
    expect(await child.exited).toEqual({ code: null, signal: 'SIGKILL' });
  }

  /** What the helper answered each of a main's forgets, by item: the line,
   * or `failed <code>` for a run that gave none. */
  function helperAnswers(child) {
    const answers = new Map();
    for (const [, item, answer] of child.out.matchAll(/^answer (\S+) (.*)$/gm)) {
      answers.set(item, answer);
    }
    for (const [, item, code] of child.out.matchAll(/^failed (\S+) (.*)$/gm)) {
      answers.set(item, `failed ${code}`);
    }
    return answers;
  }

  async function ends(child) {
    const exit = await child.exited;
    expect({ exit, err: child.err }).toEqual({ exit: { code: 0, signal: null }, err: '' });
    return JSON.parse(child.out.match(/^done (.*)$/m)[1]);
  }

  /** The next start of another profile: `profile open` reports the
   * pending items, and the drain runs after its first window. */
  async function nextStart(store) {
    const opened = launch('home');
    expect(opened.report.forgetPending).toBeGreaterThan(0);
    return drainAfterFirstWindow({
      resolver: {
        getProfileLaunchReport: () => opened.report,
        getActiveProfile: () => opened.profile,
      },
      runner: createHelperRunner({ command: store.helper('real') }),
      // The drain's own steps, whatever key store this runner stands up.
      platform: 'darwin',
      log: quietLog,
    });
  }

  describeIfDrainStore('the drain of the forget file, main killed at each step', () => {
    let store;

    beforeEach(() => {
      launch('home');
      store = drainStore();
    });

    test('main killed after profile delete answered, before the helper ran', async () => {
      const forget = await store.makeDeleted('gone');
      const main = runMain([
        'forget',
        sourceBinary,
        store.helper('real'),
        appRoot,
        'before-helper',
        JSON.stringify(forget),
      ]);
      await killAt(main, 'before-helper');
      expect(store.has(forget[0].item)).toBe(true);
      expect(recordedItems(appRoot)).toEqual([forget[0].item]);

      await expect(nextStart(store)).resolves.toEqual({ forgotten: 1, kept: 0 });
      expect(store.has(forget[0].item)).toBe(false);
      expect(recordedItems(appRoot)).toEqual([]);
    }, 120_000);

    test("the helper held past forget's 10 s: killed, and the record kept", async () => {
      const forget = await store.makeDeleted('held');
      const started = Date.now();
      const main = runMain([
        'forget',
        sourceBinary,
        store.helper('held'),
        appRoot,
        '-',
        JSON.stringify(forget),
      ]);
      await expect(ends(main)).resolves.toEqual({ forgotten: 0, kept: 1 });
      expect(Date.now() - started).toBeGreaterThanOrEqual(10_000);
      const heldPid = Number(fs.readFileSync(store.heldMarker, 'utf8'));
      pids.push(heldPid);
      expect(isAlive(heldPid)).toBe(false);
      expect(store.has(forget[0].item)).toBe(true);
      expect(recordedItems(appRoot)).toEqual([forget[0].item]);

      await expect(nextStart(store)).resolves.toEqual({ forgotten: 1, kept: 0 });
      expect(store.has(forget[0].item)).toBe(false);
      expect(recordedItems(appRoot)).toEqual([]);
    }, 120_000);

    test('the helper killed after the key store removed the item, before it answered', async () => {
      const forget = await store.makeDeleted('killed');
      const main = runMain([
        'forget',
        sourceBinary,
        store.helper('killed'),
        appRoot,
        '-',
        JSON.stringify(forget),
      ]);
      await expect(ends(main)).resolves.toEqual({ forgotten: 0, kept: 1 });
      expect(store.has(forget[0].item)).toBe(false);
      expect(recordedItems(appRoot)).toEqual([forget[0].item]);

      // Its forget answers not_found, which counts as done.
      await expect(nextStart(store)).resolves.toEqual({ forgotten: 1, kept: 0 });
      expect(recordedItems(appRoot)).toEqual([]);
    }, 120_000);

    test("main killed between the helper's answer and forget-done", async () => {
      const forget = await store.makeDeleted('answered');
      const main = runMain([
        'forget',
        sourceBinary,
        store.helper('real'),
        appRoot,
        'before-forget-done',
        JSON.stringify(forget),
      ]);
      await killAt(main, 'before-forget-done');
      expect(store.has(forget[0].item)).toBe(false);
      expect(recordedItems(appRoot)).toEqual([forget[0].item]);

      await expect(nextStart(store)).resolves.toEqual({ forgotten: 1, kept: 0 });
      expect(recordedItems(appRoot)).toEqual([]);
    }, 120_000);

    test("two profiles' mains draining at once: no item left, the file empty after one more drain, a live item kept", async () => {
      const live = await store.makeLive('live');
      const items = [...(await store.makeDeleted('one')), ...(await store.makeDeleted('two'))];
      const ids = items.map((i) => i.item).sort();
      expect(recordedItems(appRoot).sort()).toEqual(ids);
      // Lined up before their first helper, so each has listed both items.
      const release = path.join(root, 'release');
      const mains = [0, 1].map(() =>
        runMain(['drain', sourceBinary, store.helper('real'), appRoot, `before-helper@${release}`])
      );
      await Promise.all(
        mains.map((main) =>
          waitFor(() => main.out.includes('at before-helper\n'), 60_000, 'main at before-helper')
        )
      );
      fs.writeFileSync(release, '');
      const counts = await Promise.all(mains.map(ends));
      const answers = mains.map(helperAnswers);
      // TEMPORARY diagnostic, removed before review.
      if (process.env.FREEDOM_DIAG_DRAIN) {
        console.log(`DIAG ${JSON.stringify(counts)}\n${mains.map((m) => m.out).join('---\n')}`);
      }

      // Each main asked the helper about both items. Every answer is one
      // that clears a record (ok, not_found), or the one the store gives a
      // forget racing the other main's: nothing else.
      expect(answers.map((byItem) => [...byItem.keys()].sort())).toEqual([ids, ids]);
      const allowed = [...CLEARS, ...store.racedForget];
      const unexpected = answers.flatMap((byItem) =>
        [...byItem.values()].filter((answer) => !allowed.includes(answer))
      );
      expect(unexpected).toEqual([]);
      // Each counted gone exactly the items whose answer clears a record
      // (0013: only ok and not_found do), and kept the rest.
      const cleared = answers.map((byItem) => ids.filter((id) => CLEARS.includes(byItem.get(id))));
      expect(counts).toEqual(
        cleared.map((gone) => ({ forgotten: gone.length, kept: ids.length - gone.length }))
      );
      // Neither item is left in the store.
      for (const id of ids) expect(store.has(id)).toBe(false);
      // The file keeps exactly the records no main cleared, and the next
      // drain clears them: their forget answers not_found now.
      const left = ids.filter((id) => !cleared.some((gone) => gone.includes(id)));
      expect(recordedItems(appRoot).sort()).toEqual(left);
      await expect(
        drainForgetFile(appRoot, {
          runner: createHelperRunner({ command: store.helper('real') }),
          platform: 'darwin',
          log: quietLog,
        })
      ).resolves.toEqual({ forgotten: left.length, kept: 0 });
      expect(recordedItems(appRoot)).toEqual([]);
      expect(launch('home').report.forgetPending).toBe(0);
      // No drain touched the item of a profile still in use.
      expect(store.has(live.item)).toBe(true);
    }, 120_000);
  });

  describeIfKeychain('macOS: the executor, with the temporary keychain', () => {
    let store;

    beforeEach(() => {
      launch('home');
      store = drainStore();
    });

    test("create, open and forget through main: the core's answers as for a key it holds", async () => {
      const opened = launch('quick');
      const identity = path.join(opened.profile.userDataDir, 'identity');
      const runs = [];
      const runner = createHelperRunner({
        command: sourceBinary,
        spawn: (command, args, options) => {
          runs.push({ args, stdio: options.stdio });
          return spawn(command, args, options);
        },
      });
      let registered = null;
      const client = core(identity, (c) => {
        registered = registerKeystoreShell(c, { runner });
      });
      expect(registered).toBe(true);
      await client.start();
      const chrome = { caller: 'chrome' };
      await client.request(
        'vault.import',
        { password_b64: b64(PASSWORD), mnemonic_b64: b64(ABANDON), quick_unlock: true },
        { caller: 'shell' }
      );
      await expect(client.request('quick_unlock.status', {}, chrome)).resolves.toEqual({
        enabled: true,
        policy: 'unattended',
        available: true,
      });
      const [item] = namedItems(identity);
      expect(store.has(item)).toBe(true);
      expect(runs[0].args.slice(0, 7)).toEqual([
        'keystore',
        '--op',
        'create',
        '--policy',
        'unattended',
        '--item',
        item,
      ]);
      expect(runs[0].args[7]).toBe('--reply-key');
      expect(runs[0].args).toHaveLength(9);
      expect(runs[0].stdio[0]).toBe('ignore');

      await client.request('vault.lock', {}, chrome);
      await expect(client.request('quick_unlock.unlock', {}, chrome)).resolves.toMatchObject({
        addresses: { user_wallet: ABANDON_WALLET },
      });
      expect(runs.at(-1).args).toEqual(
        expect.arrayContaining(['--op', 'open', '--item', item, '--reason', 'quick_unlock'])
      );
      const { mnemonic_b64: mnemonic } = await client.request(
        'quick_unlock.export_mnemonic',
        {},
        chrome
      );
      expect(Buffer.from(mnemonic, 'base64').toString('utf8')).toBe(ABANDON);
      expect(runs.at(-1).args).toEqual(expect.arrayContaining(['--reason', 'export']));

      await expect(client.request('quick_unlock.disable', {}, chrome)).resolves.toEqual({});
      await waitFor(
        () => !store.has(item) && namedItems(identity).length === 0,
        30_000,
        'the forget'
      );
      expect(runs.at(-1).args).toEqual([
        'keystore',
        '--op',
        'forget',
        '--policy',
        'unattended',
        '--item',
        item,
      ]);
      await expect(client.request('quick_unlock.status', {}, chrome)).resolves.toMatchObject({
        enabled: false,
      });
    }, 120_000);

    test.each(['disable', 'delete'])(
      'main killed while a %s waits on its forget: the next open finishes it',
      async (action) => {
        const opened = launch(`held-${action}`);
        const identity = path.join(opened.profile.userDataDir, 'identity');
        const first = core(identity, (c) =>
          registerKeystoreShell(c, { runner: createHelperRunner({ command: sourceBinary }) })
        );
        await first.start();
        await first.request(
          'vault.import',
          { password_b64: b64(PASSWORD), mnemonic_b64: b64(ABANDON), quick_unlock: true },
          { caller: 'shell' }
        );
        await stop(first);
        const [item] = namedItems(identity);
        expect(store.has(item)).toBe(true);

        const main = runMain([
          'core',
          sourceBinary,
          store.helper('held'),
          identity,
          mockLockDir,
          action,
          PASSWORD,
        ]);
        await waitFor(
          () => fs.existsSync(store.heldMarker) && main.out.includes('answered\n'),
          60_000,
          'the held forget'
        );
        const heldPid = Number(fs.readFileSync(store.heldMarker, 'utf8'));
        pids.push(heldPid);
        // The change committed, and its key waits in the file's forget list.
        expect(namedItems(identity)).toEqual([item]);
        const corePid = Number(main.out.match(/^core (\d+)$/m)[1]);
        main.kill('SIGKILL');
        process.kill(heldPid, 'SIGKILL');
        // The core sees main gone, and exits.
        await waitFor(() => !isAlive(corePid), 30_000, 'the core to exit');
        expect(store.has(item)).toBe(true);

        const next = core(identity, (c) =>
          registerKeystoreShell(c, { runner: createHelperRunner({ command: sourceBinary }) })
        );
        await next.start();
        await waitFor(
          () => !store.has(item) && namedItems(identity).length === 0,
          30_000,
          'the drain'
        );
        await stop(next);
      },
      120_000
    );
  });
});
