// Surface semantics are tested against controlled read evidence here; real
// runner/journal identity and revocation are exercised by the Electron qualifier.
jest.mock('./railgun-wallet-runner', () => ({ isRailgunWalletRunner: (v) => v?.genuine === true }));
const { createRailgunKohakuRead } = require('./railgun-kohaku-read');
const asset = { __type: 'erc20', contract: '0x' + 'a'.repeat(40) };
function fixture() {
  let active = true;
  const received = [
    { id: '0:0', asset, amount: 12n, spentTxid: false, tag: 'unverified' },
    { id: '0:1', asset, amount: 8n, spentTxid: false, tag: 'unverified' },
    { id: '0:2', asset, amount: 5n, spentTxid: '0x' + '1'.repeat(64), tag: 'unverified' },
  ];
  const runner = {
    genuine: true,
    read: () => {
      if (!active) throw Error('stale');
      return {
        instanceId: 'fixture',
        received,
        readiness: { status: 'wallet-scanned-unverified', spendableGranted: false },
      };
    },
  };
  return {
    view: createRailgunKohakuRead({ runner, journal: {}, receipt: {} }),
    received,
    revoke: () => {
      active = false;
    },
  };
}
test('sums unspent observed amounts, tags them, filters case-insensitively and never exposes prepare methods', async () => {
  const { view } = fixture();
  expect(await view.balance()).toEqual([{ asset, amount: 20n, tag: 'unverified' }]);
  expect(await view.balance([{ ...asset, contract: '0x' + 'A'.repeat(40) }])).toHaveLength(1);
  expect(await view.balance([{ __type: 'native' }])).toEqual([]);
  expect(await view.balance([])).toEqual([]);
  expect(await view.notes()).toHaveLength(2);
  expect(await view.notes(undefined, true)).toHaveLength(3);
  expect(await view.status()).toMatchObject({ poi: 'unverified', spendableGranted: false });
  expect(view.prepareShield).toBeUndefined();
  expect(view.prepareTransfer).toBeUndefined();
  expect(view.prepareUnshield).toBeUndefined();
});
test('unsupported ERC1155 amounts cannot silently disappear from unfiltered balances', async () => {
  const { view, received } = fixture();
  received.push({
    asset: { __type: 'erc1155', contract: asset.contract, tokenId: 42n },
    amount: 1n,
    spentTxid: false,
  });
  await expect(view.balance()).rejects.toThrow('Unsupported');
  expect(await view.balance([asset])).toEqual([{ asset, amount: 20n, tag: 'unverified' }]);
  await expect(view.notes()).rejects.toThrow('Unsupported');
  expect(await view.notes([asset])).toHaveLength(2);
});
test('every read rechecks current evidence, including instance identity', async () => {
  const { view, revoke } = fixture();
  revoke();
  for (const method of ['instanceId', 'balance', 'notes', 'status'])
    await expect(view[method]()).rejects.toThrow('stale');
  expect(() => createRailgunKohakuRead({ runner: {} })).toThrow();
});
test('malformed asset filters and includeSpent are refused', async () => {
  const { view } = fixture();
  for (const assets of [
    null,
    [{}],
    [{ __type: 'native', contract: asset.contract }],
    [{ __type: 'erc721', contract: asset.contract, tokenId: '1' }],
  ]) {
    await expect(view.balance(assets)).rejects.toThrow();
    await expect(view.notes(assets)).rejects.toThrow();
  }
  await expect(view.notes(undefined, 'true')).rejects.toThrow();
});

function orderedFixture() {
  const events = [];
  let active = true;
  const receipt = {},
    journal = {};
  const received = [Object.freeze({ asset, amount: 3n, spentTxid: false })];
  const runner = {
    genuine: true,
    read: jest.fn((actualReceipt, actualJournal) => {
      events.push('current');
      expect(actualReceipt).toBe(receipt);
      expect(actualJournal).toBe(journal);
      if (!active) throw Error('stale');
      return { instanceId: 'ordered', received, readiness: {} };
    }),
  };
  const view = createRailgunKohakuRead({ runner, journal, receipt });
  expect(events).toEqual(['current']);
  events.length = 0;
  runner.read.mockClear();
  return {
    view,
    runner,
    events,
    received,
    revoke: () => {
      active = false;
    },
  };
}

