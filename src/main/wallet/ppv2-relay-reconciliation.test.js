jest.mock('../networks/private-rpc', () => ({ ...jest.requireActual('../networks/private-rpc'), createPrivateRpc: () => ({ request: mockRequest }) }));
const fs = require('fs'), os = require('os'), path = require('path');
const { Interface } = require('ethers');
const { createPrivacyScope } = require('../networks/privacy-context');
const { createPPv2RelayJournal } = require('./ppv2-relay-journal');
const { createPPv2RelayReconciliation, ABI } = require('./ppv2-relay-reconciliation');
const { validateRelay } = require('./ppv2-relay-policy');
const { relayFixture, word } = require('../../../test/helpers/ppv2-relay-fixture');
let scope, journal, reconcile, record, receipt, logs, mockRequest, canonical, spent, final;
const iface = new Interface(ABI), txHash = word(71), blockHash = word(72);
beforeEach(async () => {
  scope = createPrivacyScope({ profileId: 'fixture', signal: new AbortController().signal });
  const subject = { kind: 'private-account', principal: 'ppv2:0', protocol: 'privacy-pools-v2', deployment: 'sepolia', chainId: 11155111 };
  journal = createPPv2RelayJournal({ handle: scope.getContext({ ...subject, role: 'storage' }),
    directory: fs.mkdtempSync(path.join(os.tmpdir(), 'relay-reconcile-')), key: Buffer.alloc(32, 7) });
  const request = relayFixture(), prepared = validateRelay(request), payload = JSON.parse(request.body);
  await journal.begin(prepared.attempt, prepared.settlement); record = (await journal.list())[0];
  const make = (name, args) => ({ address: record.settlement.pool, ...iface.encodeEventLog(iface.getEvent(name), args),
    transactionHash: txHash, blockHash, blockNumber: '0x10', removed: false });
  logs = [make('Transacted', [[2n], [1n], payload.signedFeeCommitment.asset, 6000n, record.settlement.processor])];
  receipt = { transactionHash: txHash, blockHash, blockNumber: '0x10', status: '0x1', to: record.settlement.processor,
    logs: [...logs, make('Note', [payload.noteData[0].hint, payload.noteData[0].data])] };
  canonical = { number: '0x10', hash: blockHash }; spent = word(100); final = { number: '0x12', hash: word(73) };
  mockRequest = jest.fn(async (method, params, valid) => {
    const result = method === 'eth_getLogs' ? logs : method === 'eth_getTransactionReceipt' ? receipt :
      method === 'eth_call' ? spent : params[0] === 'finalized' ? final : canonical;
    if (!valid(result)) throw new Error('Invalid fixture'); return { result };
  });
  reconcile = createPPv2RelayReconciliation({ handle: scope.getContext({ ...subject, role: 'protocol-rpc' }), journal });
});
afterEach(() => scope.close());
const accept = async () => ({ allowNextOperation: true, acceptedEvidence: 'unverified-rpc' });

test('discovers an unacknowledged operation by nullifier, requires review, and refreshes resolution before reuse', async () => {
  const observed = await reconcile.observe(record.id);
  expect(observed.observation).toMatchObject({ status: 'included', transactionHash: txHash, trust: 'unverified-rpc' });
  await expect(journal.assertCanSubmit()).rejects.toThrow();
  await expect(reconcile.resolve(record.id, async () => ({ allowNextOperation: true, acceptedEvidence: 'verified' }))).rejects.toThrow();
  const resolved = await reconcile.resolve(record.id, accept); expect(resolved.resolution.blockHash).toBe(blockHash);
  await expect(journal.assertCanSubmit()).resolves.toBeUndefined();
  logs = []; await reconcile.refreshResolved();
  expect((await journal.list())[0].resolution).toBeNull();
  await expect(journal.assertCanSubmit()).rejects.toThrow();
});

test.each(['target','status','hash','note','event','spent','canonical','finality','duplicate','missing','rpc'])(
  'keeps the reservation when %s evidence disagrees', async (change) => {
    if (change === 'target') receipt.to = `0x${'55'.repeat(20)}`;
    if (change === 'status') receipt.status = '0x0';
    if (change === 'hash') receipt.transactionHash = word(80);
    if (change === 'note') receipt.logs[1] = { ...receipt.logs[1], ...iface.encodeEventLog(iface.getEvent('Note'), [word(3),'0xbb']) };
    if (change === 'event') { logs[0] = { ...logs[0], ...iface.encodeEventLog(iface.getEvent('Transacted'), [[9n],[1n],`0x${'ee'.repeat(20)}`,6000n,record.settlement.processor]) }; }
    if (change === 'spent') spent = word(0);
    if (change === 'canonical') canonical.hash = word(80);
    if (change === 'finality') final = null;
    if (change === 'duplicate') logs.push(logs[0]);
    if (change === 'missing') receipt = null;
    if (change === 'rpc') mockRequest.mockRejectedValue(new Error('upstream'));
    await expect(reconcile.resolve(record.id, accept)).rejects.toThrow();
    await expect(journal.assertCanSubmit()).rejects.toThrow();
  });

test('rechecks evidence after review and rejects a reorg during approval', async () => {
  await expect(reconcile.resolve(record.id, async () => { canonical.hash = word(80); return accept(); })).rejects.toThrow();
  await expect(journal.assertCanSubmit()).rejects.toThrow();
});

test('retains prior attempts, refuses spent inputs, and permits a different note only after explicit resolution', async () => {
  await reconcile.resolve(record.id, accept);
  const { attempt, settlement } = validateRelay(relayFixture());
  await expect(journal.begin({ ...attempt, id: word(81) }, settlement)).rejects.toThrow();
  await journal.begin({ ...attempt, id: word(81), nullifier: word(82), commitment: word(83) }, settlement);
  expect(await journal.list()).toHaveLength(2);
  await expect(journal.assertCanSubmit()).rejects.toThrow();
  await expect(journal.resolve(record.id, 0)).rejects.toThrow();
});

test('legacy attempts without settlement metadata stay readable and cannot be released', async () => {
  await reconcile.resolve(record.id, accept);
  const { attempt } = validateRelay(relayFixture());
  await journal.begin({ ...attempt, id: word(81), nullifier: word(82), commitment: word(83) });
  await expect(reconcile.resolve(word(81), accept)).rejects.toThrow();
  await expect(journal.assertCanSubmit()).rejects.toThrow();
});
