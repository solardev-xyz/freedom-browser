/** Fixture controls use synthetic registries and messages; no engine/native execution. */
const fs = require('fs'),
  path = require('path'),
  assert = require('node:assert/strict');
const { createHash } = require('crypto');
const source = fs.readFileSync(path.join(__dirname, 'railgun-relay-preparation-native.js'), 'utf8');
const w = '../../src/main/wallet/';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const clone = (v) => JSON.parse(JSON.stringify(v));
const closed = {
  code: 'RAILGUN_PROCESS_CLOSED',
  exitCode: 15,
  escalated: false,
  peerDisconnected: false,
  peakRssBytes: 1000,
};
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function load(overrides, cached = []) {
  const errors = [];
  const native = {
    assert,
    record: (error) => errors.push(error),
    observeClosed: (promise, callback) =>
      promise.then(
        (value) => {
          try {
            callback(value);
          } catch (error) {
            errors.push(error);
          }
        },
        (error) => errors.push(error)
      ),
    assertEmpty: () => assert.deepEqual(errors, []),
  };
  const req = (name) =>
    name === './railgun-native-assertions'
      ? native
      : Object.hasOwn(overrides, name)
        ? overrides[name]
        : require(name);
  req.resolve = (name) => require.resolve(name);
  req.cache = Object.fromEntries(cached.map((name) => [require.resolve(w + name), {}]));
  const module = { exports: {} };
  Function('require', 'module', 'structuredClone', source)(req, module, clone);
  return { ...module.exports, errors };
}
function observer(cached) {
  const tasks = [],
    options = [];
  const base = { resources: { close: jest.fn(async () => {}) } };
  const runtime = {
    startRailgunProcess: jest.fn((value) => {
      const barrier = deferred();
      const task = { closed: barrier.promise, close: jest.fn() };
      tasks.push({ task, barrier });
      options.push(value);
      return task;
    }),
  };
  const loaded = load(
    {
      [w + 'railgun-process']: runtime,
      './railgun-kohaku-snapshot-native': { install: () => base },
    },
    cached
  );
  const delegate = runtime.startRailgunProcess;
  const probe = loaded.install();
  const quote = {
    filename: require.resolve(w + 'railgun-relay-quote-job'),
    binaryKey: false,
    startupMs: 15000,
    lifetimeMs: 15000,
    input: JSON.stringify({ archive: '/public', quote: {}, gas: {} }),
    broker: { dispatch: jest.fn(async () => '{}') },
  };
  const relay = (construct = true) => ({
    filename: require.resolve(w + 'railgun-relay-wallet-job'),
    binaryKey: true,
    startupMs: 30000,
    lifetimeMs: 30000,
    input: JSON.stringify({
      archive: '/public',
      descriptor: {},
      checkpoint: {},
      walletId: 'id',
      restore: true,
      prefixes: {},
      ...(construct ? { relayRequest: {} } : { relayDraftText: JSON.stringify({ draft: true }) }),
    }),
    broker: {
      dispatch: jest.fn(async (wire) =>
        JSON.parse(wire).method === 'key' ? new Uint8Array(32) : '{}'
      ),
    },
  });
  const send = (index, message) => options[index].broker.dispatch(JSON.stringify(message));
  const finishQuote = async () => {
    runtime.startRailgunProcess(quote);
    await send(0, { id: 1, method: 'result', value: {} });
    tasks[0].barrier.resolve(closed);
    await tasks[0].task.closed;
  };
  return {
    ...loaded,
    delegate,
    probe,
    runtime,
    tasks,
    options,
    base,
    quote,
    relay,
    send,
    finishQuote,
  };
}
test('observer preserves original this/arguments/task and broker promise identities', async () => {
  const f = observer(),
    receiver = {},
    tail = {};
  const original = f.runtime.startRailgunProcess; // installed wrapper delegates to mock below
  const task = Reflect.apply(original, receiver, [f.quote, tail]);
  expect(task).toBe(f.tasks[0].task);
  expect(f.delegate.mock.contexts[0]).toBe(receiver);
  expect(f.delegate.mock.calls[0][1]).toBe(tail);
  const inner = f.options[0].broker;
  const wire = JSON.stringify({ id: 1, method: 'result', value: { marker: true } });
  const promise = Reflect.apply(inner.dispatch, receiver, [wire, tail]);
  expect(promise).toBe(f.quote.broker.dispatch.mock.results[0].value);
  expect(f.quote.broker.dispatch.mock.contexts[0]).toBe(receiver);
  expect(f.quote.broker.dispatch.mock.calls[0]).toEqual([wire, tail]);
  await promise;
  f.tasks[0].barrier.resolve(closed);
  await task.closed;
  expect(f.probe.jobs()[0].closedObserved).toBe(true);
  await f.probe.resources.close();
  expect(f.base.resources.close).toHaveBeenCalledTimes(1);
});
test.each([
  'railgun-account-wallet',
  'railgun-wallet-runner',
  'railgun-wallet-run',
  'railgun-relay-quote-verify',
])('late %s import refuses', (name) => {
  expect(() => observer([name])).toThrow('installed late');
});
test('second job cannot start while original first closure is pending', async () => {
  const f = observer();
  f.runtime.startRailgunProcess(f.quote);
  await f.send(0, { id: 1, method: 'result', value: {} });
  expect(() => f.runtime.startRailgunProcess(f.relay())).toThrow('Prior original');
});
test.each(['wrong-purpose', 'write-method', 'missing-result', 'bad-exit'])(
  'observer distinguishes %s',
  async (fault) => {
    const f = observer();
    await f.finishQuote();
    f.runtime.startRailgunProcess(f.relay());
    if (fault === 'wrong-purpose')
      expect(() => f.send(1, { id: 1, method: 'key', purpose: 'relay-reconstruct' })).toThrow();
    else if (fault === 'write-method')
      expect(() =>
        f.send(1, { id: 1, channel: 'wallet', wire: JSON.stringify({ method: 'batch' }) })
      ).toThrow();
    else {
      if (fault === 'bad-exit') await f.send(1, { id: 1, method: 'result', value: {} });
      f.tasks[1].barrier.resolve({ ...closed, ...(fault === 'bad-exit' ? { exitCode: 0 } : {}) });
      await f.tasks[1].task.closed;
      expect(f.errors.length).toBeGreaterThan(0);
      expect(f.probe.jobs()[1].closedObserved).toBe(false);
    }
  }
);
test('reconstruction input must be exact first-result serialized bytes after original closure', async () => {
  const f = observer();
  await f.finishQuote();
  f.runtime.startRailgunProcess(f.relay());
  await f.send(1, { id: 1, method: 'key', purpose: 'relay-prepare' });
  await f.send(1, { id: 2, method: 'result', value: { relayDraft: { draft: true } } });
  f.tasks[1].barrier.resolve(closed);
  await f.tasks[1].task.closed;
  const bad = f.relay(false);
  const input = JSON.parse(bad.input);
  input.relayDraftText = '{"draft":false}';
  bad.input = JSON.stringify(input);
  expect(() => f.runtime.startRailgunProcess(bad)).toThrow();
});
test('duplicate result and reordered matching job refuse', async () => {
  const f = observer();
  await f.finishQuote();
  expect(() => f.send(0, { id: 2, method: 'result', value: {} })).toThrow();
  expect(() => f.runtime.startRailgunProcess(f.quote)).toThrow();
});
test('original broker rejection remains sticky and original promise is returned', async () => {
  const f = observer(),
    error = Error('original');
  f.quote.broker.dispatch.mockRejectedValue(error);
  f.runtime.startRailgunProcess(f.quote);
  const pending = f.send(0, { id: 1, method: 'result', value: {} });
  expect(pending).toBe(f.quote.broker.dispatch.mock.results[0].value);
  await expect(pending).rejects.toBe(error);
  expect(f.errors).toEqual([error]);
});
test('wrong wrapper restoration still drains base observer', async () => {
  const f = observer();
  f.runtime.startRailgunProcess = () => null;
  await expect(f.probe.resources.close()).rejects.toThrow();
  expect(f.base.resources.close).toHaveBeenCalledTimes(1);
});
const zero = {
  utilityStarts: 0,
  utilitySettlements: 0,
  workerStarts: 0,
  workerSettlements: 0,
  rejectedBarriers: 0,
  brokerMessages: 0,
  railgunKeyRequests: 0,
  railgunKeyReplies: 0,
  rpcFactories: 0,
  rpcRequests: 0,
  transportFactories: 0,
  signerFactories: 0,
  applications: 0,
  walletRestores: 0,
};
function qualification() {
  const pins = require(w + 'railgun-shield-pins.json');
  const { normalizeRailgunRelayDraftCapsule } = require(w + 'railgun-relay-capsule');
  // Reuse the independent pure-data test vector without executing its tests.
  const file = fs.readFileSync(path.join(__dirname, w, 'railgun-relay-intent.test.js'), 'utf8');
  const prefix = file.slice(
    0,
    file.indexOf('const { normalizeRailgunRelayUnsignedIntent: normalize }')
  );
  assert.ok(prefix.length > 100);
  const localRequire = require('module').createRequire(
    path.join(__dirname, w, 'railgun-relay-intent.test.js')
  );
  const vector = Function('require', prefix + '\nreturn fixture();')(localRequire);
  const raw = vector.build();
  const fields = JSON.parse(Buffer.from(raw.context.quote.data, 'hex').toString());
  fields.feeExpiration = Date.now() + 240000;
  raw.context.quote.data = Buffer.from(JSON.stringify(fields)).toString('hex');
  const draft = normalizeRailgunRelayDraftCapsule({
    schema: 'railgun-relay-unsigned-draft-v1',
    walletId: raw.context.walletId,
    engineSha256: require(w + 'railgun-engine-manifest.json').sha256,
    selection: { tree: 0, position: 2 },
    noteHash: '0x' + '01'.repeat(32),
    pathElements: Array(16).fill('0x' + '01'.repeat(32)),
    intent: raw,
  });
  const notes = [2000n, 1000n, 700n].map((amount, position) => ({
    id: '0:' + position,
    tree: 0,
    position,
    amount,
    tag: 'unverified',
    asset: { __type: 'erc20', contract: pins.wrappedNative },
    spentTxid: position === 1 ? 'spent' : false,
  }));
  const baseline = {
    read: { instanceId: raw.context.self.address, received: notes },
    ownedPoi: notes.map((note) => ({ id: note.id })),
    checkpointHash: 'checkpoint',
    trees: [],
  };
  const signal = new AbortController().signal,
    owners = Object.fromEntries(
      ['identity', 'enrollment', 'coordinator'].map((key) => [key, { signal }])
    );
  const f = {
    activity: { ...zero },
    rows: [],
    rpc: [],
    files: { stable: true },
    busy: false,
    mutate: () => {},
    baseline,
    draft,
    signal,
    owners,
  };
  const { projectRailgunKohakuBalance, projectRailgunKohakuNotes } = require(
    w + 'railgun-kohaku-read-data'
  );
  const view = () => {
    const current = {
      balance: async () => {
        if (f.account.view !== current) throw Error('stale');
        return projectRailgunKohakuBalance(notes, null);
      },
      notes: async () => projectRailgunKohakuNotes(notes, null, true),
    };
    return current;
  };
  f.account = { signal, generationId: 'generation', view: view() };
  const fail = () => Object.assign(Error('refused'), { code: 'RAILGUN_ACCOUNT_WALLET_REFUSED' });
  const api = {
    readRailgunAccountOwnedNotes: () => {
      if (f.busy) throw fail();
      return baseline;
    },
    getRailgunAccountWalletPolicy: () => 'policy',
    reserveRailgunAccountWalletHandoff: () => {
      if (f.busy) throw fail();
      return { assertCurrent() {}, release() {} };
    },
    restoreRailgunAccountWallet: async () => {
      if (f.busy) throw fail();
    },
    prepareRailgunAccountRelayIntent: (account, suppliedOwners, request) => {
      if (suppliedOwners.identity !== owners.identity) throw fail();
      if (request.verified || request.signal.aborted) return Promise.reject(fail());
      f.busy = true;
      return Promise.resolve()
        .then(() => {
          const guards = require(w + 'railgun-relay-quote-data').EXPECTED_GUARDS;
          const binding = require(w + 'railgun-relay-quote-data').normalizeRailgunRelayQuote(
            raw.context.quote,
            raw.context.gas
          );
          const checkpoint = { anchor: { number: 100 }, from: 21, to: { number: 30 } };
          const reconstructed = {
            draftDigest: draft.digest,
            expectedHash: draft.data.intent.expectedHash,
            recoveredOutputs: 2,
          };
          f.rows = ['quote', 'construct', 'reconstruct'].map((role, index) => ({
            role,
            inputSha256: sha('input' + index),
            input:
              index === 1
                ? { checkpoint, relayRequest: { context: raw.context } }
                : index === 2
                  ? { checkpoint, relayDraftText: JSON.stringify(draft.data) }
                  : {},
            messages: index ? 4 : 1,
            methods: index
              ? {
                  ['key:' + (index === 1 ? 'relay-prepare' : 'relay-reconstruct')]: 1,
                  'public.get': 1,
                  'wallet.get': 1,
                  result: 1,
                }
              : { result: 1 },
            keyReplies: index ? 1 : 0,
            resultMessages: 1,
            closedObserved: true,
            closed: { ...closed },
            result:
              index === 0
                ? {
                    inputSha256: sha('input0'),
                    quoteSha256: binding.quoteSha256,
                    signatureVerified: true,
                    viewingPublicKey: raw.context.peer.viewingPublicKey,
                    masterPublicKey: raw.context.peer.masterPublicKey,
                    guards,
                  }
                : {
                    guards,
                    poiCalls: 0,
                    inventory: require(w + 'railgun-engine-manifest.json').inventory.sha256,
                    ...(index === 1
                      ? { relayDraft: draft.data }
                      : { relayReconstruction: reconstructed }),
                  },
          }));
          f.rpc = [
            'finalized',
            '0x64',
            '0x15',
            '0x1e',
            '0x14',
            'finalized',
            '0x64',
            '0x15',
            '0x1e',
            '0x14',
          ].map((tag) => ({ method: 'eth_getBlockByNumber', params: [tag, false] }));
          Object.assign(f.activity, {
            rpcRequests: 10,
            utilityStarts: 3,
            utilitySettlements: 3,
            railgunKeyRequests: 2,
            railgunKeyReplies: 2,
            brokerMessages: 9,
          });
          f.account.view = view();
          const result = {
            view: f.account.view,
            preparation: draft,
            reconstruction: reconstructed,
            reviewedPreparation: false,
            reservationsChecked: false,
            capsulePersisted: false,
            signingEnabled: false,
            proofAuthority: false,
            poiQueriesPermitted: false,
            relaySendPermitted: false,
          };
          f.mutate(result);
          return result;
        })
        .finally(() => {
          f.busy = false;
        });
    },
  };
  const loaded = load({
    [w + 'railgun-account-wallet']: api,
    [w + 'railgun-account-public']: {
      getRailgunAccountPublicIdentity: () => ({ generationId: 'public' }),
    },
    './railgun-kohaku-snapshot-native': { encryptedFiles: () => clone(f.files) },
    './railgun-relay-quote-native-vectors': {
      buildVectors: () => ({ gas: raw.context.gas, cases: [{ quote: raw.context.quote }] }),
      PUBLIC_KEY: raw.context.peer.viewingPublicKey,
      MASTER: raw.context.peer.masterPublicKey,
    },
  });
  f.run = () =>
    loaded.qualify({
      account: f.account,
      owners,
      archive: '/public/engine',
      signal,
      profile: '/mock/profile',
      walletDirectory: '/mock/wallet',
      measure: () => ({ ...f.activity }),
      jobs: () => clone(f.rows),
      rpc: () => clone(f.rpc),
    });
  f.errors = loaded.errors;
  return f;
}
test('qualifier exercises successful composite plus pre-admission and same-turn competing refusals', async () => {
  const f = qualification(),
    report = await f.run();
  expect(report.relayRestores).toBe(2);
  expect(report.preAdmissionRefusals).toBe(3);
  expect(report.competingAdmissionRefusals).toBe(3);
  expect(report.deltas).toEqual({
    ...zero,
    rpcRequests: 10,
    utilityStarts: 3,
    utilitySettlements: 3,
    railgunKeyRequests: 2,
    railgunKeyReplies: 2,
    brokerMessages: 9,
  });
  expect(report.liveChildCancellationQualified).toBe(false);
  expect(f.errors).toEqual([]);
});
test.each([
  'workerStarts',
  'rpcRequests',
  'transportFactories',
  'signerFactories',
  'walletRestores',
  'applications',
  'brokerMessages',
])('extra %s work refuses', async (key) => {
  const f = qualification();
  f.mutate = () => {
    f.activity[key]++;
  };
  await expect(f.run()).rejects.toThrow();
});
test.each([
  'missing-original',
  'closure-pending',
  'serialized-join',
  'digest',
  'guard',
  'grant',
  'missing-grant',
  'storage',
  'generation',
  'stale-view',
])('qualifier refuses %s substitution', async (kind) => {
  const f = qualification(),
    oldView = f.account.view;
  f.mutate = (result) => {
    if (kind === 'missing-original') f.rows.pop();
    if (kind === 'closure-pending') f.rows[1].closedObserved = false;
    if (kind === 'serialized-join') f.rows[2].input.relayDraftText += ' ';
    if (kind === 'digest')
      result.reconstruction = { ...result.reconstruction, draftDigest: 'f'.repeat(64) };
    if (kind === 'guard') f.rows[2].result.guards = { hooks: [], canaries: 0, attempts: 0 };
    if (kind === 'grant') result.signingEnabled = true;
    if (kind === 'missing-grant') delete result.proofAuthority;
    if (kind === 'storage') f.files.changed = true;
    if (kind === 'generation') f.account.generationId = 'other';
    if (kind === 'stale-view') result.view = f.account.view = oldView;
  };
  await expect(f.run()).rejects.toThrow();
});

