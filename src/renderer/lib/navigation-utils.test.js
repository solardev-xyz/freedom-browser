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
      expect(
        resolveProtocolIconType({
          value: 'vitalik.eth/docs',
          ensProtocols: new Map([['vitalik.eth', 'ipfs']]),
        })
      ).toBe('ipfs');
    });

    test('transport scheme wins over ens lookup for transport-prefixed display urls', async () => {
      const { resolveProtocolIconType } = await loadNavigationUtils();

      // After ENS resolution the address bar shows `bzz://name.eth`,
      // `ipfs://name.eth`, or `ipns://name.eth`. The icon must follow the
      // transport scheme even when the host is an ENS name (and even when
      // there's no path / trailing slash to distinguish it).
      expect(
        resolveProtocolIconType({
          value: 'bzz://meinhard.eth',
          ensProtocols: new Map([['meinhard.eth', 'bzz']]),
        })
      ).toBe('swarm');
      expect(
        resolveProtocolIconType({
          value: 'ipfs://vitalik.eth',
          ensProtocols: new Map([['vitalik.eth', 'ipfs']]),
        })
      ).toBe('ipfs');
      expect(
        resolveProtocolIconType({
          value: 'ipns://app.uniswap.eth/swap',
          ensProtocols: new Map(),
        })
      ).toBe('ipns');
      expect(resolveProtocolIconType({ value: 'bzz://meinhard.eth/path' })).toBe('swarm');
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
      expect(
        resolveTrustBadge({ value: 'vitalik.eth/path?q=1#frag', ensTrustByName }).level
      ).toBe('verified');
    });

    test('returns badge for transport-prefixed ENS hosts', async () => {
      const { resolveTrustBadge } = await loadNavigationUtils();
      const ensTrustByName = new Map([
        ['meinhard.eth', verifiedTrust],
        ['vitalik.eth', conflictTrust],
      ]);

      expect(resolveTrustBadge({ value: 'bzz://meinhard.eth', ensTrustByName }).level).toBe(
        'verified'
      );
      expect(resolveTrustBadge({ value: 'bzz://meinhard.eth/path', ensTrustByName }).level).toBe(
        'verified'
      );
      expect(resolveTrustBadge({ value: 'ipfs://vitalik.eth', ensTrustByName }).level).toBe(
        'conflict'
      );
      expect(resolveTrustBadge({ value: 'ipns://vitalik.eth/x', ensTrustByName }).level).toBe(
        'conflict'
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

  describe('extractEnsResolutionMetadata', () => {
    test('records both CIDv0 and CIDv1 forms for IPFS contenthashes', async () => {
      const { extractEnsResolutionMetadata } = await loadNavigationUtils();

      const { knownEnsPairs, resolvedProtocol } = extractEnsResolutionMetadata(
        'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/',
        'evmnow.eth'
      );

      expect(resolvedProtocol).toBe('ipfs');
      expect(knownEnsPairs).toEqual([
        ['QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG', 'evmnow.eth'],
        ['bafybeie5nqv6kd3qnfjupgvz34woh3oksc3iau6abmyajn7qvtf6d2ho34', 'evmnow.eth'],
      ]);
    });

    test('records both base58 multihash and base36 CIDv1 for IPNS contenthashes', async () => {
      const { extractEnsResolutionMetadata } = await loadNavigationUtils();

      // The ENS resolver decodes jalil.eth's IPNS contenthash to this base58
      // multihash; Kubo's subdomain gateway then redirects to the base36 CIDv1.
      const { knownEnsPairs, resolvedProtocol } = extractEnsResolutionMetadata(
        'ipns://12D3KooWAsDaZWCkCEUN3myg49NoCMmrYYivmJVwjg7DVJBvWdaX',
        'jalil.eth'
      );

      expect(resolvedProtocol).toBe('ipns');
      expect(knownEnsPairs).toEqual([
        ['12D3KooWAsDaZWCkCEUN3myg49NoCMmrYYivmJVwjg7DVJBvWdaX', 'jalil.eth'],
        ['k51qzi5uqu5dgkkr5wjh0m796f9u3tou74wn2q2u3shgh6yn52ce4hitig3if4', 'jalil.eth'],
      ]);
    });

    test('does not crash when the IPNS name is already a base36 CIDv1', async () => {
      // If someone hand-crafts an ens:// mapping to a CIDv1 IPNS name, we
      // only record the raw form — we don't try to invert base36 back to
      // a base58 multihash.
      const { extractEnsResolutionMetadata } = await loadNavigationUtils();

      const { knownEnsPairs, resolvedProtocol } = extractEnsResolutionMetadata(
        'ipns://k51qzi5uqu5dgkkr5wjh0m796f9u3tou74wn2q2u3shgh6yn52ce4hitig3if4',
        'jalil.eth'
      );

      expect(resolvedProtocol).toBe('ipns');
      expect(knownEnsPairs).toEqual([
        ['k51qzi5uqu5dgkkr5wjh0m796f9u3tou74wn2q2u3shgh6yn52ce4hitig3if4', 'jalil.eth'],
      ]);
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
