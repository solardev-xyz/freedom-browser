/**
 * Tests for the Safe status card.
 *
 * Error states (#1066 follow-up): a status check that fails offers a
 * retry, and an activation that was sent but couldn't be verified
 * (activateSafe's SAFE_UNVERIFIED with the deployment's hash) shows its
 * own message with a re-check and never an Activate button, whatever the
 * following status reads say, until one reports the Safe deployed.
 *
 * Owner warning (#1065): new Safes refuse a Ledger owner no device has
 * matched, but a Safe created before that check can still list one. The
 * card says so on the Safe itself, deployed or not, before the user funds
 * its address.
 */

jest.mock('./send.js', () => ({ updateSendAvailability: jest.fn() }));
jest.mock('./vault-unlock.js', () => ({ showVaultUnlock: jest.fn() }));

const { createDocument, createElement } = require('../../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;

const SENT_MESSAGE =
  "Freedom sent the activation, but couldn't verify on Gnosis that it went through.";
const STATUS_UNVERIFIED = "Freedom couldn't verify on Gnosis whether this account is activated.";

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/**
 * A card whose innerHTML setter registers every `id="…"` it contains as a
 * clickable element, which is all this module reads back from the DOM.
 */
function createDom() {
  const elements = {};
  const makeEl = (id) => {
    const listeners = {};
    const classes = new Set();
    return {
      id,
      disabled: false,
      textContent: '',
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c),
      },
      addEventListener: (type, fn) => {
        (listeners[type] ||= []).push(fn);
      },
      click: () => (listeners.click || []).map((fn) => fn()),
    };
  };
  const card = makeEl('safe-status-card');
  let html = '';
  Object.defineProperty(card, 'innerHTML', {
    get: () => html,
    set: (value) => {
      html = String(value);
      for (const key of Object.keys(elements)) {
        if (key !== 'safe-status-card') delete elements[key];
      }
      for (const match of html.matchAll(/id="([^"]+)"/g)) {
        const el = makeEl(match[1]);
        if (
          /class="[^"]*hidden[^"]*" id="safe-status-error"/.test(html) &&
          match[1] === 'safe-status-error'
        ) {
          el.classList.add('hidden');
        }
        elements[match[1]] = el;
      }
    },
  });
  elements['safe-status-card'] = card;
  return {
    card,
    document: {
      getElementById: (id) => elements[id] || null,
      // escapeHtml's text-node round trip.
      createElement: () => {
        let text = '';
        return {
          set textContent(v) {
            text = String(v);
          },
          get innerHTML() {
            return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          },
        };
      },
    },
    byId: (id) => elements[id] || null,
  };
}

const READY = {
  deployed: false,
  chainId: 100,
  executorIndex: 0,
  executorAddress: '0x' + '11'.repeat(20),
  executorBalance: '10000000000000000000',
  estimatedCost: '1000000000000000',
  needsFunds: false,
};

