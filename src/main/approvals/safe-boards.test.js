// The Safe signing boards main runs in the approvals document (freedom-core
// design 0011, APS-3b): each board action through a decision in the panel,
// main's own view of the board (never the message session's token), and
// each decision's invocation answered once the step it started is done.

const { createSafeBoards, boardChoices, STEPS } = require('./safe-boards');

const SAFE = '0x3333333333333333333333333333333333333333';
const OWNER_A = '0x1111111111111111111111111111111111111111';
const OWNER_B = '0x2222222222222222222222222222222222222222';
const OWNER_C = '0x4444444444444444444444444444444444444444';
const TO = '0x5555555555555555555555555555555555555555';
const SAFE_INDEX = 1000;
const WINDOW = 3;

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const coded = (message, code) => Object.assign(new Error(message), { code });

/** A Safe of three owners (a vault account, a Ledger, a phone), 2 of 3. */
function backends({ threshold = 2 } = {}) {
  const state = {
    signed: new Set(),
    vaultSigns: true,
    unlocked: true,
    pending: true,
    superseded: false,
    signFails: new Map(), // owner -> error, once
    executeFails: [], // errors, in turn
    executed: [],
    cancelled: [],
    swept: 0,
    signs: [],
  };
  const owners = [
    { index: 0, address: OWNER_A, type: 'mnemonic' },
    { index: 5, address: OWNER_B, type: 'ledger' },
    { index: 6, address: OWNER_C, type: 'remote' },
  ];
  const snapshot = (extra = {}) => ({
    safeIndex: SAFE_INDEX,
    chainId: 100,
    safeTxHash: `0x${'aa'.repeat(32)}`,
    threshold,
    collected: state.signed.size,
    owners: owners.map((owner) => ({ ...owner, signed: state.signed.has(owner.index) })),
    executorIndex: 0,
    display: { site: 'bzz://evil', label: 'sending everything', amount: '1' },
    createdAt: 1,
    status: state.superseded ? 'superseded' : 'awaiting',
    ...extra,
  });
  const sign = async (owner) => {
    state.signs.push(owner);
    if (owner === undefined) {
      state.swept += 1;
      if (state.unlocked && state.vaultSigns) state.signed.add(0);
      return snapshot();
    }
    const failure = state.signFails.get(owner);
    if (failure) {
      state.signFails.delete(owner);
      throw failure;
    }
    if (owner === 0 && !state.unlocked) throw coded('The vault is locked', 'VAULT_LOCKED');
    state.signed.add(owner);
    return snapshot();
  };
  const sends = {
    state: jest.fn(() => (state.pending ? snapshot() : null)),
    sign: jest.fn((safeIndex, owner) => sign(owner)),
    execute: jest.fn(async (safeIndex, options) => {
      state.executed.push(options);
      const failure = state.executeFails.shift();
      if (failure) throw failure;
      if (state.superseded) return snapshot();
      const out = { ...snapshot(), status: 'executed', executed: { hash: `0x${'bb'.repeat(32)}`, explorerUrl: 'https://x' } };
      state.pending = false;
      return out;
    }),
    cancel: jest.fn((safeIndex) => {
      state.cancelled.push(safeIndex);
      state.pending = false;
    }),
    tx: jest.fn(() => ({ to: TO, value: 400000000000000000n, data: '0xABCD', operation: 0, nonce: 7 })),
  };
  const messages = {
    state: jest.fn((safeIndex, token) =>
      state.pending && token === 'session-1'
        ? { ...snapshot(), kind: 'message', token, display: { kind: 'message', site: 'bzz://evil', method: 'personal_sign' } }
        : null
    ),
    sign: jest.fn((safeIndex, owner, token) => {
      if (token !== 'session-1') throw new Error('not your session');
      return sign(owner);
    }),
  };
  return { state, sends, messages };
}

