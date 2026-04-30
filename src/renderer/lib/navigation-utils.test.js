const originalWindow = global.window;

const loadNavigationUtils = async () => {
  jest.resetModules();
  global.window = {
    location: { href: 'file:///app/index.html' },
    internalPages: { routable: {} },
  };

  return import('./navigation-utils.js');
};

describe('navigation-utils', () => {
  afterEach(() => {
    global.window = originalWindow;
  });

  describe('resolveProtocolIconType', () => {
    test('defaults to http and handles dweb protocols', async () => {
      const { resolveProtocolIconType } = await loadNavigationUtils();

      expect(resolveProtocolIconType({ value: '' })).toBe('http');
      expect(resolveProtocolIconType({ value: 'bzz://hash' })).toBe('swarm');
      expect(resolveProtocolIconType({ value: 'ipfs://cid' })).toBe('ipfs');
      expect(resolveProtocolIconType({ value: 'ipns://name' })).toBe('ipns');
      expect(resolveProtocolIconType({ value: 'https://example.com' })).toBe('https');
    });

    test('maps ens names through resolved protocols', async () => {
      const { resolveProtocolIconType } = await loadNavigationUtils();

      expect(
        resolveProtocolIconType({
          value: 'ens://vitalik.eth',
          ensProtocols: new Map([['vitalik.eth', 'ipfs']]),
        })
      ).toBe('ipfs');
      expect(
        resolveProtocolIconType({
          value: 'vitalik.eth/docs',
          ensProtocols: new Map(),
        })
      ).toBe('http');
    });

    test('hides icons for internal pages and gates radicle on settings', async () => {
      const { resolveProtocolIconType } = await loadNavigationUtils();

      expect(resolveProtocolIconType({ value: 'freedom://history' })).toBeNull();
      expect(resolveProtocolIconType({ value: 'rad://rid' })).toBe('http');
      expect(
        resolveProtocolIconType({
          value: 'rad://rid',
          enableRadicleIntegration: true,
        })
      ).toBe('radicle');
    });

    test('prefers secure icon when the page is marked secure', async () => {
      const { resolveProtocolIconType } = await loadNavigationUtils();

      expect(
        resolveProtocolIconType({
          value: 'example.com',
          currentPageSecure: true,
        })
      ).toBe('https');
    });
  });

  describe('buildRadicleDisabledUrl', () => {
    test('creates a rad-browser disabled url and preserves input', async () => {
      const { buildRadicleDisabledUrl } = await loadNavigationUtils();

      expect(buildRadicleDisabledUrl('file:///app/index.html')).toBe(
        'file:///app/pages/rad-browser.html?error=disabled'
      );
      expect(buildRadicleDisabledUrl('file:///app/index.html', 'rad://zabc')).toBe(
        'file:///app/pages/rad-browser.html?error=disabled&input=rad%3A%2F%2Fzabc'
      );
    });
  });

  describe('resolveTrustBadge', () => {
    const verifiedTrust = { level: 'verified', agreed: ['a', 'b'], queried: ['a', 'b', 'c'] };
    const conflictTrust = { level: 'conflict', agreed: [], dissented: ['a', 'b'] };

    test('returns null for non-ENS URLs', async () => {
      const { resolveTrustBadge } = await loadNavigationUtils();
      const ensTrustByName = new Map([['vitalik.eth', verifiedTrust]]);

      expect(resolveTrustBadge({ value: 'https://example.com', ensTrustByName })).toBeNull();
      expect(resolveTrustBadge({ value: 'bzz://hash', ensTrustByName })).toBeNull();
      expect(resolveTrustBadge({ value: 'freedom://history', ensTrustByName })).toBeNull();
      expect(resolveTrustBadge({ value: '', ensTrustByName })).toBeNull();
    });

    test('returns null when the ENS name has no trust entry', async () => {
      const { resolveTrustBadge } = await loadNavigationUtils();
      const ensTrustByName = new Map([['other.eth', verifiedTrust]]);

      expect(resolveTrustBadge({ value: 'ens://vitalik.eth', ensTrustByName })).toBeNull();
    });

    test('returns badge for ens:// URLs with trust entry', async () => {
      const { resolveTrustBadge } = await loadNavigationUtils();
      const ensTrustByName = new Map([['vitalik.eth', verifiedTrust]]);

      const badge = resolveTrustBadge({ value: 'ens://vitalik.eth', ensTrustByName });

      expect(badge).toEqual({
        level: 'verified',
        name: 'vitalik.eth',
        trust: verifiedTrust,
      });
    });

    test('returns badge for bare .eth and .box URLs', async () => {
      const { resolveTrustBadge } = await loadNavigationUtils();
      const ensTrustByName = new Map([
        ['vitalik.eth', verifiedTrust],
        ['example.box', conflictTrust],
      ]);

      expect(resolveTrustBadge({ value: 'vitalik.eth', ensTrustByName }).level).toBe('verified');
      expect(resolveTrustBadge({ value: 'example.box', ensTrustByName }).level).toBe('conflict');
    });

    test('strips path and is case-insensitive', async () => {
      const { resolveTrustBadge } = await loadNavigationUtils();
      const ensTrustByName = new Map([['vitalik.eth', verifiedTrust]]);

      expect(resolveTrustBadge({ value: 'ens://vitalik.eth/profile', ensTrustByName }).level).toBe(
        'verified'
      );
      expect(resolveTrustBadge({ value: 'VITALIK.ETH', ensTrustByName }).level).toBe('verified');
      expect(resolveTrustBadge({ value: 'ENS://Vitalik.ETH/x', ensTrustByName }).level).toBe(
        'verified'
      );
    });

    test('tolerates missing / empty arguments', async () => {
      const { resolveTrustBadge } = await loadNavigationUtils();

      expect(resolveTrustBadge()).toBeNull();
      expect(resolveTrustBadge({})).toBeNull();
      expect(resolveTrustBadge({ value: 'ens://x.eth' })).toBeNull();
    });

    test('returns null when trust has no level (defensive)', async () => {
      const { resolveTrustBadge } = await loadNavigationUtils();
      const ensTrustByName = new Map([['vitalik.eth', { agreed: ['a'] }]]);

      expect(resolveTrustBadge({ value: 'ens://vitalik.eth', ensTrustByName })).toBeNull();
    });
  });

  describe('getRadicleDisplayUrl', () => {
    test('reconstructs rad urls from rad-browser pages', async () => {
      const { getRadicleDisplayUrl } = await loadNavigationUtils();

      expect(
        getRadicleDisplayUrl('file:///app/pages/rad-browser.html?rid=zabc123&path=/tree/main')
      ).toBe('rad://zabc123/tree/main');
      expect(getRadicleDisplayUrl('file:///app/pages/rad-browser.html?path=/tree/main')).toBeNull();
      expect(getRadicleDisplayUrl('https://example.com')).toBeNull();
      expect(getRadicleDisplayUrl('not-a-url')).toBeNull();
    });
  });
});
