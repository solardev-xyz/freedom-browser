// Actual wallet-job sequencing, stream/record normalizers and fixed wrappers.
// Engine wallet/restore and both crypto helpers are explicit structural seams.
const {
  createRailgunRelayUnsignedData,
} = require('../../../scripts/fixtures/railgun-relay-unsigned-data');
const { normalizeRailgunRelayDraftCapsule } = require('./railgun-relay-capsule');
const { normalizeRailgunRelayPoiHistory } = require('./railgun-relay-poi-history');
const { normalizeRailgunRelayPrePoiBinding } = require('./railgun-relay-pre-poi-data');
const { REQUIRED_LIST } = require('./railgun-poi-records');
const hex = (n) => BigInt(n).toString(16).padStart(64, '0');
function fixture(state = 'held') {
  const draft = createRailgunRelayUnsignedData().draft,
    draftDigest = normalizeRailgunRelayDraftCapsule(draft).digest;
  const proof = { leaf: hex(1), root: hex(2), indices: hex(5), elements: Array(16).fill(hex(3)) };
  const history = {
    schema: 'railgun-relay-input-poi-history-v1',
    draftDigest,
    listKey: REQUIRED_LIST,
    note: { blindedCommitment: '0x' + hex(1), type: 'Transact' },
    proof,
    event: {
      signedPOIEvent: {
        index: 5,
        blindedCommitment: '0x' + hex(1),
        type: 'Transact',
        signature: '12'.repeat(64),
      },
      validatedMerkleroot: hex(4),
    },
  };
  const prePoiBinding = {
    schema: 'railgun-relay-pre-poi-binding-v1',
    draftDigest,
    chainId: 11155111,
    txidVersion: 'V2_PoseidonMerkle',
    listKey: REQUIRED_LIST,
    listWitness: proof,
    txidLeafHash: hex(10),
    txidMerkleroot: hex(11),
    blindedCommitmentsOut: ['0x' + hex(12), '0x' + hex(13)],
  };
  const signature = ['signed', 'ready-local'].includes(state)
    ? { R8: ['0x' + hex(1), '0x' + hex(2)], S: '0x' + hex(3) }
    : null;
  const proved =
    state === 'ready-local'
      ? {
          transaction: draft.intent.transaction,
          payload: {
            snarkProof: {
              pi_a: ['1', '2'],
              pi_b: [
                ['3', '4'],
                ['5', '6'],
              ],
              pi_c: ['7', '8'],
            },
            txidMerkleroot: prePoiBinding.txidMerkleroot,
            poiMerkleroots: [proof.root],
            blindedCommitmentsOut: prePoiBinding.blindedCommitmentsOut,
            railgunTxidIfHasUnshield: '0x00',
          },
        }
      : null;
  return JSON.parse(
    JSON.stringify({
      schema: 'railgun-relay-local-record-v4',
      id: hex(100),
      binding: hex(101),
      walletId: draft.walletId,
      generationId: hex(102),
      checkpointHash: hex(103),
      authorizationDigest: hex(104),
      draft: normalizeRailgunRelayDraftCapsule(draft).data,
      history: normalizeRailgunRelayPoiHistory(history).data,
      prePoiBinding: normalizeRailgunRelayPrePoiBinding(prePoiBinding),
      state,
      signature,
      proved,
    })
  );
}
const stream = require('./railgun-relay-record-stream');
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
const mockWalletId = '11'.repeat(32),
  mockAddress = '0zk1' + 'p'.repeat(123);
let mockProveHook,
  mockVerifyHook,
  mockResult,
  mockVerification,
  mockRestoreHook,
  mockFrameHook,
  mockInit,
  mockKey;
const mockProve = jest.fn(async (o) => (mockProveHook ? mockProveHook(o) : mockResult));
const mockVerify = jest.fn(async (o) => (mockVerifyHook ? mockVerifyHook(o) : mockVerification));
const mockMessages = [],
  mockRemotes = [];
