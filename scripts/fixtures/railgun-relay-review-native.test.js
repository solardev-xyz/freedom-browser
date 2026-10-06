/** Controlled registry/job seams only. No native process, codec or signing runs. */
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const mock = {};
jest.mock('./railgun-native-assertions', () => ({
  assert: require('node:assert/strict'),
  record: jest.fn(),
  assertEmpty: jest.fn(),
  observeClosed: jest.fn(),
}));
jest.mock('../../src/main/wallet/railgun-account-wallet', () => ({
  readRailgunAccountOwnedNotes: (...args) => mock.read(...args),
  getRailgunAccountWalletPolicy: () => mock.policy,
  reserveRailgunAccountWalletHandoff: (...args) => mock.reserve(...args),
}));
jest.mock('../../src/main/wallet/railgun-account-public', () => ({
  getRailgunAccountPublicIdentity: () => ({ generationId: 'public' }),
}));
jest.mock('../../src/main/wallet/railgun-relay-quote-verify', () => ({
  verifyRailgunRelayQuote: (...args) => mock.verify(...args),
}));
jest.mock('./railgun-kohaku-snapshot-native', () => ({ encryptedFiles: () => mock.files() }));
jest.mock('./railgun-relay-quote-native-vectors', () => ({
  PUBLIC_KEY: '02'.repeat(32),
  MASTER: '7',
  buildVectors: (...args) => mock.vectors(...args),
}));
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
let f;
beforeEach(() => {
  jest.resetModules();
  mock.policy = 'policy';
  const pins = require('../../src/main/wallet/railgun-shield-pins.json');
  const signal = new AbortController().signal;
  const notes = [2000n, 1000n, 700n].map((amount, index) => ({
    tag: 'unverified',
    id: '0:' + index,
    tree: 0,
    position: index,
    amount,
    asset: { __type: 'erc20', contract: pins.wrappedNative },
    spentTxid: index === 1 ? 'spent' : false,
    hash: 'hash' + index,
    txid: 'tx' + index,
  }));
  const baseline = {
    read: { instanceId: 'self', received: notes },
    checkpointHash: 'checkpoint',
    ownedPoi: notes.map((note) => ({
      id: note.id,
      hash: note.hash,
      txid: note.txid,
      type: 'Shield',
    })),
  };
  const owners = Object.fromEntries(
    ['identity', 'enrollment', 'coordinator'].map((key) => [key, { signal, close: jest.fn() }])
  );
  const {
    projectRailgunKohakuBalance,
    projectRailgunKohakuNotes,
  } = require('../../src/main/wallet/railgun-kohaku-read-data');
  const account = {
    signal,
    generationId: 'wallet',
    close: jest.fn(),
    view: {
      balance: jest.fn(async () => projectRailgunKohakuBalance(notes, null)),
      notes: jest.fn(async () => projectRailgunKohakuNotes(notes, null, true)),
    },
  };
  f = {
    owners,
    account,
    baseline,
    signal,
    archive: '/public/engine.asar',
    profile: '/virtual/profile',
    walletDirectory: '/virtual/wallet',
    activity: { ...zero },
    rows: [],
    held: false,
    filesValue: { sealed: 'unchanged' },
  };
  f.measure = jest.fn(() => ({ ...f.activity }));
  f.jobs = jest.fn(() => JSON.parse(JSON.stringify(f.rows)));
  mock.files = jest.fn(() => ({ ...f.filesValue }));
  mock.read = jest.fn((a, o) => {
    assert.equal(a, account);
    assert.equal(o.identity, owners.identity);
    return baseline;
  });
  mock.reserve = jest.fn((a, o) => {
    assert.equal(a, account);
    assert.equal(o.enrollment, owners.enrollment);
    if (f.held) throw Object.assign(Error('busy'), { code: 'RAILGUN_ACCOUNT_PHASE_BUSY' });
    f.held = true;
    return Object.freeze({
      assertCurrent: () => assert.equal(f.held, true),
      release: () => {
        f.held = false;
      },
    });
  });
  mock.vectors = jest.fn((_archive, createdAt) => {
    const fields = {
      fees: { [pins.wrappedNative]: '0xde0b6b3a7640000' },
      feeExpiration: createdAt + 240000,
      feesID: 'fixture',
      railgunAddress: '0zk1' + 'q'.repeat(123),
      availableWallets: 1,
      version: '8.0.0',
      relayAdapt: pins.relayAdapt,
      requiredPOIListKeys: [],
      reliability: -1,
    };
    return {
      gas: { transactionType: 0, gasEstimate: '84', gasPrice: '1', minGasPrice: '1' },
      cases: [
        {
          quote: {
            data: Buffer.from(JSON.stringify(fields)).toString('hex'),
            signature: '03'.repeat(64),
          },
        },
      ],
    };
  });
  mock.verify = jest.fn(async () => {
    for (const name of ['utilityStarts', 'utilitySettlements', 'brokerMessages'])
      f.activity[name]++;
    f.rows.push({
      inputSha256: 'digest',
      resultMessages: 1,
      closedObserved: true,
      result: {
        inputSha256: 'digest',
        signatureVerified: true,
        viewingPublicKey: '02'.repeat(32),
        masterPublicKey: '7',
        guards: require('../../src/main/wallet/railgun-relay-quote-data').EXPECTED_GUARDS,
      },
      closed: {
        code: 'RAILGUN_PROCESS_CLOSED',
        exitCode: 15,
        escalated: false,
        peerDisconnected: false,
      },
    });
    return { viewingPublicKey: '02'.repeat(32), masterPublicKey: '7' };
  });
  jest.dontMock('../../src/main/wallet/railgun-relay-review');
});
afterEach(() => jest.restoreAllMocks());
const run = () => require('./railgun-relay-review-native').qualify(f);
test('real controller over controlled registries distinguishes all three cases and restores export', async () => {
  const wallet = require('../../src/main/wallet/railgun-account-wallet');
  const original = wallet.reserveRailgunAccountWalletHandoff;
  const report = await run();
  expect(report.cases).toEqual(['accepted', 'review-refused', 'held-review-close']);
  expect(report.handoffs).toEqual({ calls: 10, grants: 7, refusals: 3 });
  expect(report.quoteMargins.map((row) => row.label)).toEqual([
    'accepted',
    'review-refused',
    'held-review-close',
    'held-release',
  ]);
  expect(report.quoteMargins.every((row) => row.milliseconds >= 60000)).toBe(true);
  expect(report.deltas).toEqual({
    ...zero,
    utilityStarts: 3,
    utilitySettlements: 3,
    brokerMessages: 3,
  });
  expect(report.successHandoffReleasedBeforeClose).toBe(true);
  expect(report.closeWaitedOriginalCallback).toBe(true);
  expect(report.liveChildCancellationQualified).toBe(false);
  expect(mock.verify).toHaveBeenCalledTimes(3);
  expect(f.account.view.balance).toHaveBeenCalledTimes(3);
  expect(f.account.view.notes).toHaveBeenCalledTimes(3);
  expect(f.account.close).not.toHaveBeenCalled();
  for (const owner of Object.values(f.owners)) expect(owner.close).not.toHaveBeenCalled();
  expect(wallet.reserveRailgunAccountWalletHandoff).toBe(original);
});
test.each([
  'railgunKeyRequests',
  'railgunKeyReplies',
  'rpcRequests',
  'rpcFactories',
  'signerFactories',
  'workerStarts',
  'transportFactories',
])('extra %s work cannot qualify', async (key) => {
  const verify = mock.verify;
  mock.verify = async (...args) => {
    const result = await verify(...args);
    f.activity[key]++;
    return result;
  };
  await expect(run()).rejects.toThrow();
  expect(f.held).toBe(false);
});
test.each(['exit', 'guard', 'missing-job', 'storage', 'generation', 'policy', 'owner-view'])(
  'refuses %s observation mismatch',
  async (kind) => {
    const verify = mock.verify;
    mock.verify = async (...args) => {
      const result = await verify(...args);
      if (kind === 'exit') f.rows[0].closed.exitCode = 0;
      if (kind === 'guard') f.rows[0].result.guards = { hooks: [], canaries: 0, attempts: 0 };
      if (kind === 'missing-job') f.rows.length = 0;
      if (kind === 'storage') f.filesValue.extra = 'write';
      if (kind === 'generation') f.account.generationId = 'other';
      if (kind === 'policy') mock.policy = 'other';
      if (kind === 'owner-view') f.account.view = {};
      return result;
    };
    await expect(run()).rejects.toThrow();
  }
);
test('an insufficient fresh-quote margin refuses before any genuine job admission', async () => {
  const vectors = mock.vectors;
  mock.vectors = (archive, now) => vectors(archive, now - 181000);
  await expect(run()).rejects.toThrow();
  expect(mock.verify).not.toHaveBeenCalled();
});
function mutant(from, to) {
  jest.doMock('../../src/main/wallet/railgun-relay-review', () => {
    const filename = path.join(__dirname, '../../src/main/wallet/railgun-relay-review.js');
    const source = fs.readFileSync(filename, 'utf8');
    expect(source.split(from)).toHaveLength(2);
    const module = { exports: {} };
    const req = (name) =>
      name.startsWith('./') ? require('../../src/main/wallet/' + name.slice(2)) : require(name);
    Function('require', 'module', source.replace(from, to))(req, module);
    return module.exports;
  });
}
test('source control: success holding the reservation until close is detected', async () => {
  mutant(
    '          handoff = null;\n          attest();\n          succeeded = true;',
    '          handoff = reserveRailgunAccountWalletHandoff(account, owners);\n          attest();\n          succeeded = true;'
  );
  await expect(run()).rejects.toThrow('busy');
  expect(f.held).toBe(false);
});
test('source control: close releases handoff before the original callback settles', async () => {
  mutant('    if (!closing || busy) return;', '    if (!closing) return;');
  await expect(run()).rejects.toThrow();
  expect(f.held).toBe(false);
  expect(mock.verify).toHaveBeenCalledTimes(3);
});
test('source control: false review incorrectly accepted cannot qualify', async () => {
  mutant(
    '          assert.equal(approved, true);',
    '          assert.equal(typeof approved, "boolean");'
  );
  await expect(run()).rejects.toThrow();
  expect(mock.verify).toHaveBeenCalledTimes(2);
});
test('source control: substituted verification cannot satisfy observed original-job checks', async () => {
  mutant(
    '          const verified = await verifyRailgunRelayQuote({',
    '          const verified = await (async () => ({ viewingPublicKey: "02".repeat(32), masterPublicKey: "7" }))({'
  );
  await expect(run()).rejects.toThrow();
  expect(mock.verify).not.toHaveBeenCalled();
});