describe('safe-status card', () => {
  let dom;
  let mod;
  let walletState;

  beforeEach(async () => {
    jest.resetModules();
    dom = createDom();
    global.document = dom.document;
    global.window = {
      wallet: {
        getSafeStatus: jest.fn(),
        activateSafe: jest.fn(),
      },
    };
    jest.spyOn(console, 'error').mockImplementation(() => {});
    ({ walletState } = await import('./wallet-state.js'));
    walletState.derivedWallets = [
      { index: 0, type: 'mnemonic', name: 'Main', address: READY.executorAddress },
      { index: 5, type: 'safe', name: 'Team', address: '0x' + '55'.repeat(20) },
      { index: 6, type: 'safe', name: 'Other', address: '0x' + '66'.repeat(20) },
    ];
    walletState.activeWalletIndex = 5;
    mod = await import('./safe-status.js');
  });

  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  test('a failed status check offers a retry that checks again', async () => {
    window.wallet.getSafeStatus.mockResolvedValueOnce({
      success: false,
      code: 'SAFE_UNVERIFIED',
      error: STATUS_UNVERIFIED,
    });
    await mod.refreshSafeStatusCard();
    expect(dom.card.innerHTML).toContain('verify on Gnosis whether');
    expect(dom.byId('safe-status-activate')).toBeNull();
    const retry = dom.byId('safe-status-retry');
    expect(retry).not.toBeNull();

    window.wallet.getSafeStatus.mockResolvedValueOnce({ success: true, status: READY });
    await Promise.all(retry.click());
    expect(window.wallet.getSafeStatus).toHaveBeenCalledTimes(2);
    expect(dom.byId('safe-status-activate')).not.toBeNull();
  });

  async function activateSentUnverified() {
    window.wallet.getSafeStatus.mockResolvedValueOnce({ success: true, status: READY });
    await mod.refreshSafeStatusCard();
    window.wallet.activateSafe.mockResolvedValueOnce({
      success: false,
      code: 'SAFE_UNVERIFIED',
      hash: '0x' + 'ab'.repeat(32),
      error: SENT_MESSAGE,
    });
  }

  test('a sent but unverified activation shows its message and no Activate, even when the next read fails', async () => {
    await activateSentUnverified();
    // The next status read would fail unverified: the card must still
    // show the activation's own message, not the status read's.
    window.wallet.getSafeStatus.mockResolvedValue({
      success: false,
      code: 'SAFE_UNVERIFIED',
      error: STATUS_UNVERIFIED,
    });
    await Promise.all(dom.byId('safe-status-activate').click());
    await flush();
    expect(dom.card.innerHTML).toContain('sent the activation');
    expect(dom.byId('safe-status-activate')).toBeNull();

    await Promise.all(dom.byId('safe-status-retry').click());
    expect(dom.card.innerHTML).toContain('sent the activation');
    expect(dom.byId('safe-status-activate')).toBeNull();
  });

  test('a lagging "not deployed" read after a sent activation still offers no Activate', async () => {
    await activateSentUnverified();
    await Promise.all(dom.byId('safe-status-activate').click());
    await flush();

    // An endpoint behind the chain answers unverified 0x: status "ready".
    window.wallet.getSafeStatus.mockResolvedValueOnce({ success: true, status: READY });
    await Promise.all(dom.byId('safe-status-retry').click());
    expect(dom.byId('safe-status-activate')).toBeNull();
    expect(dom.card.innerHTML).toContain('sent the activation');

    // Switching away and back doesn't bring Activate back either.
    walletState.activeWalletIndex = 5;
    window.wallet.getSafeStatus.mockResolvedValueOnce({ success: true, status: READY });
    await mod.refreshSafeStatusCard();
    expect(dom.byId('safe-status-activate')).toBeNull();

    // A verified deployed answer clears it.
    window.wallet.getSafeStatus.mockResolvedValueOnce({
      success: true,
      status: { ...READY, deployed: true },
    });
    await Promise.all(dom.byId('safe-status-retry').click());
    expect(dom.card.classList.contains('hidden')).toBe(true);
  });

  test('a sent activation shows its own message, not the fund-the-executor card, when the executor is short', async () => {
    await activateSentUnverified();
    // A lagging endpoint quotes a redeploy the executor, having just paid
    // gas, can no longer cover.
    window.wallet.getSafeStatus.mockResolvedValue({
      success: true,
      status: { ...READY, executorBalance: '1', needsFunds: true },
    });
    await Promise.all(dom.byId('safe-status-activate').click());
    await flush();
    expect(dom.card.innerHTML).toContain('sent the activation');
    expect(dom.byId('safe-status-refresh')).toBeNull();
    expect(dom.byId('safe-status-activate')).toBeNull();

    await Promise.all(dom.byId('safe-status-retry').click());
    expect(dom.card.innerHTML).toContain('sent the activation');
    expect(dom.card.innerHTML).not.toContain('fund');
    expect(dom.byId('safe-status-refresh')).toBeNull();
  });

  test('a short executor with nothing sent still gets the fund card', async () => {
    window.wallet.getSafeStatus.mockResolvedValueOnce({
      success: true,
      status: { ...READY, executorBalance: '1', needsFunds: true },
    });
    await mod.refreshSafeStatusCard();
    expect(dom.byId('safe-status-refresh')).not.toBeNull();
    expect(dom.card.innerHTML).not.toContain('sent the activation');
  });

  test('an unverified status before anything was sent keeps Activate on a later ready read', async () => {
    window.wallet.getSafeStatus.mockResolvedValueOnce({ success: true, status: READY });
    await mod.refreshSafeStatusCard();
    // SAFE_UNVERIFIED with no hash: thrown before the deployment was sent.
    window.wallet.activateSafe.mockResolvedValueOnce({
      success: false,
      code: 'SAFE_UNVERIFIED',
      error: STATUS_UNVERIFIED,
    });
    window.wallet.getSafeStatus.mockResolvedValueOnce({ success: true, status: READY });
    await Promise.all(dom.byId('safe-status-activate').click());
    await flush();
    expect(dom.byId('safe-status-activate')).not.toBeNull();
    // …and the activation's error is shown on the re-rendered card.
    const slot = dom.byId('safe-status-error');
    expect(slot.textContent).toBe(STATUS_UNVERIFIED);
    expect(slot.classList.contains('hidden')).toBe(false);
  });

  test('an activation error lands in the error slot even when the refresh itself fails', async () => {
    window.wallet.getSafeStatus.mockResolvedValueOnce({ success: true, status: READY });
    await mod.refreshSafeStatusCard();
    window.wallet.activateSafe.mockResolvedValueOnce({ success: false, error: 'RPC down' });
    window.wallet.getSafeStatus.mockResolvedValueOnce({ success: false, error: 'No chain source' });
    await Promise.all(dom.byId('safe-status-activate').click());
    await flush();
    expect(dom.byId('safe-status-retry')).not.toBeNull();
    expect(dom.byId('safe-status-error').textContent).toBe('RPC down');
  });

  test('a non-funds activation error is shown when the refresh lands on the fund card', async () => {
    window.wallet.getSafeStatus.mockResolvedValueOnce({ success: true, status: READY });
    await mod.refreshSafeStatusCard();
    // The send reverted after the executor paid gas: it's now short.
    window.wallet.activateSafe.mockResolvedValueOnce({ success: false, error: 'Reverted' });
    window.wallet.getSafeStatus.mockResolvedValueOnce({
      success: true,
      status: { ...READY, executorBalance: '1', needsFunds: true },
    });
    await Promise.all(dom.byId('safe-status-activate').click());
    await flush();
    expect(dom.byId('safe-status-refresh')).not.toBeNull();
    const slot = dom.byId('safe-status-error');
    expect(slot.textContent).toBe('Reverted');
    expect(slot.classList.contains('hidden')).toBe(false);
  });

  test('NEEDS_FUNDS that renders the fund card is not repeated in the slot', async () => {
    window.wallet.getSafeStatus.mockResolvedValueOnce({ success: true, status: READY });
    await mod.refreshSafeStatusCard();
    window.wallet.activateSafe.mockResolvedValueOnce({
      success: false,
      code: 'SAFE_NEEDS_FUNDS',
      error: 'Fund the executor',
    });
    window.wallet.getSafeStatus.mockResolvedValueOnce({
      success: true,
      status: { ...READY, executorBalance: '1', needsFunds: true },
    });
    await Promise.all(dom.byId('safe-status-activate').click());
    await flush();
    expect(dom.byId('safe-status-refresh')).not.toBeNull();
    expect(dom.byId('safe-status-error').classList.contains('hidden')).toBe(true);
  });

  test('NEEDS_FUNDS is shown when a lagging read still renders Activate', async () => {
    window.wallet.getSafeStatus.mockResolvedValueOnce({ success: true, status: READY });
    await mod.refreshSafeStatusCard();
    window.wallet.activateSafe.mockResolvedValueOnce({
      success: false,
      code: 'SAFE_NEEDS_FUNDS',
      error: 'Fund the executor',
    });
    window.wallet.getSafeStatus.mockResolvedValueOnce({ success: true, status: READY });
    await Promise.all(dom.byId('safe-status-activate').click());
    await flush();
    expect(dom.byId('safe-status-error').textContent).toBe('Fund the executor');
  });

  test('an activation error is shown when the refresh lands on the no-executor card', async () => {
    window.wallet.getSafeStatus.mockResolvedValueOnce({ success: true, status: READY });
    await mod.refreshSafeStatusCard();
    window.wallet.activateSafe.mockResolvedValueOnce({ success: false, error: 'Owner removed' });
    window.wallet.getSafeStatus.mockResolvedValueOnce({
      success: true,
      status: { ...READY, executorIndex: null, executorAddress: null },
    });
    await Promise.all(dom.byId('safe-status-activate').click());
    await flush();
    expect(dom.card.innerHTML).toContain('none of its owners');
    expect(dom.byId('safe-status-error').textContent).toBe('Owner removed');
  });

  test('an account switch during activation keeps the message off the other account', async () => {
    await activateSentUnverified();
    let release;
    window.wallet.activateSafe.mockReset();
    window.wallet.activateSafe.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    const clicked = dom.byId('safe-status-activate').click();

    // The user switches to another Safe while the receipt is awaited.
    walletState.activeWalletIndex = 6;
    window.wallet.getSafeStatus.mockResolvedValueOnce({ success: true, status: READY });
    await mod.refreshSafeStatusCard();
    expect(dom.byId('safe-status-activate')).not.toBeNull();

    release({ success: false, code: 'SAFE_UNVERIFIED', hash: '0xab', error: SENT_MESSAGE });
    await Promise.all(clicked);
    await flush();
    expect(dom.card.innerHTML).not.toContain('sent the activation');
    expect(dom.byId('safe-status-activate')).not.toBeNull();

    // Back on the first Safe, the sent activation is remembered.
    walletState.activeWalletIndex = 5;
    window.wallet.getSafeStatus.mockResolvedValueOnce({ success: true, status: READY });
    await mod.refreshSafeStatusCard();
    expect(dom.card.innerHTML).toContain('sent the activation');
    expect(dom.byId('safe-status-activate')).toBeNull();
  });
});

