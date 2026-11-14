jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn() },
  webContents: { fromId: jest.fn(() => null) },
  BrowserWindow: { fromWebContents: jest.fn(() => null) },
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
jest.mock('../identity-manager', () => ({
  getActiveWalletIndex: jest.fn(() => 0),
  // Safe 7, whose address a safe-send token binds.
  getWalletRecord: (index) => (index === 7 ? { index, type: 'safe', address: '0x' + '77'.repeat(20) } : null),
}));
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
jest.mock('./safe/safe-service', () => ({ activateSafe: jest.fn(), DEPLOY_CHAIN_ID: 100 }));
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
// The approvals document (freedom-core design 0011, APS-3): off, unless a
// test turns it on with its own panel.
let mockWalletApprovals = null;
jest.mock('../approvals/wallet-approvals', () => {
  const actual = jest.requireActual('../approvals/wallet-approvals');
  return { ...actual, getWalletApprovals: () => mockWalletApprovals };
});
// The identity core's typed_data.hash (freedom-core design 0002, #88),
// simulated with ethers: the digest and the view, with its reports.
const mockCoreViews = [];
// Its approval tokens (design 0012, APB-1), simulated too.
const mockApprovals = require('../../../test/helpers/simulated-approvals').simulatedApprovals();
jest.mock('../core/vault-backend', () => {
  const { TypedDataEncoder } = require('ethers');
  const { simulatedView } = require('../../../test/helpers/simulated-vault-core');
  return {
    vaultBackend: {
      approval: mockApprovals.approval,
      typedDataView: jest.fn(async (data, options) => {
        mockCoreViews.push([data, options]);
        return {
          hash: TypedDataEncoder.hash(data.domain, data.types, data.message),
          view: simulatedView(data, options),
        };
      }),
    },
  };
});
// An x402 cap edit as main confirms it (#1023): the sending window, the
// key, the cap as the store holds it, and the change.
const mockCapHeld = { current: { capAmount: '10000000', createdAt: 1000, expiresAt: 87400, generation: 3 } };
jest.mock('../x402/permissions', () => ({
  capUpdateRequest: (windowId, { origin, chainId, asset, capAmount, windowSeconds } = {}) => ({
    window: windowId,
    origin,
    chainId,
    asset,
    capAmount,
    windowSeconds,
    current: mockCapHeld.current,
  }),
}));
// x402's payment as main's record of its detection holds it (APS-5),
// replaced per test: the panel's prompt and its token bind this, not the
// chrome's copy.
const mockX402Record = { build: null };
jest.mock('../x402/ipc', () => ({
  paymentApprovalRequest: (sender, payload) => mockX402Record.build(sender, payload),
}));
jest.mock('./auto-approve-pause', () => ({
  transactionAutoApprovePaused: jest.fn(async () => false),
  takeSiteTurn: jest.fn(async () => () => {}),
  sitePaymentWaiting: jest.fn(async () => false),
}));

const { buildTxRecordContext, messageViewFor, registerWalletIpc, typedDataViewFor } = require('./wallet-ipc');
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

test("a wallet handler runs for its chrome's window: a phone account's job shows there (APS-4)", async () => {
  const { BrowserWindow } = require('electron');
  const { requestWindowId } = require('../windows/request-window');
  const chrome = { id: 41 };
  BrowserWindow.fromWebContents.mockImplementation((contents) =>
    contents === chrome ? { id: 6, webContents: chrome, isDestroyed: () => false } : null
  );
  registerWalletIpc();
  const handler = ipcMain.handle.mock.calls.find(([channel]) => channel === 'wallet:get-balances-cached')[1];
  getBalancesWithCache.mockImplementationOnce(async () => ({ balances: requestWindowId(), fromCache: true }));
  expect(await handler({ sender: chrome }, '0xabc')).toEqual(expect.objectContaining({ balances: 6 }));
  // Not a chrome window's own webContents: no window.
  getBalancesWithCache.mockImplementationOnce(async () => ({ balances: requestWindowId(), fromCache: true }));
  expect(await handler({ sender: { id: 42 } }, '0xabc')).toEqual(expect.objectContaining({ balances: null }));
  BrowserWindow.fromWebContents.mockReset().mockReturnValue(null);
});

