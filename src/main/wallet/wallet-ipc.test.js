jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn() },
  webContents: { fromId: jest.fn(() => null) },
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
jest.mock('../ens-resolver', () => ({ resolveEnsContent: jest.fn() }));
jest.mock('./safe/safe-messages', () => ({
  startSafeMessage: jest.fn(async () => ({ token: 'session' })),
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
    test('Agent custody refuses automatic signing until the user explicitly takes control', async () => {
      const { setAgentPageCustody } = require('./agent-tab-custody');
      dappPermissions.getPermission.mockReturnValue({ walletIndex: 2 });
      dappPermissions.isTransactionAutoApproved.mockReturnValue(true);
      setAgentPageCustody(guests.get(12), true);
      const result = await handlers['wallet:dapp-send-transaction'](
        AUTO, TX, 2, { origin: SITE }, { autoApprove: SITE, webContentsId: 12 });
      expect(result).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      expect(signAndRecord).not.toHaveBeenCalled();
      setAgentPageCustody(guests.get(12), false);
      expect(await handlers['wallet:dapp-send-transaction'](
        AUTO, TX, 2, { origin: SITE }, { autoApprove: SITE, webContentsId: 12 })).toMatchObject({ success: true });
    });
    test('without a token: refused', async () => {
      const result = await handlers['wallet:dapp-send-transaction']({}, TX, 2, { origin: SITE });
      expect(result).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      expect(signAndRecord).not.toHaveBeenCalled();
    });

    test('a token for another account is refused', async () => {
      const confirmation = await mint('dapp-send', 2, TX);
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
      const confirmation = await mint('dapp-send', 2, TX);
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
    dappPermissions.getPermission.mockReturnValue({ walletIndex: 0 });
    dappPermissions.isTransactionAutoApproved.mockReturnValue(true);
    dappPermissions.getSigningAutoApprove.mockReturnValue(true);
    const autoSend = () => handlers['wallet:dapp-send-transaction'](
      AUTO, TX, 0, { origin: SITE }, { autoApprove: SITE, webContentsId: 12 });
    const autoSign = () => handlers['wallet:sign-message'](
      AUTO, '0x68656c6c6f', 0, { autoApprove: SITE, webContentsId: 12 });

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
      expect(await autoSend()).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      expect(await autoSign()).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      expect(signAndRecord).not.toHaveBeenCalled();
      expect(signer.signMessage).not.toHaveBeenCalled();

      // Ending the turn does not hand the tab back; only the user does.
      finishTurn();
      await service.waitForIdle();
      expect(await autoSend()).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      await expect(service.claimTab('tab_user')).resolves.toBe(true);
      expect(isAgentPage(page)).toBe(false);
      expect(await autoSend()).toMatchObject({ success: true });
      expect(await autoSign()).toMatchObject({ success: true });
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
