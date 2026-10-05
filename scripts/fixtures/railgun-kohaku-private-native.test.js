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