/** A panel: each prompt main shows, and the user's decisions on it. */
function panel() {
  const shown = [];
  const waiting = [];
  const ask = jest.fn(({ view, choices, released }) => {
    let settle;
    const decision = new Promise((resolve) => {
      settle = resolve;
    });
    const entry = { view, choices, released, settle, answered: false };
    released.then(() => {
      entry.answered = true;
    });
    shown.push(entry);
    waiting.push(entry);
    return decision;
  });
  const last = () => shown.at(-1);
  // As prompts.decide: the choices checked first.
  const decide = async (approve, raw = {}) => {
    const entry = waiting.shift();
    if (!approve) {
      entry.settle({ approve: false, choices: {} });
    } else {
      const checked = entry.choices(raw);
      if (!checked) throw new Error(`refused: ${JSON.stringify(raw)}`);
      entry.settle({ approve: true, choices: checked });
    }
    await flush();
    return entry;
  };
  return { ask, shown, last, decide, close: (reason) => waiting.shift().settle({ closed: reason }) };
}

function setup(options = {}) {
  const { state, sends, messages } = backends(options);
  const fees = [];
  const unlocks = [];
  const prompts = [];
  const boards = createSafeBoards({
    getDerivedWallets: async () => [
      { index: 0, name: 'Main Wallet', address: OWNER_A, type: 'mnemonic' },
      { index: 5, name: 'Ledger 1', address: OWNER_B, type: 'ledger' },
      { index: 6, name: 'Phone', address: OWNER_C, type: 'remote' },
      { index: SAFE_INDEX, name: 'Team Safe', address: SAFE, type: 'safe' },
    ],
    chainName: (id) => (id === 100 ? 'Gnosis Chain' : null),
    nativeSymbol: () => 'xDAI',
    sends,
    messages,
    walletPrompt: jest.fn((windowId, spec) => {
      prompts.push([windowId, spec.kind]);
      return current.ask(spec);
    }),
    walletUnlock: jest.fn(async (windowId, view) => {
      unlocks.push([windowId, view]);
      if (state.unlockAnswer === false) return { approve: false, choices: {} };
      state.unlocked = true;
      return { approve: true, choices: {} };
    }),
    confirmExecutorFee: jest.fn(async (windowId, offer) => {
      fees.push([windowId, offer]);
      return state.feeAnswer === false ? null : { confirmation: 'executor-token', gasLimit: offer.gasLimit, fees: { gasPrice: offer.gasPrice } };
    }),
    transferOf: require('./wallet-approvals').transferOf,
  });
  const current = panel();
  // A page's context: its prompts go to the same panel; its vault unlock is a prompt too.
  const context = {
    requester: { window: WINDOW },
    prompt: jest.fn((spec) => {
      if (spec.kind === 'vault.unlock') {
        unlocks.push(['page', spec.view]);
        if (state.unlockAnswer === false) return Promise.resolve({ approve: false, choices: {} });
        state.unlocked = true;
        return Promise.resolve({ approve: true, choices: {} });
      }
      prompts.push(['page', spec.kind]);
      return current.ask(spec);
    }),
  };
  return { state, sends, messages, boards, panel: current, context, fees, unlocks, prompts };
}

