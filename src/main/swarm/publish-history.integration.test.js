/**
 * publish-history.js on the real freedom-cored's history (freedom-core
 * design 0015, "Methods main calls": `swarm.history`, with core PR K1's
 * `add` and `update`, from cored 0.33.0; D3, D7 and D10; the SWM-6 to SWM-9
 * plan's PR 6.4 and point 2). No build's hello names `swarm_stores` before
 * PR 7.4: here the hello is the test's
 * (`storeMovedFor('core', { swarmStores: true })`, as
 * store-handover.integration.test.js chooses it), and main's
 * `swarmStoresNamed()` says so.
 *
 * - publish-history.test.js's cases (test/helpers/publish-history-cases.js),
 *   played through main's handlers and `coreOps` against the pinned core,
 *   each case on a core of its own: each answer equals the reference's
 *   (test/helpers/reference-publish-history.js, on a root of its own) for
 *   the same sequence, and the core's rows and legacy files end as the
 *   reference's do. Each side's times come from its own clock.
 * - A spy on `fs` and better-sqlite3 over main's run: main opens, reads and
 *   writes no publish-history file, and never the legacy
 *   publish-history.json (the core is another process; D10 is its own).
 * - js→core→js (the plan's point 2): today's main writes the history and
 *   imports the legacy file, the core serves those rows and adds its own,
 *   and today's main reads them back, with no row twice, in the profile's
 *   root layout and in the Freedom root layout (a moved profile, the legacy
 *   file at the profile's root).
 * - core→js (D10's hand-over): in a moved profile the core imports the
 *   legacy file's copy and leaves the original for its next start; a start
 *   on main's own history before then retires the original, unimported,
 *   so the legacy row is there once; the root layout is unchanged.
 * - The agent's publication controller writes its `freedom://agent` row
 *   into the core's history before the upload and updates it after.
 *
 * Skipped without the binary; FREEDOM_CORED_STORES_TEST=1 requires it (npm
 * run core:download, npm run core:download:previous).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadMainModule } = require('../../../test/helpers/main-process-test-utils');
const { coredBinaries, startCore, watchWrites } = require('../../../test/helpers/store-handover');
const {
  PUBLISH_HISTORY_CASES,
  HISTORY_FILE,
  LEGACY_FILE,
  legacyFiles,
  playPublishHistoryCase,
  seedLegacy,
} = require('../../../test/helpers/publish-history-cases');

// A core per case, and one case of 250 rows, each a round trip.
jest.setTimeout(120_000);

const { current } = coredBinaries();
const describeIfCurrent = current && fs.existsSync(current) ? describe : describe.skip;

const quietLog = () => ({ info() {}, warn() {}, error() {}, debug() {} });

/**
 * better-sqlite3, each open recorded in `opens` (`[file]`), for the
 * registry main and the reference load in.
 */
function spiedDatabase(opens) {
  const Real = jest.requireActual('better-sqlite3');
  function SpiedDatabase(file, options) {
    opens.push(String(file));
    return new Real(file, options);
  }
  return SpiedDatabase;
}

/**
 * Main's publish-history.js and the reference, in one fresh registry, its
 * profile `userDataDir`: main's handlers and `coreOps` reach `core` (its
 * hello names `swarm_stores`), and the reference keeps its database under
 * `userDataDir`'s Freedom root. `opens` records every better-sqlite3 open.
 */
function loadModules(core, userDataDir, opens = []) {
  const loaded = loadMainModule(require.resolve('./publish-history'), {
    userDataDir,
    extraMocks: {
      [require.resolve('../core/core-process')]: () => ({ getCoreClient: () => core }),
      [require.resolve('../core/core-client')]: () => ({
        ...jest.requireActual('../core/core-client'),
        swarmStoresNamed: () => true,
      }),
      [require.resolve('../logger')]: quietLog,
      'electron-log': quietLog,
      'better-sqlite3': () => spiedDatabase(opens),
    },
  });
  const { ipcMain } = loaded;
  loaded.mod.registerPublishHistoryIpc();
  const mainHandlers = new Map(ipcMain.handlers);
  ipcMain.handlers.clear();
  const reference = require('../../../test/helpers/reference-publish-history');
  reference.registerPublishHistoryIpc();
  const referenceHandlers = new Map(ipcMain.handlers);
  return { history: loaded.mod, reference, mainHandlers, referenceHandlers };
}

