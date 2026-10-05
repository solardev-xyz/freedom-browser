// Genuine facade ownership is represented by a controlled registry here. These
// are delegation/lifecycle tests, not native owner or proof qualification.
jest.mock('./railgun-kohaku-plugin', () => ({ createRailgunKohakuPlugin: jest.fn() }));
jest.mock('./railgun-kohaku-broadcaster', () => ({ createRailgunKohakuBroadcaster: jest.fn() }));
const { createRailgunKohakuPlugin: facade } = require('./railgun-kohaku-plugin');
const {
  createRailgunKohakuBroadcaster: genuineBroadcaster,
} = require('./railgun-kohaku-broadcaster');
const { createRailgunKohakuPrivateHost: createHost } = require('./railgun-kohaku-private-host');
const {
  createRailgunKohakuPrivateAdapter: create,
  createRailgunKohakuPrivateAdapterBroadcaster: broadcaster,
} = require('./railgun-kohaku-private-adapter');
const {
  independentPrivateHost,
  deferred,
  INSTANCE,
  ADDRESS,
} = require('../../../scripts/fixtures/railgun-kohaku-private-conformance');
function fixture() {
  const source = independentPrivateHost(),
    operation = Object.freeze({ __type: 'privateOperation' });
  const child = new AbortController(),
    drained = deferred();
  const plugin = {
    signal: child.signal,
    closed: drained.promise,
    instanceId: jest.fn(async () => INSTANCE),
    balance: jest.fn(async () => []),
    notes: jest.fn(async () => source.values),
    prepareTransfer: jest.fn(async () => operation),
    prepareUnshield: jest.fn(async () => operation),
    close: jest.fn(() => {
      child.abort();
      drained.resolve();
    }),
  };
  const send = jest.fn(async (value) => {
    expect(value).toBe(operation);
    return source.acknowledged;
  });
  const options = {
    account: { close: jest.fn() },
    owners: {
      identity: { close: jest.fn() },
      enrollment: { close: jest.fn() },
      coordinator: { close: jest.fn() },
    },
    signal: new AbortController().signal,
    archive: '/engine',
    proverArchive: '/prover',
    artifactDirectory: '/artifacts',
    reviewPreparation: jest.fn(),
    reviewTransaction: jest.fn(),
    gasLimit: 1n,
    maxGasFee: 1n,
  };
  facade.mockImplementation((actual) => {
    expect(actual).toEqual({ ...options, mode: 'private' });
    return plugin;
  });
  genuineBroadcaster.mockImplementation((actual) => {
    expect(actual).toBe(plugin);
    return { broadcast: send };
  });
  return { source, options, plugin, operation, child, drained, send };
}
afterEach(() => jest.clearAllMocks());
test.each(['transfer', 'full', 'partial'])(
  'fixed bridge preserves %s request, genuine token and original outcome',
  async (kind) => {
    const f = fixture();
    const host = createHost(f.options),
      adapter = create({ host, signal: new AbortController().signal });
    expect(await adapter.instanceId()).toBe(INSTANCE);
    expect(await adapter.notes()).toEqual(f.source.values);
    const input = { ...f.source.input, amount: kind === 'partial' ? 500n : 2000n };
    const token =
      kind === 'transfer'
        ? await adapter.prepareTransfer(input, INSTANCE)
        : await adapter.prepareUnshield(input, ADDRESS);
    expect(token).not.toBe(f.operation);
    expect(await broadcaster(adapter).broadcast(token)).toBe(f.source.acknowledged);
    expect(
      kind === 'transfer' ? f.plugin.prepareTransfer : f.plugin.prepareUnshield
    ).toHaveBeenCalledWith(
      input,
      kind === 'transfer' ? INSTANCE : ADDRESS,
      ...(kind === 'transfer' ? [] : [undefined])
    );
    await adapter.closed;
    expect(f.plugin.close).toHaveBeenCalledTimes(1);
    for (const value of [f.options.account, ...Object.values(f.options.owners)])
      expect(value.close).not.toHaveBeenCalled();
  }
);
test('hidden genuine operation is consumed before synchronous broadcaster rejection', async () => {
  const f = fixture();
  f.send.mockImplementation(() => {
    throw Error('private detail');
  });
  const host = createHost(f.options),
    result = await host.prepareTransfer(f.source.input, INSTANCE);
  expect(Object.keys(result.handle)).toEqual([]);
  await expect(host.broadcast(result.handle)).rejects.toThrow();
  await expect(host.broadcast(result.handle)).rejects.toThrow();
  expect(f.send).toHaveBeenCalledTimes(1);
  host.close();
  await host.closed;
});
test.each(['mode', 'host', 'ports'])(
  'caller %s override refuses before facade creation',
  (name) => {
    const f = fixture();
    expect(() => createHost({ ...f.options, [name]: {} })).toThrow();
    expect(facade).not.toHaveBeenCalled();
  }
);
test('bridge does not capture obsolete initial account after facade account replacement', async () => {
  const f = fixture();
  let current = [];
  f.plugin.notes.mockImplementation(async () => current);
  f.plugin.prepareTransfer.mockImplementation(async () => {
    current = f.source.values;
    return f.operation;
  });
  const host = createHost(f.options);
  expect(await host.notes()).toEqual([]);
  await host.prepareTransfer(f.source.input, INSTANCE);
  expect(await host.notes()).toBe(f.source.values);
  host.close();
  await host.closed;
});
test('late genuine operation after abort is never returned as host handle', async () => {
  const f = fixture(),
    held = deferred();
  f.plugin.prepareTransfer.mockImplementation(() => held.promise);
  const host = createHost(f.options),
    pending = host.prepareTransfer(f.source.input, INSTANCE);
  host.close();
  held.resolve(f.operation);
  await expect(pending).rejects.toMatchObject({ code: 'RAILGUN_KOHAKU_PRIVATE_HOST_REFUSED' });
  await host.closed;
});
test('recovery value preserves identity and is not converted to rejection', async () => {
  const f = fixture(),
    value = Object.freeze({ status: 'recovery-required', stage: 'completion' });
  f.send.mockResolvedValue(value);
  const host = createHost(f.options);
  expect(await host.broadcast((await host.prepareTransfer(f.source.input, INSTANCE)).handle)).toBe(
    value
  );
  host.close();
  await host.closed;
});
test('post-adoption broadcaster construction failure closes genuine facade once', async () => {
  const f = fixture();
  genuineBroadcaster.mockImplementation(() => {
    throw Error('stale');
  });
  expect(() => createHost(f.options)).toThrow('Kohaku private host unavailable');
  expect(f.plugin.close).toHaveBeenCalledTimes(1);
  await f.plugin.closed;
  expect(f.options.account.close).not.toHaveBeenCalled();
});
test('pre-adoption facade rejection never closes supplied account or borrowed owners', () => {
  const f = fixture();
  facade.mockImplementation(() => {
    throw Error('bad owner');
  });
  expect(() => createHost(f.options)).toThrow();
  expect(f.plugin.close).not.toHaveBeenCalled();
  for (const value of [f.options.account, ...Object.values(f.options.owners)])
    expect(value.close).not.toHaveBeenCalled();
});
