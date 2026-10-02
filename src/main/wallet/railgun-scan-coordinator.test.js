jest.mock('../networks/private-rpc', () => ({ createPrivateRpc: jest.fn() }));
const fs = require('fs'),
  os = require('os'),
  path = require('path');
const { createPrivateRpc } = require('../networks/private-rpc');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { startRailgunSessionWorker } = require('./railgun-session-worker');
const { createRailgunSourceLedger } = require('./railgun-source-ledger');
const { createRailgunScanSource } = require('./railgun-scan-source');
const { createRailgunScanCoordinator } = require('./railgun-scan-coordinator');
const { emptyPublicState } = require('./railgun-public-records');
const hash = (n) => '0x' + n.toString(16).padStart(64, '0');
let scope, directory, instances, providerHost, sourceUnavailable;
const subject = {
  kind: 'private-account',
  principal: 'fixture',
  protocol: 'railgun',
  chainId: 11155111,
  deployment: 'fixture',
};
const request = (id, method = 'batch') =>
  JSON.stringify({
    id,
    method,
    args:
      method === 'rpc'
        ? { method: 'eth_getLogs', params: [] }
        : {
            operations: [
              {
                type: 'put',
                key: Buffer.from('fixture-cursor').toString('base64'),
                value: Buffer.from('applied').toString('base64'),
              },
            ],
          },
  });
