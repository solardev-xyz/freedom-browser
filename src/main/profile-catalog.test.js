const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  deleteProfile,
  ensureProfile,
  getCatalogLockPaths,
  listProfileDataDirs,
  loadCatalog,
  saveCatalog,
  updateProfileNodeConfig,
  validateProfileDeletion,
  withCatalogWriteLock,
  withCatalogWriteLockAsync,
  waitForCatalogWriteLockIdle,
} = require('./profile-catalog');
const lockfile = require('proper-lockfile');
const fsOffload = require('./fs-offload');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-profile-catalog-'));
}

// What a delete reports when a gate it held was lost after its first change.
const CORE_LOCK_LOST = 'The profile was deleted, but its core lock was lost during the delete';
const IPFS_LOCK_LOST = 'The profile was deleted, but its IPFS data lock was lost during the delete';

function waitForPath(filePath, timeoutMs = 1000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    function check() {
      if (fs.existsSync(filePath)) {
        resolve();
        return;
      }

      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`Timed out waiting for ${filePath}`));
        return;
      }

      setTimeout(check, 10);
    }

    check();
  });
}

// The per-user lock directory (service-locks.js) for an OS app-data directory
// of `appData`.
function lockDirFor(appData) {
  let lockDir;
  jest.isolateModules(() => {
    jest.doMock(
      'electron',
      () => ({
        app: {
          getPath: (name) => {
            if (name !== 'appData') throw new Error(`unexpected path ${name}`);
            return appData;
          },
        },
      }),
      { virtual: true }
    );
    lockDir = require('./service-locks').getLockDir();
  });
  return lockDir;
}

function waitForExit(child, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Timed out waiting for child lock holder'));
    }, timeoutMs);

    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

