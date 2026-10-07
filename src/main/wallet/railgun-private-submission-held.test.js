/** A proved-unsent hold made by the normal path, then its recovered history.
 * Real: the encrypted reservation and capsule stores on disk, the private
 * operation, both submissions, the capsule and intent binders, the account
 * phase, privacy contexts, identity-manager and the identity vault. Simulated:
 * the engine wallet and prover, the spending and EOA signers, POI, every RPC
 * and the coordinator's public identity. No proof validity or service
 * acceptance is established by these fixtures. */
let mock;
jest.mock('./railgun-account-enrollment', () => ({
  isRailgunAccountEnrollment: (v) => v === mock.enrollment,
}));
jest.mock('./railgun-identity', () => ({
  assertRailgunIdentity: (v, h) => {
    require('../networks/privacy-context').getPrivacyContext(h);
    if (v !== mock.identity || v.signal.aborted) throw Error('identity');
    return v.descriptor;
  },
  assertRailgunPrivateSigner: (token) => {
    if (token !== mock.signerToken || !mock.signerLive) throw Error('B');
  },
  signRailgunPrivateIntent: (...args) => mock.sign(...args),
  quarantineRailgunIdentityCredentials: () => {},
}));
jest.mock('./railgun-engine-runtime', () => ({ verifyRailgunEngineRuntime: (v) => v }));
jest.mock('./railgun-prover-runtime', () => ({ verifyRailgunProverRuntime: (v) => v }));
jest.mock('./railgun-transact-staging', () => ({
  assertRailgunTransactStagingAvailable: () => {
    throw Error('Shield input only');
  },
}));
jest.mock('./railgun-transact-provenance', () => ({
  openRailgunTransactProvenance: async () => {
    throw Error('Shield input only');
  },
  assertRailgunTransactProvenance: () => {
    throw Error('Shield input only');
  },
}));
// The engine wallet and prover: one window, then the proved transaction.
jest.mock('./railgun-account-wallet', () => ({
  readRailgunAccountOwnedNotes: () => mock.baseline,
  assertRailgunAccountPrivateWindow: (token, account, owners, margin = 0) => {
    if (
      token !== mock.window ||
      account !== mock.account ||
      owners.identity !== mock.identity ||
      !mock.windowLive ||
      mock.data.deadline - performance.now() <= margin
    )
      throw Error('window');
    return mock.data;
  },
  operateRailgunAccountPrivateIntent: async (_account, _owners, _request, operation) => {
    mock.windowLive = true;
    try {
      const response = await operation.onIntent(
        mock.offer,
        new AbortController().signal,
        mock.window,
        mock.capsule
      );
      if (response.status !== 'signed') return { operation: { status: 'refused' } };
      return { preparation: mock.offer, operation: { status: 'proved', transaction: mock.proved } };
    } finally {
      mock.windowLive = false;
    }
  },
  getRailgunAccountWalletPolicy: () => 'composite-policy',
  openRailgunCompletedAccountWallet: async () => {
    throw Error('these cases end at the disclosure review');
  },
}));
jest.mock('./railgun-private-receive', () => ({
  verifyRailgunPrivateReceiver: async () => ({
    transactionDigest: mock.offer.transactionDigest,
    recipientVerified: true,
  }),
}));
jest.mock('./railgun-account-poi', () => ({
  openRailgunPrivateWindowPoi: () => mock.poi,
  assertRailgunPrivateWindowPoi: () => {
    if (mock.poi.isClosed) throw Error('POI');
    return mock.poiValue;
  },
}));
// The anchored reads: pass while proving, refuse at their RPC on submission.
jest.mock('./railgun-private-preflight', () => ({
  MAX_AGE_MS: 60000,
  createRailgunPrivatePreflight: (options) => {
    mock.events.push('preflight-open');
    const refuse = mock.preflightRefuse;
    const source = {
      input: options.input,
      acquire: async () => {
        if (refuse)
          throw Object.assign(Error('preflight rpc'), {
            code: 'RAILGUN_PRIVATE_PREFLIGHT_REFUSED',
            reason: 'rpc',
            step: 'nullifiers',
          });
        return { receipt: source };
      },
      close: () => {
        source.isClosed = true;
      },
    };
    return source;
  },
  assertRailgunPrivatePreflight: (source, receipt) => {
    if (source.isClosed || receipt !== source) throw Error('preflight');
    source.observation ??= Object.freeze({ inputUnspent: true, input: source.input });
    return source.observation;
  },
}));
jest.mock('./railgun-private-proof', () => ({
  verifyRailgunPrivateProof: async () => {
    mock.events.push('C');
    const controller = new AbortController();
    const proof = {
      receipt: {},
      signal: controller.signal,
      close: () => {
        proof.isClosed = true;
        controller.abort();
      },
    };
    mock.proofs.push(proof);
    return proof;
  },
  assertRailgunPrivateProof: (receipt) => {
    const proof = mock.proofs.find((value) => value.receipt === receipt);
    if (!proof || proof.isClosed) throw Error('C');
  },
}));
jest.mock('./signers', () => ({
  getSigner: (index) => {
    if (index !== 0) throw Error('index');
    return {
      getAddress: async () => mock.submitter,
      signTransaction: () => {
        throw Error('no EOA signing in these cases');
      },
    };
  },
}));
jest.mock('./private-transaction-network', () => ({
  getPrivateTransactionNetwork: () => ({
    assertCanSubmit: async () => {},
    request: async (_chain, method) => {
      mock.events.push(method);
      return { result: method === 'eth_getCode' ? '0x' : '0x100000000000000' };
    },
  }),
}));
jest.mock('./transaction-service', () => ({
  signAndSendTransaction: async () => {
    throw Error('no send in these cases');
  },
}));
jest.mock('./railgun-public-policy', () => ({ getRailgunPublicPolicy: () => 'public-policy' }));
jest.mock('./railgun-txid-policy', () => ({ getRailgunTxidPolicy: () => 'txid-policy' }));
jest.mock('./railgun-account-public', () => ({
  getRailgunAccountPublicIdentity: () => mock.publicIdentity,
  assertRailgunAccountPublicDestination: () => {},
}));
jest.mock('../networks/private-rpc', () => ({
  createPrivateRpc: (handle, role) => {
    mock.events.push('rpc:' + role);
    return { handle, role, release: () => {} };
  },
  getPrivateRpcDestination: (rpc, handle) => ({ rpc, handle }),
  getPrivateRpcDestinationDetails: (observation) => ({
    url: `https://${observation.rpc?.role ?? 'source'}.invalid/rpc`,
  }),
  createPrivateRpcDestinationConstraint: ({ observation, signal }) => {
    const controller = new AbortController();
    return {
      constraint: { observation },
      signal: AbortSignal.any([signal, controller.signal]),
      close: () => controller.abort(),
    };
  },
}));
jest.mock('./private-submission-journal', () => ({
  getPrivateSubmissionJournal: () => ({
    readSnapshot: async () => {
      mock.events.push('journal-read');
      return { records: [], archive: [] };
    },
  }),
}));
const fs = require('fs'),
  os = require('os'),
  path = require('path');
