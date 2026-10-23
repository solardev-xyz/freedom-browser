jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn() },
  webContents: { fromId: jest.fn(() => null) },
}));

jest.mock('qrcode', () => ({}));
jest.mock('./balance-service', () => ({ getBalancesWithCache: jest.fn(async () => ({ balances: null, fromCache: false })) }));
jest.mock('./chains', () => ({}));
jest.mock('./provider-manager', () => ({}));
jest.mock('./transaction-service', () => ({
  namesOwnFees: ({ maxFeePerGas, maxPriorityFeePerGas, gasPrice }) =>
    Boolean((maxFeePerGas && maxPriorityFeePerGas) || gasPrice),
}));
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
  executeSafePending: jest.fn(async () => ({ status: 'executed' })),
}));
jest.mock('../ens-resolver', () => ({ resolveEnsContent: jest.fn() }));
jest.mock('./safe/safe-messages', () => ({
  startSafeMessage: jest.fn(async () => ({ token: 'session' })),
}));
jest.mock('./safe/safe-service', () => ({ activateSafe: jest.fn() }));
// The fee check at confirmation (design 0005, A): every send's fee passes,
// unless a test says otherwise.
jest.mock('./fee-check', () => {
  const actual = jest.requireActual('./fee-check');
  const passing = { comparable: true, ratio: '1', above: false, autoApprove: true, askAgain: false };
  return {
    ...actual,
    checkFees: jest.fn(async () => passing),
    checkAtApproval: jest.fn(async () => passing),
  };
});
jest.mock('./auto-approve-pause', () => ({
  transactionAutoApprovePaused: jest.fn(async () => false),
  takeSiteTurn: jest.fn(async () => () => {}),
  sitePaymentWaiting: jest.fn(async () => false),
}));

