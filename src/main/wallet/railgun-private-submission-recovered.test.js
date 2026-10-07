/** Offline composition tests: real capsule/calldata binders and privacy/phase
 * owners; controlled store, worker and service receipts. No service acceptance
 * or cryptographic proof validity is established by these fixtures. */
let mock;
jest.mock('./railgun-private-operation', () => ({
  claimRailgunPrivateCompletion: () => {
    throw Error('cold must not mint completion');
  },
}));
jest.mock('./railgun-account-enrollment', () => ({
  isRailgunAccountEnrollment: (v) => v === mock.enrollment,
}));
jest.mock('./railgun-identity', () => ({
  quarantineRailgunIdentityCredentials: (identity) => {
    expect(identity).toBe(mock.identity);
    mock.quarantined = true;
    if (mock.quarantineThrows) throw Error('issuer cleanup');
  },
  assertRailgunIdentity: (v, h) => {
    mock.context(h);
    if (v !== mock.identity) throw Error('identity');
    return v.descriptor;
  },
}));
jest.mock('./railgun-engine-runtime', () => ({
  verifyRailgunEngineRuntime: (v) => {
    if (v !== '/engine.tgz') throw Error('engine');
    return v;
  },
}));
jest.mock('./railgun-prover-runtime', () => ({
  verifyRailgunProverRuntime: (v) => {
    if (v !== '/prover.tgz') throw Error('prover');
    return v;
  },
}));
jest.mock('./railgun-public-policy', () => ({ getRailgunPublicPolicy: () => 'public-policy' }));
jest.mock('./railgun-wallet-policy', () => ({
  getRailgunWalletPolicy: () => 'engine-only-policy',
}));
jest.mock('./railgun-txid-policy', () => ({ getRailgunTxidPolicy: () => 'txid-policy' }));
jest.mock('./railgun-account-public', () => ({
  getRailgunAccountPublicIdentity: (c, e, p) => {
    if (c !== mock.coordinator || e !== mock.enrollment || p !== 'public-policy')
      throw Error('owner');
    return mock.publicIdentity;
  },
  assertRailgunAccountPublicDestination: (c, e, d, p) => {
    if (
      c !== mock.coordinator ||
      e !== mock.enrollment ||
      d !== mock.destination ||
      p !== 'public-policy'
    )
      throw Error('destination');
  },
}));
jest.mock('../networks/private-rpc', () => ({
  createPrivateRpc: (h, role) => {
    mock.context(h);
    mock.events.push('preview:' + role);
    return { handle: h, role, release: jest.fn() };
  },
  getPrivateRpcDestination: (rpc, h) => {
    if (rpc.handle !== h) throw Error('RPC owner');
    return { rpc, h };
  },
  getPrivateRpcDestinationDetails: (obs) => ({
    url:
      obs === mock.destination
        ? 'https://source.invalid/secret-path'
        : `https://${obs.rpc.role}.invalid/rpc`,
  }),
  createPrivateRpcDestinationConstraint: ({ observation, signal, deadline }) => {
    const controller = new AbortController();
    const value = {
      constraint: { observation },
      signal: AbortSignal.any([signal, controller.signal]),
      close: () => controller.abort(),
      deadline,
    };
    mock.constraints.push(value);
    return value;
  },
}));
jest.mock('./private-submission-journal', () => ({
  getPrivateSubmissionJournal: () => ({
    readSnapshot: async () => {
      await mock.step('journal-read');
      return mock.realJournal ? mock.realJournal.readSnapshot() : mock.history;
    },
  }),
}));
jest.mock('./railgun-account-wallet', () => ({
  getRailgunAccountWalletPolicy: ({ archive, coordinator, enrollment }) => {
    if (
      archive !== '/engine.tgz' ||
      coordinator !== mock.coordinator ||
      enrollment !== mock.enrollment
    )
      throw Error('policy owners');
    return 'composite-policy';
  },
  openRailgunCompletedAccountWallet: async (options) => {
    mock.walletOptions = options;
    return mock.openWallet();
  },
  readRailgunCompletedAccountPrivateInput: (account, owners, capsule) => {
    if (
      account !== mock.account ||
      owners.identity !== mock.identity ||
      owners.enrollment !== mock.enrollment ||
      owners.coordinator !== mock.coordinator ||
      mock.phase !== 'wallet'
    )
      throw Error('wallet owners');
    expect(capsule).toEqual(mock.capsule);
    mock.events.push('owned-input');
    return mock.owned;
  },
}));
jest.mock('./railgun-account-txid', () => ({
  openRailgunAccountTxid: async (options) => {
    mock.mirrorOptions = options;
    return mock.openMirror();
  },
}));
jest.mock('./railgun-txid-note-witness', () => ({
  normalizeRailgunNoteTxidWitness: (value, state, note) => {
    if (value !== mock.noteWitness || state.root !== mock.mirrorState.root) throw Error('witness');
    expect(note).toEqual(mock.note);
    return value;
  },
}));
jest.mock('./railgun-wallet-coverage', () => ({ checkpointHash: (v) => v.digest }));
jest.mock('./railgun-private-creator', () => ({
  collectRailgunPrivateCreator: async ({ note, checkpoint, visit, assertCurrent }) => {
    assertCurrent();
    expect(note).toEqual(mock.note);
    expect(checkpoint.digest).toBe(mock.owned.binding.checkpointHash);
    await visit(() => {});
    await mock.step('creator-collect');
    return mock.creator;
  },
}));
jest.mock('./railgun-note-provenance', () => ({
  verifyRailgunNoteProvenance: async (input) => {
    await mock.step('creator-verify');
    mock.creatorInput = input;
    const { archive, state, noteWitness, events } = input;
    const inputSha256 = require('crypto')
      .createHash('sha256')
      .update(JSON.stringify({ archive, state, note: noteWitness.note, noteWitness, events }))
      .digest('hex');
    return {
      inputSha256,
      pathVerified: true,
      suppliedCreatorEventsMatched: true,
      utilityExitObserved: true,
      coverage: {
        matchedRows: 1,
        knownOmissions: 0,
        boundParamsChecked: false,
        unshieldCommitmentHashesChecked: false,
        globalTxidCompleteness: false,
      },
      ...(noteWitness.witness.row.unshield ? { unshieldCommitmentVerified: true } : {}),
      ...mock.creatorOverride,
    };
  },
}));
jest.mock('./railgun-scan-coordinator', () => ({
  getRailgunCompletedSnapshotOutcome: (c, e) => {
    if (c !== mock.coordinator || e !== mock.sourceError) throw Error('forged error');
    return mock.sourceOutcome;
  },
}));
jest.mock('./railgun-private-proof', () => ({
  verifyRailgunPrivateProof: async (input) => {
    await mock.step('C');
    mock.proofInput = input;
    mock.proofAt = performance.now();
    return mock.proof;
  },
  assertRailgunPrivateProof: (receipt, e, evidence, margin = 0) => {
    mock.proofMargins.push(margin);
    if (
      receipt !== mock.proof.receipt ||
      e !== mock.enrollment ||
      mock.proofClosed ||
      performance.now() < mock.proofAt ||
      performance.now() + margin >= mock.proofAt + 60000
    )
      throw Error('C');
    expect(evidence.transaction).toEqual(mock.stored.provedTransaction);
  },
}));
jest.mock('./railgun-poi-source', () => ({
  createRailgunPoiSource: ({ handle, notes }) => {
    mock.poiHandle = handle;
    mock.notes = notes;
    mock.events.push('poi-open');
    return mock.poi;
  },
}));
jest.mock('./railgun-poi-membership', () => ({
  verifyRailgunPoiMembership: async ({ handle, source, receipt }) => {
    expect(handle).toBe(mock.poiHandle);
    expect(source).toBe(mock.poi);
    expect(receipt).toBe(mock.poiReceipt);
    await mock.step('membership');
    return mock.membership;
  },
  assertRailgunPoiMembership: (receipt, handle, margin) => {
    if (receipt !== mock.membership.receipt || handle !== mock.poiHandle || mock.membershipInvalid)
      throw Error('membership');
    mock.poi.assertResult(mock.poiReceipt, margin);
    return mock.membership.observation;
  },
}));
jest.mock('./railgun-txid-root', () => ({
  createRailgunTxidRootSource: (handle) => {
    mock.rootHandle = handle;
    mock.events.push('root-open');
    return mock.roots;
  },
}));
jest.mock('./railgun-private-preflight', () => ({
  createRailgunPrivatePreflight: (input) => {
    mock.preflightOptions = input;
    mock.events.push('preflight-open');
    return mock.preflight;
  },
  assertRailgunPrivatePreflight: (_source, _receipt, _enrollment, margin = 0) => {
    mock.preflightMargins.push(margin);
    if (mock.preflightClosed || performance.now() + margin >= mock.preflightAt + 60000)
      throw Error('preflight');
    return mock.preflightObservation;
  },
}));
jest.mock('./private-transaction-network', () => ({
  getPrivateTransactionNetwork: (h, options) => {
    mock.networkHandle = h;
    mock.networkOptions = options;
    mock.events.push('network');
    return mock.network;
  },
}));
jest.mock('../identity-manager', () => ({
  getWalletRecord: () => mock.walletMetadata,
  WALLET_TYPES: { MNEMONIC: 'mnemonic' },
}));
jest.mock('./signers', () => ({ getSigner: () => mock.signer }));
jest.mock('./transaction-service', () => ({
  signAndSendTransaction: (...args) => mock.send(...args),
}));
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { claimRailgunAccountPhase } = require('./railgun-account-phase');
const {
  createRailgunPartialCapsuleData,
  createRailgunLegacyCapsuleData,
} = require('../../../scripts/fixtures/railgun-partial-capsule-data');
const { railgunTransactJournalIntent } = require('./railgun-transact-intent');
const {
  submitRailgunRecoveredPrivateTransaction: submit,
  assertRailgunPrivateSubmission: authorize,
  getRailgunPrivateSubmissionDiagnostic: diagnosticOf,
} = require('./railgun-private-submission');
const copy = (v) => JSON.parse(JSON.stringify(v));
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
async function until(fn) {
  for (let n = 0; n < 1000; n++) {
    if (fn()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw Error('test gate not entered');
}
let options,
  fixtureSequence = 0;
function setup(kind = 'railgun-partial-unshield', type = 'Shield') {
  const f =
    kind === 'railgun-partial-unshield'
      ? createRailgunPartialCapsuleData()
      : createRailgunLegacyCapsuleData(kind);
  const capsule = f.capsule,
    owner =
      kind === 'railgun-private-transfer' ? '0x' + '12'.repeat(20) : capsule.selection.recipient;
  f.inner.proof.a.x = 1;
  const proved = { ...capsule.preparation.transaction, data: f.encode() };
  const original = railgunTransactJournalIntent({ ...proved, from: owner });
  const scope = createPrivacyScope({
    profileId: 'cold-submit-unit',
    signal: new AbortController().signal,
  });
  mock = {
    scope,
    context: getPrivacyContext,
    events: [],
    proofMargins: [],
    preflightMargins: [],
    hooks: {},
    constraints: [],
    capsule,
    owner,
    caller: new AbortController(),
    destination: Object.freeze({}),
    publicIdentity: {
      generationId: 'a'.repeat(64),
      sourceId: 'b'.repeat(64),
      publicId: 'c'.repeat(64),
    },
    generation: { id: 'd'.repeat(64) },
    history: { records: [], archive: [] },
    phase: null,
    clock: 1000,
    poiStarted: 1000,
    rootStarted: 1000,
  };
  mock.step = async (name) => {
    mock.events.push(name);
    await mock.hooks[name]?.();
    if (mock.failure === name) throw Error('refused ' + name);
  };
  mock.identity = {
    descriptor: { walletId: capsule.walletId, accountIndex: 0 },
    signal: scope.signal,
  };
  mock.enrollment = {
    directory: '/cold-submit-unit-' + ++fixtureSequence,
    descriptor: mock.identity.descriptor,
    signal: scope.signal,
    getContext: (role, operation) =>
      scope.getContext({
        kind: 'private-account',
        principal: 'railgun:0',
        protocol: 'railgun',
        deployment: 'sepolia',
        chainId: 11155111,
        role,
        ...(operation ? { operation } : {}),
      }),
    catalog: {
      activeFor: (policy) => {
        if (policy !== 'composite-policy') return null;
        return mock.generation;
      },
    },
    openPrivateRecoveryStores: async () => ({
      reservations: mock.reservations,
      capsules: mock.capsules,
    }),
  };
  mock.entry = {
    id: 'e'.repeat(64),
    state: 'signing',
    signing: { submitter: owner },
    facts: {
      intentDigest: original.intentDigest,
      nullifier: capsule.preparation.expected.nullifier,
      checkpointHash: 'f'.repeat(64),
    },
  };
  mock.stored = {
    holdId: mock.entry.id,
    capsule,
    signature: { R8: ['1', '2'], S: '3' },
    provedTransaction: proved,
  };
  mock.receipt = {};
  mock.reservations = {
    withSigningRecovery: async (use, { timeoutMs }) => {
      const phase = claimRailgunAccountPhase(mock.enrollment, 'recovery');
      mock.phase = 'recovery';
      mock.events.push('recovery-open');
      const deadline = performance.now() + timeoutMs;
      let unknown = false;
      try {
        return await use([{ entry: copy(mock.entry), receipt: mock.receipt }], {
          signal: scope.signal,
          deadline,
          assertCurrent: () => {
            phase.assertCurrent();
            if (performance.now() >= deadline) throw Error('expired recovery');
          },
        });
      } catch (error) {
        mock.recoveryCallbackError = error;
        unknown = error?.code === 'RAILGUN_NOTE_PROVENANCE_EXIT_UNOBSERVED';
        throw error;
      } finally {
        mock.events.push('recovery-close');
        mock.phase = null;
        // Mirrors the fixed real ledger catch, covered separately with real storage.
        if (!unknown) phase.release();
      }
    },
    assertReceiptContext: (r, k) => {
      if (r !== mock.receipt || k !== 'recovery' || mock.phase !== 'recovery')
        throw Error('receipt');
    },
    assertReceipt: async () => {
      await mock.step('hold-read');
      return copy(mock.entry);
    },
  };
  mock.capsules = {
    readSigned: async (r) => {
      if (r !== mock.receipt) throw Error('receipt');
      await mock.step('signed-read');
      return copy(mock.stored);
    },
    get: async () => {
      await mock.step('capsule-read');
      return copy(mock.stored);
    },
  };
  mock.checkpoint = { digest: '1'.repeat(64), to: { number: 6000001, hash: hex(10) } };
  mock.owned = {
    binding: {
      id: '0:1',
      type,
      txid: hex(11),
      noteHash: capsule.noteHash,
      nullifier: capsule.preparation.expected.nullifier,
      amount: '1000',
      checkpointHash: mock.checkpoint.digest,
    },
    ownedRecord: {
      id: '0:1',
      type,
      txid: hex(11),
      hash: capsule.noteHash,
      nullifier: capsule.preparation.expected.nullifier,
      npk: hex(15),
      blindedCommitment: hex(16),
      blockNumber: 6000000,
    },
    publicThrough: copy(mock.checkpoint.to),
    generationId: mock.generation.id,
  };
  mock.note = {
    type,
    txid: hex(11),
    hash: capsule.noteHash,
    tree: 0,
    position: 1,
    blockNumber: 6000000,
  };
  mock.token = {};
  mock.coordinator = {
    signal: scope.signal,
    withCompletedPublicSnapshot: async (opts, use) => {
      mock.sourceOptions = opts;
      await mock.step('source');
      if (mock.sourceError) throw mock.sourceError;
      const value = await use({
        checkpoint: mock.checkpoint,
        signal: scope.signal,
        visitSource: async (visitor) => {
          mock.events.push('source-visit');
          visitor({});
        },
      });
      await mock.step('source-finish');
      return { value, evidence: mock.token };
    },
    assertSnapshot: (token) => {
      if (token !== mock.token || mock.tokenInvalid) throw Error('snapshot');
      return mock.checkpoint;
    },
  };
  mock.openWallet = async () => {
    const phase = claimRailgunAccountPhase(mock.enrollment, 'wallet');
    mock.phase = 'wallet';
    mock.account = {
      close: async () => {
        try {
          await mock.step('wallet-close');
        } finally {
          mock.phase = null;
          phase.release();
        }
      },
    };
    try {
      await mock.step('wallet-open');
      return mock.account;
    } catch (error) {
      await mock.account.close();
      throw error;
    }
  };
  mock.mirrorState = { count: 2, root: '0'.repeat(63) + '9' };
  mock.noteWitness = {
    note: mock.note,
    witness: {
      row: {
        graphID: '0x' + '0'.repeat(64) + '0'.repeat(63) + '3' + '0'.repeat(64),
        blockNumber: 6000000,
        txid: hex(11).slice(2),
      },
    },
  };
  mock.creator = {
    note: mock.note,
    checkpointHash: mock.checkpoint.digest,
    creator: { transactionIndex: 3, blockNumber: 6000000, transactionHash: hex(11) },
    events: [],
  };
  mock.openMirror = async () => {
    const phase = claimRailgunAccountPhase(mock.enrollment, 'txid');
    mock.phase = 'txid';
    mock.mirror = {
      policy: 'txid-policy',
      publicIdentity: copy(mock.publicIdentity),
      inspect: async () => {
        await mock.step('mirror-inspect');
        return { checkpoint: { state: copy(mock.mirrorState) }, pending: null };
      },
      witnessNote: async () => {
        await mock.step('mirror-witness');
        return { noteWitness: mock.noteWitness };
      },
      close: async () => {
        try {
          await mock.step('mirror-close');
        } finally {
          mock.phase = null;
          phase.release();
        }
      },
    };
    try {
      await mock.step('mirror-open');
      return mock.mirror;
    } catch (error) {
      await mock.mirror.close();
      throw error;
    }
  };
  mock.proof = {
    receipt: {},
    signal: scope.signal,
    close: () => {
      mock.proofClosed = true;
      mock.events.push('C-close');
    },
  };
  mock.poiReceipt = {};
  mock.poiDone = deferred();
  mock.poi = {
    closed: mock.poiDone.promise,
    close: () => {
      mock.poiClosed = true;
      mock.events.push('poi-close');
      if (!mock.holdPoiClose) mock.poiDone.resolve();
    },
    acquire: async () => {
      mock.poiStarted = performance.now();
      await mock.step('poi-acquire');
      mock.poiObservation = {
        listKey: require('./railgun-poi-records').REQUIRED_LIST,
        statuses: mock.notes.map((n) => ({ ...n, status: 'Valid' })),
        rootsAccepted: true,
        ...mock.poiOverride,
      };
      mock.membership.observation = {
        ...mock.poiObservation,
        membershipVerified: true,
        ...mock.memberOverride,
      };
      return { receipt: mock.poiReceipt };
    },
    assertResult: (receipt, margin = 0) => {
      mock.context(mock.poiHandle);
      if (
        receipt !== mock.poiReceipt ||
        mock.poiClosed ||
        performance.now() + margin >= mock.poiStarted + 60000
      )
        throw Error('POI expired');
      return mock.poiObservation;
    },
  };
  mock.membership = { receipt: {} };
  mock.roots = {
    acquire: async (point) => {
      mock.rootPoint = point;
      mock.rootStarted = performance.now();
      await mock.step('root');
      return (mock.rootReceipt = {});
    },
    assertRoot: (r, p, margin = 0) => {
      mock.context(mock.rootHandle);
      if (
        r !== mock.rootReceipt ||
        p !== mock.rootPoint ||
        mock.rootClosed ||
        performance.now() + margin >= mock.rootStarted + 60000
      )
        throw Error('root');
    },
    close: () => {
      mock.rootClosed = true;
      mock.events.push('root-close');
    },
  };
  mock.preflight = {
    signal: scope.signal,
    close: () => {
      mock.preflightClosed = true;
    },
    acquire: async () => {
      mock.preflightAt = performance.now();
      await mock.step('preflight');
      mock.preflightObservation = {
        input: copy(mock.preflightOptions.input),
        ...(mock.preflightOptions.intentKind
          ? { intentKind: mock.preflightOptions.intentKind }
          : {}),
        ...mock.preflightOverride,
      };
      return { receipt: {} };
    },
  };
  mock.walletMetadata = { index: 0, type: 'mnemonic', address: owner };
  mock.signer = {
    getAddress: async () => {
      await mock.step('signer-address');
      return mock.owner;
    },
    signTransaction: async () => {
      await mock.step('sign');
      return '0x1234';
    },
  };
  mock.network = {
    assertCanSubmit: async () => mock.step('journal-current'),
    request: async (_chain, method) => {
      await mock.step(method);
      return {
        result: {
          eth_getCode: '0x',
          eth_estimateGas: '0x100',
          eth_call: '0x',
          eth_getTransactionCount: '0x1',
          eth_getBalance: '0x10000000',
        }[method],
      };
    },
    listSubmissions: async () => mock.attempts,
  };
  mock.send = async (params, signer, config) => {
    mock.events.push('send-enter');
    authorize(config.privacyContext, config.intent);
    const transaction = { ...params, gasPrice: '100', nonce: 1 };
    if (Date.now() >= config.reviewExpiresAt) throw Error('expired review');
    if (!(await config.review({ from: owner, transaction, expiresAt: config.reviewExpiresAt })))
      throw Error('denied');
    await signer.getAddress();
    await signer.signTransaction(transaction);
    if (Date.now() >= config.reviewExpiresAt) throw Error('expired signing');
    authorize(config.privacyContext, config.intent);
    await mock.step('broadcast');
    return mock.outcome || { transactionHash: hex(17), submissionStatus: 'acknowledged' };
  };
  options = {
    identity: mock.identity,
    enrollment: mock.enrollment,
    coordinator: mock.coordinator,
    destination: mock.destination,
    archive: '/engine.tgz',
    proverArchive: '/prover.tgz',
    artifactDirectory: '/artifacts',
    holdId: mock.entry.id,
    signal: mock.caller.signal,
    gasLimit: 1000n,
    maxGasFee: 200000n,
    reviewDisclosures: async (summary, signal) => {
      mock.summary = summary;
      mock.reviewSignal = signal;
      await mock.step('disclosure-review');
      return true;
    },
    reviewTransaction: async () => {
      await mock.step('transaction-review');
      return true;
    },
  };
}
beforeEach(() => setup());
afterEach(() => {
  mock.poiDone?.resolve();
  mock.scope.close();
  jest.restoreAllMocks();
});
test.each(
  ['Shield', 'Transact'].flatMap((type) =>
    ['railgun-private-transfer', 'railgun-token-unshield', 'railgun-partial-unshield'].map(
      (kind) => [kind, type]
    )
  )
)('submits exact recovered %s with %s input after sequential owners', async (kind, type) => {
  setup(kind, type);
  const before = copy(mock.stored);
  const result = await submit(options);
  expect(result).toEqual({ transactionHash: hex(17), submissionStatus: 'acknowledged' });
  expect(mock.stored).toEqual(before);
  expect(mock.phase).toBeNull();
  expect(mock.events.filter((v) => v === 'C')).toHaveLength(1);
  expect(mock.events.filter((v) => v === 'sign')).toHaveLength(1);
  expect(mock.events.indexOf('journal-read')).toBeLessThan(
    mock.events.indexOf('disclosure-review')
  );
  expect(mock.events.indexOf('disclosure-review')).toBeLessThan(mock.events.indexOf('wallet-open'));
  expect(mock.events.indexOf('wallet-close')).toBeLessThan(mock.events.indexOf('source'));
  expect(mock.events.indexOf('source-finish')).toBeLessThan(mock.events.indexOf('C'));
  expect(mock.events.indexOf('C')).toBeLessThan(mock.events.indexOf('poi-acquire'));
  expect(mock.events.indexOf('poi-acquire')).toBeLessThan(mock.events.indexOf('preflight'));
  expect(mock.preflightOptions.input).toEqual({
    tree: 0,
    merkleRoot: mock.capsule.preparation.expected.merkleRoot,
    nullifier: mock.capsule.preparation.expected.nullifier,
    checkpointHash: mock.checkpoint.digest,
    minimumBlock: mock.checkpoint.to.number,
  });
  expect(mock.preflightOptions.input.checkpointHash).not.toBe(mock.entry.facts.checkpointHash);
  expect(mock.preflightOptions.destinationConstraint).toBe(mock.constraints[0].constraint);
  expect(mock.networkOptions.destinationConstraint).toBe(mock.constraints[1].constraint);
  if (type === 'Transact') {
    expect(mock.events.indexOf('mirror-close')).toBeLessThan(
      mock.events.indexOf('creator-collect')
    );
    expect(mock.events.indexOf('creator-verify')).toBeLessThan(mock.events.indexOf('C'));
    expect(mock.events.indexOf('membership')).toBeLessThan(mock.events.indexOf('root'));
    expect(mock.rootPoint).toEqual({ index: 1, root: mock.mirrorState.root });
    expect(mock.mirrorOptions).toMatchObject({ create: false, checkpointOnly: true });
  } else expect(mock.events).not.toContain('mirror-open');
  expect(mock.events.indexOf('poi-close')).toBeLessThan(mock.events.lastIndexOf('recovery-close'));
});
test.each(['capsule', 'proof', 'completion', 'observed', 'destinationConstraints', 'authorize'])(
  'refuses caller %s seam before store access',
  (key) =>
    submit({ ...options, [key]: {} }).then((result) => {
      expect(result).toEqual({ status: 'recovery-required', stage: 'admission' });
      expect(mock.events).toEqual([]);
    })
);
test.each([null, 0, 600001, NaN, Infinity])('refuses invalid timeout %p', (timeoutMs) =>
  submit({ ...options, timeoutMs }).then((result) => {
    expect(result.stage).toBe('admission');
    expect(mock.events).toEqual([]);
  })
);
test('rejects an accessor option without invoking it', async () => {
  const getter = jest.fn();
  Object.defineProperty(options, 'holdId', { get: getter, enumerable: true });
  expect((await submit(options)).stage).toBe('admission');
  expect(getter).not.toHaveBeenCalled();
});
test('rejects proxy options without traps', async () => {
  const trap = jest.fn(() => {
    throw Error('trap');
  });
  await submit(new Proxy(options, { get: trap, getPrototypeOf: trap, ownKeys: trap }));
  expect(trap).not.toHaveBeenCalled();
});
test.each(['identity', 'enrollment', 'coordinator', 'destination'])(
  'rejects wrong %s without disclosure',
  async (field) => {
    expect((await submit({ ...options, [field]: {} })).stage).toBe('admission');
    expect(mock.events).not.toContain('disclosure-review');
  }
);
test('rejects wrong stored proof before first review', async () => {
  mock.stored.provedTransaction.data = '0x1234';
  expect((await submit(options)).stage).toBe('history');
  expect(mock.events).not.toContain('journal-read');
});
test('binds original submitter before any disclosed work', async () => {
  mock.walletMetadata.address = '0x' + '98'.repeat(20);
  expect((await submit(options)).stage).toBe('history');
  expect(mock.events).not.toContain('disclosure-review');
  expect(mock.events).not.toContain('wallet-open');
});
test.each(['records', 'archive'])(
  'prior nullifier attempt in %s refuses before review/jobs',
  async (list) => {
    mock.history[list] = [
      {
        resolution: { status: 'reverted' },
        intent: {
          kind: 'railgun-transact',
          tree: 0,
          nullifier: mock.capsule.preparation.expected.nullifier,
        },
      },
    ];
    expect((await submit(options)).stage).toBe('prior-attempt');
    expect(mock.events).not.toContain('disclosure-review');
    expect(mock.events).not.toContain('C');
  }
);
test('unresolved other input blocks before review', async () => {
  mock.history.records = [{ intent: { kind: 'railgun-transact', tree: 0, nullifier: hex(100) } }];
  expect((await submit(options)).stage).toBe('prior-attempt');
  expect(mock.events).not.toContain('disclosure-review');
});
test('distinct resolved nullifier is not treated as replay', async () => {
  mock.history.archive = [
    {
      resolution: { status: 'reverted' },
      intent: { kind: 'railgun-transact', tree: 0, nullifier: hex(100) },
    },
  ];
  expect((await submit(options)).submissionStatus).toBe('acknowledged');
});
test.each([false, 'throw', 'abort'])(
  'first review %p performs no wallet/keyless/service work',
  async (mode) => {
    options.reviewDisclosures = async (summary, signal) => {
      expect(Object.isFrozen(summary.exposures.poi)).toBe(true);
      expect(summary.destinations.retainedSource).toContain('/secret-path');
      expect(signal.aborted).toBe(false);
      if (mode === 'throw') throw Error('private words');
      if (mode === 'abort') mock.caller.abort();
      return mode === 'abort';
    };
    const result = await submit(options);
    expect(result).toEqual({ status: 'recovery-required', stage: 'disclosure-review' });
    for (const event of [
      'wallet-open',
      'mirror-open',
      'source',
      'C',
      'poi-open',
      'network',
      'sign',
    ])
      expect(mock.events).not.toContain(event);
    expect(JSON.stringify(result)).not.toMatch(/secret-path|private words/);
  }
);
test('caller mutation of top-level options during awaited review cannot replace scope/proof target', async () => {
  mock.hooks['disclosure-review'] = () => {
    options.holdId = '9'.repeat(64);
    options.destination = {};
    options.reviewTransaction = () => {
      throw Error('replacement');
    };
  };
  expect((await submit(options)).submissionStatus).toBe('acknowledged');
  expect(mock.events).toContain('transaction-review');
});
test.each([
  'wallet-open',
  'wallet-close',
  'mirror-open',
  'mirror-close',
  'C',
  'creator-verify',
  'source-finish',
  'poi-acquire',
  'membership',
  'root',
  'preflight',
])('failure at %s yields no raw send and drains admitted work', async (stage) => {
  if (stage.startsWith('mirror') || stage === 'creator-verify' || stage === 'root')
    setup('railgun-partial-unshield', 'Transact');
  mock.failure = stage;
  const result = await submit(options);
  expect(result.status).toBe('recovery-required');
  expect(mock.events).not.toContain('broadcast');
  expect(mock.phase).toBeNull();
});
test('partial requires exact circuit observation before transaction network', async () => {
  mock.preflightOverride = { intentKind: 'railgun-private-transfer' };
  expect((await submit(options)).stage).toBe('preflight');
  expect(mock.events).not.toContain('network');
});
test.each(['Shield', 'Transact'])(
  'cold foreign transfer/%s reviews its signed destination, marker and POI linkage',
  async (type) => {
    setup('railgun-private-transfer', type);
    const destination = '0zk1' + 'p'.repeat(123);
    mock.capsule.selection.recipient = destination;
    mock.capsule.selection.recipientRelationship = 'foreign';
    mock.capsule.preparation.recipient = destination;
    const reviews = [];
    options.reviewTransaction = async (summary) => {
      reviews.push(summary);
      await mock.step('transaction-review');
      return true;
    };
    expect(await submit(options)).toEqual({
      transactionHash: hex(17),
      submissionStatus: 'acknowledged',
    });
    expect(mock.summary).toMatchObject({
      operation: 'railgun-private-transfer',
      recipient: destination,
      recipientRelationship: 'foreign',
    });
    expect(mock.summary.foreignOutputPoiDisclosure).toContain(
      "links the recipient's blinded output commitment to this spend"
    );
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      recipientRelationship: 'foreign',
      canonicalDestination: destination,
    });
  }
);
test('cold self transfer disclosure summary carries no relationship fields', async () => {
  setup('railgun-private-transfer');
  await submit(options);
  expect(mock.summary).not.toHaveProperty('recipientRelationship');
  expect(mock.summary).not.toHaveProperty('foreignOutputPoiDisclosure');
});
test('legacy refuses an observation claiming partial intent', async () => {
  setup('railgun-private-transfer');
  mock.preflightOverride = { intentKind: 'railgun-partial-unshield' };
  expect((await submit(options)).stage).toBe('preflight');
  expect(mock.events).not.toContain('network');
});
test.each(['id', 'type', 'hash', 'txid', 'nullifier'])(
  'genuine accessor %s mismatch refuses before eligibility',
  async (field) => {
    mock.owned.ownedRecord[field] = 'mismatch';
    expect((await submit(options)).stage).toBe('wallet');
    expect(mock.events).not.toContain('poi-acquire');
  }
);
test.each(['checkpoint', 'generation', 'public-generation', 'source-token'])(
  'changed %s refuses before raw send',
  async (choice) => {
    mock.hooks['transaction-review'] = () => {
      if (choice === 'checkpoint') mock.checkpoint.to.number++;
      if (choice === 'generation') mock.generation.id = '2'.repeat(64);
      if (choice === 'public-generation') mock.publicIdentity.generationId = '2'.repeat(64);
      if (choice === 'source-token') mock.tokenInvalid = true;
    };
    expect((await submit(options)).status).toBe('recovery-required');
    expect(mock.events).not.toContain('sign');
    expect(mock.events).not.toContain('broadcast');
  }
);
test('final snapshot must match the exact owned checkpoint', async () => {
  mock.checkpoint.digest = '9'.repeat(64);
  expect((await submit(options)).stage).toBe('source');
  expect(mock.events).not.toContain('C');
});
test('genuine source outcome survives caller cancellation', async () => {
  mock.sourceError = Error('private source text');
  mock.sourceOutcome = Object.freeze({ fatal: true, reason: 'rpc', rpcFailure: 'response' });
  mock.hooks.source = () => mock.caller.abort();
  const result = await submit(options);
  expect(result).toEqual({
    status: 'recovery-required',
    stage: 'source',
    sourceOutcome: mock.sourceOutcome,
  });
  expect(mock.events).not.toContain('C');
});
test('forged source error does not become authenticated outcome', async () => {
  mock.hooks.source = () => {
    throw Object.assign(Error('private source'), { fatal: true, reason: 'rpc' });
  };
  const result = await submit(options);
  expect(result).toEqual({ status: 'recovery-required', stage: 'source' });
  // Only the bounded stage and code, never the forged reason or message.
  expect(diagnosticOf(result)).toEqual({ stage: 'source', code: 'UNCLASSIFIED' });
});
test('cold preflight refusal keeps its bounded diagnostic outside the result shape', async () => {
  mock.preflight.acquire = async () => {
    throw Object.assign(Error('secret ' + hex(10) + ' /Users/someone'), {
      code: 'RAILGUN_PRIVATE_PREFLIGHT_REFUSED',
      reason: 'mismatch',
      step: 'nullifiers',
      causeCode: 'NOT_FOR_MISMATCH',
      payload: hex(11),
    });
  };
  const result = await submit(options);
  expect(result).toEqual({ status: 'recovery-required', stage: 'preflight' });
  expect(diagnosticOf(result)).toEqual({
    stage: 'preflight',
    substage: 'acquire',
    code: 'RAILGUN_PRIVATE_PREFLIGHT_REFUSED',
    reason: 'mismatch',
    step: 'nullifiers',
  });
  expect(mock.events).not.toContain('network');
});
test.each(['transactionIndex', 'blockNumber', 'transactionHash'])(
  'Transact creator %s mismatch refuses before C/list/root',
  async (field) => {
    setup('railgun-token-unshield', 'Transact');
    mock.creator.creator[field] = field === 'transactionHash' ? hex(99) : 99;
    expect((await submit(options)).stage).toBe('creator');
    for (const stage of ['C', 'poi-acquire', 'root']) expect(mock.events).not.toContain(stage);
  }
);
test.each([
  { pathVerified: false },
  { suppliedCreatorEventsMatched: false },
  { utilityExitObserved: false },
  { inputSha256: '9'.repeat(64) },
  { coverage: { matchedRows: 1, knownOmissions: 1 } },
])('Transact verifier mismatch %p refuses before owned query', async (override) => {
  setup('railgun-token-unshield', 'Transact');
  mock.creatorOverride = override;
  expect((await submit(options)).stage).toBe('creator');
  expect(mock.events).not.toContain('poi-acquire');
});
test.each([undefined, false, true])(
  'mixed creator final hash diagnostic %p must be true',
  async (value) => {
    setup('railgun-token-unshield', 'Transact');
    mock.noteWitness.witness.row.unshield = { npk: hex(20) };
    mock.creatorOverride = { unshieldCommitmentVerified: value };
    const result = await submit(options);
    if (value === true) expect(result.submissionStatus).toBe('acknowledged');
    else {
      expect(result.stage).toBe('creator');
      expect(mock.events).not.toContain('C');
    }
  }
);
test.each(['ShieldBlocked', 'ProofSubmitted', 'Missing'])(
  'POI diagnostic %s does not authorize send',
  async (status) => {
    mock.poiOverride = { statuses: [{ blindedCommitment: hex(16), type: 'Shield', status }] };
    expect((await submit(options)).stage).toBe('membership');
    expect(mock.events).not.toContain('network');
  }
);
test.each([{ rootsAccepted: false }, { membershipVerified: false }, { statuses: [] }])(
  'membership result %p refuses',
  async (override) => {
    mock.memberOverride = override;
    expect((await submit(options)).status).toBe('recovery-required');
    expect(mock.events).not.toContain('network');
  }
);
test('copied membership receipt refuses', async () => {
  mock.hooks.membership = () => {
    const receipt = mock.membership.receipt;
    Object.defineProperty(mock.membership, 'receipt', {
      get: (() => {
        let n = 0;
        return () => (++n === 1 ? { ...receipt } : receipt);
      })(),
    });
  };
  expect((await submit(options)).status).toBe('recovery-required');
  expect(mock.events).not.toContain('broadcast');
});
test('C then list age are not renewed at final review', async () => {
  jest.spyOn(performance, 'now').mockImplementation(() => mock.clock);
  mock.hooks['transaction-review'] = () => {
    mock.clock += 60000;
  };
  expect((await submit(options)).status).toBe('recovery-required');
  expect(mock.events).not.toContain('sign');
});
test('bounded remaining phase reserve refuses list admission after slow C', async () => {
  jest.spyOn(performance, 'now').mockImplementation(() => mock.clock);
  mock.hooks.C = () => {
    mock.clock += 130000;
  };
  expect((await submit(options)).status).toBe('recovery-required');
  expect(mock.events).not.toContain('poi-open');
});
test('review deadline is checked independently of delayed timer', async () => {
  jest.spyOn(performance, 'now').mockImplementation(() => mock.clock);
  mock.hooks['disclosure-review'] = () => {
    mock.clock += 30001;
  };
  expect((await submit(options)).stage).toBe('disclosure-review');
  expect(mock.events).not.toContain('wallet-open');
});
test.each(['entry', 'capsule'])(
  'held EOA signer followed by %s CAS drift exposes no signed bytes/raw send',
  async (target) => {
    const gate = deferred();
    mock.hooks.sign = () => gate.promise;
    const pending = submit(options);
    await until(() => mock.events.includes('sign'));
    if (target === 'entry') mock.entry.signing.changed = true;
    else {
      const original = mock.capsules.get;
      mock.capsules.get = async () => ({ ...(await original()), changed: true });
    }
    gate.resolve();
    expect((await pending).status).toBe('recovery-required');
    expect(mock.events).not.toContain('broadcast');
  }
);
test('denied final review never signs', async () => {
  options.reviewTransaction = async () => false;
  expect((await submit(options)).status).toBe('recovery-required');
  expect(mock.events).not.toContain('sign');
});
test.each([
  'wallet-open',
  'mirror-open',
  'disclosure-review',
  'transaction-review',
  'sign',
  'poi-acquire',
])('cancel held %s retains invocation and genuine admitted phase until drain', async (stage) => {
  if (stage === 'mirror-open') setup('railgun-token-unshield', 'Transact');
  const gate = deferred();
  mock.hooks[stage] = () => gate.promise;
  let settled = false;
  const pending = submit(options).then((v) => {
    settled = true;
    return v;
  });
  await until(() => mock.events.includes(stage));
  mock.caller.abort();
  await new Promise((r) => setImmediate(r));
  expect(settled).toBe(false);
  const next = { ...options, signal: new AbortController().signal };
  expect((await submit(next)).stage).toBe('admission');
  if (stage !== 'disclosure-review')
    expect(() => claimRailgunAccountPhase(mock.enrollment, 'recovery')).toThrow(/phase/i);
  gate.resolve();
  expect((await pending).status).toBe('recovery-required');
  expect(mock.events).not.toContain('broadcast');
  expect(mock.phase).toBeNull();
});
test('source.closed retains final recovery owner after refusal', async () => {
  mock.holdPoiClose = true;
  mock.failure = 'membership';
  let settled = false;
  const pending = submit(options).then((v) => {
    settled = true;
    return v;
  });
  await until(() => mock.events.includes('poi-close'));
  expect(settled).toBe(false);
  expect(() => claimRailgunAccountPhase(mock.enrollment, 'recovery')).toThrow(/phase/i);
  mock.poiDone.resolve();
  expect((await pending).stage).toBe('membership');
  expect(mock.phase).toBeNull();
});
test('borrowed ignored signer promise is drained even if service returns a refusal early', async () => {
  const gate = deferred();
  mock.hooks.sign = () => gate.promise;
  let signing;
  mock.send = async (params, signer, config) => {
    authorize(config.privacyContext, config.intent);
    signing = signer.signTransaction(params);
    signing.catch(() => {});
    await until(() => mock.events.includes('sign'));
    throw Error('service refusal');
  };
  let settled = false;
  const pending = submit(options).then((v) => {
    settled = true;
    return v;
  });
  await until(() => mock.events.includes('C-close'));
  expect(settled).toBe(false);
  expect(() => claimRailgunAccountPhase(mock.enrollment, 'recovery')).toThrow(/phase/i);
  gate.resolve();
  expect((await pending).status).toBe('recovery-required');
  await expect(signing).rejects.toThrow();
  expect(mock.phase).toBeNull();
});
test('acknowledgement survives cancellation at actual send completion', async () => {
  mock.hooks.broadcast = () => mock.caller.abort();
  const result = await submit(options);
  expect(result).toEqual({ transactionHash: hex(17), submissionStatus: 'acknowledged' });
  expect(mock.phase).toBeNull();
});
test('only actual matching journal attempt promotes uncertain thrown send hash', async () => {
  mock.attempts = [
    {
      hash: hex(18),
      intent: railgunTransactJournalIntent({ ...mock.stored.provedTransaction, from: mock.owner }),
    },
  ];
  mock.hooks.broadcast = () => {
    throw Object.assign(Error('lost reply'), { transactionHash: hex(18) });
  };
  expect(await submit(options)).toEqual({ transactionHash: hex(18), submissionStatus: 'unknown' });
});
test('unbound thrown transaction hash is not a recovered outcome', async () => {
  mock.attempts = [];
  mock.hooks.broadcast = () => {
    throw Object.assign(Error('private error'), { transactionHash: hex(18) });
  };
  const result = await submit(options);
  expect(result).toEqual({ status: 'recovery-required', stage: 'submission' });
  expect(JSON.stringify(result)).not.toContain(hex(18));
});
test('older C refuses review admission even when newly acquired list remains fresh', async () => {
  jest.spyOn(performance, 'now').mockImplementation(() => mock.clock);
  let delayed = false;
  mock.hooks['signed-read'] = () => {
    if (mock.proofAt !== undefined && !delayed) {
      delayed = true;
      mock.clock += 58000;
    }
  };
  mock.hooks['transaction-review'] = () => {
    mock.clock += 2001;
  };
  expect((await submit(options)).status).toBe('recovery-required');
  expect(mock.clock - mock.poiStarted).toBe(0);
  expect(mock.events).not.toContain('transaction-review');
  expect(mock.events).not.toContain('sign');
});
test('first review uses public metadata without borrowing EOA signer', async () => {
  options.reviewDisclosures = async () => {
    expect(mock.events).not.toContain('signer-address');
    return false;
  };
  expect((await submit(options)).stage).toBe('disclosure-review');
  expect(mock.events).not.toContain('signer-address');
});
test('changed actual signer after matching metadata refuses before EOA signing', async () => {
  mock.signer.getAddress = async () => '0x' + '98'.repeat(20);
  expect((await submit(options)).status).toBe('recovery-required');
  expect(mock.events).not.toContain('sign');
  expect(mock.events).not.toContain('broadcast');
});
test('changed public submitter metadata during final review refuses', async () => {
  mock.hooks['transaction-review'] = () => {
    mock.walletMetadata.address = '0x' + '98'.repeat(20);
  };
  expect((await submit(options)).status).toBe('recovery-required');
  expect(mock.events).not.toContain('sign');
});
test.each(['wallet-close', 'mirror-close', 'creator-verify', 'C', 'source-finish'])(
  'held %s cancellation awaits actual cleanup before releasing phase',
  async (stage) => {
    if (stage.startsWith('mirror') || stage === 'creator-verify')
      setup('railgun-token-unshield', 'Transact');
    const gate = deferred();
    let calls = 0;
    mock.hooks[stage] = () => (++calls === 1 ? gate.promise : undefined);
    let settled = false;
    const pending = submit(options).then((value) => {
      settled = true;
      return value;
    });
    await until(() => mock.events.includes(stage));
    mock.caller.abort();
    await new Promise((r) => setImmediate(r));
    try {
      expect(settled).toBe(false);
      expect(() => claimRailgunAccountPhase(mock.enrollment, 'recovery')).toThrow(/phase/i);
    } finally {
      gate.resolve();
    }
    expect((await pending).status).toBe('recovery-required');
    expect(mock.events).not.toContain('broadcast');
    expect(mock.phase).toBeNull();
  }
);
test('late competing attempt is refused by the real encrypted journal before raw admission', async () => {
  const fs = require('fs'),
    os = require('os'),
    path = require('path');
  const { createSubmissionJournal } = jest.requireActual('./private-submission-journal');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-submit-atomic-'));
  const handle = mock.scope.getContext({
    kind: 'public-address',
    principal: mock.owner,
    chainId: 11155111,
    role: 'transaction-rpc',
  });
  mock.realJournal = createSubmissionJournal({ handle, directory, key: Buffer.alloc(32, 7) });
  expect(await mock.realJournal.readSnapshot()).toEqual({ records: [], archive: [] });
  const intent = railgunTransactJournalIntent({
    ...mock.stored.provedTransaction,
    from: mock.owner,
  });
  mock.hooks['transaction-review'] = async () => {
    await mock.realJournal.begin(hex(90), 1, intent);
  };
  let refusal;
  mock.send = async (params, signer, config) => {
    const transaction = { ...params, gasPrice: '100', nonce: 1 };
    expect(await config.review({ from: mock.owner, transaction })).toBe(true);
    await signer.getAddress();
    await signer.signTransaction(transaction);
    authorize(config.privacyContext, config.intent);
    try {
      await mock.realJournal.begin(hex(91), 2, config.intent);
    } catch (error) {
      refusal = error;
      throw error;
    }
    mock.events.push('raw-send');
    return { transactionHash: hex(91), submissionStatus: 'acknowledged' };
  };
  expect((await submit(options)).status).toBe('recovery-required');
  expect(refusal).toMatchObject({ code: 'PRIVATE_RAILGUN_NULLIFIER_RESERVED' });
  expect(mock.events).not.toContain('raw-send');
  expect((await mock.realJournal.readSnapshot()).records.map((v) => v.hash)).toEqual([hex(90)]);
});

