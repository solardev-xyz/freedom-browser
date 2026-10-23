/**
 * Tests for the Safe signing board's message-session lifecycle.
 *
 * Focus: the board is chrome for a dApp request that is bound to one
 * document. When that document navigates away (or its webview dies) the
 * provider drops the response and main discards the session — the board
 * must be withdrawn too: promise settled, Ledger probing stopped, screen
 * taken down. The withdrawal is owner-scoped so an invalidation from a
 * predecessor document can never close a successor's board.
 */

const { createDocument, createElement } = require('../../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;
const originalCustomEvent = global.CustomEvent;

const flushMicrotasks = async () => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
};

/** A promise whose settlement the test controls (a held IPC reply). */
const deferred = () => {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

/** Observe a promise without awaiting it (the board settles it later). */
const track = (promise) => {
  const outcome = { settled: false, value: undefined, rejection: undefined };
  promise.then(
    (value) => {
      outcome.settled = true;
      outcome.value = value;
    },
    (error) => {
      outcome.settled = true;
      outcome.rejection = error;
    }
  );
  return outcome;
};

const messageState = (overrides = {}) => ({
  token: 'tok-1',
  status: 'collecting',
  collected: 1,
  threshold: 2,
  createdAt: '2026-07-12T00:00:00.000Z',
  display: { kind: 'message', site: 'https://app.example', method: 'personal_sign' },
  executorIndex: null,
  owners: [
    { index: 0, type: 'mnemonic', signed: true },
    { index: 1, type: 'mnemonic', signed: false },
  ],
  ...overrides,
});

const loadBoard = async () => {
  jest.resetModules();

  const walletMocks = {
    safeMessageState: jest.fn(async () => ({ success: false, error: 'no session' })),
    safeMessageSign: jest.fn(async () => ({ success: false, error: 'no session' })),
    safeMessageCancel: jest.fn(async () => ({ success: true })),
    safeMessageComplete: jest.fn(async () => ({ success: true, signature: '0xsig' })),
  };

  const identityView = createElement('div');
  global.window = {
    wallet: walletMocks,
    ledger: { getAccounts: jest.fn(async () => ({ success: false })) },
    dispatchEvent: jest.fn(),
  };
  global.CustomEvent = class CustomEvent {
    constructor(type, options) {
      this.type = type;
      this.detail = options?.detail;
    }
  };

  const screen = createElement('div', { classes: ['hidden'] });
  const elementsById = {
    'sidebar-safe-signing': screen,
    'safe-signing-back': createElement('button'),
    'safe-signing-title': createElement('h3'),
    'safe-signing-content': createElement('div'),
  };
  global.document = createDocument({ elementsById });

  jest.doMock('./wallet-state.js', () => ({
    walletState: { identityView },
    registerScreenHider: jest.fn(),
    hideAllSubscreens: jest.fn(),
  }));
  jest.doMock('./wallet-utils.js', () => ({
    escapeHtml: (text) => String(text ?? ''),
    truncateAddress: (address) => String(address ?? ''),
    formatRawTokenBalance: () => '0',
    walletRecord: jest.fn((index) => ({ name: `Account ${index}`, type: 'mnemonic' })),
    timeAgo: () => 'Just now',
  }));
  jest.doMock('./balance-display.js', () => ({ refreshBalances: jest.fn() }));
  jest.doMock('./vault-unlock.js', () => ({ showVaultUnlock: jest.fn() }));

  const mod = await import('./safe-signing.js');
  mod.initSafeSigning();

  return { mod, screen, identityView, walletMocks, ledger: global.window.ledger };
};

describe('safe signing board — message session withdrawal', () => {
  afterEach(() => {
    jest.useRealTimers();
    global.window = originalWindow;
    global.document = originalDocument;
    global.CustomEvent = originalCustomEvent;
    jest.restoreAllMocks();
  });

  test('abandoning for the owning document closes the board, stops polling, settles the promise', async () => {
    jest.useFakeTimers();
    const { mod, screen, walletMocks, ledger } = await loadBoard();
    const owner = { doc: 'A' };

    const withLedgerRow = messageState({
      owners: [
        { index: 0, type: 'mnemonic', signed: true },
        { index: 1, type: 'ledger', signed: false },
      ],
    });
    const outcome = track(mod.openSafeMessageBoard(5, withLedgerRow, owner));
    await flushMicrotasks();
    expect(screen.classList.contains('hidden')).toBe(false);

    // The unsigned Ledger row starts warm detection.
    await jest.advanceTimersByTimeAsync(0);
    expect(ledger.getAccounts).toHaveBeenCalledTimes(1);

    mod.abandonSafeMessageBoard(owner);
    await flushMicrotasks();

    expect(outcome.rejection).toEqual({ code: 4001, message: 'User rejected the request' });
    expect(screen.classList.contains('hidden')).toBe(true);
    expect(walletMocks.safeMessageCancel).toHaveBeenCalledWith(5, 'tok-1');

    // Ledger probing died with the board.
    const probes = ledger.getAccounts.mock.calls.length;
    await jest.advanceTimersByTimeAsync(10000);
    expect(ledger.getAccounts).toHaveBeenCalledTimes(probes);
  });

  test('a predecessor invalidation never closes a successor document board', async () => {
    const { mod, screen, walletMocks } = await loadBoard();
    const predecessor = { doc: 'A' };
    const successor = { doc: 'B' };

    const first = track(mod.openSafeMessageBoard(5, messageState(), predecessor));
    await flushMicrotasks();
    // Opening a new session settles the previous one (single board slot).
    const second = track(mod.openSafeMessageBoard(5, messageState({ token: 'tok-2' }), successor));
    await flushMicrotasks();
    expect(first.settled).toBe(true);
    walletMocks.safeMessageCancel.mockClear();

    // The predecessor's navigation invalidation arrives late.
    mod.abandonSafeMessageBoard(predecessor);
    await flushMicrotasks();

    expect(second.settled).toBe(false);
    expect(screen.classList.contains('hidden')).toBe(false);
    expect(walletMocks.safeMessageCancel).not.toHaveBeenCalled();
  });

  test('user cancel still rejects, cancels the session, and closes the board', async () => {
    const { mod, screen, walletMocks } = await loadBoard();

    const outcome = track(mod.openSafeMessageBoard(5, messageState(), { doc: 'A' }));
    await flushMicrotasks();

    mod.closeSafeSigning();
    await flushMicrotasks();

    expect(outcome.rejection).toEqual({ code: 4001, message: 'User rejected the request' });
    expect(walletMocks.safeMessageCancel).toHaveBeenCalledWith(5, 'tok-1');
    expect(screen.classList.contains('hidden')).toBe(true);
    expect(global.window.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'wallet:safe-signing-closed' })
    );
  });

  test('threshold met still completes and resolves the dApp promise', async () => {
    const { mod, screen, walletMocks } = await loadBoard();

    const complete = messageState({
      collected: 2,
      owners: [
        { index: 0, type: 'mnemonic', signed: true },
        { index: 1, type: 'mnemonic', signed: true },
      ],
    });
    const outcome = track(mod.openSafeMessageBoard(5, complete, { doc: 'A' }));
    await flushMicrotasks();

    expect(walletMocks.safeMessageComplete).toHaveBeenCalledWith(5, 'tok-1');
    expect(outcome.value).toBe('0xsig');
    expect(walletMocks.safeMessageCancel).not.toHaveBeenCalled();
    expect(screen.classList.contains('hidden')).toBe(true);
  });
});

