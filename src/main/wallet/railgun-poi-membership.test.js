let mockEndpoint, mockJobMode, mockExit, mockReleaseJob;
const mockRequest = jest.fn(),
  mockTransportClose = jest.fn(),
  mockStart = jest.fn();
jest.mock('../networks/wallet-tor-transport', () => ({
  createWalletTorTransport: () => ({ request: mockRequest, close: mockTransportClose }),
}));
jest.mock('../tor-manager', () => ({ getWalletSocksEndpoint: () => mockEndpoint }));
jest.mock('../settings-store', () => ({ isWalletTorExperimentAvailable: () => true }));
jest.mock('./railgun-process', () => ({ startRailgunProcess: (...args) => mockStart(...args) }));
jest.mock('./railgun-engine-runtime', () => ({ verifyRailgunEngineRuntime: (v) => v }));
const { createPrivacyScope } = require('../networks/privacy-context');
const { createRailgunPoiSource, assertRailgunPoiSource } = require('./railgun-poi-source');
const {
  verifyRailgunPoiMembership,
  assertRailgunPoiMembership,
} = require('./railgun-poi-membership');
const { REQUIRED_LIST } = require('./railgun-poi-records');
const inventory = require('./railgun-engine-manifest.json').inventory.sha256;
const events = require('../../../scripts/fixtures/railgun-poi-signed-event.json');
const notes = [{ blindedCommitment: events[0].signedPOIEvent.blindedCommitment, type: 'Shield' }];
const proof = {
  leaf: notes[0].blindedCommitment.slice(2),
  elements: Array(16).fill('0'.repeat(64)),
  indices: '0'.repeat(64),
  root: '1'.repeat(64),
};
const subject = {
  kind: 'private-account',
  principal: 'railgun:0',
  protocol: 'railgun',
  deployment: 'sepolia',
  chainId: 11155111,
  role: 'poi',
  operation: 'poi:' + 'a'.repeat(64),
};
let scope, handle, source, accepted, replyStatus;
beforeEach(() => {
  jest.clearAllMocks();
  mockTransportClose.mockReset();
  mockJobMode = null;
  mockExit = undefined;
  mockReleaseJob = undefined;
  accepted = true;
  replyStatus = 'Valid';
  mockEndpoint = { signal: new AbortController().signal };
  scope = createPrivacyScope({
    profileId: 'membership-test',
    signal: new AbortController().signal,
  });
  handle = scope.getContext(subject);
  mockRequest.mockImplementation(async (_h, _u, options) => {
    const body = JSON.parse(options.body);
    const result =
      body.method === 'ppoi_pois_per_list'
        ? { [notes[0].blindedCommitment]: { [REQUIRED_LIST]: replyStatus } }
        : body.method === 'ppoi_merkle_proofs'
          ? [proof]
          : body.method === 'ppoi_poi_events'
            ? events
            : accepted;
    return {
      status: 200,
      body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: body.id, result })),
    };
  });
  source = createRailgunPoiSource({ handle, notes });
  mockStart.mockImplementation(({ broker }) => {
    const closed = new Promise((resolve) => {
      mockExit = () => resolve({ code: 'RAILGUN_PROCESS_CLOSED' });
    });
    const close = jest.fn(() => {
      if (mockJobMode !== 'drain') mockExit();
    });
    const ready = Promise.resolve().then(async () => {
      const input = JSON.parse(await broker.dispatch(JSON.stringify({ id: 1, method: 'input' })));
      if (mockJobMode === 'drain')
        await new Promise((resolve) => {
          mockReleaseJob = resolve;
        });
      const value = { proofs: input.value.proofs, guards: { attempts: 0 }, inventory };
      if (mockJobMode === 'proof') value.proofs[0].root = '2'.repeat(64);
      if (mockJobMode === 'inventory') value.inventory = '0'.repeat(64);
      if (mockJobMode === 'egress') value.guards.attempts = 1;
      await broker.dispatch(
        JSON.stringify({ id: mockJobMode === 'sequence' ? 3 : 2, method: 'result', value })
      );
    });
    return { ready, close, closed };
  });
});
afterEach(() => {
  mockTransportClose.mockReset();
  source.close();
  scope.close();
});
async function run(receipt) {
  return verifyRailgunPoiMembership({ handle, source, receipt, archive: '/fixture/engine.asar' });
}
test('membership receipt binds genuine service evidence, and source refresh or closure revokes it', async () => {
  const observed = await source.acquire(),
    checked = await run(observed.receipt);
  expect(checked.observation).toMatchObject({
    rootsAccepted: true,
    membershipVerified: true,
    spendingEnabled: false,
  });
  expect(assertRailgunPoiMembership(checked.receipt, handle)).toBe(checked.observation);
  expect(() => assertRailgunPoiMembership({}, handle)).toThrow();
  await source.acquire();
  expect(() => assertRailgunPoiMembership(checked.receipt, handle)).toThrow();
});
test('negative/missing service results never start a membership utility', async () => {
  accepted = false;
  let observed = await source.acquire();
  await expect(run(observed.receipt)).rejects.toThrow();
  replyStatus = 'Missing';
  observed = await source.acquire();
  await expect(run(observed.receipt)).rejects.toThrow();
  expect(mockStart).not.toHaveBeenCalled();
});
test('a window can only shorten the membership worker budget and margin inherits source age', async () => {
  const observed = await source.acquire();
  const checked = await verifyRailgunPoiMembership({
    handle,
    source,
    receipt: observed.receipt,
    archive: '/fixture/engine.asar',
    timeoutMs: 1234,
  });
  expect(mockStart.mock.calls[0][0]).toMatchObject({ startupMs: 1234, lifetimeMs: 1234 });
  expect(assertRailgunPoiMembership(checked.receipt, handle, 1000)).toBe(checked.observation);
  for (const timeoutMs of [0, -1, 0.5, 180001, NaN])
    await expect(
      verifyRailgunPoiMembership({
        handle,
        source,
        receipt: observed.receipt,
        archive: '/fixture/engine.asar',
        timeoutMs,
      })
    ).rejects.toThrow();
  expect(() => assertRailgunPoiMembership(checked.receipt, handle, 60000)).toThrow();
  expect(mockStart).toHaveBeenCalledTimes(1);
});
test.each(['proof', 'inventory', 'egress', 'sequence'])(
  'bad utility %s cannot issue evidence',
  async (mode) => {
    mockJobMode = mode;
    const observed = await source.acquire();
    await expect(run(observed.receipt)).rejects.toThrow('Railgun POI membership unavailable');
    expect(source.signal.aborted).toBe(true);
  }
);
test('revocation waits for actual utility exit before returning failure', async () => {
  mockJobMode = 'drain';
  const observed = await source.acquire();
  let settled = false;
  const pending = run(observed.receipt).finally(() => {
    settled = true;
  });
  const refused = expect(pending).rejects.toThrow();
  for (let n = 0; n < 10 && !mockReleaseJob; n++) await Promise.resolve();
  expect(mockReleaseJob).toBeDefined();
  source.close();
  mockReleaseJob();
  for (let n = 0; n < 10; n++) await Promise.resolve();
  expect(settled).toBe(false);
  mockExit();
  await refused;
});
test('forged source, foreign operation, profile generation and receipts refuse before compute', async () => {
  const observed = await source.acquire();
  expect(() => assertRailgunPoiSource({ ...source }, handle)).toThrow();
  expect(() =>
    assertRailgunPoiSource(
      source,
      scope.getContext({ ...subject, operation: 'poi:' + 'b'.repeat(64) })
    )
  ).toThrow();
  const other = createPrivacyScope({
    profileId: 'membership-test',
    signal: new AbortController().signal,
  });
  expect(() => assertRailgunPoiSource(source, other.getContext(subject))).toThrow();
  other.close();
  await expect(run({})).rejects.toThrow();
  await expect(
    verifyRailgunPoiMembership({
      handle,
      source: { ...source },
      receipt: observed.receipt,
      archive: '/fixture/engine.asar',
    })
  ).rejects.toThrow();
  expect(mockStart).not.toHaveBeenCalled();
});

