const PLANS = [
  { id: 'starter', title: 'Starter', depth: 20, days: 30, safeLimitBytes: 100_000_000 },
  { id: 'advanced', title: 'Advanced', depth: 21, days: 180, safeLimitBytes: 1_000_000_000 },
  { id: 'plus', title: 'Plus', depth: 22, days: 365, safeLimitBytes: 5_000_000_000 },
];

const ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';

function stateWith(overrides = {}) {
  return {
    node: { status: 'running', error: null, registryMode: 'bundled' },
    readiness: { ok: false, key: 'needs-storage', reason: 'no-usable-stamps', message: '' },
    operation: null,
    plans: PLANS,
    ...overrides,
  };
}

describe('swarm-readiness view helpers', () => {
  let mod;
  beforeAll(async () => {
    mod = await import('./swarm-readiness.js');
  });

  test('formats node modes and leaves an unknown one blank', () => {
    expect(mod.formatSwarmMode('light')).toBe('Light');
    expect(mod.formatSwarmMode('ultraLight')).toBe('Ultra-light');
    expect(mod.formatSwarmMode('full')).toBe('Full');
    expect(mod.formatSwarmMode(null)).toBeNull();
    expect(mod.formatSwarmMode('ultra-light')).toBeNull();
  });

  test('formats plan sizes in decimal units, like the effective-volume table', () => {
    expect(mod.formatStorageSize(100_000_000)).toBe('100 MB');
    expect(mod.formatStorageSize(1_000_000_000)).toBe('1 GB');
    expect(mod.formatStorageSize(5_000_000_000)).toBe('5 GB');
    expect(mod.formatStorageSize(2_600_000_000)).toBe('2.6 GB');
    expect(mod.formatStorageSize(0)).toBe('--');
  });

  test('formats durations the way the plans and extend options name them', () => {
    expect(mod.formatDays(30)).toBe('1 month');
    expect(mod.formatDays(90)).toBe('3 months');
    expect(mod.formatDays(180)).toBe('6 months');
    expect(mod.formatDays(365)).toBe('1 year');
    expect(mod.formatDays(730)).toBe('2 years');
    expect(mod.formatDays(7)).toBe('7 days');
    expect(mod.formatDays(1)).toBe('1 day');
  });

  test('describes plans and the armed operation', () => {
    expect(mod.describePlan(PLANS[0])).toBe('Up to 100 MB for 1 month');
    expect(
      mod.describeOperationTarget({ request: { kind: 'buy', planId: 'advanced' } }, PLANS)
    ).toBe('Advanced: up to 1 GB for 6 months');
    expect(
      mod.describeOperationTarget({ request: { kind: 'extend', batchId: 'ab', days: 90 } }, PLANS)
    ).toBe('Keep your storage 3 months longer');
    expect(
      mod.describeOperationTarget(
        { request: { kind: 'extend', batchId: 'ab', days: 0, depth: 22 } },
        PLANS
      )
    ).toBe('Grow your storage to 5 GB');
    expect(mod.describeOperationTarget({ request: { kind: 'deposit' } }, PLANS)).toBe(
      'Top up the chequebook deposit'
    );
  });

  test('titles and copy follow the operation kind', () => {
    expect(mod.describeOperationTitle(null)).toBe('Publish Setup');
    expect(mod.describeOperationTitle({ request: { kind: 'extend' } })).toBe('Extend Storage');
    expect(mod.describeExecuting({ request: { kind: 'buy' } }).title).toBe(
      'Activating Your Storage'
    );
    expect(mod.describeDone({ request: { kind: 'deposit' }, result: { alreadyFull: true } })).toBe(
      'The chequebook deposit is already full.'
    );
  });

  test('a bought batch still reaching the network is not called ready yet', () => {
    const confirming = { phase: 'confirming', request: { kind: 'buy', planId: 'starter' } };
    expect(mod.describeExecuting(confirming).title).toBe('Almost Ready');
    expect(mod.describeDone({ request: { kind: 'buy' }, result: { slow: true } })).toMatch(
      /still catching up/
    );
    expect(mod.describeDone({ request: { kind: 'buy' }, result: {} })).toBe(
      'Your storage is ready. You can publish on Swarm now.'
    );
    expect(mod.describePublishCta(stateWith({ operation: confirming }))).toMatchObject({
      label: 'Confirming Storage…',
      target: 'setup',
    });
    expect(
      mod.describePublishCta(stateWith({ readiness: { ok: false, key: 'storage-pending' } }))
    ).toMatchObject({ label: 'Manage Storage', target: 'storage' });
  });

  test('builds an EIP-681 payment request for a plain xDAI transfer on Gnosis', () => {
    expect(mod.buildPaymentUri(ADDRESS, '460000000000000000')).toBe(
      `ethereum:${ADDRESS}@100?value=460000000000000000`
    );
  });

  test('pre-fills fund.ethswarm.org with the node address and the xDAI to deliver', () => {
    const url = new URL(mod.buildFundUrl(ADDRESS, '0.46'));
    expect(url.origin).toBe('https://fund.ethswarm.org');
    expect(url.searchParams.get('destination')).toBe(ADDRESS);
    expect(url.searchParams.get('dai')).toBe('0.46');
    expect(url.searchParams.get('bzz')).toBe('0');
  });

  describe('describePublishCta', () => {
    test('is hidden without state, for a stopped node and for nodes Freedom does not fund', () => {
      expect(mod.describePublishCta(null).visible).toBe(false);
      expect(
        mod.describePublishCta(stateWith({ node: { status: 'stopped', registryMode: 'none' } }))
          .visible
      ).toBe(false);
      expect(
        mod.describePublishCta(stateWith({ node: { status: 'running', registryMode: 'reused' } }))
          .visible
      ).toBe(false);
    });

    test('offers setup when storage is missing and storage management when ready', () => {
      expect(mod.describePublishCta(stateWith())).toMatchObject({
        visible: true,
        disabled: false,
        label: 'Set Up Publishing',
        target: 'setup',
      });
      expect(
        mod.describePublishCta(stateWith({ readiness: { ok: true, key: 'ready' } }))
      ).toMatchObject({ label: 'Manage Storage', target: 'storage' });
    });

    test('warns on the ready CTA that uploads can stall while paying peers is off (#488)', () => {
      const ready = stateWith({ readiness: { ok: true, key: 'ready' } });
      expect(
        mod.describePublishCta(ready, { support: 'supported', swapEnable: false })
      ).toMatchObject({
        label: 'Manage Storage',
        target: 'storage',
        hint: 'Paying peers is off, so large uploads can stall',
      });
      // On, or a node that does not honour the switch: the usual hint.
      for (const credit of [
        { support: 'supported', swapEnable: true },
        { support: 'unsupported', swapEnable: false },
        null,
      ]) {
        expect(mod.describePublishCta(ready, credit).hint).toBe('View and extend your storage');
      }
    });

    test('shows the payment it is waiting for, and a purchase in flight', () => {
      const awaiting = stateWith({
        operation: { phase: 'awaiting-funds', quote: { send: { display: '0.46' } } },
      });
      expect(mod.describePublishCta(awaiting)).toMatchObject({
        label: 'Waiting for Payment',
        hint: 'Send 0.46 xDAI to your node',
        target: 'setup',
      });
      expect(
        mod.describePublishCta(stateWith({ operation: { phase: 'executing' } }))
      ).toMatchObject({ label: 'Buying Storage…', disabled: false });
    });

    test('an attempt that did not finish yields to storage that works', () => {
      const failed = { phase: 'failed', uncertain: true };
      expect(mod.describePublishCta(stateWith({ operation: failed }))).toMatchObject({
        hint: 'The last purchase did not finish',
        target: 'setup',
      });
      expect(
        mod.describePublishCta(
          stateWith({ operation: failed, readiness: { ok: true, key: 'ready' } })
        )
      ).toMatchObject({ label: 'Manage Storage', target: 'storage' });
    });

    test('stays reachable while the node connects or has failed, so setup can explain', () => {
      expect(
        mod.describePublishCta(stateWith({ readiness: { ok: false, key: 'chain-syncing' } }))
      ).toMatchObject({ disabled: false, hint: 'Connecting to Gnosis Chain…' });
      expect(
        mod.describePublishCta(
          stateWith({
            node: { status: 'error', error: 'Exited with code 1', registryMode: 'none' },
            readiness: { ok: false, key: 'error' },
          })
        )
      ).toMatchObject({ visible: true, disabled: false, target: 'setup' });
      expect(
        mod.describePublishCta(stateWith({ readiness: { ok: false, key: 'checking' } }))
      ).toMatchObject({ disabled: true, target: 'setup' });
    });
  });
});
