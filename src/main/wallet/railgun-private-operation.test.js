let mock, mockStep, mockSign;
jest.mock('../networks/private-rpc', () => ({
  createPrivateRpc: (handle, role, options) => {
    mock.protocolAdmission = { handle, role, options };
    if (options.destinationConstraint !== mock.constraints?.protocol) throw Error('constraint');
    return { assertActive() {}, release() {} };
  },
}));
jest.mock('./railgun-transact-staging', () => ({
  assertRailgunTransactStagingAvailable: (receipt) => {
    if (!mock.staging || receipt !== mock.staging.receipt || mock.staging.consumed)
      throw Error('staging');
    mockStep('staging-available');
    return {
      signal: mock.staging.controller.signal,
      evidence: { bindings: { archive: '/engine.asar' } },
    };
  },
}));
jest.mock('./railgun-transact-provenance', () => ({
  openRailgunTransactProvenance: async ({ signal }) => {
    mockStep('provenance-open');
    if (mock.provenanceOriginal) return mock.provenanceOriginal;
    if (mock.staging.consumed) throw Error('consumed');
    mock.staging.consumed = true;
    signal.addEventListener('abort', () => mock.provenanceController.abort(), { once: true });
    if (signal.aborted) mock.provenanceController.abort();
    return mock.provenance;
  },
  assertRailgunTransactProvenance: (operation, receipt, account, owners, window, margin) => {
    mockStep('provenance-check');
    if (
      operation !== mock.provenance ||
      receipt !== mock.provenanceReceipt ||
      account !== mock.account ||
      owners.identity !== mock.identity ||
      window !== mock.window ||
      mock.provenance.signal.aborted ||
      mock.provenanceExpired ||
      margin !== 20000
    )
      throw Error('provenance');
    return mock.provenanceValue;
  },
}));
jest.mock('./railgun-account-wallet', () => ({
  readRailgunAccountOwnedNotes: () => mock.owned,
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
    mockStep('A-start');
    mock.windowLive = true;
    try {
      const response = await operation.onIntent(
        mock.offer,
        mock.scope.signal,
        mock.window,
        mock.capsule
      );
      // Match account-wallet's real checks immediately after the awaited
      // onIntent callback, including time spent draining its resources.
      if (!mock.windowLive || mock.scope.signal.aborted || performance.now() >= mock.data.deadline)
        throw Error('window post-callback refused');
      mockStep('A-response');
      if (response.status !== 'signed') return { operation: { status: 'refused' } };
      mockStep('A-proof');
      return {
        preparation: mock.offer,
        operation: { status: 'proved', transaction: mock.offer.transaction },
      };
    } catch (error) {
      mock.callbackFailure = error;
      throw error;
    } finally {
      mock.windowLive = false;
      mockStep('A-exit');
    }
  },
}));
jest.mock('./railgun-identity', () => ({
  assertRailgunIdentity: (v) => {
    if (v !== mock.identity || v.signal.aborted) throw Error('identity');
  },
  assertRailgunPrivateSigner: (token) => {
    if (token !== mock.signerToken || !mock.signerLive) throw Error('B');
  },
  signRailgunPrivateIntent: (...args) => mockSign(...args),
}));
jest.mock('./railgun-engine-runtime', () => ({ verifyRailgunEngineRuntime: (v) => v }));
jest.mock('./railgun-private-receive', () => ({
  verifyRailgunPrivateReceiver: async (options) => {
    mock.receiverOptions = options;
    mockStep('R');
    await mock.receiverPause;
    return (
      mock.receiverValue ?? {
        transactionDigest: mock.offer.transactionDigest,
        recipientVerified: true,
      }
    );
  },
}));
jest.mock('./railgun-account-poi', () => ({
  openRailgunPrivateWindowPoi: () => {
    mockStep('POI-open');
    return mock.poi;
  },
  assertRailgunPrivateWindowPoi: () => {
    mockStep('POI-check');
    if (mock.poiClosed) throw Error('POI');
    return mock.poiValue;
  },
}));
jest.mock('./railgun-private-preflight', () => ({
  createRailgunPrivatePreflight: (options) => {
    mock.preflightOptions = options;
    mockStep('preflight-open');
    return mock.preflight;
  },
  assertRailgunPrivatePreflight: () => {
    mockStep('preflight-check');
    if (mock.preflightClosed) throw Error('preflight');
    return mock.preflightValue;
  },
}));
jest.mock('./railgun-private-proof', () => ({
  verifyRailgunPrivateProof: async () => {
    mockStep('C');
    if (mock.windowLive) throw Error('A still live');
    return mock.proof;
  },
  assertRailgunPrivateProof: (receipt) => {
    mockStep('C-check');
    if (receipt !== mock.proof.receipt) throw Error('proof');
  },
}));
jest.mock('./signers', () => ({
  getSigner: (index) => {
    if (index !== 0) throw Error('index');
    return {
      getAddress: async () => mock.owner,
      signTransaction() {
        throw Error('no submission');
      },
    };
  },
}));
jest.mock('./private-transaction-network', () => ({
  getPrivateTransactionNetwork: (_handle, options) => {
    mock.networkOptions = options;
    mockStep('network');
    return {
      assertCanSubmit: async () => mockStep('journal'),
      request: async (_chain, method) => {
        mockStep(method);
        return { result: method === 'eth_getCode' ? '0x' : mock.balance };
      },
    };
  },
}));
const { createPrivacyScope } = require('../networks/privacy-context');
const {
  proveRailgunAccountPrivateOperation: prove,
  consumeRailgunPrivateSigningPermit: consume,
  claimRailgunPrivateCompletion: claim,
} = require('./railgun-private-operation');
const fixture = require('../../../scripts/fixtures/railgun-capsule-data');
const { normalizeRailgunPrivateOffer } = require('./railgun-private-preparation');
let options;
beforeEach(() => {
  mock = {
    events: [],
    failure: null,
    window: {},
    signerToken: {},
    windowLive: false,
    signerLive: false,
    balance: '0x100000000000000',
    scope: createPrivacyScope({
      profileId: 'operation-unit',
      signal: new AbortController().signal,
    }),
  };
  mockStep = (name) => {
    mock.events.push(name);
    mock.onStep?.(name);
    if (mock.failure === name) throw Error('fixture');
  };
  mock.capsule = fixture.capsule('1'.repeat(64));
  mock.capsule.engineSha256 = require('./railgun-engine-manifest.json').sha256;
  mock.offer = normalizeRailgunPrivateOffer(mock.capsule.preparation, mock.capsule.selection);
  mock.owner = mock.capsule.selection.recipient;
  mock.identity = { signal: mock.scope.signal, descriptor: { walletId: mock.capsule.walletId } };
  mock.account = { signal: mock.scope.signal };
  mock.coordinator = { signal: mock.scope.signal };
  const input = fixture.facts(mock.capsule);
  mock.owned = {
    checkpointHash: input.checkpointHash,
    ownedPoi: [{ id: '0:1', type: 'Shield', nullifier: input.nullifier, hash: input.noteHash }],
    read: {
      instanceId: 'self',
      readiness: { to: { number: 10 } },
      received: [
        {
          id: '0:1',
          tree: 0,
          position: 1,
          spentTxid: false,
          amount: 1000n,
          asset: { __type: 'erc20', contract: require('./railgun-shield-pins.json').wrappedNative },
        },
      ],
    },
  };
  mock.data = {
    owned: mock.owned,
    selection: mock.capsule.selection,
    deadline: performance.now() + 175000,
  };
  mock.held = {};
  mock.signed = {};
  mock.holdId = 'a'.repeat(64);
  mock.reservations = {
    signal: mock.scope.signal,
    assertAvailable: async () => mockStep('available'),
    reserve: async (facts) => {
      mock.reservedFacts = facts;
      mockStep('reserve');
      return mock.held;
    },
    assertReceipt: async (v) => {
      mockStep('hold-check');
      return {
        id: mock.holdId,
        state: v === mock.signed ? 'signing' : 'held',
        signing: mock.evidence,
      };
    },
    assertReceiptContext: (v, kind) => {
      if (v !== mock.signed || kind !== 'operation') throw Error('origin');
    },
    abandon: async () => mockStep('abandon'),
  };
  mock.capsules = {
    signal: mock.scope.signal,
    inspect: async () => {
      mockStep('capacity');
      return { records: 0, capacity: 32 };
    },
    put: async (_receipt, capsule, authorizationDigest) => {
      mockStep('put');
      mock.stored = {
        capsule,
        capsuleDigest: require('./railgun-private-capsule').digestRailgunPrivateCapsule(capsule),
        authorizationDigest,
      };
    },
    markSigning: async (_receipt, evidence) => {
      mockStep('mark');
      mock.evidence = evidence;
      return mock.signed;
    },
    get: async () => {
      mockStep('capsule-check');
      return mock.stored;
    },
    saveSignature: async (_receipt, signature) => {
      mockStep('save-signature');
      mock.stored.signature = signature;
    },
    saveProvedTransaction: async (_receipt, transaction) => {
      mockStep('save-proof');
      mock.stored.provedTransaction = transaction;
    },
  };
  mock.enrollment = {
    signal: mock.scope.signal,
    descriptor: mock.identity.descriptor,
    getContext: (role) =>
      mock.scope.getContext({
        kind: 'private-account',
        principal: 'railgun:0',
        protocol: 'railgun',
        deployment: 'sepolia',
        chainId: 11155111,
        role,
      }),
    openReservations: async () => {
      mockStep('open-reservations');
      return mock.reservations;
    },
    openPrivateCapsules: async () => mock.capsules,
  };
  mock.poiValue = {
    statuses: [{ status: 'Valid' }],
    membershipVerified: true,
    rootsAccepted: true,
    publicThrough: { number: 10, hash: '0x' + '1'.repeat(64) },
    input: {
      id: '0:1',
      nullifier: input.nullifier,
      noteHash: input.noteHash,
      checkpointHash: input.checkpointHash,
      type: 'Shield',
    },
  };
  mock.preflightValue = {
    inputUnspent: true,
    input: {
      tree: 0,
      merkleRoot: mock.offer.expected.merkleRoot,
      nullifier: input.nullifier,
      checkpointHash: input.checkpointHash,
      minimumBlock: 10,
    },
  };
  const poiClosed = new Promise((resolve) => {
    mock.poiExit = resolve;
  });
  mock.poi = {
    closed: poiClosed,
    acquire: async () => {
      mockStep('POI');
      return { status: mock.poiRefused ? 'refused' : 'verified', receipt: {} };
    },
    close: () => {
      mock.poiClosed = true;
      if (!mock.holdPoi) mock.poiExit();
    },
  };
  mock.preflight = {
    acquire: async () => {
      mockStep('preflight');
      return { receipt: {} };
    },
    close: () => {
      mock.preflightClosed = true;
    },
  };
  mock.proof = {
    receipt: {},
    close: () => {
      mock.proofClosed = true;
    },
  };
  mockSign = async (args) => {
    mockStep('B-validate');
    mock.signerLive = true;
    try {
      const permit = await args.onKeyRequest(
        { transactionDigest: mock.offer.transactionDigest, expectedHash: mock.offer.expectedHash },
        mock.signerToken
      );
      expect(() => consume({}, mock.identity, mock.signerToken)).toThrow();
      expect(() => consume(permit, {}, mock.signerToken)).toThrow();
      expect(() => consume(permit, mock.identity, {})).toThrow();
      const gate = consume(permit, mock.identity, mock.signerToken);
      mock.lastPermit = permit;
      mock.lastGate = gate;
      expect(() => consume(permit, mock.identity, mock.signerToken)).toThrow();
      await gate.assertCurrent();
      mockStep('derive');
      await gate.assertCurrent();
      mockStep('key');
      return {
        signature: { R8: ['0x' + '1'.repeat(64), '0x' + '2'.repeat(64)], S: '0x' + '3'.repeat(64) },
      };
    } finally {
      mock.signerLive = false;
      mock.events.push('B-exit');
    }
  };
  options = {
    account: mock.account,
    owners: { identity: mock.identity, enrollment: mock.enrollment, coordinator: mock.coordinator },
    request: { kind: mock.capsule.selection.kind, noteId: '0:1', recipient: mock.owner },
    archive: '/engine.asar',
    proverArchive: '/prover.asar',
    artifactDirectory: '/artifacts',
  };
});
afterEach(() => {
  mock.poiExit();
  mock.scope.close();
  jest.useRealTimers();
});
function enableTransact() {
  mock.owned.ownedPoi[0].type = 'Transact';
  mock.poiValue.input.type = 'Transact';
  mock.staging = { receipt: {}, consumed: false, controller: new AbortController() };
  options.stagingReceipt = mock.staging.receipt;
  mock.provenanceController = new AbortController();
  mock.provenanceReceipt = {};
  mock.provenanceValue = Object.freeze({
    transactionDigest: mock.offer.transactionDigest,
    checkpointHash: mock.owned.checkpointHash,
    spendingEnabled: false,
  });
  mock.provenance = {
    signal: mock.provenanceController.signal,
    acquireRoot: async ({ timeoutMs }) => {
      expect(timeoutMs).toBeGreaterThan(0);
      expect(timeoutMs).toBeLessThanOrEqual(20000);
      mockStep('root');
      await mock.rootPause;
      return { receipt: mock.provenanceReceipt };
    },
    close: jest.fn(async () => {
      mockStep('provenance-close');
      mock.provenanceController.abort();
      await mock.provenanceDrain;
    }),
  };
}
test('unknown operation kind refuses before owned reads', async () => {
  const owned = mock.owned;
  const readOwned = jest.fn(() => owned);
  Object.defineProperty(mock, 'owned', { get: readOwned });
  const result = await prove({
    ...options,
    request: { ...options.request, kind: 'railgun-unknown', unshieldAmount: '500' },
  });
  expect(result).toEqual({ status: 'refused', stage: 'local' });
  expect(readOwned).not.toHaveBeenCalled();
  expect(mock.events).toEqual([]);
});

