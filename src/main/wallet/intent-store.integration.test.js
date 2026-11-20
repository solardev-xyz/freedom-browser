/**
 * The intent journal through the real freedom-cored (freedom-core design
 * 0013, "The intent journal"; PRF-6(b2)): this build names `intents` in the
 * hello's `store_moved`, and the core is wallet-intents.jsonl's one writer.
 * Main's modules run as main runs them: intent-store.js (the adapter),
 * nonce-reservations.js and transaction-service.js's send path, over a
 * CoreClient on the binary; the chain and the broadcaster are mocked.
 *
 * - **(T1) The store and the send paths** on the pinned core: a send
 *   commits and hands off before its bytes reach the broadcaster, with
 *   main's run on every line, and records its outcome; `held_nonces`
 *   floors the next send's nonce under the account's lock (the sender
 *   checksummed, as signers give it); settle, track, withdraw and compact;
 *   void and retire under main's lock, sent as `lock: true`; the rules'
 *   refusals with their INTENT_* codes.
 * - **A core restart within one run of main** (coordinator call G10,
 *   `intents-core-restart`): the core reloads the file, so a held intent
 *   whose every handoff ended `not_sent` is recovered and can't be voided;
 *   its nonce stays reserved.
 * - **(T2)** Main writes no `wallet-intents.jsonl*` through any of the
 *   above (an `fs` spy).
 * - **(T3)** The reference store (9d4ea6251), with the hello before this
 *   step (`store_moved: []`), on the pinned core: the echo lacks the name,
 *   every intents.* write answers `not_moved` with `data.store`, the file's
 *   digest is unchanged by each request, the reads serve main's file
 *   read-only, and the reference's own writes still work.
 * - **(T4)** This step's modules on the previous release (0.22.0), which
 *   echoes no store: every intents.* request fails `requirement_unmet` in
 *   main, and a send fails before anything is signed or broadcast; nothing
 *   writes the file.
 * - **Rollback:** the reference store loads the file the core wrote, and
 *   its `list()` equals `intents.list`.
 *
 * Skipped without the binaries; FREEDOM_CORED_STORES_TEST=1 requires both
 * (npm run core:download, npm run core:download:previous). CI's
 * e2e-desktop job runs it on each OS.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Wallet, keccak256 } = require('ethers');
const { coredBinaries, digests, watchWrites } = require('../../../test/helpers/store-handover');
const { readJournal } = require('../../../test/helpers/reference-durable-journal');

const { current, previous } = coredBinaries();
const haveCurrent = !!(current && fs.existsSync(current));
const describeIfCurrent = haveCurrent ? describe : describe.skip;
const describeIfPrevious =
  haveCurrent && previous && fs.existsSync(previous) ? describe : describe.skip;

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
const FILE = 'wallet-intents.jsonl';
const INTENT_FILE = /wallet-intents\.jsonl/;
const UNMET = "The core can't take this request";
// Deterministic test keys (not real wallets).
const ALICE = new Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const BOB = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const RECIPIENT = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C';
const CHAIN = 100;
const PARAMS = {
  to: RECIPIENT,
  value: '1000',
  gasLimit: '21000',
  maxFeePerGas: '2000000000',
  maxPriorityFeePerGas: '1000000000',
  chainId: CHAIN,
};

jest.setTimeout(120_000);

const errorOf = (promise) =>
  promise.then(
    (result) => ({ result }),
    (err) => ({ code: err.code, data: err.data, message: err.message })
  );

describeIfCurrent('the intent journal through freedom-cored (0013, PRF-6(b2))', () => {
  let root;
  let file;
  let core;
  let chain;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'intents-core-')));
    file = path.join(root, FILE);
    fs.mkdirSync(path.join(root, 'identity'), { mode: 0o700 });
    fs.mkdirSync(path.join(root, 'locks'));
    core = null;
    // The chain: the account's pending count, and a broadcaster that sends.
    chain = {
      pending: 7,
      broadcasts: [],
      onBroadcast: null,
    };
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await core?.stop().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  /** A CoreClient on `binary` for this profile (Freedom root and grant root `root`). */
  function makeCore({ binary = current, storeMoved } = {}) {
    const { CoreClient, _internal } = require('../core/core-client');
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
    });
    if (storeMoved) client.service = _internal.coreService(storeMoved);
    return client;
  }

  /** Main's modules over `client`, fresh (a new run of main), with userData at `root`. */
  function loadMain(client) {
    jest.resetModules();
    jest.doMock('electron', () => ({
      app: { isPackaged: false, getPath: () => root, getVersion: () => 'jest' },
      ipcMain: { handle() {} },
      webContents: { getAllWebContents: () => [] },
    }));
    jest.doMock('../logger', () => quietLog);
    jest.doMock('../core/core-process', () => ({ getCoreClient: () => client }));
    jest.doMock('../networks/chain-data', () => ({
      request: async (_chainId, method) => {
        if (method === 'eth_getTransactionCount') {
          return { result: `0x${chain.pending.toString(16)}`, source: 'direct' };
        }
        throw new Error(`unexpected read ${method}`);
      },
      broadcastRawTransaction: async (chainId, raw) => {
        chain.broadcasts.push(raw);
        if (chain.onBroadcast) return chain.onBroadcast(chainId, raw);
        return { result: keccak256(raw), source: 'direct' };
      },
    }));
    jest.doMock('./chains', () => ({ getTxExplorerUrl: () => null }));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const mod = require('./intent-store');
    return {
      mod,
      store: mod.getIntentStore(),
      tx: require('./transaction-service'),
      reservations: require('./nonce-reservations'),
      vault: require('../core/vault-backend').vaultBackend,
    };
  }

  /** The reference store (9d4ea6251) over this profile's file, as an older build runs it. */
  function loadReference() {
    jest.resetModules();
    jest.doMock('electron', () => ({ app: { isPackaged: false, getPath: () => root } }));
    jest.doMock('../logger', () => quietLog);
    const reference = require('../../../test/helpers/reference-intent-store');
    return {
      reference,
      store: reference.getIntentStore(),
      reservations: require('./nonce-reservations'),
    };
  }

  /** A signer as signers.js gives one: a checksummed address. */
  function signerOf(wallet) {
    const signer = {
      signed: 0,
      getAddress: async () => wallet.address,
      signTransaction: async (tx) => {
        signer.signed += 1;
        return wallet.signTransaction(tx);
      },
    };
    return signer;
  }

  async function sign(nonce, wallet = ALICE) {
    const raw = await wallet.signTransaction({
      type: 2,
      chainId: CHAIN,
      nonce,
      to: RECIPIENT,
      value: 1000n,
      data: '0x',
      gasLimit: 21000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    });
    return { raw, hash: keccak256(raw) };
  }

  /** An original committed through `store`, with `context`. */
  async function commit(store, nonce, context = { kind: 'wallet-send' }, wallet = ALICE) {
    const { raw, hash } = await sign(nonce, wallet);
    return store.commit({
      chainId: CHAIN,
      sender: wallet.address,
      nonce,
      hash,
      raw,
      via: 'original',
      context,
    });
  }

  const records = async () => (await readJournal(file)).records;
  const underLock = (main, intent, fn) =>
    main.reservations.withAccountLock({ chainId: intent.chainId, sender: intent.sender }, fn);

  /** Runs `task` (main's operations) under the write spy, which must stay clean (T2). */
  async function asMain(task) {
    const watch = watchWrites(INTENT_FILE);
    try {
      await task();
      expect(watch.offending()).toEqual([]);
    } finally {
      watch.restore();
    }
  }

  test('(T1, T2) a send commits and hands off before its broadcast, and the next one goes above it', async () => {
    core = makeCore();
    const main = loadMain(core);
    const signer = signerOf(ALICE);
    let onDisk = null;
    chain.onBroadcast = async (_chainId, raw) => {
      onDisk ??= await records();
      return { result: keccak256(raw), source: 'direct' };
    };
    let first;
    let second;
    await asMain(async () => {
      await core.start();
      expect(core.hello.store_moved).toEqual(['intents']);
      await main.store.ready;
      first = await main.tx.signAndSendTransaction(PARAMS, signer);
      // The account's pending count still says 7: the held intent floors it.
      second = await main.tx.signAndSendTransaction(PARAMS, signer);
    });
    expect(first).toMatchObject({ nonce: 7, outcome: 'sent', from: ALICE.address });
    expect(second).toMatchObject({ nonce: 8, outcome: 'sent' });
    expect(onDisk.map((record) => record.type)).toEqual(['commit', 'handoff']);
    expect(onDisk[0]).toMatchObject({
      intent_id: first.intentId,
      nonce: 7,
      raw: chain.broadcasts[0],
    });
    const lines = await records();
    expect(lines.map((record) => [record.type, record.intent_id === first.intentId])).toEqual([
      ['commit', true],
      ['handoff', true],
      ['outcome', true],
      ['commit', false],
      ['handoff', false],
      ['outcome', false],
    ]);
    expect(new Set(lines.map((record) => record.run))).toEqual(new Set([main.mod.RUN_ID]));
    expect(lines[0].sender).toBe(ALICE.address.toLowerCase());
    await asMain(async () => {
      expect(await main.store.heldNonces(CHAIN, ALICE.address)).toEqual([7, 8]);
      expect((await main.store.get(first.intentId)).handoffs).toEqual([
        expect.objectContaining({ outcome: expect.objectContaining({ outcome: 'sent' }) }),
      ]);
    });
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  test('(T1, T2) settle, track, withdraw, compact, void and retire, with the INTENT_* codes', async () => {
    core = makeCore();
    const main = loadMain(core);
    const heard = [];
    await asMain(async () => {
      await core.start();
      main.store.onChange((id) => heard.push(id));
      const paid = await commit(main.store, 7);
      const site = await commit(main.store, 8, {
        kind: 'safe-send',
        origin: 'https://app.example',
        key: 'safe-exec:100:0xabc',
        walletIndex: 0,
      });
      expect(site.context).toEqual({
        kind: 'safe-send',
        origin: 'https://app.example',
        key: 'safe-exec:100:0xabc',
        walletIndex: 0,
      });
      expect(await main.store.byKey('safe-exec:100:0xabc')).toMatchObject({
        intentId: site.intentId,
      });

      // Refusals keep the reference's codes.
      expect(
        await errorOf(main.store.handoff('00000000-0000-4000-8000-000000000000'))
      ).toMatchObject({
        code: 'INTENT_UNKNOWN',
      });
      const { raw: other } = await sign(9);
      expect(
        await errorOf(
          main.store.commit({
            chainId: CHAIN,
            sender: ALICE.address,
            nonce: 7,
            hash: keccak256(other),
            raw: other,
            via: 'original',
            context: { kind: 'wallet-send' },
          })
        )
      ).toMatchObject({ code: 'INTENT_INVALID' });
      expect(
        await errorOf(
          main.store.settle({
            intentId: paid.intentId,
            label: 'paid',
            hash: paid.hash,
            block: 100,
            hashes: [site.hash],
          })
        )
      ).toMatchObject({ code: 'INTENT_CHANGED' });
      // Without main's lock nothing is sent.
      expect(await errorOf(main.store.void(paid.intentId, null))).toMatchObject({
        code: 'INTENT_LOCK_REQUIRED',
      });

      // The tracker's writes.
      const tracked = await main.store.track({
        intentId: site.intentId,
        bracket: { number: 99, hash: `0x${'ab'.repeat(32)}` },
        unreadSince: 5,
      });
      expect(tracked).toMatchObject({ bracket: { number: 99 }, unreadSince: 5 });
      const settled = await main.store.settle({
        intentId: paid.intentId,
        label: 'paid',
        hash: paid.hash,
        block: 100,
        hashes: [paid.hash],
      });
      expect(settled).toMatchObject({ state: 'settled', raw: null });
      expect(await errorOf(main.store.handoff(paid.intentId))).toMatchObject({
        code: 'INTENT_NOT_HELD',
        message: 'This payment is already settled.',
      });

      // The Safe executor's withdrawal, then a compaction.
      expect(await main.store.withdrawOrigin(site.intentId)).toBe(true);
      expect(await main.store.withdrawOrigin(site.intentId)).toBe(false);
      await main.store.compact();
      expect((await main.store.get(site.intentId)).context.origin).toBeNull();

      // Retire under the lock, for the hashes the user saw.
      const retired = await underLock(main, site, (lock) =>
        main.store.retire({ intentId: site.intentId, block: 120, hashes: [site.hash] }, lock)
      );
      expect(retired).toMatchObject({ state: 'retired', retirement: { block: 120 } });

      // A void: this run's intent whose only handoff ended not_sent.
      const dropped = await commit(main.store, 9);
      const handoff = await main.store.handoff(dropped.intentId);
      await main.store.outcome({
        intentId: dropped.intentId,
        handoffId: handoff.handoffId,
        outcome: 'not_sent',
      });
      expect(await main.store.voidRefusal(dropped.intentId)).toBeNull();
      const voided = await underLock(main, dropped, (lock) =>
        main.store.void(dropped.intentId, lock)
      );
      expect(voided).toMatchObject({ state: 'voided' });
      // Its nonce is free again.
      expect(await main.store.heldNonces(CHAIN, ALICE.address)).toEqual([]);
      const usage = await main.store.usage();
      expect(usage).toEqual({
        file: fs.statSync(file).size,
        owed: expect.any(Number),
        budget: expect.any(Number),
        limit: main.mod.LIMITS.journalBytes,
      });
    });
    // track and an unchanged withdrawal tell nobody.
    expect(heard).toHaveLength(9);
    const types = (await records()).map((record) => record.type);
    expect(types).not.toContain('commit');
    expect(types.filter((type) => type === 'tombstone')).toHaveLength(3);
  });

  test('a core restart within one run of main makes a held intent recovered (G10)', async () => {
    core = makeCore();
    const main = loadMain(core);
    const signer = signerOf(ALICE);
    chain.onBroadcast = async () => {
      throw Object.assign(new Error('refused before sending'), { outcome: 'not_sent' });
    };
    await asMain(async () => {
      await core.start();
      expect(await errorOf(main.tx.signAndSendTransaction(PARAMS, signer))).toMatchObject({
        message: expect.any(String),
      });
      const [held] = await main.store.held();
      expect(held).toMatchObject({ nonce: 7, recovered: false, possiblySent: false });
      expect(await main.store.voidRefusal(held.intentId)).toBeNull();

      await core.stop();
      await core.start();
      expect(core.hello.store_moved).toEqual(['intents']);
      expect(await main.store.get(held.intentId)).toMatchObject({ state: 'held', recovered: true });
      expect(await main.store.voidRefusal(held.intentId)).toMatch(/recovered from disk/);
      expect(
        await errorOf(underLock(main, held, (lock) => main.store.void(held.intentId, lock)))
      ).toMatchObject({ code: 'INTENT_VOID_REFUSED' });
      // Its nonce stays reserved, and its run is still main's.
      chain.onBroadcast = null;
      expect(await main.tx.signAndSendTransaction(PARAMS, signer)).toMatchObject({ nonce: 8 });
    });
    expect(new Set((await records()).map((record) => record.run))).toEqual(
      new Set([main.mod.RUN_ID])
    );
  });

  test('rollback: the reference store reads the file the core wrote, as the core does', async () => {
    core = makeCore();
    const main = loadMain(core);
    await asMain(async () => {
      await core.start();
      const a = await commit(main.store, 7);
      await commit(main.store, 3, { kind: 'wallet-send', key: 'k' }, BOB);
      const handoff = await main.store.handoff(a.intentId);
      await main.store.outcome({
        intentId: a.intentId,
        handoffId: handoff.handoffId,
        outcome: 'sent',
      });
      await main.store.settle({ intentId: a.intentId, label: 'paid', hash: a.hash, block: 9 });
      await commit(main.store, 8);
      // A new core loads the file and compacts it; the next one reads
      // what that wrote, as the reference will.
      await core.stop();
      await core.start();
      await main.store.usage();
      await core.stop();
      await core.start();
    });
    const { intents } = await main.vault.intents.list();
    const before = fs.readFileSync(file);
    await core.stop();
    core = null;
    const older = loadReference();
    await older.store.load();
    expect(older.store.list()).toEqual(intents);
    expect(older.store.heldNonces(CHAIN, ALICE.address)).toEqual([8]);
    expect(older.store.quarantined).toBeNull();
    // What the core wrote is what the reference's compaction writes.
    expect(fs.readFileSync(file)).toEqual(before);
  });

  test('(T3) the reference store and the hello before this step: the core writes nothing', async () => {
    core = makeCore({ storeMoved: [] });
    await core.start();
    expect(core.hello.store_moved).toEqual([]);
    const older = loadReference();
    await older.store.load();
    const intent = await commit(older.store, 7);
    const handoff = await older.store.handoff(intent.intentId);
    await older.store.outcome({
      intentId: intent.intentId,
      handoffId: handoff.handoffId,
      outcome: 'sent',
    });
    const before = digests([file]);
    const { SET_A_WRITES } = require('../../../test/helpers/store-handover');
    const writes = SET_A_WRITES.filter((write) => write.store === 'intents');
    expect(writes.map((write) => write.method)).toEqual([
      'intents.commit',
      'intents.handoff',
      'intents.outcome',
      'intents.settle',
      'intents.void',
      'intents.retire',
      'intents.track',
      'intents.withdraw_origin',
      'intents.compact',
    ]);
    // The writes with this very intent's members, too.
    const own = [
      ['intents.handoff', { run: older.reference.RUN_ID, intent_id: intent.intentId }],
      ['intents.withdraw_origin', { intent_id: intent.intentId }],
      ['intents.compact', {}],
    ];
    for (const [method, params] of [...writes.map((w) => [w.method, w.params]), ...own]) {
      const answer = await errorOf(core.request(method, params, { caller: 'shell' }));
      expect([method, answer.code, answer.data]).toEqual([
        method,
        'not_moved',
        { store: 'intents' },
      ]);
      expect(digests([file])).toEqual(before);
    }
    // Reads serve main's file, read-only.
    const read = (method, params = {}) => core.request(method, params, { caller: 'shell' });
    // What a fresh load of the file gives (compaction's fold included),
    // on a copy, since the reference's load may compact its file.
    const copy = path.join(root, 'copy.jsonl');
    fs.copyFileSync(file, copy);
    const fresh = older.reference.createIntentStore({ filePath: copy });
    await fresh.load();
    expect((await read('intents.list')).intents).toEqual(fresh.list());
    expect(
      (await read('intents.held_nonces', { chain_id: CHAIN, sender: ALICE.address })).nonces
    ).toEqual([7]);
    expect((await read('intents.get', { intent_id: intent.intentId })).intent).toMatchObject({
      intentId: intent.intentId,
      state: 'held',
    });
    expect((await read('intents.usage')).usage.file).toBe(fs.statSync(file).size);
    expect(digests([file])).toEqual(before);
    // The reference's own writes still work.
    await older.store.settle({
      intentId: intent.intentId,
      label: 'paid',
      hash: intent.hash,
      block: 9,
    });
    expect((await records()).at(-1)).toMatchObject({ type: 'settle', run: older.reference.RUN_ID });
  });
});

