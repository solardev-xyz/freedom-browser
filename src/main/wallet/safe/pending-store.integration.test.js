/**
 * safe-pending.json through the real freedom-cored (freedom-core design
 * 0013, PRF-6(d)): the core is the file's only writer, and this build's
 * hello names `safe_pending` in `store_moved`.
 *
 * - (T1) pending-store.js and the Safe flows over it (safe-transactions.js,
 *   with the unit suite's stubs for the chain, the devices and the records)
 *   against the pinned core: main's copy loads the file an older build left
 *   at the core's start; a send is saved with its free signature, an
 *   owner's signature joins it, its execution clears it; a discard clears
 *   it; each request is main's own (`shell`) and needs the echo. A deleted
 *   Safe's entry, cleared by the core in `accounts.remove`, is in
 *   src/main/identity-manager.integration.test.js.
 * - (T2) main writes no `safe-pending.json`: a spy on `fs`.
 * - (T3) the reference pending-store.js (test/helpers/reference-pending-store.js,
 *   9d4ea6251), with a client sending the hello of a build before PRF-6
 *   (no `store_moved`, no `requires`), on the pinned core: `set` and `clear`
 *   answer `not_moved` (`safe_pending`), `get` and `list` serve the
 *   reference's file, an unreadable one stays where it is, and no core
 *   request changes the file.
 * - (T4) this step's modules on the previous core release (0.22.0), which
 *   echoes no store: every request fails `requirement_unmet` in main, a send
 *   builds nothing, and no file appears or changes.
 * - Rollback: the reference loads the file the core wrote and sees what the
 *   core's `list` and `get` answer, in the file's key order.
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
  watchWrites,
} = require('../../../../test/helpers/store-handover');
const { ownerWallet } = require('./__tests__/helpers/test-owners');

const { current, previous } = coredBinaries();
const describeIfCurrent = current && fs.existsSync(current) ? describe : describe.skip;
const describeIfPrevious =
  current && previous && fs.existsSync(previous) ? describe : describe.skip;

// The profile's directory (the Freedom root, and the core's grant root) and
// the client main's modules reach, set by each describe.
let mockUserData;
let mockClient = null;
jest.mock('electron', () => ({
  app: { getPath: () => mockUserData },
}));
jest.mock('../../core/core-process', () => ({
  getCoreClient: () => mockClient,
}));

// The unit suite's stubs (safe-transactions.test.js): wallet records, the
// chain's nonce, and the build, signatures and execution.
const MOCK_OWNERS = [ownerWallet(0).address, ownerWallet(2).address, ownerWallet(4).address];
const MOCK_SAFE_ADDRESS = '0x41aD4887971f90BB3fE4d83eCa65177281283261';
const SAFE_TX_HASH = `0x${'cd'.repeat(32)}`;
const MOCK_TX_HASH = `0x${'ab'.repeat(32)}`;
jest.mock('../../identity-manager', () => {
  const records = {
    0: { index: 0, name: 'Main Wallet', address: MOCK_OWNERS[0], type: 'mnemonic' },
    2: { index: 2, name: 'My Stax', address: MOCK_OWNERS[1], type: 'ledger' },
    4: { index: 4, name: 'My Phone', address: MOCK_OWNERS[2], type: 'remote' },
    5: {
      index: 5,
      name: 'Joint',
      address: MOCK_SAFE_ADDRESS,
      type: 'safe',
      owners: [0, 2, 4],
      threshold: 2,
      saltNonce: '7508',
      deployed: { 100: true },
    },
  };
  return {
    getWalletRecord: (index) => records[index] || null,
    isVaultUnlocked: async () => true,
    WALLET_TYPES: { MNEMONIC: 'mnemonic', LEDGER: 'ledger', REMOTE: 'remote', SAFE: 'safe' },
  };
});
const mockSignatureOf = (index) => ({
  signer: MOCK_OWNERS[index === 0 ? 0 : index === 2 ? 1 : 2],
  data: `0x${'ee'.repeat(65)}`,
});
const builtResult = {
  safeAddress: MOCK_SAFE_ADDRESS,
  safeTxData: { to: MOCK_OWNERS[2], value: '1000', data: '0x', nonce: 3 },
  safeTxHash: SAFE_TX_HASH,
  typedData: { domain: {}, types: {}, message: {} },
};
const mockBuildSafeTransaction = jest.fn(async () => builtResult);
jest.mock('./safe-executor', () => ({
  buildSafeTransaction: (...args) => mockBuildSafeTransaction(...args),
  collectOwnerSignature: async ({ ownerIndex }) => mockSignatureOf(ownerIndex),
  execTransaction: async () => ({
    hash: MOCK_TX_HASH,
    explorerUrl: `https://gnosisscan.io/tx/${MOCK_TX_HASH}`,
  }),
  withdrawExecutionSite: async () => true,
  pickDefaultExecutor: jest.requireActual('./safe-executor').pickDefaultExecutor,
}));
jest.mock('../provider-manager', () => ({
  getEip1193Provider: () => ({ request: async () => '0x3' }),
}));

const pendingStore = require('./pending-store');
const safeTransactions = require('./safe-transactions');
const safeApprovals = require('./safe-approvals');
const { vaultBackend } = require('../../core/vault-backend');

const PENDING_FILE = /safe-pending\.json/;
const shell = { caller: 'shell' };
const DISPLAY = {
  toAddress: MOCK_OWNERS[2],
  asset: null,
  amount: '1000',
  symbol: 'xDAI',
  decimals: 18,
};
const TX = { to: MOCK_OWNERS[2], value: '1000', data: '0x' };
let approvals = 0;
const newApproval = () => ({ id: (++approvals).toString(16).padStart(32, '0'), page: null });

const errorOf = (promise) =>
  promise.then(
    (result) => ({ result }),
    (err) => ({ code: err.code, data: err.data, message: err.message })
  );

// A send as both routes start one: reserved, then started with its approval.
async function start() {
  const reservation = safeTransactions.reserveSafeSend(5);
  try {
    return await safeTransactions.startSafeSend({
      safeIndex: 5,
      tx: TX,
      display: DISPLAY,
      chainId: 100,
      approval: newApproval(),
      reservation,
    });
  } finally {
    reservation.release();
  }
}

// What an older build, or the test, writes: the spy on main's `fs` doesn't
// see it (writeFileSync opens through the exported openSync, which it spies).
const openAsOlderBuild = fs.openSync;
function writeAsOlderBuild(file, text) {
  const fd = openAsOlderBuild(file, 'w', 0o600);
  try {
    fs.writeSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
}

/** A profile root for one describe: the Freedom root, the core's grant root. */
function profile(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const file = path.join(root, 'safe-pending.json');
  return {
    root,
    file,
    text: () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null),
    read: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    // As an older build wrote it: the reference's text.
    seed: (store) => writeAsOlderBuild(file, JSON.stringify(store, null, 2)),
  };
}