test('reused original task identity cannot stand in for another utility', async () => {
  const f = observer();
  await f.finishQuote();
  f.delegate.mockReturnValue(f.tasks[0].task);
  expect(() => f.runtime.startRailgunProcess(f.relay())).toThrow();
});
test('unexpected header method or wrong refresh multiplicity cannot qualify', async () => {
  for (const fault of ['method', 'multiplicity', 'checkpoint']) {
    const f = qualification();
    f.mutate = () => {
      if (fault === 'method') f.rpc[0].method = 'eth_getLogs';
      else if (fault === 'multiplicity') f.rpc.pop();
      else {
        f.rows[1].input.checkpoint.anchor.number = 99;
        f.rows[2].input.checkpoint.anchor.number = 99;
        for (const request of f.rpc) if (request.params[0] === '0x64') request.params[0] = '0x63';
      }
    };
    await expect(f.run()).rejects.toThrow();
  }
});

test.each(['quote', 'relay'])('fixed %s utility budgets cannot be widened', async (role) => {
  for (const key of ['startupMs', 'lifetimeMs']) {
    const f = observer();
    if (role === 'relay') await f.finishQuote();
    const options = role === 'quote' ? f.quote : f.relay();
    options[key]++;
    expect(() => f.runtime.startRailgunProcess(options)).toThrow();
  }
});
test.each(['added', 'removed'])('counter schema %s cannot escape deltas', async (kind) => {
  const f = qualification();
  f.mutate = () => {
    if (kind === 'added') f.activity.unexpectedCounter = 0;
    else delete f.activity.workerStarts;
  };
  await expect(f.run()).rejects.toThrow();
});

test('observer refuses the old identity route rather than forwarding it as unrelated work', async () => {
  const f = observer();
  try {
    expect(() =>
      f.runtime.startRailgunProcess({
        filename: require.resolve(w + 'railgun-identity-job'),
        input: JSON.stringify({ purpose: 'spending-public' }),
      })
    ).toThrow();
    expect(f.delegate).not.toHaveBeenCalled();
  } finally {
    await f.probe.resources.close();
  }
});
