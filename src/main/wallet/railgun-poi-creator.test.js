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

const collectTransact = require('./railgun-poi-creator').collectRailgunPoiTransactCreator;
function transactFixture() {
  const f = fixture(false);
  const selected = {
    ...f.logs[0],
    ...abi.encodeEventLog('Transact', [0, 1, [f.options.capsule.noteHash], [f.transactCipher[1]]]),
  };
  const nullified = {
    ...selected,
    logIndex: 4,
    ...abi.encodeEventLog('Nullified', [0, [hex(700)]]),
  };
  const shield = {
    ...selected,
    blockNumber: 289,
    blockHash: hex(289),
    transactionHash: hex(90),
    transactionIndex: 0,
    logIndex: 0,
    ...abi.encodeEventLog('Shield', [0, 0, [f.preimages[0]], [f.ciphers[0]], [0]]),
  };
  f.logs.splice(0, f.logs.length, shield, nullified, selected);
  return { ...f, selected, nullified, shield };
}
function partialCreatorFixture() {
  const f = transactFixture();
  const unshieldArgs = ['0x' + '12'.repeat(20), [0, pins.wrappedNative, 0], 399, 1];
  const unshield = { ...f.selected, logIndex: 5, ...abi.encodeEventLog('Unshield', unshieldArgs) };
  f.selected.logIndex = 6;
  f.logs.splice(2, 0, unshield);
  f.options.checkpoint.state.unshields.count = 1;
  return { ...f, unshield, unshieldArgs };
}
test('fixed Transact collector binds complete 1x1 group and ciphertext from one full visit', async () => {
  const f = transactFixture();
  const result = await collectTransact(f.options);
  expect(result.transaction).toEqual({
    note: {
      type: 'Transact',
      txid: hex(100),
      hash: f.options.capsule.noteHash,
      tree: 0,
      position: 1,
      blockNumber: 290,
    },
    events: [
      { name: 'Nullified', logIndex: 4, tree: 0, values: [hex(700)] },
      { name: 'Transact', logIndex: 5, tree: 0, start: 1, hashes: [f.options.capsule.noteHash] },
    ],
    logsSha256: require('crypto')
      .createHash('sha256')
      .update(JSON.stringify([f.nullified, f.selected]))
      .digest('hex'),
  });
  expect(result.creator.ciphertext).toEqual(f.transactCipher[1]);
  expect(result.origin).toMatchObject({
    transactionHash: hex(100),
    transactionIndex: 4,
    logIndex: 5,
    startPosition: 1,
    outputOffset: 0,
  });
  expect(f.options.visit).toHaveBeenCalledTimes(1);
  expect(f.visited()).toBe(3);
  expect(Object.isFrozen(result.transaction.events[1].hashes)).toBe(true);
  expect(Object.isFrozen(result.transaction.note)).toBe(true);
  for (const key of [
    'sourceAuthenticated',
    'ownershipAuthenticated',
    'currentCanonicalityVerified',
    'txidMembershipVerified',
    'disclosureEnabled',
    'spendingEnabled',
  ])
    expect(result[key]).toBe(false);
  expect((await collect(f.options)).transaction).toBeUndefined();
});
test.each([
  'missing-nullifier',
  'two-nullifiers',
  'two-outputs',
  'wrong-unshield-token',
  'wrong-order',
  'wrong-hash',
  'wrong-index',
  'noncanonical',
  'late-selected-extra',
  'reappearing-group',
])('fixed Transact creator refuses %s without truncating the source visit', async (fault) => {
  const f = transactFixture();
  if (fault === 'missing-nullifier') f.logs.splice(1, 1);
  if (fault === 'two-nullifiers')
    Object.assign(f.nullified, abi.encodeEventLog('Nullified', [0, [hex(700), hex(701)]]));
  if (fault === 'two-outputs') {
    Object.assign(
      f.selected,
      abi.encodeEventLog('Transact', [
        0,
        1,
        [f.options.capsule.noteHash, hex(701)],
        [f.transactCipher[1], f.transactCipher[0]],
      ])
    );
    f.options.checkpoint.state.trees[0].length = 3;
    f.options.checkpoint.state.commitments.count = 3;
  }
  if (fault === 'wrong-unshield-token')
    f.logs.splice(2, 0, {
      ...f.selected,
      logIndex: 5,
      ...abi.encodeEventLog('Unshield', ['0x' + '12'.repeat(20), [0, pins.proxy, 0], 998, 2]),
    });
  if (fault === 'wrong-unshield-token') f.selected.logIndex = 6;
  if (fault === 'wrong-order') {
    f.selected.logIndex = 3;
    f.logs.splice(1, 2, f.selected, f.nullified);
  }
  if (fault === 'wrong-hash') f.nullified.transactionHash = hex(999);
  if (fault === 'wrong-index') f.nullified.transactionIndex = 3;
  if (fault === 'noncanonical') f.nullified.data += '00'.repeat(32);
  if (fault === 'late-selected-extra')
    f.logs.push({
      ...f.selected,
      logIndex: 6,
      ...abi.encodeEventLog('Nullified', [0, [hex(702)]]),
    });
  if (fault === 'reappearing-group') {
    f.logs.push({
      ...f.selected,
      transactionHash: hex(998),
      transactionIndex: 5,
      logIndex: 6,
      topics: [hex(900)],
      data: '0x',
    });
    f.logs.push({ ...f.nullified, transactionIndex: 6, logIndex: 7 });
  }
  const count = f.logs.length;
  await expect(collectTransact(f.options)).rejects.toMatchObject({
    code: 'RAILGUN_POI_CREATOR_REFUSED',
  });
  expect(f.visited()).toBe(count);
});
test('fixed Transact creator refuses Shield while the legacy collector remains compatible', async () => {
  const f = fixture();
  expect((await collect(f.options)).creator.type).toBe('Shield');
  await expect(collectTransact(f.options)).rejects.toMatchObject({
    code: 'RAILGUN_POI_CREATOR_REFUSED',
  });
});
test.each(['suffix-authentication', 'semantic', 'cancellation'])(
  'fixed Transact creator waits for complete suffix after %s',
  async (fault) => {
    const f = transactFixture();
    let finish,
      entered,
      settled = false;
    const gate = new Promise((resolve) => {
      finish = resolve;
    });
    const ready = new Promise((resolve) => {
      entered = resolve;
    });
    const original = f.options.visit.getMockImplementation();
    f.options.visit.mockImplementation(async (visitor) => {
      const totals = await original(visitor);
      entered();
      await gate;
      if (fault === 'suffix-authentication') throw Error('private MAC failure');
      return totals;
    });
    if (fault === 'semantic') f.nullified.topics = [hex(900)];
    const pending = collectTransact(f.options).then(
      (value) => {
        settled = true;
        return { value };
      },
      (error) => {
        settled = true;
        return { error };
      }
    );
    try {
      await ready;
      if (fault === 'cancellation')
        f.options.assertCurrent.mockImplementation(() => {
          throw Error('revoked');
        });
      await Promise.resolve();
      expect(settled).toBe(false);
      finish();
      expect(await pending).toMatchObject({ error: { code: 'RAILGUN_POI_CREATOR_REFUSED' } });
    } finally {
      finish();
      await pending;
    }
  }
);

