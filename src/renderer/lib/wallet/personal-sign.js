/**
 * What a dApp's personal_sign signs, read the way main reads it
 * (`normalizeMessage` and `signsRawHash` in src/main/wallet/signing-utils.js):
 * a 0x string is strict hex, decoded; any other string is signed as UTF-8.
 */

/** A raw 32-byte value: its signature is exactly a Swarm feed update's (#89). */
export const RAW_HASH_LENGTH = 32;

const HEX_MESSAGE = /^0x(?:[0-9a-fA-F]{2})*$/;

/**
 * The bytes a personal_sign of `message` signs, or null when main would
 * refuse it (malformed hex) or can't be read here (not a string).
 * @param {unknown} message
 * @returns {Uint8Array|null}
 */
export function personalSignBytes(message) {
  if (typeof message !== 'string') return null;
  if (!message.startsWith('0x')) return new TextEncoder().encode(message);
  if (!HEX_MESSAGE.test(message)) return null;
  const bytes = new Uint8Array((message.length - 2) / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(message.slice(2 + 2 * i, 4 + 2 * i), 16);
  }
  return bytes;
}

/**
 * Whether a personal_sign of `message` signs exactly 32 bytes: a 64-digit
 * hex string and a 32-byte text both do. Such a request always shows its
 * prompt with a warning, even under signing auto-approve, as main requires.
 * A message that isn't a string counts too, as in main.
 * @param {unknown} message
 */
export function signsRawHash(message) {
  if (typeof message !== 'string') return true;
  return personalSignBytes(message)?.length === RAW_HASH_LENGTH;
}

/** `0x` and lowercase hex. */
export function bytesToHex(bytes) {
  return '0x' + Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
