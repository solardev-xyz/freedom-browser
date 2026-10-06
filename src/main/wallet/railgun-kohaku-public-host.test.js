// Composition with the real public submitter and a controlled facade registry.
// These tests do not issue genuine enrollment, account or Shield authority.
jest.mock('./railgun-kohaku-plugin', () => ({
  createRailgunKohakuPlugin: jest.fn(),
  assertRailgunKohakuPublicPlugin: jest.fn(),
  submitRailgunKohakuPublicOperation: jest.fn(),
}));
const facade = require('./railgun-kohaku-plugin');
const { createRailgunKohakuPublicHost: createHost } = require('./railgun-kohaku-public-host');
const refused = { code: 'RAILGUN_KOHAKU_PUBLIC_HOST_REFUSED' };
let registry;
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const child = new AbortController(),
    drained = deferred(),
    operation = Object.freeze({ __type: 'publicOperation' }),
    acknowledged = Object.freeze({
      hash: '0x' + 'ab'.repeat(32),
      nonce: 1,
      from: '0x' + '12'.repeat(20),
      to: '0x' + '34'.repeat(20),
      value: '1000',
      chainId: 11155111,
      broadcastSource: 'direct',
      explorerUrl: null,
    }),
    submission = deferred();
  const plugin = {
    signal: child.signal,
    closed: drained.promise,
    instanceId: jest.fn(() => Promise.resolve('railgun-instance')),
    balance: jest.fn(() => Promise.resolve([])),
    notes: jest.fn(() => Promise.resolve([])),
    prepareShield: jest.fn(() => Promise.resolve(operation)),
    close: jest.fn(() => {
      child.abort();
      registry.get(plugin).live = false;
      drained.resolve();
    }),
  };
  const send = jest.fn((token) => {
    expect(token).toBe(operation);
    return submission.promise;
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
    reviewPreparation: jest.fn(),
    reviewTransaction: jest.fn(),
    gasLimit: 1500000n,
    maxGasFee: 2000000000000000n,
  };
  facade.createRailgunKohakuPlugin.mockImplementation((actual) => {
    expect(actual).toEqual({ ...options, mode: 'public' });
    expect(actual.account).toBe(options.account);
    expect(actual.owners).toBe(options.owners);
    registry.set(plugin, { live: true, send });
    return plugin;
  });
  return { options, plugin, operation, acknowledged, child, drained, submission, send };
}
beforeEach(() => {
  jest.resetAllMocks();
  registry = new WeakMap();
  facade.assertRailgunKohakuPublicPlugin.mockImplementation((plugin) => {
    if (!registry.get(plugin)?.live) throw Error('Unregistered or closed public instance');
  });
  facade.submitRailgunKohakuPublicOperation.mockImplementation((plugin, token) => {
    facade.assertRailgunKohakuPublicPlugin(plugin);
    return registry.get(plugin).send(token);
  });
});
function borrowedOwnersUntouched(f) {
  for (const owner of [f.options.account, ...Object.values(f.options.owners)])
    expect(owner.close).not.toHaveBeenCalled();
}