test.each([
  [0, 3520, 4096, true],
  [1760, 1760, 4096, true],
  [0, 3521, 4128, false],
  [1761, 1760, 4128, false],
  [256, 256, 1088, true],
])(
  'fixed Transact route bounds canonical ABI bytes with annotation=%s memo=%s',
  async (annotationBytes, memoBytes, encodedBytes, accepted) => {
    const f = transactFixture();
    const ciphertext = {
      ...f.transactCipher[1],
      annotationData: '0x' + 'ab'.repeat(annotationBytes),
      memo: '0x' + 'cd'.repeat(memoBytes),
    };
    Object.assign(
      f.selected,
      abi.encodeEventLog('Transact', [0, 1, [f.options.capsule.noteHash], [ciphertext]])
    );
    expect((f.selected.data.length - 2) / 2).toBe(encodedBytes);
    // Every input is canonical ABI, including the first aligned word above the
    // 4 KiB route cap. This tests the bound, not malformed trailing bytes.
    const decoded = abi.parseLog(f.selected);
    expect(abi.encodeEventLog(decoded.fragment, decoded.args)).toEqual({
      data: f.selected.data,
      topics: f.selected.topics,
    });
    if (accepted) {
      const result = await collectTransact(f.options);
      expect(result.creator.ciphertext.annotationData).toBe(ciphertext.annotationData);
      expect(result.creator.ciphertext.memo).toBe(ciphertext.memo);
    } else {
      await expect(collectTransact(f.options)).rejects.toMatchObject({
        code: 'RAILGUN_POI_CREATOR_REFUSED',
      });
    }
    expect(f.visited()).toBe(f.logs.length);
  }
);

