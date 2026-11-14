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

// A page's request main attested, with the document's PageContext, under
// which the identity core writes its grant (freedom-core design 0012, APB-2).
const SITE_PAGE = Object.freeze({
  origin: 'https://app.example',
  top_origin: 'https://app.example',
  frame: 1,
  navigation: 1,
  agent: true,
});
function attested(requestApproval) {
  return {
    ...context(requestApproval),
    attested: { key: 'https://app.example', transportKey: 'https://app.example' },
    beforeEffect: async () => true,
    effectAllowed: () => true,
    pageContext: () => SITE_PAGE,
  };
}
const CONNECT = { method: 'eth_requestAccounts', params: [], chainId: 100 };

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
    const provider = await harness.controller.handleRequest(attested(approval), CONNECT);

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
    expect(harness.dependencies.grantPermission).toHaveBeenCalledWith('https://app.example', 2, 100, SITE_PAGE);
  });

  // freedom-core design 0012, APB-2: the grant is the identity core's to
  // write, under the page's PageContext, which only a request main attested
  // has: any other connect is refused before the approval.
  test('a connect main did not attest is refused before any approval, and nothing is written', async () => {
    const harness = createHarness();
    const approval = jest.fn(async () => 'approved');
    const provider = await harness.controller.handleRequest(context(approval), request('eth_requestAccounts'));
    expect(provider).toMatchObject({ handled: true, errorCode: ERROR_CODES.POLICY_DENIED });
    expect(approval).not.toHaveBeenCalled();
    expect(harness.dependencies.grantPermission).not.toHaveBeenCalled();
    const noPage = { ...attested(approval) };
    delete noPage.pageContext;
    await expect(harness.controller.handleRequest(noPage, CONNECT)).resolves.toMatchObject({
      errorCode: ERROR_CODES.POLICY_DENIED,
    });
    expect(approval).not.toHaveBeenCalled();
  });

  test('a grant the core does not write fails the connect', async () => {
    const harness = createHarness();
    harness.dependencies.grantPermission.mockRejectedValue(
      Object.assign(new Error('The permission file could not be written'), { code: 'storage' })
    );
    const provider = await harness.controller.handleRequest(attested(), CONNECT);
    expect(provider).toMatchObject({ handled: true, error: { code: -32603 } });
    expect(provider.result).toBeUndefined();
  });

  // freedom-core design 0011, PRQ-4: main attests a page's connect and
  // passes its key, and the checks the grant write waits on.
  describe('a connect main attested', () => {
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
      // grant (freedom-core design 0012, APB-2).
      pageContext: () => PAGE,
    });
    const attestedRequest = { method: 'eth_requestAccounts', params: [], chainId: 100 };

    test('acts under main\'s key, a DNS name over its IPNS page, once main\'s checks pass', async () => {
      const harness = createHarness();
      const gate = { beforeEffect: jest.fn(async () => true), effectAllowed: jest.fn(() => true) };
      const provider = await harness.controller.handleRequest(attestedContext(gate), attestedRequest);
      expect(provider).toMatchObject({ handled: true, result: ['0x1111111111111111111111111111111111111111'] });
      expect(provider.receipt.wallet.origin).toBe('example.com');
      expect(harness.dependencies.getPermission).toHaveBeenCalledWith('example.com');
      expect(harness.dependencies.grantPermission).toHaveBeenCalledWith('example.com', 0, 100, PAGE);
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

    // The identity core answers an account change with `{ grant: null }`
    // when the key holds no grant any more (removed behind main's copy):
    // nothing was written, so the connect fails with no account and no
    // receipt. dapp-permissions.js's own `updateWalletIndex`, over that reply.
    test('an account change the identity core answers with no grant fails the connect: no account, no receipt', async () => {
      const { vaultBackend } = require('../core/vault-backend');
      const grant = jest.spyOn(vaultBackend.approval, 'grant').mockResolvedValue({ grant: null });
      const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const harness = createHarness({
          permission: { walletIndex: 1, chainId: 1 },
          wallets: [
            { index: 0, name: 'Main Wallet', address: '0x1111111111111111111111111111111111111111', type: 'mnemonic' },
            { index: 1, name: 'Second', address: '0x2222222222222222222222222222222222222222', type: 'mnemonic' },
          ],
        });
        const controller = new AgentWalletController({ ...harness.dependencies, updateWalletIndex: undefined });
        const told = [];
        const pick = jest.fn(async () => ({ status: 'approved', walletIndex: 0 }));
        const provider = await controller.handleRequest(
          { ...attestedContext({}, pick), grantWritten: (effect) => told.push(effect) },
          attestedRequest
        );
        expect(grant).toHaveBeenCalledWith({ store: 'dapp', change: { op: 'account', account: 0 } }, PAGE);
        expect(provider).toEqual({
          handled: true,
          error: { code: -32603, message: 'The account change was not recorded' },
          errorCode: ERROR_CODES.INTERNAL_ERROR,
        });
        expect(told.map((effect) => effect.grant)).toEqual(['updated']);
        await expect(told[0].written).rejects.toThrow('The account change was not recorded');
      } finally {
        grant.mockRestore();
        quiet.mockRestore();
      }
    });

    // freedom-core design 0011, PRQ-6 (#1192 round 2): the controller tells
    // main what its own write did, decided from the grant it read in the
    // write's run and told in that run, so main queues a created grant's
    // events at that write.
    describe('what the connect\'s write did, told to main in its run', () => {
      const TWO = [
        { index: 0, name: 'Main Wallet', address: '0x1111111111111111111111111111111111111111', type: 'mnemonic' },
        { index: 1, name: 'Second', address: '0x2222222222222222222222222222222222222222', type: 'mnemonic' },
      ];

      test.each([
        ['created, for a site with no grant at the write', null, 1, 'created'],
        ['updated, for a grant on another account', { walletIndex: 0, chainId: 1 }, 1, 'updated'],
        ['unchanged, for a grant already on that account', { walletIndex: 1, chainId: 1 }, 1, 'unchanged'],
      ])('%s', async (_name, permission, walletIndex, grant) => {
        const harness = createHarness({ permission, wallets: TWO });
        const { state, gate } = racingGate();
        const told = [];
        const context = {
          ...attestedContext(gate, jest.fn(async () => ({ status: 'approved', walletIndex }))),
          grantWritten: jest.fn((effect) => told.push({ ...effect, held: state.held })),
        };
        const provider = await harness.controller.handleRequest(context, attestedRequest);
        expect(provider).toMatchObject({ handled: true, result: [TWO[walletIndex].address] });
        expect(told).toEqual([
          { grant, walletIndex, account: TWO[walletIndex].address, chainId: 100, written: expect.any(Promise), held: true },
        ]);
      });

      test('decided from the grant at the write, not before the approval\'s wait', async () => {
        const harness = createHarness({ wallets: TWO });
        // A grant at the approval's start, revoked while it waits.
        let current = { walletIndex: 0, chainId: 100 };
        harness.dependencies.getPermission.mockImplementation(() => current);
        const told = [];
        const approve = jest.fn(async () => {
          current = null;
          return { status: 'approved', walletIndex: 1 };
        });
        const context = { ...attestedContext({}, approve), grantWritten: (effect) => told.push(effect.grant) };
        await harness.controller.handleRequest(context, attestedRequest);
        expect(harness.dependencies.grantPermission).toHaveBeenCalledWith('example.com', 1, 100, PAGE);
        expect(told).toEqual(['created']);
      });

      test('nothing is told when main\'s gate refuses the write, and a failing listener undoes nothing', async () => {
        const harness = createHarness({ wallets: TWO });
        const told = jest.fn();
        const refused = await harness.controller.handleRequest(
          { ...attestedContext({ effectAllowed: jest.fn(() => false) }), grantWritten: told },
          attestedRequest
        );
        expect(refused).toMatchObject({ handled: true, error: { code: -32603 } });
        expect(told).not.toHaveBeenCalled();
        const throwing = jest.fn(() => {
          throw new Error('boom');
        });
        const provider = await harness.controller.handleRequest(
          { ...attestedContext(), grantWritten: throwing },
          attestedRequest
        );
        expect(throwing).toHaveBeenCalledTimes(1);
        expect(provider).toMatchObject({ handled: true, result: ['0x1111111111111111111111111111111111111111'] });
        expect(harness.dependencies.grantPermission).toHaveBeenCalledTimes(1);
      });
    });

    test.each(['personal_sign', 'eth_signTypedData_v4'])(
      '%s: the signature and its last use each run in the same run as main\'s gate',
      async (method) => {
        const harness = createHarness({ permission: { walletIndex: 0, chainId: 100 } });
        const { state, gate } = racingGate();
        // After the mint's wait, main's last check is the token's
        // presentation: the signature runs in its run.
        const presented = { held: false };
        gate.pageToken = fakePageToken({
          onPresent: () => {
            presented.held = true;
            queueMicrotask(() => {
              presented.held = false;
            });
          },
        });
        const atEffect = [];
        harness.signer.signMessage.mockImplementation(async () => {
          atEffect.push(['signature', presented.held]);
          return '0xsignature';
        });
        harness.signer.signTypedData.mockImplementation(async () => {
          atEffect.push(['signature', presented.held]);
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
        // The mint itself ran past main's gate, in its run, and the gate
        // ran again after it: the decision read again, then presented.
        expect(gate.pageToken.calls.map(([step]) => step)).toEqual(['mint', 'holds', 'present', 'discard']);
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
        // Before the mint, after it, and again before the grant's last use
        // (this signer has no last step of its own).
        expect(gate.beforeEffect).toHaveBeenCalledTimes(3);
        expect(gate.effectAllowed).toHaveBeenCalledTimes(3);
        expect(harness.dependencies.updateLastUsed).toHaveBeenCalledWith('example.com', 100, PAGE);
      });

      // Design 0012 (APB-1d): the Agent's decision mints the page's token
      // through main's issuer, and the signer is handed that token, never
      // none (main's own, `shell`).
      test('the signer presents the page-kind token the Agent\'s decision minted, burnt after', async () => {
        const harness = createHarness({ permission: { walletIndex: 0, chainId: 100 } });
        const pageToken = fakePageToken();
        const approval = jest.fn(async () => {
          expect(pageToken.mint).not.toHaveBeenCalled();
          return 'approved';
        });
        const provider = await harness.controller.handleRequest(attestedContext({ pageToken }, approval), {
          method,
          params,
          chainId: 100,
        });
        expect(provider).toMatchObject({ handled: true });
        const kind = method === 'personal_sign' ? 'sign-message' : 'sign-typed-data';
        expect(pageToken.mint).toHaveBeenCalledWith(
          kind,
          0,
          method === 'personal_sign' ? params[0] : params[1],
          method === 'personal_sign' ? {} : { chainId: 100 }
        );
        expect(pageToken.calls).toEqual([
          ['mint', kind, 0],
          ['holds', 'token-1'],
          ['present', 'token-1'],
          ['discard', 'token-1'],
        ]);
        expect(harness.dependencies.getSigner).toHaveBeenCalledTimes(1);
        // With main's gate as the signer's last step (`beforeSign`).
        expect(harness.dependencies.getSigner).toHaveBeenCalledWith(0, {
          confirmation: expect.objectContaining({ token: 'token-1', kind, page: expect.objectContaining({ agent: true }) }),
          beforeSign: expect.any(Function),
        });
        if (method === 'eth_signTypedData_v4') {
          // The hash the core bound is the one the signature must have.
          expect(harness.signer.signTypedData).toHaveBeenCalledWith(params[1], { expectedHash: '0xboundhash' });
        }
      });

      // Codex on #1246: the mint waits on the core, and the signer on its
      // own waits, long after main presented the token. Main's gate runs
      // after the mint, and again as the signer's last step, right before
      // the core or the device is asked.
      test('the name moving while the token is minted: no signer asked, nothing signed, the token burnt', async () => {
        const harness = createHarness({ permission: { walletIndex: 0, chainId: 100 } });
        const beforeEffect = jest.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
        const pageToken = fakePageToken();
        const provider = await harness.controller.handleRequest(attestedContext({ beforeEffect, pageToken }), {
          method,
          params,
          chainId: 100,
        });
        expect(provider).toMatchObject({ handled: true, error: { code: -32603 } });
        expect(pageToken.calls).toEqual([
          ['mint', expect.any(String), 0],
          ['discard', 'token-1'],
        ]);
        expect(harness.dependencies.getSigner).not.toHaveBeenCalled();
        expect(harness.signer[signerMethod]).not.toHaveBeenCalled();
      });

      test.each([
        ['the name moves', (gate) => gate.beforeEffect.mockResolvedValueOnce(false), 'no longer open'],
        ['the page leaves its key', (gate) => gate.effectAllowed.mockReturnValueOnce(false), 'no longer open'],
        ['the agent leaves the tab', (_gate, decision) => (decision.custody = false), 'no longer holds this tab'],
        ['nothing changes', () => {}, null],
      ])("when %s during the signer's own wait: its last step is main's gate, and a refusal signs nothing", async (_label, change, refused) => {
        const harness = createHarness({ permission: { walletIndex: 0, chainId: 100 } });
        const { decision, pageToken } = custodyToken();
        const gate = { beforeEffect: jest.fn(async () => true), effectAllowed: jest.fn(() => true), pageToken };
        const signer = heldSigner();
        harness.dependencies.getSigner.mockImplementation(signer.getSigner);
        const pending = harness.controller.handleRequest(attestedContext(gate), { method, params, chainId: 100 });
        await signer.reached;
        // Presented, and the signer waiting.
        expect(pageToken.calls.map(([step]) => step)).toEqual(['mint', 'holds', 'present']);
        change(gate, decision);
        signer.release();
        const provider = await pending;
        if (refused) {
          expect(provider).toMatchObject({ handled: true, error: { code: -32603, message: expect.stringContaining(refused) } });
          expect(signer.asked).toEqual([]);
          expect(harness.dependencies.updateLastUsed).not.toHaveBeenCalled();
        } else {
          expect(provider).toMatchObject({ handled: true });
          expect(signer.asked).toEqual([[signerMethod, expect.anything(), ...(signerMethod === 'signTypedData' ? [expect.anything()] : [])]]);
          expect(pageToken.calls.map(([step]) => step)).toEqual(['mint', 'holds', 'present', 'holds', 'discard']);
        }
        expect(pageToken.calls.at(-1)).toEqual(['discard', 'token-1']);
      });

      test('a token main refuses to present signs nothing, and is burnt', async () => {
        const harness = createHarness({ permission: { walletIndex: 0, chainId: 100 } });
        const pageToken = fakePageToken({
          onPresent: () => {
            throw new Error('Signing was not confirmed: the Agent no longer holds this tab');
          },
        });
        const provider = await harness.controller.handleRequest(attestedContext({ pageToken }), { method, params, chainId: 100 });
        expect(provider).toMatchObject({
          handled: true,
          error: { code: -32603, message: 'Signing was not confirmed: the Agent no longer holds this tab' },
        });
        expect(harness.signer[signerMethod]).not.toHaveBeenCalled();
        expect(pageToken.calls.at(-1)).toEqual(['discard', 'token-1']);
        expect(harness.dependencies.updateLastUsed).not.toHaveBeenCalled();
      });

      test("the name moving during the signature: signed, but the grant's last use untouched", async () => {
        const harness = createHarness({ permission: { walletIndex: 0, chainId: 100 } });
        // Holds before the mint and after it; moved once signed.
        const beforeEffect = jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false);
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

  test('returns EIP-1193 rejection and a typed Agent cancellation when declined', async () => {
    const harness = createHarness();
    const provider = await harness.controller.handleRequest(attested(jest.fn(async () => 'declined')), CONNECT);

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

  test.each(['eth_sendTransaction', 'eth_signTypedData_v4'])('refuses a conflicting explicit chain before %s approval', async method => {
    const harness = createHarness({ permission: { walletIndex: 0, chainId: 100 } });
    const approve = jest.fn(async () => 'approved');
    const address = '0x1111111111111111111111111111111111111111';
    const params = method === 'eth_sendTransaction'
      ? [{ from: address, to: address, value: '0x0', chainId: '0x1' }]
      : [address, JSON.stringify({ domain: { chainId: 1 }, types: {}, message: {} })];
    const result = await harness.controller.handleRequest(attestedPage(approve), request(method, params));
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
    await expect(harness.controller.handleRequest(attestedPage(approve), input)).resolves.toMatchObject({ result: '0xtransaction' });
    expect(harness.dependencies.signAndRecord.mock.calls[0][0].chainId).toBe(100);
  });

  test('keeps signatures out of the Agent receipt while returning them to the page', async () => {
    const harness = createHarness({ permission: { walletIndex: 0, chainId: 100 } });
    const approval = jest.fn(async () => 'approved');

    const provider = await harness.controller.handleRequest(
      attestedPage(approval),
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
      attestedPage(approval),
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
    expect(harness.signer.signTypedData).toHaveBeenCalledWith(JSON.stringify(typedData), { expectedHash: '0xboundhash' });
    expect(provider.receipt).toMatchObject({
      wallet: { action: 'signed', signatureType: 'eth_signTypedData_v4' },
    });
  });

  test('rejects a signature claiming a different connected account', async () => {
    const harness = createHarness({ permission: { walletIndex: 0, chainId: 100 } });
    const provider = await harness.controller.handleRequest(
      attestedPage(),
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

  // Design 0012 (APB-1d): a page's signature or send goes under its page,
  // with the token the Agent's decision mints through main's issuer. One
  // main didn't attest, or gave no issuer for, has no page to sign under:
  // refused before the Agent is asked, and nothing signs as main's own.
  test.each(['personal_sign', 'eth_signTypedData_v4', 'eth_sendTransaction'])(
    'a %s main did not attest, or gave no issuer for, is refused before approval or signer',
    async (method) => {
      const params = {
        personal_sign: ['Hello Freedom', '0x1111111111111111111111111111111111111111'],
        eth_signTypedData_v4: [
          '0x1111111111111111111111111111111111111111',
          { domain: { chainId: 100 }, types: { Mail: [{ name: 'a', type: 'uint256' }] }, primaryType: 'Mail', message: { a: 1 } },
        ],
        eth_sendTransaction: [{ to: '0x3333333333333333333333333333333333333333', value: '0x1' }],
      }[method];
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
        const result = await harness.controller.handleRequest(unattested, request(method, params));
        expect(result).toMatchObject({ handled: true, errorCode: ERROR_CODES.POLICY_DENIED });
        expect(unattested.requestApproval).not.toHaveBeenCalled();
        expect(harness.dependencies.getSigner).not.toHaveBeenCalled();
        expect(harness.dependencies.signAndRecord).not.toHaveBeenCalled();
      }
    }
  );

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
    await controller.handleRequest(attested(approve), CONNECT);
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
