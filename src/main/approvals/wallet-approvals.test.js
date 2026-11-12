// The wallet's own approvals in the approvals document (freedom-core design
// 0011, APS-3): the chrome's `wallet:confirm-signing` for one of the six
// wallet kinds asks in the window's panel, with main's view of exactly the
// request the token binds, and is answered yes only on the user's approval
// there; a fee above the threshold is asked again in the panel itself.

const { createWalletApprovals, PROMPT_KINDS, REJECTED, transferOf } = require('./wallet-approvals');
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

function setup({ verdict = BELOW, atPress = [] } = {}) {
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
    getDerivedWallets: async () => WALLETS,
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