/** The reference store, loaded afresh: how an older build reads the file. */
function freshReference() {
  let reference;
  jest.isolateModules(() => {
    reference = require('../../../../test/helpers/reference-pending-store');
  });
  return reference;
}

/**
 * Records every request main sends `core`: `{ method, params, context,
 * options, gen }`, `gen` the process a request was sent to by name
 * (`requestTo`), as the pending store sends each of its own.
 */
function recordCalls(core) {
  const calls = [];
  const request = core.request.bind(core);
  core.request = (method, params, context, options) => {
    calls.push({ method, params, context, options, gen: null });
    return request(method, params, context, options);
  };
  const requestTo = core.requestTo.bind(core);
  core.requestTo = (gen, method, params, context, options) => {
    calls.push({ method, params, context, options, gen });
    return requestTo(gen, method, params, context, options);
  };
  return calls;
}

describeIfCurrent('safe-pending.json through the pinned freedom-cored (T1, T2, rollback)', () => {
  let p;
  let core;
  let calls;
  let watch;
  const older = {
    9: {
      safeTxHash: `0x${'99'.repeat(32)}`,
      threshold: 1,
      signatures: [],
      createdAt: 1700000000000,
    },
  };

  beforeAll(async () => {
    p = profile('safe-pending-core-');
    mockUserData = p.root;
    // Left by a build before PRF-6(d).
    p.seed(older);
    pendingStore._reset();
    core = await startCore({
      binary: current,
      root: p.root,
      beforeStart: (client) => {
        mockClient = client;
        calls = recordCalls(client);
        // core-process.js attaches it before the first start.
        pendingStore.attachCore(client);
      },
    });
    await pendingStore.ready;
  });

  afterAll(async () => {
    await core?.stop();
    mockClient = null;
    if (p) fs.rmSync(p.root, { recursive: true, force: true });
  });

  beforeEach(() => {
    calls.length = 0;
    // The approvals' end is the unit suite's stub: no SafeTx here has one in the core.
    vaultBackend.approval.end = jest.fn(async () => ({}));
    safeApprovals._reset({ retryDelays: [0, 0] });
    watch = watchWrites(PENDING_FILE);
  });

  afterEach(() => {
    // (T2) Main writes no safe-pending.json: the core is its only writer.
    try {
      expect(watch.offending()).toEqual([]);
    } finally {
      watch.restore();
    }
  });

  test("the build's hello names safe_pending, and the core echoes it", () => {
    expect(core.service.helloParams(core).store_moved).toContain('safe_pending');
    expect(core.hello.store_moved).toContain('safe_pending');
  });

  test("main's copy loaded the file an older build left at the core's start, which reading left as it was", () => {
    expect(pendingStore.listPendingIndexes()).toEqual([9]);
    expect(pendingStore.getPending(9)).toEqual(older[9]);
    expect(p.text()).toBe(JSON.stringify(older, null, 2));
  });

  test('a send is saved with its free signature, an owner joins it, and its execution clears it', async () => {
    await expect(start()).resolves.toMatchObject({ collected: 1, status: 'awaiting' });
    const saved = await vaultBackend.safePending.get(5);
    expect(saved).toEqual(pendingStore.getPending(5));
    expect(saved).toMatchObject({
      safeTxHash: SAFE_TX_HASH,
      signatures: [mockSignatureOf(0)],
      display: DISPLAY,
    });
    // In the reference's text, beside the older entry.
    expect(p.text()).toBe(JSON.stringify({ ...older, 5: saved }, null, 2));

    const held = pendingStore.getPending(5);
    await expect(safeTransactions.signSafePending(5, 2)).resolves.toMatchObject({ collected: 2 });
    expect(pendingStore.getPending(5)).toBe(held);
    expect((await vaultBackend.safePending.get(5)).signatures).toEqual([
      mockSignatureOf(0),
      mockSignatureOf(2),
    ]);

    await expect(safeTransactions.executeSafePending(5)).resolves.toMatchObject({
      status: 'executed',
      executed: { hash: MOCK_TX_HASH },
    });
    expect(pendingStore.getPending(5)).toBeNull();
    await expect(vaultBackend.safePending.get(5)).resolves.toBeNull();
    expect(await vaultBackend.safePending.list()).toEqual([9]);
    expect(p.read()).toEqual(older);
  });

  test('a discard clears it in the core', async () => {
    await start();
    expect(await vaultBackend.safePending.list()).toEqual([5, 9]);
    await safeTransactions.cancelSafeSend(5, { safeTxHash: SAFE_TX_HASH });
    expect(pendingStore.getPending(5)).toBeNull();
    expect(await vaultBackend.safePending.list()).toEqual([9]);
    expect(p.read()).toEqual(older);
  });

  test("each request is main's own, goes to the process main's copy is from, and needs the core's echo of safe_pending", async () => {
    await pendingStore.setPending(7, { safeTxHash: '0x07', threshold: 1, signatures: [] });
    await pendingStore.clearPending(7);
    await pendingStore.refreshPending(9);
    const store = calls.filter(({ method }) => method.startsWith('safe_pending.'));
    expect(store.map(({ method }) => method)).toEqual([
      'safe_pending.set',
      'safe_pending.clear',
      'safe_pending.get',
    ]);
    for (const { context, options, gen } of store) {
      // To the process whose copy main holds, by name.
      expect(gen).toBe(core.current);
      expect(context).toEqual(shell);
      expect(options.requires(core.hello)).toBe(true);
      expect(options.requires({ store_moved: ['vault_meta'] })).toBe(false);
    }
    // A clear of an index with none writes nothing, and says so.
    await expect(core.request('safe_pending.clear', { index: 7 }, shell)).resolves.toEqual({
      cleared: false,
      durable: true,
    });
  });

  test("rollback: the reference loads the core's file and sees what the core answers, in the file's key order", async () => {
    const big = 2 ** 40;
    await pendingStore.setPending(big, { safeTxHash: '0xbig', threshold: 1, signatures: [] });
    await pendingStore.setPending(3, {
      safeTxHash: '0x03',
      threshold: 2,
      signatures: [mockSignatureOf(0)],
    });
    const indices = await vaultBackend.safePending.list();
    // JS's key order: the array indices ascending, then the larger ones as set.
    expect(indices).toEqual([3, 9, big]);
    const reference = freshReference();
    expect(reference.listPendingIndexes()).toEqual(indices);
    for (const index of indices) {
      expect(reference.getPending(index)).toEqual(await vaultBackend.safePending.get(index));
      expect(reference.getPending(index)).toEqual(pendingStore.getPending(index));
    }
    const text = p.text();
    expect(JSON.stringify(JSON.parse(text), null, 2)).toBe(text);
    await pendingStore.clearPending(big);
    await pendingStore.clearPending(3);
  });
});