describeIfPrevious('the intent journal on the previous core release (T4)', () => {
  let root;
  let file;
  let core;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'intents-previous-')));
    file = path.join(root, FILE);
    fs.mkdirSync(path.join(root, 'identity'), { mode: 0o700 });
    fs.mkdirSync(path.join(root, 'locks'));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await core?.stop().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  test('every intents.* fails requirement_unmet, and a send signs and broadcasts nothing', async () => {
    const { CoreClient } = require('../core/core-client');
    core = new CoreClient({
      spawn,
      command: previous,
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
    });
    jest.resetModules();
    jest.doMock('electron', () => ({
      app: { isPackaged: false, getPath: () => root, getVersion: () => 'jest' },
      ipcMain: { handle() {} },
      webContents: { getAllWebContents: () => [] },
    }));
    jest.doMock('../logger', () => quietLog);
    jest.doMock('../core/core-process', () => ({ getCoreClient: () => core }));
    const broadcasts = [];
    const reads = [];
    jest.doMock('../networks/chain-data', () => ({
      request: async (_chainId, method) => {
        reads.push(method);
        return { result: '0x7', source: 'direct' };
      },
      broadcastRawTransaction: async (_chainId, raw) => {
        broadcasts.push(raw);
        return { result: keccak256(raw), source: 'direct' };
      },
    }));
    jest.doMock('./chains', () => ({ getTxExplorerUrl: () => null }));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const store = require('./intent-store').getIntentStore();
    const tx = require('./transaction-service');
    const { vaultBackend } = require('../core/vault-backend');
    let signed = 0;
    const signer = {
      getAddress: async () => ALICE.address,
      signTransaction: async (t) => {
        signed += 1;
        return ALICE.signTransaction(t);
      },
    };

    const watch = watchWrites(INTENT_FILE);
    try {
      await core.start();
      expect(core.hello.store_moved).toEqual([]);
      const unmet = { code: 'requirement_unmet', message: UNMET };
      expect(await errorOf(store.ready)).toMatchObject(unmet);
      const id = { intent_id: '00000000-0000-4000-8000-000000000000' };
      const run = require('./intent-store').RUN_ID;
      for (const [name, params] of [
        [
          'commit',
          {
            run,
            chain_id: CHAIN,
            sender: ALICE.address,
            nonce: 7,
            hash: '0x00',
            raw: '0x00',
            via: 'original',
          },
        ],
        ['handoff', { run, ...id }],
        ['outcome', { run, ...id, handoff_id: 'h', outcome: 'sent' }],
        ['settle', { run, ...id, label: 'paid', hash: null, block: 1 }],
        ['void', { run, ...id, lock: true }],
        ['retire', { run, ...id, block: 1, hashes: ['0x00'], lock: true }],
        ['track', { run, ...id, bracket: null }],
        ['withdrawOrigin', id],
        ['compact', undefined],
        ['get', id],
        ['byKey', { key: 'k' }],
        ['held', undefined],
        ['list', undefined],
        ['heldNonces', { chain_id: CHAIN, sender: ALICE.address }],
        ['usage', undefined],
        ['voidRefusal', { ...id, run }],
      ]) {
        expect([name, await errorOf(vaultBackend.intents[name](params))]).toEqual([
          name,
          expect.objectContaining(unmet),
        ]);
      }
      expect(await errorOf(store.held())).toMatchObject(unmet);
      expect(await errorOf(store.heldNonces(CHAIN, ALICE.address))).toMatchObject(unmet);
      // A send fails before its signature: nothing signed, read or broadcast.
      expect(await errorOf(tx.signAndSendTransaction(PARAMS, signer))).toMatchObject(unmet);
      expect(signed).toBe(0);
      expect(broadcasts).toEqual([]);
      expect(reads).toEqual([]);
      expect(watch.offending()).toEqual([]);
    } finally {
      watch.restore();
    }
    expect(fs.existsSync(file)).toBe(false);
  });
});
