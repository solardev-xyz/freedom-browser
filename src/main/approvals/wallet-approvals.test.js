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

// x402 (APS-5): main's token list, its reading of an entry, the paid URL's
// key and the caps it holds, as the app's are.
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const CAPS = new Map([['https://pay.example|8453|' + USDC, { origin: 'https://pay.example', chainId: 8453, asset: USDC, capAmount: '5000000', spentAmount: '1250000', createdAt: 1000, expiresAt: 87400 }]]);
const X402_DEPS = {
  chainName: (chainId) => ({ 100: 'Gnosis Chain', 8453: 'Base' })[chainId] ?? null,
  nativeSymbol: (chainId) => ({ 100: 'xDAI', 8453: 'ETH' })[chainId] ?? null,
  tokenOf: (chainId, asset) => (chainId === 8453 && asset.toLowerCase() === USDC ? { symbol: 'USDC', decimals: 6, name: 'USD Coin' } : null),
  x402Tuple: (accept) =>
    typeof accept?.network === 'string' && accept.network.startsWith('eip155:')
      ? { chainId: Number(accept.network.slice(7)), asset: accept.asset.toLowerCase(), amount: accept.amount }
      : null,
  x402Origin: (url) => new URL(url).origin,
  // As the store: the origin normalised, the asset in any case.
  x402Cap: (origin, chainId, asset) => CAPS.get(`${new URL(origin).origin}|${chainId}|${asset.toLowerCase()}`) ?? null,
};

