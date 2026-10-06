'use strict';

// Local offline-vector policy. No crypto imports, service state, or admission authority.
const { TextDecoder } = require('node:util');
const fail = (message) => {
  throw new Error(message);
};
const need = (condition, message) => {
  if (!condition) fail(message);
};
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, names, label) =>
  need(plain(value) && Object.keys(value).sort().join('|') === [...names].sort().join('|'), label);
const stringBound = (value, max, label) =>
  need(typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max, label);
const hex = (value, bytes, prefix = '') =>
  typeof value === 'string' && new RegExp(`^${prefix}[0-9a-fA-F]{${bytes * 2}}$`).test(value);

// Decode object keys before comparing them, including escaped equivalent spellings.
// JSON.parse is used only on a single scanned string token, never a whole object.
function parseBoundedJson(bytes, limits, byteLimit) {
  need(bytes instanceof Uint8Array && bytes.byteLength <= byteLimit, 'JSON byte bound');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  let offset = 0,
    members = 0,
    values = 0;
  const space = () => {
    while (/[\x20\t\r\n]/.test(text[offset] ?? '\0')) offset += 1;
  };
  function string() {
    const start = offset;
    need(text[offset++] === '"', 'String start');
    let escaped = false;
    for (; offset < text.length; offset += 1) {
      const char = text[offset];
      if (!escaped && char === '"') {
        offset += 1;
        const result = JSON.parse(text.slice(start, offset));
        need(Buffer.byteLength(result) <= limits.jsonStringBytes, 'JSON string bound');
        // Reject unpaired surrogate escapes rather than silently re-encoding replacements.
        for (let i = 0; i < result.length; i += 1) {
          const unit = result.charCodeAt(i);
          if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = result.charCodeAt(++i);
            need(next >= 0xdc00 && next <= 0xdfff, 'Unpaired surrogate');
          } else need(unit < 0xdc00 || unit > 0xdfff, 'Unpaired surrogate');
        }
        return result;
      }
      if (!escaped && char === '\\') escaped = true;
      else escaped = false;
    }
    return fail('Unterminated string');
  }
  function value(depth) {
    need(++values <= limits.jsonValues && depth <= limits.jsonDepth, 'JSON structural bound');
    space();
    const char = text[offset];
    if (char === '"') return string();
    if (char === '{' || char === '[') {
      const object = char === '{',
        result = object ? Object.create(null) : [],
        keys = new Set();
      offset += 1;
      space();
      const end = object ? '}' : ']';
      if (text[offset] === end) {
        offset += 1;
        return result;
      }
      while (true) {
        space();
        if (object) {
          const key = string();
          need(!keys.has(key), 'Duplicate decoded key');
          keys.add(key);
          need(++members <= limits.jsonMembers, 'JSON member bound');
          space();
          need(text[offset++] === ':', 'Object colon');
          result[key] = value(depth + 1);
        } else result.push(value(depth + 1));
        space();
        if (text[offset] === end) {
          offset += 1;
          return result;
        }
        need(text[offset++] === ',', 'Container delimiter');
      }
    }
    const tail = text.slice(offset);
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
      tail
    )?.[0];
    need(token !== undefined, 'JSON value');
    offset += token.length;
    const result = JSON.parse(token);
    need(typeof result !== 'number' || Number.isFinite(result), 'Finite number');
    return result;
  }
  const result = value(0);
  space();
  need(offset === text.length, 'Trailing JSON bytes');
  return result;
}

function parseSignedPacket(packetBytes, policy) {
  const packet = parseBoundedJson(packetBytes, policy.limits, policy.limits.packetBytes);
  exact(packet, ['data', 'signature'], 'Exact signed packet fields');
  need(
    typeof packet.data === 'string' &&
      packet.data.length > 0 &&
      packet.data.length <= policy.limits.signedDataBytes * 2 &&
      /^(?:[0-9a-fA-F]{2})+$/.test(packet.data),
    'Signed data hex'
  );
  need(hex(packet.signature, 64), 'Signature hex');
  const signedBytes = Buffer.from(packet.data, 'hex');
  const candidate = parseBoundedJson(signedBytes, policy.limits, policy.limits.signedDataBytes);
  need(plain(candidate), 'Candidate object');
  return { dataHex: packet.data, signatureHex: packet.signature, signedBytes, candidate };
}

