/** Orchestration seams only. Real pure capsule/calldata normalizers; plugin and
 * registry callbacks modeled explicitly. Native owns actual issuer/crypto proof. */
jest.mock('./railgun-native-assertions', () => ({ assert: require('assert/strict') }));
jest.mock('./railgun-kohaku-partial-native', () => ({
  ...jest.requireActual('./railgun-kohaku-partial-native'),
  installObservers: jest.fn(),
}));
jest.mock('../../src/main/wallet/railgun-kohaku-plugin', () => ({
  createRailgunKohakuPlugin: jest.fn(),
}));
jest.mock('../../src/main/wallet/railgun-kohaku-broadcaster', () => ({
  createRailgunKohakuBroadcaster: jest.fn(),
}));
const tools = require('./railgun-kohaku-partial-native');
const pluginModule = require('../../src/main/wallet/railgun-kohaku-plugin');
const broadcaster = require('../../src/main/wallet/railgun-kohaku-broadcaster');
const api = require('./railgun-kohaku-second-instance');
const fixtures = require('./railgun-partial-capsule-data');
const {
  validateRailgunPrivateSigningIntent,
} = require('../../src/main/wallet/railgun-private-intent');
const clone = (v) => structuredClone(v);
const gate = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
let callbacks, metrics, instances, events, fault, closeGate, reviewGate, finalGate, closedObserver;
function add(values) {
  for (const [group, map] of Object.entries(values))
    for (const [key, value] of Object.entries(map))
      metrics[group][key] = (metrics[group][key] || 0) + value;
}
function h(second = false) {
  const f = second
    ? fixtures.createRailgunLegacyCapsuleData()
    : fixtures.createRailgunPartialCapsuleData({ inputAmount: '1400' });
  const capsule = f.capsule;
  const stored = {
    holdId: second ? 'second' : 'first',
    capsule,
    signature: { dummy: true },
    provedTransaction: capsule.preparation.transaction,
  };
  const caller = new AbortController();
  return {
    second,
    identity: { descriptor: { instanceId: 'private-vector' } },
    enrollment: { signal: caller.signal },
    coordinator: {},
    account: { close: jest.fn(async () => events.push('accountclosed')) },
    archive: '/engine',
    proverArchive: '/prover',
    artifactDirectory: '/artifacts',
    capsules: { get: jest.fn(async () => stored) },
    note: { id: '0:1', hash: capsule.noteHash, amount: second ? 1000n : 1400n },
    record: {
      id: '0:1',
      type: second ? 'Transact' : 'Shield',
      nullifier: capsule.preparation.expected.nullifier,
    },
    recipient: capsule.selection.recipient,
    amount: second ? 1000n : 400n,
    measure: () => clone(metrics),
    recordReview: () => {
      metrics.eoa.reviews = (metrics.eoa.reviews || 0) + 1;
    },
    onStored: jest.fn(),
    stored,
    caller,
  };
}
beforeEach(() => {
  jest.clearAllMocks();
  metrics = { jobs: {}, keys: {}, methods: {}, rpcCounts: {}, workers: {}, eoa: {} };
  instances = [];
  events = [];
  fault = undefined;
  closeGate = undefined;
  reviewGate = undefined;
  finalGate = undefined;
  closedObserver = jest.fn();
  tools.installObservers.mockImplementation((o) => {
    callbacks = o;
    return { close: closedObserver };
  });
  pluginModule.createRailgunKohakuPlugin.mockImplementation((options) => {
    const controller = new AbortController(),
      closed = gate();
    let used = false,
      currentToken,
      local;
    const p = {
      signal: controller.signal,
      closed: closed.promise,
      close: jest.fn(() => {
        controller.abort();
        Promise.resolve(closeGate?.promise).then(() => closed.resolve());
      }),
      prepareUnshield: jest.fn(async (amount, recipient) => {
        local = instances.length === 1 ? first : second;
        const isSecond = local.second,
          expected = api.counts(isSecond, local.record.type === 'Transact');
        add({ eoa: { addressAttempts: 1 } });
        if (fault === 'early-rpc') add({ rpcCounts: { 'transaction-rpc:none:eth_chainId': 1 } });
        const summary = {
          operation: isSecond ? 'railgun-token-unshield' : 'railgun-partial-unshield',
          inputType: local.record.type,
          selection: { noteId: amount.noteId },
          fullNote: isSecond,
          amount: amount.amount.toString(),
          recipient,
          submitter: recipient,
          destinations: Object.fromEntries(
            ['retainedSource', 'protocolRpc', 'transactionRpc'].map((k) => [
              k,
              'https://synthetic.invalid/railgun-partial-controller',
            ])
          ),
        };
        if (!isSecond)
          Object.assign(summary, {
            inputAmount: '1400',
            unshieldAmount: '400',
            changeAmount: '1000',
            entireInputConsumed: true,
            changeRecipient: 'same-private-account',
            unshieldAmountIncludesProtocolFee: true,
            changeRequiresConfirmedScan: true,
            changeSpendRequiresSeparatePoiSubmission: true,
            changePoiDisclosure:
              'separately reviewed combined POI links public unshield recipient and amount at the aggregator; does not publish it automatically',
          });
        if (fault === 'summary') summary.amount = '3';
        if (reviewGate) await reviewGate.promise;
        if (controller.signal.aborted) throw Error('model closed before approval');
        await options.reviewPreparation(Object.freeze(summary), { signal: controller.signal });
        const rest = clone(expected.prepare);
        rest.eoa.addressAttempts--;
        if (fault === 'extra-key')
          rest.keys['private-receive'] = (rest.keys['private-receive'] || 0) + 1;
        add(rest);
        if (!isSecond || fault === 'receiver-on-full') {
          const expected = local.stored.capsule.preparation.expected;
          callbacks.onReceiver(
            { recipient: local.identity.descriptor.instanceId },
            {
              inputAmount: '1400',
              unshieldAmount: '400',
              changeAmount: '1000',
              recipient: local.identity.descriptor.instanceId,
              recipientVerified: true,
              transactionDigest: validateRailgunPrivateSigningIntent(
                local.stored.provedTransaction,
                expected
              ).digest,
            }
          );
        }
        const request = {
          kind: summary.operation,
          noteId: amount.noteId,
          recipient,
          ...(!isSecond ? { unshieldAmount: '400' } : {}),
        };
        if (fault === 'wrong-request') request.noteId = '0:2';
        await callbacks.onProved(
          { request, owners: options.owners },
          { status: 'proved', holdId: local.stored.holdId }
        );
        currentToken = Object.freeze({ __type: 'privateOperation' });
        return currentToken;
      }),
      async broadcast(token) {
        if (token !== currentToken || used || controller.signal.aborted)
          throw Error('model identity refusal');
        used = true;
        const request = {
          operation: local.second ? 'railgun-token-unshield' : 'railgun-partial-unshield',
          transaction: local.stored.provedTransaction,
          from: local.recipient,
          expiresAt: Date.now() + 30000,
        };
        if (finalGate) {
          events.push('final-review-held');
          await finalGate.promise;
        }
        if (controller.signal.aborted) throw Error('model final review closed');
        await options.reviewTransaction(request);
        const inc = clone(api.counts(local.second, local.record.type === 'Transact').submit);
        inc.eoa.reviews--;
        add(inc);
        const outcome = { hash: local.second ? 'second-hash' : 'first-hash' };
        callbacks.onSubmitted({ identity: local.identity, enrollment: local.enrollment }, outcome);
        events.push('submitted');
        return fault === 'copied-outcome' ? { ...outcome } : outcome;
      },
    };
    instances.push(p);
    return p;
  });
  broadcaster.createRailgunKohakuBroadcaster.mockImplementation((p) => ({
    broadcast: (t) => p.broadcast(t),
  }));
  first = h();
  second = h(true);
});
let first, second;
test.each(['Shield', 'Transact'])(
  'two distinct instances from %s; exact token/result forwarding, full receiver-free path and prior instance drained',
  async (creator) => {
    first.record.type = creator;
    const observer = api.install();
    const a = await observer.first(first);
    const b = await observer.second(second);
    expect(a.submitted.hash).toBe('first-hash');
    expect(b.submitted.hash).toBe('second-hash');
    expect(observer.report()).toEqual({ instances: 2, prove: 2, receiver: 1, submit: 2 });
    expect(b.report.previousConsumedInstanceTokenRefused).toBe(true);
    expect(instances[0]).not.toBe(instances[1]);
    expect(first.onStored).toHaveBeenCalledWith(first.stored);
    expect(second.onStored).toHaveBeenCalledWith(second.stored);
    expect(first.account.close).not.toHaveBeenCalled();
    observer.close();
    expect(closedObserver).toHaveBeenCalledTimes(1);
  }
);
test.each(['early-rpc', 'summary', 'wrong-request', 'extra-key', 'copied-outcome'])(
  '%s cannot produce successful fixture result',
  async (name) => {
    const observer = api.install();
    fault = name;
    await expect(observer.first(first)).rejects.toThrow();
    expect(instances[0].close).toHaveBeenCalled();
    observer.close();
  }
);
test('second full unshield may not request a receiver or manufacture its own partial path', async () => {
  const observer = api.install();
  await observer.first(first);
  fault = 'receiver-on-full';
  await expect(observer.second(second)).rejects.toThrow();
  observer.close();
});
test('cannot start a second instance before genuine original modeled close barrier', async () => {
  const observer = api.install();
  closeGate = gate();
  let settled = false;
  const work = observer.first(first).finally(() => {
    settled = true;
  });
  for (let n = 0; n < 50 && !events.includes('submitted'); n++) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
  expect(events).toContain('submitted');
  expect(settled).toBe(false);
  await expect(observer.second(second)).rejects.toThrow();
  expect(instances).toHaveLength(1);
  closeGate.resolve();
  await work;
  observer.close();
});
test('failed preparation still awaits adopted plugin cleanup before outward refusal', async () => {
  const observer = api.install();
  fault = 'summary';
  closeGate = gate();
  let settled = false;
  const work = observer.first(first).finally(() => {
    settled = true;
  });
  const rejection = expect(work).rejects.toThrow();
  await new Promise((r) => setImmediate(r));
  expect(settled).toBe(false);
  expect(instances[0].close).toHaveBeenCalled();
  closeGate.resolve();
  await rejection;
  observer.close();
});
test('external close while modeled preparation is held cannot run proof or submission', async () => {
  const observer = api.install();
  reviewGate = gate();
  const work = observer.first(first);
  const rejection = expect(work).rejects.toThrow();
  await Promise.resolve();
  instances[0].close();
  reviewGate.resolve();
  await rejection;
  expect(observer.report()).toEqual({ instances: 1, prove: 0, receiver: 0, submit: 0 });
  observer.close();
});
test.each([false, true])(
  'complete fixed maps catch missing and balanced extra raw RPC; second=%s',
  (second) => {
    for (const expected of Object.values(api.counts(second, true))) {
      const before = Object.fromEntries(Object.keys(expected).map((k) => [k, {}]));
      expect(() => tools.assertCounts(before, expected, expected)).not.toThrow();
      for (const key of Object.keys(expected.rpcCounts)) {
        const bad = clone(expected);
        bad.rpcCounts[key]++;
        expect(() => tools.assertCounts(before, bad, expected)).toThrow();
      }
    }
  }
);
test.each(['accountOpenCounts', 'resolutionAndCaptureCounts'])(
  '%s accounts for every extra/missing phase RPC',
  (name) => {
    const expected = api[name]();
    const before = Object.fromEntries(Object.keys(expected).map((k) => [k, {}]));
    expect(() => tools.assertCounts(before, expected, expected)).not.toThrow();
    for (const key of Object.keys(expected.rpcCounts)) {
      const extra = clone(expected),
        missing = clone(expected);
      extra.rpcCounts[key]++;
      delete missing.rpcCounts[key];
      expect(() => tools.assertCounts(before, extra, expected)).toThrow();
      expect(() => tools.assertCounts(before, missing, expected)).toThrow();
    }
  }
);

test('final-review cancellation retains cleanup and admits no EOA send after late callback', async () => {
  const observer = api.install();
  await observer.first(first);
  finalGate = gate();
  closeGate = gate();
  let settled = false;
  const work = observer.second(second).finally(() => {
    settled = true;
  });
  const rejection = expect(work).rejects.toThrow();
  for (let i = 0; i < 100 && !events.includes('final-review-held'); i++) await Promise.resolve();
  expect(events).toContain('final-review-held');
  const before = clone(metrics);
  instances[1].close();
  await new Promise((r) => setImmediate(r));
  expect(settled).toBe(false);
  expect(metrics).toEqual(before);
  finalGate.resolve();
  await new Promise((r) => setImmediate(r));
  expect(settled).toBe(false);
  expect(metrics).toEqual(before);
  closeGate.resolve();
  await rejection;
  expect(observer.report()).toEqual({ instances: 2, prove: 2, receiver: 1, submit: 1 });
  observer.close();
});
