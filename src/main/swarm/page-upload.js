'use strict';

/**
 * A page's uploads to the node: window.swarm's `publishData` and
 * `publishFiles`, through main (freedom-core design 0011, "The size and the
 * charge" and "Measured, not assumed"; step PRQ-7c).
 *
 * Main charges a page's upload for the copies of its bytes it may hold at
 * once: the IPC value and normalizeBytes' copy, and for `publishData` one
 * copy of the body as it is sent. bee-js sends through fetch, which holds
 * more. Measured in Electron 45 (Node 24, undici 7), a 10 MiB Buffer body
 * held about 2.3 copies of itself in fetch while it was sent, and a 50 MiB
 * collection through bee-js' tar writer three: the `File`'s copy, the file's
 * `arrayBuffer()`, and fetch's of the one chunk the writer hands it. Either
 * passed its charge.
 *
 * So a page's uploads go to the node here, over Node's own `http` client,
 * which writes a Buffer to the socket without copying it: in views of at
 * most 64 KiB of the bytes main already holds, each written once the last
 * has drained. A string is encoded to UTF-8 a slice at a time. Nothing else
 * of the body is copied, and at most one slice waits in the socket's buffer.
 *
 * The requests are the ones bee-js made: `POST /bzz` with the postage batch,
 * pinned, as one file (`?name=`, not deferred) or as a collection (a ustar
 * archive, `swarm-collection`, deferred), answering `{ reference }` and the
 * tag in `swarm-tag`. A failed response throws as bee-js did,
 * `<status text>: <body>`, with `status`, so the provider's error mapping
 * (`nodeWriteError`) reads it the same way.
 */

const http = require('http');
const https = require('https');

// The most of a body written at once.
const SLICE_BYTES = 64 * 1024;
// The most of a string encoded at once: at most three UTF-8 bytes a UTF-16
// unit, so a slice's bytes stay under SLICE_BYTES.
const SLICE_CHARS = 16 * 1024;
// The most of a response body read: the node answers a small JSON object.
const MAX_RESPONSE_BYTES = 64 * 1024;
// A ustar header's name field: a page's path must fit it (LIMITS.maxPathBytes
// keeps every path within 100 UTF-8 bytes).
const TAR_NAME_BYTES = 100;
const TAR_BLOCK = 512;

/** A failed response, as bee-js' BeeResponseError carried it. */
function responseError(status, statusText, body) {
  const message = body ? `${statusText}: ${body}` : statusText || `HTTP ${status}`;
  const err = new Error(message);
  err.status = status;
  err.statusText = statusText;
  return err;
}

/** The views of `bytes`, at most SLICE_BYTES each, sharing its memory. */
function* slices(bytes) {
  for (let at = 0; at < bytes.byteLength; at += SLICE_BYTES) {
    yield bytes.subarray(at, Math.min(at + SLICE_BYTES, bytes.byteLength));
  }
}

/**
 * A string's UTF-8, a slice at a time: never a surrogate pair split between
 * two slices, so the bytes are exactly `Buffer.from(text)`'s, a lone
 * surrogate's replacement included.
 */
function* utf8Slices(text) {
  for (let at = 0; at < text.length;) {
    let end = Math.min(at + SLICE_CHARS, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && end - 1 > at && last >= 0xd800 && last <= 0xdbff) end -= 1;
    yield Buffer.from(text.slice(at, end), 'utf8');
    at = end;
  }
}

/**
 * A ustar header for one regular file, as bee-js' TarStream writes it: the
 * page's own `/`-separated path in the name field, mode 0777, uid and gid
 * 1000, the time now.
 */
function tarHeader(name, size) {
  if (Buffer.byteLength(name, 'utf8') > TAR_NAME_BYTES) throw new Error(`Path exceeds ${TAR_NAME_BYTES} UTF-8 bytes`);
  const header = Buffer.alloc(TAR_BLOCK, 0);
  header.write(name, 0, TAR_NAME_BYTES, 'utf8');
  header.write('0000777\0', 100, 8);
  header.write('0001750\0', 108, 8);
  header.write('0001750\0', 116, 8);
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12);
  header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 12);
  header.write('        ', 148, 8);
  header.write('0', 156, 1);
  header.write('ustar\0\0', 257, 8);
  let checksum = 0;
  for (let i = 0; i < TAR_BLOCK; i += 1) checksum += header[i];
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return header;
}

const tarPadding = (size) => (size % TAR_BLOCK === 0 ? 0 : TAR_BLOCK - (size % TAR_BLOCK));

