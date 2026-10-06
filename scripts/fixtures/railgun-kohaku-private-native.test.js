/** Instrumentation unit controls use explicit mock owners, never native authority. */
const wallet = '../../src/main/wallet/';
const hash = '0x' + 'ab'.repeat(32);
const acknowledged = () => ({
  hash,
  nonce: 0,
  from: '0x' + 'ab'.repeat(20),
  to: '0x' + 'cd'.repeat(20),
  value: '0',
  chainId: 11155111,
  broadcastSource: 'direct',
  explorerUrl: null,
});
function setup(delegate = () => Promise.resolve(acknowledged())) {
  jest.resetModules();
  const facade = { broadcastRailgunKohakuOperation: delegate };
  jest.doMock(wallet + 'railgun-kohaku-plugin', () => facade);
  const helper = require('./railgun-kohaku-private-native');
  return { facade, helper, sticky: require('./railgun-native-assertions') };
}
afterEach(() => {
  jest.resetModules();
  jest.dontMock(wallet + 'railgun-kohaku-plugin');
  jest.dontMock(wallet + 'railgun-account-wallet');
});
test('delegate this, arguments and Promise identity survive; outer value observed independently', async () => {
  const result = acknowledged(),
    promise = Promise.resolve(result),
    receiver = {},
    args = [{}, {}];
  const delegate = jest.fn(function (...actual) {
    expect(this).toBe(receiver);
    expect(actual[0]).toBe(args[0]);
    expect(actual[1]).toBe(args[1]);
    return promise;
  });
  const { facade, helper } = setup(delegate);
  const observer = helper.installPrivateAdapterSettlementObserver();
  let raw;
  const check = observer.begin(() => {
    raw = facade.broadcastRailgunKohakuOperation.apply(receiver, args);
    return raw.then((value) => value);
  });
  expect(raw).toBe(promise);
  expect(check.promise).not.toBe(raw);
  expect(await check.promise).toBe(result);
  expect(await check.assert({ outcome: 'acknowledged', hash })).toEqual({
    status: 'fulfilled',
    fields: {
      broadcastSource: 'string',
      chainId: 'number',
      explorerUrl: 'object',
      from: 'string',
      hash: 'string',
      nonce: 'number',
      to: 'string',
      value: 'string',
    },
    originalValueIdentity: true,
  });
  expect(observer.report()).toEqual({
    delegateCalls: 1,
    delegateSettlements: 1,
    checkedCalls: 1,
    acknowledged: 1,
    uncertain: 0,
    refused: 0,
  });
  await observer.close();
  expect(facade.broadcastRailgunKohakuOperation).toBe(delegate);
});
test.each(['uncertain', 'refused'])('preserves original fulfilled %s outcome', async (outcome) => {
  const result =
    outcome === 'uncertain'
      ? { transactionHash: hash, submissionStatus: 'unknown' }
      : { status: 'recovery-required', stage: 'review-draining' };
  const { facade, helper } = setup(() => Promise.resolve(result));
  const observer = helper.installPrivateAdapterSettlementObserver();
  const check = observer.begin(() => facade.broadcastRailgunKohakuOperation().then((v) => v));
  await check.assert({ outcome, hash });
  expect(await check.promise).toBe(result);
  await observer.close();
});
test.each(['copy', 'void', 'reject'])(
  'detects outer %s mutation and leaves sticky failed close',
  async (mutation) => {
    const { facade, helper, sticky } = setup();
    const observer = helper.installPrivateAdapterSettlementObserver();
    const check = observer.begin(() =>
      facade.broadcastRailgunKohakuOperation().then((v) => {
        if (mutation === 'copy') return { ...v };
        if (mutation === 'void') return undefined;
        throw Error('changed');
      })
    );
    await expect(check.assert({ outcome: 'acknowledged', hash })).rejects.toThrow();
    await expect(observer.close()).rejects.toThrow();
    expect(() => sticky.assertEmpty()).toThrow();
  }
);
test.each([0, 2])('refuses %i delegated entries per call', async (count) => {
  const { facade, helper } = setup();
  const observer = helper.installPrivateAdapterSettlementObserver();
  expect(() =>
    observer.begin(() => {
      for (let i = 0; i < count; i++) facade.broadcastRailgunKohakuOperation();
      return Promise.resolve(acknowledged());
    })
  ).toThrow();
  if (count) await expect(observer.close()).rejects.toThrow();
  else await observer.close();
});
test('close waits for admitted original settlement and fails unchecked outcome', async () => {
  let resolve;
  const { facade, helper } = setup(
    () =>
      new Promise((yes) => {
        resolve = yes;
      })
  );
  const observer = helper.installPrivateAdapterSettlementObserver();
  observer.begin(() => facade.broadcastRailgunKohakuOperation());
  let closed = false;
  const closing = observer.close().finally(() => {
    closed = true;
  });
  closing.catch(() => {});
  await Promise.resolve();
  expect(closed).toBe(false);
  resolve({ hash });
  await expect(closing).rejects.toThrow();
});
function readSetup({ alias = false, work = false, wrongOwner = false, frozen = false } = {}) {
  const { helper } = setup();
  const asset = { __type: 'erc20', contract: '0x' + 'ab'.repeat(20) };
  const received = [0, 1, 2].map((i) => ({
    id: `0:${i}`,
    asset: { ...asset },
    amount: BigInt(i + 1),
    spentTxid: i === 2 ? hash : false,
    tag: 'unverified',
  }));
  const baseline = { read: { instanceId: 'fixture', received } },
    account = {};
  const owners = { identity: { descriptor: { instanceId: wrongOwner ? 'other' : 'fixture' } } };
  const current = jest.fn((a, o) => {
    expect(a).toBe(account);
    expect(o).toBe(owners);
    return baseline;
  });
  jest.doMock(wallet + 'railgun-account-wallet', () => ({ readRailgunAccountOwnedNotes: current }));
  let activity = 0;
  const selected = (filter, spent = false) =>
    received.filter(
      (n) =>
        (spent || !n.spentTxid) &&
        (filter === undefined ||
          filter.some((a) => a.__type === 'erc20' && a.contract.toLowerCase() === asset.contract))
    );
  const returned = (values) =>
    frozen
      ? Object.freeze(
          values.map((v) => Object.freeze({ ...v, asset: Object.freeze({ ...v.asset }) }))
        )
      : values;
  const adapter = Object.freeze({
    provenance: 'host-supplied',
    signal: new AbortController().signal,
    closed: Promise.resolve(),
    close() {},
    prepareTransfer() {},
    prepareUnshield() {},
    async instanceId() {
      if (work) activity++;
      return 'fixture';
    },
    async balance(filter) {
      const notes = selected(filter);
      return returned(
        notes.length
          ? [
              {
                asset: alias ? received[0].asset : { ...asset },
                amount: notes.reduce((n, v) => n + v.amount, 0n),
                tag: 'unverified',
              },
            ]
          : []
      );
    },
    async notes(filter, spent) {
      const notes = selected(filter, spent);
      return returned(alias ? notes : notes.map((note) => ({ ...note, asset: { ...note.asset } })));
    },
  });
  return { helper, adapter, account, owners, measure: () => ({ activity }), current };
}
test('13 read vectors join owners and test detached mutation without added work', async () => {
  const s = readSetup();
  expect(await s.helper.qualifyPrivateAdapterReads(s)).toMatchObject({
    calls: 13,
    detachedMutationIsolation: true,
  });
  expect(s.current).toHaveBeenCalledTimes(14);
});
test.each([{ alias: true }, { work: true }, { wrongOwner: true }, { frozen: true }])(
  'rejects alias, work or owner drift %j',
  async (options) => {
    const s = readSetup(options);
    await expect(s.helper.qualifyPrivateAdapterReads(s)).rejects.toThrow();
  }
);
test('three refused reads must remain refused and cause zero added activity', async () => {
  const { helper } = setup();
  let calls = 0;
  const denied = () => {
    calls++;
    return Promise.reject(
      Object.assign(Error('refused'), { code: 'RAILGUN_KOHAKU_PRIVATE_ADAPTER_REFUSED' })
    );
  };
  const adapter = { instanceId: denied, balance: denied, notes: denied };
  expect(await helper.assertPrivateAdapterReadRefusals(adapter, () => ({ jobs: 0 }))).toEqual({
    calls: 3,
    noAdditionalMeasuredWork: true,
  });
  expect(calls).toBe(3);
  await expect(
    helper.assertPrivateAdapterReadRefusals(adapter, () => ({ calls }))
  ).rejects.toThrow();
});

