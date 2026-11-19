'use strict';

const { AgentWalletController } = require('./agent-wallet-controller');
const { ERROR_CODES } = require('../automation/contract/errors');

function createHarness(options = {}) {
  const permission = options.permission ?? null;
  const wallets = options.wallets || [
    {
      index: 0,
      name: 'Main Wallet',
      address: '0x1111111111111111111111111111111111111111',
      type: 'mnemonic',
    },
  ];
  const signer = {
    signMessage: jest.fn(async () => '0xsignature'),
    signTypedData: jest.fn(async () => '0xtyped'),
  };
  const dependencies = {
    identityManager: {
      getDerivedWallets: jest.fn(async () => wallets),
      getActiveWalletIndex: jest.fn(() => 0),
    },
    getPermission: jest.fn(() => permission),
    grantPermission: jest.fn(),
    updateLastUsed: jest.fn(),
    updateWalletIndex: jest.fn(),
    getChain: jest.fn(() => ({
      chainId: 100,
      name: 'Gnosis',
      nativeCurrency: { symbol: 'xDAI', decimals: 18 },
    })),
    estimateGas: jest.fn(async () => ({ gasLimit: '24000' })),
    getGasPrices: jest.fn(async () => ({ type: 'legacy', gasPrice: '1000000000' })),
    signAndRecord: jest.fn(async () => ({
      hash: '0xtransaction',
      paymentId: 'payment_test',
      recorded: true,
    })),
    getSigner: jest.fn(() => signer),
    getTokens: jest.fn(() => ({
      '100:native': {
        chainId: 100,
        address: null,
        symbol: 'xDAI',
        name: 'xDAI',
        decimals: 18,
      },
      '100:0x9c58bacc331c9aa871afd802db6379a98e80cedb': {
        chainId: 100,
        address: '0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb',
        symbol: 'GNO',
        name: 'Gnosis',
        decimals: 18,
      },
    })),
    getAllBalances: jest.fn(async () => ({
      '100:native': { raw: '1000000000000000000', formatted: '1.0', decimals: 18 },
      '100:0x9c58bacc331c9aa871afd802db6379a98e80cedb': {
        raw: '5000000000000000000',
        formatted: '5.0',
        decimals: 18,
      },
    })),
    clearBalanceCache: jest.fn(),
    resolveEnsAddress: jest.fn(async (name) => ({
      success: true,
      name,
      address: '0x3333333333333333333333333333333333333333',
      trust: { level: 'verified' },
    })),
    buildErc20TransferData: jest.fn(() => '0xa9059cbbencoded'),
    parseAmount: jest.fn((amount, decimals) => {
      const [whole, fraction = ''] = amount.split('.');
      return BigInt(`${whole}${fraction.padEnd(decimals, '0')}`);
    }),
  };
  return {
    controller: new AgentWalletController(dependencies),
    dependencies,
    signer,
  };
}

const ADDRESS = '0x1111111111111111111111111111111111111111';