const collectRetained = require('./railgun-poi-creator').collectRailgunPoiRetainedCreator;
describe.each([
  ['Transact', collectTransact],
  ['retained', collectRetained],
])('%s partial-creator collection', (_name, collector) => {
  test('retains the exact three-event group for a legacy second-spend capsule', async () => {
    const f = partialCreatorFixture();
    expect(f.options.capsule.version).toBe(1);
    const result = await collector(f.options);
    expect(result.transaction.events.map((e) => e.name)).toEqual([
      'Nullified',
      'Unshield',
      'Transact',
    ]);
    expect(result.transaction.events[1]).toEqual({
      name: 'Unshield',
      logIndex: 5,
      to: f.unshieldArgs[0],
      token: pins.wrappedNative,
      type: 0,
      subID: '0',
      value: '400',
    });
    expect(result.transaction.events[2].hashes).toEqual([f.options.capsule.noteHash]);
    expect(result.creator.ciphertext).toEqual(f.transactCipher[1]);
    expect(result.origin).toMatchObject({ outputOffset: 0, startPosition: 1, logIndex: 6 });
    expect(result.transaction.logsSha256).toBe(
      require('crypto')
        .createHash('sha256')
        .update(JSON.stringify([f.nullified, f.unshield, f.selected]))
        .digest('hex')
    );
    expect(Object.isFrozen(result.transaction.events[1])).toBe(true);
    expect(result.sourceAuthenticated).toBe(false);
    expect(result.txidMembershipVerified).toBe(false);
    expect(result.spendingEnabled).toBe(false);
    expect(f.visited()).toBe(4);
  });
  test.each([
    'token',
    'token-type',
    'token-subid',
    'zero-gross',
    'two-nullifiers',
    'extra-event',
    'noncanonical',
    'different-transaction',
    'oversize-ciphertext',
  ])('rejects mixed %s after the entire supplied suffix is visited', async (fault) => {
    const f = partialCreatorFixture();
    if (fault === 'token') f.unshieldArgs[1][1] = pins.proxy;
    if (fault === 'token-type') f.unshieldArgs[1][0] = 1;
    if (fault === 'token-subid') f.unshieldArgs[1][2] = 1;
    if (fault === 'zero-gross') f.unshieldArgs[2] = f.unshieldArgs[3] = 0;
    Object.assign(f.unshield, abi.encodeEventLog('Unshield', f.unshieldArgs));
    if (fault === 'two-nullifiers')
      Object.assign(f.nullified, abi.encodeEventLog('Nullified', [0, [hex(700), hex(701)]]));
    if (fault === 'extra-event') f.logs.push({ ...f.nullified, logIndex: 7 });
    if (fault === 'noncanonical') f.unshield.data += '00'.repeat(32);
    if (fault === 'different-transaction') f.unshield.transactionHash = hex(999);
    if (fault === 'oversize-ciphertext')
      Object.assign(
        f.selected,
        abi.encodeEventLog('Transact', [
          0,
          1,
          [f.options.capsule.noteHash],
          [{ ...f.transactCipher[1], annotationData: '0x' + 'ab'.repeat(3521), memo: '0x' }],
        ])
      );
    f.logs.push({
      ...f.shield,
      blockNumber: 291,
      blockHash: hex(291),
      transactionHash: hex(91),
      logIndex: 0,
      ...abi.encodeEventLog('Shield', [0, 2, [], [], []]),
    });
    await expect(collector(f.options)).rejects.toMatchObject({
      code: 'RAILGUN_POI_CREATOR_REFUSED',
    });
    expect(f.visited()).toBe(f.logs.length);
  });
  test('does not release a mixed selection before source authentication completes', async () => {
    const f = partialCreatorFixture();
    let release, entered;
    const gate = new Promise((resolve) => (release = resolve));
    const ready = new Promise((resolve) => (entered = resolve));
    const original = f.options.visit.getMockImplementation();
    f.options.visit.mockImplementation(async (visitor) => {
      await original(visitor);
      entered();
      await gate;
      throw Error('source suffix authentication failed');
    });
    let settled = false;
    const pending = collector(f.options).then(
      () => {
        settled = true;
        return 'unexpected success';
      },
      (error) => {
        settled = true;
        return error;
      }
    );
    try {
      await ready;
      expect(settled).toBe(false);
      release();
      expect(await pending).toMatchObject({ code: 'RAILGUN_POI_CREATOR_REFUSED' });
    } finally {
      release();
      await pending;
    }
  });
});
test('retained selected-Transact collector binds complete 1x1 group and ciphertext from one full visit', async () => {
  const f = transactFixture();
  const result = await collectRetained(f.options);
  expect(result.transaction).toEqual({
    note: {
      type: 'Transact',
      txid: hex(100),
      hash: f.options.capsule.noteHash,
      tree: 0,
      position: 1,
      blockNumber: 290,
    },
    events: [
      { name: 'Nullified', logIndex: 4, tree: 0, values: [hex(700)] },
      { name: 'Transact', logIndex: 5, tree: 0, start: 1, hashes: [f.options.capsule.noteHash] },
    ],
    logsSha256: require('crypto')
      .createHash('sha256')
      .update(JSON.stringify([f.nullified, f.selected]))
      .digest('hex'),
  });
  expect(result.creator.ciphertext).toEqual(f.transactCipher[1]);
  expect(result.origin).toMatchObject({
    transactionHash: hex(100),
    transactionIndex: 4,
    logIndex: 5,
    startPosition: 1,
    outputOffset: 0,
  });
  expect(f.options.visit).toHaveBeenCalledTimes(1);
  expect(f.visited()).toBe(3);
  expect(Object.isFrozen(result.transaction.events[1].hashes)).toBe(true);
  expect(Object.isFrozen(result.transaction.note)).toBe(true);
  for (const key of [
    'sourceAuthenticated',
    'ownershipAuthenticated',
    'currentCanonicalityVerified',
    'txidMembershipVerified',
    'disclosureEnabled',
    'spendingEnabled',
  ])
    expect(result[key]).toBe(false);
  expect((await collect(f.options)).transaction).toBeUndefined();
});
test.each([
  'missing-nullifier',
  'two-nullifiers',
  'two-outputs',
  'wrong-unshield-token',
  'wrong-order',
  'wrong-hash',
  'wrong-index',
  'noncanonical',
  'late-selected-extra',
  'reappearing-group',
])(
  'retained selected-Transact creator refuses %s without truncating the source visit',
  async (fault) => {
    const f = transactFixture();
    if (fault === 'missing-nullifier') f.logs.splice(1, 1);
    if (fault === 'two-nullifiers')
      Object.assign(f.nullified, abi.encodeEventLog('Nullified', [0, [hex(700), hex(701)]]));
    if (fault === 'two-outputs') {
      Object.assign(
        f.selected,
        abi.encodeEventLog('Transact', [
          0,
          1,
          [f.options.capsule.noteHash, hex(701)],
          [f.transactCipher[1], f.transactCipher[0]],
        ])
      );
      f.options.checkpoint.state.trees[0].length = 3;
      f.options.checkpoint.state.commitments.count = 3;
    }
    if (fault === 'wrong-unshield-token')
      f.logs.splice(2, 0, {
        ...f.selected,
        logIndex: 5,
        ...abi.encodeEventLog('Unshield', ['0x' + '12'.repeat(20), [0, pins.proxy, 0], 998, 2]),
      });
    if (fault === 'wrong-unshield-token') f.selected.logIndex = 6;
    if (fault === 'wrong-order') {
      f.selected.logIndex = 3;
      f.logs.splice(1, 2, f.selected, f.nullified);
    }
    if (fault === 'wrong-hash') f.nullified.transactionHash = hex(999);
    if (fault === 'wrong-index') f.nullified.transactionIndex = 3;
    if (fault === 'noncanonical') f.nullified.data += '00'.repeat(32);
    if (fault === 'late-selected-extra')
      f.logs.push({
        ...f.selected,
        logIndex: 6,
        ...abi.encodeEventLog('Nullified', [0, [hex(702)]]),
      });
    if (fault === 'reappearing-group') {
      f.logs.push({
        ...f.selected,
        transactionHash: hex(998),
        transactionIndex: 5,
        logIndex: 6,
        topics: [hex(900)],
        data: '0x',
      });
      f.logs.push({ ...f.nullified, transactionIndex: 6, logIndex: 7 });
    }
    const count = f.logs.length;
    await expect(collectRetained(f.options)).rejects.toMatchObject({
      code: 'RAILGUN_POI_CREATOR_REFUSED',
    });
    expect(f.visited()).toBe(count);
  }
);
test.each(['suffix-authentication', 'semantic', 'cancellation'])(
  'retained selected-Transact creator waits for complete suffix after %s',
  async (fault) => {
    const f = transactFixture();
    let finish,
      entered,
      settled = false;
    const gate = new Promise((resolve) => {
      finish = resolve;
    });
    const ready = new Promise((resolve) => {
      entered = resolve;
    });
    const original = f.options.visit.getMockImplementation();
    f.options.visit.mockImplementation(async (visitor) => {
      const totals = await original(visitor);
      entered();
      await gate;
      if (fault === 'suffix-authentication') throw Error('private MAC failure');
      return totals;
    });
    if (fault === 'semantic') f.nullified.topics = [hex(900)];
    const pending = collectRetained(f.options).then(
      (value) => {
        settled = true;
        return { value };
      },
      (error) => {
        settled = true;
        return { error };
      }
    );
    try {
      await ready;
      if (fault === 'cancellation')
        f.options.assertCurrent.mockImplementation(() => {
          throw Error('revoked');
        });
      await Promise.resolve();
      expect(settled).toBe(false);
      finish();
      expect(await pending).toMatchObject({ error: { code: 'RAILGUN_POI_CREATOR_REFUSED' } });
    } finally {
      finish();
      await pending;
    }
  }
);

