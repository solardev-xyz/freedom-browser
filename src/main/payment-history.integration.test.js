/**
 * The payment history through the real freedom-cored (freedom-core design
 * 0013, "Payment history"; PRF-6(c)): this build names `payments` in the
 * hello's `store_moved`, and the core is payment-history.sqlite's one
 * writer and reader. Main's payment-history.js runs as main runs it, over a
 * CoreClient on the binary, with its broadcasts and IPC handlers captured.
 *
 * - **(T1) The module against the core** on the pinned core: append, update
 *   and the marks answer the records, each broadcast once the core has
 *   answered (none for a null answer); the refusals keep their classes; the
 *   repoll sweep resolves pending rows as confirmed, failed, or dropped once
 *   seen dropped the confirm time apart, and clears a sighting a pending
 *   answer follows; filters and paging, through main and through the
 *   chrome's IPC (relayed as the chrome); clear and its event; and the core
 *   imports `x402-receipts.json` from the hello's `user_data_dir` at its
 *   first request, and renames it `.migrated`.
 * - **(T2)** Main writes and reads none of `payment-history.sqlite*` or
 *   `x402-receipts.json` through any of the above (an `fs` spy), and a spy
 *   on better-sqlite3's constructor, in main's module registry, sees no
 *   open of the database (coordinator call G27). On Linux, main's
 *   `/proc/self/fd` never holds the database's files, while the core's
 *   `/proc/<pid>/fd` does once it has written.
 * - **(T3)** A hello naming none (the build before this step), with the
 *   reference module (9d4ea6251, real better-sqlite3): every `payments.*`,
 *   reads included, answers `not_moved` with `data.store`; the core never
 *   creates the database, its file descriptors never name it, and its
 *   requests leave the reference's database as it was.
 * - **(T4)** This step's module on the previous release (0.22.0), which
 *   echoes no store: every `payments.*` fails `requirement_unmet` in main,
 *   unsent, and no database exists.
 * - **Rollback:** the reference module reads the database the core wrote:
 *   its `getRecent`, `getById`, `getCount` and `getPending.all()` equal the
 *   core's answers.
 *
 * Skipped without the binaries; FREEDOM_CORED_STORES_TEST=1 requires both
 * (npm run core:download, npm run core:download:previous). CI's
 * e2e-desktop job runs it on each OS.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  coredBinaries,
  digests,
  openFiles,
  watchWrites,
  SET_A_WRITES,
} = require('../../test/helpers/store-handover');

const { current, previous } = coredBinaries();
const haveCurrent = !!(current && fs.existsSync(current));
const describeIfCurrent = haveCurrent ? describe : describe.skip;
const describeIfPrevious =
  haveCurrent && previous && fs.existsSync(previous) ? describe : describe.skip;

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
const DB_FILES = [
  'payment-history.sqlite',
  'payment-history.sqlite-wal',
  'payment-history.sqlite-shm',
];
const DB_PATTERN = /payment-history\.sqlite/;
// Main touches neither the database nor the legacy receipts the core imports.
const MAIN_UNTOUCHED = /payment-history\.sqlite|x402-receipts\.json/;
const RECORDED = 'payments:tx-recorded';
const UNMET = "The core can't take this request";
const PENDING_SQL = "SELECT * FROM payments WHERE status = 'pending' ORDER BY created_at ASC";
const SENDER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const RECIPIENT = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`;

// One valid request per payments.* method, as main sends it.
const EVERY_METHOD = [
  ['payments.append', { entry: { kind: 'x402', chainId: 8453, amount: '1', status: 'settled' } }],
  ['payments.update', { id: 1, patch: { status: 'confirmed' } }],
  ['payments.mark_confirmed', { id: 1, receipt: { gasUsed: '1' } }],
  ['payments.mark_failed', { id: 1, info: { reason: 'reverted' } }],
  ['payments.mark_dropped', { id: 1 }],
  ['payments.set_dropped_seen', { id: 1, seen_at: 1 }],
  ['payments.pending', {}],
  ['payments.get_recent', { filters: {} }],
  ['payments.get_by_id', { id: 1 }],
  ['payments.get_count', { filters: {} }],
  ['payments.clear', {}],
];

jest.setTimeout(120_000);

const errorOf = (promise) =>
  promise.then(
    (result) => ({ result }),
    (err) => ({ code: err.code, data: err.data, message: err.message, err })
  );

function makeRoot(prefix) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  fs.mkdirSync(path.join(root, 'identity'), { mode: 0o700 });
  fs.mkdirSync(path.join(root, 'locks'));
  return root;
}

/**
 * A CoreClient on `binary` for the profile at `root`: its Freedom root,
 * grant root and userData (main's hello sends `app.getPath('userData')` as
 * `user_data_dir`), passed as serve's arguments too (design 0017, C1)
 * except to the previous release (0.22.0), which doesn't know them. With
 * `storeMoved`, its hello names those stores.
 */