test('durability, one-use key permission, B/A exits and C precede a saved proof and completion', async () => {
  await expect(prove(options)).resolves.toMatchObject({
    status: 'proved',
    holdId: mock.holdId,
    submissionEnabled: false,
  });
  const order = [
    'available',
    'capacity',
    'journal',
    'POI',
    'preflight',
    'B-validate',
    'reserve',
    'put',
    'mark',
    'derive',
    'key',
    'B-exit',
    'save-signature',
    'A-proof',
    'A-exit',
    'C',
    'save-proof',
  ];
  expect(mock.events.filter((v) => order.includes(v))).toEqual(order);
  expect(mock.events).not.toContain('abandon');
  expect(mock.evidence.submitter).toBe(mock.owner);
  expect(mock.proofClosed && mock.poiClosed && mock.preflightClosed).toBe(true);
});
test('completion cannot be forged, moved to another owner or claimed twice', async () => {
  const result = await prove(options);
  expect(() => claim({}, mock.identity, mock.enrollment)).toThrow();
  expect(() => claim(result.completion.receipt, {}, mock.enrollment)).toThrow();
  expect(() => claim(result.completion.receipt, mock.identity, {})).toThrow();
  const claimed = claim(result.completion.receipt, mock.identity, mock.enrollment);
  const evidence = claimed.assertCurrent();
  expect(evidence.stored.provedTransaction).toEqual(mock.offer.transaction);
  expect(evidence.entry.signing.submitter).toBe(mock.owner);
  expect(Object.isFrozen(evidence.stored.capsule.preparation.expected)).toBe(true);
  mock.stored.provedTransaction = {};
  expect(claimed.assertCurrent().stored.provedTransaction).toEqual(mock.offer.transaction);
  expect(() => claim(result.completion.receipt, mock.identity, mock.enrollment)).toThrow();
  claimed.close();
  expect(() => claimed.assertCurrent()).toThrow();
});
test('completion survives wallet closure but is revoked by identity/enrollment closure', async () => {
  const wallet = new AbortController();
  mock.account.signal = wallet.signal;
  const result = await prove(options);
  wallet.abort();
  const claimed = claim(result.completion.receipt, mock.identity, mock.enrollment);
  expect(claimed.assertCurrent().entry.id).toBe(mock.holdId);
  mock.scope.close();
  expect(() => claimed.assertCurrent()).toThrow();
});
test('completion expires even after claiming', async () => {
  jest.useFakeTimers();
  try {
    mock.data.deadline = performance.now() + 175000;
    const result = await prove(options);
    const claimed = claim(result.completion.receipt, mock.identity, mock.enrollment);
    await jest.advanceTimersByTimeAsync(120000);
    expect(() => claimed.assertCurrent()).toThrow();
  } finally {
    jest.useRealTimers();
  }
});
test.each(['identity', 'enrollment', 'reservations', 'capsules'])(
  'independent %s closure revokes completion',
  async (owner) => {
    const controller = new AbortController();
    mock[owner].signal = controller.signal;
    const result = await prove(options);
    const claimed = claim(result.completion.receipt, mock.identity, mock.enrollment);
    expect(claimed.signal.aborted).toBe(false);
    controller.abort();
    expect(claimed.signal.aborted).toBe(true);
    expect(() => claimed.assertCurrent()).toThrow();
  }
);
test('proof readback mismatch retains signing hold without issuing completion', async () => {
  mock.capsules.saveProvedTransaction = async () => {
    mock.stored.provedTransaction = { ...mock.offer.transaction, data: '0x' };
  };
  const result = await prove(options);
  expect(result.status).toBe('signed-unfinished');
  expect(result.completion).toBeUndefined();
  expect(mock.events).not.toContain('abandon');
});
test('Transact input refuses before local stores, network or key', async () => {
  mock.owned.ownedPoi[0].type = 'Transact';
  await expect(prove(options)).resolves.toEqual({ status: 'refused', stage: 'input-provenance' });
  expect(mock.events).toEqual([]);
});
test('Transact input composes provenance/root after POI/preflight and rechecks it through derivation', async () => {
  enableTransact();
  const result = await prove(options);
  expect(result.status).toBe('proved');
  const order = [
    'staging-available',
    'open-reservations',
    'provenance-open',
    'POI',
    'preflight',
    'root',
    'B-validate',
    'reserve',
    'put',
    'mark',
    'derive',
    'key',
    'provenance-close',
    'A-exit',
    'C',
  ];
  expect(mock.events.filter((name) => order.includes(name))).toEqual(order);
  expect(mock.events.filter((name) => name === 'provenance-check').length).toBeGreaterThan(8);
  expect(mock.provenance.close).toHaveBeenCalledTimes(1);
  const before = [...mock.events];
  expect(await prove(options)).toEqual({ status: 'refused', stage: 'input-provenance' });
  expect(mock.events).toEqual(before);
});
test.each(['forged', 'consumed', 'shield-with-staging'])(
  '%s staging refuses before storage or network',
  async (mode) => {
    enableTransact();
    if (mode === 'forged') options.stagingReceipt = {};
    if (mode === 'consumed') mock.staging.consumed = true;
    if (mode === 'shield-with-staging') mock.owned.ownedPoi[0].type = 'Shield';
    expect(await prove(options)).toEqual({ status: 'refused', stage: 'input-provenance' });
    expect(mock.events).toEqual([]);
  }
);
test.each(['digest', 'checkpoint'])(
  'changed provenance %s refuses before B or reservation',
  async (field) => {
    enableTransact();
    mock.provenanceValue = Object.freeze({
      ...mock.provenanceValue,
      [field === 'digest' ? 'transactionDigest' : 'checkpointHash']: 'changed',
    });
    expect((await prove(options)).status).toBe('refused');
    expect(mock.events).not.toContain('B-validate');
    expect(mock.events).not.toContain('reserve');
  }
);
test.each(['reserve', 'put', 'mark', 'derive'])(
  'root expiry at %s prevents key release and preserves signing uncertainty',
  async (at) => {
    enableTransact();
    mock.onStep = (name) => {
      if (name === at) mock.provenanceExpired = true;
    };
    const result = await prove(options);
    const uncertain = ['mark', 'derive'].includes(at);
    expect(result.status).toBe(uncertain ? 'signed-unfinished' : 'refused');
    expect(mock.events).not.toContain('key');
    expect(mock.events.includes('abandon')).toBe(!uncertain);
  }
);
test('POI expiring during root acquisition refuses before B', async () => {
  enableTransact();
  mock.onStep = (name) => {
    if (name === 'root') mock.poiClosed = true;
  };
  expect((await prove(options)).status).toBe('refused');
  expect(mock.events).not.toContain('B-validate');
  expect(mock.events).not.toContain('reserve');
});
test.each(['staging', 'provenance'])(
  '%s cancellation during POI closes its transport and drains before releasing the controller',
  async (which) => {
    enableTransact();
    let entered, release, drain;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    mock.provenanceDrain = new Promise((resolve) => {
      drain = resolve;
    });
    mock.poi.acquire = () =>
      new Promise((resolve) => {
        entered();
        release = resolve;
      });
    const pending = prove(options);
    await started;
    (which === 'staging' ? mock.staging.controller : mock.provenanceController).abort();
    expect(mock.poiClosed).toBe(true);
    release({ status: 'verified', receipt: {} });
    for (let n = 0; n < 8; n++) await Promise.resolve();
    expect(mock.provenance.close).toHaveBeenCalled();
    expect(await prove(options)).toEqual({ status: 'refused', stage: 'local' });
    drain();
    expect((await pending).status).toBe('refused');
    expect(mock.events).not.toContain('preflight');
    expect(mock.events).not.toContain('key');
  }
);
test('unshield to an address other than the submitting vault EOA refuses before network', async () => {
  mock.owner = '0x' + '34'.repeat(20);
  expect((await prove(options)).status).toBe('refused');
  expect(mock.events).not.toContain('network');
});
test('negative POI never queries the input nullifier or creates a hold', async () => {
  mock.poiRefused = true;
  expect((await prove(options)).status).toBe('refused');
  expect(mock.events).not.toContain('preflight');
  expect(mock.events).not.toContain('reserve');
});
test.each([
  'available',
  'capacity',
  'journal',
  'eth_getBalance',
  'POI',
  'preflight',
  'B-validate',
  'reserve',
  'put',
])('%s failure releases no key and only abandons known never-signing holds', async (failure) => {
  mock.failure = failure;
  expect((await prove(options)).status).toBe('refused');
  expect(mock.events).not.toContain('key');
  expect(mock.events.includes('abandon')).toBe(failure === 'put');
});
test.each([
  'mark',
  'capsule-check',
  'derive',
  'key',
  'save-signature',
  'A-proof',
  'C',
  'save-proof',
])('%s failure conservatively preserves the signing hold for recovery', async (failure) => {
  mock.failure = failure;
  expect((await prove(options)).status).toBe('signed-unfinished');
  expect(mock.events).not.toContain('abandon');
  if (['mark', 'capsule-check', 'derive'].includes(failure))
    expect(mock.events).not.toContain('key');
  if (failure === 'save-signature') expect(mock.events).not.toContain('A-proof');
  if (failure === 'C') expect(mock.events).not.toContain('save-proof');
});
test('late window refuses before reserve and key', async () => {
  mock.data.deadline = performance.now() + 10000;
  expect((await prove(options)).status).toBe('refused');
  expect(mock.events).not.toContain('reserve');
});

