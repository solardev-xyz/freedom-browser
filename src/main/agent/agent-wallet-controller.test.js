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

function request(method, params = []) {
  return {
    method,
    params,
    displayUrl: 'https://app.example/swap',
    permissionKey: 'https://app.example',
    chainId: 100,
  };
}

function context(requestApproval = jest.fn(async () => 'approved')) {
  return {
    tabId: 'tab_test',
    pageUrl: 'https://app.example/swap',
    conversationId: 'conversation_test',
    requestApproval,
  };
}

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

  test('holds a connection request in Agent and grants only the selected public account', async () => {
    const harness = createHarness({
      wallets: [
        {
          index: 0,
          name: 'Main Wallet',
          address: '0x1111111111111111111111111111111111111111',
          type: 'mnemonic',
        },
        {
          index: 2,
          name: 'Ledger',
          address: '0x2222222222222222222222222222222222222222',
          type: 'ledger',
        },
      ],
    });
    const approval = jest.fn(async () => ({ status: 'approved', walletIndex: 2 }));
    const provider = await harness.controller.handleRequest(
      context(approval),
      request('eth_requestAccounts')
    );

    expect(provider.receipt).toEqual({
      wallet: {
        action: 'connected',
        origin: 'https://app.example',
        chainId: 100,
        account: '0x2222222222222222222222222222222222222222',
      },
    });
    expect(provider).toMatchObject({
      handled: true,
      result: ['0x2222222222222222222222222222222222222222'],
    });
    expect(approval).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'wallet_connection',
        wallet: expect.objectContaining({ kind: 'connection', requiresUnlock: false }),
      })
    );
    expect(harness.dependencies.grantPermission).toHaveBeenCalledWith(
      'https://app.example',
      2,
      100
    );
  });

  // freedom-core design 0011, PRQ-4: main attests a page's connect and
  // passes its key, and the checks the grant write waits on.
  describe('a connect main attested', () => {
    const IPNS = 'ipns://k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8';
    const attestedContext = (gate = {}, approval = jest.fn(async () => 'approved')) => ({
      ...context(approval),
      pageUrl: `${IPNS}/docs`,
      attested: { key: 'example.com', transportKey: IPNS },
      beforeEffect: gate.beforeEffect || jest.fn(async () => true),
      effectAllowed: gate.effectAllowed || jest.fn(() => true),
    });
    const attestedRequest = { method: 'eth_requestAccounts', params: [], chainId: 100 };

    test('acts under main\'s key, a DNS name over its IPNS page, once main\'s checks pass', async () => {
      const harness = createHarness();
      const gate = { beforeEffect: jest.fn(async () => true), effectAllowed: jest.fn(() => true) };
      const provider = await harness.controller.handleRequest(attestedContext(gate), attestedRequest);
      expect(provider).toMatchObject({ handled: true, result: ['0x1111111111111111111111111111111111111111'] });
      expect(provider.receipt.wallet.origin).toBe('example.com');
      expect(harness.dependencies.getPermission).toHaveBeenCalledWith('example.com');
      expect(harness.dependencies.grantPermission).toHaveBeenCalledWith('example.com', 0, 100);
      expect(gate.beforeEffect).toHaveBeenCalledTimes(1);
      expect(gate.effectAllowed).toHaveBeenCalledTimes(1);
    });

    test.each([
      ['main has answered the request, or the name moved', { beforeEffect: jest.fn(async () => false) }],
      ['the page left its key in the run of the write', { effectAllowed: jest.fn(() => false) }],
    ])('writes nothing when %s', async (_name, gate) => {
      const harness = createHarness({ permission: { walletIndex: 1, chainId: 1 } });
      const provider = await harness.controller.handleRequest(attestedContext(gate), attestedRequest);
      expect(provider).toMatchObject({ handled: true, error: { code: -32603 } });
      expect(harness.dependencies.grantPermission).not.toHaveBeenCalled();
      expect(harness.dependencies.updateLastUsed).not.toHaveBeenCalled();
      expect(harness.dependencies.updateWalletIndex).not.toHaveBeenCalled();
    });

    test('a page this run sees on another transport, or no key, is refused before any approval', async () => {
      const harness = createHarness();
      const approval = jest.fn(async () => 'approved');
      for (const attested of [
        { key: 'example.com', transportKey: 'ipns://k51other' },
        { key: '', transportKey: IPNS },
        { transportKey: IPNS },
      ]) {
        const provider = await harness.controller.handleRequest(
          { ...attestedContext({}, approval), attested },
          attestedRequest
        );
        expect(provider).toMatchObject({ handled: true, error: { code: 4100 } });
      }
      expect(approval).not.toHaveBeenCalled();
      expect(harness.dependencies.grantPermission).not.toHaveBeenCalled();
    });

    // Main's gate and the effect share one run: a losing check of the page's
    // name queued right behind the gate (here: `effectAllowed` ends the key
    // in the next microtask) never lands between them. `beforeEffect` is the
    // name checked again, which holds each time it is asked.
    function racingGate() {
      const state = { held: true };
      return {
        state,
        gate: {
          beforeEffect: jest.fn(async () => {
            state.held = true;
            return true;
          }),
          effectAllowed: jest.fn(() => {
            const now = state.held;
            queueMicrotask(() => {
              state.held = false;
            });
            return now;
          }),
        },
      };
    }

    test('the connect\'s grant write runs in the same run as main\'s last gate', async () => {
      const harness = createHarness();
      const { state, gate } = racingGate();
      const atWrite = [];
      harness.dependencies.grantPermission.mockImplementation(() => atWrite.push(state.held));
      const provider = await harness.controller.handleRequest(attestedContext(gate), attestedRequest);
      expect(provider).toMatchObject({ handled: true });
      expect(atWrite).toEqual([true]);
    });

    test('the connect\'s update of an existing grant runs in the same run as main\'s last gate', async () => {
      const harness = createHarness({
        permission: { walletIndex: 1, chainId: 1 },
        wallets: [
          { index: 0, name: 'Main Wallet', address: '0x1111111111111111111111111111111111111111', type: 'mnemonic' },
          { index: 1, name: 'Second', address: '0x2222222222222222222222222222222222222222', type: 'mnemonic' },
        ],
      });
      const { state, gate } = racingGate();
      const atWrite = [];
      harness.dependencies.updateWalletIndex.mockImplementation(() => atWrite.push(['wallet', state.held]));
      harness.dependencies.updateLastUsed.mockImplementation(() => atWrite.push(['lastUsed', state.held]));
      const pick = jest.fn(async () => ({ status: 'approved', walletIndex: 0 }));
      const provider = await harness.controller.handleRequest(attestedContext(gate, pick), attestedRequest);
      expect(provider).toMatchObject({ handled: true, result: ['0x1111111111111111111111111111111111111111'] });
      expect(atWrite).toEqual([
        ['wallet', true],
        ['lastUsed', true],
      ]);
    });

    test.each(['personal_sign', 'eth_signTypedData_v4'])(
      '%s: the signature and its last use each run in the same run as main\'s gate',
      async (method) => {
        const harness = createHarness({ permission: { walletIndex: 0, chainId: 100 } });
        const { state, gate } = racingGate();
        const atEffect = [];
        harness.signer.signMessage.mockImplementation(async () => {
          atEffect.push(['signature', state.held]);
          return '0xsignature';
        });
        harness.signer.signTypedData.mockImplementation(async () => {
          atEffect.push(['signature', state.held]);
          return '0xtyped';
        });
        harness.dependencies.updateLastUsed.mockImplementation(() => atEffect.push(['lastUsed', state.held]));
        const params =
          method === 'personal_sign'
            ? ['0x68656c6c6f', '0x1111111111111111111111111111111111111111']
            : ['0x1111111111111111111111111111111111111111', { domain: { chainId: 100 }, types: { Mail: [{ name: 'a', type: 'uint256' }] }, primaryType: 'Mail', message: { a: 1 } }];
        const provider = await harness.controller.handleRequest(attestedContext(gate), { method, params, chainId: 100 });
        expect(provider).toMatchObject({ handled: true });
        expect(atEffect).toEqual([
          ['signature', true],
          ['lastUsed', true],
        ]);
      }
    );

    // PRQ-5a: messages and typed data come attested too, and sign only once
    // main's checks pass, just before the signature.
    describe.each([
      ['personal_sign', ['0x68656c6c6f', '0x1111111111111111111111111111111111111111'], 'signMessage'],
      [
        'eth_signTypedData_v4',
        [
          '0x1111111111111111111111111111111111111111',
          { domain: { chainId: 100 }, types: { Mail: [{ name: 'a', type: 'uint256' }] }, primaryType: 'Mail', message: { a: 1 } },
        ],
        'signTypedData',
      ],
    ])('%s main attested', (method, params, signerMethod) => {
      test("signs under main's key once main's checks pass", async () => {
        const harness = createHarness({ permission: { walletIndex: 0, chainId: 100 } });
        const gate = { beforeEffect: jest.fn(async () => true), effectAllowed: jest.fn(() => true) };
        const provider = await harness.controller.handleRequest(attestedContext(gate), { method, params, chainId: 100 });
        expect(provider).toMatchObject({ handled: true });
        expect(provider.receipt.wallet.origin).toBe('example.com');
        expect(harness.dependencies.getPermission).toHaveBeenCalledWith('example.com');
        expect(harness.signer[signerMethod]).toHaveBeenCalledTimes(1);
        // Both before the signature, and again before the grant's last use.
        expect(gate.beforeEffect).toHaveBeenCalledTimes(2);
        expect(gate.effectAllowed).toHaveBeenCalledTimes(2);
        expect(harness.dependencies.updateLastUsed).toHaveBeenCalledWith('example.com', 100);
      });

      test("the name moving during the signature: signed, but the grant's last use untouched", async () => {
        const harness = createHarness({ permission: { walletIndex: 0, chainId: 100 } });
        const beforeEffect = jest.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
        const provider = await harness.controller.handleRequest(attestedContext({ beforeEffect }), { method, params, chainId: 100 });
        expect(provider).toMatchObject({ handled: true });
        expect(harness.signer[signerMethod]).toHaveBeenCalledTimes(1);
        expect(harness.dependencies.updateLastUsed).not.toHaveBeenCalled();
      });

      test.each([
        ['main has answered the request, or the name moved', { beforeEffect: jest.fn(async () => false) }],
        ['the page left its key in the run of the signature', { effectAllowed: jest.fn(() => false) }],
      ])('signs nothing when %s', async (_name, gate) => {
        const harness = createHarness({ permission: { walletIndex: 0, chainId: 100 } });
        const provider = await harness.controller.handleRequest(attestedContext(gate), { method, params, chainId: 100 });
        expect(provider).toMatchObject({ handled: true, error: { code: -32603 } });
        expect(harness.signer[signerMethod]).not.toHaveBeenCalled();
        expect(harness.dependencies.updateLastUsed).not.toHaveBeenCalled();
      });
    });

    test('only a connect and a signature come attested: a send is left to its own path', async () => {
      const harness = createHarness({ permission: { walletIndex: 0, chainId: 100 } });
      const approval = jest.fn(async () => 'approved');
      const provider = await harness.controller.handleRequest(attestedContext({}, approval), {
        method: 'eth_sendTransaction',
        params: [{ to: '0x1111111111111111111111111111111111111111', value: '0x1' }],
        chainId: 100,
      });
      expect(provider).toEqual({ handled: false });
      expect(approval).not.toHaveBeenCalled();
    });
  });

  test('returns EIP-1193 rejection and a typed Agent cancellation when declined', async () => {
    const harness = createHarness();
    const provider = await harness.controller.handleRequest(
      context(jest.fn(async () => 'declined')),
      request('eth_requestAccounts')
    );

    expect(provider).toMatchObject({
      handled: true,
      error: { code: 4001, message: 'User rejected the request' },
    });
    expect(provider.errorCode).toBe(ERROR_CODES.WALLET_REQUEST_CANCELLED_BY_USER);
    expect(harness.dependencies.grantPermission).not.toHaveBeenCalled();
  });

  test('rejects transaction data that cannot be displayed in full', async () => {
    const harness = createHarness({ permission: { walletIndex: 0, chainId: 100 } });
    const approval = jest.fn();
    const result = await harness.controller.handleRequest(context(approval), request('eth_sendTransaction', [{
      to: '0x3333333333333333333333333333333333333333', data: '0x' + 'ab'.repeat(35000),
    }]));
    expect(result.errorCode).toBe('INVALID_ARGUMENT');
    expect(approval).not.toHaveBeenCalled();
    expect(harness.dependencies.estimateGas).not.toHaveBeenCalled();
  });

  test('shows estimated transaction details and broadcasts the exact approved payload', async () => {
    const wallet = {
      index: 0,
      name: 'Main Wallet',
      address: '0x1111111111111111111111111111111111111111',
      type: 'mnemonic',
    };
    const harness = createHarness({
      permission: { walletIndex: 0, chainId: 100, autoApprove: { transactions: ['ignored'] } },
      wallets: [wallet],
    });
    const approval = jest.fn(async () => 'approved');
    const txParams = {
      from: wallet.address,
      to: '0x3333333333333333333333333333333333333333',
      value: '0xde0b6b3a7640000',
      data: '0xabcdef12',
    };

    const provider = await harness.controller.handleRequest(
      context(approval),
      request('eth_sendTransaction', [txParams])
    );

    expect(provider).toMatchObject({ handled: true, result: '0xtransaction' });
    expect(provider.receipt).toEqual({
      wallet: expect.objectContaining({
        action: 'broadcast',
        transactionHash: '0xtransaction',
        paymentId: 'payment_test',
      }),
    });
    expect(approval).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'wallet_transaction',
        wallet: expect.objectContaining({
          value: '1.0 xDAI',
          requiresUnlock: true,
          data: '0xabcdef12',
        }),
      })
    );
    expect(harness.dependencies.signAndRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        to: txParams.to,
        value: txParams.value,
        data: txParams.data,
        gasLimit: '24000',
        gasPrice: '1000000000',
        chainId: 100,
      }),
      expect.any(Object),
      { kind: 'dapp-send', origin: 'https://app.example' }
    );
  });

  test.each([{}, { type: 'legacy', gasPrice: '0' }])('refuses missing or zero fee quotes before transaction approval: %j', async gasPrices => {
    const harness = createHarness({ permission: { walletIndex: 0, chainId: 100 } });
    harness.dependencies.getGasPrices.mockResolvedValue(gasPrices);
    const approval = jest.fn(async () => 'approved');
    const result = await harness.controller.handleRequest(context(approval), request('eth_sendTransaction', [{
      from: '0x1111111111111111111111111111111111111111',
      to: '0x3333333333333333333333333333333333333333', value: '0x1', data: '0xabcdef12',
    }]));
    expect(result.errorCode).toBe('POLICY_DENIED');
    expect(approval).not.toHaveBeenCalled();
    expect(harness.dependencies.signAndRecord).not.toHaveBeenCalled();
  });

  test.each(['eth_sendTransaction', 'eth_signTypedData_v4'])('refuses a conflicting explicit chain before %s approval', async method => {
    const harness = createHarness({ permission: { walletIndex: 0, chainId: 100 } });
    const approve = jest.fn(async () => 'approved');
    const address = '0x1111111111111111111111111111111111111111';
    const params = method === 'eth_sendTransaction'
      ? [{ from: address, to: address, value: '0x0', chainId: '0x1' }]
      : [address, JSON.stringify({ domain: { chainId: 1 }, types: {}, message: {} })];
    const result = await harness.controller.handleRequest(context(approve), request(method, params));
    expect(result).toMatchObject({ handled: true, errorCode: ERROR_CODES.POLICY_DENIED });
    expect(approve).not.toHaveBeenCalled();
    expect(harness.dependencies.signAndRecord).not.toHaveBeenCalled();
    expect(harness.signer.signTypedData).not.toHaveBeenCalled();
  });

  test('keeps the approved transaction network when provider selection changes while waiting', async () => {
    const harness = createHarness({ permission: { walletIndex: 0, chainId: 100 } });
    const input = request('eth_sendTransaction', [{
      to: '0x3333333333333333333333333333333333333333', value: '0x0', chainId: '0x64',
    }]);
    const approve = jest.fn(async displayed => {
      expect(displayed.wallet.chainId).toBe(100);
      expect(displayed.origin).toBe('https://app.example');
      input.chainId = 1;
      return 'approved';
    });
    await expect(harness.controller.handleRequest(context(approve), input)).resolves.toMatchObject({ result: '0xtransaction' });
    expect(harness.dependencies.signAndRecord.mock.calls[0][0].chainId).toBe(100);
  });

  test('keeps signatures out of the Agent receipt while returning them to the page', async () => {
    const harness = createHarness({ permission: { walletIndex: 0, chainId: 100 } });
    const approval = jest.fn(async () => 'approved');

    const provider = await harness.controller.handleRequest(
      context(approval),
      request('personal_sign', ['Hello Freedom', '0x1111111111111111111111111111111111111111'])
    );

    expect(provider).toMatchObject({ handled: true, result: '0xsignature' });
    expect(approval).toHaveBeenCalledWith(
      expect.objectContaining({
        wallet: expect.objectContaining({
          summary: 'Hello Freedom',
          signatureType: 'Personal message',
        }),
      })
    );
    expect(provider.receipt).toEqual({
      wallet: {
        action: 'signed',
        origin: 'https://app.example',
        chainId: 100,
        signatureType: 'personal_sign',
      },
    });
    expect(JSON.stringify(provider.receipt)).not.toContain('0xsignature');
  });

  test('shows the complete canonical typed payload before signing it', async () => {
    const harness = createHarness({ permission: { walletIndex: 0, chainId: 100 } });
    const approval = jest.fn(async () => 'approved');
    const typedData = {
      domain: { name: 'Freedom Test', chainId: 100 },
      types: { Message: [{ name: 'contents', type: 'string' }] },
      primaryType: 'Message',
      message: { contents: 'Approve this exact text' },
    };

    const provider = await harness.controller.handleRequest(
      context(approval),
      request('eth_signTypedData_v4', [
        '0x1111111111111111111111111111111111111111',
        JSON.stringify(typedData),
      ])
    );

    expect(provider).toMatchObject({ handled: true, result: '0xtyped' });
    expect(approval).toHaveBeenCalledWith(
      expect.objectContaining({
        wallet: expect.objectContaining({
          summary: JSON.stringify(typedData, null, 2),
          signatureType: 'EIP-712 typed data',
        }),
      })
    );
    expect(harness.signer.signTypedData).toHaveBeenCalledWith(JSON.stringify(typedData));
    expect(provider.receipt).toMatchObject({
      wallet: { action: 'signed', signatureType: 'eth_signTypedData_v4' },
    });
  });

  test('rejects a signature claiming a different connected account', async () => {
    const harness = createHarness({ permission: { walletIndex: 0, chainId: 100 } });
    const provider = await harness.controller.handleRequest(
      context(),
      request('personal_sign', [
        'Hello Freedom',
        '0x2222222222222222222222222222222222222222',
      ])
    );

    expect(provider).toMatchObject({
      handled: true,
      error: { code: -32603, message: 'Signature account does not match the connected wallet' },
    });
    expect(provider.errorCode).toBe(ERROR_CODES.POLICY_DENIED);
  });

  test('does not intercept an unarmed page or a mismatched page identity', async () => {
    const harness = createHarness();
    await expect(
      harness.controller.handleRequest(null, request('eth_requestAccounts'))
    ).resolves.toEqual({ handled: false });

    const mismatch = request('eth_requestAccounts');
    mismatch.displayUrl = 'https://evil.example';
    await expect(harness.controller.handleRequest(context(), mismatch)).resolves.toEqual({
      handled: true,
      error: { code: 4100, message: 'Wallet request origin did not match the page' },
      errorCode: ERROR_CODES.POLICY_DENIED,
    });
  });
});

describe('unsupported Agent wallet signing', () => {
  const safe = { index: 1000, name: 'Team Safe', type: 'safe', address: '0x1111111111111111111111111111111111111111' };

  test('preserves Safe identity in connection approval', async () => {
    const { controller } = createHarness({ wallets: [safe] });
    const approve = jest.fn(async () => ({ status: 'approved', walletIndex: safe.index }));
    await controller.handleRequest(context(approve), request('eth_requestAccounts'));
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({
      wallet: expect.objectContaining({ wallets: [safe] }),
    }));
  });

  test.each(['personal_sign', 'eth_signTypedData_v4', 'eth_sendTransaction'])(
    'rejects Safe %s before approval or signer access', async (method) => {
      const { controller, dependencies } = createHarness({ wallets: [safe], permission: { walletIndex: safe.index } });
      const approve = jest.fn();
      const result = await controller.handleRequest(context(approve), request(method));
      expect(result).toMatchObject({ handled: true, error: { message: expect.stringContaining('unavailable for this wallet type') } });
      expect(approve).not.toHaveBeenCalled();
      expect(dependencies.getSigner).not.toHaveBeenCalled();
      expect(dependencies.signAndRecord).not.toHaveBeenCalled();
    }
  );

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
