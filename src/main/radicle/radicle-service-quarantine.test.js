/**
 * Radicle's repair and quarantine in the chrome, on freedom-radicled
 * (freedom-core design 0008, "The deadline" and "The escape", Main's view;
 * the radicled step-5 plan's B13).
 *
 * Main's own modules run here, under FREEDOM_RADICLE_BACKEND=service:
 * radicle-manager.js and its IPC, with a real RadicledNode on an in-process
 * fake service (fake-radicled.js) whose quarantine record the test holds,
 * and radicle-embedded.js and its service backend for the names. Only the
 * core is faked: its vault, unlocked, and the seal it answers each start
 * with.
 *
 * - **the report and the paging:** `rad.reconcile`'s 16 entries, and
 *   `rad.quarantine_list` through 100 entries, 64 at a time;
 * - **Remove bound to the qid main showed:** the chrome's pair is checked
 *   against main's last snapshot before anything is sent, and
 *   `not_quarantined` lists the quarantine again;
 * - **"still repairing":** `rad.reconcile`'s `deadline`, then Retry.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadMainModule } = require('../../../test/helpers/main-process-test-utils');
const { fakeRadicled, statsResult } = require('../../../test/helpers/fake-radicled');

const DID = 'did:key:z6MkderivedFromTheVaultMnemonic00000000000000';
const NID = 'z6MkderivedFromTheVaultMnemonic00000000000000';
const SEALED = Object.freeze({
  enc: Buffer.alloc(32, 0xa5).toString('base64'),
  ciphertext: Buffer.alloc(48, 0x5a).toString('base64'),
});
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** The `n`th repository's ID, in the record's order. */
function rid(n) {
  let digits = '';
  for (let i = 0, v = n; i < 4; i++, v = Math.floor(v / 58)) digits = BASE58[v % 58] + digits;
  return `rad:z3gqcJUoA1n9HaHKufZs5FCS${digits}`;
}

/** A fresh `qid`: 128 random-looking bits, lowercase hex. */
let qids = 0;
const freshQid = () => (0xabc000 + (qids += 1)).toString(16).padStart(32, '0');

/** A record entry as the service writes it. */
const record = (n) => ({
  rid: rid(n),
  qid: freshQid(),
  kind: n % 2 ? 'namespace' : 'cache',
  step: n % 2 ? 'namespaces' : 'cache',
  unit: null,
  since: 1_700_000_000_000 + n,
});

function fakeVaultBackend() {
  return {
    status: jest.fn(async () => ({ exists: true, unlocked: true, epoch: null, fingerprint: null })),
    addresses: jest.fn(async () => ({
      user_wallets: [],
      bee_wallet: '0xbee',
      publishers: [],
      radicle: { public_key: '00', did: DID, node_id: NID },
    })),
    sealRadicleKey: jest.fn(async () => ({ ...SEALED })),
    writeNodeIdentity: jest.fn(async () => ({ status: 'installed' })),
    onVaultEvent: jest.fn(() => () => {}),
  };
}

let root;
let saved;
let service;
let manager;
let ipcMain;
let sent;
/** The fake service's quarantine record, in ID order, which its methods
 * answer from, and the names its `list_repos` gives. */
let quarantine;
let names;
/** How `rad.reconcile` answers, by attempt; a success otherwise. */
let reconcileAnswers;
/** How the next `rad.remove_repo` answers, before the record's own. */
let removeAnswers;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await sleep(5);
  if (!predicate()) throw new Error('timed out waiting');
}

