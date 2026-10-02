jest.mock('../networks/private-rpc', () => ({
  ...jest.requireActual('../networks/private-rpc'),
  createPrivateRpc: (handle) => {
    mockRpcHandles.push(handle);
    return { request: mockRequest, release: mockRelease };
  },
}));
const fs = require('fs'),
  os = require('os'),
  path = require('path');
const { Interface } = require('ethers');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { createPPv2RelayJournal } = require('./ppv2-relay-journal');
const { createPPv2RelayReconciliation, ABI } = require('./ppv2-relay-reconciliation');
const { validateRelay } = require('./ppv2-relay-policy');
const { relayFixture, word, signQuote } = require('../../../test/helpers/ppv2-relay-fixture');
let scope, journal, reconcile, record, receipt, logs, mockRequest, canonical, spent, final;
let mockRpcHandles, capacityTask;
const mockRelease = jest.fn();
const iface = new Interface(ABI),
  txHash = word(71),
  blockHash = word(72);
const getOperationHandle = (id) =>
  scope.getContext({
    kind: 'private-account',
    principal: 'ppv2:0',
    protocol: 'privacy-pools-v2',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'protocol-rpc',
    operation: id,
  });
beforeEach(async () => {
  mockRpcHandles = [];
  mockRelease.mockClear();
  scope = createPrivacyScope({ profileId: 'fixture', signal: new AbortController().signal });
  const subject = {
    kind: 'private-account',
    principal: 'ppv2:0',
    protocol: 'privacy-pools-v2',
    deployment: 'sepolia',
    chainId: 11155111,
  };
  journal = createPPv2RelayJournal({
    handle: scope.getContext({ ...subject, role: 'storage' }),
    directory: fs.mkdtempSync(path.join(os.tmpdir(), 'relay-reconcile-')),
    key: Buffer.alloc(32, 7),
  });
  const request = relayFixture(),
    prepared = validateRelay(request),
    payload = JSON.parse(request.body);
  await journal.begin(prepared.attempt, prepared.settlement);
  record = (await journal.list())[0];
  const make = (name, args) => ({
    address: record.settlement.pool,
    ...iface.encodeEventLog(iface.getEvent(name), args),
    transactionHash: txHash,
    blockHash,
    blockNumber: '0x10',
    removed: false,
  });
  logs = [
    make('Transacted', [
      [2n],
      [1n],
      payload.signedFeeCommitment.asset,
      6000n,
      record.settlement.processor,
    ]),
  ];
  receipt = {
    transactionHash: txHash,
    blockHash,
    blockNumber: '0x10',
    status: '0x1',
    to: record.settlement.processor,
    logs: [...logs, make('Note', [payload.noteData[0].hint, payload.noteData[0].data])],
  };
  canonical = { number: '0x10', hash: blockHash };
  spent = word(100);
  final = { number: '0x12', hash: word(73) };
  mockRequest = jest.fn(async (method, params, valid) => {
    const result =
      method === 'eth_getLogs'
        ? logs.filter(
            (log) =>
              BigInt(log.blockNumber) >= BigInt(params[0].fromBlock) &&
              BigInt(log.blockNumber) <= BigInt(params[0].toBlock)
          )
        : method === 'eth_getTransactionReceipt'
          ? receipt
          : method === 'eth_call'
            ? spent
            : params[0] === 'finalized'
              ? final
              : params[0] === canonical.number
                ? canonical
                : { number: params[0], hash: word(90) };
    if (!valid(result)) throw new Error('Invalid fixture');
    return { result };
  });
  reconcile = createPPv2RelayReconciliation({
    handle: scope.getContext({ ...subject, role: 'protocol-rpc' }),
    journal,
    getOperationHandle,
  });
});
afterEach(async () => {
  const closingScope = scope,
    task = capacityTask;
  // A Jest timeout does not cancel the test body. Drain the fsync-heavy
  // capacity run before revoking the shared scope or starting another test.
  try {
    await task?.catch(() => {});
  } finally {
    if (capacityTask === task) capacityTask = null;
    closingScope.close();
  }
}, 30_000);
const accept = async () => ({ allowNextOperation: true, acceptedEvidence: 'unverified-rpc' });

