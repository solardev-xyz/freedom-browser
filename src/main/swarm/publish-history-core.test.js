/**
 * publish-history.js on the core's history (freedom-core design 0015,
 * "Methods main calls": `swarm.history`, with core PR K1's `add` and
 * `update`; D3, D7 and D10; the SWM-6 to SWM-9 plan's PR 6.4), against the
 * simulated core (test/helpers/simulated-swarm-stores-core.js), through
 * main's real client (core/swarm-stores.js). The hello naming
 * `swarm_stores` is the test's choice (core-client.js `swarmStoresNamed`,
 * mocked); no build names it before PR 7.4.
 * publish-history.integration.test.js plays the same cases on the real
 * core.
 *
 * - publish-history.test.js's cases (test/helpers/publish-history-cases.js):
 *   each answer of main's equals the reference's
 *   (test/helpers/reference-publish-history.js, on a root of its own) for
 *   the same sequence, the core asked the op the channel or function names,
 *   as `chrome` or `shell`, and the history's rows and the legacy files end
 *   the same.
 * - A spy on `fs` and on better-sqlite3's opens: main's publish-history.js
 *   opens no publish-history file, and never the legacy
 *   publish-history.json (D10 is the core's); the simulated core's
 *   reference, in this process, does.
 * - Every function that opens the database throws unrun, the JS provider's
 *   direct calls among them; with the move off, everything is main's own
 *   and the core is never asked.
 * - publish-service.js's freedom://publish handlers and the agent's
 *   publication controller write their rows through the core's `add` and
 *   `update`, as `shell`: the agent's (`freedom://agent`) before the upload
 *   and updated after it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// The handlers go to `mockIpc.handlers`: main's and the reference's apart.
const mockIpc = { handlers: {} };
jest.mock('electron', () => ({
  app: { getPath: jest.fn() },
  ipcMain: {
    handle: (channel, handler) => {
      mockIpc.handlers[channel] = handler;
    },
    removeHandler: () => {},
  },
  dialog: { showOpenDialog: (...args) => mockDialog.showOpenDialog(...args) },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
}));
const mockDialog = { showOpenDialog: jest.fn() };
jest.mock('electron-log', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

// better-sqlite3's opens, each with the stack that made it: main's and the
// simulated core's reference apart.
const mockOpens = [];
jest.mock('better-sqlite3', () => {
  const Real = jest.requireActual('better-sqlite3');
  function SpiedDatabase(file, options) {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 64;
    const { stack } = new Error();
    Error.stackTraceLimit = limit;
    mockOpens.push({ file: String(file), stack });
    return new Real(file, options);
  }
  return SpiedDatabase;
});

// The test chooses the hello (`swarm_stores` named or not) and the core.
const mockMove = { named: false, client: null };
jest.mock('../core/core-client', () => ({
  ...jest.requireActual('../core/core-client'),
  swarmStoresNamed: () => mockMove.named,
}));
jest.mock('../core/core-process', () => ({ getCoreClient: () => mockMove.client }));

// publish-service.js's node: the upload `mockUpload` answers.
const mockUpload = jest.fn();
jest.mock('./swarm-service', () => ({
  getBee: () => ({ file: { upload: (...args) => mockUpload(...args) } }),
  selectBestBatch: async () => 'b1'.repeat(32),
  toHex: (value) => (typeof value === 'string' ? value : value?.toHex?.()),
}));
jest.mock('./page-upload', () => ({}));

const { app } = require('electron');
const history = require('./publish-history');
const { simulatedSwarmStores } = require('../../../test/helpers/simulated-swarm-stores-core');
const {
  PUBLISH_HISTORY_CASES,
  MAIN_FNS,
  HISTORY_FILE,
  askedOf,
  legacyFiles,
  playPublishHistoryCase,
  seedLegacy,
} = require('../../../test/helpers/publish-history-cases');

const MAIN_HISTORY = path.join('src', 'main', 'swarm', 'publish-history.js');
const SPIED = [
  'existsSync',
  'readFileSync',
  'writeFileSync',
  'renameSync',
  'copyFileSync',
  'openSync',
  'statSync',
  'unlinkSync',
  'rmSync',
  'appendFileSync',
  'createReadStream',
  'createWriteStream',
];

const sim = simulatedSwarmStores();
const referenceHistory = sim.references().history;
const mainHandlers = {};
const referenceHandlers = {};
mockIpc.handlers = mainHandlers;
history.registerPublishHistoryIpc();
mockIpc.handlers = referenceHandlers;
referenceHistory.registerPublishHistoryIpc();
mockIpc.handlers = {};

// What main sent the core, each request.
const sent = [];

const dirs = [];
function tempDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pubhist-core-${name}-`));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  sim.restart();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  mockMove.named = true;
  sent.length = 0;
  mockMove.client = {
    request: (...args) => {
      sent.push(args);
      return sim.request(...args);
    },
  };
  sim.calls.length = 0;
  sim.unnormalized.length = 0;
  sim.fail = null;
  mockOpens.length = 0;
  // A new world: the core's history opens again, on the test's root.
  sim.restart();
  history.closeDb();
  app.getPath.mockReturnValue(tempDir('root'));
});

afterEach(() => {
  mockMove.named = false;
  mockMove.client = null;
});

/** The first frame of `stack` outside this file, node and node_modules. */
function callerOf(stack) {
  return stack
    .split('\n')
    .slice(1)
    .find(
      (line) =>
        !line.includes(__filename) && !line.includes('node:') && !line.includes('node_modules')
    );
}

