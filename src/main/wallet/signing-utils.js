/**
 * Input-shape helpers shared by the signer backends.
 *
 * EIP-712 payloads arrive in the full dApp wire shape (EIP712Domain in
 * types); ethers' hashing helpers want the domain type stripped, while
 * device backends (Ledger app, phone wallet RPC) want the canonical wire
 * payload with EIP712Domain and primaryType restored. Both conversions
 * live here so every backend signs the same canonical bytes.
 */

const { TypedDataEncoder } = require('ethers');

/** Types with EIP712Domain stripped, as ethers' hashing helpers expect. */
function withoutDomainType(types) {
  const stripped = { ...types };
  delete stripped.EIP712Domain;
  return stripped;
}

/**
 * The canonical EIP-712 wire payload plus the pieces backends verify
 * with: getPayload reconstructs EIP712Domain in types and an explicit
 * primaryType when ethers-style callers omitted them.
 *
 * @param {{domain?: object, types: object, message: object}} typedData
 * @returns {{domain: object, strippedTypes: object, payload: object}}
 */
function getEip712WirePayload(typedData) {
  const domain = typedData.domain || {};
  const strippedTypes = withoutDomainType(typedData.types);
  const payload = TypedDataEncoder.getPayload(domain, strippedTypes, typedData.message);
  return { domain, strippedTypes, payload };
}

/** EIP-191 personal messages sign over bytes; utf8-encode plain strings. */
function messageToBytes(message) {
  return Buffer.isBuffer(message) ? message : Buffer.from(String(message), 'utf8');
}

module.exports = { withoutDomainType, getEip712WirePayload, messageToBytes };
