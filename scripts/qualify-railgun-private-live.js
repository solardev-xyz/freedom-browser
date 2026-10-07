/** Bounded live L-A journey (steps 3-7) for the existing POI-Valid Shield note of
 * the funded disposable Sepolia profile, on the enrolled-EOA direct path:
 * full-value self-transfer, post-transaction POI, cold recovery, output POI
 * status and full unshield to the enrolled EOA. One mode per process. Every
 * mode pins the previous step's report and a completed, source-matched scan
 * report by sha256 and refuses changed sources or runtimes. Each spend mode
 * makes at most one journaled send; an uncertain send is observation-only.
 * Reports are aggregate-only: never keys, notes, nullifiers, proofs or payloads.
 * FREEDOM_WALLET_TOR_EXPERIMENT=1 electron scripts/qualify-railgun-private-live.js \
 *   MODE ENGINE_ASAR PROVER_ASAR ARTIFACT_DIRECTORY PROFILE \
 *   SCAN_REPORT SCAN_SHA256 PREVIOUS_REPORT PREVIOUS_SHA256 NEW_OUTPUT
 * MODE: check-transfer|transfer|observe|poi-submit|recover|status|check-unshield|unshield|
 *   spent-read|preflight-probe|recover-submit
 * check-transfer takes the owned-POI report of qualify-railgun-owned-poi-live.js.
 * spent-read and preflight-probe take the held transfer report pinned below and a
 * newer scan on the current sources; recover-submit takes a passed probe report.
 *
 * Held-transfer recovery (each mode separately authorized):
 * - spent-read: the held Shield input's spent marker through the scan anchor
 *   only, with the read time.
 * - preflight-probe: one production private preflight for the held input, with
 *   no account wallet, proof, EOA request, calldata, signing or broadcast. Its
 *   passed means the probe completed; result says whether the preflight passed,
 *   and scope lists what the probe does not qualify.
 * - recover-submit: the production recovered submission of the held proof,
 *   reusing its original spending signature; at most one journaled send. One
 *   allowance per canonical profile campaign, bound to the one pinned held
 *   report: not a reusable facility for an arbitrary hold. The profile's
 *   campaign directory PROFILE.l-a-recovery-ledger holds at most its one
 *   allowance file, recover-submit.jsonl, named by no report digest. Before
 *   unlock and Tor the mode refuses a spent or damaged campaign; before any
 *   account, POI, nullifier or EOA work it reserves the allowance durably. Any
 *   existing allowance or other campaign entry refuses, whatever its probe,
 *   output, held report digest or outcome, and consumption fails closed: an
 *   interrupted attempt stays pending and consumes the budget until diagnosed.
 *   Deleting the campaign directory or moving the profile resets the budget;
 *   it is no anti-tampering control. NEW_OUTPUT is also
 *   recover-submit-<probe sha256> beside the probe's output directory, and the
 *   probe is at most 30 minutes old.
 *
 * Publication: only NEW_OUTPUT/report.json is publishable. NEW_OUTPUT/transport/
 * holds the Arti state and arti.log and stays local.
 *
 * Stuck states (report.liveness). Each needs a separately authorized recovery step:
 * - proved-unsent: a refusal after proving (fee cap, completion expiry,
 *   preflight) leaves the input held in signing state. Any later spend of it
 *   is refused with RAILGUN_PRIVATE_INPUT_RESERVED. Only the pinned held
 *   transfer continues, through preflight-probe and then recover-submit.
 * - journaled-uncertain: a journaled attempt whose send is unknown. If its
 *   deadline expired between the journal write and the broadcast, it was never
 *   sent, and observe cannot resolve it.
 * D2 never proves service acceptance. The status mode (D3) is the acceptance gate.
 */
const fs = require('fs'),
  path = require('path');
const { createHash, randomBytes } = require('crypto');
const { isDeepStrictEqual } = require('util');
const pins = require('../src/main/wallet/railgun-shield-pins.json');

const JOURNEY = 'railgun-private-live-l-a-v1';
const CHAIN_ID = 11155111;
const REQUIRED_LIST = 'efc6ddb59c098a13fb2b618fdae94c1c3a807abc8fb1837c93620c9143ee9e88';
const POI_ORIGIN = 'https://ppoi.fdi.network';
const RPC_URL = 'https://sepolia.rpc.sentio.xyz';
// Authorized exposure: gasLimit x (maxFeePerGas or gasPrice), checked before signing.
const FEE_CAP_WEI = 2000000000000000n;
// The production submission ceiling. A ceiling, not a target.
const GAS_LIMIT_CEILING = 3000000n;
// gasLimit = ceil(estimate x 5/4).
const GAS_HEADROOM = Object.freeze({ numerator: 5n, denominator: 4n });
const GAS_HEADROOM_REASON =
  'The live shield estimate moved 0.6% between runs (877,565 to 882,668 gas) and ran ' +
  'with the same 25% margin. Production refuses an estimate above gasLimit, and the ' +
  'one-attempt rule forbids a resend after an out-of-gas revert. Unused gas is not ' +
  'charged, so the margin raises authorized exposure, not the fee paid.';
// Conservative pre-proof bound: refuse before any POI query, signing hold or key
// use when even this limit would exceed the cap. Never the submitted limit.
const PLANNING_GAS_LIMIT = 1500000n;
const MIN_CONFIRMATIONS = 12;
// Production owners drain their own work on close. A drain that outlives this
// bound is reported as a failure so the report is still written.
const DRAIN_MS = 300000;
const MAX_AMOUNT = BigInt(pins.maxQualificationAmount);
const MODES = Object.freeze([
  'check-transfer',
  'transfer',
  'observe',
  'poi-submit',
  'recover',
  'status',
  'check-unshield',
  'unshield',
  'spent-read',
  'preflight-probe',
  'recover-submit',
]);
// The held transfer (L-A step 3b): proved, refused at the production preflight
// before any review, never journaled. The recovery modes bind to this report only:
// another rendering of the same hold has another digest and is refused before
// any profile access. It is the operator's original report, never re-pinned.
const HELD_TRANSFER_REPORT_SHA256 =
  'd0d05c02c9303205f34382652737613932649a2bf4ecadd134cc8fc46489348c';
// Modes that follow that report from an older source baseline: sources are pinned
// to a newer scan instead, and the runtime to the held proof's engine and circuits.
const REBASED_MODES = Object.freeze(['spent-read', 'preflight-probe']);
// Production bounds of the recovered submission (railgun-private-submission.js).
const RECOVERY_TIMEOUT_MS = 600000;
const PREFLIGHT_MS = 20000;
const PROBE_PHASE_MS = 60000;
const READ_PHASE_MS = 15000;
// How long a passed probe admits its one recover-submit. Production re-reads
// every chain fact under its own 60 s clocks, so a probe is never admission
// evidence: this bound only keeps the probe and the submission in one session,
// on one scan, while the probe still describes current conditions.
const PROBE_MAX_AGE_MS = 30 * 60 * 1000;
// What a preflight-probe report qualifies. Its top-level passed means only that
// the probe completed; result alone says whether the preflight passed.
const PROBE_SCOPE = Object.freeze({
  qualifies: 'private-preflight-stage-only',
  passedMeans: 'probe-completed',
  notQualified: Object.freeze([
    'wallet-note-binding',
    'poi-status',
    'proof-recheck',
    'eoa-steps',
    'recovered-submission-timing',
  ]),
});
// The reviewed disclosure summary of the recovered submission, exactly. Any
// production change to it refuses at the disclosure review until reviewed here.
const RECOVERY_EXPOSURES = Object.freeze({
  source: Object.freeze([
    'lazy-chain-id-check',
    'public-proxy-logs',
    'canonical-blocks',
    'retained-range-and-timing',
  ]),
  poi: Object.freeze([
    'selected-blinded-commitment',
    'commitment-type',
    'required-list',
    'membership-roots',
    'membership-position-and-signed-event',
  ]),
  txidIfTransact: Object.freeze([
    'latest-txid',
    'checkpoint-tree-index-root',
    'creating-transaction-source-binding',
  ]),
  privatePreflight: Object.freeze([
    'lazy-chain-id-check',
    'deployment-code-and-storage',
    'verification-key',
    'unshield-fee',
    'original-input-tree',
    'original-merkle-root',
    'selected-nullifier',
    'root-history',
    'unspent-check',
  ]),
  transactionRpc: Object.freeze([
    'lazy-chain-id-check',
    'public-submitter',
    'code',
    'nonce',
    'balance',
    'fee-estimates',
    'original-proved-calldata',
    'recipient',
    'nullifier',
    'commitments',
    'encrypted-output',
    'eth_estimateGas',
    'eth_call',
    'signed-transaction',
  ]),
});
// The probe's disclosures, in production order (railgun-private-preflight.js).
// The selected nullifier is queried only after every earlier check passes.
const PROBE_DISCLOSURE_ORDER = Object.freeze([
  'lazy-chain-id-check',
  'latest-header',
  'deployment-code-and-storage',
  'deployment-getters',
  'root-history',
  'unshield-fee',
  'verification-key',
  'selected-nullifier',
  'anchor-header-recheck',
]);
const BEFORE_NULLIFIER = Object.freeze([
  'deployment',
  'artifacts',
  'rootHistory',
  'unshieldFee',
  'verifier',
]);
const SPEND_KINDS = Object.freeze({
  transfer: 'railgun-private-transfer',
  unshield: 'railgun-token-unshield',
});
const SOURCE_DIRECTORIES = Object.freeze([
  'src/main/wallet',
  'src/main/networks',
  'src/main/identity',
]);
const FIXED_SOURCES = Object.freeze([
  'scripts/qualify-railgun-private-live.js',
  'scripts/qualify-ppv2-live.js',
  'scripts/qualify-railgun-live.js',
  'scripts/qualify-railgun-owned-poi-live.js',
  'src/main/wallet/railgun-private-destination.js',
  'src/main/wallet/railgun-shield-pins.json',
  'src/main/tor-manager.js',
  'src/main/profile-lock.js',
  'src/main/profile-resolver.js',
  'src/main/profile-paths.js',
  'src/main/identity-manager.js',
  'src/main/settings-store.js',
  // src/main/wallet/railgun-kohaku-*.js re-export this installed package; its
  // lockfile entry integrity is bound in dependencyIdentity.
  ...[
    'package.json',
    'index.cjs',
    'read.cjs',
    'src/railgun-kohaku-private-adapter.js',
    'src/railgun-kohaku-public-adapter.js',
    'src/railgun-kohaku-read-data.js',
    'src/railgun-kohaku-read-dispatch.js',
    'src/railgun-kohaku-snapshot-plugin.js',
    'src/railgun-shield-pins.json',
  ].map((name) => 'node_modules/@freedom/railgun-kohaku-adapter/' + name),
]);
const ARTIFACT_PATTERN = /^(?:0[12]x0[123]|POI_3x3)\.(?:wasm|zkey|vkey)$/;
const HASH = /^0x[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function refusal(step) {
  return Object.assign(new Error('Railgun live journey refused'), {
    code: 'RAILGUN_LIVE_JOURNEY_REFUSED',
    step,
  });
}
function check(condition, step) {
  if (!condition) throw refusal(step);
}
const plainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => isDeepStrictEqual(a, b);
const lower = (value) => (typeof value === 'string' ? value.toLowerCase() : value);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function parseArguments(args) {
  check(Array.isArray(args) && args.length === 10, 'arguments');
  const [
    mode,
    archive,
    proverArchive,
    artifactDirectory,
    profile,
    scanFile,
    scanSha,
    previousFile,
    previousSha,
    output,
  ] = args;
  check(MODES.includes(mode), 'mode');
  const paths = [
    archive,
    proverArchive,
    artifactDirectory,
    profile,
    scanFile,
    previousFile,
    output,
  ];
  check(
    paths.every((value) => typeof value === 'string' && path.isAbsolute(value)),
    'arguments'
  );
  check(SHA256.test(scanSha) && SHA256.test(previousSha), 'arguments');
  // Reports never land inside the profile, and never replace an input report.
  const inside = path.relative(profile, output);
  check(inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside), 'output');
  check(![scanFile, previousFile].includes(output), 'output');
  // One recovered submission per probe report: the name is fixed by the probe's
  // digest beside the probe's own output, so main()'s no-overwrite check refuses
  // a second run.
  if (mode === 'recover-submit')
    check(
      path.basename(output) === `recover-submit-${previousSha}` &&
        path.dirname(output) === path.dirname(path.dirname(previousFile)),
      'output'
    );
  return Object.freeze({
    mode,
    archive,
    proverArchive,
    artifactDirectory,
    profile,
    scanFile,
    scanSha,
    previousFile,
    previousSha,
    output,
  });
}

// Fee arithmetic. A transaction carries exactly one fee shape.
function feeExposure(transaction) {
  check(plainObject(transaction), 'fee-shape');
  const present = (value) => value !== undefined && value !== null;
  const eip1559 = present(transaction.maxFeePerGas),
    legacy = present(transaction.gasPrice);
  check(eip1559 !== legacy, 'fee-shape');
  let fee, gasLimit;
  try {
    fee = BigInt(eip1559 ? transaction.maxFeePerGas : transaction.gasPrice);
    gasLimit = BigInt(transaction.gasLimit);
  } catch {
    throw refusal('fee-shape');
  }
  check(fee > 0n && gasLimit > 0n, 'fee-shape');
  return Object.freeze({ fee, gasLimit, exposure: fee * gasLimit });
}
function assertFeeWithinCap(transaction, cap = FEE_CAP_WEI) {
  check(typeof cap === 'bigint' && cap > 0n && cap <= FEE_CAP_WEI, 'fee-cap');
  const value = feeExposure(transaction);
  check(value.gasLimit <= GAS_LIMIT_CEILING, 'gas-ceiling');
  check(value.exposure <= cap, 'fee-cap');
  return value;
}
function gasLimitFromEstimate(estimate) {
  let value;
  try {
    value = BigInt(estimate);
  } catch {
    throw refusal('estimate');
  }
  check(value > 0n, 'estimate');
  const { numerator, denominator } = GAS_HEADROOM;
  const limit = (value * numerator + denominator - 1n) / denominator;
  check(limit >= value && limit <= GAS_LIMIT_CEILING, 'gas-ceiling');
  return limit;
}
function planSubmissionFee({ estimate, gasPrice }) {
  const gasLimit = gasLimitFromEstimate(estimate);
  const value = assertFeeWithinCap({ gasLimit, gasPrice });
  return Object.freeze({
    estimate: BigInt(estimate).toString(),
    gasLimit: gasLimit.toString(),
    headroom: `${GAS_HEADROOM.numerator}/${GAS_HEADROOM.denominator}`,
    quotedGasPrice: value.fee.toString(),
    quotedExposureWei: value.exposure.toString(),
    capWei: FEE_CAP_WEI.toString(),
  });
}
function planningFeeCheck(gasPrice) {
  const value = assertFeeWithinCap({ gasLimit: PLANNING_GAS_LIMIT, gasPrice });
  return Object.freeze({
    planningGasLimit: PLANNING_GAS_LIMIT.toString(),
    gasPrice: value.fee.toString(),
    exposureWei: value.exposure.toString(),
    capWei: FEE_CAP_WEI.toString(),
  });
}
// Final check of the populated transaction inside the review, before signing.
function reviewedFee(transaction, gasLimit) {
  const value = assertFeeWithinCap(transaction);
  check(value.gasLimit === BigInt(gasLimit), 'fee-gas-limit');
  return Object.freeze({
    gasLimit: value.gasLimit.toString(),
    fee: value.fee.toString(),
    feeField: transaction.maxFeePerGas != null ? 'maxFeePerGas' : 'gasPrice',
    exposureWei: value.exposure.toString(),
    capWei: FEE_CAP_WEI.toString(),
  });
}

