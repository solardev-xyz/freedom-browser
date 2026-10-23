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
  'dapp-sign-raw-warning',
  'dapp-sign-typed-warning',
  'dapp-sign-typed-warning-text',
  'dapp-sign-typed-ignored',
];

// What main hands the screen (wallet:message-view, wallet:typed-data-view;
// freedom-core #88): read here with main's own helpers and the simulated
// core's view.
const signingUtils = require('../../../main/wallet/signing-utils.js');
const { simulatedView } = require('../../../../test/helpers/simulated-vault-core.js');

function messagePrepared(message) {
  const bytes = signingUtils.messageToBytes(signingUtils.normalizeMessage(message));
  return { message: { hex: '0x' + bytes.toString('hex'), rawHash: signingUtils.signsRawHash(message) } };
}

function typedPrepared(typedData, siteChainId, chains = {}) {
  const normalized = signingUtils.normalizeTypedData(typedData);
  const view = simulatedView(
    signingUtils.toCoreTypedData(normalized),
    signingUtils.typedDataViewOptions(normalized, siteChainId)
  );
  return {
    typedData: { hash: '0x' + '11'.repeat(32), view, warnings: signingUtils.typedDataWarnings(view) },
    chainId: siteChainId,
    chains,
  };
}

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

  async function openApproval(message = '0xdeadbeef', { method = 'personal_sign', prepared } = {}) {
    const settled = { state: 'pending' };
    const params = method === 'personal_sign' ? [message, '0xledger'] : ['0xledger', message];
    const promise = mod
      .showDappSignApproval({}, 'https://app.example', method, params, prepared ?? messagePrepared(message))
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

  return { mod, elements: elementsById, sign, setSigningAutoApprove, openApproval, executeSign };
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

// #89: a personal_sign of exactly 32 bytes as signed is a raw value whose
// signature can be a Swarm feed update. Its prompt shows the bytes as hex,
// with a warning; other lengths read as before.
describe('dapp-sign: the 32-byte warning', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  const RAW_HEX = '0x' + 'ab'.repeat(32);

  test.each([
    ['given as hex', RAW_HEX, RAW_HEX],
    ['given as uppercase hex', '0x' + 'AB'.repeat(32), RAW_HEX],
    ['given as text', 'a'.repeat(32), '0x' + '61'.repeat(32)],
    ['given as multi-byte text', 'é'.repeat(16), '0x' + 'c3a9'.repeat(16)],
  ])('shows the warning and the hex, %s', async (_label, message, shown) => {
    const { elements, openApproval } = await loadDappSign();
    await openApproval(message);

    expect(elements['dapp-sign-raw-warning'].classList.contains('hidden')).toBe(false);
    expect(elements['dapp-sign-message'].textContent).toBe(shown);
  });

  test.each([
    ['31 bytes of hex', '0x' + '41'.repeat(31), 'A'.repeat(31)],
    ['33 bytes of hex', '0x' + '41'.repeat(33), 'A'.repeat(33)],
    ['31 bytes of text', 'a'.repeat(31), 'a'.repeat(31)],
    ['33 bytes of text', 'a'.repeat(33), 'a'.repeat(33)],
    // #88: from the bytes main signs; bytes that aren't UTF-8 show as hex.
    ['binary bytes', '0xfffefd00', '0xfffefd00'],
    ['uppercase hex text', '0x48454C4C4F', 'HELLO'],
  ])('no warning at %s, shown as before', async (_label, message, shown) => {
    const { elements, openApproval } = await loadDappSign();
    await openApproval(message);

    expect(elements['dapp-sign-raw-warning'].classList.contains('hidden')).toBe(true);
    expect(elements['dapp-sign-message'].textContent).toBe(shown);
  });

  test('approving signs the request as sent, and the next prompt starts without the warning', async () => {
    const { elements, sign, openApproval, executeSign } = await loadDappSign();
    const { settled, promise } = await openApproval(RAW_HEX);

    elements['dapp-sign-approve'].dispatch('click');
    await flush();
    expect(executeSign).toHaveBeenCalledWith(
      'personal_sign',
      [RAW_HEX, '0xledger'],
      LEDGER_INDEX,
      'https://app.example',
      {}
    );
    sign.resolve('0xsignature');
    await promise;
    expect(settled).toMatchObject({ state: 'resolved', value: '0xsignature' });
    expect(elements['dapp-sign-raw-warning'].classList.contains('hidden')).toBe(true);

    await openApproval('0xdeadbeef');
    expect(elements['dapp-sign-raw-warning'].classList.contains('hidden')).toBe(true);
  });
});