const flushMicrotasks = async () => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
};

const LEDGER = { index: 1000001, type: 'ledger', name: 'Old <Ledger>', address: '0xdef' };
const BROWSER = { index: 0, type: 'mnemonic', name: 'Main', address: '0xabc' };

const loadCard = async ({ ledger, deployed = false }) => {
  jest.resetModules();
  const card = createElement('div', { classes: ['hidden'] });
  const safe = {
    index: 2000001,
    type: 'safe',
    name: 'Safe 1',
    address: '0x111',
    owners: [BROWSER.index, ledger.index],
    threshold: 1,
    deployed: deployed ? { 100: true } : {},
  };
  const walletState = { derivedWallets: [BROWSER, ledger, safe], activeWalletIndex: safe.index };
  global.document = createDocument({ elementsById: { 'safe-status-card': card } });
  global.window = {
    wallet: {
      getSafeStatus: jest.fn(async () => ({
        success: true,
        status: {
          deployed,
          chainId: 100,
          executorIndex: 0,
          executorAddress: '0xabc',
          needsFunds: false,
          estimatedCost: '1',
        },
      })),
    },
  };

  jest.doMock('./wallet-state.js', () => ({ walletState }));
  jest.doMock('./send.js', () => ({ updateSendAvailability: jest.fn() }));
  jest.doMock('./vault-unlock.js', () => ({ showVaultUnlock: jest.fn() }));
  jest.doMock('./wallet-utils.js', () => ({
    escapeHtml: (text) => String(text).replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    truncateAddress: (address) => address,
    formatRawTokenBalance: (value) => value,
    walletRecord: (index = walletState.activeWalletIndex) =>
      walletState.derivedWallets.find((wallet) => wallet.index === index),
    isSafeDeployed: (wallet) => Boolean(wallet?.deployed?.[100]),
    showInlineError: jest.fn(),
  }));

  const mod = await import('./safe-status.js');
  return { mod, card, safe, walletState };
};

