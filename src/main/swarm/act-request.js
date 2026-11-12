/**
 * Validation of a `swarm_openAct` request (#648), in one place.
 *
 * Main checks a request twice: when the chrome asks what to show in the
 * consent prompt (swarm-permissions.js describeActRequest), and again when it
 * executes (swarm-provider-ipc.js handleOpenAct). Both use this function, so
 * the prompt only ever shows a request main would run, in main's own
 * canonical form (lower-case hex, the compressed publisher key), never the
 * page's text.
 */

const { normalizeActPublisher } = require('./act-publisher');

// Paths are capped like a URL's.
const ACT_MAX_PATH_BYTES = 1024;

function refuse(reason, message) {
  return { ok: false, reason, message };
}

function validateActPath(path) {
  if (path === undefined || path === null) return { ok: true, value: undefined };
  if (typeof path !== 'string') return refuse('invalid_path', 'path must be a string');
  if (path === '') return { ok: true, value: '' };
  if (Buffer.byteLength(path, 'utf-8') > ACT_MAX_PATH_BYTES) {
    return refuse('invalid_path', `path exceeds ${ACT_MAX_PATH_BYTES} UTF-8 bytes`);
  }
  if (path.startsWith('/') || path.includes('\\')) {
    return refuse('invalid_path', 'path must be relative and use / as its separator');
  }
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code < 32 || code === 127) {
      return refuse('invalid_path', 'path must not contain control characters');
    }
  }
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      return refuse('invalid_path', 'path must not contain empty, "." or ".." segments');
    }
  }
  return { ok: true, value: path };
}

/**
 * @param {unknown} params - the page's params
 * @returns {{ ok: false, reason: string, message: string, option?: string }
 *   | { ok: true, value: { reference: string, publisher: string, address: string,
 *       historyAddress: string, timestamp?: number, path?: string } }}
 *   `reason` is the -32602 `data.reason`.
 */
function validateActRequest(params) {
  if (!params || typeof params !== 'object') return refuse('invalid_params', 'params is required');

  const { options } = params;
  if (options !== undefined && options !== null) {
    if (typeof options !== 'object' || Array.isArray(options)) {
      return refuse('invalid_params', 'options must be an object');
    }
    const keys = Object.keys(options);
    if (keys.length > 0) {
      return { ...refuse('unsupported_option', `Unsupported option: ${keys[0]}`), option: keys[0] };
    }
  }

  const reference = typeof params.reference === 'string' ? params.reference : '';
  // A Swarm address: 32 bytes, or 64 for content uploaded encrypted.
  if (!/^(?:[0-9a-fA-F]{64}|[0-9a-fA-F]{128})$/.test(reference)) {
    return refuse('invalid_reference', 'reference must be a 64- or 128-character hex string');
  }

  const publisher = normalizeActPublisher(params.publisher);
  if (!publisher) {
    return refuse(
      'invalid_publisher',
      'publisher must be a secp256k1 public key: 66 hex characters starting 02 or 03, or 130 starting 04'
    );
  }

  const history = typeof params.historyAddress === 'string' ? params.historyAddress : '';
  if (!/^[0-9a-fA-F]{64}$/.test(history)) {
    return refuse('invalid_history_address', 'historyAddress must be a 64-character hex string');
  }

  const { timestamp } = params;
  if (
    timestamp !== undefined &&
    timestamp !== null &&
    (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp < 0)
  ) {
    return refuse('invalid_timestamp', 'timestamp must be a non-negative integer (unix seconds)');
  }

  const path = validateActPath(params.path);
  if (!path.ok) return path;

  return {
    ok: true,
    value: {
      reference: reference.toLowerCase(),
      publisher: publisher.publicKey,
      address: publisher.address,
      historyAddress: history.toLowerCase(),
      ...(timestamp !== undefined && timestamp !== null && { timestamp }),
      ...(path.value !== undefined && { path: path.value }),
    },
  };
}

module.exports = { validateActRequest, ACT_MAX_PATH_BYTES };
