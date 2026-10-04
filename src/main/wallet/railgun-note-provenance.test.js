let mockMode, mockTask, mockExit, mockDeferExit, mockProtocol, mockScopeCloseFailure, mockHostScope;
jest.mock('../networks/privacy-context', () => {
  const actual = jest.requireActual('../networks/privacy-context');
  return {
    ...actual,
    createPrivacyScope: (...args) => {
      const scope = actual.createPrivacyScope(...args);
      if (!mockScopeCloseFailure) return scope;
      mockHostScope = scope;
      return Object.freeze({
        ...scope,
        close: () => {
          throw Error('PRIVATE scope close failure');
        },
      });
    },
  };
});
jest.mock('./railgun-engine-runtime', () => ({ verifyRailgunEngineRuntime: (v) => v }));
jest.mock('./railgun-process', () => ({
  startRailgunProcess: jest.fn((options) => {
    let finish, reject;
    const closed = new Promise((resolve) => {
      finish = resolve;
    });
    mockExit = () =>
      finish({ code: mockMode === 'crash' ? 'RAILGUN_PROCESS_FAILED' : 'RAILGUN_PROCESS_CLOSED' });
    mockTask = {
      closed,
      close: jest.fn(() => {
        if (!mockDeferExit) mockExit();
        reject?.(Error('closed'));
      }),
    };
    const wait = new Promise((_resolve, r) => {
      reject = r;
    });
    wait.catch(() => {});
    // The real supervisor abort listener calls its own stop closure, not the
    // returned facade. Keep facade failure injection separate from that path.
    const supervisorStop = mockTask.close.getMockImplementation();
    options.broker.signal.addEventListener('abort', supervisorStop, { once: true });
    mockTask.ready = Promise.resolve().then(async () => {
      if (mockMode === 'hang') return wait;
      const input = JSON.parse(options.input);
      const value = {
        inputSha256: require('crypto').createHash('sha256').update(options.input).digest('hex'),
        pathVerified: true,
        suppliedCreatorEventsMatched: true,
        ownershipVerified: false,
        eventSourceAuthenticated: false,
        rootAccepted: false,
        spendingEnabled: false,
        coverage: require('./railgun-txid-events').matchRailgunTxidEvents({
          blockNumber: input.note.blockNumber,
          txid: input.note.txid.slice(2),
          events: input.events,
          rows: [input.noteWitness.witness.row],
        }),
        guards: { attempts: 0, canaries: 1, hooks: ['test.guard'] },
        inventory: require('./railgun-engine-manifest.json').inventory.sha256,
      };
      if (mockMode === 'digest') value.inputSha256 = '0'.repeat(64);
      if (mockMode === 'inventory') value.inventory = '0'.repeat(64);
      if (mockMode === 'authority') value.spendingEnabled = true;
      if (mockMode === 'guards') value.guards.attempts = 1;
      if (mockMode === 'path') value.pathVerified = false;
      if (mockMode === 'coverage')
        value.coverage = { ...value.coverage, globalTxidCompleteness: true };
      const wire = JSON.stringify({
        id: 1,
        method: ['key', 'input', 'get', 'provider'].includes(mockMode) ? mockMode : 'result',
        value,
      });
      if (mockProtocol) return mockProtocol(options.broker, wire);
      if (mockMode === 'missing') return;
      await options.broker.dispatch(wire);
      if (mockMode === 'duplicate') await options.broker.dispatch(wire);
    });
    return mockTask;
  }),
}));
const { createHash } = require('crypto');
const { createPrivacyScope } = require('../networks/privacy-context');
const { createRailgunTxidProjection } = require('./railgun-txid-projection');
const { findRailgunNoteTxidWitness } = require('./railgun-txid-note-witness');
const { verifyRailgunNoteProvenance } = require('./railgun-note-provenance');
const { startRailgunProcess } = require('./railgun-process');
const hash = (s) => '0' + createHash('sha256').update(s).digest('hex').slice(1);
const pair = (a, b) => hash(a + b),
  zeros = [hash('zero')];
