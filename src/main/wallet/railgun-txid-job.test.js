const { createHash } = require('crypto');
const mockArchive = '/fixture-txid-history.asar';
const mockHash = (value) => '0' + createHash('sha256').update(value).digest('hex').slice(1);
const mockPair = (a, b) => mockHash(a + b);
const mockTransaction = (row) => ({
  hash: mockHash(JSON.stringify(row)),
  railgunTxid: mockHash(row.nullifiers[0]),
});
const mockVerification = (previous, nullifier) => '0x' + mockHash((previous ?? '') + nullifier);
let mockZeros, mockPoseidonReady;
// Minimal AbstractLevelDOWN public-method shim. The actual remote bridge, job,
// projection and Merkle checks execute; only engine crypto is deterministic here.
class mockAbstractLevelDOWN {
  open(callback) {
    this._open({}, callback);
  }
  get(key, callback) {
    this._get(Buffer.from(key), {}, callback);
  }
  batch(operations, callback) {
    this._batch(operations, {}, callback);
  }
}
class mockAbstractIterator {}
jest.mock('module', () => ({
  ...jest.requireActual('module'),
  createRequire: jest.fn((filename) => {
    if (filename !== mockArchive + '/package.json') throw Error('unexpected runtime');
    const request = (name) => {
      if (name !== 'abstract-leveldown') throw Error('unexpected package: ' + name);
      return { AbstractLevelDOWN: mockAbstractLevelDOWN, AbstractIterator: mockAbstractIterator };
    };
    request.resolve = (name) => {
      if (name !== '@railgun-community/engine') throw Error('unexpected resolution');
      return mockArchive + '/node_modules/@railgun-community/engine/dist/index.js';
    };
    return request;
  }),
}));
jest.mock('./railgun-engine-runtime', () => ({
  verifyRailgunEngineRuntime: jest.fn((archive) => {
    if (archive !== mockArchive) throw Error('untrusted runtime');
    return archive;
  }),
}));
jest.mock('./railgun-public-records', () => ({
  ...jest.requireActual('./railgun-public-records'),
  ZERO_NODES: mockZeros,
}));
jest.mock(
  '/fixture-txid-history.asar/node_modules/@railgun-community/engine/dist/utils/poseidon',
  () => ({
    get initPoseidonPromise() {
      return mockPoseidonReady;
    },
    poseidonHex: (values) => mockPair(...values),
  }),
  { virtual: true }
);
jest.mock(
  '/fixture-txid-history.asar/node_modules/@railgun-community/engine/dist/transaction/railgun-txid',
  () => ({
    createRailgunTransactionWithHash: (row) => mockTransaction(row),
    calculateRailgunTransactionVerificationHash: (...args) => mockVerification(...args),
  }),
  { virtual: true }
);
jest.mock('./railgun-poi-prover', () => {
  throw Error('historical root must not import prover');
});
jest.mock('./railgun-artifacts', () => {
  throw Error('historical root must not import artifacts');
});
jest.mock('./privacy-storage', () => {
  throw Error('historical root must not open a store');
});
jest.mock('../networks/private-rpc', () => {
  throw Error('historical root must not import RPC');
});
let run,
  payload,
  database,
  checkpoints,
  rows,
  controller,
  request,
  guardReport,
  results,
  reads,
  gates;
