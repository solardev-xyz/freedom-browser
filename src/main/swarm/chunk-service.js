/**
 * Chunk Service
 *
 * Low-level Swarm CAC/SOC primitives for the page-facing window.swarm API.
 * Runs in the main process only; provider-ipc owns permission checks.
 */

const { BeeResponseError, Identifier, EthAddress } = require('@ethersphere/bee-js');
const { getBee, selectBestBatch, toHex } = require('./swarm-service');
const { noUsableBatchError } = require('./batch-errors');

function spanToResult(span) {
  const value = span.toBigInt();
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

function makeSemanticError(reason, message, cause) {
  const err = new Error(message);
  err.reason = reason;
  if (cause) err.cause = cause;
  return err;
}

function getBeeResponseBodyMessage(err) {
  const body = err?.responseBody;
  if (!body) return null;
  if (typeof body === 'object' && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
    return typeof body.message === 'string' ? body.message : null;
  }

  const text = Buffer.isBuffer(body) || body instanceof Uint8Array
    ? Buffer.from(body).toString('utf8')
    : String(body);
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.message === 'string' ? parsed.message : null;
  } catch {
    return null;
  }
}

function isChunkNotFoundError(err) {
  if (!(err instanceof BeeResponseError)) return false;
  if (err.status === 404) return true;
  return err.status === 500 && getBeeResponseBodyMessage(err)?.trim().toLowerCase() === 'read chunk failed';
}

function ensureSameReference(actual, expected, type) {
  const normalizedActual = actual.replace(/^0x/, '').toLowerCase();
  const normalizedExpected = expected.replace(/^0x/, '').toLowerCase();
  if (normalizedActual !== normalizedExpected) {
    throw makeSemanticError(
      'chunk_type_mismatch',
      `Downloaded bytes do not validate as the requested ${type} chunk`
    );
  }
}

function normalizeReference(reference) {
  return String(reference || '').replace(/^0x/, '').toLowerCase();
}

async function selectChunkBatch() {
  const batchId = await selectBestBatch(4096);
  if (!batchId) {
    throw noUsableBatchError();
  }
  return batchId;
}

function hexOf(value) {
  return Buffer.from(value).toString('hex');
}

/** span (8 bytes, little endian) ‖ payload: what Bee's /soc endpoint takes. */
function makeSocUploadBody(chunk) {
  const span = Buffer.alloc(8);
  span.writeBigUInt64LE(chunk.span);
  return Buffer.concat([span, Buffer.from(chunk.payload)]);
}

/**
 * POST a signed single-owner chunk to Bee's /soc endpoint.
 *
 * @param {object} bee
 * @param {string} batchId
 * @param {{ owner: string, identifier: Uint8Array, signature: string, span: bigint,
 *   payload: Uint8Array, socAddress: string }} chunk - from a Swarm signer
 * @param {{ pin?: boolean, deferred?: boolean }} [options] - sent only when
 *   given, as bee-js does (its feed writes send neither)
 */
async function uploadSingleOwnerChunk(bee, batchId, chunk, options = {}) {
  const expectedReference = normalizeReference(chunk.socAddress);
  const baseUrl = bee.url.endsWith('/') ? bee.url : `${bee.url}/`;
  const owner = chunk.owner.replace(/^0x/, '').toLowerCase();
  const uploadUrl = new URL(`soc/${owner}/${hexOf(chunk.identifier)}`, baseUrl);
  uploadUrl.searchParams.set('sig', chunk.signature.replace(/^0x/, ''));

  const headers = {
    'content-type': 'application/octet-stream',
    'swarm-postage-batch-id': batchId,
  };
  if (typeof options.pin === 'boolean') headers['swarm-pin'] = String(options.pin);
  if (typeof options.deferred === 'boolean') headers['swarm-deferred-upload'] = String(options.deferred);

  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers,
    body: makeSocUploadBody(chunk),
  });

  if (!response.ok) {
    const body = typeof response.text === 'function' ? await response.text() : '';
    throw new Error(`SOC upload failed (${response.status}): ${body || response.statusText || 'Bee rejected request'}`);
  }

  const body = await response.json();
  const reference = normalizeReference(body.reference);
  if (!reference) {
    throw new Error('SOC upload response missing reference');
  }
  if (reference !== expectedReference) {
    throw new Error(`SOC upload returned unexpected reference: ${reference}`);
  }
  return reference;
}

async function publishChunk(data, options = {}) {
  const bee = getBee();
  const chunk = bee.makeContentAddressedChunk(data, options.span);
  const batchId = await selectChunkBatch();

  await bee.chunk.upload(batchId, chunk, { pin: true, deferred: false });

  return {
    reference: toHex(chunk.address),
    batchIdUsed: batchId,
  };
}

async function readChunk(reference) {
  const bee = getBee();
  let raw;

  try {
    raw = await bee.chunk.download(reference);
  } catch (err) {
    if (isChunkNotFoundError(err)) {
      throw makeSemanticError('chunk_not_found', `Chunk not found: ${reference}`, err);
    }
    throw err;
  }

  let chunk;
  try {
    chunk = bee.unmarshalContentAddressedChunk(raw);
    ensureSameReference(toHex(chunk.address), reference, 'content-addressed');
  } catch (err) {
    if (err.reason === 'chunk_type_mismatch') throw err;
    throw makeSemanticError(
      'chunk_type_mismatch',
      `Downloaded bytes do not validate as the requested content-addressed chunk`,
      err
    );
  }

  return {
    data: Buffer.from(chunk.payload.toUint8Array()).toString('base64'),
    encoding: 'base64',
    span: spanToResult(chunk.span),
  };
}

const CHUNK_PAYLOAD_SIZE = 4096;