const turn = () => new Promise((resolve) => setImmediate(resolve));
const gate = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const membershipRefusal = {
  code: 'RAILGUN_POI_MEMBERSHIP_REFUSED',
  message: 'Railgun POI membership unavailable',
};
function adversarialTask(
  protocol,
  { delayedExit = false, throwingClose = false, rejectedClose = false } = {}
) {
  const state = {};
  mockStart.mockImplementation(({ broker }) => {
    state.broker = broker;
    const exit = gate();
    state.exit = exit.resolve;
    state.task = {
      close: jest.fn(() => {
        if (throwingClose) throw Error('PRIVATE task close diagnostic');
        if (!delayedExit) exit.resolve({ code: 'RAILGUN_PROCESS_CLOSED' });
      }),
      closed: rejectedClose
        ? Promise.reject(Error('PRIVATE task closed diagnostic'))
        : exit.promise,
      ready: Promise.resolve().then(async () => {
        const input = JSON.parse(await broker.dispatch(JSON.stringify({ id: 1, method: 'input' })));
        const value = { proofs: input.value.proofs, guards: { attempts: 0 }, inventory };
        await protocol(broker, value, state);
        state.driverFinished = true;
      }),
    };
    state.task.closed.catch(() => {});
    return state.task;
  });
  return state;
}
function refusingProtocol(order, fault) {
  return async (broker, value, state) => {
    const valid = (id) => JSON.stringify({ id, method: 'result', value });
    if (order === 'valid-then-bad') {
      await broker.dispatch(valid(2));
      state.initialAccepted = true;
    }
    const malformed = JSON.parse(valid(order === 'valid-then-bad' ? 3 : 2));
    if (fault === 'method') malformed.method = 'key';
    if (fault === 'proof') malformed.value.proofs[0].root = '2'.repeat(64);
    const rejected = broker.dispatch(fault === 'json' ? '{' : JSON.stringify(malformed));
    state.immediatelyAborted = broker.signal.aborted;
    const observed = rejected.then(
      () => {
        state.badAccepted = true;
      },
      () => {
        state.refusalSeen = true;
      }
    );
    if (order === 'next-turn') await turn();
    if (order !== 'valid-then-bad') {
      await broker.dispatch(valid(fault === 'json' ? 2 : 3)).then(
        () => {
          state.lateAccepted = true;
        },
        () => {
          state.lateRefused = true;
        }
      );
    }
    await observed;
    // This deliberately suppresses supervisor error handling. The host must
    // remember the refusal even when a mock utility reports healthy readiness.
  };
}
test.each(
  ['same-turn', 'next-turn', 'valid-then-bad'].flatMap((order) =>
    ['json', 'method', 'proof'].map((fault) => [order, fault])
  )
)('membership broker permanently refuses swallowed %s %s failure', async (order, fault) => {
  const observed = await source.acquire();
  const state = adversarialTask(refusingProtocol(order, fault));
  await expect(run(observed.receipt)).rejects.toMatchObject(membershipRefusal);
  expect(state.immediatelyAborted).toBe(true);
  expect(state.refusalSeen).toBe(true);
  expect(state.badAccepted).not.toBe(true);
  expect(state.driverFinished).toBe(true);
  if (order === 'valid-then-bad') expect(state.initialAccepted).toBe(true);
  else {
    expect(state.lateAccepted).not.toBe(true);
    expect(state.lateRefused).toBe(true);
  }
  expect(source.signal.aborted).toBe(true);
  expect(state.task.close).toHaveBeenCalled();
});
test('duplicate result remains fatal even when the supervisor swallows its rejection', async () => {
  const observed = await source.acquire();
  const state = adversarialTask(async (broker, value, seen) => {
    await broker.dispatch(JSON.stringify({ id: 2, method: 'result', value }));
    await broker.dispatch(JSON.stringify({ id: 3, method: 'result', value })).catch(() => {
      seen.duplicateRefused = true;
    });
  });
  await expect(run(observed.receipt)).rejects.toMatchObject(membershipRefusal);
  expect(state.duplicateRefused).toBe(true);
  expect(state.driverFinished).toBe(true);
});
test.each(['same-turn', 'next-turn', 'valid-then-bad'])(
  'swallowed %s refusal retains the operation until utility closure',
  async (order) => {
    const observed = await source.acquire();
    const state = adversarialTask(refusingProtocol(order, 'json'), { delayedExit: true });
    let settled = false;
    const pending = run(observed.receipt).then(
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
      await turn();
      await turn();
      expect(state.driverFinished).toBe(true);
      expect(state.task.close).toHaveBeenCalled();
      expect(settled).toBe(false);
      state.exit({ code: 'RAILGUN_PROCESS_CLOSED' });
      expect(await pending).toMatchObject({ error: membershipRefusal });
    } finally {
      state.exit({ code: 'RAILGUN_PROCESS_CLOSED' });
      await pending;
    }
  }
);
test.each(['valid', 'refused'])(
  'throwing task close after %s readiness cannot skip actual utility exit',
  async (mode) => {
    const observed = await source.acquire();
    const protocol =
      mode === 'valid'
        ? async (broker, value) =>
            broker.dispatch(JSON.stringify({ id: 2, method: 'result', value }))
        : refusingProtocol('same-turn', 'json');
    const state = adversarialTask(protocol, { delayedExit: true, throwingClose: true });
    let settled = false;
    const pending = run(observed.receipt).then(
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
      await turn();
      await turn();
      expect(state.task.close).toHaveBeenCalled();
      expect(settled).toBe(false);
      state.exit({ code: 'RAILGUN_PROCESS_CLOSED' });
      expect(await pending).toMatchObject({ error: membershipRefusal });
    } finally {
      state.exit({ code: 'RAILGUN_PROCESS_CLOSED' });
      await pending;
    }
  }
);
test.each(['valid', 'refused'])(
  'rejected utility closure after %s readiness yields sanitized refusal',
  async (mode) => {
    const observed = await source.acquire();
    const protocol =
      mode === 'valid'
        ? async (broker, value) =>
            broker.dispatch(JSON.stringify({ id: 2, method: 'result', value }))
        : refusingProtocol('same-turn', 'json');
    const state = adversarialTask(protocol, { rejectedClose: true });
    await expect(run(observed.receipt)).rejects.toMatchObject(membershipRefusal);
    expect(state.task.close).toHaveBeenCalled();
    expect(source.signal.aborted).toBe(true);
  }
);
test('healthy membership receipt is issued only after delayed utility exit and remains current', async () => {
  const observed = await source.acquire();
  const state = adversarialTask(
    async (broker, value) => broker.dispatch(JSON.stringify({ id: 2, method: 'result', value })),
    { delayedExit: true }
  );
  let settled = false;
  const pending = run(observed.receipt).then((value) => {
    settled = true;
    return value;
  });
  try {
    await turn();
    await turn();
    expect(state.task.close).toHaveBeenCalled();
    expect(settled).toBe(false);
    expect(source.signal.aborted).toBe(false);
    state.exit({ code: 'RAILGUN_PROCESS_CLOSED' });
    const result = await pending;
    expect(Object.isFrozen(result.observation)).toBe(true);
    expect(result.observation).toMatchObject({ membershipVerified: true, spendingEnabled: false });
    expect(assertRailgunPoiMembership(result.receipt, handle)).toBe(result.observation);
    expect(source.signal.aborted).toBe(false);
  } finally {
    state.exit({ code: 'RAILGUN_PROCESS_CLOSED' });
    await pending;
  }
});
test.each(['source', 'parent'])(
  '%s abort callback contains throwing task close and still waits for exit',
  async (owner) => {
    const observed = await source.acquire();
    const release = gate(),
      entered = gate();
    const state = adversarialTask(
      async () => {
        entered.resolve();
        await release.promise;
      },
      { delayedExit: true, throwingClose: true }
    );
    let settled = false;
    const pending = run(observed.receipt).then(
      (value) => {
        settled = true;
        return { value };
      },
      (error) => {
        settled = true;
        return { error };
      }
    );
    await entered.promise;
    try {
      expect(() => (owner === 'source' ? source.close() : scope.close())).not.toThrow();
      await turn();
      expect(state.broker.signal.aborted).toBe(true);
      expect(state.task.close).toHaveBeenCalled();
      expect(settled).toBe(false);
      release.resolve();
      await turn();
      expect(settled).toBe(false);
      state.exit({ code: 'RAILGUN_PROCESS_CLOSED' });
      expect(await pending).toMatchObject({ error: membershipRefusal });
    } finally {
      release.resolve();
      state.exit({ code: 'RAILGUN_PROCESS_CLOSED' });
      await pending;
    }
  }
);
test('source cleanup throwing after revocation cannot skip task closure or expose its diagnostic', async () => {
  const observed = await source.acquire();
  const state = adversarialTask(refusingProtocol('same-turn', 'json'), { delayedExit: true });
  mockTransportClose.mockImplementation(() => {
    throw Error('PRIVATE source transport close diagnostic');
  });
  let settled = false;
  const pending = run(observed.receipt).then(
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
    await turn();
    await turn();
    expect(state.task.close).toHaveBeenCalled();
    expect(source.signal.aborted).toBe(true);
    expect(settled).toBe(false);
    state.exit({ code: 'RAILGUN_PROCESS_CLOSED' });
    expect(await pending).toMatchObject({ error: membershipRefusal });
  } finally {
    state.exit({ code: 'RAILGUN_PROCESS_CLOSED' });
    await pending;
  }
});