// Independent revocation leaves C and the other service authority current.
// Age-expiry alone cannot isolate these later-issued 60-second receipts from C.
test.each(['root', 'list'])(
  'independent final %s revocation during held review forbids signing',
  async (kind) => {
    setup('railgun-partial-unshield', 'Transact');
    jest.spyOn(performance, 'now').mockReturnValue(1000);
    const gate = deferred();
    mock.hooks['transaction-review'] = () => gate.promise;
    const pending = submit(options);
    await until(() => mock.events.includes('transaction-review'));
    expect(mock.events).toContain('root');
    expect(mock.events).toContain('membership');
    expect(mock.proofClosed).not.toBe(true);
    if (kind === 'root') mock.rootClosed = true;
    else mock.poiClosed = true;
    gate.resolve();
    expect((await pending).status).toBe('recovery-required');
    expect(mock.events).not.toContain('sign');
    expect(mock.events).not.toContain('broadcast');
    expect(mock.phase).toBeNull();
  }
);

// The callback checked the old checkpoint; the finally published genuine token
// must be joined independently before C or eligibility admission.
test.each(['digest', 'to'])(
  'published snapshot %s drift after callback success refuses before C',
  async (field) => {
    mock.hooks['source-finish'] = () => {
      if (field === 'digest') mock.checkpoint.digest = '9'.repeat(64);
      else mock.checkpoint.to = { number: 6000002, hash: hex(19) };
    };
    expect(await submit(options)).toEqual({ status: 'recovery-required', stage: 'source' });
    expect(mock.events).toContain('source-finish');
    expect(mock.events).not.toContain('C');
    expect(mock.events).not.toContain('poi-open');
    expect(mock.events).not.toContain('broadcast');
    expect(mock.phase).toBeNull();
  }
);