/** The archive's length, before any of it is written. */
function tarLength(files) {
  let length = 2 * TAR_BLOCK;
  for (const file of files) length += TAR_BLOCK + file.bytes.byteLength + tarPadding(file.bytes.byteLength);
  return length;
}

/** The archive, piece by piece: each file's header, its bytes in views, its padding; then the end. */
function* tarPieces(files) {
  for (const file of files) {
    yield tarHeader(file.path, file.bytes.byteLength);
    yield* slices(file.bytes);
    const padding = tarPadding(file.bytes.byteLength);
    if (padding > 0) yield Buffer.alloc(padding, 0);
  }
  yield Buffer.alloc(2 * TAR_BLOCK, 0);
}

/**
 * POST `pieces` (Buffers, `length` bytes in all) to the node's `path`, each
 * written once the socket has taken the last. Resolves the parsed JSON
 * answer and the response's headers.
 */
function post(apiUrl, path, { query = {}, headers = {}, length, pieces }) {
  const url = new URL(path, apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`);
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
  }
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    let request = null;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      // An answer before the whole body went (the node refused it early):
      // nothing more is sent.
      if (request && !request.writableFinished) request.destroy();
      reject(err);
    };
    request = client.request(
      url,
      {
        method: 'POST',
        headers: { accept: 'application/json, text/plain, */*', ...headers, 'content-length': String(length) },
      },
      (response) => {
        const chunks = [];
        let received = 0;
        response.on('data', (chunk) => {
          received += chunk.length;
          if (received <= MAX_RESPONSE_BYTES) chunks.push(chunk);
        });
        response.on('error', fail);
        response.on('end', () => {
          if (settled) return;
          const text = Buffer.concat(chunks).toString('utf8');
          const status = response.statusCode || 0;
          if (status < 200 || status >= 300) {
            fail(responseError(status, response.statusMessage || '', text));
            return;
          }
          let body;
          try {
            body = JSON.parse(text);
          } catch {
            fail(new Error('The node answered the upload with no reference'));
            return;
          }
          settled = true;
          resolve({ body, headers: response.headers });
        });
      }
    );
    request.on('error', fail);
    (async () => {
      for (const piece of pieces) {
        if (settled || request.destroyed) return;
        if (!request.write(piece)) {
          await new Promise((drained) => {
            const done = () => {
              request.off('drain', done);
              request.off('close', done);
              drained();
            };
            request.on('drain', done);
            request.on('close', done);
          });
        }
      }
      if (!settled && !request.destroyed) request.end();
    })().catch((err) => {
      request.destroy(err);
      fail(err);
    });
  });
}

/** The upload's reference and tag, from the node's answer. */
function uploadResult({ body, headers }) {
  const reference = typeof body?.reference === 'string' ? body.reference.toLowerCase() : '';
  if (!/^[0-9a-f]{64}(?:[0-9a-f]{64})?$/.test(reference)) {
    throw new Error('The node answered the upload with no reference');
  }
  const tag = Number.parseInt(headers['swarm-tag'], 10);
  return { reference, tagUid: Number.isSafeInteger(tag) && tag > 0 ? tag : null };
}

/**
 * One file (`publishData`): a Buffer, or a string sent as its UTF-8.
 * @returns {Promise<{ reference: string, tagUid: number|null }>}
 */
async function uploadData(apiUrl, batchId, data, { name, contentType } = {}) {
  const isString = typeof data === 'string';
  const answer = await post(apiUrl, 'bzz', {
    query: { name: name || 'data' },
    headers: {
      'content-type': contentType || 'text/plain',
      'swarm-postage-batch-id': batchId,
      'swarm-pin': 'true',
      'swarm-deferred-upload': 'false',
    },
    length: isString ? Buffer.byteLength(data, 'utf8') : data.byteLength,
    pieces: isString ? utf8Slices(data) : slices(data),
  });
  return uploadResult(answer);
}

/**
 * A collection (`publishFiles`): `files` as `{ path, bytes }`, each under
 * the page's own path, with an index document if given.
 * @returns {Promise<{ reference: string, tagUid: number|null }>}
 */
async function uploadCollection(apiUrl, batchId, files, { indexDocument } = {}) {
  const headers = {
    'content-type': 'application/x-tar',
    'swarm-collection': 'true',
    'swarm-postage-batch-id': batchId,
    'swarm-pin': 'true',
    'swarm-deferred-upload': 'true',
  };
  if (indexDocument) headers['swarm-index-document'] = indexDocument;
  const answer = await post(apiUrl, 'bzz', { headers, length: tarLength(files), pieces: tarPieces(files) });
  return uploadResult(answer);
}

module.exports = { uploadData, uploadCollection, SLICE_BYTES, SLICE_CHARS };
