const crypto = require('node:crypto');
const { isMainThread, parentPort, workerData } = require('node:worker_threads');
const {
  checkpointError,
  networkFor,
  validateCheckpoint,
  MAX_AGE_MS,
} = require('./checkpoint-verifier');

const MAX_PROOF_BYTES = 4 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const REQUEST_MS = 20_000;
const MAX_TRUST_REQUESTS = 8;

function requireEvidence(condition) {
  if (!condition) throw checkpointError('CHECKPOINT_MISMATCH');
}

function uint(value) {
  requireEvidence(
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ||
      (typeof value === 'string' && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value))
  );
  const number = Number(BigInt(value));
  requireEvidence(Number.isSafeInteger(number) && number >= 0);
  return number;
}

function rootBytes(value) {
  requireEvidence(typeof value === 'string' && /^(?:0x)?[0-9a-f]{64}$/i.test(value));
  return Buffer.from(value.replace(/^0x/i, ''), 'hex');
}

function rootHex(value) {
  const bytes = rootBytes(value);
  requireEvidence(!bytes.equals(Buffer.alloc(32)));
  return '0x' + bytes.toString('hex');
}

function headerRoot(header) {
  requireEvidence(header && typeof header === 'object');
  const uintChunk = (value) => {
    const chunk = Buffer.alloc(32);
    chunk.writeBigUInt64LE(BigInt(uint(value)));
    return chunk;
  };
  let chunks = [
    uintChunk(header.slot),
    uintChunk(header.proposerIndex),
    rootBytes(header.parentRoot),
    rootBytes(header.stateRoot),
    rootBytes(header.bodyRoot),
    Buffer.alloc(32),
    Buffer.alloc(32),
    Buffer.alloc(32),
  ];
  while (chunks.length > 1) {
    const next = [];
    for (let i = 0; i < chunks.length; i += 2) {
      next.push(
        crypto
          .createHash('sha256')
          .update(chunks[i])
          .update(chunks[i + 1])
          .digest()
      );
    }
    chunks = next;
  }
  return '0x' + chunks[0].toString('hex');
}

// An invalid service response supplies no comparable checkpoint evidence.
function metadataValue(parse, value) {
  try {
    return parse(value);
  } catch {
    throw checkpointError('CHECKPOINT_UNAVAILABLE');
  }
}

function parseMetadata(bytes) {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw checkpointError('CHECKPOINT_UNAVAILABLE');
  }
}

// The cap applies to streamed, decoded bytes, not just Content-Length. Headers
// and compression must not allow an endpoint to allocate an unbounded body.
async function fetchBytes(fetchImpl, url, options, limit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_MS);
  let reader;
  try {
    const response = await fetchImpl(url, {
      ...options,
      redirect: 'error',
      signal: controller.signal,
    });
    if (response.status !== 200) throw checkpointError('CHECKPOINT_UNAVAILABLE');
    const length = response.headers.get('content-length');
    if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > limit)) {
      throw checkpointError('CHECKPOINT_UNAVAILABLE');
    }
    if (!response.body || typeof response.body.getReader !== 'function') {
      throw checkpointError('CHECKPOINT_UNAVAILABLE');
    }
    reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw checkpointError('CHECKPOINT_UNAVAILABLE');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (error?.code?.startsWith('CHECKPOINT_')) throw error;
    throw checkpointError('CHECKPOINT_UNAVAILABLE');
  } finally {
    clearTimeout(timer);
    controller.abort();
    try {
      await reader?.cancel();
    } catch {
      /* request already aborted */
    }
  }
}

// Each authority votes once for a (slot, root) only after explicitly endorsing
// finality. A block-root response alone is never a vote. Checkpointz's history
// endpoint lists finalized slots, allowing comparison when latest epochs differ.
async function checkpointVote(source, slot, config, fetchImpl, now) {
  const metadata = async (pathname) => parseMetadata(await fetchBytes(
    fetchImpl, source + pathname, { method: 'GET' }, MAX_METADATA_BYTES
  ));
  const [blockResult, finalityResult] = await Promise.allSettled([
    metadata(`/eth/v1/beacon/blocks/${slot}/root`),
    metadata('/eth/v1/beacon/states/head/finality_checkpoints'),
  ]);
  for (const result of [blockResult, finalityResult]) {
    if (result.status === 'rejected') throw result.reason;
  }
  const block = blockResult.value;
  const finality = finalityResult.value;
  for (const body of [block, finality]) {
    if (body.execution_optimistic !== undefined && typeof body.execution_optimistic !== 'boolean') {
      throw checkpointError('CHECKPOINT_UNAVAILABLE');
    }
    if (body.execution_optimistic === true) throw checkpointError('CHECKPOINT_QUORUM_CONFLICT');
  }
  const root = metadataValue(rootHex, block.data?.root);
  const epoch = metadataValue(uint, finality.data?.finalized?.epoch);
  const finalizedRoot = metadataValue(rootHex, finality.data?.finalized?.root);
  const epochSlot = epoch * config.slotsPerEpoch;
  const wallSlot = Math.floor((now() / 1000 - config.genesis) / config.secondsPerSlot);
  if (!Number.isSafeInteger(epochSlot) || epochSlot > wallSlot) {
    throw checkpointError('CHECKPOINT_CLOCK');
  }
  if (epochSlot < slot) throw checkpointError('CHECKPOINT_RACE');
  if (finalizedRoot !== root) {
    if (epoch === Math.ceil(slot / config.slotsPerEpoch)) {
      throw checkpointError('CHECKPOINT_QUORUM_CONFLICT');
    }
    const history = await metadata('/checkpointz/v1/beacon/slots');
    if (!Array.isArray(history.data?.slots) || history.data.slots.length > 256) {
      throw checkpointError('CHECKPOINT_UNAVAILABLE');
    }
    const entries = history.data.slots.filter((entry) => metadataValue(uint, entry?.slot) === slot);
    if (!entries.length) throw checkpointError('CHECKPOINT_RACE');
    // Reject duplicate or contradictory evidence within an authority's history.
    if (entries.length !== 1 || metadataValue(rootHex, entries[0].block_root) !== root) {
      throw checkpointError('CHECKPOINT_QUORUM_CONFLICT');
    }
  }
  return { source, slot, root, finalizedEpoch: Math.ceil(slot / config.slotsPerEpoch) };
}