test.each(['reserve', 'put'])(
  'margin expiring after %s abandons the never-signing hold',
  async (at) => {
    mock.onStep = (name) => {
      if (name === at) mock.data.deadline = performance.now() + 100;
    };
    const result = await prove(options);
    expect(result.status).toBe('refused');
    expect(mock.events).toContain('abandon');
    expect(mock.events).not.toContain('mark');
    expect(mock.events).not.toContain('key');
  }
);
test('B dying during markSigning preserves the hold and cannot obtain a key', async () => {
  mock.onStep = (name) => {
    if (name === 'mark') mock.signerLive = false;
  };
  expect((await prove(options)).status).toBe('signed-unfinished');
  expect(mock.events).not.toContain('derive');
  expect(mock.events).not.toContain('abandon');
});
test.each(['poi', 'preflight'])('mismatched %s input refuses before reserving', async (which) => {
  if (which === 'poi') mock.poiValue.input.nullifier = 'different';
  else mock.preflightValue.input.minimumBlock = 9;
  expect((await prove(options)).stage).toBe(which);
  expect(mock.events).not.toContain('reserve');
});
test('B validated digest must match the registered intent', async () => {
  mockSign = async (args) => {
    mock.signerLive = true;
    return args.onKeyRequest(
      { transactionDigest: 'wrong', expectedHash: mock.offer.expectedHash },
      mock.signerToken
    );
  };
  expect((await prove(options)).stage).toBe('signer');
  expect(mock.events).not.toContain('reserve');
});
test('insufficient test gas balance refuses before POI', async () => {
  mock.balance = '0x0';
  expect((await prove(options)).stage).toBe('submitter');
  expect(mock.events).not.toContain('POI');
});
test('concurrent controller is refused while the first waits in its live window', async () => {
  let entered, release;
  const started = new Promise((r) => {
    entered = r;
  });
  const paused = new Promise((r) => {
    release = r;
  });
  const original = mock.poi.acquire;
  mock.poi.acquire = async (...args) => {
    entered();
    await paused;
    return original(...args);
  };
  const pending = prove(options);
  await started;
  expect(await prove(options)).toEqual({ status: 'refused', stage: 'local' });
  release();
  expect((await pending).status).toBe('proved');
  expect(mock.events.filter((v) => v === 'key')).toHaveLength(1);
});
test('preflight timeout closes it but the operation waits until acquisition drains', async () => {
  jest.useFakeTimers();
  mock.data.deadline = performance.now() + 175000;
  let entered, finishClose, release;
  const started = new Promise((r) => {
    entered = r;
  });
  const closed = new Promise((r) => {
    finishClose = r;
  });
  const drained = new Promise((r) => {
    release = r;
  });
  mock.preflight.acquire = async () => {
    entered();
    await closed;
    await drained;
    throw Error('timeout');
  };
  mock.preflight.close = () => {
    mock.preflightClosed = true;
    finishClose();
  };
  let settled = false;
  const pending = prove(options).then((v) => {
    settled = true;
    return v;
  });
  await started;
  await jest.advanceTimersByTimeAsync(20001);
  expect(mock.preflightClosed).toBe(true);
  expect(settled).toBe(false);
  release();
  expect((await pending).stage).toBe('preflight');
  expect(mock.events).not.toContain('reserve');
  jest.useRealTimers();
});