/** The requests of `method` every process received. */
const requests = (method) => service.children.flatMap((child) => child.sent(method));
/** The repair states main sent the chrome, in order. */
const repairUpdates = () =>
  sent.mock.calls.filter(([channel]) => channel === 'radicle:repairUpdate').map(([, s]) => s);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'radicle-service-quarantine-'));
  const home = path.join(root, 'R');
  fs.mkdirSync(home, { recursive: true });
  saved = {
    backend: process.env.FREEDOM_RADICLE_BACKEND,
    data: process.env.FREEDOM_RADICLE_DATA,
    identity: process.env.FREEDOM_IDENTITY_DATA,
    addon: process.env.FREEDOM_RADICLE_ADDON,
  };
  process.env.FREEDOM_RADICLE_BACKEND = 'service';
  process.env.FREEDOM_RADICLE_DATA = home;
  process.env.FREEDOM_IDENTITY_DATA = path.join(root, 'identity');
  // An add-on that must never load.
  process.env.FREEDOM_RADICLE_ADDON = path.join(root, 'no-such', 'libradicle.node');
  quarantine = [];
  names = new Map();
  reconcileAnswers = [];
  removeAnswers = [];
  load();
});

afterEach(async () => {
  await manager?.stopRadicle();
  manager = null;
  for (const [key, name] of [
    ['backend', 'FREEDOM_RADICLE_BACKEND'],
    ['data', 'FREEDOM_RADICLE_DATA'],
    ['identity', 'FREEDOM_IDENTITY_DATA'],
    ['addon', 'FREEDOM_RADICLE_ADDON'],
  ]) {
    if (saved[key] === undefined) delete process.env[name];
    else process.env[name] = saved[key];
  }
  fs.rmSync(root, { recursive: true, force: true });
});

/** Main's modules over the fake core and the fake service. */
function load() {
  const vault = fakeVaultBackend();
  sent = jest.fn();
  service = fakeRadicled({
    identity: (message, child) =>
      child.result(message.id, { did: DID, nid: NID, ephemeral: false }),
    start: (message, child) =>
      child.result(message.id, { did: DID, nid: NID, alias: message.params?.alias ?? null }),
    reconcile: (message, child) => {
      const answer = reconcileAnswers.shift();
      if (answer) return answer(message, child);
      child.result(message.id, {
        was_dirty: true,
        repaired: {},
        quarantined: { count: quarantine.length, first: quarantine.slice(0, 16) },
      });
    },
    stats: (message, child) =>
      child.result(message.id, statsResult({ quarantined_count: quarantine.length })),
    // The service's paging: 64 a page, the next page's number or null.
    quarantine_list: (message, child) => {
      const page = message.params.page;
      child.result(message.id, {
        entries: quarantine.slice(page * 64, page * 64 + 64),
        next_page: quarantine.length > (page + 1) * 64 ? page + 1 : null,
      });
    },
    // The service's precondition: the record of `rid` must have `qid`.
    remove_repo: (message, child) => {
      const answer = removeAnswers.shift();
      if (answer) return answer(message, child);
      const { rid: r, qid: q } = message.params;
      const index = quarantine.findIndex((e) => e.rid === r && e.qid === q);
      if (index < 0) {
        return child.error(
          message.id,
          'not_quarantined',
          `no quarantine record of ${r} has that qid: nothing was removed`
        );
      }
      quarantine.splice(index, 1);
      child.result(message.id, { removed: true });
    },
    read: (message, child) => {
      if (message.params.op !== 'list_repos') return child.error(message.id, 'not_found');
      const repos = [...names].map(([r, name]) => ({ rid: r, name, description: '' }));
      child.readReply(message.id, JSON.stringify(repos));
    },
  });
  const nodePath = require.resolve('./radicled-node');
  const userData = path.join(root, 'userData');
  fs.mkdirSync(userData, { recursive: true });
  const loaded = loadMainModule(require.resolve('../radicle-manager'), {
    userDataDir: userData,
    windows: [{ webContents: { send: sent } }],
    extraMocks: {
      [require.resolve('../logger')]: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      }),
      [require.resolve('../core/vault-backend')]: () => ({ vaultBackend: vault }),
      [require.resolve('../service-grant')]: () => ({ radicleGrantRefusal: () => null }),
      [nodePath]: () => {
        const actual = jest.requireActual(nodePath);
        class TestRadicledNode extends actual.RadicledNode {
          static isAvailable() {
            return true;
          }
          constructor(options) {
            super({
              ...options,
              command: 'freedom-radicled',
              spawn: service.spawn,
              removeStaleSocket: async () => false,
              guard: { blockReason: () => null, block: () => {}, unblock: () => {} },
            });
          }
        }
        return { ...actual, RadicledNode: TestRadicledNode };
      },
    },
  });
  ipcMain = loaded.ipcMain;
  require('../core/node-identity-guard').setStartupRecovery(null);
  manager = require('../radicle-manager');
  manager.registerRadicleIpc();
}