for (let n = 0; n < 16; n++) zeros.push(pair(zeros[n], zeros[n]));
let scope, controller, input;
beforeEach(async () => {
  jest.clearAllMocks();
  mockMode = 'valid';
  mockDeferExit = false;
  mockProtocol = undefined;
  mockScopeCloseFailure = false;
  mockHostScope = undefined;
  scope = createPrivacyScope({
    profileId: 'detached-fixture',
    signal: new AbortController().signal,
  });
  controller = new AbortController();
  const projection = createRailgunTxidProjection({
    hashPair: pair,
    zeroNodes: zeros,
    transactionHash: (r) => ({ hash: hash(JSON.stringify(r)), railgunTxid: hash(r.nullifiers[0]) }),
    verificationHash: () => '0x' + hash('verification'),
  });
  const row = {
    version: 'V2',
    graphID: '0x' + '1'.padStart(64, '0') + '0'.repeat(128),
    commitments: ['0x' + hash('commitment')],
    nullifiers: ['0x' + hash('nullifier')],
    boundParamsHash: '0x' + hash('params'),
    blockNumber: 1,
    txid: hash('ethereum'),
    timestamp: 1,
    utxoTreeIn: 0,
    utxoTreeOut: 0,
    utxoBatchStartPositionOut: 0,
    verificationHash: '0x' + hash('verification'),
  };
  const store = new Map(),
    read = async (k) => store.get(k) ?? null;
  const { state, writes } = await projection.append(projection.empty(), [row], read);
  writes.forEach(({ key, value }) => store.set(key, value));
  const note = {
    type: 'Transact',
    txid: '0x' + row.txid,
    hash: row.commitments[0],
    tree: 0,
    position: 0,
    blockNumber: 1,
  };
  input = {
    handle: scope.getContext({
      kind: 'private-account',
      principal: 'fixture',
      protocol: 'railgun',
      deployment: 'sepolia',
      chainId: 11155111,
      role: 'engine',
      operation: 'note-provenance',
    }),
    archive: '/engine.asar',
    state,
    note,
    noteWitness: await findRailgunNoteTxidWitness({ state, note, read, projection }),
    events: [
      { name: 'Nullified', logIndex: 1, tree: 0, values: row.nullifiers },
      { name: 'Transact', logIndex: 2, tree: 0, start: 0, hashes: row.commitments },
    ],
    signal: controller.signal,
  };
});
afterEach(() => {
  mockHostScope?.close();
  controller.abort();
  scope.close();
  jest.useRealTimers();
});
test('returns only immutable diagnostic evidence after exit, with no key/storage/provider channel', async () => {
  const result = await verifyRailgunNoteProvenance(input);
  expect(result).toMatchObject({
    pathVerified: true,
    suppliedCreatorEventsMatched: true,
    utilityExitObserved: true,
    spendingEnabled: false,
    eventSourceAuthenticated: false,
    rootAccepted: false,
    ownershipVerified: false,
    coverage: { globalTxidCompleteness: false },
  });
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.coverage)).toBe(true);
  expect(mockTask.close).toHaveBeenCalled();
  const options = startRailgunProcess.mock.calls[0][0];
  for (const field of ['binaryKey', 'storage', 'createProvider'])
    expect(options[field]).toBeUndefined();
  expect(Object.keys(JSON.parse(options.input)).sort()).toEqual([
    'archive',
    'events',
    'note',
    'noteWitness',
    'state',
  ]);
});
test.each([
  'key',
  'input',
  'get',
  'provider',
  'digest',
  'inventory',
  'authority',
  'guards',
  'path',
  'coverage',
  'missing',
  'duplicate',
  'crash',
])('refuses %s without leaving a utility alive', async (mode) => {
  mockMode = mode;
  await expect(verifyRailgunNoteProvenance(input)).rejects.toMatchObject({
    code: 'RAILGUN_NOTE_PROVENANCE_REFUSED',
  });
  expect(mockTask.close).toHaveBeenCalled();
});
test.each(['timeout', 'caller', 'parent'])(
  'drains observed exit after %s revocation',
  async (mode) => {
    jest.useFakeTimers();
    mockMode = 'hang';
    mockDeferExit = true;
    let settled = false;
    const pending = verifyRailgunNoteProvenance({ ...input, timeoutMs: 20 });
    const outcome = pending.catch((error) => {
      settled = true;
      return error;
    });
    await Promise.resolve();
    if (mode === 'timeout') await jest.advanceTimersByTimeAsync(21);
    if (mode === 'caller') controller.abort();
    if (mode === 'parent') scope.close();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockTask.close).toHaveBeenCalled();
    expect(settled).toBe(false);
    mockExit();
    expect(await outcome).toMatchObject({ code: 'RAILGUN_NOTE_PROVENANCE_REFUSED' });
  }
);
test('refuses mismatched note, extra creator events and oversize input before starting a process', async () => {
  await expect(
    verifyRailgunNoteProvenance({ ...input, note: { ...input.note, position: 1 } })
  ).rejects.toThrow();
  await expect(
    verifyRailgunNoteProvenance({
      ...input,
      events: [...input.events, { ...input.events[0], logIndex: 3 }],
    })
  ).rejects.toThrow();
  await expect(
    verifyRailgunNoteProvenance({ ...input, state: { ...input.state, extra: 'x'.repeat(65536) } })
  ).rejects.toThrow();
  expect(startRailgunProcess).not.toHaveBeenCalled();
});