describe('AgentWalletController', () => {
  describe('direct transfers', () => {
    test('holds one resolved ERC-20 transfer for approval and broadcasts that exact intent', async () => {
      const harness = createHarness();
      const approval = jest.fn(async () => 'approved');

      const result = await harness.controller.transfer(
        { recipient: 'meinhard.eth', amount: '0.01', asset: 'gno', chainId: 100 },
        { requestApproval: approval }
      );

      expect(harness.dependencies.resolveEnsAddress).toHaveBeenCalledWith('meinhard.eth');
      expect(approval).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'wallet_transfer',
          operation: 'wallet_transfer',
          wallet: expect.objectContaining({
            kind: 'transfer',
            chainId: 100,
            to: expect.stringContaining('meinhard.eth'),
            recipientVerification: 'Verified name resolution',
            value: '0.01 GNO',
            tokenContract: '0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb',
            requiresUnlock: true,
          }),
        })
      );
      expect(harness.dependencies.signAndRecord).toHaveBeenCalledWith(
        {
          to: '0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb',
          value: '0',
          data: '0xa9059cbbencoded',
          gasLimit: '24000',
          gasPrice: '1000000000',
          chainId: 100,
        },
        harness.signer,
        expect.objectContaining({
          kind: expect.any(String),
          origin: 'freedom-agent',
          asset: '0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb',
          amount: '10000000000000000',
          toAddress: '0x3333333333333333333333333333333333333333',
        })
      );
      expect(result).toEqual({
        wallet: {
          action: 'broadcast',
          chainId: 100,
          transactionHash: '0xtransaction',
          paymentId: 'payment_test',
          recipient: '0x3333333333333333333333333333333333333333',
          amount: '0.01',
          asset: 'GNO',
        },
      });
    });

    test('fails closed before approval when an asset is ambiguous without a chain', async () => {
      const harness = createHarness();
      harness.dependencies.getTokens.mockReturnValue({
        '1:native': { chainId: 1, address: null, symbol: 'ETH', decimals: 18 },
        '8453:native': { chainId: 8453, address: null, symbol: 'ETH', decimals: 18 },
      });
      const approval = jest.fn();

      await expect(
        harness.controller.transfer(
          {
            recipient: '0x3333333333333333333333333333333333333333',
            amount: '1',
            asset: 'ETH',
          },
          { requestApproval: approval }
        )
      ).rejects.toMatchObject({
        code: ERROR_CODES.INVALID_ARGUMENT,
        retryable: false,
        suggestedAction: expect.stringContaining('chainId'),
      });
      expect(approval).not.toHaveBeenCalled();
      expect(harness.dependencies.signAndRecord).not.toHaveBeenCalled();
    });

    test('does not sign when the user declines the exact transfer', async () => {
      const harness = createHarness();

      await expect(
        harness.controller.transfer(
          {
            recipient: '0x3333333333333333333333333333333333333333',
            amount: '0.5',
            asset: 'xDAI',
            chainId: 100,
          },
          { requestApproval: jest.fn(async () => 'declined') }
        )
      ).rejects.toMatchObject({ code: ERROR_CODES.WALLET_REQUEST_CANCELLED_BY_USER });
      expect(harness.dependencies.signAndRecord).not.toHaveBeenCalled();
    });

    test('sends a native transfer with the approved amount and fee fields', async () => {
      const harness = createHarness();

      const result = await harness.controller.transfer(
        {
          recipient: '0x3333333333333333333333333333333333333333',
          amount: '0.25',
          asset: 'xDAI',
          chainId: 100,
        },
        { requestApproval: jest.fn(async () => 'approved') }
      );

      expect(harness.dependencies.buildErc20TransferData).not.toHaveBeenCalled();
      expect(harness.dependencies.signAndRecord).toHaveBeenCalledWith(
        {
          to: '0x3333333333333333333333333333333333333333',
          value: '250000000000000000',
          chainId: 100,
          gasLimit: '24000',
          gasPrice: '1000000000',
        },
        harness.signer,
        expect.objectContaining({
          asset: null,
          amount: '250000000000000000',
          toAddress: '0x3333333333333333333333333333333333333333',
        })
      );
      expect(harness.dependencies.getAllBalances).toHaveBeenCalledTimes(2);
      expect(result.wallet).toMatchObject({ amount: '0.25', asset: 'xDAI' });
    });

    test('checks native value plus maximum fee before asking', async () => {
      const harness = createHarness();
      harness.dependencies.getAllBalances.mockResolvedValue({
        '100:native': { raw: '1000000000000000000', formatted: '1.0', decimals: 18 },
      });
      const approval = jest.fn();

      await expect(
        harness.controller.transfer(
          {
            recipient: '0x3333333333333333333333333333333333333333',
            amount: '1',
            asset: 'xDAI',
            chainId: 100,
          },
          { requestApproval: approval }
        )
      ).rejects.toMatchObject({ code: ERROR_CODES.CAPABILITY_UNAVAILABLE });
      expect(approval).not.toHaveBeenCalled();
      expect(harness.dependencies.signAndRecord).not.toHaveBeenCalled();
    });
  });

  // freedom-core design 0011, PRQ-5b: main attests a page's send and passes
  // its key, and the checks its effect waits on. A connect or a signature
  // in a tab the Agent holds goes to the identity core since APB-5a, whose
  // prompt the Agent's sheet answers (`answerPrompt`, below).
});