function makeCore(root, { binary = current, storeMoved } = {}) {
  const { CoreClient, _internal } = require('./core/core-client');
  const client = new CoreClient({
    spawn,
    command: binary,
    args: [
      'serve',
      '--data-dir',
      path.join(root, 'identity'),
      '--lock-dir',
      path.join(root, 'locks'),
    ],
    log: quietLog,
    shellVersion: 'jest',
    grantRoot: root,
    userDataDir: root,
    grantArgs: binary !== previous,
  });
  if (storeMoved) client.service = _internal.coreService(storeMoved);
  return client;
}

/**
 * Main's payment-history.js over `client`, fresh, with userData at `root`:
 * its broadcasts (`sent`), its IPC handlers (`invoke`), and every path
 * better-sqlite3's constructor is given in main's registry (`opened`).
 */
function loadMain(root, client) {
  jest.resetModules();
  const sent = [];
  const handlers = new Map();
  const opened = [];
  jest.doMock('electron', () => ({
    app: { isPackaged: false, getPath: () => root, getVersion: () => 'jest' },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    webContents: {
      getAllWebContents: () => [{ send: (channel, payload) => sent.push([channel, payload]) }],
    },
  }));
  jest.doMock('./logger', () => quietLog);
  jest.doMock('./core/core-process', () => ({ getCoreClient: () => client }));
  jest.doMock('better-sqlite3', () => {
    const Database = jest.requireActual('better-sqlite3');
    return function WatchedDatabase(file, ...rest) {
      opened.push(String(file));
      return new Database(file, ...rest);
    };
  });
  const history = require('./payment-history');
  history.registerPaymentHistoryIpc();
  return {
    history,
    sent,
    opened,
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    vault: require('./core/vault-backend').vaultBackend,
  };
}

/** The reference module (9d4ea6251) over the profile at `root`, with the real better-sqlite3. */
function loadReference(root) {
  jest.resetModules();
  jest.doMock('electron', () => ({
    app: { isPackaged: false, getPath: () => root },
    ipcMain: { handle() {} },
    webContents: { getAllWebContents: () => [] },
  }));
  jest.doMock('./logger', () => quietLog);
  return require('../../test/helpers/reference-payment-history');
}

/** Runs `task` (main's operations) under the `fs` spy, which must stay clean (T2). */
async function asMain(task) {
  const watch = watchWrites(MAIN_UNTOUCHED, { forbidReads: true });
  try {
    await task();
    expect(watch.offending()).toEqual([]);
  } finally {
    watch.restore();
  }
}

/** The database's files `pid` holds open: Linux only, else null. */
function dbFilesOpen(pid) {
  const open = openFiles(pid);
  return open && open.filter((file) => DB_PATTERN.test(file)).map((file) => path.basename(file));
}