/**
 * Spies on `fs` for any touch of a publish-history file (the database, its
 * `-wal` and `-shm`, the legacy file and its `.migrated`), and reads
 * better-sqlite3's opens: `fromMain()` lists those main's
 * publish-history.js made itself (the frame that called `fs` or opened the
 * database), `all()` every one, `restore()` removes the spies. The
 * simulated core's reference, in this process, opens the database and
 * imports the legacy file itself, called from main's request; only main's
 * own frames count.
 */
function spyMainHistory() {
  const hits = [];
  const opensBefore = mockOpens.length;
  const spies = SPIED.map((name) => {
    const original = fs[name];
    return jest.spyOn(fs, name).mockImplementation(function (...args) {
      if (args.some((arg) => typeof arg === 'string' && arg.includes('publish-history'))) {
        const limit = Error.stackTraceLimit;
        Error.stackTraceLimit = 64;
        const { stack } = new Error();
        Error.stackTraceLimit = limit;
        hits.push({ name, target: args[0], from: callerOf(stack) || '' });
      }
      return original.apply(this, args);
    });
  });
  const opens = () =>
    mockOpens
      .slice(opensBefore)
      .filter(({ file }) => file.includes('publish-history'))
      .map(({ file, stack }) => ({ name: 'better-sqlite3', target: file, from: callerOf(stack) || '' }));
  const all = () => [...hits, ...opens()];
  return {
    all,
    fromMain: () =>
      all()
        .filter(({ from }) => from.includes(MAIN_HISTORY))
        .map(({ name, target }) => [name, target]),
    restore: () => spies.forEach((spy) => spy.mockRestore()),
  };
}

/** Main, its hello naming `swarm_stores`: its handlers and `coreOps`. */
const mainSide = {
  chrome: (channel) => mainHandlers[channel]({}),
  main: (fn, args) => history.coreOps[fn](...args),
};

/** The reference, today's main on its own database: its handlers and functions. */
const referenceSide = {
  chrome: (channel) => referenceHandlers[channel]({}),
  main: (fn, args) => referenceHistory[fn](...args),
};

