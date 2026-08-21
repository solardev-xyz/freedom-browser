const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  deleteProfile,
  ensureProfile,
  getCatalogLockPaths,
  validateProfileDeletion,
  withCatalogWriteLock,
} = require('./profile-catalog');

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

  test('deletes the short app-owned Radicle home with a profile', () => {
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

    deleteProfile(appRoot, 'work', 'Work', {
      checkoutHash: 'abcdef12',
      dev: true,
    });

    expect(fs.existsSync(record.dir)).toBe(false);
    expect(fs.existsSync(radicleDir)).toBe(false);
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

    test('rejects deleting the default profile', () => {
      const appRoot = seedWorkProfile();
      expect(() => validateProfileDeletion(appRoot, 'default', 'Default')).toThrow(
        'The default profile cannot be deleted'
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
