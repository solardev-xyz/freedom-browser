jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn() },
}));

jest.mock('qrcode', () => ({}));
jest.mock('./balance-service', () => ({ getBalancesWithCache: jest.fn(async () => ({ balances: null, fromCache: false })) }));
jest.mock('./chains', () => ({}));
jest.mock('./provider-manager', () => ({}));
jest.mock('./transaction-service', () => ({}));
jest.mock('./tx-recorder', () => ({
  signAndRecord: jest.fn(),
  KINDS: { WALLET_SEND: 'wallet-send', DAPP_SEND: 'dapp-send' },
}));
jest.mock('../identity-manager', () => ({}));
jest.mock('./rpc-manager', () => ({}));
jest.mock('./signers', () => ({}));

const { buildTxRecordContext, registerWalletIpc } = require('./wallet-ipc');
const { ipcMain } = require('electron');
const { getBalancesWithCache } = require('./balance-service');

describe('wallet-ipc', () => {
  test('renderer context cannot override fixed payment-history kind', () => {
    expect(buildTxRecordContext('dapp-send', {
      kind: 'wallet-send',
      origin: 'https://app.example',
    })).toEqual({
      kind: 'dapp-send',
      origin: 'https://app.example',
    });
  });
});


test('startup cached balance IPC never starts a fresh read', async () => {
  registerWalletIpc();
  const handler = ipcMain.handle.mock.calls.find(([channel]) => channel === 'wallet:get-balances-cached')[1];
  await handler({}, '0xabc');
  expect(getBalancesWithCache).toHaveBeenCalledWith('0xabc', false);
});
