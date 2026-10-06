// Real record/ABI/stream/pair decoders and production C. Engine arithmetic,
// signature, artifact loading and serial crypto are explicit test seams only.
// resetModules simulates fresh processes; the fixture never resets C at runtime.
const mockSignature = jest.fn(),
  mockVerify = jest.fn(),
  mockLoad = jest.fn();
let mockSerial, mockMessage, mockMath, mockEngine, mockProver;
jest.mock('../../src/main/wallet/railgun-engine-runtime', () => ({
  verifyRailgunEngineRuntime: (v) => mockEngine(v),
}));
jest.mock('../../src/main/wallet/railgun-prover-runtime', () => ({
  loadRailgunProverRuntime: (v) => {
    mockProver(v);
    return mockSerial;
  },
}));
jest.mock('../../src/main/wallet/railgun-artifacts', () => ({
  manifest: jest.requireActual('../../src/main/wallet/railgun-artifacts').manifest,
  loadRailgunArtifacts: (...args) => mockLoad(...args),
}));
jest.mock('../../src/main/wallet/railgun-relay-pre-poi-math', () => ({
  verifyRailgunRelayPrePoiPublicMath: (...args) => mockMath(...args),
}));
jest.mock(
  '/audit-engine.asar/node_modules/@railgun-community/engine/dist/utils/poseidon',
  () => ({ poseidon: () => mockMessage, initPoseidonPromise: Promise.resolve() }),
  { virtual: true }
);
jest.mock(
  '/audit-engine.asar/node_modules/@railgun-community/engine/dist/utils/keys-utils',
  () => ({
    verifyEDDSA: function (...args) {
      return mockSignature.apply(this, args);
    },
  }),
  { virtual: true }
);
const { Interface } = require('ethers');
const { createHash } = require('crypto');
const BASE = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
let input, context, controller, row, entry, sender, run, result, abi, originalFunctions, verifier;
const sha = (v) => createHash('sha256').update(v).digest('hex');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
};
async function until(fn) {
  for (let i = 0; i < 100 && !fn(); i++) await Promise.resolve();
  expect(fn()).toBe(true);
}
function makeSender() {
  sender?.close();
  const text = JSON.stringify(row);
  sender =
    require('../../src/main/wallet/railgun-relay-record-stream').createRailgunRelayVerifyRecordSender(
      text,
      controller.signal
    );
  input.recordStream = sender.manifest;
}
beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  globalThis.curve_bn128 = null;
  const fixture = require('./railgun-relay-main-proof-data').createRailgunRelayMainProofData();
  row = JSON.parse(
    JSON.stringify({
      ...fixture.record,
      state: 'ready-local',
      proved: { transaction: fixture.proof.transaction, payload: fixture.proof.payload },
    })
  );
  abi = new Interface([require('../../src/main/wallet/railgun-private-policy').TRANSACT_ABI]);
  const [[tx]] = abi.decodeFunctionData('transact', row.proved.transaction.data);
  row.proved.transaction.data = abi.encodeFunctionData('transact', [
    [
      [
        [
          [1n, 2n],
          [
            [3n, 4n],
            [5n, 6n],
          ],
          [7n, 8n],
        ],
        tx.merkleRoot,
        tx.nullifiers,
        tx.commitments,
        tx.boundParams,
        tx.unshieldPreimage,
      ],
    ],
  ]);
  const data = require('../../src/main/wallet/railgun-relay-recovery-data');
  row = JSON.parse(JSON.stringify(data.decodeRailgunRelayLocalRecord(JSON.stringify(row))));
  const draftDigest =
    require('../../src/main/wallet/railgun-relay-capsule').normalizeRailgunRelayDraftCapsule(
      row.draft
    ).digest;
  entry = {
    id: row.id,
    origin: 'relay-local-v4',
    facts: {
      ...row.draft.selection,
      nullifier: row.draft.intent.expected.nullifier,
      noteHash: row.draft.noteHash,
      kind: 'railgun-relay-self-transfer',
      checkpointHash: row.checkpointHash,
      draftDigest,
      expectedHash: row.draft.intent.expectedHash,
    },
    state: 'signing-local',
    signing: {
      gatesDigest: row.authorizationDigest,
      recordDigest: data.digestRailgunRelayLocalIntent(JSON.stringify(row)),
    },
  };
  controller = new AbortController();
  input = {
    archive: '/audit-engine.asar',
    proverArchive: '/audit-prover.asar',
    artifactDirectory: '/audit-artifacts',
    identityText: JSON.stringify({
      walletId: row.walletId,
      spendingPublicKey: ['01'.repeat(32), '02'.repeat(32)],
    }),
    entryText: JSON.stringify(entry),
    recordStream: null,
    auditCase: 'unmodified',
  };
  sender = undefined;
  makeSender();
  result = undefined;
  const guards = require('../qualify-railgun-relay-proof').EXPECTED_GUARDS;
  context = {
    signal: controller.signal,
    guardReport: jest.fn(() => guards),
    request: jest.fn(async (wire) => {
      const { id, method, ...message } = JSON.parse(wire);
      if (method === 'result') {
        result = message.value;
        return JSON.stringify({ id, value: null });
      }
      expect(method).toBe('relay-verify-record');
      return JSON.stringify({ id, value: sender.read({ method, ...message }) });
    }),
  };
  Object.defineProperty(context, 'requestKey', {
    get() {
      throw Error('key access forbidden');
    },
  });
  mockEngine = jest.fn((v) => {
    expect(v).toBe(input.archive);
    return v;
  });
  mockProver = jest.fn((v) => expect(v).toBe(input.proverArchive));
  mockMessage = BigInt(row.draft.intent.expectedHash);
  mockSignature
    .mockReset()
    .mockImplementation((_message, signature) => signature.S === BigInt(row.signature.S));
  mockVerify.mockReset().mockImplementation(function (vkey, _signals, proof) {
    expect(this).toBe(mockSerial);
    return Promise.resolve(
      BigInt(proof.pi_a[1]) === 2n && ['01x02', 'POI_3x3'].includes(vkey.variant)
    );
  });
  mockSerial = {
    verify: function (...args) {
      return mockVerify.apply(this, args);
    },
  };
  mockLoad.mockReset().mockImplementation(async ({ variant }) => ({
    vkey: { variant, nPublic: variant === '01x02' ? 5 : 8 },
    wasm: Buffer.alloc(2),
    zkey: Buffer.alloc(2),
  }));
  mockMath = jest.fn(async () => ({
    publicSignals: Array(8).fill(1n),
    draftDigest,
    historyDigest:
      require('../../src/main/wallet/railgun-relay-poi-history').normalizeRailgunRelayPoiHistory(
        row.history
      ).digest,
    historicalEventSignatureVerified: true,
    historicalMembershipPathVerified: true,
  }));
  const keys = require('/audit-engine.asar/node_modules/@railgun-community/engine/dist/utils/keys-utils');
  const artifacts = require('../../src/main/wallet/railgun-artifacts');
  originalFunctions = {
    signature: keys.verifyEDDSA,
    verify: mockSerial.verify,
    artifacts: artifacts.loadRailgunArtifacts,
  };
  verifier = jest.spyOn(
    require('../../src/main/wallet/railgun-relay-proof-verifier'),
    'verifyRailgunRelayProofs'
  );
  run = require('./railgun-relay-positive-audit-job').run;
});
afterEach(() => {
  sender?.close();
  controller.abort();
  jest.restoreAllMocks();
});
const invoke = () => run(JSON.stringify(input), context);
const expected = {
  unmodified: [true, true, true],
  signature: [false],
  'transaction-proof': [true, false],
  'pre-poi-proof': [true, true, false],
};
test.each(Object.keys(expected))(
  '%s reaches actual production C once with parser/pair acceptance and domain-specific primitive outcomes',
  async (kind) => {
    input.auditCase = kind;
    const original = JSON.stringify(row);
    await invoke();
    expect(verifier).toHaveBeenCalledTimes(1);
    expect(result.primitiveResults.map((v) => v.verified)).toEqual(expected[kind]);
    expect(result.primitiveResults.map((v) => v.domain)).toEqual(
      ['signature', '01x02', 'POI_3x3'].slice(0, expected[kind].length)
    );
    expect(result).toMatchObject({
      auditCase: kind,
      originalRecordSha256: sha(original),
      codecAccepted: true,
      transactionMatcherAccepted: true,
      pairMatcherAccepted: true,
      productionOutcome: kind === 'unmodified' ? 'verified' : 'refused',
      productionCode: kind === 'unmodified' ? null : 'RAILGUN_RELAY_PROOF_VERIFICATION_REFUSED',
    });
    const text = verifier.mock.calls[0][0].recordText,
      changed = JSON.parse(text);
    expect(result.checkedRecordSha256).toBe(sha(text));
    expect(JSON.stringify(row)).toBe(original);
    expect(result.recordDigest).toBe(entry.signing.recordDigest);
    for (const key of ['draft', 'history', 'prePoiBinding', 'authorizationDigest', 'state'])
      expect(changed[key]).toEqual(row[key]);
    if (kind === 'signature') {
      expect(changed.signature.R8).toEqual(row.signature.R8);
      expect(changed.proved).toEqual(row.proved);
      expect(BigInt(changed.signature.S)).toBe(BigInt(row.signature.S) + 1n);
    }
    if (kind === 'transaction-proof') {
      const [[before]] = abi.decodeFunctionData('transact', row.proved.transaction.data),
        [[after]] = abi.decodeFunctionData('transact', changed.proved.transaction.data);
      expect(after.proof.a.y).toBe(BASE - before.proof.a.y);
      expect(after.proof.a.x).toBe(before.proof.a.x);
      for (const key of [
        'merkleRoot',
        'nullifiers',
        'commitments',
        'boundParams',
        'unshieldPreimage',
      ])
        expect(after[key]).toEqual(before[key]);
      expect(after.proof.b).toEqual(before.proof.b);
      expect(after.proof.c).toEqual(before.proof.c);
      expect(changed.signature).toEqual(row.signature);
      expect(changed.proved.payload).toEqual(row.proved.payload);
    }
    if (kind === 'pre-poi-proof') {
      expect(changed.proved.payload.snarkProof.pi_a).toEqual(['1', (BASE - 2n).toString()]);
      expect(changed.proved.transaction).toEqual(row.proved.transaction);
      expect(changed.signature).toEqual(row.signature);
    }
    expect(Object.keys(result).sort()).toEqual(
      [
        'auditCase',
        'recordDigest',
        'originalRecordSha256',
        'checkedRecordSha256',
        'codecAccepted',
        'transactionMatcherAccepted',
        'pairMatcherAccepted',
        'primitiveResults',
        'productionOutcome',
        'productionCode',
        'guards',
        'inventory',
      ].sort()
    );
    expect(
      require('/audit-engine.asar/node_modules/@railgun-community/engine/dist/utils/keys-utils')
        .verifyEDDSA
    ).toBe(originalFunctions.signature);
    expect(mockSerial.verify).toBe(originalFunctions.verify);
    expect(require('../../src/main/wallet/railgun-artifacts').loadRailgunArtifacts).toBe(
      originalFunctions.artifacts
    );
    await expect(invoke()).rejects.toThrow();
    expect(verifier).toHaveBeenCalledTimes(1);
  }
);
test.each([
  'case',
  'extra',
  'identity',
  'entry',
  'entry-bound',
  'identity-bound',
  'archive',
  'record-hash',
  'entry-join',
])('%s malformed input cannot count as cryptographic refusal', async (mode) => {
  if (mode === 'case') input.auditCase = 'arbitrary';
  if (mode === 'extra') input.verify = true;
  if (mode === 'identity') input.identityText = ' ' + input.identityText;
  if (mode === 'entry') input.entryText = ' ' + input.entryText;
  if (mode === 'entry-bound') input.entryText = ' '.repeat(4097);
  if (mode === 'identity-bound') input.identityText = ' '.repeat(513);
  if (mode === 'archive') input.archive = 'relative.asar';
  if (mode === 'record-hash')
    input.recordStream = { ...input.recordStream, sha256: '00'.repeat(32) };
  if (mode === 'entry-join') {
    entry.signing.recordDigest = '00'.repeat(32);
    input.entryText = JSON.stringify(entry);
  }
  await expect(invoke()).rejects.toThrow();
  expect(verifier).not.toHaveBeenCalled();
  expect(result).toBeUndefined();
  expect(mockSignature).not.toHaveBeenCalled();
});
test.each(['transaction-proof', 'pre-poi-proof'])(
  '%s requires nonzero original on-curve y before C',
  async (mode) => {
    input.auditCase = mode;
    if (mode === 'pre-poi-proof') row.proved.payload.snarkProof.pi_a = ['1', '0'];
    else {
      const [[tx]] = abi.decodeFunctionData('transact', row.proved.transaction.data);
      row.proved.transaction.data = abi.encodeFunctionData('transact', [
        [
          [
            [
              [1n, 0n],
              [
                [3n, 4n],
                [5n, 6n],
              ],
              [7n, 8n],
            ],
            tx.merkleRoot,
            tx.nullifiers,
            tx.commitments,
            tx.boundParams,
            tx.unshieldPreimage,
          ],
        ],
      ]);
    }
    makeSender();
    await expect(invoke()).rejects.toThrow();
    expect(verifier).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  }
);
test.each(['signature', 'transaction-proof', 'pre-poi-proof'])(
  '%s cannot qualify a generic C/parser failure without exact false primitive',
  async (kind) => {
    input.auditCase = kind;
    verifier.mockRejectedValue(
      Object.assign(Error('wrong stage'), { code: 'RAILGUN_RELAY_PROOF_VERIFICATION_REFUSED' })
    );
    await expect(invoke()).rejects.toThrow();
    expect(result).toBeUndefined();
    expect(mockSignature).not.toHaveBeenCalled();
  }
);
test.each(['signature', 'transaction-proof', 'pre-poi-proof'])(
  '%s unexpected successful primitive cannot be labeled rejection',
  async (kind) => {
    input.auditCase = kind;
    mockSignature.mockReturnValue(true);
    mockVerify.mockResolvedValue(true);
    await expect(invoke()).rejects.toThrow();
    expect(result).toBeUndefined();
  }
);
test('serial wrapper returns exact original promise and observes held abort before restoring exports', async () => {
  const held = deferred();
  let original;
  mockVerify.mockImplementation(function () {
    expect(this).toBe(mockSerial);
    original = held.promise;
    return original;
  });
  let wrappedReturn;
  // Observe the already installed exported delegate from inside genuine C's call.
  mockLoad.mockImplementation(async ({ variant }) => {
    const old = mockSerial.verify;
    mockSerial.verify = function (...args) {
      mockSerial.verify = old;
      wrappedReturn = Reflect.apply(old, this, args);
      return wrappedReturn;
    };
    return { vkey: { variant, nPublic: 5 }, wasm: Buffer.alloc(2), zkey: Buffer.alloc(2) };
  });
  // This test-only return observer restores the audited wrapper synchronously.
  const work = invoke();
  work.catch(() => {});
  await until(() => mockVerify.mock.calls.length === 1);
  expect(wrappedReturn).toBe(original);
  controller.abort();
  let ended = false;
  work
    .finally(() => {
      ended = true;
    })
    .catch(() => {});
  await Promise.resolve();
  expect(ended).toBe(false);
  held.resolve(true);
  await expect(work).rejects.toThrow();
  expect(result).toBeUndefined();
  expect(mockSerial.verify).toBe(originalFunctions.verify);
});
test('held final result acknowledgement remains observed across abort', async () => {
  const held = deferred(),
    base = context.request.getMockImplementation();
  context.request.mockImplementation((wire) =>
    JSON.parse(wire).method === 'result' ? held.promise : base(wire)
  );
  const work = invoke();
  work.catch(() => {});
  await until(() => context.request.mock.calls.some(([w]) => JSON.parse(w).method === 'result'));
  controller.abort();
  let ended = false;
  work
    .finally(() => {
      ended = true;
    })
    .catch(() => {});
  await Promise.resolve();
  expect(ended).toBe(false);
  const last = JSON.parse(context.request.mock.calls.at(-1)[0]);
  held.resolve(JSON.stringify({ id: last.id, value: null }));
  await expect(work).rejects.toThrow();
});
test('nonzero guard attempts prevent publication', async () => {
  context.guardReport.mockReturnValue({ attempts: 1, canaries: 91, hooks: [] });
  await expect(invoke()).rejects.toThrow();
  expect(result).toBeUndefined();
});

