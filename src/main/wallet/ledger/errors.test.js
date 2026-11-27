const {
  LEDGER_ERROR_CODES,
  createLedgerError,
  mapLedgerError,
  isLedgerUserRejection,
  fromCoreError,
  ledgerCancelledNotice,
} = require('./errors');

function statusError(statusCode) {
  const err = new Error(`status ${statusCode.toString(16)}`);
  err.statusCode = statusCode;
  return err;
}

function namedError(name) {
  const err = new Error(name);
  err.name = name;
  return err;
}

describe('mapLedgerError', () => {
  test.each([
    [0x6985, LEDGER_ERROR_CODES.USER_REJECTED],
    [0x5501, LEDGER_ERROR_CODES.USER_REJECTED],
    [0x5515, LEDGER_ERROR_CODES.DEVICE_LOCKED],
    [0x6982, LEDGER_ERROR_CODES.DEVICE_LOCKED],
    [0x6511, LEDGER_ERROR_CODES.ETH_APP_NOT_OPEN],
    [0x6d00, LEDGER_ERROR_CODES.ETH_APP_NOT_OPEN],
    [0x6e00, LEDGER_ERROR_CODES.ETH_APP_NOT_OPEN],
    [0x6a80, LEDGER_ERROR_CODES.BLIND_SIGNING_REQUIRED],
  ])('maps APDU status 0x%s to a stable code', (statusCode, expected) => {
    const mapped = mapLedgerError(statusError(statusCode));
    expect(mapped.code).toBe(expected);
    expect(mapped.message).not.toMatch(/status/); // user-facing, not raw
    expect(mapped.cause).toBeDefined();
  });

  test.each([
    ['CantOpenDevice', LEDGER_ERROR_CODES.DEVICE_NOT_FOUND],
    ['DisconnectedDeviceDuringOperation', LEDGER_ERROR_CODES.DISCONNECTED],
    ['TransportRaceCondition', LEDGER_ERROR_CODES.BUSY],
    ['LockedDeviceError', LEDGER_ERROR_CODES.DEVICE_LOCKED],
  ])('maps named transport error %s', (name, expected) => {
    expect(mapLedgerError(namedError(name)).code).toBe(expected);
  });

  // Signing without hosted clear-signing resolution means a factory-
  // default device (blind signing off) refuses every contract call —
  // the instruction has to name the setting, not "reconnect the device".
  test('blind-signing refusals tell the user which setting to enable', () => {
    const mapped = mapLedgerError(statusError(0x6a80));
    expect(mapped.code).toBe(LEDGER_ERROR_CODES.BLIND_SIGNING_REQUIRED);
    expect(mapped.message).toMatch(/blind signing/i);
    expect(mapped.message).not.toMatch(/reconnect/i);
  });

  test('maps the blind-signing error class hw-app-eth actually throws', () => {
    // The tx-signing path rewrites 0x6a80 into this named error, which
    // carries no statusCode of its own.
    const { EthAppPleaseEnableContractData } = require('@ledgerhq/hw-app-eth/lib/errors');
    const err = new EthAppPleaseEnableContractData(
      'Please enable Blind signing or Contract data in the Ethereum app Settings'
    );
    expect(err.statusCode).toBeUndefined();
    expect(mapLedgerError(err).code).toBe(LEDGER_ERROR_CODES.BLIND_SIGNING_REQUIRED);
  });

  test('maps node-hid "cannot open device" message', () => {
    expect(mapLedgerError(new Error('cannot open device with path X')).code)
      .toBe(LEDGER_ERROR_CODES.DEVICE_NOT_FOUND);
  });

  test('unknown errors get the UNKNOWN code, never throw', () => {
    expect(mapLedgerError(new Error('wat')).code).toBe(LEDGER_ERROR_CODES.UNKNOWN);
    expect(mapLedgerError(undefined).code).toBe(LEDGER_ERROR_CODES.UNKNOWN);
    expect(mapLedgerError('string').code).toBe(LEDGER_ERROR_CODES.UNKNOWN);
  });

  test('already-mapped errors pass through unchanged', () => {
    const mapped = mapLedgerError(statusError(0x6985));
    expect(mapLedgerError(mapped)).toBe(mapped);
  });
});

