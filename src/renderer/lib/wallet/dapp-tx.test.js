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

async function loadDappTx({ safe = false } = {}) {
  jest.resetModules();

  const elementsById = Object.fromEntries(
    DAPP_TX_ELEMENT_IDS.map((id) => [id, createElement('button')])
  );
  elementsById['dapp-tx-auto-approve'].checked = false;
  // As in index.html: the prompt starts hidden.
  elementsById['sidebar-dapp-tx'].classList.add('hidden');
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
      safeSend: jest.fn(async () => ({ success: true, state: { safeTxHash: '0xsafetx' } })),
    },
  };
  // The Safe board settles a dApp transaction through window events.
  const listeners = {};
  window.addEventListener = (type, fn) => (listeners[type] ||= new Set()).add(fn);
  window.removeEventListener = (type, fn) => listeners[type]?.delete(fn);
  window.dispatchEvent = (event) => [...(listeners[event.type] || [])].forEach((fn) => fn(event));

  // The Ledger account bypasses the vault-unlock gate, the same as in the app.
  jest.doMock('./wallet-utils.js', () => ({
    bypassUnlockGateForDevice: jest.fn((_index, _unlockEl, confirmBtn) => {
      if (confirmBtn) confirmBtn.disabled = false;
      return true;
    }),
    bypassUnlockGateForSafe: jest.fn(() => false),
    isSafeAccount: jest.fn(() => safe),
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

  // The screen hider this module registered (another screen opening).
  const hideForOtherScreen = () => require('./wallet-state.js').registerScreenHider.mock.calls[0][0]();

  return {
    mod,
    elements: elementsById,
    send,
    rememberedRules,
    confirmSigning,
    openApproval,
    txParams,
    hideForOtherScreen,
  };
}

describe('dapp-tx approval lifecycle', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  test('a newcomer never replaces the transaction on screen', async () => {
    const { mod, elements, send, openApproval, txParams } = await loadDappTx();
    const first = await openApproval();

    // Another page asks while the user reads the first transaction.
    const other = { to: '0xAttacker000000000000000000000000000000beef', value: '5', data: '0x' };
    const second = mod.showDappTxApproval({}, 'https://other.example', other);
    await expect(second).rejects.toMatchObject({ code: -32002 });
    expect(elements['dapp-tx-site'].textContent).toBe('https://app.example');

    // Confirm sends what was shown: the first transaction.
    elements['dapp-tx-approve'].dispatch('click');
    await flush();
    expect(window.wallet.dappSendTransaction.mock.calls[0][0]).toMatchObject({
      to: txParams.to,
      data: txParams.data,
    });
    send.resolve({ success: true, hash: '0xhash' });
    await first.promise;
    expect(first.settled.state).toBe('resolved');

    // Answered: the next request is served.
    const third = await openApproval();
    expect(third.settled.state).toBe('pending');
  });

  describe('a Safe request parked on its board while a newer one shows', () => {
    const boardEvent = (type, detail) => window.dispatchEvent({ type, detail });

    async function parkSafeThenShowNewcomer() {
      const env = await loadDappTx({ safe: true });
      const { mod, elements, openApproval, hideForOtherScreen } = env;
      const a = await openApproval();
      elements['dapp-tx-approve'].dispatch('click');
      await flush();
      expect(window.wallet.safeSend).toHaveBeenCalledTimes(1);
      // The board takes the sidebar (hides the tx screen); the user parks it.
      hideForOtherScreen();
      const b = mod.showDappTxApproval({}, 'https://b.example', { to: '0xB0000000000000000000000000000000000000bb', value: '2', data: '0x' });
      b.catch(() => {});
      await flush();
      expect(elements['sidebar-dapp-tx'].classList.contains('hidden')).toBe(false);
      expect(elements['dapp-tx-site'].textContent).toBe('https://b.example');
      return { ...env, a, b };
    }

    test('discarding it answers it, not the newcomer, and leaves the newcomer on screen', async () => {
      const { a, b, elements } = await parkSafeThenShowNewcomer();
      const bState = { state: 'pending' };
      b.then(() => (bState.state = 'resolved'), () => (bState.state = 'rejected'));

      boardEvent('wallet:safe-discarded', { safeIndex: LEDGER_INDEX });
      await a.promise;
      await flush();
      expect(a.settled).toMatchObject({ state: 'rejected', value: { code: 4001 } });
      expect(bState.state).toBe('pending');
      expect(elements['sidebar-dapp-tx'].classList.contains('hidden')).toBe(false);
      expect(elements['dapp-tx-site'].textContent).toBe('https://b.example');
    });

    test('its execution answers it and leaves the newcomer on screen', async () => {
      const { a, b, elements } = await parkSafeThenShowNewcomer();
      const bState = { state: 'pending' };
      b.then(() => (bState.state = 'resolved'), () => (bState.state = 'rejected'));

      boardEvent('wallet:safe-executed', { safeTxHash: '0xsafetx', hash: '0xexec' });
      await a.promise;
      await flush();
      expect(a.settled).toMatchObject({ state: 'resolved', value: '0xexec' });
      expect(bState.state).toBe('pending');
      expect(elements['sidebar-dapp-tx'].classList.contains('hidden')).toBe(false);

      // The newcomer is still answerable from its own screen.
      elements['dapp-tx-reject'].dispatch('click');
      await flush();
      expect(bState.state).toBe('rejected');
    });
  });

  test('a prompt another screen hid holds off nothing', async () => {
    const { openApproval, hideForOtherScreen } = await loadDappTx();
    await openApproval();

    hideForOtherScreen();
    const second = await openApproval();
    expect(second.settled.state).toBe('pending');
  });

  test('a failed preparation answers the dApp and holds off nothing', async () => {
    const { openApproval } = await loadDappTx();
    window.networks.getChains.mockRejectedValueOnce(new Error('chains unavailable'));
    const first = await openApproval();
    await first.promise;
    expect(first.settled).toMatchObject({ state: 'rejected', value: { message: 'chains unavailable' } });

    const second = await openApproval();
    expect(second.settled.state).toBe('pending');
  });

  test("a replaced request's late preparation never shows its details under the newcomer", async () => {
    const { mod, elements, send } = await loadDappTx();
    const gasA = deferred();
    window.wallet.estimateGas.mockReturnValueOnce(gasA.promise);
    // A paints its recipient, then waits on its quote; it isn't shown yet.
    const a = mod.showDappTxApproval({}, 'https://a.example', { to: '0xA0000000000000000000000000000000000000aa', value: '1', data: '0x' });
    await flush();
    expect(elements['sidebar-dapp-tx'].classList.contains('hidden')).toBe(true);

    // B replaces A; B's chain lookup is slow.
    const chainsB = deferred();
    window.networks.getChains.mockReturnValueOnce(chainsB.promise);
    const b = mod.showDappTxApproval({}, 'https://b.example', { to: '0xB0000000000000000000000000000000000000bb', value: '2', data: '0x' });
    b.catch(() => {});
    await flush();
    await expect(a).rejects.toMatchObject({ code: 4001 });

    // A's quote lands first: nothing is shown.
    gasA.resolve({ success: true, gasLimit: '21000' });
    await flush();
    expect(elements['sidebar-dapp-tx'].classList.contains('hidden')).toBe(true);

    // B shows with B's details, and Confirm sends B.
    chainsB.resolve({ success: true, chains: { 8453: { name: 'Base', nativeSymbol: 'ETH' } } });
    await flush();
    expect(elements['sidebar-dapp-tx'].classList.contains('hidden')).toBe(false);
    expect(elements['dapp-tx-to'].title).toBe('0xB0000000000000000000000000000000000000bb');
    expect(elements['dapp-tx-site'].textContent).toBe('https://b.example');
    elements['dapp-tx-approve'].dispatch('click');
    await flush();
    expect(window.wallet.dappSendTransaction.mock.calls[0][0].to).toBe('0xB0000000000000000000000000000000000000bb');
    send.resolve({ success: true, hash: '0xhash' });
    await expect(b).resolves.toBe('0xhash');
  });

  test('a prompt shown while this one prepared keeps the screen', async () => {
    const { mod, elements } = await loadDappTx();
    const gas = deferred();
    window.wallet.estimateGas.mockReturnValueOnce(gas.promise);
    const pending = mod.showDappTxApproval({}, 'https://app.example', { to: '0xA0000000000000000000000000000000000000aa', value: '1', data: '0x' });
    await flush();
    // Another prompt (Connect or Sign) appears meanwhile.
    (await import('./dapp-prompt-guard.js')).registerDappPrompt(() => true);
    gas.resolve({ success: true, gasLimit: '21000' });
    await expect(pending).rejects.toMatchObject({ code: -32002 });
    expect(elements['sidebar-dapp-tx'].classList.contains('hidden')).toBe(true);
  });

  test('a quote that lands after its request was replaced is dropped', async () => {
    const { openApproval, elements } = await loadDappTx();
    const gas = deferred();
    window.wallet.estimateGas.mockReturnValueOnce(gas.promise);
    // Never shown (its quote is still out), so a newcomer may replace it.
    await openApproval();
    const second = await openApproval();
    const fee = elements['dapp-tx-fee'].textContent;

    gas.resolve({ success: true, gasLimit: '999999' });
    await flush();
    expect(elements['dapp-tx-fee'].textContent).toBe(fee);
    elements['dapp-tx-approve'].dispatch('click');
    await flush();
    expect(window.wallet.dappSendTransaction.mock.calls[0][0].gasLimit).not.toBe('999999');
    expect(second.settled.state).toBe('pending');
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
    // the transaction on the chain the next request checks.
    const [sentTx] = window.wallet.dappSendTransaction.mock.calls[0];
    expect(confirmSigning).toHaveBeenCalledWith('dapp-send', LEDGER_INDEX, sentTx);
    expect(sentTx).toMatchObject({ to: txParams.to, data: txParams.data, chainId: 100 });
    expect(rememberedRules()).toEqual(['https://app.example']);
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
      ['dapp-send', LEDGER_INDEX, calls[0][0]],
      ['dapp-send', LEDGER_INDEX, calls[1][0]],
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
