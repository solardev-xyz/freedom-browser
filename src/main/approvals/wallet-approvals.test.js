// The wallet's own approvals in the approvals document (freedom-core design
// 0011, APS-3): the chrome's `wallet:confirm-signing` for one of the six
// wallet kinds asks in the window's panel, with main's view of exactly the
// request the token binds, and is answered yes only on the user's approval
// there; a fee above the threshold is asked again in the panel itself.

const { createWalletApprovals, PROMPT_KINDS, REJECTED, NO_ACCOUNT, transferOf } = require('./wallet-approvals');
const kinds = require('../../renderer/approvals/approvals-kinds.js');

const ACTIVE = '0x1111111111111111111111111111111111111111';
const SAFE = '0x3333333333333333333333333333333333333333';
const TO = '0x2222222222222222222222222222222222222222';
const HASH = `0x${'ab'.repeat(32)}`;
const WALLETS = [
  { index: 0, name: 'Main Wallet', address: ACTIVE, type: 'mnemonic' },
  { index: 1, name: 'Ledger', address: TO, type: 'ledger' },
  { index: 1000, name: 'Team Safe', address: SAFE, type: 'safe' },
];
const BELOW = { maxCost: '21000000000000', comparable: true, ratio: '1.0', above: false, oneEndpoint: false, basis: 'header', autoApprove: true };
const ABOVE = { ...BELOW, ratio: '4.5', above: true, autoApprove: false };

const SEND = { chainId: 100, to: TO, value: '1000000000000000000', data: '0x', gasLimit: '21000', maxFeePerGas: '1000000000', maxPriorityFeePerGas: '1000000' };
const PAYLOADS = {
  'wallet-send': [null, SEND],
  'safe-send': [1000, { tx: { to: TO, value: '0', data: '0x' }, chainId: 100 }],
  'intent-resend': [null, { intentId: 'intent-123', chainId: 100, sender: ACTIVE, nonce: 7, hash: HASH }],
  'intent-replace': [null, { intentId: 'intent-123', chainId: 100, sender: ACTIVE, nonce: 7, to: TO, value: '0', data: '0x', gasLimit: '21000', gasPrice: '3000000000' }],
  'intent-close': [null, { intentId: 'intent-123', chainId: 100, sender: ACTIVE, nonce: 7, hashes: [HASH] }],
  'executor-send': [0, { chainId: 100, to: SAFE, value: '0', data: '0x6a761202', gasLimit: '90000', gasPrice: '2000000000' }],
};

function setup({ verdict = BELOW, atPress = [], wallets = async () => WALLETS } = {}) {
  const prompts = [];
  const decisions = [];
  const answers = [...atPress];
  const checkAtApproval = jest.fn(async (_tx, { acknowledged }) => {
    const next = answers.length ? answers.shift() : { ...verdict, askAgain: verdict.above && !acknowledged };
    return next;
  });
  const approvals = createWalletApprovals({
    walletPrompt: jest.fn(async (windowId, spec) => {
      prompts.push({ windowId, ...spec });
      return decisions.length ? decisions.shift() : { approve: true, choices: {} };
    }),
    chromeWindowOf: (contents) => (contents?.id >= 500 ? contents.id - 500 : null),
    getDerivedWallets: wallets,
    chainName: (chainId) => (chainId === 100 ? 'Gnosis Chain' : null),
    nativeSymbol: (chainId) => (chainId === 100 ? 'xDAI' : null),
    checkFees: jest.fn(async () => verdict),
    checkAtApproval,
  });
  return { approvals, prompts, decisions, checkAtApproval };
}

const chrome = { id: 501 };
const message = (kind, view) => ({ handle: 'c'.repeat(64), guest: null, kind, site: { key: 'freedom:wallet', label: 'Your wallet' }, view });

