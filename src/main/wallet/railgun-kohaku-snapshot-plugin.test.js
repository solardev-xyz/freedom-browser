const fs = require('fs');
const vm = require('vm');
const { createRailgunKohakuSnapshotPlugin: create } = require('./railgun-kohaku-snapshot-plugin');
const {
  snapshotFixture,
  createMemorySnapshotHost,
  checkSnapshotConformance,
} = require('../../../scripts/fixtures/railgun-kohaku-snapshot-conformance');
const code = 'RAILGUN_KOHAKU_SNAPSHOT_REFUSED';
function fixture(data = snapshotFixture(), hooks = {}) {
  const outer = new AbortController(),
    owner = new AbortController();
  const recheck = jest.fn(() => hooks.recheck?.());
  const capture = jest.fn(() =>
    hooks.capture ? hooks.capture() : { snapshot: data, assertCurrent: recheck }
  );
  const host = { signal: owner.signal, capture };
  const plugin = create({ host, signal: outer.signal });
  return { data, outer, owner, recheck, capture, host, plugin };
}
async function refused(pending) {
  await expect(pending).rejects.toMatchObject({ code });
}
test('independent memory host passes pinned read vectors with mutable consumer data', async () => {
  const data = snapshotFixture(),
    memory = createMemorySnapshotHost(data);
  const plugin = create({ host: memory.host, signal: new AbortController().signal });
  expect(await checkSnapshotConformance(plugin, data)).toEqual({
    readVectors: 9,
    provenance: 'host-supplied',
    typescriptChecked: false,
  });
  expect(memory.counters).toEqual({ captures: 9, rechecks: 9 });
  plugin.close();
  await plugin.closed;
  expect(memory.host.signal.aborted).toBe(false);
});
test('full detachment across calls, assets, host data and independent instances', async () => {
  const f = fixture();
  const second = create({ host: f.host, signal: new AbortController().signal });
  const original = structuredClone(f.data);
  const notes = await f.plugin.notes(undefined, true),
    balances = await f.plugin.balance();
  notes[0].amount = 999n;
  notes[0].asset.contract = 'changed';
  notes.push({});
  balances[0].asset.__type = 'native';
  balances[0].amount = 0n;
  balances.reverse();
  expect(f.data).toEqual(original);
  expect(await f.plugin.notes(undefined, true)).toEqual(original.received);
  expect(await second.notes(undefined, true)).toEqual(original.received);
  expect((await second.balance())[0].amount).toBe(20n);
  f.plugin.close();
  second.close();
  await Promise.all([f.plugin.closed, second.closed]);
});
test('snapshot is detached synchronously before later host mutation', async () => {
  const f = fixture();
  const pending = f.plugin.notes();
  f.data.received[0].amount = 33n;
  expect((await pending)[0].amount).toBe(12n);
  expect((await f.plugin.notes())[0].amount).toBe(33n);
  f.plugin.close();
  await f.plugin.closed;
});
test('revision change refuses the pending read but a new current read works', async () => {
  const memory = createMemorySnapshotHost();
  const plugin = create({ host: memory.host, signal: new AbortController().signal });
  const pending = plugin.notes();
  memory.replace(snapshotFixture());
  await refused(pending);
  expect(await plugin.notes()).toHaveLength(3);
  plugin.close();
  await plugin.closed;
});
test.each(['outer', 'owner', 'close'])(
  '%s revokes pending publication and drains adapter reads only',
  async (source) => {
    const f = fixture();
    let drained = false;
    f.plugin.closed.then(() => {
      drained = true;
    });
    const pending = f.plugin.notes();
    if (source === 'close') f.plugin.close();
    else f[source].abort();
    expect(drained).toBe(false);
    expect(f.plugin.signal.aborted).toBe(true);
    await refused(pending);
    await f.plugin.closed;
    expect(drained).toBe(true);
    await refused(f.plugin.instanceId());
    if (source === 'close') expect(f.owner.signal.aborted).toBe(false);
  }
);
test('final lifetime check catches reentrant close in assertCurrent', async () => {
  let plugin;
  const f = fixture(undefined, {
    recheck: () => {
      plugin.close();
    },
  });
  plugin = f.plugin;
  await refused(plugin.notes());
  await plugin.closed;
  expect(f.recheck).toHaveBeenCalledTimes(1);
});
test('capture reentrant close cannot resolve closed before admitted read settles', async () => {
  let plugin,
    drained = false;
  const order = [];
  const f = fixture(undefined, {
    capture: () => {
      plugin.close();
      return { snapshot: snapshotFixture(), assertCurrent() {} };
    },
  });
  plugin = f.plugin;
  plugin.closed.then(() => {
    drained = true;
    order.push('closed');
  });
  const pending = plugin.notes();
  pending.then(
    () => order.push('fulfilled'),
    () => order.push('read-settled')
  );
  expect(drained).toBe(false);
  await refused(pending);
  await plugin.closed;
  expect(drained).toBe(true);
  expect(order).toEqual(['read-settled', 'closed']);
});
test('capture and recheck errors are sanitized and no retry occurs', async () => {
  const a = fixture(undefined, {
    capture: () => {
      throw Error('private detail');
    },
  });
  await refused(a.plugin.notes());
  expect(a.capture).toHaveBeenCalledTimes(1);
  const b = fixture(undefined, {
    recheck: () => {
      throw Error('private detail');
    },
  });
  await expect(b.plugin.balance()).rejects.toMatchObject({
    code,
    message: 'Kohaku snapshot read unavailable',
  });
  expect(b.recheck).toHaveBeenCalledTimes(1);
  a.plugin.close();
  b.plugin.close();
  await Promise.all([a.plugin.closed, b.plugin.closed]);
});
test.each([
  false,
  true,
  null,
  1,
  'current',
  {},
  {
    then() {
      throw Error('must not call');
    },
  },
])('assertCurrent refuses non-void result %p', async (value) => {
  const f = fixture(undefined, { recheck: () => value });
  await refused(f.plugin.notes());
  f.plugin.close();
  await f.plugin.closed;
});
test('declared async capture is refused before invocation', () => {
  const capture = jest.fn(async () => snapshotFixture());
  // jest wrappers obscure the function kind; use the real async callback.
  let calls = 0;
  const host = {
    signal: new AbortController().signal,
    async capture() {
      calls++;
      return capture();
    },
  };
  expect(() => create({ host, signal: new AbortController().signal })).toThrow();
  expect(calls).toBe(0);
});
test('declared async recheck is refused before invocation', async () => {
  let calls = 0;
  const f = fixture(undefined, {
    capture: () => ({
      snapshot: snapshotFixture(),
      async assertCurrent() {
        calls++;
      },
    }),
  });
  await refused(f.plugin.notes());
  expect(calls).toBe(0);
  f.plugin.close();
  await f.plugin.closed;
});
test.each(['capture', 'recheck'])(
  'returned rejected Promise from ordinary %s is observed, refused and not awaited',
  async (target) => {
    const hooks = { [target]: () => Promise.reject(Error('contract violation')) };
    const f = fixture(undefined, hooks);
    await refused(f.plugin.notes());
    f.plugin.close();
    await f.plugin.closed;
    // Jest also fails the suite for an unhandled rejection after this turn.
    await new Promise((resolve) => setImmediate(resolve));
  }
);
test.each(['capture', 'recheck'])(
  'never-settling Promise from %s cannot hang close',
  async (target) => {
    const f = fixture(undefined, { [target]: () => new Promise(() => {}) });
    await refused(f.plugin.notes());
    f.plugin.close();
    await f.plugin.closed;
  }
);
test('custom capture thenable is never invoked', async () => {
  const then = jest.fn();
  const f = fixture(undefined, { capture: () => ({ then }) });
  await refused(f.plugin.notes());
  expect(then).not.toHaveBeenCalled();
  f.plugin.close();
  await f.plugin.closed;
});
const corruptions = [
  [
    'extra root key',
    (s) => {
      s.ownedPoi = [];
    },
  ],
  [
    'address',
    (s) => {
      s.instanceId = '0zk1bad';
    },
  ],
  [
    'oversized',
    (s) => {
      s.received = Array(10001).fill(s.received[0]);
    },
  ],
  [
    'sparse',
    (s) => {
      s.received = new Array(1);
    },
  ],
  [
    'duplicate',
    (s) => {
      s.received.push({ ...s.received[0] });
    },
  ],
  [
    'id',
    (s) => {
      s.received[0].id = '0:9';
    },
  ],
  [
    'tree capacity',
    (s) => {
      s.received[0].tree = 256;
    },
  ],
  [
    'position capacity',
    (s) => {
      s.received[0].position = 65536;
    },
  ],
  [
    'reordered',
    (s) => {
      s.received.reverse();
    },
  ],
  [
    'negative position',
    (s) => {
      s.received[0].position = -1;
    },
  ],
  [
    'fractional tree',
    (s) => {
      s.received[0].tree = 0.5;
    },
  ],
  [
    'number amount',
    (s) => {
      s.received[0].amount = 12;
    },
  ],
  [
    'negative amount',
    (s) => {
      s.received[0].amount = -1n;
    },
  ],
  [
    'amount overflow',
    (s) => {
      s.received[0].amount = 1n << 120n;
    },
  ],
  [
    'field overflow',
    (s) => {
      s.received[0].hash = '0x' + 'f'.repeat(64);
    },
  ],
  [
    'uppercase hash',
    (s) => {
      s.received[0].txid = '0x' + 'A'.repeat(64);
    },
  ],
  [
    'verified',
    (s) => {
      s.received[0].tag = 'verified';
    },
  ],
  [
    'extra note secret',
    (s) => {
      s.received[0].random = 'not copied';
    },
  ],
  [
    'malformed spent',
    (s) => {
      s.received[0].spentTxid = true;
    },
  ],
  [
    'bad token hash',
    (s) => {
      s.received[0].tokenHash = '0x12';
    },
  ],
  [
    'bad contract',
    (s) => {
      s.received[0].asset.contract = '0x12';
    },
  ],
  [
    'unknown asset',
    (s) => {
      s.received[0].asset.__type = 'unknown';
    },
  ],
  [
    'erc721 amount',
    (s) => {
      s.received[3].amount = 2n;
    },
  ],
  [
    'token overflow',
    (s) => {
      s.received[3].asset.tokenId = 1n << 256n;
    },
  ],
  [
    'token number',
    (s) => {
      s.received[3].asset.tokenId = 7;
    },
  ],
];
test.each(corruptions)('refuses snapshot %s before host recheck', async (_label, mutate) => {
  const f = fixture();
  mutate(f.data);
  await refused(f.plugin.notes());
  expect(f.recheck).not.toHaveBeenCalled();
  f.plugin.close();
  await f.plugin.closed;
});
test.each(['snapshot', 'note', 'asset', 'array'])('%s getters are never read', async (target) => {
  const f = fixture(),
    getter = jest.fn(() => {
      throw Error('getter');
    });
  const object = {
    snapshot: f.data,
    note: f.data.received[0],
    asset: f.data.received[0].asset,
    array: f.data.received,
  }[target];
  const key = { snapshot: 'instanceId', note: 'amount', asset: '__type', array: '0' }[target];
  Object.defineProperty(object, key, { get: getter, configurable: true, enumerable: true });
  await refused(f.plugin.notes());
  expect(getter).not.toHaveBeenCalled();
  f.plugin.close();
  await f.plugin.closed;
});
test('ERC1155 stays present and refuses unfiltered reads while supported explicit filters work', async () => {
  const f = fixture();
  f.data.received[3].asset.__type = 'erc1155';
  await refused(f.plugin.notes());
  await refused(f.plugin.balance());
  expect(await f.plugin.notes([f.data.received[0].asset])).toHaveLength(2);
  expect((await f.plugin.balance([f.data.received[0].asset]))[0].amount).toBe(20n);
  f.plugin.close();
  await f.plugin.closed;
});
test.each([null, [{}], Array(1001).fill({ __type: 'native' })])(
  'malformed filters refuse %p',
  async (filters) => {
    const f = fixture();
    await refused(f.plugin.notes(filters));
    f.plugin.close();
    await f.plugin.closed;
  }
);
test('includeSpent must be boolean', async () => {
  const f = fixture();
  await refused(f.plugin.notes(undefined, 'yes'));
  f.plugin.close();
  await f.plugin.closed;
});
test('constructor snapshots callbacks, enforces exact options and never grants a genuine plugin', async () => {
  const f = fixture();
  f.host.capture = () => {
    throw Error('replacement');
  };
  expect(await f.plugin.notes()).toHaveLength(3);
  expect(() => create({ host: { ...f.host, close() {} }, signal: f.outer.signal })).toThrow();
  expect(() => create({ host: f.host, signal: f.outer.signal, mode: 'private' })).toThrow();
  // Actual unchanged registry checks with inert imports: registry isolation,
  // not genuine owner or native qualification.
  const sandbox = {
    module: { exports: {} },
    require: (name) => (['assert/strict', 'path', 'util'].includes(name) ? require(name) : {}),
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('./railgun-kohaku-plugin'), 'utf8'), sandbox);
  expect(() => sandbox.module.exports.assertRailgunKohakuPrivatePlugin(f.plugin)).toThrow();
  expect(Object.keys(f.plugin)).not.toContain('prepareShield');
  f.plugin.close();
  await f.plugin.closed;
});