jest.mock('./railgun-relay-prover', () => ({
  proveRailgunRelayLocal: (...args) => mockProve(...args),
}));
jest.mock('./railgun-relay-proof-verifier', () => ({
  verifyRailgunRelayProofs: (...args) => mockVerify(...args),
}));
jest.mock('./railgun-engine-runtime', () => ({
  verifyRailgunEngineRuntime: (archive) => {
    if (archive !== '/fixture-engine.asar') throw Error('unselected archive');
    return archive;
  },
}));
jest.mock('module', () => ({
  ...jest.requireActual('module'),
  createRequire: () =>
    Object.assign(
      (name) => {
        if (name !== 'abstract-leveldown') throw Error(name);
        return {};
      },
      {
        resolve: (name) => {
          if (name !== '@railgun-community/engine') throw Error(name);
          return '/fixture-engine.asar/node_modules/@railgun-community/engine/dist/index.js';
        },
      }
    ),
}));
jest.mock('./railgun-remote', () => ({
  createRailgunRemote: ({ send }) => {
    const remote = { leveldown: {}, send, close: jest.fn() };
    mockRemotes.push(remote);
    return remote;
  },
}));
jest.mock('./railgun-wallet-scan', () => ({
  scanRailgunWallet: async (o) => {
    if (mockRestoreHook) return mockRestoreHook(o);
    await mockRemotes[0].send(JSON.stringify({ id: 1, method: 'get', key: 'public' }));
    await mockRemotes[1].send(JSON.stringify({ id: 1, method: 'get', key: 'wallet' }));
    return { instanceId: mockAddress, publicScan: true };
  },
}));
jest.mock(
  '/fixture-engine.asar/node_modules/@railgun-community/engine/dist/utils/poseidon',
  () => ({
    get initPoseidonPromise() {
      return mockInit;
    },
  }),
  { virtual: true }
);
jest.mock(
  '/fixture-engine.asar/node_modules/@railgun-community/engine/dist/database/database',
  () => ({
    Database: class {
      constructor() {}
      static pathToKey(value) {
        return value;
      }
    },
  }),
  { virtual: true }
);
jest.mock(
  '/fixture-engine.asar/node_modules/@railgun-community/engine/dist/wallet/view-only-wallet',
  () => ({
    ViewOnlyWallet: class {
      static generateID() {
        return mockWalletId;
      }
      generateShareableViewingKey() {
        return 'public-shareable';
      }
      getAddress() {
        return mockAddress;
      }
      getWalletDBPrefix() {
        return 'wallet';
      }
      getWalletSentCommitmentDBPrefix() {
        return 'sent';
      }
    },
  }),
  { virtual: true }
);
jest.mock(
  '/fixture-engine.asar/node_modules/@railgun-community/engine/dist/merkletree/utxo-merkletree',
  () => ({ UTXOMerkletree: { create: async () => ({ getMerkletreeDBPrefix: () => 'public' }) } }),
  { virtual: true }
);
jest.mock(
  '/fixture-engine.asar/node_modules/@railgun-community/engine/dist/poi/poi',
  () => ({ POI: { init: () => {} } }),
  { virtual: true }
);
jest.mock(
  '/fixture-engine.asar/node_modules/@railgun-community/engine/dist/wallet/wallet-info',
  () => ({ default: { setWalletSource: () => {} } }),
  { virtual: true }
);
jest.mock(
  '/fixture-engine.asar/node_modules/@railgun-community/engine/dist/utils/keys-utils',
  () => ({ getPublicViewingKey: async () => Buffer.alloc(32, 8) }),
  { virtual: true }
);
for (const name of [
  'note/note-util',
  'note/shield-note',
  'note/transact-note',
  'utils/encryption/aes',
  'note/memo',
  'utils/bytes',
  'poi/blinded-commitment',
  'poi/global-tree-position',
])
  jest.doMock(
    '/fixture-engine.asar/node_modules/@railgun-community/engine/dist/' + name,
    () => ({}),
    { virtual: true }
  );
