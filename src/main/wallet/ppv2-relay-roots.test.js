jest.mock('../networks/private-rpc', () => ({ createPrivateRpc: (handle, _role, _options) => {
  mockHandles.push(handle); return { request: mockRequest, release: mockRelease };
} }));
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { assertCurrentPPv2Roots, ABI } = require('./ppv2-relay-roots');
const deployment = { aspRegistryAddress: `0x${'11'.repeat(20)}`, poolAddress: `0x${'22'.repeat(20)}`, keystoreAddress: `0x${'33'.repeat(20)}` };
let mockHandles, mockRequest, scope;
const mockRelease = jest.fn();
const subject = { kind: 'private-account', principal: 'synthetic', protocol: 'privacy-pools-v2', deployment: 'sepolia', chainId: 11155111, role: 'protocol-rpc' };
beforeEach(() => {
  mockHandles = []; mockRelease.mockClear();
  scope = createPrivacyScope({ profileId: 'roots-fixture', signal: new AbortController().signal });
  mockRequest = jest.fn(async (method, [{ data }, tag], validate) => {
    expect(method).toBe('eth_call'); expect(tag).toBe('latest');
    const call = ABI.parseTransaction({ data });
    const result = ABI.encodeFunctionResult(call.name, [call.name === 'latestASPRoot' ? 4n : true]);
    expect(validate(result)).toBe(true); return { result };
  });
});
afterEach(() => scope.close());
function fixture(operation = `0x${'aa'.repeat(32)}`) {
  const controller = new AbortController();
  return { handle: scope.getContext({ ...subject, operation }), deployment, publicSignals: ['0','0','2','3','4','0','0','0'], signal: controller.signal, controller };
}
test('all three root reads use the attempt context, separated from account and owner reads', async () => {
  const first = fixture(); await assertCurrentPPv2Roots(first);
  expect(mockRequest.mock.calls.map(([, [c]]) => c.to)).toEqual(Object.values(deployment));
  expect(mockHandles).toEqual([first.handle]);
  const account = getPrivacyContext(scope.getContext(subject));
  const owner = getPrivacyContext(scope.getContext({ kind: 'public-address', principal: deployment.poolAddress, role: 'transaction-rpc', chainId: 11155111 }));
  expect(getPrivacyContext(first.handle).isolationToken).not.toBe(account.isolationToken);
  expect(getPrivacyContext(first.handle).isolationToken).not.toBe(owner.isolationToken);
  const second = fixture(`0x${'bb'.repeat(32)}`); await assertCurrentPPv2Roots(second);
  expect(getPrivacyContext(first.handle).isolationToken).not.toBe(getPrivacyContext(second.handle).isolationToken);
  expect(mockRelease).toHaveBeenCalledTimes(2);
});
test.each([0,1,2])('refuses stale root %s before the handoff can begin', async (index) => {
  const original = mockRequest.getMockImplementation(); let i = 0;
  mockRequest.mockImplementation(async (...args) => i++ === index ? { result: ABI.encodeFunctionResult(index === 0 ? 'latestASPRoot' : 'isKnownRoot', [index === 0 ? 5n : false]) } : original(...args));
  await expect(assertCurrentPPv2Roots(fixture())).rejects.toMatchObject({ code: 'PRIVATE_PPV2_ROOTS_STALE' });
  expect(mockRequest).toHaveBeenCalledTimes(index+1); expect(mockRelease).toHaveBeenCalledTimes(1);
});
test('an outage or revoked deadline does not become a successful check', async () => {
  const input = fixture(); mockRequest.mockRejectedValueOnce(new Error('remote body'));
  await expect(assertCurrentPPv2Roots(input)).rejects.toMatchObject({ code: 'PRIVATE_PPV2_ROOTS_STALE' });
  mockRequest.mockImplementationOnce(async () => { input.controller.abort(); return { result: ABI.encodeFunctionResult('latestASPRoot', [4]) }; });
  await expect(assertCurrentPPv2Roots(input)).rejects.toMatchObject({ code: 'PRIVATE_PPV2_ROOTS_STALE' });
  expect(mockRequest).toHaveBeenCalledTimes(2);
});
test('an account-level or public owner context is refused before RPC creation', async () => {
  const input = fixture(); input.handle = scope.getContext(subject);
  await expect(assertCurrentPPv2Roots(input)).rejects.toThrow();
  input.handle = scope.getContext({ kind: 'public-address', principal: deployment.poolAddress, chainId: 11155111, role: 'protocol-rpc', operation: `0x${'aa'.repeat(32)}` });
  await expect(assertCurrentPPv2Roots(input)).rejects.toThrow(); expect(mockHandles).toEqual([]);
});
