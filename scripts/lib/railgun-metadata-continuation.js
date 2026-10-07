// One explicit operator continuation of the failed L-A metadata attempt.
// This is not a reusable campaign allocator. All files are local evidence;
// none of these checks contacts a service, unlocks a vault, or writes a ledger.
const path = require('path');
const { createHash } = require('crypto');
const { isDeepStrictEqual } = require('util');

const NAME = 'metadata-repair-1';
const FAILED_REPORT_SHA256 = 'd425fd977c56305a4ba1044804ab78b69edcf7ab5c6460482c054e14f9e0b8b0';
const FAILED_PROBE_SHA256 = '335bd2809ac5b4295d5e39b76a91514bc4d1471cf477efc681ef6bed0ecefd99';
const ORIGINAL_MANIFEST_SHA256 = '51165a2f58ab9c2777aaffe3172ddc9705bd2ed168ae817cc7660f9d1c3ad524';
const PREPARATION_REPORTS = Object.freeze({
  'rounds/round-1-prep/scan/report.json':
    '55d797adc340e7f014a03eb5ff8e1d61dc0be0a186c3f3e77587b4cf0db0e8b5',
  'remaining-rounds/round-1-prep/scan/report.json':
    'fe5955f24bf9435533fccb935d72b0928db07efe8807359dc046da2efa23e332',
});
const SHA256 = /^[a-f0-9]{64}$/;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const NOT_SENT = Object.freeze({
  attempted: false,
  journaled: false,
  submissionStatus: 'not-sent',
  resendAllowed: false,
});
function check(value) {
  if (!value)
    throw Object.assign(new Error('Metadata recovery continuation refused'), {
      code: 'RAILGUN_LIVE_JOURNEY_REFUSED',
      step: 'metadata-continuation',
    });
}
function read(fs, file, expected) {
  const stat = fs.lstatSync(file);
  check(stat.isFile() && stat.size <= 4 * 1024 * 1024);
  const bytes = fs.readFileSync(file);
  const digest = sha(bytes);
  check(expected === undefined || digest === expected);
  return { digest, value: JSON.parse(bytes.toString('utf8')) };
}

function continuationDirectory(base) {
  return path.join(base, 'tmp/privacy-research-oct7-l-a', NAME);
}

