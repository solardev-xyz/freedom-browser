/**
 * Vaughan bridge error mapping.
 *
 * Vaughan speaks EIP-1193 codes over JSON-RPC; map them to stable app-level
 * codes so callers can distinguish user rejection from transport failures.
 */

const VAUGHAN_ERROR_CODES = {
  USER_REJECTED: 'VAUGHAN_USER_REJECTED',
  UNAUTHORIZED: 'VAUGHAN_UNAUTHORIZED',
  NOT_CONNECTED: 'VAUGHAN_NOT_CONNECTED',
  DISCONNECTED: 'VAUGHAN_DISCONNECTED',
  UNSUPPORTED_METHOD: 'VAUGHAN_UNSUPPORTED_METHOD',
  INVALID_PARAMS: 'VAUGHAN_INVALID_PARAMS',
  INTERNAL: 'VAUGHAN_INTERNAL',
};

const EIP1193_TO_VAUGHAN = {
  4001: VAUGHAN_ERROR_CODES.USER_REJECTED,
  4100: VAUGHAN_ERROR_CODES.UNAUTHORIZED,
  4200: VAUGHAN_ERROR_CODES.UNSUPPORTED_METHOD,
  4900: VAUGHAN_ERROR_CODES.DISCONNECTED,
  '-32602': VAUGHAN_ERROR_CODES.INVALID_PARAMS,
};

const MESSAGES = {
  [VAUGHAN_ERROR_CODES.USER_REJECTED]: 'Request rejected in Vaughan.',
  [VAUGHAN_ERROR_CODES.UNAUTHORIZED]: 'Vaughan rejected this account or origin.',
  [VAUGHAN_ERROR_CODES.NOT_CONNECTED]:
    'Vaughan is locked or this site was disconnected. Unlock Vaughan and reconnect from the dApp.',
  [VAUGHAN_ERROR_CODES.DISCONNECTED]: 'Cannot connect to Vaughan. Start the wallet and try again.',
  [VAUGHAN_ERROR_CODES.UNSUPPORTED_METHOD]: 'Vaughan does not support this request.',
  [VAUGHAN_ERROR_CODES.INVALID_PARAMS]: 'Invalid request for Vaughan signer.',
  [VAUGHAN_ERROR_CODES.INTERNAL]: 'Vaughan request failed. Try again.',
};

function createVaughanError(code, cause, message) {
  const text = message || MESSAGES[code] || MESSAGES[VAUGHAN_ERROR_CODES.INTERNAL];
  const err = new Error(text, { cause });
  err.code = code;
  return err;
}

function mapVaughanError(err) {
  if (
    err &&
    typeof err === 'object' &&
    typeof err.code === 'string' &&
    err.code.startsWith('VAUGHAN_')
  ) {
    return err;
  }
  if (err && typeof err === 'object' && typeof err.eip1193Code === 'number') {
    const code = EIP1193_TO_VAUGHAN[err.eip1193Code] || VAUGHAN_ERROR_CODES.INTERNAL;
    // Prefer the server's detail ("wallet is locked; unlock it first", …)
    // over the generic mapping — Vaughan never puts secrets in messages.
    const detail = typeof err.message === 'string' && err.message ? err.message : undefined;
    return createVaughanError(code, err, detail);
  }
  if (err && typeof err === 'object' && typeof err.code === 'string') {
    if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE'].includes(err.code)) {
      return createVaughanError(VAUGHAN_ERROR_CODES.DISCONNECTED, err);
    }
  }
  return createVaughanError(VAUGHAN_ERROR_CODES.INTERNAL, err);
}

module.exports = { VAUGHAN_ERROR_CODES, createVaughanError, mapVaughanError };
