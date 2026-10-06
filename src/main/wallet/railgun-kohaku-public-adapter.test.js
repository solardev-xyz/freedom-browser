const {
  createRailgunKohakuPublicAdapter: create,
  createRailgunKohakuPublicAdapterSubmitter: submitter,
} = require('./railgun-kohaku-public-adapter');
const {
  independentPublicHost,
  checkPublicConformance,
  deferred,
  INSTANCE,
  HASH,
} = require('../../../scripts/fixtures/railgun-kohaku-public-conformance');
const CODE = 'RAILGUN_KOHAKU_PUBLIC_ADAPTER_REFUSED';
const CONTRACT = 'RAILGUN_KOHAKU_PUBLIC_ADAPTER_CONTRACT';
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(change = () => {}) {
  const f = independentPublicHost();
  change(f);
  f.signal = new AbortController();
  f.adapter = create({ host: f.host, signal: f.signal.signal });
  f.submitter = submitter(f.adapter);
  f.prepare = () => f.adapter.prepareShield(f.input, INSTANCE);
  return f;
}
test('complete independent public conformance', async () => {
  expect(await checkPublicConformance(create, submitter)).toEqual({
    reads: 4,
    preparation: 1,
    submission: 1,
    close: 1,
    authority: false,
  });
});
test('separate submit-only surface and detached read data', async () => {
  const f = fixture();
  expect(Reflect.ownKeys(f.submitter)).toEqual(['submit']);
  expect(f.adapter.prepareTransfer).toBeUndefined();
  expect(f.adapter.prepareUnshield).toBeUndefined();
  expect(f.adapter.prepareShieldMulti).toBeUndefined();
  const balances = await f.adapter.balance();
  balances[0].asset.contract = '0x' + 'ff'.repeat(20);
  balances[0].amount = 3n;
  balances.push({});
  expect((await f.adapter.balance())[0].amount).toBe(2000n);
  expect((await f.adapter.balance())[0].asset.contract).not.toBe(balances[0].asset.contract);
  f.adapter.close();
  await f.adapter.closed;
});
test.each([0n, -1n, 10000000000000001n, 1, '1'])(
  'invalid amount %s has no host entry and allows valid later input',
  async (amount) => {
    const f = fixture();
    await expect(f.adapter.prepareShield({ ...f.input, amount })).rejects.toMatchObject({
      code: CODE,
    });
    expect(f.calls).toEqual([]);
    await f.prepare();
    f.adapter.close();
    await f.adapter.closed;
  }
);
test.each(['asset', 'recipient', 'extra', 'getter'])(
  'invalid %s input refuses without getters/host work',
  async (kind) => {
    const f = fixture();
    let getter = 0;
    const value = { ...f.input };
    if (kind === 'asset') value.asset = { __type: 'erc20', contract: '0x' + '11'.repeat(20) };
    if (kind === 'extra') value.tag = 'unverified';
    if (kind === 'getter')
      Object.defineProperty(value, 'amount', {
        get() {
          getter++;
          return 1n;
        },
      });
    await expect(
      f.adapter.prepareShield(value, kind === 'recipient' ? 'bad' : INSTANCE)
    ).rejects.toMatchObject({ code: CODE });
    expect(getter).toBe(0);
    expect(f.calls).toEqual([]);
    f.adapter.close();
    await f.adapter.closed;
  }
);
test('native-only detached amount survives caller and host argument mutation attempts', async () => {
  let supplied;
  const f = fixture((f) => {
    const original = f.host.prepareShield;
    f.host.prepareShield = (value, to) => {
      supplied = value;
      return original(value, to);
    };
  });
  const pending = f.prepare();
  f.input.amount = 2n;
  f.input.asset.__type = 'erc20';
  expect(supplied.amount).toBe(1000n);
  expect(Object.isFrozen(supplied)).toBe(true);
  expect(Object.isFrozen(supplied.asset)).toBe(true);
  expect(Reflect.set(supplied, 'amount', 3n)).toBe(false);
  const operation = await pending;
  expect(await f.submitter.submit(operation)).toBe(f.acknowledged);
  await f.adapter.closed;
});
test.each(['value', 'hash', 'address', 'icap', 'unprefixed', 'chain', 'extra'])(
  'malformed fulfilled %s is a distinct contract rejection',
  async (kind) => {
    const f = fixture(),
      op = await f.prepare();
    if (kind === 'value') f.acknowledged.value = '2';
    if (kind === 'hash') f.acknowledged.hash = 'bad';
    if (kind === 'address') f.acknowledged.to = '0x8Ba1f109551bD432803012645Ac136ddd64DBA72';
    if (kind === 'icap') f.acknowledged.from = 'XE65GB6LDNXYOFTX0NSV3FUWKOWIXAMJK36';
    if (kind === 'unprefixed') f.acknowledged.from = '8ba1f109551bd432803012645ac136ddd64dba72';
    if (kind === 'chain') f.acknowledged.chainId = 1;
    if (kind === 'extra') f.acknowledged.submissionState = 'submitted';
    await expect(f.submitter.submit(op)).rejects.toMatchObject({
      code: CONTRACT,
      submissionMayHaveOccurred: true,
    });
    await f.adapter.closed;
    await expect(f.submitter.submit(op)).rejects.toMatchObject({ code: CODE });
    expect(f.calls.filter((x) => x === 'submit')).toHaveLength(1);
  }
);
test.each(['from', 'to'])(
  'valid mixed-case %s preserves exact original acknowledgement',
  async (field) => {
    const f = fixture(),
      op = await f.prepare();
    f.acknowledged[field] = '0x8ba1f109551bD432803012645Ac136ddd64DBA72';
    expect(await f.submitter.submit(op)).toBe(f.acknowledged);
    await f.adapter.closed;
  }
);
test.each([
  'PRIVATE_BROADCAST_UNCERTAIN',
  'PRIVATE_SUBMISSION_UNRESOLVED',
  'RAILGUN_KOHAKU_REFUSED',
])('public %s remains an original rejection, never fulfilled private outcome', async (code) => {
  const error = Object.assign(new Error('original'), { code });
  if (code === 'PRIVATE_BROADCAST_UNCERTAIN')
    Object.assign(error, { transactionHash: HASH, submissionStatus: 'unknown' });
  const f = fixture((f) => {
    f.host.submit = () => Promise.reject(error);
  });
  await expect(f.submitter.submit(await f.prepare())).rejects.toBe(error);
  await f.adapter.closed;
});
test.each(['prepareShield', 'submit'])(
  'admitted %s sync throw and native rejection retain reason identity',
  async (method) => {
    for (const sync of [true, false]) {
      const error = Object.freeze({ privateHostReason: 'opaque' });
      const f = fixture((f) => {
        f.host[method] = () => {
          if (sync) throw error;
          return Promise.reject(error);
        };
      });
      await expect(
        method === 'prepareShield' ? f.prepare() : f.submitter.submit(await f.prepare())
      ).rejects.toBe(error);
      await f.adapter.closed;
    }
  }
);
test.each(['prepareShield', 'submit'])(
  'pending decorated %s promise refuses but retains original settlement after host.closed',
  async (method) => {
    const pending = deferred(),
      error = new Error('later host rejection');
    Object.assign(pending.promise, { malformed: true });
    const f = fixture((f) => {
      f.host[method] = () => pending.promise;
    });
    let closed = false;
    f.adapter.closed.then(() => {
      closed = true;
    });
    await expect(
      method === 'prepareShield' ? f.prepare() : f.submitter.submit(await f.prepare())
    ).rejects.toMatchObject({ code: method === 'submit' ? CONTRACT : CODE });
    await tick();
    expect(f.controller.signal.aborted).toBe(true);
    expect(closed).toBe(false);
    pending.reject(error);
    await f.adapter.closed;
    expect(closed).toBe(true);
  }
);
test.each(['prepareShield', 'submit'])(
  'malformed rejected native %s promise observed without leaking rejection',
  async (method) => {
    const f = fixture((f) => {
      f.host[method] = () => Object.assign(Promise.reject(new Error('private')), { extra: true });
    });
    await expect(
      method === 'prepareShield' ? f.prepare() : f.submitter.submit(await f.prepare())
    ).rejects.toMatchObject({ code: method === 'submit' ? CONTRACT : CODE });
    await f.adapter.closed;
    await tick();
  }
);
test.each(['prepareShield', 'submit'])('thenable %s is not executed', async (method) => {
  let entered = 0;
  const f = fixture((f) => {
    f.host[method] = () => ({
      then() {
        entered++;
      },
    });
  });
  await expect(
    method === 'prepareShield' ? f.prepare() : f.submitter.submit(await f.prepare())
  ).rejects.toMatchObject({ code: method === 'submit' ? CONTRACT : CODE });
  await f.adapter.closed;
  expect(entered).toBe(0);
});
test('late-added then getter on fulfilled submission never executes', async () => {
  let getter = 0;
  const f = fixture((f) => {
    f.host.submit = () => {
      const result = { ...f.acknowledged };
      const pending = Promise.resolve(result);
      Object.defineProperty(result, 'then', {
        get() {
          getter++;
          throw Error('getter');
        },
      });
      return pending;
    };
  });
  await expect(f.submitter.submit(await f.prepare())).rejects.toMatchObject({ code: CONTRACT });
  await f.adapter.closed;
  expect(getter).toBe(0);
});
test('cleanup throw preserves valid acknowledgement; closed rejects separately', async () => {
  const f = fixture((f) => {
    const close = f.host.close;
    f.host.close = () => {
      close();
      throw Error('cleanup');
    };
  });
  expect(await f.submitter.submit(await f.prepare())).toBe(f.acknowledged);
  await expect(f.adapter.closed).rejects.toMatchObject({ code: CODE });
});
test('public submit outer promise differs while delegated error identity stays original before drain', async () => {
  const outward = deferred(),
    drain = deferred(),
    error = Object.assign(Error('original'), { code: 'RAILGUN_KOHAKU_REFUSED' });
  let closes = 0;
  const f = fixture((f) => {
    f.host.submit = () => outward.promise;
    f.host.closed = drain.promise;
    f.host.close = () => {
      closes++;
      outward.reject(error);
    };
  });
  const result = f.submitter.submit(await f.prepare());
  expect(result).not.toBe(outward.promise);
  let closed = false;
  f.adapter.closed.then(() => {
    closed = true;
  });
  f.adapter.close();
  await expect(result).rejects.toBe(error);
  await tick();
  expect(closed).toBe(false);
  drain.resolve();
  await f.adapter.closed;
  expect(closes).toBe(1);
});
test('close cannot hide a late acknowledged submit value or authorize replay', async () => {
  const outward = deferred(),
    drain = deferred();
  const f = fixture((f) => {
    f.host.submit = () => outward.promise;
    f.host.closed = drain.promise;
    f.host.close = () => {};
  });
  const op = await f.prepare(),
    result = f.submitter.submit(op);
  f.adapter.close();
  outward.resolve(f.acknowledged);
  expect(await result).toBe(f.acknowledged);
  let closed = false;
  f.adapter.closed.then(() => {
    closed = true;
  });
  await tick();
  expect(closed).toBe(false);
  drain.resolve();
  await f.adapter.closed;
  await expect(f.submitter.submit(op)).rejects.toMatchObject({ code: CODE });
});
test('host abort during preparation preserves eventual original rejection and drains independently', async () => {
  const outward = deferred(),
    drain = deferred(),
    error = Error('host aborted');
  const f = fixture((f) => {
    f.host.prepareShield = () => outward.promise;
    f.host.closed = drain.promise;
    f.host.close = () => outward.reject(error);
  });
  const result = f.prepare();
  f.controller.abort();
  await expect(result).rejects.toBe(error);
  let closed = false;
  f.adapter.closed.then(() => {
    closed = true;
  });
  await tick();
  expect(closed).toBe(false);
  drain.resolve();
  await f.adapter.closed;
});
test('late preparation success after reentrant close never publishes a token', async () => {
  let adapter;
  const f = fixture((f) => {
    f.host.prepareShield = () => {
      adapter.close();
      return Promise.resolve({ handle: Object.freeze({}) });
    };
  });
  adapter = f.adapter;
  await expect(f.prepare()).rejects.toMatchObject({ code: CODE });
  await f.adapter.closed;
});
test('read result cannot publish after caller abort', async () => {
  const pending = deferred();
  const f = fixture((f) => {
    f.host.notes = () => pending.promise;
  });
  const result = f.adapter.notes();
  f.signal.abort();
  pending.resolve(f.values);
  await expect(result).rejects.toMatchObject({ code: CODE });
  await f.adapter.closed;
});
test('host.closed-first revokes once, refuses new work', async () => {
  const f = fixture();
  f.drain.resolve();
  await f.adapter.closed;
  await expect(f.prepare()).rejects.toMatchObject({ code: CODE });
  await expect(f.adapter.notes()).rejects.toMatchObject({ code: CODE });
  f.adapter.close();
  expect(f.calls.filter((x) => x === 'close')).toHaveLength(1);
});
test('copied, foreign and private-tag tokens refuse without burning original', async () => {
  const a = fixture(),
    b = fixture(),
    op = await a.prepare(),
    other = await b.prepare();
  for (const token of [{ ...op }, other, Object.freeze({ __type: 'privateOperation' })])
    await expect(a.submitter.submit(token)).rejects.toMatchObject({ code: CODE });
  expect(a.calls.filter((x) => x === 'submit')).toHaveLength(0);
  expect(await a.submitter.submit(op)).toBe(a.acknowledged);
  await a.adapter.closed;
  await expect(a.submitter.submit(op)).rejects.toMatchObject({ code: CODE });
  b.adapter.close();
  await b.adapter.closed;
  await expect(b.submitter.submit(other)).rejects.toMatchObject({ code: CODE });
});
test('duplicate adoption, fake adapter and copied adapter refuse', async () => {
  const f = fixture();
  expect(() => create({ host: f.host, signal: new AbortController().signal })).toThrow();
  for (const adapter of [{}, { ...f.adapter }, { prepareTransfer() {} }])
    expect(() => submitter(adapter)).toThrow();
  f.adapter.close();
  await f.adapter.closed;
});
test('preparing state denies read, new preparation and submit without host acquisition', async () => {
  const held = deferred();
  const f = fixture((f) => {
    f.host.prepareShield = () => held.promise;
  });
  const prepared = f.prepare();
  await expect(f.adapter.notes()).rejects.toMatchObject({ code: CODE });
  await expect(f.prepare()).rejects.toMatchObject({ code: CODE });
  await expect(f.submitter.submit({})).rejects.toMatchObject({ code: CODE });
  expect(f.calls).toEqual([]);
  held.resolve({ handle: Object.freeze({}) });
  await prepared;
  f.adapter.close();
  await f.adapter.closed;
});

