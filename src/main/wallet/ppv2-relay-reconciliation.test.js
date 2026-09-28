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
    const result = method === 'eth_getLogs' ? logs.filter((log) => BigInt(log.blockNumber) >= BigInt(params[0].fromBlock) && BigInt(log.blockNumber) <= BigInt(params[0].toBlock)) : method === 'eth_getTransactionReceipt' ? receipt :
      method === 'eth_call' ? spent : params[0] === 'finalized' ? final : params[0] === canonical.number ? canonical : { number: params[0], hash: word(90) };
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

test('resumes bounded discovery with a fresh reconciler and revalidates old inclusions without rescanning history', async () => {
  final = { number: '0x10000', hash: word(73) };
  for (const log of [...logs, ...receipt.logs]) log.blockNumber = '0x2000';
  receipt.blockNumber = canonical.number = '0x2000';
  const first = await reconcile.observe(record.id);
  expect(first.observation.status).toBe('unknown');
  expect(first.scan.nextBlock).toBe(5000);
  await expect(journal.assertCanSubmit()).rejects.toThrow();
  const subject = { kind: 'private-account', principal: 'ppv2:0', protocol: 'privacy-pools-v2', deployment: 'sepolia', chainId: 11155111, role: 'protocol-rpc' };
  reconcile = createPPv2RelayReconciliation({ handle: scope.getContext(subject), journal });
  expect((await reconcile.observe(record.id)).observation.status).toBe('included');
  await reconcile.resolve(record.id, accept);
  final.number = '0x100000'; mockRequest.mockClear();
  await reconcile.refreshResolved();
  const ranges = mockRequest.mock.calls.filter(([method]) => method === 'eth_getLogs').map(([, p]) => p[0]);
  expect(ranges).toHaveLength(1);
  expect(ranges[0]).toMatchObject({ fromBlock: '0x2000', toBlock: '0x2000' });
  expect((await journal.list())[0].resolution).toBeTruthy();
});

test('changed checkpoint resets discovery without advancing or releasing the reservation', async () => {
  logs = []; final.number = '0x10000';
  await reconcile.observe(record.id);
  canonical = { number: '0x1387', hash: word(91) };
  mockRequest.mockClear();
  const result = await reconcile.observe(record.id);
  expect(result.scan).toBeNull(); expect(result.observation.status).toBe('unknown');
  expect(mockRequest.mock.calls.some(([m]) => m === 'eth_getLogs')).toBe(false);
  await expect(journal.assertCanSubmit()).rejects.toThrow();
  await reconcile.observe(record.id);
  expect(mockRequest.mock.calls.find(([m]) => m === 'eth_getLogs')[1][0].fromBlock).toBe('0x0');
});

test.each(['rpc', 'overflow', 'boundary'])('does not persist progress when a page fails: %s', async (failure) => {
  logs = []; final.number = '0x10000';
  await reconcile.observe(record.id);
  const before = (await journal.list())[0].scan;
  const normal = mockRequest.getMockImplementation(); let boundary = 0;
  mockRequest.mockImplementation(async (method, params, valid) => {
    if (method === 'eth_getLogs' && failure === 'rpc') throw new Error('Temporary failure');
    if (method === 'eth_getLogs' && failure === 'overflow') { if (!valid(Array(2049).fill({}))) throw new Error('Too many logs'); }
    if (method === 'eth_getBlockByNumber' && params[0] === '0x270f' && failure === 'boundary' && ++boundary === 2) {
      return { result: { number: params[0], hash: word(92) } };
    }
    return normal(method, params, valid);
  });
  const result = await reconcile.observe(record.id);
  expect(result.scan).toEqual(before); expect(result.observation.status).toBe('unknown');
  await expect(journal.assertCanSubmit()).rejects.toThrow();
});

test('an empty scan at the finalized tip remains reserved and resumes only when the head advances', async () => {
  logs = [];
  const first = await reconcile.observe(record.id);
  expect(first.scan.nextBlock).toBe(19);
  mockRequest.mockClear();
  const second = await reconcile.observe(record.id);
  expect(second.scan).toEqual(first.scan);
  expect(mockRequest.mock.calls.some(([m]) => m === 'eth_getLogs')).toBe(false);
  await expect(journal.assertCanSubmit()).rejects.toThrow();
  final.number = '0x20';
  await reconcile.observe(record.id);
  expect(mockRequest.mock.calls.find(([m]) => m === 'eth_getLogs')[1][0]).toMatchObject({ fromBlock: '0x13', toBlock: '0x20' });
});

test('concurrent observers cannot overwrite a newer checkpoint', async () => {
  logs = []; final.number = '0x10000';
  const results = await Promise.allSettled([reconcile.observe(record.id), reconcile.observe(record.id)]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect((await journal.list())[0].scan.nextBlock).toBe(5000);
});

test('token settlement requires the journaled asset rather than the native sentinel', async () => {
  const token=`0x${'66'.repeat(20)}`;
  await reconcile.resolve(record.id,accept);
  const request=relayFixture(), payload=JSON.parse(request.body);
  request.intent={...request.intent,kind:'ppv2-token-withdrawal',token,commitment:word(85)};
  request.intent.publicSignals[0]=word(84);request.intent.publicSignals[6]=word(BigInt(token));
  payload.proof.publicSignals=request.intent.publicSignals;payload.signedFeeCommitment.asset=token;
  const plan=validateRelay({...request,body:JSON.stringify(payload)});
  await journal.begin(plan.attempt,plan.settlement);const id=plan.attempt.id;
  const event=iface.encodeEventLog(iface.getEvent('Transacted'),[[2n],[84n],token,6000n,record.settlement.processor]);
  logs=[{...logs[0],...event}];receipt.logs[0]=logs[0];
  await reconcile.resolve(id,accept);
  logs[0]={...logs[0],...iface.encodeEventLog(iface.getEvent('Transacted'),[[2n],[84n],`0x${'ee'.repeat(20)}`,6000n,record.settlement.processor])};
  await reconcile.refreshResolved();
  expect((await journal.list()).find(r=>r.id===id).resolution).toBeNull();
});
