let mockRun, mockTask;
jest.mock('./railgun-session-worker', () => ({
  assertRailgunSessionWorker: (session, binding) => {
    if (!session.branded || binding.binding !== '8'.repeat(64)) throw new Error('unbranded');
  },
}));
jest.mock('./railgun-engine-runtime', () => ({ verifyRailgunEngineRuntime: (v) => v }));
jest.mock('./railgun-process', () => ({
  startRailgunProcess: (options) => {
    let resolve;
    const closed = new Promise((done) => {
      resolve = done;
    });
    mockTask = {
      ready: Promise.resolve().then(() => mockRun(options)),
      closed,
      close: jest.fn(() => resolve({ code: 'RAILGUN_PROCESS_CLOSED' })),
    };
    return mockTask;
  },
}));
const { createPrivacyScope } = require('../networks/privacy-context');
const { createRailgunTxidRunner } = require('./railgun-txid-runner');
const inventory = require('./railgun-engine-manifest.json').inventory.sha256;
let scope, runner, session, dispatch, seen, revision, observations;
beforeEach(() => {
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
      if (observations.get(value) !== revision) throw new Error('stale');
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
