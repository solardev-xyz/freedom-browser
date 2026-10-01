const fs = require('fs'), os = require('os'), path = require('path');
const { Wallet, Transaction, Interface } = require('ethers');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { createPrivacyStorage } = require('./privacy-storage');
const { createSubmissionJournal } = require('./private-submission-journal');
const { transactionIntent } = require('./private-transaction-intent');
const { createPPv2ExitReservations } = require('./ppv2-exit-reservations');
const { recoverExitIntent, createPPv2ExitRecovery } = require('./ppv2-exit-recovery');
const wallet = Wallet.fromPhrase('test test test test test test test test test test test junk');
const owner = wallet.address.toLowerCase(), pool = `0x${'11'.repeat(20)}`;
const word = n => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
const quantity = n => `0x${BigInt(n).toString(16)}`;
let scope, config, journal, storage, record, rpcValue, intent, readTransaction, recover;
const legacyArchive = async () => storage.set('submissions-v1', JSON.stringify({ version: 2, records: [], archive: [{
  hash: record.hash, nonce: record.nonce, status: 'included', blockNumber: 20, blockHash: word(21), archivedAt: Date.now(),
  finalized: { blockNumber: 30, blockHash: word(31) } }] }));
const consent = async () => ({ recoverExitBinding: true, acceptedEvidence: 'signed-transaction-hash' });
beforeEach(async () => {
  scope = createPrivacyScope({ profileId: 'legacy-exit-fixture', signal: new AbortController().signal });
  config = { handle: scope.getContext({ kind: 'public-address', principal: owner, chainId: 11155111, role: 'transaction-rpc' }),
    directory: fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-exit-fixture-')), key: Buffer.alloc(32, 6) };
  storage = createPrivacyStorage(config); journal = createSubmissionJournal(config);
  const data = new Interface([require('./ppv2-ragequit-policy').RAGEQUIT_ABI]).encodeFunctionData('ragequit',
    [[[1n, 2n], [[3n, 4n], [5n, 6n]], [7n, 8n], [1n, 7n, 3n, BigInt(owner), 100n, BigInt(require('./ppv2-deposit-policy').NATIVE), 4n]]]);
  const tx = Transaction.from(await wallet.signTransaction({ type: 0, chainId: 11155111, nonce: 7, to: pool, value: 0n, data, gasLimit: 1000000n, gasPrice: 1n }));
  intent = transactionIntent('ppv2-native-ragequit', tx);
  rpcValue = { hash: tx.hash, from: tx.from, to: tx.to, type: '0x0', chainId: '0xaa36a7', nonce: '0x7', gas: quantity(tx.gasLimit),
    gasPrice: '0x1', value: '0x0', input: data, v: quantity(tx.signature.networkV), r: tx.signature.r, s: tx.signature.s };
  record = { hash: tx.hash, nonce: 7, state: 'attempted', attemptedAt: Date.now(), revision: 2,
    intent: { kind: intent.kind, digest: intent.digest }, observation: { status: 'included', trust: 'unverified', observedAt: Date.now(),
      blockNumber: 20, blockHash: word(21), confirmations: 12 }, resolution: { blockHash: word(21), minimumConfirmations: 12, reviewedAt: Date.now() } };
  await storage.set('submissions-v1', JSON.stringify({ version: 2, records: [record], archive: [] }));
  readTransaction = jest.fn(async () => rpcValue);
  recover = createPPv2ExitRecovery({ journal, readTransaction, principal: owner, pool, lifetime: scope.signal,
    assertActive: () => getPrivacyContext(config.handle) });
});
afterEach(() => { scope.close(); jest.restoreAllMocks(); });

test('authenticates legacy bytes and enriches only the binding after explicit review, retaining its reservation across restart', async () => {
  const held = createPPv2ExitReservations({ journal, pool });
  await expect(held.assertAvailable(word(8))).rejects.toMatchObject({ code: 'PRIVATE_PPV2_EXIT_RECOVERY_REQUIRED' });
  const review = jest.fn(async summary => {
    expect(Object.isFrozen(summary)).toBe(true);
    expect(summary).toMatchObject({ commitment: word(7), signatureVerified: true, inclusionVerified: false, releasesReservation: false });
    expect(Object.keys(summary)).not.toContain('input'); return consent();
  });
  await recover(record.hash, { review });
  expect(readTransaction).toHaveBeenCalledWith(record.hash, expect.any(AbortSignal));
  expect((await journal.list())[0]).toEqual({ ...record, revision: 3, intent });
  const restored = createPPv2ExitReservations({ journal: createSubmissionJournal(config), pool });
  await expect(restored.assertAvailable(word(7))).rejects.toMatchObject({ code: 'PRIVATE_PPV2_EXIT_RESERVED' });
  await expect(restored.assertAvailable(word(8))).resolves.toBeUndefined();
  await expect(journal.begin(word(99), 8, intent)).rejects.toMatchObject({ code: 'PRIVATE_PPV2_EXIT_RESERVED' });
  await expect(recover(record.hash, { review })).rejects.toThrow();
  expect(review).toHaveBeenCalledTimes(1);
  const disk = fs.readFileSync(path.join(config.directory, fs.readdirSync(config.directory)[0]), 'utf8');
  expect(disk).not.toContain(rpcValue.input); expect(disk).not.toContain(rpcValue.r);
});

test.each(['null', 'hash', 'from', 'nonce', 'chain', 'gas', 'signature', 'pre-eip155', 'typed', 'digest', 'pool', 'calldata'])(
  'refuses unauthenticated %s before review or journal mutation', async kind => {
    const original = await storage.get('submissions-v1');
    if (kind === 'null') rpcValue = null;
    if (kind === 'hash') rpcValue.hash = word(99);
    if (kind === 'from') rpcValue.from = pool;
    if (kind === 'nonce') rpcValue.nonce = '0x8';
    if (kind === 'chain') rpcValue.chainId = '0x1';
    if (kind === 'gas') rpcValue.gas = '0x1';
    if (kind === 'signature') rpcValue.r = word(99);
    if (kind === 'pre-eip155') rpcValue.v = '0x1b';
    if (kind === 'typed') rpcValue.type = '0x2';
    if (kind === 'pool') rpcValue.to = owner;
    if (kind === 'calldata') rpcValue.input += '00';
    if (kind === 'digest') {
      const fake = { ...record, intent: { ...record.intent, digest: word(99) } };
      expect(() => recoverExitIntent(fake, rpcValue, owner, pool)).toThrow(); return;
    }
    const review = jest.fn(consent);
    await expect(recover(record.hash, { review })).rejects.toMatchObject({ code: 'PRIVATE_PPV2_EXIT_RECOVERY_REFUSED' });
    expect(review).not.toHaveBeenCalled(); expect(await storage.get('submissions-v1')).toBe(original);
  });

test.each(['declined', 'stale', 'archive', 'lock', 'timeout', 'disk'])('refuses %s recovery without late or partial metadata writes', async kind => {
  const original = await journal.list(); let finish;
  const review = async () => {
    if (kind === 'declined') return {};
    if (kind === 'stale') await journal.observe(record.hash, record.observation, 2);
    if (kind === 'archive') await legacyArchive();
    if (kind === 'lock') scope.close();
    if (kind === 'timeout') return new Promise(resolve => { finish = resolve; });
    if (kind === 'disk') jest.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('disk unavailable'); });
    return consent();
  };
  await expect(recover(record.hash, { review, timeoutMs: kind === 'timeout' ? 30 : 60000 })).rejects.toThrow();
  if (finish) { finish(await consent()); await new Promise(resolve => setImmediate(resolve)); }
  if (kind === 'lock') return;
  if (kind === 'archive') expect((await journal.listArchive())[0].intent).toBeUndefined();
  else if (kind === 'stale') expect((await journal.list())[0]).toMatchObject({ revision: 3, intent: record.intent });
  else expect(await journal.list()).toEqual(original);
});