/** The rows of `dir`'s publish-history.sqlite, by id, each time a clock made `'now'`. */
function readRows(dir) {
  const file = path.join(dir, HISTORY_FILE);
  if (!fs.existsSync(file)) return null;
  const Real = jest.requireActual('better-sqlite3');
  const db = new Real(file, { readonly: true });
  try {
    const since = Date.now() - 60_000;
    return db
      .prepare('SELECT * FROM publishes ORDER BY id')
      .all()
      .map((row) => ({
        ...row,
        started_at: row.started_at >= since ? 'now' : row.started_at,
        completed_at:
          typeof row.completed_at === 'number' && row.completed_at >= since
            ? 'now'
            : row.completed_at,
      }));
  } finally {
    db.close();
  }
}

describe("publish-history.js's cases on the simulated core", () => {
  test.each(PUBLISH_HISTORY_CASES.map((kase) => [kase.name, kase]))(
    '%s',
    async (_name, kase) => {
      const coreDir = tempDir('core');
      const referenceDir = tempDir('reference');
      seedLegacy(kase, coreDir);
      seedLegacy(kase, referenceDir);
      app.getPath.mockReturnValue(coreDir);

      const spy = spyMainHistory();
      let fromMain;
      let coreTouches;
      let coreFiles;
      let played;
      try {
        played = await playPublishHistoryCase(kase, {
          main: mainSide,
          reference: referenceSide,
          between: () => {
            fromMain = spy.fromMain();
            coreTouches = spy.all().length;
            // The core's history closes, as the core's own would stop.
            referenceHistory.closeDb();
            coreFiles = legacyFiles(coreDir);
            // The reference's run: the module on its own root, the move off.
            mockMove.named = false;
            app.getPath.mockReturnValue(referenceDir);
          },
        });
      } finally {
        spy.restore();
        referenceHistory.closeDb();
      }

      // Each answer is the reference's, step by step.
      expect(played.map(({ step, main }) => [step, main])).toEqual(
        played.map(({ step, reference }) => [step, reference])
      );
      // Main opened, read and wrote no publish-history file in its run, and
      // left the legacy file to the core; the core's history did both.
      expect(fromMain).toEqual([]);
      expect(coreTouches).toBeGreaterThan(0);
      // The core was asked each op once, as the caller main relays it for,
      // each site by its permission key.
      expect(sim.calls).toEqual(kase.steps.map(askedOf));
      expect(sim.unnormalized).toEqual([]);
      // The rows and the legacy files end as the reference's.
      expect(coreFiles).toEqual(legacyFiles(referenceDir));
      expect(readRows(coreDir)).toEqual(readRows(referenceDir));
    }
  );

  test('the cases cover every op main relays or sends', () => {
    const asked = new Set(PUBLISH_HISTORY_CASES.flatMap((kase) => kase.steps.map(askedOf)).map(String));
    const expected = [
      ['swarm.history', 'list', 'chrome'],
      ['swarm.history', 'clear', 'chrome'],
      ...Object.values(MAIN_FNS).map((op) => ['swarm.history', op, 'shell']),
    ].map(String);
    expect([...asked].sort()).toEqual([...expected].sort());
  });
});