describe('createLedgerError', () => {
  test('mints an error with the registry code and message', () => {
    const err = createLedgerError(LEDGER_ERROR_CODES.WRONG_DEVICE);
    expect(err.code).toBe('LEDGER_WRONG_DEVICE');
    expect(err.message).toMatch(/does not hold/i);
    // Round-trips through mapLedgerError unchanged (LEDGER_ prefix pass-through)
    expect(mapLedgerError(err)).toBe(err);
  });
});

describe('isLedgerUserRejection', () => {
  test('true only for user rejection', () => {
    expect(isLedgerUserRejection(statusError(0x6985))).toBe(true);
    expect(isLedgerUserRejection(statusError(0x6511))).toBe(false);
    expect(isLedgerUserRejection(new Error('x'))).toBe(false);
  });
});

/**
 * The core's backend (freedom-core design 0016, API, "Errors"): a device's
 * failure is `device_failed` with `data.ledger`, and main shows this
 * table's text for it; 0016's five new codes have their texts here.
 */
describe('fromCoreError', () => {
  const failed = (ledger) =>
    Object.assign(new Error('Ledger device failed'), { code: 'device_failed', data: { ledger } });

  test.each([
    ['LEDGER_UNRESPONSIVE', 'The Ledger stopped answering. Reconnect it and try again.'],
    [
      'LEDGER_TIMEOUT',
      "The Ledger wasn't confirmed in 5 minutes. If it still shows the request, reject it there.",
    ],
    ['LEDGER_TOO_LARGE', 'This request is too large for a Ledger to sign. Nothing was sent.'],
    ['LEDGER_EMPTY_MESSAGE', "A Ledger can't sign an empty message. Nothing was sent."],
    [
      'LEDGER_TYPE_NOT_CANONICAL',
      "This request writes a type in a form a Ledger can't sign. Nothing was sent.",
    ],
  ])("0016's new code %s has its own text", (code, text) => {
    expect(Object.values(LEDGER_ERROR_CODES)).toContain(code);
    expect(createLedgerError(code)).toMatchObject({ code, message: text });
    const mapped = fromCoreError(failed(code));
    expect(mapped).toMatchObject({ code, message: text });
    expect(mapped.cause).toMatchObject({ code: 'device_failed' });
  });

  test("today's codes keep today's texts", () => {
    for (const code of ['LEDGER_WRONG_DEVICE', 'LEDGER_BUSY', 'LEDGER_USER_REJECTED', 'LEDGER_BAD_SIGNATURE']) {
      expect(fromCoreError(failed(code))).toMatchObject({ code, message: createLedgerError(code).message });
    }
  });

  test('a code the table does not name is LEDGER_UNKNOWN, and any other error is none', () => {
    expect(fromCoreError(failed('LEDGER_SOMETHING_NEW'))).toMatchObject({
      code: 'LEDGER_UNKNOWN',
      message: 'Ledger error. Reconnect the device and try again.',
    });
    expect(fromCoreError(failed(7))).toMatchObject({ code: 'LEDGER_UNKNOWN' });
    expect(fromCoreError(Object.assign(new Error('x'), { code: 'device_failed' }))).toMatchObject({
      code: 'LEDGER_UNKNOWN',
    });
    expect(fromCoreError(Object.assign(new Error('x'), { code: 'invalid_argument', data: { ledger: 'LEDGER_BUSY' } }))).toBeNull();
    expect(fromCoreError(new Error('x'))).toBeNull();
    expect(fromCoreError(null)).toBeNull();
  });
});

// LDG-3's PR 10 and its point 18 (the user's decision pending: option (a)
// built): after a Cancel or Reject while the Ledger waited, every surface
// shows this one text, kept here alone.
describe('the cancel notice', () => {
  test('LEDGER_CANCELLED says the Ledger may still show the request', () => {
    const text = 'Cancelled. If your Ledger still shows the request, reject it there.';
    expect(ledgerCancelledNotice()).toBe(text);
    expect(createLedgerError(LEDGER_ERROR_CODES.CANCELLED)).toMatchObject({ code: 'LEDGER_CANCELLED', message: text });
  });
});
