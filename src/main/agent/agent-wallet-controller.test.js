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

const ADDRESS = '0x1111111111111111111111111111111111111111';

// A page's request main attested, with the document's PageContext, under
// which the identity core writes its grant's last use (freedom-core design
// 0012, APB-2).
const SITE_PAGE = Object.freeze({
  origin: 'https://app.example',
  top_origin: 'https://app.example',
  frame: 1,
  navigation: 1,
  agent: true,
});

/**
 * Main's issuer for the Agent's decision (`page-requests.js` `agentToken`,
 * freedom-core design 0012): `mint` the request's page-kind token, `present`
 * it to the signature (main's checks, the live PageContext), `holds` reads
 * the decision again (the request, its document, the agent's custody),
 * `discard` it after. Each call is recorded in `calls`, in order;
 * `onPresent` and `onHolds` run as main's checks would, and may throw to
 * refuse.
 */
function fakePageToken({ onPresent = null, onHolds = null } = {}) {
  const calls = [];
  let minted = 0;
  return {
    calls,
    mint: jest.fn(async (kind, walletIndex, payload, options) => {
      minted += 1;
      calls.push(['mint', kind, walletIndex]);
      return {
        token: `token-${minted}`,
        kind,
        account: walletIndex,
        handle: 'a'.repeat(64),
        ...(kind === 'sign-typed-data' ? { hash: '0xboundhash' } : {}),
        options,
      };
    }),
    present: jest.fn((confirmation) => {
      calls.push(['present', confirmation.token]);
      onPresent?.(confirmation);
      return { confirmation: { ...confirmation, page: { origin: 'https://app.example', agent: true } } };
    }),
    holds: jest.fn((confirmation) => {
      calls.push(['holds', confirmation.token]);
      onHolds?.(confirmation);
    }),
    discard: jest.fn((confirmation) => {
      calls.push(['discard', confirmation?.token]);
    }),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * A signer as `signers.js` runs one for the Agent's token (Codex on #1246):
 * its own wait (the address, the core's hash, a device's spend), which a
 * test holds (`reached` once it waits, `release` to go on), then the
 * caller's last check (`beforeSign`), then the core or the device, recorded
 * in `asked`.
 */
function heldSigner() {
  const reached = deferred();
  const released = deferred();
  const asked = [];
  const step = (method, result) => async function signed(...args) {
    reached.resolve();
    await released.promise;
    await this.authorized.beforeSign();
    asked.push([method, ...args]);
    return result;
  };
  return {
    reached: reached.promise,
    release: released.resolve,
    asked,
    getSigner: (index, authorized) => ({
      authorized,
      signMessage: step('signMessage', '0xsignature'),
      signTypedData: step('signTypedData', '0xtyped'),
      signTransaction: step('signTransaction', '0xsigned'),
    }),
  };
}

// The issuer's decision, which a test ends: `holds` then refuses.
function custodyToken() {
  const decision = { custody: true };
  const pageToken = fakePageToken({
    onHolds: () => {
      if (!decision.custody) throw new Error('Signing was not confirmed: the Agent no longer holds this tab');
    },
  });
  return { decision, pageToken };
}

// A page's request main attested, with its issuer for the Agent's decision.
function attestedPage(requestApproval = jest.fn(async () => 'approved'), extra = {}) {
  return {
    ...context(requestApproval),
    attested: { key: 'https://app.example', transportKey: 'https://app.example' },
    beforeEffect: jest.fn(async () => true),
    effectAllowed: jest.fn(() => true),
    pageToken: fakePageToken(),
    pageContext: () => SITE_PAGE,
    ...extra,
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

  // freedom-core design 0011, PRQ-5b: main attests a page's send and passes
  // its key, and the checks its effect waits on. A connect or a signature
  // in a tab the Agent holds goes to the identity core since APB-5a, whose
  // prompt the Agent's sheet answers (`answerPrompt`, below).
  describe('a request main attested', () => {
    const IPNS = 'ipns://k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8';
    const PAGE = Object.freeze({ origin: 'example.com', top_origin: 'example.com', frame: 1, navigation: 2, agent: true });
    const attestedContext = (gate = {}, approval = jest.fn(async () => 'approved')) => ({
      ...context(approval),
      pageUrl: `${IPNS}/docs`,
      attested: { key: 'example.com', transportKey: IPNS },
      beforeEffect: gate.beforeEffect || jest.fn(async () => true),
      effectAllowed: gate.effectAllowed || jest.fn(() => true),
      pageToken: gate.pageToken || fakePageToken(),
      // The document's PageContext, under which the identity core writes the
      // grant's last use (freedom-core design 0012, APB-2).
      pageContext: () => PAGE,
    });

    test.each(['eth_requestAccounts', 'personal_sign', 'eth_signTypedData_v4'])(
      '%s is not the agent route\'s since APB-5a: not handled, nothing asked',
      async (method) => {
        const harness = createHarness({ permission: { walletIndex: 0, chainId: 100 } });
        const approval = jest.fn(async () => 'approved');
        const gate = { pageToken: fakePageToken() };
        const params = method === 'personal_sign' ? ['0x68656c6c6f', ADDRESS] : method === 'eth_signTypedData_v4' ? [ADDRESS, '{}'] : [];
        await expect(
          harness.controller.handleRequest(attestedContext(gate, approval), { method, params, chainId: 100 })
        ).resolves.toEqual({ handled: false });
        expect(approval).not.toHaveBeenCalled();
        expect(gate.pageToken.mint).not.toHaveBeenCalled();
        expect(harness.dependencies.getSigner).not.toHaveBeenCalled();
        expect(harness.dependencies.identityManager.getDerivedWallets).not.toHaveBeenCalled();
      }
    );
    // PRQ-5b: a send comes attested too, and is sent only once main's
    // checks pass, just before it.
    describe('eth_sendTransaction main attested', () => {
      const send = {
        method: 'eth_sendTransaction',
        params: [{ to: '0x3333333333333333333333333333333333333333', value: '0x1' }],
        chainId: 100,
      };

      test("sends under main's key once main's checks pass", async () => {
        const harness = createHarness({ permission: { walletIndex: 0, chainId: 100 } });
        const gate = { beforeEffect: jest.fn(async () => true), effectAllowed: jest.fn(() => true) };
        const provider = await harness.controller.handleRequest(attestedContext(gate), send);
        expect(provider).toMatchObject({ handled: true, result: expect.stringMatching(/^0x/) });
        expect(provider.receipt.wallet.origin).toBe('example.com');
        expect(harness.dependencies.getPermission).toHaveBeenCalledWith('example.com');
        expect(harness.dependencies.signAndRecord).toHaveBeenCalledTimes(1);
        expect(harness.dependencies.signAndRecord.mock.calls[0][2]).toMatchObject({ origin: 'example.com' });
        // Before the mint, after it, and again before the grant's last use
        // (this service asks no signer and commits through no guard).
        expect(gate.beforeEffect).toHaveBeenCalledTimes(3);
        expect(gate.effectAllowed).toHaveBeenCalledTimes(3);
        expect(harness.dependencies.updateLastUsed).toHaveBeenCalledWith('example.com', 100, PAGE);
      });

      // Design 0012 (APB-1d): the Agent's approval mints the page's
      // dapp-send token for this transaction through main's issuer, and the
      // send's signer presents it, in the same run as main's last checks.
      test.each([
        ['a vault account', 'mnemonic', false],
        ['a phone account', 'remote', true],
      ])('%s: the send presents the dapp-send token the Agent\'s decision minted', async (_label, type, phone) => {
        const harness = createHarness({
          permission: { walletIndex: 0, chainId: 100 },
          wallets: [{ index: 0, name: 'Main Wallet', address: '0x1111111111111111111111111111111111111111', type }],
        });
        const pageToken = fakePageToken();
        const order = [];
        harness.dependencies.getSigner.mockImplementation((index, authorized) => {
          order.push(['signer', authorized?.confirmation?.token]);
          return harness.signer;
        });
        harness.dependencies.signAndRecord.mockImplementation(async () => {
          order.push(['send']);
          return { hash: '0xtransaction' };
        });
        const provider = await harness.controller.handleRequest(attestedContext({ pageToken }), send);
        expect(provider).toMatchObject({ handled: true, result: '0xtransaction' });
        expect(pageToken.mint).toHaveBeenCalledWith(
          'dapp-send',
          0,
          expect.objectContaining({
            to: send.params[0].to,
            value: '0x1',
            gasLimit: '24000',
            gasPrice: '1000000000',
            chainId: 100,
            origin: 'example.com',
          }),
          { phone }
        );
        expect(pageToken.calls).toEqual([
          ['mint', 'dapp-send', 0],
          ['holds', 'token-1'],
          ['present', 'token-1'],
          ['discard', 'token-1'],
        ]);
        expect(order).toEqual([['signer', 'token-1'], ['send']]);
        expect(harness.dependencies.getSigner).toHaveBeenCalledWith(0, {
          confirmation: expect.objectContaining({ token: 'token-1', kind: 'dapp-send', page: expect.objectContaining({ agent: true }) }),
          beforeSign: expect.any(Function),
        });
      });

      test.each([
        ['the name moves', (gate) => gate.beforeEffect.mockResolvedValueOnce(false), 'no longer open'],
        ['the page leaves its key', (gate) => gate.effectAllowed.mockReturnValueOnce(false), 'no longer open'],
        ['the agent leaves the tab', (_gate, decision) => (decision.custody = false), 'no longer holds this tab'],
        ['its grant moves to another account', (_gate, _decision, harness) => harness.dependencies.getPermission.mockReturnValue({ walletIndex: 7 }), 'no longer connected'],
      ])("when %s during the transaction service's or the signer's wait: the signer's last step refuses, nothing signed or sent", async (_label, change, refused) => {
        const harness = createHarness({ permission: { walletIndex: 0, chainId: 100 } });
        const { decision, pageToken } = custodyToken();
        const gate = { beforeEffect: jest.fn(async () => true), effectAllowed: jest.fn(() => true), pageToken };
        const signer = heldSigner();
        harness.dependencies.getSigner.mockImplementation(signer.getSigner);
        const committed = [];
        harness.dependencies.signAndRecord.mockImplementation(async (tx, chosen, _record, options) => {
          const raw = await chosen.signTransaction(tx);
          await options.guardCommit(async () => committed.push(raw));
          return { hash: '0xhash' };
        });
        const pending = harness.controller.handleRequest(attestedContext(gate), send);
        await signer.reached;
        change(gate, decision, harness);
        signer.release();
        const provider = await pending;
        expect(provider).toMatchObject({ handled: true, error: { code: -32603, message: expect.stringContaining(refused) } });
        expect(signer.asked).toEqual([]);
        expect(committed).toEqual([]);
        expect(pageToken.calls.at(-1)).toEqual(['discard', 'token-1']);
      });

      test('the name moving while the token is minted: nothing presented, signed or sent, the token burnt', async () => {
        const harness = createHarness({ permission: { walletIndex: 0, chainId: 100 } });
        const beforeEffect = jest.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
        const pageToken = fakePageToken();
        const provider = await harness.controller.handleRequest(attestedContext({ beforeEffect, pageToken }), send);
        expect(provider).toMatchObject({ handled: true, error: { code: -32603 } });
        expect(pageToken.calls).toEqual([
          ['mint', 'dapp-send', 0],
          ['discard', 'token-1'],
        ]);
        expect(harness.dependencies.getSigner).not.toHaveBeenCalled();
        expect(harness.dependencies.signAndRecord).not.toHaveBeenCalled();
      });

      test('the grant gone during the mint: nothing presented or sent, the token burnt', async () => {
        const harness = createHarness({ permission: { walletIndex: 0, chainId: 100 } });
        const pageToken = fakePageToken();
        const mint = pageToken.mint.getMockImplementation();
        pageToken.mint.mockImplementation(async (...args) => {
          const minted = await mint(...args);
          harness.dependencies.getPermission.mockReturnValue(null);
          return minted;
        });
        const provider = await harness.controller.handleRequest(attestedContext({ pageToken }), send);
        expect(provider).toMatchObject({ handled: true, error: { code: -32603 } });
        expect(pageToken.present).not.toHaveBeenCalled();
        expect(pageToken.calls.at(-1)).toEqual(['discard', 'token-1']);
        expect(harness.dependencies.signAndRecord).not.toHaveBeenCalled();
      });

      // Codex on #1191: a signer can outlast a name move, the page's going or
      // its grant's change, so main's gates run again after the signature and
      // before the signed bytes are recorded or sent, and commit them.
      test('after the signature, before the commit: main\'s gates and the grant again, and the guard commits', async () => {
        const harness = createHarness({ permission: { walletIndex: 0, chainId: 100 } });
        const committed = [];
        let between = () => {};
        harness.dependencies.signAndRecord.mockImplementation(async (tx, _signer, _context, options) => {
          between();
          await options.guardCommit(async () => committed.push(tx));
          return { hash: '0xhash' };
        });
        let custody = true;
        const gate = {
          beforeEffect: jest.fn(async () => true),
          effectAllowed: jest.fn(() => true),
        };
        const pageToken = () =>
          fakePageToken({
            onHolds: () => {
              if (!custody) throw new Error('Signing was not confirmed: the Agent no longer holds this tab');
            },
          });
        await expect(harness.controller.handleRequest(attestedContext({ ...gate, pageToken: pageToken() }), send)).resolves.toMatchObject({
          handled: true,
          result: '0xhash',
        });
        expect(committed).toHaveLength(1);
        // Before the mint, after it, after the signature, and before the
        // last use.
        expect(gate.beforeEffect).toHaveBeenCalledTimes(4);
        expect(gate.effectAllowed).toHaveBeenCalledTimes(4);
        for (const [label, change] of [
          ['main answered, or the name moved', () => gate.beforeEffect.mockResolvedValueOnce(false)],
          ['the page left its key', () => gate.effectAllowed.mockReturnValueOnce(false)],
          ['the grant moved to another account', () => harness.dependencies.getPermission.mockReturnValue({ walletIndex: 7 })],
          ['the agent left the tab', () => (custody = false)],
        ]) {
          committed.length = 0;
          custody = true;
          harness.dependencies.getPermission.mockReturnValue({ walletIndex: 0, chainId: 100 });
          between = change;
          const provider = await harness.controller.handleRequest(attestedContext({ ...gate, pageToken: pageToken() }), send);
          expect({ label, provider }).toMatchObject({ label, provider: { handled: true, error: { code: -32603 } } });
          expect({ label, committed }).toEqual({ label, committed: [] });
        }
      });

      test('an attested send is refused before the signer when the grant no longer exposes the account', async () => {
        const harness = createHarness({ permission: { walletIndex: 0, chainId: 100 } });
        // The grant goes while main's gate resolves the name.
        const gate = {
          beforeEffect: jest.fn(async () => {
            harness.dependencies.getPermission.mockReturnValue(null);
            return true;
          }),
          effectAllowed: jest.fn(() => true),
        };
        const provider = await harness.controller.handleRequest(attestedContext(gate), send);
        expect(provider).toMatchObject({ handled: true, error: { code: -32603 } });
        expect(harness.dependencies.signAndRecord).not.toHaveBeenCalled();
      });

      test("the name moving during the send: sent, but the grant's last use untouched", async () => {
        const harness = createHarness({ permission: { walletIndex: 0, chainId: 100 } });
        // Holds before the mint and after it; moved once sent.
        const beforeEffect = jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false);
        const provider = await harness.controller.handleRequest(attestedContext({ beforeEffect }), send);
        expect(provider).toMatchObject({ handled: true, result: expect.stringMatching(/^0x/) });
        expect(harness.dependencies.signAndRecord).toHaveBeenCalledTimes(1);
        expect(harness.dependencies.updateLastUsed).not.toHaveBeenCalled();
      });

      test.each([
        ['main has answered the request, or the name moved', { beforeEffect: jest.fn(async () => false) }],
        ['the page left its key in the run of the send', { effectAllowed: jest.fn(() => false) }],
      ])('sends nothing when %s', async (_name, gate) => {
        const harness = createHarness({ permission: { walletIndex: 0, chainId: 100 } });
        const provider = await harness.controller.handleRequest(attestedContext(gate), send);
        expect(provider).toMatchObject({ handled: true, error: { code: -32603 } });
        expect(harness.dependencies.signAndRecord).not.toHaveBeenCalled();
        expect(harness.dependencies.updateLastUsed).not.toHaveBeenCalled();
      });
    });
  });

  test('returns EIP-1193 rejection and a typed Agent cancellation when a send is declined', async () => {
    const harness = createHarness({ permission: { walletIndex: 0, chainId: 100 } });
    const pageToken = fakePageToken();
    const provider = await harness.controller.handleRequest(
      attestedPage(jest.fn(async () => 'declined'), { pageToken }),
      request('eth_sendTransaction', [{ to: '0x3333333333333333333333333333333333333333', value: '0x1' }])
    );

    expect(provider).toMatchObject({
      handled: true,
      error: { code: 4001, message: 'User rejected the request' },
    });
    expect(provider.errorCode).toBe(ERROR_CODES.WALLET_REQUEST_CANCELLED_BY_USER);
    expect(pageToken.mint).not.toHaveBeenCalled();
    expect(harness.dependencies.signAndRecord).not.toHaveBeenCalled();
  });

  test('rejects transaction data that cannot be displayed in full', async () => {
    const harness = createHarness({ permission: { walletIndex: 0, chainId: 100 } });
    const approval = jest.fn();
    const result = await harness.controller.handleRequest(attestedPage(approval), request('eth_sendTransaction', [{
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
      attestedPage(approval),
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
      { kind: 'dapp-send', origin: 'https://app.example' },
      { guardCommit: expect.any(Function) }
    );
  });

  test.each([{}, { type: 'legacy', gasPrice: '0' }])('refuses missing or zero fee quotes before transaction approval: %j', async gasPrices => {
    const harness = createHarness({ permission: { walletIndex: 0, chainId: 100 } });
    harness.dependencies.getGasPrices.mockResolvedValue(gasPrices);
    const approval = jest.fn(async () => 'approved');
    const result = await harness.controller.handleRequest(attestedPage(approval), request('eth_sendTransaction', [{
      from: '0x1111111111111111111111111111111111111111',
      to: '0x3333333333333333333333333333333333333333', value: '0x1', data: '0xabcdef12',
    }]));
    expect(result.errorCode).toBe('POLICY_DENIED');
    expect(approval).not.toHaveBeenCalled();
    expect(harness.dependencies.signAndRecord).not.toHaveBeenCalled();
  });

  // A typed-data's chain is the sheet's to refuse (`answerPrompt`, below).
  test('refuses a conflicting explicit chain before eth_sendTransaction approval', async () => {
    const harness = createHarness({ permission: { walletIndex: 0, chainId: 100 } });
    const approve = jest.fn(async () => 'approved');
    const params = [{ from: ADDRESS, to: ADDRESS, value: '0x0', chainId: '0x1' }];
    const result = await harness.controller.handleRequest(attestedPage(approve), request('eth_sendTransaction', params));
    expect(result).toMatchObject({ handled: true, errorCode: ERROR_CODES.POLICY_DENIED });
    expect(approve).not.toHaveBeenCalled();
    expect(harness.dependencies.signAndRecord).not.toHaveBeenCalled();
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
    await expect(harness.controller.handleRequest(attestedPage(approve), input)).resolves.toMatchObject({ result: '0xtransaction' });
    expect(harness.dependencies.signAndRecord.mock.calls[0][0].chainId).toBe(100);
  });

  // Design 0012 (APB-1d): a page's send goes under its page, with the token
  // the Agent's decision mints through main's issuer. One main didn't
  // attest, or gave no issuer for, has no page to sign under: refused before
  // the Agent is asked, and nothing signs as main's own.
  test('an eth_sendTransaction main did not attest, or gave no issuer for, is refused before approval or signer', async () => {
    const params = [{ to: '0x3333333333333333333333333333333333333333', value: '0x1' }];
    for (const unattested of [
      context(jest.fn(async () => 'approved')),
      attestedPage(jest.fn(async () => 'approved'), { pageToken: undefined }),
      attestedPage(jest.fn(async () => 'approved'), { pageToken: { mint: async () => ({}) } }),
      // An issuer that can't read the decision again at the signer's last
      // step (Codex on #1246).
      attestedPage(jest.fn(async () => 'approved'), {
        pageToken: { mint: async () => ({}), present: () => ({}), discard: () => {} },
      }),
    ]) {
      const harness = createHarness({ permission: { walletIndex: 0, chainId: 100 } });
      const result = await harness.controller.handleRequest(unattested, request('eth_sendTransaction', params));
      expect(result).toMatchObject({ handled: true, errorCode: ERROR_CODES.POLICY_DENIED });
      expect(unattested.requestApproval).not.toHaveBeenCalled();
      expect(harness.dependencies.getSigner).not.toHaveBeenCalled();
      expect(harness.dependencies.signAndRecord).not.toHaveBeenCalled();
    }
  });

  test('does not intercept an unarmed page, a connect or a signature, and refuses a mismatched page identity', async () => {
    const harness = createHarness({ permission: { walletIndex: 0, chainId: 100 } });
    const send = () => request('eth_sendTransaction', [{ to: '0x3333333333333333333333333333333333333333', value: '0x1' }]);
    await expect(harness.controller.handleRequest(null, send())).resolves.toEqual({ handled: false });
    // A connect or a signature is the identity core's since APB-5a, attested
    // or not.
    for (const method of ['eth_requestAccounts', 'personal_sign', 'eth_signTypedData_v4']) {
      const approval = jest.fn(async () => 'approved');
      await expect(harness.controller.handleRequest(context(approval), request(method))).resolves.toEqual({ handled: false });
      await expect(harness.controller.handleRequest(attestedPage(approval), request(method))).resolves.toEqual({ handled: false });
      expect(approval).not.toHaveBeenCalled();
    }

    const mismatch = send();
    mismatch.displayUrl = 'https://evil.example';
    await expect(harness.controller.handleRequest(context(), mismatch)).resolves.toEqual({
      handled: true,
      error: { code: 4100, message: 'Wallet request origin did not match the page' },
      errorCode: ERROR_CODES.POLICY_DENIED,
    });
    expect(harness.dependencies.signAndRecord).not.toHaveBeenCalled();
  });
});

// freedom-core design 0012, "The Agent's answer" (APB-5a): in a tab the
// Agent holds, the identity core's eth.connect and eth.sign prompt is the
// Agent's sheet's. Main hands it the core's view (`page-eip1193.js`
// `connectShown`/`signShown`), and the sheet decides on it; the agent's own
// refusals (A7-3) answer without the sheet. Nothing here writes a grant,
// mints a token or signs: the core does, on main's answer.
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

  // An answer that asked nothing of the sheet, nor of main's own stores.
  function expectNothingAsked(harness, approval) {
    expect(approval).not.toHaveBeenCalled();
    expect(harness.dependencies.identityManager.getDerivedWallets).not.toHaveBeenCalled();
    expect(harness.dependencies.getPermission).not.toHaveBeenCalled();
    expect(harness.dependencies.getSigner).not.toHaveBeenCalled();
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
    const send = { kind: 'eth.send', method: 'eth_sendTransaction', params: [{}], chainId: 100, view: { account: VAULT, chain: CHAIN } };
    const crossed = [
      null,
      vaultUnlock,
      send,
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

  test('rejects a Safe eth_sendTransaction before approval or signer access', async () => {
    const { controller, dependencies } = createHarness({ wallets: [safe], permission: { walletIndex: safe.index } });
    const approve = jest.fn();
    const result = await controller.handleRequest(context(approve), request('eth_sendTransaction'));
    expect(result).toMatchObject({ handled: true, error: { message: expect.stringContaining('unavailable for this wallet type') } });
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
