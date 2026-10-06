const {
  createRailgunKohakuPrivateAdapter: create,
  createRailgunKohakuPrivateAdapterBroadcaster: broadcaster,
} = require('./railgun-kohaku-private-adapter');
const {
  independentPrivateHost,
  checkPrivateConformance,
  deferred,
  INSTANCE,
  HASH,
  ADDRESS,
} = require('../../../scripts/fixtures/railgun-kohaku-private-conformance');
const pins = require('./railgun-shield-pins.json');
const CODE = 'RAILGUN_KOHAKU_PRIVATE_ADAPTER_REFUSED';
function fixture() {
  const f = independentPrivateHost();
  f.signal = new AbortController();
  f.open = () => (f.instance = create({ host: f.host, signal: f.signal.signal }));
  f.prepare = () => f.instance.prepareTransfer(f.input, INSTANCE);
  return f;
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
test.each(['transfer', 'unshield', 'partial'])(
  'independent host complete %s conformance',
  async (kind) => {
    expect(await checkPrivateConformance(create, broadcaster, kind)).toEqual({
      kind,
      reads: 3,
      preparation: 1,
      broadcast: 1,
      close: 1,
      authority: false,
    });
  }
);
test('reads return mutable fully detached data across calls', async () => {
  const f = fixture();
  f.open();
  const notes = await f.instance.notes();
  notes[0].asset.contract = ADDRESS;
  notes[0].amount = 0n;
  notes.push({});
  expect((await f.instance.notes())[0].asset.contract).toBe(pins.wrappedNative);
  const balances = await f.instance.balance();
  balances[0].amount = 7n;
  balances[0].asset.contract = ADDRESS;
  expect((await f.instance.balance())[0].amount).toBe(2000n);
  f.instance.close();
  await f.instance.closed;
});
test('non-enumerable input asset fields copied explicitly', async () => {
  const f = fixture();
  f.open();
  const asset = Object.defineProperties(
    {},
    { __type: { value: 'erc20' }, contract: { value: pins.wrappedNative } }
  );
  await f.instance.prepareTransfer({ ...f.input, asset }, INSTANCE);
  expect(f.calls[0].value.asset).toEqual(f.input.asset);
  f.instance.close();
  await f.instance.closed;
});
test.each([
  [
    'negative',
    (v) => {
      v.amount = -1n;
    },
  ],
  [
    'number',
    (v) => {
      v.amount = 1;
    },
  ],
  [
    'over-integration-cap',
    (v) => {
      v.amount = BigInt(pins.maxQualificationAmount) + 1n;
    },
  ],
  [
    'coordinate',
    (v) => {
      v.noteId = '256:0';
    },
  ],
  [
    'extra',
    (v) => {
      v.extra = true;
    },
  ],
  [
    'accessor',
    (v) => {
      Object.defineProperty(v, 'amount', {
        get() {
          throw Error('getter executed');
        },
      });
    },
  ],
])('invalid %s input refuses before host work', async (_, mutate) => {
  const f = fixture();
  f.open();
  const input = { ...f.input };
  mutate(input);
  await expect(f.instance.prepareTransfer(input, INSTANCE)).rejects.toMatchObject({ code: CODE });
  expect(f.calls).toEqual([]);
  f.instance.close();
  await f.instance.closed;
});
test('unsupported tail calls refuse without invoking them', async () => {
  const f = fixture();
  f.open();
  const tailCalls = jest.fn();
  await expect(f.instance.prepareUnshield(f.input, ADDRESS, { tailCalls })).rejects.toMatchObject({
    code: CODE,
  });
  expect(tailCalls).not.toHaveBeenCalled();
  expect(f.calls).toEqual([]);
  f.instance.close();
  await f.instance.closed;
});
test('copies amount before await and admits only one preparation', async () => {
  const f = fixture(),
    held = deferred();
  let captured;
  f.host.prepareTransfer = (value) => {
    captured = value;
    return held.promise;
  };
  f.open();
  const work = f.prepare();
  f.input.amount = 1n;
  expect(captured.amount).toBe(2000n);
  expect(Object.isFrozen(captured.asset)).toBe(true);
  await expect(f.prepare()).rejects.toMatchObject({ code: CODE });
  held.resolve({ handle: Object.freeze({}) });
  await work;
  f.instance.close();
  await f.instance.closed;
});
test('transfer destination keeps its Kohaku meaning and reaches the host unchanged', async () => {
  const f = fixture(),
    seen = [];
  f.host.prepareTransfer = async (_value, to) => {
    seen.push(to);
    return { handle: Object.freeze({}) };
  };
  f.open();
  // The adapter neither resolves self nor rewrites a different account's address;
  // the trusted host owns the self/foreign decision and its verification.
  await f.instance.prepareTransfer(f.input, '0zk1' + 'p'.repeat(123));
  expect(seen).toEqual(['0zk1' + 'p'.repeat(123)]);
  f.instance.close();
  await f.instance.closed;
});
test.each([
  '0ZK1' + 'P'.repeat(123),
  '0zk1' + 'p'.repeat(122),
  '0zk1' + 'p'.repeat(124),
  '0zk1' + 'b'.repeat(123),
  ADDRESS,
  7,
  undefined,
])('malformed transfer destination %p refuses before host work', async (to) => {
  const f = fixture();
  f.open();
  await expect(f.instance.prepareTransfer(f.input, to)).rejects.toMatchObject({ code: CODE });
  expect(f.calls).toEqual([]);
  f.instance.close();
  await f.instance.closed;
});
test('copied and foreign operations do not consume genuine token; replay does', async () => {
  const a = fixture(),
    b = fixture();
  a.open();
  b.open();
  const op = await a.prepare(),
    other = await b.prepare();
  await expect(broadcaster(a.instance).broadcast({ ...op })).rejects.toMatchObject({ code: CODE });
  await expect(broadcaster(a.instance).broadcast(other)).rejects.toMatchObject({ code: CODE });
  expect(await broadcaster(a.instance).broadcast(op)).toBe(a.acknowledged);
  await expect(broadcaster(a.instance).broadcast(op)).rejects.toMatchObject({ code: CODE });
  b.instance.close();
  await Promise.all([a.instance.closed, b.instance.closed]);
});
test('host cannot be adopted twice or fake adapter made into broadcaster', async () => {
  const f = fixture();
  f.open();
  expect(() => f.open()).toThrow();
  expect(() => broadcaster({})).toThrow();
  f.instance.close();
  await f.instance.closed;
});
test('expiry discards prepared token and closes exactly once', async () => {
  const f = fixture();
  f.open();
  const token = await f.prepare();
  f.controller.abort();
  await expect(broadcaster(f.instance).broadcast(token)).rejects.toMatchObject({ code: CODE });
  await f.instance.closed;
  expect(f.calls.filter((v) => v.method === 'close')).toHaveLength(1);
});
test('held preparation cancels outward but late handle waits for actual host drain', async () => {
  const f = fixture(),
    held = deferred();
  f.host.prepareTransfer = () => held.promise;
  f.host.close = () => f.controller.abort();
  f.open();
  const pending = f.prepare();
  f.instance.close();
  await expect(pending).rejects.toMatchObject({ code: CODE });
  let closed = false;
  f.instance.closed.then(() => {
    closed = true;
  });
  await tick();
  expect(closed).toBe(false);
  held.resolve({ handle: Object.freeze({}) });
  await tick();
  expect(closed).toBe(false);
  f.drain.resolve();
  await f.instance.closed;
  expect(closed).toBe(true);
});
test('reentrant close cannot publish preparation or finish before admitted work', async () => {
  const f = fixture(),
    held = deferred();
  f.host.prepareTransfer = () => {
    f.instance.close();
    return held.promise;
  };
  f.open();
  const pending = f.prepare();
  await expect(pending).rejects.toMatchObject({ code: CODE });
  let closed = false;
  f.instance.closed.then(() => {
    closed = true;
  });
  await tick();
  expect(closed).toBe(false);
  held.resolve({ handle: Object.freeze({}) });
  await f.instance.closed;
  expect(closed).toBe(true);
});
test('read admission prevents preparation; late read refuses after close', async () => {
  const f = fixture(),
    held = deferred();
  f.host.notes = () => held.promise;
  f.open();
  const reading = f.instance.notes();
  await expect(f.prepare()).rejects.toMatchObject({ code: CODE });
  f.instance.close();
  await expect(reading).rejects.toMatchObject({ code: CODE });
  held.resolve(f.values);
  await f.instance.closed;
});
test.each(['sync-throw', 'rejected-promise', 'throwing-then'])(
  'preparation %s is sanitized and drained',
  async (kind) => {
    const f = fixture(),
      getter = jest.fn(() => {
        throw Error('secret');
      });
    f.host.prepareTransfer = () => {
      if (kind === 'sync-throw') throw Error('secret');
      if (kind === 'rejected-promise') return Promise.reject(Error('secret'));
      return Object.defineProperty({}, 'then', { get: getter });
    };
    f.open();
    await expect(f.prepare()).rejects.toMatchObject({ code: CODE });
    await f.instance.closed;
    expect(getter).not.toHaveBeenCalled();
  }
);
test.each(['throw', 'reject'])(
  'admitted broadcast %s rejects sanitized, burns token and closes',
  async (kind) => {
    const f = fixture();
    f.host.broadcast = () => {
      if (kind === 'throw') throw Error('secret');
      return Promise.reject(Error('secret'));
    };
    f.open();
    const token = await f.prepare();
    await expect(broadcaster(f.instance).broadcast(token)).rejects.toMatchObject({ code: CODE });
    await f.instance.closed;
    await expect(broadcaster(f.instance).broadcast(token)).rejects.toMatchObject({ code: CODE });
  }
);
test.each([
  ['acknowledged', null],
  ['uncertain', { transactionHash: HASH, submissionStatus: 'unknown' }],
  ['recovery', { status: 'recovery-required', stage: 'review-draining' }],
])('%s original outcome survives cancellation after invocation', async (_, value) => {
  const f = fixture(),
    held = deferred();
  const result = value || f.acknowledged;
  f.host.broadcast = () => held.promise;
  f.open();
  const token = await f.prepare();
  const pending = broadcaster(f.instance).broadcast(token);
  f.signal.abort();
  held.resolve(result);
  expect(await pending).toBe(result);
  await f.instance.closed;
});
test.each([
  [
    'extra ordinary fields',
    (v) => {
      v.submissionState = 'submitted';
      v.requiresReconciliation = true;
    },
    true,
  ],
  [
    'wrong source',
    (v) => {
      v.broadcastSource = 'myotis';
    },
    true,
  ],
  [
    'wrong chain',
    (v) => {
      v.chainId = '11155111';
    },
    true,
  ],
  [
    'wrong value',
    (v) => {
      v.value = 0;
    },
    true,
  ],
  [
    'bad nonce',
    (v) => {
      v.nonce = 1.5;
    },
    true,
  ],
  [
    'conflicting hashes',
    (v) => {
      v.transactionHash = HASH;
    },
    false,
  ],
  [
    'missing hash',
    (v) => {
      delete v.hash;
    },
    false,
  ],
  [
    'noncanonical hash',
    (v) => {
      v.hash = '0x' + 'A'.repeat(64);
    },
    false,
  ],
])('malformed %s has bounded uncertainty semantics', async (_, change, salvage) => {
  const f = fixture();
  const result = { ...f.acknowledged };
  change(result);
  f.host.broadcast = async () => result;
  f.open();
  const token = await f.prepare();
  expect(await broadcaster(f.instance).broadcast(token)).toEqual(
    salvage
      ? { transactionHash: HASH, submissionStatus: 'unknown' }
      : { status: 'recovery-required', stage: 'adapter-contract' }
  );
  await f.instance.closed;
});
test('malformed hash accessor never runs or authorizes salvage', async () => {
  const f = fixture(),
    getter = jest.fn();
  f.host.broadcast = async () => Object.defineProperty({}, 'hash', { get: getter });
  f.open();
  expect(await broadcaster(f.instance).broadcast(await f.prepare())).toEqual({
    status: 'recovery-required',
    stage: 'adapter-contract',
  });
  expect(getter).not.toHaveBeenCalled();
  await f.instance.closed;
});
test.each(['throwing-close', 'rejected-closed', 'nonvoid-closed'])(
  '%s cannot manufacture successful drain',
  async (kind) => {
    const f = fixture();
    if (kind === 'throwing-close')
      f.host.close = () => {
        f.drain.resolve();
        throw Error('secret');
      };
    f.open();
    if (kind === 'rejected-closed') f.drain.reject(Error('secret'));
    else if (kind === 'nonvoid-closed') f.drain.resolve(false);
    else f.instance.close();
    await expect(f.instance.closed).rejects.toMatchObject({ code: CODE });
  }
);
test('fulfilled data gets a late then getter: refuse without re-assimilating it', async () => {
  const f = fixture(),
    then = jest.fn(() => {
      throw Error('must not execute');
    });
  f.host.prepareTransfer = () => {
    const value = { handle: Object.freeze({}) };
    const promise = Promise.resolve(value);
    Object.defineProperty(value, 'then', { get: then });
    return promise;
  };
  f.open();
  await expect(f.prepare()).rejects.toMatchObject({ code: CODE });
  await f.instance.closed;
  expect(then).not.toHaveBeenCalled();
});
test('already fulfilled broadcast data with a late then getter salvages hash without executing getter', async () => {
  const f = fixture(),
    then = jest.fn(() => {
      throw Error('must not execute');
    });
  f.host.broadcast = () => {
    const value = { ...f.acknowledged };
    const promise = Promise.resolve(value);
    Object.defineProperty(value, 'then', { get: then });
    return promise;
  };
  f.open();
  expect(await broadcaster(f.instance).broadcast(await f.prepare())).toEqual({
    transactionHash: HASH,
    submissionStatus: 'unknown',
  });
  await f.instance.closed;
  expect(then).not.toHaveBeenCalled();
});
test('malformed rejected actual Promise is observed before contract refusal', async () => {
  const f = fixture();
  f.host.prepareTransfer = () => {
    const promise = Promise.reject(Error('sensitive error'));
    promise.extra = true;
    return promise;
  };
  f.open();
  await expect(f.prepare()).rejects.toMatchObject({ code: CODE });
  await f.instance.closed;
  await tick();
});
test('malformed held native Promise cannot be erased from adapter drain', async () => {
  const f = fixture(),
    held = deferred();
  held.promise.extra = true;
  f.host.prepareTransfer = () => held.promise;
  f.open();
  await expect(f.prepare()).rejects.toMatchObject({ code: CODE });
  let closed = false;
  f.instance.closed.then(() => {
    closed = true;
  });
  await tick();
  expect(closed).toBe(false);
  held.resolve({});
  await f.instance.closed;
});
test('invalid asynchronous close is observed and awaited, then closed rejects', async () => {
  const f = fixture(),
    held = deferred();
  f.host.close = () => {
    f.drain.resolve();
    return held.promise;
  };
  f.open();
  f.instance.close();
  let settled = false;
  f.instance.closed.catch(() => {
    settled = true;
  });
  await tick();
  expect(settled).toBe(false);
  held.reject(Error('private error'));
  await expect(f.instance.closed).rejects.toMatchObject({ code: CODE });
});
test('positive integration cap is forwarded without protocol-wide amount claim', async () => {
  const f = fixture();
  let input;
  f.host.prepareUnshield = async (value) => {
    input = value;
    return { handle: Object.freeze({}) };
  };
  f.open();
  await f.instance.prepareUnshield(
    { ...f.input, amount: BigInt(pins.maxQualificationAmount) },
    ADDRESS
  );
  expect(input.amount).toBe(BigInt(pins.maxQualificationAmount));
  f.instance.close();
  await f.instance.closed;
});
test('caller input accessors and proxy traps cannot execute during validation', async () => {
  const f = fixture();
  f.open();
  const getPrototypeOf = jest.fn();
  await expect(
    f.instance.prepareTransfer(new Proxy(f.input, { getPrototypeOf }), INSTANCE)
  ).rejects.toMatchObject({ code: CODE });
  expect(getPrototypeOf).not.toHaveBeenCalled();
  expect(f.calls).toHaveLength(0);
  f.instance.close();
  await f.instance.closed;
});
test.each([
  'null',
  'wronghash',
  'wrongamount',
  'wrongasset',
  'wrongid',
  'duplicated',
  'nonarray',
  'accessor',
  'erc1155',
])('read response %s refuses bounded data without exposing input', async (kind) => {
  const f = fixture();
  let value = structuredClone(f.values);
  if (kind === 'null') value = null;
  if (kind === 'wronghash') value[0].hash = '0x' + 'f'.repeat(64);
  if (kind === 'wrongamount') value[0].amount = 1n << 120n;
  if (kind === 'wrongasset') value[0].asset.extra = true;
  if (kind === 'wrongid') value[0].id = '0:0';
  if (kind === 'duplicated') value.push(value[0]);
  if (kind === 'nonarray') value = { 0: value[0], length: 1 };
  const getter = jest.fn();
  if (kind === 'accessor') Object.defineProperty(value[0], 'amount', { get: getter });
  if (kind === 'erc1155') value[0].asset = { __type: 'erc1155', contract: ADDRESS, tokenId: 1n };
  f.host.notes = async () => value;
  f.open();
  await expect(f.instance.notes()).rejects.toMatchObject({ code: CODE });
  expect(getter).not.toHaveBeenCalled();
  f.instance.close();
  await f.instance.closed;
});
test('checksummed EIP55 address output is preserved and invalid mixed case is uncertain', async () => {
  const f = fixture();
  const { getAddress } = require('ethers');
  f.acknowledged.to = getAddress(pins.proxy);
  f.open();
  const result = await broadcaster(f.instance).broadcast(await f.prepare());
  expect(result).toBe(f.acknowledged);
  expect(result.to).toBe(getAddress(pins.proxy));
  await f.instance.closed;
  const g = fixture();
  g.acknowledged.to = '0xEcfcf3b4ec647c4ca6d49108b311b7a7c9543fea';
  g.open();
  expect(await broadcaster(g.instance).broadcast(await g.prepare())).toEqual({
    transactionHash: HASH,
    submissionStatus: 'unknown',
  });
  await g.instance.closed;
});
test.each(['read', 'prepare'])(
  'microtask abort before %s publication refuses, even with delayed outward race',
  async (kind) => {
    const f = fixture();
    f.open();
    const pending = kind === 'read' ? f.instance.notes() : f.prepare();
    queueMicrotask(() => f.signal.abort());
    await expect(pending).rejects.toMatchObject({ code: CODE });
    await f.instance.closed;
  }
);
test('foreign-token refusal leaves pending host work count exactly zero', async () => {
  const f = fixture();
  f.open();
  const token = await f.prepare();
  const original = f.host.broadcast,
    forwarded = jest.fn(original); // callbacks are snapshotted at adoption
  const g = fixture();
  g.host.broadcast = forwarded;
  g.open();
  const genuine = await g.prepare();
  await expect(broadcaster(g.instance).broadcast(token)).rejects.toMatchObject({ code: CODE });
  expect(forwarded).not.toHaveBeenCalled();
  g.instance.close();
  f.instance.close();
  await Promise.all([f.instance.closed, g.instance.closed]);
  expect(genuine.__type).toBe('privateOperation');
});
test('fulfilled host.closed revokes a live adapter and closes host exactly once', async () => {
  const f = fixture();
  f.open();
  f.drain.resolve();
  await f.instance.closed;
  expect(f.instance.signal.aborted).toBe(true);
  expect(f.calls).toEqual([{ method: 'close' }]);
  await expect(f.instance.notes()).rejects.toMatchObject({ code: CODE });
  await expect(f.prepare()).rejects.toMatchObject({ code: CODE });
  f.instance.close();
  await f.instance.closed;
  expect(f.calls).toEqual([{ method: 'close' }]);
});

// Public vectors from the pinned ethers address documentation. Outcome spelling
// remains unchanged; the adapter requires its declared prefixed 20-byte shape.
describe.each(['from', 'to'])('acknowledged %s address shape', (field) => {
  test.each([
    ['lowercase', '0x8ba1f109551bd432803012645ac136ddd64dba72'],
    ['uppercase', '0x8BA1F109551BD432803012645AC136DDD64DBA72'],
    ['checksum', '0x8ba1f109551bD432803012645Ac136ddd64DBA72'],
  ])('preserves %s address and outcome identity', async (_, address) => {
    const f = fixture();
    f.acknowledged[field] = address;
    f.open();
    const operation = await f.prepare();
    const result = await broadcaster(f.instance).broadcast(operation);
    expect(result).toBe(f.acknowledged);
    expect(result[field]).toBe(address);
    await f.instance.closed;
    await expect(broadcaster(f.instance).broadcast(operation)).rejects.toMatchObject({
      code: CODE,
    });
  });
  test.each([
    ['ICAP', 'XE65GB6LDNXYOFTX0NSV3FUWKOWIXAMJK36'],
    ['unprefixed', '8ba1f109551bd432803012645ac136ddd64dba72'],
    ['invalid checksum', '0x8Ba1f109551bD432803012645Ac136ddd64DBA72'],
    ['short', '0x1234'],
    ['nonhex', '0x8ba1f109551bd432803012645ac136ddd64dba7g'],
  ])('salvages %s acknowledgement as uncertainty', async (_, address) => {
    const f = fixture();
    f.acknowledged[field] = address;
    f.open();
    const operation = await f.prepare();
    const result = await broadcaster(f.instance).broadcast(operation);
    expect(result).toEqual({ transactionHash: HASH, submissionStatus: 'unknown' });
    expect(result).not.toBe(f.acknowledged);
    expect(Object.isFrozen(result)).toBe(true);
    await f.instance.closed;
    await expect(broadcaster(f.instance).broadcast(operation)).rejects.toMatchObject({
      code: CODE,
    });
  });
});

function unobservablePromise(kind) {
  const held = deferred();
  let entries = 0;
  const descriptor = {
    get() {
      entries++;
      throw Error('unobservable host work');
    },
  };
  if (kind === 'constructor') Object.defineProperty(held.promise, 'constructor', descriptor);
  else
    Object.defineProperty(held.promise, 'constructor', {
      value: Object.defineProperty({}, Symbol.species, descriptor),
    });
  return { held, entries: () => entries };
}
async function closedState(instance) {
  let state = 'pending';
  instance.closed.then(
    () => {
      state = 'fulfilled';
    },
    (error) => {
      state = error.code;
    }
  );
  await tick();
  return state;
}
test.each([
  ['constructor', 'prepareTransfer'],
  ['species', 'prepareTransfer'],
  ['constructor', 'broadcast'],
  ['species', 'broadcast'],
  ['constructor', 'instanceId'],
  ['species', 'instanceId'],
])('unobservable %s promise from %s refuses reuse and rejects drainage', async (kind, method) => {
  const f = fixture(),
    bad = unobservablePromise(kind);
  let callbackEntries = 0;
  f.host[method] = () => {
    callbackEntries++;
    return bad.held.promise;
  };
  f.open();
  const result =
    method === 'broadcast'
      ? broadcaster(f.instance).broadcast(await f.prepare())
      : method === 'instanceId'
        ? f.instance.instanceId()
        : f.prepare();
  await expect(result).rejects.toMatchObject({ code: CODE });
  expect(callbackEntries).toBe(1);
  expect(bad.entries()).toBe(1);
  expect(f.instance.signal.aborted).toBe(true);
  expect(f.calls.filter((call) => call.method === 'close')).toHaveLength(1);
  expect(await closedState(f.instance)).toBe(CODE);
  await expect(f.prepare()).rejects.toMatchObject({ code: CODE });
  expect(callbackEntries).toBe(1);
  // A later host settlement cannot turn failed observation into successful drain.
  bad.held.resolve({});
  expect(await closedState(f.instance)).toBe(CODE);
});
test.each(['constructor', 'species'])(
  'unobservable %s close return preserves acknowledged identity and rejects drainage',
  async (kind) => {
    const f = fixture(),
      bad = unobservablePromise(kind),
      close = f.host.close;
    f.host.close = () => {
      close();
      return bad.held.promise;
    };
    f.open();
    const token = await f.prepare();
    expect(await broadcaster(f.instance).broadcast(token)).toBe(f.acknowledged);
    expect(await closedState(f.instance)).toBe(CODE);
    expect(bad.entries()).toBe(1);
    expect(f.calls.filter((call) => call.method === 'close')).toHaveLength(1);
    await expect(broadcaster(f.instance).broadcast(token)).rejects.toMatchObject({ code: CODE });
    bad.held.resolve();
    expect(await closedState(f.instance)).toBe(CODE);
  }
);
test('unobservable work still waits for other admitted observable reads and host closure', async () => {
  const f = fixture(),
    held = deferred(),
    bad = unobservablePromise('species');
  f.host.instanceId = () => held.promise;
  f.host.balance = () => bad.held.promise;
  f.host.close = () => {
    f.calls.push({ method: 'close' });
  };
  f.open();
  const read = f.instance.instanceId();
  const readRejection = expect(read).rejects.toMatchObject({ code: CODE });
  await expect(f.instance.balance()).rejects.toMatchObject({ code: CODE });
  expect(f.instance.signal.aborted).toBe(true);
  await readRejection;
  expect(await closedState(f.instance)).toBe('pending');
  f.drain.resolve();
  expect(await closedState(f.instance)).toBe('pending');
  held.resolve(INSTANCE);
  expect(await closedState(f.instance)).toBe(CODE);
  bad.held.resolve();
});
