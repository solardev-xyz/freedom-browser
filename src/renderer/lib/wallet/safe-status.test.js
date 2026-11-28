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
// The core's `safe_unverified` and `safe_changed` texts (design 0016).
const SETUP_UNVERIFIED =
  "Freedom couldn't verify this account on Gnosis, so it won't sign. " +
  'Try again, or add an RPC provider in Settings.';
const SETUP_CHANGED = "This account was changed outside Freedom, so Freedom can't sign for it.";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * `status`: getSafeStatus's answer to the card's first check. `marked`: the
 * Safe's record already says deployed on Gnosis. `core`: main runs the
 * core's Safe backend (preload.js `wallet.safeCoreBackend`).
 */
async function loadCard({ status = READY, marked = false, core = false } = {}) {
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
  if (core) wallet.safeCoreBackend = true;
  wallet.getSafeStatus.mockResolvedValueOnce(status);
  global.window = { wallet };
  const safe = { ...SAFE, deployed: marked ? { 100: true } : {} };
  let active = safe;
  // wallet-utils.js's unsettled setups, by wallet index; Send's button is
  // judged from them (send.js), so each re-evaluation records what it saw.
  const unsettledSafes = new Map();
  const sendSaw = [];
  const updateSendAvailability = jest.fn(() => {
    sendSaw.push(unsettledSafes.get(active?.index) ?? null);
  });

  jest.doMock('./wallet-state.js', () => ({
    walletState: { derivedWallets: [{ index: 0, name: 'Main Wallet' }] },
  }));
  jest.doMock('./wallet-utils.js', () => ({
    escapeHtml: (text) => String(text ?? ''),
    truncateAddress: (address) => String(address ?? ''),
    formatRawTokenBalance: () => '0.0005',
    walletRecord: () => active,
    isSafeDeployed: (wallet) => Boolean(wallet?.deployed?.[100]),
    setSafeSetupUnsettled: (index, reason) => {
      if (reason) unsettledSafes.set(index, reason);
      else unsettledSafes.delete(index);
    },
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
    // Why Send is blocked for the Safe (null: it isn't), and what Send's
    // last re-evaluation saw.
    unsettled: () => unsettledSafes.get(safe.index) ?? null,
    lastSendSaw: () => (sendSaw.length ? sendSaw[sendSaw.length - 1] : undefined),
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

// On the core's Safe backend (freedom-core design 0016, SAFE-3): the core
// judges the activation's fee, and with the approvals document off main's
// answer carries the ID of the ask main holds, which the card's
// confirmation returns, with no token minted by the chrome.
describe("on the core's Safe backend", () => {
  const coreStopped = (feeCheck = VERDICT, { feeAskId = 'ask-1', feeAskAgain = false } = {}) => ({
    success: false,
    code: 'FEE_CHECK_NEEDS_CONFIRMATION',
    error: "This payment's network fee needs your confirmation.",
    feeCheck,
    feeAskId,
    feeAskAgain,
  });

  test("the core's fee: shown, and confirmed with the ask's ID, with no token", async () => {
    const { wallet, card, click } = await loadCard();
    wallet.activateSafe.mockResolvedValueOnce(coreStopped());
    await click('safe-status-activate');
    expect(card.innerHTML).toContain('Confirm the network fee');
    expect(card.innerHTML).toContain('Up to 0.0005 xDAI.');
    expect(card.innerHTML).toContain('Confirm fee and activate');
    wallet.activateSafe.mockResolvedValueOnce({
      success: true,
      safeAddress: '0xsafe',
      hash: '0xhash',
    });
    await click('safe-status-confirm-fee');
    expect(wallet.activateSafe).toHaveBeenLastCalledWith(7, { feeAskId: 'ask-1' });
    expect(wallet.confirmSigning).not.toHaveBeenCalled();
  });

  test('above the threshold: main asks again after the first press, and the second press sends its new ID', async () => {
    const { wallet, card, click } = await loadCard();
    const above = { ...VERDICT, comparable: true, ratio: '20', above: true };
    wallet.activateSafe.mockResolvedValueOnce(coreStopped(above));
    await click('safe-status-activate');
    expect(card.innerHTML).toContain("This network fee is 20× today's network fee.");
    expect(card.innerHTML).toContain('Confirm fee and activate');

    wallet.activateSafe.mockResolvedValueOnce(
      coreStopped(above, { feeAskId: 'ask-2', feeAskAgain: true })
    );
    await click('safe-status-confirm-fee');
    expect(wallet.activateSafe).toHaveBeenLastCalledWith(7, { feeAskId: 'ask-1' });
    expect(card.innerHTML).toContain('Check the fee, then press Send anyway to pay it.');
    expect(card.innerHTML).toContain('>Send anyway</button>');

    wallet.activateSafe.mockResolvedValueOnce({
      success: true,
      safeAddress: '0xsafe',
      hash: '0xhash',
    });
    await click('safe-status-confirm-fee');
    expect(wallet.activateSafe).toHaveBeenLastCalledWith(7, { feeAskId: 'ask-2' });
    expect(wallet.confirmSigning).not.toHaveBeenCalled();
  });

  test("a confirmation main refuses (another window's offer since): the card again, with its error", async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const { wallet, card, click, errorEl } = await loadCard();
    wallet.activateSafe.mockResolvedValueOnce(coreStopped());
    await click('safe-status-activate');
    const refused =
      "This fee confirmation isn't the one shown for this account. Nothing was sent: try again.";
    wallet.activateSafe.mockResolvedValueOnce({
      success: false,
      code: 'SIGNING_NOT_CONFIRMED',
      error: refused,
    });
    await click('safe-status-confirm-fee');
    expect(card.innerHTML).toContain('Receive-only until activated');
    expect(errorEl.textContent).toBe(refused);
  });

  test('the approvals document rejected: the card again, with its error', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const { wallet, card, click, errorEl } = await loadCard();
    wallet.activateSafe.mockResolvedValueOnce({
      success: false,
      code: 'USER_REJECTED',
      error: 'User rejected the request',
    });
    await click('safe-status-activate');
    expect(card.innerHTML).toContain('Receive-only until activated');
    expect(errorEl.textContent).toBe('User rejected the request');
    expect(wallet.confirmSigning).not.toHaveBeenCalled();
  });

  test('reported deployed from an unverified answer only: not marked, and the card says so, with Try again', async () => {
    const session = {
      success: true,
      status: {
        ...STATUS,
        deployed: true,
        estimatedCost: null,
        setup: { state: 'unverified', read: 'code', why: 'unverified' },
      },
    };
    const { wallet, card, click, safe } = await loadCard({ status: session });
    expect(safe.deployed).toEqual({});
    expect(card.classList.contains('hidden')).toBe(false);
    expect(card.innerHTML).toContain(UNVERIFIED.error);
    expect(card.innerHTML).toContain('id="safe-status-retry"');

    // A verified read since: marked, and the card is gone.
    wallet.getSafeStatus.mockResolvedValueOnce({
      success: true,
      status: { ...DEPLOYED.status, setup: { state: 'unchanged' } },
    });
    await click('safe-status-retry');
    expect(safe.deployed).toEqual({ 100: true });
    expect(card.classList.contains('hidden')).toBe(true);
  });

  test("deployed with its owners changed: not taken as active; the card says it can't sign, with Try again", async () => {
    const { card, safe, updateSendAvailability } = await loadCard({
      status: {
        success: true,
        status: { ...DEPLOYED.status, setup: { state: 'changed', changed: ['owners'] } },
      },
    });
    expect(safe.deployed).toEqual({});
    expect(updateSendAvailability).toHaveBeenCalledTimes(1);
    expect(card.classList.contains('hidden')).toBe(false);
    expect(card.innerHTML).toContain(
      "This account was changed outside Freedom, so Freedom can't sign for it."
    );
    expect(card.innerHTML).toContain('id="safe-status-retry"');
  });

  test('deployed with its owners read unverified: not taken as active; the card says so, with Try again', async () => {
    const { wallet, card, click, safe } = await loadCard({
      status: {
        success: true,
        status: {
          ...DEPLOYED.status,
          setup: { state: 'unverified', read: 'owners', why: 'unverified' },
        },
      },
    });
    expect(safe.deployed).toEqual({});
    expect(card.classList.contains('hidden')).toBe(false);
    expect(card.innerHTML).toContain(
      "Freedom couldn't verify this account on Gnosis, so it won't sign."
    );
    expect(card.innerHTML).toContain('id="safe-status-retry"');

    // Every other setup state stays unmarked too; only unchanged marks it.
    for (const setup of [
      { state: 'changed', changed: ['threshold', 'module'] },
      { state: 'unverified', read: 'modules', why: 'failed' },
      { state: 'not_deployed' },
      null,
      { state: 'something new' },
    ]) {
      wallet.getSafeStatus.mockResolvedValueOnce({
        success: true,
        status: { ...DEPLOYED.status, setup },
      });
      await click('safe-status-retry');
      expect(safe.deployed).toEqual({});
      expect(card.classList.contains('hidden')).toBe(false);
    }
    wallet.getSafeStatus.mockResolvedValueOnce({
      success: true,
      status: { ...DEPLOYED.status, setup: { state: 'unchanged' } },
    });
    await click('safe-status-retry');
    expect(safe.deployed).toEqual({ 100: true });
    expect(card.classList.contains('hidden')).toBe(true);
  });

  test('not deployed, its code read unverified: Activate is offered, as today', async () => {
    const { card, safe } = await loadCard({
      status: {
        success: true,
        status: { ...STATUS, setup: { state: 'unverified', read: 'code', why: 'unverified' } },
      },
    });
    expect(safe.deployed).toEqual({});
    expect(card.innerHTML).toContain('id="safe-status-activate"');
  });

  // A Safe whose record already says deployed (`safe.deployed` verified its
  // activation, kept across restarts): its owners can still change
  // elsewhere, or a read come back unverified, so the core's setup is read
  // again each time it's shown, and only an unchanged one keeps it as is.
  describe('a Safe already marked deployed', () => {
    const withSetup = (setup) => ({ success: true, status: { ...DEPLOYED.status, setup } });
    const UNCHANGED = withSetup({ state: 'unchanged' });

    test('unchanged: safe.status is asked, no card while it runs or after, and Send stays', async () => {
      const pending = deferred();
      const { wallet, card, safe, unsettled, lastSendSaw, refresh } = await loadCard({
        marked: true,
        core: true,
        status: UNCHANGED,
      });
      expect(wallet.getSafeStatus).toHaveBeenCalledTimes(1);
      expect(wallet.getSafeStatus).toHaveBeenCalledWith(7);
      expect(card.classList.contains('hidden')).toBe(true);
      expect(card.innerHTML).toBe('');
      expect(safe.deployed).toEqual({ 100: true });
      expect(unsettled()).toBeNull();
      expect(lastSendSaw()).toBeNull();

      // Shown again: read again, with no "Checking" card meanwhile.
      wallet.getSafeStatus.mockReturnValueOnce(pending.promise);
      const again = refresh();
      await flushMicrotasks();
      expect(wallet.getSafeStatus).toHaveBeenCalledTimes(2);
      expect(card.classList.contains('hidden')).toBe(true);
      expect(card.innerHTML).not.toContain('Checking account status');
      pending.resolve(UNCHANGED);
      await again;
      expect(card.classList.contains('hidden')).toBe(true);
      expect(unsettled()).toBeNull();
    });

    test("its owners changed: the card says it can't sign, with Try again, and Send is blocked until a check finds it unchanged", async () => {
      const { wallet, card, click, safe, unsettled, lastSendSaw, refresh } = await loadCard({
        marked: true,
        core: true,
        status: withSetup({ state: 'changed', changed: ['owners'] }),
      });
      expect(wallet.getSafeStatus).toHaveBeenCalledTimes(1);
      expect(card.classList.contains('hidden')).toBe(false);
      expect(card.innerHTML).toContain(SETUP_CHANGED);
      expect(card.innerHTML).toContain('id="safe-status-retry"');
      expect(card.innerHTML).not.toContain('id="safe-status-activate"');
      expect(unsettled()).toBe(SETUP_CHANGED);
      expect(lastSendSaw()).toBe(SETUP_CHANGED);

      // Shown again: still blocked while the new check runs.
      const pending = deferred();
      wallet.getSafeStatus.mockReturnValueOnce(pending.promise);
      const again = refresh();
      await flushMicrotasks();
      expect(lastSendSaw()).toBe(SETUP_CHANGED);
      pending.resolve(withSetup({ state: 'changed', changed: ['owners'] }));
      await again;
      expect(card.innerHTML).toContain(SETUP_CHANGED);
      expect(unsettled()).toBe(SETUP_CHANGED);

      // Try again, now unchanged: the card goes and Send is back.
      wallet.getSafeStatus.mockResolvedValueOnce(UNCHANGED);
      await click('safe-status-retry');
      expect(wallet.getSafeStatus).toHaveBeenCalledTimes(3);
      expect(card.classList.contains('hidden')).toBe(true);
      expect(unsettled()).toBeNull();
      expect(lastSendSaw()).toBeNull();
      expect(safe.deployed).toEqual({ 100: true });
    });

    test('its owners read unverified: the card says so, with Try again, and Send is blocked', async () => {
      const { wallet, card, click, unsettled, lastSendSaw } = await loadCard({
        marked: true,
        core: true,
        status: withSetup({ state: 'unverified', read: 'owners', why: 'unverified' }),
      });
      expect(card.classList.contains('hidden')).toBe(false);
      expect(card.innerHTML).toContain(SETUP_UNVERIFIED);
      expect(card.innerHTML).toContain('id="safe-status-retry"');
      expect(unsettled()).toBe(SETUP_UNVERIFIED);
      expect(lastSendSaw()).toBe(SETUP_UNVERIFIED);

      // Every answer but deployed and unchanged keeps it so: other setups,
      // none at all, not deployed, and a check that failed.
      const failed = { success: false, error: 'All chain sources failed for eth_getCode' };
      for (const [answer, says] of [
        [withSetup({ state: 'changed', changed: ['threshold', 'module'] }), SETUP_CHANGED],
        [withSetup({ state: 'unverified', read: 'code', why: 'unverified' }), UNVERIFIED.error],
        [withSetup({ state: 'unverified', read: 'modules', why: 'failed' }), SETUP_UNVERIFIED],
        [withSetup({ state: 'something new' }), SETUP_UNVERIFIED],
        [withSetup(null), SETUP_UNVERIFIED],
        [{ success: true, status: { ...DEPLOYED.status } }, SETUP_UNVERIFIED],
        [
          { success: true, status: { ...STATUS, setup: { state: 'not_deployed' } } },
          SETUP_UNVERIFIED,
        ],
        [failed, failed.error],
      ]) {
        wallet.getSafeStatus.mockResolvedValueOnce(answer);
        await click('safe-status-retry');
        expect(card.classList.contains('hidden')).toBe(false);
        expect(card.innerHTML).toContain(says);
        expect(card.innerHTML).not.toContain('id="safe-status-activate"');
        expect(unsettled()).toBe(says);
        expect(lastSendSaw()).toBe(says);
      }
    });

    test('a failed first check: its error, with Try again, and Send is blocked', async () => {
      const { card, unsettled, lastSendSaw } = await loadCard({
        marked: true,
        core: true,
        status: UNVERIFIED,
      });
      expect(card.classList.contains('hidden')).toBe(false);
      expect(card.innerHTML).toContain(UNVERIFIED.error);
      expect(card.innerHTML).toContain('id="safe-status-retry"');
      expect(unsettled()).toBe(UNVERIFIED.error);
      expect(lastSendSaw()).toBe(UNVERIFIED.error);
    });
  });
});

test('on js, a Safe already marked deployed: no card, no status check, and Send stays, as before', async () => {
  const { wallet, card, safe, unsettled, lastSendSaw, updateSendAvailability, refresh } =
    await loadCard({ marked: true });
  expect(wallet.safeCoreBackend).toBeUndefined();
  expect(wallet.getSafeStatus).not.toHaveBeenCalled();
  expect(card.classList.contains('hidden')).toBe(true);
  expect(card.innerHTML).toBe('');
  expect(safe.deployed).toEqual({ 100: true });
  expect(unsettled()).toBeNull();
  expect(updateSendAvailability).toHaveBeenCalledTimes(1);
  expect(lastSendSaw()).toBeNull();

  await refresh();
  expect(wallet.getSafeStatus).not.toHaveBeenCalled();
  expect(card.classList.contains('hidden')).toBe(true);
});