describe('a page\'s Safe message board', () => {
  test('main\'s view: the owners with main\'s names, the method; no token, no display, nothing the chrome said', async () => {
    const env = setup();
    env.state.unlocked = false;
    const run = env.boards.runMessageBoard(env.context, { safeIndex: SAFE_INDEX, token: 'session-1' });
    await flush();
    const { view } = env.panel.last();
    expect(env.prompts).toEqual([['page', 'eth.safe_message']]);
    expect(view).toEqual({
      safe: { index: SAFE_INDEX, name: 'Team Safe', address: SAFE },
      threshold: 2,
      collected: 0,
      owners: [
        { index: 0, name: 'Main Wallet', address: OWNER_A, type: 'mnemonic', signed: false },
        { index: 5, name: 'Ledger 1', address: OWNER_B, type: 'ledger', signed: false },
        { index: 6, name: 'Phone', address: OWNER_C, type: 'remote', signed: false },
      ],
      notes: [],
      step: STEPS.COLLECT,
      error: null,
      method: 'personal_sign',
    });
    expect(JSON.stringify(env.panel.shown.map((entry) => entry.view))).not.toContain('session-1');
    await env.panel.decide(false);
    expect(await run).toEqual({ outcome: 'rejected' });
  });

  test('the sweep when it opens; an owner signed per decision; complete once the threshold is met', async () => {
    const env = setup();
    const run = env.boards.runMessageBoard(env.context, { safeIndex: SAFE_INDEX, token: 'session-1' });
    await flush();
    // The free vault signature, swept as the board opens.
    expect(env.state.signs).toEqual([undefined]);
    expect(env.panel.last().view.collected).toBe(1);
    // Neither a signed owner nor a discard is a message board's choice.
    expect(env.panel.last().choices({ action: 'sign', owner: 0 })).toBeNull();
    expect(env.panel.last().choices({ action: 'discard' })).toBeNull();
    const decided = await env.panel.decide(true, { action: 'sign', owner: 5 });
    expect(await run).toEqual({ outcome: 'complete' });
    expect(env.state.signs).toEqual([undefined, 5]);
    // Answered once the signature is in.
    expect(decided.answered).toBe(true);
    expect(env.messages.sign).toHaveBeenCalledWith(SAFE_INDEX, 5, 'session-1');
  });

  test('a device declines: a note on its row, and the board again; the next owner signs', async () => {
    const env = setup();
    env.state.signFails.set(5, coded('Declined', 'LEDGER_USER_REJECTED'));
    env.state.signFails.set(6, coded('QR closed', 'REMOTE_USER_CANCELLED'));
    const run = env.boards.runMessageBoard(env.context, { safeIndex: SAFE_INDEX, token: 'session-1' });
    await flush();
    const first = await env.panel.decide(true, { action: 'sign', owner: 5 });
    // The board shows again before the last decision is answered.
    expect(env.panel.shown).toHaveLength(2);
    expect(first.answered).toBe(true);
    expect(env.panel.last().view.notes).toEqual([{ owner: 5, note: 'declined', message: null }]);
    await env.panel.decide(true, { action: 'sign', owner: 6 });
    expect(env.panel.last().view.notes).toEqual([{ owner: 5, note: 'declined', message: null }]);
    env.state.signFails.set(5, new Error('Ledger not connected'));
    await env.panel.decide(true, { action: 'sign', owner: 5 });
    expect(env.panel.last().view.notes).toEqual([{ owner: 5, note: 'failed', message: 'Ledger not connected' }]);
    await env.panel.decide(true, { action: 'sign', owner: 6 });
    expect(await run).toEqual({ outcome: 'complete' });
  });

  test('a locked vault: the unlock asked in the panel, then the owner signs; refused, a note', async () => {
    const env = setup({ threshold: 1 });
    env.state.unlocked = false;
    env.state.unlockAnswer = false;
    const run = env.boards.runMessageBoard(env.context, { safeIndex: SAFE_INDEX, token: 'session-1' });
    await flush();
    await env.panel.decide(true, { action: 'sign', owner: 0 });
    expect(env.unlocks).toEqual([['page', { reason: 'sign' }]]);
    expect(env.panel.last().view.notes).toEqual([{ owner: 0, note: 'locked', message: null }]);
    env.state.unlockAnswer = true;
    await env.panel.decide(true, { action: 'sign', owner: 0 });
    expect(await run).toEqual({ outcome: 'complete' });
  });

  test('the request ends while the board shows: closed, and nothing signed after', async () => {
    const env = setup();
    const run = env.boards.runMessageBoard(env.context, { safeIndex: SAFE_INDEX, token: 'session-1' });
    await flush();
    env.panel.close('navigated');
    expect(await run).toEqual({ outcome: 'closed', reason: 'navigated' });
    expect(env.state.signs).toEqual([undefined]);
  });

  test('a session gone (cancelled elsewhere): nothing to show', async () => {
    const env = setup();
    env.state.pending = false;
    expect(await env.boards.runMessageBoard(env.context, { safeIndex: SAFE_INDEX, token: 'session-1' })).toEqual({ outcome: 'gone' });
    expect(env.panel.shown).toEqual([]);
  });
});