const { buildTxRecordContext, registerWalletIpc } = require('./wallet-ipc');
const { ipcMain, webContents } = require('electron');
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
  const { takeSiteTurn, sitePaymentWaiting } = require('./auto-approve-pause');
  let leave;

  const SITE = 'https://app.example';
  // The chrome window that sends every wallet IPC, and its tab guests by
  // webContents id (#764: an auto-approve claim is checked against the
  // requesting guest's own page).
  const CHROME = { id: 1 };
  const AUTO = { sender: CHROME };
  let guests;
  const guest = (id, url, { host = CHROME, destroyed = false } = {}) => {
    guests.set(id, {
      id,
      hostWebContents: host,
      getURL: () => url,
      isDestroyed: () => destroyed,
    });
  };
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
    leave = jest.fn();
    takeSiteTurn.mockReset().mockImplementation(async () => leave);
    sitePaymentWaiting.mockReset().mockResolvedValue(false);
    startSafeSend.mockClear();
    startSafeMessage.mockClear();
    guests = new Map();
    webContents.fromId.mockReset().mockImplementation((id) => guests.get(id) ?? null);
    // The requesting page (guest 12) is on SITE unless a test says otherwise.
    guest(12, `${SITE}/swap#/route`);
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
        AUTO, TX, 2, { origin: SITE }, { autoApprove: SITE, webContentsId: 12 });
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
      sitePaymentWaiting.mockResolvedValue(true);
      const result = await handlers['wallet:dapp-send-transaction'](
        AUTO, TX, 2, { origin: SITE }, { autoApprove: SITE, webContentsId: 12 });
      expect(result).toMatchObject({
        success: false,
        code: 'SIGNING_NOT_CONFIRMED',
        error: expect.stringContaining(
          'auto-approve is paused while a payment this site requested is waiting'
        ),
      });
      // Read in the site's turn, which it doesn't wait for, then leaves.
      expect(takeSiteTurn).toHaveBeenCalledWith(SITE, { wait: false });
      expect(sitePaymentWaiting).toHaveBeenCalledWith(SITE);
      expect(leave).toHaveBeenCalled();
      expect(signAndRecord).not.toHaveBeenCalled();
    });

    // Review of #788, round 2: every dApp send of a site takes its turn
    // until its payment is committed, so none can cross a silent send's
    // reading of Payments waiting.
    test("a send leaves its site's turn once its payment is committed, or when it fails", async () => {
      dappPermissions.getPermission.mockReturnValue({ walletIndex: 2 });
      dappPermissions.isTransactionAutoApproved.mockReturnValue(true);
      signAndRecord.mockImplementation(async (_tx, _signer, _context, options) => {
        // Still in its turn while it signs; main leaves it at the commit.
        expect(leave).not.toHaveBeenCalled();
        expect(options.onCommitted).toBe(leave);
        options.onCommitted();
        return { hash: '0xhash' };
      });
      await expect(
        handlers['wallet:dapp-send-transaction'](AUTO, TX, 2, { origin: SITE }, { autoApprove: SITE, webContentsId: 12 })
      ).resolves.toMatchObject({ success: true });
      expect(leave).toHaveBeenCalled();

      leave.mockClear();
      signAndRecord.mockRejectedValue(new Error('vault locked'));
      await expect(
        handlers['wallet:dapp-send-transaction'](AUTO, TX, 2, { origin: SITE }, { autoApprove: SITE, webContentsId: 12 })
      ).resolves.toMatchObject({ success: false });
      expect(leave).toHaveBeenCalled();
    });

    test("the prompt's confirmation still signs while the site's payment waits, in its turn", async () => {
      dappPermissions.getPermission.mockReturnValue({ walletIndex: 2 });
      dappPermissions.isTransactionAutoApproved.mockReturnValue(true);
      sitePaymentWaiting.mockResolvedValue(true);
      const confirmation = await mint('dapp-send', 2, { ...TX, origin: SITE });
      const result = await handlers['wallet:dapp-send-transaction'](
        {}, TX, 2, { origin: SITE }, { confirmation });
      expect(result).toMatchObject({ success: true, hash: '0xhash' });
      // It waits its turn, but the pause never refuses it.
      expect(takeSiteTurn).toHaveBeenCalledWith(SITE, { wait: true });
      expect(sitePaymentWaiting).not.toHaveBeenCalled();
    });

    // Review of #788, round 3: a silent send doesn't queue for the site's
    // turn; a confirmed one's wait is bounded, and its error says why.
    test("a silent send finding the site's turn taken is paused at once", async () => {
      dappPermissions.getPermission.mockReturnValue({ walletIndex: 2 });
      dappPermissions.isTransactionAutoApproved.mockReturnValue(true);
      takeSiteTurn.mockRejectedValue(Object.assign(new Error('busy'), { code: 'SITE_TURN_BUSY' }));
      await expect(
        handlers['wallet:dapp-send-transaction'](AUTO, TX, 2, { origin: SITE }, { autoApprove: SITE, webContentsId: 12 })
      ).resolves.toMatchObject({
        success: false,
        code: 'SIGNING_NOT_CONFIRMED',
        error: expect.stringContaining('auto-approve is paused'),
      });
      expect(sitePaymentWaiting).not.toHaveBeenCalled();
      expect(signAndRecord).not.toHaveBeenCalled();
    });

    test("a confirmed send that waited too long for the site's turn fails, saying so", async () => {
      dappPermissions.getPermission.mockReturnValue({ walletIndex: 2 });
      takeSiteTurn.mockRejectedValue(
        Object.assign(new Error('Another payment for this site is waiting for approval.'), {
          code: 'SITE_TURN_BUSY',
        })
      );
      const confirmation = await mint('dapp-send', 2, { ...TX, origin: SITE });
      await expect(
        handlers['wallet:dapp-send-transaction']({}, TX, 2, { origin: SITE }, { confirmation })
      ).resolves.toMatchObject({
        success: false,
        code: 'SITE_TURN_BUSY',
        error: 'Another payment for this site is waiting for approval.',
      });
      expect(signAndRecord).not.toHaveBeenCalled();
    });

    test('a wallet send has no site and no turn', async () => {
      const confirmation = await mint('wallet-send', null, TX);
      await expect(
        handlers['wallet:send-transaction']({}, TX, {}, { confirmation })
      ).resolves.toMatchObject({ success: true });
      expect(takeSiteTurn).not.toHaveBeenCalled();
    });

    test('a request no rule covers is refused before it waits for a turn', async () => {
      dappPermissions.getPermission.mockReturnValue({ walletIndex: 2 });
      sitePaymentWaiting.mockResolvedValue(true);
      const result = await handlers['wallet:dapp-send-transaction'](
        AUTO, TX, 2, { origin: SITE }, { autoApprove: SITE, webContentsId: 12 });
      // Refused as before: no rule, and nothing said of a pause.
      expect(result).toMatchObject({
        success: false,
        code: 'SIGNING_NOT_CONFIRMED',
        error: expect.stringContaining("not covered by the site's auto-approve rules"),
      });
      expect(takeSiteTurn).not.toHaveBeenCalled();
      expect(sitePaymentWaiting).not.toHaveBeenCalled();
    });

    // Review of #788: the pause reads the site a payment is recorded under,
    // so main records it under the site that authorized it, never under the
    // renderer's display context alone.
    test('codex: main binds an auto-approved send to the site its rule belongs to', async () => {
      dappPermissions.getPermission.mockReturnValue({ walletIndex: 2 });
      dappPermissions.isTransactionAutoApproved.mockReturnValue(true);
      const mismatched = await handlers['wallet:dapp-send-transaction'](
        AUTO, TX, 2, { origin: 'https://other.example' }, { autoApprove: SITE, webContentsId: 12 });
      expect(mismatched).toMatchObject({
        success: false,
        code: 'SIGNING_NOT_CONFIRMED',
        error: expect.stringContaining("the request's site is not the one its auto-approve names"),
      });
      expect(takeSiteTurn).not.toHaveBeenCalled();
      expect(signAndRecord).not.toHaveBeenCalled();

      // The same site, as a page path: recorded under its permission key.
      await handlers['wallet:dapp-send-transaction'](
        AUTO, TX, 2, { origin: `${SITE}/swap` }, { autoApprove: SITE, webContentsId: 12 });
      expect(signAndRecord).toHaveBeenCalledWith(
        TX,
        signer,
        expect.objectContaining({ kind: 'dapp-send', origin: SITE }),
        expect.objectContaining({ walletIndex: 2 })
      );

      // No context origin at all: the authorized site.
      await handlers['wallet:dapp-send-transaction'](AUTO, TX, 2, {}, { autoApprove: SITE, webContentsId: 12 });
      expect(signAndRecord).toHaveBeenLastCalledWith(
        TX,
        signer,
        expect.objectContaining({ origin: SITE }),
        expect.objectContaining({ walletIndex: 2 })
      );
    });

    test('codex: main binds a confirmed send to the site the user confirmed', async () => {
      dappPermissions.getPermission.mockReturnValue({ walletIndex: 2 });
      const forOther = await mint('dapp-send', 2, { ...TX, origin: 'https://other.example' });
      const refused = await handlers['wallet:dapp-send-transaction'](
        {}, TX, 2, { origin: SITE }, { confirmation: forOther });
      expect(refused).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      // A dApp payment's confirmation must name its site (round 2).
      await expect(handlers['wallet:confirm-signing']({}, 'dapp-send', 2, TX)).resolves.toMatchObject({
        success: false,
        error: 'A dApp payment needs the site it is for',
      });
      expect(signAndRecord).not.toHaveBeenCalled();

      const confirmed = await mint('dapp-send', 2, { ...TX, origin: SITE });
      await handlers['wallet:dapp-send-transaction'](
        {}, TX, 2, { origin: `${SITE}/swap` }, { confirmation: confirmed });
      expect(signAndRecord).toHaveBeenCalledWith(
        TX,
        signer,
        expect.objectContaining({ origin: SITE }),
        expect.objectContaining({ walletIndex: 2 })
      );
    });

    test('auto-approve claimed without a stored rule is refused', async () => {
      dappPermissions.getPermission.mockReturnValue({ walletIndex: 2 });
      const result = await handlers['wallet:dapp-send-transaction'](
        AUTO, TX, 2, { origin: SITE }, { autoApprove: SITE, webContentsId: 12 });
      expect(result).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      expect(signAndRecord).not.toHaveBeenCalled();
    });

    test('#764: a stored rule is never applied for a guest on another site', async () => {
      dappPermissions.getPermission.mockReturnValue({ walletIndex: 2 });
      dappPermissions.isTransactionAutoApproved.mockReturnValue(true);
      guest(77, 'https://attacker.example/');
      const result = await handlers['wallet:dapp-send-transaction'](
        AUTO, TX, 2, { origin: SITE }, { autoApprove: SITE, webContentsId: 77 });
      expect(result).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      expect(signAndRecord).not.toHaveBeenCalled();
      expect(dappPermissions.isTransactionAutoApproved).not.toHaveBeenCalled();
    });

    test('a stored rule never authorises another account than the grant exposes', async () => {
      dappPermissions.getPermission.mockReturnValue({ walletIndex: 2 });
      dappPermissions.isTransactionAutoApproved.mockReturnValue(true);
      const result = await handlers['wallet:dapp-send-transaction'](
        AUTO, TX, 0, { origin: SITE }, { autoApprove: SITE, webContentsId: 12 });
      expect(result).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      expect(signAndRecord).not.toHaveBeenCalled();
    });

    test('a plain transfer (no selector) is never auto-approved', async () => {
      dappPermissions.getPermission.mockReturnValue({ walletIndex: 2 });
      dappPermissions.isTransactionAutoApproved.mockReturnValue(true);
      const result = await handlers['wallet:dapp-send-transaction'](
        AUTO, { ...TX, data: '0x' }, 2, { origin: SITE }, { autoApprove: SITE, webContentsId: 12 });
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
        AUTO, TX, 2, { origin: SITE }, { autoApprove: SITE, webContentsId: 12, rememberAutoApprove: 'https://other.example' });
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
      const refused = await handlers[channel](AUTO, payload, 0, { autoApprove: SITE, webContentsId: 12 });
      expect(refused).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });

      dappPermissions.getSigningAutoApprove.mockReturnValue(true);
      const signed = await handlers[channel](AUTO, payload, 0, { autoApprove: SITE, webContentsId: 12 });
      expect(signed.success).toBe(true);
      expect(dappPermissions.getSigningAutoApprove).toHaveBeenCalledWith(SITE);

      // ...and only for the account the site is connected with.
      const other = await handlers[channel](AUTO, payload, 1, { autoApprove: SITE, webContentsId: 12 });
      expect(other).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
    });

    // #764: the renderer names the site; main checks the guest that asked.
    describe('the auto-approve key must belong to the requesting page', () => {
      beforeEach(() => {
        dappPermissions.getPermission.mockReturnValue({ walletIndex: 0 });
        dappPermissions.getSigningAutoApprove.mockReturnValue(true);
      });

      const refusedWith = async (event, authorization) => {
        const result = await handlers[channel](event, payload, 0, authorization);
        expect(result).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
        expect(signer[method]).not.toHaveBeenCalled();
        expect(dappPermissions.getSigningAutoApprove).not.toHaveBeenCalled();
      };

      test('a background tab claiming the visible site’s key is refused', async () => {
        guest(77, 'https://attacker.example/');
        await refusedWith(AUTO, { autoApprove: SITE, webContentsId: 77 });
      });

      test('a claim with no requesting guest is refused', async () => {
        await refusedWith(AUTO, { autoApprove: SITE });
      });

      test('an unknown or destroyed guest is refused', async () => {
        await refusedWith(AUTO, { autoApprove: SITE, webContentsId: 99 });
        guest(13, SITE, { destroyed: true });
        await refusedWith(AUTO, { autoApprove: SITE, webContentsId: 13 });
      });

      test('another window’s guest is refused', async () => {
        guest(14, SITE, { host: { id: 2 } });
        await refusedWith(AUTO, { autoApprove: SITE, webContentsId: 14 });
      });

      test('a claim from an IPC with no sender is refused', async () => {
        await refusedWith({}, { autoApprove: SITE, webContentsId: 12 });
      });

      test('a guest that navigated to another site since the request is refused', async () => {
        guest(12, 'https://elsewhere.example/');
        await refusedWith(AUTO, { autoApprove: SITE, webContentsId: 12 });
      });

      test.each([
        ['an ENS site over Swarm', 'bzz://myapp.eth/page?x=1', 'myapp.eth'],
        ['a content-addressed IPFS root', 'ipfs://QmRootCid/docs/', 'ipfs://QmRootCid'],
        ['an onchain app (internal origin form)',
          'web3://0x1111111111111111111111111111111111111111.eip155-100/index.html',
          'web3://0x1111111111111111111111111111111111111111:100'],
      ])('%s: the guest’s own page key is honoured', async (_label, url, key) => {
        guest(20, url);
        const result = await handlers[channel](AUTO, payload, 0, { autoApprove: key, webContentsId: 20 });
        expect(result.success).toBe(true);
        expect(dappPermissions.getSigningAutoApprove).toHaveBeenCalledWith(key);
      });

      // A DNS-named ENS site (`ens://example.com`) loads as ipns://<key>;
      // the renderer keys it on the name, and main accepts that only when
      // its own resolution of the name answers the guest's exact key.
      describe('a DNS-named ENS site over IPNS', () => {
        const { resolveEnsContent } = require('../ens-resolver');
        const B58 = '12D3KooWAsDaZWCkCEUN3myg49NoCMmrYYivmJVwjg7DVJBvWdaX';
        const B36 = 'k51qzi5uqu5dgkkr5wjh0m796f9u3tou74wn2q2u3shgh6yn52ce4hitig3if4';
        const NAME = 'example.com';
        const resolvesTo = (decoded) => ({ type: 'ok', protocol: 'ipns', uri: `ipns://${decoded}`, decoded });

        beforeEach(() => {
          resolveEnsContent.mockReset().mockResolvedValue(resolvesTo(B58));
        });

        test.each([
          ['the base36 key navigation loads', B36],
          ['the resolver’s own base58 key', B58],
        ])('is honoured on %s', async (_label, host) => {
          guest(30, `ipns://${host}/app/`);
          const result = await handlers[channel](AUTO, payload, 0, { autoApprove: NAME, webContentsId: 30 });
          expect(result.success).toBe(true);
          expect(resolveEnsContent).toHaveBeenCalledWith(NAME);
          expect(dappPermissions.getSigningAutoApprove).toHaveBeenCalledWith(NAME);
        });

        test('is refused when the name resolves to another key', async () => {
          guest(30, 'ipns://k51otherkey/');
          await refusedWith(AUTO, { autoApprove: NAME, webContentsId: 30 });
        });

        test('is refused on a case-folded base58 host', async () => {
          guest(30, `ipns://${B58.toLowerCase()}/`);
          await refusedWith(AUTO, { autoApprove: NAME, webContentsId: 30 });
        });

        test('is refused when the name does not resolve to IPNS, or resolution fails', async () => {
          guest(30, `ipns://${B36}/`);
          resolveEnsContent.mockResolvedValueOnce({ type: 'ok', protocol: 'ipfs', decoded: B36 });
          await refusedWith(AUTO, { autoApprove: NAME, webContentsId: 30 });
          resolveEnsContent.mockResolvedValueOnce({ type: 'not_found' });
          await refusedWith(AUTO, { autoApprove: NAME, webContentsId: 30 });
          resolveEnsContent.mockRejectedValueOnce(new Error('rpc down'));
          await refusedWith(AUTO, { autoApprove: NAME, webContentsId: 30 });
        });

        test('is refused when the guest navigates away while the name resolves', async () => {
          guest(30, `ipns://${B36}/`);
          resolveEnsContent.mockImplementationOnce(async () => {
            guests.get(30).getURL = () => 'https://attacker.example/';
            return resolvesTo(B58);
          });
          await refusedWith(AUTO, { autoApprove: NAME, webContentsId: 30 });
        });

        test('never applies to a non-IPNS guest, or to an ENS-host or scheme key', async () => {
          guest(31, 'https://attacker.example/');
          await refusedWith(AUTO, { autoApprove: NAME, webContentsId: 31 });
          guest(30, `ipns://${B36}/`);
          await refusedWith(AUTO, { autoApprove: 'myapp.eth', webContentsId: 30 });
          await refusedWith(AUTO, { autoApprove: 'https://example.com', webContentsId: 30 });
          expect(resolveEnsContent).not.toHaveBeenCalled();
        });
      });
    });
  });

  // The fee check at confirmation (design 0005, A): a transaction's
  // confirmation is the moment of its approval; an auto-approved send is
  // judged when main signs it.
  describe('the fee check at confirmation', () => {
    const feeCheck = require('./fee-check');
    const verdict = (fields) => ({
      maxCost: '1050000000000000',
      comparable: true,
      ratio: '1',
      above: false,
      oneEndpoint: false,
      basis: 'header',
      autoApprove: true,
      askAgain: false,
      ...fields,
    });

    beforeEach(() => {
      feeCheck.checkAtApproval.mockReset().mockImplementation(async () => verdict());
      feeCheck.checkFees.mockReset().mockImplementation(async () => verdict());
    });

    test('wallet:fee-check answers the verdict for the screen to show', async () => {
      feeCheck.checkFees.mockResolvedValue(verdict({ ratio: '20', above: true, autoApprove: false }));
      await expect(handlers['wallet:fee-check']({}, TX)).resolves.toEqual({
        success: true,
        feeCheck: verdict({ ratio: '20', above: true, autoApprove: false }),
      });
      expect(feeCheck.checkFees).toHaveBeenCalledWith(TX);
    });

    test('a fee above the threshold gets no confirmation until the user confirms it again', async () => {
      const above = verdict({ ratio: '20', above: true, autoApprove: false });
      feeCheck.checkAtApproval.mockImplementation(async (_tx, { acknowledged }) => ({
        ...above,
        askAgain: !acknowledged,
      }));
      for (const [kind, index, payload] of [
        ['wallet-send', null, TX],
        ['dapp-send', 2, { ...TX, origin: SITE }],
        // A Safe executor's fee, confirmed on the Safe's screen.
        ['executor-send', 0, TX],
      ]) {
        const outstanding = confirmations._outstandingCount();
        const asked = await handlers['wallet:confirm-signing']({}, kind, index, payload);
        expect(asked).toEqual({
          success: false,
          code: 'FEE_CHECK_ASK_AGAIN',
          error: "The network fee is 20× today's network fee. Confirm it again to send.",
          feeCheck: { ...above, askAgain: true },
        });
        // Nothing was minted.
        expect(confirmations._outstandingCount()).toBe(outstanding);
        const confirmed = await handlers['wallet:confirm-signing']({}, kind, index, payload, {
          feeAcknowledged: true,
        });
        expect(confirmed).toMatchObject({ success: true, token: expect.any(String) });
        expect(feeCheck.checkAtApproval).toHaveBeenLastCalledWith(payload, { acknowledged: true });
      }
      // Anything but a strict true is no answer.
      await handlers['wallet:confirm-signing']({}, 'wallet-send', null, TX, { feeAcknowledged: 'yes' });
      expect(feeCheck.checkAtApproval).toHaveBeenLastCalledWith(TX, { acknowledged: false });
    });

    test("messages, Safe payments and a phone's own payments have no fee to check", async () => {
      await mint('sign-message', 0, 'hello');
      await mint('safe-send', 0, { tx: { to: TX.to, value: '0', data: '0x' }, chainId: 100 });
      // A phone picks and pays its own fee: main signs nothing.
      getSigner.mockReturnValue({ sendTransaction: jest.fn() });
      await mint('wallet-send', null, TX);
      expect(feeCheck.checkAtApproval).not.toHaveBeenCalled();
    });

    test('an auto-approved send whose fee needs the user is refused, with nothing signed', async () => {
      dappPermissions.getPermission.mockReturnValue({ walletIndex: 2 });
      dappPermissions.isTransactionAutoApproved.mockReturnValue(true);
      for (const fields of [
        { comparable: false, ratio: null, autoApprove: false },
        { oneEndpoint: true, autoApprove: false },
        { ratio: '20', above: true, autoApprove: false, askAgain: true },
      ]) {
        feeCheck.checkAtApproval.mockResolvedValueOnce(verdict(fields));
        const result = await handlers['wallet:dapp-send-transaction'](
          {}, TX, 2, { origin: SITE }, { autoApprove: SITE });
        expect(result).toMatchObject({
          success: false,
          code: 'FEE_CHECK_NOT_AUTO_APPROVED',
          feeCheck: verdict(fields),
        });
      }
      expect(signAndRecord).not.toHaveBeenCalled();
      // Refused before it took its site's turn.
      expect(takeSiteTurn).not.toHaveBeenCalled();
      // A fee that passes is signed.
      const result = await handlers['wallet:dapp-send-transaction'](
        {}, TX, 2, { origin: SITE }, { autoApprove: SITE });
      expect(result).toMatchObject({ success: true });
      expect(feeCheck.checkAtApproval).toHaveBeenLastCalledWith(TX);
    });

    // Main never signs a fee the user didn't see: a confirmed send without
    // its own fees would be given today's after its confirmation.
    test("a send whose fee wasn't shown is refused, with nothing signed", async () => {
      const { gasPrice: _shown, ...noFee } = TX;
      const halfFee = { ...noFee, maxFeePerGas: '2000000000' };
      const zeroFee = { ...noFee, gasPrice: 0 };
      for (const tx of [noFee, halfFee, zeroFee]) {
        const confirmation = await mint('dapp-send', 2, { ...tx, origin: SITE });
        const result = await handlers['wallet:dapp-send-transaction'](
          {}, tx, 2, { origin: SITE }, { confirmation });
        expect(result).toEqual({
          success: false,
          code: 'FEE_NOT_SHOWN',
          error: "This payment's network fee wasn't shown, so nothing was signed. Review it again.",
        });
        const sent = await handlers['wallet:send-transaction'](
          {}, tx, {}, { confirmation: await mint('wallet-send', null, tx) });
        expect(sent).toMatchObject({ success: false, code: 'FEE_NOT_SHOWN' });
      }
      expect(signAndRecord).not.toHaveBeenCalled();
      expect(takeSiteTurn).not.toHaveBeenCalled();
      // A phone picks its own fee.
      getSigner.mockReturnValue({ sendTransaction: jest.fn() });
      const phone = await handlers['wallet:send-transaction'](
        {}, noFee, {}, { confirmation: await mint('wallet-send', null, noFee) });
      expect(phone).toMatchObject({ success: true });
    });

    test("a Safe's execution or activation stopped for its fee answers what to show", async () => {
      const { executeSafePending } = require('./safe/safe-transactions');
      const { activateSafe } = require('./safe/safe-service');
      const judged = verdict({ comparable: false, ratio: null, autoApprove: false });
      const offer = { executorIndex: 0, ...TX };
      const stop = () =>
        Object.assign(feeCheck.feeCheckError('FEE_CHECK_NEEDS_CONFIRMATION', judged), { offer });
      executeSafePending.mockRejectedValueOnce(stop());
      activateSafe.mockRejectedValueOnce(stop());
      for (const channel of ['wallet:safe-execute', 'wallet:activate-safe']) {
        await expect(handlers[channel]({}, 7)).resolves.toEqual({
          success: false,
          code: 'FEE_CHECK_NEEDS_CONFIRMATION',
          error: "This payment's network fee needs your confirmation.",
          feeCheck: judged,
          offer,
        });
      }
      expect(executeSafePending).toHaveBeenLastCalledWith(7, { feeConfirmation: undefined });
      expect(activateSafe).toHaveBeenLastCalledWith(7, { feeConfirmation: undefined });

      // The user's confirmation of that fee goes back with the retry.
      const feeConfirmation = { confirmation: 'token', gasLimit: TX.gasLimit, fees: { gasPrice: TX.gasPrice } };
      activateSafe.mockResolvedValueOnce({ safeAddress: '0xsafe', hash: '0xhash' });
      await handlers['wallet:safe-execute']({}, 7, { feeConfirmation });
      await handlers['wallet:activate-safe']({}, 7, { feeConfirmation });
      expect(executeSafePending).toHaveBeenLastCalledWith(7, { feeConfirmation });
      expect(activateSafe).toHaveBeenLastCalledWith(7, { feeConfirmation });
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

    // Review of #788, round 3: a dApp's SafeTx is confirmed for its site,
    // which its payment is recorded under and whose turn it takes (D12).
    test("codex r3: a dApp's SafeTx confirmation binds its site", async () => {
      const send = async (minted, display) =>
        handlers['wallet:safe-send']({}, 7, SAFE_TX, display, 100, {
          confirmation: await mint('safe-send', 7, { tx: SAFE_TX, chainId: 100, ...minted }),
        });

      // Changed, added or removed between the confirmation and the send.
      for (const [minted, display] of [
        [{ origin: SITE }, { site: 'https://other.example' }],
        [{}, { site: SITE }],
        [{ origin: SITE }, {}],
      ]) {
        await expect(send(minted, display)).resolves.toMatchObject({
          success: false,
          code: 'SIGNING_NOT_CONFIRMED',
        });
      }
      expect(startSafeSend).not.toHaveBeenCalled();

      // The same site: the SafeTx starts, recording it as a permission key.
      await expect(
        send({ origin: SITE }, { site: `${SITE}/swap`, label: 'a contract call' })
      ).resolves.toMatchObject({ success: true });
      expect(startSafeSend).toHaveBeenLastCalledWith(
        expect.objectContaining({ display: { site: SITE, label: 'a contract call' } })
      );
      // The wallet's own SafeTx has no site on either side.
      await expect(send({}, { recipientName: null })).resolves.toMatchObject({ success: true });
      expect(startSafeSend).toHaveBeenLastCalledWith(
        expect.objectContaining({ display: { recipientName: null } })
      );
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
      const result = await handlers['wallet:safe-send'](AUTO, 7, SAFE_TX, {}, 100, { autoApprove: SITE, webContentsId: 12 });
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
        AUTO, 7, REQUEST, {}, REQUESTER, { autoApprove: 'https://other.example', webContentsId: 12 });
      expect(otherSite).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });

      const ok = await handlers['wallet:safe-message-start'](
        AUTO, 7, REQUEST, {}, REQUESTER, { autoApprove: SITE, webContentsId: 12 });
      expect(ok).toMatchObject({ success: true });
      expect(startSafeMessage).toHaveBeenCalledTimes(1);
    });

    test('#764: wallet:safe-message-start refuses a key the requesting guest does not hold', async () => {
      dappPermissions.getPermission.mockReturnValue({ walletIndex: 7 });
      dappPermissions.getSigningAutoApprove.mockReturnValue(true);
      guest(77, 'https://attacker.example/');

      // Guest 77 is on another site, even though requester and claim agree.
      const borrowed = await handlers['wallet:safe-message-start'](
        AUTO, 7, REQUEST, {}, { origin: SITE, webContentsId: 77 }, { autoApprove: SITE, webContentsId: 77 });
      expect(borrowed).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });

      // The claim names another guest than the session is bound to.
      const mismatched = await handlers['wallet:safe-message-start'](
        AUTO, 7, REQUEST, {}, { origin: SITE, webContentsId: 77 }, { autoApprove: SITE, webContentsId: 12 });
      expect(mismatched).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      expect(startSafeMessage).not.toHaveBeenCalled();
    });
  });

  test('wallet:confirm-signing refuses a malformed request', async () => {
    const result = await handlers['wallet:confirm-signing']({}, 'dapp-send', 2, { ...TX, gasLimit: 'x' });
    expect(result).toMatchObject({ success: false });
    expect(result.token).toBeUndefined();
  });
});
