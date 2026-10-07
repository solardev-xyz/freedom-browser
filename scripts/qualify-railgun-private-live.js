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
 * MODE: check-transfer|transfer|observe|poi-submit|recover|status|check-unshield|unshield
 * check-transfer takes the owned-POI report of qualify-railgun-owned-poi-live.js.
 *
 * Publication: only NEW_OUTPUT/report.json is publishable. NEW_OUTPUT/transport/
 * holds the Arti state and arti.log and stays local.
 *
 * Stuck states (report.liveness). Neither has a continuation in this script;
 * each needs a separately authorized recovery step:
 * - proved-unsent: a refusal after proving (fee cap, completion expiry,
 *   preflight) leaves the input held in signing state. Any later spend of it
 *   is refused with RAILGUN_PRIVATE_INPUT_RESERVED.
 * - journaled-uncertain: a journaled attempt whose send is unknown. If its
 *   deadline expired between the journal write and the broadcast, it was never
 *   sent, and observe cannot resolve it.
 * D2 never proves service acceptance. The status mode (D3) is the acceptance gate.
 */
const fs = require('fs'),
  path = require('path');
const { createHash } = require('crypto');
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
// Observe follows a spend report, or its check report after a lost spend report.
function observedTarget(previous) {
  if (previous.mode === 'observe') return previous.target;
  return { transfer: 'transfer', unshield: 'unshield' }[previous.mode.replace(/^check-/, '')];
}
function observedHash(previous) {
  if (previous.mode === 'observe') return previous.observedHash;
  return ['transfer', 'unshield'].includes(previous.mode) ? previous.spend.journaledHash : null;
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
function assertPredecessor(mode, previous, { scanSha, scan }) {
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
      if (['transfer', 'unshield'].includes(previous.mode)) {
        // A failed or uncertain spend is still observed once it is journaled.
        check(previous.spend?.journaled === true, 'predecessor');
        check(HASH.test(previous.spend.journaledHash), 'predecessor');
        return;
      }
      if (['check-transfer', 'check-unshield'].includes(previous.mode)) {
        check(previous.passed === true, 'predecessor');
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
    default:
      throw refusal('mode');
  }
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
  };
  let client, vault;
  try {
    // Pinned predecessor, scan, sources and runtime before any profile access.
    const scan = readPinnedReport(args.scanFile, args.scanSha);
    const previous = readPinnedReport(args.previousFile, args.previousSha);
    assertScanReport(scan);
    assertPredecessor(mode, previous, { scanSha: args.scanSha, scan });
    const names = journeySourceNames({ listed: listSourceFiles(base), scan, previous });
    const hashes = () =>
      Object.fromEntries(names.map((name) => [name, sha(fs.readFileSync(path.join(base, name)))]));
    const sourceSha256 = hashes();
    assertSourcesMatch(scan.sourceSha256, sourceSha256, 'scan-sources');
    if (mode === 'check-transfer')
      assertSourcesMatch(previous.sourceSha256, sourceSha256, 'predecessor-sources');
    else assertSameSources(previous.sourceSha256, sourceSha256);
    const runtime = hashRuntime(args, base);
    if (mode !== 'check-transfer') assertSameRuntime(previous.runtime, runtime);
    report.previous.mode = mode === 'check-transfer' ? 'owned-poi' : previous.mode;
    report.scan.anchor = { number: scan.anchor.number, hash: scan.anchor.hash };
    report.chain = nextChain(mode, previous, args.previousSha);
    report.sourceSha256 = sourceSha256;
    report.runtime = runtime;
    Object.assign(ctx, { scan, previous, chain: report.chain });

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
    check(safeStorage.isEncryptionAvailable(), 'profile');
    if (process.platform === 'linux')
      check(safeStorage.getSelectedStorageBackend() !== 'basic_text', 'profile');
    vault = require('../src/main/identity/vault');
    check(vault.vaultExists(path.join(directory, 'identity')), 'profile');

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
    })
  );
  return report.passed ? 0 : 1;
}
async function closeAll(ctx) {
  // Reverse acquisition order. A failed close never skips the remaining owners.
  const steps = [
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
  report.submission = {
    status:
      typeof result?.hash === 'string'
        ? 'acknowledged'
        : typeof result?.transactionHash === 'string'
          ? 'unknown'
          : 'refused',
    ...(typeof result?.stage === 'string' ? { stage: result.stage } : {}),
    reviews,
    elapsedMs: Math.round(performance.now() - submitStarted),
  };
  ctx.stage = 'journal-readback';
  report.spend = classifySpendOutcome({ result, before, after: await ctx.readJournal() });
  // Aggregate only; printed at once so a later drain failure cannot hide it.
  console.log(JSON.stringify({ spend: report.spend }));
  if (report.spend.journaled)
    ctx.chain[step] = {
      hash: report.spend.journaledHash,
      ...(step === 'unshield' ? { amount: note.amount.toString() } : {}),
    };
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
  parseArguments,
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
  selectObservedRecord,
  classifySpendOutcome,
  journeySourceNames,
  changedSources,
  assertSourcesMatch,
  assertSameSources,
  assertSameRuntime,
  assertScanReport,
  assertOwnedPoiReport,
  assertPredecessor,
  nextChain,
  summarizeObservation,
  summarizeTransact,
  summarizeResolution,
  summarizeReceiptGas,
  summarizeOwnedPoi,
  summarizePoiResponse,
  sanitizeFailure,
  assertAggregateReport,
  renderReport,
  assessPoiSubmission,
  describeLiveness,
  dependencyIdentity,
  listSourceFiles,
  shieldInput,
  transferOutput,
  spend,
  RUNNERS,
};