/** Today's main on `userDataDir`'s history, alone in a fresh registry. */
function loadReference(userDataDir) {
  return loadMainModule(require.resolve('../../../test/helpers/reference-publish-history'), {
    userDataDir,
    extraMocks: {
      [require.resolve('../logger')]: quietLog,
    },
  }).mod;
}

/**
 * Main's publish-history.js with the move off (the build's
 * `swarmStoresNamed()`, false before PR 7.4), on `userDataDir`'s history,
 * alone in a fresh registry: a start on main's own history.
 */
function loadMainHistory(userDataDir) {
  return loadMainModule(require.resolve('./publish-history'), {
    userDataDir,
    extraMocks: {
      // An earlier load's chosen hello is still registered: the build's own.
      [require.resolve('../core/core-client')]: () => jest.requireActual('../core/core-client'),
      [require.resolve('../logger')]: quietLog,
    },
  }).mod;
}

/** The rows of `dir`'s publish-history.sqlite, by id, each time a clock made `'now'`. */
function readRows(dir) {
  const file = path.join(dir, HISTORY_FILE);
  if (!fs.existsSync(file)) return null;
  const Real = jest.requireActual('better-sqlite3');
  const db = new Real(file, { readonly: true });
  try {
    const since = Date.now() - 60_000;
    const clock = (value) => (typeof value === 'number' && value >= since ? 'now' : value);
    return db
      .prepare('SELECT * FROM publishes ORDER BY id')
      .all()
      .map((row) => ({
        ...row,
        started_at: clock(row.started_at),
        completed_at: clock(row.completed_at),
      }));
  } finally {
    db.close();
  }
}

