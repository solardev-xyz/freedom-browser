let mockRun, mockTask, mockOptions, mockDeferExit;
jest.mock('./railgun-session-worker', () => ({
  assertRailgunSessionWorker: (session, binding) => {
    if (!session.branded || binding.binding !== '8'.repeat(64)) throw new Error('unbranded');
  },
}));
jest.mock('./railgun-engine-runtime', () => ({ verifyRailgunEngineRuntime: (v) => v }));
jest.mock('./railgun-process', () => ({
  startRailgunProcess: (options) => {
    mockOptions = options;
    let resolve;
    const closed = new Promise((done) => {
      resolve = done;
    });
    mockTask = {
      ready: Promise.resolve().then(() => mockRun(options)),
      closed,
      exit: (code = 'RAILGUN_PROCESS_CLOSED') => resolve({ code }),
      close: jest.fn(() => {
        if (!mockDeferExit) resolve({ code: 'RAILGUN_PROCESS_CLOSED' });
      }),
    };
    return mockTask;
  },
}));
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { createRailgunTxidRunner } = require('./railgun-txid-runner');
const inventory = require('./railgun-engine-manifest.json').inventory.sha256;
let scope, runner, session, dispatch, seen, revision, observations;
beforeEach(() => {
  mockDeferExit = false;
  mockOptions = undefined;
  mockTask = undefined;
  scope = createPrivacyScope({
    profileId: 'txid-runner-test',
    signal: new AbortController().signal,
  });
  const handle = scope.getContext({
    kind: 'private-account',
    principal: 'fixture',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'engine',
  });
  revision = 0;
  observations = new WeakMap();
  seen = [];
  const controller = new AbortController();
  dispatch = jest.fn(async (wire) => {
    revision++;
    const value = JSON.parse(wire);
    seen.push(value);
    return JSON.stringify({ id: value.id, value: null });
  });
  session = {
    branded: true,
    signal: controller.signal,
    claimDispatch: () => ({ dispatch }),
    close: jest.fn(() => controller.abort()),
    inspectWalletState: async () => {
      const value = {};
      observations.set(value, revision);
      return value;
    },
    assertFresh: (value) => {
      if (controller.signal.aborted || observations.get(value) !== revision)
        throw new Error('stale');
    },
  };
  runner = createRailgunTxidRunner({
    policy: '9'.repeat(64),
    handle,
    archive: '/engine.asar',
    session,
    filename: '/fixture/txid-' + '9'.repeat(64) + '.sqlite',
    binding: '8'.repeat(64),
  });
  mockRun = async ({ broker }) => {
    await broker.dispatch(JSON.stringify({ id: 1, method: 'input' }));
    await broker.dispatch(
      JSON.stringify({ id: 2, method: 'get', args: { key: 'dHhpZDpzdGF0ZQ==' } })
    );
    await broker.dispatch(
      JSON.stringify({
        id: 3,
        method: 'result',
        value: {
          state: { count: 1 },
          guards: { attempts: 0 },
          inventory,
        },
      })
    );
  };
});
afterEach(() => {
  runner.close();
  scope.close();
  jest.restoreAllMocks();
});
test('receipts bind input, runner identity and current store revision', async () => {
  const payload = { rows: [{ public: true }] };
  const result = await runner.run('project', payload);
  expect(runner.assertResult(result.receipt, 'project', payload)).toBe(result.value);
  expect(Object.isFrozen(result.value.state)).toBe(true);
  expect(() => runner.assertResult({}, 'project', payload)).toThrow();
  expect(() => runner.assertResult(result.receipt, 'apply', payload)).toThrow();
  expect(() => runner.assertResult(result.receipt, 'project', { rows: [] })).toThrow();
  await runner.run('inspect', {});
  expect(() => runner.assertResult(result.receipt, 'project', payload)).toThrow();
  expect(seen.map((value) => value.id)).toEqual([1, 2]);
  expect(mockTask.close).toHaveBeenCalled();
});
test.each(['txBegin', 'txStage', 'rpc', 'clear', 'batch'])(
  'read-only projection refuses %s',
  async (method) => {
    mockRun = async ({ broker }) => {
      await broker.dispatch(JSON.stringify({ id: 1, method: 'input' }));
      await broker.dispatch(JSON.stringify({ id: 2, method, args: {} }));
    };
    await expect(runner.run('project', {})).rejects.toMatchObject({
      code: 'RAILGUN_TXID_JOB_REFUSED',
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(session.close).toHaveBeenCalled();
    expect(mockTask.close).toHaveBeenCalled();
  }
);
test.each(['delete', 'wrong-id', 'early-result', 'guards', 'inventory'])(
  'rejects %s and drains the utility',
  async (mode) => {
    mockRun = async ({ broker }) => {
      if (mode !== 'early-result')
        await broker.dispatch(JSON.stringify({ id: 1, method: 'input' }));
      if (mode === 'delete')
        return broker.dispatch(
          JSON.stringify({
            id: 2,
            method: 'txStage',
            args: { transaction: 1, operations: [{ type: 'del', key: 'eA==' }] },
          })
        );
      return broker.dispatch(
        JSON.stringify({
          id: mode === 'wrong-id' ? 4 : mode === 'early-result' ? 1 : 2,
          method: 'result',
          value: {
            guards: { attempts: mode === 'guards' ? 1 : 0 },
            inventory: mode === 'inventory' ? 'a'.repeat(64) : inventory,
          },
        })
      );
    };
    await expect(runner.run('apply', {})).rejects.toThrow();
    expect(mockTask.close).toHaveBeenCalled();
    expect(session.close).toHaveBeenCalled();
  }
);
test('snapshots input before yielding and refuses simultaneous jobs without closing the first', async () => {
  let received;
  mockRun = async ({ broker }) => {
    received = JSON.parse(await broker.dispatch(JSON.stringify({ id: 1, method: 'input' }))).value;
    await broker.dispatch(
      JSON.stringify({ id: 2, method: 'result', value: { guards: { attempts: 0 }, inventory } })
    );
  };
  const payload = { rows: [1] },
    pending = runner.run('project', payload);
  payload.rows.push(2);
  await expect(runner.run('inspect', {})).rejects.toThrow();
  await pending;
  expect(received).toEqual({ rows: [1] });
  expect(session.close).not.toHaveBeenCalled();
});
test('a closed runner never accepts an old receipt or starts another job', async () => {
  const result = await runner.run('inspect', {});
  runner.close();
  expect(() => runner.assertResult(result.receipt, 'inspect', {})).toThrow();
  await expect(runner.run('inspect', {})).rejects.toThrow();
});
test.each(['open-transaction', 'foreign-namespace', 'wrong-transaction'])(
  'refuses %s even in an apply window',
  async (mode) => {
    dispatch.mockImplementation(async (wire) => {
      const v = JSON.parse(wire);
      return JSON.stringify({ id: v.id, value: v.method === 'txBegin' ? 7 : null });
    });
    mockRun = async ({ broker }) => {
      await broker.dispatch(JSON.stringify({ id: 1, method: 'input' }));
      await broker.dispatch(JSON.stringify({ id: 2, method: 'txBegin', args: {} }));
      if (mode === 'open-transaction')
        return broker.dispatch(
          JSON.stringify({ id: 3, method: 'result', value: { guards: { attempts: 0 }, inventory } })
        );
      return broker.dispatch(
        JSON.stringify({
          id: 3,
          method: 'txStage',
          args: {
            transaction: mode === 'wrong-transaction' ? 8 : 7,
            operations: [
              {
                type: 'put',
                key: Buffer.from(
                  mode === 'foreign-namespace' ? 'wallet:state' : 'txid:state'
                ).toString('base64'),
                value: 'eA==',
              },
            ],
          },
        })
      );
    };
    await expect(runner.run('apply', {})).rejects.toThrow();
    expect(session.close).toHaveBeenCalled();
  }
);
test('a public-store filename or unbranded worker is refused before dispatch is claimed', () => {
  const handle = scope.getContext({
    kind: 'private-account',
    principal: 'fixture',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'engine',
  });
  const claim = jest.fn();
  for (const [filename, branded] of [
    ['/fixture/public.sqlite', true],
    ['/fixture/txid.sqlite', true],
    ['/fixture/txid-' + 'a'.repeat(64) + '.sqlite', true],
    ['/fixture/txid-' + '9'.repeat(64) + '.sqlite', false],
  ])
    expect(() =>
      createRailgunTxidRunner({
        policy: '9'.repeat(64),
        handle,
        archive: '/engine.asar',
        filename,
        binding: '8'.repeat(64),
        session: { ...session, branded, claimDispatch: claim },
      })
    ).toThrow();
  expect(claim).not.toHaveBeenCalled();
});
test('coverage reads the complete bounded source before producing a branded result', async () => {
  const visit = jest.fn(async (visitor) => {
    await visitor({ public: 1 });
    await visitor({ public: 2 });
  });
  mockRun = async ({ broker }) => {
    await broker.dispatch(JSON.stringify({ id: 1, method: 'input' }));
    expect(
      JSON.parse(await broker.dispatch(JSON.stringify({ id: 2, method: 'sourceNext' }))).value
    ).toEqual([{ public: 1 }, { public: 2 }]);
    expect(
      JSON.parse(await broker.dispatch(JSON.stringify({ id: 3, method: 'sourceNext' }))).value
    ).toBeNull();
    await broker.dispatch(
      JSON.stringify({
        id: 4,
        method: 'result',
        value: { coverage: { checkedCount: 1 }, guards: { attempts: 0 }, inventory },
      })
    );
  };
  const payload = { state: {}, plan: {} };
  const result = await runner.run('coverage', payload, { visit, signal: scope.signal });
  expect(runner.assertResult(result.receipt, 'coverage', payload).coverage.checkedCount).toBe(1);
  expect(visit).toHaveBeenCalledTimes(1);
  expect(dispatch).not.toHaveBeenCalled();
});
test.each(['early-result', 'txBegin', 'late-ledger-failure'])(
  'coverage refuses %s and drains the source producer',
  async (mode) => {
    let finished = false;
    const visit = async (visitor) => {
      try {
        await visitor({ public: 1 });
        if (mode === 'late-ledger-failure') throw Error('ledger integrity');
      } finally {
        finished = true;
      }
    };
    mockRun = async ({ broker }) => {
      await broker.dispatch(JSON.stringify({ id: 1, method: 'input' }));
      if (mode === 'early-result')
        await broker.dispatch(
          JSON.stringify({ id: 2, method: 'result', value: { guards: { attempts: 0 }, inventory } })
        );
      else
        await broker.dispatch(
          JSON.stringify({
            id: 2,
            method: mode === 'txBegin' ? 'txBegin' : 'sourceNext',
            ...(mode === 'txBegin' ? { args: {} } : {}),
          })
        );
    };
    await expect(runner.run('coverage', {}, { visit, signal: scope.signal })).rejects.toThrow();
    expect(finished).toBe(true);
    expect(session.close).toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  }
);
test('non-coverage jobs cannot request the source or receive a source capability', async () => {
  const source = { visit: async () => {}, signal: scope.signal };
  await expect(runner.run('inspect', {}, source)).rejects.toThrow();
  mockRun = async ({ broker }) => {
    await broker.dispatch(JSON.stringify({ id: 1, method: 'input' }));
    await broker.dispatch(JSON.stringify({ id: 2, method: 'sourceNext' }));
  };
  await expect(runner.run('inspect', {})).rejects.toThrow();
});
test.each(['txBegin', 'sourceNext', 'rpc', 'batch'])(
  'note-witness refuses %s capabilities',
  async (method) => {
    mockRun = async ({ broker }) => {
      await broker.dispatch(JSON.stringify({ id: 1, method: 'input' }));
      await broker.dispatch(JSON.stringify({ id: 2, method, args: {} }));
    };
    await expect(runner.run('note-witness', { note: {}, state: {} })).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
    expect(session.close).toHaveBeenCalled();
  }
);
test('note-witness receipts bind the complete public selector and checkpoint', async () => {
  const payload = { note: { type: 'Transact', position: 1 }, state: { count: 2 } };
  const result = await runner.run('note-witness', payload);
  expect(runner.assertResult(result.receipt, 'note-witness', payload)).toBe(result.value);
  expect(() => runner.assertResult(result.receipt, 'witness', payload)).toThrow();
  expect(() =>
    runner.assertResult(result.receipt, 'note-witness', {
      ...payload,
      note: { ...payload.note, position: 2 },
    })
  ).toThrow();
});

const historicalPayload = () => ({
  state: { count: 5, root: '1'.repeat(64), transcript: '2'.repeat(64) },
  index: 1,
});
const historicalResult = (payload) => ({
  version: 1,
  tree: 0,
  index: payload.index,
  root: '0'.repeat(64),
  checkpointIndex: payload.state.count - 1,
  checkpointRoot: payload.state.root,
  transcript: payload.state.transcript,
  localPrefixComputed: true,
  globalTxidCompleteness: false,
  ownershipVerified: false,
  eventCoverageVerified: false,
  rootAccepted: false,
  spendingEnabled: false,
});
const waitUntil = async (predicate) => {
  for (let n = 0; n < 100 && !predicate(); n++) await Promise.resolve();
  expect(predicate()).toBe(true);
};
function installHistoricalRun() {
  mockRun = async ({ broker }) => {
    const input = JSON.parse(
      await broker.dispatch(JSON.stringify({ id: 1, method: 'input' }))
    ).value;
    await broker.dispatch(
      JSON.stringify({
        id: 2,
        method: 'get',
        args: { key: Buffer.from('txid:row:' + input.index).toString('base64') },
      })
    );
    await broker.dispatch(
      JSON.stringify({
        id: 3,
        method: 'result',
        value: { historicalRoot: historicalResult(input), guards: { attempts: 0 }, inventory },
      })
    );
  };
}
test('historical root gets a keyless exact context and brands only the captured checkpoint/index', async () => {
  installHistoricalRun();
  const payload = historicalPayload(),
    original = structuredClone(payload);
  const pending = runner.run('historical-root', payload);
  payload.index = 3;
  payload.state.root = '3'.repeat(64);
  const result = await pending;
  expect(JSON.parse(mockOptions.input)).toEqual({
    archive: '/engine.asar',
    mode: 'historical-root',
  });
  expect(mockOptions).not.toHaveProperty('binaryKey');
  expect(getPrivacyContext(mockOptions.handle).subject).toMatchObject({
    kind: 'private-account',
    role: 'engine',
    operation: 'txid-historical-root',
  });
  expect(runner.assertResult(result.receipt, 'historical-root', original).historicalRoot).toEqual(
    historicalResult(original)
  );
  expect(Object.isFrozen(result.value.historicalRoot)).toBe(true);
  expect(() => runner.assertResult(result.receipt, 'historical-root', payload)).toThrow();
  expect(() => runner.assertResult(result.receipt, 'witness', original)).toThrow();
  expect(() => runner.assertResult({}, 'historical-root', original)).toThrow();
  expect(seen).toEqual([
    { id: 1, method: 'get', args: { key: Buffer.from('txid:row:1').toString('base64') } },
  ]);
});
test.each([
  'txBegin',
  'txStage',
  'txCommit',
  'txAbort',
  'txRead',
  'sourceNext',
  'rpc',
  'batch',
  'getMany',
  'open',
  'next',
  'clear',
])('historical-root never admits %s to the borrowed store', async (method) => {
  mockRun = async ({ broker }) => {
    await broker.dispatch(JSON.stringify({ id: 1, method: 'input' }));
    await broker.dispatch(JSON.stringify({ id: 2, method, args: { transaction: 1 } }));
  };
  await expect(runner.run('historical-root', historicalPayload())).rejects.toMatchObject({
    code: 'RAILGUN_TXID_JOB_REFUSED',
  });
  expect(dispatch).not.toHaveBeenCalled();
  expect(mockTask.close).toHaveBeenCalled();
  expect(session.close).toHaveBeenCalled();
});
test('historical-root refuses a source capability before process creation', async () => {
  await expect(
    runner.run('historical-root', historicalPayload(), { visit: jest.fn(), signal: scope.signal })
  ).rejects.toThrow();
  expect(mockOptions).toBeUndefined();
  expect(session.close).not.toHaveBeenCalled();
});
test.each(['wallet:state', 'txid:row:-1', 'txid:row:../0', 'TXID:row:0'])(
  'historical-root refuses borrowed key %s',
  async (key) => {
    mockRun = async ({ broker }) => {
      await broker.dispatch(JSON.stringify({ id: 1, method: 'input' }));
      await broker.dispatch(
        JSON.stringify({ id: 2, method: 'get', args: { key: Buffer.from(key).toString('base64') } })
      );
    };
    await expect(runner.run('historical-root', historicalPayload())).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
  }
);
test('historical-root receipt cannot escape before actual process exit and authenticated observation', async () => {
  installHistoricalRun();
  mockDeferExit = true;
  const inspect = jest.spyOn(session, 'inspectWalletState');
  let settled = false;
  const pending = runner.run('historical-root', historicalPayload()).then((value) => {
    settled = true;
    return value;
  });
  try {
    await waitUntil(() => mockTask?.close.mock.calls.length > 0);
    expect(settled).toBe(false);
    expect(inspect).not.toHaveBeenCalled();
    await expect(runner.run('historical-root', historicalPayload())).rejects.toThrow();
    expect(session.close).not.toHaveBeenCalled();
    mockTask.exit();
    expect((await pending).value.historicalRoot.localPrefixComputed).toBe(true);
    expect(inspect).toHaveBeenCalledTimes(1);
  } finally {
    mockTask?.exit();
    await pending.catch(() => {});
  }
});
test('historical-root cancellation after result waits for child exit and refuses branding', async () => {
  installHistoricalRun();
  mockDeferExit = true;
  const inspect = jest.spyOn(session, 'inspectWalletState');
  const pending = runner.run('historical-root', historicalPayload());
  const refused = expect(pending).rejects.toMatchObject({ code: 'RAILGUN_TXID_JOB_REFUSED' });
  try {
    await waitUntil(() => mockTask?.close.mock.calls.length > 0);
    runner.close();
    let settled = false;
    pending.catch(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    mockTask.exit();
    await refused;
    expect(inspect).not.toHaveBeenCalled();
  } finally {
    mockTask?.exit();
    await refused;
  }
});
test('historical-root failed exit never brands a result', async () => {
  installHistoricalRun();
  mockDeferExit = true;
  const pending = runner.run('historical-root', historicalPayload());
  const refused = expect(pending).rejects.toThrow();
  await waitUntil(() => mockTask?.close.mock.calls.length > 0);
  mockTask.exit('RAILGUN_PROCESS_FAILED');
  await refused;
  expect(session.close).toHaveBeenCalled();
});
test('historical-root refuses a stale post-job store observation', async () => {
  installHistoricalRun();
  jest.spyOn(session, 'inspectWalletState').mockImplementation(async () => {
    const value = {};
    observations.set(value, revision - 1);
    return value;
  });
  await expect(runner.run('historical-root', historicalPayload())).rejects.toThrow();
  expect(session.close).toHaveBeenCalled();
});
test('historical-root drains an ignored borrowed read after close before run settles', async () => {
  installHistoricalRun();
  let finishRead, readStarted;
  const entered = new Promise((resolve) => {
    readStarted = resolve;
  });
  dispatch.mockImplementation(
    (wire) =>
      new Promise((resolve) => {
        readStarted();
        finishRead = () => resolve(JSON.stringify({ id: JSON.parse(wire).id, value: null }));
      })
  );
  let settled = false;
  const pending = runner.run('historical-root', historicalPayload());
  const refused = expect(pending).rejects.toThrow();
  pending.catch(() => {
    settled = true;
  });
  try {
    await entered;
    runner.close();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(dispatch).toHaveBeenCalledTimes(1);
    finishRead();
    await refused;
    expect(dispatch).toHaveBeenCalledTimes(1);
  } finally {
    finishRead?.();
    await refused;
  }
});

test.each(['forbidden-before-result', 'bad-result-then-valid', 'valid-result-then-bad'])(
  'historical-root broker refusal is permanent: %s',
  async (kind) => {
    mockRun = async ({ broker }) => {
      await broker.dispatch(JSON.stringify({ id: 1, method: 'input' }));
      const value = {
        historicalRoot: historicalResult(historicalPayload()),
        guards: { attempts: 0 },
        inventory,
      };
      if (kind === 'valid-result-then-bad') {
        await broker.dispatch(JSON.stringify({ id: 2, method: 'result', value }));
        await broker.dispatch(JSON.stringify({ id: 3, method: 'sourceNext' })).catch(() => {});
      } else {
        const bad =
          kind === 'forbidden-before-result'
            ? { id: 2, method: 'txBegin', args: {} }
            : { id: 2, method: 'result', value: { ...value, guards: { attempts: 1 } } };
        await broker.dispatch(JSON.stringify(bad)).catch(() => {});
        await broker.dispatch(JSON.stringify({ id: 3, method: 'result', value })).catch(() => {});
      }
    };
    await expect(runner.run('historical-root', historicalPayload())).rejects.toMatchObject({
      code: 'RAILGUN_TXID_JOB_REFUSED',
    });
    expect(session.close).toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  }
);
test.each(['expectedRoot', 'rows', 'source', 'payload'])(
  'historical-root payload rejects unexpected %s before process start',
  async (key) => {
    await expect(
      runner.run('historical-root', { ...historicalPayload(), [key]: 'oracle' })
    ).rejects.toThrow();
    expect(mockOptions).toBeUndefined();
  }
);

const legacyModes = ['inspect', 'project', 'apply', 'witness', 'note-witness', 'coverage'];
test.each(
  legacyModes.flatMap((mode) =>
    ['forbidden-before-result', 'bad-result-then-valid', 'valid-result-then-bad'].map((fault) => [
      mode,
      fault,
    ])
  )
)('%s permanently revokes broker refusal: %s', async (mode, fault) => {
  let immediatelyAborted,
    lateAccepted = false,
    firstAccepted = false;
  mockRun = async ({ broker }) => {
    let id = 1;
    await broker.dispatch(JSON.stringify({ id: id++, method: 'input' }));
    if (mode === 'coverage')
      await broker.dispatch(JSON.stringify({ id: id++, method: 'sourceNext' }));
    const value = { guards: { attempts: 0 }, inventory };
    if (fault === 'valid-result-then-bad') {
      await broker.dispatch(JSON.stringify({ id: id++, method: 'result', value }));
      firstAccepted = true;
    }
    const bad =
      fault === 'bad-result-then-valid'
        ? { id: id++, method: 'result', value: { ...value, guards: { attempts: 1 } } }
        : { id: id++, method: 'rpc', args: {} };
    const refusal = broker.dispatch(JSON.stringify(bad));
    immediatelyAborted = broker.signal.aborted;
    await refusal.catch(() => {});
    if (fault !== 'valid-result-then-bad')
      await broker.dispatch(JSON.stringify({ id, method: 'result', value })).then(
        () => {
          lateAccepted = true;
        },
        () => {}
      );
  };
  const source = mode === 'coverage' ? { visit: async () => {}, signal: scope.signal } : undefined;
  await expect(runner.run(mode, {}, source)).rejects.toMatchObject({
    code: 'RAILGUN_TXID_JOB_REFUSED',
  });
  expect(immediatelyAborted).toBe(true);
  expect(lateAccepted).toBe(false);
  expect(firstAccepted).toBe(fault === 'valid-result-then-bad');
  expect(session.close).toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
});
test('apply waits for an abandoned pending txCommit after refusal and never returns its late acknowledgment', async () => {
  let enterCommit,
    finishCommit,
    commitReplyAdmitted = false,
    settled = false;
  const entered = new Promise((resolve) => {
    enterCommit = resolve;
  });
  dispatch.mockImplementation(async (wire) => {
    const message = JSON.parse(wire);
    if (message.method === 'txBegin') return JSON.stringify({ id: message.id, value: 7 });
    if (message.method !== 'txCommit') throw Error('unexpected borrowed method');
    enterCommit();
    return new Promise((resolve) => {
      finishCommit = () => resolve(JSON.stringify({ id: message.id, value: null }));
    });
  });
  mockRun = async ({ broker }) => {
    await broker.dispatch(JSON.stringify({ id: 1, method: 'input' }));
    await broker.dispatch(JSON.stringify({ id: 2, method: 'txBegin', args: {} }));
    const commit = broker.dispatch(
      JSON.stringify({ id: 3, method: 'txCommit', args: { transaction: 7 } })
    );
    commit.then(
      () => {
        commitReplyAdmitted = true;
      },
      () => {}
    );
    await broker
      .dispatch(
        JSON.stringify({ id: 4, method: 'result', value: { guards: { attempts: 0 }, inventory } })
      )
      .catch(() => {});
    // Simulate child readiness/exit settling without waiting for borrowed commit.
  };
  const pending = runner.run('apply', {});
  const refused = expect(pending).rejects.toMatchObject({ code: 'RAILGUN_TXID_JOB_REFUSED' });
  pending.catch(() => {
    settled = true;
  });
  try {
    await entered;
    await waitUntil(
      () => session.close.mock.calls.length > 0 && mockTask.close.mock.calls.length > 0
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(commitReplyAdmitted).toBe(false);
    finishCommit();
    await refused;
    expect(commitReplyAdmitted).toBe(false);
    expect(dispatch.mock.calls.map(([wire]) => JSON.parse(wire).method)).toEqual([
      'txBegin',
      'txCommit',
    ]);
  } finally {
    finishCommit?.();
    await refused;
  }
});
test('coverage revokes an in-flight sourceNext and drains its ignored producer after child exit', async () => {
  let releaseProducer,
    sourceReplyAdmitted = false,
    afterRefusalAborted,
    settled = false,
    producerDone = false;
  const gate = new Promise((resolve) => {
    releaseProducer = resolve;
  });
  const visit = async (visitor) => {
    try {
      await visitor({ public: 1 });
      await gate;
    } finally {
      producerDone = true;
    }
  };
  mockRun = async ({ broker }) => {
    await broker.dispatch(JSON.stringify({ id: 1, method: 'input' }));
    const source = broker.dispatch(JSON.stringify({ id: 2, method: 'sourceNext' }));
    source.then(
      () => {
        sourceReplyAdmitted = true;
      },
      () => {}
    );
    const rejected = broker.dispatch(JSON.stringify({ id: 3, method: 'sourceNext' }));
    afterRefusalAborted = broker.signal.aborted;
    await rejected.catch(() => {});
  };
  const pending = runner.run('coverage', {}, { visit, signal: scope.signal });
  const refused = expect(pending).rejects.toMatchObject({ code: 'RAILGUN_TXID_JOB_REFUSED' });
  pending.catch(() => {
    settled = true;
  });
  try {
    await waitUntil(() => session.close.mock.calls.length > 0);
    await new Promise((resolve) => setImmediate(resolve));
    expect(afterRefusalAborted).toBe(true);
    expect(sourceReplyAdmitted).toBe(false);
    expect(settled).toBe(false);
    expect(producerDone).toBe(false);
    releaseProducer();
    await refused;
    expect(producerDone).toBe(true);
    expect(sourceReplyAdmitted).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  } finally {
    releaseProducer();
    await refused;
  }
});

test('coverage does not return a borrowed read after its independent source signal aborts', async () => {
  const sourceController = new AbortController();
  let releaseRead,
    enterRead,
    readReplyAdmitted = false;
  const entered = new Promise((resolve) => {
    enterRead = resolve;
  });
  dispatch.mockImplementation(
    (wire) =>
      new Promise((resolve) => {
        enterRead();
        releaseRead = () => resolve(JSON.stringify({ id: JSON.parse(wire).id, value: null }));
      })
  );
  mockRun = async ({ broker }) => {
    await broker.dispatch(JSON.stringify({ id: 1, method: 'input' }));
    await broker
      .dispatch(
        JSON.stringify({
          id: 2,
          method: 'get',
          args: { key: Buffer.from('txid:state').toString('base64') },
        })
      )
      .then(
        () => {
          readReplyAdmitted = true;
        },
        () => {}
      );
  };
  const pending = runner.run(
    'coverage',
    {},
    { visit: async () => {}, signal: sourceController.signal }
  );
  const refused = expect(pending).rejects.toMatchObject({ code: 'RAILGUN_TXID_JOB_REFUSED' });
  try {
    await entered;
    sourceController.abort();
    releaseRead();
    await refused;
    expect(readReplyAdmitted).toBe(false);
  } finally {
    releaseRead?.();
    await refused;
  }
});
