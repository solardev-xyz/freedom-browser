/**
 * The ERC-4361 (Sign-In with Ethereum) message Freedom signs for a site's
 * HTTP challenge (#1152). Laid out exactly as ERC-4361's ABNF and the
 * reference `siwe` library do, so any SIWE verifier parses it.
 *
 *   ${scheme://}${domain} wants you to sign in with your Ethereum account:
 *   ${address}
 *
 *   ${statement}
 *
 *   URI: ${uri}
 *   Version: 1
 *   Chain ID: ${chainId}
 *   Nonce: ${nonce}
 *   Issued At: ${issuedAt}
 *   [Expiration Time / Not Before / Request ID]
 *
 * Without a statement the address is followed by two blank lines, as the
 * ABNF has it. The scheme prefix is left out for https, the ERC's default.
 */

const { getAddress } = require('ethers');

/**
 * @param {Object} fields - a bound challenge (challenge.js bindChallenge)
 *   plus `address` and `issuedAt` (an ISO 8601 / RFC 3339 time)
 * @returns {string}
 */
function buildSiweMessage(fields) {
  const {
    scheme,
    domain,
    address,
    statement,
    uri,
    version,
    chainId,
    nonce,
    issuedAt,
    expirationTime,
    notBefore,
    requestId,
  } = fields;
  const prefix = scheme && scheme !== 'https' ? `${scheme}://` : '';
  let message = `${prefix}${domain} wants you to sign in with your Ethereum account:\n`;
  message += `${getAddress(address)}\n\n`;
  if (statement) message += `${statement}\n`;
  message += `\nURI: ${uri}`;
  message += `\nVersion: ${version || '1'}`;
  message += `\nChain ID: ${chainId}`;
  message += `\nNonce: ${nonce}`;
  message += `\nIssued At: ${issuedAt}`;
  if (expirationTime) message += `\nExpiration Time: ${expirationTime}`;
  if (notBefore) message += `\nNot Before: ${notBefore}`;
  if (requestId) message += `\nRequest ID: ${requestId}`;
  return message;
}

/**
 * The `Authorization` header value carrying a signed message:
 * `SIWE result="<base64url of {"message","signature"}>"`.
 */
function authorizationValue(message, signature) {
  const json = JSON.stringify({ message, signature });
  return `SIWE result="${Buffer.from(json, 'utf8').toString('base64url')}"`;
}

module.exports = { buildSiweMessage, authorizationValue };
