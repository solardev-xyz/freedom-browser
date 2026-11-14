/**
 * Tests for the Safe signing board: main's prompts for a page's Safe message
 * and Safe send, the executor's fee, and the fencing of a board's in-flight
 * continuations once main has taken its prompt down.
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

// freedom-core design 0011, PRQ-5a: a page's Safe message is main's. Main
// opens the session and shows the board as its prompt (`eth.safe_message`);
// the board collects signatures with the session's token and answers the
// handle once the threshold is met. Main completes the session.
describe("safe signing board — main's prompt (0011 PRQ-5a)", () => {
  afterEach(() => {
    jest.useRealTimers();
    global.window = originalWindow;
    global.document = originalDocument;
    global.CustomEvent = originalCustomEvent;
    jest.restoreAllMocks();
  });

  async function loadPageBoard() {
    const env = await loadBoard();
    const decisions = [];
    global.window.pagePrompts = {
      decide: jest.fn(async (handle, approve, choices) => {
        decisions.push({ handle, approve, choices });
        return { ok: true };
      }),
    };
    const renderer = require('../page-prompt-renderers.js').pagePromptRenderer('eth.safe_message');
    const show = (state = messageState(), handle = 'h1') =>
      renderer.show({ handle, guest: 3, kind: 'eth.safe_message', site: { key: 'https://app.example', label: 'https://app.example' }, view: { safeIndex: 5, state } });
    return { ...env, decisions, renderer, show };
  }

  test('the threshold met answers the handle; main, not the chrome, completes the session', async () => {
    const { walletMocks, screen, decisions, show } = await loadPageBoard();
    const done = messageState({ collected: 2, owners: [{ index: 0, type: 'mnemonic', signed: true }, { index: 1, type: 'mnemonic', signed: true }] });
    walletMocks.safeMessageState.mockResolvedValue({ success: true, state: done });
    show();
    await flushMicrotasks();
    // From main's state, by the session's token.
    expect(walletMocks.safeMessageState).toHaveBeenCalledWith(5, 'tok-1');
    expect(decisions).toEqual([{ handle: 'h1', approve: true, choices: {} }]);
    expect(walletMocks.safeMessageCancel).not.toHaveBeenCalled();
    expect(screen.classList.contains('hidden')).toBe(true);
  });

  test('a device owner signs on the board with the token, then the handle is answered', async () => {
    const { walletMocks, decisions, show } = await loadPageBoard();
    const content = global.document.getElementById('safe-signing-content');
    const signButton = createElement('button', { dataset: { signOwner: '1' } });
    content.appendChild(signButton);
    walletMocks.safeMessageState.mockResolvedValue({ success: true, state: messageState() });
    walletMocks.safeMessageSign.mockResolvedValueOnce({ success: true, state: messageState() });
    show();
    await flushMicrotasks();
    expect(decisions).toEqual([]);
    const signed = messageState({ collected: 2, owners: [{ index: 0, type: 'mnemonic', signed: true }, { index: 1, type: 'mnemonic', signed: true }] });
    walletMocks.safeMessageSign.mockResolvedValueOnce({ success: true, state: signed });
    signButton.dispatch('click');
    await flushMicrotasks();
    expect(walletMocks.safeMessageSign).toHaveBeenLastCalledWith(5, 1, 'tok-1');
    expect(decisions).toEqual([{ handle: 'h1', approve: true, choices: {} }]);
  });

  test('closing the board rejects the request', async () => {
    const { mod, walletMocks, decisions, show } = await loadPageBoard();
    walletMocks.safeMessageState.mockResolvedValue({ success: true, state: messageState() });
    show();
    await flushMicrotasks();
    mod.closeSafeSigning();
    await flushMicrotasks();
    expect(decisions).toEqual([{ handle: 'h1', approve: false, choices: {} }]);
  });

  test('main hiding it takes the board down with the session kept, and shows it again from main\'s state', async () => {
    const { walletMocks, screen, decisions, renderer, show } = await loadPageBoard();
    walletMocks.safeMessageState.mockResolvedValue({ success: true, state: messageState() });
    show();
    await flushMicrotasks();
    expect(renderer.isShowing()).toBe('h1');
    expect(renderer.close('h1')).toBe(true);
    expect(screen.classList.contains('hidden')).toBe(true);
    expect(walletMocks.safeMessageCancel).not.toHaveBeenCalled();
    expect(decisions).toEqual([]);
    walletMocks.safeMessageState.mockClear();
    show();
    await flushMicrotasks();
    expect(screen.classList.contains('hidden')).toBe(false);
    expect(walletMocks.safeMessageState).toHaveBeenCalledWith(5, 'tok-1');
  });

  test('a view with no session is rejected', async () => {
    const { decisions, renderer } = await loadPageBoard();
    renderer.show({ handle: 'h2', guest: 3, kind: 'eth.safe_message', site: {}, view: { safeIndex: 5, state: {} } });
    await flushMicrotasks();
    expect(decisions).toEqual([{ handle: 'h2', approve: false, choices: {} }]);
  });

  // A board main took down keeps no hold on the board shown next: a reply
  // still in flight for it must not settle, note or re-render its successor.
  test("a hidden prompt's delayed signing error cannot write into the board shown next", async () => {
    const { walletMocks, decisions, renderer, show } = await loadPageBoard();
    const content = global.document.getElementById('safe-signing-content');
    // Plant a sign button inside the board content so the test can drive
    // the real signOwner path (the fake DOM keeps planted children when
    // innerHTML is rewritten, and render() wires [data-sign-owner]).
    const signButton = createElement('button', { dataset: { signOwner: '1' } });
    content.appendChild(signButton);
    walletMocks.safeMessageState.mockImplementation(async (_safe, token) => ({
      success: true,
      state: messageState({ token }),
    }));

    // Prompt h1: the user taps "Sign" — hold the sign reply in flight.
    const pendingSign = deferred();
    walletMocks.safeMessageSign.mockImplementationOnce(() => pendingSign.promise);
    show(messageState(), 'h1');
    await flushMicrotasks();
    signButton.dispatch('click');
    await flushMicrotasks();
    expect(walletMocks.safeMessageSign).toHaveBeenCalledWith(5, 1, 'tok-1');

    // Main hides h1 (another tab in front) and shows another document's h2.
    renderer.close('h1');
    show(messageState({ token: 'tok-2' }), 'h2');
    await flushMicrotasks();
    const boardHtml = content.innerHTML;
    walletMocks.safeMessageState.mockClear();

    // h1's sign attempt finally fails.
    pendingSign.resolve({ success: false, code: 'LEDGER_FAILED', error: 'Ledger exploded' });
    await flushMicrotasks();

    expect(content.innerHTML).toBe(boardHtml); // no stale row note or re-render
    expect(content.innerHTML).not.toContain('Ledger exploded');
    expect(walletMocks.safeMessageState).not.toHaveBeenCalled(); // no refresh against h2's session
    expect(decisions).toEqual([]);
  });
});

// freedom-core design 0011, PRQ-5b: a page's Safe send is main's. Main starts
// the SafeTx on the user's approval and shows the board as its prompt
// (`eth.safe_send`); the board signs and executes as before, and main hears
// the outcome itself. Leaving the board parks the SafeTx and answers the
// handle; main keeps the page waiting.
describe("safe signing board — a page's Safe send (0011 PRQ-5b)", () => {
  afterEach(() => {
    jest.useRealTimers();
    global.window = originalWindow;
    global.document = originalDocument;
    global.CustomEvent = originalCustomEvent;
    jest.restoreAllMocks();
  });

  const sendState = (overrides = {}) => ({
    safeIndex: 5,
    safeTxHash: '0xsafetx',
    status: 'awaiting',
    collected: 1,
    threshold: 2,
    createdAt: '2026-07-12T00:00:00.000Z',
    display: { site: 'https://app.example', toAddress: '0xabc', amount: '0' },
    executorIndex: 0,
    owners: [
      { index: 0, type: 'mnemonic', signed: true },
      { index: 1, type: 'remote', signed: false },
    ],
    ...overrides,
  });

  async function loadSendBoard() {
    const env = await loadBoard();
    const decisions = [];
    global.window.pagePrompts = {
      decide: jest.fn(async (handle, approve, choices) => {
        decisions.push({ handle, approve, choices });
        return { ok: true };
      }),
    };
    Object.assign(env.walletMocks, {
      safeState: jest.fn(async () => ({ success: true, state: sendState() })),
      safeSign: jest.fn(async () => ({ success: true, state: sendState() })),
      safeCancelPending: jest.fn(async () => ({ success: true })),
      safeExecute: jest.fn(),
      confirmSigning: jest.fn(async () => ({ success: true, token: 'token-1' })),
    });
    const renderer = require('../page-prompt-renderers.js').pagePromptRenderer('eth.safe_send');
    const show = (handle = 'h1', view = { safeIndex: 5, state: sendState() }) =>
      renderer.show({ handle, guest: 3, kind: 'eth.safe_send', site: { key: 'https://app.example', label: 'https://app.example' }, view });
    return { ...env, decisions, renderer, show };
  }

  test("it shows the SafeTx from main's state, and leaving it parks the SafeTx and answers the handle", async () => {
    const { mod, walletMocks, screen, decisions, renderer, show } = await loadSendBoard();
    show();
    await flushMicrotasks();
    expect(walletMocks.safeState).toHaveBeenCalledWith(5);
    expect(screen.classList.contains('hidden')).toBe(false);
    expect(renderer.isShowing()).toBe('h1');
    expect(decisions).toEqual([]);
    mod.closeSafeSigning();
    await flushMicrotasks();
    expect(decisions).toEqual([{ handle: 'h1', approve: false, choices: {} }]);
    expect(walletMocks.safeCancelPending).not.toHaveBeenCalled();
    expect(screen.classList.contains('hidden')).toBe(true);
  });

  // freedom-core design 0012, APB-1c: with no Safe approval held for the
  // SafeTx (the app restarted since), the owner the user taps signs with
  // the SafeTx confirmed again, a safe-send token for main's own call of it.
  test('an owner with no Safe approval held signs with the SafeTx confirmed again', async () => {
    const { walletMocks, show } = await loadSendBoard();
    const content = global.document.getElementById('safe-signing-content');
    const signButton = createElement('button', { dataset: { signOwner: '1' } });
    content.appendChild(signButton);
    const state = sendState({ chainId: 100, call: { to: '0xabc', value: '0', data: '0x01' } });
    walletMocks.safeState.mockResolvedValue({ success: true, state });
    walletMocks.safeSign.mockResolvedValue({ success: true, state });
    show('h1', { safeIndex: 5, state });
    await flushMicrotasks();
    walletMocks.safeSign.mockClear();
    walletMocks.safeSign.mockResolvedValueOnce({ success: false, code: 'SAFE_APPROVAL_NEEDED', error: 'confirm again' });
    walletMocks.safeSign.mockResolvedValueOnce({ success: true, state });
    signButton.dispatch('click');
    await flushMicrotasks();
    expect(walletMocks.confirmSigning).toHaveBeenCalledWith('safe-send', 5, {
      tx: { to: '0xabc', value: '0', data: '0x01' },
      chainId: 100,
    });
    expect(walletMocks.safeSign.mock.calls).toEqual([
      [5, 1],
      [5, 1, { confirmation: 'token-1' }],
    ]);
  });

  test('at the threshold it executes as before; main closing the prompt meanwhile keeps the board to its summary', async () => {
    const { walletMocks, screen, decisions, renderer, show } = await loadSendBoard();
    const signed = sendState({ collected: 2, owners: [{ index: 0, type: 'mnemonic', signed: true }, { index: 1, type: 'mnemonic', signed: true }] });
    walletMocks.safeState.mockResolvedValue({ success: true, state: signed });
    const execution = deferred();
    walletMocks.safeExecute.mockReturnValue(execution.promise);
    show();
    await flushMicrotasks();
    expect(walletMocks.safeExecute).toHaveBeenCalledWith(5);
    // Main heard the execution and answered the page: its prompt closes.
    expect(renderer.close('h1')).toBe(true);
    expect(screen.classList.contains('hidden')).toBe(false);
    execution.resolve({ success: true, state: { ...signed, status: 'executed', executed: { hash: '0xexec' } } });
    await flushMicrotasks();
    expect(screen.classList.contains('hidden')).toBe(false);
    expect(global.document.getElementById('safe-signing-content').innerHTML).toBeTruthy();
    // No decision: main answered from the SafeTx's outcome.
    expect(decisions).toEqual([]);
  });

  test("main hiding it takes the board down with the SafeTx kept, and shows it again from main's state", async () => {
    const { walletMocks, screen, decisions, renderer, show } = await loadSendBoard();
    show();
    await flushMicrotasks();
    expect(renderer.close('h1')).toBe(true);
    expect(screen.classList.contains('hidden')).toBe(true);
    expect(walletMocks.safeCancelPending).not.toHaveBeenCalled();
    expect(decisions).toEqual([]);
    walletMocks.safeState.mockClear();
    show();
    await flushMicrotasks();
    expect(screen.classList.contains('hidden')).toBe(false);
    expect(walletMocks.safeState).toHaveBeenCalledWith(5);
  });

  test('a view with no Safe is rejected', async () => {
    const { decisions, renderer } = await loadSendBoard();
    renderer.show({ handle: 'h2', guest: 3, kind: 'eth.safe_send', site: {}, view: {} });
    await flushMicrotasks();
    expect(decisions).toEqual([{ handle: 'h2', approve: false, choices: {} }]);
  });
});

describe('safe signing board — main runs it in the approvals panel (0011 APS-3b)', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    global.CustomEvent = originalCustomEvent;
    jest.restoreAllMocks();
  });

  async function loadPanelBoard(answer) {
    const env = await loadBoard();
    global.window.pagePrompts = { approvalsDocument: true, decide: jest.fn() };
    const reply = deferred();
    Object.assign(env.walletMocks, {
      safeBoard: jest.fn(() => reply.promise),
      safeState: jest.fn(),
      safeSign: jest.fn(),
      safeExecute: jest.fn(),
      safeCancelPending: jest.fn(),
    });
    return { ...env, reply, answer };
  }

  const events = () => global.window.dispatchEvent.mock.calls.map(([event]) => [event.type, event.detail]);

  test('the opener asks main and goes on at once; the chrome signs, executes and discards nothing itself', async () => {
    const env = await loadPanelBoard();
    await env.mod.openSafeSigningBoard(5, { status: 'awaiting' });
    expect(env.walletMocks.safeBoard).toHaveBeenCalledWith(5);
    for (const call of ['safeState', 'safeSign', 'safeExecute', 'safeCancelPending']) expect(env.walletMocks[call]).not.toHaveBeenCalled();
    expect(env.screen.classList.contains('hidden')).toBe(true);
    // Left in the panel: the listeners hear the board is closed.
    env.reply.resolve({ success: true, outcome: { outcome: 'parked' } });
    await flushMicrotasks();
    expect(events()).toEqual([['wallet:safe-signing-closed', undefined]]);
    expect(env.screen.classList.contains('hidden')).toBe(true);
  });

  test('executed in the panel: the summary with the explorer link, and the event the listeners wait on', async () => {
    const env = await loadPanelBoard();
    await env.mod.openSafeSigningBoard(5);
    env.reply.resolve({
      success: true,
      outcome: {
        outcome: 'executed',
        safeTxHash: '0xsafetx',
        display: { toAddress: '0xabc', formattedAmount: '1', symbol: 'xDAI' },
        executed: { hash: '0xexec', explorerUrl: 'https://gnosisscan.io/tx/0xexec' },
      },
    });
    await flushMicrotasks();
    expect(env.screen.classList.contains('hidden')).toBe(false);
    expect(global.document.getElementById('safe-signing-title').textContent).toBe('Transaction sent');
    expect(global.document.getElementById('safe-signing-content').innerHTML).toContain('https://gnosisscan.io/tx/0xexec');
    expect(events()).toEqual([['wallet:safe-executed', { safeIndex: 5, safeTxHash: '0xsafetx', hash: '0xexec' }]]);
  });

  test('discarded in the panel: the discard event, then closed', async () => {
    const env = await loadPanelBoard();
    await env.mod.openSafeSigningBoard(5);
    env.reply.resolve({ success: true, outcome: { outcome: 'discarded', safeTxHash: '0xsafetx' } });
    await flushMicrotasks();
    expect(events()).toEqual([
      ['wallet:safe-discarded', { safeIndex: 5, safeTxHash: '0xsafetx' }],
      ['wallet:safe-signing-closed', undefined],
    ]);
  });
});