// Journal rules. The EOA journal is the only send history this script trusts.
function transactRecords(snapshot) {
  check(plainObject(snapshot), 'journal');
  check(Array.isArray(snapshot.records) && Array.isArray(snapshot.archive), 'journal');
  return [...snapshot.records, ...snapshot.archive].filter(
    (record) => record?.intent?.kind === 'railgun-transact'
  );
}
function assertJournalResolved(snapshot) {
  check(plainObject(snapshot) && Array.isArray(snapshot.records), 'journal');
  check(
    snapshot.records.every((record) => !!record?.resolution),
    'journal-unresolved'
  );
}
function assertShieldRecord(snapshot, shieldTransactionHash) {
  check(HASH.test(shieldTransactionHash), 'shield');
  check(Array.isArray(snapshot?.records) && Array.isArray(snapshot.archive), 'journal');
  const matches = [...snapshot.records, ...snapshot.archive].filter(
    (record) => record?.hash === shieldTransactionHash
  );
  check(matches.length === 1, 'shield');
  check(matches[0].intent?.kind === 'railgun-native-shield', 'shield');
  check(!!matches[0].resolution, 'shield');
}
function matchedTransfer(record, transferHash) {
  return (
    HASH.test(transferHash) &&
    record?.hash === transferHash &&
    record.intent?.operation === SPEND_KINDS.transfer &&
    record.resolution?.railgun?.outcome === 'matched'
  );
}
// Exactly one journaled attempt per spend step, across processes.
function assertSpendAdmission(snapshot, step, chain = {}) {
  assertJournalResolved(snapshot);
  const records = transactRecords(snapshot);
  if (step === 'transfer') {
    check(records.length === 0, 'spend-attempted');
    return;
  }
  check(step === 'unshield', 'spend-step');
  check(records.length === 1, 'spend-attempted');
  check(matchedTransfer(records[0], chain.transfer?.hash), 'transfer-unresolved');
}
// Between the two spends only the matched transfer may exist, all resolved.
function assertTransferSettled(snapshot, chain) {
  assertJournalResolved(snapshot);
  const records = transactRecords(snapshot);
  check(records.length === 1 && matchedTransfer(records[0], chain.transfer?.hash), 'journal');
}
// The held transfer was never journaled: the D1 shield, all resolved, no private send.
function assertHeldJournal(snapshot, chain) {
  assertShieldRecord(snapshot, chain.shieldTransactionHash);
  assertSpendAdmission(snapshot, 'transfer', chain);
}
// Production's prior-attempt rule for a recovered submission, restated: no
// unresolved record and no record or archive entry for this tree and nullifier.
function assertHeldUnjournaled(snapshot, held) {
  assertJournalResolved(snapshot);
  const { selection, preparation } = held.stored.capsule;
  check(
    !transactRecords(snapshot).some(
      (record) =>
        record.intent.tree === selection.tree &&
        record.intent.nullifier === preparation.expected.nullifier
    ),
    'journal-held'
  );
}
// Observation is the only mode allowed while its own target is unresolved.
function selectObservedRecord(snapshot, target, chain, hash) {
  check(['transfer', 'unshield'].includes(target), 'observe-target');
  const records = transactRecords(snapshot);
  check(records.length === (target === 'transfer' ? 1 : 2), 'journal');
  if (target === 'unshield')
    check(
      records.some((record) => matchedTransfer(record, chain.transfer?.hash)),
      'transfer-unresolved'
    );
  const candidates = records.filter(
    (record) =>
      record.intent?.operation === SPEND_KINDS[target] &&
      (hash === null || record.hash === hash) &&
      (target === 'transfer' || record.hash !== chain.transfer?.hash)
  );
  check(candidates.length === 1 && HASH.test(candidates[0].hash), 'journal');
  check(
    snapshot.records.every((record) => record.hash === candidates[0].hash || !!record.resolution),
    'journal-unresolved'
  );
  return candidates[0];
}
function classifySpendOutcome({ result, before, after }) {
  const known = new Set(transactRecords(before).map((record) => record.hash));
  const added = transactRecords(after).filter((record) => !known.has(record.hash));
  const reported =
    typeof result?.hash === 'string'
      ? result.hash.toLowerCase()
      : typeof result?.transactionHash === 'string'
        ? result.transactionHash.toLowerCase()
        : null;
  check(added.length <= 1, 'spend-multiple');
  if (!added.length) {
    // A hash without a journal record cannot be bound to this attempt.
    check(reported === null, 'spend-unjournaled');
    return Object.freeze({
      attempted: false,
      journaled: false,
      submissionStatus: 'not-sent',
      resendAllowed: false,
    });
  }
  const record = added[0];
  check(HASH.test(record.hash), 'spend-hash');
  check(reported === null || reported === record.hash, 'spend-hash');
  const acknowledged = typeof result?.hash === 'string' && reported === record.hash;
  return Object.freeze({
    attempted: true,
    journaled: true,
    journaledHash: record.hash,
    journalState: typeof record.state === 'string' ? record.state : null,
    submissionStatus: acknowledged ? 'acknowledged' : 'unknown',
    // Any journaled attempt is observation-only from here; never resent.
    resendAllowed: false,
  });
}

// Pinned inputs.
function assertRelativeSource(name) {
  check(
    typeof name === 'string' &&
      name.length > 0 &&
      !path.isAbsolute(name) &&
      !name.split(/[\\/]/).includes('..'),
    'sources'
  );
}
function journeySourceNames({ listed, scan, previous }) {
  check(Array.isArray(listed), 'sources');
  const names = new Set([...listed, ...FIXED_SOURCES]);
  for (const map of [scan?.sourceSha256, previous?.sourceSha256]) {
    if (map === undefined) continue;
    check(plainObject(map), 'sources');
    for (const name of Object.keys(map)) names.add(name);
  }
  const sorted = [...names].sort();
  sorted.forEach(assertRelativeSource);
  return Object.freeze(sorted);
}
function changedSources(expected, actual) {
  check(plainObject(expected) && plainObject(actual), 'sources');
  return Object.keys(expected)
    .filter((name) => actual[name] !== expected[name])
    .sort();
}
function assertSourcesMatch(expected, actual, step = 'sources') {
  check(changedSources(expected, actual).length === 0, step);
}
function assertSameSources(previous, actual) {
  check(plainObject(previous) && plainObject(actual), 'sources');
  check(same(Object.keys(previous).sort(), Object.keys(actual).sort()), 'sources');
  assertSourcesMatch(previous, actual);
}
function assertSameRuntime(previous, actual) {
  check(plainObject(previous) && plainObject(actual), 'runtime');
  check(SHA256.test(actual.engineSha256) && SHA256.test(actual.proverSha256), 'runtime');
  check(
    plainObject(actual.artifactSha256) && Object.keys(actual.artifactSha256).length > 0,
    'runtime'
  );
  check(same(previous, actual), 'runtime');
}
// The held proof's runtime: engine, prover and circuit artifacts. Dependency
// identity is recorded fresh, because the source baseline changed.
function assertSameProofRuntime(previous, actual) {
  check(plainObject(previous) && plainObject(actual), 'runtime');
  const proof = ({ engineSha256, proverSha256, artifactSha256 }) => ({
    engineSha256,
    proverSha256,
    artifactSha256,
  });
  assertSameRuntime(proof(previous), proof(actual));
}
function assertScanReport(scan) {
  check(plainObject(scan), 'scan');
  check(scan.passed === true && scan.completed === true && scan.chainId === CHAIN_ID, 'scan');
  check(scan.txid?.independentEventCoverage === true, 'scan-txid');
  check(scan.wallet?.assetCount === 1, 'scan-wallet');
  check(
    plainObject(scan.anchor) &&
      Number.isSafeInteger(scan.anchor.number) &&
      HASH.test(scan.anchor.hash),
    'scan-anchor'
  );
  check(plainObject(scan.sourceSha256) && Object.keys(scan.sourceSha256).length > 0, 'scan');
  Object.keys(scan.sourceSha256).forEach(assertRelativeSource);
}
function assertOwnedPoiReport(report, scanSha) {
  check(plainObject(report) && report.journey === undefined, 'predecessor');
  check(report.passed === true && report.chainId === CHAIN_ID, 'predecessor');
  check(report.scanReportSha256 === scanSha, 'predecessor-scan');
  check(report.finalizedShieldMatched === true, 'predecessor');
  check(report.walletRecoveredExpectedShield === true, 'predecessor');
  check(report.submissions === 0 && report.circuitIsolationQualified === false, 'predecessor');
  check(HASH.test(report.shieldTransactionHash), 'predecessor');
  check(plainObject(report.sourceSha256), 'predecessor');
  const poi = report.poi;
  check(
    plainObject(poi) &&
      poi.allValid === true &&
      poi.selectedCount === 1 &&
      poi.listKey === REQUIRED_LIST &&
      same(poi.statuses, ['Valid']) &&
      poi.rootsAccepted === true &&
      poi.membershipVerified === true &&
      poi.ownershipAtSnapshot === true,
    'predecessor-poi'
  );
}
// The held transfer report: proved, refused at preflight before any review,
// never journaled. The pinned digest is the binding; the shape is restated.
function assertHeldTransferReport(previous, previousSha) {
  check(previousSha === HELD_TRANSFER_REPORT_SHA256, 'predecessor-held');
  check(previous.mode === 'transfer' && previous.passed === false, 'predecessor-held');
  check(previous.failure === undefined, 'predecessor-held');
  check(
    previous.prove?.status === 'proved' && previous.prove.holdCreated === true,
    'predecessor-held'
  );
  check(
    same(previous.spend, {
      attempted: false,
      journaled: false,
      submissionStatus: 'not-sent',
      resendAllowed: false,
    }),
    'predecessor-held'
  );
  check(
    previous.liveness?.state === 'proved-unsent' && previous.liveness.inputHeld === true,
    'predecessor-held'
  );
  check(
    previous.submission?.status === 'refused' &&
      previous.submission.stage === 'preflight' &&
      previous.submission.reviews === 0,
    'predecessor-held'
  );
  check(
    previous.spendRequest?.kind === SPEND_KINDS.transfer &&
      previous.spendRequest.recipient === 'self',
    'predecessor-held'
  );
  check(previous.chain.transfer === null && previous.chain.unshield === null, 'predecessor-held');
  const plan = previous.fee?.plan;
  check(plainObject(plan) && /^[1-9][0-9]{0,8}$/.test(plan.estimate ?? ''), 'predecessor-held');
  check(plan.gasLimit === gasLimitFromEstimate(plan.estimate).toString(), 'predecessor-held');
}
// Observe follows a spend report, or its check report after a lost spend report.
function observedTarget(previous) {
  if (previous.mode === 'observe') return previous.target;
  if (['recover-submit', 'preflight-probe'].includes(previous.mode)) return 'transfer';
  return { transfer: 'transfer', unshield: 'unshield' }[previous.mode.replace(/^check-/, '')];
}
function observedHash(previous) {
  if (previous.mode === 'observe') return previous.observedHash;
  return ['transfer', 'unshield', 'recover-submit'].includes(previous.mode)
    ? previous.spend.journaledHash
    : null;
}
function validPoiStatus(poi) {
  return (
    plainObject(poi) &&
    poi.allValid === true &&
    same(poi.statuses, ['Valid']) &&
    poi.rootsAccepted === true &&
    poi.membershipVerified === true &&
    poi.listKey === REQUIRED_LIST
  );
}
// Mode order. Only these predecessor/mode pairs are accepted.
function assertPredecessor(mode, previous, { scanSha, scan, previousSha, now = Date.now() }) {
  check(MODES.includes(mode), 'mode');
  if (mode === 'check-transfer') return assertOwnedPoiReport(previous, scanSha);
  check(plainObject(previous) && previous.journey === JOURNEY, 'predecessor');
  check(previous.version === 1 && previous.chainId === CHAIN_ID, 'predecessor');
  check(MODES.includes(previous.mode), 'predecessor');
  check(plainObject(previous.chain), 'predecessor');
  check(HASH.test(previous.chain.shieldTransactionHash), 'predecessor');
  check(SHA256.test(previous.chain.ownedPoiReportSha256), 'predecessor');
  check(ADDRESS.test(previous.owner), 'predecessor');
  const sameScan = previous.scan?.sha256 === scanSha;
  const anchor = scan?.anchor?.number;
  const notOlder = Number.isSafeInteger(anchor) && anchor >= previous.scan?.anchor?.number;
  const transferBlock = previous.chain.transfer?.blockNumber;
  const afterTransfer = Number.isSafeInteger(transferBlock) && anchor >= transferBlock;
  switch (mode) {
    case 'transfer':
      check(previous.mode === 'check-transfer' && previous.passed === true, 'predecessor');
      check(sameScan, 'predecessor-scan');
      return;
    case 'observe':
      check(sameScan, 'predecessor-scan');
      if (['transfer', 'unshield', 'recover-submit'].includes(previous.mode)) {
        // A failed or uncertain spend is still observed once it is journaled.
        check(previous.spend?.journaled === true, 'predecessor');
        check(HASH.test(previous.spend.journaledHash), 'predecessor');
        return;
      }
      if (['check-transfer', 'check-unshield'].includes(previous.mode)) {
        check(previous.passed === true, 'predecessor');
        return;
      }
      if (previous.mode === 'preflight-probe') {
        // A lost recover-submit report: the passed probe stands as its check report.
        check(previous.passed === true && previous.preflight?.passed === true, 'predecessor');
        check(previous.result === 'preflight-passed', 'predecessor');
        return;
      }
      check(previous.mode === 'observe' && previous.passed === true, 'predecessor');
      check(['transfer', 'unshield'].includes(previous.target), 'predecessor');
      check(HASH.test(previous.observedHash), 'predecessor');
      check(!previous.resolved, 'predecessor-resolved');
      return;
    case 'poi-submit':
      check(previous.mode === 'observe' && previous.passed === true, 'predecessor');
      check(previous.target === 'transfer', 'predecessor');
      check(previous.resolved?.outcome === 'matched', 'predecessor-unresolved');
      check(previous.transact?.operation === SPEND_KINDS.transfer, 'predecessor');
      check(previous.transact?.outputKind === 'shielded', 'predecessor');
      check(previous.chain.transfer?.hash === previous.observedHash, 'predecessor');
      check(notOlder && afterTransfer, 'predecessor-scan');
      return;
    case 'recover':
      // Any completed POI attempt continues to the read-only steps: whatever the
      // response said, only the status mode (D3) establishes acceptance.
      check(previous.mode === 'poi-submit', 'predecessor');
      check(previous.poiSubmission?.attempted === true, 'predecessor');
      check(previous.poiSubmission.attemptCompleted === true, 'predecessor');
      check(notOlder && afterTransfer, 'predecessor-scan');
      return;
    case 'status':
      if (previous.mode === 'recover') {
        check(previous.passed === true, 'predecessor');
        check(previous.recovered?.outputRecovered === true, 'predecessor');
      } else {
        // Status may be read again while the output is not yet Valid.
        check(previous.mode === 'status' && previous.passed === true, 'predecessor');
        check(previous.poi?.allValid !== true, 'predecessor-valid');
      }
      check(notOlder && afterTransfer, 'predecessor-scan');
      return;
    case 'check-unshield':
      check(previous.mode === 'status' && previous.passed === true, 'predecessor');
      check(validPoiStatus(previous.poi), 'predecessor-poi');
      check(notOlder && afterTransfer, 'predecessor-scan');
      return;
    case 'unshield':
      check(previous.mode === 'check-unshield' && previous.passed === true, 'predecessor');
      // Step 7 is bound to the exact Valid status report of step 6.
      check(SHA256.test(previous.chain.outputPoi?.reportSha256), 'predecessor-poi');
      check(validPoiStatus(previous.chain.outputPoi), 'predecessor-poi');
      check(notOlder && afterTransfer, 'predecessor-scan');
      return;
    case 'spent-read':
    case 'preflight-probe':
      assertHeldTransferReport(previous, previousSha);
      // A newer scan on the current sources; the hold-time scan never qualifies.
      check(
        scanSha !== previous.scan?.sha256 && anchor > previous.scan?.anchor?.number,
        'predecessor-scan-newer'
      );
      return;
    case 'recover-submit':
      check(previous.mode === 'preflight-probe' && previous.passed === true, 'predecessor');
      check(
        previous.preflight?.passed === true && previous.preflight.acquireCalls === 1,
        'predecessor-preflight'
      );
      check(previous.result === 'preflight-passed', 'predecessor-preflight');
      check(previous.immutables?.unchanged === true, 'predecessor');
      check(probeFresh(previous.observedAt, now), 'predecessor-stale');
      check(
        previous.chain.heldTransfer?.reportSha256 === HELD_TRANSFER_REPORT_SHA256,
        'predecessor-held'
      );
      check(previous.chain.transfer === null, 'predecessor');
      // The probe's conditions: the same scan, sources and runtime.
      check(sameScan, 'predecessor-scan');
      return;
    default:
      throw refusal('mode');
  }
}
// A canonical ISO time no later than now and at most PROBE_MAX_AGE_MS before it.
function probeFresh(observedAt, now) {
  const at = typeof observedAt === 'string' ? Date.parse(observedAt) : NaN;
  return (
    Number.isFinite(at) &&
    new Date(at).toISOString() === observedAt &&
    at <= now &&
    now - at <= PROBE_MAX_AGE_MS
  );
}
function nextChain(mode, previous, previousSha) {
  if (mode === 'check-transfer')
    return {
      ownedPoiReportSha256: previousSha,
      shieldTransactionHash: previous.shieldTransactionHash,
      transfer: null,
      unshield: null,
    };
  const chain = JSON.parse(JSON.stringify(previous.chain));
  if (REBASED_MODES.includes(mode))
    chain.heldTransfer = {
      reportSha256: previousSha,
      estimate: previous.fee.plan.estimate,
      gasLimit: previous.fee.plan.gasLimit,
    };
  if (mode === 'recover-submit')
    chain.heldTransfer = { ...chain.heldTransfer, probeReportSha256: previousSha };
  if (mode === 'check-unshield')
    chain.outputPoi = {
      reportSha256: previousSha,
      allValid: previous.poi.allValid,
      statuses: [...previous.poi.statuses],
      rootsAccepted: previous.poi.rootsAccepted,
      membershipVerified: previous.poi.membershipVerified,
      listKey: previous.poi.listKey,
    };
  return chain;
}

