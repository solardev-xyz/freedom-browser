/**
 * Remote-signer error mapping.
 *
 * Remote (phone) signing fails in ways the renderer must distinguish to
 * drive the QR/waiting UX: nobody scanned in time, the user dismissed the
 * dialog in the browser, the phone's wallet rejected the request, or the
 * phone answered from a different account than the one on record. Stable
 * REMOTE_* codes mirror the LEDGER_* registry (see ../ledger/errors.js)
 * so approval UIs handle both hardware families the same way.
 */

const REMOTE_ERROR_CODES = {
  TIMEOUT: 'REMOTE_TIMEOUT',
  USER_CANCELLED: 'REMOTE_USER_CANCELLED',
  USER_REJECTED: 'REMOTE_USER_REJECTED',
  WRONG_ACCOUNT: 'REMOTE_WRONG_ACCOUNT',
  BAD_RESPONSE: 'REMOTE_BAD_RESPONSE',
  NO_UI: 'REMOTE_NO_UI',
  UNSUPPORTED: 'REMOTE_UNSUPPORTED',
  UNKNOWN: 'REMOTE_UNKNOWN',
};

const MESSAGES = {
  [REMOTE_ERROR_CODES.TIMEOUT]: 'Your phone did not respond in time. Try again with a new QR code.',
  [REMOTE_ERROR_CODES.USER_CANCELLED]: 'Request cancelled.',
  [REMOTE_ERROR_CODES.USER_REJECTED]: 'Request rejected on your phone.',
  [REMOTE_ERROR_CODES.WRONG_ACCOUNT]:
    'Your phone answered from a different account than this wallet. Select the right account on your phone and try again.',
  [REMOTE_ERROR_CODES.BAD_RESPONSE]: 'Your phone sent an invalid response. Try again.',
  [REMOTE_ERROR_CODES.NO_UI]: 'No browser window available to show the signing QR code.',
  [REMOTE_ERROR_CODES.UNSUPPORTED]: 'This request type is not supported by phone accounts.',
  [REMOTE_ERROR_CODES.UNKNOWN]: 'Phone signing failed. Try again.',
};

/**
 * Mint an error from the code registry.
 *
 * @param {string} code - One of REMOTE_ERROR_CODES
 * @param {string} [message] - Override the registry message (e.g. to
 *   surface the phone wallet's own error text).
 * @returns {Error & {code: string}}
 */
function createRemoteError(code, message) {
  const err = new Error(message || MESSAGES[code] || MESSAGES[REMOTE_ERROR_CODES.UNKNOWN]);
  err.code = code;
  return err;
}

// EIP-1193 provider error codes a phone wallet may return.
const RPC_CODE_TO_CODE = {
  4001: REMOTE_ERROR_CODES.USER_REJECTED, // user rejected request
  4100: REMOTE_ERROR_CODES.WRONG_ACCOUNT, // unauthorized account
  4200: REMOTE_ERROR_CODES.UNSUPPORTED, // unsupported method
};

/**
 * Map a JSON-RPC error object returned by the phone wallet
 * (`{code, message}`) into a stable REMOTE_* error.
 *
 * @param {{code?: number, message?: string}|unknown} rpcError
 * @returns {Error & {code: string}}
 */
function mapRemoteRpcError(rpcError) {
  const rpcCode = rpcError && typeof rpcError === 'object' ? rpcError.code : undefined;
  const code = RPC_CODE_TO_CODE[rpcCode] || REMOTE_ERROR_CODES.UNKNOWN;
  const phoneMessage =
    rpcError && typeof rpcError === 'object' && typeof rpcError.message === 'string'
      ? rpcError.message
      : undefined;
  // User rejection keeps our neutral message; other failures surface the
  // phone wallet's own text since it names the actual problem.
  return createRemoteError(code, code === REMOTE_ERROR_CODES.USER_REJECTED ? undefined : phoneMessage);
}

module.exports = { REMOTE_ERROR_CODES, createRemoteError, mapRemoteRpcError };
