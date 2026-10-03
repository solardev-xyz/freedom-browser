const { Interface } = require('ethers');
const { collectRailgunPoiCreator: collect } = require('./railgun-poi-creator');
const { PRIVATE_EVENTS } = require('./railgun-transact-receipt');
const { SHIELD_EVENT } = require('./railgun-shield-receipt');
const { sample } = require('../../../scripts/fixtures/railgun-own-txid-data');
const pins = require('./railgun-shield-pins.json');
const abi = new Interface([SHIELD_EVENT, ...PRIVATE_EVENTS]);
const hex = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
function fixture(shield = true) {
  const { capsule } = sample();
  const checkpoint = {
    from: 0,
    previousHash: hex(0),
    to: { number: 300, hash: hex(300) },
    anchor: { number: 310, hash: hex(310) },
    logs: { count: 2, sha256: 'a'.repeat(64) },
    source: {
      level: 'unverified-rpc',
      providersSha256: 'b'.repeat(64),
      ledgerId: 'c'.repeat(64),
      ledgerSha256: 'd'.repeat(64),
    },
    state: {
      schema: 'public-records-v1',
      storeId: 'e'.repeat(64),
      trees: [{ tree: 0, length: 2, root: hex(1) }],
      commitments: { count: 2, sha256: 'f'.repeat(64) },
      nullifiers: { count: 2, sha256: '1'.repeat(64) },
      unshields: { count: 0, sha256: '2'.repeat(64) },
    },
  };
  const ciphers = [0, 1].map((i) => ({
    encryptedBundle: [hex(10 + i), hex(12 + i), hex(14 + i)],
    shieldKey: hex(16 + i),
  }));
  const preimages = [0, 1].map((i) => ({
    npk: hex(30 + i),
    token: [0, pins.wrappedNative, 0],
    value: 1000 + i,
  }));
  preimages[1].value = 1000;
  const transactCipher = [0, 1].map((i) => ({
    ciphertext: [hex(40 + i), hex(42 + i), hex(44 + i), hex(46 + i)],
    blindedSenderViewingKey: hex(50 + i),
    blindedReceiverViewingKey: hex(52 + i),
    annotationData: '0x1234',
    memo: '0x5678',
  }));
  let args = shield
    ? [0, 0, preimages, ciphers, [2, 3]]
    : [0, 0, [hex(99), capsule.noteHash], transactCipher];
  const name = shield ? 'Shield' : 'Transact';
  const logs = [
    {
      address: pins.proxy,
      blockNumber: 290,
      blockHash: hex(290),
      transactionHash: hex(100),
      transactionIndex: 4,
      logIndex: 5,
      ...abi.encodeEventLog(name, args),
    },
  ];
  let visited = 0;
  const options = {
    capsule,
    checkpoint,
    assertCurrent: jest.fn(),
    visit: jest.fn(async (visitor) => {
      for (const log of logs) {
        visitor(log);
        visited++;
      }
      return {
        count: logs.length,
        bytes: logs.reduce((n, log) => n + Buffer.byteLength(JSON.stringify(log) + '\n'), 0),
      };
    }),
  };
  return {
    options,
    logs,
    ciphers,
    preimages,
    transactCipher,
    args,
    name,
    visited: () => visited,
    encode: () => Object.assign(logs[0], abi.encodeEventLog(name, args)),
  };
}
test.each([true, false])(
  'selects exact nonzero ciphertext offset, shield=%s, without authority',
  async (shield) => {
    const f = fixture(shield),
      result = await collect(f.options);
    expect(result.origin).toMatchObject({
      tree: 0,
      startPosition: 0,
      outputOffset: 1,
      transactionIndex: 4,
      logIndex: 5,
    });
    expect(result.creator.type).toBe(shield ? 'Shield' : 'Transact');
    expect(result.creator.ciphertext).toEqual(shield ? f.ciphers[1] : f.transactCipher[1]);
    expect(result.creatorHashCompared).toBe(!shield);
    expect(result).toMatchObject({
      sourceAuthenticated: false,
      ownershipAuthenticated: false,
      currentCanonicalityVerified: false,
      txidMembershipVerified: false,
      disclosureEnabled: false,
      spendingEnabled: false,
    });
    expect(Object.isFrozen(result.creator.ciphertext)).toBe(true);
    if (shield) expect(result.creator.preimage.value).toBe('1000'); // Fee 3 is not subtracted.
  }
);
test.each([
  ['overlapping creator', (f) => f.logs.push({ ...f.logs[0], logIndex: 6 })],
  [
    'gap',
    (f) => {
      f.args[1] = 1;
      f.encode();
    },
  ],
  [
    'premature rollover',
    (f) => {
      f.args[0] = 1;
      f.encode();
    },
  ],
  [
    'checkpoint length',
    (f) => {
      f.options.checkpoint.state.trees[0].length = 3;
    },
  ],
  [
    'trailing event bytes',
    (f) => {
      f.logs[0].data += '00'.repeat(32);
    },
  ],
  [
    'different proxy',
    (f) => {
      f.logs[0].address = pins.wrappedNative;
    },
  ],
  [
    'missing creator',
    (f) => {
      f.logs.length = 0;
    },
  ],
  [
    'out-of-range checkpoint',
    (f) => {
      f.options.checkpoint.state.trees[0].length = 1;
    },
  ],
  [
    'wrong net value',
    (f) => {
      f.preimages[1].value = 999;
      f.encode();
    },
  ],
  [
    'wrong token',
    (f) => {
      f.preimages[1].token[0] = 1;
      f.encode();
    },
  ],
  [
    'missing ciphertext',
    (f) => {
      f.ciphers.pop();
      f.encode();
    },
  ],
  [
    'missing fee',
    (f) => {
      f.args[4].pop();
      f.encode();
    },
  ],
  [
    'non-scalar npk',
    (f) => {
      f.preimages[1].npk = '0x' + 'f'.repeat(64);
      f.encode();
    },
  ],
])('refuses %s with sanitized error', async (_name, mutate) => {
  const f = fixture();
  mutate(f);
  await expect(collect(f.options)).rejects.toMatchObject({
    code: 'RAILGUN_POI_CREATOR_REFUSED',
    message: 'Railgun POI creator unavailable',
  });
});
test('Transact hash mismatch refuses, but selected Shield hash comparison stays deferred', async () => {
  const f = fixture(false);
  f.args[2][1] = hex(333);
  f.encode();
  await expect(collect(f.options)).rejects.toThrow();
  const shield = fixture();
  shield.options.capsule.noteHash = hex(444);
  const result = await collect(shield.options);
  expect(result.noteHash).toBe(hex(444));
  expect(result.creatorHashCompared).toBe(false);
});
test.each(['semantic', 'cancellation'])(
  'drains full prefix after local %s refusal',
  async (mode) => {
    const f = fixture();
    f.logs.push({ ...f.logs[0], logIndex: 6 });
    if (mode === 'semantic') f.logs[0].address = pins.wrappedNative;
    else
      f.options.assertCurrent
        .mockImplementationOnce(() => {})
        .mockImplementation(() => {
          throw Error('revoked');
        });
    await expect(collect(f.options)).rejects.toThrow();
    expect(f.visited()).toBe(2);
  }
);
test('no selected evidence escapes a final visitor failure or false visit totals', async () => {
  const f = fixture(),
    visit = f.options.visit;
  f.options.visit = async (fn) => {
    await visit(fn);
    throw Error('final MAC invalid');
  };
  await expect(collect(f.options)).rejects.toThrow();
  f.options.visit = async (fn) => ({ ...(await visit(fn)), count: 999 });
  await expect(collect(f.options)).rejects.toThrow();
});
test('caller capsule mutation during the visit cannot replace the selection', async () => {
  const f = fixture(),
    visit = f.options.visit;
  f.options.visit = async (fn) => {
    f.options.capsule.selection.position = 0;
    return visit(fn);
  };
  expect((await collect(f.options)).creator.position).toBe(1);
});
test('unknown non-commitment events are left to the authenticated projector gate', async () => {
  const f = fixture();
  f.logs.push({ ...f.logs[0], logIndex: 6, topics: [hex(999)], data: '0x' });
  expect((await collect(f.options)).sourceAuthenticated).toBe(false);
});

test('empty Shield at the current frontier preserves contiguity; empty Transact refuses', async () => {
  const f = fixture();
  f.logs.push({ ...f.logs[0], logIndex: 6, ...abi.encodeEventLog('Shield', [0, 2, [], [], []]) });
  expect((await collect(f.options)).creator.position).toBe(1);
  Object.assign(f.logs[1], abi.encodeEventLog('Transact', [0, 2, [], []]));
  await expect(collect(f.options)).rejects.toThrow();
});
test('an overlapping creator of the other kind refuses after both events drain', async () => {
  const f = fixture(),
    other = fixture(false);
  f.logs.push({ ...other.logs[0], logIndex: 6 });
  await expect(collect(f.options)).rejects.toThrow();
  expect(f.visited()).toBe(2);
});
test('late unrelated commitment gap refuses an earlier valid selection', async () => {
  const f = fixture();
  f.logs.push({
    ...f.logs[0],
    logIndex: 6,
    ...abi.encodeEventLog('Shield', [0, 3, [f.preimages[0]], [f.ciphers[0]], [2]]),
  });
  await expect(collect(f.options)).rejects.toThrow();
  expect(f.visited()).toBe(2);
});