const operationGate = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const operationTurn = () => new Promise((resolve) => setImmediate(resolve));
function holdPoiClosure() {
  const entered = operationGate();
  mock.holdPoi = true;
  const close = mock.poi.close;
  mock.poi.close = () => {
    close();
    entered.resolve();
  };
  return entered;
}
test.each([false, true])(
  'POI drain holds the A callback after signed/refused work, refused=%s',
  async (refused) => {
    mock.poiRefused = refused;
    const entered = holdPoiClosure();
    let settled = false;
    const pending = prove(options).then((value) => {
      settled = true;
      return value;
    });
    await entered.promise;
    try {
      expect(mock.poiClosed).toBe(true);
      expect(mock.windowLive).toBe(true);
      await operationTurn();
      expect(settled).toBe(false);
      expect(mock.events).not.toContain('A-response');
      expect(mock.events).not.toContain('C');
      expect(await prove(options)).toEqual({ status: 'refused', stage: 'local' });
      if (!refused) {
        expect(mock.stored.signature).toBeDefined();
        expect(mock.preflightClosed).toBe(true);
        mock.signerLive = true;
        expect(() => consume(mock.lastPermit, mock.identity, mock.signerToken)).toThrow();
        await expect(mock.lastGate.assertCurrent()).rejects.toThrow();
        mock.signerLive = false;
      }
      mock.poiExit();
      expect((await pending).status).toBe(refused ? 'refused' : 'proved');
    } finally {
      mock.poiExit();
      await pending;
    }
  }
);
test.each(['poi-first', 'provenance-first'])(
  'both close requests start promptly and both drains hold A in %s order',
  async (order) => {
    enableTransact();
    const entered = holdPoiClosure(),
      provenance = operationGate();
    mock.provenanceDrain = provenance.promise;
    let settled = false;
    const pending = prove(options).then((value) => {
      settled = true;
      return value;
    });
    await entered.promise;
    try {
      await operationTurn();
      expect(mock.provenance.close).toHaveBeenCalled();
      expect(mock.provenance.signal.aborted).toBe(true);
      expect(mock.preflightClosed).toBe(true);
      expect(mock.windowLive).toBe(true);
      if (order === 'poi-first') mock.poiExit();
      else provenance.resolve();
      await operationTurn();
      expect(settled).toBe(false);
      expect(mock.events).not.toContain('A-proof');
      expect(mock.events).not.toContain('C');
      expect(await prove(options)).toEqual({ status: 'refused', stage: 'local' });
      if (order === 'poi-first') provenance.resolve();
      else mock.poiExit();
      expect((await pending).status).toBe('proved');
    } finally {
      provenance.resolve();
      mock.poiExit();
      await pending;
    }
  }
);
test('post-signature POI drain crossing the actual A window deadline retains signed-unfinished state', async () => {
  jest.useFakeTimers();
  mock.data.deadline = performance.now() + 175000;
  const entered = holdPoiClosure();
  let settled = false;
  const pending = prove(options).then((value) => {
    settled = true;
    return value;
  });
  await entered.promise;
  try {
    expect(mock.stored.signature).toBeDefined();
    expect(mock.events.filter((x) => x === 'key')).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(175001);
    expect(settled).toBe(false);
    expect(mock.windowLive).toBe(true);
    expect(mock.events).not.toContain('A-proof');
    expect(mock.events).not.toContain('abandon');
    mock.poiExit();
    const result = await pending;
    expect(result).toMatchObject({ status: 'signed-unfinished', holdId: mock.holdId });
    expect(result.completion).toBeUndefined();
    expect(mock.stored.signature).toBeDefined();
    expect(mock.stored.capsule).toBeDefined();
    expect(mock.events).not.toContain('save-proof');
    expect(mock.events).not.toContain('abandon');
    expect(mock.windowLive).toBe(false);
    // Preserve the real reservation contract: a durable signing hold blocks
    // another operation, rather than the original fixture's always-free stub.
    mock.reservations.assertAvailable = async () => {
      throw Error('signing hold retained');
    };
    expect((await prove(options)).status).toBe('refused');
    expect(mock.events.filter((x) => x === 'key')).toHaveLength(1);
  } finally {
    mock.poiExit();
    await pending;
  }
});
test.each(['poi', 'preflight', 'provenance-throw', 'provenance-reject'])(
  'post-signature %s cleanup failure waits all other drains and retains signed state',
  async (failure) => {
    enableTransact();
    const entered = holdPoiClosure(),
      provenance = operationGate();
    mock.provenanceDrain = provenance.promise;
    if (failure === 'poi') {
      const close = mock.poi.close;
      mock.poi.close = () => {
        close();
        throw Error('PRIVATE POI close');
      };
    }
    if (failure === 'preflight')
      mock.preflight.close = () => {
        mock.preflightClosed = true;
        throw Error('PRIVATE preflight close');
      };
    if (failure === 'provenance-throw')
      mock.provenance.close.mockImplementation(() => {
        mock.provenanceController.abort();
        throw Error('PRIVATE provenance close');
      });
    if (failure === 'provenance-reject')
      mock.provenance.close.mockImplementation(async () => {
        mock.provenanceController.abort();
        await provenance.promise;
        throw Error('PRIVATE provenance rejection');
      });
    let settled = false;
    const pending = prove(options).then((value) => {
      settled = true;
      return value;
    });
    await entered.promise;
    try {
      await operationTurn();
      expect(mock.provenance.close).toHaveBeenCalled();
      expect(mock.preflightClosed).toBe(true);
      expect(mock.stored.signature).toBeDefined();
      expect(settled).toBe(false);
      expect(mock.events).not.toContain('A-proof');
      provenance.resolve();
      await operationTurn();
      expect(settled).toBe(false);
      mock.poiExit();
      const result = await pending;
      expect(result.status).toBe('signed-unfinished');
      expect(result.holdId).toBe(mock.holdId);
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
      expect(mock.events).not.toContain('abandon');
      expect(mock.events).not.toContain('C');
    } finally {
      provenance.resolve();
      mock.poiExit();
      await pending;
    }
  }
);
test('simultaneous POI close throw and provenance rejection cannot skip remaining POI drain', async () => {
  enableTransact();
  const entered = holdPoiClosure();
  const close = mock.poi.close;
  mock.poi.close = () => {
    close();
    throw Error('PRIVATE POI');
  };
  mock.provenance.close.mockImplementation(async () => {
    mock.provenanceController.abort();
    throw Error('PRIVATE provenance');
  });
  let settled = false;
  const pending = prove(options).then((value) => {
    settled = true;
    return value;
  });
  await entered.promise;
  try {
    await operationTurn();
    expect(mock.provenance.close).toHaveBeenCalled();
    expect(mock.preflightClosed).toBe(true);
    expect(settled).toBe(false);
    expect(mock.windowLive).toBe(true);
    expect(mock.stored.signature).toBeDefined();
    mock.poiExit();
    const result = await pending;
    expect(result.status).toBe('signed-unfinished');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(mock.events).not.toContain('abandon');
    expect(mock.events).not.toContain('C');
  } finally {
    mock.poiExit();
    await pending;
  }
});
test('abort-listener POI close exception is contained and cannot skip preflight closure/drain', async () => {
  const entered = operationGate(),
    release = operationGate();
  mock.holdPoi = true;
  mock.preflight.acquire = async () => {
    entered.resolve();
    await release.promise;
    throw Error('cancelled');
  };
  const close = mock.poi.close;
  mock.poi.close = () => {
    close();
    throw Error('PRIVATE listener');
  };
  let settled = false;
  const pending = prove(options).then((value) => {
    settled = true;
    return value;
  });
  await entered.promise;
  try {
    expect(() => mock.scope.close()).not.toThrow();
    await operationTurn();
    expect(mock.poiClosed).toBe(true);
    expect(mock.preflightClosed).toBe(true);
    release.resolve();
    await operationTurn();
    expect(settled).toBe(false);
    mock.poiExit();
    expect((await pending).status).toBe('refused');
    expect(mock.events).not.toContain('reserve');
    expect(mock.events).not.toContain('key');
  } finally {
    release.resolve();
    mock.poiExit();
    await pending;
  }
});
test.each(['missing', 'rejected'])(
  'invalid POI %s barrier never admits key work or success',
  async (mode) => {
    if (mode === 'missing') delete mock.poi.closed;
    else mock.poi.closed = Promise.reject(Error('PRIVATE invalid POI closed'));
    if (mode === 'rejected') mock.poi.closed.catch(() => {});
    const result = await prove(options);
    expect(result.status).toBe('refused');
    expect(result.completion).toBeUndefined();
    expect(mock.events).not.toContain('key');
    expect(mock.events).not.toContain('reserve');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  }
);

