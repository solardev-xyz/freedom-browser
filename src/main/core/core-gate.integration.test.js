/**
 * Profile delete and freedom-cored's gate, against the real binary
 * (freedom-core design 0001, "Lifetime lock"). Skipped unless
 * FREEDOM_CORED_PATH points at a build, e.g.
 *   FREEDOM_CORED_PATH=freedom-cored-bin/linux-x64/freedom-cored npx jest src/main/core/core-gate
 * or FREEDOM_CORED_GATE_TEST=1 asks for the binary `npm run core:download`
 * fetched, which must then be there (CI's e2e-desktop job, on each OS).
 *
 * - a delete while the profile's core runs waits out the binary's 5 s of
 *   retries, then fails, and changes nothing; once the core has stopped, it
 *   goes through, and no core starts on the profile while it runs;
 * - the packaged default profile's delete, in the macOS and Windows layout
 *   (the lock directory inside the app data root), leaves another
 *   profile's running core its gate: a second core on that profile still
 *   can't start.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// FREEDOM_CORED_PATH is a development build's override.
jest.mock('electron', () => ({ app: { isPackaged: false } }), { virtual: true });

const { CoreClient } = require('./core-client');
const { getCoredBinaryPath } = require('./cored-binary');
const { withCoreGate } = require('./core-gate');
const { deleteProfile, ensureProfile, loadCatalog } = require('../profile-catalog');

const required = process.env.FREEDOM_CORED_GATE_TEST === '1';
const binary = process.env.FREEDOM_CORED_PATH || (required ? getCoredBinaryPath() : null);
if (required && !fs.existsSync(binary)) {
  throw new Error('FREEDOM_CORED_GATE_TEST=1 needs freedom-cored: run npm run core:download');
}
const describeIfBinary = binary ? describe : describe.skip;
const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
// Past the binary's 5 s of retries, with room to spare on a slow runner.
const REFUSAL_MS = 30_000;

function core(identityDir, lockDir) {
  return new CoreClient({
    spawn,
    command: binary,
    args: [
      'serve',
      '--data-dir',
      identityDir,
      '--lock-dir',
      lockDir,
      '--parent-pid',
      String(process.pid),
    ],
    log: quietLog,
    shellVersion: 'jest',
  });
}

describeIfBinary("profile delete and the real freedom-cored's gate", () => {
  let root;
  const running = [];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-core-gate-'));
  });

  afterEach(async () => {
    for (const client of running.splice(0)) await client.stop();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  async function started(identityDir, lockDir) {
    const client = core(identityDir, lockDir);
    running.push(client);
    await client.start();
    return client;
  }

  test(
    "a delete while the profile's core runs fails and changes nothing; once it has stopped, it goes through",
    async () => {
      const appRoot = path.join(root, 'Freedom Dev', 'freedom-browser-abcdef12');
      const lockDir = path.join(root, 'Freedom', 'locks');
      const options = {
        checkoutHash: 'abcdef12',
        defaultProfileDir: path.join(appRoot, 'Profiles', 'default'),
        dev: true,
      };
      ensureProfile(appRoot, 'default', options);
      const { record } = ensureProfile(appRoot, 'work', options);
      const identityDir = path.join(record.dir, 'identity');
      const workCore = await started(identityDir, lockDir);
      await expect(workCore.request('vault.status')).resolves.toMatchObject({ exists: false });
      const marker = path.join(identityDir, 'still-here');
      fs.writeFileSync(marker, 'the core is using this directory');
      const gate = (dir, fn) => withCoreGate(dir, fn, { lockDir, log: quietLog });

      const startedAt = Date.now();
      await expect(
        deleteProfile(appRoot, 'work', 'Work', { ...options, withCoreGate: gate })
      ).rejects.toMatchObject({ name: 'CoreGateError', code: 'lock_held' });
      // hold-lock waited out its contention retries before refusing.
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(4_500);
      expect(fs.readFileSync(marker, 'utf-8')).toBe('the core is using this directory');
      expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['default', 'work']);

      await workCore.stop();
      let coreDuringDelete = null;
      await deleteProfile(appRoot, 'work', 'Work', {
        ...options,
        withCoreGate: gate,
        // Under the core's gate, before anything is removed: no core starts.
        withIpfsGate: async (_dir, fn) => {
          const late = core(identityDir, lockDir);
          running.push(late);
          coreDuringDelete = await late.start().then(
            () => 'started',
            (err) => err.code
          );
          return fn();
        },
      });
      expect(coreDuringDelete).toBe('core_unavailable');
      expect(fs.existsSync(record.dir)).toBe(false);
      expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['default']);
    },
    REFUSAL_MS * 2
  );

  // macOS and Windows: <appData>/Freedom is both the packaged app data root
  // (the default profile's directory) and the lock directory's parent.
  test(
    "the default profile's delete leaves another profile's core its gate (macOS and Windows layout)",
    async () => {
      const appRoot = path.join(root, 'Freedom');
      const lockDir = path.join(appRoot, 'locks');
      ensureProfile(appRoot, 'default', { defaultProfileDir: appRoot });
      const { record: work } = ensureProfile(appRoot, 'work', { defaultProfileDir: appRoot });
      const workIdentity = path.join(work.dir, 'identity');
      await started(workIdentity, lockDir);

      await deleteProfile(appRoot, 'default', 'My Profile', {
        withCoreGate: (dir, fn) => withCoreGate(dir, fn, { lockDir, log: quietLog }),
      });

      expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['work']);
      expect(fs.existsSync(path.join(appRoot, 'identity'))).toBe(false);
      const second = core(workIdentity, lockDir);
      running.push(second);
      await expect(second.start()).rejects.toMatchObject({ code: 'core_unavailable' });
    },
    REFUSAL_MS
  );
});