test('actual private and public registry tokens cannot cross either submitter', async () => {
  const privateApi = require('./railgun-kohaku-private-adapter');
  const {
    independentPrivateHost,
  } = require('../../../scripts/fixtures/railgun-kohaku-private-conformance');
  const publicFixture = fixture(),
    privateFixture = independentPrivateHost();
  const privateAdapter = privateApi.createRailgunKohakuPrivateAdapter({
    host: privateFixture.host,
    signal: new AbortController().signal,
  });
  const privateBroadcaster =
    privateApi.createRailgunKohakuPrivateAdapterBroadcaster(privateAdapter);
  try {
    const publicToken = await publicFixture.prepare();
    const privateToken = await privateAdapter.prepareTransfer(privateFixture.input, INSTANCE);
    expect(() => submitter(privateAdapter)).toThrow();
    expect(() =>
      privateApi.createRailgunKohakuPrivateAdapterBroadcaster(publicFixture.adapter)
    ).toThrow();
    await expect(publicFixture.submitter.submit(privateToken)).rejects.toMatchObject({
      code: CODE,
    });
    await expect(privateBroadcaster.broadcast(publicToken)).rejects.toMatchObject({
      code: 'RAILGUN_KOHAKU_PRIVATE_ADAPTER_REFUSED',
    });
    expect(publicFixture.calls.filter((x) => x === 'submit')).toHaveLength(0);
    expect(privateFixture.calls.filter((x) => x.method === 'broadcast')).toHaveLength(0);
    expect(await publicFixture.submitter.submit(publicToken)).toBe(publicFixture.acknowledged);
    expect(await privateBroadcaster.broadcast(privateToken)).toBe(privateFixture.acknowledged);
    await Promise.all([publicFixture.adapter.closed, privateAdapter.closed]);
  } finally {
    publicFixture.adapter.close();
    privateAdapter.close();
    await Promise.all([publicFixture.adapter.closed, privateAdapter.closed]);
  }
});

