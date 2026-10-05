// Fixture hashes are equality checks, never production issuer evidence.
jest.mock('./railgun-native-assertions', () => ({ assert: require('assert/strict') }));
const fs = require('fs'),
  os = require('os'),
  path = require('path');
const { spawnSync } = require('child_process');
const data = require('./railgun-combined-poi-restart-data');
const h = require('./railgun-combined-poi-second-handoff');
const copy = (v) => JSON.parse(JSON.stringify(v));
let first, second, record;
beforeEach(() => {
  first = {
    entry: {
      id: 'a'.repeat(64),
      state: 'signing',
      facts: { nullifier: 'first-nullifier' },
      signing: { submitter: 'owner' },
    },
    stored: {
      holdId: 'a'.repeat(64),
      capsule: {
        version: 2,
        preparation: { expected: { changeCommitment: 'change' }, changeAmount: '600' },
      },
      signature: ['original-first-signature'],
      provedTransaction: { data: 'original-first-proof' },
    },
  };
  second = {
    entry: {
      id: 'b'.repeat(64),
      state: 'signing',
      facts: { nullifier: 'second-nullifier' },
      signing: { submitter: 'owner' },
    },
    stored: {
      holdId: 'b'.repeat(64),
      capsule: {
        version: 1,
        selection: { kind: 'railgun-token-unshield', recipient: 'owner' },
        noteHash: 'change',
        preparation: { expected: { amount: '600' } },
      },
      signature: ['original-second-signature'],
      provedTransaction: { data: 'original-second-proof' },
    },
  };
  record = {
    hash: 'first-tx',
    nonce: 0,
    intent: { nullifier: 'first-nullifier' },
    resolution: { blockHash: 'first-anchor' },
    revision: 1,
    observation: { blockHash: 'first-anchor', confirmations: 3, observedAt: 1 },
  };
});
test('only hashes leave two exact slots; neither signature nor capsule serialized', () => {
  const v = h.pairHashes(first, second, record);
  for (const name of ['first', 'second'])
    for (const hash of Object.values(v[name])) expect(hash).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(v)).not.toContain('original-second-signature');
  expect(JSON.stringify(v)).not.toContain('change');
  expect(v.first.holdId).not.toBe(v.second.holdId);
});
test.each(['hold', 'nullifier', 'proof', 'amount', 'recipient', 'creator', 'kind'])(
  '%s mismatch refuses hashing a handoff',
  (kind) => {
    if (kind === 'hold') second.entry.id = first.entry.id;
    if (kind === 'nullifier') second.entry.facts.nullifier = first.entry.facts.nullifier;
    if (kind === 'proof') second.stored.provedTransaction = null;
    if (kind === 'amount') second.stored.capsule.preparation.expected.amount = '599';
    if (kind === 'recipient') second.stored.capsule.selection.recipient = 'other';
    if (kind === 'creator') second.stored.capsule.noteHash = 'other';
    if (kind === 'kind') second.stored.capsule.selection.kind = 'railgun-private-transfer';
    expect(() => h.pairHashes(first, second, record)).toThrow();
  }
);
test('stable record digest permits observation refresh, binds nonce/anchor/resolution', () => {
  const digest = h.firstImmutable(record);
  const refreshed = copy(record);
  refreshed.revision++;
  refreshed.observation.confirmations++;
  refreshed.observation.observedAt++;
  expect(h.firstImmutable(refreshed)).toBe(digest);
  for (const mutate of [
    (v) => v.nonce++,
    (v) => (v.observation.blockHash = 'changed'),
    (v) => (v.resolution.blockHash = 'changed'),
  ]) {
    const changed = copy(refreshed);
    mutate(changed);
    expect(h.firstImmutable(changed)).not.toBe(digest);
  }
});
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'second-handoff-'));
  const pid = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
  for (const file of [
    'wallet-railgun-accounts/a/store',
    'wallet-private-submissions/a',
    'wallet-privacy-inventory.json',
    'identity/identity-vault.json',
    'identity/vault-meta.json',
  ]) {
    const p = path.join(directory, 'profile', file);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'encrypted-' + file);
  }
  const hashes = h.pairHashes(first, second, record),
    hex = '1'.repeat(64);
  const state = { count: 1, root: hex };
  const wire = {
    schema: 'railgun-combined-change-public-wire-v1',
    inputCreator: 'Shield',
    transaction: { hash: '0x' + hex, from: 'owner', blockHash: 'anchor' },
    receipt: { transactionHash: '0x' + hex, from: 'owner', blockHash: 'anchor' },
    history: { rows: [{ txid: hex }], state, checkpoints: [state], finalized: 1 },
    publicIdentity: {},
    checkpoint: {},
    retained: { capsuleDigest: hex, entrySha256: hex, inspect: { reservedTransitions: 2 } },
    privateHashes: { ...hashes.first, record: hashes.record },
    acceptedBodySha256: hex,
    list: {},
  };
  delete wire.privateHashes.holdId;
  const predecessor = {
    runID: '11111111-1111-4111-8111-111111111111',
    setupPID: pid,
    inputCreator: 'Shield',
    profile: path.resolve(directory, 'profile'),
    sourceHashes: { code: hex },
    runtimes: { engine: hex },
    sourceSha256: hex,
    publicWireSha256: data.digest(wire),
    setupReportSha256: data.sha('setup'),
  };
  fs.writeFileSync(path.join(directory, 'report.json'), 'setup');
  fs.writeFileSync(path.join(directory, 'restart-wire.json'), JSON.stringify(wire));
  fs.writeFileSync(path.join(directory, 'restart-handoff.json'), JSON.stringify(predecessor));
  const report = {
    runID: predecessor.runID,
    provePID: process.pid,
    secondProveStopQualified: true,
    secondColdSubmitQualified: false,
  };
  fs.writeFileSync(path.join(directory, 'second-prove-report.json'), JSON.stringify(report));
  const options = {
    directory,
    predecessor,
    report,
    records: hashes,
    retained: { entrySha256: hex, inspectSha256: hex },
  };
  return { directory, options, pid };
}
function frozen() {
  const f = fixture();
  const sealed = h.seal(f.options);
  sealed.provePID = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
  const report = { ...f.options.report, provePID: sealed.provePID };
  fs.writeFileSync(path.join(f.directory, 'second-prove-report.json'), JSON.stringify(report));
  sealed.proveReportSha256 = data.sha(
    fs.readFileSync(path.join(f.directory, 'second-prove-report.json'))
  );
  fs.writeFileSync(path.join(f.directory, 'second-proved-handoff.json'), JSON.stringify(sealed));
  return { ...f, sealed };
}
test('new exited process can load complete exact profile and hash-only second stage', () => {
  const { directory, sealed } = frozen();
  expect(h.load(directory, { inputCreator: 'Shield' }).handoff).toEqual(sealed);
});
test.each([
  'livePid',
  'vault',
  'metadata',
  'wire',
  'report',
  'predecessor',
  'extra',
  'firstProof',
  'sameHold',
])('%s cannot pass cold loader', (kind) => {
  const { directory, sealed } = frozen();
  if (kind === 'livePid') sealed.provePID = process.pid;
  if (kind === 'vault')
    fs.appendFileSync(path.join(directory, 'profile/identity/identity-vault.json'), 'changed');
  if (kind === 'metadata')
    fs.appendFileSync(path.join(directory, 'profile/identity/vault-meta.json'), 'changed');
  if (kind === 'wire') fs.appendFileSync(path.join(directory, 'restart-wire.json'), ' ');
  if (kind === 'report') fs.appendFileSync(path.join(directory, 'second-prove-report.json'), ' ');
  if (kind === 'predecessor') fs.appendFileSync(path.join(directory, 'restart-handoff.json'), ' ');
  if (kind === 'extra') sealed.capsule = { secret: 'forbidden' };
  if (kind === 'firstProof') sealed.records.first.provedTransaction = 'f'.repeat(64);
  if (kind === 'sameHold') sealed.records.second.holdId = sealed.records.first.holdId;
  fs.writeFileSync(path.join(directory, 'second-proved-handoff.json'), JSON.stringify(sealed));
  // Wire checksum covers canonical JSON; whitespace alone is deliberately not mutation.
  if (kind === 'wire') {
    const w = JSON.parse(fs.readFileSync(path.join(directory, 'restart-wire.json')));
    w.acceptedBodySha256 = 'f'.repeat(64);
    fs.writeFileSync(path.join(directory, 'restart-wire.json'), JSON.stringify(w));
  }
  expect(() => h.load(directory, { inputCreator: 'Shield' })).toThrow();
});
test('refused proof stop cannot seal and no overwrite on repeated seal', () => {
  const f = fixture();
  f.options.report.secondProveStopQualified = false;
  expect(() => h.seal(f.options)).toThrow();
  f.options.report.secondProveStopQualified = true;
  h.seal(f.options);
  expect(() => h.seal(f.options)).toThrow();
});
