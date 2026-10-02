const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { createPrivacyScope } = require('../networks/privacy-context');
const { createRailgunSourceLedger } = require('./railgun-source-ledger');
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
