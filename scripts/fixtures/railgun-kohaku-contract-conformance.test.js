/** Orchestration counterexamples only; mock registry checks do not establish
 * native account ownership. Runtime hooks use the genuine owners at construction. */
const accountModule = '../../src/main/wallet/railgun-account-wallet';
const pluginModule = '../../src/main/wallet/railgun-kohaku-plugin';
function setup(mode = 'private') {
  jest.resetModules();
  const asset = { __type: 'erc20', contract: '0x' + 'ab'.repeat(20) };
  const received = [
    { id: '0:0', asset, amount: 11n, spentTxid: false, tag: 'unverified' },
    { id: '0:1', asset, amount: 7n, spentTxid: '0x' + '1'.repeat(64), tag: 'unverified' },
  ];
  const read = { instanceId: 'fixture', received };
  const snapshot = { read, binding: { generation: 'fixture-generation' } };
  const owners = { identity: { descriptor: { instanceId: 'fixture' } } },
    account = {};
  const counters = { jobs: 0, rpc: 0, worker: 0 };
  let changed = false;
  const current = jest.fn((actual, owner) => {
    expect(actual).toBe(account);
    expect(owner).toBe(owners);
    return changed ? { ...snapshot, binding: { generation: 'other' } } : snapshot;
  });
  jest.doMock(accountModule, () => ({ readRailgunAccountOwnedNotes: current }));
  const selected = (filter) =>
    filter === undefined ||
    filter.some((v) => v.__type === 'erc20' && v.contract.toLowerCase() === asset.contract);
  const instance = {
    async instanceId() {
      return read.instanceId;
    },
    async balance(filter) {
      return selected(filter) ? [{ asset, amount: 11n, tag: 'unverified' }] : [];
    },
    async notes(filter, spent = false) {
      return selected(filter) ? received.filter((v) => spent || v.spentTxid === false) : [];
    },
    status() {},
    ...(mode === 'view'
      ? {}
      : { close: jest.fn(), closed: Promise.resolve(), signal: new AbortController().signal }),
    ...(mode === 'private'
      ? { prepareTransfer() {}, prepareUnshield() {} }
      : mode === 'public'
        ? { prepareShield() {} }
        : {}),
  };
  account.view = instance;
  const check = jest.fn((actual) => expect(actual).toBe(instance));
  const create = jest.fn((options) => {
    expect(options).toEqual({ account, owners, signal: instance.signal });
    return instance;
  });
  jest.doMock(pluginModule, () => ({
    assertRailgunKohakuPrivatePlugin: check,
    assertRailgunKohakuPublicPlugin: check,
    createRailgunKohakuPlugin: create,
  }));
  const helper = require('./railgun-kohaku-contract-conformance');
  const options = { instance, account, owners, mode, measure: () => ({ ...counters }) };
  return {
    helper,
    options,
    instance,
    counters,
    current,
    check,
    create,
    drift: () => {
      changed = true;
    },
  };
}
afterEach(() => {
  jest.resetModules();
  jest.dontMock(accountModule);
  jest.dontMock(pluginModule);
});
test.each(['private', 'public'])(
  'checks %s snapshot after all 11 awaited reads without granting eligibility',
  async (mode) => {
    const state = setup(mode);
    const result = await state.helper.qualifyOperationInstance(state.options);
    expect(result).toMatchObject({
      calls: 11,
      eligibilityGranted: false,
      portableHostQualified: false,
      typescriptConformance: false,
      noAdditionalMeasuredWork: true,
    });
    expect(state.current).toHaveBeenCalledTimes(12);
    expect(state.check).toHaveBeenCalledTimes(2);
  }
);
test('owned view must be the exact account view, not a lookalike', async () => {
  const state = setup('view');
  await expect(
    state.helper.qualifyOwnedView({ ...state.options, instance: { ...state.instance } })
  ).rejects.toThrow();
  expect(state.current).not.toHaveBeenCalled();
  expect((await state.helper.qualifyOwnedView(state.options)).calls).toBe(11);
});
test.each(['jobs', 'rpc', 'worker'])(
  'refuses hidden %s work during otherwise correct reads',
  async (field) => {
    const state = setup();
    const original = state.instance.balance;
    state.instance.balance = async (...args) => {
      state.counters[field]++;
      return original(...args);
    };
    await expect(state.helper.qualifyOperationInstance(state.options)).rejects.toThrow(
      'Read conformance added work'
    );
  }
);
test('same local data returned synchronously cannot pass asynchronous contract', async () => {
  const state = setup();
  state.instance.instanceId = () => 'fixture';
  await expect(state.helper.qualifyOperationInstance(state.options)).rejects.toThrow();
});
test('late generation drift is caught after await even if old data is correct', async () => {
  const state = setup();
  state.instance.instanceId = async () => {
    state.drift();
    return 'fixture';
  };
  await expect(state.helper.qualifyOperationInstance(state.options)).rejects.toThrow();
});
test('spent-note value is not hidden by comparing two facade methods', async () => {
  const state = setup();
  state.instance.balance = async () => [
    {
      asset: { __type: 'erc20', contract: '0x' + 'ab'.repeat(20) },
      amount: 18n,
      tag: 'unverified',
    },
  ];
  await expect(state.helper.qualifyOperationInstance(state.options)).rejects.toThrow();
});
test('default read construction uses fixed exact owners and drains close after a read refusal', async () => {
  const state = setup('read');
  let release,
    done = false;
  state.instance.closed = new Promise((resolve) => {
    release = resolve;
  });
  state.instance.instanceId = () => 'fixture';
  const work = state.helper
    .qualifyReadInstance({
      account: state.options.account,
      owners: state.options.owners,
      signal: state.instance.signal,
      measure: state.options.measure,
    })
    .catch((error) => {
      done = true;
      throw error;
    });
  const rejected = expect(work).rejects.toThrow();
  await Promise.resolve();
  await Promise.resolve();
  expect(state.instance.close).toHaveBeenCalledTimes(1);
  expect(done).toBe(false);
  release();
  await rejected;
  expect(state.create).toHaveBeenCalledTimes(1);
});

