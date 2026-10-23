describe('dapp-tx helpers', () => {
  test('decodes ERC-20 transfer calldata into ledger context', async () => {
    const { buildDappTxContext, decodeErc20Transfer } = await import('./dapp-tx.js');
    const recipient = '1111111111111111111111111111111111111111';
    const amount = 123456789n;
    const data = '0xa9059cbb' +
      recipient.padStart(64, '0') +
      amount.toString(16).padStart(64, '0');

    expect(decodeErc20Transfer(data)).toEqual({
      toAddress: `0x${recipient}`,
      amount: amount.toString(10),
    });
    expect(buildDappTxContext('https://app.example', {
      to: '0xTokenContract000000000000000000000000000000',
      data,
    })).toEqual({
      origin: 'https://app.example',
      asset: '0xtokencontract000000000000000000000000000000',
      toAddress: `0x${recipient}`,
      amount: amount.toString(10),
      metadata: { erc20Method: 'transfer' },
    });
  });

  test('leaves non-transfer calls as origin-only context', async () => {
    const { buildDappTxContext, decodeErc20Transfer } = await import('./dapp-tx.js');

    expect(decodeErc20Transfer('0x095ea7b3')).toBeNull();
    expect(buildDappTxContext('https://app.example', {
      to: '0xTokenContract000000000000000000000000000000',
      data: '0x095ea7b3',
    })).toEqual({ origin: 'https://app.example' });
  });
});