async function open(create, applyRange = async () => {}) {
  const handle = scope.getContext({ ...subject, role: 'engine' }),
    rpcHandle = scope.getContext({ ...subject, role: 'protocol-rpc' });
  const ledger = await createRailgunSourceLedger({
    handle: rpcHandle,
    filename: path.join(directory, 'source.sqlite'),
    key: Buffer.alloc(32, 52),
    binding: 'd'.repeat(64),
    create,
  });
  const source = createRailgunScanSource({
    handle: rpcHandle,
    ledger,
    projectRange: async ({ range }, { visit }) => {
      await visit(() => {});
      return emptyPublicState(range.storeId);
    },
  });
  const storeSession = startRailgunSessionWorker({
    handle,
    storage: {
      format: 'paged-v2',
      filename: path.join(directory, 'engine.sqlite'),
      key: Buffer.alloc(32, 53),
      binding: 'e'.repeat(64),
      create,
    },
    createProvider: ({ signal }) => ({
      signal,
      request: async () => {
        throw Error('No engine RPC');
      },
    }),
    onClose: () => {},
  });
  const entry = { ledger, source, storeSession };
  instances.push(entry);
  await storeSession.ready;
  entry.coordinator = await createRailgunScanCoordinator({
    handle,
    storeSession,
    source,
    journalStorage: { directory, key: Buffer.alloc(32, 54), binding: 'f'.repeat(64) },
    applyRange,
  });
  return entry;
}
async function close(entry) {
  entry.coordinator?.close();
  entry.source.close();
  entry.ledger.close();
  entry.storeSession.close();
  await Promise.all([entry.ledger.closed, entry.storeSession.closed]);
}
beforeEach(() => {
  scope = createPrivacyScope({
    profileId: 'coordinator-fixture',
    signal: new AbortController().signal,
  });
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-scan-coordinator-'));
  instances = [];
  providerHost = 'first.example';
  sourceUnavailable = false;
  createPrivateRpc.mockImplementation((handle, _role, { signal }) => {
    const lifetime = AbortSignal.any([getPrivacyContext(handle).signal, signal]);
    return {
      signal: lifetime,
      trust: { queried: [providerHost] },
      release: () => {},
      assertActive: () => {
        if (lifetime.aborted) throw Error('closed');
      },
      request: async (method, params) => {
        if (sourceUnavailable) throw Error('source unavailable');
        if (method === 'eth_getLogs') return { result: [] };
        const number = params[0] === 'finalized' ? 100 : Number(BigInt(params[0]));
        return {
          result: {
            number: '0x' + number.toString(16),
            hash: hash(number + 1),
            parentHash: hash(number),
          },
        };
      },
    };
  });
});
afterEach(async () => {
  scope.close();
  for (const entry of instances) await close(entry);
});
const next = (to) => ({ to, anchor: { number: 100, hash: hash(101) } });
test('durably coordinates successive ranges, translates child IDs and revalidates after reopen/provider change', async () => {
  const apply = jest.fn(async (_range, { dispatch }) => {
    expect(JSON.parse(await dispatch(request(1))).id).toBe(1);
  });
  const first = await open(true, apply);
  expect(() => first.coordinator.inspect()).toThrow();
  expect(await first.coordinator.advance(next(10))).toMatchObject({
    status: 'applied-unverified',
    to: { number: 10 },
  });
  expect(await first.coordinator.advance(next(20))).toMatchObject({ to: { number: 20 } });
  expect(apply).toHaveBeenCalledTimes(2);
  await close(first);
  providerHost = 'second.example';
  const coldApply = jest.fn(),
    second = await open(false, coldApply);
  expect(await second.coordinator.recover()).toMatchObject({ to: { number: 20 } });
  expect(coldApply).not.toHaveBeenCalled();
  expect(second.coordinator.inspect().status).toBe('applied-unverified');
});
test('replays exactly the pending range after an interrupted apply, including a provider change', async () => {
  const first = await open(true, async (_range, { dispatch }) => {
    await dispatch(request(1));
    throw Error('engine stopped');
  });
  await expect(first.coordinator.advance(next(10))).rejects.toThrow();
  await close(first);
  providerHost = 'second.example';
  const apply = jest.fn(async ({ plan }, { dispatch }) => {
    expect(plan.from).toBe(0);
    expect(plan.to.number).toBe(10);
    await dispatch(request(1));
  });
  const second = await open(false, apply);
  expect(await second.coordinator.recover()).toMatchObject({ to: { number: 10 } });
  expect(apply).toHaveBeenCalledTimes(1);
});
test('an orphan source tail from before prepare is discarded only with journal-issued authority', async () => {
  const first = await open(true);
  await first.coordinator.advance(next(10));
  const identity = await first.storeSession.inspectStoreIdentity();
  const orphan = await first.source.acquire({
    from: 11,
    to: 15,
    previousHash: hash(11),
    anchor: next(0).anchor,
    storeId: identity.instanceId,
  });
  expect(orphan.plan.to.number).toBe(15);
  await close(first);
  const second = await open(false);
  await second.coordinator.recover();
  expect(await second.coordinator.advance(next(20))).toMatchObject({ to: { number: 20 } });
});
test.each(['rpc', 'late'])('refuses %s engine dispatch outside its scan grant', async (mode) => {
  let saved;
  const entry = await open(true, async (_range, { dispatch }) => {
    saved = dispatch;
    if (mode === 'rpc') await dispatch(request(1, 'rpc'));
  });
  if (mode === 'rpc') await expect(entry.coordinator.advance(next(10))).rejects.toThrow();
  else {
    await entry.coordinator.advance(next(10));
    await expect(saved(request(1))).rejects.toThrow();
  }
  expect(entry.coordinator.signal.aborted).toBe(true);
  expect(() => entry.coordinator.inspect()).toThrow();
});
test('keeps readiness unavailable during apply and refuses overlapping work', async () => {
  let entered, release;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const entry = await open(true, async () => {
    entered();
    await new Promise((resolve) => {
      release = resolve;
    });
  });
  const running = entry.coordinator.advance(next(10));
  await started;
  expect(() => entry.coordinator.inspect()).toThrow();
  await expect(entry.coordinator.recover()).rejects.toThrow();
  release();
  await running;
  expect(entry.coordinator.inspect().to.number).toBe(10);
});
test('profile lock cancels a silent apply callback without waiting for it to settle', async () => {
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const entry = await open(true, async () => {
    entered();
    await new Promise(() => {});
  });
  const running = entry.coordinator.advance(next(10));
  await started;
  scope.close();
  await expect(running).rejects.toThrow();
});
test('a retained raw store-session reference cannot bypass the coordinator', async () => {
  const entry = await open(true);
  await entry.coordinator.advance(next(10));
  await expect(entry.storeSession.dispatch(request(1))).rejects.toThrow();
  expect(() => entry.coordinator.inspect()).toThrow();
});
const readRequest = (id, method, args) => JSON.stringify({ id, method, args });
const b64 = (value) => Buffer.from(value).toString('base64');
test('read-only snapshots support bounded cursors, local IDs and current opaque evidence', async () => {
  const entry = await open(true, async (_range, { dispatch }) => dispatch(request(1)));
  await entry.coordinator.advance(next(10));
  let windowSignal;
  const result = await entry.coordinator.withPublicSnapshot(
    async ({ checkpoint, dispatch, signal }) => {
      windowSignal = signal;
      expect(checkpoint.to.number).toBe(10);
      expect(Object.isFrozen(checkpoint.state)).toBe(true);
      expect(Object.isFrozen(checkpoint.to)).toBe(true);
      expect(() => entry.coordinator.inspect()).toThrow();
      const call = async (id, method, args) => {
        const reply = JSON.parse(await dispatch(readRequest(id, method, args)));
        expect(reply.id).toBe(id);
        return reply.value;
      };
      expect(await call(1, 'get', { key: b64('fixture-cursor') })).toBe(b64('applied'));
      expect(await call(2, 'getMany', { keys: [b64('fixture-cursor'), b64('absent')] })).toEqual([
        b64('applied'),
        null,
      ]);
      const cursor = await call(3, 'open', { options: {} });
      await call(4, 'seek', { cursor, target: b64('fixture-cursor') });
      expect(await call(5, 'nextMany', { cursor, limit: 2 })).toEqual({
        rows: [[b64('fixture-cursor'), b64('applied')]],
        done: true,
      });
      await call(6, 'end', { cursor });
      return 'observed';
    }
  );
  expect(result.value).toBe('observed');
  expect(windowSignal.aborted).toBe(true);
  expect(entry.coordinator.assertSnapshot(result.evidence).to.number).toBe(10);
  expect(() => entry.coordinator.assertSnapshot({})).toThrow();
  const newer = await entry.coordinator.withPublicSnapshot(async () => 'new');
  expect(() => entry.coordinator.assertSnapshot(result.evidence)).toThrow();
  expect(entry.coordinator.assertSnapshot(newer.evidence).to.number).toBe(10);
  await entry.coordinator.advance(next(20));
  expect(() => entry.coordinator.assertSnapshot(newer.evidence)).toThrow();
});
test.each(['batch', 'txBegin', 'txStage', 'txCommit', 'txAbort', 'clear', 'rpc'])(
  'snapshot rejects %s before exposing a completed result',
  async (method) => {
    const entry = await open(true);
    await entry.coordinator.advance(next(10));
    await expect(
      entry.coordinator.withPublicSnapshot(async ({ dispatch }) => {
        await dispatch(readRequest(1, method, {})).catch(() => {});
        return 'ignored rejection';
      })
    ).rejects.toThrow();
    expect(entry.coordinator.signal.aborted).toBe(true);
  }
);
test('snapshot refuses a leaked cursor and subsequent lifetime reuse', async () => {
  const entry = await open(true);
  await entry.coordinator.advance(next(10));
  let dispatch;
  await expect(
    entry.coordinator.withPublicSnapshot(async (window) => {
      dispatch = window.dispatch;
      await dispatch(readRequest(1, 'open', { options: {} }));
    })
  ).rejects.toThrow();
  await expect(dispatch(readRequest(2, 'get', { key: b64('absent') }))).rejects.toThrow();
});
test('a completed snapshot cannot leave an active read capability', async () => {
  const entry = await open(true);
  await entry.coordinator.advance(next(10));
  let dispatch;
  const result = await entry.coordinator.withPublicSnapshot(async (window) => {
    dispatch = window.dispatch;
  });
  expect(entry.coordinator.assertSnapshot(result.evidence).to.number).toBe(10);
  await expect(dispatch(readRequest(1, 'get', { key: b64('absent') }))).rejects.toThrow();
  expect(() => entry.coordinator.assertSnapshot(result.evidence)).toThrow();
});
test('profile lock revokes a silent read-only job and refuses overlap', async () => {
  const entry = await open(true);
  await entry.coordinator.advance(next(10));
  let entered, windowSignal;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const running = entry.coordinator.withPublicSnapshot(async ({ signal }) => {
    windowSignal = signal;
    entered();
    await new Promise(() => {});
  });
  await started;
  await expect(entry.coordinator.advance(next(20))).rejects.toThrow();
  scope.close();
  await expect(running).rejects.toThrow();
  expect(windowSignal.aborted).toBe(true);
});
test('snapshot requires a scanned checkpoint and does not claim coverage for an empty store', async () => {
  const entry = await open(true),
    run = jest.fn();
  await expect(entry.coordinator.withPublicSnapshot(run)).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
});
test('snapshot rechecks source headers after its read callback', async () => {
  const entry = await open(true);
  await entry.coordinator.advance(next(10));
  await expect(
    entry.coordinator.withPublicSnapshot(async () => {
      sourceUnavailable = true;
      return 'must not publish';
    })
  ).rejects.toThrow();
});
