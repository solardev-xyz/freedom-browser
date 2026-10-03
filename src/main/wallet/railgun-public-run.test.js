let mockRun, mockOptions, mockTask;
jest.mock('./railgun-engine-runtime', () => ({ verifyRailgunEngineRuntime: (v) => v }));
jest.mock('./railgun-process', () => ({
  startRailgunProcess: (options) => {
    mockOptions = options;
    let finish;
    const closed = new Promise((resolve) => {
      finish = resolve;
    });
    return (mockTask = {
      ready: Promise.resolve().then(() => mockRun(options)),
      closed,
      close: jest.fn(() => finish({ code: 'RAILGUN_PROCESS_CLOSED' })),
    });
  },
}));
const { createPrivacyScope } = require('../networks/privacy-context');
const { createRailgunPublicJobs, createFeed } = require('./railgun-public-run');
let scope, jobs, query, capability, seen;
beforeEach(() => {
  scope = createPrivacyScope({
    profileId: 'public-run-test',
    signal: new AbortController().signal,
  });
  const handle = scope.getContext({
    kind: 'private-account',
    principal: 'railgun:0',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'engine',
  });
  jobs = createRailgunPublicJobs({ handle, archive: '/engine.asar' });
  query = { range: { storeId: 'a'.repeat(64) } };
  seen = [];
  capability = {
    signal: scope.signal,
    visit: async (consume) => {
      for (let n = 0; n < 300; n++) await consume({ public: n });
    },
  };
  mockRun = async ({ broker }) => {
    let id = 0;
    while (true) {
      const { value } = JSON.parse(
        await broker.dispatch(JSON.stringify({ id: ++id, method: 'sourceNext' }))
      );
      if (value === null) break;
      seen.push(value);
    }
    await broker.dispatch(
      JSON.stringify({
        id: id + 1,
        method: 'jobResult',
        value: { state: { public: true }, guards: { attempts: 0 } },
      })
    );
  };
});
afterEach(() => {
  scope.close();
});
test.each(['txRead', 'rpc', 'clear'])(
  'apply allows transaction reads but refuses direct %s egress/clearing',
  async (method) => {
    const dispatch = jest.fn(async (wire) => {
      const message = JSON.parse(wire);
      expect(message.id).toBe(1);
      expect(message.method).toBe('txRead');
      return JSON.stringify({ id: 1, value: null });
    });
    mockRun = async ({ broker }) => {
      let id = 0;
      while (
        JSON.parse(await broker.dispatch(JSON.stringify({ id: ++id, method: 'sourceNext' })))
          .value !== null
      ) {
        /* Drain public feed. */
      }
      const reply = JSON.parse(
        await broker.dispatch(
          JSON.stringify({ id: ++id, method, args: { transaction: 1, method: 'get', args: {} } })
        )
      );
      expect(reply.id).toBe(id);
      await broker.dispatch(
        JSON.stringify({ id: id + 1, method: 'jobResult', value: { guards: { attempts: 0 } } })
      );
    };
    const run = jobs.apply(
      { plan: { state: { trees: [{}] } }, logs: [{ public: true }] },
      { signal: scope.signal, dispatch }
    );
    if (method === 'txRead') {
      await expect(run).resolves.toMatchObject({ guards: { attempts: 0 } });
      expect(dispatch).toHaveBeenCalledTimes(1);
    } else {
      await expect(run).rejects.toThrow();
      expect(dispatch).not.toHaveBeenCalled();
    }
  }
);
test('projects bounded public batches with fixed governance ceiling and pinned archive job', async () => {
  expect(await jobs.project(query, capability)).toEqual({ public: true });
  expect(seen.map((v) => v.length)).toEqual([128, 128, 44]);
  expect(JSON.parse(mockOptions.input)).toEqual({
    mode: 'plan',
    storeId: 'a'.repeat(64),
    archive: '/engine.asar',
    qualifiedThrough: 11829346,
  });
  expect(mockOptions.filename).toBe(require.resolve('./railgun-public-job'));
  expect(mockOptions.binaryKey).toBeUndefined();
  expect(mockTask.close).toHaveBeenCalled();
});
test.each(['early-result', 'storage-in-plan', 'wrong-sequence', 'nonzero-guards'])(
  'refuses %s and drains the utility',
  async (mode) => {
    const normal = mockRun;
    mockRun = async ({ broker }) => {
      if (mode === 'nonzero-guards')
        return normal({
          broker: {
            dispatch: (wire) => {
              const v = JSON.parse(wire);
              if (v.method === 'jobResult') v.value.guards.attempts = 1;
              return broker.dispatch(JSON.stringify(v));
            },
          },
        });
      const message =
        mode === 'early-result'
          ? { id: 1, method: 'jobResult', value: { guards: { attempts: 0 } } }
          : mode === 'wrong-sequence'
            ? { id: 2, method: 'sourceNext' }
            : { id: 1, method: 'get', args: {} };
      await broker.dispatch(JSON.stringify(message));
    };
    await expect(jobs.project(query, capability)).rejects.toThrow();
    expect(mockTask.close).toHaveBeenCalled();
  }
);
test('cancellation interrupts backpressured source production and releases the job owner', async () => {
  let release;
  const begun = new Promise((resolve) => {
    release = resolve;
  });
  mockRun = async ({ broker }) => {
    await broker.dispatch(JSON.stringify({ id: 1, method: 'sourceNext' }));
    release();
    await new Promise((resolve) =>
      broker.signal.addEventListener('abort', resolve, { once: true })
    );
    throw Error('cancelled');
  };
  const controller = new AbortController();
  const pending = jobs.project(query, { ...capability, signal: controller.signal });
  pending.catch(() => {});
  await begun;
  await expect(jobs.project(query, capability)).rejects.toThrow();
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(mockTask.close).toHaveBeenCalled();
});
test('feed rejects oversized entries and drains after close while a batch waits', async () => {
  const bad = createFeed(
    async (consume) => consume({ value: 'x'.repeat(1024 * 1024) }),
    scope.signal
  );
  await expect(bad.done).rejects.toThrow();
  bad.close();
  const feed = createFeed(async (consume) => {
    for (let i = 0; i < 300; i++) await consume({ i });
  }, scope.signal);
  expect(await feed.next()).toHaveLength(128);
  feed.close();
  await expect(feed.done).rejects.toThrow();
});
test('a frozen failure is wrapped without modifying its shared cause', async () => {
  const original = Object.freeze(Object.assign(new Error('shared refusal'), { code: 'REFUSED' }));
  mockRun = async () => {
    throw original;
  };
  await expect(jobs.project(query, capability)).rejects.toMatchObject({
    cause: original,
    code: 'REFUSED',
    closed: { code: 'RAILGUN_PROCESS_CLOSED' },
  });
  expect(Object.keys(original)).toEqual(['code']);
});