const LEGACY_ENTRIES = [
  {
    id: 'legacy-1',
    type: 'directory',
    name: 'old-site',
    status: 'completed',
    reference: 'legacyref',
    bzzUrl: 'bzz://legacyref',
    tagUid: 100,
    batchIdUsed: 'legacybatch',
    timestamp: '2026-04-15T19:30:32.540Z',
  },
  {
    id: 'legacy-2',
    type: 'feed-create',
    name: 'feed-x',
    status: 'completed',
    timestamp: '2026-04-15T19:31:00.000Z',
  },
];
const LEGACY_TEXT = JSON.stringify({ version: 1, entries: LEGACY_ENTRIES });

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describeIfCurrent('publish-history.js on the pinned freedom-cored (a hello naming swarm_stores)', () => {
  const dirs = [];
  let chosen;

  beforeAll(() => {
    const { storeMovedFor } = jest.requireActual('../core/core-client');
    chosen = storeMovedFor('core', { swarmStores: true });
  });

  afterAll(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  const tempDir = (name) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pubhist-int-${name}-`));
    dirs.push(dir);
    return dir;
  };

  /** A core on `root` whose hello names `swarm_stores`, main's modules loaded on it. */
  async function startNamed(root, userDataDir, options = {}) {
    let modules;
    const opens = [];
    const core = await startCore({
      binary: current,
      root,
      storeMoved: chosen,
      ...options,
      beforeStart: (client) => {
        modules = loadModules(client, userDataDir, opens);
      },
    });
    expect(core.hello.store_moved).toEqual([...chosen]);
    return { core, modules, opens };
  }

  describe("publish-history.test.js's cases", () => {
    test.each(PUBLISH_HISTORY_CASES.map((kase) => [kase.name, kase]))(
      '%s',
      async (_name, kase) => {
        const root = tempDir('core');
        const referenceDir = tempDir('reference');
        // Before the core starts: its history opens, and imports, from then.
        seedLegacy(kase, root);
        seedLegacy(kase, referenceDir);
        const { core, modules, opens } = await startNamed(root, referenceDir);
        try {
          const mainSide = {
            chrome: (channel) => modules.mainHandlers.get(channel)({}),
            main: (fn, args) => modules.history.coreOps[fn](...args),
          };
          const referenceSide = {
            chrome: (channel) => modules.referenceHandlers.get(channel)({}),
            main: (fn, args) => modules.reference[fn](...args),
          };

          // Main's run, watched: the core is another process, so any touch
          // of a publish-history file in this one is main's.
          const watch = watchWrites(/publish-history/, { forbidReads: true });
          const exists = jest.spyOn(fs, 'existsSync');
          let mainTouches;
          let coreFiles;
          let played;
          try {
            played = await playPublishHistoryCase(kase, {
              main: mainSide,
              reference: referenceSide,
              between: () => {
                mainTouches = [
                  ...watch.offending().map(({ name, args }) => [name, String(args[0])]),
                  ...exists.mock.calls
                    .filter(([target]) => String(target).includes('publish-history'))
                    .map(([target]) => ['existsSync', String(target)]),
                  ...opens.map((file) => ['better-sqlite3', file]),
                ];
                watch.restore();
                exists.mockRestore();
                coreFiles = legacyFiles(root);
              },
            });
          } finally {
            watch.restore();
            exists.mockRestore();
            modules.reference.closeDb();
          }

          expect(mainTouches).toEqual([]);
          // Each answer is the reference's, step by step.
          expect(played.map(({ step, main }) => [step, main])).toEqual(
            played.map(({ step, reference }) => [step, reference])
          );
          // The legacy files and the rows end as the reference's.
          expect(coreFiles).toEqual(legacyFiles(referenceDir));
          await core.stop();
          expect(readRows(root)).toEqual(readRows(referenceDir));
        } finally {
          await core.stop();
        }
      }
    );
  });

  describe('js→core→js: no row twice (the plan, point 2)', () => {
    /**
     * Today's main on `userDataDir`: the legacy file imported, a completed
     * and a failed row of its own; the rows it ends with.
     */
    async function jsRun(userDataDir) {
      const js = loadReference(userDataDir);
      try {
        expect(js.getEntries()).toHaveLength(LEGACY_ENTRIES.length);
        const done = js.addEntry({ type: 'file', name: 'js.txt', origin: 'freedom://publish' });
        await pause(3);
        js.updateEntry(done.id, { status: 'completed', reference: 'ab'.repeat(32) });
        await pause(3);
        const failed = js.addEntry({ type: 'data', name: 'js-failed', origin: 'freedom://agent' });
        js.updateEntry(failed.id, { status: 'failed', errorMessage: 'stamp expired' });
        return js.getEntries();
      } finally {
        js.closeDb();
      }
    }

    /** Main on the core: it reads `before`, adds and updates a row; the rows it ends with. */
    async function coreRun(modules, before) {
      const ops = modules.history.coreOps;
      expect(await ops.getEntries()).toEqual(before);
      expect(await modules.mainHandlers.get('swarm:get-publish-history')({})).toEqual({
        success: true,
        entries: before,
      });
      await pause(3);
      const row = await ops.addEntry({
        type: 'directory',
        name: 'core-site',
        status: 'uploading',
        origin: 'freedom://agent',
      });
      expect(row.id).toBe(before.length + 1);
      await ops.updateEntry(row.id, { status: 'completed', reference: 'cd'.repeat(32) });
      return ops.getEntries();
    }

    /** No row twice: each id once, and no two rows alike but for their id. */
    function expectNoRowTwice(rows) {
      expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
      const alike = rows.map(({ id: _id, ...rest }) => JSON.stringify(rest));
      expect(new Set(alike).size).toBe(rows.length);
    }

    test("in the profile's root layout: imported once, by today's main", async () => {
      const root = tempDir('root-layout');
      fs.writeFileSync(path.join(root, LEGACY_FILE), LEGACY_TEXT);

      const before = await jsRun(root);
      expect(legacyFiles(root)).toEqual({ legacy: false, migrated: true });
      // A stray copy back beside its .migrated (a restored backup): the
      // core drops it, as today's main does, and imports nothing.
      fs.writeFileSync(path.join(root, LEGACY_FILE), LEGACY_TEXT);

      const { core, modules, opens } = await startNamed(root, tempDir('elsewhere'));
      let afterCore;
      try {
        afterCore = await coreRun(modules, before);
        expect(opens).toEqual([]);
      } finally {
        await core.stop();
      }
      expect(legacyFiles(root)).toEqual({ legacy: false, migrated: true });
      expect(afterCore).toHaveLength(before.length + 1);

      const js = loadReference(root);
      try {
        const after = js.getEntries();
        expect(after).toEqual(afterCore);
        expectNoRowTwice(after);
        expect(after.filter((row) => row.name === 'old-site')).toHaveLength(1);
      } finally {
        js.closeDb();
      }
    });

    test('in the Freedom root layout: the legacy file at the profile root, imported once', async () => {
      const userData = tempDir('moved');
      const freedom = path.join(userData, 'freedom');
      fs.mkdirSync(freedom);
      fs.writeFileSync(path.join(freedom, 'layout.json'), JSON.stringify({ version: 1 }));
      fs.writeFileSync(path.join(userData, LEGACY_FILE), LEGACY_TEXT);

      const before = await jsRun(userData);
      expect(fs.existsSync(path.join(freedom, HISTORY_FILE))).toBe(true);
      expect(legacyFiles(userData)).toEqual({ legacy: false, migrated: true });
      expect(legacyFiles(freedom)).toEqual({ legacy: false, migrated: false });

      // The core: its grant root the Freedom root, the profile's directory
      // its user_data_dir. The legacy file is gone from the profile's root,
      // so it hands nothing over and imports nothing.
      const { core, modules, opens } = await startNamed(userData, tempDir('elsewhere'), {
        grantRoot: freedom,
        userDataDir: userData,
      });
      let afterCore;
      try {
        expect(core.service.helloParams(core)).toMatchObject({
          grant_root: freedom,
          user_data_dir: userData,
        });
        afterCore = await coreRun(modules, before);
        expect(opens).toEqual([]);
      } finally {
        await core.stop();
      }
      expect(legacyFiles(userData)).toEqual({ legacy: false, migrated: true });
      expect(legacyFiles(freedom)).toEqual({ legacy: false, migrated: false });

      const js = loadReference(userData);
      try {
        const after = js.getEntries();
        expect(after).toEqual(afterCore);
        expectNoRowTwice(after);
        expect(after.filter((row) => row.name === 'old-site')).toHaveLength(1);
      } finally {
        js.closeDb();
      }
    });
  });

  describe("core→js: the core's legacy import stands (D10's hand-over)", () => {
    const ONE_ROW = JSON.stringify({
      version: 1,
      entries: [
        {
          type: 'data',
          name: 'legacy',
          status: 'completed',
          timestamp: '2026-04-15T19:30:32.540Z',
        },
      ],
    });

    /** A start on main's own history: its rows. */
    function jsStart(userDataDir) {
      const js = loadMainHistory(userDataDir);
      try {
        return js.getEntries();
      } finally {
        js.closeDb();
      }
    }

    test('in the Freedom root layout: the original retired, one legacy row', async () => {
      const userData = tempDir('handover');
      const freedom = path.join(userData, 'freedom');
      fs.mkdirSync(freedom);
      fs.writeFileSync(path.join(freedom, 'layout.json'), JSON.stringify({ version: 1 }));
      fs.writeFileSync(path.join(userData, LEGACY_FILE), ONE_ROW);
      const moved = { grantRoot: freedom, userDataDir: userData };

      // The core's start: it copies the file into the Freedom root and
      // imports the copy, which it renames there; the original stays at the
      // profile's root until its next start.
      let { core, modules } = await startNamed(userData, tempDir('elsewhere'), moved);
      try {
        const rows = await modules.history.coreOps.getEntries();
        expect(rows.map((row) => row.name)).toEqual(['legacy']);
      } finally {
        await core.stop();
      }
      expect(legacyFiles(userData)).toEqual({ legacy: true, migrated: false });
      expect(legacyFiles(freedom)).toEqual({ legacy: false, migrated: true });
      expect(fs.readFileSync(path.join(freedom, `${LEGACY_FILE}.migrated`), 'utf8')).toBe(ONE_ROW);

      // The next start on main's own history: the core's import stands, so
      // the original is retired, as the core's next start would, unimported.
      const rows = jsStart(userData);
      expect(rows.map((row) => row.name)).toEqual(['legacy']);
      expect(legacyFiles(userData)).toEqual({ legacy: false, migrated: false });
      expect(legacyFiles(freedom)).toEqual({ legacy: false, migrated: true });
      expect(jsStart(userData)).toEqual(rows);

      // And the core again: nothing to hand over, the same one row.
      ({ core, modules } = await startNamed(userData, tempDir('elsewhere'), moved));
      try {
        expect(await modules.history.coreOps.getEntries()).toEqual(rows);
      } finally {
        await core.stop();
      }
    });

    test("in the profile's root layout: unchanged, the core renamed it, one legacy row", async () => {
      const root = tempDir('handover-root');
      fs.writeFileSync(path.join(root, LEGACY_FILE), ONE_ROW);
      const { core, modules } = await startNamed(root, tempDir('elsewhere'));
      try {
        const rows = await modules.history.coreOps.getEntries();
        expect(rows.map((row) => row.name)).toEqual(['legacy']);
      } finally {
        await core.stop();
      }
      expect(legacyFiles(root)).toEqual({ legacy: false, migrated: true });
      const rows = jsStart(root);
      expect(rows.map((row) => row.name)).toEqual(['legacy']);
      expect(legacyFiles(root)).toEqual({ legacy: false, migrated: true });
    });
  });

  test("the agent's freedom://agent row is the core's before the upload, and updated after it", async () => {
    const root = tempDir('agent');
    const { core, modules } = await startNamed(root, tempDir('elsewhere'));
    try {
      const { SwarmPublicationController } = require('../agent/swarm-publication-controller');
      const reference = 'ef'.repeat(32);
      let rowsAtUpload = null;
      const controller = new SwarmPublicationController({
        attachmentStore: { resolvePublicationSource: jest.fn() },
        publishData: jest.fn(async () => {
          rowsAtUpload = await modules.history.coreOps.getEntries();
          return { reference, bzzUrl: `bzz://${reference}`, tagUid: null, bytesSize: 5 };
        }),
        publishFile: jest.fn(),
        publishDirectory: jest.fn(),
        publishCollection: jest.fn(),
        getUploadStatus: jest.fn(),
        verifyPublication: async () => true,
        publicationIdFactory: () => `swarm_pub_${'d'.repeat(24)}`,
      });
      const result = await controller.publish(
        { text: 'hello', contentType: 'text/plain' },
        { conversationId: 'conversation_test', requestApproval: async () => 'approved' }
      );
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
      expect(await modules.history.coreOps.getEntries()).toEqual([
        expect.objectContaining({
          id: 1,
          status: 'completed',
          origin: 'freedom://agent',
          reference,
          bzzUrl: `bzz://${reference}`,
          completedAt: expect.any(String),
        }),
      ]);
    } finally {
      await core.stop();
    }
  });
});