test('native asset and maximum valid scalar bounds preserve bigint data', async () => {
  const f = fixture();
  f.data.received = [
    {
      ...f.data.received[0],
      id: '255:65535',
      tree: 255,
      position: 65535,
      amount: (1n << 120n) - 1n,
      asset: { __type: 'native' },
    },
  ];
  expect(await f.plugin.balance()).toEqual([
    { asset: { __type: 'native' }, amount: (1n << 120n) - 1n, tag: 'unverified' },
  ]);
  f.plugin.close();
  await f.plugin.closed;
});
test('tokenHash shape is data only, never a preimage authentication claim', async () => {
  const f = fixture();
  f.data.received[0].tokenHash = '0x' + 'f'.repeat(64);
  expect((await f.plugin.notes())[0].tokenHash).toBe(f.data.received[0].tokenHash);
  expect(f.plugin.provenance).toBe('host-supplied');
  f.plugin.close();
  await f.plugin.closed;
});
test('capture data proxies are rejected before invoking traps', async () => {
  const traps = { getPrototypeOf: jest.fn(), ownKeys: jest.fn(), get: jest.fn() };
  const f = fixture(new Proxy(snapshotFixture(), traps));
  await refused(f.plugin.notes());
  for (const trap of Object.values(traps)) expect(trap).not.toHaveBeenCalled();
  f.plugin.close();
  await f.plugin.closed;
});
test('closed constructor signals and accessor host callbacks refuse without invocation', () => {
  const signal = new AbortController();
  signal.abort();
  const capture = jest.fn();
  expect(() =>
    create({ host: { signal: signal.signal, capture }, signal: new AbortController().signal })
  ).toThrow();
  const host = { signal: new AbortController().signal };
  Object.defineProperty(host, 'capture', { get: capture, enumerable: true });
  expect(() => create({ host, signal: new AbortController().signal })).toThrow();
  expect(capture).not.toHaveBeenCalled();
});