test.each([
  [
    'private complete',
    'private',
    false,
    [
      ['private', 13],
      ['read', 13],
    ],
  ],
  ['private held', 'private', true, [['private', 13]]],
  ['public complete', 'public', false, [['public', 13]]],
  ['public held', 'public', true, [['public', 13]]],
])('fixed instance vector accepts %s', (_name, lane, heldReview, entries) => {
  const { helper } = setup();
  helper.assertInstanceReadVector(
    entries.map(([mode, calls]) => ({ mode, calls })),
    { lane, heldReview }
  );
});
test.each([
  ['private no checks', 'private', false, []],
  ['private omitted default', 'private', false, [['private', 13]]],
  [
    'private short first',
    'private',
    false,
    [
      ['private', 12],
      ['read', 13],
    ],
  ],
  [
    'private short default',
    'private',
    false,
    [
      ['private', 13],
      ['read', 12],
    ],
  ],
  [
    'private swapped',
    'private',
    false,
    [
      ['read', 13],
      ['private', 13],
    ],
  ],
  ['held omitted', 'private', true, []],
  ['held short', 'private', true, [['private', 12]]],
  [
    'held extra',
    'private',
    true,
    [
      ['private', 13],
      ['read', 13],
    ],
  ],
  ['public omitted', 'public', false, []],
  ['public short', 'public', false, [['public', 12]]],
  [
    'public extra',
    'public',
    false,
    [
      ['public', 13],
      ['public', 13],
    ],
  ],
  ['public wrong lane', 'public', false, [['private', 13]]],
])('fixed instance vector rejects %s', (_name, lane, heldReview, entries) => {
  const { helper } = setup();
  expect(() =>
    helper.assertInstanceReadVector(
      entries.map(([mode, calls]) => ({ mode, calls })),
      { lane, heldReview }
    )
  ).toThrow();
});
test('matching wrong account and facade IDs cannot replace the enrolled identity', async () => {
  const state = setup();
  const baseline = state.current(state.options.account, state.options.owners);
  state.current.mockReturnValue({
    ...baseline,
    read: { ...baseline.read, instanceId: 'other-account' },
  });
  state.instance.instanceId = jest.fn(async () => 'other-account');
  await expect(state.helper.qualifyOperationInstance(state.options)).rejects.toThrow(
    'Owned snapshot/identity join'
  );
  expect(state.instance.instanceId).not.toHaveBeenCalled();
});
test('identity changes while a read settles cannot pass by returning the old matching snapshot', async () => {
  const state = setup();
  state.instance.instanceId = async () => {
    state.options.owners.identity.descriptor.instanceId = 'other-account';
    return 'fixture';
  };
  await expect(state.helper.qualifyOperationInstance(state.options)).rejects.toThrow();
});
