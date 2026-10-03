const mockPublic = jest.fn(),
  mockSign = jest.fn(),
  mockVerify = jest.fn(),
  mockPoseidon = jest.fn(),
  mockNoteHash = jest.fn();
jest.mock('./railgun-engine-runtime', () => ({ verifyRailgunEngineRuntime: () => '/engine.asar' }));
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
      JSON.stringify({ id: 1, method: 'key', purpose: 'spending-sign' })
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
