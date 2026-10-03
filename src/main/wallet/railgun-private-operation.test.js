let mock, mockStep, mockSign;
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
      mockStep('A-response');
      if (response.status !== 'signed') return { operation: { status: 'refused' } };
      mockStep('A-proof');
      return {
        preparation: mock.offer,
        operation: { status: 'proved', transaction: mock.offer.transaction },
      };
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
  verifyRailgunPrivateReceiver: async () => {
    mockStep('R');
    return { transactionDigest: mock.offer.transactionDigest, recipientVerified: true };
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
  createRailgunPrivatePreflight: () => {
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
  getPrivateTransactionNetwork: () => {
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
    reserve: async () => {
      mockStep('reserve');
      return mock.held;
    },
    assertReceipt: async (v) => {
      mockStep('hold-check');
      return { id: mock.holdId, state: v === mock.signed ? 'signing' : 'held', signing: mock.evidence };
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
  mock.poi = {
    acquire: async () => {
      mockStep('POI');
      return { status: mock.poiRefused ? 'refused' : 'verified', receipt: {} };
    },
    close: () => {
      mock.poiClosed = true;
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
afterEach(() => mock.scope.close());
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