test.each(['preflight', 'eth_getBalance'])(
  'slow %s setup refuses the cold review before signature or durable attempt',
  async (stage) => {
    jest.spyOn(performance, 'now').mockImplementation(() => mock.clock);
    mock.hooks[stage] = () => {
      mock.clock += 10000;
    };
    expect((await submit(options)).status).toBe('recovery-required');
    expect(mock.events).toContain(stage);
    expect(mock.proofClosed).toBe(true); // Cleaned up, not a renewed C.
    expect(mock.events).not.toContain('transaction-review');
    expect(mock.events).not.toContain('sign');
    expect(mock.events).not.toContain('broadcast');
    expect(mock.events.filter((v) => v === 'C')).toHaveLength(1);
  }
);
test('cold review checks 50s on every genuine authority without resetting its service expiry', async () => {
  setup('railgun-partial-unshield', 'Transact');
  jest.spyOn(performance, 'now').mockImplementation(() => mock.clock);
  let wall = 1000000;
  jest.spyOn(Date, 'now').mockImplementation(() => wall);
  const advance = (ms) => {
    mock.clock += ms;
    wall += ms;
  };
  const gate = deferred();
  let request;
  mock.hooks.eth_getCode = () => advance(1000);
  options.reviewTransaction = async (value) => {
    request = value;
    mock.events.push('transaction-review');
    // The existing deadline began before EOA RPC, not at this display.
    expect(request.expiresAt).toBe(1030000);
    expect(request.expiresAt - Date.now()).toBe(29000);
    expect(mock.proofMargins).toContain(50000);
    expect(mock.preflightMargins).toContain(50000);
    await gate.promise;
    advance(25000);
    expect(Date.now()).toBeLessThan(request.expiresAt);
    return true;
  };
  mock.hooks.sign = () => {
    advance(1000);
    expect(Date.now()).toBeLessThan(request.expiresAt);
  };
  mock.hooks.broadcast = () => {
    // Model bounded journal/start-send work still within every original clock.
    advance(500);
    expect(Date.now()).toBeLessThan(request.expiresAt);
    authorize(
      mock.networkHandle,
      railgunTransactJournalIntent({ ...mock.stored.provedTransaction, from: mock.owner })
    );
  };
  const pending = submit(options);
  await until(() => mock.events.includes('transaction-review'));
  gate.resolve();
  expect(await pending).toEqual({ transactionHash: hex(17), submissionStatus: 'acknowledged' });
  expect(mock.events.filter((v) => v === 'C')).toHaveLength(1);
  expect(mock.events.indexOf('disclosure-review')).toBeLessThan(mock.events.indexOf('C'));
  expect(request.expiresAt).toBe(1030000);
});
test('late approval does not renew request.expiresAt even with current service authorities', async () => {
  let wall = 1000000;
  jest.spyOn(Date, 'now').mockImplementation(() => wall);
  options.reviewTransaction = async (request) => {
    expect(request.expiresAt).toBe(1030000);
    wall = request.expiresAt;
    return true;
  };
  expect((await submit(options)).status).toBe('recovery-required');
  expect(mock.events).not.toContain('sign');
  expect(mock.events).not.toContain('broadcast');
});

