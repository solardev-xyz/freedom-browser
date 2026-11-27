/**
 * ACT Service (#648)
 *
 * Opens content shared with this Swarm node through ACT (Swarm's access
 * control) for `swarm_openAct`. The node does the work: given the publisher's
 * public key and the ACT history, it finds this node's grantee entry, unwraps
 * the access key with its own key, decrypts the reference and serves the
 * content (Ant's `act_maybe_resolve`, Bee's `actDecryptionHandler`). Freedom
 * never reads the node's key, so it never leaves the node.
 *
 * This is the one place Freedom sends `Swarm-Act-*` headers to the node.
 * `bzz://` keeps refusing to forward them from pages (bzz-protocol.js,
 * audit O-2, #429): a page reaches ACT content only through the
 * provider method, after main has checked the user's per-publisher consent.
 *
 * Main process only; swarm-provider-ipc.js owns validation and consent.
 */

const { getAntApiUrl } = require('../service-registry');

// The whole request, headers and body: an ACT lookup walks a history, a
// key-value store and then the content itself.
const ACT_READ_TIMEOUT_MS = 120_000;
// Error bodies are read for their message only.
const MAX_ERROR_BODY_BYTES = 4096;
// Ant's and Bee's body for accesscontrol.ErrNotFound: no grantee entry for
// this node under that publisher, or no history entry at the timestamp.
const ACT_NOT_FOUND_MESSAGE = 'act or history entry not found';

function actError(reason, message, extra = {}) {
  const err = new Error(message);
  err.reason = reason;
  Object.assign(err, extra);
  return err;
}

async function readErrorText(body) {
  if (!body) return '';
  const reader = body.getReader();
  const pieces = [];
  let total = 0;
  try {
    while (total < MAX_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      pieces.push(Buffer.from(value));
      total += value.byteLength;
    }
  } catch {
    // A broken error body leaves the status to speak for itself.
  }
  reader.cancel().catch(() => {});
  return Buffer.concat(pieces).subarray(0, MAX_ERROR_BODY_BYTES).toString('utf8');
}

function errorMessage(text) {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.message === 'string') return parsed.message;
  } catch {
    // not JSON
  }
  return text.trim();
}

/** The body's declared length, or null when it has none it can be held to. */
function declaredLength(response) {
  const encoding = response.headers.get('content-encoding');
  if (encoding && encoding.toLowerCase() !== 'identity') return null;
  const value = response.headers.get('content-length');
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  const length = Number(value.trim());
  return Number.isSafeInteger(length) ? length : null;
}

/**
 * The node path for a share: `bytes/<ref>` for a blob (bee-js
 * `downloadData`), `bzz/<ref>/<path>` for a file in a manifest (bee-js
 * `downloadFile`). `path` has been validated by the caller; each segment is
 * percent-encoded here, so nothing in it can act as a separator.
 */
function nodePath(reference, path) {
  if (path === undefined) return `bytes/${reference}`;
  const encoded = path === '' ? '' : path.split('/').map(encodeURIComponent).join('/');
  return `bzz/${reference}/${encoded}`;
}

/**
 * Open an ACT share through the node and return its bytes.
 *
 * @param {Object} share
 * @param {string} share.reference - the ACT (encrypted) reference, hex
 * @param {string} share.publisher - compressed publisher key, normalised by
 *   act-publisher.js (never the page's own spelling)
 * @param {string} share.historyAddress - hex
 * @param {number} [share.timestamp] - unix seconds; the node uses "now" when
 *   absent
 * @param {string} [share.path] - absent for a blob, a manifest path otherwise
 * @param {{ maxBytes: number, charge: Function, reserve: Function }} meter -
 *   the read budget (swarm-provider-ipc.js permissionFreeReadMeter): a
 *   declared length is reserved before the body is read, an undeclared one
 *   piece by piece; past maxBytes is data_too_large.
 * @returns {Promise<{ data: string, encoding: 'base64', contentType: string|null }>}
 */
async function openActShare(share, meter, { signal } = {}) {
  const base = getAntApiUrl();
  if (!base) throw actError('node-stopped', 'Swarm node is not running');
  const baseUrl = base.endsWith('/') ? base : `${base}/`;
  // Relative to the base, so an external node behind a path prefix
  // (https://host/bee/) keeps its prefix.
  const url = new URL(nodePath(share.reference, share.path), baseUrl).href;

  const headers = {
    accept: '*/*',
    // A compressed body would decode past its Content-Length.
    'accept-encoding': 'identity',
    'swarm-act-publisher': share.publisher,
    'swarm-act-history-address': share.historyAddress,
  };
  if (share.timestamp !== undefined) headers['swarm-act-timestamp'] = String(share.timestamp);

  const timeout = AbortSignal.timeout(ACT_READ_TIMEOUT_MS);
  const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let response;
  try {
    // A redirect would carry the ACT headers to wherever it points; the
    // node has no reason to send one for these paths, so it is an error.
    response = await fetch(url, { headers, redirect: 'manual', signal: abort });
  } catch (err) {
    const message = err.cause?.message ? `${err.message}: ${err.cause.message}` : err.message;
    throw new Error(`Swarm node request failed: ${message}`, { cause: err });
  }

  if (!response.ok) {
    let text = '';
    if (response.status >= 300 && response.status < 400) {
      response.body?.cancel().catch(() => {});
    } else {
      text = await readErrorText(response.body);
    }
    const message = errorMessage(text) || response.statusText || `HTTP ${response.status}`;
    if (response.status === 404) {
      if (message.toLowerCase() === ACT_NOT_FOUND_MESSAGE) {
        throw actError('act_not_found', 'No ACT grant for this node from that publisher, or no such history');
      }
      throw actError('content_not_found', `Content not found: ${message}`);
    }
    if (response.status === 400) {
      throw actError('invalid_params', `The node refused the request: ${message}`);
    }
    throw actError('node_error', `The node could not open the share (HTTP ${response.status}): ${message}`);
  }

  const contentType = response.headers.get('content-type');
  const declared = declaredLength(response);
  try {
    if (declared !== null) {
      if (declared > meter.maxBytes) {
        throw actError('data_too_large', `Content exceeds the maximum read size of ${meter.maxBytes} bytes`, {
          limit: meter.maxBytes,
          actual: declared,
        });
      }
      const refusal = meter.reserve(declared);
      if (refusal) throw actError('refused', 'Read budget exceeded', { refusal });
    }
  } catch (err) {
    response.body?.cancel().catch(() => {});
    throw err;
  }

  const pieces = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (declared !== null) {
          if (total > declared) {
            throw new Error(`Node sent more than the ${declared} bytes it declared`);
          }
        } else {
          if (total > meter.maxBytes) {
            throw actError('data_too_large', `Content exceeds the maximum read size of ${meter.maxBytes} bytes`, {
              limit: meter.maxBytes,
            });
          }
          const refusal = meter.reserve(value.byteLength);
          if (refusal) throw actError('refused', 'Read budget exceeded', { refusal });
        }
        pieces.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      }
    } catch (err) {
      reader.cancel().catch(() => {});
      throw err;
    }
  }
  if (declared !== null && total !== declared) {
    throw new Error(`Node sent ${total} of the ${declared} bytes it declared`);
  }

  return {
    data: Buffer.concat(pieces, total).toString('base64'),
    encoding: 'base64',
    contentType: contentType || null,
  };
}

module.exports = { openActShare, ACT_READ_TIMEOUT_MS };
