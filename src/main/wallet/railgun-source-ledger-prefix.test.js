const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { createPrivacyScope } = require('../networks/privacy-context');
const { startRailgunSessionWorker } = require('./railgun-session-worker');
const { createRailgunSourceLedger, railgunSourceBinding } = require('./railgun-source-ledger');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const hash = (n) => '0x' + n.toString(16).padStart(64, '0');
const encode = (value) => Buffer.from(value).toString('base64');
const flush = () => new Promise(setImmediate);
let scope, options, resources;
const rows = [
  { blockNumber: 5, data: 'first' },
  { blockNumber: 9, data: 'second' },
];
const range = (from = 0, to = 10, logs = rows) => ({
  from,
  to: { number: to, hash: hash(to + 1) },
  previousHash: hash(from),
  providersSha256: 'b'.repeat(64),
  logs: {
    count: logs.length,
    sha256: sha(logs.map((value) => JSON.stringify(value) + '\n').join('')),
  },
});
async function open(create = false) {
  const ledger = await createRailgunSourceLedger({ ...options, create });
  resources.push(ledger);
  return ledger;
}
async function close(value) {
  value.close();
  await value.closed;
}
async function edit(editRows) {
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
      binding: railgunSourceBinding(options.binding),
      create: false,
    },
    createProvider: ({ signal }) => ({
      signal,
      request: async () => {
        throw Error('No RPC');
      },
    }),
    onClose: () => {},
  });
  resources.push(worker);
  await worker.ready;
  let id = 0;
  const call = async (method, args) =>
    JSON.parse(await worker.dispatch(JSON.stringify({ id: ++id, method, args }))).value;
  const get = async (key) => {
    const value = await call('get', { key: encode(key) });
    return value === null ? null : JSON.parse(Buffer.from(value, 'base64').toString());
  };
  const put = async (key, value) =>
    call('batch', {
      operations: [
        {
          type: 'put',
          key: encode(key),
          value: encode(JSON.stringify(value)),
        },
      ],
    });
  await editRows({ get, put });
  await close(worker);
}
beforeEach(() => {
  resources = [];
  scope = createPrivacyScope({
    profileId: 'ledger-prefix-fixture',
    signal: new AbortController().signal,
  });
  options = {
    handle: scope.getContext({
      kind: 'private-account',
      principal: 'fixture',
      protocol: 'railgun',
      chainId: 11155111,
      deployment: 'sepolia-fixture',
      role: 'protocol-rpc',
    }),
    filename: path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-ledger-prefix-')),
      'source.sqlite'
    ),
    key: Buffer.alloc(32, 81),
    binding: 'a'.repeat(64),
  };
});
afterEach(async () => {
  scope.close();
  for (const value of resources) await close(value);
});
test('empty authenticated ledger reports absence without creating a range', async () => {
  const ledger = await open(true);
  expect(await ledger.hasPrefix('f'.repeat(64))).toBe(false);
  expect(ledger.signal.aborted).toBe(false);
  const reference = await ledger.stage(range(), rows);
  expect(await ledger.hasPrefix(reference.ledgerSha256)).toBe(true);
});
test('cold prefix lookup finds an older prefix without retaining away its newer tail', async () => {
  const first = await open(true);
  const prefix = await first.stage(range(), rows);
  const tailRows = [{ blockNumber: 15, data: 'tail' }];
  const tail = await first.stage(range(11, 20, tailRows), tailRows);
  await close(first);
  const ledger = await open();
  expect(await ledger.hasPrefix(prefix.ledgerSha256)).toBe(true);
  expect(await ledger.hasPrefix(tail.ledgerSha256)).toBe(true);
  expect(await ledger.hasPrefix('f'.repeat(64))).toBe(false);
  const seen = [];
  await ledger.visitThrough(tail.ledgerSha256, (value) => seen.push(value));
  expect(seen).toEqual([...rows, ...tailRows]);
});
test.each([null, undefined, {}, 'F'.repeat(64), 'f'.repeat(63), '0x' + 'f'.repeat(64)])(
  'invalid prefix input %# refuses without damaging a healthy ledger',
  async (value) => {
    const ledger = await open(true);
    const reference = await ledger.stage(range(), rows);
    await expect(ledger.hasPrefix(value)).rejects.toThrow();
    expect(ledger.signal.aborted).toBe(false);
    expect(await ledger.hasPrefix(reference.ledgerSha256)).toBe(true);
  }
);
test('lookup while a visitor is pending refuses without releasing or closing that owner', async () => {
  const ledger = await open(true);
  const reference = await ledger.stage(range(), rows);
  let release, enter;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const visiting = ledger.visitThrough(reference.ledgerSha256, async () => {
    enter();
    await gate;
  });
  try {
    await entered;
    await expect(ledger.hasPrefix(reference.ledgerSha256)).rejects.toThrow();
    expect(ledger.signal.aborted).toBe(false);
    await flush();
  } finally {
    release();
  }
  await visiting;
  expect(await ledger.hasPrefix(reference.ledgerSha256)).toBe(true);
});
test('hasPrefix authenticates metadata without reading logs or pretending their digest was checked', async () => {
  const first = await open(true);
  const reference = await first.stage(range(), rows);
  await close(first);
  await edit(async ({ put }) => {
    await put('source:range:00000:log:00001', { ...rows[1], data: 'corrupt' });
  });
  const ledger = await open();
  expect(await ledger.hasPrefix(reference.ledgerSha256)).toBe(true);
  expect(ledger.signal.aborted).toBe(false);
  await expect(ledger.visitThrough(reference.ledgerSha256, () => {})).rejects.toThrow();
  expect(ledger.signal.aborted).toBe(true);
});
test.each(['chain', 'index', 'hash', 'tail-hash', 'tail-height', 'tail-block', 'count', 'logs'])(
  'authenticated absence rejects corrupted %s metadata instead of reporting false',
  async (kind) => {
    const first = await open(true);
    await first.stage(range(), rows);
    await close(first);
    await edit(async ({ get, put }) => {
      const key = ['chain', 'index', 'hash'].includes(kind) ? 'source:range:00000' : 'source:meta';
      const value = await get(key);
      if (kind === 'chain') value.previous = 'd'.repeat(64);
      if (kind === 'index') value.index = 1;
      if (kind === 'hash') value.sha256 = 'd'.repeat(64);
      if (kind === 'tail-hash') value.sha256 = 'd'.repeat(64);
      if (kind === 'tail-height') value.to++;
      if (kind === 'tail-block') value.blockHash = hash(777);
      if (kind === 'count') value.count++;
      if (kind === 'logs') value.logs++;
      await put(key, value);
    });
    const ledger = await open();
    await expect(ledger.hasPrefix('f'.repeat(64))).rejects.toThrow();
    expect(ledger.signal.aborted).toBe(true);
  }
);

test('matched older prefix does not authenticate a later tail, while absence must authenticate it', async () => {
  const first = await open(true);
  const prefix = await first.stage(range(), rows);
  const tail = [{ blockNumber: 15, data: 'tail' }];
  await first.stage(range(11, 20, tail), tail);
  await close(first);
  await edit(async ({ get, put }) => {
    const record = await get('source:range:00001');
    record.previous = 'd'.repeat(64);
    await put('source:range:00001', record);
  });
  const ledger = await open();
  const before = fs.readFileSync(options.filename);
  expect(await ledger.hasPrefix(prefix.ledgerSha256)).toBe(true);
  expect(fs.readFileSync(options.filename)).toEqual(before);
  expect(ledger.signal.aborted).toBe(false);
  await expect(ledger.hasPrefix('f'.repeat(64))).rejects.toThrow();
  expect(ledger.signal.aborted).toBe(true);
});
