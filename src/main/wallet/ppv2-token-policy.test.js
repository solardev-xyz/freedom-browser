const { Interface } = require('ethers');
const { createPPv2TokenPolicy, TOKEN_ABI } = require('./ppv2-token-policy');
const { configuration } = require('../../../test/helpers/ppv2-session-fixture');
const token = `0x${'55'.repeat(20)}`,
  other = `0x${'66'.repeat(20)}`;
const abi = new Interface(TOKEN_ABI),
  assetABI = new Interface([
    'function assets(address) view returns(tuple(bool,uint256,uint256,uint256))',
  ]);
const intent = { token, amount: 10000n, maxFee: 100n };
let policy, allowance, balance, feeBPS, enabled, provider, config;
beforeEach(() => {
  allowance = 0n;
  balance = 20000n;
  feeBPS = 100n;
  enabled = true;
  config = configuration();
  config.erc20Tokens = [token];
  config.contracts.push({ address: token });
  provider = {
    call: jest.fn(async ({ to, data }) => {
      if (to === config.deployment.entrypointAddress)
        return assetABI.encodeFunctionResult('assets', [[enabled, 1n, feeBPS, 0n]]);
      const call = abi.parseTransaction({ data });
      return abi.encodeFunctionResult(call.name, [call.name === 'allowance' ? allowance : balance]);
    }),
  };
  policy = createPPv2TokenPolicy({ configuration: config, provider });
});
test('binds an exact finite approval to the configured token, owner and entrypoint', async () => {
  const prepared = await policy.approval(intent);
  expect(prepared).toMatchObject({
    kind: 'ppv2-token-approval',
    to: token,
    value: 0n,
    approvalAmount: 10100n,
    fee: 100n,
    spender: config.deployment.entrypointAddress,
  });
  expect(abi.decodeFunctionData('approve', prepared.data)[1]).toBe(10100n);
  expect(Object.isFrozen(prepared)).toBe(true);
  await policy.check(prepared);
  allowance = 10100n;
  expect(await policy.approval(intent)).toBeNull();
});
test.each([1n, 10000n, 10200n, (1n << 256n) - 1n])(
  'resets residual or excessive allowance %s before any replacement',
  async (existing) => {
    allowance = existing;
    const reset = await policy.approval(intent);
    expect(reset.approvalAmount).toBe(0n);
    allowance = 0n;
    await expect(policy.check(reset)).rejects.toThrow();
    expect((await policy.approval(intent)).approvalAmount).toBe(10100n);
  }
);
test.each(['token', 'fee', 'balance', 'disabled', 'amount', 'allowance-response'])(
  'refuses unsafe token preparation: %s',
  async (change) => {
    let args = intent;
    if (change === 'token') args = { ...intent, token: other };
    if (change === 'fee') feeBPS = 101n;
    if (change === 'balance') balance = 10099n;
    if (change === 'disabled') enabled = false;
    if (change === 'amount') args = { ...intent, amount: 1n << 128n };
    if (change === 'allowance-response') provider.call.mockResolvedValue('0x');
    await expect(policy.approval(args)).rejects.toMatchObject({
      code: 'PRIVATE_PPV2_TOKEN_REFUSED',
    });
  }
);
test('rechecks exact allowance and fee after approval/review without accepting a larger allowance', async () => {
  allowance = 10100n;
  const prepared = { ...intent, fee: 100n, kind: 'ppv2-token-deposit' };
  await policy.check(prepared);
  for (const v of [0n, 10099n, 10101n]) {
    allowance = v;
    await expect(policy.check(prepared)).rejects.toThrow();
  }
  allowance = 10100n;
  feeBPS = 99n;
  await expect(policy.check(prepared)).rejects.toThrow();
});
test('refuses token grants outside configured contracts', () => {
  config.erc20Tokens = [other];
  expect(() => createPPv2TokenPolicy({ configuration: config, provider })).toThrow();
});
