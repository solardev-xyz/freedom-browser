const { Interface } = require('ethers');
const { PRIVATE_EVENTS } = require('./railgun-transact-receipt');
const { collectRailgunPrivateCreator } = require('./railgun-private-creator');
const { checkpointHash } = require('./railgun-wallet-coverage');
const abi = new Interface(PRIVATE_EVENTS),
  pins = require('./railgun-shield-pins.json');
const hex = (n) => '0x' + n.toString(16).padStart(64, '0');
const ciphertext = [[hex(1), hex(2), hex(3), hex(4)], hex(5), hex(6), '0x', '0x'];
function fixture() {
  const note = {
    type: 'Transact',
    txid: hex(50),
    hash: hex(20),
    tree: 0,
    position: 10,
    blockNumber: 5,
  };
  const checkpoint = {
    from: 0,
    previousHash: hex(0),
    to: { number: 10, hash: hex(10) },
    anchor: { number: 100, hash: hex(100) },
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
      trees: [{ tree: 0, length: 11, root: hex(11) }],
      commitments: { count: 11, sha256: 'f'.repeat(64) },
      nullifiers: { count: 1, sha256: '1'.repeat(64) },
      unshields: { count: 0, sha256: '2'.repeat(64) },
    },
  };
  const log = (name, args, logIndex) => ({
    address: pins.proxy,
    blockNumber: 5,
    blockHash: hex(5),
    transactionHash: note.txid,
    transactionIndex: 2,
    logIndex,
    ...abi.encodeEventLog(abi.getEvent(name), args),
  });
  const logs = [
    log('Nullified', [0, [hex(30)]], 1),
    log('Transact', [0, 10, [note.hash], [ciphertext]], 2),
  ];
  const options = {
    note,
    checkpoint,
    assertCurrent: jest.fn(),
    visit: jest.fn(async (visitor) => {
      for (const entry of logs) await visitor(entry);
      return {
        count: logs.length,
        bytes: logs.reduce((n, entry) => n + Buffer.byteLength(JSON.stringify(entry) + '\n'), 0),
      };
    }),
  };
  return { options, logs, log };
}
test('captures full canonical production events and exact source checkpoint as immutable data', async () => {
  const f = fixture(),
    result = await collectRailgunPrivateCreator(f.options);
  expect(result.note).toEqual(f.options.note);
  expect(result.checkpointHash).toBe(checkpointHash(f.options.checkpoint));
  expect(result.creator).toEqual({
    blockNumber: 5,
    blockHash: hex(5),
    transactionHash: hex(50),
    transactionIndex: 2,
  });
  expect(result.events).toEqual([
    { name: 'Nullified', logIndex: 1, tree: 0, values: [hex(30)] },
    { name: 'Transact', logIndex: 2, tree: 0, start: 10, hashes: [hex(20)] },
  ]);
  expect(result.source.trust).toBe('unverified-rpc');
  expect(result).toMatchObject({
    txidMembershipVerified: false,
    rootAccepted: false,
    spendingEnabled: false,
  });
  expect(Object.isFrozen(result.events[1].hashes)).toBe(true);
  f.options.note.hash = hex(99);
  expect(result.note.hash).toBe(hex(20));
});
test('supports one row with private output and unshield, preserving gross amount', async () => {
  const f = fixture();
  f.logs[1].logIndex = 3;
  f.logs.splice(
    1,
    0,
    f.log('Unshield', ['0x' + '1'.repeat(40), [0, pins.wrappedNative, 0], 998, 2], 2)
  );
  const result = await collectRailgunPrivateCreator(f.options);
  expect(result.events[1]).toMatchObject({ name: 'Unshield', value: '1000', subID: '0' });
});
test.each(['valid', 'semantic'])(
  'waits for the entire %s source visit to authenticate',
  async (mode) => {
    const f = fixture();
    let release,
      settled = false;
    if (mode === 'semantic') f.logs[0].blockHash = hex(999);
    f.options.visit.mockImplementation(async (visitor) => {
      for (const log of f.logs) await visitor(log);
      await new Promise((r) => {
        release = r;
      });
      return {
        count: 2,
        bytes: f.logs.reduce((n, log) => n + Buffer.byteLength(JSON.stringify(log) + '\n'), 0),
      };
    });
    const pending = collectRailgunPrivateCreator(f.options);
    const observed = pending.then(
      (v) => {
        settled = true;
        return v;
      },
      (e) => {
        settled = true;
        return e;
      }
    );
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(settled).toBe(false);
    release();
    const result = await observed;
    if (mode === 'semantic') expect(result.code).toBe('RAILGUN_PRIVATE_CREATOR_REFUSED');
    else expect(result.creator.transactionHash).toBe(hex(50));
  }
);
test.each(['tail-authentication', 'cancelled', 'visit-count'])(
  'refuses %s even after the selected logs were delivered',
  async (mode) => {
    const f = fixture(),
      original = f.options.visit.getMockImplementation();
    f.options.visit.mockImplementation(async (visitor) => {
      const result = await original(visitor);
      if (mode === 'tail-authentication') throw Error('private backend detail');
      if (mode === 'cancelled')
        f.options.assertCurrent.mockImplementation(() => {
          throw Error('closed');
        });
      if (mode === 'visit-count') result.count++;
      return result;
    });
    await expect(collectRailgunPrivateCreator(f.options)).rejects.toMatchObject({
      code: 'RAILGUN_PRIVATE_CREATOR_REFUSED',
      message: 'Railgun private creator unavailable',
    });
  }
);
test.each([
  'foreign-block',
  'foreign-index',
  'duplicate',
  'extra-row',
  'unknown-event',
  'trailing-bytes',
  'ciphertext-count',
  'duplicate-output',
  'wrong-output',
  'missing',
  'too-large',
])('refuses %s without filtering selected creator events', async (mode) => {
  const f = fixture();
  if (mode === 'foreign-block') f.logs[1].blockNumber++;
  if (mode === 'foreign-index') f.logs[1].transactionIndex++;
  if (mode === 'duplicate') f.logs[1].logIndex = 1;
  if (mode === 'extra-row') {
    f.logs[1].logIndex = 3;
    f.logs.splice(1, 0, f.log('Nullified', [0, [hex(31)]], 2));
  }
  if (mode === 'unknown-event') f.logs[0].topics = [hex(900)];
  if (mode === 'trailing-bytes') f.logs[1].data += '00';
  if (mode === 'ciphertext-count') f.logs[1] = f.log('Transact', [0, 10, [hex(20)], []], 2);
  if (mode === 'duplicate-output')
    f.logs[1] = f.log('Transact', [0, 10, [hex(20), hex(20)], [ciphertext, ciphertext]], 2);
  if (mode === 'wrong-output') f.logs[1] = f.log('Transact', [0, 10, [hex(99)], [ciphertext]], 2);
  if (mode === 'missing') f.options.note.txid = hex(900);
  if (mode === 'too-large') f.logs[1].data = '0x' + '00'.repeat(4097);
  await expect(collectRailgunPrivateCreator(f.options)).rejects.toMatchObject({
    code: 'RAILGUN_PRIVATE_CREATOR_REFUSED',
  });
});

