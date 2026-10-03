const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { createPrivacyScope } = require('../networks/privacy-context');
const { createRailgunSourceLedger } = require('./railgun-source-ledger');
const { startRailgunSessionWorker } = require('./railgun-session-worker');
const { railgunSourceBinding } = require('./railgun-source-ledger');
const hash = (v) => createHash('sha256').update(v).digest('hex');
const blockHash = (n) => '0x' + n.toString(16).padStart(64, '0');
let scope, options, ledgers;
const values = [
  { blockNumber: 5, data: 'public-a' },
  { blockNumber: 10, data: 'public-b' },
];
function range(from = 0, to = 10, logs = values) {
  return {
    from,
    to: { number: to, hash: blockHash(to) },
    previousHash: blockHash(from ? from - 1 : 0),
    providersSha256: 'b'.repeat(64),
    logs: { count: logs.length, sha256: hash(logs.map((v) => JSON.stringify(v) + '\n').join('')) },
  };
}
async function open(create) {
  const ledger = await createRailgunSourceLedger({ ...options, create });
  ledgers.push(ledger);
  return ledger;
}
async function suppliedWorker(binding = railgunSourceBinding(options.binding)) {
  const worker = startRailgunSessionWorker({
    handle: scope.getContext({
      kind: 'private-account',
      principal: 'fixture',
      protocol: 'railgun',
      chainId: 11155111,
      deployment: 'sepolia-fixture',
      role: 'engine',
    }),
    storage: {
      format: 'paged-v2',
      filename: options.filename,
      key: options.key,
      binding,
      create: true,
    },
    createProvider: ({ signal }) => ({
      signal,
      request: async () => {
        throw Error('no RPC');
      },
    }),
    onClose: () => {},
  });
  ledgers.push(worker);
  await worker.ready;
  return worker;
}
test('consumes only an authentic matching worker and rejects cloning, path, binding or account substitution', async () => {
  const worker = await suppliedWorker();
  const args = { ...options, key: undefined, create: true, storeSession: worker };
  await expect(
    createRailgunSourceLedger({ ...args, storeSession: { ...worker } })
  ).rejects.toThrow();
  await expect(
    createRailgunSourceLedger({ ...args, filename: options.filename + '.other' })
  ).rejects.toThrow();
  await expect(createRailgunSourceLedger({ ...args, binding: 'c'.repeat(64) })).rejects.toThrow();
  const foreign = scope.getContext({
    kind: 'private-account',
    principal: 'another',
    protocol: 'railgun',
    chainId: 11155111,
    deployment: 'sepolia-fixture',
    role: 'protocol-rpc',
  });
  await expect(createRailgunSourceLedger({ ...args, handle: foreign })).rejects.toThrow();
  const otherProfile = createPrivacyScope({
    profileId: 'different-profile',
    signal: new AbortController().signal,
  });
  try {
    const handle = otherProfile.getContext({
      kind: 'private-account',
      principal: 'fixture',
      protocol: 'railgun',
      chainId: 11155111,
      deployment: 'sepolia-fixture',
      role: 'protocol-rpc',
    });
    await expect(createRailgunSourceLedger({ ...args, handle })).rejects.toThrow();
  } finally {
    otherProfile.close();
  }
  expect(worker.signal.aborted).toBe(false);
  const ledger = await createRailgunSourceLedger(args);
  ledgers.push(ledger);
  await expect(createRailgunSourceLedger(args)).rejects.toThrow();
  expect(worker.signal.aborted).toBe(false);
  ledger.assertEmpty();
  const ref = await ledger.stage(range(), values);
  expect(ref.ledgerId).toBe(ledger.identity());
  ledger.close();
  await worker.closed;
  await expect(createRailgunSourceLedger(args)).rejects.toThrow();
});
test('an existing empty store without source metadata is refused on reopen', async () => {
  const worker = await suppliedWorker();
  await expect(
    createRailgunSourceLedger({ ...options, key: undefined, storeSession: worker })
  ).rejects.toThrow();
  await worker.closed;
  expect(worker.signal.aborted).toBe(true);
});
test('initialization refuses a nonempty store with missing source metadata', async () => {
  const worker = await suppliedWorker();
  await worker.dispatch(
    JSON.stringify({
      id: 1,
      method: 'batch',
      args: {
        operations: [
          {
            type: 'put',
            key: Buffer.from('other').toString('base64'),
            value: Buffer.from('data').toString('base64'),
          },
        ],
      },
    })
  );
  worker.close();
  await worker.closed;
  const reopened = startRailgunSessionWorker({
    handle: scope.getContext({
      kind: 'private-account',
      principal: 'fixture',
      protocol: 'railgun',
      chainId: 11155111,
      deployment: 'sepolia-fixture',
      role: 'engine',
    }),
    storage: {
      format: 'paged-v2',
      filename: options.filename,
      key: options.key,
      binding: railgunSourceBinding(options.binding),
      create: false,
    },
    createProvider: ({ signal }) => ({
      signal,
      request: async () => {
        throw Error('no RPC');
      },
    }),
    onClose: () => {},
  });
  ledgers.push(reopened);
  await expect(
    createRailgunSourceLedger({ ...options, key: undefined, create: true, storeSession: reopened })
  ).rejects.toThrow();
  await reopened.closed;
});
beforeEach(() => {
  scope = createPrivacyScope({ profileId: 'ledger-fixture', signal: new AbortController().signal });
  ledgers = [];
  const handle = scope.getContext({
    kind: 'private-account',
    principal: 'fixture',
    protocol: 'railgun',
    chainId: 11155111,
    deployment: 'sepolia-fixture',
    role: 'protocol-rpc',
  });
  options = {
    handle,
    filename: path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-source-ledger-')),
      'source.sqlite'
    ),
    key: Buffer.alloc(32, 51),
    binding: 'a'.repeat(64),
  };
});
afterEach(async () => {
  scope.close();
  for (const ledger of ledgers) {
    ledger.close();
    await ledger.closed;
  }
});
test('keeps source logs in a separate encrypted store, appends contiguous ranges and restores exact prefixes', async () => {
  const first = await open(true),
    reference = await first.stage(range(), values),
    read = [];
  expect(await first.visit(reference, (v) => read.push(v))).toMatchObject({ count: 2 });
  expect(read).toEqual(values);
  const next = await first.stage(range(11, 20, []), []);
  expect(next.ledgerId).toBe(reference.ledgerId);
  expect(next.ledgerSha256).not.toBe(reference.ledgerSha256);
  expect(fs.readFileSync(options.filename).includes(Buffer.from('public-a'))).toBe(false);
  first.close();
  await first.closed;
  const second = await open(false),
    restored = await second.stage(range(), values);
  expect(restored).toEqual(reference);
  const cold = [];
  await second.visit(restored, (v) => cold.push(v));
  expect(cold).toEqual(values);
  await expect(second.visit(reference, () => {})).rejects.toThrow();
  const tail = await second.stage(range(11, 20, []), []);
  expect(tail).toEqual(next);
  expect(await second.visit(tail, () => {})).toMatchObject({ count: 2 });
});
test.each(['gap', 'parent', 'digest', 'count', 'changed-prefix'])(
  'refuses %s without replacing history',
  async (mode) => {
    const ledger = await open(true);
    await ledger.stage(range(), values);
    const next = range(11, 20, []);
    if (mode === 'gap') next.from = 12;
    if (mode === 'parent') next.previousHash = blockHash(8);
    if (mode === 'digest') next.logs.sha256 = '0'.repeat(64);
    if (mode === 'count') next.logs.count = 1;
    if (mode === 'changed-prefix') {
      Object.assign(next, range());
      next.to.hash = blockHash(99);
    }
    await expect(ledger.stage(next, mode === 'changed-prefix' ? values : [])).rejects.toThrow();
    expect(ledger.signal.aborted).toBe(true);
    await ledger.closed;
    const reopened = await open(false),
      reference = await reopened.stage(range(), values);
    expect(await reopened.visit(reference, () => {})).toMatchObject({ count: 2 });
  }
);
test('snapshots caller inputs, refuses forged handles and revokes on profile lock', async () => {
  const ledger = await open(true),
    input = range(),
    logs = structuredClone(values);
  const pending = ledger.stage(input, logs);
  input.to.number = 99;
  logs[0].data = 'changed';
  const reference = await pending,
    read = [];
  await ledger.visit(reference, (v) => read.push(v));
  expect(read).toEqual(values);
  await expect(ledger.visit({ ...reference }, () => {})).rejects.toThrow();
  scope.close();
  await expect(ledger.stage(range(11, 20, []), [])).rejects.toThrow();
});
test('an unfinished visitor excludes concurrent staging and closes on failure', async () => {
  const ledger = await open(true),
    reference = await ledger.stage(range(), values);
  let release, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const visiting = ledger.visit(reference, () => {
    entered();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  await started;
  await expect(ledger.stage(range(11, 20, []), [])).rejects.toThrow();
  ledger.close();
  release();
  await expect(visiting).rejects.toThrow();
});
test('provider changes preserve the content hash and cached range remains discoverable', async () => {
  const ledger = await open(true),
    reference = await ledger.stage(range(), values);
  const switched = range();
  switched.providersSha256 = 'c'.repeat(64);
  expect(await ledger.stage(switched, values)).toEqual(reference);
  const first = await ledger.nextAfter(hash('freedom:railgun:source-ledger-v1'));
  expect(first.range.to.number).toBe(10);
  expect(await ledger.nextAfter(first.sha256)).toBeNull();
  await expect(ledger.retain({})).rejects.toThrow();
});