describe('answerPrompt: the Agent\'s sheet on the identity core\'s prompt', () => {
  const LEDGER_ADDRESS = '0x2222222222222222222222222222222222222222';
  const SAFE_ADDRESS = '0x3333333333333333333333333333333333333333';
  const VAULT = Object.freeze({ index: 0, name: 'Main Wallet', address: ADDRESS, type: 'mnemonic' });
  const LEDGER = Object.freeze({ index: 1, name: 'Ledger', address: LEDGER_ADDRESS, type: 'ledger' });
  const SAFE = Object.freeze({ index: 1000, name: 'Team Safe', address: SAFE_ADDRESS, type: 'safe' });
  const CHAIN = Object.freeze({ id: 100, name: 'Gnosis Chain' });
  const TYPED = Object.freeze({
    types: { EIP712Domain: [{ name: 'chainId', type: 'uint256' }], Order: [{ name: 'amount', type: 'uint256' }] },
    domain: { chainId: 100 },
    primaryType: 'Order',
    message: { amount: '1' },
  });
  const TYPED_HASH = `0x${'5a'.repeat(32)}`;

  // The run's context and main's attestation (`freedom-agent-service.js`).
  function sheetContext(requestApproval = jest.fn(async () => 'approved'), extra = {}) {
    return {
      tabId: 'tab_test',
      pageUrl: 'https://app.example/swap',
      conversationId: 'conversation_test',
      requestApproval,
      attested: { key: 'https://app.example', transportKey: 'https://app.example' },
      ...extra,
    };
  }

  // Main's prompt for the core's eth.connect: the core's view, in main's form.
  function connectPrompt(view = {}) {
    return {
      kind: 'eth.connect',
      method: 'eth_requestAccounts',
      params: [],
      chainId: 100,
      view: { accounts: [VAULT, LEDGER], defaultIndex: 0, chain: CHAIN, ...view },
    };
  }

  // Main's prompt for the core's eth.sign, `view` as `signShown` gives it.
  function signPrompt(method, { account = VAULT, params, hex = '0x68656c6c6f', rawHash = false, typed = {} } = {}) {
    const view = { method, account, chain: CHAIN, alwaysAllow: account.type === 'mnemonic' };
    if (method === 'personal_sign') {
      view.message = { hex, rawHash };
    } else {
      view.typedData = {
        hash: TYPED_HASH,
        view: { domain: TYPED.domain, primary_type: 'Order', message: TYPED.message },
        warnings: [],
        ...typed,
      };
      view.chains = {};
    }
    const defaults = method === 'personal_sign' ? [hex, account.address] : [account.address, JSON.stringify(TYPED)];
    return { kind: 'eth.sign', method, params: params ?? defaults, chainId: 100, view };
  }

  const RECIPIENT = '0x4444444444444444444444444444444444444444';
  // Main's prompt for the core's eth.send, `view` as `sendShown` gives it:
  // the core's prepared transaction, its quote and its fee check.
  function sendPrompt({ account = VAULT, params, view = {} } = {}) {
    return {
      kind: 'eth.send',
      method: 'eth_sendTransaction',
      params: params ?? [{ from: account.address, to: RECIPIENT, value: '0x2386f26fc10000' }],
      chainId: 100,
      view: {
        account,
        chain: { ...CHAIN, symbol: 'xDAI' },
        tx: { to: RECIPIENT, value: '10000000000000000', data: '0x' },
        fee: { gasLimit: '21000', maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000', estimate: '21000000000000' },
        feeCheck: { maxCost: '42000000000000', comparable: true, ratio: '1', above: false, oneEndpoint: false, basis: 'base-fee', autoApprove: true },
        feeAskAgain: false,
        alwaysAllow: false,
        ...view,
      },
    };
  }

  // An answer that asked nothing of the sheet, nor of main's own stores.
  function expectNothingAsked(harness, approval) {
    expect(approval).not.toHaveBeenCalled();
    expect(harness.dependencies.identityManager.getDerivedWallets).not.toHaveBeenCalled();
    expect(harness.dependencies.getPermission).not.toHaveBeenCalled();
    expect(harness.dependencies.getSigner).not.toHaveBeenCalled();
    expect(harness.dependencies.estimateGas).not.toHaveBeenCalled();
    expect(harness.dependencies.signAndRecord).not.toHaveBeenCalled();
  }

  describe('a connect', () => {
    test('the sheet shows the core\'s accounts and chain, defaulting to its default, and its pick is the decision', async () => {
      const harness = createHarness();
      const approval = jest.fn(async () => ({ status: 'approved', walletIndex: 1 }));
      const outcome = await harness.controller.answerPrompt(sheetContext(approval), connectPrompt({ defaultIndex: 1 }));
      expect(outcome).toEqual({ handled: true, decision: { approve: true, walletIndex: 1 }, receiptOf: expect.any(Function) });
      expect(approval).toHaveBeenCalledTimes(1);
      expect(approval).toHaveBeenCalledWith({
        operation: 'browser_wallet_action',
        tabId: 'tab_test',
        origin: 'https://app.example',
        destinationOrigin: 'https://app.example',
        action: 'wallet_connection',
        label: 'Connect a wallet account',
        wallet: {
          kind: 'connection',
          chainId: 100,
          chainName: 'Gnosis Chain',
          wallets: [VAULT, LEDGER],
          defaultWalletIndex: 1,
          requiresUnlock: false,
        },
      });
      // The view is the core's: main's own wallet list and grants are never read.
      expect(harness.dependencies.identityManager.getDerivedWallets).not.toHaveBeenCalled();
      expect(harness.dependencies.getPermission).not.toHaveBeenCalled();
      expect(harness.dependencies.grantPermission).not.toHaveBeenCalled();
    });

    test('an approve with no pick takes the sheet\'s default; a default the core didn\'t offer falls back to the first account offered', async () => {
      const harness = createHarness();
      const plain = jest.fn(async () => 'approved');
      await expect(harness.controller.answerPrompt(sheetContext(plain), connectPrompt({ defaultIndex: 1 }))).resolves.toMatchObject({
        decision: { approve: true, walletIndex: 1 },
      });
      const offTheList = jest.fn(async () => true);
      await expect(
        harness.controller.answerPrompt(sheetContext(offTheList), connectPrompt({ defaultIndex: 7 }))
      ).resolves.toMatchObject({ decision: { approve: true, walletIndex: 0 } });
      expect(offTheList.mock.calls[0][0].wallet.defaultWalletIndex).toBe(0);
      const none = jest.fn(async () => 'approved');
      await expect(harness.controller.answerPrompt(sheetContext(none), connectPrompt({ defaultIndex: null }))).resolves.toMatchObject({
        decision: { approve: true, walletIndex: 0 },
      });
    });

    test('a DNS name over IPNS: the sheet shows the name main attested, not the page\'s transport', async () => {
      const harness = createHarness();
      const IPNS = 'ipns://k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8';
      const approval = jest.fn(async () => 'approved');
      const context = sheetContext(approval, { pageUrl: `${IPNS}/docs`, attested: { key: 'example.com', transportKey: IPNS } });
      const outcome = await harness.controller.answerPrompt(context, connectPrompt());
      expect(outcome.decision).toEqual({ approve: true, walletIndex: 0 });
      expect(approval.mock.calls[0][0]).toMatchObject({ origin: 'example.com', destinationOrigin: 'example.com' });
      expect(outcome.receiptOf({ result: [ADDRESS] })).toEqual({
        wallet: { action: 'connected', origin: 'example.com', chainId: 100, account: ADDRESS },
      });
    });

    test('the Agent\'s receipt names the account the page got, and nothing for an answer without one', async () => {
      const harness = createHarness();
      const { receiptOf } = await harness.controller.answerPrompt(sheetContext(), connectPrompt());
      expect(receiptOf({ result: [LEDGER_ADDRESS] })).toEqual({
        wallet: { action: 'connected', origin: 'https://app.example', chainId: 100, account: LEDGER_ADDRESS },
      });
      expect(receiptOf({ error: { code: 4001, message: 'User rejected the request' } })).toBeNull();
      expect(receiptOf({ result: [] })).toBeNull();
      expect(receiptOf(null)).toBeNull();
    });

    test('no account in the core\'s view: refused without the sheet', async () => {
      const harness = createHarness();
      const approval = jest.fn(async () => 'approved');
      for (const accounts of [[], [{ index: -1, address: ADDRESS }], [{ index: 0 }], 'not a list']) {
        await expect(harness.controller.answerPrompt(sheetContext(approval), connectPrompt({ accounts }))).resolves.toEqual({
          handled: true,
          error: { code: -32603, message: 'No wallet account is available' },
          errorCode: ERROR_CODES.CAPABILITY_UNAVAILABLE,
        });
      }
      expectNothingAsked(harness, approval);
    });
  });

  describe('a signature', () => {
    test('personal_sign: the sheet shows the core\'s message as text where its bytes are UTF-8, on the core\'s account and chain', async () => {
      const harness = createHarness();
      const approval = jest.fn(async () => 'approved');
      const outcome = await harness.controller.answerPrompt(sheetContext(approval), signPrompt('personal_sign'));
      expect(outcome).toEqual({ handled: true, decision: { approve: true }, receiptOf: expect.any(Function) });
      expect(approval).toHaveBeenCalledWith({
        operation: 'browser_wallet_action',
        tabId: 'tab_test',
        origin: 'https://app.example',
        destinationOrigin: 'https://app.example',
        action: 'wallet_signature',
        label: 'Sign a message',
        wallet: {
          kind: 'signature',
          chainId: 100,
          chainName: 'Gnosis Chain',
          account: VAULT,
          signatureType: 'Personal message',
          summary: 'hello',
          requiresUnlock: true,
        },
      });
      expect(harness.dependencies.getSigner).not.toHaveBeenCalled();
      expect(harness.signer.signMessage).not.toHaveBeenCalled();
    });

    test('personal_sign: bytes that are not UTF-8 show as hex, and a raw 32-byte value carries its warning', async () => {
      const harness = createHarness();
      const summaryOf = async (prompt) => {
        const approval = jest.fn(async () => 'approved');
        await harness.controller.answerPrompt(sheetContext(approval), prompt);
        return approval.mock.calls[0][0].wallet.summary;
      };
      expect(await summaryOf(signPrompt('personal_sign', { hex: '0xff00fe' }))).toBe('0xff00fe');
      const raw = `0x${'68'.repeat(32)}`;
      expect(await summaryOf(signPrompt('personal_sign', { hex: raw, rawHash: true }))).toBe(
        `${raw}\n\nWarning: this signs a raw 32-byte value. It can authorize things this screen can't show.`
      );
    });

    test('the sheet shows the core\'s view, not the page\'s params', async () => {
      const harness = createHarness();
      const approval = jest.fn(async () => 'approved');
      // The page's params ask for "hello"; the core's view, which its token
      // binds, says "core": the sheet shows the core's.
      const prompt = signPrompt('personal_sign', { hex: '0x636f7265', params: ['0x68656c6c6f', ADDRESS] });
      await harness.controller.answerPrompt(sheetContext(approval), prompt);
      expect(approval.mock.calls[0][0].wallet.summary).toBe('core');
    });

    test('eth_signTypedData_v4: the sheet shows the core\'s domain, message and hash, the fields not signed and the core\'s warnings', async () => {
      const harness = createHarness();
      const approval = jest.fn(async () => 'approved');
      const prompt = signPrompt('eth_signTypedData_v4', {
        account: LEDGER,
        typed: {
          view: { domain: { chainId: 100, name: 'Fixture' }, primary_type: 'Order', message: { amount: '1' }, ignored: ['extra'] },
          warnings: ['named-type', 'chain-absent', 'not-a-warning-main-knows'],
        },
      });
      const outcome = await harness.controller.answerPrompt(sheetContext(approval), prompt);
      expect(outcome.decision).toEqual({ approve: true });
      const shown = approval.mock.calls[0][0];
      expect(shown).toMatchObject({
        action: 'wallet_signature',
        label: 'Sign typed data',
        wallet: { kind: 'signature', account: LEDGER, signatureType: 'EIP-712 typed data', requiresUnlock: false },
      });
      expect(shown.wallet.summary).toBe(
        [
          `Domain: ${JSON.stringify({ chainId: 100, name: 'Fixture' }, null, 2)}`,
          `Order: ${JSON.stringify({ amount: '1' }, null, 2)}`,
          `Hash: ${TYPED_HASH}`,
          'Not signed, though the site sent it: extra',
          'Warning: The site named a different type of data than the one shown here. This shows what is signed, but another wallet could sign something different for this request.',
          'Warning: This data names no chain. The signature is valid on every chain where the contract it is for exists.',
        ].join('\n')
      );
      expect(harness.signer.signTypedData).not.toHaveBeenCalled();
    });

    test('a sheet that gives an account for a signature approves the signature only', async () => {
      const harness = createHarness();
      const approval = jest.fn(async () => ({ status: 'approved', walletIndex: 1 }));
      await expect(harness.controller.answerPrompt(sheetContext(approval), signPrompt('personal_sign'))).resolves.toMatchObject({
        decision: { approve: true },
      });
      const outcome = await harness.controller.answerPrompt(sheetContext(approval), signPrompt('personal_sign'));
      expect(outcome.decision).not.toHaveProperty('walletIndex');
    });

    test.each(['personal_sign', 'eth_signTypedData_v4'])(
      '%s: the Agent\'s receipt keeps the signature out, and is nothing for an answer without one',
      async (method) => {
        const harness = createHarness();
        const { receiptOf } = await harness.controller.answerPrompt(sheetContext(), signPrompt(method));
        const receipt = receiptOf({ result: '0xsignature' });
        expect(receipt).toEqual({ wallet: { action: 'signed', origin: 'https://app.example', chainId: 100, signatureType: method } });
        expect(JSON.stringify(receipt)).not.toContain('0xsignature');
        expect(receiptOf({ error: { code: 4001, message: 'User rejected the request' } })).toBeNull();
        expect(receiptOf(undefined)).toBeNull();
      }
    );
  });

  // The sheet's decision, as main relays it to the core (`page-eip1193.js`).
  test.each([
    ['approved', 'approved', { approve: true }],
    ['true', true, { approve: true }],
    ['an approved status', { status: 'approved' }, { approve: true }],
    ['declined', 'declined', { approve: false }],
    ['a declined status', { status: 'declined' }, { approve: false }],
    ['nothing', undefined, { approve: false }],
    ['withdrawn', 'withdrawn', { closed: true }],
    ['a withdrawn status', { status: 'withdrawn' }, { closed: true }],
  ])('the sheet answering %s is the decision %j', async (_label, answer, decision) => {
    const harness = createHarness();
    for (const prompt of [signPrompt('personal_sign'), signPrompt('eth_signTypedData_v4'), connectPrompt()]) {
      const outcome = await harness.controller.answerPrompt(sheetContext(jest.fn(async () => answer)), prompt);
      const expected = decision.approve && prompt.kind === 'eth.connect' ? { ...decision, walletIndex: 0 } : decision;
      expect({ kind: prompt.kind, decision: outcome.decision }).toEqual({ kind: prompt.kind, decision: expected });
    }
  });

  // A7-3: the agent's own refusals, each before the sheet is asked.
  describe('a send (APB-5b)', () => {
    test("the sheet shows the core's quote on the core's account and chain, and its approve is the decision", async () => {
      const harness = createHarness();
      const approval = jest.fn(async () => 'approved');
      const outcome = await harness.controller.answerPrompt(sheetContext(approval), sendPrompt());
      expect(approval).toHaveBeenCalledWith({
        operation: 'browser_wallet_action',
        tabId: 'tab_test',
        origin: 'https://app.example',
        destinationOrigin: 'https://app.example',
        action: 'wallet_transaction',
        label: 'Send a wallet transaction',
        wallet: {
          kind: 'transaction',
          chainId: 100,
          chainName: 'Gnosis Chain',
          account: VAULT,
          to: RECIPIENT,
          value: '0.01 xDAI',
          // The core's gas limit times its fee cap: 21,000 × 2 gwei.
          maxFee: '0.000042 xDAI',
          data: '',
          requiresUnlock: true,
        },
      });
      expect(outcome).toMatchObject({ handled: true, decision: { approve: true } });
      // Main estimates, prices and signs nothing: the core quoted it, and
      // mints and hands main the send on the approve.
      expectNothingAsked(harness, jest.fn());
      expect(outcome.receiptOf({ result: `0x${'ab'.repeat(32)}` })).toEqual({
        wallet: { action: 'broadcast', origin: 'https://app.example', chainId: 100, transactionHash: `0x${'ab'.repeat(32)}` },
      });
      expect(outcome.receiptOf({ error: { code: 4001, message: 'User rejected the request' } })).toBeNull();
    });

    test("the sheet shows the core's view, not the page's params: its recipient, amount, data and fee", async () => {
      const harness = createHarness();
      const approval = jest.fn(async () => 'approved');
      const data = `0xa9059cbb${'00'.repeat(64)}`;
      await harness.controller.answerPrompt(
        sheetContext(approval),
        sendPrompt({
          params: [{ to: RECIPIENT, value: '0x1', data: '0x' }],
          view: {
            tx: { to: ADDRESS, value: '0', data },
            fee: { gasLimit: '60000', gasPrice: '3000000000', estimate: '1' },
          },
        })
      );
      expect(approval.mock.calls[0][0].wallet).toMatchObject({
        to: ADDRESS,
        value: '0.0 xDAI',
        maxFee: '0.00018 xDAI',
        data,
      });
    });

    test('a decline, or a sheet withdrawn, is the decision; a Ledger needs no unlock', async () => {
      const harness = createHarness();
      const declined = await harness.controller.answerPrompt(sheetContext(jest.fn(async () => 'declined')), sendPrompt());
      expect(declined.decision).toEqual({ approve: false });
      const withdrawn = await harness.controller.answerPrompt(sheetContext(jest.fn(async () => 'withdrawn')), sendPrompt());
      expect(withdrawn.decision).toEqual({ closed: true });
      const approval = jest.fn(async () => 'approved');
      const ledger = await harness.controller.answerPrompt(sheetContext(approval), sendPrompt({ account: LEDGER }));
      expect(ledger.decision).toEqual({ approve: true });
      expect(approval.mock.calls[0][0].wallet).toMatchObject({ account: LEDGER, requiresUnlock: false });
    });

    test.each([
      ['another `from`', { params: [{ from: LEDGER_ADDRESS, to: RECIPIENT }] }, 'Transaction sender does not match the connected wallet'],
      ['another `chainId`', { params: [{ to: RECIPIENT, chainId: '0x1' }] }, 'Transaction chain does not match the approved wallet network'],
      ['no `to`', { params: [{ value: '0x1' }] }, 'Transaction parameters are incomplete'],
      ['data over 65,536 characters', { params: [{ to: RECIPIENT, data: `0x${'00'.repeat(32_768)}` }] }, 'Use valid transaction data no larger than the approval display limit.'],
      ['no fee (a failed quote)', { view: { fee: null, feeCheck: null } }, 'Freedom could not determine the maximum transaction fee. Try again before approving.'],
      ['a zero fee', { view: { fee: { gasLimit: '21000', gasPrice: '0', estimate: '0' } } }, 'Freedom could not determine the maximum transaction fee. Try again before approving.'],
    ])("the agent's own refusal (A7-3): %s, without the sheet", async (_name, prompt, message) => {
      const harness = createHarness();
      const approval = jest.fn();
      const outcome = await harness.controller.answerPrompt(sheetContext(approval), sendPrompt(prompt));
      expect(outcome).toMatchObject({ handled: true, error: { code: -32603, message } });
      expectNothingAsked(harness, approval);
    });

    // A7-5: the sheet confirms no fee, so a fee the core's check stops is
    // never its to approve; the page gets today's text.
    test.each([
      ['above the threshold', { feeCheck: { comparable: true, ratio: '3.5', above: true } }],
      ['asked again at the approve', { feeCheck: { comparable: true, ratio: '3.5', above: true, askAgain: true }, feeAskAgain: true }],
    ])('a fee the check stops (A7-5): %s, refused without the sheet', async (_name, view) => {
      const harness = createHarness();
      const approval = jest.fn();
      const outcome = await harness.controller.answerPrompt(sheetContext(approval), sendPrompt({ view }));
      expect(outcome).toEqual({
        handled: true,
        error: { code: -32603, message: "The network fee is 3.5× today's network fee. Confirm it again to send." },
        errorCode: ERROR_CODES.POLICY_DENIED,
      });
      expectNothingAsked(harness, approval);
    });
  });

  describe('the agent\'s own refusals, without the sheet (A7-3)', () => {
    test('a request over 131,072 characters', async () => {
      const harness = createHarness();
      const approval = jest.fn(async () => 'approved');
      const long = `0x${'ab'.repeat(65_536)}`;
      for (const prompt of [
        signPrompt('personal_sign', { params: [long, ADDRESS] }),
        signPrompt('eth_signTypedData_v4', { params: [ADDRESS, long] }),
        { ...connectPrompt(), params: [long] },
      ]) {
        await expect(harness.controller.answerPrompt(sheetContext(approval), prompt)).resolves.toEqual({
          handled: true,
          error: { code: -32602, message: 'Wallet request is too large' },
          errorCode: ERROR_CODES.INVALID_ARGUMENT,
        });
      }
      // Params that can't be serialized at all are refused the same way.
      const cyclic = [];
      cyclic.push(cyclic);
      await expect(
        harness.controller.answerPrompt(sheetContext(approval), signPrompt('personal_sign', { params: cyclic }))
      ).resolves.toMatchObject({ handled: true, error: { code: -32602, message: 'Wallet request is too large' } });
      expectNothingAsked(harness, approval);
    });

    test('a page this run sees on another transport than main attested, or no key', async () => {
      const harness = createHarness();
      const approval = jest.fn(async () => 'approved');
      for (const attested of [
        { key: 'https://app.example', transportKey: 'https://other.example' },
        { key: 'https://app.example', transportKey: 'ipns://k51other' },
        { key: '', transportKey: 'https://app.example' },
        { transportKey: 'https://app.example' },
      ]) {
        for (const prompt of [connectPrompt(), signPrompt('personal_sign'), signPrompt('eth_signTypedData_v4')]) {
          await expect(harness.controller.answerPrompt(sheetContext(approval, { attested }), prompt)).resolves.toEqual({
            handled: true,
            error: { code: 4100, message: 'Wallet request origin did not match the page' },
            errorCode: ERROR_CODES.POLICY_DENIED,
          });
        }
      }
      // The run's page moved to another site since main attested it.
      await expect(
        harness.controller.answerPrompt(sheetContext(approval, { pageUrl: 'https://other.example/' }), connectPrompt())
      ).resolves.toMatchObject({ error: { code: 4100 } });
      expectNothingAsked(harness, approval);
    });

    test.each(['personal_sign', 'eth_signTypedData_v4'])('%s on a Safe\'s account', async (method) => {
      const harness = createHarness();
      const approval = jest.fn(async () => 'approved');
      await expect(harness.controller.answerPrompt(sheetContext(approval), signPrompt(method, { account: SAFE }))).resolves.toEqual({
        handled: true,
        error: {
          code: -32603,
          message: 'Agent signing and transfers are unavailable for this wallet type; use Freedom’s wallet controls',
        },
        errorCode: ERROR_CODES.CAPABILITY_UNAVAILABLE,
      });
      expectNothingAsked(harness, approval);
    });

    test.each(['personal_sign', 'eth_signTypedData_v4'])('%s on an account the core\'s view does not name', async (method) => {
      const harness = createHarness();
      const approval = jest.fn(async () => 'approved');
      const prompt = signPrompt(method);
      prompt.view.account = { index: -1, address: ADDRESS };
      await expect(harness.controller.answerPrompt(sheetContext(approval), prompt)).resolves.toEqual({
        handled: true,
        error: { code: -32603, message: 'The connected wallet is unavailable' },
        errorCode: ERROR_CODES.CAPABILITY_UNAVAILABLE,
      });
      expectNothingAsked(harness, approval);
    });

    test.each([
      ['personal_sign', ['0x68656c6c6f', LEDGER_ADDRESS]],
      ['eth_signTypedData_v4', [LEDGER_ADDRESS, JSON.stringify(TYPED)]],
    ])('%s claiming another address than the core\'s account', async (method, params) => {
      const harness = createHarness();
      const approval = jest.fn(async () => 'approved');
      await expect(harness.controller.answerPrompt(sheetContext(approval), signPrompt(method, { params }))).resolves.toEqual({
        handled: true,
        error: { code: -32603, message: 'Signature account does not match the connected wallet' },
        errorCode: ERROR_CODES.POLICY_DENIED,
      });
      expectNothingAsked(harness, approval);
    });

    test.each([
      ['an empty message', 'personal_sign', ['', ADDRESS]],
      ['a message over 65,536 characters', 'personal_sign', [`0x${'ab'.repeat(32_768)}`, ADDRESS]],
      ['no message', 'personal_sign', [undefined, ADDRESS]],
      ['typed data that is not JSON', 'eth_signTypedData_v4', [ADDRESS, '{not json']],
      ['typed data over 65,536 characters', 'eth_signTypedData_v4', [ADDRESS, JSON.stringify({ ...TYPED, message: { amount: '1'.repeat(65_536) } })]],
    ])('%s', async (_label, method, params) => {
      const harness = createHarness();
      const approval = jest.fn(async () => 'approved');
      await expect(harness.controller.answerPrompt(sheetContext(approval), signPrompt(method, { params }))).resolves.toEqual({
        handled: true,
        error: { code: -32603, message: 'The signature payload is invalid or too large to review safely' },
        errorCode: ERROR_CODES.INVALID_ARGUMENT,
      });
      expectNothingAsked(harness, approval);
    });

    test('typed data whose domain names another chain than the core\'s view', async () => {
      const harness = createHarness();
      const approval = jest.fn(async () => 'approved');
      for (const chainId of [1, '1', '0x1']) {
        const params = [ADDRESS, JSON.stringify({ ...TYPED, domain: { chainId } })];
        await expect(harness.controller.answerPrompt(sheetContext(approval), signPrompt('eth_signTypedData_v4', { params }))).resolves.toEqual({
          handled: true,
          error: { code: -32603, message: 'Typed-data chain does not match the approved wallet network' },
          errorCode: ERROR_CODES.POLICY_DENIED,
        });
      }
      expectNothingAsked(harness, approval);
      // The view's chain, in any form, or none named: the sheet is asked.
      for (const domain of [{ chainId: 100 }, { chainId: '0x64' }, {}]) {
        const params = [ADDRESS, { ...TYPED, domain }];
        await expect(
          harness.controller.answerPrompt(sheetContext(approval), signPrompt('eth_signTypedData_v4', { params }))
        ).resolves.toMatchObject({ handled: true, decision: { approve: true } });
      }
      expect(approval).toHaveBeenCalledTimes(3);
    });
  });

  test('not the sheet\'s: an unarmed run, a prompt it doesn\'t answer, or a view without a chain', async () => {
    const harness = createHarness();
    const approval = jest.fn(async () => 'approved');
    const unarmed = [
      null,
      { ...sheetContext(approval), tabId: undefined },
      { ...sheetContext(approval), pageUrl: undefined },
      { ...sheetContext(approval), requestApproval: undefined },
      { ...sheetContext(approval), attested: undefined },
    ];
    for (const context of unarmed) {
      await expect(harness.controller.answerPrompt(context, connectPrompt())).resolves.toEqual({ handled: false });
    }
    const vaultUnlock = { kind: 'vault.unlock', method: 'personal_sign', params: [], chainId: 100, view: { account: VAULT, reason: 'sign' } };
    const crossed = [
      null,
      vaultUnlock,
      { ...sendPrompt(), method: 'personal_sign' },
      { ...sendPrompt(), view: { ...sendPrompt().view, chain: { id: '100' } } },
      { ...connectPrompt(), method: 'personal_sign' },
      { ...signPrompt('personal_sign'), method: 'eth_requestAccounts' },
      { ...signPrompt('personal_sign'), method: 'eth_sign' },
      { ...connectPrompt(), view: undefined },
      { ...connectPrompt(), view: { ...connectPrompt().view, chain: {} } },
      { ...signPrompt('personal_sign'), view: { ...signPrompt('personal_sign').view, chain: { id: '100' } } },
    ];
    for (const prompt of crossed) {
      await expect(harness.controller.answerPrompt(sheetContext(approval), prompt)).resolves.toEqual({ handled: false });
    }
    expectNothingAsked(harness, approval);
  });
});

describe('unsupported Agent wallet signing', () => {
  const safe = { index: 1000, name: 'Team Safe', type: 'safe', address: '0x1111111111111111111111111111111111111111' };
  const sheet = (requestApproval) => ({
    tabId: 'tab_test',
    pageUrl: 'https://app.example/swap',
    requestApproval,
    attested: { key: 'https://app.example', transportKey: 'https://app.example' },
  });
  const signature = (method) => ({
    kind: 'eth.sign',
    method,
    params: method === 'personal_sign' ? ['0x68656c6c6f', safe.address] : [safe.address, '{}'],
    chainId: 100,
    view: {
      method,
      account: safe,
      chain: { id: 100, name: 'Gnosis Chain' },
      ...(method === 'personal_sign'
        ? { message: { hex: '0x68656c6c6f', rawHash: false } }
        : { typedData: { hash: `0x${'5a'.repeat(32)}`, view: {}, warnings: [] }, chains: {} }),
    },
  });

  // The core offers a deployed Safe to connect: the sheet shows it as a Safe.
  test('preserves Safe identity in connection approval', async () => {
    const { controller } = createHarness();
    const approve = jest.fn(async () => ({ status: 'approved', walletIndex: safe.index }));
    const outcome = await controller.answerPrompt(sheet(approve), {
      kind: 'eth.connect',
      method: 'eth_requestAccounts',
      params: [],
      chainId: 100,
      view: { accounts: [safe], defaultIndex: safe.index, chain: { id: 100, name: 'Gnosis Chain' } },
    });
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({
      wallet: expect.objectContaining({ wallets: [safe], defaultWalletIndex: safe.index }),
    }));
    expect(outcome.decision).toEqual({ approve: true, walletIndex: safe.index });
  });

  test.each(['personal_sign', 'eth_signTypedData_v4'])(
    'rejects Safe %s before the sheet or signer access', async (method) => {
      const { controller, dependencies } = createHarness({ wallets: [safe], permission: { walletIndex: safe.index } });
      const approve = jest.fn();
      const result = await controller.answerPrompt(sheet(approve), signature(method));
      expect(result).toMatchObject({ handled: true, error: { code: -32603, message: expect.stringContaining('unavailable for this wallet type') } });
      expect(approve).not.toHaveBeenCalled();
      expect(dependencies.getSigner).not.toHaveBeenCalled();
      expect(dependencies.signAndRecord).not.toHaveBeenCalled();
    }
  );

  test('rejects a Safe eth_sendTransaction before the sheet or signer access (A7-3)', async () => {
    const { controller, dependencies } = createHarness({ wallets: [safe], permission: { walletIndex: safe.index } });
    const approve = jest.fn();
    const result = await controller.answerPrompt(sheet(approve), {
      kind: 'eth.send',
      method: 'eth_sendTransaction',
      params: [{ to: safe.address }],
      chainId: 100,
      view: {
        account: safe,
        chain: { id: 100, name: 'Gnosis Chain', symbol: 'xDAI' },
        tx: { to: safe.address, value: '0', data: '0x' },
        fee: { paidBy: 'executor' },
        feeCheck: null,
        feeAskAgain: false,
        alwaysAllow: false,
      },
    });
    expect(result).toMatchObject({ handled: true, error: { code: -32603, message: expect.stringContaining('unavailable for this wallet type') } });
    expect(approve).not.toHaveBeenCalled();
    expect(dependencies.getSigner).not.toHaveBeenCalled();
    expect(dependencies.signAndRecord).not.toHaveBeenCalled();
  });

  test('rejects a direct Safe transfer before estimation or approval', async () => {
    const { controller, dependencies } = createHarness({ wallets: [safe] });
    const requestApproval = jest.fn();
    await expect(controller.transfer({
      walletIndex: safe.index, recipient: safe.address, asset: 'xdai', chainId: 100, amount: '0.01',
    }, { requestApproval })).rejects.toMatchObject({ code: ERROR_CODES.CAPABILITY_UNAVAILABLE });
    expect(requestApproval).not.toHaveBeenCalled();
    expect(dependencies.estimateGas).not.toHaveBeenCalled();
    expect(dependencies.getSigner).not.toHaveBeenCalled();
  });
});