test('malformed preparation handle closes without publishing a public token', async () => {
  const f = fixture((f) => {
    f.host.prepareShield = async () => ({ handle: {} });
  });
  await expect(f.prepare()).rejects.toMatchObject({ code: CODE });
  await f.adapter.closed;
  await expect(f.submitter.submit({ __type: 'publicOperation' })).rejects.toMatchObject({
    code: CODE,
  });
  expect(f.calls.filter((x) => x === 'submit')).toHaveLength(0);
});
test('reentrant close is invoked once', async () => {
  let adapter,
    calls = 0;
  const f = fixture((f) => {
    f.host.close = () => {
      calls++;
      adapter.close();
      f.drain.resolve();
    };
  });
  adapter = f.adapter;
  f.adapter.close();
  await f.adapter.closed;
  expect(calls).toBe(1);
});
test('fulfilled acknowledgement accessors refuse without execution or manufactured hash', async () => {
  let reads = 0;
  const f = fixture(),
    op = await f.prepare();
  Object.defineProperty(f.acknowledged, 'hash', {
    get() {
      reads++;
      return HASH;
    },
  });
  try {
    await f.submitter.submit(op);
    throw Error('accepted malformed outcome');
  } catch (error) {
    expect(error.code).toBe(CONTRACT);
    expect(error.submissionMayHaveOccurred).toBe(true);
    expect(error.transactionHash).toBeUndefined();
  }
  await f.adapter.closed;
  expect(reads).toBe(0);
});