describe('the six wallet kinds ask in the window\'s panel', () => {
  test.each(Object.keys(PAYLOADS))('%s: main\'s view fits its template\'s schema, and an approval says yes', async (kind) => {
    const env = setup();
    const [index, payload] = PAYLOADS[kind];
    const feeChecked = ['wallet-send', 'intent-replace', 'executor-send'].includes(kind);
    expect(await env.approvals.confirm({ sender: chrome, kind, index: kind === 'wallet-send' ? 0 : index, payload, feeChecked })).toEqual({
      approved: true,
    });
    expect(env.prompts).toHaveLength(1);
    const [prompt] = env.prompts;
    expect(prompt.windowId).toBe(1);
    expect(prompt.kind).toBe(PROMPT_KINDS[kind]);
    expect(kinds.checkMessage(message(prompt.kind, prompt.view)).valid).toBe(true);
    // Approve only: no choices.
    expect(prompt.choices({})).toEqual({});
    expect(prompt.choices({ feeAcknowledged: true })).toBeNull();
  });

  test('a rejection, or the prompt closing, says no; no window says no', async () => {
    const env = setup();
    env.decisions.push({ approve: false, choices: {} }, { closed: 'closed' });
    const [index, payload] = PAYLOADS['safe-send'];
    expect(await env.approvals.confirm({ sender: chrome, kind: 'safe-send', index, payload })).toEqual(REJECTED);
    expect(await env.approvals.confirm({ sender: chrome, kind: 'safe-send', index, payload })).toEqual(REJECTED);
    expect(await env.approvals.confirm({ sender: { id: 7 }, kind: 'safe-send', index, payload })).toMatchObject({ approved: false, code: 'NO_WINDOW' });
    await expect(env.approvals.confirm({ sender: chrome, kind: 'dapp-send', index, payload })).rejects.toThrow('not a wallet kind');
  });

  test('a fee above the threshold is asked again in the panel, and its second press confirms it', async () => {
    const env = setup({ verdict: ABOVE });
    const [, payload] = PAYLOADS['wallet-send'];
    expect(await env.approvals.confirm({ sender: chrome, kind: 'wallet-send', index: 0, payload, feeChecked: true })).toEqual({ approved: true });
    expect(env.prompts.map((p) => [p.view.feeCheck.above, p.view.feeAskAgain])).toEqual([
      [true, false],
      [true, true],
    ]);
    // The fee at each press: the first not acknowledged, the second so.
    expect(env.checkAtApproval.mock.calls.map(([, options]) => options)).toEqual([{ acknowledged: false }, { acknowledged: true }]);
  });

  test('a fee newly above at the press is asked again; one no longer above needs no second press', async () => {
    const newly = setup({ verdict: BELOW, atPress: [{ ...ABOVE, askAgain: true }, { ...ABOVE, askAgain: false }] });
    const [, payload] = PAYLOADS['intent-replace'];
    expect(await newly.approvals.confirm({ sender: chrome, kind: 'intent-replace', index: null, payload, feeChecked: true })).toEqual({ approved: true });
    expect(newly.prompts.map((p) => [p.view.feeCheck.above, p.view.feeAskAgain])).toEqual([
      [false, false],
      [true, true],
    ]);
    // Rejected at the second prompt: no.
    const declined = setup({ verdict: ABOVE });
    declined.decisions.push({ approve: true, choices: {} }, { approve: false, choices: {} });
    expect(await declined.approvals.confirm({ sender: chrome, kind: 'wallet-send', index: 0, payload: SEND, feeChecked: true })).toEqual(REJECTED);
  });

  test('a phone pays its own fee: no fee check, and the view says so', async () => {
    const env = setup();
    expect(await env.approvals.confirm({ sender: chrome, kind: 'wallet-send', index: 0, payload: SEND, feeChecked: false })).toEqual({ approved: true });
    expect(env.prompts[0].view.feeCheck).toBeNull();
  });
});

// Codex, #1210: the panel's invocation is answered once its decision is
// acted on, and a window's prompt has no request of its own to wait for.
describe('each decision is released once what it started is done', () => {
  const settledYet = async (promise) => {
    let settled = false;
    promise.then(() => (settled = true));
    await new Promise((resolve) => setImmediate(resolve));
    return settled;
  };

  test('an approval once the token is minted; a rejection at once; a fee asked again once main has its verdict', async () => {
    const env = setup();
    let releasedAtMint = null;
    const outcome = await env.approvals.confirm({ sender: chrome, kind: 'wallet-send', index: 0, payload: SEND, feeChecked: true }, async () => {
      releasedAtMint = await settledYet(env.prompts[0].released);
      return { token: 'token', expiresAt: 1 };
    });
    expect(outcome).toEqual({ token: 'token', expiresAt: 1, approved: true });
    expect(env.prompts[0].released).toBeInstanceOf(Promise);
    expect(releasedAtMint).toBe(false);
    expect(await settledYet(env.prompts[0].released)).toBe(true);

    const rejected = setup();
    rejected.decisions.push({ approve: false, choices: {} });
    const mint = jest.fn();
    expect(await rejected.approvals.confirm({ sender: chrome, kind: 'intent-close', index: null, payload: PAYLOADS['intent-close'][1] }, mint)).toEqual(REJECTED);
    expect(mint).not.toHaveBeenCalled();
    expect(await settledYet(rejected.prompts[0].released)).toBe(true);

    // A mint that throws is released all the same.
    const failing = setup();
    await expect(
      failing.approvals.confirm({ sender: chrome, kind: 'safe-send', index: 1000, payload: PAYLOADS['safe-send'][1] }, () => {
        throw new Error('mint failed');
      })
    ).rejects.toThrow('mint failed');
    expect(await settledYet(failing.prompts[0].released)).toBe(true);

    const twice = setup({ verdict: ABOVE });
    let firstReleasedAtSecond = null;
    expect(
      await twice.approvals.confirm({ sender: chrome, kind: 'wallet-send', index: 0, payload: SEND, feeChecked: true }, async () => {
        firstReleasedAtSecond = await settledYet(twice.prompts[0].released);
        return {};
      })
    ).toEqual({ approved: true });
    expect(twice.prompts).toHaveLength(2);
    expect(firstReleasedAtSecond).toBe(true);
  });
});