const { getAddress } = require('ethers');
const { createPrivacyScope } = require('../networks/privacy-context');
const { claimRailgunAccountPhase } = require('./railgun-account-phase');
const { createRailgunPrivateReservations } = require('./railgun-private-reservations');
const {
  createRailgunPrivateCapsuleStore,
  consumeRailgunCapsuleSigningPermit,
} = require('./railgun-private-capsule-store');
const {
  proveRailgunAccountPrivateOperation: prove,
  consumeRailgunPrivateSigningPermit,
} = require('./railgun-private-operation');
const { normalizeRailgunPrivateOffer } = require('./railgun-private-preparation');
const { railgunTransactJournalIntent } = require('./railgun-transact-intent');
const {
  createRailgunLegacyCapsuleData,
} = require('../../../scripts/fixtures/railgun-partial-capsule-data');
const {
  submitRailgunPrivateTransaction,
  submitRailgunRecoveredPrivateTransaction,
  getRailgunPrivateSubmissionDiagnostic: diagnosticOf,
  readRailgunSubmitterMetadata,
} = require('./railgun-private-submission');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const copy = (v) => JSON.parse(JSON.stringify(v));
const SUBMITTER = '0x' + 'c0'.repeat(20);
let root, previousIdentityData, reservations, capsules;

