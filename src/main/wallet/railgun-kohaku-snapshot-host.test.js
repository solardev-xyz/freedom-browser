// These owner seams are controlled WeakMap doubles. They exercise the bridge's
// binding/lifetime behavior; they are not native account qualification.
jest.mock('./railgun-account-wallet', () => ({ readRailgunAccountOwnedNotes: jest.fn() }));
jest.mock('./railgun-account-public', () => ({ getRailgunAccountPublicIdentity: jest.fn() }));
const { readRailgunAccountOwnedNotes: readOwned } = require('./railgun-account-wallet');
const { getRailgunAccountPublicIdentity: publicIdentity } = require('./railgun-account-public');
const { createRailgunKohakuSnapshotHost: createHost } = require('./railgun-kohaku-snapshot-host');
const {
  createRailgunKohakuSnapshotPlugin: createPlugin,
} = require('./railgun-kohaku-snapshot-plugin');
const {
  snapshotFixture,
  checkSnapshotConformance,
} = require('../../../scripts/fixtures/railgun-kohaku-snapshot-conformance');
const failCode = 'RAILGUN_KOHAKU_SNAPSHOT_REFUSED';
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function fixture() {
  const signals = Array.from({ length: 5 }, () => new AbortController());
  const close = jest.fn();
  const account = { view: {}, generationId: '1'.repeat(64), signal: signals[0].signal, close };
  const identity = { signal: signals[1].signal, close },
    enrollment = { signal: signals[2].signal, close },
    coordinator = { signal: signals[3].signal, close };
  const owners = { identity, enrollment, coordinator };
  const read = freeze(snapshotFixture());
  let busy = false,
    checkpoint = '2'.repeat(64),
    publicGeneration = '3'.repeat(64);
  const genuine = new WeakMap([[account, Object.freeze({ ...owners })]]);
  readOwned.mockImplementation((actualAccount, actualOwners) => {
    const expected = genuine.get(actualAccount);
    if (
      !expected ||
      busy ||
      signals.some((signal) => signal.signal.aborted) ||
      Object.keys(expected).some((key) => actualOwners[key] !== expected[key])
    )
      throw Error('stale');
    return Object.freeze({
      read,
      checkpointHash: checkpoint,
      ownedPoi: ['never exported'],
      trees: [],
    });
  });
  publicIdentity.mockImplementation((actualCoordinator, actualEnrollment) => {
    if (actualCoordinator !== coordinator || actualEnrollment !== enrollment)
      throw Error('bad owner');
    return Object.freeze({
      generationId: publicGeneration,
      sourceId: '4'.repeat(64),
      publicId: '5'.repeat(64),
    });
  });
  const options = { account, owners, signal: signals[4].signal };
  const host = createHost(options);
  return {
    options,
    host,
    read,
    account,
    owners,
    close,
    signals,
    busy(value) {
      busy = value;
    },
    checkpoint(value) {
      checkpoint = value;
    },
    publicGeneration(value) {
      publicGeneration = value;
    },
  };
}
afterEach(() => jest.clearAllMocks());
test('same pinned vectors work through the fixed bridge with only local owner reads', async () => {
  const f = fixture();
  const plugin = createPlugin({ host: f.host, signal: new AbortController().signal });
  readOwned.mockClear();
  publicIdentity.mockClear();
  expect(await checkSnapshotConformance(plugin, f.read)).toMatchObject({ readVectors: 9 });
  expect(readOwned).toHaveBeenCalledTimes(18);
  expect(publicIdentity).toHaveBeenCalledTimes(18);
  expect(Object.keys(f.host.capture().snapshot).sort()).toEqual(['instanceId', 'received']);
  plugin.close();
  await plugin.closed;
  expect(f.close).not.toHaveBeenCalled();
  expect(readOwned(f.account, f.owners).read).toBe(f.read);
  expect(() => f.host.capture().assertCurrent()).not.toThrow();
});
test.each(['view', 'walletGeneration', 'publicGeneration', 'checkpoint', 'busy'])(
  'changed %s refuses publication without closing owners',
  async (kind) => {
    const f = fixture();
    const plugin = createPlugin({ host: f.host, signal: new AbortController().signal });
    const originalView = f.account.view,
      originalGeneration = f.account.generationId;
    const pending = plugin.notes();
    if (kind === 'view') f.account.view = {};
    if (kind === 'walletGeneration') f.account.generationId = '6'.repeat(64);
    if (kind === 'publicGeneration') f.publicGeneration('7'.repeat(64));
    if (kind === 'checkpoint') f.checkpoint('8'.repeat(64));
    if (kind === 'busy') f.busy(true);
    await expect(pending).rejects.toMatchObject({ code: failCode });
    f.account.view = originalView;
    f.account.generationId = originalGeneration;
    f.publicGeneration('3'.repeat(64));
    f.checkpoint('2'.repeat(64));
    f.busy(false);
    expect(await plugin.notes()).toEqual(
      f.read.received.filter((note) => note.spentTxid === false)
    );
    plugin.close();
    await plugin.closed;
    expect(f.close).not.toHaveBeenCalled();
    expect(readOwned(f.account, f.owners).read).toBe(f.read);
  }
);
test.each([0, 1, 2, 3, 4])(
  'borrowed lifetime %i aborts publication, never invokes owner close',
  async (index) => {
    const f = fixture();
    const plugin = createPlugin({ host: f.host, signal: new AbortController().signal });
    const pending = plugin.balance();
    f.signals[index].abort();
    await expect(pending).rejects.toMatchObject({ code: failCode });
    await plugin.closed;
    expect(f.close).not.toHaveBeenCalled();
    expect(() => f.host.capture()).toThrow();
  }
);
test.each(['account', 'identity', 'enrollment', 'coordinator'])(
  'counterfeit %s fails genuine owner join before capture',
  (kind) => {
    const f = fixture();
    const options = { ...f.options, owners: { ...f.owners } };
    if (kind === 'account') options.account = { ...f.account };
    else options.owners[kind] = { ...f.owners[kind] };
    expect(() => createHost(options)).toThrow();
    expect(f.close).not.toHaveBeenCalled();
  }
);
test('constructor binds owner references against later caller option mutation', () => {
  const f = fixture();
  f.options.account = {};
  f.owners.identity = {};
  expect(readOwned.mock.calls[0][1].identity).not.toBe(f.owners.identity);
  expect(() => f.host.capture().assertCurrent()).not.toThrow();
});
test('capture closure binding is not caller-replaceable and snapshot excludes owner evidence', () => {
  const f = fixture(),
    captured = f.host.capture();
  expect(Object.isFrozen(f.host)).toBe(true);
  expect(Object.isFrozen(captured)).toBe(true);
  expect(Object.keys(captured.snapshot)).toEqual(['instanceId', 'received']);
  expect(captured.snapshot.received).toBe(f.read.received);
  expect(Object.isFrozen(captured.snapshot.received[0].asset)).toBe(true);
  expect(captured.snapshot.ownedPoi).toBeUndefined();
});
test('reentrant account revocation inside final genuine public identity read refuses', async () => {
  const f = fixture();
  const plugin = createPlugin({ host: f.host, signal: new AbortController().signal });
  const pending = plugin.instanceId();
  publicIdentity.mockImplementationOnce(() => {
    f.signals[0].abort();
    return { generationId: '3'.repeat(64), sourceId: '4'.repeat(64), publicId: '5'.repeat(64) };
  });
  await expect(pending).rejects.toMatchObject({ code: failCode });
  await plugin.closed;
  expect(f.close).not.toHaveBeenCalled();
});
test('closing many independent adapters leaves borrowed owner signals untouched and no bridge listeners', async () => {
  const { getEventListeners } = require('events');
  const f = fixture();
  const baseline = f.signals.map(
    (controller) => getEventListeners(controller.signal, 'abort').length
  );
  const plugins = Array.from({ length: 50 }, () =>
    createPlugin({ host: f.host, signal: new AbortController().signal })
  );
  await Promise.all(plugins.map((plugin) => plugin.instanceId()));
  for (const plugin of plugins) plugin.close();
  await Promise.all(plugins.map((plugin) => plugin.closed));
  expect(
    f.signals.map((controller) => getEventListeners(controller.signal, 'abort').length)
  ).toEqual(baseline);
  expect(f.signals.every((controller) => !controller.signal.aborted)).toBe(true);
  expect(f.close).not.toHaveBeenCalled();
});