const copy = (value) => JSON.parse(JSON.stringify(value));
const input = () => JSON.stringify({ archive: mockArchive, mode: 'historical-root' });
const context = () => ({ request, signal: controller.signal, guardReport });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  const gate = { promise, resolve };
  gates.push(gate);
  return gate;
};
beforeEach(async () => {
  jest.resetModules();
  mockPoseidonReady = Promise.resolve();
  mockZeros = [mockHash('zero')];
  for (let n = 0; n < 16; n++) mockZeros.push(mockPair(mockZeros[n], mockZeros[n]));
  const projection = require('./railgun-txid-projection').createRailgunTxidProjection({
    hashPair: mockPair,
    transactionHash: mockTransaction,
    verificationHash: mockVerification,
    zeroNodes: mockZeros,
  });
  let previous;
  rows = Array.from({ length: 5 }, (_, index) => {
    const nullifier = '0x' + mockHash('nullifier-' + index);
    previous = mockVerification(previous, nullifier);
    return {
      version: 'V2',
      graphID: '0x' + (index + 1).toString(16).padStart(64, '0') + '0'.repeat(128),
      commitments: ['0x' + mockHash('commitment-' + index)],
      nullifiers: [nullifier],
      boundParamsHash: '0x' + mockHash('params'),
      blockNumber: index + 1,
      txid: mockHash('transaction-' + index),
      timestamp: index,
      utxoTreeIn: 0,
      utxoTreeOut: 0,
      utxoBatchStartPositionOut: index,
      verificationHash: previous,
    };
  });
  database = new Map();
  checkpoints = [];
  let current = projection.empty();
  for (const row of rows) {
    const appended = await projection.append(
      current,
      [row],
      async (key) => database.get(key) ?? null
    );
    for (const { key, value } of appended.writes) database.set(key, value);
    current = appended.state;
    checkpoints.push(copy(current));
  }
  payload = { state: copy(current), index: 1 };
  controller = new AbortController();
  results = [];
  reads = [];
  gates = [];
  guardReport = jest.fn(() => ({ attempts: 0, canaries: 1, hooks: ['fixture.guard'] }));
  request = jest.fn(async (wire) => {
    const message = JSON.parse(wire);
    let value;
    if (message.method === 'input') {
      expect(message).toEqual({ id: 1, method: 'input' });
      value = copy(payload);
    } else if (message.method === 'get') {
      const key = Buffer.from(message.args.key, 'base64').toString();
      expect(Buffer.from(key).toString('base64')).toBe(message.args.key);
      expect(Object.keys(message.args)).toEqual(['key']);
      reads.push(key);
      const text = database.get(key);
      value = text === undefined ? null : Buffer.from(text).toString('base64');
    } else {
      expect(message.method).toBe('result');
      results.push(message.value);
      value = null;
    }
    return JSON.stringify({ id: message.id, value });
  });
  run = require('./railgun-txid-job').run;
});
afterEach(() => {
  controller.abort();
  for (const gate of gates) gate.resolve();
  jest.restoreAllMocks();
});
test.each([0, 1, 2, 3, 4])(
  'historical-root computes index %i from real read-only projection and remote broker',
  async (index) => {
    payload.index = index;
    const before = [...database];
    await run(input(), context());
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      historicalRoot: {
        version: 1,
        tree: 0,
        index,
        root: checkpoints[index].root,
        checkpointIndex: 4,
        checkpointRoot: checkpoints[4].root,
        transcript: checkpoints[4].transcript,
        localPrefixComputed: true,
        globalTxidCompleteness: false,
        ownershipVerified: false,
        eventCoverageVerified: false,
        rootAccepted: false,
        spendingEnabled: false,
      },
      guards: { attempts: 0, canaries: 1, hooks: ['fixture.guard'] },
      inventory: require('./railgun-engine-manifest.json').inventory.sha256,
    });
    expect(reads[0]).toBe('txid:state');
    expect(reads[1]).toBe('txid:row:' + index);
    expect(reads.length).toBeLessThanOrEqual(20);
    expect(
      reads.every((key) =>
        /^txid:(state|row:[0-9]+|lookup:[0-9a-f]{64}|node:[0-9]+:[0-9]+)$/.test(key)
      )
    ).toBe(true);
    expect([...database]).toEqual(before);
    expect(
      request.mock.calls
        .map(([wire]) => JSON.parse(wire).method)
        .every((method) => ['input', 'get', 'result'].includes(method))
    ).toBe(true);
    expect(JSON.parse(input())).not.toHaveProperty('expectedRoot');
    expect(payload).toEqual({ state: checkpoints[4], index });
    if (index < 4) expect(results[0].historicalRoot.root).not.toBe(payload.state.root);
  }
);
test.each(['expectedRoot', 'root', 'payload', 'rows', 'source', 'viewingKey'])(
  'historical-root refuses extra payload field %s before boundary lookup',
  async (key) => {
    payload[key] = 'oracle';
    await expect(run(input(), context())).rejects.toThrow();
    expect(reads).toEqual(['txid:state']);
    expect(results).toEqual([]);
  }
);
test.each(['archive-extra', 'mode', 'engine'])(
  'historical-root refuses invalid startup %s before broker use',
  async (kind) => {
    const value = JSON.parse(input());
    if (kind === 'archive-extra') value.expectedRoot = checkpoints[0].root;
    if (kind === 'mode') value.mode = 'historical-root-write';
    if (kind === 'engine') value.archive = '/unknown.asar';
    await expect(run(JSON.stringify(value), context())).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  }
);
test.each([undefined, null, '1', -1, 0.5, 5, 8000])(
  'historical-root refuses index %p before boundary row',
  async (index) => {
    payload.index = index;
    await expect(run(input(), context())).rejects.toThrow();
    expect(reads).toEqual(['txid:state']);
    expect(results).toEqual([]);
  }
);
test.each(['count', 'root', 'transcript', 'branches'])(
  'historical-root pins exact stored %s',
  async (key) => {
    if (key === 'count') payload.state.count--;
    else if (key === 'branches') payload.state.branches[0] = mockZeros[0];
    else payload.state[key] = mockHash('wrong-' + key);
    await expect(run(input(), context())).rejects.toThrow();
    expect(reads).toEqual(['txid:state']);
    expect(results).toEqual([]);
  }
);
test('historical-root refuses unsupported current count before projection', async () => {
  const changed = copy(payload.state);
  changed.count = 8001;
  payload.state = changed;
  database.set('txid:state', JSON.stringify(changed));
  await expect(run(input(), context())).rejects.toThrow();
  expect(reads).toEqual(['txid:state']);
  expect(results).toEqual([]);
});
test.each(['missing-row', 'wrong-row-sha', 'redirected-lookup', 'right-sibling'])(
  'historical-root rejects corrupt %s even when a discarded subtree would not affect the old fold',
  async (kind) => {
    payload.index = 0;
    if (kind === 'missing-row') database.delete('txid:row:0');
    if (kind === 'wrong-row-sha') {
      const row = JSON.parse(database.get('txid:row:0'));
      row.rowSha256 = '9'.repeat(64);
      database.set('txid:row:0', JSON.stringify(row));
    }
    if (kind === 'redirected-lookup')
      database.set('txid:lookup:' + mockTransaction(rows[0]).railgunTxid, '1');
    if (kind === 'right-sibling')
      database.set('txid:node:0:1', mockHash('corrupt-discarded-right'));
    await expect(run(input(), context())).rejects.toThrow();
    expect(results).toEqual([]);
  }
);
test('historical-root checks guard attempts before publishing any result', async () => {
  guardReport.mockReturnValue({ attempts: 1, canaries: 1, hooks: ['fixture.guard'] });
  await expect(run(input(), context())).rejects.toThrow();
  expect(results).toEqual([]);
});
test.each(['id', 'extra-key', 'non-null'])(
  'historical-root rejects malformed result acknowledgment %s',
  async (kind) => {
    const dispatch = request.getMockImplementation();
    request.mockImplementation(async (wire) => {
      const message = JSON.parse(wire);
      if (message.method !== 'result') return dispatch(wire);
      results.push(message.value);
      return JSON.stringify({
        id: kind === 'id' ? message.id + 1 : message.id,
        value: kind === 'non-null' ? true : null,
        ...(kind === 'extra-key' ? { accepted: true } : {}),
      });
    });
    await expect(run(input(), context())).rejects.toThrow();
    expect(results).toHaveLength(1);
  }
);
test('historical-root cancellation during runtime setup makes no broker request', async () => {
  const gate = deferred();
  mockPoseidonReady = gate.promise;
  const pending = run(input(), context());
  const refused = expect(pending).rejects.toThrow();
  controller.abort();
  gate.resolve();
  await refused;
  expect(request).not.toHaveBeenCalled();
});
test('historical-root cancellation during a borrowed row read never admits a late result', async () => {
  const gate = deferred(),
    entered = deferred(),
    dispatch = request.getMockImplementation();
  request.mockImplementation(async (wire) => {
    const message = JSON.parse(wire);
    if (
      message.method === 'get' &&
      Buffer.from(message.args.key, 'base64').toString() === 'txid:row:1'
    ) {
      entered.resolve();
      await gate.promise;
    }
    return dispatch(wire);
  });
  const pending = run(input(), context());
  const refused = expect(pending).rejects.toThrow();
  try {
    await entered.promise;
    controller.abort();
    gate.resolve();
    await refused;
    expect(results).toEqual([]);
    expect(guardReport).not.toHaveBeenCalled();
  } finally {
    gate.resolve();
    await refused;
  }
});