test.each(['__type', 'contract', 'tokenId'])(
  'non-enumerable ERC721 %s is validated and explicitly preserved',
  async (key) => {
    const f = fixture(),
      asset = f.data.received[3].asset;
    Object.defineProperty(asset, key, { value: asset[key], enumerable: false, configurable: true });
    const notes = await f.plugin.notes();
    expect(notes[2].asset).toEqual({
      __type: 'erc721',
      contract: '0x' + 'b'.repeat(40),
      tokenId: 7n,
    });
    expect(Object.keys(notes[2].asset).sort()).toEqual(['__type', 'contract', 'tokenId']);
    expect((await f.plugin.balance([notes[2].asset]))[0].asset).toEqual(notes[2].asset);
    f.plugin.close();
    await f.plugin.closed;
  }
);
test.each(['__type', 'contract', 'tokenId'])(
  'non-enumerable ERC1155 %s never disappears or bypasses unsupported refusal',
  async (key) => {
    const f = fixture(),
      asset = f.data.received[3].asset;
    asset.__type = 'erc1155';
    Object.defineProperty(asset, key, { value: asset[key], enumerable: false, configurable: true });
    await refused(f.plugin.notes());
    await refused(f.plugin.balance());
    expect(await f.plugin.notes([f.data.received[0].asset])).toHaveLength(2);
    expect((await f.plugin.balance([f.data.received[0].asset]))[0].amount).toBe(20n);
    f.plugin.close();
    await f.plugin.closed;
  }
);
test('received array prototype must be the plain local Array prototype', async () => {
  const f = fixture();
  Object.setPrototypeOf(f.data.received, Object.create(Array.prototype));
  await refused(f.plugin.notes());
  f.plugin.close();
  await f.plugin.closed;
});
