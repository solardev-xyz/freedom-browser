/**
 * Checkpoint evidence checks, shared by the WASM worker
 * (`checkpoint-verifier-worker.js`) and the native checkpoint process's
 * path (`checkpoint-colibrid.js`, `freedom-colibrid checkpoint`;
 * freedom-core design 0014, COL-5), so both judge a checkpoint by the same
 * rules:
 * - `fetchBytes`: one bounded HTTP request (20 s, no redirects, streamed
 *   bytes capped: 4 MiB for a proof, 64 KiB for metadata);
 * - `checkpointQuorum`: the checkpointz quorum for a slot (3 seats,
 *   threshold 2);
 * - `headerRoot`: a beacon block header's SSZ root;
 * - `verifiedCheckpoint`: after the proof verified, the decoded proof's
 *   `sync_data` checks, the quorum match and the maximum age;
 * - `verifyFailure`: what a failed verification means.
 *
 * Fetch and clock come from the caller.
 */
const crypto = require('node:crypto');
const { checkpointError, validateCheckpoint, MAX_AGE_MS } = require('./checkpoint-verifier');

const MAX_PROOF_BYTES = 4 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const REQUEST_MS = 20_000;

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
    throw Object.assign(checkpointError('CHECKPOINT_UNAVAILABLE'), { failure: 'invalid-json' });
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
    if (response.status !== 200) throw Object.assign(checkpointError('CHECKPOINT_UNAVAILABLE'), {
      failure: 'http', httpStatus: response.status,
    });
    const length = response.headers.get('content-length');
    if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > limit)) {
      throw Object.assign(checkpointError('CHECKPOINT_UNAVAILABLE'), { failure: 'body-limit' });
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
      if (size > limit) throw Object.assign(checkpointError('CHECKPOINT_UNAVAILABLE'), { failure: 'body-limit' });
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (error?.code?.startsWith('CHECKPOINT_')) throw error;
    throw Object.assign(checkpointError('CHECKPOINT_UNAVAILABLE'), {
      failure: controller.signal.aborted ? 'timeout' : 'transport',
    });
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
// finality. A root without a finality endorsement is never a vote. Beacon APIs
// can mark the requested block finalized; Checkpointz also exposes finalized
// history. These are authority assertions, not substitutes for Colibri's proof.
async function checkpointVote(source, slot, config, fetchImpl, now) {
  const metadata = async (pathname, stage) => {
    try {
      return parseMetadata(await fetchBytes(
        fetchImpl, source + pathname, { method: 'GET' }, MAX_METADATA_BYTES
      ));
    } catch (error) {
      error.stage = stage;
      throw error;
    }
  };
  const [blockResult, finalityResult] = await Promise.allSettled([
    metadata(`/eth/v1/beacon/blocks/${slot}/root`, 'block-root'),
    metadata('/eth/v1/beacon/states/head/finality_checkpoints', 'finality'),
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
  if (block.finalized !== undefined && typeof block.finalized !== 'boolean') {
    throw checkpointError('CHECKPOINT_UNAVAILABLE');
  }
  // A head STATE can be unfinalized while its reported finalized checkpoint is
  // valid. Only the flag on the requested BLOCK is evidence for this vote.
  if (block.finalized === false) throw checkpointError('CHECKPOINT_RACE');
  if (config.beaconSources?.includes(source) &&
      (block.finalized !== true || block.execution_optimistic !== false)) {
    throw checkpointError('CHECKPOINT_UNAVAILABLE');
  }
  if (finalizedRoot !== root) {
    if (epoch === Math.ceil(slot / config.slotsPerEpoch)) {
      throw checkpointError('CHECKPOINT_QUORUM_CONFLICT');
    }
    if (block.finalized === true && block.execution_optimistic === false) {
      return { source, slot, root, finalizedEpoch: Math.ceil(slot / config.slotsPerEpoch) };
    }
    const history = await metadata('/checkpointz/v1/beacon/slots', 'history');
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

async function checkpointQuorum(slot, config, fetchImpl, now, onDiagnostic = () => {}) {
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
    const batch = await Promise.allSettled(candidates.map(async (source) => {
      const started = Date.now();
      let failure;
      try {
        return await checkpointVote(source, slot, config, fetchImpl, now);
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        try {
          onDiagnostic({ source, slot, elapsedMs: Math.max(0, Date.now() - started),
            outcome: failure?.code || 'vote', stage: failure?.stage,
            failure: failure?.failure, httpStatus: failure?.httpStatus });
        } catch { /* diagnostics cannot affect a vote */ }
      }
    }));
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

// A verification failure caused by a refused or failed lookup keeps that
// lookup's category, so a service outage is never presented as conflicting
// proof. Otherwise only Colibri's own staleness verdict is not a mismatch.
function verifyFailure(message, transportError) {
  if (transportError) return transportError;
  if (/proof for latest too old/i.test(message || '')) {
    return checkpointError('CHECKPOINT_STALE');
  }
  return checkpointError('CHECKPOINT_MISMATCH');
}

// The checkpoint a decoded proof carries: the modern committee-binding variant
// only, its branch well formed, its slot positive. Returns its slot and root.
function decodedCheckpoint(decoded) {
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
  return { slot, root: headerRoot(checkpoint.header) };
}

// A checkpoint's slot must have started and be at most MAX_AGE_MS old by the
// caller's clock.
function checkCheckpointAge(slot, config, now) {
  const slotTime = (config.genesis + slot * config.secondsPerSlot) * 1000;
  requireEvidence(Number.isSafeInteger(slotTime));
  if (slotTime > now()) throw checkpointError('CHECKPOINT_CLOCK');
  if (now() - slotTime > MAX_AGE_MS) throw checkpointError('CHECKPOINT_STALE');
}

// After the proof verified: bind the decoded checkpoint to what the quorum
// observed during verification and to the clock, then revalidate the narrow
// record lifecycle code will persist.
function verifiedCheckpoint(chainId, config, decoded, observations, now) {
  // A future Colibri API must not silently bypass the independently selected
  // authority. No observation after success is an unsupported runtime contract,
  // while observed evidence that disagrees with the proof remains a mismatch.
  if (!observations.length) throw checkpointError('CHECKPOINT_INCOMPATIBLE');
  const { slot, root } = decodedCheckpoint(decoded);
  const quorum = observations.find((item) => item.slot === slot && item.root === root);
  requireEvidence(quorum);
  checkCheckpointAge(slot, config, now);

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
}

module.exports = {
  checkCheckpointAge,
  checkpointQuorum,
  decodedCheckpoint,
  fetchBytes,
  headerRoot,
  requireEvidence,
  uint,
  verifiedCheckpoint,
  verifyFailure,
  MAX_METADATA_BYTES,
  MAX_PROOF_BYTES,
  REQUEST_MS,
};