function jobs() {
  let prove, verify, wallet;
  jest.isolateModules(() => {
    prove = require('./railgun-relay-prove-job').run;
    verify = require('./railgun-relay-verify-job').run;
    wallet = require('./railgun-wallet-job').withWallet;
  });
  return { prove, verify, wallet };
}
function fixtureRun(kind = 'Proof', c = new AbortController()) {
  const record = fixture(kind === 'Proof' ? 'signed' : 'ready-local'),
    text = JSON.stringify(record),
    sender = stream[`createRailgunRelay${kind}RecordSender`](text, c.signal);
  const base = {
    archive: '/fixture-engine.asar',
    proverArchive: '/fixture-prover.asar',
    artifactDirectory: '/fixture-artifacts',
    recordStream: sender.manifest,
  };
  const input =
    kind === 'Proof'
      ? {
          ...base,
          descriptor: {
            walletId: mockWalletId,
            instanceId: mockAddress,
            spendingPublicKey: [hex(4), hex(5)],
          },
          checkpoint: { public: true },
          walletId: mockWalletId,
          restore: true,
          prefixes: { public: ['public'], wallet: ['wallet', 'sent'] },
        }
      : {
          ...base,
          identityText: JSON.stringify({
            walletId: mockWalletId,
            spendingPublicKey: [hex(4), hex(5)],
          }),
        };
  let sequence = 0;
  const handle = async (wire) => {
    const message = JSON.parse(wire);
    expect(message.id).toBe(++sequence);
    mockMessages.push(message);
    let value;
    if (message.method?.endsWith('-record'))
      value = sender.read({ method: message.method, index: message.index });
    else if (message.channel) value = 'public-reply';
    else if (message.method === 'result') value = null;
    else throw Error('unselected method');
    const reply = JSON.stringify({ id: message.id, value });
    return mockFrameHook ? mockFrameHook(message, reply) : reply;
  };
  const context = {
    signal: c.signal,
    guardReport: () => ({ hooks: ['structural-test-only'], canaries: 1, attempts: 0 }),
    request: jest.fn(handle),
    requestKey: jest.fn(async (wire) => {
      const message = JSON.parse(wire);
      expect(message).toEqual({ id: 1, method: 'key', purpose: 'relay-prove-local' });
      expect(sequence++).toBe(0);
      mockMessages.push(message);
      return mockKey;
    }),
  };
  return { input, context, sender, text, c };
}
beforeEach(() => {
  mockMessages.length = 0;
  mockRemotes.length = 0;
  mockProve.mockClear();
  mockVerify.mockClear();
  mockProveHook = mockVerifyHook = mockRestoreHook = mockFrameHook = undefined;
  mockInit = Promise.resolve();
  mockKey = Buffer.alloc(32, 7);
  const r = fixture('ready-local');
  mockResult = {
    recordDigest: hex(1),
    draftDigest: hex(2),
    historyDigest: hex(3),
    expectedHash: '0x' + hex(11),
    transaction: r.proved.transaction,
    payload: r.proved.payload,
    transactionDigest: hex(4),
    payloadDigest: hex(5),
    locallyVerified: true,
    independentlyVerified: false,
  };
  mockVerification = {
    engineSha256: hex(1),
    proverSha256: hex(2),
    artifactVkeys: { '01x02': hex(3), POI_3x3: hex(4) },
    recordDigest: hex(5),
    draftDigest: hex(6),
    historyDigest: hex(7),
    expectedHash: '0x' + hex(11),
    transactionDigest: hex(8),
    payloadDigest: hex(9),
    transactionVerified: true,
    prePoiVerified: true,
    historicalEventSignatureVerified: true,
    historicalMembershipPathVerified: true,
    inputOwnershipVerified: false,
    currentMembershipVerified: false,
    authorityGranted: false,
  };
});
test('producer preserves key id1, storage sequence, fixed chunks, result and key wipe', async () => {
  const { prove } = jobs(),
    f = fixtureRun();
  await prove(JSON.stringify(f.input), f.context);
  expect(mockMessages.map((v) => v.id)).toEqual([1, 2, 3, 4, 5]);
  expect(mockMessages.map((v) => v.method || v.channel)).toEqual([
    'key',
    'public',
    'wallet',
    'relay-proof-record',
    'result',
  ]);
  expect(mockProve).toHaveBeenCalledTimes(1);
  expect(mockProve.mock.calls[0][0].recordText).toBe(f.text);
  expect(mockProve.mock.calls[0][0]).not.toHaveProperty('readRelayProofRecord');
  expect(mockProve.mock.calls[0][0]).not.toHaveProperty('tree');
  expect(mockMessages[4].value.relayProof).toEqual(mockResult);
  expect(mockMessages[4].value).not.toHaveProperty('witness');
  expect(mockKey.every((v) => v === 0)).toBe(true);
  expect(mockRemotes.every((v) => v.close.mock.calls.length === 1)).toBe(true);
  await expect(prove(JSON.stringify(f.input), f.context)).rejects.toThrow();
  expect(f.context.requestKey).toHaveBeenCalledTimes(1);
});
test('keyless C starts chunks at id1, verifies once, and exposes no key or wallet route', async () => {
  const { verify } = jobs(),
    f = fixtureRun('Verify');
  await verify(JSON.stringify(f.input), f.context);
  expect(mockMessages.map((v) => [v.id, v.method])).toEqual([
    ...Array.from({ length: f.sender.manifest.chunks }, (_, i) => [i + 1, 'relay-verify-record']),
    [f.sender.manifest.chunks + 1, 'result'],
  ]);
  expect(f.context.requestKey).not.toHaveBeenCalled();
  expect(mockRemotes).toHaveLength(0);
  expect(mockVerify.mock.calls[0][0].recordText).toBe(f.text);
  expect(mockVerify.mock.calls[0][0]).not.toHaveProperty('wallet');
  expect(mockMessages.at(-1).value.authorityGranted).toBe(false);
});
test.each([
  'privateIntent',
  'privateOperation',
  'privateRecovery',
  'relayRequest',
  'relayDraftText',
  'recordText',
  'witness',
  'prover',
  'mode',
])('producer refuses %s init before key loan', async (key) => {
  const { prove } = jobs(),
    f = fixtureRun();
  f.input[key] = {};
  await expect(prove(JSON.stringify(f.input), f.context)).rejects.toThrow();
  expect(f.context.requestKey).not.toHaveBeenCalled();
  expect(mockProve).not.toHaveBeenCalled();
});
test.each(['wallet', 'descriptor', 'recordText', 'signature', 'mode', 'requestKey'])(
  'C refuses extra %s init',
  async (key) => {
    const { verify } = jobs(),
      f = fixtureRun('Verify');
    f.input[key] = {};
    await expect(verify(JSON.stringify(f.input), f.context)).rejects.toThrow();
    expect(f.context.request).not.toHaveBeenCalled();
  }
);
test.each(['writable', 'oversize', 'relative runtime', 'bad manifest', 'wrong wallet'])(
  'producer refuses %s before restore',
  async (mode) => {
    const { prove } = jobs(),
      f = fixtureRun();
    let text;
    if (mode === 'writable') f.input.restore = false;
    if (mode === 'oversize') f.input.checkpoint = { value: 'x'.repeat(65536) };
    if (mode === 'relative runtime') f.input.proverArchive = 'relative.asar';
    if (mode === 'bad manifest') f.input.recordStream = { ...f.input.recordStream, chunks: 9 };
    if (mode === 'wrong wallet') f.input.walletId = hex(99);
    text = JSON.stringify(f.input);
    await expect(prove(text, f.context)).rejects.toThrow();
    expect(f.context.requestKey).not.toHaveBeenCalled();
  }
);
test.each(['Proof', 'Verify'])(
  'wrong outer reply id is refused in %s, no proof result',
  async (kind) => {
    const j = jobs(),
      f = fixtureRun(kind);
    mockFrameHook = (message, reply) =>
      message.method?.endsWith('-record')
        ? JSON.stringify({ ...JSON.parse(reply), id: message.id + 1 })
        : reply;
    await expect(
      (kind === 'Proof' ? j.prove : j.verify)(JSON.stringify(f.input), f.context)
    ).rejects.toThrow();
    expect(mockMessages.some((v) => v.method === 'result')).toBe(false);
    expect(mockProve).not.toHaveBeenCalled();
    expect(mockVerify).not.toHaveBeenCalled();
  }
);
test.each(['Proof', 'Verify'])(
  'held original chunk in %s drains through abort before rejection',
  async (kind) => {
    const j = jobs(),
      f = fixtureRun(kind),
      held = deferred(),
      entered = deferred();
    mockFrameHook = async (message, reply) => {
      if (message.method?.endsWith('-record')) {
        entered.resolve();
        await held.promise;
      }
      return reply;
    };
    let settled = false;
    const original = (kind === 'Proof' ? j.prove : j.verify)(JSON.stringify(f.input), f.context);
    original.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await entered.promise;
    f.c.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    if (kind === 'Proof') expect(mockKey.every((v) => v === 7)).toBe(true);
    held.resolve();
    await expect(original).rejects.toThrow();
    expect(mockMessages.some((v) => v.method === 'result')).toBe(false);
    if (kind === 'Proof') expect(mockKey.every((v) => v === 0)).toBe(true);
  }
);
test.each(['Proof', 'Verify'])(
  'original %s crypto callback remains awaited after abort',
  async (kind) => {
    const j = jobs(),
      f = fixtureRun(kind),
      held = deferred(),
      entered = deferred();
    const hook = async () => {
      entered.resolve();
      await held.promise;
      return kind === 'Proof' ? mockResult : mockVerification;
    };
    if (kind === 'Proof') mockProveHook = hook;
    else mockVerifyHook = hook;
    let settled = false;
    const original = (kind === 'Proof' ? j.prove : j.verify)(JSON.stringify(f.input), f.context);
    original.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await entered.promise;
    f.c.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    held.resolve();
    await expect(original).rejects.toThrow();
    expect(mockMessages.some((v) => v.method === 'result')).toBe(false);
  }
);
test.each(['Proof', 'Verify'])('full private witness cannot escape %s result', async (kind) => {
  const j = jobs(),
    f = fixtureRun(kind);
  (kind === 'Proof' ? mockResult : mockVerification).witness = {
    privateInputs: { secret: 'fixture' },
  };
  await expect(
    (kind === 'Proof' ? j.prove : j.verify)(JSON.stringify(f.input), f.context)
  ).rejects.toThrow();
  expect(mockMessages.some((v) => v.method === 'result')).toBe(false);
});
test('only relay-prove-local restored callbacks receive the one-use record reader', async () => {
  const { wallet } = jobs(),
    f = fixtureRun();
  const ordinary = { ...f.input };
  delete ordinary.proverArchive;
  delete ordinary.artifactDirectory;
  delete ordinary.recordStream;
  f.context.requestKey = async (wire) => {
    expect(JSON.parse(wire).purpose).toBe('wallet-viewing');
    return mockKey;
  };
  f.context.request = async (wire) => {
    const m = JSON.parse(wire);
    return JSON.stringify({ id: m.id, value: m.channel ? 'reply' : null });
  };
  await wallet(JSON.stringify(ordinary), f.context, 'wallet-viewing', async (restored) => {
    expect(restored.readRelayProofRecord).toBeUndefined();
    expect(restored.exchangePrivateIntent).toBeUndefined();
    return {};
  });
  expect(mockProve).not.toHaveBeenCalled();
});
test('relay reader is one-use even after its successful initial consumption', async () => {
  const { wallet } = jobs(),
    f = fixtureRun();
  await wallet(JSON.stringify(f.input), f.context, 'relay-prove-local', async (restored) => {
    expect(await restored.readRelayProofRecord()).toBe(f.text);
    await expect(restored.readRelayProofRecord()).rejects.toThrow();
    return {};
  });
  expect(mockMessages.filter((v) => v.method === 'relay-proof-record')).toHaveLength(1);
});
test('new producer detects cancellation between callback completion and final result', async () => {
  const { wallet } = jobs(),
    f = fixtureRun();
  await expect(
    wallet(JSON.stringify(f.input), f.context, 'relay-prove-local', async () => {
      f.c.abort();
      return {};
    })
  ).rejects.toThrow();
  expect(mockMessages.some((v) => v.method === 'result')).toBe(false);
});
test('producer awaits original final acknowledgement before refusal and key wipe on abort', async () => {
  const { prove } = jobs(),
    f = fixtureRun(),
    held = deferred(),
    entered = deferred();
  mockFrameHook = async (message, reply) => {
    if (message.method === 'result') {
      entered.resolve();
      await held.promise;
    }
    return reply;
  };
  let settled = false;
  const original = prove(JSON.stringify(f.input), f.context);
  original.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await entered.promise;
  expect(mockMessages.filter((message) => message.method === 'result')).toHaveLength(1);
  expect(mockKey.every((value) => value === 7)).toBe(true);
  f.c.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(mockKey.every((value) => value === 7)).toBe(true);
  held.resolve();
  await expect(original).rejects.toThrow();
  expect(mockKey.every((value) => value === 0)).toBe(true);
  expect(mockRemotes.every((remote) => remote.close.mock.calls.length === 1)).toBe(true);
});
test('keyless C awaits original final acknowledgement and rechecks cancellation', async () => {
  const { verify } = jobs(),
    f = fixtureRun('Verify'),
    held = deferred(),
    entered = deferred();
  mockFrameHook = async (message, reply) => {
    if (message.method === 'result') {
      entered.resolve();
      await held.promise;
    }
    return reply;
  };
  let settled = false;
  const original = verify(JSON.stringify(f.input), f.context);
  original.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await entered.promise;
  f.c.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  held.resolve();
  await expect(original).rejects.toThrow();
});
test.each(['Proof', 'Verify'])(
  'bad frame shape/size in %s is refused before helper',
  async (kind) => {
    for (const mode of ['extra', 'size', 'value']) {
      const j = jobs(),
        f = fixtureRun(kind);
      mockMessages.length = 0;
      mockRemotes.length = 0;
      mockFrameHook = (message, reply) => {
        if (!message.method?.endsWith('-record')) return reply;
        if (mode === 'extra') return JSON.stringify({ ...JSON.parse(reply), extra: true });
        if (mode === 'size') return 'x'.repeat(65536);
        return JSON.stringify({ id: message.id, value: { index: message.index, data: '00' } });
      };
      await expect(
        (kind === 'Proof' ? j.prove : j.verify)(JSON.stringify(f.input), f.context)
      ).rejects.toThrow();
      expect(mockMessages.some((v) => v.method === 'result')).toBe(false);
    }
    expect(mockProve).not.toHaveBeenCalled();
    expect(mockVerify).not.toHaveBeenCalled();
  }
);
test('keyless C refuses noncanonical or wrong public identity before requesting record', async () => {
  for (const identityText of [
    '{}',
    ' ' + JSON.stringify({ walletId: mockWalletId, spendingPublicKey: [hex(4), hex(5)] }),
    JSON.stringify({ walletId: mockWalletId, spendingPublicKey: [hex(4)] }),
  ]) {
    const { verify } = jobs(),
      f = fixtureRun('Verify');
    f.input.identityText = identityText;
    await expect(verify(JSON.stringify(f.input), f.context)).rejects.toThrow();
    expect(f.context.request).not.toHaveBeenCalled();
  }
});
test('cancellation while engine initializes refuses before borrowing the viewing key', async () => {
  const { prove } = jobs(),
    f = fixtureRun(),
    held = deferred();
  mockInit = held.promise;
  const original = prove(JSON.stringify(f.input), f.context);
  f.c.abort();
  held.resolve();
  await expect(original).rejects.toThrow();
  expect(f.context.requestKey).not.toHaveBeenCalled();
});
test('producer observes original failure and wipes loan/remotes before run rejects', async () => {
  const { prove } = jobs(),
    f = fixtureRun(),
    error = Error('fixed helper refusal');
  mockProveHook = async () => {
    throw error;
  };
  await expect(prove(JSON.stringify(f.input), f.context)).rejects.toBe(error);
  expect(mockKey.every((v) => v === 0)).toBe(true);
  expect(mockRemotes.every((v) => v.close.mock.calls.length === 1)).toBe(true);
  expect(mockMessages.some((v) => v.method === 'result')).toBe(false);
});
test('readonly private intent exchange is never exposed to local relay proof callback', async () => {
  const { wallet } = jobs(),
    f = fixtureRun();
  await wallet(JSON.stringify(f.input), f.context, 'relay-prove-local', async (restored) => {
    expect(restored.exchangePrivateIntent).toBeUndefined();
    return {};
  });
  expect(mockMessages.some((v) => v.method === 'private-intent')).toBe(false);
});
// New binding purpose reuses the actual withWallet lifetime but no record route.
function prePoiWalletFixture() {
  const f = fixtureRun();
  f.context.requestKey = jest.fn(async (wire) => {
    const message = JSON.parse(wire);
    expect(message).toEqual({ id: 1, method: 'key', purpose: 'relay-pre-poi' });
    mockMessages.push(message);
    return mockKey;
  });
  f.context.request = jest.fn(async (wire) => {
    const message = JSON.parse(wire);
    mockMessages.push(message);
    const reply = JSON.stringify({ id: message.id, value: message.channel ? 'reply' : null });
    return mockFrameHook ? mockFrameHook(message, reply) : reply;
  });
  return f;
}
test('pre-POI restored scope has fixed viewing purpose, no private exchange or signed record reader', async () => {
  const { wallet } = jobs(),
    f = prePoiWalletFixture();
  await wallet(JSON.stringify(f.input), f.context, 'relay-pre-poi', async (restored) => {
    expect(restored.exchangePrivateIntent).toBeUndefined();
    expect(restored.readRelayProofRecord).toBeUndefined();
    return { relayPrePoiBinding: { structural: true } };
  });
  expect(mockMessages.map((m) => m.id)).toEqual([1, 2, 3, 4]);
  expect(mockMessages.map((m) => m.method || m.channel)).toEqual([
    'key',
    'public',
    'wallet',
    'result',
  ]);
  expect(mockKey.every((v) => v === 0)).toBe(true);
  expect(mockRemotes.every((r) => r.close.mock.calls.length === 1)).toBe(true);
});
test('pre-POI cancellation during engine initialization admits no viewing key', async () => {
  const { wallet } = jobs(),
    f = prePoiWalletFixture(),
    held = deferred();
  mockInit = held.promise;
  const original = wallet(JSON.stringify(f.input), f.context, 'relay-pre-poi', async () => ({}));
  f.c.abort();
  held.resolve();
  await expect(original).rejects.toThrow();
  expect(f.context.requestKey).not.toHaveBeenCalled();
});
test('pre-POI cancellation at callback completion withholds result and wipes loan', async () => {
  const { wallet } = jobs(),
    f = prePoiWalletFixture();
  await expect(
    wallet(JSON.stringify(f.input), f.context, 'relay-pre-poi', async () => {
      f.c.abort();
      return {};
    })
  ).rejects.toThrow();
  expect(mockMessages.some((m) => m.method === 'result')).toBe(false);
  expect(mockKey.every((v) => v === 0)).toBe(true);
});
test('pre-POI original final acknowledgement stays owned through cancellation', async () => {
  const { wallet } = jobs(),
    f = prePoiWalletFixture(),
    held = deferred(),
    reached = deferred();
  mockFrameHook = async (message, reply) => {
    if (message.method === 'result') {
      reached.resolve();
      await held.promise;
    }
    return reply;
  };
  let settled = false;
  const original = wallet(JSON.stringify(f.input), f.context, 'relay-pre-poi', async () => ({}));
  original.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await reached.promise;
  f.c.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(mockKey.every((v) => v === 7)).toBe(true);
  held.resolve();
  await expect(original).rejects.toThrow();
  expect(mockKey.every((v) => v === 0)).toBe(true);
  expect(mockRemotes.every((r) => r.close.mock.calls.length === 1)).toBe(true);
});
