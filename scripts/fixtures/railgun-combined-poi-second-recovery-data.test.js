// Fixture hashes are equality checks, never production issuer evidence.
jest.mock('./railgun-native-assertions', () => ({
  assert: require('assert/strict'),
}));
const fs = require('fs'),
  os = require('os'),
  path = require('path');
const { spawnSync } = require('child_process');
const data = require('./railgun-combined-poi-restart-data');
const h = require('./railgun-combined-poi-second-recovery-data');
const proved = require('./railgun-combined-poi-second-handoff');
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
        preparation: {
          expected: { changeCommitment: 'change' },
          changeAmount: '600',
        },
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

beforeEach(() => {
  second.stored.provedTransaction = null;
});
test('only original signed second and null slot can be sealed, no private data', () => {
  const value = h.signedHashes(first, second, record);
  expect(value.second.provedTransaction).toBeNull();
  expect(JSON.stringify(value)).not.toContain('original-second-signature');
  expect(JSON.stringify(value)).not.toContain('change');
});
test.each([
  'samehold',
  'sameNullifier',
  'firstProof',
  'secondProof',
  'signature',
  'amount',
  'recipient',
  'kind',
  'note',
])('signed boundary rejects %s', (fault) => {
  if (fault === 'samehold') second.entry.id = first.entry.id;
  if (fault === 'sameNullifier') second.entry.facts.nullifier = first.entry.facts.nullifier;
  if (fault === 'firstProof') first.stored.provedTransaction = null;
  if (fault === 'secondProof') second.stored.provedTransaction = { present: true };
  if (fault === 'signature') second.stored.signature = null;
  if (fault === 'amount') second.stored.capsule.preparation.expected.amount = '599';
  if (fault === 'recipient') second.stored.capsule.selection.recipient = 'other';
  if (fault === 'kind') second.stored.capsule.selection.kind = 'railgun-private-transfer';
  if (fault === 'note') second.stored.capsule.noteHash = 'other';
  expect(() => h.signedHashes(first, second, record)).toThrow();
});
test('unfinished reader requires exact genuine receipt routing and all saved hashes', async () => {
  const expected = h.signedHashes(first, second, record),
    a = {},
    b = {};
  const capsules = {
    readSigned: jest.fn(async (r) => {
      expect(r).toBe(a);
      return first.stored;
    }),
    readSignedUnfinished: jest.fn(async (r) => {
      expect(r).toBe(b);
      return second.stored;
    }),
  };
  const enrollment = {
    openPrivateRecoveryStores: async () => ({
      capsules,
      reservations: {
        withSigningRecovery: async (fn) =>
          fn(
            [
              { entry: second.entry, receipt: b },
              { entry: first.entry, receipt: a },
            ],
            { assertCurrent() {} }
          ),
      },
    }),
  };
  const value = await h.readUnfinishedPair(enrollment, expected);
  expect(value).toEqual({ first, second });
  second.stored.signature = ['changed'];
  expect(value.second.stored.signature).toEqual(['original-second-signature']);
  await expect(h.readUnfinishedPair(enrollment, expected)).rejects.toThrow();
});
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'second-c-recovery-handoff-'));
  for (const file of [
    'wallet-railgun-accounts/a/store',
    'wallet-private-submissions/a',
    'wallet-privacy-inventory.json',
    'identity/identity-vault.json',
    'identity/vault-meta.json',
  ]) {
    const p = path.join(directory, 'profile', file);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      file === 'identity/vault-meta.json'
        ? JSON.stringify({
            userKnowsPassword: true,
            addresses: { userWallet: '0x' + '1'.repeat(40) },
            derivedWallets: [
              {
                index: 0,
                name: 'Offline public vector',
                type: 'mnemonic',
                address: '0x' + '1'.repeat(40),
              },
            ],
          })
        : 'cipher-' + file
    );
  }
  const dead = () => spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
  const setupPID = dead(),
    signPID = dead(),
    recoverPID = dead(),
    hex = '1'.repeat(64);
  const records = h.signedHashes(first, second, record),
    state = { count: 1, root: hex };
  const wire = {
    schema: 'railgun-combined-change-public-wire-v1',
    inputCreator: 'Shield',
    transaction: { hash: '0x' + hex, from: 'owner', blockHash: 'anchor' },
    receipt: {
      transactionHash: '0x' + hex,
      from: 'owner',
      blockHash: 'anchor',
    },
    history: {
      rows: [{ txid: hex }],
      state,
      checkpoints: [state],
      finalized: 1,
    },
    publicIdentity: {},
    checkpoint: {},
    retained: {
      capsuleDigest: hex,
      entrySha256: hex,
      inspect: { reservedTransitions: 2 },
    },
    privateHashes: { ...records.first, record: records.record },
    acceptedBodySha256: hex,
    list: {},
  };
  delete wire.privateHashes.holdId;
  const write = (name, v) => fs.writeFileSync(path.join(directory, name), JSON.stringify(v));
  const digestFile = (name) => data.sha(fs.readFileSync(path.join(directory, name)));
  write('restart-wire.json', wire);
  write('report.json', { setup: true });
  const common = {
    runID: '12345678-1234-1234-1234-123456789abc',
    setupPID,
    inputCreator: 'Shield',
    profile: path.join(directory, 'profile'),
    sourceHashes: { source: hex },
    runtimes: { engine: hex },
    sourceSha256: hex,
    publicWireSha256: data.digest(wire),
    setupReportSha256: digestFile('report.json'),
  };
  write('restart-handoff.json', { ...common, files: data.profileSnapshot(directory) });
  const report = {
    runID: common.runID,
    signPID,
    secondSignStopQualified: true,
    secondRecoveryStopQualified: false,
    secondColdSubmitQualified: false,
  };
  write('second-sign-report.json', report);
  const signed = {
    ...common,
    schema: 'railgun-combined-second-recovery-v1',
    stage: 'signed-unfinished',
    signPID,
    recoverPID: null,
    predecessorSha256: digestFile('restart-handoff.json'),
    reportSha256: digestFile('second-sign-report.json'),
    files: data.profileSnapshot(directory),
    records,
    retained: { entrySha256: hex, inspectSha256: hex },
    drainedAndProfileReleased: true,
  };
  write('second-signed-handoff.json', signed);
  second.stored.provedTransaction = { data: 'new-proof-original-signature' };
  const recovered = {
    ...signed,
    stage: 'proof-stored',
    recoverPID,
    records: proved.pairHashes(first, second, record),
    predecessorSha256: digestFile('second-signed-handoff.json'),
  };
  write('second-recover-report.json', {
    runID: common.runID,
    signPID,
    recoverPID,
    secondSignStopQualified: false,
    secondRecoveryStopQualified: true,
    secondColdSubmitQualified: false,
  });
  recovered.reportSha256 = digestFile('second-recover-report.json');
  write('second-recovered-handoff.json', recovered);
  return { directory, write, signed, recovered };
}
test('distinct process chains carry only unchanged original signature and changed proof slot', () => {
  const { directory } = fixture();
  expect(h.loadSigned(directory, { inputCreator: 'Shield' }).handoff.stage).toBe(
    'signed-unfinished'
  );
  expect(h.loadRecovered(directory, { inputCreator: 'Shield' }).handoff.stage).toBe('proof-stored');
});
test.each([
  'signature',
  'first',
  'record',
  'pid',
  'vault',
  'predecessor',
  'report',
  'body',
  'stage',
  'unfinished',
])('cold recovered load rejects %s drift without rewriting files', (fault) => {
  const { directory, write, recovered, signed } = fixture();
  if (fault === 'signature') recovered.records.second.signature = 'f'.repeat(64);
  if (fault === 'first') recovered.records.first.stored = 'f'.repeat(64);
  if (fault === 'record') recovered.records.record = 'f'.repeat(64);
  if (fault === 'pid') recovered.recoverPID = process.pid;
  if (fault === 'stage') recovered.stage = 'signed-unfinished';
  if (fault === 'unfinished') recovered.records.second.provedTransaction = null;
  if (fault === 'vault')
    fs.appendFileSync(path.join(directory, 'profile/identity/identity-vault.json'), 'changed');
  if (fault === 'predecessor')
    write('second-signed-handoff.json', {
      ...signed,
      drainedAndProfileReleased: false,
    });
  if (fault === 'report') write('second-recover-report.json', { different: true });
  if (fault === 'body') write('restart-wire.json', { different: true });
  write('second-recovered-handoff.json', recovered);
  const before = fs.readFileSync(path.join(directory, 'second-recovered-handoff.json'));
  expect(() => h.loadRecovered(directory, { inputCreator: 'Shield' })).toThrow();
  expect(fs.readFileSync(path.join(directory, 'second-recovered-handoff.json'))).toEqual(before);
});
test('seal requires successful report and drained predecessor before creating any boundary', () => {
  const { directory, signed } = fixture();
  const target = path.join(directory, 'fresh');
  fs.mkdirSync(target);
  const report = {
    runID: signed.runID,
    signPID: process.pid,
    secondSignStopQualified: false,
    secondRecoveryStopQualified: false,
    secondColdSubmitQualified: false,
  };
  expect(() =>
    h.sealSigned({
      directory: target,
      predecessor: signed,
      report,
      records: signed.records,
      retained: signed.retained,
    })
  ).toThrow();
  expect(fs.existsSync(path.join(target, 'second-signed-handoff.json'))).toBe(false);
});

