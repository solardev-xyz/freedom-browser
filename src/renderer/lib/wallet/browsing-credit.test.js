let mod;

beforeAll(async () => {
  mod = await import('./browsing-credit.js');
});

const XBZZ = 10n ** 16n;
const plur = (micro) => ((BigInt(micro) * XBZZ) / 1_000_000n).toString();

function credit(overrides = {}) {
  return {
    node: 'running',
    support: 'supported',
    swapEnable: true,
    toggle: { inProgress: false, error: null },
    chequebook: {
      address: '0x' + 'ab'.repeat(20),
      total: '0.001',
      available: '0.0008',
      totalPlur: plur(1000),
      availablePlur: plur(800),
      availableExact: true,
    },
    spend: { day: '0.0002', week: '0.0005', dayPlur: plur(200), weekPlur: plur(500), since: 1 },
    ...overrides,
  };
}

function setup(chequebook = {}) {
  return {
    canBuy: true,
    account: {
      chequebook: {
        address: '0x' + 'ab'.repeat(20),
        deposit: '0.001',
        target: '0.001',
        needsTopUp: false,
        managed: true,
        ...chequebook,
      },
    },
  };
}

const withBalance = (micro, total = 1000) =>
  credit({
    chequebook: {
      ...credit().chequebook,
      available: String(micro / 1e6),
      availablePlur: plur(micro),
      total: String(total / 1e6),
      totalPlur: plur(total),
    },
  });

describe('describeBrowsingCredit', () => {
  test('hidden until the node runs', () => {
    expect(mod.describeBrowsingCredit(null, null).visible).toBe(false);
    expect(mod.describeBrowsingCredit(credit({ node: 'stopped' }), null).visible).toBe(false);
  });

  test('a funded chequebook on a supporting node pays peers', () => {
    const view = mod.describeBrowsingCredit(credit(), setup());
    expect(view).toMatchObject({
      visible: true,
      available: '0.0008',
      detail: 'Of 0.001 xBZZ deposited',
      spend: 'Spent 0.0002 xBZZ in 24 h · 0.0005 xBZZ in 7 days',
      tier: { text: 'Paying peers', value: 'paying' },
      level: 'ok',
      status: '',
      showTopUp: false,
      toggle: { checked: true, disabled: false },
    });
    expect(view.costNote).toMatch(/0\.75 xBZZ per GB/);
    expect(view.costNote).toMatch(/never goes past what is deposited/);
  });

  test('switched off: free tier, the switch still on hand', () => {
    const view = mod.describeBrowsingCredit(credit({ swapEnable: false }), setup());
    expect(view.tier.value).toBe('free');
    expect(view.status).toBe(
      'Paying peers is off, so downloads use the free tier and may be slow, and large uploads can stall.'
    );
    expect(view.toggle).toMatchObject({ checked: false, disabled: false });
    // The switch is node-wide: its hint names uploads too.
    expect(view.toggle.hint).toMatch(/downloads and uploads/);
  });

  test('a node version without the switch: disabled, and says so', () => {
    const view = mod.describeBrowsingCredit(credit({ support: 'unsupported' }), setup());
    expect(view.tier.value).toBe('free');
    expect(view.status).toMatch(/not supported by this node version/);
    expect(view.toggle).toEqual({
      checked: false,
      disabled: true,
      hint: 'Not supported by this node version.',
    });
    // The balance still shows: the chequebook reads are bee's API.
    expect(view.available).toBe('0.0008');
    // It never spends on downloads, so no cost note.
    expect(view.costNote).toBe('');
  });

  test('a node Freedom does not run: no tier claim, switch disabled', () => {
    const view = mod.describeBrowsingCredit(credit({ support: 'unmanaged' }), setup());
    expect(view.tier).toBeNull();
    expect(view.toggle.disabled).toBe(true);
    expect(view.toggle.hint).toMatch(/own configuration/);
  });

  test('restarting: switch disabled with a hint', () => {
    const view = mod.describeBrowsingCredit(
      credit({ toggle: { inProgress: true, error: null } }),
      setup()
    );
    expect(view.toggle).toMatchObject({ disabled: true, hint: 'Restarting the node…' });
  });

  test('a failed flip shows its error under the switch', () => {
    const view = mod.describeBrowsingCredit(
      credit({ toggle: { inProgress: false, error: 'Wait for the purchase to finish.' } }),
      setup()
    );
    expect(view.toggle.hint).toBe('Wait for the purchase to finish.');
  });

  test('low credit offers the top-up when the deposit can be topped up', () => {
    const view = mod.describeBrowsingCredit(withBalance(300), setup({ needsTopUp: true }));
    expect(view.level).toBe('low');
    expect(view.tier.value).toBe('paying');
    expect(view.status).toMatch(/credit is low/);
    expect(view.showTopUp).toBe(true);
  });

  test('empty credit falls back to the free tier, with the top-up', () => {
    const view = mod.describeBrowsingCredit(withBalance(0), setup({ needsTopUp: true }));
    expect(view.level).toBe('empty');
    expect(view.tier.value).toBe('free');
    expect(view.status).toBe(
      'The credit is used up, so downloads use the free tier and may be slow.'
    );
    expect(view.showTopUp).toBe(true);
  });

  test('spent but uncashed: no top-up, and says why', () => {
    // availableBalance counts every cheque written; the deposit route only
    // sees the on-chain balance, which drops once peers cash them.
    const view = mod.describeBrowsingCredit(withBalance(0), setup({ needsTopUp: false }));
    expect(view.showTopUp).toBe(false);
    expect(view.status).toMatch(/still reads full on chain until peers cash/);
  });

  test('no top-up where the node cannot buy or manages its own deposit', () => {
    expect(
      mod.describeBrowsingCredit(withBalance(0), { ...setup({ needsTopUp: true }), canBuy: false })
        .showTopUp
    ).toBe(false);
    expect(
      mod.describeBrowsingCredit(withBalance(0), setup({ needsTopUp: true, managed: false }))
        .showTopUp
    ).toBe(false);
  });

  test('no chequebook yet', () => {
    const view = mod.describeBrowsingCredit(credit({ chequebook: null, spend: null }), setup());
    expect(view.status).toMatch(/no chequebook yet/);
    expect(view.tier.value).toBe('free');
    expect(view.spend).toBe('');
  });

  test('chequebook not read yet', () => {
    const view = mod.describeBrowsingCredit(credit({ chequebook: undefined }), setup());
    expect(view).toMatchObject({ tier: null, available: '--', status: 'Reading the chequebook…' });
  });

  test('an upper-bound balance says so', () => {
    const c = credit();
    c.chequebook = { ...c.chequebook, availableExact: false };
    expect(mod.describeBrowsingCredit(c, setup()).detail).toMatch(/upper bound/);
  });

  test('thresholds', () => {
    expect(mod.EMPTY_BELOW_PLUR).toBe(9_000_000_000n);
    expect(mod.LOW_BELOW_PLUR).toBe(5n * 10n ** 12n);
  });
});
