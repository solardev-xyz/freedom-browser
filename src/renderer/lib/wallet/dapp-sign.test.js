const { createDocument, createElement } = require('../../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;

const DAPP_SIGN_ELEMENT_IDS = [
  'sidebar-dapp-sign',
  'dapp-sign-back',
  'dapp-sign-site',
  'dapp-sign-message',
  'dapp-sign-typed-data-section',
  'dapp-sign-typed-data',
  'dapp-sign-unlock',
  'dapp-sign-touchid-btn',
  'dapp-sign-password-link',
  'dapp-sign-password-section',
  'dapp-sign-password-input',
  'dapp-sign-password-submit',
  'dapp-sign-error',
  'dapp-sign-reject',
  'dapp-sign-approve',
  'dapp-sign-auto-approve',
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

async function loadDappSign() {
  jest.resetModules();

  const elementsById = Object.fromEntries(
    DAPP_SIGN_ELEMENT_IDS.map((id) => [id, createElement('button')])
  );
  elementsById['dapp-sign-auto-approve'].checked = false;
  const messageParent = createElement('div');
  messageParent.appendChild(elementsById['dapp-sign-message']);
  global.document = createDocument({ elementsById });

  const sign = deferred();
  const setSigningAutoApprove = jest.fn().mockResolvedValue({ success: true });
  global.window = {
    dappPermissions: {
      getPermission: jest.fn().mockResolvedValue({ walletIndex: LEDGER_INDEX, chainId: 8453 }),
      setSigningAutoApprove,
    },
  };

  const executeSign = jest.fn(() => sign.promise);
  jest.doMock('../dapp-provider.js', () => ({ executeSign }));
  // The Ledger account bypasses the vault-unlock gate, the same as in the app.
  jest.doMock('./wallet-utils.js', () => ({
    bypassUnlockGateForDevice: jest.fn((_index, _unlockEl, confirmBtn) => {
      if (confirmBtn) confirmBtn.disabled = false;
      return true;
    }),
    bypassUnlockGateForSafe: jest.fn(() => false),
    isSafeAccount: jest.fn(() => false),
    signingButtonLabel: jest.fn(() => 'Confirm on your Ledger…'),
  }));
  jest.doMock('./safe-signing.js', () => ({
    isSafeSigningBoardOpen: jest.fn(() => false),
  }));
  jest.doMock('./wallet-state.js', () => ({
    walletState: { identityView: createElement('div') },
    registerScreenHider: jest.fn(),
    hideAllSubscreens: jest.fn(),
  }));
  jest.doMock('../sidebar.js', () => ({ open: jest.fn() }));

  const mod = await import('./dapp-sign.js');
  mod.initDappSign();

  async function openApproval() {
    const settled = { state: 'pending' };
    const promise = mod
      .showDappSignApproval({}, 'https://app.example', 'personal_sign', ['0xdeadbeef', '0xledger'])
      .then(
        (signature) => {
          settled.state = 'resolved';
          settled.value = signature;
        },
        (err) => {
          settled.state = 'rejected';
          settled.value = err;
        }
      );
    await flush();
    return { settled, promise };
  }

  return { mod, elements: elementsById, sign, setSigningAutoApprove, openApproval };
}

describe('dapp-sign approval lifecycle', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  test('reject and back are inert while a Ledger signature is in flight', async () => {
    const { elements, sign, setSigningAutoApprove, openApproval } = await loadDappSign();
    const { settled, promise } = await openApproval();

    elements['dapp-sign-auto-approve'].checked = true;
    elements['dapp-sign-approve'].dispatch('click');
    await flush();

    expect(elements['dapp-sign-approve'].textContent).toBe('Confirm on your Ledger…');
    expect(elements['dapp-sign-reject'].disabled).toBe(true);
    expect(elements['dapp-sign-back'].disabled).toBe(true);

    elements['dapp-sign-reject'].dispatch('click');
    elements['dapp-sign-back'].dispatch('click');
    await flush();
    expect(settled.state).toBe('pending');

    sign.resolve('0xsignature');
    await promise;

    expect(settled).toMatchObject({ state: 'resolved', value: '0xsignature' });
    expect(setSigningAutoApprove).toHaveBeenCalledTimes(1);
    expect(elements['dapp-sign-auto-approve'].checked).toBe(false);
  });

  test('a second request cannot take the screen from an in-flight signature', async () => {
    const { elements, sign, openApproval } = await loadDappSign();
    const first = await openApproval();

    elements['dapp-sign-approve'].dispatch('click');
    await flush();
    expect(elements['dapp-sign-reject'].disabled).toBe(true);

    // The device prompt for the first message is still up: the newcomer is
    // refused rather than repainting the screen and re-enabling the way
    // out from under it.
    const second = await openApproval();
    expect(second.settled.state).toBe('rejected');
    expect(second.settled.value).toMatchObject({ code: -32002 });
    expect(elements['dapp-sign-reject'].disabled).toBe(true);
    expect(elements['dapp-sign-back'].disabled).toBe(true);
    expect(elements['dapp-sign-approve'].disabled).toBe(true);
    expect(elements['dapp-sign-approve'].textContent).toBe('Confirm on your Ledger…');

    elements['dapp-sign-reject'].dispatch('click');
    await flush();
    expect(first.settled.state).toBe('pending');

    sign.resolve('0xsignature');
    await first.promise;
    expect(first.settled).toMatchObject({ state: 'resolved', value: '0xsignature' });
  });

  // The per-module guard above only stops a second *signing* request. Every
  // other approval surface (dapp-tx, dapp-connect, x402, vault-unlock)
  // shares the same sidebar and takes it over via hideAllSubscreens(), so
  // the flight also has to hold the shared lock — that is what refuses
  // them while the device prompt is up.
  test('an in-flight signature holds the shared sidebar lock until it settles', async () => {
    const { elements, sign, openApproval } = await loadDappSign();
    // After loadDappSign's resetModules, so this is the same lock instance
    // the module under test holds.
    const flight = await import('./signature-flight.js');
    const { promise } = await openApproval();

    expect(flight.isSignatureInFlight()).toBe(false);

    elements['dapp-sign-approve'].dispatch('click');
    await flush();
    expect(flight.isSignatureInFlight()).toBe(true);

    sign.resolve('0xsignature');
    await promise;
    expect(flight.isSignatureInFlight()).toBe(false);
  });

  test('rejecting before confirming settles 4001 and enables no signing auto-approve', async () => {
    const { elements, setSigningAutoApprove, openApproval } = await loadDappSign();
    const { settled, promise } = await openApproval();

    elements['dapp-sign-auto-approve'].checked = true;
    elements['dapp-sign-reject'].dispatch('click');
    await promise;

    expect(settled.state).toBe('rejected');
    expect(settled.value).toMatchObject({ code: 4001 });
    expect(setSigningAutoApprove).not.toHaveBeenCalled();
    expect(elements['dapp-sign-auto-approve'].checked).toBe(false);
  });
});
