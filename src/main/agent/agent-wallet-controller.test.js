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