test.each([false, true])(
  'cold Transact verifier unknown=%s reaches recovery owner and preserves exclusion',
  async (unknown) => {
    setup('railgun-token-unshield', 'Transact');
    const gate = deferred();
    const error = Object.assign(Error('fixed verifier failure'), {
      code: unknown ? 'RAILGUN_NOTE_PROVENANCE_EXIT_UNOBSERVED' : 'RAILGUN_NOTE_PROVENANCE_REFUSED',
    });
    mock.quarantineThrows = true;
    mock.hooks['creator-verify'] = async () => {
      await gate.promise;
      throw error;
    };
    let settled = false;
    const work = submit(options).then((v) => {
      settled = true;
      return v;
    });
    await until(() => mock.events.includes('creator-verify'));
    expect(settled).toBe(false);
    expect(() => claimRailgunAccountPhase(mock.enrollment, 'recovery')).toThrow();
    gate.resolve();
    expect((await work).status).toBe('recovery-required');
    expect(mock.events).not.toContain('broadcast');
    if (unknown) {
      expect(mock.quarantined).toBe(true);
      expect(mock.recoveryCallbackError).toBe(error);
      expect(() => claimRailgunAccountPhase(mock.enrollment, 'recovery')).toThrow();
      const before = [...mock.events];
      expect((await submit(options)).status).toBe('recovery-required');
      expect(mock.events).toEqual(before);
    } else {
      expect(mock.quarantined).not.toBe(true);
      expect(mock.recoveryCallbackError).toBeUndefined();
      claimRailgunAccountPhase(mock.enrollment, 'recovery').release();
    }
  }
);