async function startNode() {
  await expect(manager.startRadicle()).resolves.toEqual({ status: 'running', error: null });
}

/** The chrome's calls, through main's IPC. */
const getRepair = () => ipcMain.invoke('radicle:getRepair');
const remove = (r, q) => ipcMain.invoke('radicle:removeQuarantined', r, q);

/** What main shows of a record entry, named `name`. */
const shownOf = ({ since: _since, ...entry }, name = null) => ({ ...entry, name });

describe("the report and rad.quarantine_list's paging", () => {
  test('pages through 100 quarantined repositories, 64 at a time, after the report', async () => {
    quarantine = Array.from({ length: 100 }, (_, n) => record(n));
    await startNode();
    await waitUntil(() => repairUpdates().length > 0);

    expect(requests('rad.quarantine_list').map((m) => m.params)).toEqual([
      { page: 0 },
      { page: 1 },
    ]);
    const snapshot = await getRepair();
    expect(snapshot.count).toBe(100);
    expect(snapshot.entries).toEqual(quarantine.map((e) => shownOf(e)));
    expect(repairUpdates()).toEqual([snapshot]);
  });

  test("a report that holds them all is shown as it is, with the repositories' names", async () => {
    quarantine = [record(0), record(1)];
    names = new Map([
      [rid(0), 'heartwood'],
      [rid(9), 'another'],
    ]);
    await startNode();
    await waitUntil(() => repairUpdates().length > 0);

    expect(requests('rad.quarantine_list')).toHaveLength(0);
    expect(requests('rad.read').map((m) => m.params.op)).toContain('list_repos');
    await expect(getRepair()).resolves.toEqual({
      repairing: false,
      count: 2,
      entries: [shownOf(quarantine[0], 'heartwood'), shownOf(quarantine[1])],
    });
  });

  test('a clean record: no listing, and nothing sent to the chrome', async () => {
    await startNode();
    await sleep(50);
    expect(requests('rad.quarantine_list')).toHaveLength(0);
    expect(repairUpdates()).toEqual([]);
    await expect(getRepair()).resolves.toEqual({ repairing: false, count: 0, entries: [] });
  });
});

