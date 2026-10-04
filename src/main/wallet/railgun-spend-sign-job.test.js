const mockPublic = jest.fn(),
  mockSign = jest.fn(),
  mockVerify = jest.fn(),
  mockPoseidon = jest.fn(),
  mockNoteHash = jest.fn();
jest.mock('./railgun-engine-runtime', () => ({
  verifyRailgunEngineRuntime: jest.fn(() => '/engine.asar'),
}));
jest.mock('./railgun-private-intent', () => ({ validateRailgunPrivateSigningIntent: jest.fn() }));
jest.mock(
  '/engine.asar/node_modules/@railgun-community/engine/dist/utils/poseidon',
  () => ({
    initPoseidonPromise: Promise.resolve(),
    poseidon: (...args) => mockPoseidon(...args),
  }),
  { virtual: true }
);
jest.mock(
  '/engine.asar/node_modules/@railgun-community/engine/dist/utils/keys-utils',
  () => ({
    getPublicSpendingKey: (...args) => mockPublic(...args),
    signEDDSA: (...args) => mockSign(...args),
    verifyEDDSA: (...args) => mockVerify(...args),
  }),
  { virtual: true }
);
jest.mock(
  '/engine.asar/node_modules/@railgun-community/engine/dist/note/note-util',
  () => ({
    getNoteHash: (...args) => mockNoteHash(...args),
  }),
  { virtual: true }
);
const { run } = require('./railgun-spend-sign-job');
const { validateRailgunPrivateSigningIntent } = require('./railgun-private-intent');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
let controller, input, context, bytes, checked;
beforeEach(() => {
  jest.clearAllMocks();
  controller = new AbortController();
  bytes = new Uint8Array(32).fill(7);
  checked = {
    kind: 'railgun-token-unshield',
    merkleRoot: hex(1),
    boundParamsHash: hex(2),
    nullifier: hex(3),
    commitment: hex(4),
    recipient: '0x' + '12'.repeat(20),
    amount: '1000',
    digest: hex(99),
  };
  input = {
    archive: '/engine.asar',
    expected: {},
    transaction: {},
    spendingPublicKey: [hex(5), hex(6)],
    expectedHash: hex(7),
  };
  mockPublic.mockReturnValue([5n, 6n]);
  mockSign.mockReturnValue({ R8: [8n, 9n], S: 10n });
  mockVerify.mockReturnValue(true);
  mockPoseidon.mockReturnValue(7n);
  mockNoteHash.mockReturnValue(4n);
  validateRailgunPrivateSigningIntent.mockReturnValue(checked);
  context = {
    signal: controller.signal,
    requestKey: jest.fn(async () => bytes),
    request: jest.fn(async () => JSON.stringify({ id: 2, value: null })),
    guardReport: jest.fn(() => ({ attempts: 0, hooks: ['test'], canaries: 1 })),
  };
});
const invoke = () => run(JSON.stringify(input), context);
test.each(['railgun-token-unshield', 'railgun-private-transfer'])(
  'one %s signature binds reconstructed public inputs, then wipes before reporting',
  async (kind) => {
    checked.kind = kind;
    context.request.mockImplementation(async () => {
      expect([...bytes]).toEqual(Array(32).fill(0));
      return JSON.stringify({ id: 2, value: null });
    });
    await invoke();
    expect(validateRailgunPrivateSigningIntent).toHaveBeenCalledWith(
      input.transaction,
      input.expected
    );
    expect(mockPoseidon).toHaveBeenCalledWith([1n, 2n, 3n, 4n]);
    expect(mockNoteHash).toHaveBeenCalledTimes(kind === 'railgun-token-unshield' ? 1 : 0);
    expect(context.requestKey).toHaveBeenCalledWith(
      JSON.stringify({
        id: 1,
        method: 'key',
        purpose: 'spending-sign',
        transactionDigest: checked.digest,
        expectedHash: input.expectedHash,
      })
    );
    expect(mockSign).toHaveBeenCalledTimes(1);
    expect(mockVerify).toHaveBeenCalledWith(7n, { R8: [8n, 9n], S: 10n }, [5n, 6n]);
    expect(context.request).toHaveBeenCalledTimes(1);
    const value = JSON.parse(context.request.mock.calls[0][0]).value;
    expect(value).toMatchObject({
      signature: { R8: [hex(8), hex(9)], S: hex(10) },
      message: hex(7),
      transactionDigest: hex(99),
    });
    expect(Object.keys(value).sort()).toEqual([
      'guards',
      'inventory',
      'message',
      'signature',
      'transactionDigest',
    ]);
  }
);
test.each([
  () => {
    input.extra = true;
  },
  () => {
    input.expectedHash = hex(8);
  },
  () => {
    input.expectedHash = '0x01';
  },
  () => {
    input.spendingPublicKey = [hex(5)];
  },
  () => {
    input.spendingPublicKey[0] = '0x' + 'ff'.repeat(32);
  },
  () => {
    mockNoteHash.mockReturnValue(5n);
  },
  () => {
    validateRailgunPrivateSigningIntent.mockImplementationOnce(() => {
      throw Error('policy');
    });
  },
  () => {
    controller.abort();
  },
  () => {
    context.guardReport.mockReturnValue({ attempts: 1 });
  },
])('refuses invalid intent before asking for any key %#', async (change) => {
  change();
  await expect(invoke()).rejects.toThrow();
  expect(context.requestKey).not.toHaveBeenCalled();
  expect(mockSign).not.toHaveBeenCalled();
  expect(context.request).not.toHaveBeenCalled();
});
test.each([
  () => {
    bytes = new Uint8Array(31).fill(7);
  },
  () => {
    mockPublic.mockReturnValue([5n, 7n]);
  },
  () => {
    mockSign.mockImplementationOnce(() => {
      throw Error('sign');
    });
  },
  () => {
    mockVerify.mockReturnValue(false);
  },
  () => {
    context.requestKey.mockImplementation(async () => {
      controller.abort();
      return bytes;
    });
  },
])('wipes any received buffer on failure and returns no signature %#', async (change) => {
  change();
  await expect(invoke()).rejects.toThrow();
  expect([...bytes]).toEqual(Array(bytes.length).fill(0));
  expect(context.request).not.toHaveBeenCalled();
});
test('abort after signing suppresses the result and wipes the key', async () => {
  mockSign.mockImplementationOnce(() => {
    controller.abort();
    return { R8: [8n, 9n], S: 10n };
  });
  await expect(invoke()).rejects.toThrow();
  expect([...bytes]).toEqual(Array(32).fill(0));
  expect(context.request).not.toHaveBeenCalled();
});
test('refuses a wrong result acknowledgement after wiping', async () => {
  context.request.mockResolvedValue(JSON.stringify({ id: 2, value: true }));
  await expect(invoke()).rejects.toThrow();
  expect([...bytes]).toEqual(Array(32).fill(0));
});