test.each(['balance', 'notes'])(
  '%s evaluates filter getters once in original order before current',
  async (method) => {
    const { view, events, runner, received } = orderedFixture();
    const filteredAsset = {
      __type: 'erc20',
      get contract() {
        events.push('contract');
        return asset.contract;
      },
    };
    const filters = [filteredAsset];
    Object.defineProperty(filters, 'map', {
      get() {
        events.push('map');
        return Array.prototype.map;
      },
    });
    const result = await view[method](filters);
    expect(events).toEqual(['map', 'contract', 'contract', 'contract', 'current']);
    expect(runner.read).toHaveBeenCalledTimes(1);
    expect(result[0].asset).toBe(asset);
    if (method === 'notes') expect(result[0]).toBe(received[0]);
  }
);

test.each(['balance', 'notes'])(
  '%s drains the caller map iterable before consulting current evidence',
  async (method) => {
    const { view, events } = orderedFixture();
    const filters = [];
    filters.map = () => {
      events.push('map');
      return {
        *[Symbol.iterator]() {
          events.push('iterate');
          yield 'erc20:' + asset.contract;
          events.push('done');
        },
      };
    };
    expect(await view[method](filters)).toHaveLength(1);
    expect(events).toEqual(['map', 'iterate', 'done', 'current']);
  }
);

test.each(['getter', 'iterator'])(
  'preserves exact %s exception and performs no authority read',
  async (kind) => {
    const { view, runner } = orderedFixture();
    const failure = Error(kind);
    const filters = [];
    if (kind === 'getter')
      Object.defineProperty(filters, 'map', {
        get() {
          throw failure;
        },
      });
    else
      filters.map = () => ({
        [Symbol.iterator]() {
          throw failure;
        },
      });
    await expect(view.balance(filters)).rejects.toBe(failure);
    await expect(view.notes(filters)).rejects.toBe(failure);
    expect(runner.read).not.toHaveBeenCalled();
  }
);

test('includeSpent validation precedes filter evaluation and malformed filters precede stale reads', async () => {
  const { view, runner, revoke } = orderedFixture();
  const map = jest.fn(() => {
    throw Error('filter evaluated');
  });
  const filters = [];
  filters.map = map;
  await expect(view.notes(filters, 'true')).rejects.not.toThrow('filter evaluated');
  expect(map).not.toHaveBeenCalled();
  revoke();
  await expect(view.balance(null)).rejects.not.toThrow('stale');
  await expect(view.notes(null)).rejects.not.toThrow('stale');
  expect(runner.read).not.toHaveBeenCalled();
});

test('revocation from filter evaluation is checked before projecting supplied evidence', async () => {
  const { view, revoke, runner } = orderedFixture();
  const filter = {
    __type: 'erc20',
    get contract() {
      revoke();
      return asset.contract;
    },
  };
  await expect(view.balance([filter])).rejects.toThrow('stale');
  expect(runner.read).toHaveBeenCalledTimes(1);
});

test('all successful methods consult current evidence exactly once per call', async () => {
  const { view, runner } = orderedFixture();
  for (const method of ['instanceId', 'balance', 'notes', 'status']) {
    runner.read.mockClear();
    await view[method]();
    expect(runner.read).toHaveBeenCalledTimes(1);
  }
  expect(Object.keys(view)).toEqual(['instanceId', 'balance', 'notes', 'status']);
  expect(Object.isFrozen(view)).toBe(true);
});

test('malformed custom map output refuses before currentness rather than silently matching nothing', async () => {
  const { view, runner } = orderedFixture();
  const filters = [];
  filters.map = () => [1];
  await expect(view.balance(filters)).rejects.toThrow();
  await expect(view.notes(filters)).rejects.toThrow();
  expect(runner.read).not.toHaveBeenCalled();
});
