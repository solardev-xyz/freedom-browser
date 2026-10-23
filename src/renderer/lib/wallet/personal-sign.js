/**
 * A personal_sign's bytes for its approval screen. Main reads the dApp's
 * message (`wallet:message-view`: strict 0x hex decoded, any other string
 * as UTF-8) and hands the screen the very bytes it sends to sign, as hex,
 * with whether they are a raw 32-byte value (freedom-core #88, #89). These
 * helpers only turn that hex back into something to show.
 */

const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;

/** `0x` hex to bytes (an even number of hex digits), or null. */
export function hexToBytes(hex) {
  if (typeof hex !== 'string' || !HEX.test(hex)) return null;
  const bytes = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(2 + 2 * i, 4 + 2 * i), 16);
  }
  return bytes;
}

/** The bytes as text, when they are well-formed UTF-8; null otherwise. */
export function utf8Text(bytes) {
  if (!bytes) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** `0x` and lowercase hex. */
export function bytesToHex(bytes) {
  return '0x' + Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