function exitEvidence() {
  logs = [
    {
      ...logs[0],
      ...iface.encodeEventLog(iface.getEvent('Ragequit'), [
        record.settlement.owner,
        `0x${'ee'.repeat(20)}`,
        10000n,
        BigInt(record.commitment),
        BigInt(record.nullifier),
        12n,
      ]),
    },
  ];
  receipt = {
    ...receipt,
    from: record.settlement.owner,
    to: record.settlement.pool,
    logs: [...logs],
  };
}

test('a matching emergency exit resolves a withheld relay only after explicit review and fresh evidence', async () => {
  exitEvidence();
  expect((await reconcile.observe(record.id)).observation.status).toBe('exited');
  await expect(journal.assertCanSubmit()).rejects.toThrow();
  await reconcile.resolve(record.id, accept);
  await reconcile.refreshResolved();
  await expect(journal.assertCanSubmit()).resolves.toBeUndefined();
  expect((await journal.list())[0]).toMatchObject({
    acknowledgedHash: null,
    observation: { status: 'exited' },
  });
  canonical.hash = word(88);
  await reconcile.refreshResolved();
  await expect(journal.assertCanSubmit()).rejects.toThrow();
});

test.each(['owner', 'asset', 'amount', 'commitment', 'nullifier', 'sender', 'target', 'spent'])(
  'refuses mismatched emergency-exit %s evidence',
  async (change) => {
    exitEvidence();
    const values = [
      record.settlement.owner,
      `0x${'ee'.repeat(20)}`,
      10000n,
      BigInt(record.commitment),
      BigInt(record.nullifier),
      12n,
    ];
    if (change === 'owner') values[0] = `0x${'66'.repeat(20)}`;
    if (change === 'asset') values[1] = `0x${'66'.repeat(20)}`;
    if (change === 'amount') values[2] = 9999n;
    if (change === 'commitment') values[3] = 88n;
    if (change === 'nullifier') values[4] = 88n;
    logs[0] = { ...logs[0], ...iface.encodeEventLog(iface.getEvent('Ragequit'), values) };
    receipt.logs = [...logs];
    if (change === 'sender') receipt.from = `0x${'66'.repeat(20)}`;
    if (change === 'target') receipt.to = record.settlement.processor;
    if (change === 'spent') spent = word(0);
    await expect(reconcile.resolve(record.id, accept)).rejects.toThrow();
    await expect(journal.assertCanSubmit()).rejects.toThrow();
  }
);

test.each(['rpc', 'missing-logs', 'missing-receipt', 'lagging-finality'])(
  'a transient %s preserves a reviewed inclusion and its lookup position',
  async (failure) => {
    await reconcile.resolve(record.id, accept);
    const before = await journal.list();
    if (failure === 'rpc') mockRequest.mockRejectedValueOnce(new Error('Temporary failure'));
    if (failure === 'missing-logs') logs = [];
    if (failure === 'missing-receipt') receipt = null;
    if (failure === 'lagging-finality') final.number = '0xf';
    await expect(reconcile.observe(record.id)).rejects.toMatchObject({
      code: 'PRIVATE_PPV2_RECONCILIATION_REFUSED',
    });
    expect(await journal.list()).toEqual(before);
    expect(
      mockRpcHandles.every((handle) => getPrivacyContext(handle).subject.operation === record.id)
    ).toBe(true);
  }
);

test('different relay attempts use different operation isolation tokens', async () => {
  await reconcile.resolve(record.id, accept);
  const first = getPrivacyContext(mockRpcHandles[0]);
  const { attempt, settlement } = validateRelay(relayFixture());
  await journal.begin(
    { ...attempt, id: word(81), nullifier: word(82), commitment: word(83) },
    settlement
  );
  await reconcile.observe(word(81));
  const second = getPrivacyContext(mockRpcHandles.at(-1));
  expect(second.subject.operation).toBe(word(81));
  expect(second.isolationToken).not.toBe(first.isolationToken);
});

test('discovers an unacknowledged operation by nullifier, requires review, and refreshes resolution before reuse', async () => {
  const observed = await reconcile.observe(record.id);
  expect(observed.observation).toMatchObject({
    status: 'included',
    transactionHash: txHash,
    trust: 'unverified-rpc',
  });
  await expect(journal.assertCanSubmit()).rejects.toThrow();
  await expect(
    reconcile.resolve(record.id, async () => ({
      allowNextOperation: true,
      acceptedEvidence: 'verified',
    }))
  ).rejects.toThrow();
  const resolved = await reconcile.resolve(record.id, accept);
  expect(resolved.resolution.blockHash).toBe(blockHash);
  await expect(journal.assertCanSubmit()).resolves.toBeUndefined();
  canonical.hash = word(80);
  await reconcile.refreshResolved();
  expect((await journal.list())[0].resolution).toBeNull();
  await expect(journal.assertCanSubmit()).rejects.toThrow();
});