// Aggregate summaries. Whitelists only: production objects carry private facts.
const isoTime = (value) =>
  typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() === value
    ? value
    : null;
function blockNumber(value) {
  if (value === undefined || value === null) return null;
  let number;
  try {
    number = Number(BigInt(value));
  } catch {
    throw refusal('observation');
  }
  check(Number.isSafeInteger(number) && number >= 0, 'observation');
  return number;
}
function summarizeObservation(record) {
  const observation = record?.observation;
  return {
    journalState: typeof record?.state === 'string' ? record.state : null,
    status: typeof observation?.status === 'string' ? observation.status : null,
    blockNumber: blockNumber(observation?.blockNumber),
    blockHash: HASH.test(observation?.blockHash) ? observation.blockHash : null,
    confirmations: Number.isSafeInteger(observation?.confirmations)
      ? observation.confirmations
      : null,
  };
}
function summarizeTransact(transact) {
  if (!plainObject(transact)) return null;
  const output = transact.output;
  return {
    status: typeof transact.status === 'string' ? transact.status : null,
    operation: typeof transact.operation === 'string' ? transact.operation : null,
    outputKind: typeof output?.kind === 'string' ? output.kind : null,
    ...(output?.kind === 'unshield'
      ? {
          unshield: {
            recipient: ADDRESS.test(output.recipient) ? output.recipient : null,
            amount: String(output.amount),
            received: String(output.received),
            fee: String(output.fee),
            feeDeviation: output.feeDeviation === true,
          },
        }
      : {}),
    trust: transact.trust === 'unverified-rpc' ? 'unverified-rpc' : null,
  };
}
function summarizeResolution(record) {
  const resolution = record?.resolution,
    railgun = resolution?.railgun;
  if (!resolution) return null;
  return {
    outcome: ['matched', 'reverted'].includes(railgun?.outcome) ? railgun.outcome : null,
    finalizedBlockNumber: blockNumber(railgun?.finalizedBlockNumber),
    finalizedBlockHash: HASH.test(railgun?.finalizedBlockHash) ? railgun.finalizedBlockHash : null,
    minimumConfirmations: Number.isSafeInteger(resolution.minimumConfirmations)
      ? resolution.minimumConfirmations
      : null,
  };
}
function summarizeReceiptGas(receipt) {
  check(plainObject(receipt), 'receipt');
  let gasUsed, price;
  try {
    gasUsed = BigInt(receipt.gasUsed);
    price = BigInt(receipt.effectiveGasPrice ?? receipt.gasPrice);
  } catch {
    throw refusal('receipt');
  }
  check(gasUsed > 0n && price > 0n, 'receipt');
  return {
    gasUsed: gasUsed.toString(),
    effectiveGasPrice: price.toString(),
    feePaidWei: (gasUsed * price).toString(),
    receiptStatus:
      receipt.status === '0x1' ? 'success' : receipt.status === '0x0' ? 'reverted' : null,
  };
}
function summarizeOwnedPoi(value, elapsedMs) {
  check(plainObject(value) && Array.isArray(value.statuses), 'poi');
  const statuses = value.statuses.map((entry) => entry.status);
  check(
    statuses.every((status) => typeof status === 'string'),
    'poi'
  );
  return {
    allValid:
      statuses.length === 1 &&
      statuses[0] === 'Valid' &&
      value.rootsAccepted === true &&
      value.membershipVerified === true,
    selectedCount: statuses.length,
    listKey: value.listKey === REQUIRED_LIST ? REQUIRED_LIST : null,
    statuses,
    rootsAccepted: value.rootsAccepted === true,
    membershipVerified: value.membershipVerified === true,
    ownershipAtSnapshot: value.ownershipAtSnapshot === true,
    txidProvenanceVerified: value.txidProvenanceVerified === true,
    reservationsChecked: value.reservationsChecked === true,
    spendingEnabled: value.spendingEnabled === true,
    elapsedMs,
  };
}
function summarizePoiResponse(response) {
  if (!plainObject(response)) return null;
  return {
    classification: typeof response.classification === 'string' ? response.classification : null,
    httpStatus: Number.isSafeInteger(response.httpStatus) ? response.httpStatus : null,
    responseBytes: Number.isSafeInteger(response.responseBytes) ? response.responseBytes : null,
    matchingEnvelope: response.matchingEnvelope === true,
    transportAuthenticated: response.transportAuthenticated === true,
    acceptanceVerified: response.acceptanceVerified === true,
  };
}
function sanitizeFailure(stage, error) {
  return {
    stage,
    code: /^[A-Z0-9_]+$/.test(error?.code ?? '') ? error.code : (error?.name ?? 'Error'),
    ...(/^[a-z][a-z-]{0,63}$/.test(error?.step ?? '') ? { step: error.step } : {}),
    ...(['rpc', 'mismatch', 'stale', 'inactive', 'refused'].includes(error?.reason)
      ? { reason: error.reason }
      : {}),
    ...(typeof error?.transactionHash === 'string' && HASH.test(error.transactionHash)
      ? { transactionHash: error.transactionHash, reconciliationRequired: true }
      : {}),
  };
}

// The closed TOR_REQUEST_FAILED stages (wallet-tor-transport.js), matched
// exactly: a diagnostic only, which never proves non-delivery and never
// authorizes a retry or anything else.
const DIAGNOSTIC_CAUSE_STAGES = Object.freeze([
  'connect',
  'tls',
  'socket-new',
  'socket-reused',
  'response',
  'unclassified',
]);
// The production refusal diagnostic, checked again here: allow-listed keys with
// identifier-shaped values only, never messages, payloads, paths or long hex.
// An unavailable diagnostic is null and never blocks the journal readback.
const DIAGNOSTIC_KEYS = Object.freeze({
  stage: /^[a-z][a-z-]{0,31}$/,
  substage: /^[a-z][a-z-]{0,31}$/,
  code: /^[A-Z][A-Z0-9_]{0,79}$/,
  reason: /^[a-z][a-z-]{0,31}$/,
  step: /^[a-z][a-zA-Z-]{0,31}$/,
  deploymentStep: /^[a-z][a-zA-Z-]{0,31}$/,
  causeCode: /^[A-Z][A-Z0-9_]{0,79}$/,
  causeStage: new RegExp(`^(?:${DIAGNOSTIC_CAUSE_STAGES.join('|')})$`),
});
function summarizeSubmissionDiagnostic(value) {
  if (!plainObject(value)) return null;
  const summary = {};
  for (const [key, pattern] of Object.entries(DIAGNOSTIC_KEYS)) {
    const item = value[key];
    if (typeof item === 'string' && pattern.test(item) && !/[0-9a-fA-F]{16}/.test(item))
      summary[key] = item;
  }
  return summary;
}
function readSubmissionDiagnostic(ctx, result) {
  try {
    return summarizeSubmissionDiagnostic(
      ctx.load('wallet/railgun-private-submission').getRailgunPrivateSubmissionDiagnostic(result)
    );
  } catch {
    return null;
  }
}
// The probe's refusal through the same production tuple and the same allowlist.
function readPreflightDiagnostic(ctx, substage, error) {
  try {
    return summarizeSubmissionDiagnostic(
      ctx
        .load('wallet/railgun-private-submission')
        .getRailgunPrivatePreflightDiagnostic(substage, error)
    );
  } catch {
    return null;
  }
}
// Whether nullifiers(tree, nullifier) reached the RPC. Production queries it only
// after the deployment, artifact, root, fee and verifier steps pass.
function nullifierQuery({ passed, diagnostic }) {
  if (passed || diagnostic?.substage === 'admission' || diagnostic?.step === 'anchor-recheck')
    return 'queried';
  if (diagnostic?.substage === 'open' || BEFORE_NULLIFIER.includes(diagnostic?.step))
    return 'not-queried';
  if (diagnostic?.step === 'nullifiers')
    return diagnostic.reason === 'mismatch' ? 'queried' : 'possibly-queried';
  return 'unknown';
}
// Public anchor facts and fixed booleans of a passed preflight; never its input.
function summarizePreflightObservation(observed) {
  const anchor = observed?.anchor;
  return {
    anchor: {
      blockNumber: blockNumber(anchor?.number),
      blockHash: HASH.test(anchor?.hash) ? anchor.hash : null,
      timestamp: blockNumber(anchor?.timestamp),
    },
    deploymentMatched: observed?.deploymentMatched === true,
    verifierMatched: observed?.verifierMatched === true,
    rootAccepted: observed?.rootAccepted === true,
    inputUnspent: observed?.inputUnspent === true,
    unshieldFeeBps: Number.isSafeInteger(observed?.unshieldFeeBps) ? observed.unshieldFeeBps : null,
    trust: observed?.trust === 'unverified-rpc' ? 'unverified-rpc' : null,
  };
}

// Redaction backstop for every report write. Public hashes only under fixed keys.
const FORBIDDEN_KEYS = new Set([
  'nullifier',
  'nullifiers',
  'npk',
  'random',
  'commitment',
  'commitments',
  'changeCommitment',
  'unshieldCommitment',
  'blindedCommitment',
  'blindedCommitments',
  'blindedCommitmentsOut',
  'noteHash',
  'selector',
  'facts',
  'proof',
  'proofs',
  'payload',
  'signature',
  'mnemonic',
  'privateKey',
  'spendingKey',
  'viewingKey',
  'password',
  'merkleRoot',
  'poiMerkleroots',
  'txidMerkleroot',
  'railgunTxidIfHasUnshield',
  'boundParamsHash',
  'intentDigest',
  'transactionDigest',
  'capsule',
  'capsuleDigest',
  'bindingDigest',
  'ciphertext',
  'data',
  'unsignedSerialized',
  'signedTransaction',
  'instanceId',
  'intent',
]);
const PUBLIC_HASH_KEYS = new Set([
  'hash',
  'transactionHash',
  'shieldTransactionHash',
  'journaledHash',
  'observedHash',
  'blockHash',
  'finalizedBlockHash',
]);
const ADDRESS_KEYS = new Set(['owner', 'recipient', 'recipientAddress']);
// Any run of 32 or more hex digits (16-byte randoms and longer) must be one of
// the exact public shapes under an allow-listed key.
function allowedHexString(value, key, parent) {
  if (HASH.test(value)) return PUBLIC_HASH_KEYS.has(key);
  if (SHA256.test(value))
    return /sha256$/i.test(key) || /sha256$/i.test(parent) || key === 'listKey';
  if (ADDRESS.test(value)) return ADDRESS_KEYS.has(key);
  return false;
}
function assertAggregateReport(report) {
  let nodes = 0;
  const walk = (value, key, parent, depth) => {
    check(++nodes <= 20000 && depth <= 16, 'report-redaction');
    if (value === null || ['boolean', 'number'].includes(typeof value)) return;
    if (typeof value === 'string') {
      check(value.length <= 4096, 'report-redaction');
      check(!/0zk1[0-9a-z]{20,}/.test(value), 'report-redaction');
      if (/[0-9a-fA-F]{32,}/.test(value))
        check(allowedHexString(value, key, parent), 'report-redaction');
      return;
    }
    check(typeof value === 'object', 'report-redaction');
    if (Array.isArray(value)) {
      for (const item of value) walk(item, key, parent, depth + 1);
      return;
    }
    for (const [name, item] of Object.entries(value)) {
      check(!FORBIDDEN_KEYS.has(name), 'report-redaction');
      walk(item, name, key, depth + 1);
    }
  };
  walk(report, '', '', 0);
  return true;
}
function renderReport(report) {
  try {
    assertAggregateReport(report);
    return JSON.stringify(report, null, 2) + '\n';
  } catch {
    return (
      JSON.stringify(
        {
          journey: JOURNEY,
          version: 1,
          mode: MODES.includes(report?.mode) ? report.mode : null,
          passed: false,
          failure: { stage: 'report-redaction', code: 'RAILGUN_LIVE_JOURNEY_REFUSED' },
        },
        null,
        2
      ) + '\n'
    );
  }
}

