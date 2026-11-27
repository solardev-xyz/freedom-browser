/**
 * Ledger error mapping.
 *
 * Transport and app errors from `@ledgerhq/*` come as TransportStatusError
 * (with a `statusCode` APDU status word), named transport errors, or plain
 * node-hid failures. Map them to stable machine codes + user-facing
 * messages so the renderer can drive the connect/sign UX ("unlock your
 * Ledger", "open the Ethereum app", "request rejected on device") without
 * string-matching library internals.
 */

const LEDGER_ERROR_CODES = {
  DEVICE_NOT_FOUND: 'LEDGER_DEVICE_NOT_FOUND',
  DEVICE_LOCKED: 'LEDGER_DEVICE_LOCKED',
  ETH_APP_NOT_OPEN: 'LEDGER_ETH_APP_NOT_OPEN',
  USER_REJECTED: 'LEDGER_USER_REJECTED',
  DISCONNECTED: 'LEDGER_DISCONNECTED',
  BUSY: 'LEDGER_BUSY',
  WRONG_DEVICE: 'LEDGER_WRONG_DEVICE',
  BLIND_SIGNING_REQUIRED: 'LEDGER_BLIND_SIGNING_REQUIRED',
  // The device's signature doesn't recover to the account over what was
  // asked (a mis-encoded request, a confused device, a faulty transport).
  BAD_SIGNATURE: 'LEDGER_BAD_SIGNATURE',
  // Adding an account: the device holds another address at that path.
  ADDRESS_MISMATCH: 'LEDGER_ADDRESS_MISMATCH',
  // An account no Ledger has yet shown to hold its address at its path.
  ACCOUNT_UNCHECKED: 'LEDGER_ACCOUNT_UNCHECKED',
  UNKNOWN: 'LEDGER_UNKNOWN',
  // The core's backend (design 0016, API, "Errors"): no answer in 15 s to
  // an APDU the user doesn't confirm.
  UNRESPONSIVE: 'LEDGER_UNRESPONSIVE',
  // No confirmation in 5 minutes to the one the user confirms.
  TIMEOUT: 'LEDGER_TIMEOUT',
  // Typed data, a message or a transaction a Ledger can't carry (deviation
  // `device-bounds`), refused before the first APDU.
  TOO_LARGE: 'LEDGER_TOO_LARGE',
  // An empty `personal_sign` (deviation `empty-message`), refused before
  // the first APDU.
  EMPTY_MESSAGE: 'LEDGER_EMPTY_MESSAGE',
  // An array suffix written in a form the device wouldn't rebuild from its
  // descriptor (`uint8[02]`), refused before the first APDU.
  TYPE_NOT_CANONICAL: 'LEDGER_TYPE_NOT_CANONICAL',
  // The user's Cancel (or Reject) while the Ledger waited (design 0016,
  // "Deadlines, cancel and unplugging", deviation `cancel`): main's own
  // cancel of the core's request, nothing signed.
  CANCELLED: 'LEDGER_CANCELLED',
};

