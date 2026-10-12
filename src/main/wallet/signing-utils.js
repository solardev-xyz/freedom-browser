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
      // defineProperty, not assignment: a field named __proto__ is data.
      if (item !== undefined) {
        Object.defineProperty(out, key, {
          value: toCoreValue(item),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    return out;
  }
  return value;
}

// ethers' TypedDataEncoder walks a shared subtype once per path to it, so a
// diamond-shaped type graph costs it exponential time; the Ledger and phone
// backends run it on dApp input. This bound is far above any real payload.
const MAX_TYPE_PATHS = 10000;
// The identity core's own caps (freedom-core design 0002), checked first so
// the scan below is bounded even when a structured clone shares one field
// array between many types.
const MAX_TYPES = 256;
const MAX_FIELDS = 1024;

/**
 * Refuses a type graph ethers would take too long to walk: counts, in linear
 * time, the paths its dependency walk would visit from every type.
 * @param {object} types
 */
function assertBoundedTypeGraph(types) {
  if (!types || typeof types !== 'object') return;
  const names = Object.keys(types);
  if (names.length > MAX_TYPES) throw new Error('Typed data has too many types');
  let fields = 0;
  for (const name of names) {
    // Counted per type, so an array shared between types counts each time.
    if (Array.isArray(types[name])) fields += types[name].length;
    if (fields > MAX_FIELDS) throw new Error('Typed data has too many fields');
  }
  const children = new Map(names.map((name) => [name, new Set()]));
  for (const name of names) {
    for (const field of Array.isArray(types[name]) ? types[name] : []) {
      // This runs on dApp input, so it must stay linear: no coercion (an
      // array's toString rebuilds nested text), and indexOf, not a regex.
      const type = field?.type;
      if (typeof type !== 'string') {
        throw new Error('Typed data field types must be strings');
      }
      const bracket = type.indexOf('[');
      const base = bracket === -1 ? type : type.slice(0, bracket);
      if (base !== name && children.has(base)) children.get(name).add(base);
    }
  }
  const paths = new Map();
  const visiting = new Set();
  const pathsFrom = (name) => {
    if (paths.has(name)) return paths.get(name);
    // A cycle: ethers refuses it; let it say so.
    if (visiting.has(name)) return 1;
    visiting.add(name);
    let total = 1;
    for (const child of children.get(name)) {
      total += pathsFrom(child);
      if (total > MAX_TYPE_PATHS) break;
    }
    visiting.delete(name);
    paths.set(name, total);
    return total;
  };
  for (const name of names) {
    if (pathsFrom(name) > MAX_TYPE_PATHS) {
      throw new Error('Typed data has too many nested types');
    }
  }
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
  assertBoundedTypeGraph,
  getEip712WirePayload,
  messageToBytes,
};
