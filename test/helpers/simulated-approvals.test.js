/**
 * The simulated core's callers (simulated-approvals.js) are the real core's
 * (cored 0.16.0): only a PageContext is a page. The chrome (vault-backend's
 * `'chrome'`) and main itself (`shell`, no context) are never one, so a
 * site's standing rule, here one that covers everything, answers neither:
 * `approval.check` is `forbidden` to them (the method table admits a page
 * only), and `{ standing }` on a signature is `not_authorized` / `no_rule`.
 */
const { simulatedApprovals } = require('./simulated-approvals');

const PAGE = Object.freeze({
  origin: 'https://app.example',
  top_origin: 'https://app.example',
  frame: 1,
  navigation: 2,
  agent: false,
});
const MESSAGE = { message: '0x68656c6c6f' };
const CHECK = { request: { kind: 'message', account: 0, account_kind: 'vault', ...MESSAGE } };
const STANDING = { authorization: { standing: {} } };

function refusalOf(fn) {
  try {
    fn();
  } catch (err) {
    return { code: err.code, reason: err.data?.reason };
  }
  throw new Error('expected a refusal');
}

describe('the simulated core tells a page from the chrome and from main', () => {
  let approvals;
  beforeEach(() => {
    approvals = simulatedApprovals();
    approvals.setStanding(() => ({ covered: true }));
  });

  test('approval.check: a page is covered by the rule; the chrome and main are refused', async () => {
    await expect(approvals.approval.check(CHECK, PAGE)).resolves.toEqual({ covered: true });
    for (const caller of ['chrome', null, undefined]) {
      await expect(approvals.approval.check(CHECK, caller)).rejects.toMatchObject({ code: 'forbidden' });
    }
  });

  test('{ standing } on a signature: a page signs under the rule; the chrome and main get no_rule', () => {
    expect(approvals.authorize('sign.message', 0, MESSAGE, { ...STANDING, page: PAGE })).toBeNull();
    for (const page of ['chrome', null]) {
      expect(refusalOf(() => approvals.authorize('sign.message', 0, MESSAGE, { ...STANDING, page }))).toEqual({
        code: 'not_authorized',
        reason: 'no_rule',
      });
    }
  });

  test('no authorization: main signs on its word; a page and the chrome get no_token', () => {
    expect(approvals.authorize('sign.message', 0, MESSAGE, { page: null })).toBeNull();
    for (const page of [PAGE, 'chrome']) {
      expect(refusalOf(() => approvals.authorize('sign.message', 0, MESSAGE, { page }))).toEqual({
        code: 'not_authorized',
        reason: 'no_token',
      });
    }
  });

  test('the chrome mints no token, spends none of main\'s, and presents no Safe approval', async () => {
    const send = { kind: 'wallet-send', account: 0, payload: { tx: { to: '0x' + '22'.repeat(20), chain_id: 100 } } };
    await expect(approvals.approval.issue(send, 'chrome')).rejects.toMatchObject({ code: 'forbidden' });
    const { token } = await approvals.approval.issue(send);
    await expect(approvals.approval.spend({ token, ...send }, 'chrome')).rejects.toMatchObject({
      code: 'not_authorized',
      data: { reason: 'mismatch' },
    });
    const safe = approvals.openSafeApproval({ kind: 'safe-message' });
    const typed = { typed_data: { domain: {}, types: { SafeMessage: [{ name: 'message', type: 'bytes' }] }, message: {} } };
    expect(refusalOf(() => approvals.authorize('sign.typed_data', 0, typed, { authorization: { safe }, page: 'chrome' }))).toEqual({
      code: 'not_authorized',
      reason: 'mismatch',
    });
    expect(approvals.authorize('sign.typed_data', 0, typed, { authorization: { safe }, page: null })).toBeNull();
  });

  test('the store writes a page alone makes: approval.touch from the chrome or main is refused', async () => {
    await expect(approvals.approval.touch({ store: 'dapp' }, PAGE)).resolves.toEqual({});
    for (const caller of ['chrome', null]) {
      await expect(approvals.approval.touch({ store: 'dapp' }, caller)).rejects.toMatchObject({ code: 'forbidden' });
    }
  });

  // A device send's finalize receipt (cored 0.16.0, "A device send's rule"):
  // given only to a page's flagged dApp send, presented only by that page.
  test("a receipt: given to a page's flagged spend alone, presented by that page alone; the chrome and main are refused and leave it", async () => {
    const payload = {
      tx: { to: '0x' + '11'.repeat(20), value: '0', data: '0x095ea7b3' + '00'.repeat(4), chain_id: '100' },
      remember: true,
    };
    const handle = 'c'.repeat(64);
    const flagged = async () => {
      const { token } = await approvals.approval.issue({ kind: 'dapp-send', account: 3, payload, handle }, PAGE);
      return approvals.approval.spend({ token, kind: 'dapp-send', account: 3, payload, handle }, PAGE);
    };
    const { receipt } = await flagged();
    expect(receipt).toMatch(/^[0-9a-f]{32}$/);
    for (const caller of ['chrome', null]) {
      await expect(approvals.approval.remember({ receipt }, caller)).rejects.toMatchObject({ code: 'forbidden' });
    }
    expect(approvals.openReceipts()).toBe(1);
    approvals.dapp.connect(PAGE.origin, 3, 100);
    await expect(approvals.approval.remember({ receipt }, PAGE)).resolves.toEqual({ rule: { added: true } });
    await expect(approvals.approval.remember({ receipt }, PAGE)).rejects.toMatchObject({ code: 'not_authorized', data: { reason: 'unknown_token' } });
    // Another document of the page's origin takes it, writing nothing.
    const other = (await flagged()).receipt;
    await expect(approvals.approval.remember({ receipt: other }, { ...PAGE, navigation: 3 })).rejects.toMatchObject({
      data: { reason: 'mismatch' },
    });
    expect(approvals.openReceipts()).toBe(0);
  });
});