async function checkpointQuorum(slot, config, fetchImpl, now) {
  // Stable candidate order makes replacement depend on availability, never on
  // response speed or which answer we prefer. Definitive responses occupy one of
  // the three seats, including dissent or inconsistent evidence. Only candidates
  // unable to supply usable evidence may be replaced, once each per lookup.
  const results = [];
  let next = 0;
  let occupied = 0;
  while (next < config.sources.length && occupied < config.participants) {
    const candidates = config.sources.slice(next, next + config.participants - occupied);
    next += candidates.length;
    const batch = await Promise.allSettled(candidates.map(
      (source) => checkpointVote(source, slot, config, fetchImpl, now)
    ));
    results.push(...batch);
    occupied += batch.filter((result) => result.status === 'fulfilled' ||
      !['CHECKPOINT_UNAVAILABLE', 'CHECKPOINT_RACE'].includes(result.reason?.code)).length;
    const groups = new Map();
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const vote = result.value;
      const group = groups.get(vote.root) || [];
      group.push(vote);
      groups.set(vote.root, group);
    }
    const winner = [...groups.values()].find((group) => group.length >= config.threshold);
    if (winner) return {
      slot, root: winner[0].root, finalizedEpoch: winner[0].finalizedEpoch,
      sources: winner.map((vote) => vote.source),
    };
  }
  const roots = new Set(results.filter((result) => result.status === 'fulfilled')
    .map((result) => result.value.root));
  if (roots.size > 1 || results.some((result) => result.reason?.code === 'CHECKPOINT_QUORUM_CONFLICT')) {
    throw checkpointError('CHECKPOINT_QUORUM_CONFLICT');
  }
  if (results.every((result) => result.reason?.code === 'CHECKPOINT_CLOCK')) {
    throw checkpointError('CHECKPOINT_CLOCK');
  }
  // Publication lag, HTTP failures and malformed responses do not establish a
  // conflict. Never reduce the configured threshold because a source is missing.
  throw checkpointError('CHECKPOINT_QUORUM_UNAVAILABLE');
}

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
            quorumRequests.set(slot, checkpointQuorum(slot, config, fetchImpl, now));
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
      if (transportError) throw transportError;
      if (/proof for latest too old/i.test(error?.message || '')) {
        throw checkpointError('CHECKPOINT_STALE');
      }
      throw checkpointError('CHECKPOINT_MISMATCH');
    }
    if (transportError) throw transportError;
    // A future Colibri API must not silently bypass the independently selected
    // authority. No observation after success is an unsupported runtime contract,
    // while observed evidence that disagrees with the proof remains a mismatch.
    if (!observations.length) throw checkpointError('CHECKPOINT_INCOMPATIBLE');
    const sync = decoded?.sync_data;
    const checkpoint = sync?.checkpoint;
    requireEvidence(
      Array.isArray(sync?.pubkeys) &&
        sync.pubkeys.length === 512 &&
        checkpoint &&
        Object.keys(checkpoint).sort().join(',') === 'aggregate_pubkey,header,proof' &&
        typeof checkpoint.aggregate_pubkey === 'string' &&
        /^0x[0-9a-f]{96}$/i.test(checkpoint.aggregate_pubkey) &&
        Array.isArray(checkpoint.proof) &&
        checkpoint.proof.length > 0 &&
        checkpoint.proof.length <= 16
    );
    for (const branch of checkpoint.proof) rootBytes(branch);
    const slot = uint(checkpoint.header?.slot);
    requireEvidence(slot > 0);
    const root = headerRoot(checkpoint.header);
    const quorum = observations.find((item) => item.slot === slot && item.root === root);
    requireEvidence(quorum);
    const slotTime = (config.genesis + slot * config.secondsPerSlot) * 1000;
    requireEvidence(Number.isSafeInteger(slotTime));
    if (slotTime > now()) throw checkpointError('CHECKPOINT_CLOCK');
    if (now() - slotTime > MAX_AGE_MS) throw checkpointError('CHECKPOINT_STALE');

    return validateCheckpoint(
      {
        schemaVersion: 2,
        chainId,
        network: config.network,
        root,
        slot,
        verifiedAt: now(),
        sources: quorum.sources,
        finalizedEpoch: quorum.finalizedEpoch,
      },
      chainId,
      { now: now() }
    );
  } finally {
    client?.destroy();
    storage.clear();
  }
}

// The public parent API accepts only a chain ID. Dependencies are injectable
// here for deterministic tests; they are never accepted in worker messages.
if (!isMainThread && parentPort) {
  verifyCheckpoint(workerData?.chainId)
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