test.each([
  ['constructor', 'prepareShield'],
  ['species', 'prepareShield'],
  ['constructor', 'submit'],
  ['species', 'submit'],
  ['constructor', 'notes'],
  ['species', 'notes'],
])('unobservable %s promise settles %s and rejects drainage', async (kind, method) => {
  let entries = 0;
  const malformed = Promise.resolve();
  const descriptor = {
    get() {
      entries++;
      throw Error('unobservable promise');
    },
  };
  if (kind === 'constructor') Object.defineProperty(malformed, 'constructor', descriptor);
  else
    Object.defineProperty(malformed, 'constructor', {
      value: Object.defineProperty({}, Symbol.species, descriptor),
    });
  const f = fixture((f) => {
    f.host[method] = () => malformed;
  });
  const result =
    method === 'prepareShield'
      ? f.prepare()
      : method === 'notes'
        ? f.adapter.notes()
        : f.submitter.submit(await f.prepare());
  await expect(result).rejects.toMatchObject(
    method === 'submit' ? { code: CONTRACT, submissionMayHaveOccurred: true } : { code: CODE }
  );
  expect(entries).toBe(1);
  expect(f.calls.filter((call) => call === 'close')).toHaveLength(1);
  await expect(f.adapter.closed).rejects.toMatchObject({ code: CODE });
  await expect(f.prepare()).rejects.toMatchObject({ code: CODE });
});

test.each(['constructor', 'species'])(
  'unobservable %s close return preserves acknowledgement and rejects drainage',
  async (kind) => {
    let entries = 0;
    const malformed = Promise.resolve();
    const descriptor = {
      get() {
        entries++;
        throw Error('unobservable cleanup');
      },
    };
    if (kind === 'constructor') Object.defineProperty(malformed, 'constructor', descriptor);
    else
      Object.defineProperty(malformed, 'constructor', {
        value: Object.defineProperty({}, Symbol.species, descriptor),
      });
    const f = fixture((f) => {
      const close = f.host.close;
      f.host.close = () => {
        close();
        return malformed;
      };
    });
    expect(await f.submitter.submit(await f.prepare())).toBe(f.acknowledged);
    await expect(f.adapter.closed).rejects.toMatchObject({ code: CODE });
    expect(entries).toBe(1);
    expect(f.calls.filter((call) => call === 'close')).toHaveLength(1);
  }
);
