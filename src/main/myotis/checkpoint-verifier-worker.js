const { isMainThread, parentPort, workerData } = require('node:worker_threads');
const { checkpointError, networkFor } = require('./checkpoint-verifier');
const {
  checkpointQuorum,
  fetchBytes,
  headerRoot,
  requireEvidence,
  uint,
  verifiedCheckpoint,
  verifyFailure,
  MAX_PROOF_BYTES,
  MAX_METADATA_BYTES,
} = require('./checkpoint-evidence');

const MAX_TRUST_REQUESTS = 8;

async function verifyCheckpoint(chainId, dependencies = {}) {
  const config = networkFor(chainId);
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  const now = dependencies.now || Date.now;
  // Lazy import: tests may inspect helpers in the main thread. Production only
  // initializes Colibri here, inside the disposable worker.
  const { Colibri, Strategy, decode_proof, clientVersion } =
    dependencies.runtime || require('../ens/colibri-runtime');
  if (typeof decode_proof !== 'function' || !Number.isSafeInteger(clientVersion) || clientVersion <= 0) {
    throw checkpointError('CHECKPOINT_INCOMPATIBLE');
  }
  const storage = new Map();
  const observations = [];
  const quorumRequests = new Map();
  let transportError = null;
  let requestCount = 0;
  let client;
  try {
    await Colibri.register_storage({
      get: (key) => storage.get(key) || null,
      set: (key, value) => storage.set(key, Buffer.from(value)),
      del: (key) => storage.delete(key),
    });
    client = new Colibri({
      chainId,
      zk_proof: true,
      proofStrategy: Strategy.VerifiedOnly,
      privacy_mode: 'basic',
      max_latest_age_seconds: 60,
      checkpointz: [config.source],
      beacon_apis: [],
      prover: [],
      fetch: async (input, options = {}) => {
        try {
          const url = new URL(input);
          requireEvidence(
            url.origin === config.source &&
              !url.username &&
              !url.password &&
              !url.search &&
              !url.hash &&
              (options.method || 'GET') === 'GET' &&
              /^\/eth\/v1\/beacon\/blocks\/[0-9]+\/root$/.test(url.pathname)
          );
          if (++requestCount > MAX_TRUST_REQUESTS) throw checkpointError('CHECKPOINT_UNAVAILABLE');
          const slot = uint(url.pathname.split('/').at(-2));
          if (!quorumRequests.has(slot)) {
            quorumRequests.set(slot, checkpointQuorum(slot, config, fetchImpl, now, dependencies.onDiagnostic));
          }
          const observation = await quorumRequests.get(slot);
          observations.push(observation);
          // Colibri sees only the root endorsed by the fixed quorum. The origin
          // here is an interception boundary, not a mandatory individual voter.
          const bytes = JSON.stringify({ data: { root: observation.root } });
          return new Response(bytes, {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        } catch (error) {
          // Colibri wraps fetch failures in verifier errors. Retain the original
          // category so a service outage is never presented as conflicting proof.
          transportError ||= error?.code ? error : checkpointError('CHECKPOINT_UNAVAILABLE');
          throw error;
        }
      },
    });
    const proof = await fetchBytes(
      fetchImpl,
      config.prover,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          method: 'eth_getBlockByNumber',
          params: ['latest', false],
          version: clientVersion,
          zk_proof: true,
        }),
      },
      MAX_PROOF_BYTES
    );
    // Decode once to distinguish an unavailable/malformed service body from a
    // recognized proof that fails cryptographic verification. Decoding grants no
    // trust: the exact same bounded bytes must still pass verifyProof below. The
    // disposable worker's total deadline also bounds synchronous WASM decoding.
    let decoded;
    try {
      decoded = await decode_proof(proof);
      if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error();
    } catch {
      throw checkpointError('CHECKPOINT_UNAVAILABLE');
    }
    try {
      await client.verifyProof('eth_getBlockByNumber', ['latest', false], proof);
    } catch (error) {
      throw verifyFailure(error?.message, transportError);
    }
    if (transportError) throw transportError;
    return verifiedCheckpoint(chainId, config, decoded, observations, now);
  } finally {
    client?.destroy();
    storage.clear();
  }
}

// The public parent API accepts only a chain ID. Dependencies are injectable
// here for deterministic tests; they are never accepted in worker messages.
if (!isMainThread && parentPort) {
  verifyCheckpoint(workerData?.chainId, {
    onDiagnostic: (diagnostic) => parentPort.postMessage({ type: 'checkpoint-source', diagnostic }),
  })
    .then(
      (checkpoint) => parentPort.postMessage({ ok: true, checkpoint }),
      (error) =>
        parentPort.postMessage({
          ok: false,
          error: { code: error?.code || 'CHECKPOINT_UNAVAILABLE' },
        })
    )
    .finally(() => parentPort.close());
}

module.exports = { checkpointQuorum, verifyCheckpoint, fetchBytes, headerRoot, MAX_PROOF_BYTES, MAX_METADATA_BYTES };
