// Real canonical records/ABI; cryptographic execution and owned-core output are
// explicit structural test seams. No runtime archive, prover or key is loaded.
const {
  createRailgunRelayUnsignedData,
} = require('../../../scripts/fixtures/railgun-relay-unsigned-data');
const { normalizeRailgunRelayDraftCapsule } = require('./railgun-relay-capsule');
const { REQUIRED_LIST } = require('./railgun-poi-records');
const { normalizeRailgunRelayPoiHistory } = require('./railgun-relay-poi-history');
const { normalizeRailgunRelayPrePoiBinding } = require('./railgun-relay-pre-poi-data');
const hex = (n) => BigInt(n).toString(16).padStart(64, '0');

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
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
const streamRefused = expect.objectContaining({ code: 'RAILGUN_RELAY_RECORD_STREAM_REFUSED' });
test.each([
  ['Proof', 'signed'],
  ['Verify', 'ready-local'],
])('real canonical %s record round trip, one-use and frozen manifest', async (kind, state) => {
  const text = JSON.stringify(fixture(state)),
    signal = new AbortController().signal;
  const sender = stream[`createRailgunRelay${kind}RecordSender`](text, signal);
  const request = jest.fn(async (message) => sender.read(message));
  const reader = stream[`createRailgunRelay${kind}RecordReader`]({
    manifest: sender.manifest,
    request,
    signal,
  });
  expect(Object.isFrozen(sender.manifest)).toBe(true);
  expect(await reader.read()).toBe(text);
  expect(request.mock.calls.map(([v]) => v.index)).toEqual([
    ...Array(sender.manifest.chunks).keys(),
  ]);
  await expect(reader.read()).rejects.toEqual(streamRefused);
  expect(() => sender.read({ method: `relay-${kind.toLowerCase()}-record`, index: 0 })).toThrow();
});
test.each(['held', 'signing-local', 'ready-local', 'cancelled-unsigned', 'discarded-signed'])(
  'proof stream refuses state %s',
  (state) => {
    expect(() =>
      stream.createRailgunRelayProofRecordSender(
        JSON.stringify(fixture(state)),
        new AbortController().signal
      )
    ).toThrow();
  }
);
test.each([
  ['skip', { method: 'relay-proof-record', index: 1 }],
  ['wrong kind', { method: 'relay-verify-record', index: 0 }],
  ['extra', { method: 'relay-proof-record', index: 0, offset: 0 }],
  ['negative', { method: 'relay-proof-record', index: -1 }],
])('sender sticky refusal for %s', (_name, message) => {
  const sender = stream.createRailgunRelayProofRecordSender(
    JSON.stringify(fixture('signed')),
    new AbortController().signal
  );
  expect(() => sender.read(message)).toThrow();
  expect(() => sender.read({ method: 'relay-proof-record', index: 0 })).toThrow();
});
test.each(['digest', 'length', 'index', 'uppercase', 'extra', 'wrong record'])(
  'receiver refuses %s',
  async (mode) => {
    const text = JSON.stringify(fixture('signed')),
      signal = new AbortController().signal;
    const sender = stream.createRailgunRelayProofRecordSender(text, signal);
    const manifest = { ...sender.manifest };
    if (mode === 'digest') manifest.sha256 = 'ff'.repeat(32);
    const reader = stream.createRailgunRelayProofRecordReader({
      manifest,
      signal,
      request: async (message) => {
        const value = { ...sender.read(message) };
        if (mode === 'length') value.data += '00';
        if (mode === 'index') value.index++;
        if (mode === 'uppercase') value.data = value.data.toUpperCase();
        if (mode === 'extra') value.path = '/unselected';
        if (mode === 'wrong record') value.data = value.data.replace(/^../, '20');
        return value;
      },
    });
    await expect(reader.read()).rejects.toEqual(streamRefused);
  }
);
test.each([0, 98305, NaN, -1, 1.5])('manifest rejects byte size %s', (bytes) => {
  expect(() =>
    stream.createRailgunRelayProofRecordReader({
      manifest: {
        schema: 'railgun-relay-local-record-stream-v1',
        bytes,
        chunks: 1,
        sha256: '00'.repeat(32),
      },
      request: async () => {},
      signal: new AbortController().signal,
    })
  ).toThrow();
});
test('original held chunk drains after abort before refusal; no second request', async () => {
  const c = new AbortController(),
    held = deferred(),
    text = JSON.stringify(fixture('signed'));
  const sender = stream.createRailgunRelayProofRecordSender(text, c.signal);
  const reply = sender.read({ method: 'relay-proof-record', index: 0 });
  const request = jest.fn(() => held.promise);
  const reader = stream.createRailgunRelayProofRecordReader({
    manifest: sender.manifest,
    signal: c.signal,
    request,
  });
  let settled = false;
  const original = reader.read();
  original.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  c.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  held.resolve(reply);
  await expect(original).rejects.toEqual(streamRefused);
  expect(request).toHaveBeenCalledTimes(1);
});
test('manifest is detached before first await; sender close is nonthrowing and sticky', async () => {
  const signal = new AbortController().signal,
    text = JSON.stringify(fixture('signed'));
  const sender = stream.createRailgunRelayProofRecordSender(text, signal),
    manifest = { ...sender.manifest };
  const reader = stream.createRailgunRelayProofRecordReader({
    manifest,
    signal,
    request: async (v) => sender.read(v),
  });
  manifest.sha256 = 'ff'.repeat(32);
  expect(await reader.read()).toBe(text);
  expect(() => {
    sender.close();
    sender.close();
  }).not.toThrow();
  expect(() => sender.read({ method: 'relay-proof-record', index: 0 })).toThrow();
});
test('protocol allocation boundary uses six bounded chunks; decoder seam is NOT record-schema evidence', async () => {
  let isolated;
  jest.doMock('./railgun-relay-recovery-data', () => ({
    RAILGUN_RELAY_LOCAL_LIMITS: { record: 98304 },
    decodeRailgunRelayLocalRecord: (text) => {
      if (text !== 'x'.repeat(98304)) throw Error('test decoder');
      return { state: 'signed' };
    },
  }));
  jest.isolateModules(() => {
    isolated = require('./railgun-relay-record-stream');
  });
  jest.dontMock('./railgun-relay-recovery-data');
  const text = 'x'.repeat(98304),
    signal = new AbortController().signal;
  const sender = isolated.createRailgunRelayProofRecordSender(text, signal),
    sizes = [];
  const reader = isolated.createRailgunRelayProofRecordReader({
    manifest: sender.manifest,
    signal,
    request: async (v) => {
      const out = sender.read(v);
      sizes.push(Buffer.byteLength(JSON.stringify(out)));
      return out;
    },
  });
  expect(sender.manifest.chunks).toBe(6);
  expect(await reader.read()).toBe(text);
  expect(sizes).toHaveLength(6);
  expect(Math.max(...sizes)).toBeLessThan(65536);
});

