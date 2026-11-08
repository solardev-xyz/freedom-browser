/**
 * The Safe account card's activation (design 0005, A): main judges the
 * executor's activation fee as it signs. One that needs the user stops
 * before signing; the card shows it, and the activation is signed only
 * with the fee the user confirms there.
 *
 * And its error state (#1112): a status check that failed shows its
 * error with Try again, which runs the check again.
 */

const { createDocument, createElement } = require('../../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;

const flushMicrotasks = async () => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
};

const SAFE = { index: 7, type: 'safe', name: 'Team', deployed: {} };
const OFFER = {
  executorIndex: 0,
  chainId: 100,
  to: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67',
  value: '0',
  data: '0x1688f0b9',
  gasLimit: '250000',
  maxFeePerGas: '2000000000',
  maxPriorityFeePerGas: '1000000000',
};
const VERDICT = {
  maxCost: '500000000000000',
  comparable: false,
  ratio: null,
  above: false,
  oneEndpoint: false,
  autoApprove: false,
};
const stopped = (feeCheck = VERDICT) => ({
  success: false,
  code: 'FEE_CHECK_NEEDS_CONFIRMATION',
  error: "This payment's network fee needs your confirmation.",
  feeCheck,
  offer: OFFER,
});
const CONFIRMED = {
  confirmation: 'token-1',
  gasLimit: '250000',
  fees: { maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000' },
};
const STATUS = {
  deployed: false,
  chainId: 100,
  executorIndex: 0,
  executorAddress: '0xexecutor',
  estimatedCost: '500000000000000',
  needsFunds: false,
};
const READY = { success: true, status: STATUS };
const DEPLOYED = {
  success: true,
  status: { ...STATUS, deployed: true, estimatedCost: null },
};
const UNVERIFIED = {
  success: false,
  error:
    "Freedom couldn't verify on Gnosis whether this account is activated. " +
    'Try again, or add an RPC provider in Settings.',
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** `status`: getSafeStatus's answer to the card's first check. */
async function loadCard({ status = READY } = {}) {
  jest.resetModules();
  const buttons = {
    'safe-status-activate': createElement('button'),
    'safe-status-confirm-fee': createElement('button'),
    'safe-status-cancel-fee': createElement('button'),
    'safe-status-retry': createElement('button'),
  };
  const elementsById = {
    'safe-status-card': createElement('div'),
    'safe-status-error': createElement('div', { classes: ['hidden'] }),
    ...buttons,
  };
  global.document = createDocument({ elementsById });
  const wallet = {
    getSafeStatus: jest.fn(async () => READY),
    activateSafe: jest.fn(async () => stopped()),
    confirmSigning: jest.fn(async () => ({ success: true, token: 'token-1' })),
  };
  wallet.getSafeStatus.mockResolvedValueOnce(status);
  global.window = { wallet };
  const safe = { ...SAFE, deployed: {} };
  let active = safe;
  const updateSendAvailability = jest.fn();

  jest.doMock('./wallet-state.js', () => ({
    walletState: { derivedWallets: [{ index: 0, name: 'Main Wallet' }] },
  }));
  jest.doMock('./wallet-utils.js', () => ({
    escapeHtml: (text) => String(text ?? ''),
    truncateAddress: (address) => String(address ?? ''),
    formatRawTokenBalance: () => '0.0005',
    walletRecord: () => active,
    isSafeDeployed: () => false,
    showInlineError: (el, message) => {
      if (el) {
        el.textContent = message;
        el.classList.remove('hidden');
      }
    },
  }));
  jest.doMock('./send.js', () => ({ updateSendAvailability }));
  jest.doMock('./vault-unlock.js', () => ({ showVaultUnlock: jest.fn() }));

  const mod = await import('./safe-status.js');
  await mod.refreshSafeStatusCard();
  const card = elementsById['safe-status-card'];
  const click = async (id) => {
    buttons[id].dispatch('click');
    await flushMicrotasks();
  };
  return {
    wallet,
    card,
    click,
    buttons,
    safe,
    updateSendAvailability,
    refresh: mod.refreshSafeStatusCard,
    setActive: (record) => {
      active = record;
    },
    errorEl: elementsById['safe-status-error'],
  };
}

afterEach(() => {
  global.window = originalWindow;
  global.document = originalDocument;
  jest.restoreAllMocks();
});

test("a fee that needs the user: shown, and nothing signed until it's confirmed", async () => {
  const { wallet, card, click } = await loadCard();
  await click('safe-status-activate');
  expect(wallet.activateSafe).toHaveBeenCalledTimes(1);
  expect(wallet.activateSafe).toHaveBeenCalledWith(7);
  expect(card.innerHTML).toContain('Confirm the network fee');
  expect(card.innerHTML).toContain('Up to 0.0005 xDAI.');
  expect(card.innerHTML).toContain("Couldn't compare this fee with today's network fee.");
  expect(card.innerHTML).toContain('Confirm fee and activate');
  expect(wallet.confirmSigning).not.toHaveBeenCalled();
});

test('the confirmed fee is what main signs', async () => {
  const { wallet, click } = await loadCard();
  await click('safe-status-activate');
  wallet.activateSafe.mockResolvedValueOnce({
    success: true,
    safeAddress: '0xsafe',
    hash: '0xhash',
  });
  await click('safe-status-confirm-fee');
  const { executorIndex: _executor, ...payload } = OFFER;
  expect(wallet.confirmSigning).toHaveBeenCalledWith('executor-send', 0, payload);
  expect(wallet.activateSafe).toHaveBeenLastCalledWith(7, { feeConfirmation: CONFIRMED });
});

test('above the threshold: the ratio, and the confirmation says it was seen', async () => {
  const { wallet, card, click } = await loadCard();
  const above = { ...VERDICT, comparable: true, ratio: '20', above: true };
  wallet.activateSafe.mockResolvedValueOnce(stopped(above));
  await click('safe-status-activate');
  expect(card.innerHTML).toContain("This network fee is 20× today's network fee.");
  await click('safe-status-confirm-fee');
  expect(wallet.confirmSigning).toHaveBeenCalledWith('executor-send', 0, expect.anything(), {
    feeAcknowledged: true,
  });
});

test('newly above at the press: main asks again, and the card shows it', async () => {
  const { wallet, card, click } = await loadCard();
  await click('safe-status-activate');
  wallet.confirmSigning.mockResolvedValueOnce({
    success: false,
    code: 'FEE_CHECK_ASK_AGAIN',
    error: 'again',
    feeCheck: { ...VERDICT, comparable: true, ratio: '4', above: true },
  });
  await click('safe-status-confirm-fee');
  expect(wallet.activateSafe).toHaveBeenCalledTimes(1);
  expect(card.innerHTML).toContain("This network fee is 4× today's network fee.");
  await click('safe-status-confirm-fee');
  expect(wallet.confirmSigning).toHaveBeenLastCalledWith('executor-send', 0, expect.anything(), {
    feeAcknowledged: true,
  });
  expect(wallet.activateSafe).toHaveBeenLastCalledWith(7, { feeConfirmation: CONFIRMED });
});

test('cancel goes back to the card, and Activate is judged again', async () => {
  const { wallet, card, click } = await loadCard();
  await click('safe-status-activate');
  await click('safe-status-cancel-fee');
  expect(card.innerHTML).toContain('Receive-only until activated');
  await click('safe-status-activate');
  // (The fake DOM keeps each render's listener on its one button.) Every
  // activation since is a new one, with no confirmation riding along.
  const again = wallet.activateSafe.mock.calls.slice(1);
  expect(again.length).toBeGreaterThan(0);
  expect(again).toEqual(again.map(() => [7]));
  expect(wallet.confirmSigning).not.toHaveBeenCalled();
});

test('a failed status check: its error, and Try again', async () => {
  const { card } = await loadCard({ status: UNVERIFIED });
  expect(card.classList.contains('hidden')).toBe(false);
  expect(card.innerHTML).toContain(UNVERIFIED.error);
  expect(card.innerHTML).toMatch(
    /<button type="button" class="safe-status-btn" id="safe-status-retry">Try again<\/button>/
  );
});

test('Try again with a verified answer: the Safe is marked, and the error is gone', async () => {
  const { wallet, card, click, safe, updateSendAvailability } = await loadCard({
    status: UNVERIFIED,
  });
  updateSendAvailability.mockClear();
  wallet.getSafeStatus.mockResolvedValueOnce(DEPLOYED);
  await click('safe-status-retry');
  expect(wallet.getSafeStatus).toHaveBeenCalledTimes(2);
  expect(wallet.getSafeStatus).toHaveBeenLastCalledWith(7);
  expect(safe.deployed).toEqual({ 100: true });
  expect(updateSendAvailability).toHaveBeenCalled();
  expect(card.classList.contains('hidden')).toBe(true);
});

test('Try again on a Safe not yet activated: the card offers Activate', async () => {
  const { wallet, card, click, safe } = await loadCard({ status: UNVERIFIED });
  wallet.getSafeStatus.mockResolvedValueOnce(READY);
  await click('safe-status-retry');
  expect(safe.deployed).toEqual({});
  expect(card.innerHTML).not.toContain(UNVERIFIED.error);
  expect(card.innerHTML).toContain('Receive-only until activated');
  expect(card.innerHTML).toContain('id="safe-status-activate"');
});

test('a failed retry: the error and an enabled Try again, which runs once more', async () => {
  const { wallet, card, click } = await loadCard({ status: UNVERIFIED });
  const failed = { success: false, error: 'All chain sources failed for eth_getCode' };
  wallet.getSafeStatus.mockResolvedValueOnce(failed);
  await click('safe-status-retry');
  expect(wallet.getSafeStatus).toHaveBeenCalledTimes(2);
  expect(card.classList.contains('hidden')).toBe(false);
  expect(card.innerHTML).toContain(failed.error);
  expect(card.innerHTML).toContain('id="safe-status-retry"');
  // A fresh button: what the press disabled is gone with the old card.
  expect(card.innerHTML).not.toContain('disabled');

  // (The fake DOM keeps each render's listener on its one button, so this
  // press reaches both; the check in flight keeps it to one.)
  wallet.getSafeStatus.mockResolvedValueOnce(DEPLOYED);
  await click('safe-status-retry');
  expect(wallet.getSafeStatus).toHaveBeenCalledTimes(3);
  expect(card.classList.contains('hidden')).toBe(true);
});

test('Try again while its check runs: disabled, and a second press starts nothing', async () => {
  const { wallet, card, buttons } = await loadCard({ status: UNVERIFIED });
  const pending = deferred();
  wallet.getSafeStatus.mockReturnValueOnce(pending.promise);
  const retry = buttons['safe-status-retry'];

  retry.dispatch('click');
  retry.dispatch('click'); // the fake DOM delivers a press to a disabled button
  await flushMicrotasks();
  expect(wallet.getSafeStatus).toHaveBeenCalledTimes(2);
  expect(retry.disabled).toBe(true);
  expect(retry.textContent).toBe('Checking…');
  expect(card.innerHTML).toContain(UNVERIFIED.error);

  pending.resolve(DEPLOYED);
  await flushMicrotasks();
  expect(wallet.getSafeStatus).toHaveBeenCalledTimes(2);
  expect(card.classList.contains('hidden')).toBe(true);
});

test("another account shown during Try again: the old check's answer paints nothing", async () => {
  const { wallet, card, buttons, refresh, setActive } = await loadCard({ status: UNVERIFIED });
  const pending = deferred();
  wallet.getSafeStatus.mockReturnValueOnce(pending.promise);
  buttons['safe-status-retry'].dispatch('click');
  await flushMicrotasks();

  setActive({ index: 0, type: 'mnemonic', name: 'Main Wallet' });
  await refresh();
  expect(card.classList.contains('hidden')).toBe(true);

  pending.resolve(READY);
  await flushMicrotasks();
  expect(card.classList.contains('hidden')).toBe(true);
  expect(card.innerHTML).not.toContain('Receive-only until activated');
});