describe('Remove, bound to the qid main showed', () => {
  test("rad.remove_repo { rid, qid } with the shown entry's qid; the entry goes once main lists again", async () => {
    quarantine = Array.from({ length: 20 }, (_, n) => record(n));
    await startNode();
    await waitUntil(() => repairUpdates().length > 0);
    const { entries } = await getRepair();
    const target = entries[7];

    await expect(remove(target.rid, target.qid)).resolves.toEqual({
      success: true,
      removed: true,
    });
    expect(requests('rad.remove_repo').map((m) => m.params)).toEqual([
      { rid: target.rid, qid: target.qid },
    ]);
    await waitUntil(() => repairUpdates().length > 1);
    const after = await getRepair();
    expect(after.count).toBe(19);
    expect(after.entries.map((e) => e.rid)).not.toContain(target.rid);
  });

  test("the chrome can't pick another qid, nor a repository main didn't show: nothing is sent", async () => {
    quarantine = [record(0), record(1)];
    await startNode();
    await waitUntil(() => repairUpdates().length > 0);
    const { entries } = await getRepair();

    for (const [r, q] of [
      [entries[0].rid, entries[1].qid],
      [entries[0].rid, freshQid()],
      [rid(5), entries[0].qid],
      [entries[0].rid, null],
    ]) {
      await expect(remove(r, q)).resolves.toMatchObject({
        success: false,
        error: { code: 'QUARANTINE_NOT_SHOWN' },
      });
    }
    expect(requests('rad.remove_repo')).toHaveLength(0);
  });

  test('not_quarantined: nothing was removed, and the quarantine is listed again', async () => {
    quarantine = [record(0), record(1)];
    await startNode();
    await waitUntil(() => repairUpdates().length > 0);
    const { entries } = await getRepair();
    // Removed and quarantined again since: a new record, with a new qid.
    const again = { ...quarantine[1], qid: freshQid() };
    quarantine[1] = again;

    await expect(remove(entries[1].rid, entries[1].qid)).resolves.toMatchObject({
      success: false,
      error: { code: 'NOT_QUARANTINED' },
    });
    await waitUntil(() => repairUpdates().length > 1);
    expect(requests('rad.quarantine_list').map((m) => m.params)).toEqual([{ page: 0 }]);
    const after = await getRepair();
    expect(after.entries[1]).toEqual(shownOf(again));
    // The old qid is no longer shown, so it can't be sent again.
    await expect(remove(entries[1].rid, entries[1].qid)).resolves.toMatchObject({
      error: { code: 'QUARANTINE_NOT_SHOWN' },
    });
    expect(requests('rad.remove_repo')).toHaveLength(1);
  });

  test('a removal that fails part way names its step; the record and its qid stay, and a retry with it completes', async () => {
    quarantine = [record(0)];
    await startNode();
    await waitUntil(() => repairUpdates().length > 0);
    const [entry] = (await getRepair()).entries;
    removeAnswers.push((message, child) =>
      child.error(message.id, 'failed', 'the storage: its directory could not be flushed')
    );

    await expect(remove(entry.rid, entry.qid)).resolves.toEqual({
      success: false,
      error: { code: 'REMOVE_FAILED', message: 'the storage: its directory could not be flushed' },
    });
    await waitUntil(() => requests('rad.quarantine_list').length > 0);
    await expect(remove(entry.rid, entry.qid)).resolves.toEqual({ success: true, removed: true });
    await waitUntil(() => repairUpdates().length > 1);
    await expect(getRepair()).resolves.toEqual({ repairing: false, count: 0, entries: [] });
  });

  test('a crash with a removal in flight is outcome_unknown; the restart lists the quarantine again', async () => {
    quarantine = [record(0), record(1)];
    await startNode();
    await waitUntil(() => repairUpdates().length > 0);
    const [entry] = (await getRepair()).entries;
    removeAnswers.push((_message, child) => {
      // The removal went through, and the process crashed before its answer.
      quarantine.splice(0, 1);
      setImmediate(() => child.exit(70));
    });

    await expect(remove(entry.rid, entry.qid)).resolves.toMatchObject({
      success: false,
      error: { code: 'OUTCOME_UNKNOWN' },
    });
    // The restart's reconciliation reports the record as it is.
    await waitUntil(() => service.children.length === 2 && repairUpdates().length > 1, 10_000);
    await expect(getRepair()).resolves.toEqual({
      repairing: false,
      count: 1,
      entries: [shownOf(quarantine[0])],
    });
    expect(requests('rad.remove_repo')).toHaveLength(1);
  });
});

describe('"still repairing" and Retry (0008, "The deadline")', () => {
  test("rad.reconcile's deadline: the error state and the repair state say so; Retry spawns a fresh process", async () => {
    reconcileAnswers.push((message, child) =>
      child.error(message.id, 'deadline', 'the reconciliation deadline passed')
    );
    await expect(manager.startRadicle()).resolves.toEqual({
      status: 'error',
      error: 'Radicle is still repairing its data',
    });
    await expect(getRepair()).resolves.toEqual({ repairing: true, count: 0, entries: [] });
    expect(repairUpdates().at(-1)).toEqual({ repairing: true, count: 0, entries: [] });

    // Retry: the chrome's start.
    await expect(ipcMain.invoke('radicle:start')).resolves.toEqual({
      status: 'running',
      error: null,
    });
    expect(service.children).toHaveLength(2);
    await expect(getRepair()).resolves.toEqual({ repairing: false, count: 0, entries: [] });
    expect(repairUpdates().at(-1).repairing).toBe(false);
  });
});