// Both native proving algorithms are mocked below. These tests check admission,
// signal construction, result conversion, ordering and original-await retention.
let mockPrepared,
  mockMath,
  mockSpend,
  mockPoi,
  mockInit,
  mockMessage,
  mockArtifactHook,
  mockSpendHook,
  mockPoiHook;
const mockLoaded = [],
  mockCalls = [];
const mockVerify = jest.fn(async () => true),
  mockSignature = jest.fn(() => true);
const mockAssemble = jest.fn(async () => mockPrepared),
  mockPublicMath = jest.fn(async () => mockMath);
jest.mock('./railgun-engine-runtime', () => ({
  verifyRailgunEngineRuntime: jest.fn((path) => {
    if (path !== '/fixture-engine.asar') throw Error('archive');
    return path;
  }),
}));
jest.mock('./railgun-prover-runtime', () => ({
  loadRailgunProverRuntime: jest.fn((path) => {
    if (path !== '/fixture-prover.asar') throw Error('prover archive');
    return { verify: (...args) => mockVerify(...args) };
  }),
}));
jest.mock('./railgun-artifacts', () => ({
  manifest: jest.requireActual('./railgun-artifacts').manifest,
  loadRailgunArtifacts: jest.fn(async ({ variant }) => {
    mockCalls.push(variant);
    if (mockArtifactHook) await mockArtifactHook(variant);
    const value = {
      variant,
      vkey: { nPublic: variant === '01x02' ? 5 : 8, variant },
      wasm: Buffer.alloc(4, 8),
      zkey: Buffer.alloc(4, 9),
    };
    mockLoaded.push(value);
    return value;
  }),
}));
jest.mock('./railgun-relay-pre-poi-witness', () => ({
  restoreRailgunRelayPrePoiWitness: (...args) => mockAssemble(...args),
}));
jest.mock('./railgun-relay-pre-poi-math', () => ({
  verifyRailgunRelayPrePoiPublicMath: (...args) => mockPublicMath(...args),
}));
jest.mock(
  '/fixture-engine.asar/node_modules/@railgun-community/engine/dist/utils/poseidon',
  () => ({
    poseidon: () => mockMessage,
    get initPoseidonPromise() {
      return mockInit;
    },
  }),
  { virtual: true }
);
jest.mock(
  '/fixture-engine.asar/node_modules/@railgun-community/engine/dist/utils/keys-utils',
  () => ({ verifyEDDSA: (...args) => mockSignature(...args) }),
  { virtual: true }
);
jest.mock(
  '/fixture-engine.asar/node_modules/@railgun-community/engine/dist/debugger/debugger',
  () => ({ default: { engineDebugger: undefined } }),
  { virtual: true }
);
jest.mock(
  '/fixture-engine.asar/node_modules/@railgun-community/engine/dist/prover/prover',
  () => ({
    Prover: class {
      constructor(getters) {
        this.getters = getters;
      }
      setSnarkJSGroth16() {}
      async proveRailgun(version, witness) {
        mockCalls.push('spend');
        expect(version).toBe('V2_PoseidonMerkle');
        expect(witness.signature).toEqual([1n, 2n, 3n]);
        await this.getters.getArtifacts(witness.publicInputs);
        if (mockSpendHook) await mockSpendHook(witness);
        return mockSpend;
      }
      async provePOI(inputs, list, blindIn, blindOut) {
        mockCalls.push('poi');
        expect(inputs).toBe(mockPrepared.inputs);
        expect(list).toBe(require('./railgun-poi-records').REQUIRED_LIST);
        expect(blindIn).toEqual(['0x' + '1'.padStart(64, '0')]);
        expect(blindOut).toEqual(mockPrepared.binding.blindedCommitmentsOut);
        await this.getters.getArtifactsPOI(3, 3);
        if (mockPoiHook) await mockPoiHook();
        return mockPoi;
      }
      static formatProof(p) {
        return {
          a: { x: p.pi_a[0], y: p.pi_a[1] },
          b: { x: [p.pi_b[0][1], p.pi_b[0][0]], y: [p.pi_b[1][1], p.pi_b[1][0]] },
          c: { x: p.pi_c[0], y: p.pi_c[1] },
        };
      }
    },
  }),
  { virtual: true }
);
function helpers() {
  let p, v;
  jest.isolateModules(() => {
    p = require('./railgun-relay-prover').proveRailgunRelayLocal;
    v = require('./railgun-relay-proof-verifier').verifyRailgunRelayProofs;
  });
  return { p, v };
}
function proofOptions(state = 'signed', signal = new AbortController().signal) {
  const r = fixture(state),
    e = r.draft.intent.expected;
  mockPrepared = {
    witness: {
      txidVersion: 'V2_PoseidonMerkle',
      publicInputs: {
        merkleRoot: BigInt(e.merkleRoot),
        boundParamsHash: BigInt(e.boundParamsHash),
        nullifiers: [BigInt(e.nullifier)],
        commitmentsOut: [BigInt(e.feeCommitment), BigInt(e.selfCommitment)],
      },
      privateInputs: { publicKey: [4n, 5n], privateMarker: 999n },
      boundParams: {},
    },
    inputs: { privateMarker: 888n },
    binding: r.prePoiBinding,
    publicSignals: [12n, 13n, 0n, 11n, 0n, 2n, 55n, 55n],
    historyDigest: normalizeRailgunRelayPoiHistory(r.history).digest,
  };
  const proof = {
    pi_a: [1n, 2n, 1n],
    pi_b: [
      [3n, 4n],
      [5n, 6n],
      [1n, 0n],
    ],
    pi_c: [7n, 8n, 1n],
    protocol: 'groth16',
    curve: 'bn128',
  };
  mockSpend = { proof, publicInputs: mockPrepared.witness.publicInputs };
  mockPoi = {
    proof,
    publicInputs: {
      blindedCommitmentsOut: [12n, 13n, 0n],
      anyRailgunTxidMerklerootAfterTransaction: 11n,
      railgunTxidIfHasUnshield: 0n,
      poiMerkleroots: [2n, 55n, 55n],
    },
  };
  mockMath = {
    draftDigest: normalizeRailgunRelayDraftCapsule(r.draft).digest,
    historyDigest: mockPrepared.historyDigest,
    publicSignals: mockPrepared.publicSignals,
    historicalEventSignatureVerified: true,
    historicalMembershipPathVerified: true,
  };
  return {
    archive: '/fixture-engine.asar',
    proverArchive: '/fixture-prover.asar',
    artifactDirectory: '/fixture-artifacts',
    wallet: { fixture: true },
    descriptor: { walletId: r.walletId, spendingPublicKey: [hex(4), hex(5)] },
    checkpoint: { fixture: 'checkpoint' },
    scan: { fixture: 'scan' },
    recordText: JSON.stringify(r),
    signal,
  };
}
function verifierOptions(o, record) {
  return {
    archive: o.archive,
    proverArchive: o.proverArchive,
    artifactDirectory: o.artifactDirectory,
    identityText: JSON.stringify({
      walletId: o.descriptor.walletId,
      spendingPublicKey: o.descriptor.spendingPublicKey,
    }),
    recordText: JSON.stringify(record),
    signal: o.signal,
  };
}
const proofRefused = expect.objectContaining({ code: 'RAILGUN_RELAY_PROOF_REFUSED' }),
  verifyRefused = expect.objectContaining({ code: 'RAILGUN_RELAY_PROOF_VERIFICATION_REFUSED' });
