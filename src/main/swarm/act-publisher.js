/**
 * The one normaliser for an ACT publisher key (#648).
 *
 * A page names the publisher of an ACT share by its secp256k1 public key,
 * in any of the spellings Bee and Ant accept: compressed (33 bytes, `02`/`03`)
 * or uncompressed (65 bytes, `04`), any hex case, with or without `0x`. The
 * consent prompt, the stored per-publisher grant and the header main sends to
 * the node must all name the same key, so every one of them goes through this
 * function and uses its compressed lower-case form, never the page's string.
 *
 * Hybrid keys (`06`/`07`), which the node would also take, are refused: no
 * client produces them and they would be a second spelling of one grant.
 */

const { SigningKey, computeAddress } = require('ethers');

const PUBLISHER_RE = /^(?:0x)?((?:0[23][0-9a-fA-F]{64})|(?:04[0-9a-fA-F]{128}))$/;

/**
 * @param {unknown} value
 * @returns {{ publicKey: string, address: string } | null} `publicKey` is the
 *   compressed key, 66 lower-case hex characters without `0x`; `address` is
 *   the key's checksummed Ethereum address. Null for anything else,
 *   including a point that is not on the curve.
 */
function normalizeActPublisher(value) {
  if (typeof value !== 'string') return null;
  const match = PUBLISHER_RE.exec(value);
  if (!match) return null;
  try {
    // ethers checks the point is on the curve. The regex above has already
    // pinned the length and prefix: given 32 bytes, ethers would read them
    // as a private key and derive a public key from it.
    const compressed = SigningKey.computePublicKey(`0x${match[1].toLowerCase()}`, true);
    return {
      publicKey: compressed.slice(2).toLowerCase(),
      address: computeAddress(compressed),
    };
  } catch {
    return null;
  }
}

module.exports = { normalizeActPublisher };
