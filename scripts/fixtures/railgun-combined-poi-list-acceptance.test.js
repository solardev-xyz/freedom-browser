// Structural orchestration only: genuine account registry, native crypto and
// supervisor exits are explicitly mocked. The qualification must exercise those.
let mockOwned,
  mockVerifier,
  mockMode,
  mockExit,
  mockHold,
  mockTask,
  mockHistory,
  mockProof,
  mockEnrollment,
  mockCoordinator,
  mockAccount;
jest.mock('../../src/main/wallet/railgun-account-wallet', () => ({
  readRailgunAccountOwnedNotes: jest.fn((account, owners) => {
    if (
      account !== mockAccount ||
      owners.enrollment !== mockEnrollment ||
      owners.coordinator !== mockCoordinator
    )
      throw Error('account-owner');
    return mockOwned;
  }),
}));
jest.mock('../../src/main/wallet/railgun-own-poi-proof', () => ({
  assertRailgunOwnPoiProof: jest.fn((proof, enrollment, coordinator) => {
    if (proof !== mockProof || enrollment !== mockEnrollment || coordinator !== mockCoordinator)
      throw Error('unregistered-proof');
    return mockHistory;
  }),
}));
jest.mock('../../src/main/wallet/railgun-poi-verifier', () => ({
  verifyRailgunPoiPayload: jest.fn((v) => mockVerifier(v)),
}));
jest.mock('../../src/main/wallet/railgun-poi-records', () => ({
  ...jest.requireActual('../../src/main/wallet/railgun-poi-records'),
  verifyPoiEvent: jest.fn((v) => v[0]),
}));
jest.mock('../../src/main/wallet/railgun-process', () => ({
  startRailgunProcess: jest.fn((o) => {
    const closed = new Promise((r) => {
      mockExit = () => r({ code: 'RAILGUN_PROCESS_CLOSED' });
    });
    mockTask = {
      closed,
      close: jest.fn(() => {
        if (!mockHold) mockExit();
      }),
    };
    o.broker.signal.addEventListener('abort', mockTask.close, { once: true });
    mockTask.ready = Promise.resolve().then(async () => {
      const input = JSON.parse(o.input),
        hex = (n) => n.toString(16).padStart(64, '0');
      const value = {
        inputSha256: require('crypto').createHash('sha256').update(o.input).digest('hex'),
        payloadSha256: require('crypto')
          .createHash('sha256')
          .update(JSON.stringify(input.payload))
          .digest('hex'),
        proof: {
          leaf: input.change.blindedCommitment.slice(2),
          elements: Array(16).fill(hex(0)),
          indices: hex(0),
          root: hex(8),
        },
        note: { blindedCommitment: input.change.blindedCommitment, type: 'Transact' },
        chainAuthenticated: false,
        ownershipAuthenticated: false,
        spendingEnabled: false,
        inventory: require('../../src/main/wallet/railgun-engine-manifest.json').inventory.sha256,
        guards: { attempts: 0, canaries: 1, hooks: ['test.guard'] },
      };
      if (mockMode === 'binding') value.payloadSha256 = '0'.repeat(64);
      if (mockMode === 'authority') value.spendingEnabled = true;
      const wire = JSON.stringify({ id: 1, method: 'result', value });
      if (mockMode === 'bad-valid') await o.broker.dispatch('{}').catch(() => {});
      await o.broker.dispatch(wire);
      if (mockMode === 'duplicate') await o.broker.dispatch(wire);
    });
    return mockTask;
  }),
}));
const { createHash } = require('crypto');
const { samplePartial } = require('./railgun-partial-own-txid-data');
const { createRailgunTxidProjection } = require('../../src/main/wallet/railgun-txid-projection');
const { prepareRailgunPoiSubmission } = require('../../src/main/wallet/railgun-poi-submit-data');
const { REQUIRED_LIST } = require('../../src/main/wallet/railgun-poi-records');
const { verifyRailgunPoiPayload } = require('../../src/main/wallet/railgun-poi-verifier');
const { startRailgunProcess } = require('../../src/main/wallet/railgun-process');
const { createCombinedPoiListAcceptance } = require('./railgun-combined-poi-list-acceptance');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const hash = (s) => '0' + createHash('sha256').update(s).digest('hex').slice(1);
const base = { chainType: '0', chainID: '11155111', txidVersion: 'V2_PoseidonMerkle' };
const defer = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
let options, payload, body, helper, controller, sign;
beforeEach(async () => {
  jest.clearAllMocks();
  mockHold = false;
  mockMode = 'valid';
  mockTask = undefined;
  const ownEvidence = samplePartial(),
    pair = (a, b) => hash(a + b),
    zeroNodes = [hash('zero')];
  for (let i = 0; i < 16; i++) zeroNodes.push(pair(zeroNodes[i], zeroNodes[i]));
  const projection = createRailgunTxidProjection({
    hashPair: pair,
    zeroNodes,
    transactionHash: (r) => ({ hash: hash(JSON.stringify(r)), railgunTxid: hash(r.nullifiers[0]) }),
    verificationHash: () => ownEvidence.row.verificationHash,
  });
  const map = new Map(),
    read = async (k) => map.get(k) ?? null;
  const { state, writes } = await projection.append(projection.empty(), [ownEvidence.row], read);
  writes.forEach(({ key, value }) => map.set(key, value));
  const witness = await projection.witness(state, hash(ownEvidence.row.nullifiers[0]), read);
  const id = '1:123',
    commitment = ownEvidence.row.commitments[0],
    txid = ownEvidence.transaction.hash;
  mockOwned = {
    read: {
      instanceId: 'test',
      received: [
        {
          id,
          tree: 1,
          position: 123,
          hash: commitment,
          txid,
          spentTxid: false,
          amount: 600n,
          tokenHash: hex(2),
          asset: {
            __type: 'erc20',
            contract: require('../../src/main/wallet/railgun-shield-pins.json').wrappedNative,
          },
        },
      ],
    },
    ownedPoi: [
      {
        id,
        hash: commitment,
        txid,
        type: 'Transact',
        npk: hex(1),
        blindedCommitment: hex(5),
        blockNumber: 291,
      },
    ],
  };
  controller = new AbortController();
  sign = jest.fn(() => 'a'.repeat(128));
  options = {
    account: {},
    owners: {
      enrollment: { descriptor: { walletId: ownEvidence.capsule.walletId, instanceId: 'test' } },
      coordinator: {},
    },
    changeId: id,
    proof: { status: 'proved' },
    archive: '/engine.asar',
    proverArchive: '/prover.asar',
    artifactDirectory: '/artifacts',
    signature: { sign },
    signal: controller.signal,
  };
  payload = {
    listKey: REQUIRED_LIST,
    proof: {
      pi_a: ['1', '2'],
      pi_b: [
        ['3', '4'],
        ['5', '6'],
      ],
      pi_c: ['7', '8'],
    },
    poiMerkleroots: [hex(3).slice(2)],
    txidMerkleroot: witness.root,
    txidMerklerootIndex: witness.checkpointIndex,
    blindedCommitmentsOut: [hex(5)],
    railgunTxidIfHasUnshield: '0x' + witness.railgunTxid,
  };
  mockProof = options.proof;
  mockAccount = options.account;
  mockEnrollment = options.owners.enrollment;
  mockCoordinator = options.owners.coordinator;
  const { from: submitter, ...transaction } = ownEvidence.transaction;
  const provedTransaction = { ...transaction, data: transaction.input };
  mockHistory = {
    preparation: { ownEvidence, state, witness },
    capture: {
      capsule: ownEvidence.capsule,
      capsuleDigest:
        require('../../src/main/wallet/railgun-private-capsule').digestRailgunPrivateCapsule(
          ownEvidence.capsule
        ),
      bindingDigest: hash('binding'),
      submitter,
      provedTransaction,
      intent: require('../../src/main/wallet/railgun-transact-intent').railgunTransactJournalIntent(
        { ...provedTransaction, from: submitter }
      ),
      projection: require('../../src/main/wallet/railgun-own-txid').projectRailgunOwnRecord(
        ownEvidence.record
      ),
    },
    payload: JSON.parse(JSON.stringify(payload)),
    expected: {
      listKey: payload.listKey,
      poiMerkleroots: [...payload.poiMerkleroots],
      txidMerkleroot: payload.txidMerkleroot,
      txidMerklerootIndex: payload.txidMerklerootIndex,
      railgunTxidIfHasUnshield: payload.railgunTxidIfHasUnshield,
      outputCount: 1,
    },
    payloadSha256: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  };
  body = prepareRailgunPoiSubmission({ payload, requestId: 123 }).body;
  mockVerifier = async (v) => ({
    payloadSha256: createHash('sha256').update(JSON.stringify(v.payload)).digest('hex'),
    proofVerified: true,
    independentlyVerified: true,
    utilityExitObserved: true,
    sourceAuthenticated: false,
    membershipAuthenticated: false,
    rootAccepted: false,
    metadataAuthenticated: false,
    ownershipAuthenticated: false,
    disclosureEnabled: false,
    spendingEnabled: false,
  });
});
afterEach(async () => {
  mockExit?.();
  helper?.close();
  if (helper) await helper.closed;
  helper = undefined;
  controller.abort();
});
const request = () => ({ signal: controller.signal, timeoutMs: 10000 });
const statuses = () => ({
  ...base,
  listKeys: [REQUIRED_LIST],
  blindedCommitmentDatas: [{ blindedCommitment: hex(5), type: 'Transact' }],
});
const post = () => helper.acceptPost(body, request());
test('publishes only after both independent checks and exits; exact fixed wire reaches real normalizer', async () => {
  expect(Object.hasOwn(mockHistory.capture.provedTransaction, 'from')).toBe(false);
  expect(mockHistory.capture.submitter).toMatch(/^0x[0-9a-f]{40}$/);
  helper = createCombinedPoiListAcceptance(options);
  expect(helper.answer('ppoi_pois_per_list', statuses())[hex(5)][REQUIRED_LIST]).toBe('Missing');
  expect(() =>
    helper.answer('ppoi_merkle_proofs', {
      ...base,
      listKey: REQUIRED_LIST,
      blindedCommitments: [hex(5)],
    })
  ).toThrow();
  expect((await post()).status).toBe(200);
  expect(verifyRailgunPoiPayload).toHaveBeenCalledTimes(1);
  expect(startRailgunProcess).toHaveBeenCalledTimes(1);
  expect(helper.answer('ppoi_pois_per_list', statuses())[hex(5)][REQUIRED_LIST]).toBe('Valid');
  expect(sign).toHaveBeenCalledWith({ index: 0, blindedCommitment: hex(5), type: 'Transact' });
  expect(helper.report()).toEqual({
    postCalls: 1,
    verifierExits: 1,
    bindingExits: 1,
    signedEvents: 1,
    accepted: true,
    disposableTrust: true,
    singleLeafDisposableList: true,
    historyAuthenticatedAtConstruction: true,
    listStateRealistic: false,
    chainAuthenticated: false,
    productionAuthority: false,
  });
  const admitted = startRailgunProcess.mock.calls[0][0];
  expect(admitted.startupMs).toBe(admitted.lifetimeMs);
  expect(admitted.binaryKey).toBeUndefined();
  expect(admitted.storage).toBeUndefined();
  await expect(post()).rejects.toThrow();
  expect(sign).toHaveBeenCalledTimes(1);
});
test.each(['own-T', 'change', 'input-root', 'txid-root', 'index', 'duplicate-json', 'method'])(
  'refuses %s substitution before verifier or list signing',
  async (mode) => {
    helper = createCombinedPoiListAcceptance(options);
    if (mode === 'own-T') payload.railgunTxidIfHasUnshield = hex(7);
    if (mode === 'change') payload.blindedCommitmentsOut = [hex(7)];
    if (mode === 'input-root') payload.poiMerkleroots = [hex(7).slice(2)];
    if (mode === 'txid-root') payload.txidMerkleroot = hex(7).slice(2);
    if (mode === 'index') payload.txidMerklerootIndex++;
    body = prepareRailgunPoiSubmission({ payload, requestId: 123 }).body;
    if (mode === 'duplicate-json') body = body.replace('"id":123', '"id":123,"id":123');
    if (mode === 'method') body = body.replace('ppoi_submit_transact_proof', 'ppoi_other');
    await expect(post()).rejects.toThrow();
    expect(verifyRailgunPoiPayload).not.toHaveBeenCalled();
    expect(startRailgunProcess).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
  }
);
test.each(['binding', 'authority', 'bad-valid', 'duplicate'])(
  'failed binding %s never unlocks list membership',
  async (mode) => {
    mockMode = mode;
    helper = createCombinedPoiListAcceptance(options);
    await expect(post()).rejects.toThrow();
    expect(sign).not.toHaveBeenCalled();
    expect(helper.report().accepted).toBe(false);
  }
);
test('cryptographic proof refusal cannot be replaced with successful POST', async () => {
  mockVerifier = async () => {
    throw Error('invalid Groth16');
  };
  helper = createCombinedPoiListAcceptance(options);
  await expect(post()).rejects.toThrow('invalid Groth16');
  expect(startRailgunProcess).not.toHaveBeenCalled();
  expect(sign).not.toHaveBeenCalled();
});
test('held verifier cancellation drains original call without issuing membership', async () => {
  const gate = defer(),
    real = mockVerifier;
  mockVerifier = async (v) => {
    await gate.promise;
    return real(v);
  };
  helper = createCombinedPoiListAcceptance(options);
  const pending = post();
  let done = false;
  pending.catch(() => {
    done = true;
  });
  controller.abort();
  let closed = false;
  helper.closed.then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(done).toBe(false);
  expect(closed).toBe(false);
  gate.resolve();
  await expect(pending).rejects.toThrow();
  await helper.closed;
  expect(startRailgunProcess).not.toHaveBeenCalled();
  expect(sign).not.toHaveBeenCalled();
});
test('held binding exit prevents both acceptance and logical close, including after abort', async () => {
  mockHold = true;
  helper = createCombinedPoiListAcceptance(options);
  const pending = post();
  pending.catch(() => {});
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(mockTask.close).toHaveBeenCalled();
  expect(sign).not.toHaveBeenCalled();
  controller.abort();
  let closed = false;
  helper.closed.then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  mockExit();
  await expect(pending).rejects.toThrow();
  await helper.closed;
  expect(sign).not.toHaveBeenCalled();
});
test.each(['spent', 'value', 'hash', 'txid', 'coordinates', 'foreign-owner'])(
  'genuine-read snapshot mismatch %s refuses before any work',
  async (mode) => {
    const n = mockOwned.read.received[0];
    if (mode === 'spent') n.spentTxid = hex(9);
    if (mode === 'value') n.amount = 599n;
    if (mode === 'hash') n.hash = hex(9);
    if (mode === 'txid') n.txid = hex(9);
    if (mode === 'coordinates') n.position++;
    if (mode === 'foreign-owner') options.owners.enrollment.descriptor.walletId = 'foreign';
    expect(() => createCombinedPoiListAcceptance(options)).toThrow();
    expect(verifyRailgunPoiPayload).not.toHaveBeenCalled();
    expect(startRailgunProcess).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
  }
);