// Call with actual upstream decoded address only after bounded parsing, before verification.
// An arbitrary supplied expected key is not trust: the campaign independently constructs
// both allowed genuine fixture keys using Node's Ed25519 seed derivation.
function validateCandidateKey(candidate, decoded, expected) {
  need(candidate.railgunAddress === expected.address, 'Expected exact fixture address');
  need(
    decoded?.viewingPublicKey instanceof Uint8Array && hex(expected.publicKeyHex, 32),
    'Decoded fixture key'
  );
  need(
    Buffer.from(decoded.viewingPublicKey).toString('hex') === expected.publicKeyHex,
    'Expected genuine fixture key'
  );
}
const versionParts = (version) => {
  need(
    typeof version === 'string' &&
      /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version),
    'Version format'
  );
  const parts = version.split('.').map(Number);
  need(parts.every(Number.isSafeInteger), 'Version integer');
  return parts;
};
const compareVersion = (left, right) => {
  for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
};

// This is policy on already verified bytes, not signature verification itself.
function validateQuoteFields(quote, decoded, context, policy) {
  exact(
    quote,
    [
      'fees',
      'feeExpiration',
      'feesID',
      'railgunAddress',
      'identifier',
      'availableWallets',
      'version',
      'relayAdapt',
      'requiredPOIListKeys',
      'reliability',
    ],
    'Exact quote fields'
  );
  need(
    context.topic === policy.topic &&
      context.chain.type === policy.chain.type &&
      context.chain.id === policy.chain.id &&
      context.deployment === policy.deployment,
    'Local topic/chain/deployment'
  );
  need(
    decoded.chain === undefined ||
      (decoded.chain.type === context.chain.type && decoded.chain.id === context.chain.id),
    'Address chain'
  );
  need(
    Number.isSafeInteger(context.nowMs) &&
      Number.isSafeInteger(context.previousNowMs) &&
      context.nowMs >= context.previousNowMs &&
      context.nowMs >= 0,
    'Monotonic local clock'
  );
  need(Number.isSafeInteger(quote.feeExpiration), 'Expiry safe integer');
  const remaining = quote.feeExpiration - context.nowMs;
  need(
    remaining >= policy.quoteMinimumRemainingMs && remaining <= policy.quoteMaximumRemainingMs,
    'Expiry local bounds'
  );
  stringBound(quote.feesID, policy.limits.feesIdBytes, 'Fees ID');
  stringBound(quote.identifier, policy.limits.identifierBytes, 'Identifier');
  need(
    Number.isSafeInteger(quote.availableWallets) &&
      quote.availableWallets >= 1 &&
      quote.availableWallets <= policy.maximumAvailableWallets,
    'Available wallets'
  );
  need(
    typeof quote.reliability === 'number' &&
      Number.isFinite(quote.reliability) &&
      quote.reliability >= 0.75 &&
      quote.reliability <= 1,
    'Reliability'
  );
  const version = versionParts(quote.version);
  need(
    compareVersion(version, versionParts(policy.broadcasterVersion.min)) >= 0 &&
      compareVersion(version, versionParts(policy.broadcasterVersion.max)) <= 0,
    'Version range'
  );
  need(quote.relayAdapt === policy.relayAdapt, 'Expected relay adapt');
  need(plain(quote.fees), 'Fee map');
  const tokens = Object.keys(quote.fees),
    normalized = new Set();
  need(tokens.length > 0 && tokens.length <= policy.limits.quoteTokens, 'Token count');
  for (const token of tokens) {
    need(hex(token, 20, '0x') && !normalized.has(token.toLowerCase()), 'Unique token address');
    normalized.add(token.toLowerCase());
    const fee = quote.fees[token];
    need(
      typeof fee === 'string' &&
        /^0x[0-9a-fA-F]+$/.test(fee) &&
        fee.length <= 2 + policy.limits.feeIntegerBits / 4 &&
        BigInt(fee) > 0n,
      'Bounded positive fee'
    );
  }
  need(Object.hasOwn(quote.fees, policy.tokenAddress), 'Selected token fee');
  need(
    Array.isArray(quote.requiredPOIListKeys) &&
      quote.requiredPOIListKeys.length <= policy.limits.poiLists,
    'Required POI list'
  );
  const seen = new Set();
  for (const key of quote.requiredPOIListKeys) {
    need(hex(key, 32) && !seen.has(key.toLowerCase()), 'Unique POI key');
    seen.add(key.toLowerCase());
    need(context.activePOIListKeys.includes(key), 'Active POI coverage');
  }
  return {
    chainBinding:
      decoded.chain === undefined
        ? 'local-context-only-all-chains-address'
        : 'signed-address-chain-plus-local-topic',
    tokenSelectionIsLocal: true,
  };
}