test.each([
  'target',
  'status',
  'hash',
  'note',
  'event',
  'spent',
  'canonical',
  'finality',
  'duplicate',
  'missing',
  'rpc',
])('keeps the reservation when %s evidence disagrees', async (change) => {
  if (change === 'target') receipt.to = `0x${'55'.repeat(20)}`;
  if (change === 'status') receipt.status = '0x0';
  if (change === 'hash') receipt.transactionHash = word(80);
  if (change === 'note')
    receipt.logs[1] = {
      ...receipt.logs[1],
      ...iface.encodeEventLog(iface.getEvent('Note'), [word(3), '0xbb']),
    };
  if (change === 'event') {
    logs[0] = {
      ...logs[0],
      ...iface.encodeEventLog(iface.getEvent('Transacted'), [
        [9n],
        [1n],
        `0x${'ee'.repeat(20)}`,
        6000n,
        record.settlement.processor,
      ]),
    };
  }
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
  await expect(
    reconcile.resolve(record.id, async () => {
      canonical.hash = word(80);
      return accept();
    })
  ).rejects.toThrow();
  await expect(journal.assertCanSubmit()).rejects.toThrow();
});

test('retains prior attempts, refuses spent inputs, and permits a different note only after explicit resolution', async () => {
  await reconcile.resolve(record.id, accept);
  const { attempt, settlement } = validateRelay(relayFixture());
  await expect(journal.begin({ ...attempt, id: word(81) }, settlement)).rejects.toThrow();
  await journal.begin(
    { ...attempt, id: word(81), nullifier: word(82), commitment: word(83) },
    settlement
  );
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
  const subject = {
    kind: 'private-account',
    principal: 'ppv2:0',
    protocol: 'privacy-pools-v2',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'protocol-rpc',
  };
  reconcile = createPPv2RelayReconciliation({
    handle: scope.getContext(subject),
    journal,
    getOperationHandle,
  });
  expect((await reconcile.observe(record.id)).observation.status).toBe('included');
  await reconcile.resolve(record.id, accept);
  final.number = '0x100000';
  mockRequest.mockClear();
  await reconcile.refreshResolved();
  const ranges = mockRequest.mock.calls
    .filter(([method]) => method === 'eth_getLogs')
    .map(([, p]) => p[0]);
  expect(ranges).toHaveLength(0);
  expect(mockRequest.mock.calls).toHaveLength(1);
  expect(mockRequest.mock.calls[0].slice(0, 2)).toEqual([
    'eth_getBlockByNumber',
    ['0x2000', false],
  ]);
  expect(mockRelease).toHaveBeenCalledTimes(mockRpcHandles.length);
  expect((await journal.list())[0].resolution).toBeTruthy();
});

test('changed checkpoint resets discovery without advancing or releasing the reservation', async () => {
  logs = [];
  final.number = '0x10000';
  await reconcile.observe(record.id);
  canonical = { number: '0x1387', hash: word(91) };
  mockRequest.mockClear();
  const result = await reconcile.observe(record.id);
  expect(result.scan).toBeNull();
  expect(result.observation.status).toBe('unknown');
  expect(mockRequest.mock.calls.some(([m]) => m === 'eth_getLogs')).toBe(false);
  await expect(journal.assertCanSubmit()).rejects.toThrow();
  await reconcile.observe(record.id);
  expect(mockRequest.mock.calls.find(([m]) => m === 'eth_getLogs')[1][0].fromBlock).toBe('0x0');
});