// Deliberately suppress broker rejection in the mocked supervisor. These tests
// establish the host's own irrevocable refusal, not a live supervisor bypass.
const protocolCases = ['same-tick', 'next-tick', 'valid-then-bad'];
function exerciseRefusal(timing, fault, observed) {
  return async (broker, valid) => {
    const value = JSON.parse(valid);
    if (fault === 'digest') value.value.inputSha256 = '0'.repeat(64);
    if (fault === 'method') value.method = 'key';
    const invalid = fault === 'json' ? '{' : JSON.stringify(value);
    observed.signal = broker.signal;
    if (timing === 'valid-then-bad') {
      await broker.dispatch(valid);
      observed.initialAccepted = true;
    }
    const refused = broker.dispatch(invalid);
    observed.immediatelyAborted = broker.signal.aborted;
    const rejection = refused.then(
      () => {
        observed.invalidAccepted = true;
      },
      () => {
        observed.rejectionSeen = true;
      }
    );
    if (timing === 'next-tick') await new Promise((resolve) => setImmediate(resolve));
    if (timing !== 'valid-then-bad') {
      await broker.dispatch(valid).then(
        () => {
          observed.lateAccepted = true;
        },
        () => {
          observed.lateRefused = true;
        }
      );
    }
    await rejection;
    observed.driverFinished = true;
    // Return normally even after refusal; supervisor readiness is not trusted
    // to preserve the original failure in this adversarial host-boundary mock.
  };
}
test.each(
  protocolCases.flatMap((timing) => ['digest', 'method', 'json'].map((fault) => [timing, fault]))
)('permanently revokes %s %s refusal before supervisor reaction', async (timing, fault) => {
  const observed = {};
  mockProtocol = exerciseRefusal(timing, fault, observed);
  await expect(verifyRailgunNoteProvenance(input)).rejects.toMatchObject({
    code: 'RAILGUN_NOTE_PROVENANCE_REFUSED',
  });
  expect(observed.immediatelyAborted).toBe(true);
  expect(observed.rejectionSeen).toBe(true);
  expect(observed.invalidAccepted).not.toBe(true);
  expect(observed.driverFinished).toBe(true);
  if (timing === 'valid-then-bad') expect(observed.initialAccepted).toBe(true);
  else {
    expect(observed.lateAccepted).not.toBe(true);
    expect(observed.lateRefused).toBe(true);
  }
  expect(mockTask.close).toHaveBeenCalled();
});
test.each(protocolCases)(
  'retains %s refusal until the actual delayed process exit',
  async (timing) => {
    const observed = {};
    mockDeferExit = true;
    mockProtocol = exerciseRefusal(timing, 'digest', observed);
    let settled = false;
    const pending = verifyRailgunNoteProvenance(input).then(
      (value) => {
        settled = true;
        return { value };
      },
      (error) => {
        settled = true;
        return { error };
      }
    );
    try {
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(observed.driverFinished).toBe(true);
      expect(observed.immediatelyAborted).toBe(true);
      expect(observed.signal.aborted).toBe(true);
      expect(mockTask.close).toHaveBeenCalled();
      expect(settled).toBe(false);
      mockExit();
      expect(await pending).toMatchObject({
        error: { code: 'RAILGUN_NOTE_PROVENANCE_REFUSED' },
      });
    } finally {
      mockExit();
      await pending;
    }
  }
);

