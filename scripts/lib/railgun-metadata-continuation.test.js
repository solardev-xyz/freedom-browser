const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const api = require('./railgun-metadata-continuation');
const qualifier = require('../qualify-railgun-private-live');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const notSent = {
  attempted: false,
  journaled: false,
  submissionStatus: 'not-sent',
  resendAllowed: false,
};
const owner = '0x' + '12'.repeat(20);
let base, ctx, m, campaign, directory, original, header, manifest, metadata;
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
const denied = () =>
  expect(() => m.admitMetadataContinuation(ctx, header, qualifier.readRecoveryLedger)).toThrow(
    'Metadata recovery continuation refused'
  );

function sourceRevision() {
  const originalManifestSha256 = sha(fs.readFileSync(path.join(campaign, 'continuation.json')));
  let source = fs
    .readFileSync(require.resolve('./railgun-metadata-continuation'), 'utf8')
    .replace(api.FAILED_REPORT_SHA256, manifest.failedReportSha256)
    .replace(api.ORIGINAL_MANIFEST_SHA256, originalManifestSha256);
  const preparationReports = {};
  for (const [name, digest] of Object.entries(api.PREPARATION_REPORTS)) {
    const file = path.join(campaign, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    json(file, { passed: false, fixture: name });
    preparationReports[name] = sha(fs.readFileSync(file));
    source = source.replace(digest, preparationReports[name]);
  }
  // Test-only historical evidence pins; there is no production override.
  const compiled = { exports: {} };
  new Function('require', 'module', 'exports', source)(require, compiled, compiled.exports);
  m = compiled.exports;
  ctx.sourceCommit = 'b'.repeat(40);
  const revision = {
    version: 1,
    name: 'tor-setup-1',
    originalManifestSha256,
    preparationReports,
    sourceCommit: ctx.sourceCommit,
    remainingRounds: 1,
  };
  const file = path.join(campaign, 'tor-setup-source-revision.json');
  json(file, revision);
  return { file, revision };
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'metadata-continuation-')));
  const profile = path.join(base, 'profile');
  fs.mkdirSync(path.join(profile, 'identity'), { recursive: true });
  directory = `${profile}.l-a-recovery-ledger`;
  fs.mkdirSync(directory);
  original = path.join(directory, 'recover-submit.jsonl');
  header = {
    type: 'railgun-l-a-recovery-ledger',
    version: 1,
    journey: qualifier.JOURNEY,
    chainId: 11155111,
    mode: 'recover-submit',
    budget: 1,
    profile,
    profileId: 'test-profile',
    heldTransferReportSha256: qualifier.HELD_TRANSFER_REPORT_SHA256,
  };
  const pending = {
    type: 'attempt-pending',
    attempt: 1,
    attemptId: 'original',
    binding: {
      heldTransferReportSha256: header.heldTransferReportSha256,
      probeReportSha256: api.FAILED_PROBE_SHA256,
      scanAnchor: { number: 11863789 },
    },
  };
  const finished = {
    type: 'attempt-finished',
    attemptId: 'original',
    holdIdSha256: sha('held'),
    outcome: { submission: 'refused', spend: notSent },
  };
  fs.writeFileSync(original, [header, pending, finished].map(JSON.stringify).join('\n') + '\n');
  campaign = api.continuationDirectory(base);
  fs.mkdirSync(campaign, { recursive: true });
  const failed = {
    mode: 'recover-submit',
    owner,
    passed: false,
    submission: { stage: 'history', status: 'refused' },
    reservation: { finished: true },
    spend: notSent,
    chain: {
      heldTransfer: {
        reportSha256: header.heldTransferReportSha256,
        probeReportSha256: api.FAILED_PROBE_SHA256,
      },
    },
  };
  const failedBytes = JSON.stringify(failed);
  fs.writeFileSync(path.join(campaign, 'previous-report.json'), failedBytes);
  // Replace only the historical report digest with a synthetic report's digest.
  // Production exposes no pin override and imports the fixed original module.
  const filename = require.resolve('./railgun-metadata-continuation');
  const compiled = { exports: {} };
  new Function(
    'require',
    'module',
    'exports',
    fs.readFileSync(filename, 'utf8').replace(api.FAILED_REPORT_SHA256, sha(failedBytes))
  )(require, compiled, compiled.exports);
  m = compiled.exports;
  metadata = path.join(profile, 'identity/vault-meta.json');
  fs.writeFileSync(metadata, 'synthetic public metadata');
  const sources = {
    'scripts/write-railgun-submitter-metadata.js': sha('writer'),
    'scripts/lib/railgun-vault-meta.js': sha('builder'),
    'scripts/qualify-railgun-private-live.js': sha('qualifier'),
  };
  const repair = {
    tool: 'railgun-submitter-metadata',
    version: 1,
    result: 'created',
    written: true,
    verification: 'full-created-record',
    profileId: 'test-profile',
    readback: 'production-reader',
    otherEntriesUnchanged: true,
    walletIndex: 0,
    type: 'mnemonic',
    createdAtSource: 'existing-vault',
    metadataSha256: sha(fs.readFileSync(metadata)),
    sourceSha256: sources,
  };
  json(path.join(campaign, 'metadata-report.json'), repair);
  manifest = {
    name: api.NAME,
    profile,
    profileId: 'test-profile',
    sourceCommit: 'a'.repeat(40),
    failedReportSha256: sha(failedBytes),
    previousLedgerSha256: sha(fs.readFileSync(original)),
    repairReportSha256: sha(JSON.stringify(repair)),
  };
  json(path.join(campaign, 'continuation.json'), manifest);
  ctx = {
    base,
    fs,
    args: { continuation: api.NAME, profile, previousSha: sha('new-probe') },
    profileId: 'test-profile',
    sourceCommit: manifest.sourceCommit,
    previous: { owner, sourceSha256: { ...sources } },
    scan: { anchor: { number: 11864000 } },
    report: { sourceSha256: sources },
  };
});
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