const MESSAGES = {
  [LEDGER_ERROR_CODES.DEVICE_NOT_FOUND]: 'No Ledger device found. Connect it via USB and unlock it.',
  [LEDGER_ERROR_CODES.DEVICE_LOCKED]: 'Ledger is locked. Unlock it with your PIN.',
  [LEDGER_ERROR_CODES.ETH_APP_NOT_OPEN]: 'Open the Ethereum app on your Ledger.',
  [LEDGER_ERROR_CODES.USER_REJECTED]: 'Request rejected on the Ledger device.',
  [LEDGER_ERROR_CODES.DISCONNECTED]: 'Ledger was disconnected. Reconnect it and try again.',
  [LEDGER_ERROR_CODES.BUSY]: 'Ledger is busy with another request. Finish or dismiss it on the device.',
  [LEDGER_ERROR_CODES.WRONG_DEVICE]:
    'This Ledger does not hold the selected account. Connect the device this account was added from.',
  [LEDGER_ERROR_CODES.BLIND_SIGNING_REQUIRED]:
    'Ledger cannot display this contract call. Enable "Blind signing" (called "Contract data" on older app versions) in the Ethereum app settings, then try again.',
  [LEDGER_ERROR_CODES.BAD_SIGNATURE]:
    "The Ledger returned a signature that doesn't match this request. Nothing was sent.",
  [LEDGER_ERROR_CODES.ADDRESS_MISMATCH]:
    "This Ledger holds a different address at that path. The account wasn't added.",
  [LEDGER_ERROR_CODES.ACCOUNT_UNCHECKED]:
    "This Ledger account hasn't been checked on its Ledger yet. Connect that Ledger and open Connect Hardware Wallet, then try again.",
  [LEDGER_ERROR_CODES.UNKNOWN]: 'Ledger error. Reconnect the device and try again.',
  // UNRESPONSIVE, TIMEOUT and TYPE_NOT_CANONICAL are 0016's own texts
  // ("Deadlines, cancel and unplugging", "Bounds"); 0016 names TOO_LARGE
  // and EMPTY_MESSAGE without one, so theirs follow BAD_SIGNATURE's form.
  [LEDGER_ERROR_CODES.UNRESPONSIVE]: 'The Ledger stopped answering. Reconnect it and try again.',
  [LEDGER_ERROR_CODES.TIMEOUT]:
    "The Ledger wasn't confirmed in 5 minutes. If it still shows the request, reject it there.",
  [LEDGER_ERROR_CODES.TOO_LARGE]: 'This request is too large for a Ledger to sign. Nothing was sent.',
  [LEDGER_ERROR_CODES.EMPTY_MESSAGE]: "A Ledger can't sign an empty message. Nothing was sent.",
  [LEDGER_ERROR_CODES.TYPE_NOT_CANONICAL]:
    "This request writes a type in a form a Ledger can't sign. Nothing was sent.",
  // What Freedom says after a Cancel or a Reject while the Ledger waits
  // (the LDG-3 plan's point 18): closing the device doesn't clear its
  // screen, so the request may still show there. This is option (a), the
  // recommended one, while the user's decision is pending; option (b)
  // would just close the screen. Every surface (the send screen, the
  // approvals document, the chrome's dApp screen) shows this text and no
  // copy of it, so changing the option changes this line.
  [LEDGER_ERROR_CODES.CANCELLED]: 'Cancelled. If your Ledger still shows the request, reject it there.',
};

const KNOWN_CODES = new Set(Object.values(LEDGER_ERROR_CODES));

/**
 * Mint an error from the code registry — the only way LEDGER_* errors
 * should be created outside of `mapLedgerError`.
 *
 * @param {string} code - One of LEDGER_ERROR_CODES
 * @returns {Error & {code: string}}
 */
function createLedgerError(code) {
  const err = new Error(MESSAGES[code] || MESSAGES[LEDGER_ERROR_CODES.UNKNOWN]);
  err.code = code;
  return err;
}

// APDU status words (TransportStatusError.statusCode)
const STATUS_TO_CODE = {
  0x5515: LEDGER_ERROR_CODES.DEVICE_LOCKED,
  0x6982: LEDGER_ERROR_CODES.DEVICE_LOCKED, // security not satisfied (locked mid-session)
  0x6985: LEDGER_ERROR_CODES.USER_REJECTED, // conditions of use not satisfied
  0x5501: LEDGER_ERROR_CODES.USER_REJECTED, // user refused on device
  // "incorrect data" from the Ethereum app while signing means it refused
  // to sign data it cannot decode: blind signing is off. Unavoidable here
  // because we never resolve clear-signing metadata (see signer.js), and
  // it is the factory default, so it needs its own actionable message.
  0x6a80: LEDGER_ERROR_CODES.BLIND_SIGNING_REQUIRED,
  0x6511: LEDGER_ERROR_CODES.ETH_APP_NOT_OPEN, // app not started
  0x6d00: LEDGER_ERROR_CODES.ETH_APP_NOT_OPEN, // INS not supported (wrong app)
  0x6e00: LEDGER_ERROR_CODES.ETH_APP_NOT_OPEN, // CLA not supported (wrong app)
  0x6e01: LEDGER_ERROR_CODES.ETH_APP_NOT_OPEN,
};