describe("on the core's history, main never opens it", () => {
  test('every function that opens the database throws, unrun, and the core is not asked', () => {
    const spy = spyMainHistory();
    try {
      for (const run of [
        () => history.getDb(),
        () => history.addEntry({ type: 'data', origin: 'https://app.example' }),
        () => history.updateEntry(1, { status: 'completed' }),
        () => history.getEntries(),
        () => history.clearEntries(),
        () => history.removeEntry(1),
      ]) {
        expect(run).toThrow("publish-history.sqlite is the identity core's: main doesn't open it");
      }
      expect(spy.all()).toEqual([]);
    } finally {
      spy.restore();
    }
    expect(sent).toEqual([]);
    // closeDb has nothing to close.
    expect(() => history.closeDb()).not.toThrow();
  });

  test("a site goes to the core as its permission key; main's own origins are their own", async () => {
    await history.coreOps.addEntry({ type: 'data', origin: 'HTTPS://App.Example/path?q=1' });
    await history.coreOps.addEntry({ type: 'data', origin: 'freedom://publish' });
    await history.coreOps.addEntry({ type: 'data', origin: 'freedom://agent' });
    await history.coreOps.addEntry({ type: 'data' });
    const origins = (await history.coreOps.getEntries()).map((row) => row.origin);
    expect(origins.sort()).toEqual(
      ['https://app.example', 'freedom://publish', 'freedom://agent', null].sort()
    );
    expect(sim.unnormalized).toEqual([]);
    // Sent as it was given, the core would have stored it verbatim.
    await sim.stores.history('add', { entry: { origin: 'HTTPS://App.Example/path' } });
    expect(sim.unnormalized).toEqual([
      ['swarm.history', 'add', 'entry.origin', 'HTTPS://App.Example/path'],
    ]);
    // Each request went as `shell`, with swarm_stores required.
    for (const [method, , context, options] of sent) {
      expect(method).toBe('swarm.history');
      expect(context).toEqual({ caller: 'shell' });
      expect(options.requires({ store_moved: ['swarm_stores'] })).toBe(true);
      expect(options.requires({ store_moved: [] })).toBe(false);
    }
  });

  test("the chrome's handlers wrap a failing core's error, as a failing database's", async () => {
    sim.fail = () => {
      const err = new Error('the store is unavailable');
      err.code = 'storage';
      throw err;
    };
    const log = require('../logger');
    log.error.mockClear();
    expect(await mainHandlers['swarm:get-publish-history']({})).toEqual({
      success: false,
      error: 'the store is unavailable',
    });
    expect(await mainHandlers['swarm:clear-publish-history']({})).toEqual({
      success: false,
      error: 'the store is unavailable',
    });
    expect(log.error.mock.calls.map(([text]) => text)).toEqual([
      '[PublishHistory] Failed to get history:',
      '[PublishHistory] Failed to clear history:',
    ]);
    // Without a running core: core_unavailable, wrapped the same way.
    mockMove.client = null;
    expect(await mainHandlers['swarm:get-publish-history']({})).toEqual({
      success: false,
      error: 'The identity core is not running',
    });
  });

  test("with the move off, everything is main's own and the core is never asked", async () => {
    mockMove.named = false;
    const spy = spyMainHistory();
    try {
      const row = history.addEntry({ type: 'data', name: 'local', origin: 'freedom://publish' });
      expect(history.updateEntry(row.id, { status: 'completed' })).toMatchObject({
        id: row.id,
        status: 'completed',
      });
      expect(await mainHandlers['swarm:get-publish-history']({})).toEqual({
        success: true,
        entries: history.getEntries(),
      });
      expect(await mainHandlers['swarm:clear-publish-history']({})).toEqual({ success: true });
      expect(history.getEntries()).toEqual([]);
      // Main opened its own database.
      expect(spy.fromMain()).toContainEqual([
        'better-sqlite3',
        path.join(app.getPath(), HISTORY_FILE),
      ]);
    } finally {
      spy.restore();
    }
    expect(sent).toEqual([]);
    expect(sim.calls).toEqual([]);
  });
});

