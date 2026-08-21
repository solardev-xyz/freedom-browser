const { LEDGER_ERROR_CODES, createLedgerError, mapLedgerError, isLedgerUserRejection } = require('./errors');

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