test('synchronous startup refusal closes the subsequently returned task and drains its exit', async () => {
  const observed = await source.acquire();
  const exit = gate();
  let task, immediatelyAborted;
  mockStart.mockImplementation(({ broker }) => {
    // A hostile supervisor can invoke the broker before returning its task.
    // The host must remember to close that task once it actually exists.
    void broker.dispatch('{').catch(() => {});
    immediatelyAborted = broker.signal.aborted;
    task = { ready: Promise.resolve(), closed: exit.promise, close: jest.fn() };
    return task;
  });
  let settled = false;
  const pending = run(observed.receipt).then(
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
    await turn();
    expect(immediatelyAborted).toBe(true);
    expect(task.close).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    exit.resolve({ code: 'RAILGUN_PROCESS_CLOSED' });
    expect(await pending).toMatchObject({ error: membershipRefusal });
  } finally {
    exit.resolve({ code: 'RAILGUN_PROCESS_CLOSED' });
    await pending;
  }
});
test('a caught but unawaited malformed broker call after valid result cannot publish a receipt', async () => {
  const observed = await source.acquire();
  const state = adversarialTask(async (broker, value) => {
    await broker.dispatch(JSON.stringify({ id: 2, method: 'result', value }));
    // The supervisor observes rejection but neither awaits nor propagates it.
    void broker.dispatch('{').catch(() => {});
  });
  await expect(run(observed.receipt)).rejects.toMatchObject(membershipRefusal);
  expect(state.driverFinished).toBe(true);
  expect(state.task.close).toHaveBeenCalled();
});