test('reviewed constraints reach early protocol admission, EOA, preflight and private completion only', async () => {
  mock.constraints = { protocol: Object.freeze({}), transaction: Object.freeze({}) };
  const result = await prove({ ...options, destinationConstraints: mock.constraints });
  expect(result.status).toBe('proved');
  expect(mock.protocolAdmission.role).toBe('protocol-rpc');
  expect(mock.protocolAdmission.options.destinationConstraint).toBe(mock.constraints.protocol);
  expect(mock.preflightOptions.destinationConstraint).toBe(mock.constraints.protocol);
  expect(mock.networkOptions.destinationConstraint).toBe(mock.constraints.transaction);
  const claimed = claim(
    result.completion.receipt,
    options.owners.identity,
    options.owners.enrollment
  );
  expect(claimed.destinationConstraints.protocol).toBe(mock.constraints.protocol);
  expect(claimed.destinationConstraints.transaction).toBe(mock.constraints.transaction);
  expect(Object.isFrozen(claimed.destinationConstraints)).toBe(true);
  expect(claimed.assertCurrent()).not.toHaveProperty('destinationConstraints');
  claimed.close();
});
test.each([
  {},
  { protocol: {} },
  { protocol: {}, transaction: undefined },
  { protocol: {}, transaction: {}, injected: true },
])(
  'incomplete constraint pair refuses before stores or disclosures',
  async (destinationConstraints) => {
    expect((await prove({ ...options, destinationConstraints })).status).toBe('refused');
    expect(mock.events).not.toContain('POI');
    expect(mock.events).not.toContain('available');
  }
);
test('forged protocol constraint refuses before owned-note POI and key', async () => {
  mock.constraints = { protocol: {}, transaction: {} };
  const result = await prove({
    ...options,
    destinationConstraints: { protocol: {}, transaction: mock.constraints.transaction },
  });
  expect(result.status).toBe('refused');
  expect(mock.events).not.toContain('POI');
  expect(mock.events).not.toContain('key');
});

