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

async function loadDappTx() {
  jest.resetModules();

  const elementsById = Object.fromEntries(
    DAPP_TX_ELEMENT_IDS.map((id) => [id, createElement('button')])
  );
  elementsById['dapp-tx-auto-approve'].checked = false;
  global.document = createDocument({ elementsById });

  const send = deferred();
  const addTransactionAutoApprove = jest.fn().mockResolvedValue({ success: true });
  global.window = {
    dappPermissions: {
      getPermission: jest.fn().mockResolvedValue({ walletIndex: LEDGER_INDEX, chainId: 8453 }),
      addTransactionAutoApprove,
    },
    networks: {
      getChains: jest.fn().mockResolvedValue({
        success: true,
        chains: { 8453: { name: 'Base', nativeSymbol: 'ETH' } },
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
      dappSendTransaction: jest.fn(() => send.promise),
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

  async function openApproval() {
    const settled = { state: 'pending' };
    const promise = mod.showDappTxApproval({}, 'https://app.example', txParams).then(
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

  return { mod, elements: elementsById, send, addTransactionAutoApprove, openApproval, txParams };
}

describe('dapp-tx approval lifecycle', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  test('reject and back are inert while a Ledger signature is in flight', async () => {
    const { elements, send, addTransactionAutoApprove, openApproval } = await loadDappTx();
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
    expect(addTransactionAutoApprove).toHaveBeenCalledTimes(1);
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
    const { elements, addTransactionAutoApprove, openApproval } = await loadDappTx();
    const { settled, promise } = await openApproval();

    elements['dapp-tx-auto-approve'].checked = true;
    elements['dapp-tx-reject'].dispatch('click');
    await promise;

    expect(settled.state).toBe('rejected');
    expect(settled.value).toMatchObject({ code: 4001 });
    expect(addTransactionAutoApprove).not.toHaveBeenCalled();
    // Closing clears the checkbox so the intent cannot leak into the next request.
    expect(elements['dapp-tx-auto-approve'].checked).toBe(false);
  });

  test('auto-approve intent does not leak into the next request', async () => {
    const { elements, send, addTransactionAutoApprove, openApproval } = await loadDappTx();
    const first = await openApproval();

    elements['dapp-tx-auto-approve'].checked = true;
    elements['dapp-tx-approve'].dispatch('click');
    send.resolve({ success: true, hash: '0xhash' });
    await first.promise;
    expect(addTransactionAutoApprove).toHaveBeenCalledTimes(1);
    expect(elements['dapp-tx-auto-approve'].checked).toBe(false);

    const second = await openApproval();
    expect(elements['dapp-tx-auto-approve'].checked).toBe(false);
    expect(elements['dapp-tx-reject'].disabled).toBe(false);
    elements['dapp-tx-approve'].dispatch('click');
    await second.promise;

    expect(second.settled).toMatchObject({ state: 'resolved', value: '0xhash' });
    expect(addTransactionAutoApprove).toHaveBeenCalledTimes(1);
  });
});
