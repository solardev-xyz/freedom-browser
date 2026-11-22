/**
 * The set-A store handover against the real freedom-cored (freedom-core
 * design 0013, "One writer per store: `store_moved`"). This build's hello
 * names `vault_meta` (PRF-6(a)), `intents` (PRF-6(b2)), `payments`
 * (PRF-6(c)), `safe_pending` (PRF-6(d)) and `rpc_api_keys` (PRF-6(e)), in
 * `STORES` order, and the pinned core echoes them all. A hello naming
 * none, as a build before PRF-6 sends, has the pinned core (0.27.0) write
 * none of the stores, answer each of their writes `not_moved` and serves
 * the reads it can; a store's request sent with
 * `requires: requiresStore(name)` fails `requirement_unmet` in main, unsent;
 * and the previous release (0.22.0), which ignores `store_moved`, takes a
 * hello naming all five and echoes none, so every store's request fails
 * the same way there, and a hello naming the profile's directory too.
 * With `payments` named and the profile's directory apart from the Freedom
 * root, as after 0013's move, the pinned core copies the legacy x402
 * receipts from the profile's directory into the Freedom root and imports
 * the copy (design 0017 C5).
 *
 * Skipped without the binaries; FREEDOM_CORED_STORES_TEST=1 requires both
 * (npm run core:download, npm run core:download:previous).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  coredBinaries,
  startCore,
  snapshot,
  openFiles,
  watchWrites,
  SET_A_WRITES,
} = require('../../../test/helpers/store-handover');

const { current, previous } = coredBinaries();
const describeIfCurrent = current && fs.existsSync(current) ? describe : describe.skip;
const describeIfPrevious =
  current && previous && fs.existsSync(previous) ? describe : describe.skip;

const STORE_READS = [
  ['accounts.list', {}],
  ['accounts.meta', {}],
  ['accounts.active', {}],
  ['intents.list', {}],
  ['safe_pending.list', {}],
];

// The set-A stores' files (design 0013): main's, before each moves.
const SET_A_FILES =
  /vault-meta\.json|wallet-intents\.jsonl|payment-history\.sqlite|safe-pending\.json|rpc-api-keys\.json/;

const shell = { caller: 'shell' };
const errorOf = (promise) =>
  promise.then(
    (result) => ({ result }),
    (err) => ({ code: err.code, data: err.data, message: err.message })
  );

/** One request per store, the first of its writes in `SET_A_WRITES`. */
function onePerStore() {
  const seen = new Set();
  return SET_A_WRITES.filter(({ store }) => !seen.has(store) && seen.add(store));
}