beforeEach(() => {
  mockLoaded.length = 0;
  mockCalls.length = 0;
  mockInit = Promise.resolve();
  mockMessage = 11n;
  mockArtifactHook = mockSpendHook = mockPoiHook = undefined;
  mockVerify.mockReset().mockResolvedValue(true);
  mockSignature.mockReset().mockReturnValue(true);
  mockAssemble.mockClear();
  mockPublicMath.mockClear();
  globalThis.curve_bn128 = null;
});
afterEach(() => {
  delete globalThis.curve_bn128;
});
test('fixed serial producer exposes only public proofs; C receives no wallet and checks both domains', async () => {
  const { p, v } = helpers(),
    o = proofOptions(),
    result = await p(o);
  expect(mockCalls).toEqual(['01x02', 'POI_3x3', 'spend', 'poi']);
  expect(mockAssemble).toHaveBeenCalledTimes(1);
  expect(Object.keys(result).sort()).toEqual(
    [
      'recordDigest',
      'draftDigest',
      'historyDigest',
      'expectedHash',
      'transaction',
      'payload',
      'transactionDigest',
      'payloadDigest',
      'locallyVerified',
      'independentlyVerified',
    ].sort()
  );
  expect(JSON.stringify(result)).not.toContain('privateMarker');
  expect(result.independentlyVerified).toBe(false);
  expect(result.transaction.data).not.toBe(JSON.parse(o.recordText).draft.intent.transaction.data);
  const r = JSON.parse(o.recordText);
  r.state = 'ready-local';
  r.proved = { transaction: result.transaction, payload: result.payload };
  const verified = await v(verifierOptions(o, r));
  expect(verified.recordDigest).toBe(result.recordDigest);
  expect(verified.transactionDigest).toBe(result.transactionDigest);
  expect(verified.payloadDigest).toBe(result.payloadDigest);
  expect(verified).toMatchObject({
    transactionVerified: true,
    prePoiVerified: true,
    inputOwnershipVerified: false,
    currentMembershipVerified: false,
    authorityGranted: false,
  });
  expect(mockVerify.mock.calls.map(([key, signals]) => [key.variant, signals.length])).toEqual([
    ['01x02', 5],
    ['POI_3x3', 8],
    ['01x02', 5],
    ['POI_3x3', 8],
  ]);
  expect(mockVerify.mock.calls[2][2].pi_b).toEqual([
    [3n, 4n],
    [5n, 6n],
    [1n, 0n],
  ]);
  for (const item of mockLoaded) {
    expect([...item.wasm, ...item.zkey].every((n) => n === 0)).toBe(true);
  }
  await expect(p(o)).rejects.toEqual(proofRefused);
  await expect(v(verifierOptions(o, r))).rejects.toEqual(verifyRefused);
});
test.each([
  'record',
  'signature',
  'binding',
  'history',
  'public key',
  'nullifier',
  'output order',
  'expectedHash',
])('producer refuses changed %s before proving', async (mode) => {
  const { p } = helpers(),
    o = proofOptions();
  if (mode === 'record') {
    const r = JSON.parse(o.recordText);
    r.state = 'held';
    r.signature = null;
    o.recordText = JSON.stringify(r);
  }
  if (mode === 'signature') mockSignature.mockReturnValue(false);
  if (mode === 'binding') mockPrepared.binding = { ...mockPrepared.binding, txidLeafHash: hex(99) };
  if (mode === 'history') mockPrepared.historyDigest = hex(99);
  if (mode === 'public key') mockPrepared.witness.privateInputs.publicKey = [6n, 7n];
  if (mode === 'nullifier') mockPrepared.witness.publicInputs.nullifiers = [88n];
  if (mode === 'output order') mockPrepared.witness.publicInputs.commitmentsOut.reverse();
  if (mode === 'expectedHash') mockMessage = 99n;
  await expect(p(o)).rejects.toEqual(proofRefused);
  expect(mockCalls).not.toContain('spend');
});
test.each(['01x02', 'POI_3x3'])(
  'producer refuses a failing %s local verification and wipes both artifacts',
  async (variant) => {
    const { p } = helpers(),
      o = proofOptions();
    mockVerify.mockImplementation(async (k) => k.variant !== variant);
    await expect(p(o)).rejects.toEqual(proofRefused);
    for (const a of mockLoaded) expect([...a.wasm, ...a.zkey].every((n) => n === 0)).toBe(true);
  }
);
test('producer snapshots original record and descriptor before artifact await', async () => {
  const { p } = helpers(),
    o = proofOptions(),
    held = deferred();
  mockArtifactHook = async (variant) => {
    if (variant === '01x02') await held.promise;
  };
  const original = p(o);
  await Promise.resolve();
  o.recordText = 'bad';
  o.descriptor.spendingPublicKey[0] = hex(999);
  o.scan.fixture = 'changed';
  held.resolve();
  await expect(original).resolves.toMatchObject({ expectedHash: '0x' + hex(11) });
  expect(mockAssemble.mock.calls[0][0].scan.fixture).toBe('scan');
});
test.each(['spend', 'poi', 'artifact'])(
  'abort during held original %s waits then refuses and wipes',
  async (stage) => {
    const { p } = helpers(),
      c = new AbortController(),
      o = proofOptions('signed', c.signal),
      held = deferred(),
      entered = deferred();
    const hold = async () => {
      entered.resolve();
      await held.promise;
    };
    if (stage === 'spend') mockSpendHook = hold;
    else if (stage === 'poi') mockPoiHook = hold;
    else mockArtifactHook = hold;
    let settled = false;
    const original = p(o);
    original.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await entered.promise;
    c.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    held.resolve();
    await expect(original).rejects.toEqual(proofRefused);
    for (const a of mockLoaded) expect([...a.wasm, ...a.zkey].every((n) => n === 0)).toBe(true);
  }
);
test.each(['signature', 'transaction', 'poi', 'identity', 'extra'])(
  'C refuses %s independently',
  async (mode) => {
    const { v } = helpers(),
      o = proofOptions('ready-local'),
      r = JSON.parse(o.recordText),
      input = verifierOptions(o, r);
    if (mode === 'signature') mockSignature.mockReturnValue(false);
    if (mode === 'transaction') mockVerify.mockImplementation(async (k) => k.variant !== '01x02');
    if (mode === 'poi') mockVerify.mockImplementation(async (k) => k.variant !== 'POI_3x3');
    if (mode === 'identity')
      input.identityText = JSON.stringify({
        walletId: hex(999),
        spendingPublicKey: [hex(4), hex(5)],
      });
    if (mode === 'extra') input.producerVerified = true;
    await expect(v(input)).rejects.toEqual(verifyRefused);
    expect(mockAssemble).not.toHaveBeenCalled();
  }
);
test('C holds its original verify across abort and never returns a receipt', async () => {
  const { v } = helpers(),
    c = new AbortController(),
    o = proofOptions('ready-local', c.signal),
    held = deferred(),
    entered = deferred();
  mockVerify.mockImplementation(async () => {
    entered.resolve();
    return held.promise;
  });
  let settled = false;
  const original = v(verifierOptions(o, JSON.parse(o.recordText)));
  original.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await entered.promise;
  c.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  held.resolve(true);
  await expect(original).rejects.toEqual(verifyRefused);
});
test('keyless C source has no private helper import; init limits remain unchanged in baseline', () => {
  const fs = require('fs'),
    path = require('path');
  const source = fs.readFileSync(path.join(__dirname, 'railgun-relay-proof-verifier.js'), 'utf8');
  for (const name of [
    'railgun-relay-prover',
    'railgun-relay-reconstruct',
    'railgun-relay-pre-poi-witness',
    'railgun-wallet-job',
  ])
    expect(source).not.toContain("require('./" + name + "')");
  for (const name of ['railgun-process.js', 'railgun-process-entry.js'])
    expect(fs.readFileSync(path.join(__dirname, name), 'utf8')).toContain('> 65536');
});
test.each(['selector', 'prover', 'verify', 'witness', 'hashPair', 'trustRoot'])(
  'helpers refuse caller-supplied %s without executing work',
  async (name) => {
    const { p, v } = helpers(),
      o = proofOptions('signed');
    await expect(p({ ...o, [name]: () => true })).rejects.toEqual(proofRefused);
    expect(mockCalls).toEqual([]);
    const ready = fixture('ready-local');
    await expect(v({ ...verifierOptions(o, ready), [name]: () => true })).rejects.toEqual(
      verifyRefused
    );
    expect(mockVerify).not.toHaveBeenCalled();
  }
);
test('second artifact load failure wipes first artifact and has no private error cause', async () => {
  const { p } = helpers(),
    o = proofOptions();
  mockArtifactHook = async (variant) => {
    if (variant === 'POI_3x3') throw Error('private secret');
  };
  const outcome = await p(o).catch((error) => error);
  expect(outcome).toEqual(proofRefused);
  expect(outcome.cause).toBeUndefined();
  expect(outcome.message).not.toContain('secret');
  expect(mockLoaded).toHaveLength(1);
  expect(mockLoaded[0].wasm.equals(Buffer.alloc(4))).toBe(true);
  expect(o.signal.aborted).toBe(false);
});
test('C rejects failed historical signature/path result and never reaches proof verifier', async () => {
  const { v } = helpers(),
    o = proofOptions('ready-local');
  mockMath.historicalEventSignatureVerified = false;
  await expect(v(verifierOptions(o, JSON.parse(o.recordText)))).rejects.toEqual(verifyRefused);
  expect(mockVerify).not.toHaveBeenCalled();
});
test('POI result cannot swap output order after witnessed assembly', async () => {
  const { p } = helpers(),
    o = proofOptions();
  mockPoi.publicInputs.blindedCommitmentsOut = [13n, 12n, 0n];
  await expect(p(o)).rejects.toEqual(proofRefused);
  expect(mockVerify).toHaveBeenCalledTimes(1);
});
test('C verifies original stored signature rather than merely accepting proof booleans', async () => {
  const { v } = helpers(),
    o = proofOptions('ready-local');
  await v(verifierOptions(o, JSON.parse(o.recordText)));
  expect(mockSignature).toHaveBeenCalledWith(11n, { R8: [1n, 2n], S: 3n }, [4n, 5n]);
  expect(mockPublicMath).toHaveBeenCalledTimes(1);
});
test.each(['truncated UTF-8', 'noncanonical JSON', 'wrong state'])(
  'matching transport digest still refuses %s',
  async (mode) => {
    const signal = new AbortController().signal;
    let bytes;
    if (mode === 'truncated UTF-8') bytes = Buffer.from([0xc3]);
    if (mode === 'noncanonical JSON') bytes = Buffer.from(' ' + JSON.stringify(fixture('signed')));
    if (mode === 'wrong state') bytes = Buffer.from(JSON.stringify(fixture('held')));
    const hash = require('crypto').createHash('sha256').update(bytes).digest('hex');
    const reader = stream.createRailgunRelayProofRecordReader({
      manifest: {
        schema: 'railgun-relay-local-record-stream-v1',
        bytes: bytes.length,
        sha256: hash,
        chunks: Math.ceil(bytes.length / 16384),
      },
      signal,
      request: async ({ index }) => ({
        index,
        data: bytes.subarray(index * 16384, (index + 1) * 16384).toString('hex'),
      }),
    });
    await expect(reader.read()).rejects.toEqual(streamRefused);
  }
);
test('stream rejects accessor/proxy manifests without invoking traps', () => {
  const hit = jest.fn(() => 1),
    signal = new AbortController().signal;
  const manifest = {
    schema: 'railgun-relay-local-record-stream-v1',
    bytes: 1,
    sha256: '00'.repeat(32),
    chunks: 1,
  };
  const accessor = { ...manifest };
  Object.defineProperty(accessor, 'bytes', { get: hit, enumerable: true });
  for (const value of [
    accessor,
    new Proxy(manifest, { get: hit, getPrototypeOf: hit, ownKeys: hit }),
  ])
    expect(() =>
      stream.createRailgunRelayProofRecordReader({
        manifest: value,
        signal,
        request: async () => {},
      })
    ).toThrow();
  expect(hit).not.toHaveBeenCalled();
});
test('sender abort immediately wipes its private byte copy and removes listener', () => {
  const c = new AbortController(),
    text = JSON.stringify(fixture('signed'));
  const sender = stream.createRailgunRelayProofRecordSender(text, c.signal);
  const listeners = require('events').getEventListeners;
  expect(listeners(c.signal, 'abort')).toHaveLength(1);
  const fill = jest.spyOn(Buffer.prototype, 'fill');
  try {
    c.abort();
    expect(fill).toHaveBeenCalledTimes(1);
    expect(fill.mock.contexts[0].length).toBe(Buffer.byteLength(text));
    expect(fill.mock.contexts[0].every((byte) => byte === 0)).toBe(true);
    expect(listeners(c.signal, 'abort')).toHaveLength(0);
    sender.close();
    expect(fill).toHaveBeenCalledTimes(1);
  } finally {
    fill.mockRestore();
  }
  expect(() => sender.read({ method: 'relay-proof-record', index: 0 })).toThrow();
});