test('unknown hashes and old archives never trigger an RPC lookup', async () => {
  await expect(recover(word(99), { review: consent })).rejects.toThrow();
  await legacyArchive();
  await expect(recover(record.hash, { review: consent })).rejects.toThrow();
  expect(readTransaction).not.toHaveBeenCalled();
});


test.each(['exit', 'unclassified'])('retained %s history cannot be archived before classification', async kind => {
  const before = await storage.get('submissions-v1');
  if (kind === 'unclassified') {
    const state = JSON.parse(before); delete state.records[0].intent;
    await storage.set('submissions-v1', JSON.stringify(state));
    await expect(recover(record.hash, { review: consent })).rejects.toThrow();
    expect(readTransaction).not.toHaveBeenCalled();
  }
  const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 86400000);
  await expect(journal.archiveResolved([{ hash: record.hash, revision: 2 }], [{ blockNumber: 30, blockHash: word(31) }]))
    .rejects.toMatchObject({ code: 'PRIVATE_HISTORY_ARCHIVE_REFUSED' });
  clock.mockRestore(); expect(await journal.listArchive()).toEqual([]);
  expect((await journal.list())[0].intent?.commitment).toBeUndefined();
});

test('recovering one exit cannot clear other ambiguous history', async () => {
  const other = { ...record, hash: word(99), nonce: 8, intent: undefined };
  await storage.set('submissions-v1', JSON.stringify({ version: 2, records: [record, other], archive: [] }));
  await recover(record.hash, { review: consent });
  await expect(createPPv2ExitReservations({ journal, pool }).assertAvailable(word(8))).rejects.toMatchObject({ code: 'PRIVATE_PPV2_EXIT_RECOVERY_REQUIRED' });
});

test('an unavailable transaction or hung RPC cannot write after the recovery deadline', async () => {
  let finish;
  readTransaction.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const review = jest.fn(consent);
  await expect(recover(record.hash, { review, timeoutMs: 30 })).rejects.toThrow();
  expect(readTransaction.mock.calls[0][1].aborted).toBe(true);
  finish(rpcValue); await new Promise(resolve => setImmediate(resolve));
  expect(review).not.toHaveBeenCalled(); expect((await journal.list())[0]).toEqual(record);
});


test.each(['r', 's'])('accepts an unpadded signature %s only when it reconstructs the exact recorded transaction', async field => {
  let tx;
  for (let nonce = 0; nonce < 4096; nonce++) {
    tx = Transaction.from(await wallet.signTransaction({ type: 0, chainId: 11155111, nonce, to: pool, value: 0n,
      data: rpcValue.input, gasLimit: 1000000n, gasPrice: 1n }));
    if (tx.signature[field].startsWith('0x0')) break;
  }
  expect(tx.signature[field]).toMatch(/^0x0/);
  const observed = { ...rpcValue, nonce: quantity(tx.nonce), hash: tx.hash, v: quantity(tx.signature.networkV),
    r: quantity(tx.signature.r), s: quantity(tx.signature.s) };
  expect(observed[field].length).toBeLessThan(66);
  expect(recoverExitIntent({ ...record, nonce: tx.nonce, hash: tx.hash }, observed, owner, pool)).toEqual(intent);
  expect(() => recoverExitIntent({ ...record, nonce: tx.nonce, hash: tx.hash }, { ...observed, [field]: '0x0' }, owner, pool)).toThrow();
});
