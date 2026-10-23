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
jest.mock('../identity-manager', () => ({ getActiveWalletIndex: jest.fn(() => 0) }));
jest.mock('./rpc-manager', () => ({}));
jest.mock('./signers', () => ({ getSigner: jest.fn() }));
jest.mock('./dapp-permissions', () => ({
  getPermission: jest.fn(() => null),
  getSigningAutoApprove: jest.fn(() => false),
  isTransactionAutoApproved: jest.fn(() => false),
  addTransactionAutoApprove: jest.fn(() => true),
}));
jest.mock('./safe/safe-transactions', () => ({
  startSafeSend: jest.fn(async () => ({ safeTxHash: '0xsafetx' })),
}));
jest.mock('./safe/safe-messages', () => ({
  startSafeMessage: jest.fn(async () => ({ token: 'session' })),
}));
jest.mock('./safe/safe-service', () => ({ activateSafe: jest.fn() }));
jest.mock('./auto-approve-pause', () => ({
  transactionAutoApprovePaused: jest.fn(async () => false),
  admitAutoApprovedTransaction: jest.fn(async () => () => {}),
}));

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

// Security audit O-7: every signing handler refuses unless it is handed a
// confirmation token main issued for exactly this request, or main's own
// reading of the site's auto-approve policy covers it.
describe('signing handlers require a main-side confirmation', () => {
  const { signAndRecord } = require('./tx-recorder');
  const { getSigner } = require('./signers');
  const { getActiveWalletIndex } = require('../identity-manager');
  const dappPermissions = require('./dapp-permissions');
  const { startSafeSend } = require('./safe/safe-transactions');
  const { startSafeMessage } = require('./safe/safe-messages');
  const confirmations = require('./signing-confirmation');
  const { admitAutoApprovedTransaction } = require('./auto-approve-pause');
  let release;

  const SITE = 'https://app.example';
  const TX = {
    to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    value: '0',
    data: '0x095ea7b3' + '00'.repeat(64),
    gasLimit: '50000',
    gasPrice: '1000000000',
    chainId: 100,
  };
  let handlers;
  let signer;

  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    confirmations._reset();
    ipcMain.handle.mockClear();
    registerWalletIpc();
    handlers = Object.fromEntries(ipcMain.handle.mock.calls.map(([channel, fn]) => [channel, fn]));
    signer = {
      signMessage: jest.fn(async () => '0xmsgsig'),
      signTypedData: jest.fn(async () => '0xtypedsig'),
    };
    getSigner.mockReset().mockReturnValue(signer);
    signAndRecord.mockReset().mockResolvedValue({ hash: '0xhash' });
    getActiveWalletIndex.mockReset().mockReturnValue(0);
    dappPermissions.getPermission.mockReset().mockReturnValue(null);
    dappPermissions.getSigningAutoApprove.mockReset().mockReturnValue(false);
    dappPermissions.isTransactionAutoApproved.mockReset().mockReturnValue(false);
    dappPermissions.addTransactionAutoApprove.mockReset().mockReturnValue(true);
    release = jest.fn();
    admitAutoApprovedTransaction.mockReset().mockImplementation(async () => release);
    startSafeSend.mockClear();
    startSafeMessage.mockClear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function mint(kind, index, payload) {
    const result = await handlers['wallet:confirm-signing']({}, kind, index, payload);
    expect(result.success).toBe(true);
    return result.token;
  }

  describe('wallet:send-transaction', () => {
    test('without a token: refused, nothing signed', async () => {
      const result = await handlers['wallet:send-transaction']({}, TX, {});
      expect(result).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      expect(signAndRecord).not.toHaveBeenCalled();
    });

    test('with a token for this transaction: signed once', async () => {
      const confirmation = await mint('wallet-send', null, TX);
      const result = await handlers['wallet:send-transaction']({}, TX, {}, { confirmation });
      expect(result).toMatchObject({ success: true, hash: '0xhash' });
      expect(signAndRecord).toHaveBeenCalledTimes(1);

      const replay = await handlers['wallet:send-transaction']({}, TX, {}, { confirmation });
      expect(replay).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      expect(signAndRecord).toHaveBeenCalledTimes(1);
    });

    test('a changed recipient is refused', async () => {
      const confirmation = await mint('wallet-send', null, TX);
      const result = await handlers['wallet:send-transaction'](
        {}, { ...TX, to: '0x' + '66'.repeat(20) }, {}, { confirmation });
      expect(result).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      expect(signAndRecord).not.toHaveBeenCalled();
    });

    test('the account active when confirming is the one bound', async () => {
      const confirmation = await mint('wallet-send', 5 /* ignored */, TX);
      getActiveWalletIndex.mockReturnValue(1);
      const result = await handlers['wallet:send-transaction']({}, TX, {}, { confirmation });
      expect(result).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      expect(signAndRecord).not.toHaveBeenCalled();
    });

    test('main binds the active account, whatever index the renderer names', async () => {
      getActiveWalletIndex.mockReturnValue(4);
      const confirmation = await mint('wallet-send', 9, TX);
      const result = await handlers['wallet:send-transaction']({}, TX, {}, { confirmation });
      expect(result).toMatchObject({ success: true });
      expect(getSigner).toHaveBeenCalledWith(4);
    });

    test('a wallet send has no auto-approve', async () => {
      dappPermissions.getPermission.mockReturnValue({ walletIndex: 0 });
      dappPermissions.isTransactionAutoApproved.mockReturnValue(true);
      const result = await handlers['wallet:send-transaction']({}, TX, {}, { autoApprove: SITE });
      expect(result).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      expect(signAndRecord).not.toHaveBeenCalled();
    });
  });

  describe('wallet:dapp-send-transaction', () => {
    test('without a token: refused', async () => {
      const result = await handlers['wallet:dapp-send-transaction']({}, TX, 2, { origin: SITE });
      expect(result).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      expect(signAndRecord).not.toHaveBeenCalled();
    });

    test('a token for another account is refused', async () => {
      const confirmation = await mint('dapp-send', 2, { ...TX, origin: SITE });
      const result = await handlers['wallet:dapp-send-transaction'](
        {}, TX, 3, { origin: SITE }, { confirmation });
      expect(result).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      expect(signAndRecord).not.toHaveBeenCalled();
    });

    test('auto-approve is evaluated in main: a matching stored rule signs', async () => {
      dappPermissions.getPermission.mockReturnValue({ walletIndex: 2 });
      dappPermissions.isTransactionAutoApproved.mockReturnValue(true);
      const result = await handlers['wallet:dapp-send-transaction'](
        {}, TX, 2, { origin: SITE }, { autoApprove: SITE });
      expect(result).toMatchObject({ success: true, hash: '0xhash' });
      // Main derives the rule key from the transaction it is signing.
      expect(dappPermissions.isTransactionAutoApproved).toHaveBeenCalledWith(
        SITE, TX.to, '0x095ea7b3', 100);
    });

    // D12: a matching rule is paused while one of the site's payments is in
    // Payments waiting; the renderer shows the prompt meanwhile.
    test("a matching rule is paused while one of the site's payments waits", async () => {
      dappPermissions.getPermission.mockReturnValue({ walletIndex: 2 });
      dappPermissions.isTransactionAutoApproved.mockReturnValue(true);
      admitAutoApprovedTransaction.mockResolvedValue(null);
      const result = await handlers['wallet:dapp-send-transaction'](
        {}, TX, 2, { origin: SITE }, { autoApprove: SITE });
      expect(result).toMatchObject({
        success: false,
        code: 'SIGNING_NOT_CONFIRMED',
        error: expect.stringContaining(
          'auto-approve is paused while a payment this site requested is waiting'
        ),
      });
      expect(admitAutoApprovedTransaction).toHaveBeenCalledWith(SITE);
      expect(signAndRecord).not.toHaveBeenCalled();
    });

    test('an admitted auto-approved send releases its admission once it settles', async () => {
      dappPermissions.getPermission.mockReturnValue({ walletIndex: 2 });
      dappPermissions.isTransactionAutoApproved.mockReturnValue(true);
      signAndRecord.mockImplementation(async () => {
        // Still admitted while it signs and records.
        expect(release).not.toHaveBeenCalled();
        return { hash: '0xhash' };
      });
      await expect(
        handlers['wallet:dapp-send-transaction']({}, TX, 2, { origin: SITE }, { autoApprove: SITE })
      ).resolves.toMatchObject({ success: true });
      expect(release).toHaveBeenCalledTimes(1);

      signAndRecord.mockRejectedValue(new Error('vault locked'));
      await expect(
        handlers['wallet:dapp-send-transaction']({}, TX, 2, { origin: SITE }, { autoApprove: SITE })
      ).resolves.toMatchObject({ success: false });
      expect(release).toHaveBeenCalledTimes(2);
    });

    test("the prompt's confirmation still signs while the site's payment waits", async () => {
      dappPermissions.getPermission.mockReturnValue({ walletIndex: 2 });
      dappPermissions.isTransactionAutoApproved.mockReturnValue(true);
      admitAutoApprovedTransaction.mockResolvedValue(null);
      const confirmation = await mint('dapp-send', 2, { ...TX, origin: SITE });
      const result = await handlers['wallet:dapp-send-transaction'](
        {}, TX, 2, { origin: SITE }, { confirmation });
      expect(result).toMatchObject({ success: true, hash: '0xhash' });
      // Nothing claims auto-approve, so nothing is admitted or read.
      expect(admitAutoApprovedTransaction).not.toHaveBeenCalled();
    });

    test('the records are read only for a request a rule covers', async () => {
      dappPermissions.getPermission.mockReturnValue({ walletIndex: 2 });
      admitAutoApprovedTransaction.mockResolvedValue(null);
      const result = await handlers['wallet:dapp-send-transaction'](
        {}, TX, 2, { origin: SITE }, { autoApprove: SITE });
      // Refused as before: no rule, and nothing said of a pause.
      expect(result).toMatchObject({
        success: false,
        code: 'SIGNING_NOT_CONFIRMED',
        error: expect.stringContaining("not covered by the site's auto-approve rules"),
      });
      expect(admitAutoApprovedTransaction).not.toHaveBeenCalled();
    });

    // Review of #788: the pause reads the site a payment is recorded under,
    // so main records it under the site that authorized it, never under the
    // renderer's display context alone.
    test('codex: main binds an auto-approved send to the site its rule belongs to', async () => {
      dappPermissions.getPermission.mockReturnValue({ walletIndex: 2 });
      dappPermissions.isTransactionAutoApproved.mockReturnValue(true);
      const mismatched = await handlers['wallet:dapp-send-transaction'](
        {}, TX, 2, { origin: 'https://other.example' }, { autoApprove: SITE });
      expect(mismatched).toMatchObject({
        success: false,
        code: 'SIGNING_NOT_CONFIRMED',
        error: expect.stringContaining("the request's site is not the one its auto-approve names"),
      });
      expect(admitAutoApprovedTransaction).not.toHaveBeenCalled();
      expect(signAndRecord).not.toHaveBeenCalled();

      // The same site, as a page path: recorded under its permission key.
      await handlers['wallet:dapp-send-transaction'](
        {}, TX, 2, { origin: `${SITE}/swap` }, { autoApprove: SITE });
      expect(signAndRecord).toHaveBeenCalledWith(
        TX, signer, expect.objectContaining({ kind: 'dapp-send', origin: SITE }), { walletIndex: 2 });

      // No context origin at all: the authorized site.
      await handlers['wallet:dapp-send-transaction']({}, TX, 2, {}, { autoApprove: SITE });
      expect(signAndRecord).toHaveBeenLastCalledWith(
        TX, signer, expect.objectContaining({ origin: SITE }), { walletIndex: 2 });
    });

    test('codex: main binds a confirmed send to the site the user confirmed', async () => {
      dappPermissions.getPermission.mockReturnValue({ walletIndex: 2 });
      const forOther = await mint('dapp-send', 2, { ...TX, origin: 'https://other.example' });
      const refused = await handlers['wallet:dapp-send-transaction'](
        {}, TX, 2, { origin: SITE }, { confirmation: forOther });
      expect(refused).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      const withoutSite = await mint('dapp-send', 2, TX);
      await expect(
        handlers['wallet:dapp-send-transaction'](
          {},
          TX,
          2,
          { origin: SITE },
          { confirmation: withoutSite }
        )
      ).resolves.toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      expect(signAndRecord).not.toHaveBeenCalled();

      const confirmed = await mint('dapp-send', 2, { ...TX, origin: SITE });
      await handlers['wallet:dapp-send-transaction'](
        {}, TX, 2, { origin: `${SITE}/swap` }, { confirmation: confirmed });
      expect(signAndRecord).toHaveBeenCalledWith(
        TX, signer, expect.objectContaining({ origin: SITE }), { walletIndex: 2 });
    });

    test('auto-approve claimed without a stored rule is refused', async () => {
      dappPermissions.getPermission.mockReturnValue({ walletIndex: 2 });
      const result = await handlers['wallet:dapp-send-transaction'](
        {}, TX, 2, { origin: SITE }, { autoApprove: SITE });
      expect(result).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      expect(signAndRecord).not.toHaveBeenCalled();
    });

    test('a stored rule never authorises another account than the grant exposes', async () => {
      dappPermissions.getPermission.mockReturnValue({ walletIndex: 2 });
      dappPermissions.isTransactionAutoApproved.mockReturnValue(true);
      const result = await handlers['wallet:dapp-send-transaction'](
        {}, TX, 0, { origin: SITE }, { autoApprove: SITE });
      expect(result).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      expect(signAndRecord).not.toHaveBeenCalled();
    });

    test('a plain transfer (no selector) is never auto-approved', async () => {
      dappPermissions.getPermission.mockReturnValue({ walletIndex: 2 });
      dappPermissions.isTransactionAutoApproved.mockReturnValue(true);
      const result = await handlers['wallet:dapp-send-transaction'](
        {}, { ...TX, data: '0x' }, 2, { origin: SITE }, { autoApprove: SITE });
      expect(result).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
    });

    test('"always allow" is recorded by main from the confirmed transaction', async () => {
      dappPermissions.getPermission.mockReturnValue({ walletIndex: 2 });
      const confirmation = await mint('dapp-send', 2, { ...TX, origin: SITE });
      const result = await handlers['wallet:dapp-send-transaction'](
        {}, TX, 2, { origin: SITE }, { confirmation, rememberAutoApprove: SITE });
      expect(result).toMatchObject({ success: true, autoApproveAdded: true });
      expect(dappPermissions.addTransactionAutoApprove).toHaveBeenCalledWith(
        SITE, TX.to, '0x095ea7b3', 100);
    });

    test('an auto-approved send cannot add rules', async () => {
      dappPermissions.getPermission.mockReturnValue({ walletIndex: 2 });
      dappPermissions.isTransactionAutoApproved.mockReturnValue(true);
      await handlers['wallet:dapp-send-transaction'](
        {}, TX, 2, { origin: SITE }, { autoApprove: SITE, rememberAutoApprove: 'https://other.example' });
      expect(dappPermissions.addTransactionAutoApprove).not.toHaveBeenCalled();
    });

    test('no IPC channel adds an auto-approve rule on its own', () => {
      expect(Object.keys(handlers)).not.toContain('dapp:add-tx-auto-approve');
    });
  });

  describe.each([
    ['wallet:sign-message', 'sign-message', '0x68656c6c6f', 'signMessage'],
    ['wallet:sign-typed-data', 'sign-typed-data', { domain: { chainId: 100 }, message: { a: 1 } }, 'signTypedData'],
  ])('%s', (channel, kind, payload, method) => {
    test('without a token: refused, the key is never touched', async () => {
      const result = await handlers[channel]({}, payload, 0);
      expect(result).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      expect(getSigner).not.toHaveBeenCalled();
    });

    test('with a token for this payload: signed', async () => {
      const confirmation = await mint(kind, 0, payload);
      const result = await handlers[channel]({}, payload, 0, { confirmation });
      expect(result).toEqual({ success: true, signature: method === 'signMessage' ? '0xmsgsig' : '0xtypedsig' });
      expect(signer[method]).toHaveBeenCalledWith(payload);
    });

    test('a token for a different payload is refused', async () => {
      const confirmation = await mint(kind, 0, payload);
      const other = typeof payload === 'string' ? '0x6869' : { ...payload, message: { a: 2 } };
      const result = await handlers[channel]({}, other, 0, { confirmation });
      expect(result).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      expect(signer[method]).not.toHaveBeenCalled();
    });

    test('an expired token is refused', async () => {
      const confirmation = await mint(kind, 0, payload);
      const realNow = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(realNow + confirmations.CONFIRMATION_TTL_MS + 1);
      const result = await handlers[channel]({}, payload, 0, { confirmation });
      expect(result).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      expect(signer[method]).not.toHaveBeenCalled();
    });

    test('auto-approve is evaluated in main', async () => {
      dappPermissions.getPermission.mockReturnValue({ walletIndex: 0 });
      const refused = await handlers[channel]({}, payload, 0, { autoApprove: SITE });
      expect(refused).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });

      dappPermissions.getSigningAutoApprove.mockReturnValue(true);
      const signed = await handlers[channel]({}, payload, 0, { autoApprove: SITE });
      expect(signed.success).toBe(true);
      expect(dappPermissions.getSigningAutoApprove).toHaveBeenCalledWith(SITE);

      // ...and only for the account the site is connected with.
      const other = await handlers[channel]({}, payload, 1, { autoApprove: SITE });
      expect(other).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
    });
  });

  describe('Safe handlers', () => {
    const SAFE_TX = { to: TX.to, value: '5', data: '0x' };

    test('wallet:safe-send without a token creates no SafeTx', async () => {
      const result = await handlers['wallet:safe-send']({}, 7, SAFE_TX, {}, 100);
      expect(result).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      expect(startSafeSend).not.toHaveBeenCalled();
    });

    test('wallet:safe-send with a token for this SafeTx proceeds; another chain is refused', async () => {
      const confirmation = await mint('safe-send', 7, { tx: SAFE_TX, chainId: 100 });
      const ok = await handlers['wallet:safe-send']({}, 7, SAFE_TX, {}, 100, { confirmation });
      expect(ok).toMatchObject({ success: true });
      expect(startSafeSend).toHaveBeenCalledTimes(1);

      const again = await mint('safe-send', 7, { tx: SAFE_TX, chainId: 100 });
      const wrongChain = await handlers['wallet:safe-send']({}, 7, SAFE_TX, {}, 1, { confirmation: again });
      expect(wrongChain).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      expect(startSafeSend).toHaveBeenCalledTimes(1);
    });

    test('a locked vault reaches the renderer as VAULT_LOCKED, whatever the core calls it', async () => {
      // The identity core's errors carry their own code; the renderer walks
      // the user through unlock only on VAULT_LOCKED.
      const locked = () => Object.assign(new Error('Vault is locked'), { code: 'vault_locked' });
      const { activateSafe } = require('./safe/safe-service');
      activateSafe.mockRejectedValueOnce(locked());
      await expect(handlers['wallet:activate-safe']({}, 7)).resolves.toMatchObject({
        success: false,
        code: 'VAULT_LOCKED',
      });
      startSafeSend.mockRejectedValueOnce(locked());
      const confirmation = await mint('safe-send', 7, { tx: SAFE_TX, chainId: 100 });
      await expect(
        handlers['wallet:safe-send']({}, 7, SAFE_TX, {}, 100, { confirmation })
      ).resolves.toMatchObject({ success: false, code: 'VAULT_LOCKED' });
      // Other codes pass through unchanged.
      activateSafe.mockRejectedValueOnce(Object.assign(new Error('Needs funds'), { code: 'NEEDS_FUNDS' }));
      await expect(handlers['wallet:activate-safe']({}, 7)).resolves.toMatchObject({
        code: 'NEEDS_FUNDS',
      });
    });

    test('wallet:safe-send has no auto-approve', async () => {
      dappPermissions.getPermission.mockReturnValue({ walletIndex: 7 });
      dappPermissions.getSigningAutoApprove.mockReturnValue(true);
      const result = await handlers['wallet:safe-send']({}, 7, SAFE_TX, {}, 100, { autoApprove: SITE });
      expect(result).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      expect(startSafeSend).not.toHaveBeenCalled();
    });

    const REQUEST = { method: 'personal_sign', params: ['0xdead', '0xsafe'] };
    const REQUESTER = { origin: SITE, webContentsId: 12 };

    test('wallet:safe-message-start without a token opens no session', async () => {
      const result = await handlers['wallet:safe-message-start']({}, 7, REQUEST, {}, REQUESTER);
      expect(result).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      expect(startSafeMessage).not.toHaveBeenCalled();
    });

    test('wallet:safe-message-start with a token for this request proceeds', async () => {
      const confirmation = await mint('safe-message', 7, REQUEST);
      const result = await handlers['wallet:safe-message-start'](
        {}, 7, REQUEST, {}, REQUESTER, { confirmation });
      expect(result).toMatchObject({ success: true });
      expect(startSafeMessage).toHaveBeenCalledTimes(1);
    });

    test('wallet:safe-message-start auto-approve is evaluated in main, for the requesting site only', async () => {
      dappPermissions.getPermission.mockReturnValue({ walletIndex: 7 });
      dappPermissions.getSigningAutoApprove.mockReturnValue(true);

      const otherSite = await handlers['wallet:safe-message-start'](
        {}, 7, REQUEST, {}, REQUESTER, { autoApprove: 'https://other.example' });
      expect(otherSite).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });

      const ok = await handlers['wallet:safe-message-start'](
        {}, 7, REQUEST, {}, REQUESTER, { autoApprove: SITE });
      expect(ok).toMatchObject({ success: true });
      expect(startSafeMessage).toHaveBeenCalledTimes(1);
    });
  });

  test('wallet:confirm-signing refuses a malformed request', async () => {
    const result = await handlers['wallet:confirm-signing']({}, 'dapp-send', 2, { ...TX, gasLimit: 'x' });
    expect(result).toMatchObject({ success: false });
    expect(result.token).toBeUndefined();
  });
});