// Security audit O-7: every signing handler refuses unless it is handed a
// confirmation token main issued for exactly this request. A site's rules
// are main's to read, for a page's request it holds (freedom-core design
// 0011): no handler here honours one.
describe('signing handlers require a main-side confirmation', () => {
  const { signAndRecord } = require('./tx-recorder');
  const { getSigner } = require('./signers');
  const { getActiveWalletIndex } = require('../identity-manager');
  const dappPermissions = require('./dapp-permissions');
  const { startSafeSend } = require('./safe/safe-transactions');
  const confirmations = require('./signing-confirmation');
  const { toCoreTransaction, buildTransaction } = require('./signing-utils');
  // Tokens outstanding: main's own (x402's) and the core's.
  const outstanding = () => confirmations._outstandingCount() + mockApprovals.outstanding();
  // What the core signed: a token is checked as it signs (design 0012).
  let signedTxs = [];

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

  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    confirmations._reset();
    mockApprovals.reset();
    signedTxs = [];
    ipcMain.handle.mockClear();
    registerWalletIpc();
    handlers = Object.fromEntries(ipcMain.handle.mock.calls.map(([channel, fn]) => [channel, fn]));
    // The account's signer presents its confirmation to the (simulated)
    // core as it signs, which spends it there (design 0012, APB-1).
    getSigner.mockReset().mockImplementation((index, authorized = {}) => ({
      signTransaction: async (tx) => {
        try {
          mockApprovals.authorize(
            'sign.transaction',
            index,
            { tx: toCoreTransaction(tx).tx },
            authorized.confirmation ? confirmations.signingAuthorization(authorized.confirmation) : {}
          );
        } catch (err) {
          throw confirmations.confirmationError(err);
        }
        signedTxs.push(tx);
      },
    }));
    signAndRecord.mockReset().mockImplementation(async (tx, signer) => {
      // A phone signs and sends in one step.
      if (signer.sendTransaction) await signer.sendTransaction(tx);
      else await signer.signTransaction(buildTransaction({ ...tx, nonce: 0 }));
      return { hash: '0xhash' };
    });
    getActiveWalletIndex.mockReset().mockReturnValue(0);
    dappPermissions.getPermission.mockReset().mockReturnValue(null);
    dappPermissions.getSigningAutoApprove.mockReset().mockReturnValue(false);
    dappPermissions.isTransactionAutoApproved.mockReset().mockReturnValue(false);
    dappPermissions.addTransactionAutoApprove.mockReset().mockReturnValue(true);
    startSafeSend.mockClear();
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
      expect(signedTxs).toHaveLength(1);

      const replay = await handlers['wallet:send-transaction']({}, TX, {}, { confirmation });
      expect(replay).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      // Refused by the core as it was presented: nothing signed.
      expect(signedTxs).toHaveLength(1);
    });

    test("an executor-send token is refused before any signature, and burnt", async () => {
      // The core reads a transaction token's kind from the token: main checks
      // the route's against the kind it minted, as its JS check did.
      const confirmation = await mint('executor-send', 0, TX);
      mockApprovals.calls.length = 0;
      getSigner.mockClear();
      const result = await handlers['wallet:send-transaction']({}, TX, {}, { confirmation });
      expect(result).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      expect(result.error).toMatch(/request differs from what was confirmed/);
      expect(signAndRecord).not.toHaveBeenCalled();
      expect(getSigner).not.toHaveBeenCalled();
      expect(signedTxs).toEqual([]);
      // Nothing asked of the core but the burn.
      expect(mockApprovals.calls.map((call) => call.method)).toEqual(['approval.discard']);
      expect(mockApprovals.calls[0].params).toEqual({ token: confirmation });
      expect(outstanding()).toBe(0);
      // Burnt: the executor's own route can't present it either.
      const { confirmationFor } = confirmations;
      expect(() => confirmationFor(confirmation, 'executor-send', 0, TX)).toThrow(/unknown or already used/);
    });

    test('a changed recipient is refused', async () => {
      const confirmation = await mint('wallet-send', null, TX);
      const result = await handlers['wallet:send-transaction'](
        {}, { ...TX, to: '0x' + '66'.repeat(20) }, {}, { confirmation });
      expect(result).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      expect(signedTxs).toEqual([]);
    });

    test('the account active when confirming is the one bound', async () => {
      const confirmation = await mint('wallet-send', 5 /* ignored */, TX);
      getActiveWalletIndex.mockReturnValue(1);
      const result = await handlers['wallet:send-transaction']({}, TX, {}, { confirmation });
      expect(result).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      expect(signedTxs).toEqual([]);
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

    test('a wallet send has no rule to claim either', async () => {
      const result = await handlers['wallet:send-transaction']({}, TX, {}, { autoApprove: SITE, webContentsId: 12 });
      expect(result).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      expect(signAndRecord).not.toHaveBeenCalled();
    });
  });

  // freedom-core design 0011: a page's sends, signatures and chain reads
  // are main's (page/page-sends.js, page/page-signing.js), and the chrome's
  // old route into them is gone (PRQ-9).
  test("the chrome's old page-request channels are gone", () => {
    for (const channel of [
      'wallet:dapp-send-transaction',
      'wallet:sign-message',
      'wallet:sign-typed-data',
      'wallet:typed-data-view',
      'wallet:message-view',
      'wallet:safe-message-start',
      'wallet:safe-message-complete',
      'wallet:chain-request',
    ]) {
      expect(Object.keys(handlers)).not.toContain(channel);
    }
  });

  // freedom-core design 0011, PRQ-5b: a page's send, from a Safe account
  // too, is served by main (page/page-sends.js), whose own issuer mints its
  // token and which reads the site's contract rule itself. The chrome gets
  // no dApp-send token, and no IPC records a rule.
  describe('a dApp send', () => {
    const { checkAtApproval } = require('./fee-check');

    test('the chrome gets no dApp-send token: nothing issued, and no fee judged', async () => {
      checkAtApproval.mockClear();
      const result = await handlers['wallet:confirm-signing']({}, 'dapp-send', 2, { ...TX, origin: SITE });
      expect(result).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      expect(result.token).toBeUndefined();
      expect(outstanding()).toBe(0);
      expect(checkAtApproval).not.toHaveBeenCalled();
    });

    test('no IPC channel adds an auto-approve rule on its own', () => {
      expect(Object.keys(handlers)).not.toContain('dapp:add-tx-auto-approve');
    });
  });

  const TYPED = {
    domain: { name: 'App', chainId: 100 },
    types: {
      EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }],
      Order: [{ name: 'a', type: 'uint256' }],
    },
    primaryType: 'Order',
    message: { a: 1 },
  };
  const TYPED_HASH = require('ethers').TypedDataEncoder.hash(
    TYPED.domain,
    { Order: TYPED.types.Order },
    TYPED.message
  );

  // freedom-core design 0011, PRQ-5a: a page's personal_sign and typed data,
  // from a Safe account too, are served by main (page/page-signing.js),
  // whose own issuer mints their tokens. The chrome gets none.
  describe.each([
    ['sign-message', '0x68656c6c6f'],
    ['sign-typed-data', TYPED],
  ])('%s', (kind, payload) => {
    const { vaultBackend } = require('../core/vault-backend');

    test('the chrome gets no token of this kind', async () => {
      vaultBackend.typedDataView.mockClear();
      const result = await handlers['wallet:confirm-signing']({}, kind, 0, payload);
      expect(result).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      expect(result.token).toBeUndefined();
      expect(outstanding()).toBe(0);
      expect(vaultBackend.typedDataView).not.toHaveBeenCalled();
    });
  });

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
      // A dApp's send is judged by main's own prompt (page/page-sends.js).
      for (const [kind, index, payload] of [
        ['wallet-send', null, TX],
        // A Safe executor's fee, confirmed on the Safe's screen.
        ['executor-send', 0, TX],
      ]) {
        const tokensBefore = outstanding();
        const asked = await handlers['wallet:confirm-signing']({}, kind, index, payload);
        expect(asked).toEqual({
          success: false,
          code: 'FEE_CHECK_ASK_AGAIN',
          error: "The network fee is 20× today's network fee. Confirm it again to send.",
          feeCheck: { ...above, askAgain: true },
        });
        // Nothing was minted.
        expect(outstanding()).toBe(tokensBefore);
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

    test("Safe payments and a phone's own payments have no fee to check", async () => {
      await mint('safe-send', 7, { tx: { to: TX.to, value: '0', data: '0x' }, chainId: 100 });
      // A phone picks and pays its own fee: main signs nothing.
      getSigner.mockReturnValue({ sendTransaction: jest.fn() });
      await mint('wallet-send', null, TX);
      expect(feeCheck.checkAtApproval).not.toHaveBeenCalled();
    });

    // Main never signs a fee the user didn't see: a confirmed send without
    // its own fees would be given today's after its confirmation.
    test("a send whose fee wasn't shown is refused, with nothing signed", async () => {
      const { gasPrice: _shown, ...noFee } = TX;
      const halfFee = { ...noFee, maxFeePerGas: '2000000000' };
      const zeroFee = { ...noFee, gasPrice: 0 };
      for (const tx of [noFee, halfFee, zeroFee]) {
        const sent = await handlers['wallet:send-transaction'](
          {}, tx, {}, { confirmation: await mint('wallet-send', null, tx) });
        expect(sent).toEqual({
          success: false,
          code: 'FEE_NOT_SHOWN',
          error: "This payment's network fee wasn't shown, so nothing was signed. Review it again.",
        });
      }
      expect(signAndRecord).not.toHaveBeenCalled();
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

  // freedom-core design 0011, APS-3: with the approvals document on, the
  // wallet's own kinds are minted only on the user's approval in the
  // window's panel, of main's view of exactly the request bound.
  describe('the wallet\'s own kinds, with the approvals document on', () => {
    afterEach(() => {
      mockWalletApprovals = null;
    });

    test('a token only once the panel approves; none when it doesn\'t; a bad request asks nothing', async () => {
      const feeCheck = require('./fee-check');
      feeCheck.checkAtApproval.mockClear();
      const asked = [];
      let answer = { approved: true };
      let mintedBeforeAnswer = null;
      mockWalletApprovals = {
        // As wallet-approvals.js: the token is minted on the approval,
        // before the panel's decision is answered.
        confirm: jest.fn(async (request, onApproved) => {
          asked.push(request);
          if (!answer.approved) return answer;
          const tokensBefore = outstanding();
          const minted = await onApproved();
          mintedBeforeAnswer = outstanding() === tokensBefore + 1;
          return { ...minted, approved: true };
        }),
      };
      const chromeEvent = { sender: { id: 501 } };
      const tokensBefore = outstanding();
      const approved = await handlers['wallet:confirm-signing'](chromeEvent, 'wallet-send', null, TX, { feeAcknowledged: true });
      expect(approved).toMatchObject({ success: true, token: expect.any(String), expiresAt: expect.any(Number) });
      expect(mintedBeforeAnswer).toBe(true);
      expect(asked).toEqual([{ sender: chromeEvent.sender, kind: 'wallet-send', index: 0, payload: TX, feeChecked: true }]);
      // The fee is asked in the panel: the chrome's acknowledgement isn't read.
      expect(feeCheck.checkAtApproval).not.toHaveBeenCalled();
      expect(outstanding()).toBe(tokensBefore + 1);

      answer = { approved: false, error: 'User rejected the request', code: 'USER_REJECTED' };
      expect(await handlers['wallet:confirm-signing'](chromeEvent, 'intent-close', null, { intentId: 'intent-123', chainId: 100, sender: TX.to, nonce: 1, hashes: [`0x${'ab'.repeat(32)}`] })).toEqual({
        success: false,
        error: 'User rejected the request',
        code: 'USER_REJECTED',
      });
      expect(outstanding()).toBe(tokensBefore + 1);

      // A request the token couldn't bind is refused before anyone is asked.
      const before = asked.length;
      expect(await handlers['wallet:confirm-signing'](chromeEvent, 'intent-resend', null, { intentId: 'x', chainId: 100 })).toMatchObject({ success: false });
      expect(asked).toHaveLength(before);
      // The page kinds stay refused, unasked.
      expect(await handlers['wallet:confirm-signing'](chromeEvent, 'dapp-send', 0, TX)).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      expect(asked).toHaveLength(before);
    });
  });

  // freedom-core #88: typed data is signed only as the core's view showed
  // it, bound to its hash, and a warned request always needs its prompt.
  // Main's own prompt shows these views (page/page-signing.js).
  describe('typed data and its view', () => {
    const withData = (changes) => ({ ...TYPED, ...changes });

    test('typed data the core refuses gets no view', async () => {
      const { vaultBackend } = require('../core/vault-backend');
      vaultBackend.typedDataView.mockRejectedValueOnce(
        Object.assign(new Error('invalid typed data: too large to show in one reply'), { code: 'invalid_argument' })
      );
      await expect(typedDataViewFor(TYPED, 100)).rejects.toMatchObject({ code: 'invalid_argument' });
    });

    test("the view passes the dApp's primaryType as it came, and its chain", async () => {
      mockCoreViews.length = 0;
      for (const primaryType of ['Order', 'Other', true, false, null, 7, ['Order'], { Order: [] }]) {
        await typedDataViewFor(withData({ primaryType }), 100);
      }
      const { primaryType: _dropped, ...noPrimaryType } = TYPED;
      await typedDataViewFor(noPrimaryType, 100);
      // A JSON string from the dApp is parsed: its values keep their types.
      await typedDataViewFor(JSON.stringify(withData({ primaryType: null })), 1);
      expect(mockCoreViews.map(([, options]) => options)).toEqual([
        { primaryType: 'Order', chainId: 100 },
        { primaryType: 'Other', chainId: 100 },
        { primaryType: true, chainId: 100 },
        { primaryType: false, chainId: 100 },
        { primaryType: null, chainId: 100 },
        { primaryType: 7, chainId: 100 },
        { primaryType: ['Order'], chainId: 100 },
        { primaryType: { Order: [] }, chainId: 100 },
        { chainId: 100 },
        { primaryType: null, chainId: 1 },
      ]);
      // The core gets the data without EIP712Domain and primaryType.
      expect(mockCoreViews[0][0]).toEqual({
        domain: TYPED.domain,
        types: { Order: TYPED.types.Order },
        message: TYPED.message,
      });
    });

    test('the view reports what the approval screen warns about', async () => {
      const view = (data, chainId) => typedDataViewFor(data, chainId);
      await expect(view(TYPED, 100)).resolves.toMatchObject({ hash: TYPED_HASH, warnings: [] });
      await expect(view(withData({ primaryType: 'Other' }), 100)).resolves.toMatchObject({ warnings: ['named-type'] });
      await expect(view(withData({ primaryType: true }), 100)).resolves.toMatchObject({ warnings: ['named-type'] });
      await expect(view(TYPED, 1)).resolves.toMatchObject({ warnings: ['chain-mismatch'] });
      await expect(view(withData({ domain: { name: 'App' } }), 100)).resolves.toMatchObject({
        warnings: ['chain-absent'],
      });
      // Without a chain or a primaryType: unknown, never a match, no warning.
      const { primaryType: _dropped, ...noPrimaryType } = TYPED;
      const unknown = await view(noPrimaryType, undefined);
      expect(unknown.view).toMatchObject({ named_type: 'unknown', chain: 'unknown' });
      expect(unknown.warnings).toEqual([]);
    });

    test('personal_sign is shown from the bytes main signs', () => {
      expect(messageViewFor('0x68656c6c6f')).toEqual({ hex: '0x68656c6c6f', rawHash: false });
      expect(messageViewFor('0x48454C4C4F')).toEqual({ hex: '0x48454c4c4f', rawHash: false });
      expect(messageViewFor('hé')).toEqual({ hex: '0x68c3a9', rawHash: false });
      expect(messageViewFor('0x' + 'ab'.repeat(32))).toMatchObject({ rawHash: true });
      expect(messageViewFor('z'.repeat(32))).toMatchObject({ rawHash: true, hex: '0x' + '7a'.repeat(32) });
      // What signing would refuse, or can't show, fails before any prompt.
      for (const bad of ['0x41zz42', '0x123', ['0x00'], null]) {
        expect(() => messageViewFor(bad)).toThrow();
      }
    });
  });

  // Audit M1: the user's own tab a run adopts is driven like the tabs it
  // creates, so it must be held in Agent custody the same way.
  test('a run that adopts the user tab with "Allow website interactions" cannot use dApp auto-approve rules until the user takes it back', async () => {
    const { FreedomAgentService } = require('../agent/freedom-agent-service');
    const { createOriginScopedAutomationController } = require('../automation/origin-scoped-controller');
    const { OPERATIONS } = require('../automation/contract/operations');
    const { setAgentPageCustody, isAgentPage } = require('./agent-tab-custody');
    const page = guests.get(12);
    const envelope = (result) => ({
      ok: true, runtimeId: 'r', contextId: 'c', tabId: 'tab_user', navigationId: 1, result,
    });
    const controller = {
      execute: jest.fn(async (operation) => envelope(operation === OPERATIONS.SNAPSHOT
        ? { elements: [{ ref: 'ref_swap', role: 'button', name: 'Swap' }] }
        : { tab: { tabId: 'tab_user', url: `${SITE}/swap`, navigationId: 1, available: true } })),
      inspectAction: jest.fn(async () => envelope({ label: 'Swap' })),
      markPageControlled: jest.fn(),
      releasePageControl: jest.fn(),
      setPageAgentCustody: jest.fn((tabId, owned) => tabId === 'tab_user' && setAgentPageCustody(page, owned)),
    };
    let scoped;
    let finishTurn;
    const session = {
      subscribe: jest.fn(() => () => {}),
      prompt: jest.fn(() => new Promise((resolve) => { finishTurn = resolve; })),
      sendCustomMessage: jest.fn(async () => {}),
      steer: jest.fn(async () => {}),
      clearQueue: jest.fn(() => ({ steering: [], followUp: [] })),
      abort: jest.fn(async () => finishTurn?.()),
      dispose: jest.fn(),
    };
    const service = new FreedomAgentService({
      controller,
      loadSdk: jest.fn(async () => ({})),
      createControllerScope: async (options) => {
        scoped = await createOriginScopedAutomationController(options);
        return scoped;
      },
      createTools: jest.fn(async () => []),
      createSession: jest.fn(async () => ({ session })),
      effectClassifier: { classify: jest.fn(async () => ({ effect: 'read', confidence: 1 })) },
      accessReviewer: { review: jest.fn(async () => ({ decision: 'ask_user' })) },
      interactionClassifier: { classify: jest.fn(async () => ({
        kind: 'ordinary', confidence: 1, summary: 'Swap.', uncertainties: [],
      })) },
      runIdFactory: () => 'run_adopted',
      conversationIdFactory: () => 'conversation_adopted',
      now: () => 1_000,
    });
    // Main reads custody live for a page's request before any standing rule
    // answers it (freedom-core design 0011, page/page-sends.js and
    // page/page-signing.js): the tab's custody, as main reads it.
    const { guestInCustody } = require('../page/page-signing');
    const ruleMayAnswer = () => !guestInCustody(12);

    try {
      await service.start({
        prompt: 'Swap on this page', tabId: 'tab_user', approvalMode: 'allow_website_interactions',
        model: { id: 'model_test', provider: 'test' }, modelRuntime: {},
        createWorkspacePage: jest.fn(async () => 'tab_fresh'),
      });
      // The model's click on the adopted page needs no approval in this mode...
      await scoped.execute(OPERATIONS.SNAPSHOT, { tabId: 'tab_user' });
      expect(await scoped.execute(OPERATIONS.CLICK, { tabId: 'tab_user', ref: 'ref_swap' }))
        .toMatchObject({ ok: true });
      expect(controller.execute).toHaveBeenCalledWith(OPERATIONS.CLICK, expect.anything(), expect.anything());
      // ...so whatever the page then asks for, no site rule answers for it.
      expect(isAgentPage(page)).toBe(true);
      expect(ruleMayAnswer()).toBe(false);

      // Ending the turn does not hand the tab back; only the user does.
      finishTurn();
      await service.waitForIdle();
      expect(ruleMayAnswer()).toBe(false);
      await expect(service.claimTab('tab_user')).resolves.toBe(true);
      expect(isAgentPage(page)).toBe(false);
      expect(ruleMayAnswer()).toBe(true);
    } finally {
      setAgentPageCustody(page, false);
      await service.dispose();
    }
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
    // freedom-core design 0011, PRQ-5b: a dApp's SafeTx is main's, minted
    // for the requester's key (page/page-sends.js). The chrome gets no
    // safe-send token that names a site, and starts no SafeTx for one.
    test("the chrome gets no Safe-send token for a site, and starts no site's SafeTx", async () => {
      const refused = await handlers['wallet:confirm-signing']({}, 'safe-send', 7, {
        tx: SAFE_TX,
        chainId: 100,
        origin: SITE,
      });
      expect(refused).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      expect(outstanding()).toBe(0);
      // A page token, main's own, is never spent here.
      const { token } = await confirmations.issuePageConfirmation(
        'safe-send',
        7,
        { tx: SAFE_TX, chainId: 100, origin: SITE },
        { handle: 'b'.repeat(64), context: { origin: SITE, top_origin: SITE, frame: 1, navigation: 1, agent: false } }
      );
      await expect(
        handlers['wallet:safe-send']({}, 7, SAFE_TX, { site: SITE }, 100, { confirmation: token })
      ).resolves.toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      // Nor does a site's display ride on the wallet's own token.
      const own = await mint('safe-send', 7, { tx: SAFE_TX, chainId: 100 });
      await expect(
        handlers['wallet:safe-send']({}, 7, SAFE_TX, { site: SITE }, 100, { confirmation: own })
      ).resolves.toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      expect(startSafeSend).not.toHaveBeenCalled();
      // The wallet's own SafeTx has no site, and still starts.
      await expect(
        handlers['wallet:safe-send']({}, 7, SAFE_TX, { recipientName: null }, 100, {
          confirmation: await mint('safe-send', 7, { tx: SAFE_TX, chainId: 100 }),
        })
      ).resolves.toMatchObject({ success: true });
      expect(startSafeSend).toHaveBeenLastCalledWith(expect.objectContaining({ display: { recipientName: null } }));
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

    // freedom-core design 0011, PRQ-5a: main opens a page's Safe message
    // session itself (page/page-signing.js). The chrome gets no token for
    // one.
    test('the chrome gets no safe-message token', async () => {
      const request = { method: 'personal_sign', params: ['0xdead', '0xsafe'] };
      const minted = await handlers['wallet:confirm-signing']({}, 'safe-message', 7, request);
      expect(minted).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      expect(minted.token).toBeUndefined();
      expect(outstanding()).toBe(0);
    });
  });

  // x402:approve (x402/ipc.js) spends these; it signs with the active
  // account, so that is the account the confirmation binds.
  const X402_PAYMENT = {
    webContentsId: 42,
    detectionId: 'req-9100',
    url: 'https://api.example/article',
    acceptIndex: 0,
    accept: {
      scheme: 'exact',
      network: 'eip155:8453',
      amount: '10000',
      asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
    },
    grant: null,
  };
  // The card that mints it is the sidebar of the window hosting the tab.
  const mintX402 = async (index, payload = X402_PAYMENT, event = AUTO) => {
    const result = await handlers['wallet:confirm-signing'](event, 'x402-payment', index, payload);
    expect(result.success).toBe(true);
    return result.token;
  };

  test('an x402-payment confirmation binds the active account, whatever index the renderer names', async () => {
    const feeCheck = require('./fee-check');
    feeCheck.checkAtApproval.mockClear();
    guest(42, 'https://api.example/article');
    getActiveWalletIndex.mockReturnValue(4);
    const token = await mintX402(9);
    expect(feeCheck.checkAtApproval).not.toHaveBeenCalled();
    let refused;
    try {
      confirmations.consumeConfirmation(token, 'x402-payment', 9, X402_PAYMENT);
    } catch (err) {
      refused = err;
    }
    expect(refused?.code).toBe('SIGNING_NOT_CONFIRMED');

    const again = await mintX402(9);
    expect(() => confirmations.consumeConfirmation(again, 'x402-payment', 4, X402_PAYMENT)).not.toThrow();
  });

  test("an x402-payment confirmation is minted only by the window hosting the payment's tab", async () => {
    const refusal = { success: false, error: 'This payment is not on a tab of this window' };
    // Another window's tab.
    guest(42, 'https://api.example/article', { host: { id: 2 } });
    expect(await handlers['wallet:confirm-signing'](AUTO, 'x402-payment', 0, X402_PAYMENT)).toEqual(refusal);
    // A tab that is closing, and one that is gone.
    guest(42, 'https://api.example/article', { destroyed: true });
    expect(await handlers['wallet:confirm-signing'](AUTO, 'x402-payment', 0, X402_PAYMENT)).toEqual(refusal);
    guests.delete(42);
    expect(await handlers['wallet:confirm-signing'](AUTO, 'x402-payment', 0, X402_PAYMENT)).toEqual(refusal);
    // No tab named, or a sender that names no window.
    guest(42, 'https://api.example/article');
    expect(await handlers['wallet:confirm-signing'](AUTO, 'x402-payment', 0, { ...X402_PAYMENT, webContentsId: undefined }))
      .toEqual(refusal);
    expect(await handlers['wallet:confirm-signing']({}, 'x402-payment', 0, X402_PAYMENT)).toEqual(refusal);
    expect(outstanding()).toBe(0);

    // The hosting window's sidebar gets its token.
    const token = await mintX402(0);
    expect(() => confirmations.consumeConfirmation(token, 'x402-payment', 0, X402_PAYMENT)).not.toThrow();
  });

  test('an x402 cap edit is confirmed for the window that asks, and the cap main holds', async () => {
    const edit = { origin: 'https://pay.example', chainId: 8453, asset: '0xabc', capAmount: '20000000' };
    const held = (windowId) => ({ ...edit, window: windowId, windowSeconds: undefined, current: mockCapHeld.current });
    // What the renderer says about the window or the cap is not used.
    const result = await handlers['wallet:confirm-signing'](
      AUTO, 'x402-cap-update', null, { ...edit, window: 9, current: { capAmount: '1', createdAt: 1, expiresAt: 2, generation: 1 } });
    expect(result.success).toBe(true);
    expect(() => confirmations.consumeConfirmation(result.token, 'x402-cap-update', null, held(9)))
      .toThrow(/differs/);

    const again = await handlers['wallet:confirm-signing'](AUTO, 'x402-cap-update', null, edit);
    expect(() => confirmations.consumeConfirmation(again.token, 'x402-cap-update', null, held(CHROME.id)))
      .not.toThrow();

    // A sender that is no window, or a cap main doesn't hold: no token.
    expect(await handlers['wallet:confirm-signing']({}, 'x402-cap-update', null, edit))
      .toMatchObject({ success: false, error: expect.stringMatching(/window/) });
    const saved = mockCapHeld.current;
    mockCapHeld.current = null;
    try {
      expect(await handlers['wallet:confirm-signing'](AUTO, 'x402-cap-update', null, edit))
        .toMatchObject({ success: false, error: expect.stringMatching(/No such auto-pay cap/) });
    } finally {
      mockCapHeld.current = saved;
    }
  });

  // freedom-core design 0011, APS-5: with the approvals document on, the
  // chrome mints no x402 token on its own word either.
  describe('x402\'s kinds, with the approvals document on', () => {
    const MAIN_ACCEPT = { ...X402_PAYMENT.accept, amount: '25000' };
    let asked;
    let answer;
    beforeEach(() => {
      asked = [];
      answer = { approved: true };
      mockWalletApprovals = {
        confirm: jest.fn(async (request, onApproved) => {
          asked.push(request);
          if (!answer.approved) return answer;
          return { ...(await onApproved()), approved: true };
        }),
      };
      // Main's record: its own entry at the index, whatever the chrome sent.
      mockX402Record.build = (_sender, payload) => ({ ...X402_PAYMENT, accept: MAIN_ACCEPT, grant: payload.grant ?? null });
      guest(42, 'https://api.example/article');
      getActiveWalletIndex.mockReturnValue(0);
    });
    afterEach(() => {
      mockWalletApprovals = null;
      mockX402Record.build = null;
    });

    test('a payment asks the panel with main\'s record, and only its approval mints', async () => {
      const chrome = { ...X402_PAYMENT, accept: { ...X402_PAYMENT.accept, amount: '1' } };
      const result = await handlers['wallet:confirm-signing'](AUTO, 'x402-payment', 9, chrome);
      expect(result).toMatchObject({ success: true, token: expect.any(String) });
      expect(asked).toEqual([
        { sender: CHROME, kind: 'x402-payment', index: 0, payload: { ...X402_PAYMENT, accept: MAIN_ACCEPT }, feeChecked: false },
      ]);
      // The token binds main's entry, which x402:approve rebuilds; not the chrome's.
      expect(() => confirmations.consumeConfirmation(result.token, 'x402-payment', 0, chrome)).toThrow(/differs/);
      const again = await handlers['wallet:confirm-signing'](AUTO, 'x402-payment', 0, chrome);
      expect(() => confirmations.consumeConfirmation(again.token, 'x402-payment', 0, { ...X402_PAYMENT, accept: MAIN_ACCEPT }))
        .not.toThrow();

      // Rejected in the panel: no token.
      answer = { approved: false, error: 'User rejected the request', code: 'USER_REJECTED' };
      const tokensBefore = outstanding();
      expect(await handlers['wallet:confirm-signing'](AUTO, 'x402-payment', 0, X402_PAYMENT)).toEqual({
        success: false,
        error: 'User rejected the request',
        code: 'USER_REJECTED',
      });
      expect(outstanding()).toBe(tokensBefore);
    });

    test('a payment main can\'t find as asked, or on another window\'s tab, asks nothing', async () => {
      mockX402Record.build = () => {
        throw new Error('Approval is stale — the detection has been superseded');
      };
      expect(await handlers['wallet:confirm-signing'](AUTO, 'x402-payment', 0, X402_PAYMENT)).toEqual({
        success: false,
        error: 'Approval is stale — the detection has been superseded',
      });
      guest(42, 'https://api.example/article', { host: { id: 2 } });
      expect(await handlers['wallet:confirm-signing'](AUTO, 'x402-payment', 0, X402_PAYMENT)).toMatchObject({ success: false });
      expect(asked).toEqual([]);
      expect(outstanding()).toBe(0);
    });

    test('a cap\'s edit asks the panel with the cap main holds, and only its approval mints', async () => {
      const edit = { origin: 'https://pay.example', chainId: 8453, asset: '0xabc', capAmount: '20000000' };
      const held = { ...edit, window: CHROME.id, windowSeconds: undefined, current: mockCapHeld.current };
      const result = await handlers['wallet:confirm-signing'](AUTO, 'x402-cap-update', null, edit);
      expect(result).toMatchObject({ success: true, token: expect.any(String) });
      expect(asked).toEqual([{ sender: CHROME, kind: 'x402-cap-update', index: null, payload: held, feeChecked: false }]);
      expect(() => confirmations.consumeConfirmation(result.token, 'x402-cap-update', null, held)).not.toThrow();

      answer = { approved: false, error: 'User rejected the request', code: 'USER_REJECTED' };
      expect(await handlers['wallet:confirm-signing'](AUTO, 'x402-cap-update', null, edit)).toMatchObject({ success: false, code: 'USER_REJECTED' });
      expect(outstanding()).toBe(0);

      // A cap main doesn't hold: refused before anyone is asked.
      const saved = mockCapHeld.current;
      mockCapHeld.current = null;
      try {
        expect(await handlers['wallet:confirm-signing'](AUTO, 'x402-cap-update', null, edit))
          .toMatchObject({ success: false, error: expect.stringMatching(/No such auto-pay cap/) });
      } finally {
        mockCapHeld.current = saved;
      }
      expect(asked).toHaveLength(2);
    });
  });

  test('wallet:confirm-signing refuses a malformed request', async () => {
    const result = await handlers['wallet:confirm-signing']({}, 'dapp-send', 2, { ...TX, gasLimit: 'x' });
    expect(result).toMatchObject({ success: false });
    expect(result.token).toBeUndefined();
  });
});
