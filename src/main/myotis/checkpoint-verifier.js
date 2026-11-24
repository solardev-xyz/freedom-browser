// Checkpoint recovery belongs to the node service. Each verification attempt has
// its own verifier and store, independent of chain reads' Colibri processes:
// a one-shot freedom-colibrid process (checkpoint-colibrid.js).

const DEADLINE_MS = 90_000;
const MAX_AGE_MS = 60 * 60 * 1000;
const CHECKPOINT_NETWORKS = Object.freeze({
  1: Object.freeze({
    network: 'mainnet',
    // Also serves as Colibri's intercepted request origin and the legacy v1 source.
    source: 'https://mainnet.checkpoint.sigp.io',
    sources: Object.freeze([
      'https://mainnet.checkpoint.sigp.io',
      'https://beaconstate.ethstaker.cc',
      'https://beaconstate-mainnet.chainsafe.io',
      'https://mainnet-checkpoint-sync.attestant.io',
      'https://sync-mainnet.beaconcha.in',
      'https://checkpointz.pietjepuk.net',
      'https://mainnet-checkpoint-sync.stakely.io',
    ]),
    participants: 3,
    threshold: 2,
    prover: 'https://mainnet1.colibri-proof.tech',
    genesis: 1606824023,
    secondsPerSlot: 12,
    slotsPerEpoch: 32,
  }),
  100: Object.freeze({
    network: 'gnosis',
    source: 'https://checkpoint.gnosischain.com',
    sources: Object.freeze([
      'https://checkpoint.gnosischain.com',
      'https://checkpoint-sync-gnosis.dappnode.net',
      'https://gnosis-beacon-api.publicnode.com',
    ]),
    // Standard Beacon APIs must explicitly mark the requested block finalized.
    beaconSources: Object.freeze(['https://gnosis-beacon-api.publicnode.com']),
    participants: 3,
    threshold: 2,
    prover: 'https://gnosis.colibri-proof.tech',
    genesis: 1638993340,
    secondsPerSlot: 5,
    slotsPerEpoch: 16,
  }),
});
const ERROR_MESSAGES = Object.freeze({
  CHECKPOINT_QUORUM_UNAVAILABLE: 'Not enough checkpoint sources could confirm a recent checkpoint. Try again.',
  CHECKPOINT_QUORUM_CONFLICT: 'Checkpoint sources disagree. Sync is paused.',
  CHECKPOINT_UNAVAILABLE: 'The checkpoint service could not complete verification. Try again.',
  CHECKPOINT_INCOMPATIBLE: 'This checkpoint verifier is incompatible. Update Freedom to try again.',
  CHECKPOINT_MISMATCH: 'The checkpoint evidence did not pass verification.',
  CHECKPOINT_STALE: 'The checkpoint is too old. Try again for a recent checkpoint.',
  CHECKPOINT_RACE: 'The finalized checkpoint changed during verification. Try again.',
  CHECKPOINT_CLOCK: 'The checkpoint time does not agree with this computer’s clock.',
});

function checkpointError(code) {
  const safeCode = Object.hasOwn(ERROR_MESSAGES, code) ? code : 'CHECKPOINT_UNAVAILABLE';
  const error = new Error(ERROR_MESSAGES[safeCode]);
  error.code = safeCode;
  return error;
}

function networkFor(chainId) {
  if (typeof chainId !== 'number' || !Object.hasOwn(CHECKPOINT_NETWORKS, chainId)) {
    throw checkpointError('CHECKPOINT_MISMATCH');
  }
  return CHECKPOINT_NETWORKS[chainId];
}