test.each(['copied', 'unregistered', 'enrollment', 'coordinator', 'account'])(
  'refuses %s proof or owner without later work',
  (mode) => {
    if (mode === 'copied') options.proof = { ...options.proof };
    if (mode === 'unregistered') options.proof = {};
    if (mode === 'enrollment')
      options.owners = { ...options.owners, enrollment: { ...mockEnrollment } };
    if (mode === 'coordinator')
      options.owners = { ...options.owners, coordinator: { ...mockCoordinator } };
    if (mode === 'account') options.account = {};
    expect(() => createCombinedPoiListAcceptance(options)).toThrow();
    expect(verifyRailgunPoiPayload).not.toHaveBeenCalled();
    expect(startRailgunProcess).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    if (mode !== 'account')
      expect(
        require('../../src/main/wallet/railgun-account-wallet').readRailgunAccountOwnedNotes
      ).not.toHaveBeenCalled();
  }
);
test.each([
  'capsuleDigest',
  'bindingDigest',
  'captureCapsule',
  'projection',
  'provedTransaction',
  'submitter',
  'payloadDigest',
])('rejects inconsistent mocked authenticated history %s', (mode) => {
  if (mode === 'capsuleDigest') mockHistory.capture.capsuleDigest = hash('other');
  if (mode === 'bindingDigest') mockHistory.capture.bindingDigest = 'wrong';
  if (mode === 'captureCapsule') mockHistory.capture.capsule = {};
  if (mode === 'projection') mockHistory.capture.projection = {};
  if (mode === 'provedTransaction') mockHistory.capture.provedTransaction = {};
  if (mode === 'submitter') mockHistory.capture.submitter = '0x' + '12'.repeat(20);
  if (mode === 'payloadDigest') mockHistory.payloadSha256 = hash('other');
  expect(() => createCombinedPoiListAcceptance(options)).toThrow();
  expect(verifyRailgunPoiPayload).not.toHaveBeenCalled();
  expect(startRailgunProcess).not.toHaveBeenCalled();
  expect(sign).not.toHaveBeenCalled();
});
test('pins detached registered history across later registry lifetime and caller mutation', async () => {
  helper = createCombinedPoiListAcceptance(options);
  expect(
    require('../../src/main/wallet/railgun-own-poi-proof').assertRailgunOwnPoiProof
  ).toHaveBeenCalledWith(mockProof, mockEnrollment, mockCoordinator);
  mockProof = undefined;
  mockHistory.payload.poiMerkleroots = [hex(9).slice(2)];
  expect((await post()).status).toBe(200);
  expect(sign).toHaveBeenCalledTimes(1);
});

test.each(['railgunTxidIfHasUnshield', 'txidMerkleroot', 'txidMerklerootIndex', 'outputCount'])(
  'expected metadata %s cannot replace authenticated own witness',
  (field) => {
    mockHistory.expected[field] =
      typeof mockHistory.expected[field] === 'number'
        ? 9
        : field === 'railgunTxidIfHasUnshield'
          ? hex(9)
          : hex(9).slice(2);
    if (field !== 'outputCount') mockHistory.payload[field] = mockHistory.expected[field];
    mockHistory.payloadSha256 = createHash('sha256')
      .update(JSON.stringify(mockHistory.payload))
      .digest('hex');
    expect(() => createCombinedPoiListAcceptance(options)).toThrow();
    expect(verifyRailgunPoiPayload).not.toHaveBeenCalled();
    expect(startRailgunProcess).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
  }
);