// The disposable profile's identity directory as scripts/create-railgun-test-profile.js
// makes it: identity/vault.createVault, and so no identity-manager metadata.
async function createProfile(metadata) {
  const identity = path.join(root, 'identity');
  process.env.FREEDOM_IDENTITY_DATA = identity;
  await require('../identity/vault').createVault(identity, 'p'.repeat(32));
  if (metadata)
    // The shape identity-manager.createNewVault writes beside an app-made vault.
    fs.writeFileSync(
      path.join(identity, 'vault-meta.json'),
      JSON.stringify({
        userKnowsPassword: true,
        createdAt: new Date().toISOString(),
        addresses: { userWallet: metadata, beeWallet: getAddress('0x' + '0b'.repeat(20)) },
      })
    );
}

async function setup() {
  const scope = createPrivacyScope({
    profileId: 'held-history-unit',
    signal: new AbortController().signal,
  });
  const f = createRailgunLegacyCapsuleData('railgun-private-transfer');
  const capsule = f.capsule;
  capsule.engineSha256 = require('./railgun-engine-manifest.json').sha256;
  f.inner.proof.a.x = 1;
  const walletId = capsule.walletId;
  const checkpointHash = 'f'.repeat(64);
  mock = {
    scope,
    events: [],
    proofs: [],
    window: {},
    signerToken: {},
    windowLive: false,
    signerLive: false,
    submitter: getAddress(SUBMITTER),
    capsule,
    offer: normalizeRailgunPrivateOffer(capsule.preparation, capsule.selection),
    proved: { ...capsule.preparation.transaction, data: f.encode() },
    request: f.request,
    publicIdentity: {
      generationId: 'a'.repeat(64),
      sourceId: 'b'.repeat(64),
      publicId: 'c'.repeat(64),
    },
    generation: { id: 'd'.repeat(64) },
  };
  mock.identity = {
    descriptor: { walletId, accountIndex: 0, instanceId: f.owned.read.instanceId },
    signal: scope.signal,
  };
  mock.account = { signal: scope.signal };
  mock.coordinator = { signal: scope.signal };
  mock.baseline = {
    checkpointHash,
    ownedPoi: [{ id: '0:1', type: 'Shield', nullifier: hex(2), hash: capsule.noteHash }],
    read: { ...f.owned.read, readiness: { to: { number: 10 } } },
  };
  mock.data = {
    owned: mock.baseline,
    selection: capsule.selection,
    deadline: performance.now() + 175000,
  };
  let drained;
  mock.poi = {
    closed: new Promise((resolve) => (drained = resolve)),
    acquire: async () => ({ status: 'verified', receipt: {} }),
    close: () => {
      mock.poi.isClosed = true;
      drained();
    },
  };
  mock.poiValue = Object.freeze({
    statuses: [{ status: 'Valid' }],
    membershipVerified: true,
    rootsAccepted: true,
    input: {
      id: '0:1',
      nullifier: hex(2),
      noteHash: capsule.noteHash,
      checkpointHash,
      type: 'Shield',
    },
  });
  mock.sign = async ({ onKeyRequest }) => {
    mock.signerLive = true;
    try {
      const permit = await onKeyRequest(
        { transactionDigest: mock.offer.transactionDigest, expectedHash: mock.offer.expectedHash },
        mock.signerToken
      );
      await consumeRailgunPrivateSigningPermit(
        permit,
        mock.identity,
        mock.signerToken
      ).assertCurrent();
      return { signature: { R8: [hex(1), hex(2)], S: hex(3) } };
    } finally {
      mock.signerLive = false;
    }
  };
  const directory = path.join(root, 'account');
  fs.mkdirSync(directory);
  const subject = {
    kind: 'private-account',
    principal: 'railgun:0',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
  };
  mock.enrollment = {
    directory,
    descriptor: mock.identity.descriptor,
    signal: scope.signal,
    getContext: (role, operation) =>
      scope.getContext({ ...subject, role, ...(operation ? { operation } : {}) }),
    catalog: { activeFor: (policy) => (policy === 'composite-policy' ? mock.generation : null) },
    openReservations: async () => reservations,
    openPrivateCapsules: async () => capsules,
    openPrivateRecoveryStores: async () => {
      const phase = claimRailgunAccountPhase(mock.enrollment, 'recovery');
      try {
        return Object.freeze({ reservations, capsules });
      } finally {
        phase.release();
      }
    },
  };
  let reservationFloor = null,
    capsuleFloor = null;
  const storage = (operation) =>
    scope.getContext({ ...subject, role: 'storage', operation: operation + walletId });
  reservations = await createRailgunPrivateReservations({
    handle: storage('railgun-private-reservations-v1:'),
    directory,
    key: Buffer.alloc(32, 6),
    binding: '6'.repeat(64),
    walletId,
    create: true,
    readFloor: async () => reservationFloor,
    advanceFloor: async (v) => {
      reservationFloor = v;
    },
    authorizeSigning: (permit, held, receipt, evidence) =>
      consumeRailgunCapsuleSigningPermit(permit, capsules, held, receipt, evidence),
    claimRecovery: () => claimRailgunAccountPhase(mock.enrollment, 'recovery'),
  });
  capsules = await createRailgunPrivateCapsuleStore({
    handle: storage('railgun-private-capsules-v1:'),
    directory,
    key: Buffer.alloc(32, 7),
    binding: '6'.repeat(64),
    walletId,
    reservations,
    create: true,
    readFloor: async () => capsuleFloor,
    advanceFloor: async (v) => {
      capsuleFloor = v;
    },
  });
}

