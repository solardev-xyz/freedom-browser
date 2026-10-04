const { createHash } = require('crypto');
// Real projection and normalization with deterministic hashes. Native fixture
// separately qualifies pinned engine crypto; no unit claim of Poseidon validity.
const mockHash = (text) => '0' + createHash('sha256').update(text).digest('hex').slice(1);
const mockPair = (a, b) => mockHash(a + b);
const mockZeros = [mockHash('zero')];
for (let n = 0; n < 16; n++) mockZeros.push(mockPair(mockZeros[n], mockZeros[n]));
const mockTransactionHash = (r) => ({
  hash: mockHash(JSON.stringify(r)),
  railgunTxid: mockHash(JSON.stringify([r.nullifiers, r.commitments, r.boundParamsHash])),
});
const mockVerificationHash = (previous, nullifier) => '0x' + mockHash((previous ?? '') + nullifier);
const mockNoteHash = (to, token, value) =>
  BigInt('0x' + mockHash(JSON.stringify([to, token, value.toString()])));
let mockReady, mockGetNoteHash, mockValidateToken;
jest.mock('module', () => ({
  ...jest.requireActual('module'),
  createRequire: () => ({ resolve: () => '/fixture-provenance/engine/index.js' }),
}));
jest.mock('./railgun-engine-runtime', () => ({ verifyRailgunEngineRuntime: jest.fn((v) => v) }));
jest.mock('./railgun-public-records', () => ({ ZERO_NODES: mockZeros }));
jest.mock(
  '/fixture-provenance/engine/utils/poseidon',
  () => ({
    get initPoseidonPromise() {
      return mockReady;
    },
    poseidonHex: ([a, b]) => mockPair(a, b),
  }),
  { virtual: true }
);
jest.mock(
  '/fixture-provenance/engine/transaction/railgun-txid',
  () => ({
    createRailgunTransactionWithHash: (r) => mockTransactionHash(r),
    calculateRailgunTransactionVerificationHash: (p, n) => mockVerificationHash(p, n),
  }),
  { virtual: true }
);
jest.mock(
  '/fixture-provenance/engine/note/note-util',
  () => ({
    getNoteHash: (...a) => mockGetNoteHash(...a),
    assertValidNoteToken: (...a) => mockValidateToken(...a),
  }),
  { virtual: true }
);
const { createRailgunTxidProjection } = require('./railgun-txid-projection');
const { findRailgunNoteTxidWitness } = require('./railgun-txid-note-witness');
const { matchRailgunTxidEvents } = require('./railgun-txid-events');
const { run } = require('./railgun-note-provenance-job');
const pins = require('./railgun-shield-pins.json');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const detach = (v) => JSON.parse(JSON.stringify(v));
let controller, request, guardReport;
beforeEach(() => {
  jest.clearAllMocks();
  mockReady = Promise.resolve();
  mockGetNoteHash = jest.fn(mockNoteHash);
  mockValidateToken = jest.fn();
  controller = new AbortController();
  request = jest.fn(async () => JSON.stringify({ id: 1, value: null }));
  guardReport = jest.fn(() => ({ attempts: 0, canaries: 1, hooks: ['test.guard'] }));
});
afterEach(() => controller.abort());
function projection() {
  return createRailgunTxidProjection({
    hashPair: mockPair,
    transactionHash: mockTransactionHash,
    verificationHash: mockVerificationHash,
    zeroNodes: mockZeros,
  });
}
async function fixture(kind = 'mixed', mutate = () => {}, outputIndex = kind === 'multi' ? 1 : 0) {
  const row = {
    version: 'V2',
    graphID: hex(30) + '0'.repeat(128),
    commitments: [hex(20)],
    nullifiers: [hex(10)],
    boundParamsHash: hex(9),
    blockNumber: 30,
    txid: hex(40).slice(2),
    timestamp: 1,
    utxoTreeIn: 0,
    utxoTreeOut: 1,
    utxoBatchStartPositionOut: 123,
    verificationHash: mockVerificationHash(undefined, hex(10)),
  };
  if (kind === 'mixed') {
    row.unshield = {
      toAddress: '0x' + '12'.repeat(20),
      tokenData: { tokenType: 0, tokenAddress: pins.wrappedNative, tokenSubID: hex(0) },
      value: '400',
    };
    row.commitments.push(hex(mockNoteHash(row.unshield.toAddress, row.unshield.tokenData, 400n)));
  }
  if (kind === 'multi') {
    row.nullifiers.push(hex(11));
    row.commitments.push(hex(21));
  }
  mutate(row);
  const p = projection(),
    values = new Map(),
    read = async (k) => values.get(k) ?? null;
  const { state, writes } = await p.append(p.empty(), [row], read);
  writes.forEach(({ key, value }) => values.set(key, value));
  const note = {
    type: 'Transact',
    txid: '0x' + row.txid,
    hash: row.commitments[outputIndex],
    tree: row.utxoTreeOut,
    position: row.utxoBatchStartPositionOut + outputIndex,
    blockNumber: row.blockNumber,
  };
  const noteWitness = await findRailgunNoteTxidWitness({ state, note, read, projection: p });
  const events = [
    { name: 'Nullified', logIndex: 1, tree: row.utxoTreeIn, values: row.nullifiers },
    ...(row.unshield
      ? [
          {
            name: 'Unshield',
            logIndex: 2,
            to: row.unshield.toAddress,
            token: row.unshield.tokenData.tokenAddress,
            type: row.unshield.tokenData.tokenType,
            subID: BigInt(row.unshield.tokenData.tokenSubID).toString(),
            value: row.unshield.value,
          },
        ]
      : []),
    {
      name: 'Transact',
      logIndex: 3,
      tree: row.utxoTreeOut,
      start: row.utxoBatchStartPositionOut,
      hashes: row.commitments.slice(0, row.commitments.length - (row.unshield ? 1 : 0)),
    },
  ];
  return detach({ archive: '/fixture-engine.asar', state, note, noteWitness, events });
}
const execute = (input) =>
  run(JSON.stringify(input), { request, signal: controller.signal, guardReport });
