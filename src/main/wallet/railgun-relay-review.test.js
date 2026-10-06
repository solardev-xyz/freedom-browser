const mock = {};
jest.mock('./railgun-account-wallet', () => ({
  readRailgunAccountOwnedNotes: (...args) => mock.read(...args),
  reserveRailgunAccountWalletHandoff: (...args) => mock.reserve(...args),
}));
jest.mock('./railgun-account-public', () => ({
  getRailgunAccountPublicIdentity: (...args) => mock.public(...args),
}));
jest.mock('./railgun-relay-quote-verify', () => ({
  verifyRailgunRelayQuote: (...args) => mock.verify(...args),
}));
const { createRailgunRelayReview } = require('./railgun-relay-review');
const pins = require('./railgun-shield-pins.json');
const refused = { code: 'RAILGUN_RELAY_REVIEW_REFUSED' };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
function fixture() {
  const controller = new AbortController(),
    signal = controller.signal;
  const account = { signal, view: {}, generationId: 'wallet-1', close: jest.fn() };
  const owners = Object.fromEntries(
    ['identity', 'enrollment', 'coordinator'].map((k) => [k, { signal, close: jest.fn() }])
  );
  const note = {
    id: '0:1',
    tree: 0,
    position: 1,
    amount: 1000n,
    asset: { __type: 'erc20', contract: pins.wrappedNative },
    spentTxid: false,
    hash: 'abc',
    txid: 'def',
  };
  const owned = {
    read: { instanceId: 'self', received: [note] },
    ownedPoi: [{ id: '0:1', type: 'Shield', hash: 'abc', txid: 'def' }],
    checkpointHash: 'checkpoint',
  };
  const publicIdentity = { generationId: 'public-1' };
  const handoff = { assertCurrent: jest.fn(), release: jest.fn() };
  mock.read = jest.fn((a, o) => {
    if (a !== account || o.identity !== owners.identity) throw Error('foreign');
    return owned;
  });
  mock.public = jest.fn(() => publicIdentity);
  mock.reserve = jest.fn(() => handoff);
  mock.verify = jest.fn(async () => ({ viewingPublicKey: '02'.repeat(32), masterPublicKey: '7' }));
  const review = jest.fn(async () => true);
  const fields = {
    fees: { [pins.wrappedNative]: '0xde0b6b3a7640000' },
    feeExpiration: Date.now() + 240000,
    feesID: 'public-test',
    railgunAddress: '0zk1' + 'q'.repeat(123),
    identifier: 'public test',
    availableWallets: 1,
    version: '8.0.0',
    relayAdapt: pins.relayAdapt,
    requiredPOIListKeys: ['44'.repeat(32)],
    reliability: 0.5,
  };
  const request = {
    noteId: '0:1',
    quote: {
      data: Buffer.from(JSON.stringify(fields)).toString('hex'),
      signature: '03'.repeat(32) + '00'.repeat(32),
    },
    gas: { transactionType: 0, gasEstimate: '84', gasPrice: '1', minGasPrice: '1' },
    maxFee: '100',
  };
  const create = () =>
    createRailgunRelayReview({ account, owners, signal, archive: '/public/engine.asar', review });
  return { controller, account, owners, owned, publicIdentity, handoff, review, request, create };
}
afterEach(() => jest.restoreAllMocks());
test('local fee/self review with exact owner joins, no scope promotion and borrowed owners', async () => {
  const f = fixture(),
    h = f.create(),
    result = await h.reviewLocal(f.request);
  expect(result.summary).toMatchObject({
    gasLimitMultiplierBps: 12000,
    inputAmount: '1000',
    feeAmount: '100',
    netAmount: '900',
    localReviewOnly: true,
    operatorTrusted: false,
    gasEstimateVerified: false,
    permitsSigning: false,
    permitsPoiQueries: false,
    permitsRelaySend: false,
  });
  expect(result.summary).not.toHaveProperty('gasBufferBps');
  expect(f.review).toHaveBeenCalledTimes(1);
  expect(f.handoff.release).toHaveBeenCalledTimes(1);
  expect(Object.keys(h).sort()).toEqual(['close', 'closed', 'reviewLocal', 'signal']);
  expect(mock.verify.mock.calls[0][0]).not.toHaveProperty('noteId');
  expect(mock.verify.mock.calls[0][0]).not.toHaveProperty('inputAmount');
  expect(result.receipt.signal.aborted).toBe(false);
  await expect(h.reviewLocal(f.request)).rejects.toMatchObject(refused);
  expect(result.receipt.signal.aborted).toBe(true);
  await h.closed;
  expect(f.account.close).not.toHaveBeenCalled();
  Object.values(f.owners).forEach((o) => expect(o.close).not.toHaveBeenCalled());
  expect(mock.read(f.account, f.owners)).toBe(f.owned);
});
test('completedOnly account refuses at genuine handoff seam before crypto/review', async () => {
  const f = fixture();
  mock.reserve.mockImplementation(() => {
    throw Error('completedOnly');
  });
  const h = f.create();
  await expect(h.reviewLocal(f.request)).rejects.toMatchObject(refused);
  await h.closed;
  expect(mock.verify).not.toHaveBeenCalled();
  expect(f.review).not.toHaveBeenCalled();
});
test.each(['cap', 'net', 'spent', 'duplicate', 'foreign'])(
  'refuses %s before verification',
  async (kind) => {
    const f = fixture();
    if (kind === 'cap') f.request.maxFee = '99';
    if (kind === 'net') f.owned.read.received[0].amount = 100n;
    if (kind === 'spent') f.owned.read.received[0].spentTxid = 'spent';
    if (kind === 'duplicate') f.owned.ownedPoi.push({ ...f.owned.ownedPoi[0] });
    if (kind === 'foreign') f.owned.ownedPoi[0].hash = 'other';
    const h = f.create();
    await expect(h.reviewLocal(f.request)).rejects.toMatchObject(refused);
    await h.closed;
    expect(mock.verify).not.toHaveBeenCalled();
  }
);
test.each(['view', 'generation', 'checkpoint', 'public-generation', 'note', 'record'])(
  'reattests %s after original verification',
  async (kind) => {
    const f = fixture(),
      gate = deferred();
    mock.verify.mockReturnValue(gate.promise);
    const h = f.create(),
      pending = h.reviewLocal(f.request);
    if (kind === 'view') f.account.view = {};
    if (kind === 'generation') f.account.generationId = 'new';
    if (kind === 'checkpoint') f.owned.checkpointHash = 'new';
    if (kind === 'public-generation') f.publicIdentity.generationId = 'new';
    if (kind === 'note') f.owned.read.received[0].amount = 999n;
    if (kind === 'record') f.owned.ownedPoi[0].type = 'Transact';
    gate.resolve({ viewingPublicKey: '02'.repeat(32), masterPublicKey: '7' });
    await expect(pending).rejects.toMatchObject(refused);
    await h.closed;
    expect(f.review).not.toHaveBeenCalled();
  }
);
test('detaches caller quote/gas/cap during pending verification', async () => {
  const f = fixture(),
    gate = deferred();
  mock.verify.mockReturnValue(gate.promise);
  const h = f.create(),
    pending = h.reviewLocal(f.request);
  f.request.quote.data = '';
  f.request.gas.gasPrice = '999';
  f.request.maxFee = '999';
  f.request.noteId = 'other';
  gate.resolve({ viewingPublicKey: '02'.repeat(32), masterPublicKey: '7' });
  const value = await pending;
  expect(value.summary.feeAmount).toBe('100');
  expect(value.summary.maximumFee).toBe('100');
  h.close();
  await h.closed;
});
test.each(['verification', 'review'])(
  'close retains original %s and phase until settlement',
  async (kind) => {
    const f = fixture(),
      gate = deferred();
    if (kind === 'verification') mock.verify.mockReturnValue(gate.promise);
    else f.review.mockReturnValue(gate.promise);
    const h = f.create(),
      pending = h.reviewLocal(f.request);
    await Promise.resolve();
    h.close();
    let settled = false;
    h.closed.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(f.handoff.release).not.toHaveBeenCalled();
    gate.resolve(
      kind === 'verification' ? { viewingPublicKey: '02'.repeat(32), masterPublicKey: '7' } : true
    );
    await expect(pending).rejects.toMatchObject(refused);
    await h.closed;
    expect(f.handoff.release).toHaveBeenCalledTimes(1);
    expect(f.account.close).not.toHaveBeenCalled();
  }
);
test('unobserved process drain rejects closed and retains exclusion', async () => {
  const f = fixture();
  mock.verify.mockRejectedValue(
    Object.assign(Error('private details'), { code: 'RAILGUN_RELAY_QUOTE_DRAIN_FAILED' })
  );
  const h = f.create();
  await expect(h.reviewLocal(f.request)).rejects.toMatchObject(refused);
  await expect(h.closed).rejects.toMatchObject(refused);
  expect(f.handoff.release).not.toHaveBeenCalled();
});
test.each(['false', 'throw', 'reject', 'close', 'expiry', 'monotonic', 'rollback', 'owner-abort'])(
  'review final refusal %s',
  async (kind) => {
    const f = fixture(),
      h = f.create();
    f.review.mockImplementation(async () => {
      if (kind === 'throw' || kind === 'reject') throw Error('private error');
      if (kind === 'close') h.close();
      if (kind === 'expiry') jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 240001);
      if (kind === 'rollback') jest.spyOn(Date, 'now').mockReturnValue(Date.now() - 1000);
      if (kind === 'monotonic')
        jest.spyOn(performance, 'now').mockReturnValue(performance.now() + 30001);
      if (kind === 'owner-abort') f.controller.abort();
      return kind !== 'false';
    });
    await expect(h.reviewLocal(f.request)).rejects.toMatchObject(refused);
    await h.closed;
    expect(f.handoff.release).toHaveBeenCalledTimes(1);
  }
);
test('expiry signal invalidates successful receipt without closing borrowed account', async () => {
  jest.useFakeTimers();
  try {
    const f = fixture(),
      h = f.create();
    const value = await h.reviewLocal(f.request);
    jest.advanceTimersByTime(45000);
    await h.closed;
    expect(value.receipt.signal.aborted).toBe(true);
    expect(f.account.close).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});
test('release failure is sticky, refuses result and rejects closed without claiming drain', async () => {
  const f = fixture();
  f.handoff.release.mockImplementation(() => {
    throw Error('release failure');
  });
  const h = f.create();
  await expect(h.reviewLocal(f.request)).rejects.toMatchObject(refused);
  await expect(h.closed).rejects.toMatchObject(refused);
  expect(f.handoff.release).toHaveBeenCalledTimes(1);
});
test('reentrant close at final handoff release cannot publish approval', async () => {
  const f = fixture(),
    h = f.create();
  f.handoff.release.mockImplementation(() => h.close());
  await expect(h.reviewLocal(f.request)).rejects.toMatchObject(refused);
  await h.closed;
});
test('sync review throw is observed and releases the live phase', async () => {
  const f = fixture();
  f.review.mockImplementation(() => {
    throw Error('private details');
  });
  const h = f.create();
  await expect(h.reviewLocal(f.request)).rejects.toMatchObject(refused);
  await h.closed;
  expect(f.handoff.release).toHaveBeenCalledTimes(1);
});
test.each(['rollback', 'monotonic', 'expiry'])(
  'clock refusal after awaited crypto: %s',
  async (kind) => {
    const f = fixture(),
      gate = deferred();
    mock.verify.mockReturnValue(gate.promise);
    const h = f.create(),
      pending = h.reviewLocal(f.request);
    if (kind === 'rollback') jest.spyOn(Date, 'now').mockReturnValue(Date.now() - 1);
    if (kind === 'expiry') jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 240001);
    if (kind === 'monotonic')
      jest.spyOn(performance, 'now').mockReturnValue(performance.now() + 45001);
    gate.resolve({ viewingPublicKey: '02'.repeat(32), masterPublicKey: '7' });
    await expect(pending).rejects.toMatchObject(refused);
    await h.closed;
    expect(f.review).not.toHaveBeenCalled();
  }
);
test('quote already expired never reserves a phase or starts verification', async () => {
  const f = fixture();
  const fields = JSON.parse(Buffer.from(f.request.quote.data, 'hex'));
  fields.feeExpiration = Date.now() - 1;
  f.request.quote.data = Buffer.from(JSON.stringify(fields)).toString('hex');
  const h = f.create();
  await expect(h.reviewLocal(f.request)).rejects.toMatchObject(refused);
  await h.closed;
  expect(mock.reserve).not.toHaveBeenCalled();
  expect(mock.verify).not.toHaveBeenCalled();
});
test('final owner reattestation cannot overrun deadline with delayed timer dispatch', async () => {
  const f = fixture(),
    h = f.create();
  f.handoff.release.mockImplementation(() => {
    mock.read.mockImplementation(() => {
      jest.spyOn(performance, 'now').mockReturnValue(performance.now() + 45001);
      return f.owned;
    });
  });
  await expect(h.reviewLocal(f.request)).rejects.toMatchObject(refused);
  await h.closed;
});