function realPartial(change) {
  const {
    createRailgunPartialCapsuleData,
  } = require('../../../scripts/fixtures/railgun-partial-capsule-data');
  const fixture = createRailgunPartialCapsuleData();
  change?.(fixture);
  const { preparation } = fixture.capsule;
  preparation.transaction.data = fixture.encode();
  input.transaction = preparation.transaction;
  input.expected = preparation.expected;
  input.expectedHash = preparation.expectedHash;
  validateRailgunPrivateSigningIntent.mockImplementationOnce(
    jest.requireActual('./railgun-private-intent').validateRailgunPrivateSigningIntent
  );
  return preparation;
}
test('real partial intent hashes the final unshield preimage and signs all five ordered inputs', async () => {
  const preparation = realPartial();
  await invoke();
  expect(mockNoteHash).toHaveBeenCalledWith(
    preparation.recipient,
    {
      tokenType: 0,
      tokenAddress: require('./railgun-shield-pins.json').wrappedNative,
      tokenSubID: '0',
    },
    400n
  );
  expect(mockPoseidon).toHaveBeenCalledWith(
    [
      preparation.expected.merkleRoot,
      preparation.expected.boundParamsHash,
      preparation.expected.nullifier,
      preparation.expected.changeCommitment,
      preparation.expected.unshieldCommitment,
    ].map(BigInt)
  );
  expect(context.requestKey).toHaveBeenCalledTimes(1);
  expect(mockSign).toHaveBeenCalledTimes(1);
  expect([...bytes]).toEqual(Array(32).fill(0));
});
test.each(['change instead of unshield', 'wrong preimage', 'wrong message'])(
  'partial %s refuses before the spending key',
  async (mode) => {
    realPartial();
    if (mode === 'change instead of unshield') mockNoteHash.mockReturnValue(3n);
    if (mode === 'wrong preimage') mockNoteHash.mockReturnValue(9n);
    if (mode === 'wrong message') input.expectedHash = hex(8);
    await expect(invoke()).rejects.toThrow();
    expect(context.requestKey).not.toHaveBeenCalled();
    expect(context.request).not.toHaveBeenCalled();
    expect(mockSign).not.toHaveBeenCalled();
  }
);
test.each(['recipient', 'amount', 'swapped commitments'])(
  'coherently retargeted partial %s cannot keep the old unshield commitment',
  async (mode) => {
    realPartial((fixture) => {
      const expected = fixture.capsule.preparation.expected;
      if (mode === 'recipient') {
        expected.recipient = '0x' + '34'.repeat(20);
        fixture.inner.unshieldPreimage.npk = '0x' + '0'.repeat(24) + '34'.repeat(20);
      }
      if (mode === 'amount') {
        expected.unshieldAmount = '401';
        fixture.inner.unshieldPreimage.value = 401;
      }
      if (mode === 'swapped commitments') {
        fixture.inner.commitments.reverse();
        [expected.changeCommitment, expected.unshieldCommitment] = [
          expected.unshieldCommitment,
          expected.changeCommitment,
        ];
      }
    });
    if (mode !== 'swapped commitments') mockNoteHash.mockReturnValue(9n);
    await expect(invoke()).rejects.toThrow();
    // Structural policy passed; independent preimage hashing caused refusal.
    expect(mockNoteHash).toHaveBeenCalledTimes(1);
    expect(context.requestKey).not.toHaveBeenCalled();
    expect(mockSign).not.toHaveBeenCalled();
    expect(context.request).not.toHaveBeenCalled();
  }
);
test('unknown signing kind refuses before runtime or key admission', async () => {
  checked.kind = 'railgun-unknown';
  await expect(invoke()).rejects.toThrow();
  expect(require('./railgun-engine-runtime').verifyRailgunEngineRuntime).not.toHaveBeenCalled();
  expect(mockPoseidon).not.toHaveBeenCalled();
  expect(mockNoteHash).not.toHaveBeenCalled();
  expect(context.requestKey).not.toHaveBeenCalled();
  expect(context.request).not.toHaveBeenCalled();
  expect(mockSign).not.toHaveBeenCalled();
});