describe('profile catalog', () => {
  let tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  function track(dir) {
    tempDirs.push(dir);
    return dir;
  }

  test('waits briefly for a concurrent catalog writer', async () => {
    const appRoot = track(makeTempDir());
    const paths = getCatalogLockPaths(appRoot);
    const readyPath = path.join(appRoot, 'holder-ready');
    fs.writeFileSync(paths.targetPath, 'catalog lock target');

    const holderScript = `
      const lockfile = require(${JSON.stringify(require.resolve('proper-lockfile'))});
      const fs = require('fs');
      const targetPath = process.argv[1];
      const lockDir = process.argv[2];
      const readyPath = process.argv[3];
      const release = lockfile.lockSync(targetPath, {
        lockfilePath: lockDir,
        realpath: false,
        stale: 30000,
        update: 10000,
      });
      fs.writeFileSync(readyPath, 'ready');
      setTimeout(() => {
        release();
        process.exit(0);
      }, 150);
    `;

    const child = spawn(process.execPath, [
      '-e',
      holderScript,
      paths.targetPath,
      paths.lockDir,
      readyPath,
    ], {
      stdio: 'ignore',
    });
    let childExited = false;

    try {
      await waitForPath(readyPath);

      const result = withCatalogWriteLock(appRoot, () => 'acquired', {
        retries: { retries: 10, minTimeout: 25, maxTimeout: 25 },
      });

      expect(result).toBe('acquired');
      await expect(waitForExit(child)).resolves.toEqual({ code: 0, signal: null });
      childExited = true;
    } finally {
      if (!childExited && !child.killed) {
        child.kill('SIGKILL');
      }
    }
  });

  function isCatalogLockHeld(appRoot) {
    const paths = getCatalogLockPaths(appRoot);
    return lockfile.checkSync(paths.targetPath, {
      lockfilePath: paths.lockDir,
      realpath: false,
      stale: 30000,
    });
  }

  function deferred() {
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  describe('withCatalogWriteLockAsync (#513)', () => {
    test('holds the cross-process lock across awaits and releases it after', async () => {
      const appRoot = track(makeTempDir());
      const gate = deferred();
      const started = deferred();
      const running = withCatalogWriteLockAsync(appRoot, async () => {
        started.resolve();
        await gate.promise;
        return 'done';
      });

      // Wait for the holder itself, not a fixed 20 ms: acquiring the lock is
      // async file I/O, and under load it took longer than that (#535).
      await started.promise;
      expect(isCatalogLockHeld(appRoot)).toBe(true);
      gate.resolve();
      await expect(running).resolves.toBe('done');
      expect(isCatalogLockHeld(appRoot)).toBe(false);
    });

    test('releases the lock when the critical section throws', async () => {
      const appRoot = track(makeTempDir());
      await expect(
        withCatalogWriteLockAsync(appRoot, async () => {
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');
      expect(isCatalogLockHeld(appRoot)).toBe(false);
      expect(withCatalogWriteLock(appRoot, () => 'next')).toBe('next');
    });

    test('serializes in-process async holders in call order', async () => {
      const appRoot = track(makeTempDir());
      const gate = deferred();
      const firstStarted = deferred();
      const order = [];
      const first = withCatalogWriteLockAsync(appRoot, async () => {
        order.push('first:start');
        firstStarted.resolve();
        await gate.promise;
        order.push('first:end');
      }, { retries: 0 });
      const second = withCatalogWriteLockAsync(appRoot, async () => {
        order.push('second');
      }, { retries: 0 });

      // Once the first holder is in, give the second every chance to run
      // alongside it. A fixed 20 ms from the start raced the first holder's
      // own acquisition instead: 1 failure in 20 parallel jest runs (#535).
      await firstStarted.promise;
      await new Promise((r) => setTimeout(r, 20));
      expect(order).toEqual(['first:start']);
      gate.resolve();
      await Promise.all([first, second]);
      expect(order).toEqual(['first:start', 'first:end', 'second']);
    });

    // A sync caller retrying with Atomics.wait would block the event loop the
    // async holder needs, so it must fail fast instead of sleeping out its
    // whole retry budget.
    test('fails a sync caller fast while an async holder is active', async () => {
      const appRoot = track(makeTempDir());
      const gate = deferred();
      const started = deferred();
      const running = withCatalogWriteLockAsync(appRoot, () => {
        started.resolve();
        return gate.promise;
      });
      await started.promise;

      const startedAt = Date.now();
      let caught;
      try {
        withCatalogWriteLock(appRoot, () => 'never', {
          retries: { retries: 20, minTimeout: 100, maxTimeout: 100 },
        });
      } catch (err) {
        caught = err;
      }
      expect(caught?.code).toBe('ELOCKED');
      expect(caught?.message).toMatch(/profile catalog is busy/);
      expect(Date.now() - startedAt).toBeLessThan(100);

      gate.resolve();
      await running;
      expect(withCatalogWriteLock(appRoot, () => 'after')).toBe('after');
    });

    // #517 R1-M1: short sync writers that must not fail on a transient busy
    // catalog (Ant/Tor persisting a fallback port) wait for the async holder
    // and its queue to drain, then their sync call goes straight through.
    test('waitForCatalogWriteLockIdle resolves once async holders have drained', async () => {
      const appRoot = track(makeTempDir());
      expect(await waitForCatalogWriteLockIdle(appRoot)).toBeUndefined();

      const gate1 = deferred();
      const gate2 = deferred();
      const firstStarted = deferred();
      const first = withCatalogWriteLockAsync(appRoot, () => {
        firstStarted.resolve();
        return gate1.promise;
      }, { retries: 0 });
      const second = withCatalogWriteLockAsync(appRoot, () => gate2.promise, { retries: 0 });
      await firstStarted.promise;

      let idle = false;
      const waiting = waitForCatalogWriteLockIdle(appRoot).then(() => {
        idle = true;
        // Same tick as the wait resolving: no fast-fail.
        return withCatalogWriteLock(appRoot, () => 'written');
      });
      gate1.resolve();
      await first;
      await new Promise((r) => setTimeout(r, 20));
      // Still queued behind the second holder.
      expect(idle).toBe(false);
      gate2.resolve();
      await second;
      await expect(waiting).resolves.toBe('written');

      // A holder that is queued but has not acquired the lock yet counts too.
      const gate3 = deferred();
      const third = withCatalogWriteLockAsync(appRoot, () => gate3.promise, { retries: 0 });
      let idleBeforeAcquire = false;
      const waitingEarly = waitForCatalogWriteLockIdle(appRoot).then(() => {
        idleBeforeAcquire = true;
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(idleBeforeAcquire).toBe(false);
      gate3.resolve();
      await third;
      await waitingEarly;
    });

    test('waits (without blocking) for a concurrent cross-process writer', async () => {
      const appRoot = track(makeTempDir());
      const paths = getCatalogLockPaths(appRoot);
      const readyPath = path.join(appRoot, 'holder-ready');
      fs.writeFileSync(paths.targetPath, 'catalog lock target');

      const holderScript = `
        const lockfile = require(${JSON.stringify(require.resolve('proper-lockfile'))});
        const fs = require('fs');
        const [targetPath, lockDir, readyPath] = process.argv.slice(1);
        const release = lockfile.lockSync(targetPath, {
          lockfilePath: lockDir, realpath: false, stale: 30000, update: 10000,
        });
        fs.writeFileSync(readyPath, 'ready');
        setTimeout(() => { release(); process.exit(0); }, 150);
      `;
      const child = spawn(process.execPath, ['-e', holderScript, paths.targetPath, paths.lockDir, readyPath], {
        stdio: 'ignore',
      });
      let childExited = false;
      // Listen up front: the child exits while we are still awaiting the lock.
      const exited = waitForExit(child, 5000);

      try {
        await waitForPath(readyPath);
        let ticks = 0;
        const ticker = setInterval(() => {
          ticks += 1;
        }, 10);
        const result = await withCatalogWriteLockAsync(appRoot, async () => 'acquired', {
          retries: { retries: 20, minTimeout: 25, maxTimeout: 25 },
        });
        clearInterval(ticker);

        expect(result).toBe('acquired');
        // The event loop kept running while we waited out the other holder.
        expect(ticks).toBeGreaterThan(3);
        await expect(exited).resolves.toEqual({ code: 0, signal: null });
        childExited = true;
      } finally {
        if (!childExited && !child.killed) {
          child.kill('SIGKILL');
        }
      }
    });
  });

  test('fills missing Bee P2P ports in existing profile metadata', () => {
    const appRoot = track(makeTempDir());
    const profileDir = path.join(appRoot, 'Profiles', 'default');
    fs.mkdirSync(profileDir, { recursive: true });

    const record = {
      id: 'default',
      displayName: 'Default',
      dir: profileDir,
      slot: 0,
      createdAt: '2026-05-25T00:00:00.000Z',
      lastOpenedAt: '2026-05-25T00:00:00.000Z',
      nodes: {
        bee: {
          mode: 'managed',
          apiPort: 11633,
          externalApi: null,
        },
      },
    };

    fs.writeFileSync(
      path.join(appRoot, 'profile-registry.json'),
      JSON.stringify({ version: 1, profiles: [record] }, null, 2)
    );
    fs.writeFileSync(
      path.join(profileDir, 'profile.json'),
      JSON.stringify({
        version: 1,
        id: 'default',
        displayName: 'Default',
        createdAt: record.createdAt,
        lastOpenedAt: record.lastOpenedAt,
        slot: 0,
        nodes: record.nodes,
      }, null, 2)
    );

    const result = ensureProfile(appRoot, 'default', { defaultProfileDir: profileDir });

    expect(result.metadata.nodes.bee.p2pPort).toBe(12633);
    expect(result.metadata.nodes.myotis).toEqual({
      mode: 'managed',
      backend: 'myotis-native',
    });

    const catalog = JSON.parse(
      fs.readFileSync(path.join(appRoot, 'profile-registry.json'), 'utf-8')
    );
    const metadata = JSON.parse(
      fs.readFileSync(path.join(profileDir, 'profile.json'), 'utf-8')
    );
    expect(catalog.profiles[0].nodes.bee.p2pPort).toBe(12633);
    expect(metadata.nodes.bee.p2pPort).toBe(12633);
    expect(catalog.profiles[0].nodes.myotis).toEqual({
      mode: 'managed',
      backend: 'myotis-native',
    });
    expect(metadata.nodes.myotis).toEqual({
      mode: 'managed',
      backend: 'myotis-native',
    });
    expect(catalog.profiles[0].nodes.tor).toMatchObject({
      mode: 'managed',
      socksPort: 19150,
    });
    expect(metadata.nodes.tor).toMatchObject({
      mode: 'managed',
      socksPort: 19150,
    });
  });

  test('updateProfileNodeConfig keeps the IPFS external gateway but clamps Myotis to native', () => {
    const appRoot = track(makeTempDir());
    const profileDir = path.join(appRoot, 'Profiles', 'default');
    fs.mkdirSync(profileDir, { recursive: true });
    const { metadata } = ensureProfile(appRoot, 'default', { defaultProfileDir: profileDir });
    const profile = { id: 'default', appRoot, userDataDir: profileDir, metadata };

    // IPFS is native but may point at an external gateway: mode, endpoint, and
    // the prompt marker must survive, with the native backend stamped.
    const ipfsResult = updateProfileNodeConfig(profile, 'ipfs', {
      mode: 'external',
      externalGateway: 'http://127.0.0.1:8080',
      externalCandidatePrompt: { choice: 'external' },
    });
    expect(ipfsResult.metadata.nodes.ipfs).toMatchObject({
      mode: 'external',
      externalGateway: 'http://127.0.0.1:8080',
      externalCandidatePrompt: { choice: 'external' },
      backend: 'freedom-ipfs',
    });
    const persistedIpfs = JSON.parse(
      fs.readFileSync(path.join(profileDir, 'profile.json'), 'utf-8')
    ).nodes.ipfs;
    expect(persistedIpfs).toMatchObject({
      mode: 'external',
      externalGateway: 'http://127.0.0.1:8080',
    });

    // Myotis stays native-only: external is clamped to managed and endpoints dropped.
    const myotisResult = updateProfileNodeConfig(profile, 'myotis', {
      mode: 'external',
      externalGateway: 'http://127.0.0.1:9000',
    });
    expect(myotisResult.metadata.nodes.myotis).toEqual({
      mode: 'managed',
      backend: 'myotis-native',
    });
  });

  test('ensureProfile preserves a persisted IPFS external gateway across reboots', () => {
    const appRoot = track(makeTempDir());
    const profileDir = path.join(appRoot, 'Profiles', 'default');
    fs.mkdirSync(profileDir, { recursive: true });

    const nodes = {
      ipfs: {
        mode: 'external',
        externalGateway: 'http://127.0.0.1:8080',
        backend: 'freedom-ipfs',
      },
    };
    const record = {
      id: 'default',
      displayName: 'Default',
      dir: profileDir,
      slot: 0,
      createdAt: '2026-05-25T00:00:00.000Z',
      lastOpenedAt: '2026-05-25T00:00:00.000Z',
      nodes,
    };
    fs.writeFileSync(
      path.join(appRoot, 'profile-registry.json'),
      JSON.stringify({ version: 1, profiles: [record] }, null, 2)
    );
    fs.writeFileSync(
      path.join(profileDir, 'profile.json'),
      JSON.stringify(
        {
          version: 1,
          id: 'default',
          displayName: 'Default',
          createdAt: record.createdAt,
          lastOpenedAt: record.lastOpenedAt,
          slot: 0,
          nodes,
        },
        null,
        2
      )
    );

    // ensureProfile runs on every launch and normalizes node config; the external
    // gateway must not be clamped back to the managed default.
    const result = ensureProfile(appRoot, 'default', { defaultProfileDir: profileDir });
    expect(result.metadata.nodes.ipfs).toMatchObject({
      mode: 'external',
      externalGateway: 'http://127.0.0.1:8080',
      backend: 'freedom-ipfs',
    });

    const persisted = JSON.parse(
      fs.readFileSync(path.join(profileDir, 'profile.json'), 'utf-8')
    ).nodes.ipfs;
    expect(persisted).toMatchObject({
      mode: 'external',
      externalGateway: 'http://127.0.0.1:8080',
    });
  });

  test('adopts an existing profile directory with metadata instead of assigning a fresh slot', () => {
    const appRoot = track(makeTempDir());
    const profileDir = path.join(appRoot, 'Profiles', 'work');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, 'profile.json'),
      JSON.stringify({
        version: 1,
        id: 'old-work-id',
        displayName: 'Recovered Work',
        createdAt: '2026-05-20T00:00:00.000Z',
        lastOpenedAt: '2026-05-21T00:00:00.000Z',
        slot: 7,
        nodes: {
          bee: {
            mode: 'external',
            externalApi: 'http://127.0.0.1:1633',
          },
        },
      }, null, 2)
    );

    const result = ensureProfile(appRoot, 'work', {
      markOpened: true,
      now: '2026-05-25T00:00:00.000Z',
    });

    expect(result.record).toMatchObject({
      id: 'work',
      displayName: 'Recovered Work',
      slot: 7,
    });
    expect(result.metadata).toMatchObject({
      id: 'work',
      displayName: 'Recovered Work',
      slot: 7,
      lastOpenedAt: '2026-05-25T00:00:00.000Z',
    });
    expect(result.metadata.nodes.bee).toMatchObject({
      mode: 'external',
      apiPort: 11640,
      p2pPort: 12640,
      externalApi: 'http://127.0.0.1:1633',
    });
    expect(result.metadata.nodes.tor).toMatchObject({
      mode: 'managed',
      socksPort: 19157,
    });

    const catalog = JSON.parse(
      fs.readFileSync(path.join(appRoot, 'profile-registry.json'), 'utf-8')
    );
    expect(catalog.profiles).toHaveLength(1);
    expect(catalog.profiles[0].slot).toBe(7);
  });

  // "Verify content from this node" (freedom-core design 0009) is kept with
  // the node's endpoint: absent means on, and a stored choice survives an
  // update of another field, a launch's normalization, and an adoption's
  // rebase.
  test('keeps the Swarm and IPFS verification setting wherever node config is rebuilt', () => {
    const appRoot = track(makeTempDir());
    const profileDir = path.join(appRoot, 'Profiles', 'work');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, 'profile.json'),
      JSON.stringify({
        version: 1,
        id: 'work',
        displayName: 'Work',
        slot: 3,
        nodes: {
          bee: { mode: 'external', externalApi: 'http://127.0.0.1:1633', verify: false },
          ipfs: { mode: 'external', externalGateway: 'http://127.0.0.1:8080', verify: false },
        },
      })
    );

    // Adopted: the rebase keeps the stored choice.
    const adopted = ensureProfile(appRoot, 'work');
    expect(adopted.metadata.nodes.bee).toMatchObject({ mode: 'external', verify: false });
    expect(adopted.metadata.nodes.ipfs).toMatchObject({ mode: 'external', verify: false });

    // A later launch's normalization keeps it too.
    const relaunched = ensureProfile(appRoot, 'work');
    expect(relaunched.metadata.nodes.bee.verify).toBe(false);
    expect(relaunched.metadata.nodes.ipfs.verify).toBe(false);

    // Patched on its own, it merges with the mode and endpoint.
    const profile = {
      id: 'work',
      appRoot,
      userDataDir: profileDir,
      metadata: relaunched.metadata,
    };
    const on = updateProfileNodeConfig(profile, 'ipfs', { verify: true });
    expect(on.metadata.nodes.ipfs).toMatchObject({
      mode: 'external',
      externalGateway: 'http://127.0.0.1:8080',
      verify: true,
      backend: 'freedom-ipfs',
    });
    const endpoint = updateProfileNodeConfig(profile, 'bee', {
      mode: 'external',
      externalApi: 'http://127.0.0.1:1634',
    });
    expect(endpoint.metadata.nodes.bee).toMatchObject({
      externalApi: 'http://127.0.0.1:1634',
      verify: false,
    });

    // A profile that never chose has no member at all: on by default.
    const fresh = ensureProfile(appRoot, 'fresh');
    expect(fresh.metadata.nodes.bee).not.toHaveProperty('verify');
    expect(fresh.metadata.nodes.ipfs).not.toHaveProperty('verify');
  });

  test("lists every profile with its slot: the catalog's, and those it doesn't list", () => {
    const appRoot = track(makeTempDir());
    const { record } = ensureProfile(appRoot, 'work');
    const stray = path.join(appRoot, 'Profiles', 'stray');
    fs.mkdirSync(stray, { recursive: true });
    fs.writeFileSync(path.join(stray, 'profile.json'), JSON.stringify({ id: 'stray', slot: 9 }));
    const bare = path.join(appRoot, 'Profiles', 'bare');
    fs.mkdirSync(bare);
    const profiles = listProfileDataDirs(appRoot);
    expect(profiles).toEqual(
      expect.arrayContaining([
        { dir: path.join(appRoot, 'Profiles', 'work'), slot: record.slot },
        { dir: stray, slot: 9 },
        { dir: bare, slot: null },
      ])
    );
    expect(profiles).toHaveLength(3);
  });

  test('refuses to launch an unregistered profile directory without metadata', () => {
    const appRoot = track(makeTempDir());
    const profileDir = path.join(appRoot, 'Profiles', 'work');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'history.sqlite'), 'existing data');

    expect(() => ensureProfile(appRoot, 'work')).toThrow(
      'Profile directory exists but is not registered: work'
    );
    expect(fs.existsSync(path.join(profileDir, 'profile.json'))).toBe(false);
    expect(fs.existsSync(path.join(appRoot, 'profile-registry.json'))).toBe(false);
  });

  test('deletes the short app-owned Radicle home with a profile', async () => {
    const tempRoot = track(makeTempDir());
    const appRoot = path.join(tempRoot, 'Freedom Dev', 'freedom-browser-abcdef12');
    const defaultProfileDir = path.join(appRoot, 'Profiles', 'default');
    fs.mkdirSync(defaultProfileDir, { recursive: true });

    ensureProfile(appRoot, 'default', {
      checkoutHash: 'abcdef12',
      defaultProfileDir,
      dev: true,
    });
    const { record } = ensureProfile(appRoot, 'work', {
      checkoutHash: 'abcdef12',
      defaultProfileDir,
      dev: true,
    });
    const radicleDir = path.join(tempRoot, 'Freedom Dev', 'R', 'abcdef12', String(record.slot));
    fs.mkdirSync(radicleDir, { recursive: true });
    fs.writeFileSync(path.join(radicleDir, 'node.db'), 'radicle');

    // #517 R1-M2: a staging copy an interrupted Radicle carry-over left next
    // to this slot's home goes with it; a different slot's is untouched.
    const staging = `${radicleDir}.migrating-4242-1700000000000`;
    const otherSlotStaging = `${radicleDir}1.migrating-4242-1700000000000`;
    for (const dir of [staging, otherSlotStaging]) {
      fs.mkdirSync(path.join(dir, 'storage'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'storage', 'blob'), 'x');
    }

    await deleteProfile(appRoot, 'work', 'Work', {
      checkoutHash: 'abcdef12',
      dev: true,
    });
    expect(fs.existsSync(staging)).toBe(false);
    expect(fs.existsSync(otherSlotStaging)).toBe(true);

    expect(fs.existsSync(record.dir)).toBe(false);
    expect(fs.existsSync(radicleDir)).toBe(false);
  });

  // #513: the deletes run off the main thread (fs-offload), but in the same
  // order and still entirely under the cross-process catalog write lock.
  test('deletes asynchronously, catalog first, then profile dir, then Radicle home, under the lock', async () => {
    const tempRoot = track(makeTempDir());
    const appRoot = path.join(tempRoot, 'Freedom Dev', 'freedom-browser-abcdef12');
    const defaultProfileDir = path.join(appRoot, 'Profiles', 'default');
    const options = { checkoutHash: 'abcdef12', defaultProfileDir, dev: true };
    ensureProfile(appRoot, 'default', options);
    const { record } = ensureProfile(appRoot, 'work', options);
    const radicleDir = path.join(tempRoot, 'Freedom Dev', 'R', 'abcdef12', String(record.slot));
    fs.mkdirSync(radicleDir, { recursive: true });
    // Enough entries that a recursive delete takes many event-loop turns.
    for (let i = 0; i < 400; i += 1) {
      fs.writeFileSync(path.join(record.dir, `blob-${i}`), 'x');
    }

    const realRemovePath = fsOffload.removePath;
    const calls = [];
    const rmSpy = jest.spyOn(fsOffload, 'removePath').mockImplementation((target, opts) => {
      calls.push({
        target,
        lockHeld: isCatalogLockHeld(appRoot),
        catalogIds: loadCatalog(appRoot).profiles.map((p) => p.id),
      });
      return realRemovePath(target, opts);
    });
    const rmSyncSpy = jest.spyOn(fs, 'rmSync');

    let immediates = 0;
    let spinning = true;
    const spin = () => {
      if (!spinning) return;
      immediates += 1;
      setImmediate(spin);
    };
    setImmediate(spin);

    try {
      await deleteProfile(appRoot, 'work', 'Work', options);
    } finally {
      spinning = false;
      rmSpy.mockRestore();
      rmSyncSpy.mockRestore();
    }

    expect(rmSyncSpy).not.toHaveBeenCalled();
    expect(calls.map((c) => c.target)).toEqual([path.resolve(record.dir), radicleDir]);
    for (const call of calls) {
      expect(call.lockHeld).toBe(true);
      expect(call.catalogIds).toEqual(['default']);
    }
    expect(immediates).toBeGreaterThan(0);
    expect(fs.existsSync(record.dir)).toBe(false);
    expect(fs.existsSync(radicleDir)).toBe(false);
    expect(isCatalogLockHeld(appRoot)).toBe(false);
  });

  // freedom-core design 0007, "Lifetime lock": the profile's IPFS data is
  // removed under freedom-ipfsd's gate on it, and a writer that holds the gate
  // fails the delete before anything is changed.
  describe("under the profile's IPFS gate", () => {
    const devOptions = (appRoot) => ({
      checkoutHash: 'abcdef12',
      defaultProfileDir: path.join(appRoot, 'Profiles', 'default'),
      dev: true,
    });

    test('removes nothing but inside the gate, which it takes on <profile>/ipfs-data/freedom-ipfs', async () => {
      const tempRoot = track(makeTempDir());
      const appRoot = path.join(tempRoot, 'Freedom Dev', 'freedom-browser-abcdef12');
      const options = devOptions(appRoot);
      ensureProfile(appRoot, 'default', options);
      const { record } = ensureProfile(appRoot, 'work', options);
      fs.mkdirSync(path.join(record.dir, 'ipfs-data', 'freedom-ipfs'), { recursive: true });

      let held = false;
      const gates = [];
      const removals = [];
      const rmSpy = jest.spyOn(fsOffload, 'removePath').mockImplementation(async (target) => {
        removals.push({ target, held });
      });
      const withIpfsGate = async (dir, fn) => {
        gates.push({ dir, catalogIds: loadCatalog(appRoot).profiles.map((p) => p.id) });
        held = true;
        try {
          return await fn();
        } finally {
          held = false;
        }
      };
      try {
        await deleteProfile(appRoot, 'work', 'Work', { ...options, withIpfsGate });
      } finally {
        rmSpy.mockRestore();
      }

      // Taken once, on the directory the service would use, before the
      // catalog changed.
      expect(gates).toEqual([
        {
          dir: path.join(path.resolve(record.dir), 'ipfs-data', 'freedom-ipfs'),
          catalogIds: ['default', 'work'],
        },
      ]);
      expect(removals.length).toBeGreaterThan(0);
      expect(removals.every((removal) => removal.held)).toBe(true);
    });

    test('a gate another writer holds fails the delete, and changes nothing', async () => {
      const tempRoot = track(makeTempDir());
      const appRoot = path.join(tempRoot, 'Freedom Dev', 'freedom-browser-abcdef12');
      const options = devOptions(appRoot);
      ensureProfile(appRoot, 'default', options);
      const { record } = ensureProfile(appRoot, 'work', options);
      const store = path.join(record.dir, 'ipfs-data', 'freedom-ipfs', 'freedom-ipfs.sqlite3');
      fs.mkdirSync(path.dirname(store), { recursive: true });
      fs.writeFileSync(store, 'blocks');
      const held = Object.assign(
        new Error('The IPFS data is in use by another process. Close it and try again.'),
        { name: 'IpfsGateError', code: 'lock_held' }
      );
      const rmSpy = jest.spyOn(fsOffload, 'removePath');

      try {
        await expect(
          deleteProfile(appRoot, 'work', 'Work', {
            ...options,
            withIpfsGate: async () => {
              throw held;
            },
          })
        ).rejects.toBe(held);
        expect(rmSpy).not.toHaveBeenCalled();
      } finally {
        rmSpy.mockRestore();
      }
      expect(fs.readFileSync(store, 'utf-8')).toBe('blocks');
      expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['default', 'work']);
      expect(isCatalogLockHeld(appRoot)).toBe(false);
    });

    // The gate's holder can end mid-delete (killed); another writer may then
    // take the gate and recreate the directory. The gated directory is moved
    // aside first, so the removal still running never reaches its path, and
    // the delete reports the loss.
    const gateLostOnFirstRemoval = (ipfsDir) => {
      let lost = false;
      const realRemovePath = fsOffload.removePath;
      const rmSpy = jest.spyOn(fsOffload, 'removePath').mockImplementation((target, opts) => {
        if (!lost) {
          lost = true;
          fs.mkdirSync(ipfsDir, { recursive: true });
          fs.writeFileSync(path.join(ipfsDir, 'new-owner'), 'theirs');
        }
        return realRemovePath(target, opts);
      });
      const withIpfsGate = async (_dir, fn) => fn({ gated: true, held: () => !lost });
      return { rmSpy, withIpfsGate };
    };

    test('a gate lost mid-delete: a writer that recreates the directory keeps its data', async () => {
      const tempRoot = track(makeTempDir());
      const appRoot = path.join(tempRoot, 'Freedom Dev', 'freedom-browser-abcdef12');
      const options = devOptions(appRoot);
      ensureProfile(appRoot, 'default', options);
      const { record } = ensureProfile(appRoot, 'work', options);
      const ipfsDir = path.join(path.resolve(record.dir), 'ipfs-data', 'freedom-ipfs');
      fs.mkdirSync(ipfsDir, { recursive: true });
      fs.writeFileSync(path.join(ipfsDir, 'freedom-ipfs.sqlite3'), 'blocks');
      fs.writeFileSync(path.join(record.dir, 'history.db'), 'h');
      const { rmSpy, withIpfsGate } = gateLostOnFirstRemoval(ipfsDir);

      try {
        await expect(
          deleteProfile(appRoot, 'work', 'Work', { ...options, withIpfsGate })
        ).rejects.toThrow(IPFS_LOCK_LOST);
      } finally {
        rmSpy.mockRestore();
      }

      expect(fs.readFileSync(path.join(ipfsDir, 'new-owner'), 'utf-8')).toBe('theirs');
      // The old store went with the fenced directory.
      expect(fs.readdirSync(ipfsDir)).toEqual(['new-owner']);
      expect(fs.readdirSync(record.dir)).toEqual(['ipfs-data']);
      expect(fs.readdirSync(path.dirname(ipfsDir))).toEqual(['freedom-ipfs']);
      expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['default']);
    });

    test('packaged layout: a gate lost mid-delete leaves the app root writer its data too', async () => {
      const appRoot = track(makeTempDir());
      ensureProfile(appRoot, 'default', { defaultProfileDir: appRoot });
      ensureProfile(appRoot, 'work', { defaultProfileDir: appRoot });
      const ipfsDir = path.join(path.resolve(appRoot), 'ipfs-data', 'freedom-ipfs');
      fs.mkdirSync(ipfsDir, { recursive: true });
      fs.writeFileSync(path.join(ipfsDir, 'freedom-ipfs.sqlite3'), 'blocks');
      fs.mkdirSync(path.join(appRoot, 'ant-data'));
      const { rmSpy, withIpfsGate } = gateLostOnFirstRemoval(ipfsDir);

      try {
        await expect(
          deleteProfile(appRoot, 'default', 'My Profile', { withIpfsGate })
        ).rejects.toThrow(IPFS_LOCK_LOST);
      } finally {
        rmSpy.mockRestore();
      }

      expect(fs.readFileSync(path.join(ipfsDir, 'new-owner'), 'utf-8')).toBe('theirs');
      // The old store went with the fenced directory.
      expect(fs.readdirSync(ipfsDir)).toEqual(['new-owner']);
      expect(fs.readdirSync(path.dirname(ipfsDir))).toEqual(['freedom-ipfs']);
      expect(fs.existsSync(path.join(appRoot, 'ant-data'))).toBe(false);
    });

    test('a gate already lost fails the delete before the move, and changes nothing', async () => {
      const tempRoot = track(makeTempDir());
      const appRoot = path.join(tempRoot, 'Freedom Dev', 'freedom-browser-abcdef12');
      const options = devOptions(appRoot);
      ensureProfile(appRoot, 'default', options);
      const { record } = ensureProfile(appRoot, 'work', options);
      const store = path.join(record.dir, 'ipfs-data', 'freedom-ipfs', 'freedom-ipfs.sqlite3');
      fs.mkdirSync(path.dirname(store), { recursive: true });
      fs.writeFileSync(store, 'blocks');
      const rmSpy = jest.spyOn(fsOffload, 'removePath');

      try {
        await expect(
          deleteProfile(appRoot, 'work', 'Work', {
            ...options,
            withIpfsGate: async (_dir, fn) => fn({ gated: true, held: () => false }),
          })
        ).rejects.toThrow("The IPFS data directory's lock was lost; nothing was deleted");
        expect(rmSpy).not.toHaveBeenCalled();
      } finally {
        rmSpy.mockRestore();
      }
      expect(fs.readFileSync(store, 'utf-8')).toBe('blocks');
      expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['default', 'work']);
    });

    test('a held gate: the move retries a transient Windows refusal, then the delete completes', async () => {
      const tempRoot = track(makeTempDir());
      const appRoot = path.join(tempRoot, 'Freedom Dev', 'freedom-browser-abcdef12');
      const options = devOptions(appRoot);
      ensureProfile(appRoot, 'default', options);
      const { record } = ensureProfile(appRoot, 'work', options);
      fs.mkdirSync(path.join(record.dir, 'ipfs-data', 'freedom-ipfs'), { recursive: true });
      const realRename = fs.renameSync;
      const renameSpy = jest.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      });
      renameSpy.mockImplementation((...args) => realRename(...args));

      try {
        await deleteProfile(appRoot, 'work', 'Work', {
          ...options,
          withIpfsGate: async (_dir, fn) => fn({ gated: true, held: () => true }),
        });
      } finally {
        renameSpy.mockRestore();
      }
      expect(fs.existsSync(record.dir)).toBe(false);
      expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['default']);
    });

    // IPFS data behind a symlink or junction is data elsewhere: a gated
    // delete removes the link, as the plain removal does, and neither moves
    // nor walks into what it points at.
    const linkDir = (target, link) =>
      fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    const sharedIpfs = (tempRoot) => {
      const shared = path.join(tempRoot, 'shared');
      fs.mkdirSync(path.join(shared, 'freedom-ipfs'), { recursive: true });
      fs.writeFileSync(path.join(shared, 'freedom-ipfs', 'freedom-ipfs.sqlite3'), 'blocks');
      fs.writeFileSync(path.join(shared, 'unrelated'), 'keep me');
      return shared;
    };
    const expectSharedUntouched = (shared) => {
      expect(fs.readFileSync(path.join(shared, 'unrelated'), 'utf-8')).toBe('keep me');
      expect(
        fs.readFileSync(path.join(shared, 'freedom-ipfs', 'freedom-ipfs.sqlite3'), 'utf-8')
      ).toBe('blocks');
      expect(fs.readdirSync(shared).sort()).toEqual(['freedom-ipfs', 'unrelated']);
    };
    const heldGate = async (_dir, fn) => fn({ gated: true, held: () => true });

    test('a held gate with ipfs-data behind a link: refused, and nothing changes', async () => {
      const tempRoot = track(makeTempDir());
      const appRoot = path.join(tempRoot, 'Freedom Dev', 'freedom-browser-abcdef12');
      const options = devOptions(appRoot);
      ensureProfile(appRoot, 'default', options);
      const { record } = ensureProfile(appRoot, 'work', options);
      const shared = sharedIpfs(tempRoot);
      linkDir(shared, path.join(record.dir, 'ipfs-data'));

      await expect(
        deleteProfile(appRoot, 'work', 'Work', { ...options, withIpfsGate: heldGate })
      ).rejects.toThrow('is reached through a link');

      expectSharedUntouched(shared);
      expect(fs.existsSync(path.join(record.dir, 'ipfs-data'))).toBe(true);
      expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['default', 'work']);
    });

    test('packaged layout: a held gate with ipfs-data behind a link is refused too', async () => {
      const tempRoot = track(makeTempDir());
      const appRoot = path.join(tempRoot, 'app');
      fs.mkdirSync(appRoot);
      ensureProfile(appRoot, 'default', { defaultProfileDir: appRoot });
      ensureProfile(appRoot, 'work', { defaultProfileDir: appRoot });
      const shared = sharedIpfs(tempRoot);
      linkDir(shared, path.join(appRoot, 'ipfs-data'));

      await expect(
        deleteProfile(appRoot, 'default', 'My Profile', { withIpfsGate: heldGate })
      ).rejects.toThrow('is reached through a link');

      expectSharedUntouched(shared);
      expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['default', 'work']);
    });

    test('a held gate with the IPFS directory itself a link: refused', async () => {
      const tempRoot = track(makeTempDir());
      const appRoot = path.join(tempRoot, 'Freedom Dev', 'freedom-browser-abcdef12');
      const options = devOptions(appRoot);
      ensureProfile(appRoot, 'default', options);
      const { record } = ensureProfile(appRoot, 'work', options);
      const shared = sharedIpfs(tempRoot);
      fs.mkdirSync(path.join(record.dir, 'ipfs-data'));
      linkDir(
        path.join(shared, 'freedom-ipfs'),
        path.join(record.dir, 'ipfs-data', 'freedom-ipfs')
      );

      await expect(
        deleteProfile(appRoot, 'work', 'Work', { ...options, withIpfsGate: heldGate })
      ).rejects.toThrow('is reached through a link');

      expectSharedUntouched(shared);
      expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['default', 'work']);
    });

    test('a held gate with the IPFS directory an alias of the profile itself: refused', async () => {
      const tempRoot = track(makeTempDir());
      const appRoot = path.join(tempRoot, 'Freedom Dev', 'freedom-browser-abcdef12');
      const options = devOptions(appRoot);
      ensureProfile(appRoot, 'default', options);
      const { record } = ensureProfile(appRoot, 'work', options);
      fs.writeFileSync(path.join(record.dir, 'history.db'), 'h');
      fs.mkdirSync(path.join(record.dir, 'ipfs-data'));
      linkDir(path.resolve(record.dir), path.join(record.dir, 'ipfs-data', 'freedom-ipfs'));

      await expect(
        deleteProfile(appRoot, 'work', 'Work', { ...options, withIpfsGate: heldGate })
      ).rejects.toThrow('is reached through a link');

      expect(fs.readFileSync(path.join(record.dir, 'history.db'), 'utf-8')).toBe('h');
      expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['default', 'work']);
    });

    // The Radicle home goes with the profile: its path is held to the same
    // rule, a link at no step, even where the home itself isn't there yet.
    const radicleCheckout = (tempRoot) => path.join(tempRoot, 'Freedom Dev', 'R', 'abcdef12');

    test('a held gate with the Radicle path through a link into the IPFS directory: refused', async () => {
      const tempRoot = track(makeTempDir());
      const appRoot = path.join(tempRoot, 'Freedom Dev', 'freedom-browser-abcdef12');
      const options = devOptions(appRoot);
      ensureProfile(appRoot, 'default', options);
      const { record } = ensureProfile(appRoot, 'work', options);
      const ipfsDir = path.join(path.resolve(record.dir), 'ipfs-data', 'freedom-ipfs');
      fs.mkdirSync(ipfsDir, { recursive: true });
      fs.writeFileSync(path.join(ipfsDir, 'freedom-ipfs.sqlite3'), 'blocks');
      // The slot isn't there yet: a successor could create it in its store.
      fs.mkdirSync(path.dirname(radicleCheckout(tempRoot)), { recursive: true });
      linkDir(ipfsDir, radicleCheckout(tempRoot));

      await expect(
        deleteProfile(appRoot, 'work', 'Work', { ...options, withIpfsGate: heldGate })
      ).rejects.toThrow("The profile's Radicle data is reached through a link");

      expect(fs.readdirSync(ipfsDir)).toEqual(['freedom-ipfs.sqlite3']);
      expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['default', 'work']);
    });

    test('a held gate with the Radicle path through a link out of the app: refused', async () => {
      const tempRoot = track(makeTempDir());
      const appRoot = path.join(tempRoot, 'Freedom Dev', 'freedom-browser-abcdef12');
      const options = devOptions(appRoot);
      ensureProfile(appRoot, 'default', options);
      const { record } = ensureProfile(appRoot, 'work', options);
      const outside = path.join(tempRoot, 'outside');
      fs.mkdirSync(path.join(outside, String(record.slot)), { recursive: true });
      fs.writeFileSync(path.join(outside, String(record.slot), 'unrelated'), 'keep me');
      fs.mkdirSync(path.dirname(radicleCheckout(tempRoot)), { recursive: true });
      linkDir(outside, radicleCheckout(tempRoot));

      await expect(
        deleteProfile(appRoot, 'work', 'Work', { ...options, withIpfsGate: heldGate })
      ).rejects.toThrow("The profile's Radicle data is reached through a link");

      expect(fs.readFileSync(path.join(outside, String(record.slot), 'unrelated'), 'utf-8')).toBe(
        'keep me'
      );
      expect(fs.existsSync(record.dir)).toBe(true);
      expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['default', 'work']);
    });

    test('a link that appears after the check is removed as a link, never walked into', async () => {
      const tempRoot = track(makeTempDir());
      const appRoot = path.join(tempRoot, 'Freedom Dev', 'freedom-browser-abcdef12');
      const options = devOptions(appRoot);
      ensureProfile(appRoot, 'default', options);
      const { record } = ensureProfile(appRoot, 'work', options);
      fs.mkdirSync(path.join(record.dir, 'ipfs-data', 'freedom-ipfs'), { recursive: true });
      const shared = sharedIpfs(tempRoot);
      // Once the fence has moved the directory, ipfs-data becomes a link.
      const realRename = fs.renameSync;
      // The fence moves the canonical path, as the native realpath gives it
      // (gatedPlace): the temp directory's own can differ from the one named
      // (/private/var on macOS; on Windows, long names for 8.3 ones, which
      // only the native realpath expands).
      const ipfsDir = path.join(fs.realpathSync.native(record.dir), 'ipfs-data', 'freedom-ipfs');
      let planted = false;
      const renameSpy = jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        realRename(from, to);
        if (from !== ipfsDir) return;
        const ipfsData = path.dirname(ipfsDir);
        realRename(ipfsData, path.join(tempRoot, 'moved-ipfs-data'));
        linkDir(shared, ipfsData);
        planted = true;
      });

      try {
        await deleteProfile(appRoot, 'work', 'Work', { ...options, withIpfsGate: heldGate });
      } finally {
        renameSpy.mockRestore();
      }

      expect(planted).toBe(true);
      expectSharedUntouched(shared);
      expect(fs.existsSync(path.join(record.dir, 'ipfs-data'))).toBe(false);
    });

    test('an alias inside the profile (a link to a profile directory): refused', async () => {
      const tempRoot = track(makeTempDir());
      const appRoot = path.join(tempRoot, 'Freedom Dev', 'freedom-browser-abcdef12');
      const options = devOptions(appRoot);
      ensureProfile(appRoot, 'default', options);
      const { record } = ensureProfile(appRoot, 'work', options);
      // ipfs-data is a link to a real directory in the profile, under a name
      // that also starts with '..'.
      const volume = path.join(path.resolve(record.dir), '..cache');
      const ipfsDir = path.join(volume, 'freedom-ipfs');
      fs.mkdirSync(ipfsDir, { recursive: true });
      fs.writeFileSync(path.join(ipfsDir, 'freedom-ipfs.sqlite3'), 'blocks');
      linkDir(volume, path.join(record.dir, 'ipfs-data'));

      await expect(
        deleteProfile(appRoot, 'work', 'Work', { ...options, withIpfsGate: heldGate })
      ).rejects.toThrow('is reached through a link');

      expect(fs.readFileSync(path.join(ipfsDir, 'freedom-ipfs.sqlite3'), 'utf-8')).toBe('blocks');
      expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['default', 'work']);
    });

    test('a directory on the way created after the delete began is spared, not removed', async () => {
      const tempRoot = track(makeTempDir());
      const appRoot = path.join(tempRoot, 'Freedom Dev', 'freedom-browser-abcdef12');
      const options = devOptions(appRoot);
      ensureProfile(appRoot, 'default', options);
      const { record } = ensureProfile(appRoot, 'work', options);
      fs.writeFileSync(path.join(record.dir, 'history.db'), 'h');
      // No ipfs-data yet: a writer creates it, store and all, as the fence
      // finds nothing to move.
      // The fence moves the canonical path (see above).
      const ipfsDir = path.join(fs.realpathSync.native(record.dir), 'ipfs-data', 'freedom-ipfs');
      let planted = false;
      const realRename = fs.renameSync;
      const renameSpy = jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        try {
          realRename(from, to);
        } finally {
          if (from === ipfsDir) {
            fs.mkdirSync(ipfsDir, { recursive: true });
            fs.writeFileSync(path.join(ipfsDir, 'new-owner'), 'theirs');
            planted = true;
          }
        }
      });

      try {
        await deleteProfile(appRoot, 'work', 'Work', { ...options, withIpfsGate: heldGate });
      } finally {
        renameSpy.mockRestore();
      }

      expect(planted).toBe(true);
      expect(fs.readFileSync(path.join(ipfsDir, 'new-owner'), 'utf-8')).toBe('theirs');
      expect(fs.readdirSync(record.dir)).toEqual(['ipfs-data']);
    });

    test("packaged layout: the default profile's gate is the app data root's ipfs-data/freedom-ipfs", async () => {
      const appRoot = track(makeTempDir());
      ensureProfile(appRoot, 'default', { defaultProfileDir: appRoot });
      ensureProfile(appRoot, 'work', { defaultProfileDir: appRoot });
      fs.mkdirSync(path.join(appRoot, 'ipfs-data', 'freedom-ipfs'), { recursive: true });
      const dirs = [];

      await deleteProfile(appRoot, 'default', 'My Profile', {
        withIpfsGate: async (dir, fn) => {
          dirs.push(dir);
          return fn();
        },
      });

      expect(dirs).toEqual([path.join(path.resolve(appRoot), 'ipfs-data', 'freedom-ipfs')]);
      expect(fs.existsSync(path.join(appRoot, 'ipfs-data'))).toBe(false);
    });
  });

  // freedom-core design 0001, "Lifetime lock": profile delete holds the
  // core's gate on the profile's identity directory for the whole
  // destructive operation, so the profile's core can't have its files open
  // while they go. It is taken first, before freedom-ipfsd's gate (the
  // core's lifetime lock, then a node's gate: 0008, "Lock order").
  describe("under the profile's core gate", () => {
    const devOptions = (appRoot) => ({
      checkoutHash: 'abcdef12',
      defaultProfileDir: path.join(appRoot, 'Profiles', 'default'),
      dev: true,
    });

    function devWorkProfile() {
      const tempRoot = track(makeTempDir());
      const appRoot = path.join(tempRoot, 'Freedom Dev', 'freedom-browser-abcdef12');
      const options = devOptions(appRoot);
      ensureProfile(appRoot, 'default', options);
      const { record } = ensureProfile(appRoot, 'work', options);
      const vault = path.join(record.dir, 'identity', 'vault.json');
      fs.mkdirSync(path.dirname(vault), { recursive: true });
      fs.writeFileSync(vault, 'secret');
      fs.mkdirSync(path.join(record.dir, 'ipfs-data', 'freedom-ipfs'), { recursive: true });
      return { appRoot, options, record, vault };
    }

    test("takes the core's gate on <profile>/identity, then the IPFS gate, and removes nothing outside both", async () => {
      const { appRoot, options, record } = devWorkProfile();
      const events = [];
      const holding = new Set();
      const removals = [];
      const rmSpy = jest.spyOn(fsOffload, 'removePath').mockImplementation(async (target) => {
        removals.push({ target, holding: [...holding] });
      });
      const gate = (name) => async (dir, fn) => {
        events.push({
          take: name,
          dir,
          catalogIds: loadCatalog(appRoot).profiles.map((p) => p.id),
        });
        holding.add(name);
        try {
          return await fn({ gated: true, held: () => holding.has(name) });
        } finally {
          holding.delete(name);
          events.push({ release: name });
        }
      };
      try {
        await deleteProfile(appRoot, 'work', 'Work', {
          ...options,
          withCoreGate: gate('core'),
          withIpfsGate: gate('ipfs'),
        });
      } finally {
        rmSpy.mockRestore();
      }

      const profileDir = path.resolve(record.dir);
      expect(events).toEqual([
        { take: 'core', dir: path.join(profileDir, 'identity'), catalogIds: ['default', 'work'] },
        {
          take: 'ipfs',
          dir: path.join(profileDir, 'ipfs-data', 'freedom-ipfs'),
          catalogIds: ['default', 'work'],
        },
        { release: 'ipfs' },
        { release: 'core' },
      ]);
      expect(removals.length).toBeGreaterThan(0);
      for (const removal of removals) expect(removal.holding).toEqual(['core', 'ipfs']);
    });

    test('a core that holds its gate fails the delete, which changes nothing and takes no other gate', async () => {
      const { appRoot, options, vault } = devWorkProfile();
      const held = Object.assign(
        new Error('The profile is in use by another process. Close it and try again.'),
        { name: 'CoreGateError', code: 'lock_held' }
      );
      const withIpfsGate = jest.fn((_dir, fn) => fn());
      const rmSpy = jest.spyOn(fsOffload, 'removePath');

      try {
        await expect(
          deleteProfile(appRoot, 'work', 'Work', {
            ...options,
            withCoreGate: async () => {
              throw held;
            },
            withIpfsGate,
          })
        ).rejects.toBe(held);
        expect(rmSpy).not.toHaveBeenCalled();
      } finally {
        rmSpy.mockRestore();
      }
      expect(withIpfsGate).not.toHaveBeenCalled();
      expect(fs.readFileSync(vault, 'utf-8')).toBe('secret');
      expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['default', 'work']);
      expect(isCatalogLockHeld(appRoot)).toBe(false);
    });

    test('a core gate already lost fails the delete before anything changes', async () => {
      const { appRoot, options, vault } = devWorkProfile();
      const rmSpy = jest.spyOn(fsOffload, 'removePath');

      try {
        await expect(
          deleteProfile(appRoot, 'work', 'Work', {
            ...options,
            withCoreGate: async (_dir, fn) => fn({ gated: true, held: () => false }),
          })
        ).rejects.toThrow("The profile's core lock was lost; nothing was deleted");
        expect(rmSpy).not.toHaveBeenCalled();
      } finally {
        rmSpy.mockRestore();
      }
      expect(fs.readFileSync(vault, 'utf-8')).toBe('secret');
      expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['default', 'work']);
    });

    test('a core gate lost while the IPFS gate was taken fails the delete before anything changes', async () => {
      const { appRoot, options, vault } = devWorkProfile();
      let coreHeld = true;
      const rmSpy = jest.spyOn(fsOffload, 'removePath');

      try {
        await expect(
          deleteProfile(appRoot, 'work', 'Work', {
            ...options,
            withCoreGate: async (_dir, fn) => fn({ gated: true, held: () => coreHeld }),
            withIpfsGate: async (_dir, fn) => {
              coreHeld = false;
              return fn({ gated: true, held: () => true });
            },
          })
        ).rejects.toThrow("The profile's core lock was lost; nothing was deleted");
        expect(rmSpy).not.toHaveBeenCalled();
      } finally {
        rmSpy.mockRestore();
      }
      expect(fs.readFileSync(vault, 'utf-8')).toBe('secret');
      expect(
        fs.existsSync(path.join(path.dirname(path.dirname(vault)), 'ipfs-data', 'freedom-ipfs'))
      ).toBe(true);
      expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['default', 'work']);
    });

    test('a core gate lost while the IPFS move waits out a Windows refusal fails the delete, and changes nothing', async () => {
      const { appRoot, options, record, vault } = devWorkProfile();
      const ipfsDir = path.join(fs.realpathSync.native(record.dir), 'ipfs-data', 'freedom-ipfs');
      let coreHeld = true;
      let atRefusal = null;
      const realRename = fs.renameSync;
      const renameSpy = jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (from === ipfsDir && atRefusal === null) {
          // The identity directory has moved by now; the refusal puts it back.
          atRefusal = fs.readdirSync(record.dir).sort();
          coreHeld = false;
          throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
        }
        return realRename(from, to);
      });
      const rmSpy = jest.spyOn(fsOffload, 'removePath');

      try {
        await expect(
          deleteProfile(appRoot, 'work', 'Work', {
            ...options,
            withCoreGate: async (_dir, fn) => fn({ gated: true, held: () => coreHeld }),
            withIpfsGate: async (_dir, fn) => fn({ gated: true, held: () => true }),
          })
        ).rejects.toThrow("The profile's core lock was lost; nothing was deleted");
        expect(rmSpy).not.toHaveBeenCalled();
      } finally {
        renameSpy.mockRestore();
        rmSpy.mockRestore();
      }
      expect(atRefusal).toEqual([
        expect.stringMatching(/^\.identity\.deleting-\d+-\d+$/),
        'ipfs-data',
        'profile.json',
      ]);
      expect(fs.readdirSync(record.dir).sort()).toEqual(['identity', 'ipfs-data', 'profile.json']);
      expect(fs.existsSync(ipfsDir)).toBe(true);
      expect(fs.readFileSync(vault, 'utf-8')).toBe('secret');
      expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['default', 'work']);
    });

    test("packaged layout: the default profile's core gate is the app data root's identity", async () => {
      const appRoot = track(makeTempDir());
      ensureProfile(appRoot, 'default', { defaultProfileDir: appRoot });
      ensureProfile(appRoot, 'work', { defaultProfileDir: appRoot });
      fs.mkdirSync(path.join(appRoot, 'identity'), { recursive: true });
      const dirs = [];

      await deleteProfile(appRoot, 'default', 'My Profile', {
        withCoreGate: async (dir, fn) => {
          dirs.push(dir);
          return fn({ gated: true, held: () => true });
        },
      });

      expect(dirs).toEqual([path.join(path.resolve(appRoot), 'identity')]);
      expect(fs.existsSync(path.join(appRoot, 'identity'))).toBe(false);
    });

    test('a development build without freedom-cored deletes ungated', async () => {
      const { appRoot, options, record } = devWorkProfile();

      await deleteProfile(appRoot, 'work', 'Work', {
        ...options,
        withCoreGate: async (_dir, fn) => fn(),
      });

      expect(fs.existsSync(record.dir)).toBe(false);
      expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['default']);
    });
    // A gate is held for the whole delete only while its holder lives: one
    // killed mid-delete releases it, and a core or service can then start on
    // the profile's directories while the removal still runs. Each gated
    // directory moves aside, as the catalog changes, before anything else
    // does; nothing is removed by its path after that, and a directory made
    // again there is spared. The tombstones go with the rest.
    describe('a gate lost after the first change', () => {
      const realpathOf = (dir) => fs.realpathSync.native(dir);
      const tombstones = (dir) =>
        fs.readdirSync(dir).filter((name) => /\.deleting-\d+-\d+$/.test(name));

      // A profile with all it can have: its identity, its IPFS data, the
      // rest of its data, its Radicle home and a staging copy beside it.
      function fullWorkProfile() {
        const { appRoot, options, record, vault } = devWorkProfile();
        const identityDir = path.join(record.dir, 'identity');
        const ipfsDir = path.join(record.dir, 'ipfs-data', 'freedom-ipfs');
        fs.writeFileSync(path.join(ipfsDir, 'freedom-ipfs.sqlite3'), 'blocks');
        fs.writeFileSync(path.join(record.dir, 'history.db'), 'h');
        const radicleDir = path.join(path.dirname(appRoot), 'R', 'abcdef12', String(record.slot));
        fs.mkdirSync(radicleDir, { recursive: true });
        fs.writeFileSync(path.join(radicleDir, 'node.db'), 'radicle');
        const staging = `${radicleDir}.migrating-4242-1700000000000`;
        fs.mkdirSync(staging);
        fs.writeFileSync(path.join(staging, 'blob'), 'x');
        return { appRoot, options, record, vault, identityDir, ipfsDir, radicleDir, staging };
      }

      // Both gates, each held until `lose(name)`.
      function losableGates() {
        const held = { core: true, ipfs: true };
        return {
          lose: (name) => {
            held[name] = false;
          },
          withCoreGate: async (_dir, fn) => fn({ gated: true, held: () => held.core }),
          withIpfsGate: async (_dir, fn) => fn({ gated: true, held: () => held.ipfs }),
        };
      }

      // Runs `act(target)` once, as the first removal `when(target)` picks
      // begins, and lets that removal go on.
      function onRemoval(when, act) {
        const realRemovePath = fsOffload.removePath;
        let done = false;
        return jest.spyOn(fsOffload, 'removePath').mockImplementation(async (target, opts) => {
          if (!done && when(target)) {
            done = true;
            await act(target);
          }
          return realRemovePath(target, opts);
        });
      }

      const named = (prefix) => (target) => path.basename(target).startsWith(prefix);
      const STAGES = [
        ['its first removal', () => () => true],
        ["the identity directory's removal", () => named('.identity.deleting-')],
        ["the IPFS directory's removal", () => named('.freedom-ipfs.deleting-')],
        ["the rest of the profile's removal", () => named('history.db')],
        ["the Radicle home's removal", (p) => (target) => target === p.radicleDir],
        ["a Radicle staging copy's removal", (p) => (target) => target === p.staging],
      ];

      // What a new holder makes once it has the gate: a core its identity
      // directory and vault, the IPFS service its store.
      const NEW_HOLDERS = {
        core: {
          message: CORE_LOCK_LOST,
          start: (p) => {
            fs.mkdirSync(p.identityDir, { recursive: true });
            fs.writeFileSync(path.join(p.identityDir, 'vault.json'), 'the new core');
          },
          expectKept: (p) => {
            expect(fs.readdirSync(p.record.dir)).toEqual(['identity']);
            expect(fs.readdirSync(p.identityDir)).toEqual(['vault.json']);
            expect(fs.readFileSync(path.join(p.identityDir, 'vault.json'), 'utf-8')).toBe(
              'the new core'
            );
          },
        },
        ipfs: {
          message: IPFS_LOCK_LOST,
          start: (p) => {
            fs.mkdirSync(p.ipfsDir, { recursive: true });
            fs.writeFileSync(path.join(p.ipfsDir, 'new-owner'), 'theirs');
          },
          expectKept: (p) => {
            expect(fs.readdirSync(p.record.dir)).toEqual(['ipfs-data']);
            expect(fs.readdirSync(path.dirname(p.ipfsDir))).toEqual(['freedom-ipfs']);
            expect(fs.readdirSync(p.ipfsDir)).toEqual(['new-owner']);
          },
        },
      };

      describe.each(Object.keys(NEW_HOLDERS))('the %s gate', (gateName) => {
        test.each(STAGES)(
          'lost at %s: a new holder keeps what it made, the rest goes, and the loss is reported',
          async (_stage, pick) => {
            const profile = fullWorkProfile();
            const holder = NEW_HOLDERS[gateName];
            const { lose, withCoreGate, withIpfsGate } = losableGates();
            const rmSpy = onRemoval(pick(profile), () => {
              lose(gateName);
              holder.start(profile);
            });

            try {
              await expect(
                deleteProfile(profile.appRoot, 'work', 'Work', {
                  ...profile.options,
                  withCoreGate,
                  withIpfsGate,
                })
              ).rejects.toThrow(holder.message);
            } finally {
              rmSpy.mockRestore();
            }

            holder.expectKept(profile);
            expect(fs.existsSync(profile.radicleDir)).toBe(false);
            expect(fs.existsSync(profile.staging)).toBe(false);
            expect(loadCatalog(profile.appRoot).profiles.map((p) => p.id)).toEqual(['default']);
          }
        );
      });

      // Before the walk reads the data root: the directory made again is one
      // of the entries it meets.
      test.each(Object.keys(NEW_HOLDERS))(
        'the %s gate lost as the walk begins: its new holder keeps what it made',
        async (gateName) => {
          const profile = fullWorkProfile();
          const holder = NEW_HOLDERS[gateName];
          const { lose, withCoreGate, withIpfsGate } = losableGates();
          const realReaddir = fs.promises.readdir;
          let done = false;
          const readdirSpy = jest
            .spyOn(fs.promises, 'readdir')
            .mockImplementation(async (dir, ...rest) => {
              if (!done && path.resolve(dir) === path.resolve(profile.record.dir)) {
                done = true;
                lose(gateName);
                holder.start(profile);
              }
              return realReaddir(dir, ...rest);
            });

          try {
            await expect(
              deleteProfile(profile.appRoot, 'work', 'Work', {
                ...profile.options,
                withCoreGate,
                withIpfsGate,
              })
            ).rejects.toThrow(holder.message);
          } finally {
            readdirSpy.mockRestore();
          }

          expect(done).toBe(true);
          holder.expectKept(profile);
        }
      );

      test('both gates lost: both new holders keep theirs, and both losses are reported', async () => {
        const profile = fullWorkProfile();
        const { lose, withCoreGate, withIpfsGate } = losableGates();
        const rmSpy = onRemoval(
          () => true,
          () => {
            lose('core');
            lose('ipfs');
            NEW_HOLDERS.core.start(profile);
            NEW_HOLDERS.ipfs.start(profile);
          }
        );

        try {
          await expect(
            deleteProfile(profile.appRoot, 'work', 'Work', {
              ...profile.options,
              withCoreGate,
              withIpfsGate,
            })
          ).rejects.toThrow(
            'The profile was deleted, but its core lock and IPFS data lock were lost during the ' +
              'delete. A process may have taken them since, so its identity directory and IPFS ' +
              'data directory, if made again, were left alone.'
          );
        } finally {
          rmSpy.mockRestore();
        }

        expect(fs.readdirSync(profile.record.dir).sort()).toEqual(['identity', 'ipfs-data']);
        expect(fs.readdirSync(profile.identityDir)).toEqual(['vault.json']);
        expect(fs.readdirSync(profile.ipfsDir)).toEqual(['new-owner']);
      });

      test("packaged layout: a core gate lost while the identity directory goes leaves the new core the app root's identity", async () => {
        const appRoot = track(makeTempDir());
        ensureProfile(appRoot, 'default', { defaultProfileDir: appRoot });
        const { record: work } = ensureProfile(appRoot, 'work', { defaultProfileDir: appRoot });
        const identityDir = path.join(appRoot, 'identity');
        fs.mkdirSync(identityDir);
        fs.writeFileSync(path.join(identityDir, 'vault.json'), 'secret');
        fs.mkdirSync(path.join(appRoot, 'ipfs-data', 'freedom-ipfs'), { recursive: true });
        fs.writeFileSync(path.join(appRoot, 'Cookies'), 'cookies');
        const { lose, withCoreGate, withIpfsGate } = losableGates();
        const rmSpy = onRemoval(named('.identity.deleting-'), () => {
          lose('core');
          fs.mkdirSync(identityDir);
          fs.writeFileSync(path.join(identityDir, 'vault.json'), 'the new core');
        });

        try {
          await expect(
            deleteProfile(appRoot, 'default', 'My Profile', { withCoreGate, withIpfsGate })
          ).rejects.toThrow(CORE_LOCK_LOST);
        } finally {
          rmSpy.mockRestore();
        }

        expect(fs.readFileSync(path.join(identityDir, 'vault.json'), 'utf-8')).toBe('the new core');
        expect(tombstones(appRoot)).toEqual([]);
        for (const gone of ['ipfs-data', 'Cookies', 'profile.json']) {
          expect(fs.existsSync(path.join(appRoot, gone))).toBe(false);
        }
        expect(fs.existsSync(work.dir)).toBe(true);
        expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['work']);
      });

      test('under the core gate alone, the identity directory is fenced and spared; the IPFS data goes with the rest', async () => {
        const profile = fullWorkProfile();
        const { lose, withCoreGate } = losableGates();
        const rmSpy = onRemoval(named('.identity.deleting-'), () => {
          lose('core');
          NEW_HOLDERS.core.start(profile);
        });

        try {
          await expect(
            deleteProfile(profile.appRoot, 'work', 'Work', { ...profile.options, withCoreGate })
          ).rejects.toThrow(CORE_LOCK_LOST);
        } finally {
          rmSpy.mockRestore();
        }

        NEW_HOLDERS.core.expectKept(profile);
      });

      test('with the gates held throughout: the tombstones are removed, and nothing by a gated path', async () => {
        const profile = fullWorkProfile();
        const profileDir = realpathOf(profile.record.dir);
        const { withCoreGate, withIpfsGate } = losableGates();
        const realRename = fs.renameSync;
        const renames = [];
        const renameSpy = jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
          renames.push({
            from,
            to,
            catalogIds: loadCatalog(profile.appRoot).profiles.map((p) => p.id),
          });
          return realRename(from, to);
        });
        const realRemovePath = fsOffload.removePath;
        const removals = [];
        const rmSpy = jest.spyOn(fsOffload, 'removePath').mockImplementation((target, opts) => {
          removals.push(target);
          return realRemovePath(target, opts);
        });

        try {
          await deleteProfile(profile.appRoot, 'work', 'Work', {
            ...profile.options,
            withCoreGate,
            withIpfsGate,
          });
        } finally {
          renameSpy.mockRestore();
          rmSpy.mockRestore();
        }

        // The identity directory, then the IPFS directory, each to a
        // tombstone beside it, and then the catalog, in that order.
        const identityTomb = expect.stringMatching(/[/\\]\.identity\.deleting-\d+-\d+$/);
        const ipfsTomb = expect.stringMatching(/[/\\]\.freedom-ipfs\.deleting-\d+-\d+$/);
        expect(renames.slice(0, 2)).toEqual([
          {
            from: path.join(profileDir, 'identity'),
            to: identityTomb,
            catalogIds: ['default', 'work'],
          },
          {
            from: path.join(profileDir, 'ipfs-data', 'freedom-ipfs'),
            to: ipfsTomb,
            catalogIds: ['default', 'work'],
          },
        ]);
        expect(path.dirname(renames[0].to)).toBe(profileDir);
        expect(path.dirname(renames[1].to)).toBe(path.join(profileDir, 'ipfs-data'));
        expect(renames[2].to).toBe(
          path.join(path.resolve(profile.appRoot), 'profile-registry.json')
        );
        expect(renames).toHaveLength(3);

        const resolvedDir = path.resolve(profile.record.dir);
        const gatedPaths = [
          path.join(resolvedDir, 'identity'),
          path.join(resolvedDir, 'ipfs-data', 'freedom-ipfs'),
        ];
        for (const gated of gatedPaths) expect(removals).not.toContain(gated);
        expect(removals).toEqual(
          expect.arrayContaining([
            path.join(resolvedDir, path.basename(renames[0].to)),
            path.join(resolvedDir, 'ipfs-data', path.basename(renames[1].to)),
          ])
        );
        expect(fs.existsSync(profile.record.dir)).toBe(false);
        expect(fs.existsSync(profile.radicleDir)).toBe(false);
      });

      // A core or service that tries to start while the delete holds its
      // gate makes its missing directory, then waits out the gate.
      describe('a directory made again under a gate still held', () => {
        test.each([
          ['a core', (p) => p.identityDir],
          ['an IPFS service', (p) => p.ipfsDir],
        ])(
          'by %s that only tried to start: removed, and the profile with it',
          async (_who, dirOf) => {
            const profile = fullWorkProfile();
            const { withCoreGate, withIpfsGate } = losableGates();
            const rmSpy = onRemoval(
              () => true,
              () => fs.mkdirSync(dirOf(profile), { recursive: true })
            );

            try {
              await deleteProfile(profile.appRoot, 'work', 'Work', {
                ...profile.options,
                withCoreGate,
                withIpfsGate,
              });
            } finally {
              rmSpy.mockRestore();
            }

            expect(fs.existsSync(profile.record.dir)).toBe(false);
          }
        );

        test('made again after the walk passed it: removed too', async () => {
          const profile = fullWorkProfile();
          const { withCoreGate, withIpfsGate } = losableGates();
          // The last removal: the profile's directory has gone by then.
          const rmSpy = onRemoval(
            (target) => target === profile.staging,
            () => fs.mkdirSync(profile.identityDir, { recursive: true })
          );

          try {
            await deleteProfile(profile.appRoot, 'work', 'Work', {
              ...profile.options,
              withCoreGate,
              withIpfsGate,
            });
          } finally {
            rmSpy.mockRestore();
          }

          expect(fs.existsSync(profile.record.dir)).toBe(false);
        });

        test('packaged layout: removed, and the app data root kept', async () => {
          const appRoot = track(makeTempDir());
          ensureProfile(appRoot, 'default', { defaultProfileDir: appRoot });
          ensureProfile(appRoot, 'work', { defaultProfileDir: appRoot });
          fs.mkdirSync(path.join(appRoot, 'identity'));
          fs.writeFileSync(path.join(appRoot, 'Cookies'), 'cookies');
          const { withCoreGate, withIpfsGate } = losableGates();
          const rmSpy = onRemoval(
            () => true,
            () => fs.mkdirSync(path.join(appRoot, 'identity'))
          );

          try {
            await deleteProfile(appRoot, 'default', 'My Profile', { withCoreGate, withIpfsGate });
          } finally {
            rmSpy.mockRestore();
          }

          expect(fs.existsSync(path.join(appRoot, 'identity'))).toBe(false);
          expect(fs.existsSync(path.join(appRoot, 'Cookies'))).toBe(false);
          expect(fs.existsSync(path.join(appRoot, 'profile-registry.json'))).toBe(true);
        });

        test('under a gate lost meanwhile, even an empty one stays', async () => {
          const profile = fullWorkProfile();
          const { lose, withCoreGate, withIpfsGate } = losableGates();
          const rmSpy = onRemoval(
            () => true,
            () => {
              lose('core');
              fs.mkdirSync(profile.identityDir);
            }
          );

          try {
            await expect(
              deleteProfile(profile.appRoot, 'work', 'Work', {
                ...profile.options,
                withCoreGate,
                withIpfsGate,
              })
            ).rejects.toThrow(CORE_LOCK_LOST);
          } finally {
            rmSpy.mockRestore();
          }

          expect(fs.readdirSync(profile.record.dir)).toEqual(['identity']);
          expect(fs.readdirSync(profile.identityDir)).toEqual([]);
        });
      });
    });

    // The fence moves both gated directories and changes the catalog in one
    // step: a move Windows refuses (a scanner holding a file open) puts back
    // what that attempt moved before it waits, so nothing has changed at any
    // moment the delete awaits.
    describe("the fence's Windows retries", () => {
      const refusal = (code = 'EPERM') =>
        Object.assign(new Error(`${code}: operation not permitted`), { code });
      const heldGates = {
        withCoreGate: async (_dir, fn) => fn({ gated: true, held: () => true }),
        withIpfsGate: async (_dir, fn) => fn({ gated: true, held: () => true }),
      };
      const listed = (dir) => fs.readdirSync(dir).sort();

      // `refuse(from, to, calls)` throws to refuse a rename; anything else
      // runs.
      function renamesRefusing(refuse) {
        const realRename = fs.renameSync;
        const calls = [];
        const spy = jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
          calls.push({ from, to });
          refuse(from, to, calls);
          return realRename(from, to);
        });
        return { spy, calls };
      }

      test('a refused identity move is tried again, and the delete completes', async () => {
        const { appRoot, options, record } = devWorkProfile();
        const identityDir = path.join(fs.realpathSync.native(record.dir), 'identity');
        const { spy, calls } = renamesRefusing((from, _to, all) => {
          if (from === identityDir && all.filter((c) => c.from === identityDir).length === 1) {
            throw refusal();
          }
        });

        try {
          await deleteProfile(appRoot, 'work', 'Work', { ...options, ...heldGates });
        } finally {
          spy.mockRestore();
        }

        expect(calls.filter((c) => c.from === identityDir)).toHaveLength(2);
        expect(fs.existsSync(record.dir)).toBe(false);
        expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['default']);
      });

      test('a refused IPFS move puts the identity directory back before waiting, then both move', async () => {
        const { appRoot, options, record, vault } = devWorkProfile();
        const profileDir = fs.realpathSync.native(record.dir);
        const identityDir = path.join(profileDir, 'identity');
        const ipfsDir = path.join(profileDir, 'ipfs-data', 'freedom-ipfs');
        let refused = false;
        let atRetry = null;
        const { spy } = renamesRefusing((from) => {
          if (from === ipfsDir && !refused) {
            refused = true;
            throw refusal('EBUSY');
          }
          // The next attempt's first move: what the wait saw.
          if (from === identityDir && refused && atRetry === null) {
            atRetry = { listed: listed(record.dir), vault: fs.readFileSync(vault, 'utf-8') };
          }
        });

        try {
          await deleteProfile(appRoot, 'work', 'Work', { ...options, ...heldGates });
        } finally {
          spy.mockRestore();
        }

        expect(atRetry).toEqual({
          listed: ['identity', 'ipfs-data', 'profile.json'],
          vault: 'secret',
        });
        expect(fs.existsSync(record.dir)).toBe(false);
        expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['default']);
      });

      test('a move still refused after every retry fails the delete, with everything back in place', async () => {
        const { appRoot, options, record, vault } = devWorkProfile();
        const ipfsDir = path.join(fs.realpathSync.native(record.dir), 'ipfs-data', 'freedom-ipfs');
        const { spy, calls } = renamesRefusing((from) => {
          if (from === ipfsDir) throw refusal('EACCES');
        });
        const rmSpy = jest.spyOn(fsOffload, 'removePath');

        try {
          await expect(
            deleteProfile(appRoot, 'work', 'Work', { ...options, ...heldGates })
          ).rejects.toMatchObject({ code: 'EACCES' });
          expect(rmSpy).not.toHaveBeenCalled();
        } finally {
          spy.mockRestore();
          rmSpy.mockRestore();
        }

        expect(calls.filter((c) => c.from === ipfsDir)).toHaveLength(10);
        expect(listed(record.dir)).toEqual(['identity', 'ipfs-data', 'profile.json']);
        expect(fs.existsSync(ipfsDir)).toBe(true);
        expect(fs.readFileSync(vault, 'utf-8')).toBe('secret');
        expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['default', 'work']);
      });

      test('a move that fails otherwise is not retried, and puts back what moved', async () => {
        const { appRoot, options, record, vault } = devWorkProfile();
        const ipfsDir = path.join(fs.realpathSync.native(record.dir), 'ipfs-data', 'freedom-ipfs');
        const { spy, calls } = renamesRefusing((from) => {
          if (from === ipfsDir) throw refusal('EIO');
        });

        try {
          await expect(
            deleteProfile(appRoot, 'work', 'Work', { ...options, ...heldGates })
          ).rejects.toMatchObject({ code: 'EIO' });
        } finally {
          spy.mockRestore();
        }

        expect(calls.filter((c) => c.from === ipfsDir)).toHaveLength(1);
        expect(listed(record.dir)).toEqual(['identity', 'ipfs-data', 'profile.json']);
        expect(fs.readFileSync(vault, 'utf-8')).toBe('secret');
        expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['default', 'work']);
      });

      test("a move that can't be put back is named, with where it is", async () => {
        const { appRoot, options, record } = devWorkProfile();
        const profileDir = fs.realpathSync.native(record.dir);
        const ipfsDir = path.join(profileDir, 'ipfs-data', 'freedom-ipfs');
        const { spy } = renamesRefusing((from) => {
          if (from === ipfsDir) throw refusal('EIO');
          if (path.basename(from).startsWith('.identity.deleting-')) throw refusal('EBUSY');
        });

        let failure;
        try {
          failure = await deleteProfile(appRoot, 'work', 'Work', { ...options, ...heldGates }).then(
            () => null,
            (err) => err
          );
        } finally {
          spy.mockRestore();
        }

        const [tombstone] = fs
          .readdirSync(profileDir)
          .filter((name) => name.startsWith('.identity.'));
        expect(failure.message).toBe(
          "The profile couldn't be deleted, and not all of its data could be put back: its " +
            `identity data is at ${path.join(profileDir, tombstone)}. Move it back to its name ` +
            'without the leading dot and the ".deleting-…" suffix.'
        );
        expect(failure.cause).toMatchObject({ code: 'EIO' });
        expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['default', 'work']);
      });

      test('a refused catalog write puts the moves back, and the retry drops only the deleted profile', async () => {
        const { appRoot, options, record } = devWorkProfile();
        ensureProfile(appRoot, 'play', options);
        const registry = path.join(path.resolve(appRoot), 'profile-registry.json');
        let refused = false;
        let atRetry = null;
        const identityDir = path.join(fs.realpathSync.native(record.dir), 'identity');
        const { spy } = renamesRefusing((from, to) => {
          if (to === registry && !refused) {
            refused = true;
            throw refusal();
          }
          if (from === identityDir && refused && atRetry === null) {
            atRetry = listed(record.dir);
          }
        });

        try {
          await deleteProfile(appRoot, 'work', 'Work', { ...options, ...heldGates });
        } finally {
          spy.mockRestore();
        }

        expect(atRetry).toEqual(['identity', 'ipfs-data', 'profile.json']);
        expect(fs.existsSync(record.dir)).toBe(false);
        expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['default', 'play']);
      });
    });

    test('a held core gate with the identity directory a link: refused, and nothing changes', async () => {
      const { appRoot, options, record } = devWorkProfile();
      const elsewhere = path.join(path.dirname(appRoot), 'elsewhere');
      fs.renameSync(path.join(record.dir, 'identity'), elsewhere);
      fs.symlinkSync(
        elsewhere,
        path.join(record.dir, 'identity'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );

      await expect(
        deleteProfile(appRoot, 'work', 'Work', {
          ...options,
          withCoreGate: async (_dir, fn) => fn({ gated: true, held: () => true }),
        })
      ).rejects.toThrow("The profile's identity data is reached through a link");

      expect(fs.readFileSync(path.join(elsewhere, 'vault.json'), 'utf-8')).toBe('secret');
      expect(fs.lstatSync(path.join(record.dir, 'identity')).isSymbolicLink()).toBe(true);
      expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['default', 'work']);
    });

    test('a held core gate alone with the Radicle path through a link: refused, and nothing changes', async () => {
      const { appRoot, options, record, vault } = devWorkProfile();
      const outside = path.join(path.dirname(path.dirname(appRoot)), 'outside');
      fs.mkdirSync(path.join(outside, String(record.slot)), { recursive: true });
      fs.writeFileSync(path.join(outside, String(record.slot), 'unrelated'), 'keep me');
      fs.mkdirSync(path.join(path.dirname(appRoot), 'R'), { recursive: true });
      fs.symlinkSync(
        outside,
        path.join(path.dirname(appRoot), 'R', 'abcdef12'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );

      await expect(
        deleteProfile(appRoot, 'work', 'Work', {
          ...options,
          withCoreGate: async (_dir, fn) => fn({ gated: true, held: () => true }),
        })
      ).rejects.toThrow("The profile's Radicle data is reached through a link");

      expect(fs.readFileSync(path.join(outside, String(record.slot), 'unrelated'), 'utf-8')).toBe(
        'keep me'
      );
      expect(fs.readFileSync(vault, 'utf-8')).toBe('secret');
      expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['default', 'work']);
    });
  });

  // freedom-core design 0008, "Spawn and lock": a catalog profile's Radicle
  // home (`R/<slot>`, outside its directory) goes under freedom-radicled's
  // gate, the interim in main for design 0013's "Deletion".
  describe("under the profile's Radicle home gate", () => {
    const RADICLE_LOCK_LOST =
      'The profile was deleted, but its Radicle home lock was lost during the delete';
    const tombstones = (dir) =>
      fs.readdirSync(dir).filter((name) => /\.deleting-\d+-\d+$/.test(name));

    function devWorkProfile() {
      const tempRoot = track(makeTempDir());
      const appRoot = path.join(tempRoot, 'Freedom Dev', 'freedom-browser-abcdef12');
      const options = {
        checkoutHash: 'abcdef12',
        defaultProfileDir: path.join(appRoot, 'Profiles', 'default'),
        dev: true,
      };
      ensureProfile(appRoot, 'default', options);
      const { record } = ensureProfile(appRoot, 'work', options);
      const vault = path.join(record.dir, 'identity', 'vault.json');
      fs.mkdirSync(path.dirname(vault), { recursive: true });
      fs.writeFileSync(vault, 'secret');
      fs.mkdirSync(path.join(record.dir, 'ipfs-data', 'freedom-ipfs'), { recursive: true });
      const radicleDir = path.join(path.dirname(appRoot), 'R', 'abcdef12', String(record.slot));
      fs.mkdirSync(path.join(radicleDir, 'storage'), { recursive: true });
      fs.writeFileSync(path.join(radicleDir, 'storage', 'repo'), 'seeded');
      return { appRoot, options, record, vault, radicleDir };
    }

    // A gate held until `lose()`.
    function losableGate() {
      let held = true;
      return {
        lose: () => {
          held = false;
        },
        withRadicleGate: async (_dir, fn) => fn({ gated: true, held: () => held }),
      };
    }

    test('takes it on R/<checkoutHash>/<slot> after the core and IPFS gates, and removes the home under it', async () => {
      const { appRoot, options, record, radicleDir } = devWorkProfile();
      const events = [];
      const holding = new Set();
      const removals = [];
      const realRemovePath = fsOffload.removePath;
      const rmSpy = jest.spyOn(fsOffload, 'removePath').mockImplementation((target, opts) => {
        removals.push({ target, holding: [...holding] });
        return realRemovePath(target, opts);
      });
      const gate = (name) => async (dir, fn) => {
        events.push({ take: name, dir, catalogIds: loadCatalog(appRoot).profiles.map((p) => p.id) });
        holding.add(name);
        try {
          return await fn({ gated: true, held: () => holding.has(name) });
        } finally {
          holding.delete(name);
          events.push({ release: name });
        }
      };
      try {
        await deleteProfile(appRoot, 'work', 'Work', {
          ...options,
          withCoreGate: gate('core'),
          withIpfsGate: gate('ipfs'),
          withRadicleGate: gate('radicle'),
        });
      } finally {
        rmSpy.mockRestore();
      }

      const profileDir = path.resolve(record.dir);
      expect(events).toEqual([
        { take: 'core', dir: path.join(profileDir, 'identity'), catalogIds: ['default', 'work'] },
        {
          take: 'ipfs',
          dir: path.join(profileDir, 'ipfs-data', 'freedom-ipfs'),
          catalogIds: ['default', 'work'],
        },
        { take: 'radicle', dir: path.resolve(radicleDir), catalogIds: ['default', 'work'] },
        { release: 'radicle' },
        { release: 'ipfs' },
        { release: 'core' },
      ]);
      expect(removals.length).toBeGreaterThan(0);
      for (const removal of removals) expect(removal.holding).toEqual(['core', 'ipfs', 'radicle']);
      // The home went by its tombstone, never by its own path.
      expect(removals.map((removal) => removal.target)).not.toContain(path.resolve(radicleDir));
      expect(fs.existsSync(radicleDir)).toBe(false);
      expect(tombstones(path.dirname(radicleDir))).toEqual([]);
      expect(fs.existsSync(record.dir)).toBe(false);
    });

    test('a gate another writer holds fails the delete, and changes nothing', async () => {
      const { appRoot, options, vault, radicleDir } = devWorkProfile();
      const held = Object.assign(
        new Error('The Radicle data is in use by another process. Close it and try again.'),
        { name: 'RadicleGateError', code: 'lock_held' }
      );
      const rmSpy = jest.spyOn(fsOffload, 'removePath');

      try {
        await expect(
          deleteProfile(appRoot, 'work', 'Work', {
            ...options,
            withCoreGate: async (_dir, fn) => fn({ gated: true, held: () => true }),
            withIpfsGate: async (_dir, fn) => fn({ gated: true, held: () => true }),
            withRadicleGate: async () => {
              throw held;
            },
          })
        ).rejects.toBe(held);
        expect(rmSpy).not.toHaveBeenCalled();
      } finally {
        rmSpy.mockRestore();
      }
      expect(fs.readFileSync(path.join(radicleDir, 'storage', 'repo'), 'utf-8')).toBe('seeded');
      expect(fs.readFileSync(vault, 'utf-8')).toBe('secret');
      expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['default', 'work']);
      expect(isCatalogLockHeld(appRoot)).toBe(false);
    });

    test('a gate already lost fails the delete before anything changes', async () => {
      const { appRoot, options, vault, radicleDir } = devWorkProfile();
      const rmSpy = jest.spyOn(fsOffload, 'removePath');

      try {
        await expect(
          deleteProfile(appRoot, 'work', 'Work', {
            ...options,
            withRadicleGate: async (_dir, fn) => fn({ gated: true, held: () => false }),
          })
        ).rejects.toThrow("The Radicle home's lock was lost; nothing was deleted");
        expect(rmSpy).not.toHaveBeenCalled();
      } finally {
        rmSpy.mockRestore();
      }
      expect(fs.readFileSync(path.join(radicleDir, 'storage', 'repo'), 'utf-8')).toBe('seeded');
      expect(fs.readFileSync(vault, 'utf-8')).toBe('secret');
      expect(tombstones(path.dirname(radicleDir))).toEqual([]);
      expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['default', 'work']);
    });

    test('lost mid-delete: a home a new holder made is spared, and the loss is reported', async () => {
      const { appRoot, options, record, radicleDir } = devWorkProfile();
      const { lose, withRadicleGate } = losableGate();
      const realRemovePath = fsOffload.removePath;
      let done = false;
      const rmSpy = jest.spyOn(fsOffload, 'removePath').mockImplementation(async (target, opts) => {
        if (!done) {
          done = true;
          lose();
          fs.mkdirSync(path.join(radicleDir, 'node'), { recursive: true });
          fs.writeFileSync(path.join(radicleDir, 'node', 'new-owner'), 'theirs');
        }
        return realRemovePath(target, opts);
      });

      try {
        await expect(
          deleteProfile(appRoot, 'work', 'Work', { ...options, withRadicleGate })
        ).rejects.toThrow(
          `${RADICLE_LOCK_LOST}. A process may have taken it since, so its Radicle home, if made ` +
            'again, was left alone.'
        );
      } finally {
        rmSpy.mockRestore();
      }

      expect(fs.readdirSync(radicleDir)).toEqual(['node']);
      expect(fs.readFileSync(path.join(radicleDir, 'node', 'new-owner'), 'utf-8')).toBe('theirs');
      expect(tombstones(path.dirname(radicleDir))).toEqual([]);
      expect(fs.existsSync(record.dir)).toBe(false);
      expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['default']);
    });

    test('a home made again empty under the gate still held goes too', async () => {
      const { appRoot, options, radicleDir } = devWorkProfile();
      const { withRadicleGate } = losableGate();
      const realRemovePath = fsOffload.removePath;
      let done = false;
      // A start that waited out the gate: hold-lock and serve make the home
      // before they try its lock.
      const rmSpy = jest.spyOn(fsOffload, 'removePath').mockImplementation(async (target, opts) => {
        if (!done) {
          done = true;
          fs.mkdirSync(radicleDir, { recursive: true });
        }
        return realRemovePath(target, opts);
      });

      try {
        await deleteProfile(appRoot, 'work', 'Work', { ...options, withRadicleGate });
      } finally {
        rmSpy.mockRestore();
      }

      expect(done).toBe(true);
      expect(fs.existsSync(radicleDir)).toBe(false);
      expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['default']);
    });

    test('under its gate alone, a link in the home\'s path is refused before anything changes', async () => {
      const { appRoot, options, record, vault } = devWorkProfile();
      const outside = track(makeTempDir());
      const checkoutHome = path.join(path.dirname(appRoot), 'R', 'abcdef12');
      fs.rmSync(checkoutHome, { recursive: true, force: true });
      fs.mkdirSync(path.join(outside, String(record.slot)), { recursive: true });
      fs.writeFileSync(path.join(outside, String(record.slot), 'unrelated'), 'keep me');
      fs.symlinkSync(outside, checkoutHome, process.platform === 'win32' ? 'junction' : 'dir');

      await expect(
        deleteProfile(appRoot, 'work', 'Work', {
          ...options,
          withRadicleGate: losableGate().withRadicleGate,
        })
      ).rejects.toThrow("The profile's Radicle data is reached through a link");

      expect(fs.readFileSync(path.join(outside, String(record.slot), 'unrelated'), 'utf-8')).toBe(
        'keep me'
      );
      expect(fs.readFileSync(vault, 'utf-8')).toBe('secret');
      expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['default', 'work']);
    });

    test('a profile without a slot has no Radicle home, and takes no Radicle gate', async () => {
      const { appRoot, options, record } = devWorkProfile();
      const catalog = loadCatalog(appRoot);
      delete catalog.profiles.find((p) => p.id === 'work').slot;
      saveCatalog(appRoot, catalog);
      const withRadicleGate = jest.fn((_dir, fn) => fn({ gated: true, held: () => true }));

      await deleteProfile(appRoot, 'work', 'Work', { ...options, withRadicleGate });

      expect(withRadicleGate).not.toHaveBeenCalled();
      expect(fs.existsSync(record.dir)).toBe(false);
    });
  });

  describe('deleting the default profile (#124)', () => {
    test('dev layout: removes Profiles/default and its Radicle home, keeps the rest', async () => {
      const tempRoot = track(makeTempDir());
      const appRoot = path.join(tempRoot, 'Freedom Dev', 'freedom-browser-abcdef12');
      const defaultProfileDir = path.join(appRoot, 'Profiles', 'default');
      const options = { checkoutHash: 'abcdef12', defaultProfileDir, dev: true };
      const { record: defaultRecord } = ensureProfile(appRoot, 'default', options);
      const { record: workRecord } = ensureProfile(appRoot, 'work', options);
      const radicleRoot = path.join(tempRoot, 'Freedom Dev', 'R', 'abcdef12');
      fs.mkdirSync(path.join(radicleRoot, '0'), { recursive: true });
      fs.mkdirSync(path.join(radicleRoot, String(workRecord.slot)), { recursive: true });

      await deleteProfile(appRoot, 'default', 'My Profile', { checkoutHash: 'abcdef12', dev: true });

      expect(fs.existsSync(defaultRecord.dir)).toBe(false);
      expect(fs.existsSync(path.join(radicleRoot, '0'))).toBe(false);
      expect(fs.existsSync(workRecord.dir)).toBe(true);
      expect(fs.existsSync(path.join(radicleRoot, String(workRecord.slot)))).toBe(true);
      expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['work']);
    });

    // A packaged build keeps the default profile in the app data root itself,
    // next to the catalog and every other profile — so it must be removed
    // entry by entry, never by deleting the root.
    test('packaged layout: wipes the default profile out of the app data root only', async () => {
      const appRoot = track(makeTempDir());
      ensureProfile(appRoot, 'default', { defaultProfileDir: appRoot });
      const { record: workRecord } = ensureProfile(appRoot, 'work', {
        defaultProfileDir: appRoot,
      });

      // The default profile's own data, as the app lays it out in userData.
      fs.mkdirSync(path.join(appRoot, 'identity-data'), { recursive: true });
      fs.writeFileSync(path.join(appRoot, 'identity-data', 'vault.json'), 'secret');
      fs.writeFileSync(path.join(appRoot, 'Cookies'), 'cookies');
      fs.writeFileSync(path.join(appRoot, 'profile-open'), 'lock target');
      fs.mkdirSync(path.join(appRoot, 'R', '0'), { recursive: true });

      // App-wide entries that must survive.
      fs.writeFileSync(path.join(workRecord.dir, 'history.sqlite'), 'work data');
      fs.mkdirSync(path.join(appRoot, 'R', String(workRecord.slot)), { recursive: true });
      fs.writeFileSync(path.join(appRoot, 'updater-owner'), 'updater lock target');
      fs.mkdirSync(path.join(appRoot, 'updater-owner.lock'));
      fs.mkdirSync(path.join(appRoot, 'logs'));
      fs.writeFileSync(path.join(appRoot, 'logs', 'main.log'), 'log');
      const unregisteredDir = path.join(appRoot, 'Profiles', 'stray');
      fs.mkdirSync(unregisteredDir, { recursive: true });

      await deleteProfile(appRoot, 'default', 'My Profile');

      for (const gone of ['identity-data', 'Cookies', 'profile-open', 'profile.json']) {
        expect(fs.existsSync(path.join(appRoot, gone))).toBe(false);
      }
      expect(fs.existsSync(path.join(appRoot, 'R', '0'))).toBe(false);

      expect(fs.readFileSync(path.join(workRecord.dir, 'history.sqlite'), 'utf-8')).toBe(
        'work data'
      );
      expect(fs.existsSync(path.join(appRoot, 'R', String(workRecord.slot)))).toBe(true);
      expect(fs.existsSync(path.join(appRoot, 'updater-owner'))).toBe(true);
      expect(fs.existsSync(path.join(appRoot, 'updater-owner.lock'))).toBe(true);
      expect(fs.existsSync(path.join(appRoot, 'logs', 'main.log'))).toBe(true);
      expect(fs.existsSync(unregisteredDir)).toBe(true);
      expect(fs.existsSync(getCatalogLockPaths(appRoot).targetPath)).toBe(true);
      expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['work']);
    });

    // macOS and Windows: the packaged app data root is <appData>/Freedom, and
    // the lock directory every Freedom build shares (service-locks.js,
    // freedom-core design 0001, "Lifetime lock") is <appData>/Freedom/locks,
    // inside it. 0001 says it is never deleted: removed, every gate held at
    // that moment goes with it, and the next process locks a new file under
    // the same name.
    describe('packaged layout on macOS and Windows: the shared lock directory', () => {
      function packagedLayout() {
        const appData = track(makeTempDir());
        const appRoot = path.join(appData, 'Freedom');
        ensureProfile(appRoot, 'default', { defaultProfileDir: appRoot });
        ensureProfile(appRoot, 'work', { defaultProfileDir: appRoot });
        const lockDir = lockDirFor(appData);
        expect(path.dirname(lockDir)).toBe(appRoot);
        const held = ['a'.repeat(64), `ipfs-${'b'.repeat(64)}`].map((name) =>
          path.join(lockDir, `${name}.lock`)
        );
        fs.mkdirSync(lockDir, { recursive: true });
        for (const file of held) fs.writeFileSync(file, '');
        fs.mkdirSync(path.join(appRoot, 'identity'), { recursive: true });
        fs.writeFileSync(path.join(appRoot, 'identity', 'vault.json'), 'secret');
        fs.mkdirSync(path.join(appRoot, 'ipfs-data', 'freedom-ipfs'), { recursive: true });
        return { appRoot, lockDir, held };
      }

      test.each([
        ['without a gate', {}],
        [
          'under a held IPFS gate',
          { withIpfsGate: async (_dir, fn) => fn({ gated: true, held: () => true }) },
        ],
        [
          'under held core and IPFS gates',
          {
            withCoreGate: async (_dir, fn) => fn({ gated: true, held: () => true }),
            withIpfsGate: async (_dir, fn) => fn({ gated: true, held: () => true }),
          },
        ],
      ])("survives the default profile's delete, %s", async (_label, options) => {
        const { appRoot, held } = packagedLayout();

        await deleteProfile(appRoot, 'default', 'My Profile', options);

        for (const file of held) expect(fs.existsSync(file)).toBe(true);
        expect(fs.readdirSync(appRoot).filter((name) => name.includes('.deleting-'))).toEqual([]);
        expect(fs.existsSync(path.join(appRoot, 'identity'))).toBe(false);
        expect(fs.existsSync(path.join(appRoot, 'ipfs-data'))).toBe(false);
        expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['work']);
      });
    });

    test('still refuses a non-default record that points at the app data root', async () => {
      const appRoot = track(makeTempDir());
      ensureProfile(appRoot, 'default', { defaultProfileDir: appRoot });
      ensureProfile(appRoot, 'work', { defaultProfileDir: appRoot });
      const catalog = loadCatalog(appRoot);
      catalog.profiles.find((p) => p.id === 'work').dir = appRoot;
      saveCatalog(appRoot, catalog);

      await expect(deleteProfile(appRoot, 'work', 'Work')).rejects.toThrow(
        'Refusing to delete a profile outside the app data root'
      );
      expect(fs.existsSync(path.join(appRoot, 'profile.json'))).toBe(true);
    });

    test('refuses the last remaining profile and removes nothing', async () => {
      const appRoot = track(makeTempDir());
      ensureProfile(appRoot, 'default', { defaultProfileDir: appRoot });

      await expect(deleteProfile(appRoot, 'default', 'My Profile')).rejects.toThrow(
        'The last remaining profile cannot be deleted'
      );
      expect(fs.existsSync(path.join(appRoot, 'profile.json'))).toBe(true);
      expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['default']);
    });

    test('refuses a default profile that is currently open', async () => {
      const appRoot = track(makeTempDir());
      ensureProfile(appRoot, 'default', { defaultProfileDir: appRoot });
      ensureProfile(appRoot, 'work', { defaultProfileDir: appRoot });

      await expect(
        deleteProfile(appRoot, 'default', 'My Profile', {
          isProfileLocked: (record) => record.id === 'default',
        })
      ).rejects.toThrow('Profile is currently open: My Profile');
      expect(fs.existsSync(path.join(appRoot, 'profile.json'))).toBe(true);
      expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['default', 'work']);
    });
  });

  describe('validateProfileDeletion', () => {
    function seedWorkProfile() {
      const appRoot = track(makeTempDir());
      const defaultProfileDir = path.join(appRoot, 'Profiles', 'default');
      fs.mkdirSync(defaultProfileDir, { recursive: true });
      ensureProfile(appRoot, 'default', { defaultProfileDir });
      ensureProfile(appRoot, 'work', { defaultProfileDir });
      return appRoot;
    }

    test('passes for a registered profile with a matching display name', () => {
      const appRoot = seedWorkProfile();
      expect(() => validateProfileDeletion(appRoot, 'work', 'Work')).not.toThrow();
    });

    test('rejects a mismatched display-name confirmation', () => {
      const appRoot = seedWorkProfile();
      expect(() => validateProfileDeletion(appRoot, 'work', 'Wrong')).toThrow(
        'Profile display name confirmation did not match'
      );
    });

    test('rejects an unknown profile id', () => {
      const appRoot = seedWorkProfile();
      expect(() => validateProfileDeletion(appRoot, 'ghost', 'Ghost')).toThrow(
        'Profile not found: ghost'
      );
    });

    // #124: the guard is "never the last profile", not "never `default`".
    test('allows deleting the default profile while another profile remains', () => {
      const appRoot = seedWorkProfile();
      expect(() => validateProfileDeletion(appRoot, 'default', 'My Profile')).not.toThrow();
    });

    test('rejects deleting the last remaining profile, default or not', () => {
      const appRoot = track(makeTempDir());
      ensureProfile(appRoot, 'work');
      expect(() => validateProfileDeletion(appRoot, 'work', 'Work')).toThrow(
        'The last remaining profile cannot be deleted'
      );

      const defaultRoot = track(makeTempDir());
      ensureProfile(defaultRoot, 'default');
      expect(() => validateProfileDeletion(defaultRoot, 'default', 'My Profile')).toThrow(
        'The last remaining profile cannot be deleted'
      );
    });

    test('does not remove anything (pure validation)', () => {
      const appRoot = seedWorkProfile();
      const workDir = path.join(appRoot, 'Profiles', 'work');
      validateProfileDeletion(appRoot, 'work', 'Work');
      expect(fs.existsSync(workDir)).toBe(true);
    });
  });
});
