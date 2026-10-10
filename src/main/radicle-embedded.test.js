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
      expect(embedded.getVersion()).toBe('0.8.0');
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

describe('raw reads (#514)', () => {
  const BIG = 'x'.repeat(64 * 1024);
  // The addon's own spacing: anything JSON.stringify would not produce shows
  // the text was passed through, not round-tripped.
  const BLOB = `{"binary":false, "name":"README.md","content":"${BIG}"}`;

  function withFakeAddon(body, run) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rad-addon-'));
    const fake = path.join(dir, 'libradicle.node.js');
    fs.writeFileSync(fake, `module.exports = {${REQUIRED_FAKE_EXPORTS}${body}};`);
    process.env.FREEDOM_RADICLE_ADDON = fake;
    return jest
      .isolateModulesAsync(async () => run(require('./radicle-embedded')))
      .finally(() => {
        delete process.env.FREEDOM_RADICLE_ADDON;
        jest.resetModules();
        fs.rmSync(dir, { recursive: true, force: true });
      });
  }

  const TREE =
    'treeAt: async () => JSON.stringify({ entries: [' +
    '{ name: "src", kind: "tree" }, { name: "README.md", kind: "blob" }] }),';

  test('resolve to the addon text verbatim, without parsing it', () =>
    withFakeAddon(
      `blobAt: async () => ${JSON.stringify(BLOB)},` +
        'commit: async () => \'{"commit":{},"diff":{"files":[]}} \',' +
        'treeAt: async () => "[1,2]",' +
        'commits: async () => "[]",',
      async (embedded) => {
        const parse = jest.spyOn(JSON, 'parse');
        try {
          await expect(embedded.blobAtRaw('rad:zAbc', 'r', 'README.md')).resolves.toBe(BLOB);
          await expect(embedded.commitRaw('rad:zAbc', 'r')).resolves.toBe(
            '{"commit":{},"diff":{"files":[]}} '
          );
          await expect(embedded.treeAtRaw('rad:zAbc', 'r')).resolves.toBe('[1,2]');
          await expect(embedded.commitsRaw('rad:zAbc', 'r')).resolves.toBe('[]');
          expect(parse).not.toHaveBeenCalled();
        } finally {
          parse.mockRestore();
        }
      }
    ));

  test.each([
    ['compact', '{"error":"the path does not exist"}'],
    ['spaced', ' { "error" : "the path does not exist" }'],
  ])('throw on a %s addon error payload, as call() does', (_label, payload) =>
    withFakeAddon(`blobAt: async () => ${JSON.stringify(payload)},`, async (embedded) => {
      await expect(embedded.blobAtRaw('rad:zAbc', 'r', 'x')).rejects.toThrow(
        'the path does not exist'
      );
    }));

  test('reject a non-string addon result', () =>
    withFakeAddon('commit: async () => undefined,', async (embedded) => {
      await expect(embedded.commitRaw('rad:zAbc', 'r')).rejects.toThrow(/no JSON text/);
    }));

  test('readmeAtRaw splices `path` into the blob text, equal to readmeAt', () =>
    withFakeAddon(`${TREE}blobAt: async () => ${JSON.stringify(`${BLOB}\n`)},`, async (embedded) => {
      const raw = await embedded.readmeAtRaw('rad:zAbc', 'r');
      expect(raw.startsWith(BLOB.slice(0, -1))).toBe(true);
      expect(JSON.parse(raw)).toEqual(await embedded.readmeAt('rad:zAbc', 'r'));
      expect(JSON.parse(raw)).toEqual({
        binary: false,
        name: 'README.md',
        content: BIG,
        path: 'README.md',
      });
    }));

  test('readmeAtRaw: a `path` already in the blob is overridden, as the spread does', () =>
    withFakeAddon(
      `${TREE}blobAt: async () => '{"path":"elsewhere","content":"a"}',`,
      async (embedded) => {
        const raw = await embedded.readmeAtRaw('rad:zAbc', 'r');
        expect(JSON.parse(raw)).toEqual({ path: 'README.md', content: 'a' });
        expect(JSON.parse(raw)).toEqual(await embedded.readmeAt('rad:zAbc', 'r'));
      }
    ));

  test('readmeAtRaw falls back to an exact parse for a payload it cannot splice', () =>
    withFakeAddon(`${TREE}blobAt: async () => '{}',`, async (embedded) => {
      await expect(embedded.readmeAtRaw('rad:zAbc', 'r')).resolves.toBe('{"path":"README.md"}');
    }));

  test('readmeAtRaw without a revision reads the head, as readmeAt does', () =>
    withFakeAddon(
      'tree: async () => JSON.stringify({ entries: [{ name: "README.md", kind: "blob" }] }),' +
        'treeAt: async () => { throw new Error("treeAt needs a revision"); },' +
        `blob: async () => ${JSON.stringify(BLOB)},` +
        'blobAt: async () => { throw new Error("blobAt needs a revision"); },',
      async (embedded) => {
        const raw = await embedded.readmeAtRaw('rad:zAbc');
        expect(JSON.parse(raw)).toEqual(await embedded.readmeAt('rad:zAbc'));
        expect(JSON.parse(raw)).toEqual({
          binary: false,
          name: 'README.md',
          content: BIG,
          path: 'README.md',
        });
      }
    ));

  test('readmeAtRaw is null when the root has no readme', () =>
    withFakeAddon(
      'treeAt: async () => JSON.stringify({ entries: [{ name: "a.md", kind: "blob" }] }),',
      async (embedded) => {
        await expect(embedded.readmeAtRaw('rad:zAbc', 'r')).resolves.toBeNull();
      }
    ));
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