describeIfCurrent(
  'the reference with the hello of a build before PRF-6, on the pinned freedom-cored (T3)',
  () => {
    let p;
    let core;
    let reference;
    let changed;

    beforeAll(async () => {
      p = profile('safe-pending-prestep-');
      mockUserData = p.root;
      core = await startCore({
        binary: current,
        root: p.root,
        storeMoved: [],
        beforeStart: (client) => {
          // The build before PRF-6 sends no `requires`. No core request
          // changes safe-pending.json: each is checked before and after.
          changed = [];
          const request = client.request.bind(client);
          client.request = async (method, params, context, options = {}) => {
            const before = p.text();
            try {
              return await request(method, params, context, { ...options, requires: null });
            } finally {
              if (p.text() !== before) changed.push(method);
            }
          };
        },
      });
      reference = () => freshReference();
    });

    afterAll(async () => {
      await core?.stop();
      if (p) fs.rmSync(p.root, { recursive: true, force: true });
    });

    afterEach(() => {
      expect(changed).toEqual([]);
    });

    test('the echo lacks safe_pending', () => {
      expect(core.service.helloParams(core).store_moved).toEqual([]);
      expect(core.hello.store_moved).toEqual([]);
    });

    test("set and clear answer not_moved (safe_pending); get and list serve the reference's writes", async () => {
      const entry = { safeTxHash: SAFE_TX_HASH, threshold: 2, signatures: [mockSignatureOf(0)] };
      reference().setPending(5, entry);
      reference().setPending(6, { safeTxHash: '0x06', threshold: 1, signatures: [] });
      const text = p.text();
      expect(await core.request('safe_pending.list', {}, shell)).toEqual({ indices: [5, 6] });
      expect(await core.request('safe_pending.get', { index: 5 }, shell)).toEqual({ entry });
      expect(await core.request('safe_pending.get', { index: 8 }, shell)).toEqual({ entry: null });
      for (const [method, params] of [
        ['safe_pending.set', { index: 5, entry: { safeTxHash: '0x00' } }],
        ['safe_pending.set', { index: 7, entry: { safeTxHash: '0x07' } }],
        ['safe_pending.clear', { index: 5 }],
        ['safe_pending.clear', { index: 8 }],
      ]) {
        const answer = await errorOf(core.request(method, params, shell));
        expect([method, answer.code, answer.data?.store]).toEqual([
          method,
          'not_moved',
          'safe_pending',
        ]);
      }
      expect(p.text()).toBe(text);
      // The reference's own writes still work, and the core reads them.
      reference().clearPending(6);
      expect(await core.request('safe_pending.list', {}, shell)).toEqual({ indices: [5] });
    });

    test('an unreadable file reads as empty, and stays where it is', async () => {
      fs.writeFileSync(p.file, '{ not json', 'utf8');
      expect(await core.request('safe_pending.list', {}, shell)).toEqual({ indices: [] });
      expect(await core.request('safe_pending.get', { index: 5 }, shell)).toEqual({ entry: null });
      expect(p.text()).toBe('{ not json');
      expect(fs.readdirSync(p.root).filter((name) => name.startsWith('safe-pending'))).toEqual([
        'safe-pending.json',
      ]);
    });
  }
);

