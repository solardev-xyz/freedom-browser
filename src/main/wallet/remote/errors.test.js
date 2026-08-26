const { REMOTE_ERROR_CODES, createRemoteError, mapRemoteRpcError } = require('./errors');

describe('remote errors', () => {
  test('createRemoteError mints code + user-facing message from the registry', () => {
    const err = createRemoteError(REMOTE_ERROR_CODES.TIMEOUT);
    expect(err.code).toBe('REMOTE_TIMEOUT');
    expect(err.message).toMatch(/did not respond/);
  });

  test('createRemoteError accepts a message override', () => {
    const err = createRemoteError(REMOTE_ERROR_CODES.UNKNOWN, 'gas too low');
    expect(err.code).toBe('REMOTE_UNKNOWN');
    expect(err.message).toBe('gas too low');
  });

  test('maps EIP-1193 user rejection (4001) with our neutral message', () => {
    const err = mapRemoteRpcError({ code: 4001, message: 'MetaMask Tx Signature: User denied.' });
    expect(err.code).toBe(REMOTE_ERROR_CODES.USER_REJECTED);
    // The phone wallet's own rejection text is noise; ours is consistent.
    expect(err.message).toMatch(/rejected on your phone/i);
  });

  test.each([
    [4100, REMOTE_ERROR_CODES.WRONG_ACCOUNT],
    [4200, REMOTE_ERROR_CODES.UNSUPPORTED],
  ])('maps EIP-1193 code %s', (rpcCode, expected) => {
    expect(mapRemoteRpcError({ code: rpcCode }).code).toBe(expected);
  });

  test('unknown RPC errors keep the phone message but map to UNKNOWN', () => {
    const err = mapRemoteRpcError({ code: -32000, message: 'intrinsic gas too low' });
    expect(err.code).toBe(REMOTE_ERROR_CODES.UNKNOWN);
    expect(err.message).toBe('intrinsic gas too low');
  });

  test('malformed RPC errors map to UNKNOWN with the registry message', () => {
    const err = mapRemoteRpcError(undefined);
    expect(err.code).toBe(REMOTE_ERROR_CODES.UNKNOWN);
    expect(err.message).toMatch(/failed/i);
  });
});
