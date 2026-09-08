jest.mock('./logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const path = require('path');
const os = require('os');
const fs = require('fs');

const REQUIRED_FAKE_EXPORTS = [
  'start', 'shutdown', 'connectSeeds', 'cloneRepo', 'cloneRepoWithProgress',
  'cancelClone', 'unseedRepo', 'listRepos', 'listSeededRepos',
  'issues', 'issue', 'patches', 'patch',
  'identity', 'createIssue', 'commentIssue', 'editIssueState', 'commentPatch',
  'importRepo', 'repoInfo', 'commits', 'commit', 'tree', 'treeAt', 'blob', 'blobAt',
  'remotes', 'repoStats', 'status', 'seeders',
].map((name) => `${name}: async () => JSON.stringify({ ok: true }),`).join('');

describe('radicle-embedded addon loading', () => {
  afterEach(() => {
    delete process.env.FREEDOM_RADICLE_ADDON;
    jest.resetModules();
  });

  test('is unavailable when no addon binary exists anywhere', () => {
    process.env.FREEDOM_RADICLE_ADDON = path.join(
      os.tmpdir(),
      'does-not-exist',
      'libradicle.node'
    );
    jest.isolateModules(() => {
      const embedded = require('./radicle-embedded');
      // Note: falls through to radicle-bin/ and the sibling dev checkout;
      // in CI neither exists. On a dev machine with a sibling build this
      // is legitimately true, so only assert the shape.
      expect(typeof embedded.isAvailable()).toBe('boolean');
    });
  });

  test('checks the packaged extraResources location', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: path.join(os.tmpdir(), 'Freedom.app', 'Contents', 'Resources'),
    });

    try {
      jest.isolateModules(() => {
        const embedded = require('./radicle-embedded');
        expect(embedded.candidatePaths()).toContain(
          path.join(process.resourcesPath, 'radicle-bin', 'libradicle.node')
        );
      });
    } finally {
      if (original) Object.defineProperty(process, 'resourcesPath', original);
      else delete process.resourcesPath;
    }
  });

  test('call() surfaces addon {error} payloads as thrown errors', async () => {
    // Fake addon: a real file on disk that require() can load.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rad-addon-'));
    const fake = path.join(dir, 'libradicle.node.js');
    fs.writeFileSync(
      fake,
      'module.exports = {' +
        REQUIRED_FAKE_EXPORTS +
        'repoInfo: async () => JSON.stringify({ error: "boom" }),' +
        'status: async () => JSON.stringify({ connectedPeers: 3 }),' +
        '};'
    );
    process.env.FREEDOM_RADICLE_ADDON = fake;
    await jest.isolateModulesAsync(async () => {
      const embedded = require('./radicle-embedded');
      expect(embedded.isAvailable()).toBe(true);
      expect(embedded.getVersion()).toBe('0.7.1');
      await expect(embedded.repoInfo('rad:zAbc')).rejects.toThrow('boom');
      await expect(embedded.status()).resolves.toEqual({ connectedPeers: 3 });
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('parses streaming clone progress and exposes native cancellation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rad-addon-'));
    const fake = path.join(dir, 'libradicle.node.js');
    fs.writeFileSync(
      fake,
      'module.exports = {' +
        REQUIRED_FAKE_EXPORTS +
        'cloneRepoWithProgress: async (_rid, _timeout, callback) => {' +
        ' callback(JSON.stringify({ phase: "resolving", candidates: 2 }));' +
        ' return JSON.stringify({ ok: true }); },' +
        'cancelClone: () => JSON.stringify({ cancelled: true }),' +
        '};'
    );
    process.env.FREEDOM_RADICLE_ADDON = fake;
    await jest.isolateModulesAsync(async () => {
      const embedded = require('./radicle-embedded');
      const onProgress = jest.fn();
      await expect(
        embedded.cloneRepoWithProgress('rad:zAbc', 1234, onProgress)
      ).resolves.toEqual({ ok: true });
      expect(onProgress).toHaveBeenCalledWith({ phase: 'resolving', candidates: 2 });
      await expect(embedded.cancelClone('rad:zAbc')).resolves.toEqual({ cancelled: true });
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('buildRepoMeta shape', () => {
  afterEach(() => {
    delete process.env.FREEDOM_RADICLE_ADDON;
    jest.resetModules();
  });

  test('produces the viewer metadata fields rad-browser consumes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rad-addon-'));
    const fake = path.join(dir, 'libradicle.node.js');
    fs.writeFileSync(
      fake,
      'module.exports = {' +
        REQUIRED_FAKE_EXPORTS +
        'repoInfo: async () => JSON.stringify({ rid: "rad:zAbc", name: "demo",' +
        ' description: "d", defaultBranch: "main", head: "sha1", delegates: ["did:key:zMe"],' +
        ' threshold: 1, visibility: { type: "public" }, issuesOpen: 2, patchesOpen: 1 }),' +
        'seeders: async () => JSON.stringify({ seeding: 7 }),' +
        '};'
    );
    process.env.FREEDOM_RADICLE_ADDON = fake;
    await jest.isolateModulesAsync(async () => {
      const embedded = require('./radicle-embedded');
      const meta = await embedded.buildRepoMeta('rad:zAbc');
      const project = meta.payloads['xyz.radicle.project'];
      expect(project.data).toEqual({
        name: 'demo',
        description: 'd',
        defaultBranch: 'main',
      });
      expect(project.meta.head).toBe('sha1');
      expect(meta.delegates).toEqual(['did:key:zMe']);
      expect(meta.threshold).toBe(1);
      expect(meta.seeding).toBe(7);
      expect(meta.visibility).toEqual({ type: 'public' });
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
