/**
 * Tests for the Safe status card's owner warning (#1065).
 *
 * New Safes refuse a Ledger owner no device has matched, but a Safe
 * created before that check can still list one. The card says so on the
 * Safe itself, deployed or not, before the user funds its address.
 */

const { createDocument, createElement } = require('../../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;

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