const observedTurn = () => new Promise((resolve) => setImmediate(resolve));
const sanitizedRefusal = {
  code: 'RAILGUN_NOTE_PROVENANCE_REFUSED',
  message: 'Railgun note provenance unavailable',
};
test.each(['success-close', 'refusal-cleanup'])(
  'throwing %s cannot skip scope revocation or delayed exit drain',
  async (point) => {
    mockDeferExit = true;
    if (point === 'refusal-cleanup') mockMode = 'missing';
    let settled = false;
    const pending = verifyRailgunNoteProvenance(input).then(
      (value) => {
        settled = true;
        return { value };
      },
      (error) => {
        settled = true;
        return { error };
      }
    );
    const ordinaryClose = mockTask.close.getMockImplementation();
    if (point === 'success-close')
      mockTask.close
        .mockImplementationOnce(() => {
          throw Error('PRIVATE explicit success close failure');
        })
        .mockImplementation(ordinaryClose);
    else
      mockTask.close.mockImplementation(() => {
        throw Error('PRIVATE explicit cleanup close failure');
      });
    try {
      await observedTurn();
      await observedTurn();
      expect(mockTask.close).toHaveBeenCalled();
      expect(startRailgunProcess.mock.calls[0][0].broker.signal.aborted).toBe(true);
      expect(settled).toBe(false);
      mockExit();
      expect(await pending).toMatchObject({ error: sanitizedRefusal });
    } finally {
      mockExit();
      await pending;
    }
  }
);
test.each(['valid', 'missing'])(
  'rejecting closed after %s readiness returns only sanitized refusal',
  async (mode) => {
    mockMode = mode;
    const pending = verifyRailgunNoteProvenance(input);
    const outcome = pending.then(
      (value) => ({ value }),
      (error) => ({ error })
    );
    mockTask.closed = Promise.reject(Error('PRIVATE close diagnostic'));
    mockTask.closed.catch(() => {});
    expect(await outcome).toMatchObject({ error: sanitizedRefusal });
    expect(startRailgunProcess.mock.calls[0][0].broker.signal.aborted).toBe(true);
    expect(mockTask.close).toHaveBeenCalled();
  }
);
test('valid diagnostic waits for observed exit before returning immutable evidence', async () => {
  mockDeferExit = true;
  let settled = false;
  const pending = verifyRailgunNoteProvenance(input).then((result) => {
    settled = true;
    return result;
  });
  try {
    await observedTurn();
    await observedTurn();
    expect(mockTask.close).toHaveBeenCalled();
    expect(settled).toBe(false);
    mockExit();
    const result = await pending;
    expect(result).toMatchObject({
      pathVerified: true,
      utilityExitObserved: true,
      ownershipVerified: false,
      eventSourceAuthenticated: false,
      rootAccepted: false,
      spendingEnabled: false,
    });
    expect(Object.isFrozen(result)).toBe(true);
  } finally {
    mockExit();
    await pending;
  }
});

test.each(['caller', 'parent', 'timeout'])(
  '%s revocation contains throwing close without skipping delayed exit',
  async (point) => {
    jest.useFakeTimers();
    mockMode = 'hang';
    mockDeferExit = true;
    let settled = false;
    const pending = verifyRailgunNoteProvenance({ ...input, timeoutMs: 20 }).then(
      (value) => {
        settled = true;
        return { value };
      },
      (error) => {
        settled = true;
        return { error };
      }
    );
    mockTask.close.mockImplementation(() => {
      throw Error('PRIVATE close from revocation failure');
    });
    try {
      await Promise.resolve();
      if (point === 'caller') controller.abort();
      if (point === 'parent') scope.close();
      if (point === 'timeout') await jest.advanceTimersByTimeAsync(21);
      for (let turn = 0; turn < 20; turn++) await Promise.resolve();
      expect(startRailgunProcess.mock.calls[0][0].broker.signal.aborted).toBe(true);
      expect(mockTask.close).toHaveBeenCalled();
      expect(settled).toBe(false);
      mockExit();
      expect(await pending).toMatchObject({ error: sanitizedRefusal });
    } finally {
      mockExit();
      await pending;
    }
  }
);
test('throwing scope close still closes the task and awaits its observed exit', async () => {
  mockScopeCloseFailure = true;
  mockMode = 'missing';
  mockDeferExit = true;
  let settled = false;
  const pending = verifyRailgunNoteProvenance(input).then(
    (value) => {
      settled = true;
      return { value };
    },
    (error) => {
      settled = true;
      return { error };
    }
  );
  try {
    await observedTurn();
    await observedTurn();
    expect(mockHostScope).toBeDefined();
    expect(mockTask.close).toHaveBeenCalled();
    expect(settled).toBe(false);
    await expect(startRailgunProcess.mock.calls[0][0].broker.dispatch('{}')).rejects.toMatchObject(
      sanitizedRefusal
    );
    mockExit();
    expect(await pending).toMatchObject({ error: sanitizedRefusal });
  } finally {
    mockExit();
    await pending;
  }
});
