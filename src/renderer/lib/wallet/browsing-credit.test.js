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
    // An Ant with freedom-hq/ant#126: `/node` says it pays, and deposits take an amount.
    paying: true,
    depositAmount: true,
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

const withBalance = (micro, total = 1000, overrides = {}) =>
  credit({
    ...overrides,
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
      // Any amount can be added, so the top-up is always on offer.
      showTopUp: true,
      toggle: { checked: true, disabled: false },
    });
    // freedom-hq/ant#126's measured figures, downloads and uploads.
    expect(view.costNote).toMatch(/faster downloads and for uploads/);
    expect(view.costNote).toMatch(/0\.59 xBZZ per GB/);
    expect(view.costNote).toMatch(/0\.16 xBZZ per hour of HD video/);
    expect(view.costNote).toMatch(/\(an estimate\)/);
    expect(view.costNote).toMatch(/Uploads cost about 0\.22 xBZZ per GB/);
    expect(view.costNote).not.toMatch(/0\.75|0\.35/);
    expect(view.costNote).toMatch(/never goes past what is deposited/);
  });

  test('the badge follows the node’s own word on paying', () => {
    // Switch on, credit left, but the node has not seen the funds yet.
    const view = mod.describeBrowsingCredit(credit({ paying: false }), setup());
    expect(view.tier.value).toBe('free');
    expect(view.status).toBe('The node is not paying peers yet, so downloads use the free tier and may be slow.');
  });

  test('switched off: free tier, the switch still on hand', () => {
    const view = mod.describeBrowsingCredit(credit({ swapEnable: false, paying: false }), setup());
    expect(view.tier.value).toBe('free');
    expect(view.status).toBe(
      'Paying peers is off, so downloads use the free tier and may be slow, and large uploads can stall.'
    );
    expect(view.toggle).toMatchObject({ checked: false, disabled: false });
    // The switch is node-wide: its hint names uploads too.
    expect(view.toggle.hint).toMatch(/faster downloads and for uploads/);
  });

  test('a node version without the switch: disabled, and says so', () => {
    const view = mod.describeBrowsingCredit(
      credit({ support: 'unsupported', paying: null, depositAmount: false }),
      setup()
    );
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

  test('an ultra-light node reports the switch but cannot pay: disabled, and says why', () => {
    const view = mod.describeBrowsingCredit(
      credit({ support: 'no-settlement', paying: false }),
      setup()
    );
    expect(view.tier.value).toBe('free');
    expect(view.status).toMatch(/cannot pay peers .*ultra-light/);
    expect(view.toggle).toEqual({
      checked: false,
      disabled: true,
      hint: 'This node cannot pay peers in the mode it runs in (ultra-light).',
    });
    expect(view.costNote).toBe('');
  });

  test('a node Freedom does not run: no tier claim, switch disabled', () => {
    const view = mod.describeBrowsingCredit(credit({ support: 'unmanaged', paying: null }), setup());
    expect(view.tier).toBeNull();
    expect(view.toggle.disabled).toBe(true);
    expect(view.toggle.hint).toMatch(/own configuration/);
  });

  test('a node Freedom does not run but that says it pays: the badge, still no switch', () => {
    const view = mod.describeBrowsingCredit(credit({ support: 'unmanaged' }), setup());
    expect(view.tier.value).toBe('paying');
    expect(view.toggle.disabled).toBe(true);
  });

  test('switching: switch disabled with a hint', () => {
    const view = mod.describeBrowsingCredit(
      credit({ toggle: { inProgress: true, error: null } }),
      setup()
    );
    expect(view.toggle).toMatchObject({ disabled: true, hint: 'Switching…' });
  });

  test('a failed flip shows its error under the switch', () => {
    const view = mod.describeBrowsingCredit(
      credit({ toggle: { inProgress: false, error: 'Wait for the purchase to finish.' } }),
      setup()
    );
    expect(view.toggle.hint).toBe('Wait for the purchase to finish.');
  });

  test('low credit says so, and offers the top-up', () => {
    const view = mod.describeBrowsingCredit(withBalance(300), setup());
    expect(view.level).toBe('low');
    expect(view.tier.value).toBe('paying');
    expect(view.status).toMatch(/credit is low.*downloads and uploads/);
    expect(view.showTopUp).toBe(true);
  });

  test('empty credit falls back to the free tier, for uploads too, with the top-up', () => {
    // The node's last funds read may still say it pays; an empty credit can't.
    const view = mod.describeBrowsingCredit(withBalance(0), setup());
    expect(view.level).toBe('empty');
    expect(view.tier.value).toBe('free');
    expect(view.status).toBe(
      'The credit is used up, so downloads use the free tier and may be slow, and large uploads can stall.'
    );
    // Spent but uncashed doesn't matter: an amount is added whatever the
    // on-chain balance reads.
    expect(view.showTopUp).toBe(true);
  });

  describe('an Ant from before freedom-hq/ant#126 (top-up only to the target)', () => {
    const legacy = { paying: null, depositAmount: false, support: 'unsupported' };

    test('low or empty credit offers the top-up when the deposit is short', () => {
      expect(
        mod.describeBrowsingCredit(withBalance(300, 1000, legacy), setup({ needsTopUp: true }))
          .showTopUp
      ).toBe(true);
      expect(
        mod.describeBrowsingCredit(withBalance(0, 1000, legacy), setup({ needsTopUp: true }))
          .showTopUp
      ).toBe(true);
      // A full credit has nothing to top up to.
      expect(
        mod.describeBrowsingCredit(credit(legacy), setup({ needsTopUp: true })).showTopUp
      ).toBe(false);
    });

    test('spent but uncashed: no top-up, and says why', () => {
      // availableBalance counts every cheque written; the deposit route only
      // sees the on-chain balance, which drops once peers cash them.
      const view = mod.describeBrowsingCredit(
        withBalance(0, 1000, legacy),
        setup({ needsTopUp: false })
      );
      expect(view.showTopUp).toBe(false);
      expect(view.status).toMatch(/still reads full on chain until peers cash/);
    });
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
    expect(mod.describeBrowsingCredit(credit(), { canBuy: true, account: { chequebook: null } }).showTopUp).toBe(false);
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

  test('top-up amounts: presets, and a typed amount within the node’s range', () => {
    expect(mod.DEPOSIT_PRESETS.map((p) => p.xbzz)).toEqual(['0.05', '0.1', '0.5']);
    for (const preset of mod.DEPOSIT_PRESETS) {
      expect(mod.parseXbzzAmount(preset.xbzz).plur).toBeDefined();
    }
    expect(mod.parseXbzzAmount('0.1')).toEqual({ plur: '1000000000000000' });
    expect(mod.parseXbzzAmount(' 0,25 ')).toEqual({ plur: '2500000000000000' });
    expect(mod.parseXbzzAmount('.5')).toEqual({ plur: '5000000000000000' });
    expect(mod.parseXbzzAmount('2')).toEqual({ plur: '20000000000000000' });
    expect(mod.parseXbzzAmount('0.001')).toEqual({ plur: '10000000000000' });
    expect(mod.parseXbzzAmount('10')).toEqual({ plur: '100000000000000000' });
    expect(mod.parseXbzzAmount('0.0009').error).toMatch(/between 0\.001 and 10/);
    expect(mod.parseXbzzAmount('10.0000000000000001').error).toMatch(/between/);
    for (const bad of ['', 'abc', '1e3', '-1', '0.1.2', '.', '0.12345678901234567']) {
      expect(mod.parseXbzzAmount(bad).error).toBeTruthy();
    }
    expect(mod.formatXbzz('1000000000000000')).toBe('0.1');
    expect(mod.formatXbzz('20000000000000000')).toBe('2');
    expect(mod.formatXbzz('nope')).toBeNull();
  });

  test('thresholds', () => {
    expect(mod.EMPTY_BELOW_PLUR).toBe(9_000_000_000n);
    expect(mod.LOW_BELOW_PLUR).toBe(5n * 10n ** 12n);
  });
});
