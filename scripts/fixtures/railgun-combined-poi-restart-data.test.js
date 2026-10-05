// Manifest tests use disposable ordinary files, never a wallet/profile issuer.
jest.mock('./railgun-native-assertions', () => ({
  assert: require('assert/strict'),
}));
jest.mock('original-fs', () => require('fs'), { virtual: true });
const fs = require('fs'),
  os = require('os'),
  path = require('path');
const { spawnSync } = require('child_process');
const data = require('./railgun-combined-poi-restart-data');
let directory, wire, report, options, pid;
const hash = 'a'.repeat(64);
const copy = (v) => JSON.parse(JSON.stringify(v));
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'combined-restart-unit-'));
  for (const [file, body] of Object.entries({
    'wallet-railgun-accounts/account/store': 'encrypted',
    'wallet-private-submissions/journal': 'encrypted-eoa',
    'wallet-privacy-inventory.json': 'authenticated-inventory',
    'identity/identity-vault.json': 'encrypted-vault',
    'identity/vault-meta.json': 'public-wallet-metadata',
  })) {
    const name = path.join(directory, 'profile', file);
    fs.mkdirSync(path.dirname(name), { recursive: true });
    fs.writeFileSync(name, body);
  }
  pid = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
  const state = { count: 1, root: hash };
  wire = {
    schema: 'railgun-combined-change-public-wire-v1',
    inputCreator: 'Shield',
    transaction: { hash: '0x' + hash, from: 'owner', blockHash: 'block' },
    receipt: {
      transactionHash: '0x' + hash,
      from: 'owner',
      blockHash: 'block',
    },
    history: {
      rows: [{ txid: hash }],
      state,
      checkpoints: [state],
      finalized: 100,
    },
    publicIdentity: { id: 'genuine-diagnostic' },
    checkpoint: { to: { number: 100 } },
    retained: {
      capsuleDigest: hash,
      entrySha256: hash,
      inspect: { reservedTransitions: 2 },
    },
    privateHashes: Object.fromEntries(
      ['entry', 'stored', 'capsule', 'signature', 'provedTransaction', 'record'].map((k) => [
        k,
        hash,
      ])
    ),
    list: {},
    acceptedBodySha256: hash,
  };
  report = {
    runID: '11111111-1111-4111-8111-111111111111',
    setupPID: process.pid,
    secondSpendQualified: false,
    connected: {
      disposableChangeMembershipVerified: true,
      acceptance: { accepted: true, verifierExits: 1, bindingExits: 1 },
    },
  };
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report));
  options = {
    directory,
    wire,
    report,
    sourceHashes: { source: hash },
    runtimes: { engine: hash },
    sourceSha256: hash,
    runID: report.runID,
  };
});
// Keep artifacts on failure and success; do not erase diagnostic files.
test('runtime manifest binds spend and combined POI artifacts independently', () => {
  const inputs = {
    archive: path.join(directory, 'engine.asar'),
    proverArchive: path.join(directory, 'prover.asar'),
    bytecodes: path.join(directory, 'bytecodes.json'),
    artifactDirectory: directory,
  };
  for (const file of [inputs.archive, inputs.proverArchive, inputs.bytecodes])
    fs.writeFileSync(file, path.basename(file));
  const names = ['01x01', '01x02', 'POI_3x3'].flatMap((c) =>
    ['wasm', 'zkey', 'vkey'].map((ext) => c + '.' + ext)
  );
  for (const name of names) fs.writeFileSync(path.join(directory, name), name);
  const baseline = data.runtimeHashes(inputs);
  expect(Object.keys(baseline.artifacts)).toEqual(names);
  for (const name of names) {
    fs.appendFileSync(path.join(directory, name), '-changed');
    const changed = data.runtimeHashes(inputs);
    expect(changed.artifacts[name]).not.toBe(baseline.artifacts[name]);
    expect(changed.engine).toBe(baseline.engine);
    expect(changed.prover).toBe(baseline.prover);
    expect(changed.bytecodes).toBe(baseline.bytecodes);
    for (const other of names.filter((value) => value !== name))
      expect(changed.artifacts[other]).toBe(baseline.artifacts[other]);
    fs.writeFileSync(path.join(directory, name), name);
  }
});
function sealed() {
  const h = data.seal(options);
  h.setupPID = pid;
  const r = { ...report, setupPID: pid };
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(r));
  h.setupReportSha256 = data.sha(fs.readFileSync(path.join(directory, 'report.json')));
  fs.writeFileSync(path.join(directory, 'restart-handoff.json'), JSON.stringify(h));
  return h;
}
test('exact existing profile + public wire survive an actually exited PID boundary', () => {
  sealed();
  expect(data.load(directory, { inputCreator: 'Shield' }).wire).toEqual(wire);
});
test('current PID and another running OS PID refuse', () => {
  expect(() => data.assertGone(process.pid)).toThrow();
  expect(() => data.assertGone(process.ppid)).toThrow();
});
test.each(['setupPID', 'profile', 'runID', 'inputCreator', 'drainedAndProfileReleased'])(
  'changed handoff %s refuses',
  (key) => {
    const h = sealed();
    h[key] =
      key === 'setupPID' ? process.pid : key === 'drainedAndProfileReleased' ? false : 'changed';
    fs.writeFileSync(path.join(directory, 'restart-handoff.json'), JSON.stringify(h));
    expect(() => data.load(directory, { inputCreator: 'Shield' })).toThrow();
  }
);
test.each([
  'wallet-railgun-accounts/account/store',
  'wallet-private-submissions/journal',
  'wallet-privacy-inventory.json',
  'identity/identity-vault.json',
  'identity/vault-meta.json',
])('changed %s refuses before restore', (name) => {
  sealed();
  fs.appendFileSync(path.join(directory, 'profile', name), 'mutation');
  expect(() => data.load(directory, { inputCreator: 'Shield' })).toThrow();
});
test('additional account file is not silently adopted', () => {
  sealed();
  fs.writeFileSync(path.join(directory, 'profile/wallet-railgun-accounts/new'), 'new');
  expect(() => data.load(directory, { inputCreator: 'Shield' })).toThrow();
});
test('missing store refuses, preserving displaced bytes', () => {
  sealed();
  fs.renameSync(
    path.join(directory, 'profile/wallet-railgun-accounts/account/store'),
    path.join(directory, 'displaced')
  );
  expect(() => data.load(directory, { inputCreator: 'Shield' })).toThrow();
});
test('altered public row or receipt fails even with stale saved manifest', () => {
  sealed();
  const v = copy(wire);
  v.receipt.blockHash = 'different';
  fs.writeFileSync(path.join(directory, 'restart-wire.json'), JSON.stringify(v));
  expect(() => data.load(directory, { inputCreator: 'Shield' })).toThrow();
});
test.each(['capsule', 'acceptance', 'viewingPrivateKey', 'continuation', 'acceptedBody'])(
  'extra private/capability field %s rejected',
  (key) => {
    wire[key] = {};
    expect(() => data.checkWire(wire)).toThrow();
  }
);
test('oversized, symlink, hardlink and directory input refused', () => {
  const f = path.join(directory, 'value');
  fs.writeFileSync(f, '{}');
  expect(() => data.readJson(f, 1)).toThrow();
  const link = path.join(directory, 'link');
  fs.symlinkSync(f, link);
  expect(() => data.readJson(link)).toThrow();
  const hard = path.join(directory, 'hard');
  fs.linkSync(f, hard);
  expect(() => data.readJson(hard)).toThrow();
  expect(() => data.readJson(directory)).toThrow();
});
test('unverified setup cannot seal a handoff', () => {
  report.connected.acceptance.verifierExits = 0;
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report));
  expect(() => data.seal(options)).toThrow();
  expect(fs.existsSync(path.join(directory, 'restart-handoff.json'))).toBe(false);
});
test('public wire is detached and unexpected history length refuses', () => {
  const value = data.checkWire(wire);
  value.transaction.hash = 'changed';
  expect(wire.transaction.hash).toBe('0x' + hash);
  wire.history.rows.push({ txid: hash });
  expect(() => data.checkWire(wire)).toThrow();
});
