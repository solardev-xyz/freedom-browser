/**
 * Input-shape helpers shared by the signer backends.
 *
 * EIP-712 payloads arrive in the full dApp wire shape (EIP712Domain in
 * types); ethers' hashing helpers want the domain type stripped, while
 * device backends (Ledger app, phone wallet RPC) want the canonical wire
 * payload with EIP712Domain and primaryType restored. Both conversions
 * live here so every backend signs the same canonical bytes.
 */

const { TypedDataEncoder, Transaction } = require('ethers');

/**
 * 0x-hex dApp messages are signatures over the bytes, not the hex text.
 * The hex must be well-formed: Buffer.from(…, 'hex') silently stops at the
 * first bad digit, which would sign a different (shorter) message.
 */
function normalizeMessage(message) {
  if (typeof message === 'string' && message.startsWith('0x')) {
    if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(message)) {
      throw new Error('Invalid hex message');
    }
    return Buffer.from(message.slice(2), 'hex');
  }
  return message;
}

/** dApps send typed data either as an object or a JSON string. */
function normalizeTypedData(typedData) {
  return typeof typedData === 'string' ? JSON.parse(typedData) : typedData;
}

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

/**
 * A typed-data value as JSON for the identity core: BigInts become decimal
 * strings (x402 passes them), byte arrays become hex, undefined fields are
 * dropped (as JSON would).
 */
function toCoreValue(value) {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return '0x' + Buffer.from(value).toString('hex');
  if (Array.isArray(value)) return value.map(toCoreValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) out[key] = toCoreValue(item);
    }
    return out;
  }
  return value;
}

/**
 * The core's `typed_data` (freedom-core design 0002): the domain (absent
 * means empty, as in ethers), the types without EIP712Domain, the message.
 * primaryType is dropped; the core infers it as ethers does.
 */
function toCoreTypedData(typedData) {
  return {
    domain: toCoreValue(typedData.domain || {}),
    types: toCoreValue(withoutDomainType(typedData.types)),
    message: toCoreValue(typedData.message),
  };
}

/**
 * The core's `tx` for `sign.transaction`, read through ethers' own
 * Transaction so the request means exactly what Wallet.signTransaction
 * would have signed (type inference, defaults, validation). Returns the
 * ethers transaction too, to check the core's result against.
 */
function toCoreTransaction(request) {
  const { from, ...fields } = request;
  const unsigned = Transaction.from(fields);
  // Throws where ethers would refuse to serialize.
  void unsigned.unsignedSerialized;
  const type = unsigned.inferType();
  if (type !== 0 && type !== 2) throw new Error(`Unsupported transaction type ${type}`);
  if (unsigned.chainId === 0n) throw new Error('Transaction chainId is required');
  if (unsigned.accessList?.length) throw new Error('Access lists are not supported');
  const tx = {
    type,
    chain_id: unsigned.chainId.toString(),
    nonce: String(unsigned.nonce),
    gas_limit: unsigned.gasLimit.toString(),
    to: unsigned.to,
    value: unsigned.value.toString(),
    data: unsigned.data,
  };
  if (type === 0) {
    tx.gas_price = (unsigned.gasPrice ?? 0n).toString();
  } else {
    tx.max_fee_per_gas = (unsigned.maxFeePerGas ?? 0n).toString();
    tx.max_priority_fee_per_gas = (unsigned.maxPriorityFeePerGas ?? 0n).toString();
  }
  return { tx, unsigned, from };
}

/** EIP-191 personal messages sign over bytes; utf8-encode plain strings. */
function messageToBytes(message) {
  return Buffer.isBuffer(message) ? message : Buffer.from(String(message), 'utf8');
}

module.exports = {
  normalizeMessage,
  normalizeTypedData,
  withoutDomainType,
  toCoreTypedData,
  toCoreTransaction,
  getEip712WirePayload,
  messageToBytes,
};
