const { createDocument, createElement } = require('../../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;

const ELEMENT_IDS = [
  'sidebar-identity',
  'sidebar-connect-vaughan',
  'connect-vaughan-back',
  'connect-vaughan-detect',
  'connect-vaughan-status-text',
  'connect-vaughan-accounts-step',
  'connect-vaughan-account-list',
  'connect-vaughan-name-input',
  'connect-vaughan-submit',
  'connect-vaughan-error',
  'connect-vaughan-success',
  'connect-vaughan-result-name',
  'connect-vaughan-result-address',
  'connect-vaughan-done',
];

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function loadConnectVaughan({ getAccounts }) {
  jest.resetModules();

  const elementsById = Object.fromEntries(
    ELEMENT_IDS.map((id) => {
      const tag =
        id.includes('input') ? 'input' : id.includes('list') || id.includes('error') ? 'div' : 'button';
      return [id, createElement(tag)];
    })
  );
  elementsById['sidebar-connect-vaughan'].classList.add('hidden');
  elementsById['connect-vaughan-detect'].classList.add('hidden');
  elementsById['connect-vaughan-accounts-step'].classList.add('hidden');
  elementsById['connect-vaughan-success'].classList.add('hidden');
  elementsById['connect-vaughan-error'].classList.add('hidden');
  elementsById['connect-vaughan-submit'].disabled = true;
  elementsById['connect-vaughan-submit'].textContent = 'Add Account';

  global.document = createDocument({ elementsById });
  global.window = {
    vaughan: {
      getAccounts,
      addAccount: jest.fn(),
    },
    wallet: {
      setActiveWallet: jest.fn(async () => ({ success: true })),
    },
  };

  jest.doMock('./wallet-state.js', () => ({
    walletState: {
      identityView: elementsById['sidebar-identity'],
      derivedWallets: [],
      activeWalletIndex: 0,
      fullAddresses: { wallet: '' },
    },
    registerScreenHider: jest.fn(),
  }));
  jest.doMock('./signature-flight.js', () => ({
    refuseSubscreenWhileInFlight: jest.fn(() => false),
  }));
  jest.doMock('./wallet-selector.js', () => ({
    loadDerivedWallets: jest.fn(async () => {}),
    updateWalletSelectorDisplay: jest.fn(),
  }));
  jest.doMock('./balance-display.js', () => ({
    refreshBalances: jest.fn(),
  }));
  jest.doMock('./wallet-utils.js', () => ({
    escapeHtml: (text) => String(text ?? ''),
    truncateAddress: (address) => address,
  }));

  const mod = await import('./connect-vaughan.js');
  mod.initConnectVaughan();
  return { mod, elementsById };
}

afterEach(() => {
  global.window = originalWindow;
  global.document = originalDocument;
  jest.useRealTimers();
});

describe('connect-vaughan', () => {
  test('openConnectVaughan lists accounts from Vaughan getAccounts', async () => {
    const getAccounts = jest.fn(async () => ({
      success: true,
      accounts: ['0x1111111111111111111111111111111111111111'],
    }));
    const { mod, elementsById } = await loadConnectVaughan({ getAccounts });

    await mod.openConnectVaughan();
    await flush();

    expect(getAccounts).toHaveBeenCalled();
    expect(elementsById['connect-vaughan-accounts-step'].classList.contains('hidden')).toBe(false);
    expect(elementsById['connect-vaughan-account-list'].children).toHaveLength(1);
    expect(elementsById['connect-vaughan-account-list'].children[0].innerHTML).toMatch(/0x1111/i);
  });

  test('shows disconnect guidance when Vaughan is unreachable', async () => {
    const getAccounts = jest.fn(async () => ({
      success: false,
      error: 'Cannot connect to Vaughan. Start the wallet and try again.',
      code: 'VAUGHAN_DISCONNECTED',
    }));
    const { mod, elementsById } = await loadConnectVaughan({ getAccounts });

    await mod.openConnectVaughan();
    await flush();

    expect(elementsById['connect-vaughan-detect'].classList.contains('hidden')).toBe(false);
    expect(elementsById['connect-vaughan-status-text'].textContent).toMatch(/Cannot connect/i);
    expect(getAccounts).toHaveBeenCalled();

    await mod.closeConnectVaughan();
  });
});