describeIfPrevious("this step's pending store on the previous freedom-cored release (T4)", () => {
  let p;
  let core;
  let watch;
  const older = { 5: { safeTxHash: SAFE_TX_HASH, threshold: 2, signatures: [] } };

  beforeAll(async () => {
    p = profile('safe-pending-previous-');
    mockUserData = p.root;
    pendingStore._reset();
    core = await startCore({
      binary: previous,
      root: p.root,
      // 0.22.0 doesn't know serve's grant arguments (design 0017, C1).
      grantArgs: false,
      beforeStart: (client) => {
        mockClient = client;
      },
    });
  });

  afterAll(async () => {
    await core?.stop();
    mockClient = null;
    if (p) fs.rmSync(p.root, { recursive: true, force: true });
  });

  beforeEach(() => {
    vaultBackend.approval.end = jest.fn(async () => ({}));
    safeApprovals._reset({ retryDelays: [0, 0] });
    mockBuildSafeTransaction.mockClear();
    watch = watchWrites(PENDING_FILE);
  });

  afterEach(() => {
    try {
      expect(watch.offending()).toEqual([]);
    } finally {
      watch.restore();
    }
  });

  test('the hello names safe_pending, and the previous release echoes none', () => {
    expect(core.service.helloParams(core).store_moved).toContain('safe_pending');
    expect(core.hello.store_moved).toEqual([]);
  });

  test('every request fails requirement_unmet in main, a send builds nothing, and no file appears', async () => {
    const unmet = { code: 'requirement_unmet' };
    await expect(pendingStore.ready).rejects.toMatchObject(unmet);
    await expect(pendingStore.setPending(5, older[5])).rejects.toMatchObject(unmet);
    await expect(pendingStore.clearPending(5)).rejects.toMatchObject(unmet);
    await expect(vaultBackend.safePending.get(5)).rejects.toMatchObject(unmet);
    await expect(vaultBackend.safePending.list()).rejects.toMatchObject(unmet);
    await expect(start()).rejects.toMatchObject(unmet);
    await expect(safeTransactions.cancelSafeSend(5)).rejects.toMatchObject(unmet);
    expect(mockBuildSafeTransaction).not.toHaveBeenCalled();
    expect(pendingStore.getPending(5)).toBeNull();
    expect(fs.existsSync(p.file)).toBe(false);
  });

  test('a file an older build left is neither read into main nor changed', async () => {
    p.seed(older);
    const text = p.text();
    await expect(pendingStore.ready).rejects.toMatchObject({ code: 'requirement_unmet' });
    await expect(
      pendingStore.setPending(5, { ...older[5], superseded: true })
    ).rejects.toMatchObject({
      code: 'requirement_unmet',
    });
    expect(pendingStore.getPending(5)).toBeNull();
    expect(p.text()).toBe(text);
  });
});