test('admits only the fixed repaired continuation, preserving the original ledger', () => {
  const before = fs.readFileSync(original);
  const admitted = m.admitMetadataContinuation(ctx, header, qualifier.readRecoveryLedger);
  expect(admitted.file).toBe(path.join(directory, 'recover-submit.metadata-repair-1.jsonl'));
  expect(admitted.header).toMatchObject({
    version: 2,
    continuation: api.NAME,
    previousLedgerSha256: sha(before),
    holdIdSha256: sha('held'),
  });
  expect(fs.readFileSync(original)).toEqual(before);
  expect(fs.readdirSync(directory)).toEqual(['recover-submit.jsonl']);
  expect(api.FAILED_REPORT_SHA256).toBe(
    'd425fd977c56305a4ba1044804ab78b69edcf7ab5c6460482c054e14f9e0b8b0'
  );
});

test.each(['pending', 'finished', 'torn'])(
  'an existing %s continuation consumes the allowance',
  (state) => {
    fs.writeFileSync(path.join(directory, 'recover-submit.metadata-repair-1.jsonl'), state);
    denied();
  }
);
test.each([
  'name',
  'profile',
  'profileId',
  'sourceCommit',
  'failedReportSha256',
  'previousLedgerSha256',
  'repairReportSha256',
])('a changed manifest %s is refused', (key) => {
  manifest[key] = 'changed';
  json(path.join(campaign, 'continuation.json'), manifest);
  denied();
});
test('missing, changed, pending or journaled original evidence is refused', () => {
  const originalBytes = fs.readFileSync(original);
  for (const change of [
    (r) => r.pop(),
    (r) => {
      r[2].outcome.spend = { ...notSent, attempted: true };
    },
    (r) => {
      r[2].holdIdSha256 = null;
    },
    (r) => {
      r[1].binding.probeReportSha256 = sha('another-probe');
    },
  ]) {
    const records = originalBytes.toString().trim().split('\n').map(JSON.parse);
    change(records);
    fs.writeFileSync(original, records.map(JSON.stringify).join('\n') + '\n');
    manifest.previousLedgerSha256 = sha(fs.readFileSync(original));
    json(path.join(campaign, 'continuation.json'), manifest);
    denied();
  }
  fs.renameSync(original, original + '.retained');
  denied();
});
test('changed metadata, repair source, or original report refuses', () => {
  fs.writeFileSync(metadata, 'changed');
  denied();
  fs.writeFileSync(metadata, 'synthetic public metadata');
  const name = 'scripts/write-railgun-submitter-metadata.js';
  const originalHash = ctx.report.sourceSha256[name];
  ctx.report.sourceSha256[name] = sha('changed');
  denied();
  ctx.report.sourceSha256[name] = originalHash;
  fs.appendFileSync(path.join(campaign, 'previous-report.json'), '\n');
  denied();
});

test('the consumed probe, an old scan, or mismatched probe sources refuse', () => {
  const fresh = ctx.args.previousSha;
  ctx.args.previousSha = api.FAILED_PROBE_SHA256;
  denied();
  ctx.args.previousSha = fresh;
  ctx.scan.anchor.number = 11863789;
  denied();
  ctx.scan.anchor.number = 11864000;
  ctx.previous.sourceSha256['scripts/qualify-railgun-private-live.js'] = sha('old source');
  denied();
});
test('another campaign or symlinked original is refused', () => {
  ctx.args.continuation = 'metadata-repair-2';
  denied();
  ctx.args.continuation = api.NAME;
  const target = path.join(base, 'original-copy');
  fs.renameSync(original, target);
  fs.symlinkSync(target, original);
  denied();
});