function parseReply(plaintextBytes, policy) {
  const reply = parseBoundedJson(plaintextBytes, policy.limits, policy.limits.replyBytes);
  need(plain(reply), 'Reply object');
  if (Object.hasOwn(reply, 'txHash')) {
    exact(reply, ['txHash'], 'Exact hash reply');
    need(hex(reply.txHash, 32, '0x'), 'Transaction hash');
    return { kind: 'hash', txHash: reply.txHash };
  }
  exact(reply, ['error'], 'Exact error reply');
  stringBound(reply.error, policy.limits.errorBytes, 'Reply error');
  return { kind: 'error', error: reply.error };
}

// No peer-authenticated operation ID is invented. A retained operation owns its fresh
// key; its key must decrypt the reply, while an independent concurrent key must fail.
function validateCommonPlaintext(value, expected, policy) {
  exact(
    value,
    [
      'transactType',
      'txidVersion',
      'to',
      'data',
      'broadcasterViewingKey',
      'chainID',
      'chainType',
      'minGasPrice',
      'feesID',
      'useRelayAdapt',
      'devLog',
      'minVersion',
      'maxVersion',
      'preTransactionPOIsPerTxidLeafPerList',
    ],
    'Exact COMMON fields'
  );
  const fields = {
    transactType: 'COMMON',
    txidVersion: policy.txidVersion,
    to: policy.deployment,
    data: expected.data,
    broadcasterViewingKey: expected.publicKeyHex,
    chainID: policy.chain.id,
    chainType: policy.chain.type,
    minGasPrice: expected.minGasPrice,
    feesID: expected.feesID,
    useRelayAdapt: false,
    devLog: false,
    minVersion: policy.broadcasterVersion.min,
    maxVersion: policy.broadcasterVersion.max,
  };
  for (const [key, target] of Object.entries(fields)) need(value[key] === target, `COMMON ${key}`);
  need(
    plain(value.preTransactionPOIsPerTxidLeafPerList) &&
      Object.keys(value.preTransactionPOIsPerTxidLeafPerList).length === 0,
    'Explicit empty synthetic POI map'
  );
  return true;
}

function validateEncryptedData(value, maximumCiphertextBytes) {
  need(Array.isArray(value) && value.length === 2, 'Encrypted tuple');
  need(hex(value[0], 32, '0x'), 'IV/tag exactly 16+16 bytes');
  need(
    typeof value[1] === 'string' &&
      /^0x(?:[0-9a-fA-F]{2})+$/.test(value[1]) &&
      value[1].length <= 2 + maximumCiphertextBytes * 2,
    'Bounded nonempty ciphertext'
  );
  return value;
}

function parseRequestEnvelope(bytes, policy) {
  const request = parseBoundedJson(bytes, policy.limits, policy.limits.requestBytes);
  exact(request, ['pubkey', 'encryptedData'], 'Exact request params');
  need(hex(request.pubkey, 32), 'Ephemeral public key encoding');
  validateEncryptedData(request.encryptedData, policy.limits.requestBytes / 2);
  return request;
}

module.exports = {
  parseBoundedJson,
  parseSignedPacket,
  validateCandidateKey,
  validateQuoteFields,
  parseReply,
  validateCommonPlaintext,
  validateEncryptedData,
  parseRequestEnvelope,
};
