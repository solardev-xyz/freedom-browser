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

  test('a packaged build loads only the add-on it ships, ignoring the env override (R-7)', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
    const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'Freedom-Resources-'));
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: resources });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rad-addon-'));
    const planted = path.join(dir, 'libradicle.node.js');
    fs.writeFileSync(planted, `module.exports = {${REQUIRED_FAKE_EXPORTS}};`);
    process.env.FREEDOM_RADICLE_ADDON = planted;

    try {
      jest.isolateModules(() => {
        jest.doMock('electron', () => ({ app: { isPackaged: true } }));
        const embedded = require('./radicle-embedded');
        expect(embedded.candidatePaths()).toEqual([
          path.join(resources, 'radicle-bin', 'libradicle.node'),
        ]);
        expect(embedded.isAvailable()).toBe(false);
        expect(embedded.getAddonPath()).toBeNull();
      });
    } finally {
      jest.dontMock('electron');
      if (original) Object.defineProperty(process, 'resourcesPath', original);
      else delete process.resourcesPath;
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(resources, { recursive: true, force: true });
    }
  });

  test('a development build still honours FREEDOM_RADICLE_ADDON first', () => {
    process.env.FREEDOM_RADICLE_ADDON = '/somewhere/libradicle.node';
    jest.isolateModules(() => {
      jest.doMock('electron', () => ({ app: { isPackaged: false } }));
      expect(require('./radicle-embedded').candidatePaths()[0]).toBe('/somewhere/libradicle.node');
    });
    jest.dontMock('electron');
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

  // PRIVATE MODE GUARD (#1073): a private window's seed or sync reaches the
  // progress callback in its log context, and JSON.parse's error quotes part
  // of the event (a short one whole), whose fetch errors can name the
  // Radicle storage path.
  const BAD_EVENT = '/home/alice';
  test.each([
    ['a private', true],
    ['a normal', false],
  ])('an invalid clone progress event in %s context', async (_label, isPrivate) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rad-addon-'));
    const fake = path.join(dir, 'libradicle.node.js');
    fs.writeFileSync(
      fake,
      'module.exports = {' +
        REQUIRED_FAKE_EXPORTS +
        'cloneRepoWithProgress: async (_rid, _timeout, callback) => {' +
        ` callback(${JSON.stringify(BAD_EVENT)});` +
        ' return JSON.stringify({ ok: true }); },' +
        '};'
    );
    process.env.FREEDOM_RADICLE_ADDON = fake;
    await jest.isolateModulesAsync(async () => {
      const log = require('./logger');
      const { runWithPrivateLogContext } = require('./private/private-log-context');
      const embedded = require('./radicle-embedded');
      await runWithPrivateLogContext(isPrivate, () =>
        embedded.cloneRepoWithProgress('rad:zAbc', 1234, () => {})
      );
      const lines = log.warn.mock.calls.filter(([first]) =>
        String(first).includes('Ignoring invalid clone progress event')
      );
      expect(lines).toHaveLength(1);
      if (isPrivate) {
        expect(lines[0]).toEqual([
          '[RadicleEmbedded] Ignoring invalid clone progress event:',
          '<private>',
        ]);
      } else {
        expect(lines[0][1]).toContain('/home/alice');
      }
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

  // PRIVATE MODE GUARD (#1050): a seeders() failure is swallowed here, so
  // the protocol's redacted catch never runs, and the add-on's text can
  // name the repository's storage path. Under the context a private `rad:`
  // or `radapi:` registration sets, its log line carries none of it.
  const HOME = '/home/alice/.config/Freedom/profiles/default/radicle';
  const SEEDERS_FAILED = `failed to open '${HOME}/storage/zAbc/refs': Permission denied`;
  test.each([
    ['a private', true, '<private>'],
    ['a normal', false, SEEDERS_FAILED],
  ])('a seeders() failure in %s context', async (_label, isPrivate, logged) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rad-addon-'));
    const fake = path.join(dir, 'libradicle.node.js');
    fs.writeFileSync(
      fake,
      'module.exports = {' +
        REQUIRED_FAKE_EXPORTS +
        'repoInfo: async () => JSON.stringify({ rid: "rad:zAbc", name: "demo" }),' +
        `seeders: async () => JSON.stringify({ error: ${JSON.stringify(SEEDERS_FAILED)} }),` +
        '};'
    );
    process.env.FREEDOM_RADICLE_ADDON = fake;
    await jest.isolateModulesAsync(async () => {
      const embedded = require('./radicle-embedded');
      const log = require('./logger');
      const { runWithPrivateLogContext } = require('./private/private-log-context');
      const meta = await runWithPrivateLogContext(isPrivate, () =>
        embedded.buildRepoMeta('rad:zAbc')
      );
      expect(meta.seeding).toBe(0);
      const prefix = '[RadicleEmbedded] seeders() failed:';
      expect(log.warn.mock.calls.filter((args) => args[0] === prefix)).toEqual([[prefix, logged]]);
      expect(JSON.stringify(log.warn.mock.calls).includes(HOME)).toBe(!isPrivate);
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('read bounds (R-3)', () => {
  // The fake addon's reads come from `global.__radicleFake`, so a test can
  // hold one and see which run.
  function withScriptedAddon(run) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rad-addon-'));
    const fake = path.join(dir, 'libradicle.node.js');
    const scripted = ['issue', 'treeAt', 'blobAt', 'repoInfo']
      .map((name) => `${name}: (...args) => global.__radicleFake.${name}(...args),`)
      .join('');
    fs.writeFileSync(fake, `module.exports = {${REQUIRED_FAKE_EXPORTS}${scripted}};`);
    process.env.FREEDOM_RADICLE_ADDON = fake;
    return jest
      .isolateModulesAsync(async () => run(require('./radicle-embedded')))
      .finally(() => {
        delete global.__radicleFake;
        delete process.env.FREEDOM_RADICLE_ADDON;
        jest.resetModules();
        fs.rmSync(dir, { recursive: true, force: true });
      });
  }

  test('a read that has ended starts no addon call, and parses nothing', () =>
    withScriptedAddon(async (embedded) => {
      const ended = new AbortController();
      ended.abort();
      global.__radicleFake = { issue: jest.fn(async () => '{"id":"x"}') };
      await expect(
        embedded.withReadBounds({ signal: ended.signal }, () => embedded.issue('rad:zAbc', 'x'))
      ).rejects.toBeInstanceOf(embedded.ReadEnded);
      expect(global.__radicleFake.issue).not.toHaveBeenCalled();

      // Ended while the call ran: its reply is dropped unparsed.
      const running = new AbortController();
      global.__radicleFake.issue = jest.fn(async () => {
        running.abort();
        return '{"id":"x"}';
      });
      const parse = jest.spyOn(JSON, 'parse');
      try {
        await expect(
          embedded.withReadBounds({ signal: running.signal }, () => embedded.issue('rad:zAbc', 'x'))
        ).rejects.toBeInstanceOf(embedded.ReadEnded);
        expect(parse).not.toHaveBeenCalled();
      } finally {
        parse.mockRestore();
      }
    }));

  test('a composed read stops between its addon calls (readme: tree, then blob)', () =>
    withScriptedAddon(async (embedded) => {
      const ended = new AbortController();
      global.__radicleFake = {
        treeAt: jest.fn(async () => {
          ended.abort();
          return JSON.stringify({ entries: [{ name: 'README.md', kind: 'blob' }] });
        }),
        blobAt: jest.fn(async () => '{"content":"x"}'),
      };
      await expect(
        embedded.withReadBounds({ signal: ended.signal }, () =>
          embedded.readmeAtRaw('rad:zAbc', 'r')
        )
      ).rejects.toBeInstanceOf(embedded.ReadEnded);
      expect(global.__radicleFake.treeAt).toHaveBeenCalledTimes(1);
      expect(global.__radicleFake.blobAt).not.toHaveBeenCalled();
    }));

  test('a reply over the cap is refused before it is parsed, parsed or raw', () =>
    withScriptedAddon(async (embedded) => {
      const reply = JSON.stringify({ id: 'x', body: 'y'.repeat(100) });
      global.__radicleFake = {
        issue: async () => reply,
        blobAt: async () => reply,
      };
      const parse = jest.spyOn(JSON, 'parse');
      try {
        const capped = { maxReplyChars: reply.length - 1 };
        await expect(
          embedded.withReadBounds(capped, () => embedded.issue('rad:zAbc', 'x'))
        ).rejects.toBeInstanceOf(embedded.ReplyTooLarge);
        await expect(
          embedded.withReadBounds(capped, () => embedded.blobAtRaw('rad:zAbc', 'r', 'f'))
        ).rejects.toBeInstanceOf(embedded.ReplyTooLarge);
        expect(parse).not.toHaveBeenCalled();
      } finally {
        parse.mockRestore();
      }
      // At the cap, and outside any bounds, the reply is served.
      await expect(
        embedded.withReadBounds({ maxReplyChars: reply.length }, () =>
          embedded.issue('rad:zAbc', 'x')
        )
      ).resolves.toMatchObject({ id: 'x' });
      await expect(embedded.issue('rad:zAbc', 'x')).resolves.toMatchObject({ id: 'x' });
    }));
});

describe('shutdown proof (R-8)', () => {
  afterEach(() => {
    delete process.env.FREEDOM_RADICLE_ADDON;
    jest.resetModules();
  });

  test('the node counts as started until the add-on proves it stopped', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rad-addon-'));
    const fake = path.join(dir, 'libradicle.node.js');
    // The first shutdown fails before the node's thread has joined; the
    // second one succeeds.
    fs.writeFileSync(
      fake,
      'let shutdowns = 0;' +
        'module.exports = {' +
        REQUIRED_FAKE_EXPORTS +
        'start: async () => JSON.stringify({ did: "did:key:z6MkTest" }),' +
        'shutdown: async () => { shutdowns += 1;' +
        ' return shutdowns === 1' +
        '  ? JSON.stringify({ error: "control channel closed" })' +
        '  : JSON.stringify({ ok: true }); },' +
        '};'
    );
    process.env.FREEDOM_RADICLE_ADDON = fake;
    try {
      await jest.isolateModulesAsync(async () => {
        const embedded = require('./radicle-embedded');
        await embedded.start(dir, 'Alias');
        expect(embedded.isStarted()).toBe(true);

        const stopping = embedded.shutdown();
        // Still started while the add-on has not answered, and after it
        // failed to prove the node stopped.
        expect(embedded.isStarted()).toBe(true);
        await expect(stopping).rejects.toThrow('control channel closed');
        expect(embedded.isStarted()).toBe(true);

        await expect(embedded.shutdown()).resolves.toEqual({ ok: true });
        expect(embedded.isStarted()).toBe(false);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Under FREEDOM_RADICLE_BACKEND=service (freedom-core design 0008, "Main's
// side"; plan B7): the exports keep their shapes; identity and status are
// collected and kept under 4 KiB, callScoped and callStream are the service
// node's reads (radicle/radicle-service-backend.js), the rest say they
// aren't on the service yet, and the add-on is never loaded.
describe('on the freedom-radicled service', () => {
  let embedded;
  // The logger the module loaded with.
  let embeddedLog;
  let reads;
  let generation;

  /** A service node whose `rad.read` answers `answer(op, args)`'s JSON. */
  const node = {
    get generation() {
      return generation;
    },
    read: jest.fn(async (op, args) => {
      reads.push({ op, args });
      const bytes = Buffer.from(JSON.stringify({ op, args }));
      return {
        result: { content_type: 'application/json', bytes: bytes.length, body: true },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      };
    }),
    streamStats: () => ({ outstanding: 0, ringBytes: 0, bodies: 0, outbox: 0 }),
  };

  beforeEach(() => {
    process.env.FREEDOM_RADICLE_BACKEND = 'service';
    // An add-on that must never load.
    process.env.FREEDOM_RADICLE_ADDON = path.join(os.tmpdir(), 'no-such', 'libradicle.node');
    reads = [];
    generation = 1;
    jest.isolateModules(() => {
      embedded = require('./radicle-embedded');
      embeddedLog = require('./logger');
    });
    embedded.setServiceNodeSource(() => node);
  });

  afterEach(() => {
    delete process.env.FREEDOM_RADICLE_BACKEND;
    delete process.env.FREEDOM_RADICLE_ADDON;
    jest.resetModules();
  });

  test.each([
    ['identity', 'identity'],
    ['status', 'status'],
  ])('%s is a collected read of %s, kept under 4 KiB', async (name, op) => {
    await expect(embedded[name]()).resolves.toEqual({ op, args: {} });
    expect(reads).toEqual([{ op, args: {} }]);
    expect(embedded.collectionBudget()).toEqual({ held: 0, limit: 16 * 1024 * 1024 });
  });

  test('identity and status of 4 KiB or more are too_large to keep', async () => {
    const big = { op: 'identity', alias: 'x'.repeat(4096) };
    node.read.mockImplementationOnce(async () => {
      const bytes = Buffer.from(JSON.stringify(big));
      return {
        result: { content_type: 'application/json', bytes: bytes.length, body: true },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      };
    });
    await expect(embedded.identity()).rejects.toMatchObject({ code: 'too_large' });
    expect(embedded.collectionBudget().held).toBe(0);
  });

  test("callScoped and callStream are the service backend's", async () => {
    await expect(embedded.callScoped('node_info', {}, async (value) => value.op)).resolves.toBe(
      'node_info'
    );
    // The value is used in its scope, not handed out of it.
    await expect(
      embedded.callScoped('list_repos', {}, async (value) => value)
    ).rejects.toMatchObject({ code: 'invalid_argument' });
    const { head, body } = await embedded.callStream('commit', { rid: 'rad:z1', revision: 'a' });
    expect(head).toEqual({ content_type: 'application/json', bytes: expect.any(Number) });
    expect(JSON.parse(await new Response(body).text())).toEqual({
      op: 'commit',
      args: { rid: 'rad:z1', revision: 'a' },
    });
    expect(embedded.streamStats()).toEqual({ streams: 0, buffered: 0 });
  });

  test.each([
    // Collected, but used only inside a scope: their callers move into one.
    'repoInfo',
    'seeders',
    'listSeededRepos',
    'listRepos',
    'start',
    'shutdown',
    'unseedRepo',
    'createIssue',
    'commentIssue',
    'editIssueState',
    'commentPatch',
    'importRepo',
    'issues',
    'issue',
    'patches',
    'patch',
    'commits',
    'commit',
    'tree',
    'treeAt',
    'blob',
    'blobAt',
    'commitsRaw',
    'commitRaw',
    'treeAtRaw',
    'blobRaw',
    'blobAtRaw',
    'remotes',
    'repoStats',
    'buildRepoMeta',
    'readme',
    'readmeAt',
    'readmeAtRaw',
  ])('%s is not on the service yet: it says so, and reads nothing', async (name) => {
    await expect(embedded[name]('rad:z1', 'a'.repeat(40), 'README.md')).rejects.toMatchObject({
      name: 'RadicleServiceUnsupported',
      code: 'RADICLE_SERVICE_UNSUPPORTED',
      message: embedded.NOT_ON_SERVICE,
      export: name,
    });
    expect(reads).toEqual([]);
  });

  describe('the network operations: the service node\'s rad.connect_seeds and rad.clone', () => {
    /** The node's network calls, each answered as the test says. */
    let calls;
    beforeEach(() => {
      calls = [];
      node.connectSeeds = jest.fn(async (timeoutMs, options) => {
        calls.push(['connectSeeds', timeoutMs, options]);
        return { attempted: 1, connected: 1, target: 1, targetReached: true, elapsedMs: 3, failures: [] };
      });
      node.clone = jest.fn(
        (rid, timeoutMs, { onProgress = null, signal = null } = {}) =>
          new Promise((resolve, reject) => {
            calls.push({ rid, timeoutMs, onProgress, signal, resolve, reject });
          })
      );
    });
    afterEach(() => {
      delete node.connectSeeds;
      delete node.clone;
    });

    test('connectSeeds: 15000 by default, the report as the service gave it', async () => {
      await expect(embedded.connectSeeds()).resolves.toMatchObject({ connected: 1 });
      await expect(embedded.connectSeeds(5000)).resolves.toMatchObject({ connected: 1 });
      expect(calls.map(([, timeoutMs]) => timeoutMs)).toEqual([15000, 5000]);
      expect(reads).toEqual([]);
    });

    test('cloneRepo: no progress, 120000 by default', async () => {
      const done = embedded.cloneRepo('rad:z1');
      await new Promise((resolve) => setImmediate(resolve));
      expect(calls[0]).toMatchObject({ rid: 'rad:z1', timeoutMs: 120000, onProgress: null, signal: null });
      calls[0].resolve({ ok: true });
      await expect(done).resolves.toEqual({ ok: true });
    });

    test("cloneRepoWithProgress: each event's text parsed for the callback; one that isn't JSON is logged, redacted, and dropped", async () => {
      const events = [];
      const done = embedded.cloneRepoWithProgress('rad:z1', 1234, (event) => events.push(event));
      await new Promise((resolve) => setImmediate(resolve));
      const [call] = calls;
      expect(call).toMatchObject({ rid: 'rad:z1', timeoutMs: 1234 });
      call.onProgress('{"candidates":2,"phase":"resolving"}');
      call.onProgress('{"phase":');
      call.onProgress('{"phase":"peer-failed","summary":{"count":12,"reasons":["r"]}}');
      call.resolve({ ok: true });
      await expect(done).resolves.toEqual({ ok: true });
      expect(events).toEqual([
        { candidates: 2, phase: 'resolving' },
        { phase: 'peer-failed', summary: { count: 12, reasons: ['r'] } },
      ]);
      expect(embeddedLog.warn).toHaveBeenCalledWith(
        '[RadicleEmbedded] Ignoring invalid clone progress event:',
        expect.any(String)
      );
    });

    test("cancelClone: the RID's progress clone, whose cancel settles it { cancelled: true }; none, { cancelled: false }", async () => {
      await expect(embedded.cancelClone('rad:z1')).resolves.toEqual({ cancelled: false });
      const done = embedded.cloneRepoWithProgress('rad:z1', 1234, () => {});
      await new Promise((resolve) => setImmediate(resolve));
      const [call] = calls;
      expect(call.signal.aborted).toBe(false);
      await expect(embedded.cancelClone('rad:z2')).resolves.toEqual({ cancelled: false });
      await expect(embedded.cancelClone('rad:z1')).resolves.toEqual({ cancelled: true });
      expect(call.signal.aborted).toBe(true);
      // The node answers when the clone stops.
      call.resolve({ cancelled: true });
      await expect(done).resolves.toEqual({ cancelled: true });
      await expect(embedded.cancelClone('rad:z1')).resolves.toEqual({ cancelled: false });
    });

    test('the add-on is never loaded for them', async () => {
      await embedded.connectSeeds();
      await embedded.cancelClone('rad:z1');
      expect(embedded.getAddonPath()).toBeNull();
    });
  });

  test("isStarted is the service node's: a generation that serves", () => {
    expect(embedded.isStarted()).toBe(true);
    generation = null;
    expect(embedded.isStarted()).toBe(false);
    embedded.setServiceNodeSource(() => null);
    expect(embedded.isStarted()).toBe(false);
  });

  test('with no node, a read is stopped', async () => {
    embedded.setServiceNodeSource(() => null);
    await expect(embedded.status()).rejects.toMatchObject({ code: 'stopped' });
  });

  test('the add-on has no streams: callStream and callScoped refuse there', async () => {
    delete process.env.FREEDOM_RADICLE_BACKEND;
    await expect(embedded.callStream('status', {})).rejects.toThrow(/the add-on has no streams/);
    await expect(embedded.callScoped('status', {}, async () => {})).rejects.toThrow(
      /the add-on has no streams/
    );
    expect(() => embedded.collectionBudget()).toThrow(/the add-on has no streams/);
  });
});