// The live L-A transfer mode: prove, then the production submission refuses at
// its preflight's RPC. Nothing is reviewed, journaled or sent; the hold stays.
async function holdProvedUnsent() {
  const proved = await prove({
    account: mock.account,
    owners: { identity: mock.identity, enrollment: mock.enrollment, coordinator: mock.coordinator },
    request: mock.request,
    archive: '/engine.tgz',
    proverArchive: '/prover.tgz',
    artifactDirectory: '/artifacts',
  });
  expect(proved).toMatchObject({ status: 'proved', submissionEnabled: false });
  mock.preflightRefuse = true;
  const review = jest.fn();
  const result = await submitRailgunPrivateTransaction({
    identity: mock.identity,
    enrollment: mock.enrollment,
    completion: proved.completion.receipt,
    proverArchive: '/prover.tgz',
    artifactDirectory: '/artifacts',
    review,
    gasLimit: 1559208n,
    maxGasFee: 2000000000000000n,
  });
  mock.preflightRefuse = false;
  expect(result).toEqual({ status: 'recovery-required', stage: 'preflight' });
  expect(diagnosticOf(result)).toMatchObject({
    stage: 'preflight',
    substage: 'acquire',
    code: 'RAILGUN_PRIVATE_PREFLIGHT_REFUSED',
  });
  expect(review).not.toHaveBeenCalled();
  expect(await reservations.inspect()).toMatchObject({ held: 0, signing: 1 });
  expect(await capsules.inspect()).toMatchObject({ records: 1, signatures: 1, proofs: 1 });
  const stored = await capsules.get(proved.holdId);
  // The hold binds the journal intent of the proved transaction and its EOA.
  expect(
    railgunTransactJournalIntent({ ...stored.provedTransaction, from: SUBMITTER }).intentDigest
  ).toBe(mock.offer.transactionDigest);
  return { holdId: proved.holdId, stored: copy(stored) };
}