test.each(['mixed', 'legacy', 'multi'])(
  'verifies %s path/events with exact legacy reply compatibility',
  async (kind) => {
    const input = await fixture(kind);
    await execute(input);
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(request.mock.calls[0][0])).toEqual({
      id: 1,
      method: 'result',
      value: {
        inputSha256: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
        pathVerified: true,
        suppliedCreatorEventsMatched: true,
        ...(kind === 'mixed' ? { unshieldCommitmentVerified: true } : {}),
        ownershipVerified: false,
        eventSourceAuthenticated: false,
        rootAccepted: false,
        spendingEnabled: false,
        coverage: matchRailgunTxidEvents({
          blockNumber: input.note.blockNumber,
          txid: input.note.txid.slice(2),
          events: input.events,
          rows: [input.noteWitness.witness.row],
        }),
        guards: guardReport(),
        inventory: require('./railgun-engine-manifest.json').inventory.sha256,
      },
    });
    if (kind === 'mixed') {
      const u = input.noteWitness.witness.row.unshield;
      expect(mockValidateToken).toHaveBeenCalledWith(u.tokenData, 400n);
      expect(mockGetNoteHash).toHaveBeenCalledWith(u.toAddress, u.tokenData, 400n);
      expect(mockValidateToken.mock.invocationCallOrder[0]).toBeLessThan(
        mockGetNoteHash.mock.invocationCallOrder[0]
      );
    } else {
      expect(mockGetNoteHash).not.toHaveBeenCalled();
      expect(mockValidateToken).not.toHaveBeenCalled();
    }
  }
);
test.each([
  [
    'wrong final hash',
    (r) => {
      r.commitments[1] = hex(99);
    },
  ],
  [
    'wrong gross',
    (r) => {
      r.unshield.value = '401';
    },
  ],
  [
    'wrong recipient',
    (r) => {
      r.unshield.toAddress = '0x' + '13'.repeat(20);
    },
  ],
  [
    'swapped commitments',
    (r) => {
      r.commitments.reverse();
    },
  ],
])('path/event-valid %s reaches and fails final preimage comparison', async (_name, mutate) => {
  const input = await fixture('mixed', mutate);
  expect(() => projection().verifyWitness(input.state, input.noteWitness.witness)).not.toThrow();
  expect(
    matchRailgunTxidEvents({
      blockNumber: 30,
      txid: input.note.txid.slice(2),
      events: input.events,
      rows: [input.noteWitness.witness.row],
    }).matchedRows
  ).toBe(1);
  await expect(execute(input)).rejects.toThrow();
  expect(mockGetNoteHash).toHaveBeenCalledTimes(1);
  expect(request).not.toHaveBeenCalled();
});
// Token API is independently mocked; these cases assert forwarding and final-slot
// selection. Native fixtures exercise the actual pinned token/hash functions.
const genericRows = [
  [
    'multiple inputs/outputs',
    (r) => {
      r.nullifiers.push(hex(11));
      r.commitments.splice(1, 0, hex(21));
    },
    1,
  ],
  [
    'maximum 13 inputs/13 total commitments',
    (r) => {
      r.nullifiers = Array.from({ length: 13 }, (_, i) => hex(100 + i));
      r.commitments = [...Array.from({ length: 12 }, (_, i) => hex(200 + i)), r.commitments.at(-1)];
      r.verificationHash = mockVerificationHash(undefined, r.nullifiers[0]);
    },
    11,
  ],
  [
    'non-WETH ERC20',
    (r) => {
      r.unshield.tokenData.tokenAddress = pins.proxy;
    },
    0,
  ],
  [
    'ERC721',
    (r) => {
      r.unshield.tokenData.tokenType = 1;
      r.unshield.tokenData.tokenSubID = hex(9);
      r.unshield.value = '1';
    },
    0,
  ],
  [
    'ERC1155',
    (r) => {
      r.unshield.tokenData.tokenType = 2;
      r.unshield.tokenData.tokenSubID = hex(9);
    },
    0,
  ],
  [
    'zero ERC20 value',
    (r) => {
      r.unshield.value = '0';
    },
    0,
  ],
];
test.each(genericRows)(
  'generic mixed %s validates actual token arguments and FINAL commitment',
  async (_name, mutate, selected) => {
    const input = await fixture(
      'mixed',
      (r) => {
        mutate(r);
        const u = r.unshield;
        r.commitments[r.commitments.length - 1] = hex(
          mockNoteHash(u.toAddress, u.tokenData, BigInt(u.value))
        );
      },
      selected
    );
    const u = input.noteWitness.witness.row.unshield;
    await execute(input);
    expect(input.noteWitness.outputIndex).toBe(selected);
    expect(mockValidateToken).toHaveBeenCalledTimes(1);
    expect(mockValidateToken).toHaveBeenCalledWith(u.tokenData, BigInt(u.value));
    expect(mockGetNoteHash).toHaveBeenCalledWith(u.toAddress, u.tokenData, BigInt(u.value));
    expect(mockValidateToken.mock.invocationCallOrder[0]).toBeLessThan(
      mockGetNoteHash.mock.invocationCallOrder[0]
    );
    expect(JSON.parse(request.mock.calls[0][0]).value.unshieldCommitmentVerified).toBe(true);
  }
);
test.each([0, 1, 2])(
  'pinned token API rejection for type %s wins even with path-valid matching hash',
  async (type) => {
    const input = await fixture('mixed', (r) => {
      r.unshield.tokenData.tokenType = type;
      r.unshield.tokenData.tokenSubID = hex(9);
      const u = r.unshield;
      r.commitments[1] = hex(mockNoteHash(u.toAddress, u.tokenData, BigInt(u.value)));
    });
    expect(() => projection().verifyWitness(input.state, input.noteWitness.witness)).not.toThrow();
    mockValidateToken.mockImplementation(() => {
      throw Error('pinned validation refused');
    });
    await expect(execute(input)).rejects.toThrow();
    expect(mockGetNoteHash).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  }
);
test('nullable absent unshield keeps no-unshield reply bytes and skips token/hash APIs', async () => {
  const input = await fixture('multi', (r) => {
    r.unshield = null;
  });
  await execute(input);
  const value = JSON.parse(request.mock.calls[0][0]).value;
  expect(Object.hasOwn(value, 'unshieldCommitmentVerified')).toBe(false);
  expect(mockValidateToken).not.toHaveBeenCalled();
  expect(mockGetNoteHash).not.toHaveBeenCalled();
  expect(Object.keys(value)).toEqual([
    'inputSha256',
    'pathVerified',
    'suppliedCreatorEventsMatched',
    'ownershipVerified',
    'eventSourceAuthenticated',
    'rootAccepted',
    'spendingEnabled',
    'coverage',
    'guards',
    'inventory',
  ]);
});
test('path-valid wrong final hash with selected ordinary index 1 cannot check commitment index 1 instead', async () => {
  const input = await fixture(
    'mixed',
    (r) => {
      r.nullifiers.push(hex(11));
      r.commitments.splice(1, 0, hex(21));
      r.commitments[r.commitments.length - 1] = hex(99);
    },
    1
  );
  expect(() => projection().verifyWitness(input.state, input.noteWitness.witness)).not.toThrow();
  await expect(execute(input)).rejects.toThrow();
  expect(mockGetNoteHash).toHaveBeenCalledTimes(1);
  expect(request).not.toHaveBeenCalled();
});
test.each(['sibling', 'root', 'note', 'row', 'events', 'extra'])(
  'refuses %s substitution before result',
  async (kind) => {
    const input = await fixture();
    if (kind === 'sibling') input.noteWitness.witness.elements[0] = hex(99).slice(2);
    if (kind === 'root') input.state.root = input.noteWitness.witness.root = hex(99).slice(2);
    if (kind === 'note') input.note.position++;
    if (kind === 'row') input.noteWitness.witness.row.unshield.value = '401';
    if (kind === 'events') input.events[1].value = '401';
    if (kind === 'extra') input.mode = 'verified';
    await expect(execute(input)).rejects.toThrow();
    expect(mockGetNoteHash).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  }
);
test('aborting Poseidon initialization prevents hash work and any result', async () => {
  const input = await fixture();
  let release;
  mockReady = new Promise((r) => {
    release = r;
  });
  const work = execute(input);
  const observed = work.catch((e) => e);
  await Promise.resolve();
  controller.abort();
  release();
  expect(await observed).toMatchObject({ code: 'ERR_ASSERTION' });
  expect(mockGetNoteHash).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});
test('token validator failure cannot emit a successful hash diagnostic', async () => {
  const input = await fixture();
  mockValidateToken.mockImplementation(() => {
    throw Error('invalid');
  });
  await expect(execute(input)).rejects.toThrow();
  expect(mockGetNoteHash).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});
test('aborted hash completion cannot publish a result', async () => {
  const input = await fixture();
  mockGetNoteHash.mockImplementation((...a) => {
    controller.abort();
    return mockNoteHash(...a);
  });
  await expect(execute(input)).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});
test.each(['guard', 'ack', 'post-result'])('refuses %s failure', async (kind) => {
  const input = await fixture();
  if (kind === 'guard')
    guardReport.mockReturnValue({ attempts: 1, canaries: 1, hooks: ['test.guard'] });
  if (kind === 'ack') request.mockResolvedValue('{"id":2,"value":null}');
  if (kind === 'post-result')
    request.mockImplementation(async () => {
      controller.abort();
      return '{"id":1,"value":null}';
    });
  await expect(execute(input)).rejects.toThrow();
});
