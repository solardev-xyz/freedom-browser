/**
 * feed-store.js on the real freedom-cored's feed store (freedom-core design
 * 0015, D3, D7 and D8; the SWM-6 to SWM-9 plan's PR 6.2). No build's hello
 * names `swarm_stores` before PR 7.4: here the hello is the test's
 * (`storeMovedFor('core', { swarmStores: true })`, as
 * store-handover.integration.test.js chooses it), and main's
 * `swarmStoresNamed()` says so.
 *
 * - feed-store.test.js's store cases (test/helpers/feed-store-cases.js),
 *   played through main's handlers and `coreOps` against the pinned core,
 *   each case on a core of its own whose vault is unlocked from a known
 *   phrase: each answer equals the reference's
 *   (test/helpers/reference-feed-store.js, on a root of its own, its owners
 *   the core's addresses) for the same sequence, and the core's
 *   swarm-feeds.json ends as the reference's does.
 * - An `fs` spy over main's run: main opens, reads and writes no feed-store
 *   file (the core is another process).
 * - D8: the references come in the core's order, ICU root collation, which
 *   main keeps.
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
  FEED_STORE_CASES,
  mainOpArgs,
  normalized,
  playFeedStoreCase,
} = require('../../../test/helpers/feed-store-cases');

const { current } = coredBinaries();
const describeIfCurrent = current && fs.existsSync(current) ? describe : describe.skip;

const FEEDS_FILE = 'swarm-feeds.json';
const PASSWORD = 'feed-store-core-pass-1';
const ABANDON =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PUBLISHERS = [0, 1, 2, 3, 4, 5, 6, 7];
const shell = { caller: 'shell' };
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

/**
 * The reference's owners, as identity-manager.js reads them from the vault:
 * the core's addresses for the same phrase, and its messages while locked.
 */
function ownersOf(state) {
  return {
    getBeeWalletAddress: async () => (state.unlocked ? state.addresses.bee_wallet : null),
    getPublisherAddress: async (index) => {
      if (!state.unlocked) throw new Error('Vault must be unlocked to derive publisher keys');
      const found = state.addresses.publishers.find((one) => one.origin_index === index);
      if (!found) throw new Error(`no address for publisher ${index} in the test`);
      return found.address;
    },
    getDerivedWallets: async () => state.wallets,
  };
}

/**
 * Main's feed-store.js and the reference, in one fresh registry, on `core`:
 * main's handlers and `coreOps` reach the core (its hello names
 * `swarm_stores`), and the reference keeps its file under `referenceDir`.
 */
function loadModules(core, referenceDir, owners) {
  const loaded = loadMainModule(require.resolve('./feed-store'), {
    userDataDir: referenceDir,
    extraMocks: {
      [require.resolve('../core/core-process')]: () => ({ getCoreClient: () => core }),
      [require.resolve('../core/core-client')]: () => ({
        ...jest.requireActual('../core/core-client'),
        swarmStoresNamed: () => true,
      }),
      [require.resolve('../identity-manager')]: () => owners,
    },
  });
  const { ipcMain } = loaded;
  loaded.mod.registerFeedStoreIpc();
  const mainHandlers = new Map(ipcMain.handlers);
  ipcMain.handlers.clear();
  const reference = require('../../../test/helpers/reference-feed-store');
  reference.registerFeedStoreIpc();
  const referenceHandlers = new Map(ipcMain.handlers);
  return { feeds: loaded.mod, reference, mainHandlers, referenceHandlers };
}