test.each(['rpc', 'overflow', 'boundary'])(
  'does not persist progress when a page fails: %s',
  async (failure) => {
    logs = [];
    final.number = '0x10000';
    await reconcile.observe(record.id);
    const before = (await journal.list())[0].scan;
    const normal = mockRequest.getMockImplementation();
    let boundary = 0;
    mockRequest.mockImplementation(async (method, params, valid) => {
      if (method === 'eth_getLogs' && failure === 'rpc') throw new Error('Temporary failure');
      if (method === 'eth_getLogs' && failure === 'overflow') {
        if (!valid(Array(2049).fill({}))) throw new Error('Too many logs');
      }
      if (
        method === 'eth_getBlockByNumber' &&
        params[0] === '0x270f' &&
        failure === 'boundary' &&
        ++boundary === 2
      ) {
        return { result: { number: params[0], hash: word(92) } };
      }
      return normal(method, params, valid);
    });
    await expect(reconcile.observe(record.id)).rejects.toMatchObject({
      code: 'PRIVATE_PPV2_RECONCILIATION_REFUSED',
    });
    const result = (await journal.list())[0];
    expect(result.scan).toEqual(before);
    expect(result.observation.status).toBe('unknown');
    await expect(journal.assertCanSubmit()).rejects.toThrow();
  }
);

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
  expect(mockRequest.mock.calls.find(([m]) => m === 'eth_getLogs')[1][0]).toMatchObject({
    fromBlock: '0x13',
    toBlock: '0x20',
  });
});