const { createDocument, createElement } = require('../../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;

const DAPP_TX_ELEMENT_IDS = [
  'sidebar-dapp-tx',
  'dapp-tx-back',
  'dapp-tx-site',
  'dapp-tx-to',
  'dapp-tx-value',
  'dapp-tx-data',
  'dapp-tx-data-row',
  'dapp-tx-network',
  'dapp-tx-fee',
  'dapp-tx-warning',
  'dapp-tx-unlock',
  'dapp-tx-touchid-btn',
  'dapp-tx-password-link',
  'dapp-tx-password-section',
  'dapp-tx-password-input',
  'dapp-tx-password-submit',
  'dapp-tx-error',
  'dapp-tx-reject',
  'dapp-tx-approve',
  'dapp-tx-auto-approve-row',
  'dapp-tx-auto-approve',
  'dapp-tx-fee-max',
  'dapp-tx-fee-note',
  'dapp-tx-fee-warning',
  'dapp-tx-fee-warning-text',
];

const LEDGER_INDEX = 1000000;

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function loadDappTx({ type = 'ledger' } = {}) {
  jest.resetModules();

  const elementsById = Object.fromEntries(
    DAPP_TX_ELEMENT_IDS.map((id) => [id, createElement('button')])
  );
  elementsById['dapp-tx-auto-approve'].checked = false;
  global.document = createDocument({ elementsById });

  const send = deferred();
  let minted = 0;
  const confirmSigning = jest.fn(async () => ({ success: true, token: `token-${++minted}` }));
  global.window = {
    dappPermissions: {
      getPermission: jest.fn().mockResolvedValue({ walletIndex: LEDGER_INDEX, chainId: 8453 }),
    },
    networks: {
      getChains: jest.fn().mockResolvedValue({
        success: true,
        chains: {
          8453: { name: 'Base', nativeSymbol: 'ETH' },
          100: { name: 'Gnosis', nativeSymbol: 'xDAI' },
        },
      }),
    },
    wallet: {
      getDerivedWallets: jest.fn().mockResolvedValue({
        success: true,
        wallets: [{ index: LEDGER_INDEX, address: '0xledger', type: 'ledger' }],
      }),
      estimateGas: jest.fn().mockResolvedValue({ success: true, gasLimit: '21000' }),
      getGasPrice: jest.fn().mockResolvedValue({
        success: true,
        type: 'legacy',
        gasPrice: '1000000000',
        effectiveGasPrice: '1000000000',
      }),
      confirmSigning,
      dappSendTransaction: jest.fn(() => send.promise),
      intentResend: jest.fn(),
      // The fee check at confirmation (design 0005, A): a fee like today's.
      feeCheck: jest.fn().mockResolvedValue({
        success: true,
        feeCheck: {
          maxCost: '21000000000000',
          comparable: true,
          ratio: '1',
          above: false,
          autoApprove: true,
        },
      }),
    },
  };

  // The Ledger account bypasses the vault-unlock gate, the same as in the app.
  jest.doMock('./wallet-utils.js', () => ({
    bypassUnlockGateForDevice: jest.fn((_index, _unlockEl, confirmBtn) => {
      if (confirmBtn) confirmBtn.disabled = false;
      return true;
    }),
    bypassUnlockGateForSafe: jest.fn(() => false),
    isSafeAccount: jest.fn(() => false),
    accountType: jest.fn(() => type),
    renderSafeFeePayer: jest.fn(),
    truncateAddress: jest.fn((address) => address),
    signingButtonLabel: jest.fn(() => 'Confirm on your Ledger…'),
  }));
  jest.doMock('./safe-signing.js', () => ({
    openSafeSigningBoard: jest.fn(),
    isSafeSigningBoardOpen: jest.fn(() => false),
  }));
  jest.doMock('./wallet-state.js', () => ({
    walletState: { identityView: createElement('div'), selectedChainId: 8453 },
    registerScreenHider: jest.fn(),
    hideAllSubscreens: jest.fn(),
  }));
  jest.doMock('../sidebar.js', () => ({ open: jest.fn() }));

  const mod = await import('./dapp-tx.js');
  mod.initDappTx();

  const txParams = {
    to: '0xToken00000000000000000000000000000000dead',
    value: '0',
    data: '0x095ea7b300000000000000000000000000000000000000000000000000000000000000ff',
  };

  async function openApproval({ webview = {}, requestChainId } = {}) {
    const settled = { state: 'pending' };
    const promise = mod
      .showDappTxApproval(webview, 'https://app.example', txParams, requestChainId)
      .then(
        (hash) => {
          settled.state = 'resolved';
          settled.value = hash;
        },
        (err) => {
          settled.state = 'rejected';
          settled.value = err;
        }
      );
    await flush();
    return { settled, promise };
  }

  // "Always allow" now travels with the confirmed send; main records the
  // rule from it (security audit O-7). One entry per send that asked for it.
  const rememberedRules = () =>
    window.wallet.dappSendTransaction.mock.calls
      .map((call) => call[3]?.rememberAutoApprove)
      .filter(Boolean);

  return { mod, elements: elementsById, send, rememberedRules, confirmSigning, openApproval, txParams };
}

describe('dapp-tx approval lifecycle', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  test('reject and back are inert while a Ledger signature is in flight', async () => {
    const { elements, send, rememberedRules, openApproval } = await loadDappTx();
    const { settled, promise } = await openApproval();

    elements['dapp-tx-auto-approve'].checked = true;
    elements['dapp-tx-approve'].dispatch('click');
    await flush();

    // Device prompt is up: the only two ways out of the screen are closed,
    // because the signature can no longer be recalled.
    expect(elements['dapp-tx-approve'].textContent).toBe('Confirm on your Ledger…');
    expect(elements['dapp-tx-reject'].disabled).toBe(true);
    expect(elements['dapp-tx-back'].disabled).toBe(true);

    elements['dapp-tx-reject'].dispatch('click');
    elements['dapp-tx-back'].dispatch('click');
    await flush();
    expect(settled.state).toBe('pending');

    send.resolve({ success: true, hash: '0xhash' });
    await promise;

    expect(settled).toMatchObject({ state: 'resolved', value: '0xhash' });
    expect(rememberedRules()).toHaveLength(1);
  });

  test('a second request cannot take the screen from an in-flight signature', async () => {
    const { elements, send, openApproval } = await loadDappTx();
    const first = await openApproval();

    elements['dapp-tx-approve'].dispatch('click');
    await flush();
    expect(elements['dapp-tx-reject'].disabled).toBe(true);

    // The device prompt for the first tx is still up: the newcomer is
    // refused rather than repainting the screen and re-enabling the way
    // out from under it.
    const second = await openApproval();
    expect(second.settled.state).toBe('rejected');
    expect(second.settled.value).toMatchObject({ code: -32002 });
    expect(elements['dapp-tx-reject'].disabled).toBe(true);
    expect(elements['dapp-tx-back'].disabled).toBe(true);
    expect(elements['dapp-tx-approve'].disabled).toBe(true);
    expect(elements['dapp-tx-approve'].textContent).toBe('Confirm on your Ledger…');

    // Cancelling now still cannot settle the first request behind the device.
    elements['dapp-tx-reject'].dispatch('click');
    await flush();
    expect(first.settled.state).toBe('pending');

    send.resolve({ success: true, hash: '0xhash' });
    await first.promise;
    expect(first.settled).toMatchObject({ state: 'resolved', value: '0xhash' });
  });

  // The per-module guard above only stops a second *transaction*. Every
  // other approval surface (dapp-sign, dapp-connect, x402, vault-unlock)
  // shares the same sidebar and takes it over via hideAllSubscreens(), so
  // the flight also has to hold the shared lock — that is what refuses
  // them while the device prompt is up.
  test('an in-flight signature holds the shared sidebar lock until it settles', async () => {
    const { elements, send, openApproval } = await loadDappTx();
    // After loadDappTx's resetModules, so this is the same lock instance
    // the module under test holds.
    const flight = await import('./signature-flight.js');
    const { promise } = await openApproval();

    expect(flight.isSignatureInFlight()).toBe(false);

    elements['dapp-tx-approve'].dispatch('click');
    await flush();
    expect(flight.isSignatureInFlight()).toBe(true);

    send.resolve({ success: true, hash: '0xhash' });
    await promise;
    expect(flight.isSignatureInFlight()).toBe(false);
  });

  test('rejecting before confirming settles 4001 and installs no auto-approve rule', async () => {
    const { elements, rememberedRules, openApproval } = await loadDappTx();
    const { settled, promise } = await openApproval();

    elements['dapp-tx-auto-approve'].checked = true;
    elements['dapp-tx-reject'].dispatch('click');
    await promise;

    expect(settled.state).toBe('rejected');
    expect(settled.value).toMatchObject({ code: 4001 });
    expect(rememberedRules()).toHaveLength(0);
    // Closing clears the checkbox so the intent cannot leak into the next request.
    expect(elements['dapp-tx-auto-approve'].checked).toBe(false);
  });

  test('auto-approve intent does not leak into the next request', async () => {
    const { elements, send, rememberedRules, openApproval } = await loadDappTx();
    const first = await openApproval();

    elements['dapp-tx-auto-approve'].checked = true;
    elements['dapp-tx-approve'].dispatch('click');
    send.resolve({ success: true, hash: '0xhash' });
    await first.promise;
    expect(rememberedRules()).toHaveLength(1);
    expect(elements['dapp-tx-auto-approve'].checked).toBe(false);

    const second = await openApproval();
    expect(elements['dapp-tx-auto-approve'].checked).toBe(false);
    expect(elements['dapp-tx-reject'].disabled).toBe(false);
    elements['dapp-tx-approve'].dispatch('click');
    await second.promise;

    expect(second.settled).toMatchObject({ state: 'resolved', value: '0xhash' });
    expect(rememberedRules()).toHaveLength(1);
  });
  test('an onchain app is quoted, signed and recorded on the chain it is pinned to', async () => {
    const { elements, send, rememberedRules, confirmSigning, openApproval, txParams } =
      await loadDappTx();
    // Stored grant and the wallet's current selection both say Base (8453);
    // the app's own origin is pinned to Gnosis (100) and must win. Anything
    // else signs and broadcasts on a chain the app never asked for, while
    // eth_chainId keeps reporting 0x64.
    const webview = {
      getURL: () => 'web3://0x00000095643cffa7d9fae407a84dfcb6406456c6.eip155-100/swap',
    };
    const { promise } = await openApproval({ webview });

    expect(elements['dapp-tx-network'].textContent).toBe('Gnosis');
    expect(window.wallet.estimateGas).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 100 })
    );
    expect(window.wallet.getGasPrice).toHaveBeenCalledWith(100);

    elements['dapp-tx-auto-approve'].checked = true;
    elements['dapp-tx-approve'].dispatch('click');
    send.resolve({ success: true, hash: '0xhash' });
    await promise;

    expect(window.wallet.dappSendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 100 }),
      LEDGER_INDEX,
      expect.anything(),
      { confirmation: 'token-1', rememberAutoApprove: 'https://app.example' }
    );
    // The confirmation — and so the rule main files from it — is bound to
    // the transaction on the chain the next request checks, and to the site
    // the payment is recorded under.
    const [sentTx, , context] = window.wallet.dappSendTransaction.mock.calls[0];
    expect(confirmSigning).toHaveBeenCalledWith('dapp-send', LEDGER_INDEX, {
      ...sentTx,
      origin: 'https://app.example',
    });
    expect(context.origin).toBe('https://app.example');
    expect(sentTx).toMatchObject({ to: txParams.to, data: txParams.data, chainId: 100 });
    expect(rememberedRules()).toEqual(['https://app.example']);
  });

  // Review of #788, round 3: a dApp's Safe transaction is confirmed for the
  // site, which main records its payment under (D12).
  test("a Safe account's transaction is confirmed for the site that asked", async () => {
    const { elements, confirmSigning, openApproval, txParams } = await loadDappTx();
    const utils = await import('./wallet-utils.js');
    utils.isSafeAccount.mockReturnValue(true);
    window.addEventListener = jest.fn();
    window.removeEventListener = jest.fn();
    window.wallet.safeSend = jest.fn(async () => ({
      success: true,
      state: { safeTxHash: '0x' + '5a'.repeat(32) },
    }));
    await openApproval({ requestChainId: 100 });

    elements['dapp-tx-approve'].dispatch('click');
    await flush();
    await flush();

    const safeTx = { to: txParams.to, value: '0', data: txParams.data };
    expect(confirmSigning).toHaveBeenCalledWith('safe-send', LEDGER_INDEX, {
      tx: safeTx,
      chainId: 100,
      origin: 'https://app.example',
    });
    const [, , display] = window.wallet.safeSend.mock.calls[0];
    expect(display.site).toBe('https://app.example');
  });

  test('every Confirm mints a fresh confirmation for exactly the transaction it sends', async () => {
    const { elements, send, confirmSigning, openApproval } = await loadDappTx();
    const first = await openApproval();
    elements['dapp-tx-approve'].dispatch('click');
    send.resolve({ success: true, hash: '0xhash' });
    await first.promise;
    const second = await openApproval();
    elements['dapp-tx-approve'].dispatch('click');
    await second.promise;

    const calls = window.wallet.dappSendTransaction.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call[3])).toEqual([
      { confirmation: 'token-1' },
      { confirmation: 'token-2' },
    ]);
    expect(confirmSigning.mock.calls).toEqual([
      ['dapp-send', LEDGER_INDEX, { ...calls[0][0], origin: 'https://app.example' }],
      ['dapp-send', LEDGER_INDEX, { ...calls[1][0], origin: 'https://app.example' }],
    ]);
  });

  test('a refused confirmation never reaches the signing call', async () => {
    const { elements, confirmSigning, openApproval } = await loadDappTx();
    confirmSigning.mockResolvedValueOnce({ success: false, error: 'Invalid gasLimit' });
    const { settled } = await openApproval();

    elements['dapp-tx-approve'].dispatch('click');
    await flush();
    await flush();

    expect(window.wallet.dappSendTransaction).not.toHaveBeenCalled();
    expect(settled.state).toBe('pending');
    expect(elements['dapp-tx-reject'].disabled).toBe(false);
  });

  test('the chain the provider resolved outranks the grant and the selection', async () => {
    const { elements, openApproval } = await loadDappTx();
    await openApproval({ requestChainId: 100 });

    expect(elements['dapp-tx-network'].textContent).toBe('Gnosis');
    expect(window.wallet.getGasPrice).toHaveBeenCalledWith(100);
  });
});