test('reordered entry is not accepted as the canonical captured ledger row', async () => {
  input.entryText = JSON.stringify({ state: entry.state, ...entry });
  await expect(invoke()).rejects.toThrow();
  expect(verifier).not.toHaveBeenCalled();
});
test('actual delegate exception is not interpreted as cryptographic false', async () => {
  input.auditCase = 'transaction-proof';
  mockVerify.mockRejectedValue(Error('unexpected primitive failure'));
  await expect(invoke()).rejects.toThrow();
  expect(result).toBeUndefined();
  expect(mockSerial.verify).toBe(originalFunctions.verify);
  expect(
    require('/audit-engine.asar/node_modules/@railgun-community/engine/dist/utils/keys-utils')
      .verifyEDDSA
  ).toBe(originalFunctions.signature);
});
test('wrong artifact domain identity fails even with successful primitive values', async () => {
  const vkey = { nPublic: 5 };
  mockLoad.mockImplementation(async ({ variant }) => {
    vkey.nPublic = variant === '01x02' ? 5 : 8;
    return { vkey, wasm: Buffer.alloc(2), zkey: Buffer.alloc(2) };
  });
  mockVerify.mockResolvedValue(true);
  await expect(invoke()).rejects.toThrow();
  expect(result).toBeUndefined();
});

test('replacement of an owned observer refuses and still restores other owned exports', async () => {
  const keys = require('/audit-engine.asar/node_modules/@railgun-community/engine/dist/utils/keys-utils');
  const old = mockMath.getMockImplementation(),
    foreign = () => true;
  mockMath.mockImplementation(async (...args) => {
    keys.verifyEDDSA = foreign;
    return old(...args);
  });
  await expect(invoke()).rejects.toThrow();
  expect(result).toBeUndefined();
  expect(keys.verifyEDDSA).toBe(foreign);
  expect(mockSerial.verify).toBe(originalFunctions.verify);
  expect(require('../../src/main/wallet/railgun-artifacts').loadRailgunArtifacts).toBe(
    originalFunctions.artifacts
  );
});

test('second run with a fresh valid record stream refuses before any new broker request or C call', async () => {
  await invoke();
  const requests = context.request.mock.calls.length;
  makeSender();
  await expect(invoke()).rejects.toThrow();
  expect(context.request).toHaveBeenCalledTimes(requests);
  expect(verifier).toHaveBeenCalledTimes(1);
});
