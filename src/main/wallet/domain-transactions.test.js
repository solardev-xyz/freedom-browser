'use strict';

const { DomainTransactions } = require('./domain-transactions');
const account = { index: 0, address: '0x000000000000000000000000000000000000dEaD', type: 'mnemonic' };
function fixture() {
  const dependencies = { identityManager: { getActiveWalletIndex: () => 0, getDerivedWallets: jest.fn(async () => [account]) },
    estimateGas: jest.fn(async () => ({ gasLimit: '100000' })), getGasPrices: jest.fn(async () => ({ type: 'eip1559', maxFeePerGas: '10', maxPriorityFeePerGas: '1' })),
    balance: jest.fn(async () => 10n ** 22n), signAndRecord: jest.fn(async () => ({ hash: `0x${'a'.repeat(64)}` })), getSigner: jest.fn(() => ({})) };
  const wallet = new DomainTransactions(dependencies);
  const plan = { id: 'domain_fixture', name: 'test.eth', step: 'commit', account, to: '0x0000000000000000000000000000000000000001', data: '0x1234', value: '123', label: 'Commit test.eth', summary: 'Commit costs gas; does not buy the name.' };
  const context = { requestApproval: jest.fn(async () => 'approved'), revalidate: jest.fn(async () => {}), beforeSend: jest.fn(async () => {}) };
  return { wallet, dependencies, plan, context };
}
test('shows exact intent and maximum fee, revalidates, journals then uses the existing recorder', async () => {
  const f = fixture();
  await f.wallet.send(f.plan, f.context);
  expect(f.context.requestApproval).toHaveBeenCalledWith(expect.objectContaining({ action: 'wallet_transaction', operation: 'domain_execute',
    inputPreview: f.plan.summary, wallet: expect.objectContaining({ chainId: 1, data: '0x1234', maxFee: '0.000000000001 ETH' }) }));
  expect(f.context.revalidate.mock.invocationCallOrder[0]).toBeLessThan(f.context.beforeSend.mock.invocationCallOrder[0]);
  expect(f.context.beforeSend.mock.invocationCallOrder[0]).toBeLessThan(f.dependencies.signAndRecord.mock.invocationCallOrder[0]);
  expect(f.dependencies.signAndRecord).toHaveBeenCalledWith(expect.objectContaining({ chainId: 1, redactErrors: true }), {}, expect.objectContaining({ metadata: expect.objectContaining({ domainOperationId: f.plan.id }) }));
});
test.each(['declined', 'withdrawn'])('a %s decision never signs or marks dispatch', async decision => {
  const f = fixture(); f.context.requestApproval.mockResolvedValue(decision);
  await expect(f.wallet.send(f.plan, f.context)).rejects.toMatchObject({ code: 'DOMAIN_DECLINED' });
  expect(f.dependencies.signAndRecord).not.toHaveBeenCalled(); expect(f.context.beforeSend).not.toHaveBeenCalled();
});
test('changed state or cancellation after approval prevents dispatch', async () => {
  const f = fixture(); f.context.revalidate.mockRejectedValue(new Error('stale'));
  await expect(f.wallet.send(f.plan, f.context)).rejects.toThrow('stale');
  expect(f.dependencies.signAndRecord).not.toHaveBeenCalled();
  const controller = new AbortController();
  const g = fixture(); g.context.signal = controller.signal;
  g.context.requestApproval.mockImplementation(async () => { controller.abort(); return 'approved'; });
  await expect(g.wallet.send(g.plan, g.context)).rejects.toThrow();
  expect(g.dependencies.signAndRecord).not.toHaveBeenCalled();
});
test('insufficient balance and unsupported signers never reach approval', async () => {
  const f = fixture(); f.dependencies.balance.mockResolvedValue(0n);
  await expect(f.wallet.send(f.plan, f.context)).rejects.toMatchObject({ code: 'DOMAIN_BALANCE' });
  expect(f.context.requestApproval).not.toHaveBeenCalled();
  f.dependencies.identityManager.getDerivedWallets.mockResolvedValue([{ ...account, type: 'safe' }]);
  await expect(f.wallet.account(0)).rejects.toThrow('supported');
});

test('a typed domain description reaches the approval card beside the exact transaction', async () => {
  const f = fixture();
  f.plan.presentation = { format: 'freedom-domain-approval/1', action: 'register_commit', name: 'test.eth',
    items: [{ label: 'Name', value: 'test.eth' }], contract: { address: f.plan.to, name: 'ENS ETHRegistrarController' } };
  await f.wallet.send(f.plan, f.context);
  const { wallet } = f.context.requestApproval.mock.calls[0][0];
  expect(wallet.domain).toEqual(f.plan.presentation);
  expect(wallet).toMatchObject({ to: f.plan.to, data: '0x1234', value: '0.000000000000000123 ETH' });
});

test.each([
  [{ type: 'eip1559', maxFeePerGas: '10' }],
  [{ type: 'eip1559', maxFeePerGas: '10', maxPriorityFeePerGas: null }],
  [{ type: 'eip1559', maxFeePerGas: '10', maxPriorityFeePerGas: '0' }],
  [{ type: 'eip1559', maxPriorityFeePerGas: '1' }],
])('a partial EIP-1559 quote %j is refused before approval', async fees => {
  const f = fixture(); f.dependencies.getGasPrices.mockResolvedValue(fees);
  await expect(f.wallet.send(f.plan, f.context)).rejects.toThrow('maximum network fee');
  expect(f.context.requestApproval).not.toHaveBeenCalled();
  expect(f.dependencies.signAndRecord).not.toHaveBeenCalled();
});

test('ownWallet checks an address against the profile’s own wallet list', async () => {
  const f = fixture();
  f.dependencies.identityManager.getDerivedWallets.mockResolvedValue([{ ...account, name: 'Savings\u202e' },
    { index: 1, address: '0x000000000000000000000000000000000000bEEF', type: 'safe', name: 'Team' }]);
  expect(await f.wallet.ownWallet(account.address.toLowerCase())).toEqual({ status: 'own', name: 'Savings ' });
  expect(await f.wallet.ownWallet('0x000000000000000000000000000000000000beef')).toEqual({ status: 'own', name: 'Team' });
  expect(await f.wallet.ownWallet('0x000000000000000000000000000000000000cafE')).toEqual({ status: 'other' });
  f.dependencies.identityManager.getDerivedWallets.mockResolvedValue([account, { index: 1, address: null, type: 'mnemonic' }]);
  expect(await f.wallet.ownWallet('0x000000000000000000000000000000000000cafE')).toEqual({ status: 'unknown' });
});