// D2 never proves acceptance. Only a matching rpc-result counts as delivered;
// unavailable, HTTP failure, malformed, unmatched or rejected (rpc-error) do not.
function assessPoiSubmission({ result, entryState }) {
  const response = summarizePoiResponse(result?.response);
  const attempted = entryState === 'attempted';
  const attemptCompleted = attempted && result?.stage === 'response';
  const delivered =
    attemptCompleted &&
    response?.classification === 'rpc-result' &&
    response.matchingEnvelope === true;
  return {
    status: typeof result?.status === 'string' ? result.status : null,
    stage: typeof result?.stage === 'string' ? result.stage : null,
    classification: response?.classification ?? null,
    response,
    entryState: typeof entryState === 'string' ? entryState : null,
    attempted,
    attemptCompleted,
    delivered,
    serviceAcceptanceVerified: false,
    acceptanceGate: 'status',
    automaticRetry: false,
  };
}
// Explicit stuck-state report for a spend. No continuation exists in this script.
function describeLiveness({ holdCreated, spend }) {
  if (!holdCreated) return { inputHeld: false, state: 'no-hold', continuation: 'none' };
  if (spend?.journaled === true && spend.submissionStatus === 'acknowledged')
    return { inputHeld: true, state: 'sent', continuation: 'observe' };
  if (spend?.journaled === true)
    return {
      inputHeld: true,
      state: 'journaled-uncertain',
      continuation: 'observe',
      mayNeverResolve: true,
      unresolvedContinuation: 'separately-authorized-recovery',
    };
  return {
    inputHeld: true,
    state: spend?.journaled === false ? 'proved-unsent' : 'unknown',
    continuation: 'separately-authorized-recovery',
    laterSpendRefusal: 'RAILGUN_PRIVATE_INPUT_RESERVED',
  };
}
// The installed ethers and Kohaku adapter must be the locked ones; the lock
// itself is pinned, and the adapter's tarball integrity is reported with it.
function dependencyIdentity({ ethersPackage, adapterPackage, packageLock, electronVersion }) {
  let installed, adapter, lock;
  try {
    installed = JSON.parse(ethersPackage);
    adapter = JSON.parse(adapterPackage);
    lock = JSON.parse(packageLock);
  } catch {
    throw refusal('dependencies');
  }
  check(installed?.name === 'ethers' && typeof installed.version === 'string', 'dependencies');
  check(lock?.packages?.['node_modules/ethers']?.version === installed.version, 'dependencies');
  const locked = lock?.packages?.['node_modules/@freedom/railgun-kohaku-adapter'];
  check(
    adapter?.name === '@freedom/railgun-kohaku-adapter' &&
      typeof adapter.version === 'string' &&
      locked?.version === adapter.version &&
      /^sha512-[A-Za-z0-9+/]{86}==$/.test(locked.integrity),
    'dependencies'
  );
  return {
    ethersVersion: installed.version,
    railgunKohakuAdapter: { version: adapter.version, integrity: locked.integrity },
    packageLockSha256: sha(packageLock),
    electronVersion: typeof electronVersion === 'string' ? electronVersion : null,
  };
}
// Recursive: loaded subdirectories (wallet/remote, wallet/ledger) are pinned too.
function listSourceFiles(base, directories = SOURCE_DIRECTORIES, fsImpl = fs) {
  const out = [];
  const visit = (relative) => {
    for (const entry of fsImpl.readdirSync(path.join(base, relative), { withFileTypes: true })) {
      const name = relative + '/' + entry.name;
      if (entry.isDirectory()) {
        if (!/^__.*__$/.test(entry.name)) visit(name);
      } else if (
        entry.isFile() &&
        /\.(?:js|json)$/.test(entry.name) &&
        !/\.test\.js$/.test(entry.name)
      )
        out.push(name);
    }
  };
  directories.forEach(visit);
  return out.sort();
}

// ---------------------------------------------------------------------------
// Electron live process. main() alone runs under Electron. The steps below take
// every production module through ctx.load, so Jest drives them with fakes.
// ---------------------------------------------------------------------------
let lock,
  backgroundFailure = false;
// The checkout's commit, bound in the recovery ledger beside the source digests.
function sourceCommit(base) {
  const value = require('child_process')
    .execFileSync('git', ['-C', base, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10000 })
    .trim();
  check(COMMIT.test(value), 'recovery-binding');
  return value;
}
function readPinnedReport(filename, expected) {
  const stat = fs.lstatSync(filename);
  check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4 * 1024 * 1024, 'pinned');
  const bytes = fs.readFileSync(filename);
  check(sha(bytes) === expected, 'pinned');
  return JSON.parse(bytes);
}
function hashRuntime({ archive, proverArchive, artifactDirectory }, base) {
  // Asar archives must be read as files, not as Electron's virtual directories.
  const raw = require('original-fs');
  const artifactSha256 = {};
  for (const name of fs.readdirSync(artifactDirectory).sort()) {
    if (!ARTIFACT_PATTERN.test(name)) continue;
    const filename = path.join(artifactDirectory, name);
    const stat = fs.lstatSync(filename);
    check(stat.isFile() && !stat.isSymbolicLink(), 'runtime');
    artifactSha256[name] = sha(fs.readFileSync(filename));
  }
  check(Object.keys(artifactSha256).length > 0, 'runtime');
  return {
    engineSha256: sha(raw.readFileSync(archive)),
    proverSha256: sha(raw.readFileSync(proverArchive)),
    artifactSha256,
    dependencies: dependencyIdentity({
      ethersPackage: fs.readFileSync(path.join(base, 'node_modules/ethers/package.json'), 'utf8'),
      adapterPackage: fs.readFileSync(
        path.join(base, 'node_modules/@freedom/railgun-kohaku-adapter/package.json'),
        'utf8'
      ),
      packageLock: fs.readFileSync(path.join(base, 'package-lock.json'), 'utf8'),
      electronVersion: process.versions.electron,
    }),
  };
}
async function main() {
  const { app, safeStorage } = require('electron');
  const args = parseArguments(process.argv.slice(2));
  const { mode, profile: directory, output } = args;
  check(
    !app.isPackaged &&
      process.env.FREEDOM_WALLET_TOR_EXPERIMENT === '1' &&
      !process.env.FREEDOM_IDENTITY_DATA,
    'environment'
  );
  check(fs.realpathSync(directory) === directory, 'profile');
  check(!fs.existsSync(output), 'output');
  check(
    !fs.existsSync(
      path.join(directory, require('../src/main/networks/direct-testnet-transport').MARKER)
    ),
    'profile'
  );
  fs.mkdirSync(output, { mode: 0o700 });
  const base = path.join(__dirname, '..');
  const report = {
    journey: JOURNEY,
    version: 1,
    mode,
    observedAt: new Date().toISOString(),
    chainId: CHAIN_ID,
    owner: null,
    previous: { sha256: args.previousSha },
    scan: { sha256: args.scanSha },
    limits: {
      feeCapWei: FEE_CAP_WEI.toString(),
      gasLimitCeiling: GAS_LIMIT_CEILING.toString(),
      gasHeadroom: `${GAS_HEADROOM.numerator}/${GAS_HEADROOM.denominator}`,
      planningGasLimit: PLANNING_GAS_LIMIT.toString(),
      minimumConfirmations: MIN_CONFIRMATIONS,
      maxQualificationAmount: MAX_AMOUNT.toString(),
      automaticRetry: false,
    },
    publication: { publishable: ['report.json'], localOnly: ['transport/'] },
    transport: 'qualification-only Tor endpoint shim',
    circuitIsolationQualified: false,
    passed: false,
  };
  const torModule = require.resolve('../src/main/tor-manager'),
    savedTor = require.cache[torModule];
  const ctx = {
    args,
    report,
    stage: 'preconditions',
    load: (name) => require('../src/main/' + name),
    // The recovery ledger's file system (recover-submit only).
    fs,
  };
  let client, vault;
  try {
    // Pinned predecessor, scan, sources and runtime before any profile access.
    const scan = readPinnedReport(args.scanFile, args.scanSha);
    const previous = readPinnedReport(args.previousFile, args.previousSha);
    assertScanReport(scan);
    assertPredecessor(mode, previous, {
      scanSha: args.scanSha,
      scan,
      previousSha: args.previousSha,
    });
    // A rebased mode's sources are anchored by the newer scan alone; its report
    // is the new chain anchor that recover-submit compares in full.
    const rebased = REBASED_MODES.includes(mode);
    const names = journeySourceNames({
      listed: listSourceFiles(base),
      scan,
      previous: rebased ? undefined : previous,
    });
    const hashes = () =>
      Object.fromEntries(names.map((name) => [name, sha(fs.readFileSync(path.join(base, name)))]));
    const sourceSha256 = hashes();
    assertSourcesMatch(scan.sourceSha256, sourceSha256, 'scan-sources');
    if (mode === 'check-transfer')
      assertSourcesMatch(previous.sourceSha256, sourceSha256, 'predecessor-sources');
    else if (!rebased) assertSameSources(previous.sourceSha256, sourceSha256);
    const runtime = hashRuntime(args, base);
    if (rebased) assertSameProofRuntime(previous.runtime, runtime);
    else if (mode !== 'check-transfer') assertSameRuntime(previous.runtime, runtime);
    report.previous.mode = mode === 'check-transfer' ? 'owned-poi' : previous.mode;
    report.scan.anchor = { number: scan.anchor.number, hash: scan.anchor.hash };
    report.chain = nextChain(mode, previous, args.previousSha);
    report.sourceSha256 = sourceSha256;
    report.runtime = runtime;
    Object.assign(ctx, { scan, previous, chain: report.chain });
    if (mode === 'recover-submit') ctx.sourceCommit = sourceCommit(base);

    ctx.stage = 'profile';
    const profile = require('../src/main/profile-resolver').initializeProfile(app, {
      env: { FREEDOM_TEST_USER_DATA: directory },
    });
    lock = require('../src/main/profile-lock').acquireProfileLock(profile, {
      onCompromised: () => app.exit(1),
    });
    app.dock?.hide();
    await app.whenReady();
    const marker = JSON.parse(fs.readFileSync(path.join(directory, 'railgun-test-profile.json')));
    check(
      same(marker, { version: 1, chainId: CHAIN_ID, profileId: profile.id, disposable: true }),
      'profile'
    );
    ctx.profileId = profile.id;
    check(safeStorage.isEncryptionAvailable(), 'profile');
    if (process.platform === 'linux')
      check(safeStorage.getSelectedStorageBackend() !== 'basic_text', 'profile');
    vault = require('../src/main/identity/vault');
    check(vault.vaultExists(path.join(directory, 'identity')), 'profile');
    // Read-only: a spent, damaged or unbound campaign refuses before unlock and Tor.
    if (mode === 'recover-submit') {
      ctx.stage = 'admission';
      assertRecoveryAdmissible(ctx);
    }

    ctx.stage = 'unlock';
    let password = safeStorage.decryptString(
      fs.readFileSync(path.join(directory, 'qualification-password.bin'))
    );
    await vault.unlockVault(path.join(directory, 'identity'), password, 0);
    password = undefined;
    ctx.owner = (await ctx.load('wallet/signers').getSigner(0).getAddress()).toLowerCase();
    report.owner = ctx.owner;
    if (mode !== 'check-transfer') check(ctx.owner === previous.owner, 'owner');
    const registry = require('../src/main/networks/network-registry');
    check(
      registry.addCustomChain(
        {
          chainId: CHAIN_ID,
          name: 'Sepolia bounded Railgun private journey',
          nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
        },
        [RPC_URL]
      ).success === true,
      'registry'
    );
    registry.updateNetwork(CHAIN_ID, {
      access: { readOrder: ['direct'], allowDirect: true },
      quorum: { timeoutMs: 45000 },
    });
    ctx.stage = 'tor';
    const { openLiveTransport } = require('./qualify-ppv2-live');
    client = await openLiveTransport(path.join(output, 'transport'), console.log, 'sentio');
    report.tor = client.metadata;
    require.cache[torModule] = {
      id: torModule,
      filename: torModule,
      loaded: true,
      exports: { getWalletSocksEndpoint: () => client.endpoint },
    };
    const handle = ctx.load('wallet/privacy-session').openPrivacySession().getContext({
      kind: 'public-address',
      principal: ctx.owner,
      chainId: CHAIN_ID,
      role: 'transaction-rpc',
    });
    ctx.network = ctx
      .load('wallet/private-transaction-network')
      .getPrivateTransactionNetwork(handle);
    const journal = ctx
      .load('wallet/private-submission-journal')
      .getPrivateSubmissionJournal(handle);
    ctx.readJournal = () => journal.readSnapshot();
    await RUNNERS[mode](ctx);
    ctx.stage = 'final-sources';
    check(same(hashes(), report.sourceSha256), 'sources-changed');
    report.passed = report.passed === true && !backgroundFailure;
  } catch (error) {
    report.passed = false;
    report.failure = sanitizeFailure(ctx.stage, error);
  } finally {
    let drainTimer;
    const drained = await Promise.race([
      closeAll(ctx).then(() => true),
      new Promise((resolve) => {
        drainTimer = setTimeout(() => resolve(false), DRAIN_MS);
      }),
    ]);
    clearTimeout(drainTimer);
    if (!drained) {
      report.passed = false;
      report.drainTimedOut = true;
    }
    try {
      vault?.lockVault();
    } catch {
      report.passed = false;
    }
    if (client) await client.close();
    require.cache[torModule] = savedTor;
    fs.writeFileSync(path.join(output, 'report.json'), renderReport(report), {
      flag: 'wx',
      mode: 0o600,
    });
  }
  console.log(
    JSON.stringify({
      mode,
      passed: report.passed,
      failure: report.failure,
      spend: report.spend,
      liveness: report.liveness?.state,
      observation: report.observation?.status,
      resolved: report.resolved?.outcome,
      poi: report.poi?.statuses,
      poiSubmission: report.poiSubmission?.classification,
      input: report.input?.spent,
      preflight: report.preflight?.passed,
      result: report.result,
      nullifierQuery: report.preflight?.nullifierQuery,
    })
  );
  return report.passed ? 0 : 1;
}
async function closeAll(ctx) {
  // Reverse acquisition order. A failed close never skips the remaining owners.
  const steps = [
    () => ctx.preflight?.close(),
    () => ctx.poi?.close(),
    async () => ctx.poi && (await ctx.poi.closed),
    () => ctx.membership?.close?.(),
    async () => ctx.membership?.closed && (await ctx.membership.closed),
    () => ctx.plan?.close?.(),
    async () => ctx.plan?.closed && (await ctx.plan.closed),
    () => ctx.store?.close(),
    async () => ctx.store && (await ctx.store.closed),
    () => ctx.completion?.close(),
    async () => await ctx.wallet?.close(),
    () => ctx.staged?.close?.(),
    () => ctx.recovery?.close(),
    () => ctx.destinations?.close(),
    async () => await ctx.publicAccount?.close(),
    () => ctx.enrollment?.close(),
    () => ctx.identity?.close(),
  ];
  for (const step of steps) {
    try {
      await step();
    } catch {
      ctx.report.passed = false;
    }
  }
}