test.each(['railgun-kohaku-private-host', 'railgun-kohaku-broadcaster'])(
  'refuses capture after %s already imported',
  (name) => {
    const { helper } = setup();
    require(wallet + name);
    expect(() => helper.installPrivateAdapterSettlementObserver()).toThrow('Install before');
  }
);

test.each(['field', 'type'])(
  'original outcome identity alone cannot hide wrong %s schema',
  async (bad) => {
    const value = acknowledged();
    if (bad === 'field') delete value.nonce;
    else value.nonce = '0';
    const { facade, helper } = setup(() => Promise.resolve(value));
    const observer = helper.installPrivateAdapterSettlementObserver();
    const check = observer.begin(() => facade.broadcastRailgunKohakuOperation());
    await expect(check.assert({ outcome: 'acknowledged', hash })).rejects.toThrow(
      'Exact specialized'
    );
    await expect(observer.close()).rejects.toThrow();
  }
);

test('native key deltas follow actual job purposes and count requests before dispatch failure', async () => {
  const fs = require('fs'),
    path = require('path'),
    vm = require('vm'),
    parser = require('acorn');
  const source = (file) => fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
  const nodes = (text, predicate) => {
    const result = [];
    const walk = (value) => {
      if (!value || typeof value !== 'object') return;
      if (predicate(value)) result.push(value);
      for (const item of Object.values(value))
        if (Array.isArray(item)) item.forEach(walk);
        else if (item && typeof item === 'object') walk(item);
    };
    walk(parser.parse(text, { ecmaVersion: 'latest' }));
    return result;
  };
  const operate = source('src/main/wallet/railgun-private-operate-job.js');
  const operateCalls = nodes(
    operate,
    (node) => node.type === 'CallExpression' && node.callee.property?.name === 'withWallet'
  );
  expect(operateCalls).toHaveLength(1);
  const operatePurpose = operateCalls[0].arguments[2].value;
  expect(operatePurpose).toBe('private-operate');
  const walletJob = source('src/main/wallet/railgun-wallet-job.js');
  const keyCalls = nodes(
    walletJob,
    (node) => node.type === 'CallExpression' && node.callee.name === 'requestKey'
  );
  expect(keyCalls).toHaveLength(1);
  const operateWire = vm.runInNewContext(
    walletJob.slice(keyCalls[0].arguments[0].start, keyCalls[0].arguments[0].end),
    { purpose: operatePurpose }
  );
  const receive = source('src/main/wallet/railgun-private-receive-job.js');
  const receiveCalls = nodes(
    receive,
    (node) => node.type === 'CallExpression' && node.callee.name === 'requestKey'
  );
  expect(receiveCalls).toHaveLength(1);
  const receiveWire = vm.runInNewContext(
    receive.slice(receiveCalls[0].arguments[0].start, receiveCalls[0].arguments[0].end)
  );
  const qualifier = source('scripts/qualify-railgun-wallet-journal.js');
  const dispatches = nodes(
    qualifier,
    (node) => node.type === 'Property' && node.method && node.key.name === 'dispatch'
  );
  expect(dispatches).toHaveLength(1);
  const body = qualifier.slice(
    dispatches[0].value.body.start + 1,
    dispatches[0].value.body.end - 1
  );
  const reply = body.indexOf('const reply = await original.dispatch(wire);');
  expect(reply).toBeGreaterThan(0);
  const error = Error('Dispatch rejected after request admission');
  const original = { dispatch: jest.fn().mockRejectedValue(error) };
  // Execute the real observer prefix; replace only the unrelated post-dispatch
  // fixture branches. A rejected delegate must still increment request counts.
  const context = vm.createContext({
    messages: 0,
    snapshotProbe: undefined,
    localReviewProbe: undefined,
    relayPreparationProbe: undefined,
    exactReviewProbe: undefined,
    stagingGuard: false,
    failReadOnlyRestore: false,
    privateViewingKeys: 0,
    privateReceiveKeys: 0,
    original,
  });
  const dispatch = vm.runInContext(
    `(async function(wire) { ${body.slice(0, reply)} return original.dispatch(wire); })`,
    context
  );
  const integration = source('scripts/fixtures/railgun-kohaku-integration.js');
  const start = integration.indexOf('          const keyCounts = readKeyCounts();');
  const end = integration.indexOf('          const closedReads =', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const report = (inputType) =>
    vm.runInNewContext(
      `(function() { ${integration.slice(start, end)} return keyRequestDeltas; })()`,
      {
        inputType,
        readKeyCounts: () => ({
          privateViewingKeys: context.privateViewingKeys,
          privateReceiveKeys: context.privateReceiveKeys,
        }),
        branchBefore: { keys: { privateViewingKeys: 0, privateReceiveKeys: 0 } },
        assert: require('assert/strict'),
      }
    );
  await expect(dispatch(operateWire)).rejects.toBe(error);
  expect(report('Transact')).toEqual({ privatePrepare: 0, privateReceive: 0 });
  await expect(dispatch(receiveWire)).rejects.toBe(error);
  expect(report('Shield')).toEqual({ privatePrepare: 0, privateReceive: 1 });
  expect(original.dispatch).toHaveBeenNthCalledWith(1, operateWire);
  expect(original.dispatch).toHaveBeenNthCalledWith(2, receiveWire);
  await expect(
    dispatch(JSON.stringify({ id: 1, method: 'key', purpose: 'private-prepare' }))
  ).rejects.toBe(error);
  expect(context.privateViewingKeys).toBe(1);
  expect(context.privateReceiveKeys).toBe(1);
  expect(context.messages).toBe(3);
  expect(() => report('Shield')).toThrow();
});

test('denied RPC map removes both independently cached transaction client chain checks', async () => {
  const fs = require('fs'),
    path = require('path'),
    vm = require('vm'),
    parser = require('acorn');
  const read = (name) => fs.readFileSync(path.join(__dirname, '../../', name), 'utf8');
  const find = (root, predicate) => {
    const result = [];
    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (predicate(node)) result.push(node);
      for (const item of Object.values(node))
        if (Array.isArray(item)) item.forEach(walk);
        else if (item && typeof item === 'object') walk(item);
    }
    walk(root);
    return result;
  };
  const parse = (source) => parser.parse(source, { ecmaVersion: 'latest' });
  const rpcSource = read('src/main/networks/private-rpc.js');
  const readyNodes = find(
    parse(rpcSource),
    (node) => node.type === 'FunctionDeclaration' && node.id.name === 'ready'
  );
  expect(readyNodes).toHaveLength(1);
  const readySource = rpcSource.slice(readyNodes[0].start, readyNodes[0].end);
  const raw = jest.fn(async () => '0xaa36a7');
  const handles = new Set();
  const networks = new Map();
  const networkModule = {
    getPrivateTransactionNetwork(handle) {
      if (!networks.has(handle)) {
        handles.add(handle);
        // Actual production ready() implementation, with admitted wire and
        // currency seams mocked. Each new client has its own chainCheck cache.
        const ready = vm.runInNewContext(`(function() { ${readySource}; return ready; })()`, {
          chainCheck: undefined,
          assertActive() {},
          raw,
          isQuantity: (value) => /^0x[0-9a-f]+$/.test(value),
          subject: { chainId: 11155111 },
        });
        networks.set(handle, {
          async request() {
            await ready();
            return { result: '0x' };
          },
        });
      }
      return networks.get(handle);
    },
  };
  for (const [file, functionName] of [
    ['railgun-private-operation.js', 'prove'],
    ['railgun-private-submission.js', 'submitFinal'],
  ]) {
    const source = read('src/main/wallet/' + file);
    const functions = find(
      parse(source),
      (node) => node.type === 'FunctionDeclaration' && node.id.name === functionName
    );
    expect(functions).toHaveLength(1);
    const calls = find(functions[0], (node) => node.type === 'CallExpression');
    expect(calls.some((node) => node.callee.name === 'createPrivacyScope')).toBe(true);
    const createNetwork = calls.filter(
      (node) => node.callee.property?.name === 'getPrivateTransactionNetwork'
    );
    expect(createNetwork).toHaveLength(1);
    const firstRequest = calls.find(
      (node) => node.callee.object?.name === 'network' && node.callee.property?.name === 'request'
    );
    expect(firstRequest.arguments[1].value).toBe('eth_getCode');
    const handle = Object.freeze({ phase: functionName });
    const context = vm.createContext({
      handle,
      destinationConstraints: undefined,
      claim: {},
      require: (name) => {
        expect(name).toBe('./private-transaction-network');
        return networkModule;
      },
      pins: { chainId: 11155111 },
      submitter: '0x' + 'ab'.repeat(20),
      owner: '0x' + 'ab'.repeat(20),
    });
    context.network = vm.runInContext(
      source.slice(createNetwork[0].start, createNetwork[0].end),
      context
    );
    const expression = source.slice(firstRequest.start, firstRequest.end);
    await vm.runInContext(expression, context);
    await vm.runInContext(expression, context);
  }
  expect(handles.size).toBe(2);
  expect(raw).toHaveBeenCalledTimes(2);
  expect(raw.mock.calls.every(([method]) => method === 'eth_chainId')).toBe(true);
  const fixture = read('scripts/fixtures/railgun-kohaku-integration.js');
  const maps = find(
    parse(fixture),
    (node) => node.type === 'VariableDeclarator' && node.id.name === 'expectedMethods'
  );
  expect(maps).toHaveLength(1);
  const expression = fixture.slice(maps[0].init.start, maps[0].init.end);
  const map = (denied) => vm.runInNewContext(`(${expression})`, { denied, inputType: 'Shield' });
  const successful = map(false),
    denied = map(true);
  expect(successful.eth_chainId - denied.eth_chainId).toBe(raw.mock.calls.length);
  expect(denied).toEqual({ eth_chainId: 10, eth_getBlockByNumber: 710, eth_getLogs: 16 });
  expect(Object.values(denied).reduce((total, value) => total + value, 0)).toBe(736);
});