// Named errors from @ledgerhq/errors / node-hid
const NAME_TO_CODE = {
  TransportOpenUserCancelled: LEDGER_ERROR_CODES.DEVICE_NOT_FOUND,
  CantOpenDevice: LEDGER_ERROR_CODES.DEVICE_NOT_FOUND,
  NoDeviceFound: LEDGER_ERROR_CODES.DEVICE_NOT_FOUND,
  DisconnectedDevice: LEDGER_ERROR_CODES.DISCONNECTED,
  DisconnectedDeviceDuringOperation: LEDGER_ERROR_CODES.DISCONNECTED,
  TransportRaceCondition: LEDGER_ERROR_CODES.BUSY,
  TransportInterfaceNotAvailable: LEDGER_ERROR_CODES.BUSY,
  LockedDeviceError: LEDGER_ERROR_CODES.DEVICE_LOCKED,
  // hw-app-eth rewrites 0x6a80 from the tx-signing path into this named
  // error (it carries no statusCode of its own).
  EthAppPleaseEnableContractData: LEDGER_ERROR_CODES.BLIND_SIGNING_REQUIRED,
};

/**
 * Classify a raw `@ledgerhq/*` / node-hid error into a stable code.
 *
 * @param {unknown} err
 * @returns {string} One of LEDGER_ERROR_CODES
 */
function classifyLedgerError(err) {
  if (!err || typeof err !== 'object') return LEDGER_ERROR_CODES.UNKNOWN;
  if (typeof err.statusCode === 'number' && STATUS_TO_CODE[err.statusCode]) {
    return STATUS_TO_CODE[err.statusCode];
  }
  if (err.name && NAME_TO_CODE[err.name]) {
    return NAME_TO_CODE[err.name];
  }
  const message = String(err.message || '');
  if (/cannot open device|no device/i.test(message)) {
    return LEDGER_ERROR_CODES.DEVICE_NOT_FOUND;
  }
  if (/disconnected/i.test(message)) {
    return LEDGER_ERROR_CODES.DISCONNECTED;
  }
  return LEDGER_ERROR_CODES.UNKNOWN;
}

/**
 * Wrap a raw Ledger error into an Error with a stable `.code` and a
 * user-facing message. Errors that already carry a LEDGER_* code pass
 * through unchanged.
 *
 * @param {unknown} err
 * @returns {Error & {code: string}}
 */
function mapLedgerError(err) {
  if (err && typeof err === 'object' && typeof err.code === 'string' && err.code.startsWith('LEDGER_')) {
    return err;
  }
  const code = classifyLedgerError(err);
  const mapped = new Error(MESSAGES[code], { cause: err });
  mapped.code = code;
  return mapped;
}

function isLedgerUserRejection(err) {
  return mapLedgerError(err).code === LEDGER_ERROR_CODES.USER_REJECTED;
}

/**
 * A device's failure as the identity core reports it on its backend
 * (freedom-core design 0016, API, "Errors"): `device_failed` with
 * `data.ledger`, a LEDGER_* code, becomes an Error with that code and this
 * table's text, the core's error kept as its cause; a code this table
 * doesn't name is LEDGER_UNKNOWN. Null for any other error.
 *
 * @param {unknown} err
 * @returns {(Error & {code: string})|null}
 */
function fromCoreError(err) {
  if (!err || typeof err !== 'object' || err.code !== 'device_failed') return null;
  const named = err.data?.ledger;
  const code = KNOWN_CODES.has(named) ? named : LEDGER_ERROR_CODES.UNKNOWN;
  const mapped = new Error(MESSAGES[code], { cause: err });
  mapped.code = code;
  return mapped;
}

/**
 * The text Freedom shows once the user cancelled a request the Ledger
 * waited on (point 18; MESSAGES says why it lives there).
 *
 * @returns {string}
 */
function ledgerCancelledNotice() {
  return MESSAGES[LEDGER_ERROR_CODES.CANCELLED];
}

module.exports = {
  LEDGER_ERROR_CODES,
  createLedgerError,
  ledgerCancelledNotice,
  mapLedgerError,
  isLedgerUserRejection,
  fromCoreError,
};