// #88: typed data is shown from the identity core's view of what is signed,
// never the dApp's JSON, with its reports warned about.
describe('dapp-sign: the typed-data view', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  const CONTRACT = '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC';
  const LONG = 'a long field, '.repeat(20);
  const MAIL = {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      Person: [{ name: 'name', type: 'string' }, { name: 'wallet', type: 'address' }],
      Mail: [
        { name: 'from', type: 'Person' },
        { name: 'to', type: 'Person[]' },
        { name: 'amount', type: 'uint256' },
        { name: 'contents', type: 'string' },
      ],
    },
    primaryType: 'Mail',
    domain: { name: 'Ether Mail', chainId: 1, verifyingContract: CONTRACT },
    message: {
      from: { name: 'Cow', wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826', nested: 'not signed' },
      to: [{ name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' }],
      amount: '0x' + 'f'.repeat(64),
      contents: LONG,
      extra: 'sent, not signed',
      also: 1,
    },
  };

  async function openTyped(data, siteChainId = 1, chains = {}) {
    const loaded = await loadDappSign();
    await loaded.openApproval(JSON.stringify(data), {
      method: 'eth_signTypedData_v4',
      prepared: typedPrepared(data, siteChainId, chains),
    });
    return loaded.elements;
  }

  const text = (elements) => elements['dapp-sign-typed-data'].textContent;
  const warning = (elements) =>
    elements['dapp-sign-typed-warning'].classList.contains('hidden')
      ? null
      : elements['dapp-sign-typed-warning-text'].textContent;

  test('every field of the view, whole: nothing from the dApp\'s own JSON', async () => {
    const elements = await openTyped(MAIL);
    const shown = text(elements);
    // The domain whole: the contract in full, the chain id.
    expect(shown).toContain(`verifyingContract: ${CONTRACT.toLowerCase()}`);
    expect(shown).toContain('chainId: 1');
    // Structs nested, arrays listed, values normalized and untruncated.
    expect(shown).toContain('from (Person):');
    expect(shown).toContain('wallet: 0xcd2a3d9f938e13cd947ec05abc7fe734df8dd826');
    expect(shown).toContain('to (Person[]):');
    expect(shown).toContain('[0]:');
    expect(shown).toContain(`amount: ${(2n ** 256n - 1n).toString()}`);
    expect(shown).toContain(`contents: ${LONG}`);
    // Undeclared keys aren't shown as data; top-level ones are listed.
    expect(shown).not.toContain('not signed');
    expect(shown).not.toContain('extra');
    expect(shown).not.toContain(CONTRACT);
    expect(elements['dapp-sign-typed-ignored'].classList.contains('hidden')).toBe(false);
    expect(elements['dapp-sign-typed-ignored'].textContent).toBe(
      "The site also sent these fields, which aren't signed: also, extra"
    );
    // A match on both: no warning.
    expect(warning(elements)).toBeNull();
  });

  test('the primaryType warning: on a mismatch, a non-string included; not on a match or without one', async () => {
    for (const primaryType of ['Person', 'Order', 'EIP712Domain', true, null, 7]) {
      const elements = await openTyped({ ...MAIL, primaryType });
      expect(warning(elements)).toContain('The site named a different type of data than the one shown here');
    }
    for (const data of [MAIL, (({ primaryType: _p, ...rest }) => rest)(MAIL)]) {
      expect(warning(await openTyped(data))).toBeNull();
    }
  });

  test('true, false and null with a struct of that name as the root still warn', async () => {
    for (const name of ['true', 'false', 'null']) {
      const data = {
        domain: { chainId: 1 },
        types: { [name]: [{ name: 'v', type: 'uint8' }] },
        primaryType: JSON.parse(name),
        message: { v: 1 },
      };
      const elements = await openTyped(data);
      expect(text(elements)).toContain(`${name}:`);
      expect(warning(elements)).toContain('different type of data');
    }
  });

  test('the chain warning names both chains on a mismatch, and warns on an absent chain', async () => {
    const chains = { 1: { name: 'Ethereum' }, 100: { name: 'Gnosis' } };
    expect(warning(await openTyped(MAIL, 100, chains))).toBe(
      'This data is for Ethereum (chain 1), but the site is on Gnosis (chain 100).'
    );
    expect(warning(await openTyped(MAIL, 5))).toBe('This data is for chain 1, but the site is on chain 5.');
    const noChain = { ...MAIL, domain: { name: 'Ether Mail', verifyingContract: CONTRACT } };
    expect(warning(await openTyped(noChain, 1))).toBe(
      'This data names no chain. The signature is valid on every chain where the contract it is for exists.'
    );
    // A match: no warning. Unknown (no site chain): never shown as a match,
    // and no warning either.
    expect(warning(await openTyped(MAIL, 1))).toBeNull();
    expect(warning(await openTyped(MAIL, undefined))).toBeNull();
  });

  test('both warnings together; and the next prompt starts without them', async () => {
    const { elements, openApproval } = await loadDappSign();
    const data = { ...MAIL, primaryType: 'Person' };
    await openApproval(JSON.stringify(data), {
      method: 'eth_signTypedData_v4',
      prepared: typedPrepared(data, 100),
    });
    const both = warning(elements);
    expect(both).toContain('different type of data');
    expect(both).toContain('but the site is on chain 100');

    await openApproval('0xdeadbeef');
    expect(warning(elements)).toBeNull();
    expect(elements['dapp-sign-typed-ignored'].classList.contains('hidden')).toBe(true);
  });
});