// The manifest is frozen by the operator before the first new probe. Its
// source commit must equal this run's clean source baseline, unless the one
// explicit transport-fix revision binds the preserved original manifest and
// both failed preparations. This never creates another recovery allowance.
function admitMetadataContinuation(ctx, originalHeader, readRecoveryLedger) {
  let stage = 'MANIFEST';
  try {
    check(ctx.args.continuation === NAME);
    const fs = ctx.fs;
    const campaign = continuationDirectory(ctx.base);
    check(fs.realpathSync(campaign) === campaign);
    const manifest = read(fs, path.join(campaign, 'continuation.json'));
    const m = manifest.value;
    check(m.name === NAME && m.profile === ctx.args.profile && m.profileId === ctx.profileId);
    check(/^[a-f0-9]{40}$/.test(m.sourceCommit));
    let sourceRevision;
    const revisionFile = path.join(campaign, 'tor-setup-source-revision.json');
    let revisionExists = false;
    try {
      fs.lstatSync(revisionFile);
      revisionExists = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (revisionExists) sourceRevision = read(fs, revisionFile);
    if (sourceRevision) {
      stage = 'SOURCE_REVISION';
      const r = sourceRevision.value;
      check(manifest.digest === ORIGINAL_MANIFEST_SHA256);
      check(
        isDeepStrictEqual(
          Object.keys(r).sort(),
          [
            'name',
            'originalManifestSha256',
            'preparationReports',
            'remainingRounds',
            'sourceCommit',
            'version',
          ].sort()
        )
      );
      check(r.name === 'tor-setup-1' && r.version === 1 && r.remainingRounds === 1);
      check(r.originalManifestSha256 === manifest.digest);
      check(/^[a-f0-9]{40}$/.test(r.sourceCommit));
      check(r.sourceCommit === ctx.sourceCommit && r.sourceCommit !== m.sourceCommit);
      check(isDeepStrictEqual(r.preparationReports, PREPARATION_REPORTS));
      for (const [name, digest] of Object.entries(PREPARATION_REPORTS))
        read(fs, path.join(campaign, name), digest);
    } else check(m.sourceCommit === ctx.sourceCommit);
    check(m.failedReportSha256 === FAILED_REPORT_SHA256);
    check(SHA256.test(m.previousLedgerSha256) && SHA256.test(m.repairReportSha256));

    stage = 'PREVIOUS_LEDGER';
    const directory = `${ctx.args.profile}.l-a-recovery-ledger`;
    check(fs.lstatSync(directory).isDirectory() && fs.realpathSync(directory) === directory);
    const original = path.join(directory, 'recover-submit.jsonl');
    const file = path.join(directory, `recover-submit.${NAME}.jsonl`);
    const names = fs.readdirSync(directory).sort();
    // Presence, even a torn continuation, consumes this allowance. No third
    // name, alternative output directory, or changed manifest can reset it.
    check(names.length === 1 && names[0] === 'recover-submit.jsonl');
    const old = readRecoveryLedger(fs, original, originalHeader);
    check(sha(fs.readFileSync(original)) === m.previousLedgerSha256);
    check(old.finished !== null && SHA256.test(old.finished.holdIdSha256));
    check(old.pending.binding.probeReportSha256 === FAILED_PROBE_SHA256);
    check(old.finished.outcome.submission === 'refused');
    check(isDeepStrictEqual(old.finished.outcome.spend, NOT_SENT));
    stage = 'PREVIOUS_REPORT';
    const failed = read(
      fs,
      path.join(campaign, 'previous-report.json'),
      FAILED_REPORT_SHA256
    ).value;
    check(failed.mode === 'recover-submit' && failed.passed === false);
    check(failed.submission?.stage === 'history' && failed.submission.status === 'refused');
    check(failed.reservation?.finished === true && isDeepStrictEqual(failed.spend, NOT_SENT));
    check(failed.chain?.heldTransfer?.reportSha256 === originalHeader.heldTransferReportSha256);
    check(failed.chain.heldTransfer.probeReportSha256 === FAILED_PROBE_SHA256);
    check(failed.owner === ctx.previous.owner);

    stage = 'FRESH_PROBE';
    check(SHA256.test(ctx.args.previousSha) && ctx.args.previousSha !== FAILED_PROBE_SHA256);
    check(Number.isSafeInteger(old.pending.binding.scanAnchor?.number));
    check(ctx.scan?.anchor?.number > old.pending.binding.scanAnchor.number);
    check(isDeepStrictEqual(ctx.previous.sourceSha256, ctx.report.sourceSha256));

    stage = 'REPAIR_REPORT';
    const repair = read(
      fs,
      path.join(campaign, 'metadata-report.json'),
      m.repairReportSha256
    ).value;
    check(repair.tool === 'railgun-submitter-metadata' && repair.version === 1);
    check(repair.result === 'created' && repair.profileId === ctx.profileId);
    check(repair.written === true && repair.verification === 'full-created-record');
    check(repair.readback === 'production-reader' && repair.otherEntriesUnchanged === true);
    check(repair.walletIndex === 0 && repair.type === 'mnemonic');
    check(repair.createdAtSource === 'existing-vault');
    check(SHA256.test(repair.metadataSha256));
    stage = 'METADATA';
    const metadata = path.join(ctx.args.profile, 'identity/vault-meta.json');
    check(fs.lstatSync(metadata).isFile());
    check(sha(fs.readFileSync(metadata)) === repair.metadataSha256);
    stage = 'REPAIR_SOURCES';
    for (const name of [
      'scripts/write-railgun-submitter-metadata.js',
      'scripts/lib/railgun-vault-meta.js',
    ]) {
      check(SHA256.test(repair.sourceSha256?.[name]));
      check(repair.sourceSha256[name] === ctx.report.sourceSha256[name]);
    }

    return {
      fsImpl: fs,
      file,
      header: {
        ...originalHeader,
        version: 2,
        continuation: NAME,
        previousLedgerSha256: m.previousLedgerSha256,
        previousReportSha256: FAILED_REPORT_SHA256,
        repairReportSha256: m.repairReportSha256,
        manifestSha256: manifest.digest,
        ...(sourceRevision ? { sourceRevisionSha256: sourceRevision.digest } : {}),
        holdIdSha256: old.finished.holdIdSha256,
      },
    };
  } catch {
    throw Object.assign(new Error('Metadata recovery continuation refused'), {
      code: `RAILGUN_METADATA_CONTINUATION_${stage}`,
      step: 'metadata-continuation',
    });
  }
}

module.exports = {
  NAME,
  FAILED_REPORT_SHA256,
  FAILED_PROBE_SHA256,
  ORIGINAL_MANIFEST_SHA256,
  PREPARATION_REPORTS,
  continuationDirectory,
  admitMetadataContinuation,
};