test.each(['original', 'revised'])(
  'the real qualifier reserves the %s continuation once and preserves its predecessor',
  (version) => {
    const revision = version === 'revised' ? sourceRevision() : undefined;
    const probe = sha('fresh probe');
    const scan = sha('fresh scan');
    Object.assign(ctx.args, {
      previousSha: probe,
      scanSha: scan,
      output: path.join(campaign, 'recover-submit-' + probe),
      previousFile: 'synthetic-probe',
    });
    ctx.chain = {
      heldTransfer: {
        reportSha256: qualifier.HELD_TRANSFER_REPORT_SHA256,
        probeReportSha256: probe,
      },
    };
    Object.assign(ctx.previous, { observedAt: new Date().toISOString(), scan: { sha256: scan } });
    ctx.scan = { anchor: { number: 11864000, hash: '0x' + 'ab'.repeat(32) } };
    const previousBytes = fs.readFileSync(original);
    const spy = jest
      .spyOn(api, 'admitMetadataContinuation')
      .mockImplementation(m.admitMetadataContinuation);
    try {
      expect(qualifier.assertRecoveryAdmissible(ctx)).toBeUndefined();
      const reservation = qualifier.reserveRecoveryAttempt(ctx);
      expect(reservation.header.continuation).toBe(api.NAME);
      if (revision)
        expect(reservation.header.sourceRevisionSha256).toBe(sha(fs.readFileSync(revision.file)));
      expect(ctx.continuationHoldIdSha256).toBe(sha('held'));
      expect(fs.readFileSync(original)).toEqual(previousBytes);
      const pending = qualifier.readRecoveryLedger(fs, reservation.file, reservation.header);
      expect(pending.finished).toBeNull();
      expect(pending.pending.binding.sourceCommit).toBe(ctx.sourceCommit);
      expect(() => qualifier.reserveRecoveryAttempt(ctx)).toThrow();
      expect(() => qualifier.assertRecoveryAdmissible(ctx)).toThrow();
    } finally {
      spy.mockRestore();
    }
  }
);

test('the revision preserves the original manifest and cannot select the old or another source', () => {
  const before = fs.readFileSync(path.join(campaign, 'continuation.json'));
  const { file } = sourceRevision();
  const admitted = m.admitMetadataContinuation(ctx, header, qualifier.readRecoveryLedger);
  expect(admitted.header.manifestSha256).toBe(sha(before));
  expect(admitted.header.sourceRevisionSha256).toBe(sha(fs.readFileSync(file)));
  expect(admitted.file).toBe(path.join(directory, 'recover-submit.metadata-repair-1.jsonl'));
  expect(fs.readFileSync(path.join(campaign, 'continuation.json'))).toEqual(before);
  ctx.sourceCommit = manifest.sourceCommit;
  denied();
  ctx.sourceCommit = 'c'.repeat(40);
  denied();
});

test.each([
  'version',
  'name',
  'originalManifestSha256',
  'preparationReports',
  'sourceCommit',
  'remainingRounds',
  'extra',
])('a changed revision %s refuses without reserving anything', (key) => {
  const { file, revision } = sourceRevision();
  revision[key] = 'changed';
  json(file, revision);
  denied();
  expect(fs.readdirSync(directory)).toEqual(['recover-submit.jsonl']);
});

test.each(Object.keys(api.PREPARATION_REPORTS))(
  'changed preserved preparation %s refuses',
  (name) => {
    sourceRevision();
    fs.appendFileSync(path.join(campaign, name), '\n');
    denied();
  }
);

test.each(['torn', 'symlink', 'missing'])('a %s revision refuses the new source', (state) => {
  const { file } = sourceRevision();
  if (state === 'torn') fs.writeFileSync(file, '{');
  else {
    fs.renameSync(file, file + '.retained');
    if (state === 'symlink') fs.symlinkSync(file + '.absent', file);
  }
  denied();
});

test('rewriting the original manifest cannot authorize the revision', () => {
  sourceRevision();
  manifest.sourceCommit = ctx.sourceCommit;
  json(path.join(campaign, 'continuation.json'), manifest);
  denied();
});

test('CLI accepts only the explicit fixed continuation for recover-submit', () => {
  const probe = sha('probe');
  const argv = [
    'recover-submit',
    '/engine',
    '/prover',
    '/artifacts',
    '/profile',
    '/scan',
    sha('scan'),
    '/evidence/probe/report.json',
    probe,
    '/evidence/recover-submit-' + probe,
  ];
  expect(qualifier.parseArguments([...argv, api.NAME]).continuation).toBe(api.NAME);
  expect(() => qualifier.parseArguments([...argv, 'campaign-3'])).toThrow();
  expect(() => qualifier.parseArguments(['transfer', ...argv.slice(1), api.NAME])).toThrow();
});