describe('a Safe send\'s board, a page\'s or the wallet\'s own', () => {
  test('main\'s view: the SafeTx main holds, read from its data; the executor; never the stored display', async () => {
    const env = setup();
    const run = env.boards.runSendBoard(env.context, { safeIndex: SAFE_INDEX });
    await flush();
    const { view } = env.panel.last();
    expect(env.prompts).toEqual([['page', 'eth.safe_send']]);
    expect(view).toMatchObject({
      chain: { id: 100, name: 'Gnosis Chain', symbol: 'xDAI' },
      tx: { to: TO, value: '400000000000000000', data: '0xabcd' },
      transfer: null,
      executor: { index: 0, name: 'Main Wallet', address: OWNER_A },
      step: STEPS.COLLECT,
    });
    expect(JSON.stringify(view)).not.toContain('sending everything');
    expect(Object.keys(view).sort()).toEqual(
      ['chain', 'collected', 'error', 'executor', 'notes', 'owners', 'safe', 'step', 'threshold', 'transfer', 'tx'].sort()
    );
    await env.panel.decide(false);
    expect(await run).toEqual({ outcome: 'parked' });
    expect(env.sends.cancel).not.toHaveBeenCalled();
  });

  test('an owner signed, the threshold met, executed: the outcome with its hash', async () => {
    const env = setup();
    const run = env.boards.runSendBoard(env.context, { safeIndex: SAFE_INDEX });
    await flush();
    await env.panel.decide(true, { action: 'sign', owner: 5 });
    expect(await run).toEqual({
      outcome: 'executed',
      safeTxHash: `0x${'aa'.repeat(32)}`,
      display: expect.any(Object),
      executed: { hash: `0x${'bb'.repeat(32)}`, explorerUrl: 'https://x' },
    });
    expect(env.state.executed).toEqual([{}]);
  });

  test('the executor\'s fee: main\'s own offer asked in the panel\'s window, then executed with that confirmation', async () => {
    const env = setup();
    const offer = { executorIndex: 0, chainId: 100, to: SAFE, value: '0', data: '0x6a76', gasLimit: '90000', gasPrice: '1000000000' };
    env.state.executeFails.push(Object.assign(coded('needs confirmation', 'FEE_CHECK_NEEDS_CONFIRMATION'), { offer, feeCheck: {} }));
    const run = env.boards.runSendBoard(env.context, { safeIndex: SAFE_INDEX });
    await flush();
    await env.panel.decide(true, { action: 'sign', owner: 6 });
    expect((await run).outcome).toBe('executed');
    expect(env.fees).toEqual([[WINDOW, offer]]);
    expect(env.state.executed).toEqual([{}, { feeConfirmation: { confirmation: 'executor-token', gasLimit: '90000', fees: { gasPrice: '1000000000' } } }]);
  });

  test('the fee not confirmed: the board says so, and "try again" asks again', async () => {
    const env = setup();
    const offer = { executorIndex: 0, chainId: 100, to: SAFE, value: '0', data: '0x', gasLimit: '90000', gasPrice: '1' };
    const needs = () => Object.assign(coded('needs confirmation', 'FEE_CHECK_NEEDS_CONFIRMATION'), { offer });
    env.state.executeFails.push(needs(), needs());
    env.state.feeAnswer = false;
    const run = env.boards.runSendBoard(env.context, { safeIndex: SAFE_INDEX });
    await flush();
    await env.panel.decide(true, { action: 'sign', owner: 5 });
    expect(env.panel.last().view).toMatchObject({ step: STEPS.RETRY, error: { code: 'fee', message: null } });
    // Signing isn't a choice once the threshold is met.
    expect(env.panel.last().choices({ action: 'sign', owner: 6 })).toBeNull();
    env.state.feeAnswer = true;
    await env.panel.decide(true, { action: 'retry' });
    expect((await run).outcome).toBe('executed');
    expect(env.fees).toHaveLength(2);
  });

  test('no funds: "try again" once funded; a locked vault asks for its unlock and executes', async () => {
    const env = setup();
    env.state.executeFails.push(coded('insufficient funds for gas', 'SAFE_NEEDS_FUNDS'), coded('locked', 'VAULT_LOCKED'));
    const run = env.boards.openWalletBoard(WINDOW, SAFE_INDEX);
    await flush();
    await env.panel.decide(true, { action: 'sign', owner: 5 });
    expect(env.panel.last().view).toMatchObject({
      step: STEPS.RETRY,
      error: { code: 'needs-funds', message: 'insufficient funds for gas' },
    });
    await env.panel.decide(true, { action: 'retry' });
    expect((await run).outcome).toBe('executed');
    expect(env.unlocks).toEqual([[WINDOW, { reason: 'send' }]]);
    expect(env.prompts.every(([windowId, kind]) => windowId === WINDOW && kind === 'wallet.safe_board')).toBe(true);
  });

  test('discard is its own choice, asked again; "keep" goes back to the board; the second press discards', async () => {
    const env = setup();
    const run = env.boards.openWalletBoard(WINDOW, SAFE_INDEX);
    await flush();
    await env.panel.decide(true, { action: 'discard' });
    expect(env.panel.last().view.step).toBe(STEPS.DISCARD);
    expect(env.sends.cancel).not.toHaveBeenCalled();
    // A signature isn't a choice while the discard is asked.
    expect(env.panel.last().choices({ action: 'sign', owner: 5 })).toBeNull();
    await env.panel.decide(false);
    expect(env.panel.last().view.step).toBe(STEPS.COLLECT);
    await env.panel.decide(true, { action: 'discard' });
    await env.panel.decide(true, { action: 'discard' });
    expect(await run).toEqual({ outcome: 'discarded', safeTxHash: `0x${'aa'.repeat(32)}` });
    expect(env.sends.cancel).toHaveBeenCalledWith(SAFE_INDEX);
  });

  test('a discard refused (a step still running): the board says why', async () => {
    const env = setup();
    env.sends.cancel.mockImplementationOnce(() => {
      throw coded('Wait for the current step to finish first', 'SAFE_BUSY');
    });
    const run = env.boards.openWalletBoard(WINDOW, SAFE_INDEX);
    await flush();
    await env.panel.decide(true, { action: 'discard' });
    await env.panel.decide(true, { action: 'discard' });
    expect(env.panel.last().view).toMatchObject({ step: STEPS.RETRY, error: { code: 'failed', message: 'Wait for the current step to finish first' } });
    await env.panel.decide(false);
    expect(await run).toEqual({ outcome: 'parked' });
  });

  test('superseded: only its discard is offered', async () => {
    const env = setup();
    env.state.superseded = true;
    const run = env.boards.openWalletBoard(WINDOW, SAFE_INDEX);
    await flush();
    // No sweep for a SafeTx that can't execute.
    expect(env.state.signs).toEqual([]);
    expect(env.panel.last().view.step).toBe(STEPS.SUPERSEDED);
    expect(env.panel.last().choices({ action: 'sign', owner: 5 })).toBeNull();
    expect(env.panel.last().choices({ action: 'retry' })).toBeNull();
    await env.panel.decide(true, { action: 'discard' });
    await env.panel.decide(true, { action: 'discard' });
    expect((await run).outcome).toBe('discarded');
  });

  test('the wallet\'s board: one at a time per Safe, in a window', async () => {
    const env = setup();
    const run = env.boards.openWalletBoard(WINDOW, SAFE_INDEX);
    await flush();
    expect(await env.boards.openWalletBoard(WINDOW, SAFE_INDEX)).toEqual({ outcome: 'open' });
    expect(await env.boards.openWalletBoard(null, SAFE_INDEX)).toEqual({ outcome: 'no-window' });
    await env.panel.decide(false);
    expect(await run).toEqual({ outcome: 'parked' });
    // Open again once it ended.
    const again = env.boards.openWalletBoard(WINDOW, SAFE_INDEX);
    await flush();
    env.panel.close('closed');
    expect(await again).toEqual({ outcome: 'closed', reason: 'closed' });
  });
});