function setup({ verdict = BELOW, atPress = [], wallets = async () => WALLETS, now = () => 0 } = {}) {
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
    ...X402_DEPS,
    checkFees: jest.fn(async () => verdict),
    checkAtApproval,
    now: () => now(),
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

// APS-4: a held payment's resend asked again by the chrome, because the
// payment was replaced after the first approval, says so in the panel.
describe('a resend asked again after a replacement', () => {
  const RESEND = PAYLOADS['intent-resend'][1];
  const REPLACED = { ...RESEND, hash: `0x${'cd'.repeat(32)}` };
  const ask = (env, payload) =>
    env.approvals.confirm({ sender: chrome, kind: 'intent-resend', index: null, payload, feeChecked: false }, () => ({ token: 't' }));

  test('names the transaction approved before; a first ask, and the same transaction again, name none', async () => {
    const env = setup();
    await ask(env, RESEND);
    expect(env.prompts[0].view.replaced).toBeNull();
    await ask(env, REPLACED);
    expect(env.prompts[1].view.replaced).toBe(HASH);
    expect(kinds.checkMessage(message('wallet.intent_resend', env.prompts[1].view)).valid).toBe(true);
    // Read once: the next ask of the same transaction is a plain one.
    await ask(env, REPLACED);
    expect(env.prompts[2].view.replaced).toBeNull();
  });

  test('not after a rejection, not for another payment, and not once the approval\'s token has lapsed', async () => {
    let clock = 0;
    const env = setup({ now: () => clock });
    env.decisions.push({ approve: false });
    await ask(env, RESEND);
    await ask(env, REPLACED);
    expect(env.prompts[1].view.replaced).toBeNull();
    await ask(env, RESEND);
    await ask(env, { ...REPLACED, intentId: 'intent-456' });
    expect(env.prompts[3].view.replaced).toBeNull();
    await ask(env, RESEND);
    clock += 2 * 60 * 1000 + 1;
    await ask(env, REPLACED);
    expect(env.prompts[5].view.replaced).toBeNull();
  });
});

// freedom-core design 0011, APS-5: x402's payment and an auto-pay cap's edit
// ask in the window's panel, with main's view, so that with the document on
// the chrome mints no approval at all.
describe('x402\'s two kinds ask in the window\'s panel', () => {
  const PAYMENT = {
    webContentsId: 42,
    detectionId: 'req-9100',
    url: 'https://pay.example/article?id=7',
    acceptIndex: 1,
    accept: { scheme: 'exact', network: 'eip155:8453', amount: '2500000', asset: USDC, payTo: TO, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } },
    grant: null,
  };
  const CAP_EDIT = {
    window: 501,
    origin: 'https://PAY.example',
    chainId: 8453,
    asset: USDC,
    capAmount: '10000000',
    windowSeconds: undefined,
    current: { capAmount: '5000000', createdAt: 1000, expiresAt: 87400, generation: 3 },
  };

  test('a payment: main\'s view of the active account, the seller\'s entry and the grant, fitting its template', async () => {
    const env = setup();
    const minted = await env.approvals.confirm({ sender: chrome, kind: 'x402-payment', index: 0, payload: PAYMENT, feeChecked: false }, () => ({ token: 't' }));
    expect(minted).toEqual({ token: 't', approved: true });
    const [prompt] = env.prompts;
    expect(prompt.windowId).toBe(1);
    expect(prompt.kind).toBe('wallet.x402_payment');
    expect(prompt.view).toEqual({
      account: WALLETS[0],
      site: 'https://pay.example',
      url: PAYMENT.url,
      payment: { scheme: 'exact', network: 'eip155:8453', asset: USDC, amount: '2500000', payTo: TO },
      chain: { id: 8453, name: 'Base', symbol: 'ETH' },
      token: { symbol: 'USDC', decimals: 6 },
      grant: null,
    });
    expect(kinds.checkMessage(message(prompt.kind, prompt.view)).valid).toBe(true);
    expect(prompt.choices({})).toEqual({});
    expect(prompt.choices({ grant: { capAmount: '1' } })).toBeNull();

    // With an allowance, on a phone account; a V1 entry main reads no chain for.
    await env.approvals.confirm({
      sender: chrome,
      kind: 'x402-payment',
      index: 1,
      payload: { ...PAYMENT, accept: { scheme: 'exact', network: 'base', maxAmountRequired: '7', asset: USDC, payTo: TO }, grant: { capAmount: '9000000', windowSeconds: 86400 } },
    });
    const v1 = env.prompts[1].view;
    expect(v1).toMatchObject({ account: { index: 1, type: 'ledger' }, chain: null, token: null, grant: { capAmount: '9000000', windowSeconds: 86400 } });
    expect(v1.payment.amount).toBe('7');
    expect(kinds.checkMessage(message('wallet.x402_payment', v1)).valid).toBe(true);
  });

  test('a payment: a rejection says no, and an account main can\'t show asks nothing', async () => {
    const env = setup();
    env.decisions.push({ approve: false, choices: {} });
    const onApproved = jest.fn(() => ({ token: 't' }));
    expect(await env.approvals.confirm({ sender: chrome, kind: 'x402-payment', index: 0, payload: PAYMENT }, onApproved)).toEqual(REJECTED);
    expect(await env.approvals.confirm({ sender: chrome, kind: 'x402-payment', index: 77, payload: PAYMENT }, onApproved)).toEqual(NO_ACCOUNT);
    expect(env.prompts).toHaveLength(1);
    expect(onApproved).not.toHaveBeenCalled();
  });

  test('a cap\'s edit: main\'s view of the cap it holds and the change, fitting its template', async () => {
    const env = setup();
    expect(await env.approvals.confirm({ sender: chrome, kind: 'x402-cap-update', index: null, payload: CAP_EDIT })).toEqual({ approved: true });
    const [prompt] = env.prompts;
    expect(prompt.kind).toBe('wallet.x402_cap_update');
    expect(prompt.view).toEqual({
      site: 'https://pay.example',
      chain: { id: 8453, name: 'Base', symbol: 'ETH' },
      asset: USDC,
      token: { symbol: 'USDC', decimals: 6 },
      current: { capAmount: '5000000', spentAmount: '1250000', expiresAt: 87400 },
      change: { capAmount: '10000000', windowSeconds: null, expiresAt: null },
    });
    expect(kinds.checkMessage(message(prompt.kind, prompt.view)).valid).toBe(true);
    // A new window: its end from the grant's start, as the store computes it.
    await env.approvals.confirm({ sender: chrome, kind: 'x402-cap-update', index: null, payload: { ...CAP_EDIT, capAmount: undefined, windowSeconds: 7 * 86400 } });
    expect(env.prompts[1].view.change).toEqual({ capAmount: null, windowSeconds: 7 * 86400, expiresAt: 1000 + 7 * 86400 });
  });

  test('a cap\'s edit main can\'t show asks nothing', async () => {
    const env = setup();
    await expect(env.approvals.confirm({ sender: chrome, kind: 'x402-cap-update', index: null, payload: { ...CAP_EDIT, asset: TO } })).rejects.toThrow('No such auto-pay cap');
    await expect(env.approvals.confirm({ sender: chrome, kind: 'x402-cap-update', index: null, payload: { ...CAP_EDIT, windowSeconds: 1.5 } })).rejects.toThrow('Invalid window');
    expect(env.prompts).toHaveLength(0);
  });
});
