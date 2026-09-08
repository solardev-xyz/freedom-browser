/**
 * Chunk Service
 *
 * Low-level Swarm CAC/SOC primitives for the page-facing window.swarm API.
 * Runs in the main process only; provider-ipc owns permission checks.
 */

const { PrivateKey, BeeResponseError, Identifier, EthAddress } = require('@ethersphere/bee-js');
const { getBee, selectBestBatch, toHex } = require('./swarm-service');

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
    throw new Error('No usable postage batch available. Purchase stamps first.');
  }
  return batchId;
}

function getSignerAddress(signerPrivateKey) {
  const signer = new PrivateKey(signerPrivateKey);
  return signer.publicKey().address().toChecksum();
}

function makeSocUploadBody(soc) {
  return Buffer.concat([
    Buffer.from(soc.span.toUint8Array()),
    Buffer.from(soc.payload.toUint8Array()),
  ]);
}

async function uploadSingleOwnerChunk(bee, batchId, soc) {
  const expectedReference = normalizeReference(toHex(soc.address));
  const baseUrl = bee.url.endsWith('/') ? bee.url : `${bee.url}/`;
  const uploadUrl = new URL(`soc/${toHex(soc.owner)}/${soc.identifier.toHex()}`, baseUrl);
  uploadUrl.searchParams.set('sig', soc.signature.toHex());

  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'swarm-postage-batch-id': batchId,
      'swarm-pin': 'true',
      'swarm-deferred-upload': 'false',
    },
    body: makeSocUploadBody(soc),
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

async function writeSingleOwnerChunk(signerPrivateKey, identifier, data, options = {}) {
  const bee = getBee();
  const signer = new PrivateKey(signerPrivateKey);
  const chunk = bee.makeContentAddressedChunk(data, options.span);
  const soc = chunk.toSingleOwnerChunk(identifier, signer);
  const batchId = await selectChunkBatch();

  await uploadSingleOwnerChunk(bee, batchId, soc);

  return {
    reference: toHex(soc.address),
    owner: soc.owner.toChecksum(),
    identifier: soc.identifier.toHex(),
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
  writeSingleOwnerChunk,
  readSingleOwnerChunk,
  getSignerAddress,
  spanToResult,
  isChunkNotFoundError,
};