// Codex, #1210: a token that binds an account's index is asked for only
// with that account, as main's wallet list has it, in the panel.
describe('an index-bound kind whose account main can\'t show asks nothing', () => {
  test.each(['wallet-send', 'safe-send', 'executor-send'])('%s: the wallet list unreadable, or no account at its index', async (kind) => {
    const [index, payload] = PAYLOADS[kind];
    const bound = kind === 'wallet-send' ? 0 : index;
    const feeChecked = kind !== 'safe-send';
    const unreadable = setup({
      wallets: async () => {
        throw new Error('vault meta unreadable');
      },
    });
    expect(await unreadable.approvals.confirm({ sender: chrome, kind, index: bound, payload, feeChecked })).toEqual(NO_ACCOUNT);
    expect(unreadable.prompts).toHaveLength(0);
    const notAList = setup({ wallets: async () => null });
    expect(await notAList.approvals.confirm({ sender: chrome, kind, index: bound, payload, feeChecked })).toEqual(NO_ACCOUNT);
    for (const missing of [7, null, '0', 1.5]) {
      const env = setup();
      expect(await env.approvals.confirm({ sender: chrome, kind, index: missing, payload, feeChecked })).toEqual(NO_ACCOUNT);
      expect(env.prompts).toHaveLength(0);
    }
    expect(NO_ACCOUNT).toMatchObject({ approved: false, code: 'ACCOUNT_UNKNOWN' });
  });

  test('an intent\'s sender may have left the wallet: its address shows, as not in this wallet', async () => {
    const env = setup({
      wallets: async () => {
        throw new Error('vault meta unreadable');
      },
    });
    const [, payload] = PAYLOADS['intent-close'];
    expect(await env.approvals.confirm({ sender: chrome, kind: 'intent-close', index: null, payload })).toEqual({ approved: true });
    expect(env.prompts[0].view.account).toEqual({ index: null, name: '', address: ACTIVE, type: 'unknown' });
    expect(kinds.checkMessage(message('wallet.intent_close', env.prompts[0].view)).valid).toBe(true);
  });
});

describe('main\'s views', () => {
  test('the account by index or by address, the chain\'s name and symbol, and a token transfer read from the data', async () => {
    const env = setup();
    const data = `0xa9059cbb${'0'.repeat(24)}${TO.slice(2)}${(5n * 10n ** 18n).toString(16).padStart(64, '0')}`;
    const view = await env.approvals.viewOf('wallet-send', 0, { ...SEND, value: '0', data }, { verdict: BELOW, askAgain: false });
    expect(view.account).toEqual({ index: 0, name: 'Main Wallet', address: ACTIVE, type: 'mnemonic' });
    expect(view.chain).toEqual({ id: 100, name: 'Gnosis Chain', symbol: 'xDAI' });
    expect(view.transfer).toEqual({ token: TO, recipient: TO.toLowerCase(), amount: '5000000000000000000' });
    expect(view.fee).toEqual({ gasLimit: '21000', maxFeePerGas: '1000000000', maxPriorityFeePerGas: '1000000' });
    const intent = await env.approvals.viewOf('intent-close', null, PAYLOADS['intent-close'][1], { verdict: null, askAgain: false });
    expect(intent.account.name).toBe('Main Wallet');
    const stranger = await env.approvals.viewOf('intent-resend', null, { ...PAYLOADS['intent-resend'][1], sender: SAFE.replace('3', '4') }, {});
    expect(stranger.account).toMatchObject({ index: null, type: 'unknown' });
    expect(kinds.checkMessage(message('wallet.intent_resend', stranger)).valid).toBe(true);
    expect(transferOf({ to: TO, data: '0xa9059cbb' })).toBeNull();
  });
});

describe('a step main runs in a window: a Safe board\'s executor fee (APS-3b)', () => {
  test('asked in the window named, with no sender; above the threshold, asked again there; minted on the second press', async () => {
    const env = setup({ verdict: ABOVE });
    const [index, payload] = PAYLOADS['executor-send'];
    const minted = jest.fn(() => ({ token: 'executor-token' }));
    expect(await env.approvals.confirm({ windowId: 4, kind: 'executor-send', index, payload, feeChecked: true }, minted)).toEqual({
      approved: true,
      token: 'executor-token',
    });
    expect(env.prompts.map((prompt) => [prompt.windowId, prompt.kind, prompt.view.feeAskAgain])).toEqual([
      [4, 'wallet.executor_send', false],
      [4, 'wallet.executor_send', true],
    ]);
    expect(minted).toHaveBeenCalledTimes(1);
  });

  test('a window id wins over a sender; neither is no window', async () => {
    const env = setup();
    const [index, payload] = PAYLOADS['executor-send'];
    await env.approvals.confirm({ windowId: 4, sender: chrome, kind: 'executor-send', index, payload, feeChecked: true });
    expect(env.prompts.map((prompt) => prompt.windowId)).toEqual([4]);
    expect((await env.approvals.confirm({ kind: 'executor-send', index, payload, feeChecked: true })).code).toBe('NO_WINDOW');
  });
});
