/** Host orchestration tests. Issuer registries and A/C execution are controlled
 * mocks; capsule/transaction schemas are real. No native crypto claim. */
let mock;
const mockForbidden = jest.fn(() => {
  throw Error('Unexpected new admission');
});
jest.mock('./railgun-account-enrollment', () => ({
  isRailgunAccountEnrollment: (value) => value === mock.enrollment,
}));
jest.mock('./railgun-identity', () => ({
  assertRailgunIdentity: (...args) => mock.assertIdentity(...args),
  signRailgunPrivateIntent: (...args) => mockForbidden(...args),
}));
jest.mock('./railgun-account-public', () => ({
  assertRailgunAccountPublicDestination: (...args) => mock.assertDestination(...args),
}));
jest.mock('./railgun-account-wallet', () => ({
  openRailgunCompletedAccountWallet: (...args) => mock.openAccount(...args),
  recoverRailgunAccountPrivateProof: (...args) => mock.recover(...args),
  operateRailgunAccountPrivateIntent: (...args) => mockForbidden(...args),
}));
jest.mock('./railgun-private-proof', () => ({
  verifyRailgunPrivateProof: (...args) => mock.verify(...args),
  assertRailgunPrivateProof: (...args) => mock.assertProof(...args),
}));
jest.mock('./railgun-engine-runtime', () => ({
  verifyRailgunEngineRuntime: (value) => mock.runtime(value, mock.options.archive),
}));
jest.mock('./railgun-prover-runtime', () => ({
  verifyRailgunProverRuntime: (value) => mock.runtime(value, mock.options.proverArchive),
}));
jest.mock('./railgun-private-preflight', () => ({
  createRailgunPrivatePreflight: (...args) => mockForbidden(...args),
}));
jest.mock('./railgun-account-poi', () => ({
  openRailgunPrivateWindowPoi: (...args) => mockForbidden(...args),
}));
jest.mock('./railgun-transact-provenance', () => ({
  openRailgunTransactProvenance: (...args) => mockForbidden(...args),
}));
jest.mock('./railgun-account-txid', () => ({
  openRailgunAccountTxid: (...args) => mockForbidden(...args),
}));
jest.mock('./railgun-private-operation', () => ({
  claimRailgunPrivateCompletion: (...args) => mockForbidden(...args),
}));
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const {
  normalizeRailgunPrivateCapsule,
  digestRailgunPrivateCapsule,
} = require('./railgun-private-capsule');
const {
  validateRailgunPrivateSigningIntent,
  matchRailgunPrivateProvedTransaction,
} = require('./railgun-private-intent');
const {
  createRailgunPartialCapsuleData,
  createRailgunLegacyCapsuleData,
} = require('../../../scripts/fixtures/railgun-partial-capsule-data');
const { resumeRailgunAccountPrivateProof: resume } = require('./railgun-private-proof-recovery');
const copy = (value) => JSON.parse(JSON.stringify(value));
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const turn = async () => {
  for (let n = 0; n < 20; n++) await Promise.resolve();
};
const kinds = ['railgun-private-transfer', 'railgun-token-unshield', 'railgun-partial-unshield'];
function configure(kind = 'railgun-token-unshield') {
  const fixture =
    kind === 'railgun-partial-unshield'
      ? createRailgunPartialCapsuleData()
      : createRailgunLegacyCapsuleData(kind);
  fixture.capsule.engineSha256 = require('./railgun-engine-manifest.json').sha256;
  const capsule = normalizeRailgunPrivateCapsule(fixture.capsule);
  mock.identity.descriptor = freeze({
    walletId: capsule.walletId,
    instanceId: fixture.owned.read.instanceId,
  });
  mock.enrollment.descriptor = mock.identity.descriptor;
  mock.entry = {
    id: mock.options.holdId,
    state: 'signing',
    facts: {
      tree: capsule.selection.tree,
      position: capsule.selection.position,
      kind,
      nullifier: capsule.preparation.expected.nullifier,
      noteHash: capsule.noteHash,
      intentDigest: validateRailgunPrivateSigningIntent(
        capsule.preparation.transaction,
        capsule.preparation.expected
      ).digest,
      checkpointHash: '4'.repeat(64),
      poiDigest: '5'.repeat(64),
    },
    signing: {
      submitter: '0x' + '12'.repeat(20),
      operationId: '6'.repeat(64),
      gatesDigest: '7'.repeat(64),
    },
  };
  mock.stored = {
    holdId: mock.entry.id,
    factsDigest: hash(mock.entry.facts),
    authorizationDigest: '8'.repeat(64),
    capsuleDigest: digestRailgunPrivateCapsule(capsule),
    signingDigest: hash(mock.entry.signing),
    capsule,
    signature: {
      R8: ['0x' + '1'.padStart(64, '0'), '0x' + '2'.padStart(64, '0')],
      S: '0x' + '3'.padStart(64, '0'),
    },
    provedTransaction: null,
  };
  fixture.inner.proof.a.x = 1;
  const transaction = { ...capsule.preparation.transaction, data: fixture.encode() };
  mock.candidate = {
    status: 'proved',
    transaction,
    transactionDigest: matchRailgunPrivateProvedTransaction(
      capsule.preparation.transaction,
      transaction,
      capsule.preparation.expected
    ).digest,
    independentlyVerified: false,
  };
}
beforeEach(() => {
  const owner = new AbortController(),
    caller = new AbortController();
  const scope = createPrivacyScope({ profileId: 'proof-recovery-unit', signal: owner.signal });
  mock = {
    owner,
    caller,
    scope,
    events: [],
    hooks: new Map(),
    phase: null,
    phaseCount: 0,
    accountLive: false,
    proofLive: false,
    proofReceipt: Object.freeze({}),
    receipts: [],
    accountController: new AbortController(),
    proofController: new AbortController(),
  };
  mock.step = async (name) => {
    mock.events.push(name);
    await mock.hooks.get(name)?.();
  };
  mock.options = {
    archive: '/fixture/engine.asar',
    proverArchive: '/fixture/prover.asar',
    artifactDirectory: '/fixture/artifacts',
    holdId: '3'.repeat(64),
    signal: caller.signal,
  };
  mock.identity = { signal: scope.signal };
  mock.coordinator = { signal: scope.signal };
  mock.destination = Object.freeze({});
  mock.enrollment = {
    signal: scope.signal,
    directory: '/fixture/account',
    getContext: jest.fn((role, operation) =>
      scope.getContext({
        kind: 'private-account',
        principal: 'railgun:0',
        protocol: 'railgun',
        deployment: 'sepolia',
        chainId: 11155111,
        role,
        operation,
      })
    ),
    openPrivateRecoveryStores: jest.fn(async () => {
      await mock.step('stores');
      return { reservations: mock.reservations, capsules: mock.capsules };
    }),
    openReservations: mockForbidden,
    openPrivateCapsules: mockForbidden,
  };
  Object.assign(mock.options, {
    identity: mock.identity,
    enrollment: mock.enrollment,
    coordinator: mock.coordinator,
    destination: mock.destination,
  });
  mock.runtime = jest.fn((value, expected) => {
    assert.equal(value, expected);
    return value;
  });
  mock.assertIdentity = jest.fn((identity, handle) => {
    assert.equal(identity, mock.identity);
    assert.equal(identity.signal.aborted, false);
    if (handle) getPrivacyContext(handle);
    return identity.descriptor;
  });
  mock.assertDestination = jest.fn((coordinator, enrollment, destination) => {
    assert.equal(coordinator, mock.coordinator);
    assert.equal(enrollment, mock.enrollment);
    assert.equal(destination, mock.destination);
    assert.equal(coordinator.signal.aborted, false);
    if (mock.destinationRevoked) throw Error('destination revoked');
  });
  const checkReceipt = (receipt) => {
    assert.ok(mock.phase && receipt === mock.phase.receipt);
    mock.phase.current();
  };
  mock.reservations = {
    withSigningRecovery: jest.fn(async (use, { timeoutMs }) => {
      assert.equal(mock.phase, null);
      assert.equal(mock.accountLive, false);
      const number = ++mock.phaseCount,
        controller = new AbortController(),
        receipt = Object.freeze({});
      const deadline = performance.now() + timeoutMs;
      const current = () => {
        assert.ok(
          mock.phase?.receipt === receipt &&
            !controller.signal.aborted &&
            !scope.signal.aborted &&
            performance.now() < deadline
        );
      };
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      mock.phase = { number, receipt, current };
      mock.receipts.push(receipt);
      try {
        await mock.step('phase' + number + '-enter');
        current();
        const records = mock.records
          ? mock.records(receipt)
          : [{ receipt, entry: freeze(copy(mock.entry)) }];
        const result = await use(records, {
          signal: controller.signal,
          deadline,
          assertCurrent: current,
        });
        current();
        await mock.step('phase' + number + '-exit');
        return result;
      } finally {
        clearTimeout(timer);
        controller.abort();
        mock.phase = null;
      }
    }),
    assertReceiptContext: jest.fn((receipt, origin) => {
      assert.equal(origin, 'recovery');
      checkReceipt(receipt);
    }),
    assertReceipt: jest.fn(async (receipt) => {
      checkReceipt(receipt);
      await mock.step('entry' + mock.phase.number);
      checkReceipt(receipt);
      return freeze(copy(mock.entry));
    }),
    reserve: mockForbidden,
    markSigning: mockForbidden,
    abandon: mockForbidden,
    close: jest.fn(),
  };
  mock.capsules = {
    readSignedUnfinished: jest.fn(async (receipt) => {
      checkReceipt(receipt);
      await mock.step('unfinished' + mock.phase.number);
      checkReceipt(receipt);
      if (!mock.stored.signature || mock.stored.provedTransaction)
        throw Object.assign(Error('not ready'), { code: 'RAILGUN_CAPSULE_NOT_READY' });
      return freeze(copy(mock.stored));
    }),
    saveProvedTransaction: jest.fn(async (receipt, transaction) => {
      checkReceipt(receipt);
      assert.equal(mock.phase.number, 2);
      assert.equal(mock.accountLive, false);
      assert.ok(mock.proofLive);
      await mock.step('save-before');
      checkReceipt(receipt);
      assert.equal(mock.stored.provedTransaction, null);
      mock.stored = { ...mock.stored, provedTransaction: copy(transaction) };
      await mock.step('save-after');
      return freeze(copy(mock.stored));
    }),
    readSigned: jest.fn(async (receipt) => {
      checkReceipt(receipt);
      await mock.step('readback');
      checkReceipt(receipt);
      if (!mock.stored.signature || !mock.stored.provedTransaction)
        throw Object.assign(Error('not ready'), { code: 'RAILGUN_CAPSULE_NOT_READY' });
      return freeze(copy(mock.stored));
    }),
    saveSignature: mockForbidden,
    markSigning: mockForbidden,
    put: mockForbidden,
    close: jest.fn(),
  };
  mock.account = {
    signal: mock.accountController.signal,
    close: jest.fn(async () => {
      mock.accountController.abort();
      await mock.step('account-close');
      mock.accountLive = false;
      await mock.step('account-drained');
    }),
  };
  mock.openAccount = jest.fn(async (options) => {
    assert.equal(mock.phase, null);
    assert.equal(options.identity, mock.identity);
    assert.equal(options.enrollment, mock.enrollment);
    assert.equal(options.coordinator, mock.coordinator);
    assert.equal(options.destination, mock.destination);
    assert.ok(options.signal instanceof AbortSignal);
    mock.accountLive = true;
    mock.accountOptions = options;
    await mock.step('account-open');
    return mock.account;
  });
  mock.recover = jest.fn(async (account, owners, options) => {
    assert.equal(account, mock.account);
    assert.equal(mock.phase, null);
    assert.ok(mock.accountLive);
    assert.equal(owners.identity, mock.identity);
    assert.equal(owners.enrollment, mock.enrollment);
    assert.equal(owners.coordinator, mock.coordinator);
    assert.deepEqual(options.capsule, mock.stored.capsule);
    assert.deepEqual(options.signature, mock.stored.signature);
    assert.deepEqual(Object.keys(options).sort(), [
      'artifactDirectory',
      'capsule',
      'proverArchive',
      'signature',
    ]);
    await mock.step('recover');
    return copy(mock.candidate);
  });
  mock.proof = {
    receipt: mock.proofReceipt,
    observation: {},
    signal: mock.proofController.signal,
    close: jest.fn(() => {
      mock.events.push('C-close');
      mock.proofLive = false;
      mock.proofController.abort();
    }),
  };
  mock.verify = jest.fn(async (options) => {
    assert.equal(mock.phase?.number, 2);
    assert.equal(mock.accountLive, false);
    mock.proofEvidence = {
      intent: copy(options.intent),
      transaction: copy(options.transaction),
      expected: copy(options.expected),
    };
    matchRailgunPrivateProvedTransaction(options.intent, options.transaction, options.expected);
    mock.verifyOptions = options;
    await mock.step('C');
    mock.proofLive = true;
    return mock.proof;
  });
  mock.assertProof = jest.fn((receipt, enrollment, evidence) => {
    assert.equal(receipt, mock.proofReceipt);
    assert.equal(enrollment, mock.enrollment);
    assert.ok(mock.proofLive);
    assert.deepEqual(evidence, mock.proofEvidence);
    if (mock.proofRevoked) throw Error('C revoked');
  });
  mockForbidden.mockClear();
  configure();
});
afterEach(() => {
  expect(mockForbidden).not.toHaveBeenCalled();
  expect(mock.reservations.close).not.toHaveBeenCalled();
  expect(mock.capsules.close).not.toHaveBeenCalled();
  expect(mock.phase).toBeNull();
  mock.scope.close();
  jest.useRealTimers();
  jest.restoreAllMocks();
});
function refusal(result, selected = true) {
  expect(result.status).toBe(selected ? 'recovery-required' : 'refused');
  expect(result.submissionEnabled).toBe(false);
  expect(typeof result.stage).toBe('string');
  expect(Object.keys(result).sort()).toEqual(
    selected
      ? ['holdId', 'stage', 'status', 'submissionEnabled']
      : ['stage', 'status', 'submissionEnabled']
  );
  if (selected) expect(result.holdId).toBe(mock.options.holdId);
}
test.each(kinds)(
  'stores only the original proof slot for %s after account drain and fresh C',
  async (kind) => {
    configure(kind);
    const before = copy(mock.stored),
      entry = copy(mock.entry);
    const result = await resume(mock.options);
    expect(result).toEqual({
      status: 'proof-stored',
      holdId: entry.id,
      transactionDigest: mock.candidate.transactionDigest,
      submissionEnabled: false,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(mock.phaseCount).toBe(2);
    expect(mock.receipts[0]).not.toBe(mock.receipts[1]);
    expect(mock.entry).toEqual(entry);
    expect(mock.stored).toEqual({ ...before, provedTransaction: mock.candidate.transaction });
    expect(mock.enrollment.openPrivateRecoveryStores).toHaveBeenCalledTimes(1);
    expect(mock.capsules.saveProvedTransaction).toHaveBeenCalledTimes(1);
    expect(mock.capsules.saveProvedTransaction).toHaveBeenCalledWith(
      mock.receipts[1],
      mock.candidate.transaction
    );
    const index = (name) => mock.events.indexOf(name);
    expect(index('phase1-exit')).toBeLessThan(index('account-open'));
    expect(index('account-drained')).toBeLessThan(index('phase2-enter'));
    expect(index('C')).toBeLessThan(index('save-before'));
    expect(index('save-after')).toBeLessThan(index('readback'));
    expect(mock.verify).toHaveBeenCalledTimes(1);
    expect(mock.assertProof).toHaveBeenCalled();
    expect(mock.proof.close).toHaveBeenCalled();
  }
);
test.each(['identity', 'enrollment', 'coordinator', 'destination'])(
  'refuses copied %s before store or account work',
  async (key) => {
    refusal(await resume({ ...mock.options, [key]: { ...mock.options[key] } }), false);
    expect(mock.enrollment.openPrivateRecoveryStores).not.toHaveBeenCalled();
    expect(mock.openAccount).not.toHaveBeenCalled();
  }
);
test.each([0, -1, 360001, 1.5, NaN, Infinity, '360000', null])(
  'invalid timeout %p refuses before stores',
  async (timeoutMs) => {
    refusal(await resume({ ...mock.options, timeoutMs }), false);
    expect(mock.enrollment.openPrivateRecoveryStores).not.toHaveBeenCalled();
  }
);
test.each(['', 'short', 'A'.repeat(64), null])(
  'invalid holdId %p refuses before stores',
  async (holdId) => {
    refusal(await resume({ ...mock.options, holdId }), false);
    expect(mock.enrollment.openPrivateRecoveryStores).not.toHaveBeenCalled();
  }
);
test('caller cancellation before admission makes no store or account calls', async () => {
  mock.caller.abort();
  refusal(await resume(mock.options), false);
  expect(mock.enrollment.openPrivateRecoveryStores).not.toHaveBeenCalled();
  expect(mock.openAccount).not.toHaveBeenCalled();
});
test('unknown options are refused without invoking accessors', async () => {
  const get = jest.fn(() => {
    throw Error('must not evaluate');
  });
  const options = { ...mock.options };
  Object.defineProperty(options, 'review', { enumerable: true, get });
  refusal(await resume(options), false);
  expect(get).not.toHaveBeenCalled();
  expect(mock.enrollment.openPrivateRecoveryStores).not.toHaveBeenCalled();
});
test.each(['missing-hold', 'duplicate-hold', 'missing-signature', 'reader-refusal'])(
  'initial %s preserves data and admits no viewing/C',
  async (mode) => {
    if (mode === 'missing-hold') mock.records = () => [];
    if (mode === 'duplicate-hold')
      mock.records = (receipt) => [
        { receipt, entry: copy(mock.entry) },
        { receipt, entry: copy(mock.entry) },
      ];
    if (mode === 'missing-signature') mock.stored.signature = null;
    if (mode === 'reader-refusal')
      mock.hooks.set('unfinished1', () => {
        throw Error('reader');
      });
    const before = copy(mock.stored);
    refusal(await resume(mock.options), false);
    expect(mock.stored).toEqual(before);
    expect(mock.openAccount).not.toHaveBeenCalled();
    expect(mock.verify).not.toHaveBeenCalled();
  }
);
test.each(['entry', 'capsule', 'signature', 'binding', 'competing-proof'])(
  'final phase %s drift refuses before C or writes',
  async (field) => {
    const original = copy(mock.stored);
    mock.hooks.set('account-close', () => {
      if (field === 'entry')
        mock.entry = {
          ...mock.entry,
          signing: { ...mock.entry.signing, operationId: 'a'.repeat(64) },
        };
      if (field === 'capsule')
        mock.stored = {
          ...mock.stored,
          capsule: { ...mock.stored.capsule, pathElements: Array(16).fill('0x' + '9'.repeat(64)) },
        };
      if (field === 'signature')
        mock.stored = {
          ...mock.stored,
          signature: { ...mock.stored.signature, S: '0x' + '4'.padStart(64, '0') },
        };
      if (field === 'binding') mock.stored = { ...mock.stored, factsDigest: 'f'.repeat(64) };
      if (field === 'competing-proof')
        mock.stored = { ...mock.stored, provedTransaction: copy(mock.candidate.transaction) };
    });
    refusal(await resume(mock.options));
    expect(mock.verify).not.toHaveBeenCalled();
    expect(mock.capsules.saveProvedTransaction).not.toHaveBeenCalled();
    expect(mock.stored.capsuleDigest).toBe(original.capsuleDigest);
  }
);
test.each(['entry', 'signature', 'proof-revoked'])(
  'late %s change during C prevents durable write',
  async (field) => {
    mock.hooks.set('C', () => {
      if (field === 'entry')
        mock.entry = { ...mock.entry, facts: { ...mock.entry.facts, poiDigest: 'c'.repeat(64) } };
      if (field === 'signature')
        mock.stored = {
          ...mock.stored,
          signature: { ...mock.stored.signature, S: '0x' + '4'.padStart(64, '0') },
        };
      if (field === 'proof-revoked') mock.proofRevoked = true;
    });
    refusal(await resume(mock.options));
    expect(mock.capsules.saveProvedTransaction).not.toHaveBeenCalled();
  }
);
test.each(['C', 'save-before', 'save-after', 'readback'])(
  '%s failure reports recovery-required without retry or changing original signature',
  async (stage) => {
    const signature = copy(mock.stored.signature);
    mock.hooks.set(stage, () => {
      throw Error(stage);
    });
    refusal(await resume(mock.options));
    expect(mock.stored.signature).toEqual(signature);
    expect(mock.capsules.saveProvedTransaction.mock.calls.length).toBeLessThanOrEqual(1);
    expect(mock.stored.provedTransaction !== null).toBe(['save-after', 'readback'].includes(stage));
  }
);

function hold(name) {
  const entered = deferred(),
    gate = deferred();
  mock.hooks.set(name, () => {
    entered.resolve();
    return gate.promise;
  });
  return { entered: entered.promise, release: gate.resolve };
}
test.each(['status', 'verified', 'digest', 'transaction'])(
  'rejects a mismatched reconstructed candidate %s before C',
  async (field) => {
    if (field === 'status') mock.candidate.status = 'signed';
    if (field === 'verified') mock.candidate.independentlyVerified = true;
    if (field === 'digest') mock.candidate.transactionDigest = 'e'.repeat(64);
    if (field === 'transaction') mock.candidate.transaction.value = '1';
    refusal(await resume(mock.options));
    expect(mock.verify).not.toHaveBeenCalled();
    expect(mock.capsules.saveProvedTransaction).not.toHaveBeenCalled();
    expect(mock.account.close).toHaveBeenCalled();
  }
);
test.each(['account-open', 'recover', 'account-close', 'C'])(
  'caller abort during borrowed %s waits for settlement and permits no later write',
  async (stage) => {
    const barrier = hold(stage);
    let settled = false;
    const pending = resume(mock.options).then((value) => {
      settled = true;
      return value;
    });
    await barrier.entered;
    mock.caller.abort();
    await turn();
    expect(settled).toBe(false);
    expect(mock.capsules.saveProvedTransaction).not.toHaveBeenCalled();
    if (stage === 'account-open') expect(mock.recover).not.toHaveBeenCalled();
    if (stage !== 'C') expect(mock.verify).not.toHaveBeenCalled();
    barrier.release();
    refusal(await pending);
    expect(mock.account.close).toHaveBeenCalled();
    expect(mock.accountLive).toBe(false);
    if (stage === 'C') expect(mock.proof.close).toHaveBeenCalled();
    expect(mock.capsules.saveProvedTransaction).not.toHaveBeenCalled();
  }
);
test('late-opened account is retained through its own close after cancellation', async () => {
  const opening = hold('account-open'),
    closing = hold('account-close');
  let settled = false;
  const pending = resume(mock.options).then((value) => {
    settled = true;
    return value;
  });
  await opening.entered;
  mock.caller.abort();
  opening.release();
  await closing.entered;
  await turn();
  expect(settled).toBe(false);
  expect(mock.accountLive).toBe(true);
  expect(mock.recover).not.toHaveBeenCalled();
  expect(mock.phaseCount).toBe(1);
  closing.release();
  refusal(await pending);
  expect(mock.accountLive).toBe(false);
});
test('held account close excludes final recovery phase and concurrent host without revoking owner', async () => {
  const barrier = hold('account-close');
  const pending = resume(mock.options);
  await barrier.entered;
  const competing = await resume(mock.options);
  refusal(competing, false);
  expect(mock.accountOptions.signal.aborted).toBe(false);
  expect(mock.enrollment.signal.aborted).toBe(false);
  expect(mock.phaseCount).toBe(1);
  expect(mock.verify).not.toHaveBeenCalled();
  expect(mock.enrollment.openPrivateRecoveryStores).toHaveBeenCalledTimes(1);
  barrier.release();
  expect((await pending).status).toBe('proof-stored');
  expect(mock.phaseCount).toBe(2);
});
test.each(['account-open', 'recover', 'C'])(
  'retained destination revocation during %s refuses without writing',
  async (stage) => {
    mock.hooks.set(stage, () => {
      mock.destinationRevoked = true;
    });
    refusal(await resume(mock.options));
    expect(mock.capsules.saveProvedTransaction).not.toHaveBeenCalled();
    if (stage === 'account-open') expect(mock.recover).not.toHaveBeenCalled();
    if (stage !== 'C') expect(mock.verify).not.toHaveBeenCalled();
  }
);
test('original deadline expires while C ignores cancellation, then drains before returning', async () => {
  jest.useFakeTimers();
  const barrier = hold('C');
  let settled = false;
  const pending = resume({ ...mock.options, timeoutMs: 10000 }).then((value) => {
    settled = true;
    return value;
  });
  await barrier.entered;
  await jest.advanceTimersByTimeAsync(10001);
  expect(mock.verifyOptions.signal.aborted).toBe(true);
  expect(settled).toBe(false);
  barrier.release();
  refusal(await pending);
  expect(mock.proof.close).toHaveBeenCalled();
  expect(mock.capsules.saveProvedTransaction).not.toHaveBeenCalled();
});
test('stage budgets use the remaining original deadline and fixed component caps', async () => {
  jest.useFakeTimers();
  mock.hooks.set('unfinished1', () => {
    jest.advanceTimersByTime(10000);
  });
  mock.hooks.set('recover', () => {
    jest.advanceTimersByTime(10000);
  });
  expect((await resume({ ...mock.options, timeoutMs: 40000 })).status).toBe('proof-stored');
  expect(mock.reservations.withSigningRecovery.mock.calls[0][1].timeoutMs).toBe(40000);
  expect(mock.accountOptions.timeoutMs).toBe(30000);
  expect(mock.reservations.withSigningRecovery.mock.calls[1][1].timeoutMs).toBe(20000);
  expect(mock.verifyOptions.timeoutMs).toBe(20000);
});
test('omitted signal and undefined timeout preserve the default bounded flow', async () => {
  const options = { ...mock.options, timeoutMs: undefined };
  delete options.signal;
  expect((await resume(options)).status).toBe('proof-stored');
  expect(mock.reservations.withSigningRecovery.mock.calls[0][1].timeoutMs).toBeLessThanOrEqual(
    45000
  );
  expect(mock.accountOptions.timeoutMs).toBeLessThanOrEqual(180000);
  expect(mock.verifyOptions.timeoutMs).toBeLessThanOrEqual(60000);
});
test('caller options mutated after admission cannot retarget the selected operation', async () => {
  const options = { ...mock.options },
    holdId = options.holdId;
  mock.hooks.set('stores', () => {
    options.holdId = 'a'.repeat(64);
    options.destination = {};
    options.archive = '/other/engine.asar';
    options.proverArchive = '/other/prover.asar';
    options.artifactDirectory = '/other/artifacts';
    options.timeoutMs = 1;
  });
  expect((await resume(options)).holdId).toBe(holdId);
  expect(mock.accountOptions.archive).toBe(mock.options.archive);
  expect(mock.verifyOptions.proverArchive).toBe(mock.options.proverArchive);
  expect(mock.verifyOptions.artifactDirectory).toBe(mock.options.artifactDirectory);
});
test.each(['account-close', 'C-close'])(
  '%s cleanup refusal is sanitized and releases only the host exclusion',
  async (stage) => {
    if (stage === 'account-close')
      mock.hooks.set(stage, () => {
        throw Error('close failed');
      });
    else
      mock.proof.close.mockImplementation(() => {
        throw Error('C close failed');
      });
    const result = await resume(mock.options);
    refusal(result);
    expect(mock.enrollment.signal.aborted).toBe(false);
    expect(mock.capsules.saveProvedTransaction).toHaveBeenCalledTimes(stage === 'C-close' ? 1 : 0);
    // A fresh admitted lookup proves the local busy claim was released. This
    // deliberately does not claim a failed account issuer can be reopened.
    mock.accountLive = false;
    mock.records = () => [];
    refusal(await resume(mock.options), false);
    expect(mock.enrollment.openPrivateRecoveryStores).toHaveBeenCalledTimes(2);
  }
);
test.each(['signature', 'transaction', 'entry'])(
  'post-write %s readback mismatch is recovery-required and never retried',
  async (field) => {
    mock.hooks.set('readback', () => {
      if (field === 'signature') mock.stored = { ...mock.stored, signature: null };
      if (field === 'transaction')
        mock.stored = {
          ...mock.stored,
          provedTransaction: { ...mock.stored.provedTransaction, value: '1' },
        };
      if (field === 'entry') mock.entry = { ...mock.entry, state: 'submitted' };
    });
    refusal(await resume(mock.options));
    expect(mock.capsules.saveProvedTransaction).toHaveBeenCalledTimes(1);
    expect(mock.stored.provedTransaction).not.toBeNull();
  }
);
test('abort after durable write preserves the proof while reporting unresolved completion', async () => {
  mock.hooks.set('save-after', () => {
    mock.caller.abort();
  });
  refusal(await resume(mock.options));
  expect(mock.capsules.saveProvedTransaction).toHaveBeenCalledTimes(1);
  expect(mock.stored.provedTransaction).toEqual(mock.candidate.transaction);
  expect(mock.capsules.readSigned).not.toHaveBeenCalled();
});
test('final recovery phase exit failure preserves the saved proof without success', async () => {
  mock.hooks.set('phase2-exit', () => {
    throw Error('phase exit failed');
  });
  refusal(await resume(mock.options));
  expect(mock.stored.provedTransaction).toEqual(mock.candidate.transaction);
  expect(mock.capsules.saveProvedTransaction).toHaveBeenCalledTimes(1);
});

test.each(['stores', 'unfinished1'])(
  'cancelled initial %s drains the borrowed read before refusing without account admission',
  async (stage) => {
    const barrier = hold(stage);
    let settled = false;
    const pending = resume(mock.options).then((value) => {
      settled = true;
      return value;
    });
    await barrier.entered;
    mock.caller.abort();
    await turn();
    expect(settled).toBe(false);
    barrier.release();
    refusal(await pending, false);
    expect(mock.openAccount).not.toHaveBeenCalled();
    expect(mock.verify).not.toHaveBeenCalled();
  }
);
test.each(['account-open', 'recover', 'C'])(
  'owner revocation during %s stops subsequent admission and preserves the signed input',
  async (stage) => {
    const original = copy(mock.stored);
    mock.hooks.set(stage, () => {
      mock.owner.abort();
    });
    refusal(await resume(mock.options));
    expect(mock.stored).toEqual(original);
    expect(mock.capsules.saveProvedTransaction).not.toHaveBeenCalled();
    if (stage === 'account-open') expect(mock.recover).not.toHaveBeenCalled();
    if (stage !== 'C') expect(mock.verify).not.toHaveBeenCalled();
  }
);
test.each(['stored-hold', 'wallet'])(
  'initial authenticated reader %s mismatch refuses before completed account work',
  async (field) => {
    if (field === 'stored-hold') mock.stored.holdId = '9'.repeat(64);
    else mock.stored.capsule = { ...mock.stored.capsule, walletId: '9'.repeat(64) };
    refusal(await resume(mock.options), false);
    expect(mock.openAccount).not.toHaveBeenCalled();
    expect(mock.verify).not.toHaveBeenCalled();
  }
);
test('malformed proxy options refuse without evaluating proxy traps', async () => {
  const trap = jest.fn(() => {
    throw Error('must not evaluate');
  });
  const options = new Proxy(mock.options, { get: trap, getPrototypeOf: trap, ownKeys: trap });
  refusal(await resume(options), false);
  expect(trap).not.toHaveBeenCalled();
  expect(mock.enrollment.openPrivateRecoveryStores).not.toHaveBeenCalled();
});
test('failed completed-account open drains its own borrowed work before host returns', async () => {
  const barrier = hold('account-open');
  mock.openAccount.mockImplementation(async () => {
    await mock.step('account-open');
    throw Error('completed checkpoint unavailable');
  });
  let settled = false;
  const pending = resume(mock.options).then((value) => {
    settled = true;
    return value;
  });
  await barrier.entered;
  await turn();
  expect(settled).toBe(false);
  barrier.release();
  refusal(await pending);
  expect(mock.recover).not.toHaveBeenCalled();
  expect(mock.verify).not.toHaveBeenCalled();
});

test.each(kinds)(
  'existing %s proof is only a stored diagnostic with no new account or C',
  async (kind) => {
    configure(kind);
    mock.stored.provedTransaction = copy(mock.candidate.transaction);
    const before = copy(mock.stored);
    const result = await resume(mock.options);
    expect(result).toEqual({
      status: 'proof-present',
      holdId: mock.options.holdId,
      transactionDigest: mock.candidate.transactionDigest,
      submissionEnabled: false,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(mock.phaseCount).toBe(1);
    expect(mock.capsules.readSigned).toHaveBeenCalledWith(mock.receipts[0]);
    expect(mock.openAccount).not.toHaveBeenCalled();
    expect(mock.recover).not.toHaveBeenCalled();
    expect(mock.verify).not.toHaveBeenCalled();
    expect(mock.capsules.saveProvedTransaction).not.toHaveBeenCalled();
    expect(mock.stored).toEqual(before);
  }
);
test('lost acknowledgement retry reports the existing proof without regenerating or writing twice', async () => {
  mock.hooks.set('save-after', () => {
    throw Error('reply lost after commit');
  });
  refusal(await resume(mock.options));
  const committed = copy(mock.stored);
  mock.hooks.delete('save-after');
  expect(await resume(mock.options)).toEqual({
    status: 'proof-present',
    holdId: mock.options.holdId,
    transactionDigest: mock.candidate.transactionDigest,
    submissionEnabled: false,
  });
  expect(mock.stored).toEqual(committed);
  expect(mock.openAccount).toHaveBeenCalledTimes(1);
  expect(mock.recover).toHaveBeenCalledTimes(1);
  expect(mock.verify).toHaveBeenCalledTimes(1);
  expect(mock.capsules.saveProvedTransaction).toHaveBeenCalledTimes(1);
});
test('an arbitrary initial read failure cannot fall back to a completed stored proof', async () => {
  mock.stored.provedTransaction = copy(mock.candidate.transaction);
  mock.hooks.set('unfinished1', () => {
    throw Error('integrity failure');
  });
  refusal(await resume(mock.options), false);
  expect(mock.capsules.readSigned).not.toHaveBeenCalled();
  expect(mock.openAccount).not.toHaveBeenCalled();
});
test.each(['transaction', 'holdId', 'walletId'])(
  'existing proof diagnostic still refuses mismatched %s',
  async (field) => {
    mock.stored.provedTransaction = copy(mock.candidate.transaction);
    if (field === 'transaction') mock.stored.provedTransaction.value = '1';
    if (field === 'holdId') mock.stored.holdId = 'a'.repeat(64);
    if (field === 'walletId')
      mock.stored.capsule = { ...mock.stored.capsule, walletId: 'a'.repeat(64) };
    const result = await resume(mock.options);
    expect(['refused', 'recovery-required']).toContain(result.status);
    expect(result.submissionEnabled).toBe(false);
    expect(mock.openAccount).not.toHaveBeenCalled();
    expect(mock.verify).not.toHaveBeenCalled();
    expect(mock.capsules.saveProvedTransaction).not.toHaveBeenCalled();
  }
);
test('cancelled existing-proof read drains before refusal and does not claim proof presence', async () => {
  mock.stored.provedTransaction = copy(mock.candidate.transaction);
  const barrier = hold('readback');
  let settled = false;
  const pending = resume(mock.options).then((value) => {
    settled = true;
    return value;
  });
  await barrier.entered;
  mock.caller.abort();
  await turn();
  expect(settled).toBe(false);
  barrier.release();
  refusal(await pending, false);
  expect(mock.openAccount).not.toHaveBeenCalled();
});
