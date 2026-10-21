/**
 * freedom-ipfsd's gate against the real binary (freedom-core design 0007,
 * "Lifetime lock" and "Crashes, hangs and restarts"). Skipped unless
 * FREEDOM_IPFSD_PATH points at a build, e.g.
 *   FREEDOM_IPFSD_PATH=freedom-ipfsd-bin/linux-x64/freedom-ipfsd npx jest src/main/ipfs/ipfsd-gate
 *
 * - `hold-lock` against a running service is refused (75);
 * - a service started while `hold-lock` holds the gate exits 75, and isn't
 *   restarted;
 * - a profile delete while a service writes the profile's IPFS data fails,
 *   and removes nothing; once the service has stopped, it goes through;
 * - with the add-on downloaded too (`npm run ipfs:download`), the add-on runs
 *   under hold-lock (Rollback): a service on its directory exits 75 while
 *   the add-on runs, and starts once the add-on has stopped; and an add-on
 *   start waiting out a service's gate gives up at once when stopped.
 *
 * Each refusal waits out the binary's 5 s of contention retries.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { holdIpfsGate, takeIpfsGate, withIpfsGate } = require('./ipfsd-gate');
const { FreedomIpfsdNode } = require('./freedom-ipfsd-node');
const { FreedomIpfsNativeNode } = require('./freedom-ipfs-native-node');
const { isNativeBindingAvailable } = require('./freedom-ipfs-native-binding');
const { deleteProfile, ensureProfile, loadCatalog } = require('../profile-catalog');

const binary = process.env.FREEDOM_IPFSD_PATH;
const describeIfBinary = binary ? describe : describe.skip;
const testIfAddon = isNativeBindingAvailable() ? test : test.skip;
const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
// Past the binary's 5 s of retries, with room to spare on a slow runner.
const REFUSAL_MS = 30_000;

describeIfBinary('the IPFS data directory gate with the real freedom-ipfsd', () => {
  let root;
  let lockDir;
  const running = [];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-ipfsd-gate-'));
    lockDir = path.join(root, 'locks');
  });

  afterEach(async () => {
    for (const stop of running.splice(0)) await stop();
    // Windows may hold the store's files a moment after the process exits.
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  /** A persistent service on `dataDir`, counting the processes it spawns. */
  function service(dataDir) {
    const spawned = [];
    const node = new FreedomIpfsdNode({
      dataDir,
      lockDir,
      log: quietLog,
      shellVersion: 'jest',
      spawn: (...args) => {
        const child = spawn(...args);
        spawned.push(child);
        return child;
      },
    });
    running.push(() => node.stop());
    return { node, spawned };
  }

  const hold = (dataDir) => holdIpfsGate({ dataDir, lockDir, log: quietLog });

  test(
    'hold-lock against a running service is refused: 75, lock_held',
    async () => {
      const dataDir = path.join(root, 'ipfs-data', 'freedom-ipfs');
      const { node } = service(dataDir);
      await expect(node.start()).resolves.toBe(true);

      const started = Date.now();
      await expect(hold(dataDir)).rejects.toMatchObject({
        name: 'IpfsGateError',
        code: 'lock_held',
      });
      // It retried for 5 s first.
      expect(Date.now() - started).toBeGreaterThanOrEqual(4_500);
      expect(node.isHealthy()).toBe(true);
    },
    REFUSAL_MS
  );

  test(
    "a service started under hold-lock exits 75, and isn't restarted; once released, it starts",
    async () => {
      const dataDir = path.join(root, 'ipfs-data', 'freedom-ipfs');
      const held = await hold(dataDir);

      const first = service(dataDir);
      await expect(first.node.start()).resolves.toBe(false);
      expect(first.spawned).toHaveLength(1);
      expect(first.spawned[0].exitCode).toBe(75);
      expect(first.node.state).toBe('failed');
      // No restart: still the one process, after the back-off would have run.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(first.spawned).toHaveLength(1);

      await held.release();
      const second = service(dataDir);
      await expect(second.node.start()).resolves.toBe(true);
    },
    REFUSAL_MS
  );

  test(
    "a profile delete while a service writes the profile's IPFS data fails, and removes nothing",
    async () => {
      const appRoot = path.join(root, 'Freedom');
      const options = { defaultProfileDir: path.join(appRoot, 'Profiles', 'default') };
      ensureProfile(appRoot, 'default', options);
      const { record } = ensureProfile(appRoot, 'work', options);
      const dataDir = path.join(record.dir, 'ipfs-data', 'freedom-ipfs');
      const { node } = service(dataDir);
      await expect(node.start()).resolves.toBe(true);
      const gate = (dir, fn) => withIpfsGate(dir, fn, { lockDir, log: quietLog });

      await expect(
        deleteProfile(appRoot, 'work', 'Work', { ...options, withIpfsGate: gate })
      ).rejects.toMatchObject({ code: 'lock_held' });
      expect(fs.existsSync(path.join(dataDir, 'freedom-ipfs.sqlite3'))).toBe(true);
      expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['default', 'work']);

      await node.stop();
      await deleteProfile(appRoot, 'work', 'Work', { ...options, withIpfsGate: gate });
      expect(fs.existsSync(record.dir)).toBe(false);
      expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['default']);
    },
    REFUSAL_MS
  );

  testIfAddon(
    'the add-on runs under hold-lock: a service on its directory exits 75 until the add-on stops',
    async () => {
      const dataDir = path.join(root, 'ipfs-data', 'freedom-ipfs');
      const addon = new FreedomIpfsNativeNode({
        dataDir,
        takeGate: (options) => takeIpfsGate(dataDir, { ...options, lockDir, log: quietLog }),
      });
      running.push(() => addon.stop());
      await expect(addon.start()).resolves.toBe(true);

      const refused = service(dataDir);
      await expect(refused.node.start()).resolves.toBe(false);
      expect(refused.spawned[0].exitCode).toBe(75);

      await addon.stop();
      const next = service(dataDir);
      await expect(next.node.start()).resolves.toBe(true);
    },
    REFUSAL_MS
  );

  testIfAddon(
    "an add-on start waiting out another writer's gate gives up at a stop, at once",
    async () => {
      const dataDir = path.join(root, 'ipfs-data', 'freedom-ipfs');
      const { node } = service(dataDir);
      await expect(node.start()).resolves.toBe(true);
      const addon = new FreedomIpfsNativeNode({
        dataDir,
        takeGate: (options) => takeIpfsGate(dataDir, { ...options, lockDir, log: quietLog }),
      });
      running.push(() => addon.stop());
      const starting = addon.start();
      // hold-lock is retrying against the service's gate.
      await new Promise((resolve) => setTimeout(resolve, 500));

      const stopped = Date.now();
      await addon.stop();
      await expect(starting).rejects.toMatchObject({ code: 'cancelled' });
      expect(Date.now() - stopped).toBeLessThan(2_000);
      expect(node.isHealthy()).toBe(true);
    },
    REFUSAL_MS
  );
});