// Revalidate the narrow verifier result before allowing it into lifecycle/storage
// code. This also gives persisted checkpoints the same chain and freshness rules.
function validateCheckpoint(value, chainId, { now = Date.now(), fresh = true } = {}) {
  const config = networkFor(chainId);
  // Existing generations retain their original trust policy. New recovery and
  // verifier results always require v2 quorum provenance, even for fresh v1 records.
  const legacy = !fresh && value?.schemaVersion === 1 && value.source === config.source;
  const quorum = value?.schemaVersion === 2 &&
    Array.isArray(value.sources) &&
    value.sources.length >= config.threshold &&
    value.sources.length <= config.participants &&
    new Set(value.sources).size === value.sources.length &&
    value.sources.every((source) => config.sources.includes(source));
  if (
    !value ||
    (!legacy && !quorum) ||
    value.chainId !== chainId ||
    value.network !== config.network ||
    typeof value.root !== 'string' ||
    !/^0x[0-9a-f]{64}$/.test(value.root) ||
    /^0x0{64}$/.test(value.root) ||
    !Number.isSafeInteger(value.slot) ||
    value.slot <= 0 ||
    !Number.isSafeInteger(value.finalizedEpoch) ||
    value.finalizedEpoch < 0 ||
    !Number.isSafeInteger(value.verifiedAt) ||
    value.verifiedAt <= 0
  ) {
    throw checkpointError('CHECKPOINT_MISMATCH');
  }
  const slotTime = (config.genesis + value.slot * config.secondsPerSlot) * 1000;
  const epochSlot = value.finalizedEpoch * config.slotsPerEpoch;
  if (!Number.isSafeInteger(slotTime) || !Number.isSafeInteger(epochSlot) || epochSlot < value.slot)
    throw checkpointError('CHECKPOINT_MISMATCH');
  if (value.verifiedAt < slotTime) throw checkpointError('CHECKPOINT_MISMATCH');
  const wallSlot = Math.floor((now / 1000 - config.genesis) / config.secondsPerSlot);
  if (
    fresh &&
    (!Number.isSafeInteger(now) || slotTime > now || epochSlot > wallSlot || value.verifiedAt > now)
  ) {
    throw checkpointError('CHECKPOINT_CLOCK');
  }
  if (fresh && now - slotTime > MAX_AGE_MS) throw checkpointError('CHECKPOINT_STALE');
  return {
    schemaVersion: legacy ? 1 : 2,
    chainId,
    network: config.network,
    root: value.root,
    slot: value.slot,
    verifiedAt: value.verifiedAt,
    ...(legacy ? { source: config.source } : { sources: [...value.sources] }),
    finalizedEpoch: value.finalizedEpoch,
  };
}

// The checkpoint for `chainId`, verified by freedom-colibrid's one-shot
// `checkpoint` process. Required lazily: checkpoint-colibrid.js requires this
// module for its errors and its network table.
function acquireCheckpoint(chainId, options = {}) {
  return require('./checkpoint-colibrid').acquireColibridCheckpoint(chainId, options);
}

// Diagnostics cross a trust boundary too (the quorum's, checkpoint-colibrid.js).
// Never forward response bodies, arbitrary URLs/messages or fields into
// main-process logs or renderer status.
function validateDiagnostic(value, chainId) {
  if (!value || !networkFor(chainId).sources.includes(value.source) ||
      !Number.isSafeInteger(value.slot) || value.slot <= 0 ||
      !Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0 || value.elapsedMs > DEADLINE_MS ||
      !(value.outcome === 'vote' || Object.hasOwn(ERROR_MESSAGES, value.outcome))) return null;
  return {
    chainId, source: value.source, slot: value.slot, outcome: value.outcome, elapsedMs: value.elapsedMs,
    ...(['block-root', 'finality', 'history'].includes(value.stage) ? { stage: value.stage } : {}),
    ...(['http', 'timeout', 'transport', 'body-limit', 'invalid-json'].includes(value.failure)
      ? { failure: value.failure } : {}),
    ...(Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599
      ? { httpStatus: value.httpStatus } : {}),
  };
}

module.exports = {
  acquireCheckpoint,
  validateCheckpoint,
  validateDiagnostic,
  CHECKPOINT_NETWORKS,
  checkpointError,
  networkFor,
  DEADLINE_MS,
  MAX_AGE_MS,
};