// Shared account work, as in the funded shield and owned-POI qualifiers.
async function openAccount(ctx) {
  const { archive } = ctx.args,
    scan = ctx.scan;
  ctx.stage = 'enroll';
  ctx.identity = await ctx.load('wallet/railgun-identity').openRailgunIdentity({ archive });
  ctx.enrollment = await ctx
    .load('wallet/railgun-account-enrollment')
    .openRailgunAccountEnrollment({ identity: ctx.identity, create: false });
  ctx.stage = 'restore-public';
  ctx.publicAccount = await ctx.load('wallet/railgun-account-public').openRailgunAccountPublic({
    enrollment: ctx.enrollment,
    archive,
    mode: 'active',
  });
  check(ctx.publicAccount.generationId === scan.generationId, 'scan-generation');
  check(ctx.publicAccount.policy === scan.publicPolicy, 'scan-generation');
  const status = await ctx.publicAccount.coordinator.recover();
  check(same(status.to, scan.anchor), 'scan-anchor');
  const snapshot = await ctx.publicAccount.coordinator.withPublicSnapshot(() => undefined);
  const checked = ctx.publicAccount.coordinator.assertSnapshot(snapshot.evidence);
  check(checked.state.storeId === scan.publicState?.storeId, 'scan-state');
  check(same(checked.state.trees, scan.publicState?.trees), 'scan-state');
  ctx.status = status;
  // The completed checkpoint of this scan: a recovered preflight's current binding.
  ctx.checkpoint = checked;
  ctx.owners = Object.freeze({
    identity: ctx.identity,
    enrollment: ctx.enrollment,
    coordinator: ctx.publicAccount.coordinator,
  });
}
async function openWallet(ctx) {
  ctx.stage = 'restore-wallet';
  ctx.wallet = await ctx.load('wallet/railgun-account-wallet').openRailgunAccountWallet({
    identity: ctx.identity,
    enrollment: ctx.enrollment,
    archive: ctx.args.archive,
    coordinator: ctx.publicAccount.coordinator,
    mode: 'active',
  });
  return readOwned(ctx);
}
function readOwned(ctx) {
  const owned = ctx
    .load('wallet/railgun-account-wallet')
    .readRailgunAccountOwnedNotes(ctx.wallet, ctx.owners);
  check(same(owned.read.readiness.to, ctx.status.to), 'wallet-readiness');
  if (ctx.scan.wallet?.to) check(same(ctx.scan.wallet.to, ctx.status.to), 'wallet-readiness');
  check(owned.read.instanceId === ctx.identity.descriptor.instanceId, 'wallet-instance');
  return owned;
}
function wethNote(note) {
  return (
    !!note &&
    note.asset?.__type === 'erc20' &&
    lower(note.asset.contract) === pins.wrappedNative &&
    typeof note.amount === 'bigint' &&
    note.amount > 0n &&
    note.amount <= MAX_AMOUNT
  );
}
// The input: the one unspent Shield note created by the D1 shield transaction.
function shieldInput(owned, shieldTransactionHash) {
  const notes = owned.read.received.filter((note) => lower(note.txid) === shieldTransactionHash);
  check(notes.length === 1 && notes[0].spentTxid === false && wethNote(notes[0]), 'input');
  const record = owned.ownedPoi.find((value) => value.id === notes[0].id);
  check(record?.type === 'Shield' && lower(record.txid) === shieldTransactionHash, 'input');
  return notes[0];
}
// The output: the one note created by the journaled self-transfer.
function transferOutput(owned, transferHash) {
  check(HASH.test(transferHash), 'output');
  const notes = owned.read.received.filter((note) => lower(note.txid) === transferHash);
  check(notes.length === 1 && wethNote(notes[0]), 'output');
  const record = owned.ownedPoi.find((value) => value.id === notes[0].id);
  check(record?.type === 'Transact' && lower(record.txid) === transferHash, 'output');
  return notes[0];
}
// Before proving: the one fee quote of a spend. The post-proof plan reuses it,
// so no quote round trip sits between proof and submission; the review
// recheck of the populated transaction remains the authoritative fee check.
async function submitterChecks(ctx) {
  const { network, owner } = ctx;
  const read = async (method, params) => (await network.request(CHAIN_ID, method, params)).result;
  const code = await read('eth_getCode', [owner, 'pending']);
  const balance = await read('eth_getBalance', [owner, 'pending']);
  const latest = await read('eth_getTransactionCount', [owner, 'latest']);
  const pending = await read('eth_getTransactionCount', [owner, 'pending']);
  check(code === '0x', 'submitter-code');
  // The production operation itself requires a 0.002 ETH pending balance.
  check(BigInt(balance) >= FEE_CAP_WEI, 'submitter-balance');
  check(BigInt(latest) === BigInt(pending), 'submitter-nonce');
  const quote = await network.getFeeQuote(CHAIN_ID);
  const planning = planningFeeCheck(quote.gasPrice);
  ctx.quotedGasPrice = planning.gasPrice;
  return { codeEmpty: true, balanceWei: BigInt(balance).toString(), nonceSettled: true, planning };
}
async function readOnlyPreparation(ctx, request, note) {
  const before = readOwned(ctx);
  const oldView = ctx.wallet.view,
    started = performance.now();
  const prepared = await ctx
    .load('wallet/railgun-account-wallet')
    .prepareRailgunAccountPrivateIntent(ctx.wallet, ctx.owners, request);
  check(prepared.view === ctx.wallet.view && prepared.view !== oldView, 'preparation');
  const p = prepared.preparation;
  check(p.amount === note.amount.toString(), 'preparation-amount');
  check(p.recipient === request.recipient, 'preparation-recipient');
  check(p.witnessRetained === false && p.spendingEnabled === false, 'preparation');
  check(same(prepared.readOnly, { readOnly: true, writeAttempts: 0 }), 'preparation');
  check(readOwned(ctx).checkpointHash === before.checkpointHash, 'preparation');
  let receiver = null;
  if (request.kind === SPEND_KINDS.transfer) {
    const checked = await ctx.load('wallet/railgun-private-receive').verifyRailgunPrivateReceiver({
      identity: ctx.identity,
      enrollment: ctx.enrollment,
      archive: ctx.args.archive,
      transaction: p.transaction,
      expected: p.expected,
      recipient: p.recipient,
      amount: p.amount,
    });
    check(checked.recipientVerified === true, 'receiver');
    check(checked.transactionDigest === p.transactionDigest, 'receiver');
    receiver = { recipientVerified: true, spendingEnabled: checked.spendingEnabled === true };
  }
  return {
    kind: request.kind,
    fullInputValue: true,
    witnessRetained: false,
    writeAttempts: 0,
    elapsedMs: Math.round(performance.now() - started),
    ...(receiver ? { receiver } : {}),
  };
}
// Self for the transfer, the enrolled EOA for the unshield; never caller data.
function spendRequest(ctx, step, note) {
  const recipient = step === 'transfer' ? ctx.identity.descriptor.instanceId : ctx.owner;
  if (step === 'unshield') check(ADDRESS.test(recipient), 'recipient');
  else check(typeof recipient === 'string' && recipient.startsWith('0zk'), 'recipient');
  return Object.freeze({ kind: SPEND_KINDS[step], noteId: note.id, recipient });
}
// Binds the reviewed RPC destination from preparation through submission.
function openDestinationConstraints(ctx) {
  const { createPrivacyScope, getPrivacyContext } = ctx.load('networks/privacy-context');
  const rpc = ctx.load('networks/private-rpc');
  const parent = getPrivacyContext(ctx.enrollment.getContext('engine'));
  const preview = createPrivacyScope({
    profileId: parent.profileId,
    signal: ctx.enrollment.signal,
  });
  const clients = [],
    constraints = [],
    origins = [];
  const close = () => {
    for (const value of constraints) value.close();
    for (const value of clients) value.release();
    preview.close();
  };
  try {
    const protocolSubject = { ...parent.subject, role: 'protocol-rpc' };
    delete protocolSubject.operation;
    const transactionSubject = {
      kind: 'public-address',
      principal: ctx.owner,
      chainId: CHAIN_ID,
      role: 'transaction-rpc',
    };
    for (const [subject, role] of [
      [protocolSubject, 'protocol-rpc'],
      [transactionSubject, 'transaction-rpc'],
    ]) {
      const handle = preview.getContext(subject);
      const client = rpc.createPrivateRpc(handle, role);
      clients.push(client);
      const observation = rpc.getPrivateRpcDestination(client, handle);
      const origin = new URL(rpc.getPrivateRpcDestinationDetails(observation).url).origin;
      check(origin === new URL(RPC_URL).origin, 'destination');
      origins.push(origin);
      constraints.push(
        rpc.createPrivateRpcDestinationConstraint({
          observation,
          signal: ctx.enrollment.signal,
          deadline: performance.now() + 600000,
        })
      );
    }
  } catch (error) {
    close();
    throw error;
  }
  return {
    close,
    origins,
    value: Object.freeze({
      protocol: constraints[0].constraint,
      transaction: constraints[1].constraint,
    }),
  };
}
// One spend: production prove -> own estimate and fee cap -> one production submit.
async function spend(ctx, step) {
  const { report } = ctx;
  let holdCreated = false;
  try {
    await spendSteps(ctx, step, () => {
      holdCreated = true;
    });
  } finally {
    report.liveness = describeLiveness({ holdCreated, spend: report.spend });
  }
}
async function spendSteps(ctx, step, onHold) {
  const { report } = ctx;
  const { archive, proverArchive, artifactDirectory } = ctx.args;
  ctx.stage = 'journal';
  const before = await ctx.readJournal();
  assertShieldRecord(before, ctx.chain.shieldTransactionHash);
  assertSpendAdmission(before, step, ctx.chain);
  await openAccount(ctx);
  const owned = await openWallet(ctx);
  const note =
    step === 'transfer'
      ? shieldInput(owned, ctx.chain.shieldTransactionHash)
      : transferOutput(owned, ctx.chain.transfer.hash);
  check(note.spentTxid === false, 'input');
  const request = spendRequest(ctx, step, note);
  report.spendRequest = {
    kind: request.kind,
    recipient: step === 'transfer' ? 'self' : 'enrolled-eoa',
    ...(step === 'unshield' ? { recipientAddress: ctx.owner, amount: note.amount.toString() } : {}),
    fullInputValue: true,
    amountWithinCeiling: true,
    // The direct path gates the input by Valid status, accepted roots and local
    // membership verification. It generates no pre-transaction POI proof.
    inputPoiGate: 'window-status-roots-membership',
    preTransactionPoiProof: false,
  };
  ctx.stage = 'submitter';
  report.submitter = await submitterChecks(ctx);
  ctx.stage = 'destinations';
  ctx.destinations = openDestinationConstraints(ctx);
  report.destinations = { rpcOrigins: ctx.destinations.origins, poiOrigin: POI_ORIGIN };
  const options = {
    account: ctx.wallet,
    owners: ctx.owners,
    archive,
    proverArchive,
    artifactDirectory,
    destinationConstraints: ctx.destinations.value,
    request,
  };
  if (step === 'unshield') {
    ctx.stage = 'transact-staging';
    ctx.staged = await ctx.load('wallet/railgun-transact-staging').stageRailgunTransactInput({
      account: ctx.wallet,
      owners: ctx.owners,
      request,
      archive,
      signal: ctx.enrollment.signal,
    });
    check(ctx.staged.status === 'staged', 'transact-staging');
    ctx.wallet = options.account = ctx.staged.account;
    options.stagingReceipt = ctx.staged.receipt;
  }
  ctx.stage = 'prove';
  const proveStarted = performance.now();
  const proved = await ctx
    .load('wallet/railgun-private-operation')
    .proveRailgunAccountPrivateOperation(options);
  if (typeof proved.holdId === 'string') onHold();
  report.prove = {
    status: proved.status,
    ...(proved.stage ? { stage: proved.stage } : {}),
    holdCreated: typeof proved.holdId === 'string',
    elapsedMs: Math.round(performance.now() - proveStarted),
  };
  report.spend = {
    attempted: false,
    journaled: false,
    submissionStatus: 'not-sent',
    resendAllowed: false,
  };
  if (proved.completion) ctx.completion = proved.completion;
  // From here the completion's lifetime runs: only local work and one estimate
  // precede submission. Submission enters account recovery, so close the wallet.
  await ctx.wallet.close();
  ctx.wallet = undefined;
  ctx.staged?.close?.();
  ctx.staged = undefined;
  check(proved.status === 'proved' && SHA256.test(proved.holdId), 'prove');
  ctx.stage = 'proved-transaction';
  const stored = await (await ctx.enrollment.openPrivateCapsules()).get(proved.holdId);
  const transaction = stored?.provedTransaction;
  check(plainObject(transaction) && lower(transaction.to) === pins.proxy, 'proved-transaction');
  check(stored.capsule.selection.kind === request.kind, 'proved-transaction');
  check(stored.capsule.selection.recipient === request.recipient, 'proved-transaction');
  check(!Object.hasOwn(stored.capsule.selection, 'recipientRelationship'), 'proved-transaction');
  ctx.stage = 'estimate';
  const rpcTx = { from: ctx.owner, to: transaction.to, value: '0x0', data: transaction.data };
  const estimate = (await ctx.network.request(CHAIN_ID, 'eth_estimateGas', [rpcTx])).result;
  ctx.stage = 'fee-cap';
  // Refuses before submission; the signed hold remains (report.liveness).
  const fee = planSubmissionFee({ estimate, gasPrice: ctx.quotedGasPrice });
  report.fee = { plan: fee, headroomReason: GAS_HEADROOM_REASON };
  ctx.stage = 'submission';
  let reviews = 0;
  const submitStarted = performance.now();
  const completion = ctx.completion;
  ctx.completion = undefined;
  // Until the journal is read back, a send may have happened.
  report.spend = {
    attempted: null,
    journaled: null,
    submissionStatus: 'unknown',
    resendAllowed: false,
  };
  const result = await ctx
    .load('wallet/railgun-private-submission')
    .submitRailgunPrivateTransaction({
      identity: ctx.identity,
      enrollment: ctx.enrollment,
      completion: completion.receipt,
      proverArchive,
      artifactDirectory,
      gasLimit: BigInt(fee.gasLimit),
      maxGasFee: FEE_CAP_WEI,
      review: async (reviewRequest) => {
        check(++reviews === 1, 'review-repeated');
        const actual = reviewRequest.transaction;
        check(reviewRequest.operation === request.kind, 'review');
        check(!Object.hasOwn(reviewRequest, 'recipientRelationship'), 'review');
        check(lower(reviewRequest.from) === ctx.owner, 'review');
        check(lower(actual.to) === pins.proxy && BigInt(actual.value) === 0n, 'review');
        check(Number(actual.chainId) === CHAIN_ID, 'review');
        check(actual.data === transaction.data, 'review');
        check(reviewRequest.maxGasFee === FEE_CAP_WEI, 'review');
        check(reviewRequest.fundingAddressPublic === true, 'review');
        if (step === 'unshield') {
          check(lower(reviewRequest.intent?.recipient) === ctx.owner, 'review');
          check(reviewRequest.intent?.amount === note.amount.toString(), 'review');
        }
        report.fee.reviewed = reviewedFee(actual, fee.gasLimit);
        return true;
      },
    });
  await recordSubmission(ctx, { result, before, started: submitStarted, reviews });
  if (report.spend.journaled)
    ctx.chain[step] = {
      hash: report.spend.journaledHash,
      ...(step === 'unshield' ? { amount: note.amount.toString() } : {}),
    };
  report.passed = report.spend.submissionStatus === 'acknowledged';
}
// One production submission's result, then the journal read back: the journal
// alone decides whether a send was attempted.
async function recordSubmission(ctx, { result, before, started, reviews }) {
  const { report } = ctx;
  const status =
    typeof result?.hash === 'string'
      ? 'acknowledged'
      : typeof result?.transactionHash === 'string'
        ? 'unknown'
        : 'refused';
  report.submission = {
    status,
    ...(typeof result?.stage === 'string' ? { stage: result.stage } : {}),
    ...(status === 'refused' ? { diagnostic: readSubmissionDiagnostic(ctx, result) } : {}),
    reviews,
    elapsedMs: Math.round(performance.now() - started),
  };
  ctx.stage = 'journal-readback';
  report.spend = classifySpendOutcome({ result, before, after: await ctx.readJournal() });
  // Aggregate only; printed at once so a later drain failure cannot hide it.
  console.log(JSON.stringify({ spend: report.spend }));
}