function enablePartial() {
  mock.capsule =
    require('../../../scripts/fixtures/railgun-partial-capsule-data').createRailgunPartialCapsuleData().capsule;
  mock.capsule.engineSha256 = require('./railgun-engine-manifest.json').sha256;
  mock.offer = normalizeRailgunPrivateOffer(mock.capsule.preparation, mock.capsule.selection);
  mock.owner = mock.capsule.selection.recipient;
  mock.identity.descriptor.walletId = mock.capsule.walletId;
  mock.identity.descriptor.instanceId = '0zk1' + 'q'.repeat(123);
  mock.data.selection = mock.capsule.selection;
  const selected = mock.owned.ownedPoi[0];
  selected.nullifier = mock.offer.expected.nullifier;
  selected.hash = mock.capsule.noteHash;
  mock.poiValue.input.nullifier = selected.nullifier;
  mock.poiValue.input.noteHash = selected.hash;
  mock.preflightValue.input.nullifier = selected.nullifier;
  mock.preflightValue.input.merkleRoot = mock.offer.expected.merkleRoot;
  mock.preflightValue.intentKind = 'railgun-partial-unshield';
  mock.receiverValue = {
    transactionDigest: mock.offer.transactionDigest,
    recipientVerified: true,
    recipient: mock.identity.descriptor.instanceId,
    inputAmount: mock.offer.inputAmount,
    unshieldAmount: mock.offer.unshieldAmount,
    changeAmount: mock.offer.changeAmount,
  };
  options.request = {
    kind: 'railgun-partial-unshield',
    noteId: '0:1',
    recipient: mock.owner,
    unshieldAmount: mock.offer.unshieldAmount,
  };
}
test.each(['Shield', 'Transact'])(
  'partial %s input traverses real orchestration and existing durable key ordering',
  async (type) => {
    enablePartial();
    if (type === 'Transact') enableTransact();
    const result = await prove(options);
    expect(result).toMatchObject({ status: 'proved', submissionEnabled: false });
    expect(mock.receiverOptions).toMatchObject({
      recipient: mock.identity.descriptor.instanceId,
      inputAmount: '1000',
      expected: mock.offer.expected,
    });
    expect(mock.receiverOptions).not.toHaveProperty('amount');
    expect(mock.receiverOptions).not.toHaveProperty('changeAmount');
    expect(mock.preflightOptions.intentKind).toBe('railgun-partial-unshield');
    expect(mock.reservedFacts.kind).toBe('railgun-partial-unshield');
    const order = [
      'R',
      'POI',
      'preflight',
      'reserve',
      'put',
      'mark',
      'key',
      'save-signature',
      'A-proof',
      'A-exit',
      'C',
      'save-proof',
    ];
    for (let i = 1; i < order.length; i++)
      expect(mock.events.indexOf(order[i])).toBeGreaterThan(mock.events.indexOf(order[i - 1]));
    expect(mock.events.filter((v) => v === 'key')).toHaveLength(1);
    expect(mock.stored.capsule.version).toBe(2);
  }
);
test.each([
  'recipient',
  'transactionDigest',
  'inputAmount',
  'unshieldAmount',
  'changeAmount',
  'recipientVerified',
])('partial receiver %s mismatch refuses before POI, preflight or reservation', async (key) => {
  enablePartial();
  mock.receiverValue[key] = key === 'recipientVerified' ? false : 'changed';
  expect(await prove(options)).toMatchObject({ status: 'refused', stage: 'receiver' });
  for (const event of ['POI-open', 'preflight-open', 'reserve', 'key'])
    expect(mock.events).not.toContain(event);
});
test('partial public recipient mismatch refuses before A or receive work', async () => {
  enablePartial();
  mock.owner = '0x' + '45'.repeat(20);
  expect((await prove(options)).status).toBe('refused');
  for (const event of ['A-start', 'R', 'POI-open', 'reserve', 'key'])
    expect(mock.events).not.toContain(event);
});
test.each(['missing', 'wrong', 'late-missing', 'late-wrong', 'legacy-extra'])(
  'preflight exact conditional kind guard refuses %s before reserve or key',
  async (fault) => {
    if (fault !== 'legacy-extra') enablePartial();
    const change = () => {
      if (fault.includes('missing')) delete mock.preflightValue.intentKind;
      else mock.preflightValue.intentKind = 'railgun-private-transfer';
    };
    if (fault.startsWith('late'))
      mock.onStep = (step) => {
        if (step === 'B-validate') change();
      };
    else change();
    expect((await prove(options)).status).toBe('refused');
    expect(mock.events).not.toContain('reserve');
    expect(mock.events).not.toContain('key');
  }
);
test.each(['reserve', 'put', 'mark', 'save-signature', 'A-proof', 'C', 'save-proof'])(
  'partial failure at %s preserves existing conservative durable semantics',
  async (step) => {
    enablePartial();
    mock.failure = step;
    const result = await prove(options);
    expect(result.status).toBe(['reserve', 'put'].includes(step) ? 'refused' : 'signed-unfinished');
    if (['mark', 'save-signature', 'A-proof', 'C', 'save-proof'].includes(step))
      expect(mock.events).not.toContain('abandon');
    expect(mock.events.filter((v) => v === 'key').length).toBeLessThanOrEqual(1);
  }
);

