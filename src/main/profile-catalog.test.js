const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  deleteProfile,
  ensureProfile,
  getCatalogLockPaths,
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
