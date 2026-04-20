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

      expect(resolvedProtocol).toBe('ipfs');
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

      const { knownEnsPairs } = extractEnsResolutionMetadata(
        'ipns://k51qzi5uqu5dgkkr5wjh0m796f9u3tou74wn2q2u3shgh6yn52ce4hitig3if4',
        'jalil.eth'
      );

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
