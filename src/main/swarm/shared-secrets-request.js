/**
 * Validation of a `swarm_deriveSharedSecrets` request, in one place.
 *
 * Main checks a request twice: when the chrome asks whether to show the
 * consent prompt at all (swarm-permissions.js describeSharedSecretsRequest),
 * and again when it executes (swarm-provider-ipc.js
 * handleDeriveSharedSecrets). Both use this function, so the user is never
 * asked to approve a request main would then refuse: an empty or oversized
 * list, a malformed key, or a key that is not a point on secp256k1.
 */

const { SigningKey } = require('ethers');

// Public keys per call: enough to wrap a group key for a large community in
// one approval.
const MAX_SHARED_SECRET_KEYS = 256;

// `data` holds the extra fields main's -32602 carries next to the reason.
function refuse(reason, message, data = {}) {
  return { ok: false, reason, message, data };
}

// A compressed (33-byte) or uncompressed (65-byte) secp256k1 public key,
// with or without 0x. Length is bounded before the regexp sees it (#478).
function parsePublicKey(value) {
  if (typeof value !== 'string') return null;
  const hex = value.replace(/^0x/, '');
  if (hex.length !== 66 && hex.length !== 130) return null;
  if (!/^(0[23][0-9a-fA-F]{64}|04[0-9a-fA-F]{128})$/.test(hex)) return null;
  return `0x${hex.toLowerCase()}`;
}

function isCurvePoint(publicKey) {
  try {
    SigningKey.computePublicKey(publicKey, true);
    return true;
  } catch {
    return false;
  }
}

/**
 * @returns {{ ok: true, value: { publicKeys: string[] } }
 *   | { ok: false, reason: string, message: string, data: Object }}
 *   publicKeys are 0x-prefixed lower-case hex, in the page's order.
 */
function validateSharedSecretsRequest(params) {
  if (!params || typeof params !== 'object') {
    return refuse('invalid_params', 'params is required');
  }

  const { options } = params;
  if (options !== undefined && options !== null) {
    if (typeof options !== 'object' || Array.isArray(options)) {
      return refuse('invalid_params', 'options must be an object');
    }
    const keys = Object.keys(options);
    if (keys.length > 0) {
      return refuse('unsupported_option', `Unsupported option: ${keys[0]}`, { option: keys[0] });
    }
  }

  const { publicKeys } = params;
  if (!Array.isArray(publicKeys) || publicKeys.length === 0) {
    return refuse('invalid_public_key', 'publicKeys must be a non-empty array');
  }
  if (publicKeys.length > MAX_SHARED_SECRET_KEYS) {
    return refuse(
      'payload_too_large',
      `publicKeys may hold at most ${MAX_SHARED_SECRET_KEYS} keys`,
      {
        limit: MAX_SHARED_SECRET_KEYS,
        actual: publicKeys.length,
      }
    );
  }

  const parsed = [];
  for (let index = 0; index < publicKeys.length; index += 1) {
    const publicKey = parsePublicKey(publicKeys[index]);
    if (!publicKey) {
      return refuse(
        'invalid_public_key',
        'each public key must be a hex secp256k1 public key, compressed (66 characters) or uncompressed (130)',
        { index }
      );
    }
    if (!isCurvePoint(publicKey)) {
      return refuse('invalid_public_key', 'public key is not a point on secp256k1', { index });
    }
    parsed.push(publicKey);
  }

  return { ok: true, value: { publicKeys: parsed } };
}

module.exports = { validateSharedSecretsRequest, MAX_SHARED_SECRET_KEYS };