test("the helpers' write spy and snapshot see a store file's write, and its read when forbidden", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-handover-spy-'));
  try {
    const file = path.join(dir, 'safe-pending.json');
    const before = snapshot(dir);
    const watch = watchWrites(SET_A_FILES, { forbidReads: true });
    try {
      fs.writeFileSync(path.join(dir, 'other.json'), '{}');
      fs.writeFileSync(file, '{}');
      fs.readFileSync(file, 'utf8');
      fs.closeSync(fs.openSync(file, 'r'));
      expect(watch.offending().map(({ name }) => name)).toEqual([
        'writeFileSync',
        'openSync',
        'readFileSync',
      ]);
    } finally {
      watch.restore();
    }
    const reads = watchWrites(SET_A_FILES);
    try {
      fs.closeSync(fs.openSync(file, 'r'));
      fs.readFileSync(file, 'utf8');
      expect(reads.offending()).toEqual([]);
      fs.closeSync(fs.openSync(file, 'a'));
      expect(reads.offending().map(({ name }) => name)).toEqual(['openSync']);
    } finally {
      reads.restore();
    }
    expect(Object.keys(snapshot(dir)).sort()).toEqual(['other.json', 'safe-pending.json']);
    expect(snapshot(dir)).not.toEqual(before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describeIfCurrent('the set-A stores before any moves, on the pinned freedom-cored', () => {
  let root;
  let core;
  let requiresStore;
  let STORES;

  beforeAll(async () => {
    ({ requiresStore, STORES } = require('./core-client'));
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-handover-'));
    // The hello of a build before PRF-6, which names none.
    core = await startCore({ binary: current, root, storeMoved: [] });
  });

  afterAll(async () => {
    await core?.stop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  test("the build's hello names its stores, in STORES order, and the echo has them all", async () => {
    const { STORE_MOVED } = require('./core-client');
    expect(STORE_MOVED).toEqual(
      expect.arrayContaining(['vault_meta', 'intents', 'payments', 'safe_pending', 'rpc_api_keys'])
    );
    expect(STORE_MOVED).toEqual(STORES.filter((name) => STORE_MOVED.includes(name)));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'store-handover-build-'));
    let built;
    try {
      built = await startCore({ binary: current, root: other });
      expect(built.service.helloParams(built).store_moved).toEqual([...STORE_MOVED]);
      expect(built.hello.store_moved).toEqual([...STORE_MOVED]);
    } finally {
      await built?.stop();
      fs.rmSync(other, { recursive: true, force: true });
    }
    expect(core.service.helloParams(core).store_moved).toEqual([]);
    expect(core.hello.store_moved).toEqual([]);
  });

  test('a hello naming all five gets all five back, in its order', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'store-handover-all-'));
    let named;
    try {
      named = await startCore({ binary: current, root: other, storeMoved: STORES });
      expect(named.service.helloParams(named).store_moved).toEqual([...STORES]);
      expect(named.hello.store_moved).toEqual([...STORES]);
    } finally {
      await named?.stop();
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  test('with none named, every write answers not_moved and nothing in the profile changes', async () => {
    const before = snapshot(root);
    const identityBefore = snapshot(path.join(root, 'identity'));
    // Main touches none of the stores' files either.
    const watch = watchWrites(SET_A_FILES, { forbidReads: true });
    try {
      for (const { store, method, params } of SET_A_WRITES) {
        const answer = await errorOf(core.request(method, params, shell));
        expect([method, answer.code, answer.data?.store]).toEqual([method, 'not_moved', store]);
      }
      for (const [method, params] of STORE_READS) {
        const answer = await errorOf(core.request(method, params, shell));
        expect([method, typeof answer.result]).toEqual([method, 'object']);
        expect(answer.result).not.toBeNull();
      }
      expect(watch.offending()).toEqual([]);
    } finally {
      watch.restore();
    }
    expect(snapshot(root)).toEqual(before);
    expect(snapshot(path.join(root, 'identity'))).toEqual(identityBefore);
    expect(fs.existsSync(path.join(root, 'payment-history.sqlite'))).toBe(false);
    const open = openFiles(core.current.child.pid);
    if (open) {
      expect(
        open.filter((file) => /payment-history\.sqlite|rpc-api-keys\.json/.test(file))
      ).toEqual([]);
    }
  });

  // Design 0013, PRF-8b-lite (cored 0.24.0): the legacy x402 receipts are
  // imported from the hello's user_data_dir, the profile's directory, and
  // renamed there, while the database stays under grant_root, the Freedom
  // root, as after 0013's move. A file at the Freedom root is left unread.
  // The pinned core (0.27.0, design 0017 C5) copies a moved profile's legacy
  // receipts from user_data_dir into the Freedom root and imports the copy;
  // a Freedom-root file that isn't that copy is a conflict, which skips the
  // legacy import and leaves both files.
  const receipts = (id) =>
    JSON.stringify([
      {
        id,
        settledAt: 1699000000,
        status: 'settled',
        chainId: 8453,
        amount: '500',
        origin: 'https://x.example',
        url: 'https://x.example/a',
      },
    ]);

  async function startMoved(userData, freedom) {
    const moved = await startCore({
      binary: current,
      root: userData,
      grantRoot: freedom,
      userDataDir: userData,
      storeMoved: ['payments'],
    });
    expect(moved.service.helloParams(moved)).toMatchObject({
      grant_root: freedom,
      user_data_dir: userData,
    });
    expect(moved.hello.store_moved).toEqual(['payments']);
    return moved;
  }

  test('with payments named, the receipts in user_data_dir are imported from their copy', async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'store-handover-user-data-'));
    const freedom = path.join(userData, 'freedom');
    fs.mkdirSync(freedom);
    const legacy = path.join(userData, 'x402-receipts.json');
    fs.writeFileSync(legacy, receipts('profile'));
    let moved;
    try {
      moved = await startMoved(userData, freedom);
      const { payments } = await moved.request('payments.get_recent', {}, { caller: 'chrome' });
      expect(payments.map((p) => [p.kind, p.metadata?.legacyId])).toEqual([['x402', 'profile']]);
      expect(fs.existsSync(path.join(freedom, 'payment-history.sqlite'))).toBe(true);
      expect(fs.existsSync(path.join(userData, 'payment-history.sqlite'))).toBe(false);
      // The copy was imported and renamed; the original stays until a later start.
      expect(fs.readFileSync(path.join(freedom, 'x402-receipts.json.migrated'), 'utf8')).toBe(
        receipts('profile')
      );
      expect(fs.existsSync(path.join(freedom, 'x402-receipts.json'))).toBe(false);
      expect(fs.existsSync(legacy)).toBe(true);
      await moved.stop();
      moved = await startMoved(userData, freedom);
      const again = await moved.request('payments.get_recent', {}, { caller: 'chrome' });
      expect(again.payments).toHaveLength(1);
      expect(fs.existsSync(legacy)).toBe(false);
      expect(fs.existsSync(`${legacy}.migrated`)).toBe(false);
    } finally {
      await moved?.stop();
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });

  test('a Freedom-root receipts file that is not the copy is a conflict: nothing imported', async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'store-handover-user-data-'));
    const freedom = path.join(userData, 'freedom');
    fs.mkdirSync(freedom);
    fs.writeFileSync(path.join(userData, 'x402-receipts.json'), receipts('profile'));
    fs.writeFileSync(path.join(freedom, 'x402-receipts.json'), receipts('freedom'));
    let moved;
    try {
      moved = await startMoved(userData, freedom);
      const { payments } = await moved.request('payments.get_recent', {}, { caller: 'chrome' });
      expect(payments).toEqual([]);
      expect(fs.readFileSync(path.join(userData, 'x402-receipts.json'), 'utf8')).toBe(
        receipts('profile')
      );
      expect(fs.readFileSync(path.join(freedom, 'x402-receipts.json'), 'utf8')).toBe(
        receipts('freedom')
      );
      expect(fs.existsSync(path.join(userData, 'x402-receipts.json.migrated'))).toBe(false);
      expect(fs.existsSync(path.join(freedom, 'x402-receipts.json.migrated'))).toBe(false);
    } finally {
      await moved?.stop();
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });

  test("a store's request with requires fails requirement_unmet in main, unsent", async () => {
    const before = snapshot(root);
    const requires = requiresStore('payments');
    const answer = await errorOf(
      core.request('payments.get_count', { filters: {} }, shell, { requires })
    );
    expect(answer.code).toBe('requirement_unmet');

    // The same through vault-backend's `call`.
    jest.resetModules();
    jest.doMock('./core-process', () => ({ getCoreClient: () => core }));
    const { _internal } = require('./vault-backend');
    const viaBackend = await errorOf(
      _internal.call('payments.get_count', { filters: {} }, null, { requires })
    );
    expect(viaBackend.code).toBe('requirement_unmet');
    // A request without `requires` still reaches the core.
    const sent = await errorOf(_internal.call('payments.get_count', { filters: {} }));
    expect([sent.code, sent.data?.store]).toEqual(['not_moved', 'payments']);

    expect(fs.existsSync(path.join(root, 'payment-history.sqlite'))).toBe(false);
    expect(snapshot(root)).toEqual(before);
  });
});

