/**
 * permission-manifests.js on the real freedom-cored's manifest store
 * (freedom-core design 0015, D3, D6 and D17; the SWM-6 to SWM-9 plan's
 * PR 6.3, points 5 and 6). No build's hello names `swarm_stores` before
 * PR 7.4: here the hello is the test's (`storeMovedFor('core', {
 * swarmStores: true })`, as store-handover.integration.test.js chooses it),
 * and main's `swarmStoresNamed()` says so.
 *
 * - permission-manifests' store cases (test/helpers/permission-manifest-cases.js),
 *   played through main's page path and the chrome's handlers against the
 *   pinned core, each case on a core of its own, its check's manifest
 *   fetched by main's own `shell.swarm_manifest` handler
 *   (core/swarm-shell.js `registerSwarmShell`, on the core's client): each
 *   answer and each manifest fetched equal the reference's
 *   (test/helpers/reference-permission-manifests.js, on a root of its own,
 *   its Swarm grants on test/helpers/simulated-grant-core.js) for the same
 *   sequence, and the core's swarm-manifest-grants.json, swarm-permissions.json
 *   and swarm-feeds.json end as the reference's do. Site keys main is given
 *   unnormalized among them: the core keys the store by what main sends.
 * - An `fs` spy over main's run: main opens, reads and writes no
 *   manifest-store file (the core is another process).
 *
 * Skipped without the binary; FREEDOM_CORED_STORES_TEST=1 requires it (npm
 * run core:download, npm run core:download:previous).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const mockIpc = { handlers: {} };
jest.mock('electron', () => ({
  app: { getPath: jest.fn() },
  ipcMain: {
    handle: (channel, handler) => {
      mockIpc.handlers[channel] = handler;
    },
    removeHandler: () => {},
  },
  session: {
    defaultSession: { partition: 'default' },
    fromPartition: (partition) => ({ partition }),
  },
}));
jest.mock('electron-log', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  transports: { file: {}, console: {} },
}));
jest.mock('../private/private-windows', () => ({
  getPartitionForWebContents: () => null,
  isPrivateWebContents: () => false,
}));
jest.mock('../identity-manager', () => ({
  getBeeWalletAddress: async () => '0xBee0000000000000000000000000000000000000',
  getPublisherAddress: async (index) => `0xPublisher${index}`,
  getDerivedWallets: async () => [],
}));
// Every manifest fetch, main's and the reference's.
jest.mock('./bzz-protocol', () => ({ handleBzzRequest: jest.fn() }));

// The hello naming `swarm_stores` is the test's choice, and so is the core.
const mockMove = { named: false, client: null };
jest.mock('../core/core-client', () => ({
  ...jest.requireActual('../core/core-client'),
  swarmStoresNamed: () => mockMove.named,
}));
jest.mock('../core/core-process', () => ({ getCoreClient: () => mockMove.client }));

const { coredBinaries, startCore, watchWrites } = require('../../../test/helpers/store-handover');
const { useSimulatedGrantCore } = require('../../../test/helpers/simulated-grant-core');
const {
  PERMISSION_MANIFEST_CASES,
  normalized,
  playPermissionManifestCase,
  responseFor,
} = require('../../../test/helpers/permission-manifest-cases');

const { current } = coredBinaries();
const describeIfCurrent = current && fs.existsSync(current) ? describe : describe.skip;

const STORE_FILE = 'swarm-manifest-grants.json';
const FILES = [STORE_FILE, 'swarm-permissions.json', 'swarm-feeds.json'];

// The stores' logs: kept quiet.
for (const method of ['log', 'warn', 'error'])
  jest.spyOn(console, method).mockImplementation(() => {});

describeIfCurrent(
  "permission-manifests' store cases on the pinned freedom-cored (a hello naming swarm_stores)",
  () => {
    const { app } = require('electron');
    const { handleBzzRequest } = require('./bzz-protocol');
    const { storeMovedFor } = jest.requireActual('../core/core-client');
    const { registerSwarmShell } = require('../core/swarm-shell');
    const manifests = require('./permission-manifests');
    const reference = require('../../../test/helpers/reference-permission-manifests');
    const referenceFeeds = require('../../../test/helpers/reference-feed-store');
    const chosen = storeMovedFor('core', { swarmStores: true });
    const serving = { spec: undefined };
    const fetched = [];
    const dirs = [];
    const mainHandlers = {};
    const referenceHandlers = {};

    const tempDir = (name) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `permission-manifests-core-${name}-`));
      dirs.push(dir);
      return dir;
    };

    beforeAll(() => {
      mockMove.named = true;
      mockIpc.handlers = mainHandlers;
      manifests.registerPermissionManifestIpc();
      mockMove.named = false;
      app.getPath.mockReturnValue(tempDir('register'));
      mockIpc.handlers = referenceHandlers;
      reference.registerPermissionManifestIpc();
      mockIpc.handlers = {};
    });

    beforeEach(() => {
      handleBzzRequest.mockReset();
      handleBzzRequest.mockImplementation(async (request) => {
        fetched.push(request.url);
        const response = responseFor(serving.spec);
        if (!response) throw new Error('fetch failed');
        return response;
      });
      fetched.length = 0;
    });

    afterAll(() => {
      for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    });

    const liveGuest = () => ({ isDestroyed: () => false });
    const world = (handlers, module) => ({
      serve: (spec) => {
        serving.spec = spec;
      },
      guest: liveGuest,
      check: (request) => module.checkPageManifest(request),
      decide: (...args) => module.decidePageManifest(...args),
      release: (token) => module.releasePageManifest(token),
      handlers,
    });

    /** A store file of `dir`, parsed and normalized; its text where it isn't JSON; or null. */
    const fileOf = (dir, name) => {
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) return null;
      const text = fs.readFileSync(file, 'utf8');
      try {
        return normalized(JSON.parse(text));
      } catch {
        return text;
      }
    };

    const seeded = (dir, kase) => {
      for (const [file, text] of Object.entries(kase.seed?.files ?? {})) {
        fs.writeFileSync(path.join(dir, file), text);
      }
    };

    test.each(PERMISSION_MANIFEST_CASES.map((kase) => [kase.name, kase]))(
      '%s',
      async (_name, kase) => {
        const root = tempDir('core');
        const referenceDir = tempDir('reference');
        // Before the core starts: its swarm thread loads the stores then, and
        // its grant store the Swarm grants.
        seeded(root, kase);
        const grantSeed = kase.seed?.grants?.swarm;
        if (grantSeed) {
          fs.writeFileSync(
            path.join(root, 'swarm-permissions.json'),
            JSON.stringify(grantSeed, null, 2),
            {
              mode: 0o600,
            }
          );
        }
        seeded(referenceDir, kase);

        // Main's run, watched: the core is another process, so any touch of a
        // manifest-store file in this one is main's.
        app.getPath.mockReturnValue(root);
        manifests._resetForTests();
        const core = await startCore({
          binary: current,
          root,
          storeMoved: chosen,
          beforeStart: (client) => {
            registerSwarmShell(client);
          },
        });
        let mainRun;
        let mainTouches;
        try {
          expect(core.hello.store_moved).toEqual([...chosen]);
          mockMove.named = true;
          mockMove.client = core;
          const watch = watchWrites(/swarm-manifest-grants/, { forbidReads: true });
          const exists = jest.spyOn(fs, 'existsSync');
          try {
            mainRun = await playPermissionManifestCase(kase, world(mainHandlers, manifests));
          } finally {
            mainTouches = [
              ...watch.offending().map(({ name, args }) => [name, String(args[0])]),
              ...exists.mock.calls
                .filter(([target]) => String(target).includes('swarm-manifest-grants'))
                .map(([target]) => ['existsSync', String(target)]),
            ];
            watch.restore();
            exists.mockRestore();
            mockMove.named = false;
            mockMove.client = null;
          }
        } finally {
          await core.stop();
        }
        const mainFetched = [...fetched];
        expect(mainTouches).toEqual([]);
        expect(manifests._manifestAskCountForTests()).toBe(0);

        // The reference's run, today's main on its own files.
        fetched.length = 0;
        app.getPath.mockReturnValue(referenceDir);
        reference._resetForTests();
        referenceFeeds._resetCache();
        const grantCore = await useSimulatedGrantCore({ swarm: grantSeed ?? {} });
        const referenceRun = await playPermissionManifestCase(
          kase,
          world(referenceHandlers, reference)
        );
        fs.writeFileSync(
          path.join(referenceDir, 'swarm-permissions.json'),
          grantCore.file('swarm')
        );

        // Each answer is the reference's, step by step, and so is each fetch.
        expect(normalized(mainRun).map((outcome, i) => [kase.steps[i], outcome])).toEqual(
          normalized(referenceRun).map((outcome, i) => [kase.steps[i], outcome])
        );
        expect(mainFetched).toEqual(fetched);
        // The core's files end as the reference's (its grants as the
        // simulated grant core writes them; none where it holds none).
        for (const file of FILES) {
          const expected = fileOf(referenceDir, file);
          const empty =
            file === 'swarm-permissions.json' && expected && Object.keys(expected).length === 0;
          expect([file, fileOf(root, file) ?? (empty ? {} : null)]).toEqual([file, expected]);
        }
      }
    );
  }
);