test('partial cancellation while independent receive is pending drains it and admits no POI or key', async () => {
  enablePartial();
  let release;
  mock.receiverPause = new Promise((resolve) => {
    release = resolve;
  });
  let settled = false;
  const work = prove(options).finally(() => {
    settled = true;
  });
  while (!mock.events.includes('R')) await new Promise((resolve) => setImmediate(resolve));
  mock.scope.close();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(settled).toBe(false);
  release();
  expect((await work).status).toBe('refused');
  for (const event of ['POI-open', 'reserve', 'key']) expect(mock.events).not.toContain(event);
});

test.each([true, false])(
  'fixed provenance original reaches account callback as unknown=%s without releasing early',
  async (unknown) => {
    enableTransact();
    let rejectOriginal;
    mock.provenanceOriginal = new Promise((_resolve, reject) => {
      rejectOriginal = reject;
    });
    let settled = false;
    const work = prove(options).then((result) => {
      settled = true;
      return result;
    });
    await operationTurn();
    expect(mock.events).toContain('provenance-open');
    expect(mock.windowLive).toBe(true);
    expect(settled).toBe(false);
    expect(mock.events).not.toContain('A-exit');
    const failure = Object.assign(Error('fixed provenance refusal'), {
      code: unknown ? 'RAILGUN_NOTE_PROVENANCE_EXIT_UNOBSERVED' : 'RAILGUN_NOTE_PROVENANCE_REFUSED',
    });
    rejectOriginal(failure);
    expect((await work).status).toBe('refused');
    if (unknown) {
      expect(mock.callbackFailure).toBe(failure);
      expect(mock.events).not.toContain('A-response');
    } else {
      expect(mock.callbackFailure).toBeUndefined();
      expect(mock.events).toContain('A-response');
    }
    expect(mock.events).toContain('A-exit');
    expect(mock.events).not.toContain('key');
  }
);