test('shared creator event normalizer preserves legacy three-event gross-unshield interpretation', async () => {
  const { normalizeRailgunPrivateCreatorEvents } = require('./railgun-private-creator');
  const f = fixture();
  f.logs[1].logIndex = 3;
  f.logs.splice(
    1,
    0,
    f.log('Unshield', ['0x' + '1'.repeat(40), [0, pins.wrappedNative, 0], 998, 2], 2)
  );
  const parsed = normalizeRailgunPrivateCreatorEvents(f.logs);
  expect(parsed).toEqual((await collectRailgunPrivateCreator(f.options)).events);
  expect(parsed[1].value).toBe('1000');
  parsed[0].values[0] = hex(999);
  expect(normalizeRailgunPrivateCreatorEvents(f.logs)[0].values).toEqual([hex(30)]);
});
test.each([
  'trailing-bytes',
  'duplicate-output',
  'cipher-count',
  'empty-nullifiers',
  'unknown-topic',
])('shared creator event normalizer refuses %s canonical ambiguity', (fault) => {
  const { normalizeRailgunPrivateCreatorEvents } = require('./railgun-private-creator');
  const f = fixture();
  if (fault === 'trailing-bytes') f.logs[0].data += '00'.repeat(32);
  if (fault === 'duplicate-output')
    f.logs[1] = f.log('Transact', [0, 10, [hex(20), hex(20)], [ciphertext, ciphertext]], 2);
  if (fault === 'cipher-count') f.logs[1] = f.log('Transact', [0, 10, [hex(20)], []], 2);
  if (fault === 'empty-nullifiers') f.logs[0] = f.log('Nullified', [0, []], 1);
  if (fault === 'unknown-topic') f.logs[0].topics = [hex(999)];
  expect(() => normalizeRailgunPrivateCreatorEvents(f.logs)).toThrow();
});