describe('safe status card — Ledger owners no device has matched (#1065)', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
  });

  test('an undeployed Safe with an unchecked Ledger owner warns above the activation card', async () => {
    const { mod, card } = await loadCard({ ledger: { ...LEDGER, addressCheck: 'unchecked' } });
    await mod.refreshSafeStatusCard();
    await flushMicrotasks();

    expect(card.classList.contains('hidden')).toBe(false);
    expect(card.innerHTML).toContain('safe-status-owner-warning');
    expect(card.innerHTML).toContain('"Old &lt;Ledger&gt;" (not checked on its Ledger yet)');
    expect(card.innerHTML).toContain('Check this owner before adding funds.');
    // The activation card is still there, below the warning.
    expect(card.innerHTML.indexOf('safe-status-owner-warning')).toBeLessThan(
      card.innerHTML.indexOf('safe-status-activate')
    );
  });

  test('a deployed Safe with a mismatched Ledger owner still shows the warning', async () => {
    const { mod, card } = await loadCard({
      ledger: { ...LEDGER, addressCheck: 'mismatched' },
      deployed: true,
    });
    await mod.refreshSafeStatusCard();

    expect(card.classList.contains('hidden')).toBe(false);
    expect(card.innerHTML).toContain('(not on the Ledger last connected)');
    expect(card.innerHTML).not.toContain('safe-status-activate');
  });

  test('a matched Ledger owner: no warning, and a deployed Safe shows no card', async () => {
    const { mod, card } = await loadCard({
      ledger: { ...LEDGER, addressCheck: 'matched' },
      deployed: true,
    });
    await mod.refreshSafeStatusCard();
    expect(card.classList.contains('hidden')).toBe(true);

    const undeployed = await loadCard({ ledger: { ...LEDGER, addressCheck: 'matched' } });
    await undeployed.mod.refreshSafeStatusCard();
    await flushMicrotasks();
    expect(undeployed.card.innerHTML).not.toContain('safe-status-owner-warning');
    expect(undeployed.card.innerHTML).toContain('safe-status-activate');
  });

  test('uncheckedLedgerOwners lists only Ledger owners that are not matched', async () => {
    const { mod } = await loadCard({ ledger: { ...LEDGER, addressCheck: 'unchecked' } });
    const records = [
      BROWSER,
      { ...LEDGER, index: 1, addressCheck: 'unchecked' },
      { ...LEDGER, index: 2, addressCheck: 'mismatched' },
      { ...LEDGER, index: 3, addressCheck: 'matched' },
    ];
    const safe = { type: 'safe', owners: [0, 1, 2, 3] };
    expect(mod.uncheckedLedgerOwners(safe, records).map((owner) => owner.index)).toEqual([1, 2]);
    expect(mod.uncheckedLedgerOwners({ ...records[1] }, records)).toEqual([]);
    expect(mod.ownerWarningHtml([])).toBe('');
  });
});
