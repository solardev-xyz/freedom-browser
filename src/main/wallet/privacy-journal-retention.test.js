const fs = require('fs'), os = require('os'), path = require('path');
const { createPrivacyScope } = require('../networks/privacy-context');
const { createSubmissionJournal } = require('./private-submission-journal');
const { createPPv2RelayJournal } = require('./ppv2-relay-journal');
const { createJournalArchiver } = require('./privacy-journal-archiver');
const { createPrivacyStorage } = require('./privacy-storage');
const { MINIMUM_AGE_MS, ARCHIVE_MAX } = require('./privacy-journal-retention');
const { validateRelay } = require('./ppv2-relay-policy');
const { relayFixture, word } = require('../../../test/helpers/ppv2-relay-fixture');
const accept = async () => ({ archiveResolvedHistory: true, stopRevalidating: true, acceptedEvidence: 'unverified-rpc' });

describe.each(['public', 'relay'])('%s history retention', (kind) => {
  let scope, handle, directory, journal, archive, now, rpc, config;
  const key = Buffer.alloc(32, 17), storageKey = kind === 'public' ? 'submissions-v1' : 'relay-attempts-v1';
  const identifier = (i) => word(100 + i);
  const factory = kind === 'public' ? createSubmissionJournal : createPPv2RelayJournal;
  async function add(i, resolve = true) {
    if (kind === 'public') await journal.begin(identifier(i), i);
    else {
      const { attempt, settlement } = validateRelay(relayFixture());
      await journal.begin({ ...attempt, id: identifier(i), nullifier: word(200 + i), commitment: word(300 + i) }, settlement);
    }
    if (!resolve) return;
    await journal.observe(identifier(i), kind === 'public'
      ? { status: 'included', blockNumber: i + 1, blockHash: word(10001 + i), confirmations: 20, observedAt: now, trust: 'unverified' }
      : { status: 'included', blockNumber: i + 1, blockHash: word(10001 + i), transactionHash: word(500 + i), trust: 'unverified-rpc' }, 0);
    await journal.resolve(identifier(i), 1, 1);
  }
  beforeEach(() => {
    now = Date.now(); jest.spyOn(Date, 'now').mockImplementation(() => now);
    scope = createPrivacyScope({ profileId: 'retention-fixture', signal: new AbortController().signal });
    handle = scope.getContext(kind === 'public'
      ? { kind: 'public-address', principal: `0x${'11'.repeat(20)}`, role: 'transaction-rpc', chainId: 11155111 }
      : { kind: 'private-account', principal: 'ppv2:0', role: 'storage', protocol: 'privacy-pools-v2', deployment: 'sepolia', chainId: 11155111 });
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-retention-'));
    config = { handle, directory, key }; journal = factory(config);
    rpc = { request: jest.fn(async (method, params, valid) => {
      const n = params[0] === 'finalized' ? 4095 : Number(BigInt(params[0] || '0x0'));
      const value = method === 'eth_blockNumber' ? '0x1000' : { number: `0x${n.toString(16)}`, hash: word(10000 + n) };
      if (!valid(value)) throw new Error('Invalid fixture'); return { result: value };
    }) };
    archive = createJournalArchiver({ journal, kind, lifetime: scope.signal, assertActive: () => require('../networks/privacy-context').getPrivacyContext(handle),
      withRpc: (_record, _signal, task) => task(rpc) });
  });
  afterEach(() => { scope.close(); jest.restoreAllMocks(); });

  test('frees live capacity after explicit review without losing permanent reuse guards across restart', async () => {
    for (let i = 0; i < 64; i++) await add(i);
    now += MINIMUM_AGE_MS + 1;
    const review = jest.fn(accept);
    expect(await archive({ review })).toMatchObject({ archived: 16, retained: 16, stopsRevalidation: true });
    expect(review.mock.calls[0][0]).toMatchObject({ action: 'archive-final-history', evidence: 'unverified-rpc', stopsRevalidation: true });
    journal = factory(config);
    expect(await journal.list()).toHaveLength(48); expect(await journal.listArchive()).toHaveLength(16);
    await expect(add(0, false)).rejects.toMatchObject({ code: kind === 'public' ? 'PRIVATE_BROADCAST_ALREADY_ATTEMPTED' : 'PRIVATE_PPV2_RELAY_REUSE_REFUSED' });
    if (kind === 'public') {
      expect(await journal.has(identifier(0))).toBe(true);
      await expect(journal.begin(word(999), 0)).rejects.toMatchObject({ code: 'PRIVATE_NONCE_REUSE_REFUSED' });
    } else {
      await expect(journal.assertCanExit(word(300))).rejects.toMatchObject({ code: 'PRIVATE_PPV2_RELAY_REUSE_REFUSED' });
      await expect(journal.assertCanExit(word(316))).rejects.toMatchObject({ code: 'PRIVATE_PPV2_RELAY_REUSE_REFUSED' });
      const { attempt, settlement } = validateRelay(relayFixture());
      for (const reused of [{ nullifier: word(200) }, { commitment: word(300) }]) {
        await expect(journal.begin({ ...attempt, id: word(999), nullifier: word(998), commitment: word(997), ...reused }, settlement))
          .rejects.toMatchObject({ code: 'PRIVATE_PPV2_RELAY_REUSE_REFUSED' });
      }
    }
    await add(64, false); // A 65th operation, including a public emergency exit, now has a slot.
    await expect(journal.assertCanSubmit()).rejects.toMatchObject({ code: kind === 'public' ? 'PRIVATE_SUBMISSION_UNRESOLVED' : 'PRIVATE_PPV2_RELAY_UNRESOLVED' });
    expect(await journal.listArchive()).toHaveLength(16);
  });

  test.each(['young', 'unresolved', 'declined', 'missing-consent', 'rpc', 'not-finalized', 'changed-finality', 'revision'])('refuses %s archival without losing records', async (failure) => {
    await add(0, failure !== 'unresolved');
    if (failure !== 'young') now += MINIMUM_AGE_MS + 1;
    const before = await journal.list();
    if (failure === 'rpc') rpc.request.mockRejectedValueOnce(Object.assign(new Error('Unavailable'), { code: 'PRIVATE_RPC_UNAVAILABLE' }));
    if (failure === 'not-finalized') rpc.request.mockImplementation(async (method, _params) => ({ result: method === 'eth_blockNumber' ? '0x1000' : { number: '0x0', hash: word(10000) } }));
    const review = async () => {
      if (failure === 'revision') await journal.observe(identifier(0), before[0].observation, before[0].revision);
      if (failure === 'changed-finality') {
        const original = rpc.request.getMockImplementation();
        rpc.request.mockImplementation(async (...args) => {
          const response = await original(...args);
          if (response.result?.number === '0xfff') response.result.hash = word(55);
          return response;
        });
      }
      return failure === 'declined' ? {} : failure === 'missing-consent'
        ? { archiveResolvedHistory: true, acceptedEvidence: 'unverified-rpc' } : accept();
    };
    await expect(archive({ review })).rejects.toMatchObject({ code: failure === 'rpc' ? 'PRIVATE_RPC_UNAVAILABLE' : 'PRIVATE_HISTORY_ARCHIVE_REFUSED' });
    expect(await journal.listArchive()).toEqual([]);
    if (failure !== 'revision') expect(await journal.list()).toEqual(before);
    else expect((await journal.list())[0].revision).toBe(before[0].revision + 1);
  });

  test('confirmed canonical conflict revokes resolution and never archives it', async () => {
    await add(0); now += MINIMUM_AGE_MS + 1;
    const original = rpc.request.getMockImplementation();
    rpc.request.mockImplementation(async (...args) => {
      const value = await original(...args); if (value.result?.number === '0x1') value.result.hash = word(56); return value;
    });
    const review = jest.fn(accept); await expect(archive({ review })).rejects.toMatchObject({ code: 'PRIVATE_HISTORY_ARCHIVE_REFUSED' });
    expect(review).not.toHaveBeenCalled(); expect(await journal.listArchive()).toEqual([]);
    expect((await journal.list())[0].resolution).toBeNull();
    await expect(journal.assertCanSubmit()).rejects.toMatchObject({ code: kind === 'public' ? 'PRIVATE_SUBMISSION_UNRESOLVED' : 'PRIVATE_PPV2_RELAY_UNRESOLVED' });
  });

  test('archived evidence is no longer queried by ordinary reconciliation', async () => {
    await add(0); now += MINIMUM_AGE_MS + 1; await archive({ review: accept }); rpc.request.mockClear();
    if (kind === 'public') {
      const reconcile = require('./private-submission-reconciler').createSubmissionReconciler({ rpc, journal,
        principal: `0x${'11'.repeat(20)}`, assertActive: () => {} });
      await reconcile.refreshResolved(); expect(rpc.request).not.toHaveBeenCalled();
    } else {
      const getOperationHandle = jest.fn();
      const reconcile = require('./ppv2-relay-reconciliation').createPPv2RelayReconciliation({ journal, getOperationHandle,
        handle: scope.getContext({ kind: 'private-account', principal: 'ppv2:0', role: 'protocol-rpc',
          protocol: 'privacy-pools-v2', deployment: 'sepolia', chainId: 11155111 }) });
      await reconcile.refreshResolved(); expect(getOperationHandle).not.toHaveBeenCalled();
    }
  });

  test('vault lifetime cancellation prevents a late archive commit', async () => {
    await add(0); now += MINIMUM_AGE_MS + 1;
    let release, entered;
    const ready = new Promise((resolve) => { entered = resolve; });
    const pending = archive({ review: () => { entered(); return new Promise((resolve) => { release = resolve; }); } });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'PRIVATE_HISTORY_ARCHIVE_REFUSED' });
    await ready; scope.close(); await rejected;
    release(await accept()); await new Promise((resolve) => setImmediate(resolve));
    const next = createPrivacyScope({ profileId: 'retention-fixture', signal: new AbortController().signal });
    const subject = kind === 'public' ? { kind: 'public-address', principal: `0x${'11'.repeat(20)}`, role: 'transaction-rpc', chainId: 11155111 }
      : { kind: 'private-account', principal: 'ppv2:0', role: 'storage', protocol: 'privacy-pools-v2', deployment: 'sepolia', chainId: 11155111 };
    try { const restored = factory({ ...config, handle: next.getContext(subject) });
      expect(await restored.list()).toHaveLength(1); expect(await restored.listArchive()).toEqual([]);
    } finally { next.close(); }
  });

  test('non-prefix archival and duplicate live/archive state fail closed', async () => {
    await add(0); await add(1); now += MINIMUM_AGE_MS + 1;
    const rows = await journal.list(), id = kind === 'public' ? 'hash' : 'id';
    await expect(journal.archiveResolved([{ [id]: rows[1][id], revision: rows[1].revision }], [{ blockNumber: 4095, blockHash: word(14095) }])).rejects.toMatchObject({ code: 'PRIVATE_HISTORY_ARCHIVE_REFUSED' });
    await archive({ review: accept, limit: 1 });
    const storage = createPrivacyStorage(config), state = JSON.parse(await storage.get(storageKey));
    state.records.push(rows[0]); await storage.set(storageKey, JSON.stringify(state));
    await expect(journal.list()).rejects.toMatchObject({ code: kind === 'public' ? 'PRIVATE_JOURNAL_INVALID' : 'PRIVATE_PPV2_RELAY_STATE_INVALID' });
  });

  test('legacy state migrates atomically and a failed rename retains every guard', async () => {
    await add(0); const storage = createPrivacyStorage(config);
    const state = JSON.parse(await storage.get(storageKey));
    await storage.set(storageKey, JSON.stringify({ version: 1, records: state.records }));
    expect(await journal.listArchive()).toEqual([]); now += MINIMUM_AGE_MS + 1;
    const rename = jest.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('Disk unavailable'); });
    await expect(archive({ review: accept })).rejects.toMatchObject({ code: 'PRIVATE_STORAGE_WRITE_FAILED' });
    expect(await journal.list()).toHaveLength(1); expect(await journal.listArchive()).toEqual([]);
    rename.mockRestore(); await archive({ review: accept }); await add(1, false);
    expect(JSON.parse(await storage.get(storageKey)).version).toBe(2);
  });

  test('permanent archive cap is distinct and maximum encoded history fits the storage bound', async () => {
    await add(2000); now += MINIMUM_AGE_MS + 1;
    const storage = createPrivacyStorage(config), state = JSON.parse(await storage.get(storageKey));
    state.archive = Array.from({ length: ARCHIVE_MAX }, (_, i) => ({
      ...(kind === 'public' ? { hash: word(i + 1), nonce: i } : { id: word(i + 1), nullifier: word(i + 5000), commitment: word(i + 10000) }),
      status: 'included', blockNumber: i, blockHash: word(90000 + i), archivedAt: now,
      finalized: { blockNumber: 4095, blockHash: word(14095) },
    }));
    expect(Buffer.byteLength(JSON.stringify({ ...state, records: Array(64).fill(state.records[0]) }))).toBeLessThan(1024 * 1024);
    await storage.set(storageKey, JSON.stringify(state));
    await expect(archive({ review: accept })).rejects.toMatchObject({ code: 'PRIVATE_HISTORY_ARCHIVE_FULL' });
    expect(await journal.list()).toHaveLength(1);
  });

  test('a late RPC cannot continue an expired archive inspection or write state', async () => {
    await add(0); now += MINIMUM_AGE_MS + 1;
    let release;
    rpc.request.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    await expect(archive({ timeoutMs: 10, review: accept })).rejects.toMatchObject({ code: 'PRIVATE_HISTORY_ARCHIVE_REFUSED' });
    release({ result: '0x1000' }); await new Promise((resolve) => setImmediate(resolve));
    expect(rpc.request).toHaveBeenCalledTimes(1);
    expect(await journal.listArchive()).toEqual([]); expect(await journal.list()).toHaveLength(1);
  });

  test('an expired review cannot archive after its callback eventually returns', async () => {
    await add(0); now += MINIMUM_AGE_MS + 1;
    let release;
    const pending = archive({ timeoutMs: 10, review: () => new Promise((resolve) => { release = resolve; }) });
    await expect(pending).rejects.toMatchObject({ code: 'PRIVATE_HISTORY_ARCHIVE_REFUSED' });
    release?.(await accept()); await new Promise((resolve) => setImmediate(resolve));
    expect(await journal.list()).toHaveLength(1); expect(await journal.listArchive()).toEqual([]);
  });
});