test('unknown provenance failure survives another throwing close and waits the original POI drain', async () => {
  enableTransact();
  const entered = holdPoiClosure();
  const failure = Object.assign(Error('unknown provenance child'), {
    code: 'RAILGUN_NOTE_PROVENANCE_EXIT_UNOBSERVED',
  });
  mock.provenance.acquireRoot = async () => {
    throw failure;
  };
  mock.provenance.close.mockImplementation(() => {
    throw Error('cleanup failure');
  });
  let settled = false;
  const work = prove(options).then((result) => {
    settled = true;
    return result;
  });
  await entered.promise;
  await operationTurn();
  expect(mock.provenance.close).toHaveBeenCalled();
  expect(settled).toBe(false);
  expect(mock.windowLive).toBe(true);
  expect(mock.callbackFailure).toBeUndefined();
  mock.poiExit();
  expect((await work).status).toBe('refused');
  expect(mock.callbackFailure).toBe(failure);
  expect(mock.events).not.toContain('A-response');
});

const FOREIGN = '0zk1' + 'p'.repeat(123);
function enableForeign() {
  mock.capsule =
    require('../../../scripts/fixtures/railgun-partial-capsule-data').createRailgunLegacyCapsuleData(
      'railgun-private-transfer'
    ).capsule;
  mock.capsule.engineSha256 = require('./railgun-engine-manifest.json').sha256;
  mock.capsule.selection.recipient = FOREIGN;
  mock.capsule.selection.recipientRelationship = 'foreign';
  mock.capsule.preparation.recipient = FOREIGN;
  mock.offer = normalizeRailgunPrivateOffer(mock.capsule.preparation, mock.capsule.selection);
  mock.owner = '0x' + '45'.repeat(20);
  mock.identity.descriptor.walletId = mock.capsule.walletId;
  mock.identity.descriptor.instanceId = mock.owned.read.instanceId;
  mock.data.selection = mock.capsule.selection;
  const selected = mock.owned.ownedPoi[0];
  selected.nullifier = mock.offer.expected.nullifier;
  selected.hash = mock.capsule.noteHash;
  mock.poiValue.input.nullifier = selected.nullifier;
  mock.poiValue.input.noteHash = selected.hash;
  mock.preflightValue.input.nullifier = selected.nullifier;
  mock.preflightValue.input.merkleRoot = mock.offer.expected.merkleRoot;
  mock.receiverValue = {
    transactionDigest: mock.offer.transactionDigest,
    recipientVerified: true,
    recipient: FOREIGN,
    recipientRelationship: 'foreign',
    amount: '1000',
  };
  options.request = { kind: 'railgun-private-transfer', noteId: '0:1', recipient: FOREIGN };
}
test.each(['Shield', 'Transact'])(
  'foreign %s input binds the marked destination and sent-output result into signing',
  async (type) => {
    enableForeign();
    if (type === 'Transact') enableTransact();
    const result = await prove(options);
    expect(result).toMatchObject({ status: 'proved', submissionEnabled: false });
    expect(mock.receiverOptions).toMatchObject({
      recipient: FOREIGN,
      recipientRelationship: 'foreign',
      amount: '1000',
      expected: mock.offer.expected,
    });
    expect(mock.receiverOptions).not.toHaveProperty('inputAmount');
    expect(mock.stored.capsule.version).toBe(1);
    expect(mock.stored.capsule.selection).toEqual({
      kind: 'railgun-private-transfer',
      tree: 0,
      position: 1,
      recipient: FOREIGN,
      recipientRelationship: 'foreign',
    });
    expect(mock.reservedFacts.kind).toBe('railgun-private-transfer');
    // The verified foreign receiver result is an input of the durable gates digest.
    const { digestRailgunPrivateCapsule } = require('./railgun-private-capsule');
    const authorization = require('crypto')
      .createHash('sha256')
      .update('freedom:railgun:private-gates-v1\0')
      .update(
        JSON.stringify({
          operation: type === 'Transact' ? 'transact-input-private-v1' : 'shield-input-private-v1',
          submitter: mock.owner,
          capsuleDigest: digestRailgunPrivateCapsule(mock.capsule),
          checkpointHash: mock.owned.checkpointHash,
          receiver: mock.receiverValue,
          poi: mock.poiValue,
          preflight: mock.preflightValue,
          signer: {
            transactionDigest: mock.offer.transactionDigest,
            expectedHash: mock.offer.expectedHash,
          },
          ...(type === 'Transact' ? { provenance: mock.provenanceValue } : {}),
        })
      )
      .digest('hex');
    expect(mock.stored.authorizationDigest).toBe(authorization);
    const order = ['R', 'POI', 'preflight', 'reserve', 'put', 'mark', 'key', 'save-signature'];
    for (let i = 1; i < order.length; i++)
      expect(mock.events.indexOf(order[i])).toBeGreaterThan(mock.events.indexOf(order[i - 1]));
  }
);
test.each([
  ['missing marker', (v) => delete v.recipientRelationship],
  ['self marker', (v) => (v.recipientRelationship = 'self')],
  ['other destination', (v) => (v.recipient = '0zk1' + 'r'.repeat(123))],
  ['own destination', (v) => (v.recipient = mock.owned.read.instanceId)],
  ['unverified', (v) => (v.recipientVerified = false)],
])('foreign receiver result with %s refuses before POI, reservation or key', async (_l, change) => {
  enableForeign();
  change(mock.receiverValue);
  expect(await prove(options)).toMatchObject({ status: 'refused', stage: 'receiver' });
  for (const event of ['POI-open', 'preflight-open', 'reserve', 'key'])
    expect(mock.events).not.toContain(event);
});
test('a utility capsule without the reviewed foreign marker cannot reach the receiver', async () => {
  enableForeign();
  delete mock.capsule.selection.recipientRelationship;
  expect((await prove(options)).status).toBe('refused');
  for (const event of ['R', 'POI-open', 'reserve', 'key']) expect(mock.events).not.toContain(event);
});
test('a malformed foreign destination refuses before network, A or receive work', async () => {
  enableForeign();
  options.request = { ...options.request, recipient: '0zk1' + 'P'.repeat(123) };
  expect(await prove(options)).toEqual({ status: 'refused', stage: 'local' });
  expect(mock.events).toEqual([]);
});
