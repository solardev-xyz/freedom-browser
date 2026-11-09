/**
 * EIP-712 typed-data bounds checking for Ledger hardware signers.
 *
 * @ledgerhq/hw-app-eth 7.11.1 has known encoding defects during EIP-712 field signing:
 * 1. A value whose encoding is 255n+1 to 256n bytes long loses its last bytes
 *    (lib/modules/EIP712/index.js:168-187).
 * 2. An array with more than 255 entries is announced with a 1-byte count (intAsHexBytes(len, 1)),
 *    so 256 entries is transmitted as 0 (:164-166).
 * 3. Type or field names are prefixed with JavaScript name.length (UTF-16 code units)
 *    but sent as UTF-8 (utils.js:166-194), causing multi-byte names (e.g. non-ASCII 'é')
 *    to be mis-announced.
 * 4. Names >= 256 bytes create an APDU that exceeds the 255-byte limit and is refused by transport.
 *
 * This module inspects the full EIP-712 wire payload and refuses any typed data
 * that hits these boundaries BEFORE anything is sent to the Ledger device.
 */

const { LEDGER_ERROR_CODES, createLedgerError } = require('./errors');

function isAscii(str) {
  return typeof str === 'string' && /^[\x20-\x7E]*$/.test(str);
}

/**
 * Returns true if the value's byteLength causes hw-app-eth's chunking bug to lose bytes.
 * hw-app-eth prepends a 2-byte length header: dataLength = 2 + byteLength.
 * It allocates Math.ceil(dataLength / 256) chunks, each capped at 255 bytes.
 * If dataLength > Math.ceil(dataLength / 256) * 255, the trailing bytes are truncated.
 */
function hasHwAppEthChunkLoss(byteLength) {
  const dataLength = 2 + byteLength;
  const numSlices = Math.ceil(dataLength / 256);
  return dataLength > numSlices * 255;
}

function assertValidName(name) {
  if (typeof name !== 'string') return;
  if (!isAscii(name)) {
    throw createLedgerError(LEDGER_ERROR_CODES.UNSUPPORTED_TYPED_DATA);
  }
  if (Buffer.byteLength(name, 'utf8') > 255) {
    throw createLedgerError(LEDGER_ERROR_CODES.UNSUPPORTED_TYPED_DATA);
  }
}

function assertValidValue(value, type) {
  if (value == null) return;

  if (Array.isArray(value)) {
    if (value.length > 255) {
      throw createLedgerError(LEDGER_ERROR_CODES.UNSUPPORTED_TYPED_DATA);
    }
    const itemType = type ? type.replace(/\[\d*\]$/, '') : '';
    for (const item of value) {
      assertValidValue(item, itemType);
    }
    return;
  }

  if (typeof value === 'object' && !Buffer.isBuffer(value)) {
    for (const [k, v] of Object.entries(value)) {
      assertValidName(k);
      assertValidValue(v);
    }
    return;
  }

  if (typeof value === 'string') {
    let byteLength;
    if (type?.startsWith('bytes') && type !== 'bytes') {
      // Fixed bytes (e.g. bytes32)
      byteLength = (value.startsWith('0x') ? value.length - 2 : value.length) / 2;
    } else if (type === 'bytes' || (!type && value.startsWith('0x') && value.length % 2 === 0)) {
      byteLength = (value.startsWith('0x') ? value.length - 2 : value.length) / 2;
    } else {
      byteLength = Buffer.byteLength(value, 'utf8');
    }
    if (hasHwAppEthChunkLoss(byteLength)) {
      throw createLedgerError(LEDGER_ERROR_CODES.UNSUPPORTED_TYPED_DATA);
    }
  } else if (Buffer.isBuffer(value)) {
    if (hasHwAppEthChunkLoss(value.length)) {
      throw createLedgerError(LEDGER_ERROR_CODES.UNSUPPORTED_TYPED_DATA);
    }
  }
}

/**
 * Validates full EIP-712 wire payload for compatibility with hw-app-eth.
 * Throws LEDGER_UNSUPPORTED_TYPED_DATA if any defective boundary is violated.
 *
 * @param {{types?: object, primaryType?: string, domain?: object, message?: object}} payload
 */
function validateLedgerEip712(payload) {
  if (!payload || typeof payload !== 'object') return;

  if (payload.primaryType) {
    assertValidName(payload.primaryType);
  }

  if (payload.types && typeof payload.types === 'object') {
    for (const [typeName, fields] of Object.entries(payload.types)) {
      assertValidName(typeName);
      if (Array.isArray(fields)) {
        for (const field of fields) {
          assertValidName(field?.name);
          assertValidName(field?.type);
        }
      }
    }
  }

  if (payload.domain && typeof payload.domain === 'object') {
    assertValidValue(payload.domain);
  }

  if (payload.message && typeof payload.message === 'object') {
    assertValidValue(payload.message);
  }
}

module.exports = {
  validateLedgerEip712,
  hasHwAppEthChunkLoss,
  isAscii,
};