test('fixed public-only options and frozen exact host shape retain original lifetime', async () => {
  const f = fixture(),
    host = createHost(f.options);
  expect(Object.isFrozen(host)).toBe(true);
  expect(Reflect.ownKeys(host).sort()).toEqual(
    [
      'signal',
      'closed',
      'instanceId',
      'balance',
      'notes',
      'prepareShield',
      'submit',
      'close',
    ].sort()
  );
  expect(host.signal).toBe(f.plugin.signal);
  expect(host.closed).toBe(f.plugin.closed);
  expect(facade.assertRailgunKohakuPublicPlugin).toHaveBeenCalledWith(f.plugin);
  expect(facade.createRailgunKohakuPlugin).toHaveBeenCalledTimes(1);
  expect(f.send).not.toHaveBeenCalled();
  expect(host.close()).toBeUndefined();
  await host.closed;
  expect(f.plugin.close).toHaveBeenCalledTimes(1);
  borrowedOwnersUntouched(f);
});
test('read delegation preserves receiver, arguments, original promise and result', async () => {
  const f = fixture(),
    host = createHost(f.options),
    assets = Object.freeze([{ __type: 'native' }]);
  for (const [name, args] of [
    ['instanceId', []],
    ['balance', [assets]],
    ['notes', [assets, true]],
  ]) {
    const result = Object.freeze({ from: name }),
      promise = Promise.resolve(result);
    f.plugin[name].mockImplementation(function (...actual) {
      expect(this).toBe(f.plugin);
      expect(actual).toEqual(args);
      return promise;
    });
    const returned = host[name](...args);
    expect(returned).toBe(promise);
    expect(await returned).toBe(result);
  }
  host.close();
  await host.closed;
});
test.each([undefined, 'railgun-instance'])(
  'preparation forwards exact input and optional recipient, exposes only empty handle: %s',
  async (recipient) => {
    const f = fixture(),
      host = createHost(f.options),
      input = Object.freeze({ asset: Object.freeze({ __type: 'native' }), amount: 1000n });
    const prepared = await host.prepareShield(input, recipient);
    expect(f.plugin.prepareShield.mock.calls).toEqual([[input, recipient]]);
    expect(f.plugin.prepareShield.mock.contexts[0]).toBe(f.plugin);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Reflect.ownKeys(prepared)).toEqual(['handle']);
    expect(Object.isFrozen(prepared.handle)).toBe(true);
    expect(Reflect.ownKeys(prepared.handle)).toEqual([]);
    expect(prepared.handle).not.toBe(f.operation);
    const original = host.submit(prepared.handle);
    expect(original).toBe(f.submission.promise);
    expect(facade.submitRailgunKohakuPublicOperation.mock.calls).toEqual([[f.plugin, f.operation]]);
    f.submission.resolve(f.acknowledged);
    expect(await original).toBe(f.acknowledged);
    await expect(host.submit(prepared.handle)).rejects.toMatchObject(refused);
    expect(f.send).toHaveBeenCalledTimes(1);
    host.close();
    await host.closed;
  }
);
test.each(['PRIVATE_BROADCAST_UNCERTAIN', 'PRIVATE_SUBMISSION_UNRESOLVED', 'OTHER'])(
  'original admitted %s rejection and promise survive without manufactured outcome',
  async (code) => {
    const f = fixture(),
      host = createHost(f.options),
      { handle } = await host.prepareShield({}, undefined),
      error = Object.assign(Error('controller refusal'), { code });
    const pending = host.submit(handle);
    expect(pending).toBe(f.submission.promise);
    const checked = expect(pending).rejects.toBe(error);
    f.submission.reject(error);
    await checked;
    await expect(host.submit(handle)).rejects.toMatchObject(refused);
    expect(f.send).toHaveBeenCalledTimes(1);
    host.close();
    await host.closed;
  }
);
test('burns handle before synchronous original rejection and reentrant replay', async () => {
  const f = fixture(),
    host = createHost(f.options),
    { handle } = await host.prepareShield({}),
    error = Error('original synchronous throw');
  let reentrant;
  f.send.mockImplementation((token) => {
    expect(token).toBe(f.operation);
    reentrant = expect(host.submit(handle)).rejects.toMatchObject(refused);
    throw error;
  });
  try {
    host.submit(handle);
    throw Error('unexpected success');
  } catch (actual) {
    expect(actual).toBe(error);
  }
  await reentrant;
  await expect(host.submit(handle)).rejects.toMatchObject(refused);
  expect(f.send).toHaveBeenCalledTimes(1);
  host.close();
  await host.closed;
});
test('foreign, copied and raw facade tokens never consume the genuine host handle', async () => {
  const first = fixture(),
    host = createHost(first.options),
    { handle } = await host.prepareShield({});
  const second = fixture(),
    other = createHost(second.options),
    foreign = (await other.prepareShield({})).handle;
  for (const invalid of [
    foreign,
    { ...handle },
    first.operation,
    { __type: 'privateOperation' },
    null,
  ])
    await expect(host.submit(invalid)).rejects.toMatchObject(refused);
  expect(first.send).not.toHaveBeenCalled();
  const pending = host.submit(handle);
  first.submission.resolve(first.acknowledged);
  expect(await pending).toBe(first.acknowledged);
  expect(first.send).toHaveBeenCalledTimes(1);
  expect(second.send).not.toHaveBeenCalled();
  host.close();
  other.close();
  await Promise.all([host.closed, other.closed]);
});
test('close revokes unused handles and reserves idempotence before reentrant facade close', async () => {
  const f = fixture(),
    host = createHost(f.options),
    { handle } = await host.prepareShield({});
  f.plugin.close.mockImplementation(() => {
    host.close();
    f.child.abort();
    f.drained.resolve();
  });
  host.close();
  host.close();
  await expect(host.submit(handle)).rejects.toMatchObject(refused);
  await expect(host.prepareShield({})).rejects.toMatchObject(refused);
  expect(f.plugin.prepareShield).toHaveBeenCalledTimes(1);
  expect(f.send).not.toHaveBeenCalled();
  expect(f.plugin.close).toHaveBeenCalledTimes(1);
  await host.closed;
  borrowedOwnersUntouched(f);
});
test('late successful preparation after close never publishes a host handle', async () => {
  const f = fixture(),
    preparation = deferred(),
    host = createHost(f.options);
  f.plugin.prepareShield.mockReturnValue(preparation.promise);
  const pending = host.prepareShield({});
  host.close();
  preparation.resolve(f.operation);
  await expect(pending).rejects.toMatchObject(refused);
  expect(f.send).not.toHaveBeenCalled();
  await host.closed;
});
test('prepare rejection remains the original error', async () => {
  const f = fixture(),
    error = Error('preparation denied'),
    host = createHost(f.options);
  f.plugin.prepareShield.mockRejectedValue(error);
  await expect(host.prepareShield({})).rejects.toBe(error);
  expect(f.send).not.toHaveBeenCalled();
  host.close();
  await host.closed;
});
test('admitted outward rejection survives close while the original logical drain stays pending', async () => {
  const f = fixture(),
    host = createHost(f.options),
    { handle } = await host.prepareShield({}),
    error = Error('controller review-draining');
  f.plugin.close.mockImplementation(() => f.child.abort());
  let closed = false;
  host.closed.then(() => (closed = true));
  const pending = host.submit(handle);
  host.close();
  expect(pending).toBe(f.submission.promise);
  const checked = expect(pending).rejects.toBe(error);
  f.submission.reject(error);
  await checked;
  expect(closed).toBe(false);
  borrowedOwnersUntouched(f);
  f.drained.resolve();
  await host.closed;
  expect(closed).toBe(true);
});
test('cleanup failure does not replace an acknowledged submission', async () => {
  const f = fixture(),
    host = createHost(f.options),
    { handle } = await host.prepareShield({}),
    error = Error('cleanup failed');
  const pending = host.submit(handle);
  f.plugin.close.mockImplementation(() => {
    f.child.abort();
    f.drained.reject(error);
    throw error;
  });
  const closed = expect(host.closed).rejects.toBe(error);
  expect(() => host.close()).toThrow(error);
  host.close();
  expect(f.plugin.close).toHaveBeenCalledTimes(1);
  f.submission.resolve(f.acknowledged);
  expect(await pending).toBe(f.acknowledged);
  await closed;
});
test.each(['mode', 'host', 'ports', 'proverArchive', 'artifactDirectory', 'signer', 'controller'])(
  'extra %s refuses before adoption',
  (name) => {
    const f = fixture();
    expect(() => createHost({ ...f.options, [name]: {} })).toThrow(
      'Kohaku public host unavailable'
    );
    expect(facade.createRailgunKohakuPlugin).not.toHaveBeenCalled();
    expect(f.plugin.close).not.toHaveBeenCalled();
    borrowedOwnersUntouched(f);
  }
);
test('accessors and proxies refuse without evaluating caller hooks or adopting account', () => {
  const f = fixture(),
    getter = jest.fn(),
    trap = jest.fn();
  const accessor = { ...f.options };
  Object.defineProperty(accessor, 'archive', { get: getter });
  expect(() => createHost(accessor)).toThrow('Kohaku public host unavailable');
  const proxy = new Proxy(f.options, { getPrototypeOf: trap, ownKeys: trap, get: trap });
  expect(() => createHost(proxy)).toThrow('Kohaku public host unavailable');
  expect(getter).not.toHaveBeenCalled();
  expect(trap).not.toHaveBeenCalled();
  expect(facade.createRailgunKohakuPlugin).not.toHaveBeenCalled();
  borrowedOwnersUntouched(f);
});
test('factory refusal before returned adoption never closes caller account or owners', () => {
  const f = fixture();
  facade.createRailgunKohakuPlugin.mockImplementation(() => {
    throw Error('bad genuine owner');
  });
  expect(() => createHost(f.options)).toThrow('Kohaku public host unavailable');
  expect(f.plugin.close).not.toHaveBeenCalled();
  borrowedOwnersUntouched(f);
});
test.each([false, true])(
  'post-adoption submitter refusal observes deferred drain even when close throws: %s',
  async (throws) => {
    const f = fixture(),
      drainError = Error('later drain failure');
    facade.assertRailgunKohakuPublicPlugin.mockImplementation(() => {
      throw Error('public instance no longer available');
    });
    f.plugin.close.mockImplementation(() => {
      f.child.abort();
      if (throws) throw Error('close failure');
    });
    const observed = jest.spyOn(Promise.prototype, 'then');
    try {
      expect(() => createHost(f.options)).toThrow('Kohaku public host unavailable');
      expect(f.plugin.close).toHaveBeenCalledTimes(1);
      expect(f.plugin.signal.aborted).toBe(true);
      const index = observed.mock.contexts.indexOf(f.plugin.closed);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(observed.mock.calls[index]).toHaveLength(2);
      expect(observed.mock.calls[index].every((callback) => typeof callback === 'function')).toBe(
        true
      );
    } finally {
      observed.mockRestore();
    }
    borrowedOwnersUntouched(f);
    // Construction has already refused synchronously; the independent original
    // barrier can still reject later and was observed by the host cleanup path.
    f.drained.reject(drainError);
    await expect(f.plugin.closed).rejects.toBe(drainError);
  }
);

test('external facade abort refuses unused submission and late preparation without host-close substitution', async () => {
  const first = fixture(),
    firstHost = createHost(first.options),
    { handle } = await firstHost.prepareShield({});
  first.child.abort();
  await expect(firstHost.submit(handle)).rejects.toMatchObject(refused);
  await expect(firstHost.prepareShield({})).rejects.toMatchObject(refused);
  expect(first.send).not.toHaveBeenCalled();
  expect(first.plugin.prepareShield).toHaveBeenCalledTimes(1);
  firstHost.close();
  await firstHost.closed;

  const second = fixture(),
    held = deferred(),
    secondHost = createHost(second.options);
  second.plugin.prepareShield.mockReturnValue(held.promise);
  const pending = secondHost.prepareShield({});
  second.child.abort();
  held.resolve(second.operation);
  await expect(pending).rejects.toMatchObject(refused);
  expect(second.send).not.toHaveBeenCalled();
  secondHost.close();
  await secondHost.closed;
});