function installedObserver(cached = []) {
  const source = fs.readFileSync(path.join(__dirname, 'railgun-relay-review-native.js'), 'utf8');
  const originalDispatch = jest.fn(() => Promise.resolve('reply'));
  const task = { closed: Promise.resolve({ code: 'RAILGUN_PROCESS_CLOSED', exitCode: 15 }) };
  const runtime = { startRailgunProcess: jest.fn(() => task) };
  const base = {
    resources: { close: jest.fn(async () => {}) },
    measure: () => ({}),
    count: jest.fn(),
  };
  const observations = [],
    errors = [];
  const req = (name) => {
    if (name === './railgun-native-assertions')
      return {
        assert,
        record: (error) => {
          errors.push(error);
        },
        observeClosed: (promise, callback) => {
          observations.push(promise);
          promise.then(callback);
        },
      };
    if (name === './railgun-kohaku-snapshot-native') return { install: () => base };
    if (name.endsWith('/railgun-process')) return runtime;
    return require(name);
  };
  req.resolve = (name) => name;
  req.cache = Object.fromEntries(cached.map((name) => ['../../src/main/wallet/' + name, {}]));
  const module = { exports: {} };
  Function('require', 'module', source)(req, module);
  return {
    install: module.exports.install,
    runtime,
    base,
    task,
    originalDispatch,
    observations,
    errors,
  };
}
test('observer returns original task and broker promise, preserves this and arguments, restores in order', async () => {
  const f = installedObserver();
  const original = f.runtime.startRailgunProcess;
  const probe = f.install();
  const receiver = {},
    tail = {};
  const options = {
    filename: '../../src/main/wallet/railgun-relay-quote-job',
    input: JSON.stringify({ archive: '/public/engine', quote: {}, gas: {} }),
    binaryKey: false,
    broker: { dispatch: f.originalDispatch },
  };
  expect(Reflect.apply(f.runtime.startRailgunProcess, receiver, [options, tail])).toBe(f.task);
  expect(original.mock.contexts[0]).toBe(receiver);
  expect(original.mock.calls[0][1]).toBe(tail);
  const inner = original.mock.calls[0][0].broker;
  const wire = JSON.stringify({ id: 1, method: 'result', value: { publicResult: true } });
  const result = Reflect.apply(inner.dispatch, receiver, [wire, tail]);
  expect(result).toBe(f.originalDispatch.mock.results[0].value);
  expect(f.originalDispatch.mock.contexts[0]).toBe(receiver);
  expect(f.originalDispatch.mock.calls[0]).toEqual([wire, tail]);
  expect(f.observations).toEqual([f.task.closed]);
  await result;
  expect(probe.jobs()[0]).toMatchObject({
    resultMessages: 1,
    closedObserved: true,
    result: { publicResult: true },
  });
  f.base.resources.close.mockImplementation(async () =>
    expect(f.runtime.startRailgunProcess).toBe(original)
  );
  await probe.resources.close();
  expect(f.base.resources.close).toHaveBeenCalledTimes(1);
});
test.each(['railgun-relay-review', 'railgun-relay-quote-verify'])(
  'late %s import refuses before observer installation',
  (name) => {
    const f = installedObserver([name]);
    expect(f.install).toThrow('installed late');
    expect(f.runtime.startRailgunProcess).not.toHaveBeenCalled();
  }
);
test('wrong wrapper ownership refuses but still closes underlying measurement owner', async () => {
  const f = installedObserver(),
    probe = f.install();
  f.runtime.startRailgunProcess = () => null;
  await expect(probe.resources.close()).rejects.toThrow();
  expect(f.base.resources.close).toHaveBeenCalledTimes(1);
});
test('non-quote job is forwarded with the original options object and no quote record', () => {
  const f = installedObserver(),
    original = f.runtime.startRailgunProcess,
    probe = f.install();
  const options = { filename: '/other/job' };
  expect(f.runtime.startRailgunProcess(options)).toBe(f.task);
  expect(original.mock.calls[0][0]).toBe(options);
  expect(probe.jobs()).toEqual([]);
});
test('broker observer preserves original rejected promise and original error identity', async () => {
  const f = installedObserver(),
    original = f.runtime.startRailgunProcess;
  const error = Error('original broker refusal');
  f.originalDispatch.mockImplementation(() => Promise.reject(error));
  f.install();
  f.runtime.startRailgunProcess({
    filename: '../../src/main/wallet/railgun-relay-quote-job',
    input: JSON.stringify({ archive: '/public/engine', quote: {}, gas: {} }),
    binaryKey: false,
    broker: { dispatch: f.originalDispatch },
  });
  const promise = original.mock.calls[0][0].broker.dispatch('{}');
  expect(promise).toBe(f.originalDispatch.mock.results[0].value);
  await expect(promise).rejects.toBe(error);
  expect(f.errors).toEqual([error]);
});
test.each(['key-allowed', 'owned-input'])(
  'observer refuses %s before launching a quote job',
  (kind) => {
    const f = installedObserver(),
      original = f.runtime.startRailgunProcess;
    f.install();
    const input = { archive: '/public/engine', quote: {}, gas: {} };
    if (kind === 'owned-input') input.noteId = '0:2';
    expect(() =>
      f.runtime.startRailgunProcess({
        filename: '../../src/main/wallet/railgun-relay-quote-job',
        input: JSON.stringify(input),
        binaryKey: kind === 'key-allowed',
        broker: {},
      })
    ).toThrow();
    expect(original).not.toHaveBeenCalled();
  }
);