describe('Confirm again after a failed dApp send (5)', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  const HELD = {
    intentId: '7b0c6c1e-0c62-4a6e-9a49-0d6a3f6d1a02',
    chainId: 8453,
    sender: '0xledger',
    nonce: 4,
    hash: '0x' + 'cd'.repeat(32),
    state: 'held',
    kind: 'dapp-send',
    origin: 'https://app.example',
  };

  test('a refused send turns Confirm into Send again, which sends the same payment', async () => {
    const { elements, send, confirmSigning, openApproval } = await loadDappTx();
    const { settled, promise } = await openApproval();

    elements['dapp-tx-approve'].dispatch('click');
    send.resolve({
      success: false,
      error: 'Insufficient funds for transaction',
      outcome: 'rejected',
      reasonClass: 'insufficient funds',
      intentId: HELD.intentId,
      intent: HELD,
    });
    await flush();
    await flush();

    // The request is still open, and the screen says what happened.
    expect(settled.state).toBe('pending');
    expect(elements['dapp-tx-error'].textContent).toBe(
      'The network refused it: insufficient funds'
    );
    expect(elements['dapp-tx-approve'].textContent).toBe('Send again');
    expect(elements['dapp-tx-approve'].disabled).toBe(false);

    window.wallet.intentResend.mockResolvedValue({ success: true, hash: HELD.hash, resent: true });
    elements['dapp-tx-approve'].dispatch('click');
    await promise;

    expect(confirmSigning).toHaveBeenLastCalledWith('intent-resend', null, {
      intentId: HELD.intentId,
      chainId: 8453,
      sender: '0xledger',
      nonce: 4,
      hash: HELD.hash,
    });
    expect(window.wallet.intentResend).toHaveBeenCalledWith(HELD.intentId, {
      confirmation: 'token-2',
    });
    // One payment was signed; the dApp gets its hash.
    expect(window.wallet.dappSendTransaction).toHaveBeenCalledTimes(1);
    expect(settled).toMatchObject({ state: 'resolved', value: HELD.hash });
  });

  test('a second failure keeps Send again, with the newest outcome', async () => {
    const { elements, send, openApproval } = await loadDappTx();
    const { settled } = await openApproval();
    elements['dapp-tx-approve'].dispatch('click');
    send.resolve({ success: false, error: 'not ready', outcome: 'not_sent', intent: HELD });
    await flush();
    await flush();
    expect(elements['dapp-tx-error'].textContent).toBe('Not sent; nothing left this computer');

    window.wallet.intentResend.mockResolvedValue({
      success: false,
      error: 'Insufficient funds for transaction',
      outcome: 'rejected',
      reasonClass: 'insufficient funds',
      intent: HELD,
    });
    elements['dapp-tx-approve'].dispatch('click');
    await flush();
    await flush();
    expect(elements['dapp-tx-error'].textContent).toBe(
      'The network refused it: insufficient funds'
    );
    expect(elements['dapp-tx-approve'].textContent).toBe('Send again');
    expect(window.wallet.dappSendTransaction).toHaveBeenCalledTimes(1);
    expect(settled.state).toBe('pending');
  });

  test('a failure before any payment existed leaves Confirm as a new send, as before', async () => {
    const { elements, send, openApproval } = await loadDappTx();
    await openApproval();
    elements['dapp-tx-approve'].dispatch('click');
    send.resolve({ success: false, error: 'Rejected on the Ledger' });
    await flush();
    await flush();
    expect(elements['dapp-tx-approve'].textContent).toBe('Confirm');
    expect(elements['dapp-tx-error'].textContent).toBe('Rejected on the Ledger');

    elements['dapp-tx-approve'].dispatch('click');
    await flush();
    expect(window.wallet.dappSendTransaction).toHaveBeenCalledTimes(2);
    expect(window.wallet.intentResend).not.toHaveBeenCalled();
  });

  // D13: a phone signs and broadcasts itself, so its lost answer leaves the
  // payment possibly sent; confirming again would ask the phone to pay again.
  test("a phone's lost answer disables Confirm and says to check the phone first", async () => {
    const { elements, send, openApproval } = await loadDappTx();
    const { settled } = await openApproval();
    const message =
      "No answer came back from your phone, so it's unknown whether this payment was sent. " +
      "Check your phone's wallet before you try again.";
    elements['dapp-tx-approve'].dispatch('click');
    send.resolve({ success: false, code: 'REMOTE_OUTCOME_UNKNOWN', error: message });
    await flush();
    await flush();

    expect(elements['dapp-tx-error'].textContent).toBe(message);
    expect(elements['dapp-tx-approve'].disabled).toBe(true);
    expect(elements['dapp-tx-approve'].textContent).toBe('Confirm');
    elements['dapp-tx-approve'].dispatch('click');
    await flush();
    expect(window.wallet.dappSendTransaction).toHaveBeenCalledTimes(1);
    expect(settled.state).toBe('pending');
  });

  // D13: a site told "rejected" (4001) may send the request again, and the
  // phone could pay twice. Leaving the approval tells it the outcome is
  // unknown instead.
  test.each(['dapp-tx-reject', 'dapp-tx-back'])(
    'after a lost answer, leaving with %s tells the site the outcome is unknown, never 4001',
    async (button) => {
      const { elements, send, openApproval } = await loadDappTx();
      const { settled, promise } = await openApproval();
      elements['dapp-tx-approve'].dispatch('click');
      send.resolve({ success: false, code: 'REMOTE_OUTCOME_UNKNOWN', error: 'lost' });
      await flush();
      await flush();

      elements[button].dispatch('click');
      await promise;
      expect(settled).toEqual({
        state: 'rejected',
        value: {
          code: -32603,
          message:
            "The payment's outcome is unknown: it may have been sent. Check the wallet before retrying.",
          data: { outcome: 'unknown' },
        },
      });
    }
  );

  test("the phone's own rejection is still 4001: nothing was sent", async () => {
    const { elements, send, openApproval } = await loadDappTx();
    const { settled, promise } = await openApproval();
    elements['dapp-tx-approve'].dispatch('click');
    send.resolve({
      success: false,
      code: 'REMOTE_USER_REJECTED',
      error: 'Request rejected on your phone.',
    });
    await flush();
    await flush();

    elements['dapp-tx-reject'].dispatch('click');
    await promise;
    expect(settled.value).toEqual({ code: 4001, message: 'User rejected the request' });
  });

  // 709-B1: an approval that left a held payment only ever sends that
  // payment again; it never signs a new one, whatever a resend's reply.
  async function refusedApproval() {
    const loaded = await loadDappTx();
    const opened = await loaded.openApproval();
    loaded.elements['dapp-tx-approve'].dispatch('click');
    loaded.send.resolve({
      success: false,
      error: 'Insufficient funds for transaction',
      outcome: 'rejected',
      intentId: HELD.intentId,
      intent: HELD,
    });
    await flush();
    await flush();
    return { ...loaded, ...opened };
  }

  const press = async (elements) => {
    elements['dapp-tx-approve'].dispatch('click');
    await flush();
    await flush();
  };

  test('an authorization refusal that names nothing keeps Send again for the same payment', async () => {
    const { elements, settled } = await refusedApproval();
    window.wallet.intentResend.mockResolvedValue({
      success: false,
      code: 'SIGNING_NOT_CONFIRMED',
      error: 'Signing was not confirmed: confirmation expired',
    });
    await press(elements);
    await press(elements);
    expect(elements['dapp-tx-approve'].textContent).toBe('Send again');
    expect(window.wallet.intentResend).toHaveBeenCalledTimes(2);
    expect(window.wallet.dappSendTransaction).toHaveBeenCalledTimes(1);
    expect(settled.state).toBe('pending');
  });

  test("a stale confirmation is minted again against main's current hash, and the dApp gets that hash", async () => {
    const { elements, confirmSigning, settled } = await refusedApproval();
    const replaced = { ...HELD, hash: '0x' + 'ef'.repeat(32) };
    window.wallet.intentResend
      .mockResolvedValueOnce({
        success: false,
        code: 'SIGNING_NOT_CONFIRMED',
        error: 'Signing was not confirmed',
        intentId: HELD.intentId,
        intent: replaced,
      })
      .mockResolvedValueOnce({ success: true, hash: replaced.hash, resent: true });
    await press(elements);
    const hashes = confirmSigning.mock.calls
      .filter(([kind]) => kind === 'intent-resend')
      .map(([, , payload]) => payload.hash);
    expect(hashes).toEqual([HELD.hash, replaced.hash]);
    expect(settled).toMatchObject({ state: 'resolved', value: replaced.hash });
    expect(window.wallet.dappSendTransaction).toHaveBeenCalledTimes(1);
  });

  test('a payment main reports settled leaves Confirm disabled: nothing to send, nothing new to sign', async () => {
    const { elements, settled } = await refusedApproval();
    window.wallet.intentResend.mockResolvedValue({
      success: false,
      code: 'INTENT_NOT_HELD',
      error: 'This payment is already settled.',
      intentId: HELD.intentId,
      intent: { ...HELD, state: 'settled' },
    });
    await press(elements);
    expect(elements['dapp-tx-approve'].disabled).toBe(true);
    expect(elements['dapp-tx-error'].textContent).toBe('This payment is already settled.');
    await press(elements);
    expect(window.wallet.intentResend).toHaveBeenCalledTimes(1);
    expect(window.wallet.dappSendTransaction).toHaveBeenCalledTimes(1);
    expect(elements['dapp-tx-reject'].disabled).toBe(false);
    expect(settled.state).toBe('pending');
  });

  test('a first failure naming a payment main no longer holds disables Confirm too', async () => {
    const { elements, send, openApproval } = await loadDappTx();
    await openApproval();
    elements['dapp-tx-approve'].dispatch('click');
    send.resolve({
      success: false,
      error: 'voided',
      intentId: HELD.intentId,
      intent: { ...HELD, state: 'voided' },
    });
    await flush();
    await flush();
    expect(elements['dapp-tx-approve'].disabled).toBe(true);
  });
});

