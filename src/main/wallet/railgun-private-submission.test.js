let mock;
jest.mock('./railgun-private-operation', () => ({
  claimRailgunPrivateCompletion: (receipt, identity, enrollment) => {
    if (
      receipt !== mock.receipt ||
      identity !== mock.identity ||
      enrollment !== mock.enrollment ||
      mock.claimed
    )
      throw Error('completion');
    mock.claimed = true;
    return mock.claim;
  },
}));
jest.mock('./railgun-private-proof', () => ({
  verifyRailgunPrivateProof: async (input) => {
    mock.proofInput = input;
    mock.step('C');
    return mock.proof;
  },
  assertRailgunPrivateProof: (_receipt, _enrollment, _evidence, margin = 0) => {
    mock.proofMargins.push(margin);
    if (mock.proofClosed) throw Error('C');
  },
}));
jest.mock('./railgun-private-preflight', () => ({
  createRailgunPrivatePreflight: (options) => {
    const { input, destinationConstraint, intentKind } = options;
    // The warm path carries no recovered review budget.
    mock.preflightDeadline = Object.hasOwn(options, 'disclosureDeadline');
    mock.preflightKind = intentKind;
    mock.preflightConstraint = destinationConstraint;
    mock.step('preflight-open');
    mock.preflightInput = input;
    return mock.preflight;
  },
  assertRailgunPrivatePreflight: () => {
    if (mock.preflightClosed) throw Error('preflight');
    return mock.observed;
  },
}));
jest.mock('./signers', () => ({ getSigner: () => mock.signer }));
jest.mock('./private-transaction-network', () => ({
  getPrivateTransactionNetwork: (_handle, options) => {
    mock.networkOptions = options;
    return mock.networkConstructor(_handle, options);
  },
}));
jest.mock('./transaction-service', () => ({
  signAndSendTransaction: (...args) => mock.send(...args),
}));
const { createPrivacyScope } = require('../networks/privacy-context');
const { fixture } = require('../../../scripts/fixtures/railgun-transact-data');
const { extractRailgunTransactIntent } = require('./railgun-transact-intent');
const {
  submitRailgunPrivateTransaction: submit,
  assertRailgunPrivateSubmission: authorize,
} = require('./railgun-private-submission');
let options;
beforeEach(() => {
  const f = fixture(),
    tx = f.transaction(),
    parsed = extractRailgunTransactIntent(tx);
  delete tx.from;
  mock = {
    receipt: {},
    identity: {},
    claimed: false,
    events: [],
    proofMargins: [],
    scope: createPrivacyScope({
      profileId: 'submission-unit',
      signal: new AbortController().signal,
    }),
  };
  mock.networkConstructor = jest.fn(() => mock.network);
  mock.step = (stage) => {
    mock.events.push(stage);
    if (mock.failure === stage) throw Error(stage);
  };
  mock.owner = f.transaction().from;
  mock.snapshot = {
    minimumBlock: 10,
    entry: {
      id: 'a'.repeat(64),
      state: 'signing',
      signing: { submitter: mock.owner },
      facts: {
        intentDigest: parsed.intentDigest,
        nullifier: parsed.expected.nullifier,
        checkpointHash: 'b'.repeat(64),
      },
    },
    stored: {
      capsule: {
        version: 1,
        selection: { kind: parsed.expected.kind, tree: 0 },
        preparation: { transaction: parsed.intent, expected: parsed.expected },
      },
      provedTransaction: tx,
    },
  };
  mock.claim = {
    signal: mock.scope.signal,
    close: () => {
      mock.claimClosed = true;
    },
    assertCurrent: () => {
      if (mock.claimClosed) throw Error('closed');
      return mock.snapshot;
    },
  };
  mock.records = [{ receipt: {}, entry: JSON.parse(JSON.stringify(mock.snapshot.entry)) }];
  mock.reservations = {
    withSigningRecovery: async (use) => {
      mock.step('recovery');
      mock.phase = true;
      try {
        const result = await use(mock.records, {
          signal: mock.scope.signal,
          assertCurrent: () => {
            if (!mock.phase) throw Error('phase');
          },
        });
        mock.step('phase-end');
        return result;
      } finally {
        mock.phase = false;
      }
    },
    assertReceiptContext: (_receipt, kind) => {
      if (!mock.phase || kind !== 'recovery') throw Error('phase');
    },
    assertReceipt: async () => {
      mock.step('attest-hold');
      return mock.records[0].entry;
    },
  };
  mock.stored = JSON.parse(JSON.stringify(mock.snapshot.stored));
  mock.enrollment = {
    openReservations: async () => mock.reservations,
    openPrivateCapsules: async () => ({
      get: async () => {
        mock.step('attest-capsule');
        return mock.stored;
      },
    }),
    getContext: () =>
      mock.scope.getContext({
        kind: 'private-account',
        principal: 'railgun:0',
        protocol: 'railgun',
        deployment: 'sepolia',
        chainId: 11155111,
        role: 'engine',
      }),
  };
  mock.proof = {
    receipt: {},
    signal: mock.scope.signal,
    close: () => {
      mock.proofClosed = true;
    },
  };
  mock.preflight = {
    signal: mock.scope.signal,
    close: () => {
      mock.preflightClosed = true;
    },
    acquire: async () => {
      mock.step('preflight');
      mock.observed = {
        input: mock.preflightInput,
        ...(mock.preflightKind ? { intentKind: mock.preflightKind } : {}),
        ...mock.observationOverride,
      };
      return { receipt: {} };
    },
  };
  mock.signer = { getAddress: async () => mock.owner, signTransaction() {} };
  mock.network = {
    assertCanSubmit: async () => mock.step('journal'),
    request: async (_chain, method) => {
      mock.step(method);
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
  };
  mock.send = async (params, signer, config) => {
    mock.step('transaction-service');
    mock.handle = config.privacyContext;
    mock.intent = config.intent;
    authorize(mock.handle, mock.intent);
    const transaction = { ...params, gasPrice: '100', nonce: 1 };
    if (!(await config.review({ from: mock.owner, transaction }))) throw Error('review');
    await signer.getAddress();
    await signer.signTransaction(transaction);
    authorize(mock.handle, mock.intent);
    mock.step('broadcast');
    return { hash: '0x' + 'c'.repeat(64) };
  };
  options = {
    identity: mock.identity,
    enrollment: mock.enrollment,
    completion: mock.receipt,
    proverArchive: '/prover',
    artifactDirectory: '/artifacts',
    gasLimit: 100000n,
    maxGasFee: 10000000n,
    review: async () => true,
  };
});
afterEach(() => mock.scope.close());
test('claims internally, reattests under exclusion, verifies C then preflight before one EOA attempt', async () => {
  expect(await submit(options)).toEqual({ hash: '0x' + 'c'.repeat(64) });
  const ordered = [
    'recovery',
    'C',
    'preflight',
    'journal',
    'eth_estimateGas',
    'eth_call',
    'transaction-service',
    'broadcast',
    'phase-end',
  ];
  expect(mock.events.filter((v) => ordered.includes(v))).toEqual(ordered);
  expect(mock.preflightInput.minimumBlock).toBe(10);
  expect(mock.preflightDeadline).toBe(false);
  expect(() => authorize(mock.handle, mock.intent)).toThrow();
  expect((await submit(options)).status).toBe('recovery-required');
  expect(mock.events.filter((v) => v === 'broadcast')).toHaveLength(1);
});
test('final review names the signed foreign destination from the durable capsule only', async () => {
  const destination = '0zk1' + 'p'.repeat(123);
  for (const capsule of [mock.snapshot.stored.capsule, mock.stored.capsule])
    Object.assign(capsule.selection, { recipient: destination, recipientRelationship: 'foreign' });
  const reviews = [];
  options.review = async (request) => {
    reviews.push(request);
    return true;
  };
  expect(await submit(options)).toEqual({ hash: '0x' + 'c'.repeat(64) });
  expect(reviews).toHaveLength(1);
  expect(reviews[0]).toMatchObject({
    operation: 'railgun-private-transfer',
    recipientRelationship: 'foreign',
    canonicalDestination: destination,
  });
  expect(Object.isFrozen(reviews[0])).toBe(true);
});
test('self-transfer final review carries no relationship fields', async () => {
  const reviews = [];
  options.review = async (request) => {
    reviews.push(request);
    return true;
  };
  await submit(options);
  expect(reviews[0]).not.toHaveProperty('recipientRelationship');
  expect(reviews[0]).not.toHaveProperty('canonicalDestination');
});
test('unbranded completion refuses before stores, proof or network', async () => {
  expect(await submit({ ...options, completion: mock.claim })).toEqual({
    status: 'recovery-required',
    stage: 'completion',
  });
  expect(mock.events).toEqual([]);
  expect(() => authorize({}, {})).toThrow();
});
test.each(['entry', 'capsule'])('changed %s refuses before C or network', async (which) => {
  if (which === 'entry') mock.records[0].entry.signing.submitter = '0x' + '56'.repeat(20);
  else mock.stored.provedTransaction.data = '0x';
  expect((await submit(options)).status).toBe('recovery-required');
  expect(mock.events).not.toContain('C');
});
test.each(['C', 'preflight', 'journal', 'eth_estimateGas', 'eth_call'])(
  '%s refusal sends nothing and drains phase',
  async (at) => {
    mock.failure = at;
    expect((await submit(options)).status).toBe('recovery-required');
    expect(mock.events).not.toContain('broadcast');
    expect(mock.phase).toBe(false);
  }
);
test('review mutation of durable data refuses before broadcast', async () => {
  options.review = async () => {
    mock.stored.provedTransaction.data = '0x';
    return true;
  };
  expect((await submit(options)).status).toBe('recovery-required');
  expect(mock.events).not.toContain('broadcast');
});
test('claim expiry in review revokes the EOA scope', async () => {
  options.review = async () => {
    mock.claimClosed = true;
    return true;
  };
  expect((await submit(options)).status).toBe('recovery-required');
  expect(mock.events).not.toContain('broadcast');
});
test.each([false, true])(
  'late phase failure preserves an acknowledged hash (partial=%s)',
  async (partial) => {
    if (partial) configurePartialSubmission();
    mock.failure = 'phase-end';
    expect(await submit(options)).toEqual({ hash: '0x' + 'c'.repeat(64) });
  }
);
test('unknown submission hash is retained and never automatically retried', async () => {
  mock.network.listSubmissions = async () => [
    {
      hash: '0x' + 'd'.repeat(64),
      intent: require('./railgun-transact-intent').railgunTransactJournalIntent({
        ...mock.snapshot.stored.provedTransaction,
        from: mock.owner,
      }),
    },
  ];
  mock.send = async () => {
    throw Object.assign(Error('uncertain'), { transactionHash: '0x' + 'd'.repeat(64) });
  };
  expect(await submit(options)).toEqual({
    transactionHash: '0x' + 'd'.repeat(64),
    submissionStatus: 'unknown',
  });
  expect((await submit(options)).status).toBe('recovery-required');
});
test('fabricated review error hash cannot claim a journaled attempt', async () => {
  options.review = async () => {
    throw Object.assign(Error('fake'), {
      code: 'PRIVATE_BROADCAST_UNCERTAIN',
      transactionHash: '0x' + 'e'.repeat(64),
    });
  };
  mock.network.listSubmissions = jest.fn(async () => []);
  expect(await submit(options)).toEqual({ status: 'recovery-required', stage: 'submission' });
  expect(mock.network.listSubmissions).not.toHaveBeenCalled();
  expect(mock.events).not.toContain('broadcast');
});
test('transaction-service hash without matching durable intent is not promoted', async () => {
  mock.send = async () => {
    throw Object.assign(Error('fake'), { transactionHash: '0x' + 'e'.repeat(64) });
  };
  mock.network.listSubmissions = async () => [{ hash: '0x' + 'e'.repeat(64), intent: {} }];
  expect(await submit(options)).toEqual({ status: 'recovery-required', stage: 'submission' });
});
test.each([false, true])(
  'cancellation drains pending review before releasing the recovery phase (partial=%s)',
  async (partial) => {
    if (partial) configurePartialSubmission();
    let enter, release, rejectService;
    const entered = new Promise((resolve) => {
      enter = resolve;
    });
    const paused = new Promise((resolve) => {
      release = resolve;
    });
    options.review = async () => {
      enter();
      await paused;
      return true;
    };
    mock.send = (params, _signer, config) => {
      const pending = config.review({
        from: mock.owner,
        transaction: { ...params, gasPrice: '100', nonce: 1 },
      });
      pending.catch(() => {});
      return new Promise((_resolve, reject) => {
        rejectService = reject;
      });
    };
    let settled = false;
    const pending = submit(options).then((value) => {
      settled = true;
      return value;
    });
    await entered;
    rejectService(Error('cancelled'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(mock.phase).toBe(true);
    release();
    expect((await pending).status).toBe('recovery-required');
    expect(mock.phase).toBe(false);
    expect(mock.events).not.toContain('broadcast');
  }
);
test.each([false, true])(
  'cancellation drains a pending EOA signer and prevents another signing attempt (partial=%s)',
  async (partial) => {
    if (partial) configurePartialSubmission();
    let enter, release, rejectService, second;
    const entered = new Promise((resolve) => {
      enter = resolve;
    });
    const paused = new Promise((resolve) => {
      release = resolve;
    });
    mock.signer.signTransaction = async () => {
      enter();
      await paused;
      return 'signed';
    };
    mock.send = (params, signer) => {
      signer.signTransaction(params).catch(() => {});
      second = signer.signTransaction(params);
      second.catch(() => {});
      return new Promise((_resolve, reject) => {
        rejectService = reject;
      });
    };
    let settled = false;
    const pending = submit(options).then((value) => {
      settled = true;
      return value;
    });
    await entered;
    await expect(second).rejects.toThrow();
    rejectService(Error('cancelled'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(mock.phase).toBe(true);
    release();
    expect((await pending).status).toBe('recovery-required');
    expect(mock.phase).toBe(false);
  }
);

test.each([false, true])(
  'submission inherits constrained completion and ignores caller attempt to replace restrictions (partial=%s)',
  async (partial) => {
    if (partial) configurePartialSubmission();
    const constraints = Object.freeze({
      protocol: Object.freeze({}),
      transaction: Object.freeze({}),
    });
    mock.claim.destinationConstraints = constraints;
    expect(
      await submit({ ...options, destinationConstraints: { protocol: {}, transaction: {} } })
    ).toEqual({ hash: '0x' + 'c'.repeat(64) });
    expect(mock.preflightConstraint).toBe(constraints.protocol);
    expect(mock.networkOptions.destinationConstraint).toBe(constraints.transaction);
  }
);

// The completion registry is mocked; the v2 bytes pass the real capsule normalizer.
test.each(['partial-v1', 'partial-v3', 'unknown-kind', 'legacy-v2'])(
  'unsupported %s completion refuses before opening stores or proof/signing work',
  async (kind) => {
    const {
      createRailgunPartialCapsuleData,
    } = require('../../../scripts/fixtures/railgun-partial-capsule-data');
    const { normalizeRailgunPrivateCapsule } = require('./railgun-private-capsule');
    if (kind.startsWith('partial-')) {
      mock.snapshot.stored.capsule = JSON.parse(
        JSON.stringify(normalizeRailgunPrivateCapsule(createRailgunPartialCapsuleData().capsule))
      );
      mock.snapshot.stored.capsule.version = kind === 'partial-v1' ? 1 : 3;
    }
    if (kind === 'unknown-kind') mock.snapshot.stored.capsule.selection.kind = 'unknown';
    if (kind === 'legacy-v2') mock.snapshot.stored.capsule.version = 2;
    const reservations = jest.spyOn(mock.enrollment, 'openReservations');
    const capsules = jest.spyOn(mock.enrollment, 'openPrivateCapsules');
    const address = jest.spyOn(mock.signer, 'getAddress');
    expect(await submit(options)).toEqual({ status: 'recovery-required', stage: 'completion' });
    expect(reservations).not.toHaveBeenCalled();
    expect(capsules).not.toHaveBeenCalled();
    expect(address).not.toHaveBeenCalled();
    expect(mock.events).toEqual([]);
    expect(mock.claimClosed).toBe(true);
  }
);

// Genuine authorities/transport are mocked; ABI and capsule/intent normalizers are real.
function configurePartialSubmission() {
  const { samplePartial } = require('../../../scripts/fixtures/railgun-partial-own-txid-data');
  const f = samplePartial({ recipient: mock.owner });
  mock.snapshot.stored.capsule =
    require('./railgun-private-capsule').normalizeRailgunPrivateCapsule(f.capsule);
  mock.snapshot.stored.provedTransaction = {
    chainId: 11155111,
    to: f.transaction.to,
    value: '0',
    data: f.transaction.input,
  };
  mock.snapshot.entry.facts.intentDigest = f.record.intent.intentDigest;
  mock.snapshot.entry.facts.nullifier = f.record.intent.nullifier;
  mock.records[0].entry = JSON.parse(JSON.stringify(mock.snapshot.entry));
  mock.stored = JSON.parse(JSON.stringify(mock.snapshot.stored));
  return f;
}
test('partial v2 submits exact proved calldata with authenticated 01x02 selection and inherited destinations once', async () => {
  const f = configurePartialSubmission();
  const constraints = { protocol: {}, transaction: {} };
  mock.claim.destinationConstraints = constraints;
  const reviews = [];
  options.review = async (request) => {
    reviews.push(request);
    return true;
  };
  expect(await submit(options)).toEqual({ hash: '0x' + 'c'.repeat(64) });
  expect(mock.preflightKind).toBe('railgun-partial-unshield');
  expect(mock.networkConstructor).toHaveBeenCalledTimes(1);
  expect(mock.preflightConstraint).toBe(constraints.protocol);
  expect(mock.networkOptions.destinationConstraint).toBe(constraints.transaction);
  expect(mock.proofInput.transaction.data).toBe(f.transaction.input);
  expect(mock.proofInput.expected).toEqual(f.capsule.preparation.expected);
  expect(reviews).toHaveLength(1);
  expect(reviews[0].transaction.data).toBe(f.transaction.input);
  expect(reviews[0].intent).toMatchObject({
    version: 2,
    operation: 'railgun-partial-unshield',
    changeCommitment: f.row.commitments[0],
    unshieldCommitment: f.row.commitments[1],
    unshieldAmount: '400',
  });
  expect(reviews[0].intent).not.toHaveProperty('inputAmount');
  expect(reviews[0].intent).not.toHaveProperty('changeAmount');
  expect((await submit(options)).status).toBe('recovery-required');
  expect(mock.events.filter((v) => v === 'broadcast')).toHaveLength(1);
  expect(() => authorize(mock.handle, mock.intent)).toThrow();
});
test.each([undefined, 'railgun-token-unshield', 'railgun-private-transfer'])(
  'partial preflight observed kind %s refuses before transaction network',
  async (intentKind) => {
    configurePartialSubmission();
    mock.observationOverride = { intentKind };
    expect(await submit(options)).toEqual({ status: 'recovery-required', stage: 'preflight' });
    expect(mock.networkConstructor).not.toHaveBeenCalled();
    expect(mock.networkOptions).toBeUndefined();
    expect(mock.events).not.toContain('journal');
    expect(mock.events).not.toContain('broadcast');
    expect(mock.phase).toBe(false);
  }
);
test('partial non-self recipient refuses before proof and preflight', async () => {
  configurePartialSubmission();
  // A coherently normalized capsule remains insufficient when its recipient is not this EOA.
  const { samplePartial } = require('../../../scripts/fixtures/railgun-partial-own-txid-data');
  const f = samplePartial({ recipient: '0x' + '56'.repeat(20) });
  mock.snapshot.stored.capsule = f.capsule;
  mock.snapshot.stored.provedTransaction.data = f.transaction.input;
  mock.snapshot.entry.facts.intentDigest = f.record.intent.intentDigest;
  mock.records[0].entry = JSON.parse(JSON.stringify(mock.snapshot.entry));
  mock.stored = JSON.parse(JSON.stringify(mock.snapshot.stored));
  expect(await submit(options)).toEqual({ status: 'recovery-required', stage: 'recovery' });
  expect(mock.events).not.toContain('C');
  expect(mock.preflightKind).toBeUndefined();
});
test('proof-stored diagnostic is not a completion even when its capsule is partial', async () => {
  configurePartialSubmission();
  expect(
    await submit({ ...options, completion: { status: 'proof-stored', submissionEnabled: false } })
  ).toEqual({ status: 'recovery-required', stage: 'completion' });
  expect(mock.events).toEqual([]);
});
test.each(['changeCommitment', 'unshieldCommitment', 'unshieldAmount'])(
  'partial durable %s mutation during review refuses without sending',
  async (field) => {
    configurePartialSubmission();
    options.review = async () => {
      mock.stored.capsule.preparation.expected[field] =
        field === 'unshieldAmount' ? '401' : '0x' + '01'.repeat(32);
      return true;
    };
    expect((await submit(options)).status).toBe('recovery-required');
    expect(mock.events).not.toContain('broadcast');
    expect(mock.phase).toBe(false);
  }
);
test('partial uncertain attempt survives late recovery failure and cannot be retried', async () => {
  configurePartialSubmission();
  mock.failure = 'phase-end';
  const hash = '0x' + 'd'.repeat(64);
  const intent = require('./railgun-transact-intent').railgunTransactJournalIntent({
    ...mock.snapshot.stored.provedTransaction,
    from: mock.owner,
  });
  mock.network.listSubmissions = async () => [{ hash, intent }];
  mock.send = jest.fn(async () => {
    throw Object.assign(Error('lost reply'), { transactionHash: hash });
  });
  expect(await submit(options)).toEqual({ transactionHash: hash, submissionStatus: 'unknown' });
  expect((await submit(options)).status).toBe('recovery-required');
  expect(mock.send).toHaveBeenCalledTimes(1);
});

describe.each([false, true])('legacy observed-kind exclusion, full-unshield=%s', (unshield) => {
  test.each(['railgun-partial-unshield', undefined])(
    'even an own intentKind property with value %s refuses before network construction',
    async (intentKind) => {
      if (unshield) {
        const f = require('../../../scripts/fixtures/railgun-own-txid-data').sample(true);
        mock.owner = f.capsule.selection.recipient;
        mock.snapshot.entry.signing.submitter = mock.owner;
        mock.snapshot.stored.capsule = f.capsule;
        mock.snapshot.stored.provedTransaction = {
          chainId: 11155111,
          to: f.transaction.to,
          value: '0',
          data: f.transaction.input,
        };
        mock.snapshot.entry.facts.intentDigest = f.record.intent.intentDigest;
        mock.snapshot.entry.facts.nullifier = f.record.intent.nullifier;
        mock.records[0].entry = JSON.parse(JSON.stringify(mock.snapshot.entry));
        mock.stored = JSON.parse(JSON.stringify(mock.snapshot.stored));
      }
      mock.observationOverride = { intentKind };
      expect(await submit(options)).toEqual({ status: 'recovery-required', stage: 'preflight' });
      expect(mock.preflightKind).toBeUndefined();
      expect(mock.networkConstructor).not.toHaveBeenCalled();
      expect(mock.events).toContain('preflight');
      expect(mock.events).not.toContain('journal');
      expect(mock.events).not.toContain('transaction-service');
      expect(mock.events).not.toContain('broadcast');
      expect(mock.phase).toBe(false);
    }
  );
});

// The final service mock above actually invokes the borrowed signer. These
// controls fail if only the post-signing durable reattestation is removed.
test.each(['hold', 'capsule'])(
  'warm held signer rechecks %s before exposing signed bytes',
  async (target) => {
    let release, entered;
    const pendingSign = new Promise((resolve) => {
      release = resolve;
    });
    const called = new Promise((resolve) => {
      entered = resolve;
    });
    mock.signer.signTransaction = async () => {
      entered();
      await pendingSign;
      return '0x1234';
    };
    const pending = submit(options);
    await called;
    if (target === 'hold') mock.records[0].entry.signing.changed = true;
    else mock.stored.changed = true;
    release();
    expect(await pending).toEqual({ status: 'recovery-required', stage: 'submission' });
    expect(mock.events).not.toContain('broadcast');
    expect(mock.phase).toBe(false);
  }
);

test('warm completion preserves zero default proof review margin', async () => {
  expect(await submit(options)).toEqual({ hash: '0x' + 'c'.repeat(64) });
  expect(mock.proofMargins.length).toBeGreaterThan(0);
  expect(mock.proofMargins.every((value) => value === 0)).toBe(true);
});
