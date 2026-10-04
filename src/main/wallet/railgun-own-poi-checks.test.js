const assert = require('assert/strict');
jest.mock('./railgun-public-policy', () => ({
  getRailgunPublicPolicy: jest.fn((archive) => {
    if (archive !== '/engine') throw Error('policy');
    return 'fixture-policy';
  }),
}));
jest.mock('./railgun-account-public', () => ({
  getRailgunAccountPublicDestination: jest.fn((coordinator, enrollment, policy) => {
    if (
      coordinator !== mock.coordinator ||
      enrollment !== mock.enrollment ||
      policy !== 'fixture-policy'
    )
      throw Error('destination owner');
    return mock.destination;
  }),
  assertRailgunAccountPublicDestination: jest.fn((coordinator, enrollment, destination, policy) => {
    if (
      coordinator !== mock.coordinator ||
      enrollment !== mock.enrollment ||
      destination !== mock.destination ||
      policy !== 'fixture-policy'
    )
      throw Error('destination changed');
    return destination;
  }),
}));
let mock;
jest.mock('./railgun-engine-runtime', () => ({
  verifyRailgunEngineRuntime: (value) => {
    if (value !== '/engine') throw Error('archive');
    return value;
  },
}));
jest.mock('./railgun-own-poi-proof', () => ({
  assertRailgunOwnPoiProof: (proof, enrollment, coordinator) => {
    if (
      proof !== mock.proof ||
      enrollment !== mock.enrollment ||
      coordinator !== mock.coordinator ||
      !mock.historyActive ||
      mock.identity.signal.aborted ||
      mock.enrollment.signal.aborted ||
      mock.coordinator.signal.aborted
    )
      throw Error('proof history');
    return mock.history;
  },
}));
jest.mock('./railgun-own-witness', () => ({
  preflightRailgunRetainedPoiCompleted: jest.fn((options) => mock.preflight(options)),
}));
jest.mock('./railgun-own-operation', () => {
  const assert = require('assert/strict');
  return {
    withRailgunOwnOperationRecovery: jest.fn(async (options, use) => {
      mock.events.push('recovery');
      mock.phase = true;
      const current = () => assert.ok(!options.signal.aborted);
      try {
        if (mock.recoveryStatus) return mock.recoveryStatus;
        const capture = JSON.parse(JSON.stringify(mock.finalCapture || mock.fresh.capture));
        const value = await use({
          capture,
          assertCurrent: current,
          reattest: async () => {
            mock.events.push('reattest');
            await mock.reattest();
            current();
            return JSON.parse(JSON.stringify(mock.reattestedCapture || capture));
          },
        });
        await mock.recoveryDrain();
        current();
        return { status: 'used', value };
      } finally {
        mock.events.push('recovery-drained');
        mock.phase = false;
      }
    }),
  };
});
jest.mock('./railgun-poi-root', () => ({
  createRailgunPoiRootSource: jest.fn((options) => mock.root('list', options)),
  createRailgunPoiTxidRootSource: jest.fn((options) => mock.root('txid', options)),
}));
const { createHash } = require('crypto');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { normalizeRailgunPoiPayload } = require('./railgun-poi-payload');
const { REQUIRED_LIST } = require('./railgun-poi-records');
const { preflightRailgunRetainedPoiCompleted } = require('./railgun-own-witness');
const {
  createRailgunPoiRootSource,
  createRailgunPoiTxidRootSource,
} = require('./railgun-poi-root');
const {
  openRailgunOwnPoiChecks: open,
  assertRailgunOwnPoiChecks: check,
} = require('./railgun-own-poi-checks');
const hex = (n) => BigInt(n).toString(16).padStart(64, '0');
const clone = (v) => JSON.parse(JSON.stringify(v));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const until = async (predicate) => {
  for (let i = 0; i < 200 && !predicate(); i++) await Promise.resolve();
  expect(predicate()).toBe(true);
};
let options, results;
beforeEach(() => {
  jest.clearAllMocks();
  const identity = new AbortController(),
    enrollmentAbort = new AbortController();
  mock = {
    identity,
    enrollmentAbort,
    caller: new AbortController(),
    coordinator: { signal: new AbortController().signal },
    coordinatorAbort: new AbortController(),
    historyActive: true,
    destination: Object.freeze({}),
    proof: {},
    events: [],
    roots: {},
    rootDelays: {},
    rootCloseDelays: {},
    reattest: async () => {},
    recoveryDrain: async () => {},
  };
  mock.coordinator.signal = mock.coordinatorAbort.signal;
  mock.scope = createPrivacyScope({
    profileId: 'own-poi-checks-unit',
    signal: AbortSignal.any([identity.signal, enrollmentAbort.signal]),
  });
  mock.enrollment = {
    directory: '/fixture/own-poi-checks',
    signal: mock.scope.signal,
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
  const payload = normalizeRailgunPoiPayload({
    listKey: REQUIRED_LIST,
    proof: {
      pi_a: ['1', '2'],
      pi_b: [
        ['3', '4'],
        ['5', '6'],
      ],
      pi_c: ['7', '8'],
    },
    poiMerkleroots: [hex(5)],
    txidMerkleroot: hex(6),
    txidMerklerootIndex: 4,
    blindedCommitmentsOut: ['0x' + hex(8)],
    railgunTxidIfHasUnshield: '0x00',
  });
  const capture = {
    bindingDigest: hex(1),
    selector: { holdId: hex(2) },
    facts: { nullifier: hex(3) },
    submitter: '0x' + '12'.repeat(20),
    capsule: { input: 'owned' },
    capsuleDigest: hex(4),
    provedTransaction: { data: '0x1234' },
    intent: { digest: hex(7) },
    projection: { included: true },
    record: { state: 'submitted' },
  };
  mock.history = {
    archive: '/engine',
    txidTree: 0,
    payload,
    payloadSha256: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    expected: { ...payload, outputCount: 1 },
    capture,
    publicIdentity: { generation: 'stable-policy' },
    preparation: {
      creator: { type: 'Shield', hash: hex(10) },
      ownEvidence: { capsule: clone(capture.capsule), row: { txid: hex(11) } },
      witness: { railgunTxid: hex(12), leaf: hex(13), index: 3, rowSha256: hex(14) },
    },
  };
  mock.fresh = {
    status: 'captured',
    capture: clone(capture),
    publicIdentity: clone(mock.history.publicIdentity),
    creatorClassification: { type: 'Shield', legacy: false },
    poiPreparation: clone(mock.history.preparation),
    witness: {
      ...mock.history.preparation.witness,
      root: hex(99),
      checkpointIndex: 9,
      path: ['advanced'],
    },
    observations: {
      archiveAnchorChecked: true,
      finalRepresentation: 'active',
      finalArchiveAnchor: null,
    },
  };
  mock.preflight = async () => {
    mock.events.push('preflight');
    return clone(mock.fresh);
  };
  mock.root = (kind, input) => {
    mock.events.push(kind + '-create');
    const lifetime = new AbortController(),
      drained = deferred();
    const receipt = {},
      observation = Object.freeze({ kind, root: input.root, accepted: true });
    let acquiring = false,
      finished = false,
      closed = false;
    const finish = () => {
      if (closed && !acquiring && (!mock.rootCloseDelays[kind] || finished)) drained.resolve();
    };
    const source = {
      input,
      signal: lifetime.signal,
      closed: drained.promise,
      close: jest.fn(() => {
        if (closed) return;
        closed = true;
        lifetime.abort();
        mock.events.push(kind + '-close');
        if (mock.rootCloseDelays[kind])
          mock.rootCloseDelays[kind].promise.then(() => {
            finished = true;
            finish();
          });
        finish();
      }),
      acquire: jest.fn(async (budget) => {
        acquiring = true;
        mock.events.push(kind + '-acquire');
        source.budget = budget;
        try {
          if (mock.rootDelays[kind]) await mock.rootDelays[kind].promise;
          assert.ok(!lifetime.signal.aborted);
          return { receipt, observation };
        } finally {
          acquiring = false;
          mock.events.push(kind + '-drained');
          finish();
        }
      }),
      assertResult: jest.fn((value, margin) => {
        assert.equal(value, receipt);
        assert.ok(!lifetime.signal.aborted);
        assert.ok(Number.isSafeInteger(margin) && margin >= 0);
        return observation;
      }),
    };
    mock.roots[kind] = source;
    return source;
  };
  options = {
    archive: '/engine',
    enrollment: mock.enrollment,
    coordinator: mock.coordinator,
    proof: mock.proof,
    signal: mock.caller.signal,
  };
  results = [];
});
afterEach(async () => {
  for (const result of results) result.close?.();
  for (const source of Object.values(mock.roots)) source.close();
  mock.scope.close();
  await Promise.all(results.map((v) => v.closed));
  jest.useRealTimers();
});
const run = async (changes = {}) => {
  const result = await open({ ...options, ...changes });
  results.push(result);
  return result;
};
const assertReceipt = (result, margin = 0) =>
  check(result.receipt, mock.enrollment, mock.coordinator, mock.proof, margin);

test('fresh checks use original roots with advanced mirror data and grant no authority', async () => {
  const result = await run();
  expect(result).toMatchObject({ status: 'checked' });
  expect(preflightRailgunRetainedPoiCompleted).toHaveBeenCalledWith(
    expect.objectContaining({ selector: mock.history.capture.selector, archive: '/engine' })
  );
  expect(mock.roots.list.input.root).toBe(hex(5));
  expect(mock.roots.txid.input).toMatchObject({ root: hex(6), index: 4 });
  const context = getPrivacyContext(mock.roots.list.input.handle);
  expect(context.subject).toMatchObject({
    role: 'poi',
    operation: expect.stringMatching(/^poi:[0-9a-f]{64}$/),
  });
  expect(mock.roots.list.input.handle).toBe(mock.roots.txid.input.handle);
  expect(mock.events.indexOf('recovery')).toBeGreaterThan(mock.events.indexOf('txid-drained'));
  expect(mock.events).toContain('reattest');
  expect(mock.phase).toBe(false);
  const observation = assertReceipt(result, 1000);
  for (const key of [
    'accountAuthenticated',
    'sourceAuthenticated',
    'currentFinalityVerified',
    'membershipAuthenticated',
    'rootAccepted',
    'noteStatusChecked',
    'disclosureEnabled',
    'spendingEnabled',
  ])
    expect(observation[key]).toBe(false);
  expect(Object.isFrozen(observation.payload.proof.pi_b[0])).toBe(true);
  expect(Object.isFrozen(observation.capture)).toBe(true);
  expect(() => check({}, mock.enrollment, mock.coordinator, mock.proof)).toThrow();
  expect(() => check(result.receipt, {}, mock.coordinator, mock.proof)).toThrow();
  expect(() => check(result.receipt, mock.enrollment, {}, mock.proof)).toThrow();
  expect(() => check(result.receipt, mock.enrollment, mock.coordinator, {})).toThrow();
});
test.each([null, [], {}, { extra: true }])(
  'malformed options refuse without opening sources %#',
  async (value) => {
    expect((await open(value)).status).toBe('refused');
    expect(preflightRailgunRetainedPoiCompleted).not.toHaveBeenCalled();
    expect(createRailgunPoiRootSource).not.toHaveBeenCalled();
  }
);
test.each([0, -1, 240001, 1.5, NaN])(
  'invalid timeout %s refuses before preflight',
  async (timeoutMs) => {
    expect((await run({ timeoutMs })).status).toBe('refused');
    expect(preflightRailgunRetainedPoiCompleted).not.toHaveBeenCalled();
  }
);
test.each(['proof', 'archive', 'payload', 'signal', 'tree'])(
  'forged or invalid %s refuses before disclosure',
  async (kind) => {
    const change = {};
    if (kind === 'proof') change.proof = {};
    if (kind === 'archive') change.archive = '/wrong';
    if (kind === 'payload') mock.history.payloadSha256 = hex(999);
    if (kind === 'signal') mock.caller.abort();
    if (kind === 'tree') mock.history.txidTree = 1;
    expect((await run(change)).status).toBe('refused');
    expect(preflightRailgunRetainedPoiCompleted).not.toHaveBeenCalled();
    expect(createRailgunPoiTxidRootSource).not.toHaveBeenCalled();
  }
);
test.each(['bindingDigest', 'facts', 'capsuleDigest', 'intent', 'projection'])(
  'changed stable capture %s refuses before root queries',
  async (key) => {
    mock.fresh.capture[key] = 'changed';
    expect(await run()).toEqual({ status: 'refused', stage: 'history-binding' });
    expect(createRailgunPoiRootSource).not.toHaveBeenCalled();
  }
);
test.each([
  'creator',
  'row',
  'railgunTxid',
  'leaf',
  'index',
  'rowSha256',
  'checkpoint',
  'identity',
  'legacy',
  'classification',
  'anchor',
])('changed proof-history relation %s refuses before root queries', async (kind) => {
  if (kind === 'creator') mock.fresh.poiPreparation.creator = {};
  else if (kind === 'row') mock.fresh.poiPreparation.ownEvidence.row = {};
  else if (kind === 'checkpoint') mock.fresh.witness.checkpointIndex = 3;
  else if (kind === 'identity') mock.fresh.publicIdentity = {};
  else if (kind === 'legacy') mock.fresh.creatorClassification.legacy = true;
  else if (kind === 'classification') mock.fresh.creatorClassification.type = 'Transact';
  else if (kind === 'anchor') mock.fresh.observations.archiveAnchorChecked = false;
  else mock.fresh.witness[kind] = 'changed';
  expect((await run()).status).toBe('refused');
  expect(createRailgunPoiRootSource).not.toHaveBeenCalled();
});
test('a fresh checked archive transition is allowed, but archive rollback is refused', async () => {
  mock.fresh.capture.record = { archivedAt: 123, finalized: { number: 20, hash: hex(20) } };
  const result = await run();
  expect(result.status).toBe('checked');
  result.close();
  await result.closed;
  mock.history.capture.record = clone(mock.fresh.capture.record);
  mock.fresh.capture.record = {};
  expect(await run()).toEqual({ status: 'refused', stage: 'history-binding' });
});
test.each(['initial', 'reattest'])(
  'archive change during final %s window refuses',
  async (when) => {
    const changed = clone(mock.fresh.capture);
    changed.record = { archivedAt: 1, finalized: { number: 20, hash: hex(20) } };
    mock[when === 'initial' ? 'finalCapture' : 'reattestedCapture'] = changed;
    expect((await run()).status).toBe('refused');
    expect(mock.phase).toBe(false);
  }
);
test.each(['preflight', 'recovery'])('refused %s status never becomes a receipt', async (at) => {
  if (at === 'preflight') mock.preflight = async () => ({ status: 'refused', stage: 'anchor' });
  else mock.recoveryStatus = { status: 'refused', stage: 'busy' };
  expect((await run()).status).toBe('refused');
  if (at === 'preflight') expect(createRailgunPoiRootSource).not.toHaveBeenCalled();
});
test('root queries start together; root rejection cancels its sibling but retains owner until both drain', async () => {
  mock.rootDelays.list = deferred();
  mock.rootDelays.txid = deferred();
  let settled = false;
  const pending = run().then((value) => {
    settled = true;
    return value;
  });
  await until(() => mock.events.includes('txid-acquire'));
  mock.rootDelays.list.reject(
    Object.assign(Error('secret'), { code: 'RAILGUN_POI_ROOT_REJECTED' })
  );
  await until(() => mock.roots.txid.signal.aborted);
  expect(settled).toBe(false);
  expect((await run()).status).toBe('refused');
  expect(preflightRailgunRetainedPoiCompleted).toHaveBeenCalledTimes(1);
  mock.rootDelays.txid.resolve();
  expect(await pending).toEqual({ status: 'refused', stage: 'list-root-rejected' });
  expect(mock.events).not.toContain('recovery');
  mock.rootDelays = {};
  expect((await run()).status).toBe('checked');
});
test('caller cancellation drains a late preflight and never opens roots', async () => {
  const gate = deferred();
  mock.preflight = async () => {
    await gate.promise;
    return clone(mock.fresh);
  };
  let settled = false;
  const pending = run().then((v) => {
    settled = true;
    return v;
  });
  await until(() => preflightRailgunRetainedPoiCompleted.mock.calls.length === 1);
  mock.caller.abort();
  expect(settled).toBe(false);
  expect((await run({ signal: new AbortController().signal })).status).toBe('refused');
  gate.resolve();
  expect((await pending).status).toBe('refused');
  expect(createRailgunPoiRootSource).not.toHaveBeenCalled();
});
test('cancellation waits for final recovery drain before owner reuse', async () => {
  const gate = deferred();
  mock.recoveryDrain = () => {
    mock.events.push('draining-recovery');
    return gate.promise;
  };
  let settled = false;
  const pending = run().then((v) => {
    settled = true;
    return v;
  });
  await until(() => mock.events.includes('draining-recovery'));
  mock.caller.abort();
  expect(settled).toBe(false);
  expect(mock.phase).toBe(true);
  expect((await run({ signal: new AbortController().signal })).status).toBe('refused');
  gate.resolve();
  expect((await pending).status).toBe('refused');
  expect(mock.phase).toBe(false);
});
test.each(['identity', 'enrollmentAbort', 'coordinatorAbort', 'history', 'list', 'txid'])(
  '%s revocation invalidates issued receipt',
  async (kind) => {
    const result = await run();
    if (kind === 'history') mock.historyActive = false;
    else if (['list', 'txid'].includes(kind)) mock.roots[kind].close();
    else mock[kind].abort();
    expect(() => assertReceipt(result)).toThrow('Railgun own POI checks unavailable');
  }
);
test('explicit 60-second total budget includes preflight latency and strict remaining-time margins', async () => {
  jest.useFakeTimers();
  const gate = deferred();
  mock.preflight = async () => {
    await gate.promise;
    return clone(mock.fresh);
  };
  const pending = run({ timeoutMs: 60000 });
  await until(() => preflightRailgunRetainedPoiCompleted.mock.calls.length === 1);
  await jest.advanceTimersByTimeAsync(40000);
  gate.resolve();
  const result = await pending;
  expect(result.status).toBe('checked');
  expect(mock.roots.list.budget.timeoutMs).toBeLessThanOrEqual(20000);
  expect(() => assertReceipt(result, 19999)).not.toThrow();
  expect(() => assertReceipt(result, 20000)).toThrow();
  expect(() => assertReceipt(result, -1)).toThrow();
  expect(() => assertReceipt(result, 60000)).toThrow();
  await jest.advanceTimersByTimeAsync(20000);
  expect(() => assertReceipt(result)).toThrow();
});
test('default budget permits a long bounded preflight then grants at most 60 seconds of freshness', async () => {
  jest.useFakeTimers();
  const gate = deferred();
  mock.preflight = async () => {
    await gate.promise;
    return clone(mock.fresh);
  };
  const pending = run();
  await until(() => preflightRailgunRetainedPoiCompleted.mock.calls.length === 1);
  const input = preflightRailgunRetainedPoiCompleted.mock.calls[0][0];
  expect(input.timeoutMs).toBe(180000);
  await jest.advanceTimersByTimeAsync(90000);
  expect(input.signal.aborted).toBe(false);
  gate.resolve();
  const result = await pending;
  expect(result.status).toBe('checked');
  expect(result.observation.preflight.durationMs).toBe(90000);
  expect(mock.roots.list.budget.timeoutMs).toBe(45000);
  expect(() => assertReceipt(result, 59999)).not.toThrow();
  expect(() => assertReceipt(result, 60000)).toThrow();
  await jest.advanceTimersByTimeAsync(10000);
  expect(() => assertReceipt(result, 49999)).not.toThrow();
  expect(() => assertReceipt(result, 50000)).toThrow();
  await jest.advanceTimersByTimeAsync(50000);
  expect(result.signal.aborted).toBe(true);
  expect(() => assertReceipt(result)).toThrow();
  await result.closed;
});
test('post-preflight freshness cannot extend a caller-shortened original total deadline', async () => {
  jest.useFakeTimers();
  const gate = deferred();
  mock.preflight = async () => {
    await gate.promise;
    return clone(mock.fresh);
  };
  const pending = run({ timeoutMs: 70000 });
  await until(() => preflightRailgunRetainedPoiCompleted.mock.calls.length === 1);
  expect(preflightRailgunRetainedPoiCompleted.mock.calls[0][0].timeoutMs).toBe(70000);
  await jest.advanceTimersByTimeAsync(40000);
  gate.resolve();
  const result = await pending;
  expect(result.status).toBe('checked');
  expect(result.observation.preflight.durationMs).toBe(40000);
  expect(mock.roots.txid.budget.timeoutMs).toBe(30000);
  expect(() => assertReceipt(result, 29999)).not.toThrow();
  expect(() => assertReceipt(result, 30000)).toThrow();
  await jest.advanceTimersByTimeAsync(30000);
  expect(result.signal.aborted).toBe(true);
  expect(() => assertReceipt(result)).toThrow();
});
test('close.closed retains owner while transport closure is still pending', async () => {
  mock.rootCloseDelays.txid = deferred();
  const result = await run();
  let closed = false;
  result.closed.then(() => {
    closed = true;
  });
  result.close();
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(() => assertReceipt(result)).toThrow();
  expect((await run()).status).toBe('refused');
  mock.rootCloseDelays.txid.resolve();
  await result.closed;
  mock.rootCloseDelays = {};
  expect((await run()).status).toBe('checked');
});
test('healthy admission and a live checks receipt exclude competitors without cancelling their owner', async () => {
  const gate = deferred();
  let signal;
  mock.preflight = async (input) => {
    signal = input.signal;
    await gate.promise;
    return clone(mock.fresh);
  };
  const pending = run();
  await until(() => !!signal);
  expect(await run()).toEqual({ status: 'refused', stage: 'proof-history' });
  expect(signal.aborted).toBe(false);
  expect(preflightRailgunRetainedPoiCompleted).toHaveBeenCalledTimes(1);
  gate.resolve();
  const first = await pending;
  expect(first.status).toBe('checked');
  expect(await run()).toEqual({ status: 'refused', stage: 'proof-history' });
  expect(first.signal.aborted).toBe(false);
  expect(() => assertReceipt(first)).not.toThrow();
  expect(preflightRailgunRetainedPoiCompleted).toHaveBeenCalledTimes(1);
  first.close();
  await first.closed;
  expect((await run()).status).toBe('checked');
  expect(preflightRailgunRetainedPoiCompleted).toHaveBeenCalledTimes(2);
});
test.each(['list', 'txid'])(
  '%s source failures are redacted and revoke both readers',
  async (kind) => {
    mock.rootDelays[kind] = deferred();
    const pending = run();
    await until(() => mock.events.includes('txid-acquire'));
    mock.rootDelays[kind].reject(Error('secret endpoint and proof material'));
    expect(await pending).toEqual({ status: 'refused', stage: kind + '-root-unavailable' });
    expect(mock.roots.list.signal.aborted).toBe(true);
    expect(mock.roots.txid.signal.aborted).toBe(true);
    expect(mock.events).not.toContain('recovery');
  }
);
test('partial root construction failure still drains the created reader', async () => {
  createRailgunPoiTxidRootSource.mockImplementationOnce(() => {
    throw Error('factory');
  });
  expect(await run()).toEqual({ status: 'refused', stage: 'root-contexts' });
  expect(mock.roots.list.signal.aborted).toBe(true);
  await mock.roots.list.closed;
  expect((await run()).status).toBe('checked');
});
test('changing an already archived anchor refuses even if the new preflight reports it checked', async () => {
  mock.history.capture.record = { archivedAt: 1, finalized: { number: 20, hash: hex(20) } };
  mock.fresh.capture.record = { archivedAt: 2, finalized: { number: 21, hash: hex(21) } };
  expect(await run()).toEqual({ status: 'refused', stage: 'history-binding' });
  expect(createRailgunPoiRootSource).not.toHaveBeenCalled();
});
test('bound payload cannot change original roots even when its digest is recomputed', async () => {
  mock.history.payload = { ...mock.history.payload, txidMerkleroot: hex(91) };
  mock.history.payloadSha256 = createHash('sha256')
    .update(JSON.stringify(mock.history.payload))
    .digest('hex');
  expect(await run()).toEqual({ status: 'refused', stage: 'proof-history' });
  expect(preflightRailgunRetainedPoiCompleted).not.toHaveBeenCalled();
});
test('preflight timeout revokes immediately but waits for its late callback before returning', async () => {
  jest.useFakeTimers();
  const gate = deferred();
  let signal,
    settled = false;
  mock.preflight = async (input) => {
    signal = input.signal;
    await gate.promise;
    return clone(mock.fresh);
  };
  const pending = run({ timeoutMs: 2000 }).then((value) => {
    settled = true;
    return value;
  });
  await until(() => !!signal);
  await jest.advanceTimersByTimeAsync(2000);
  expect(signal.aborted).toBe(true);
  expect(settled).toBe(false);
  gate.resolve();
  expect((await pending).status).toBe('refused');
  expect(createRailgunPoiRootSource).not.toHaveBeenCalled();
});
test('root closure during final reattestation revokes authority and waits for recovery drain', async () => {
  const gate = deferred();
  mock.reattest = () => gate.promise;
  let settled = false;
  const pending = run().then((value) => {
    settled = true;
    return value;
  });
  await until(() => mock.events.includes('reattest'));
  mock.roots.list.close();
  expect(settled).toBe(false);
  expect(mock.roots.txid.signal.aborted).toBe(true);
  expect(mock.phase).toBe(true);
  gate.resolve();
  expect((await pending).status).toBe('refused');
  expect(mock.phase).toBe(false);
});

// Structural joins only; genuine source authentication and crypto are native qualifications.
function makeTransactProofFixture(unshield = false, mixedCreator = false) {
  const h = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
  const hash = (v) =>
    require('crypto').createHash('sha256').update(JSON.stringify(v)).digest('hex');
  const evidence = require('../../../scripts/fixtures/railgun-own-txid-data').sample(unshield);
  const descriptor = {
    walletId: evidence.capsule.walletId,
    instanceId: '0zk1' + 'q'.repeat(123),
    masterPublicKey: h(3).slice(2),
    spendingPublicKey: [h(4).slice(2), h(5).slice(2)],
    viewingPublicKey: h(6).slice(2),
    accountIndex: 0,
  };
  const creator = {
    type: 'Transact',
    tree: evidence.capsule.selection.tree,
    position: evidence.capsule.selection.position,
    hash: evidence.capsule.noteHash,
    ciphertext: {
      ciphertext: [h(7), h(8), h(9), h(10)],
      blindedSenderViewingKey: h(11),
      blindedReceiverViewingKey: h(12),
      annotationData: '0x',
      memo: '0x',
    },
  };
  const state = { count: 2, root: h(15).slice(2), transcript: h(16).slice(2), breaks: [] };
  const witnessFor = (row, index) => ({
    row: JSON.parse(JSON.stringify(row)),
    leaf: h(17 + index).slice(2),
    railgunTxid: h(19 + index).slice(2),
    rowSha256: hash(row),
    index,
    elements: Array(16).fill(h(0).slice(2)),
    root: state.root,
    checkpointIndex: 1,
    transcript: state.transcript,
    continuity: require('./railgun-txid-omissions').classifyRailgunTxidContinuity(1, []),
    globalTxidCompleteness: false,
  });
  const blockNumber = evidence.row.blockNumber - 1;
  const creatorRow = {
    version: 'V2',
    graphID: h(blockNumber) + h(2).slice(2) + h(0).slice(2),
    commitments: mixedCreator ? [creator.hash, h(702)] : [creator.hash],
    nullifiers: [h(700)],
    boundParamsHash: h(701),
    blockNumber,
    txid: h(706).slice(2),
    timestamp: blockNumber,
    utxoTreeIn: creator.tree,
    utxoTreeOut: creator.tree,
    utxoBatchStartPositionOut: creator.position,
    verificationHash: evidence.row.verificationHash,
    ...(mixedCreator
      ? {
          unshield: {
            tokenData: {
              tokenType: 0,
              tokenAddress: require('./railgun-shield-pins.json').wrappedNative,
              tokenSubID: h(0),
            },
            toAddress: '0x' + '12'.repeat(20),
            value: '400',
          },
        }
      : {}),
  };
  const note = {
    type: 'Transact',
    tree: creator.tree,
    position: creator.position,
    hash: creator.hash,
    txid: h(706),
    blockNumber,
  };
  const input = {
    archive: '/engine.asar',
    proverArchive: '/prover.asar',
    artifactDirectory: '/artifacts',
    descriptor,
    preparation: { creator, ownEvidence: evidence, state, witness: witnessFor(evidence.row, 1) },
    listProofs: [
      {
        leaf: h(21).slice(2),
        root: h(22).slice(2),
        indices: h(0).slice(2),
        elements: Array(16).fill(h(0).slice(2)),
      },
    ],
  };
  const selectorInput =
    require('./railgun-poi-transact-selector-data').prepareRailgunPoiTransactSelectorInput({
      archive: input.archive,
      descriptor,
      capsule: evidence.capsule,
      creator,
    });
  return {
    input,
    selector: {
      blindedCommitment: h(21),
      bindingDigest: selectorInput.bindingDigest,
      inputSha256: hash(selectorInput),
    },
    creatorProvenance: {
      note,
      noteWitness: {
        note,
        outputIndex: 0,
        witness: witnessFor(creatorRow, 0),
        ownershipVerified: false,
        eventCoverageVerified: false,
        rootAccepted: false,
        spendingEnabled: false,
      },
      verification: {
        ...(mixedCreator ? { unshieldCommitmentVerified: true } : {}),
        utilityExitObserved: true,
        pathVerified: true,
        suppliedCreatorEventsMatched: true,
        coverage: {
          matchedRows: 1,
          knownOmissions: 0,
          boundParamsChecked: false,
          unshieldCommitmentHashesChecked: false,
          globalTxidCompleteness: false,
        },
      },
    },
  };
}
function configureTransactChecks(mixedCreator = false) {
  const fixture = makeTransactProofFixture(false, mixedCreator);
  fixture.input.preparation.state.count = 5;
  for (const witness of [
    fixture.input.preparation.witness,
    fixture.creatorProvenance.noteWitness.witness,
  ]) {
    witness.checkpointIndex = 4;
    witness.continuity = require('./railgun-txid-omissions').classifyRailgunTxidContinuity(4, []);
  }
  const capsule = fixture.input.preparation.ownEvidence.capsule;
  mock.history.capture.capsule = clone(capsule);
  mock.history.capture.capsuleDigest =
    require('./railgun-private-capsule').digestRailgunPrivateCapsule(capsule);
  mock.fresh.capture = clone(mock.history.capture);
  mock.history.preparation = clone(fixture.input.preparation);
  mock.fresh.poiPreparation = clone(fixture.input.preparation);
  mock.fresh.witness = clone(fixture.input.preparation.witness);
  mock.fresh.creatorClassification.type = 'Transact';
  mock.fresh.txidPolicy = 'fixture-txid-policy';
  const origin = {
    blockNumber: 12,
    blockHash: '0x' + hex(123),
    transactionHash: '0x' + hex(124),
    logIndex: 0,
  };
  mock.fresh.observations.source = { checkpointHash: hex(125), creator: { origin } };
  mock.fresh.creatorProvenance = {
    ...fixture.creatorProvenance,
    publicIdentity: clone(mock.history.publicIdentity),
    txidPolicy: mock.fresh.txidPolicy,
    checkpointHash: hex(125),
    origin: clone(origin),
  };
}
test('fresh Transact checks bind retained creator and common checkpoint before the separate original roots', async () => {
  configureTransactChecks();
  const result = await run();
  expect(result.status).toBe('checked');
  expect(preflightRailgunRetainedPoiCompleted).toHaveBeenCalledTimes(1);
  expect(preflightRailgunRetainedPoiCompleted.mock.calls[0][0].sourceDestination).toBe(
    mock.destination
  );
  expect(createRailgunPoiRootSource).toHaveBeenCalledTimes(1);
  expect(createRailgunPoiTxidRootSource).toHaveBeenCalledTimes(1);
  expect(result).not.toHaveProperty('sourceOutcome');
});
test.each(
  [
    'type',
    'note',
    'identity',
    'policy',
    'checkpoint',
    'origin',
    'witness-root',
    'witness-count',
    'output-index',
    'not-before-own',
    'exit',
    'path',
    'events',
    'coverage-count',
    'coverage-omissions',
    'capsule',
  ].flatMap((fault) => [
    [fault, false],
    [fault, true],
  ])
)(
  'retained Transact checks %s mixed=%s mismatch refuses before either original-root request',
  async (fault, mixedCreator) => {
    configureTransactChecks(mixedCreator);
    const fresh = mock.fresh,
      provenance = fresh.creatorProvenance;
    if (fault === 'type') fresh.creatorClassification.type = 'Shield';
    if (fault === 'note') provenance.note.hash = '0x' + hex(777);
    if (fault === 'identity') provenance.publicIdentity = {};
    if (fault === 'policy') provenance.txidPolicy = 'other';
    if (fault === 'checkpoint') provenance.checkpointHash = hex(777);
    if (fault === 'origin') provenance.origin.logIndex++;
    if (fault === 'witness-root') provenance.noteWitness.witness.root = hex(777);
    if (fault === 'witness-count') provenance.noteWitness.witness.checkpointIndex--;
    if (fault === 'output-index') provenance.noteWitness.outputIndex = 1;
    if (fault === 'not-before-own') provenance.noteWitness.witness.index = fresh.witness.index;
    if (fault === 'exit') provenance.verification.utilityExitObserved = false;
    if (fault === 'path') provenance.verification.pathVerified = false;
    if (fault === 'events') provenance.verification.suppliedCreatorEventsMatched = false;
    if (fault === 'coverage-count') provenance.verification.coverage.matchedRows = 2;
    if (fault === 'coverage-omissions') provenance.verification.coverage.knownOmissions = 1;
    if (fault === 'capsule') fresh.poiPreparation.ownEvidence.capsule.noteHash = '0x' + hex(777);
    const result = await run();
    expect(createRailgunPoiRootSource).not.toHaveBeenCalled();
    expect(createRailgunPoiTxidRootSource).not.toHaveBeenCalled();
    expect(result.status).toBe('refused');
    expect(result.stage).toBe('history-binding');
  }
);
test('checks preserve bounded preflight refusal stage after cancellation without adding sourceOutcome', async () => {
  mock.preflight = async () => {
    mock.caller.abort();
    return {
      status: 'refused',
      stage: 'source:pending',
      sourceOutcome: { fatal: false, reason: 'pending', rpcFailure: null },
    };
  };
  expect(await run()).toEqual({ status: 'refused', stage: 'preflight:source:pending' });
  expect(createRailgunPoiRootSource).not.toHaveBeenCalled();
  expect(createRailgunPoiTxidRootSource).not.toHaveBeenCalled();
});
test('checks destination drift before roots refuses without a replacement observation', async () => {
  const original = mock.destination;
  mock.preflight = async () => {
    mock.destination = Object.freeze({});
    return clone(mock.fresh);
  };
  expect((await run()).status).toBe('refused');
  expect(preflightRailgunRetainedPoiCompleted.mock.calls[0][0].sourceDestination).toBe(original);
  expect(
    require('./railgun-account-public').getRailgunAccountPublicDestination
  ).toHaveBeenCalledTimes(1);
  expect(createRailgunPoiRootSource).not.toHaveBeenCalled();
  expect(createRailgunPoiTxidRootSource).not.toHaveBeenCalled();
});

test('pinned destination revocation invalidates downstream root contexts and issued checks', async () => {
  const result = await run();
  expect(result.status).toBe('checked');
  const handle = mock.roots.list.input.handle;
  expect(() => getPrivacyContext(handle)).not.toThrow();
  mock.destination = Object.freeze({});
  expect(() => getPrivacyContext(handle)).toThrow();
  expect(() => assertReceipt(result)).toThrow();
});

test.each(['missing', 'pending'])(
  'retained checks refuse %s completed source and allow a later independently completed source',
  async (reason) => {
    const complete = mock.preflight;
    mock.preflight = async () => ({
      status: 'refused',
      stage: 'source:' + reason,
      sourceOutcome: { fatal: false, reason, rpcFailure: null },
    });
    expect(await run()).toEqual({ status: 'refused', stage: 'preflight:source:' + reason });
    expect(createRailgunPoiRootSource).not.toHaveBeenCalled();
    expect(createRailgunPoiTxidRootSource).not.toHaveBeenCalled();
    mock.preflight = complete;
    expect((await run()).status).toBe('checked');
    expect(preflightRailgunRetainedPoiCompleted).toHaveBeenCalledTimes(2);
  }
);

test('mixed creator diagnostic reaches roots only through current mocked retained preflight', async () => {
  configureTransactChecks(true);
  const result = await run();
  expect(result.status).toBe('checked');
  expect(createRailgunPoiRootSource).toHaveBeenCalledTimes(1);
  expect(createRailgunPoiTxidRootSource).toHaveBeenCalledTimes(1);
  expect(result.rootAccepted).not.toBe(true);
});
test.each(['missing', 'false', 'copied-legacy', 'coverage-hash'])(
  'mixed creator %s verification refuses before either original root',
  async (fault) => {
    configureTransactChecks(true);
    const provenance = mock.fresh.creatorProvenance;
    if (fault === 'missing') delete provenance.verification.unshieldCommitmentVerified;
    if (fault === 'false') provenance.verification.unshieldCommitmentVerified = false;
    if (fault === 'copied-legacy')
      provenance.verification = clone(makeTransactProofFixture().creatorProvenance.verification);
    if (fault === 'coverage-hash')
      provenance.verification.coverage.unshieldCommitmentHashesChecked = true;
    expect(await run()).toMatchObject({ status: 'refused', stage: 'history-binding' });
    expect(createRailgunPoiRootSource).not.toHaveBeenCalled();
    expect(createRailgunPoiTxidRootSource).not.toHaveBeenCalled();
  }
);