describeIfCurrent(
  "feed-store.js's store cases on the pinned freedom-cored (a hello naming swarm_stores)",
  () => {
    const dirs = [];
    let chosen;

    beforeAll(() => {
      ({ storeMovedFor: chosen } = jest.requireActual('../core/core-client'));
      chosen = chosen('core', { swarmStores: true });
    });

    afterAll(() => {
      for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    });

    const tempDir = (name) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `feed-store-core-${name}-`));
      dirs.push(dir);
      return dir;
    };

    test.each(FEED_STORE_CASES.map((kase) => [kase.name, kase]))('%s', async (_name, kase) => {
      const root = tempDir('core');
      const referenceDir = tempDir('reference');
      if (kase.seed) {
        // Before the core starts: its swarm thread loads the store then.
        fs.writeFileSync(path.join(root, FEEDS_FILE), kase.seed);
        fs.writeFileSync(path.join(referenceDir, FEEDS_FILE), kase.seed);
      }
      const state = { unlocked: true, addresses: null, wallets: [] };
      let modules;
      const core = await startCore({
        binary: current,
        root,
        storeMoved: chosen,
        beforeStart: (client) => {
          modules = loadModules(client, referenceDir, ownersOf(state));
        },
      });
      try {
        expect(core.hello.store_moved).toEqual([...chosen]);
        await core.request(
          'vault.import',
          {
            password_b64: b64(PASSWORD),
            mnemonic_b64: b64(ABANDON),
            overwrite: false,
            user_knows_password: true,
          },
          shell
        );
        state.addresses = await core.request(
          'keys.addresses',
          { accounts: [], publishers: PUBLISHERS },
          shell
        );
        state.wallets = (await core.request('accounts.list', {}, shell)).wallets;
        if (kase.vault === 'locked') await core.request('vault.lock', {}, shell);

        const mainSide = {
          chrome: (channel, args) => modules.mainHandlers.get(channel)({}, ...args),
          main: (op, args) => modules.feeds.coreOps[op](...mainOpArgs(op, args)[0]),
          vault: (to) =>
            to === 'unlock'
              ? core.request('vault.unlock', { password_b64: b64(PASSWORD) }, shell)
              : core.request('vault.lock', {}, shell),
        };
        const referenceSide = {
          chrome: (channel, args) => modules.referenceHandlers.get(channel)({}, ...args),
          main: (op, args) => modules.reference[op](...mainOpArgs(op, args)[1]),
          vault: (to) => {
            state.unlocked = to === 'unlock';
          },
        };

        // Main's run, watched: the core is another process, so any touch of
        // a feed-store file in this one is main's.
        const watch = watchWrites(/swarm-feeds/, { forbidReads: true });
        const exists = jest.spyOn(fs, 'existsSync');
        let mainTouches;
        let played;
        try {
          played = await playFeedStoreCase(kase, {
            main: mainSide,
            reference: referenceSide,
            between: () => {
              mainTouches = [
                ...watch.offending().map(({ name, args }) => [name, String(args[0])]),
                ...exists.mock.calls
                  .filter(([target]) => String(target).includes('swarm-feeds'))
                  .map(([target]) => ['existsSync', String(target)]),
              ];
              watch.restore();
              exists.mockRestore();
              // The reference's run starts from the case's vault.
              state.unlocked = kase.vault !== 'locked';
            },
          });
        } finally {
          watch.restore();
          exists.mockRestore();
        }

        expect(mainTouches).toEqual([]);
        // Each answer is the reference's, step by step.
        expect(played.map(({ step, main }) => [step, main])).toEqual(
          played.map(({ step, reference }) => [step, reference])
        );
        // The core's file ends as the reference's.
        const read = (dir) =>
          normalized(JSON.parse(fs.readFileSync(path.join(dir, FEEDS_FILE), 'utf8')));
        if (fs.existsSync(path.join(referenceDir, FEEDS_FILE))) {
          expect(read(root)).toEqual(read(referenceDir));
        } else {
          expect(fs.existsSync(path.join(root, FEEDS_FILE))).toBe(false);
        }

        if (kase.name.includes('D8')) {
          // ICU root collation: `_` before `-` before `.` before letters, the
          // active identities first; a code-unit sort puts `-` first and `_`
          // after `.`.
          const [{ main }] = played;
          const origins = main.result.map(({ origin }) => origin);
          expect(origins).toEqual(['a_b.eth', 'a-b.eth', 'a.b.eth', 'ab.eth', 'aa.eth']);
          const codeUnits = [...origins.slice(0, 4)].sort();
          expect(codeUnits).toEqual(['a-b.eth', 'a.b.eth', 'a_b.eth', 'ab.eth']);
        }
      } finally {
        await core.stop();
      }
    });
  }
);