describe('dapp-tx: the fee check at confirmation (design 0005, A)', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  const ABOVE = {
    maxCost: '420000000000000',
    comparable: true,
    ratio: '20',
    above: true,
    autoApprove: false,
  };
  const shown = (element) => !element.classList.contains('hidden');
  const press = async (elements) => {
    elements['dapp-tx-approve'].dispatch('click');
    await flush();
  };

  test('the approval shows the most the transaction can cost, and how its fee compares', async () => {
    const { elements, confirmSigning, openApproval } = await loadDappTx();
    await openApproval();
    expect(window.wallet.feeCheck).toHaveBeenCalledWith({
      chainId: 8453,
      gasLimit: '21000',
      gasPrice: '1000000000',
    });
    expect(elements['dapp-tx-fee-max'].textContent).toBe('Up to 0.000021 ETH');
    expect(elements['dapp-tx-fee-note'].textContent).toBe("About 1× today's network fee");
    expect(shown(elements['dapp-tx-fee-warning'])).toBe(false);
    await press(elements);
    expect(confirmSigning.mock.calls[0]).toHaveLength(3);
  });

  test('a fee far above today’s is confirmed twice before anything is signed', async () => {
    const { elements, confirmSigning, openApproval } = await loadDappTx();
    window.wallet.feeCheck.mockResolvedValue({ success: true, feeCheck: ABOVE });
    await openApproval();
    expect(shown(elements['dapp-tx-fee-warning'])).toBe(true);
    expect(elements['dapp-tx-fee-warning-text'].textContent).toBe(
      "This network fee is 20× today's network fee."
    );
    await press(elements);
    expect(confirmSigning).not.toHaveBeenCalled();
    expect(elements['dapp-tx-approve'].textContent).toBe('Send anyway');
    await press(elements);
    expect(confirmSigning).toHaveBeenCalledWith(
      'dapp-send',
      LEDGER_INDEX,
      expect.objectContaining({ gasPrice: '1000000000', origin: 'https://app.example' }),
      { feeAcknowledged: true }
    );
    expect(window.wallet.dappSendTransaction).toHaveBeenCalled();
  });

  test('a fee newly above at the press: nothing signed, and the approval asks again', async () => {
    const { elements, confirmSigning, openApproval } = await loadDappTx();
    await openApproval();
    confirmSigning.mockResolvedValueOnce({
      success: false,
      code: 'FEE_CHECK_ASK_AGAIN',
      error: "The network fee is 20× today's network fee. Confirm it again to send.",
      feeCheck: { ...ABOVE, askAgain: true },
    });
    await press(elements);
    expect(window.wallet.dappSendTransaction).not.toHaveBeenCalled();
    expect(elements['dapp-tx-approve'].textContent).toBe('Send anyway');
    expect(elements['dapp-tx-approve'].disabled).toBe(false);
    expect(elements['dapp-tx-reject'].disabled).toBe(false);
    // No error: the approval asks.
    expect(elements['dapp-tx-error'].textContent).toBe('');
    expect(elements['dapp-tx-fee-warning-text'].textContent).toBe(
      "This network fee is 20× today's network fee. Check the fee, then press Send anyway to pay it."
    );
    await press(elements);
    expect(confirmSigning).toHaveBeenLastCalledWith(
      'dapp-send',
      LEDGER_INDEX,
      expect.any(Object),
      { feeAcknowledged: true }
    );
    expect(window.wallet.dappSendTransaction).toHaveBeenCalledTimes(1);
  });

  test('a phone picks and pays its own fee: there is none to check', async () => {
    const { elements, confirmSigning, openApproval } = await loadDappTx({ type: 'remote' });
    await openApproval();
    expect(window.wallet.feeCheck).not.toHaveBeenCalled();
    expect(shown(elements['dapp-tx-fee-max'])).toBe(false);
    await press(elements);
    expect(confirmSigning).toHaveBeenCalled();
  });
});
