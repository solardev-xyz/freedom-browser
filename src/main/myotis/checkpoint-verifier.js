// Checkpoint recovery belongs to the node service. Each verification attempt has
// its own JS/WASM worker and store, independent of the ENS verifier's global cache.
const path = require('node:path');
const { Worker } = require('node:worker_threads');

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
    ]),
    participants: 2,
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

// Revalidate the narrow worker result before allowing it into lifecycle/storage
// code. This also gives persisted checkpoints the same chain and freshness rules.
function validateCheckpoint(value, chainId, { now = Date.now(), fresh = true } = {}) {
  const config = networkFor(chainId);
  // Existing generations retain their original trust policy. New recovery and
  // worker results always require v2 quorum provenance, even for fresh v1 records.
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

function acquireCheckpoint(chainId, { signal } = {}) {
  return new Promise((resolve, reject) => {
    try {
      networkFor(chainId);
    } catch (error) {
      reject(error);
      return;
    }
    if (
      signal &&
      (typeof signal.addEventListener !== 'function' ||
        typeof signal.removeEventListener !== 'function')
    ) {
      reject(checkpointError('CHECKPOINT_MISMATCH'));
      return;
    }
    const abortError = () => {
      const error = checkpointError('CHECKPOINT_UNAVAILABLE');
      error.name = 'AbortError';
      return error;
    };
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    let worker;
    let timer;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      // Await the terminal receipt: lifecycle shutdown awaits this promise and
      // must not finish while the worker still owns a WASM verifier or sockets.
      const complete = () => {
        if (error) reject(error);
        else resolve(result);
      };
      if (!worker) {
        complete();
        return;
      }
      try {
        Promise.resolve(worker.terminate()).then(complete, () => {
          // A termination failure must never turn a verified result into success.
          reject(error || checkpointError('CHECKPOINT_UNAVAILABLE'));
        });
      } catch {
        reject(error || checkpointError('CHECKPOINT_UNAVAILABLE'));
      }
    };
    const abort = () => finish(abortError());
    try {
      worker = new Worker(path.join(__dirname, 'checkpoint-verifier-worker.js'), {
        workerData: { chainId },
        execArgv: [],
        env: { C4_DISABLE_NATIVE: '1' },
        resourceLimits: {
          maxOldGenerationSizeMb: 128,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4,
        },
        stdout: true,
        stderr: true,
      });
      worker.stdout?.resume();
      worker.stderr?.resume();
      worker.on('message', (message) => {
        if (settled) return;
        if (message?.ok !== true) {
          finish(checkpointError(message?.error?.code));
          return;
        }
        try {
          finish(null, validateCheckpoint(message.checkpoint, chainId));
        } catch (error) {
          finish(error);
        }
      });
      // Keep these handlers attached through termination: a late worker error
      // must not become an unhandled main-process EventEmitter error.
      worker.on('error', () => finish(checkpointError('CHECKPOINT_UNAVAILABLE')));
      worker.on('exit', () => finish(checkpointError('CHECKPOINT_UNAVAILABLE')));
      timer = setTimeout(() => finish(checkpointError('CHECKPOINT_UNAVAILABLE')), DEADLINE_MS);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    } catch {
      finish(checkpointError('CHECKPOINT_UNAVAILABLE'));
    }
  });
}

module.exports = {
  acquireCheckpoint,
  validateCheckpoint,
  CHECKPOINT_NETWORKS,
  checkpointError,
  networkFor,
  DEADLINE_MS,
  MAX_AGE_MS,
};