describeIfPrevious('the set-A stores on the previous freedom-cored release', () => {
  let root;
  let core;
  let requiresStore;
  let STORES;

  beforeAll(async () => {
    ({ requiresStore, STORES } = require('./core-client'));
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-handover-previous-'));
    // The hello also names the profile's directory (PRF-8b-lite), which a
    // core before 0.24.0 ignores, as every member it doesn't know.
    core = await startCore({ binary: previous, root, storeMoved: STORES, userDataDir: root });
  });

  afterAll(async () => {
    await core?.stop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  test("a hello naming all five, and the profile's directory, is taken, and echoes none", () => {
    expect(core.service.helloParams(core).store_moved).toEqual([...STORES]);
    expect(core.service.helloParams(core).user_data_dir).toBe(root);
    expect(core.hello.store_moved).toEqual([]);
  });

  test("each store's request with requires fails requirement_unmet, and nothing changes", async () => {
    const before = snapshot(root);
    const identityBefore = snapshot(path.join(root, 'identity'));
    const requests = onePerStore();
    expect(requests.map(({ store }) => store)).toEqual([...STORES]);
    for (const { store, method, params } of requests) {
      const answer = await errorOf(
        core.request(method, params, shell, { requires: requiresStore(store) })
      );
      expect([method, answer.code]).toEqual([method, 'requirement_unmet']);
    }
    expect(snapshot(root)).toEqual(before);
    expect(snapshot(path.join(root, 'identity'))).toEqual(identityBefore);
  });
});