describe('safe signing board — cross-session fencing of in-flight continuations', () => {
  afterEach(() => {
    jest.useRealTimers();
    global.window = originalWindow;
    global.document = originalDocument;
    global.CustomEvent = originalCustomEvent;
    jest.restoreAllMocks();
  });

  // Production hands the board the persistent webview object for every
  // document it hosts (dapp-provider.js) — a predecessor and its
  // successor share the SAME owner reference. These tests hold a
  // predecessor IPC reply in flight, open a successor board, and only
  // then release it: the stale continuation must not settle the
  // successor's promise or touch its state, notes, UI, or polling.

  const thresholdMetState = (overrides = {}) =>
    messageState({
      collected: 2,
      owners: [
        { index: 0, type: 'mnemonic', signed: true },
        { index: 1, type: 'mnemonic', signed: true },
      ],
      ...overrides,
    });

  test("a predecessor's in-flight completion cannot settle or touch a successor board for the same owner", async () => {
    jest.useFakeTimers();
    const { mod, screen, walletMocks, ledger } = await loadBoard();
    const webview = { tag: 'persistent-webview' };

    // Document A: threshold already met, so opening the board immediately
    // calls safeMessageComplete — hold that reply in flight.
    const pendingA = deferred();
    walletMocks.safeMessageComplete.mockImplementationOnce(() => pendingA.promise);
    const first = track(mod.openSafeMessageBoard(5, thresholdMetState(), webview));
    await flushMicrotasks();
    expect(walletMocks.safeMessageComplete).toHaveBeenCalledWith(5, 'tok-1');
    expect(first.settled).toBe(false);

    // A navigates away; a successor document in the same webview opens
    // its own session (with an unsigned Ledger row, so B is polling).
    mod.abandonSafeMessageBoard(webview);
    await flushMicrotasks();
    expect(first.rejection).toEqual({ code: 4001, message: 'User rejected the request' });

    const successorState = messageState({
      token: 'tok-2',
      owners: [
        { index: 0, type: 'mnemonic', signed: true },
        { index: 1, type: 'ledger', signed: false },
      ],
    });
    const second = track(mod.openSafeMessageBoard(5, successorState, webview));
    await flushMicrotasks();
    expect(screen.classList.contains('hidden')).toBe(false);
    const content = global.document.getElementById('safe-signing-content');
    const boardHtml = content.innerHTML;

    // A's completion finally resolves — with A's signature.
    pendingA.resolve({ success: true, signature: '0xsig-A' });
    await flushMicrotasks();

    expect(second.settled).toBe(false); // B must never receive A's signature
    expect(screen.classList.contains('hidden')).toBe(false);
    expect(content.innerHTML).toBe(boardHtml); // no UI writes from the stale path

    // B's warm Ledger detection is still running.
    ledger.getAccounts.mockClear();
    await jest.advanceTimersByTimeAsync(2100);
    expect(ledger.getAccounts).toHaveBeenCalled();
  });

  test("a predecessor's delayed signing error cannot write into a successor board", async () => {
    const { mod, walletMocks } = await loadBoard();
    const webview = { tag: 'persistent-webview' };
    const content = global.document.getElementById('safe-signing-content');

    // Plant a sign button inside the board content so the test can drive
    // the real signOwner path (the fake DOM keeps planted children when
    // innerHTML is rewritten, and render() wires [data-sign-owner]).
    const signButton = createElement('button', { dataset: { signOwner: '1' } });
    content.appendChild(signButton);

    // Document A: the user taps "Sign" — hold the sign reply in flight.
    const pendingSign = deferred();
    walletMocks.safeMessageSign.mockImplementationOnce(() => pendingSign.promise);
    track(mod.openSafeMessageBoard(5, messageState(), webview));
    await flushMicrotasks();
    signButton.dispatch('click');
    await flushMicrotasks();
    expect(walletMocks.safeMessageSign).toHaveBeenCalledWith(5, 1, 'tok-1');

    // A navigates; a successor session opens for the same webview.
    mod.abandonSafeMessageBoard(webview);
    const second = track(mod.openSafeMessageBoard(5, messageState({ token: 'tok-2' }), webview));
    await flushMicrotasks();
    const boardHtml = content.innerHTML;
    walletMocks.safeMessageState.mockClear();

    // A's sign attempt finally fails.
    pendingSign.resolve({ success: false, code: 'LEDGER_FAILED', error: 'Ledger exploded' });
    await flushMicrotasks();

    expect(content.innerHTML).toBe(boardHtml); // no stale row note or re-render
    expect(content.innerHTML).not.toContain('Ledger exploded');
    expect(walletMocks.safeMessageState).not.toHaveBeenCalled(); // no refresh against B's session
    expect(second.settled).toBe(false);
  });

  test('a successor board still completes normally after a stale predecessor continuation', async () => {
    const { mod, screen, walletMocks } = await loadBoard();
    const webview = { tag: 'persistent-webview' };

    const pendingA = deferred();
    const pendingB = deferred();
    walletMocks.safeMessageComplete
      .mockImplementationOnce(() => pendingA.promise)
      .mockImplementationOnce(() => pendingB.promise);

    track(mod.openSafeMessageBoard(5, thresholdMetState(), webview));
    await flushMicrotasks();
    mod.abandonSafeMessageBoard(webview);
    const second = track(
      mod.openSafeMessageBoard(5, thresholdMetState({ token: 'tok-2' }), webview)
    );
    await flushMicrotasks();
    expect(walletMocks.safeMessageComplete).toHaveBeenLastCalledWith(5, 'tok-2');

    // A's stale completion is ignored…
    pendingA.resolve({ success: true, signature: '0xsig-A' });
    await flushMicrotasks();
    expect(second.settled).toBe(false);

    // …while B's own completion settles B as usual.
    pendingB.resolve({ success: true, signature: '0xsig-B' });
    await flushMicrotasks();
    expect(second.value).toBe('0xsig-B');
    expect(screen.classList.contains('hidden')).toBe(true);
  });
});