/**
 * The byte length of the blob a root chunk stands for, from its span.
 *
 * Bee and Ant keep a redundancy-coded tree's level in the span's most
 * significant byte (little-endian, so the last of its 8 bytes): set to
 * `level | 0x80` on intermediate chunks, read back as "encoded" when the
 * byte is above 128 (Bee's `redundancy.IsLevelEncoded` / `DecodeSpan`). That
 * byte is cleared to get the real size; any other value in it is a real (and
 * absurdly large) size, left as is.
 *
 * @param {Uint8Array} spanBytes - the chunk's 8 span bytes
 * @returns {bigint}
 */
function dataSizeFromSpan(spanBytes) {
  const bytes = Buffer.from(spanBytes);
  if (bytes[7] > 128) bytes[7] = 0;
  return bytes.readBigUInt64LE(0);
}

/**
 * Download a blob's root chunk, check it hashes to `reference`, and work out
 * the blob's size from its span. Lets the caller refuse an oversized blob
 * before the node joins all of it.
 *
 * @returns {Promise<{ size: bigint, payload: Buffer }>} `payload` is the root
 *   chunk's own payload, which is the whole blob when `size` fits one chunk.
 */
async function readDataRoot(reference) {
  const bee = getBee();
  let raw;

  try {
    raw = await bee.chunk.download(reference);
  } catch (err) {
    if (isChunkNotFoundError(err)) {
      throw makeSemanticError('chunk_not_found', `Data not found: ${reference}`, err);
    }
    throw err;
  }

  let chunk;
  try {
    chunk = bee.unmarshalContentAddressedChunk(raw);
    ensureSameReference(toHex(chunk.address), reference, 'content-addressed');
  } catch (err) {
    if (err.reason === 'chunk_type_mismatch') throw err;
    throw makeSemanticError(
      'chunk_type_mismatch',
      'Downloaded bytes do not validate as the requested content-addressed chunk',
      err
    );
  }

  return {
    size: dataSizeFromSpan(chunk.span.toUint8Array()),
    payload: Buffer.from(chunk.payload.toUint8Array()),
    // What the root read itself pulled off the network (span + payload), so
    // the caller can charge it whether or not the blob is then joined.
    chunkBytes: raw.length,
  };
}

/**
 * Read a whole blob by its root reference, joined by the node (bee-js
 * `data.download`, i.e. `GET /bytes/<ref>`): the node checks every chunk it
 * fetches, recovers erasure-coded content and falls back to the root's
 * replicas. Freedom keeps no tree code of its own.
 *
 * `root` is what `readDataRoot` returned for the same reference. A blob that
 * fits in its root chunk is that chunk's payload, already verified, so it is
 * returned without a second request.
 */
async function readData(reference, root) {
  const size = Number(root.size);
  let data;

  if (root.size <= BigInt(CHUNK_PAYLOAD_SIZE)) {
    data = root.payload.subarray(0, size);
  } else {
    const bee = getBee();
    try {
      data = Buffer.from((await bee.data.download(reference)).toUint8Array());
    } catch (err) {
      if (isChunkNotFoundError(err)) {
        throw makeSemanticError('chunk_not_found', `Data not found: ${reference}`, err);
      }
      throw err;
    }
  }

  if (data.length !== size) {
    throw new Error(`Node returned ${data.length} bytes for a ${size}-byte blob`);
  }

  return {
    data: data.toString('base64'),
    encoding: 'base64',
  };
}

/**
 * Sign (in the identity core, through `signer`) and publish a single-owner
 * chunk. bee-js still validates the chunk first, so size errors read as
 * before.
 *
 * @param {import('./swarm-signer').SwarmSigner} signer
 */
async function writeSingleOwnerChunk(signer, identifier, data, options = {}) {
  const bee = getBee();
  bee.makeContentAddressedChunk(data, options.span);
  const id = new Identifier(identifier);
  const signed = await signer.signSoc({ identifier: id.toUint8Array(), payload: data, span: options.span });
  const batchId = await selectChunkBatch();

  const reference = await uploadSingleOwnerChunk(
    bee,
    batchId,
    { ...signed, identifier: id.toUint8Array(), payload: data },
    { pin: true, deferred: false }
  );

  return {
    reference,
    owner: signed.owner,
    identifier: id.toHex(),
    batchIdUsed: batchId,
  };
}

async function readSingleOwnerChunk(params) {
  const bee = getBee();
  const { address, owner, identifier } = params;
  const reference = address || toHex(
    bee.calculateSingleOwnerChunkAddress(new Identifier(identifier), new EthAddress(owner))
  );
  let raw;

  try {
    raw = await bee.chunk.download(reference);
  } catch (err) {
    if (isChunkNotFoundError(err)) {
      throw makeSemanticError('chunk_not_found', 'Single Owner Chunk not found', err);
    }
    throw err;
  }

  let soc;
  try {
    soc = bee.unmarshalSingleOwnerChunk(raw, reference);
  } catch (err) {
    throw makeSemanticError(
      'chunk_type_mismatch',
      'Downloaded bytes do not validate as the requested Single Owner Chunk',
      err
    );
  }

  return {
    data: Buffer.from(soc.payload.toUint8Array()).toString('base64'),
    encoding: 'base64',
    span: spanToResult(soc.span),
    reference: toHex(soc.address),
    owner: soc.owner.toChecksum(),
    identifier: soc.identifier.toHex(),
    signature: soc.signature.toHex(),
  };
}

module.exports = {
  publishChunk,
  readChunk,
  readDataRoot,
  readData,
  dataSizeFromSpan,
  writeSingleOwnerChunk,
  readSingleOwnerChunk,
  uploadSingleOwnerChunk,
  spanToResult,
  isChunkNotFoundError,
};