async function recover(holdId) {
  const disclosures = [];
  const result = await submitRailgunRecoveredPrivateTransaction({
    identity: mock.identity,
    enrollment: mock.enrollment,
    coordinator: mock.coordinator,
    destination: Object.freeze({}),
    archive: '/engine.tgz',
    proverArchive: '/prover.tgz',
    artifactDirectory: '/artifacts',
    holdId,
    reviewDisclosures: async (summary) => {
      disclosures.push(summary);
      // These cases stop at the first review: history is what they qualify.
      return false;
    },
    reviewTransaction: async () => false,
    gasLimit: 1559208n,
    maxGasFee: 2000000000000000n,
    signal: new AbortController().signal,
  });
  return { result, disclosures };
}

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-held-history-')));
  previousIdentityData = process.env.FREEDOM_IDENTITY_DATA;
  await setup();
});
afterEach(() => {
  reservations?.close();
  capsules?.close();
  mock.scope.close();
  if (previousIdentityData === undefined) delete process.env.FREEDOM_IDENTITY_DATA;
  else process.env.FREEDOM_IDENTITY_DATA = previousIdentityData;
  fs.rmSync(root, { recursive: true, force: true });
});

test('a vault-only profile refuses the held proof at history, naming the submitter metadata', async () => {
  await createProfile(null);
  const { holdId, stored } = await holdProvedUnsent();
  const before = mock.events.length;
  const { result, disclosures } = await recover(holdId);
  expect(result).toEqual({ status: 'recovery-required', stage: 'history' });
  // Every hold check passed; the vault has no public wallet-0 record to bind.
  expect(diagnosticOf(result)).toEqual({
    stage: 'history',
    substage: 'submitter-metadata',
    code: 'ERR_ASSERTION',
  });
  expect(() => readRailgunSubmitterMetadata()).toThrow();
  // Refused before any destination, journal read, disclosure review or proof.
  expect(mock.events.slice(before)).toEqual([]);
  expect(disclosures).toEqual([]);
  expect(await reservations.inspect()).toMatchObject({ held: 0, signing: 1 });
  expect(copy(await capsules.get(holdId))).toEqual(stored);
});

test('the same hold passes history once the vault has its public wallet-0 metadata', async () => {
  await createProfile(getAddress(SUBMITTER));
  const { holdId, stored } = await holdProvedUnsent();
  expect(readRailgunSubmitterMetadata()).toEqual({
    index: 0,
    type: 'mnemonic',
    address: SUBMITTER,
  });
  const before = mock.events.length;
  const { result, disclosures } = await recover(holdId);
  expect(result).toEqual({ status: 'recovery-required', stage: 'disclosure-review' });
  expect(mock.events.slice(before)).toEqual([
    'rpc:protocol-rpc',
    'rpc:transaction-rpc',
    'journal-read',
  ]);
  expect(disclosures).toHaveLength(1);
  expect(disclosures[0]).toMatchObject({
    operation: 'railgun-private-transfer',
    submitter: SUBMITTER,
    recipient: mock.identity.descriptor.instanceId,
    originalSpendingSignatureReused: true,
    newSpendingSignature: false,
  });
  expect(copy(await capsules.get(holdId))).toEqual(stored);
});

test('public metadata naming another account refuses at the submitter sub-step', async () => {
  await createProfile(getAddress('0x' + '98'.repeat(20)));
  const { holdId } = await holdProvedUnsent();
  const { result, disclosures } = await recover(holdId);
  expect(diagnosticOf(result)).toEqual({
    stage: 'history',
    substage: 'submitter',
    code: 'ERR_ASSERTION',
  });
  expect(disclosures).toEqual([]);
});