// No native issuer is modeled by these public bytes; the fixtures exercise file/chain equality.
test.each(['signed', 'recovered'])(
  '%s boundary retains both metadata and encrypted vault hashes',
  (stage) => {
    const { directory, signed, recovered } = fixture();
    const value = stage === 'signed' ? signed : recovered;
    const snapshot = data.profileSnapshot(directory);
    expect(value.files.publicVaultMetadata).toBe(snapshot.publicVaultMetadata);
    expect(value.files.encryptedVault).toBe(snapshot.encryptedVault);
    expect(value.files.publicVaultMetadata).not.toBe(value.files.encryptedVault);
    expect(() =>
      (stage === 'signed' ? h.loadSigned : h.loadRecovered)(directory, { inputCreator: 'Shield' })
    ).not.toThrow();
  }
);
test.each(
  ['signed', 'recovered'].flatMap((stage) => ['missing', 'changed'].map((fault) => [stage, fault]))
)('%s resume refuses %s public metadata without repair or manifest writes', (stage, fault) => {
  const { directory } = fixture();
  const filename = path.join(directory, 'profile/identity/vault-meta.json');
  if (fault === 'missing')
    fs.renameSync(filename, path.join(directory, 'displaced-public-metadata.json'));
  else fs.appendFileSync(filename, 'changed');
  const before = fault === 'changed' ? fs.readFileSync(filename) : null;
  const writer = jest.spyOn(fs, 'writeFileSync');
  try {
    expect(() =>
      (stage === 'signed' ? h.loadSigned : h.loadRecovered)(directory, { inputCreator: 'Shield' })
    ).toThrow();
    expect(writer).not.toHaveBeenCalled();
    expect(fs.existsSync(filename)).toBe(fault !== 'missing');
    if (before) expect(fs.readFileSync(filename)).toEqual(before);
  } finally {
    writer.mockRestore();
  }
});
test.each(
  ['signed', 'recovered'].flatMap((stage) => [false, true].map((changed) => [stage, changed]))
)('%s seal preserves metadata (changed=%s)', (stage, changed) => {
  const { directory, signed, recovered } = fixture();
  const predecessor =
    stage === 'signed' ? data.readJson(path.join(directory, 'restart-handoff.json')) : signed;
  const target = path.join(directory, 'seal-target');
  fs.mkdirSync(target);
  fs.cpSync(path.join(directory, 'profile'), path.join(target, 'profile'), { recursive: true });
  const signedStage = stage === 'signed';
  const priorName = signedStage ? 'restart-handoff.json' : 'second-signed-handoff.json';
  const reportName = signedStage ? 'second-sign-report.json' : 'second-recover-report.json';
  const handoffName = signedStage ? 'second-signed-handoff.json' : 'second-recovered-handoff.json';
  fs.writeFileSync(path.join(target, priorName), JSON.stringify(predecessor));
  const report = {
    runID: signed.runID,
    [signedStage ? 'signPID' : 'recoverPID']: process.pid,
    secondSignStopQualified: signedStage,
    secondRecoveryStopQualified: !signedStage,
    secondColdSubmitQualified: false,
  };
  fs.writeFileSync(path.join(target, reportName), JSON.stringify(report));
  if (changed) fs.appendFileSync(path.join(target, 'profile/identity/vault-meta.json'), 'changed');
  const seal = () =>
    (signedStage ? h.sealSigned : h.sealRecovered)({
      directory: target,
      predecessor,
      report,
      records: (signedStage ? signed : recovered).records,
      retained: signed.retained,
    });
  if (changed) expect(seal).toThrow();
  else {
    const value = seal();
    expect(value.files.publicVaultMetadata).toBe(predecessor.files.publicVaultMetadata);
    expect(value.files.encryptedVault).toBe(predecessor.files.encryptedVault);
  }
  expect(fs.existsSync(path.join(target, handoffName))).toBe(!changed);
});
test.each(['signed', 'recovered'])(
  '%s load rejects predecessor metadata drift even with recomputed file hashes',
  (stage) => {
    const { directory, write, signed, recovered } = fixture();
    if (stage === 'signed') {
      const initial = data.readJson(path.join(directory, 'restart-handoff.json'));
      initial.files.publicVaultMetadata = 'f'.repeat(64);
      write('restart-handoff.json', initial);
      signed.predecessorSha256 = data.sha(
        fs.readFileSync(path.join(directory, 'restart-handoff.json'))
      );
      write('second-signed-handoff.json', signed);
    } else {
      recovered.files.publicVaultMetadata = 'f'.repeat(64);
      // Isolate predecessor continuity from final current-file comparison.
      write('second-recovered-handoff.json', recovered);
    }
    const snapshot = jest
      .spyOn(data, 'profileSnapshot')
      .mockReturnValue(stage === 'signed' ? signed.files : recovered.files);
    try {
      expect(() =>
        (stage === 'signed' ? h.loadSigned : h.loadRecovered)(directory, { inputCreator: 'Shield' })
      ).toThrow();
    } finally {
      snapshot.mockRestore();
    }
  }
);