test.each([
  [0, 3520, 4096, true],
  [1760, 1760, 4096, true],
  [0, 3521, 4128, false],
  [1761, 1760, 4128, false],
  [256, 256, 1088, true],
])(
  'retained selected-Transact route bounds canonical ABI bytes with annotation=%s memo=%s',
  async (annotationBytes, memoBytes, encodedBytes, accepted) => {
    const f = transactFixture();
    const ciphertext = {
      ...f.transactCipher[1],
      annotationData: '0x' + 'ab'.repeat(annotationBytes),
      memo: '0x' + 'cd'.repeat(memoBytes),
    };
    Object.assign(
      f.selected,
      abi.encodeEventLog('Transact', [0, 1, [f.options.capsule.noteHash], [ciphertext]])
    );
    expect((f.selected.data.length - 2) / 2).toBe(encodedBytes);
    // Every input is canonical ABI, including the first aligned word above the
    // 4 KiB route cap. This tests the bound, not malformed trailing bytes.
    const decoded = abi.parseLog(f.selected);
    expect(abi.encodeEventLog(decoded.fragment, decoded.args)).toEqual({
      data: f.selected.data,
      topics: f.selected.topics,
    });
    if (accepted) {
      const result = await collectRetained(f.options);
      expect(result.creator.ciphertext.annotationData).toBe(ciphertext.annotationData);
      expect(result.creator.ciphertext.memo).toBe(ciphertext.memo);
    } else {
      await expect(collectRetained(f.options)).rejects.toMatchObject({
        code: 'RAILGUN_POI_CREATOR_REFUSED',
      });
    }
    expect(f.visited()).toBe(f.logs.length);
  }
);

test('retained creator accepts Shield unchanged and omits creating-transaction data', async () => {
  const f = fixture();
  const expected = await collect(f.options),
    retained = await collectRetained(f.options);
  expect(retained).toEqual(expected);
  expect(retained.creator.type).toBe('Shield');
  expect(retained).not.toHaveProperty('transaction');
});
test('selected Shield transaction with more than three valid events survives retained group overflow', async () => {
  const f = fixture();
  for (let i = 0; i < 3; i++)
    f.logs.push({
      ...f.logs[0],
      logIndex: 6 + i,
      ...abi.encodeEventLog('Shield', [
        0,
        2 + i,
        [{ ...f.preimages[0], npk: hex(80 + i) }],
        [f.ciphers[0]],
        [0],
      ]),
    });
  f.options.checkpoint.state.trees[0].length = 5;
  f.options.checkpoint.state.commitments.count = 5;
  const result = await collectRetained(f.options);
  expect(f.visited()).toBe(4);
  expect(result.creator.type).toBe('Shield');
  expect(result.creator.preimage.npk).toBe(f.preimages[1].npk);
  expect(result).not.toHaveProperty('transaction');
});