// ---------------------------------------------------------------------------
// Held-transfer recovery. Every step reads the one held signing record through
// the production signing-recovery path; none releases, discards or re-signs it.
// ---------------------------------------------------------------------------
// Expected refusals stay values inside recovery, as in production, so a refused
// check never closes the authenticated stores.
async function inRecovery(stores, timeoutMs, use) {
  const outcome = await stores.reservations.withSigningRecovery(
    async (records, context) => {
      try {
        return { value: await use(records, context) };
      } catch (error) {
        return { error };
      }
    },
    { timeoutMs }
  );
  if (outcome.error) throw outcome.error;
  return outcome.value;
}
// The one signing-recovery record and its capsule, read like the production
// recovered submission: receipt-attested, original signature and proof present.
async function readHeld(ctx, { reservations, capsules }, records, context) {
  context.assertCurrent();
  check(Array.isArray(records) && records.length === 1, 'hold');
  const [{ receipt, entry }] = records;
  reservations.assertReceiptContext(receipt, 'recovery');
  check(same(await reservations.assertReceipt(receipt), entry), 'hold');
  const stored = await capsules.readSigned(receipt);
  context.assertCurrent();
  check(SHA256.test(entry.id) && stored?.holdId === entry.id && entry.state === 'signing', 'hold');
  check(lower(entry.signing?.submitter) === ctx.owner, 'hold');
  check(!!stored.signature && plainObject(stored.provedTransaction), 'hold-signature');
  check(lower(stored.provedTransaction.to) === pins.proxy, 'hold');
  const { selection, preparation } = stored.capsule;
  check(
    selection.kind === SPEND_KINDS.transfer && entry.facts.kind === SPEND_KINDS.transfer,
    'hold'
  );
  check(selection.recipient === ctx.identity.descriptor.instanceId, 'hold-recipient');
  check(!Object.hasOwn(selection, 'recipientRelationship'), 'hold-recipient');
  check(
    entry.facts.tree === selection.tree && entry.facts.nullifier === preparation.expected.nullifier,
    'hold'
  );
  // A detached copy: the receipt and live store objects stay inside recovery.
  return JSON.parse(JSON.stringify({ entry, stored }));
}
const HELD_SUMMARY = Object.freeze({
  signingRecords: 1,
  operation: SPEND_KINDS.transfer,
  recipient: 'self',
  submitter: 'enrolled-eoa',
  originalSignaturePresent: true,
  provedTransactionPresent: true,
  journaled: false,
});
// Aggregate hold counts; a lease rewrite or floor advance leaves them unchanged.
async function holdCounts({ reservations, capsules }) {
  // [report key, store key]: the report never names a proof field.
  const count = (value, keys) =>
    Object.fromEntries(
      keys.map(([name, key]) => {
        check(Number.isSafeInteger(value?.[key]) && value[key] >= 0, 'hold-counts');
        return [name, value[key]];
      })
    );
  return {
    reservations: count(
      await reservations.inspect(),
      ['held', 'signing', 'abandoned', 'legacy'].map((key) => [key, key])
    ),
    capsules: count(await capsules.inspect(), [
      ['records', 'records'],
      ['signed', 'signatures'],
      ['proved', 'proofs'],
    ]),
  };
}
// The authenticated immutable facts a read-only probe must leave unchanged.
// Lease rewrites and floor advances on store open are expected and not compared.
function immutableParts({ held, journal, holds }) {
  const { entry, stored } = held;
  const { preparation } = stored.capsule;
  return {
    'hold-entry': entry,
    intent: [entry.facts, preparation.transaction, preparation.expected, stored.factsDigest],
    signing: [entry.signing, stored.signingDigest, stored.authorizationDigest],
    signature: stored.signature,
    'proved-transaction': stored.provedTransaction,
    'calldata-ciphertext': [preparation.transaction.data, stored.provedTransaction.data],
    capsule: [stored.holdId, stored.capsuleDigest, stored.capsule],
    'journal-records': journal.records,
    'journal-archive': journal.archive,
    'hold-counts': holds,
  };
}
const EXPECTED_STORE_WRITES = Object.freeze([
  'reservations-lease',
  'reservations-floor',
  'capsules-lease',
  'capsules-floor',
]);
// The binding production supplies to a recovered submission: the current
// completed checkpoint hash and its block (owned.binding.checkpointHash and
// owned.publicThrough.number), both taken from this scan's coordinator checkpoint.
function currentPreflightBinding(ctx) {
  const checkpoint = ctx.checkpoint;
  check(plainObject(checkpoint) && plainObject(checkpoint.to), 'preflight-binding');
  check(
    same(checkpoint.to, ctx.status.to) && same(checkpoint.to, ctx.scan.anchor),
    'preflight-binding'
  );
  const value = ctx.load('wallet/railgun-wallet-coverage').checkpointHash(checkpoint);
  check(SHA256.test(value) && Number.isSafeInteger(checkpoint.to.number), 'preflight-binding');
  return Object.freeze({ checkpointHash: value, minimumBlock: checkpoint.to.number });
}
// The recovered-submission preflight input (submitFinal with currentCheckpointHash):
// the held proof's original tree, merkleRoot and nullifier, bound to the current
// completed checkpoint and its block. Never the hold-time binding, never a mix.
function recoveredPreflightInput({ held, current, holdAnchor }) {
  const { entry, stored } = held;
  const input = Object.freeze({
    tree: stored.capsule.selection.tree,
    merkleRoot: stored.capsule.preparation.expected.merkleRoot,
    nullifier: entry.facts.nullifier,
    checkpointHash: current.checkpointHash,
    minimumBlock: current.minimumBlock,
  });
  assertRecoveredPreflightInput(input, { held, current, holdAnchor });
  return input;
}
function assertRecoveredPreflightInput(input, { held, current, holdAnchor }) {
  const { entry, stored } = held;
  const { selection, preparation } = stored.capsule;
  check(
    plainObject(input) &&
      same(Object.keys(input).sort(), [
        'checkpointHash',
        'merkleRoot',
        'minimumBlock',
        'nullifier',
        'tree',
      ]),
    'preflight-binding'
  );
  // The original held proof inputs.
  check(input.tree === selection.tree && input.tree === entry.facts.tree, 'preflight-binding');
  check(input.merkleRoot === preparation.expected.merkleRoot, 'preflight-binding');
  check(
    input.nullifier === entry.facts.nullifier && input.nullifier === preparation.expected.nullifier,
    'preflight-binding'
  );
  // Both halves of the binding from the one current completed checkpoint.
  check(input.checkpointHash === current.checkpointHash, 'preflight-binding');
  check(input.minimumBlock === current.minimumBlock, 'preflight-binding');
  // Neither half may be the hold-time binding.
  check(input.checkpointHash !== entry.facts.checkpointHash, 'preflight-binding');
  check(Number.isSafeInteger(holdAnchor) && input.minimumBlock > holdAnchor, 'preflight-binding');
}
// Exactly one production private preflight under the reviewed destination, with
// the recovered submission's timer and admission and without proof, EOA or
// signing work. A refusal is data and is never retried.
async function probePreflight(ctx, input, signal) {
  const preflights = ctx.load('wallet/railgun-private-preflight');
  const started = performance.now();
  let substage = 'open',
    acquireCalls = 0,
    preflight,
    passed = false,
    diagnostic = null,
    observation = null;
  try {
    preflight = preflights.createRailgunPrivatePreflight({
      enrollment: ctx.enrollment,
      artifactDirectory: ctx.args.artifactDirectory,
      input,
      destinationConstraint: ctx.destinations.value.protocol,
    });
    ctx.preflight = preflight;
    const stop = () => preflight.close();
    const timer = setTimeout(stop, PREFLIGHT_MS);
    timer.unref?.();
    signal.addEventListener('abort', stop, { once: true });
    let acquired;
    try {
      check(!signal.aborted, 'preflight');
      substage = 'acquire';
      acquireCalls++;
      acquired = await preflight.acquire();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
    }
    substage = 'admission';
    const observed = preflights.assertRailgunPrivatePreflight(
      preflight,
      acquired.receipt,
      ctx.enrollment
    );
    check(same(observed.input, input), 'preflight-input');
    observation = summarizePreflightObservation(observed);
    passed = true;
  } catch (error) {
    diagnostic = readPreflightDiagnostic(ctx, substage, error);
  } finally {
    try {
      preflight?.close();
    } catch {
      // Production also continues past a failed close; closeAll retries it.
    }
    ctx.preflight = undefined;
  }
  return {
    attempted: acquireCalls > 0,
    acquireCalls,
    retry: false,
    passed,
    diagnostic,
    nullifierQuery: nullifierQuery({ passed, diagnostic }),
    observation,
    elapsedMs: Math.round(performance.now() - started),
  };
}
// The disclosure review of the recovered submission, answered by fixed policy:
// the self transfer by the enrolled EOA, the original signature reused, the
// reviewed Sentio and POI destinations and exactly the reviewed exposures.
function assertRecoveryDisclosure(ctx, held, summary) {
  const origin = (value) => {
    try {
      return new URL(value).origin;
    } catch {
      return null;
    }
  };
  const { selection } = held.stored.capsule;
  const rpc = new URL(RPC_URL).origin;
  check(plainObject(summary) && plainObject(summary.destinations), 'disclosure-review');
  check(summary.purpose === 'railgun-recovered-private-submission', 'disclosure-review');
  check(
    summary.chainId === CHAIN_ID && summary.operation === SPEND_KINDS.transfer,
    'disclosure-review'
  );
  check(lower(summary.submitter) === ctx.owner, 'disclosure-review');
  check(summary.recipient === ctx.identity.descriptor.instanceId, 'disclosure-review');
  check(!Object.hasOwn(summary, 'recipientRelationship'), 'disclosure-review');
  check(
    summary.selection?.noteId === `${selection.tree}:${selection.position}`,
    'disclosure-review'
  );
  check(
    summary.selection.originalCheckpointHash === held.entry.facts.checkpointHash,
    'disclosure-review'
  );
  for (const key of ['retainedSource', 'protocolRpc', 'transactionRpc'])
    check(origin(summary.destinations[key]) === rpc, 'disclosure-review');
  check(
    summary.destinations.poi === POI_ORIGIN && summary.destinations.txid === POI_ORIGIN,
    'disclosure-review'
  );
  check(same(summary.exposures, RECOVERY_EXPOSURES), 'disclosure-review');
  check(summary.requiredList === REQUIRED_LIST, 'disclosure-review');
  check(
    summary.originalSpendingSignatureReused === true && summary.newSpendingSignature === false,
    'disclosure-review'
  );
  check(
    summary.eoaSigningAndBroadcast === true && summary.simulationBeforeTransactionReview === true,
    'disclosure-review'
  );
  check(
    summary.automaticRetry === false &&
      summary.chainStateVerified === false &&
      summary.inputCreatorDeterminedByCompletedWallet === true,
    'disclosure-review'
  );
  return {
    purpose: summary.purpose,
    operation: summary.operation,
    recipient: 'self',
    submitter: 'enrolled-eoa',
    destinationOrigins: {
      rpc,
      poi: POI_ORIGIN,
    },
    exposures: JSON.parse(JSON.stringify(RECOVERY_EXPOSURES)),
    originalSpendingSignatureReused: true,
    newSpendingSignature: false,
    automaticRetry: false,
  };
}
// The transfer mode's fixed review policy for the original proved calldata. The
// fee recheck refuses before production signs the EOA transaction.
function reviewRecoveredTransaction(ctx, held, fee, request) {
  check(plainObject(request) && plainObject(request.transaction), 'review');
  const actual = request.transaction;
  check(request.operation === SPEND_KINDS.transfer, 'review');
  check(!Object.hasOwn(request, 'recipientRelationship'), 'review');
  check(lower(request.from) === ctx.owner, 'review');
  check(lower(actual.to) === pins.proxy && BigInt(actual.value) === 0n, 'review');
  check(Number(actual.chainId) === CHAIN_ID, 'review');
  check(actual.data === held.stored.provedTransaction.data, 'review-calldata');
  check(request.maxGasFee === FEE_CAP_WEI && request.fundingAddressPublic === true, 'review');
  check(request.chainStateVerified === false, 'review');
  return reviewedFee(actual, fee.gasLimit);
}
// The held Shield input with its spent marker. Unlike shieldInput, a spent note
// is reported, never refused.
function heldShieldNote(owned, shieldTransactionHash) {
  const notes = owned.read.received.filter((note) => lower(note.txid) === shieldTransactionHash);
  check(notes.length === 1 && wethNote(notes[0]), 'input');
  const [note] = notes;
  const record = owned.ownedPoi.find((value) => value.id === note.id);
  check(record?.type === 'Shield' && lower(record.txid) === lower(note.txid), 'input-record');
  return note;
}
// Public facts only: spent or not, and the public spending transaction.
function spentStatus(note) {
  if (note.spentTxid === false) return { spent: false };
  const txid = lower(note.spentTxid);
  const value = typeof txid === 'string' && /^[0-9a-f]{64}$/.test(txid) ? '0x' + txid : txid;
  check(HASH.test(value), 'input-spent');
  return { spent: true, transactionHash: value };
}
// Experiment 1: the read-only preflight probe of the held input.
async function preflightProbe(ctx) {
  const { report, previous } = ctx;
  report.scope = JSON.parse(JSON.stringify(PROBE_SCOPE));
  report.result = 'not-completed';
  ctx.stage = 'journal';
  const before = await ctx.readJournal();
  assertHeldJournal(before, ctx.chain);
  report.liveness = describeLiveness({ holdCreated: true, spend: { journaled: false } });
  await openAccount(ctx);
  ctx.stage = 'binding';
  const current = currentPreflightBinding(ctx);
  const holdAnchor = previous.scan.anchor.number;
  ctx.stage = 'destinations';
  ctx.destinations = openDestinationConstraints(ctx);
  report.destinations = { rpcOrigins: ctx.destinations.origins };
  ctx.stage = 'hold';
  const stores = await ctx.enrollment.openPrivateRecoveryStores();
  const holdsBefore = await holdCounts(stores);
  ctx.stage = 'preflight';
  const observedAt = new Date().toISOString();
  const held = await inRecovery(stores, PROBE_PHASE_MS, async (records, context) => {
    const value = await readHeld(ctx, stores, records, context);
    assertHeldUnjournaled(before, value);
    report.hold = { ...HELD_SUMMARY };
    const input = recoveredPreflightInput({ held: value, current, holdAnchor });
    report.preflightBinding = {
      rule: 'recovered-submission',
      originalFields: ['tree', 'merkleRoot', 'nullifier'],
      currentFields: ['checkpointHash', 'minimumBlock'],
      minimumBlock: input.minimumBlock,
      holdAnchorNumber: holdAnchor,
      checkpointChangedSinceHold: true,
    };
    report.preflight = await probePreflight(ctx, input, context.signal);
    report.disclosure = {
      order: PROBE_DISCLOSURE_ORDER,
      nullifierQuery: report.preflight.nullifierQuery,
      eoa: false,
      calldata: false,
      poi: false,
      signing: false,
      broadcast: false,
    };
    context.assertCurrent();
    return value;
  });
  report.coverage = {
    scanAnchor: { number: ctx.status.to.number, hash: ctx.status.to.hash },
    holdAnchorNumber: holdAnchor,
    preflightAnchor: report.preflight.observation?.anchor ?? null,
    observedAt,
    appliesTo: 'conditions-at-observation',
  };
  ctx.stage = 'immutables';
  const reread = await inRecovery(stores, READ_PHASE_MS, (records, context) =>
    readHeld(ctx, stores, records, context)
  );
  const parts = {
    before: immutableParts({ held, journal: before, holds: holdsBefore }),
    after: immutableParts({
      held: reread,
      journal: await ctx.readJournal(),
      holds: await holdCounts(stores),
    }),
  };
  const changed = Object.keys(parts.before).filter(
    (name) => !same(parts.before[name], parts.after[name])
  );
  report.immutables = {
    unchanged: changed.length === 0,
    compared: Object.keys(parts.before),
    changed,
    holds: holdsBefore,
    expectedStoreWrites: EXPECTED_STORE_WRITES,
    wholeProfileIdentityAsserted: false,
  };
  check(changed.length === 0, 'immutables');
  // A completed probe; only result 'preflight-passed' admits recover-submit.
  report.result = report.preflight.passed === true ? 'preflight-passed' : 'preflight-refused';
  report.passed = true;
}
// ---------------------------------------------------------------------------
// The recovered submission's one-use budget: one allowance per canonical profile
// campaign, bound to the one pinned held report (HELD_TRANSFER_REPORT_SHA256).
// It is scoped to that L-A campaign, not a reusable per-hold facility: keyed by
// the profile alone, so neither a re-pinned report nor any other hold in the
// same profile mints a second allowance.
// The stable identity of the held operation, its hold id, lives only in the
// enrollment's authenticated recovery stores: readable after unlock, the Tor
// transport and the account open, never before network work. So the allowance is
// keyed by the canonical profile alone. The profile holds exactly one signing
// hold (readHeld), and every held-transfer mode binds the one pinned held report,
// refused under any other digest before profile access. The allowance file is
// named by no report digest, and the campaign directory admits nothing beside
// it, so another rendering of the same hold can never mint a second allowance.
// The hold id's digest is bound in the finished record once read.
//
// Before unlock and Tor, main() refuses a spent or damaged campaign, read-only.
// Before any account, POI, nullifier or EOA work, the mode reserves the allowance:
// creating it exclusively (O_CREAT|O_EXCL) is the lock, never released. An
// existing allowance refuses every later attempt, pending or finished, valid or
// damaged, whatever its probe, output, held report digest or outcome. A started
// attempt consumes the budget whatever ends it, a transport failure before the
// nullifier included; an interrupted one stays pending until diagnosed and
// nothing here retries. Deleting the campaign or moving the profile resets the
// budget: this is no anti-tampering control. The production journal and hold
// checks stay the independent no-double-send boundary.
// ---------------------------------------------------------------------------
const RECOVERY_LEDGER = 'railgun-l-a-recovery-ledger';
const RECOVERY_LEDGER_MAX_BYTES = 64 * 1024;
const RECOVERY_ALLOWANCE = 'recover-submit.jsonl';
const QUALIFIER = 'scripts/qualify-railgun-private-live.js';
const HOLD_ID_DOMAIN = 'railgun-l-a-recovery-hold-id\n';
// The profile's one allowance, in a sibling of the profile directory: fixed by
// the profile's canonical path alone, and outside the funded profile itself.
function recoveryLedgerPath(profile) {
  return path.join(`${profile}.l-a-recovery-ledger`, RECOVERY_ALLOWANCE);
}
function recoveryLedgerHeader(ctx) {
  return {
    type: RECOVERY_LEDGER,
    version: 1,
    journey: JOURNEY,
    chainId: CHAIN_ID,
    mode: 'recover-submit',
    budget: 1,
    profile: ctx.args.profile,
    profileId: ctx.profileId,
    heldTransferReportSha256: HELD_TRANSFER_REPORT_SHA256,
  };
}
// What the attempt is bound to, all known before any account work. The hold id
// is read only inside the attempt, so its digest lands in the finished record.
function recoveryAttemptBinding(ctx) {
  const { args, chain, previous, scan, report } = ctx;
  const sources = report?.sourceSha256;
  check(typeof ctx.profileId === 'string' && ctx.profileId.length > 0, 'recovery-binding');
  check(chain?.heldTransfer?.reportSha256 === HELD_TRANSFER_REPORT_SHA256, 'recovery-binding');
  check(
    SHA256.test(args.previousSha) && chain.heldTransfer.probeReportSha256 === args.previousSha,
    'recovery-binding'
  );
  check(SHA256.test(args.scanSha) && previous?.scan?.sha256 === args.scanSha, 'recovery-binding');
  check(
    Number.isSafeInteger(scan?.anchor?.number) && HASH.test(scan.anchor.hash),
    'recovery-binding'
  );
  check(typeof previous.observedAt === 'string', 'recovery-binding');
  check(COMMIT.test(ctx.sourceCommit), 'recovery-binding');
  check(plainObject(sources) && SHA256.test(sources[QUALIFIER]), 'recovery-binding');
  return {
    heldTransferReportSha256: HELD_TRANSFER_REPORT_SHA256,
    probeReportSha256: args.previousSha,
    probeObservedAt: previous.observedAt,
    scanReportSha256: args.scanSha,
    scanAnchor: { number: scan.anchor.number, hash: scan.anchor.hash },
    sourceCommit: ctx.sourceCommit,
    scriptSha256: sources[QUALIFIER],
    sourcesSha256: sha(JSON.stringify(sources)),
  };
}
// A file-system predicate that is false, never a throw, for an unusable path.
function holds(read) {
  try {
    return read() === true;
  } catch {
    return false;
  }
}
function syncDirectory(fsImpl, directory) {
  const fd = fsImpl.openSync(directory, 'r');
  try {
    fsImpl.fsyncSync(fd);
  } finally {
    fsImpl.closeSync(fd);
  }
}
// The whole ledger: its exact header, one attempt-pending and at most one
// attempt-finished of that attempt. Anything else is damage. No read admits.
function readRecoveryLedger(fsImpl, file, header) {
  let records;
  try {
    // lstat: a symlinked ledger is damage, never followed.
    const stat = fsImpl.lstatSync(file);
    check(stat.isFile() && stat.size <= RECOVERY_LEDGER_MAX_BYTES, 'recovery-ledger');
    const lines = fsImpl.readFileSync(file, 'utf8').split('\n');
    // A last record without its newline is a torn write, and damage too.
    check(lines.pop() === '', 'recovery-ledger');
    records = lines.map((line) => JSON.parse(line));
  } catch {
    throw refusal('recovery-ledger');
  }
  const [first, pending, finished, ...rest] = records;
  check(same(first, header), 'recovery-ledger');
  check(
    pending?.type === 'attempt-pending' &&
      pending.attempt === 1 &&
      same(pending.binding?.heldTransferReportSha256, header.heldTransferReportSha256),
    'recovery-ledger'
  );
  check(
    finished === undefined ||
      (finished?.type === 'attempt-finished' && finished.attemptId === pending.attemptId),
    'recovery-ledger'
  );
  // The held operation's stable identity, once read: a hold id digest or none.
  check(
    finished === undefined || finished.holdIdSha256 === null || SHA256.test(finished.holdIdSha256),
    'recovery-ledger'
  );
  check(rest.length === 0, 'recovery-ledger');
  return { pending, finished: finished ?? null };
}
// The profile's whole campaign directory: absent, empty, or exactly its one
// allowance. A readable allowance refuses as attempted; any other entry, a
// damaged allowance or a symlinked directory refuses as damage. Creates nothing.
function assertRecoveryUnspent(fsImpl, file, header) {
  const directory = path.dirname(file);
  let stat, names;
  try {
    stat = fsImpl.lstatSync(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw refusal('recovery-ledger');
  }
  // lstat: a symlinked campaign directory is refused, never followed.
  check(stat.isDirectory(), 'recovery-ledger');
  try {
    names = fsImpl.readdirSync(directory);
  } catch {
    throw refusal('recovery-ledger');
  }
  if (names.length === 0) return;
  // Another ledger name beside the allowance (another digest, another
  // rendering) is never a second allowance.
  check(names.length === 1 && names[0] === path.basename(file), 'recovery-ledger');
  readRecoveryLedger(fsImpl, file, header);
  throw refusal('recovery-attempted');
}
// The canonical profile, the complete binding and an unspent campaign, or a
// refusal. Read-only.
function recoveryAdmission(ctx) {
  const fsImpl = ctx.fs,
    profile = ctx.args?.profile;
  // The profile main() opened: a real directory under its canonical path.
  check(
    holds(
      () => fsImpl.lstatSync(profile).isDirectory() && fsImpl.realpathSync(profile) === profile
    ),
    'recovery-binding'
  );
  const binding = recoveryAttemptBinding(ctx);
  const header = recoveryLedgerHeader(ctx);
  const file = recoveryLedgerPath(profile);
  assertRecoveryUnspent(fsImpl, file, header);
  return { fsImpl, binding, header, file };
}
// main() before unlock and Tor: refuses without creating the campaign.
function assertRecoveryAdmissible(ctx) {
  recoveryAdmission(ctx);
}
// Reserves the one attempt, or refuses before anything else of the mode runs.
// Returns only after the pending record and its directory entry are synced.
function reserveRecoveryAttempt(ctx) {
  const { fsImpl, binding, header, file } = recoveryAdmission(ctx);
  const directory = path.dirname(file);
  const created = holds(() => fsImpl.mkdirSync(directory, { mode: 0o700 }) === undefined);
  // lstat: a symlinked ledger directory is refused, never followed.
  check(
    holds(() => fsImpl.lstatSync(directory).isDirectory()),
    'recovery-ledger'
  );
  if (created) syncDirectory(fsImpl, path.dirname(directory));
  const line = JSON.stringify({
    type: 'attempt-pending',
    attempt: 1,
    attemptId: randomBytes(16).toString('hex'),
    reservedAt: new Date().toISOString(),
    pid: process.pid,
    // Diagnostics only: neither path decides anything.
    output: ctx.args.output,
    probeReport: ctx.args.previousFile,
    binding,
  });
  let fd;
  try {
    fd = fsImpl.openSync(file, 'wx', 0o600);
  } catch {
    // An attempt took the allowance since the admission read. Damage, or any
    // other failed create, refuses as damage and is never read as absent.
    assertRecoveryUnspent(fsImpl, file, header);
    throw refusal('recovery-ledger');
  }
  try {
    const bytes = Buffer.from(JSON.stringify(header) + '\n' + line + '\n');
    check(fsImpl.writeSync(fd, bytes) === bytes.length, 'recovery-ledger');
    fsImpl.fsyncSync(fd);
  } finally {
    fsImpl.closeSync(fd);
  }
  syncDirectory(fsImpl, directory);
  return Object.freeze({ file, header, pending: JSON.parse(line) });
}
// Appends the attempt's outcome once. A ledger that is no longer exactly this
// attempt's pending record stays as it is, keeps refusing, and fails the report.
function finishRecoveryAttempt(ctx, reservation, failure) {
  const { report } = ctx;
  try {
    const fsImpl = ctx.fs;
    const current = readRecoveryLedger(fsImpl, reservation.file, reservation.header);
    check(
      same(current.pending, reservation.pending) && current.finished === null,
      'recovery-ledger'
    );
    const finished = {
      type: 'attempt-finished',
      attempt: 1,
      attemptId: reservation.pending.attemptId,
      finishedAt: new Date().toISOString(),
      holdIdSha256: ctx.holdIdSha256 ?? null,
      outcome: {
        stage: ctx.stage,
        failure: failure ? sanitizeFailure(ctx.stage, failure.error) : null,
        submission: report.submission?.status ?? null,
        spend: JSON.parse(JSON.stringify(report.spend)),
        passed: report.passed === true,
      },
    };
    const bytes = Buffer.from(JSON.stringify(finished) + '\n');
    const fd = fsImpl.openSync(reservation.file, 'a');
    try {
      check(fsImpl.writeSync(fd, bytes) === bytes.length, 'recovery-ledger');
      fsImpl.fsyncSync(fd);
    } finally {
      fsImpl.closeSync(fd);
    }
    report.reservation.finished = true;
  } catch {
    report.passed = false;
  }
}
// Experiment 2: production recovered submission of the held proved input. The
// original spending signature and proof are reused: no proving, no spending-key
// use, no hold release or discard, and at most one journaled send.
async function recoverSubmit(ctx) {
  const { report } = ctx;
  const { archive, proverArchive, artifactDirectory } = ctx.args;
  ctx.stage = 'journal';
  const before = await ctx.readJournal();
  assertHeldJournal(before, ctx.chain);
  await openAccount(ctx);
  ctx.stage = 'hold';
  const stores = await ctx.enrollment.openPrivateRecoveryStores();
  const held = await inRecovery(stores, READ_PHASE_MS, (records, context) =>
    readHeld(ctx, stores, records, context)
  );
  assertHeldUnjournaled(before, held);
  // Only a digest of the hold id leaves recovery, into the local ledger.
  ctx.holdIdSha256 = sha(HOLD_ID_DOMAIN + held.entry.id);
  report.hold = { ...HELD_SUMMARY };
  ctx.stage = 'submitter';
  report.submitter = await submitterChecks(ctx);
  ctx.stage = 'fee-cap';
  // The held transfer's own estimate: no calldata leaves before production's
  // ordered disclosure review, and production refuses a higher estimate.
  const fee = planSubmissionFee({
    estimate: ctx.chain.heldTransfer.estimate,
    gasPrice: ctx.quotedGasPrice,
  });
  check(fee.gasLimit === ctx.chain.heldTransfer.gasLimit, 'fee-plan');
  report.fee = {
    plan: fee,
    estimateSource: 'held-transfer-report',
    headroomReason: GAS_HEADROOM_REASON,
  };
  ctx.stage = 'destination';
  const destination = ctx
    .load('wallet/railgun-account-public')
    .getRailgunAccountPublicDestination(ctx.publicAccount.coordinator, ctx.enrollment);
  ctx.stage = 'submission';
  const reviews = { disclosure: 0, transaction: 0 };
  const maxGasFee = FEE_CAP_WEI;
  const started = performance.now();
  // Until the journal is read back, a send may have happened.
  report.spend = {
    attempted: null,
    journaled: null,
    submissionStatus: 'unknown',
    resendAllowed: false,
  };
  const result = await ctx
    .load('wallet/railgun-private-submission')
    .submitRailgunRecoveredPrivateTransaction({
      identity: ctx.identity,
      enrollment: ctx.enrollment,
      coordinator: ctx.publicAccount.coordinator,
      destination,
      archive,
      proverArchive,
      artifactDirectory,
      holdId: held.entry.id,
      reviewDisclosures: async (summary) => {
        check(++reviews.disclosure === 1, 'review-repeated');
        report.recovery = { disclosure: assertRecoveryDisclosure(ctx, held, summary) };
        return true;
      },
      reviewTransaction: async (request) => {
        check(++reviews.transaction === 1, 'review-repeated');
        report.fee.reviewed = reviewRecoveredTransaction(ctx, held, fee, request);
        return true;
      },
      gasLimit: BigInt(fee.gasLimit),
      maxGasFee,
      signal: ctx.enrollment.signal,
      timeoutMs: RECOVERY_TIMEOUT_MS,
    });
  await recordSubmission(ctx, { result, before, started, reviews });
  // Uncertain or acknowledged, a journaled attempt continues only in observe.
  if (report.spend.journaled) ctx.chain.transfer = { hash: report.spend.journaledHash };
  report.passed = report.spend.submissionStatus === 'acknowledged';
}
const RUNNERS = {
  async 'check-transfer'(ctx) {
    ctx.stage = 'journal';
    const snapshot = await ctx.readJournal();
    assertShieldRecord(snapshot, ctx.chain.shieldTransactionHash);
    assertSpendAdmission(snapshot, 'transfer', ctx.chain);
    await openAccount(ctx);
    const note = shieldInput(await openWallet(ctx), ctx.chain.shieldTransactionHash);
    ctx.stage = 'preparation';
    const request = spendRequest(ctx, 'transfer', note);
    ctx.report.preparation = await readOnlyPreparation(ctx, request, note);
    ctx.stage = 'submitter';
    ctx.report.submitter = await submitterChecks(ctx);
    ctx.report.passed = true;
  },
  async transfer(ctx) {
    await spend(ctx, 'transfer');
  },
  async observe(ctx) {
    const { report, previous, chain } = ctx;
    const target = observedTarget(previous);
    ctx.stage = 'journal';
    const record = selectObservedRecord(
      await ctx.readJournal(),
      target,
      chain,
      observedHash(previous)
    );
    const hash = record.hash;
    report.target = target;
    report.observedHash = hash;
    const expectedAmount = chain.unshield?.amount ?? previous.spendRequest?.amount;
    if (target === 'unshield') check(/^[1-9][0-9]*$/.test(expectedAmount ?? ''), 'observe-amount');
    ctx.stage = 'observe';
    ctx.recovery = ctx
      .load('wallet/railgun-transact-recovery')
      .openRailgunTransactRecovery(ctx.owner);
    const observed = await ctx.recovery.observe(hash);
    report.observation = summarizeObservation(observed.record);
    report.transact = summarizeTransact(observed.transact);
    const status = report.observation.status;
    if (['included', 'reverted'].includes(status)) {
      ctx.stage = 'receipt';
      const { result: receipt } = await ctx.network.request(CHAIN_ID, 'eth_getTransactionReceipt', [
        hash,
      ]);
      report.gas = summarizeReceiptGas(receipt);
      chain[target] = { ...chain[target], hash, blockNumber: report.observation.blockNumber };
    }
    const ready =
      (report.transact?.status === 'matched' || status === 'reverted') &&
      report.observation.confirmations >= MIN_CONFIRMATIONS;
    if (record.resolution) report.resolved = summarizeResolution(record);
    else if (ready) {
      ctx.stage = 'finality';
      const { result: finalized } = await ctx.network.request(CHAIN_ID, 'eth_getBlockByNumber', [
        'finalized',
        false,
      ]);
      if (BigInt(finalized.number) >= BigInt(report.observation.blockNumber)) {
        ctx.stage = 'resolve';
        await ctx.recovery.resolve(hash, {
          minimumConfirmations: MIN_CONFIRMATIONS,
          review: async (request) => {
            const transact = request.transact;
            if (transact) {
              check(transact.status === 'matched', 'resolution');
              check(transact.operation === SPEND_KINDS[target], 'resolution');
              if (target === 'transfer') check(transact.output?.kind === 'shielded', 'resolution');
              else {
                check(transact.output?.kind === 'unshield', 'resolution');
                check(lower(transact.output.recipient) === ctx.owner, 'resolution');
                check(transact.output.amount === expectedAmount, 'resolution');
              }
            }
            return { allowNextTransaction: true, acceptedEvidence: 'unverified-rpc' };
          },
        });
        const settled = (await ctx.recovery.list()).find((value) => value.hash === hash);
        report.resolved = summarizeResolution(settled);
        check(report.resolved !== null, 'resolution');
      }
    }
    report.passed = true;
  },
  async 'poi-submit'(ctx) {
    const { report } = ctx;
    const { archive, proverArchive, artifactDirectory } = ctx.args;
    ctx.stage = 'journal';
    const snapshot = await ctx.readJournal();
    assertTransferSettled(snapshot, ctx.chain);
    const transferRecord = transactRecords(snapshot)[0];
    await openAccount(ctx);
    const common = {
      identity: ctx.identity,
      enrollment: ctx.enrollment,
      coordinator: ctx.publicAccount.coordinator,
      archive,
      signal: ctx.enrollment.signal,
    };
    ctx.stage = 'selector';
    const { reservations } = await ctx.enrollment.openPrivateRecoveryStores();
    // The hold's private facts stay in memory for their production consumers.
    const selector = await reservations.withSigningRecovery(async (records, context) => {
      try {
        context.assertCurrent();
        const matches = records.filter(
          (value) => value.entry.facts.intentDigest === transferRecord.intent.intentDigest
        );
        if (matches.length !== 1) return null;
        const { entry } = matches[0];
        if (lower(entry.signing?.submitter) !== ctx.owner) return null;
        if (entry.facts.nullifier !== transferRecord.intent.nullifier) return null;
        if (entry.facts.tree !== transferRecord.intent.tree) return null;
        context.assertCurrent();
        return Object.freeze({
          tree: entry.facts.tree,
          position: entry.facts.position,
          nullifier: entry.facts.nullifier,
          noteHash: entry.facts.noteHash,
        });
      } catch {
        return null;
      }
    });
    check(plainObject(selector), 'selector');
    ctx.stage = 'capture';
    const captured = await ctx.load('wallet/railgun-own-operation').captureRailgunOwnOperation({
      enrollment: ctx.enrollment,
      selector,
      signal: ctx.enrollment.signal,
    });
    check(captured.status === 'captured', 'capture');
    const selection = captured.capture.capsule.selection;
    check(selection.kind === SPEND_KINDS.transfer, 'capture');
    check(!Object.hasOwn(selection, 'recipientRelationship'), 'capture');
    const capsuleDigest = captured.capture.capsuleDigest;
    ctx.stage = 'intent-store';
    ctx.store = await ctx.enrollment.openPoiIntents();
    const entries = async () =>
      (await ctx.store.list()).filter((value) => value.capsuleDigest === capsuleDigest);
    const existing = await entries();
    check(existing.length <= 1, 'intent-store');
    // One POI submission attempt per output: an attempted entry is never resent.
    check(existing[0]?.state !== 'attempted', 'poi-attempted');
    report.ownPoi = { resumedPreparedEntry: existing[0]?.state === 'prepared' };
    if (!existing.length) {
      ctx.stage = 'membership';
      const membershipStarted = performance.now();
      ctx.membership = await ctx
        .load('wallet/railgun-own-poi-membership')
        .openRailgunOwnPoiMembership({
          enrollment: ctx.enrollment,
          coordinator: ctx.publicAccount.coordinator,
          archive,
          signal: ctx.enrollment.signal,
          selector,
        });
      report.ownPoi.membership = {
        status: ctx.membership.status,
        ...(ctx.membership.stage ? { stage: ctx.membership.stage } : {}),
        elapsedMs: Math.round(performance.now() - membershipStarted),
      };
      check(ctx.membership.status === 'verified', 'membership');
      ctx.stage = 'own-poi-proof';
      const proofStarted = performance.now();
      const proved = await ctx.load('wallet/railgun-own-poi-proof').proveRailgunOwnPoi({
        ...common,
        proverArchive,
        artifactDirectory,
        membershipReceipt: ctx.membership.receipt,
      });
      const outputs = proved.payload?.blindedCommitmentsOut;
      report.ownPoi.proving = {
        status: proved.status,
        ...(proved.stage ? { stage: proved.stage } : {}),
        separatelyVerified: proved.separatelyVerified === true,
        outputCount: Array.isArray(outputs) ? outputs.length : null,
        elapsedMs: Math.round(performance.now() - proofStarted),
      };
      check(proved.status === 'proved' && proved.separatelyVerified === true, 'own-poi-proof');
      check(report.ownPoi.proving.outputCount === 1, 'own-poi-proof');
      ctx.membership.close();
      await ctx.membership.closed;
      ctx.membership = undefined;
      ctx.stage = 'prepare';
      const prepared = await ctx.store.prepare({
        proof: proved,
        coordinator: ctx.publicAccount.coordinator,
        signal: ctx.enrollment.signal,
      });
      report.ownPoi.prepared = {
        status: prepared.status,
        ...(prepared.stage ? { stage: prepared.stage } : {}),
      };
      check(prepared.status === 'prepared', 'prepare');
    }
    ctx.stage = 'plan';
    const plans = ctx.load('wallet/railgun-poi-disclosure-plan');
    ctx.plan = await plans.prepareRailgunPoiDisclosurePlan({
      identity: ctx.identity,
      enrollment: ctx.enrollment,
      coordinator: ctx.publicAccount.coordinator,
      capsuleDigest,
      signal: ctx.enrollment.signal,
    });
    check(ctx.plan.status === 'prepared', 'plan');
    const summary = ctx.plan.summary;
    check(summary.operation === 'transfer' && summary.outputCount === 1, 'plan');
    check(summary.listKey === REQUIRED_LIST && summary.endpoint === POI_ORIGIN, 'plan');
    check(!Object.hasOwn(summary, 'recipientRelationship'), 'plan');
    report.ownPoi.plan = {
      operation: summary.operation,
      outputCount: summary.outputCount,
      listKey: summary.listKey,
      requestInventory: summary.requestInventory,
      disclosureCategories: summary.disclosureCategories,
    };
    ctx.stage = 'poi-submission';
    const purposes = [];
    const rpcOrigin = new URL(RPC_URL).origin;
    const submitStarted = performance.now();
    const result = await plans.submitRailgunRetainedPoi({
      ...common,
      proverArchive,
      artifactDirectory,
      plan: ctx.plan.plan,
      review: async (request) => {
        purposes.push(request.purpose);
        check(purposes.length <= 2, 'poi-review');
        const submitting = purposes.length === 2;
        check(
          request.purpose === (submitting ? 'submit-retained-poi' : 'validate-retained-poi'),
          'poi-review'
        );
        check(request.operation === 'transfer' && request.outputCount === 1, 'poi-review');
        check(request.listKey === REQUIRED_LIST && request.chainId === CHAIN_ID, 'poi-review');
        check(request.unshieldIdCategory === 'absent', 'poi-review');
        check(!Object.hasOwn(request, 'recipientRelationship'), 'poi-review');
        const expected = submitting
          ? [{ role: 'poi-service', origin: POI_ORIGIN }]
          : [
              { role: 'source-rpc', origin: rpcOrigin },
              { role: 'receipt-rpc', origin: rpcOrigin },
              { role: 'poi-service', origin: POI_ORIGIN },
            ];
        check(same(request.destinations, expected), 'poi-review');
        return true;
      },
    });
    const assessment = assessPoiSubmission({ result, entryState: (await entries())[0]?.state });
    report.poiSubmission = {
      ...assessment,
      reviews: purposes,
      elapsedMs: Math.round(performance.now() - submitStarted),
    };
    // Passed means delivered with a matching rpc-result, never accepted.
    report.passed = assessment.delivered;
  },
  async recover(ctx) {
    ctx.stage = 'journal';
    assertTransferSettled(await ctx.readJournal(), ctx.chain);
    await openAccount(ctx);
    const owned = await openWallet(ctx);
    ctx.stage = 'output';
    const output = transferOutput(owned, ctx.chain.transfer.hash);
    const inputs = owned.read.received.filter(
      (note) => lower(note.txid) === ctx.chain.shieldTransactionHash
    );
    check(inputs.length === 1 && inputs[0].spentTxid !== false, 'input-unspent');
    ctx.report.recovered = {
      coldRestore: true,
      outputRecovered: output.spentTxid === false,
      outputType: 'Transact',
      outputEqualsInputValue: output.amount === inputs[0].amount,
      inputSpent: true,
      walletThrough: ctx.status.to,
    };
    check(ctx.report.recovered.outputRecovered, 'output-spent');
    check(ctx.report.recovered.outputEqualsInputValue, 'output-value');
    ctx.report.passed = true;
  },
  async status(ctx) {
    ctx.stage = 'journal';
    assertTransferSettled(await ctx.readJournal(), ctx.chain);
    await openAccount(ctx);
    const output = transferOutput(await openWallet(ctx), ctx.chain.transfer.hash);
    check(output.spentTxid === false, 'output-spent');
    ctx.stage = 'poi';
    const api = ctx.load('wallet/railgun-account-poi');
    ctx.poi = api.openRailgunAccountPoi({
      wallet: ctx.wallet,
      ...ctx.owners,
      archive: ctx.args.archive,
      noteIds: [output.id],
    });
    const started = performance.now();
    const acquired = await ctx.poi.acquire();
    const value = api.assertRailgunAccountPoi(ctx.poi, acquired.receipt, ctx.wallet, ctx.owners);
    ctx.report.poi = summarizeOwnedPoi(value, Math.round(performance.now() - started));
    // passed is a completed read; only poi.allValid admits the unshield.
    ctx.report.passed = true;
  },
  async 'check-unshield'(ctx) {
    ctx.stage = 'journal';
    assertSpendAdmission(await ctx.readJournal(), 'unshield', ctx.chain);
    await openAccount(ctx);
    const output = transferOutput(await openWallet(ctx), ctx.chain.transfer.hash);
    check(output.spentTxid === false, 'output-spent');
    ctx.stage = 'preparation';
    const request = spendRequest(ctx, 'unshield', output);
    ctx.report.preparation = await readOnlyPreparation(ctx, request, output);
    ctx.report.spendRequest = {
      kind: request.kind,
      recipient: 'enrolled-eoa',
      recipientAddress: ctx.owner,
      amount: output.amount.toString(),
      fullInputValue: true,
      amountWithinCeiling: true,
    };
    ctx.stage = 'submitter';
    ctx.report.submitter = await submitterChecks(ctx);
    ctx.report.passed = true;
  },
  async unshield(ctx) {
    await spend(ctx, 'unshield');
  },
  // Experiment 0: the held input's spent marker through the scan's anchor only.
  async 'spent-read'(ctx) {
    ctx.stage = 'journal';
    assertHeldJournal(await ctx.readJournal(), ctx.chain);
    await openAccount(ctx);
    const owned = await openWallet(ctx);
    const readAt = new Date().toISOString();
    ctx.stage = 'input';
    // Never the nullifier, root or hold id. The scan report records its anchor
    // as number and hash only (openAccount requires exactly that), not a block
    // time; the anchor was a finalized block when the scan began (scanObservedAt).
    // Nothing after the anchor is observed, at readAt or otherwise.
    ctx.report.input = {
      ...spentStatus(heldShieldNote(owned, ctx.chain.shieldTransactionHash)),
      through: { number: ctx.status.to.number, hash: ctx.status.to.hash },
      scanObservedAt: isoTime(ctx.scan.observedAt),
      readAt,
      observedThroughAnchorOnly: true,
    };
    ctx.report.passed = true;
  },
  async 'preflight-probe'(ctx) {
    await preflightProbe(ctx);
  },
  async 'recover-submit'(ctx) {
    const { report } = ctx;
    report.spend = {
      attempted: false,
      journaled: false,
      submissionStatus: 'not-sent',
      resendAllowed: false,
    };
    let reservation = null,
      failure = null;
    try {
      // Nothing of the attempt runs before its durable one-use reservation.
      ctx.stage = 'reservation';
      reservation = reserveRecoveryAttempt(ctx);
      report.reservation = {
        ledger: 'profile-sibling',
        budget: 1,
        reservedBeforeAccountWork: true,
        finished: false,
      };
      await recoverSubmit(ctx);
    } catch (error) {
      failure = { error };
      throw error;
    } finally {
      // The input was already held when this mode started.
      report.liveness = describeLiveness({ holdCreated: true, spend: report.spend });
      if (reservation) finishRecoveryAttempt(ctx, reservation, failure);
    }
  },
};

if (
  require.main === module ||
  (process.versions.electron &&
    process.type === 'browser' &&
    typeof process.argv[1] === 'string' &&
    path.resolve(process.argv[1]) === path.resolve(__filename))
) {
  process.on('unhandledRejection', () => {
    backgroundFailure = true;
    console.error('Railgun live journey background failure');
  });
  main().then(
    (code) => {
      if (lock) require('../src/main/profile-lock').releaseProfileLock(lock);
      require('electron').app.exit(code);
    },
    () => {
      if (lock) require('../src/main/profile-lock').releaseProfileLock(lock);
      console.error('Railgun live journey refused');
      require('electron').app.exit(1);
    }
  );
}

module.exports = {
  JOURNEY,
  CHAIN_ID,
  REQUIRED_LIST,
  POI_ORIGIN,
  RPC_URL,
  FEE_CAP_WEI,
  GAS_LIMIT_CEILING,
  GAS_HEADROOM,
  PLANNING_GAS_LIMIT,
  MIN_CONFIRMATIONS,
  MODES,
  SPEND_KINDS,
  FIXED_SOURCES,
  SOURCE_DIRECTORIES,
  HELD_TRANSFER_REPORT_SHA256,
  REBASED_MODES,
  RECOVERY_EXPOSURES,
  RECOVERY_TIMEOUT_MS,
  PROBE_MAX_AGE_MS,
  PROBE_SCOPE,
  PROBE_DISCLOSURE_ORDER,
  parseArguments,
  recoveryLedgerPath,
  readRecoveryLedger,
  assertRecoveryAdmissible,
  reserveRecoveryAttempt,
  feeExposure,
  assertFeeWithinCap,
  gasLimitFromEstimate,
  planSubmissionFee,
  planningFeeCheck,
  reviewedFee,
  transactRecords,
  assertJournalResolved,
  assertShieldRecord,
  assertSpendAdmission,
  assertTransferSettled,
  assertHeldJournal,
  assertHeldUnjournaled,
  selectObservedRecord,
  classifySpendOutcome,
  journeySourceNames,
  changedSources,
  assertSourcesMatch,
  assertSameSources,
  assertSameRuntime,
  assertSameProofRuntime,
  assertScanReport,
  assertOwnedPoiReport,
  assertHeldTransferReport,
  assertPredecessor,
  nextChain,
  summarizeObservation,
  summarizeTransact,
  summarizeResolution,
  summarizeReceiptGas,
  summarizeOwnedPoi,
  summarizePoiResponse,
  sanitizeFailure,
  DIAGNOSTIC_CAUSE_STAGES,
  summarizeSubmissionDiagnostic,
  nullifierQuery,
  summarizePreflightObservation,
  recoveredPreflightInput,
  assertRecoveredPreflightInput,
  assertAggregateReport,
  renderReport,
  assessPoiSubmission,
  describeLiveness,
  dependencyIdentity,
  listSourceFiles,
  shieldInput,
  transferOutput,
  heldShieldNote,
  spentStatus,
  spend,
  RUNNERS,
  main,
};