describeIfCurrent('payment-history.sqlite through freedom-cored (0013, PRF-6(c))', () => {
  let root;
  let core;

  beforeEach(() => {
    root = makeRoot('payments-core-');
    core = null;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await core?.stop().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  test('(T1, T2) append, update and the marks answer the records, each broadcast after its answer', async () => {
    core = makeCore(root);
    const main = loadMain(root, core);
    const { history } = main;
    await asMain(async () => {
      await core.start();
      // The build's stores, the payment history among them, all echoed.
      expect(core.hello.store_moved).toContain('payments');
      expect(core.hello.store_moved).toEqual(core.service.helloParams(core).store_moved);
      // The core opens the database at its first request, not at the hello.
      expect(fs.existsSync(path.join(root, 'payment-history.sqlite'))).toBe(false);

      const a = await history.append({
        kind: 'wallet-send',
        chainId: 100,
        txHash: hash(1),
        fromAddress: SENDER,
        toAddress: RECIPIENT,
        amount: '1000',
        metadata: { txFrom: SENDER, txNonce: 3 },
      });
      expect(a).toMatchObject({
        id: expect.any(Number),
        kind: 'wallet-send',
        chainId: 100,
        txHash: hash(1),
        status: 'pending',
        confirmedAt: null,
        metadata: { txFrom: SENDER, txNonce: 3 },
      });
      expect(main.sent).toEqual([
        [RECORDED, { id: a.id, kind: 'wallet-send', status: 'pending', txHash: hash(1) }],
      ]);

      expect(await history.update(a.id, { txHash: hash(2) })).toMatchObject({
        txHash: hash(2),
        status: 'pending',
      });
      const confirmed = await history.markConfirmed(a.id, { gasUsed: '21000', gasPrice: '7' });
      expect(confirmed).toMatchObject({ status: 'confirmed', gasUsed: '21000', gasPrice: '7' });
      expect(confirmed.confirmedAt).toEqual(expect.any(Number));

      const b = await history.append({
        kind: 'dapp-send',
        chainId: 1,
        amount: '2',
        origin: 'https://app.example',
      });
      expect(await history.markFailed(b.id, { reason: 'reverted' })).toMatchObject({
        status: 'failed',
        metadata: { failureReason: 'reverted' },
      });
      const c = await history.append({
        kind: 'safe-send',
        chainId: 100,
        txHash: hash(3),
        amount: '3',
        metadata: { safeAddress: RECIPIENT },
      });
      expect(await history.markDropped(c.id)).toMatchObject({
        status: 'dropped',
        metadata: { safeAddress: RECIPIENT, failureReason: 'nonce used by another transaction' },
      });
      expect(main.sent.map(([, payload]) => [payload.id, payload.status])).toEqual([
        [a.id, 'pending'],
        [a.id, 'pending'],
        [a.id, 'confirmed'],
        [b.id, 'pending'],
        [b.id, 'failed'],
        [c.id, 'pending'],
        [c.id, 'dropped'],
      ]);

      // A null answer is broadcast to no one: a row no longer pending isn't
      // dropped, and no row has id 9999.
      const before = main.sent.length;
      await expect(history.markDropped(a.id)).resolves.toBeNull();
      await expect(history.update(9999, { status: 'confirmed' })).resolves.toBeNull();
      expect(await history.getById(a.id)).toEqual(confirmed);
      await expect(history.getById(9999)).resolves.toBeNull();

      // Refusals keep payment-history.js's classes and messages (G13).
      const unknown = await history
        .append({ kind: 'lightning', chainId: 1, amount: '1' })
        .catch((e) => e);
      expect(unknown).toBeInstanceOf(Error);
      expect(unknown).toMatchObject({
        message: "payment-history: unknown kind 'lightning'",
        code: 'invalid_argument',
        data: { name: 'Error' },
      });
      await expect(history.append({ kind: 'x402', chainId: 1, amount: 'ten' })).rejects.toThrow(
        'payment-history: amount must be a digit string'
      );
      const typeError = await history.getRecent(null).catch((e) => e);
      expect(typeError).toBeInstanceOf(TypeError);
      expect(typeError.message).toMatch(/Cannot read properties of null/);
      expect(main.sent).toHaveLength(before);
    });
    // (T2) better-sqlite3's constructor, in main's registry, opened nothing.
    expect(main.opened.filter((file) => DB_PATTERN.test(file))).toEqual([]);
    // One process on the database: the core, never main (Linux).
    const mine = dbFilesOpen(process.pid);
    if (mine) {
      expect(mine).toEqual([]);
      expect(dbFilesOpen(core.current.child.pid)).toEqual(
        expect.arrayContaining(['payment-history.sqlite', 'payment-history.sqlite-wal'])
      );
    }
  });

  test('(T1) the repoll sweep resolves pending rows, and drops one seen dropped the confirm time apart', async () => {
    core = makeCore(root);
    const main = loadMain(root, core);
    const { history, vault } = main;
    await asMain(async () => {
      await core.start();
      const seenLongAgo = Date.now() - history.DROPPED_CONFIRM_MS - 1000;
      const append = (n, metadata) =>
        history.append({
          kind: 'wallet-send',
          chainId: 100,
          txHash: n ? hash(n) : null,
          amount: String(n),
          metadata,
          createdAt: 1000 + n,
        });
      const confirmed = await append(1, { txFrom: SENDER, txNonce: 1 });
      const failed = await append(2);
      const firstSeen = await append(3, { txFrom: SENDER, txNonce: 3 });
      const seenBefore = await append(4, {
        txFrom: SENDER,
        txNonce: 4,
        txDroppedSeenAt: seenLongAgo,
        note: 'kept',
      });
      const pendingAgain = await append(5, { txDroppedSeenAt: seenLongAgo });
      const noHash = await append(0);

      // The sweep's rows: the core's `pending`, raw, oldest first.
      const raw = await vault.payments.pending();
      expect(raw.map((row) => row.id)).toEqual([
        noHash.id,
        confirmed.id,
        failed.id,
        firstSeen.id,
        seenBefore.id,
        pendingAgain.id,
      ]);
      expect(raw[1]).toMatchObject({
        tx_hash: hash(1),
        chain_id: 100,
        status: 'pending',
        metadata: JSON.stringify({ txFrom: SENDER, txNonce: 1 }),
      });

      const status = jest.fn(async (txHash) => {
        if (txHash === hash(1))
          return { status: 'confirmed', gasUsed: '21000', effectiveGasPrice: '9' };
        if (txHash === hash(2)) return { status: 'failed', gasUsed: '30000' };
        if (txHash === hash(5)) return { status: 'pending' };
        return { status: 'dropped' };
      });
      main.sent.length = 0;
      const sweptAt = Date.now();
      await expect(history.repollPending(status)).resolves.toEqual({
        resolved: 3,
        stillPending: 3,
        errors: 0,
      });
      expect(status).toHaveBeenCalledTimes(5);
      expect(status).toHaveBeenCalledWith(hash(3), 100, { from: SENDER, nonce: 3, sweep: true });

      expect(await history.getById(confirmed.id)).toMatchObject({
        status: 'confirmed',
        gasUsed: '21000',
        gasPrice: '9',
      });
      expect(await history.getById(failed.id)).toMatchObject({
        status: 'failed',
        gasUsed: '30000',
      });
      // Seen dropped once: still pending, its sighting kept on the row.
      const sighted = await history.getById(firstSeen.id);
      expect(sighted.status).toBe('pending');
      expect(sighted.metadata).toEqual({
        txFrom: SENDER,
        txNonce: 3,
        txDroppedSeenAt: expect.any(Number),
      });
      expect(sighted.metadata.txDroppedSeenAt).toBeGreaterThanOrEqual(sweptAt);
      // Seen dropped again past the confirm time: dropped, its metadata kept.
      expect(await history.getById(seenBefore.id)).toMatchObject({
        status: 'dropped',
        metadata: { txNonce: 4, note: 'kept', failureReason: 'nonce used by another transaction' },
      });
      // A pending answer clears an earlier sighting.
      expect(await history.getById(pendingAgain.id)).toMatchObject({
        status: 'pending',
        metadata: {},
      });
      expect((await history.getById(noHash.id)).status).toBe('pending');
      // The marks broadcast; the sightings don't.
      expect(main.sent.map(([, payload]) => [payload.id, payload.status]).sort()).toEqual(
        [
          [confirmed.id, 'confirmed'],
          [failed.id, 'failed'],
          [seenBefore.id, 'dropped'],
        ].sort()
      );
      // The confirming sweep the sighting scheduled isn't waited for here.
    });
  });

  test("(T1) filters and paging, through main and through the chrome's IPC", async () => {
    core = makeCore(root);
    const main = loadMain(root, core);
    const { history, invoke } = main;
    await asMain(async () => {
      await core.start();
      const rows = [
        {
          kind: 'x402',
          chainId: 8453,
          origin: 'https://a.example',
          amount: '1',
          status: 'settled',
          asset: USDC,
          createdAt: 1000,
        },
        {
          kind: 'x402',
          chainId: 1,
          origin: 'https://b.example',
          amount: '2',
          status: 'settled',
          createdAt: 5000,
        },
        { kind: 'wallet-send', chainId: 8453, amount: '3', createdAt: 3000 },
        {
          kind: 'dapp-send',
          chainId: 8453,
          origin: 'https://a.example',
          amount: '4',
          createdAt: 2000,
        },
        {
          kind: 'x402',
          chainId: 8453,
          origin: 'https://a.example',
          amount: '5',
          status: 'no-receipt',
          createdAt: 4000,
        },
      ];
      for (const row of rows) await history.append(row);

      const amounts = async (filters) => (await history.getRecent(filters)).map((r) => r.amount);
      expect(await amounts({})).toEqual(['2', '5', '3', '4', '1']);
      expect(await amounts()).toEqual(['2', '5', '3', '4', '1']);
      expect(await amounts({ limit: 2 })).toEqual(['2', '5']);
      expect(await amounts({ limit: 2, offset: 2 })).toEqual(['3', '4']);
      expect(await amounts({ offset: 4 })).toEqual(['1']);
      expect(await amounts({ kind: 'x402' })).toEqual(['2', '5', '1']);
      expect(await amounts({ chainId: 8453 })).toEqual(['5', '3', '4', '1']);
      expect(await amounts({ origin: 'https://a.example' })).toEqual(['5', '4', '1']);
      expect(await amounts({ status: 'pending' })).toEqual(['3', '4']);
      expect(await amounts({ kind: 'x402', chainId: 8453, status: 'settled' })).toEqual(['1']);
      expect(await amounts({ kind: 'x402', bogus: 'dropped', limit: 10_000_000 })).toEqual([
        '2',
        '5',
        '1',
      ]);
      expect(await history.getCount({})).toBe(5);
      expect(await history.getCount({ kind: 'x402', limit: 1 })).toBe(3);
      expect(await history.getCount({ chainId: 8453, origin: 'https://a.example' })).toBe(3);

      // The chrome's reads, relayed to the core as the chrome's.
      const recent = await invoke('payments:get-recent', { kind: 'x402', limit: 2 });
      expect(recent).toEqual({
        success: true,
        payments: await history.getRecent({ kind: 'x402', limit: 2 }),
      });
      const malicious = JSON.parse('{"kind":"x402","__proto__":{"evil":true}}');
      expect((await invoke('payments:get-recent', malicious)).payments).toHaveLength(3);
      const [first] = recent.payments;
      expect(await invoke('payments:get-by-id', first.id)).toEqual({
        success: true,
        payment: first,
      });
      expect(await invoke('payments:get-by-id', 'not-an-int')).toEqual({
        success: false,
        error: 'id must be an integer',
      });
      expect(await invoke('payments:get-count', { origin: 'https://a.example' })).toEqual({
        success: true,
        count: 3,
      });
      expect(await invoke('payments:get-recent', null)).toMatchObject({ success: false });
    });
  });

  test('(T1) clear empties the history, broadcast once it removed rows', async () => {
    core = makeCore(root);
    const main = loadMain(root, core);
    const { history, invoke } = main;
    await asMain(async () => {
      await core.start();
      await history.append({ kind: 'x402', chainId: 1, amount: '1', status: 'settled' });
      await history.append({ kind: 'wallet-send', chainId: 1, amount: '2' });
      main.sent.length = 0;
      expect(await invoke('payments:clear')).toEqual({ success: true, removed: 2 });
      expect(main.sent).toEqual([[RECORDED, { id: null }]]);
      expect(await history.getCount({})).toBe(0);
      await expect(history.clear()).resolves.toBe(0);
      expect(main.sent).toHaveLength(1);
    });
  });

  test('(T1) the core imports x402-receipts.json from user_data_dir at its first request, and renames it .migrated', async () => {
    const legacy = path.join(root, 'x402-receipts.json');
    fs.writeFileSync(
      legacy,
      JSON.stringify([
        {
          id: 'r-1',
          url: 'https://x.example/a',
          origin: 'https://x.example',
          chainId: 8453,
          asset: USDC,
          amount: '500',
          txHash: hash(9),
          status: 'settled',
          settledAt: 1700000000,
        },
        {
          url: 'https://y.example/b',
          origin: 'https://y.example',
          chainId: 8453,
          amount: '7',
          status: 'no-receipt',
          settledAt: 1700000100,
        },
      ])
    );
    core = makeCore(root);
    const main = loadMain(root, core);
    const { history } = main;
    await asMain(async () => {
      await core.start();
      expect(core.service.helloParams(core).user_data_dir).toBe(root);
      // Nothing until the first request.
      expect(fs.existsSync(legacy)).toBe(true);
      expect(fs.existsSync(path.join(root, 'payment-history.sqlite'))).toBe(false);
      expect(await history.getCount({ kind: 'x402' })).toBe(2);
      expect(fs.existsSync(legacy)).toBe(false);
      expect(fs.existsSync(`${legacy}.migrated`)).toBe(true);
      const imported = await history.getRecent({});
      expect(imported).toEqual([
        expect.objectContaining({
          kind: 'x402',
          amount: '7',
          status: 'no-receipt',
          createdAt: 1700000100 * 1000,
          metadata: { legacyId: expect.stringMatching(/^legacy:1700000100:no-receipt:8453/) },
        }),
        expect.objectContaining({
          kind: 'x402',
          amount: '500',
          txHash: hash(9),
          status: 'settled',
          asset: USDC,
          createdAt: 1700000000 * 1000,
          confirmedAt: 1700000000 * 1000,
          metadata: { legacyId: 'r-1' },
        }),
      ]);
    });
    // A later core finds it imported: nothing twice.
    await core.stop();
    core = makeCore(root);
    const again = loadMain(root, core);
    await core.start();
    expect(await again.history.getCount({})).toBe(2);
  });

  // Codex round 1 on #1299: an x402 row (appendOnce) the core didn't
  // answer is kept, read back at the core's next start, and written once.
  test('(T1) an x402 record made while the core is down is written once at its next start', async () => {
    core = makeCore(root);
    const main = loadMain(root, core);
    const { history } = main;
    const nonce = `0x${'ef'.repeat(32)}`;
    const record = {
      kind: 'x402',
      chainId: 8453,
      origin: 'https://x.example',
      url: 'https://x.example/a',
      asset: USDC,
      amount: '500',
      toAddress: RECIPIENT,
      status: 'settled',
      txHash: hash(7),
      metadata: { authorizationNonce: nonce },
    };
    const until = async (check) => {
      for (let i = 0; i < 100 && !(await check()); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    await asMain(async () => {
      history.attachCore(async () => ({ status: 'pending' }), core);
      await core.start();
      await core.stop();
      await expect(history.appendOnce(record)).resolves.toBeNull();
      expect(main.sent).toEqual([]);
      await core.start();
      await until(() => main.sent.length >= 2);
      const rows = await history.getRecent({ kind: 'x402' });
      expect(rows).toEqual([
        expect.objectContaining({
          amount: '500',
          txHash: hash(7),
          metadata: { authorizationNonce: nonce },
        }),
      ]);
      expect(main.sent).toEqual([
        [RECORDED, { id: rows[0].id, kind: 'x402', status: 'settled', txHash: hash(7) }],
        [RECORDED, { id: null }],
      ]);
      // Settled: a later start writes nothing more.
      await core.stop();
      await core.start();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await history.getCount({ kind: 'x402' })).toBe(1);
    });
  });

  test("Rollback: the reference reads the core's database as the core answers it", async () => {
    core = makeCore(root);
    const main = loadMain(root, core);
    const { history, vault } = main;
    let answers;
    await asMain(async () => {
      await core.start();
      const a = await history.append({
        kind: 'x402',
        chainId: 8453,
        amount: '10',
        status: 'settled',
        origin: 'https://a.example',
        url: 'https://a.example/x',
        asset: USDC,
        txHash: hash(1),
        metadata: { x402Version: 2 },
      });
      const b = await history.append({
        kind: 'wallet-send',
        chainId: 100,
        amount: '20',
        txHash: hash(2),
        fromAddress: SENDER,
        toAddress: RECIPIENT,
        metadata: { txFrom: SENDER, txNonce: 0 },
      });
      const c = await history.append({
        kind: 'safe-send',
        chainId: 100,
        amount: '30',
        txHash: hash(3),
      });
      await history.markConfirmed(b.id, { gasUsed: '21000', gasPrice: '5' });
      await history.repollPending(async () => ({ status: 'dropped' }));
      const d = await history.append({
        kind: 'dapp-send',
        chainId: 1,
        amount: '40',
        origin: 'https://d.example',
      });
      answers = {
        recent: await history.getRecent({}),
        x402: await history.getRecent({ kind: 'x402' }),
        paged: await history.getRecent({ limit: 2, offset: 1 }),
        byId: await Promise.all([a, b, c, d].map((row) => history.getById(row.id))),
        count: await history.getCount({}),
        countPending: await history.getCount({ status: 'pending' }),
        pending: await vault.payments.pending(),
        ids: [a, b, c, d].map((row) => row.id),
      };
    });
    expect(answers.pending.map((row) => row.id)).toEqual([answers.ids[2], answers.ids[3]]);
    await core.stop();
    core = null;
    const reference = loadReference(root);
    try {
      expect(reference.getRecent({})).toEqual(answers.recent);
      expect(reference.getRecent({ kind: 'x402' })).toEqual(answers.x402);
      expect(reference.getRecent({ limit: 2, offset: 1 })).toEqual(answers.paged);
      expect(answers.ids.map((id) => reference.getById(id))).toEqual(answers.byId);
      expect(reference.getCount({})).toBe(answers.count);
      expect(reference.getCount({ status: 'pending' })).toBe(answers.countPending);
      expect(reference.getDb().prepare(PENDING_SQL).all()).toEqual(answers.pending);
      // The sighting the core wrote is the one the reference's sweep reads.
      expect(JSON.parse(answers.pending[0].metadata)).toEqual({
        txDroppedSeenAt: expect.any(Number),
      });
    } finally {
      reference.closeDb();
    }
  });

  test('(T3) a hello naming none and the reference module: the core neither serves nor opens the database', async () => {
    core = makeCore(root, { storeMoved: [] });
    await core.start();
    expect(core.hello.store_moved).toEqual([]);
    const shell = { caller: 'shell' };
    const sweep = async () => {
      const writes = SET_A_WRITES.filter((write) => write.store === 'payments');
      expect(writes.map((write) => write.method)).toEqual(EVERY_METHOD.map(([method]) => method));
      for (const [method, params] of [
        ...writes.map((w) => [w.method, w.params]),
        ...EVERY_METHOD,
      ]) {
        const answer = await errorOf(core.request(method, params, shell));
        expect([method, answer.code, answer.data]).toEqual([
          method,
          'not_moved',
          { store: 'payments' },
        ]);
      }
      // The chrome's reads too.
      for (const [method, params] of EVERY_METHOD.filter(([m]) => /get_|clear/.test(m))) {
        const answer = await errorOf(core.request(method, params, { caller: 'chrome' }));
        expect([method, answer.code]).toEqual([method, 'not_moved']);
      }
      const open = dbFilesOpen(core.current.child.pid);
      if (open) expect(open).toEqual([]);
    };
    await sweep();
    for (const file of DB_FILES) expect(fs.existsSync(path.join(root, file))).toBe(false);

    // The reference keeps its own database, as the build before this step.
    const reference = loadReference(root);
    let row;
    try {
      row = reference.append({
        kind: 'wallet-send',
        chainId: 100,
        txHash: hash(1),
        amount: '1',
      });
      reference.markConfirmed(row.id, { gasUsed: '21000' });
      expect(reference.getCount({})).toBe(1);
    } finally {
      // Closed while the core is asked, so no connection of main's holds the
      // files (Windows can't read a -shm whose bytes SQLite locks).
      reference.closeDb();
    }
    const files = DB_FILES.map((file) => path.join(root, file));
    const before = digests(files);
    expect(before[files[0]]).not.toBeNull();
    await sweep();
    expect(digests(files)).toEqual(before);
    try {
      expect(reference.getById(row.id)).toMatchObject({ status: 'confirmed', gasUsed: '21000' });
    } finally {
      reference.closeDb();
    }
  });
});

describeIfPrevious('the payment history on the previous core release (T4)', () => {
  let root;
  let core;

  beforeEach(() => {
    root = makeRoot('payments-previous-');
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await core?.stop().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  test('every payments.* fails requirement_unmet in main, and no database exists', async () => {
    core = makeCore(root, { binary: previous });
    const main = loadMain(root, core);
    const { history, vault, invoke } = main;
    const unmet = { code: 'requirement_unmet', message: UNMET };
    await asMain(async () => {
      await core.start();
      expect(core.hello.store_moved).toEqual([]);
      expect(core.service.helloParams(core).store_moved).toContain('payments');
      for (const [name, call] of [
        [
          'append',
          () => history.append({ kind: 'x402', chainId: 1, amount: '1', status: 'settled' }),
        ],
        ['update', () => history.update(1, { status: 'confirmed' })],
        ['markConfirmed', () => history.markConfirmed(1, {})],
        ['markFailed', () => history.markFailed(1, {})],
        ['markDropped', () => history.markDropped(1)],
        ['getRecent', () => history.getRecent({})],
        ['getById', () => history.getById(1)],
        ['getCount', () => history.getCount({})],
        ['clear', () => history.clear()],
        ['repollPending', () => history.repollPending(async () => ({ status: 'confirmed' }))],
        ['setDroppedSeen', () => vault.payments.setDroppedSeen(1, 1)],
        ['pending', () => vault.payments.pending()],
      ]) {
        expect([name, await errorOf(call())]).toEqual([name, expect.objectContaining(unmet)]);
      }
      for (const [channel, arg] of [
        ['payments:get-recent', {}],
        ['payments:get-by-id', 1],
        ['payments:get-count', {}],
        ['payments:clear', undefined],
      ]) {
        expect([channel, await invoke(channel, arg)]).toEqual([
          channel,
          { success: false, error: UNMET },
        ]);
      }
      expect(main.sent).toEqual([]);
    });
    for (const file of DB_FILES) expect(fs.existsSync(path.join(root, file))).toBe(false);
    expect(main.opened).toEqual([]);
  });
});