describe("main's own rows through the core's add and update", () => {
  // A stand-in webContents: the pick tokens are bound to sender.id.
  const sender = { id: 41, once: () => {} };

  const loadPublishService = () => {
    mockIpc.handlers = {};
    const service = require('./publish-service');
    service.registerPublishIpc();
    const handlers = mockIpc.handlers;
    mockIpc.handlers = {};
    return { service, handlers };
  };

  test("freedom://publish's handlers: a row before each upload, completed or failed after it", async () => {
    const { handlers, service } = loadPublishService();
    const reference = 'ab'.repeat(32);
    const spy = spyMainHistory();
    let published;
    let failed;
    let picked;
    let rowAtUpload = null;
    try {
      mockUpload.mockImplementationOnce(async () => {
        // The row is the core's before the upload goes.
        rowAtUpload = await sim.stores.history('list');
        return { reference, tagUid: 9 };
      });
      published = await handlers['swarm:publish-data']({ sender }, 'hello');
      mockUpload.mockRejectedValueOnce(new Error('node unreachable'));
      failed = await handlers['swarm:publish-data']({ sender }, 'again');

      const file = path.join(tempDir('picked'), 'notes.txt');
      fs.writeFileSync(file, 'notes');
      mockDialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [file] });
      const { token } = await handlers['swarm:pick-file']({ sender });
      mockUpload.mockResolvedValueOnce({ reference, tagUid: 10 });
      picked = await handlers['swarm:publish-file']({ sender }, token);
    } finally {
      spy.restore();
    }

    expect(published).toEqual({
      success: true,
      reference,
      bzzUrl: `bzz://${reference}`,
      tagUid: 9,
    });
    expect(failed).toEqual({ success: false, error: 'node unreachable' });
    expect(picked).toMatchObject({ success: true, reference, tagUid: 10 });
    expect(rowAtUpload).toEqual([
      expect.objectContaining({
        id: 1,
        type: 'data',
        name: 'Text',
        status: 'uploading',
        origin: service.USER_ORIGIN,
      }),
    ]);
    expect(sim.calls).toEqual([
      ['swarm.history', 'add', 'shell'],
      ['swarm.history', 'list', 'shell'],
      ['swarm.history', 'update', 'shell'],
      ['swarm.history', 'add', 'shell'],
      ['swarm.history', 'update', 'shell'],
      ['swarm.history', 'add', 'shell'],
      ['swarm.history', 'update', 'shell'],
    ]);
    const rows = await sim.stores.history('list');
    expect(rows).toEqual([
      expect.objectContaining({
        id: 3,
        type: 'file',
        name: 'notes.txt',
        status: 'completed',
        reference,
        tagUid: 10,
        bytesSize: 5,
        origin: 'freedom://publish',
      }),
      expect.objectContaining({
        id: 2,
        status: 'failed',
        errorMessage: 'node unreachable',
        origin: 'freedom://publish',
      }),
      expect.objectContaining({
        id: 1,
        status: 'completed',
        reference,
        bzzUrl: `bzz://${reference}`,
        tagUid: 9,
        batchIdUsed: 'b1'.repeat(32),
        bytesSize: 5,
        origin: 'freedom://publish',
      }),
    ]);
    expect(spy.fromMain()).toEqual([]);
  });

  test("a failed row write fails freedom://publish's request, as main's own database's would", async () => {
    const { handlers } = loadPublishService();
    sim.fail = (_method, params) => {
      if (params.op === 'add') throw new Error('disk full');
    };
    mockUpload.mockClear();
    await expect(handlers['swarm:publish-data']({ sender }, 'hello')).rejects.toThrow('disk full');
    expect(mockUpload).not.toHaveBeenCalled();
  });

  const controllerWith = (publishData) => {
    const { SwarmPublicationController } = require('../agent/swarm-publication-controller');
    return new SwarmPublicationController({
      attachmentStore: { resolvePublicationSource: jest.fn() },
      publishData,
      publishFile: jest.fn(),
      publishDirectory: jest.fn(),
      publishCollection: jest.fn(),
      getUploadStatus: jest.fn(),
      verifyPublication: async () => true,
      publicationIdFactory: () => `swarm_pub_${'c'.repeat(24)}`,
    });
  };
  const approval = { conversationId: 'conversation_test', requestApproval: async () => 'approved' };

  test("the agent's freedom://agent row is the core's before the upload, and updated after it", async () => {
    const reference = 'cd'.repeat(32);
    let rowsAtUpload = null;
    const controller = controllerWith(
      jest.fn(async () => {
        rowsAtUpload = await sim.stores.history('list');
        return { reference, bzzUrl: `bzz://${reference}`, tagUid: null, bytesSize: 5 };
      })
    );
    const spy = spyMainHistory();
    let result;
    try {
      result = await controller.publish({ text: 'hello', contentType: 'text/plain' }, approval);
    } finally {
      spy.restore();
    }
    expect(result.publication).toMatchObject({ state: 'completed', reference });
    expect(rowsAtUpload).toEqual([
      expect.objectContaining({
        id: 1,
        type: 'data',
        name: 'Text',
        status: 'uploading',
        origin: 'freedom://agent',
        bytesSize: 5,
        reference: null,
        completedAt: null,
      }),
    ]);
    expect(sim.calls).toEqual([
      ['swarm.history', 'add', 'shell'],
      ['swarm.history', 'list', 'shell'],
      ['swarm.history', 'update', 'shell'],
    ]);
    expect(await sim.stores.history('list')).toEqual([
      expect.objectContaining({
        id: 1,
        status: 'completed',
        origin: 'freedom://agent',
        reference,
        bzzUrl: `bzz://${reference}`,
        completedAt: expect.any(String),
      }),
    ]);
    expect(spy.fromMain()).toEqual([]);
  });

  test("the agent's row records a failed upload through the core", async () => {
    const controller = controllerWith(
      jest.fn(async () => {
        const err = new Error('Request failed with status 400');
        err.status = 400;
        throw err;
      })
    );
    await expect(
      controller.publish({ text: 'hello', contentType: 'text/plain' }, approval)
    ).rejects.toThrow('Request failed with status 400');
    expect(await sim.stores.history('list')).toEqual([
      expect.objectContaining({
        id: 1,
        status: 'failed',
        origin: 'freedom://agent',
        errorMessage: 'Request failed with status 400',
      }),
    ]);
    expect(sim.calls.map(([, op]) => op)).toEqual(['add', 'update', 'list']);
  });

  test("with the move off, the agent's row is main's own, written before the upload", async () => {
    mockMove.named = false;
    const reference = 'cd'.repeat(32);
    let rowsAtUpload = null;
    const controller = controllerWith(
      jest.fn(async () => {
        rowsAtUpload = history.getEntries();
        return { reference, bzzUrl: `bzz://${reference}`, tagUid: null, bytesSize: 5 };
      })
    );
    const result = await controller.publish(
      { text: 'hello', contentType: 'text/plain' },
      approval
    );
    expect(result.publication).toMatchObject({ state: 'completed', reference });
    expect(rowsAtUpload).toEqual([
      expect.objectContaining({ id: 1, status: 'uploading', origin: 'freedom://agent' }),
    ]);
    expect(history.getEntries()).toEqual([
      expect.objectContaining({ id: 1, status: 'completed', origin: 'freedom://agent', reference }),
    ]);
    expect(sent).toEqual([]);
  });

  test("a cancel while the core writes the agent's row stops it before any upload", async () => {
    const publishData = jest.fn();
    const controller = controllerWith(publishData);
    const abort = new AbortController();
    // The core answers the row's add once the user has cancelled.
    const request = mockMove.client.request;
    mockMove.client.request = async (method, params, ...rest) => {
      const answer = await request(method, params, ...rest);
      if (params.op === 'add') abort.abort();
      return answer;
    };
    const result = await controller.publish(
      { text: 'hello', contentType: 'text/plain' },
      { ...approval, signal: abort.signal }
    );
    expect(result.publication.state).toBe('failed');
    // #run stops before the upload; its row update follows.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(publishData).not.toHaveBeenCalled();
    expect(await sim.stores.history('list')).toEqual([
      expect.objectContaining({ id: 1, status: 'failed', origin: 'freedom://agent' }),
    ]);
  });
});