describe('boardChoices: what a decision may choose, for the view main shows', () => {
  const view = (step, owners = [{ index: 1, signed: false }, { index: 2, signed: true }]) => ({ step, owners });
  test.each([
    ['send', view('collect'), { action: 'sign', owner: 1 }, { action: 'sign', owner: 1 }],
    ['send', view('collect'), { action: 'sign', owner: 2 }, null],
    ['send', view('collect'), { action: 'sign', owner: '1' }, null],
    ['send', view('collect'), { action: 'sign' }, null],
    ['send', view('collect'), { action: 'sign', owner: 1, approve: true }, null],
    ['send', view('collect'), { action: 'discard' }, { action: 'discard' }],
    ['send', view('collect'), { action: 'retry' }, null],
    ['send', view('retry'), { action: 'retry' }, { action: 'retry' }],
    ['send', view('discard'), { action: 'discard' }, { action: 'discard' }],
    ['send', view('collect'), {}, null],
    ['send', view('collect'), { action: 'execute' }, null],
    ['message', view('collect'), { action: 'discard' }, null],
    ['message', view('collect'), { action: 'sign', owner: 1 }, { action: 'sign', owner: 1 }],
  ])('%s %j: %j -> %j', (board, shown, raw, expected) => {
    expect(boardChoices(board, shown)(raw)).toEqual(expected);
  });
});