// Design 0005, A: main judges the executor's fee as it signs. One that needs
// the user stops before signing; the board shows it and signs only the fee
// the user confirms there.
describe("safe signing board — the executor's fee", () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    global.CustomEvent = originalCustomEvent;
    jest.restoreAllMocks();
  });

  const OFFER = {
    executorIndex: 0,
    chainId: 100,
    to: '0x41aD4887971f90BB3fE4d83eCa65177281283261',
    value: '0',
    data: '0x6a761202',
    gasLimit: '150000',
    maxFeePerGas: '2000000000',
    maxPriorityFeePerGas: '1000000000',
  };
  const VERDICT = {
    maxCost: '300000000000000',
    comparable: false,
    ratio: null,
    above: false,
    oneEndpoint: false,
    autoApprove: false,
  };
  const ABOVE = { ...VERDICT, comparable: true, ratio: '20', above: true };
  const stopped = (feeCheck = VERDICT) => ({
    success: false,
    code: 'FEE_CHECK_NEEDS_CONFIRMATION',
    error: "This payment's network fee needs your confirmation.",
    feeCheck,
    offer: OFFER,
  });
  const sendState = () => ({
    status: 'collecting',
    collected: 2,
    threshold: 2,
    createdAt: '2026-07-12T00:00:00.000Z',
    display: { toAddress: '0xabc', amount: '1000', symbol: 'xDAI' },
    executorIndex: 0,
    owners: [
      { index: 0, type: 'mnemonic', signed: true },
      { index: 1, type: 'mnemonic', signed: true },
    ],
  });
  const CONFIRMED = {
    confirmation: 'token-1',
    gasLimit: '150000',
    fees: { maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000' },
  };

  async function openStoppedBoard(feeCheck = VERDICT) {
    const board = await loadBoard();
    const content = global.document.getElementById('safe-signing-content');
    const confirmButton = createElement('button');
    const retryButton = createElement('button');
    global.document.getElementById = (id) =>
      ({
        'sidebar-safe-signing': board.screen,
        'safe-signing-content': content,
        'safe-signing-confirm-fee': confirmButton,
        'safe-signing-retry-execute': retryButton,
      })[id] ?? null;
    Object.assign(board.walletMocks, {
      safeState: jest.fn(async () => ({ success: true, state: sendState() })),
      safeSign: jest.fn(),
      safeCancelPending: jest.fn(),
      safeExecute: jest.fn(async () => stopped(feeCheck)),
      confirmSigning: jest.fn(async () => ({ success: true, token: 'token-1' })),
    });
    await board.mod.openSafeSigningBoard(5, sendState());
    await flushMicrotasks();
    return { ...board, content, confirmButton, retryButton };
  }

  const click = async (button) => {
    button.dispatch('click');
    await flushMicrotasks();
  };

  test("a fee that needs the user: shown, and nothing signed until it's confirmed", async () => {
    const { walletMocks, content } = await openStoppedBoard();
    expect(walletMocks.safeExecute).toHaveBeenCalledTimes(1);
    expect(walletMocks.safeExecute).toHaveBeenCalledWith(5);
    expect(content.innerHTML).toContain('Confirm the network fee');
    expect(content.innerHTML).toContain('Up to 0.0003 xDAI');
    expect(content.innerHTML).toContain("Couldn't compare this fee with today's network fee");
    expect(content.innerHTML).toContain('Confirm fee and execute');
    // It waits for the user: the automatic run doesn't go round again.
    expect(walletMocks.confirmSigning).not.toHaveBeenCalled();
  });

  test('the confirmed fee is what main signs', async () => {
    const { walletMocks, confirmButton } = await openStoppedBoard();
    walletMocks.safeExecute.mockResolvedValueOnce({
      success: true,
      state: { ...sendState(), status: 'executed', executed: { hash: '0xhash' } },
    });
    await click(confirmButton);
    const { executorIndex: _executor, ...payload } = OFFER;
    expect(walletMocks.confirmSigning).toHaveBeenCalledWith('executor-send', 0, payload);
    expect(walletMocks.safeExecute).toHaveBeenLastCalledWith(5, { feeConfirmation: CONFIRMED });
  });

  test('above the threshold: the ratio, and the confirmation says it was seen', async () => {
    const { walletMocks, content, confirmButton } = await openStoppedBoard(ABOVE);
    expect(content.innerHTML).toContain("This network fee is 20× today's network fee");
    await click(confirmButton);
    expect(walletMocks.confirmSigning).toHaveBeenCalledWith(
      'executor-send',
      0,
      expect.objectContaining({ maxFeePerGas: OFFER.maxFeePerGas }),
      { feeAcknowledged: true }
    );
  });

  test('newly above at the press: main asks again, and the board shows it', async () => {
    const { walletMocks, content, confirmButton } = await openStoppedBoard();
    walletMocks.confirmSigning.mockResolvedValueOnce({
      success: false,
      code: 'FEE_CHECK_ASK_AGAIN',
      error: 'again',
      feeCheck: ABOVE,
    });
    await click(confirmButton);
    expect(walletMocks.safeExecute).toHaveBeenCalledTimes(1);
    expect(content.innerHTML).toContain("This network fee is 20× today's network fee");
    await click(confirmButton);
    expect(walletMocks.confirmSigning).toHaveBeenLastCalledWith(
      'executor-send',
      0,
      expect.anything(),
      { feeAcknowledged: true }
    );
    expect(walletMocks.safeExecute).toHaveBeenLastCalledWith(5, { feeConfirmation: CONFIRMED });
  });

  test('a failed execution stays retryable, and "Try again" is judged again', async () => {
    const { walletMocks, content, confirmButton, retryButton } = await openStoppedBoard();
    walletMocks.safeExecute.mockResolvedValueOnce({
      success: false,
      error: 'Insufficient funds for transaction',
      code: 'SAFE_NEEDS_FUNDS',
    });
    await click(confirmButton);
    expect(content.innerHTML).toContain('Insufficient funds for transaction');
    await click(retryButton);
    // A new quote, judged again: no confirmation rides along.
    expect(walletMocks.safeExecute).toHaveBeenLastCalledWith(5);
    expect(content.innerHTML).toContain('Confirm fee and execute');
  });
});
