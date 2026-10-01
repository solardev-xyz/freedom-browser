const fs = require('fs'), os = require('os'), path = require('path');
const { Interface } = require('ethers');
const { createPrivacyScope } = require('../networks/privacy-context');
const { createSubmissionJournal } = require('./private-submission-journal');
const { createPrivacyStorage } = require('./privacy-storage');
const { transactionIntent } = require('./private-transaction-intent');
const { RAGEQUIT_ABI } = require('./ppv2-ragequit-policy');
const { NATIVE } = require('./ppv2-deposit-policy');
const { createPPv2ExitReservations } = require('./ppv2-exit-reservations');
const word = (v) => `0x${BigInt(v).toString(16).padStart(64, '0')}`;
const pool = `0x${'11'.repeat(20)}`, owner = `0x${'22'.repeat(20)}`;
const note = { commitment: word(7), value: 100n, asset: { __type: 'native' }, status: 'active', labelState: 'approved' };
const tx = { chainId: 11155111, from: owner, to: pool, value: 0n, data: new Interface([RAGEQUIT_ABI]).encodeFunctionData('ragequit',
  [[[1n, 2n], [[3n, 4n], [5n, 6n]], [7n, 8n], [1n, 7n, 3n, BigInt(owner), 100n, BigInt(NATIVE), 4n]]]) };
const intent = transactionIntent('ppv2-native-ragequit', tx);
let scope, config, journal, exits;
beforeEach(() => {
  scope = createPrivacyScope({ profileId: 'exit-fixture', signal: new AbortController().signal });
  config = { handle: scope.getContext({ kind: 'public-address', principal: owner, chainId: 11155111, role: 'transaction-rpc' }),
    directory: fs.mkdtempSync(path.join(os.tmpdir(), 'exit-reservations-')), key: Buffer.alloc(32, 4) };
  journal = createSubmissionJournal(config); exits = createPPv2ExitReservations({ journal, pool });
});
afterEach(() => { scope.close(); jest.restoreAllMocks(); });

test.each(['attempted', 'submitted', 'included', 'reverted', 'nonce-consumed', 'reorged'])(
  '%s exit remains reserved across restart, generic resolution and SDK cache reconstruction', async (status) => {
    await journal.begin(word(90), 1, intent);
    if (status === 'submitted') await journal.markSubmitted(word(90));
    if (['included', 'reverted', 'nonce-consumed'].includes(status)) {
      await journal.observe(word(90), { status, trust: 'unverified', observedAt: Date.now(), confirmations: 12,
        blockNumber: 20, blockHash: word(21), ...(status === 'nonce-consumed' ? { finalizedNonce: 2 } : {}) }, 0);
      await journal.resolve(word(90), 1, 12);
      await expect(journal.assertCanSubmit()).resolves.toBeUndefined();
      await expect(journal.begin(word(91), 2, intent)).rejects.toMatchObject({ code: 'PRIVATE_PPV2_EXIT_RESERVED' });
    }
    if (status === 'reorged') await journal.observe(word(90), { status, trust: 'unverified', observedAt: Date.now(),
      confirmations: 0, blockNumber: null, blockHash: null }, 0);
    exits = createPPv2ExitReservations({ journal: createSubmissionJournal(config), pool });
    await expect(exits.assertAvailable(note.commitment)).rejects.toMatchObject({ code: 'PRIVATE_PPV2_EXIT_RESERVED' });
    for (const status of ['active', 'pending', 'inactive', 'rejected', 'exit_pending']) {
      expect(await exits.notes([{ ...note, status }])).toMatchObject([{ status: 'exit_pending', labelState: 'unknown' }]);
    }
    expect(await exits.balance([note, { ...note, commitment: word(8), value: 30n }])).toMatchObject([
      { tag: 'spendable', amount: 30n }, { tag: 'unspendable', amount: 100n }]);
    expect(await exits.balance([{ ...note, status: 'exited' }])).toEqual([]);
    await expect(exits.assertAvailable(word(8))).resolves.toBeUndefined();
    await expect(createPPv2ExitReservations({ journal, pool: owner }).assertAvailable(word(7))).resolves.toBeUndefined();
  });

test('archival preserves the binding and cannot release an exit after a later SDK cache rebuild', async () => {
  await journal.begin(word(90), 1, intent);
  await journal.observe(word(90), { status: 'included', trust: 'unverified', observedAt: Date.now(), confirmations: 12,
    blockNumber: 20, blockHash: word(21) }, 0);
  const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() - 2 * 86400000);
  await journal.resolve(word(90), 1, 12); clock.mockRestore();
  await journal.archiveResolved([{ hash: word(90), revision: 2 }], [{ blockNumber: 30, blockHash: word(31) }]);
  expect(await journal.list()).toEqual([]);
  expect((await journal.listArchive())[0].intent).toEqual(intent);
  await expect(journal.begin(word(91), 2, intent)).rejects.toMatchObject({ code: 'PRIVATE_PPV2_EXIT_RESERVED' });
  exits = createPPv2ExitReservations({ journal: createSubmissionJournal(config), pool });
  await expect(exits.assertAvailable(word(7))).rejects.toMatchObject({ code: 'PRIVATE_PPV2_EXIT_RESERVED' });
});

test.each(['unclassified', 'legacy-exit', 'legacy-archive'])('%s history fails closed without rewriting or inferring a note', async (kind) => {
  const record = { hash: word(90), nonce: 1, state: 'attempted', attemptedAt: Date.now() };
  if (kind === 'legacy-exit') record.intent = { kind: intent.kind, digest: intent.digest };
  const archive = { hash: word(90), nonce: 1, status: 'included', blockNumber: 20, blockHash: word(21),
    archivedAt: Date.now(), finalized: { blockNumber: 30, blockHash: word(31) } };
  const storage = createPrivacyStorage(config);
  const serialized = JSON.stringify({ version: 2, records: kind === 'legacy-archive' ? [] : [record], archive: kind === 'legacy-archive' ? [archive] : [] });
  await storage.set('submissions-v1', serialized);
  await expect(exits.assertAvailable(word(8))).rejects.toMatchObject({ code: 'PRIVATE_PPV2_EXIT_RECOVERY_REQUIRED' });
  await expect(exits.balance([note])).rejects.toMatchObject({ code: 'PRIVATE_PPV2_EXIT_RECOVERY_REQUIRED' });
  expect(await storage.get('submissions-v1')).toBe(serialized);
});

test('known legacy non-exit intent does not reserve unrelated notes', async () => {
  await journal.begin(word(90), 1, { kind: 'ppv2-native-deposit', digest: word(4) });
  expect(await exits.notes([note])).toEqual([note]);
});


test('avoids SDK coin selection while a reserved input is still active for that asset', async () => {
  await journal.begin(word(90), 1, intent);
  await expect(exits.assertSelectable([note, { ...note, commitment: word(8) }], { __type: 'native' }))
    .rejects.toMatchObject({ code: 'PRIVATE_PPV2_EXIT_RESERVED' });
  await expect(exits.assertSelectable([{ ...note, status: 'exit_pending' }], { __type: 'native' })).resolves.toBeUndefined();
  await expect(exits.assertSelectable([note], { __type: 'erc20', contract: pool })).resolves.toBeUndefined();
});