test('concurrent observers cannot overwrite a newer checkpoint', async () => {
  logs = [];
  final.number = '0x10000';
  const results = await Promise.allSettled([
    reconcile.observe(record.id),
    reconcile.observe(record.id),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect((await journal.list())[0].scan.nextBlock).toBe(5000);
});

test('token settlement requires the journaled asset rather than the native sentinel', async () => {
  const token = `0x${'66'.repeat(20)}`;
  await reconcile.resolve(record.id, accept);
  const request = relayFixture(),
    payload = JSON.parse(request.body);
  request.intent = {
    ...request.intent,
    kind: 'ppv2-token-withdrawal',
    token,
    commitment: word(85),
  };
  request.intent.publicSignals[0] = word(84);
  request.intent.publicSignals[6] = word(BigInt(token));
  payload.proof.publicSignals = request.intent.publicSignals;
  payload.signedFeeCommitment.asset = token;
  payload.signedFeeCommitment.signedRelayerCommitment = signQuote(
    payload.signedFeeCommitment,
    request.intent.processor
  );
  const plan = validateRelay({ ...request, body: JSON.stringify(payload) });
  await journal.begin(plan.attempt, plan.settlement);
  const id = plan.attempt.id;
  const event = iface.encodeEventLog(iface.getEvent('Transacted'), [
    [2n],
    [84n],
    token,
    6000n,
    record.settlement.processor,
  ]);
  logs = [{ ...logs[0], ...event }];
  receipt.logs[0] = logs[0];
  await reconcile.resolve(id, accept);
  logs[0] = {
    ...logs[0],
    ...iface.encodeEventLog(iface.getEvent('Transacted'), [
      [2n],
      [84n],
      `0x${'ee'.repeat(20)}`,
      6000n,
      record.settlement.processor,
    ]),
  };
  await reconcile.observe(id);
  expect((await journal.list()).find((r) => r.id === id).resolution).toBeNull();
});

test('a smaller explicitly requested page recovers from provider range limits without implicit retry', async () => {
  logs = [];
  final.number = '0x10000';
  const normal = mockRequest.getMockImplementation();
  mockRequest.mockImplementation(async (method, params, valid) => {
    if (method === 'eth_getLogs' && BigInt(params[0].toBlock) - BigInt(params[0].fromBlock) >= 100n)
      throw new Error('range limit');
    return normal(method, params, valid);
  });
  await expect(reconcile.observe(record.id)).rejects.toThrow();
  expect((await journal.list())[0].scan).toBeUndefined();
  expect((await reconcile.observe(record.id, { maxBlocks: 100 })).scan.nextBlock).toBe(100);
});

test('compact refresh preserves reviewed evidence on missing blocks or wrong heights, revokes changed hashes, and releases transport', async () => {
  await reconcile.resolve(record.id, accept);
  const before = await journal.list();
  mockRequest.mockResolvedValueOnce({ result: null });
  await expect(reconcile.refreshResolved()).rejects.toThrow();
  expect(await journal.list()).toEqual(before);
  mockRequest.mockResolvedValueOnce({ result: { ...canonical, number: '0x11' } });
  await expect(reconcile.refreshResolved()).rejects.toThrow();
  expect(await journal.list()).toEqual(before);
  mockRequest.mockResolvedValueOnce({ result: { ...canonical, hash: word(88) } });
  await reconcile.refreshResolved();
  expect((await journal.list())[0].resolution).toBeNull();
  expect(mockRelease).toHaveBeenCalledTimes(mockRpcHandles.length);
});

async function qualifyRelayCapacity() {
  const capacityScope = scope;
  await reconcile.resolve(record.id, accept);
  for (let index = 1; index < 63; index++) {
    const id = word(1000 + index);
    await journal.begin(
      {
        ...validateRelay(relayFixture()).attempt,
        id,
        commitment: word(2000 + index),
        nullifier: word(3000 + index),
      },
      record.settlement
    );
    await journal.observe(
      id,
      {
        status: 'included',
        transactionHash: txHash,
        blockHash,
        blockNumber: 16,
        trust: 'unverified-rpc',
      },
      0
    );
    await journal.resolve(id, 1);
  }
  jest.useFakeTimers();
  let pending;
  try {
    const started = Date.now(),
      request = relayFixture();
    request.intent.commitment = word(9000);
    request.intent.publicSignals[0] = word(9001);
    const body = JSON.parse(request.body);
    body.proof.publicSignals[0] = word(9001);
    body.signedFeeCommitment.expiration = started + 60000;
    body.signedFeeCommitment.signedRelayerCommitment = signQuote(
      body.signedFeeCommitment,
      request.intent.processor
    );
    request.body = JSON.stringify(body);
    mockRequest.mockClear();
    mockRelease.mockClear();
    mockRpcHandles = [];
    mockRequest.mockImplementation(async (method, params, valid) => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(method).toBe('eth_getBlockByNumber');
      expect(params).toEqual(['0x10', false]);
      expect(valid(canonical)).toBe(true);
      return { result: canonical };
    });
    let handedOff;
    const network = {
      fetch: jest.fn(async () => {
        handedOff = Date.now();
        return new Response(JSON.stringify({ txHash: word(9999) }));
      }),
    };
    const gate = require('./ppv2-relay-handoff').createPPv2RelayHandoff({
      handle: capacityScope.getContext({
        kind: 'private-account',
        principal: 'ppv2:0',
        protocol: 'privacy-pools-v2',
        deployment: 'sepolia',
        chainId: 11155111,
        role: 'relayer',
      }),
      journal,
      network,
      verifyProof: async () => true,
      beforeBegin: (signal) => reconcile.refreshResolved(signal),
    });
    const prepared = await gate.prepare(request);
    pending = gate.submit(prepared, {
      review: async () => true,
      invoke: (net) =>
        net.fetch(request.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: request.body,
        }),
    });
    // Observe rejection immediately, including while the fake clock advances.
    // Awaiting the original below still makes a rejection fail the test.
    pending.catch(() => {});
    await jest.advanceTimersByTimeAsync(5000);
    await pending;
    expect(handedOff - started).toBeLessThan(45000);
    expect(mockRequest).toHaveBeenCalledTimes(63);
    expect(mockRelease).toHaveBeenCalledTimes(63);
    expect(
      new Set(mockRpcHandles.map((handle) => getPrivacyContext(handle).isolationToken)).size
    ).toBe(63);
    expect(network.fetch).toHaveBeenCalledTimes(1);
    expect(await journal.list()).toHaveLength(64);
  } finally {
    try {
      if (pending) {
        capacityScope.close();
        await jest.runOnlyPendingTimersAsync();
        await pending.catch(() => {});
      }
    } finally {
      jest.useRealTimers();
    }
  }
}

// The setup performs almost 200 real durable writes. Keep the simulated quote
// deadline assertion while allowing slower CI filesystem I/O.
test('63 resolved attempts revalidate inside a 60-second quote without receipt rescans or retained transport groups', () => {
  capacityTask = qualifyRelayCapacity();
  capacityTask.catch(() => {});
  return capacityTask;
}, 30_000);

test('an aborted relay refresh cannot commit a delayed block response', async () => {
  await reconcile.resolve(record.id, accept);
  const before = await journal.list(),
    controller = new AbortController();
  let release;
  mockRequest.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ result: canonical });
      })
  );
  const pending = reconcile.refreshResolved(controller.signal);
  for (let i = 0; i < 10 && !release; i++) await Promise.resolve();
  expect(release).toEqual(expect.any(Function));
  controller.abort();
  release();
  await expect(pending).rejects.toMatchObject({ code: 'PRIVATE_PPV2_RECONCILIATION_REFUSED' });
  expect(await journal.list()).toEqual(before);
});
