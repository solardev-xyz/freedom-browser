const originalWindow = global.window;

const loadNavigationUtils = async (internalPages = {}) => {
  jest.resetModules();
  global.window = {
    location: { href: 'file:///app/index.html' },
    internalPages: { routable: internalPages },
  };

  return import('./navigation-utils.js');
};

describe('navigation-utils extracted helpers', () => {
  afterEach(() => {
    global.window = originalWindow;
  });

  test('applies ens suffixes and extracts ens resolution metadata', async () => {
    const mod = await loadNavigationUtils();

    expect(mod.applyEnsSuffix('https://example.com/base/', '/docs?q=1')).toBe(
      'https://example.com/docs?q=1'
    );
    expect(mod.applyEnsSuffix('not-a-url', '/docs')).toBe('not-a-url/docs');

    expect(mod.extractEnsResolutionMetadata('bzz://abcdef/path', 'name.eth')).toEqual({
      knownEnsPairs: [['abcdef', 'name.eth']],
      resolvedProtocol: 'swarm',
    });
    expect(mod.extractEnsResolutionMetadata('ipfs://QmHash/path', 'name.eth')).toEqual({
      knownEnsPairs: [['QmHash', 'name.eth']],
      resolvedProtocol: 'ipfs',
    });
    // Real CIDv0 — only the CIDv0 form is recorded now. The CIDv1-base32
    // dual record was needed back when Chromium followed Kubo's subdomain
    // redirect; with `ipfs:` as a standard scheme the protocol handler
    // follows the redirect internally so the address bar never sees the
    // CIDv1 form.
    expect(
      mod.extractEnsResolutionMetadata(
        'ipfs://Qmbnp5ufs7kauPzwnu5boMjbXM97TvmuiNd5F7F2ex8ThC/path',
        'jthor.eth'
      )
    ).toEqual({
      knownEnsPairs: [['Qmbnp5ufs7kauPzwnu5boMjbXM97TvmuiNd5F7F2ex8ThC', 'jthor.eth']],
      resolvedProtocol: 'ipfs',
    });
    expect(mod.extractEnsResolutionMetadata('ipns://docs.example/path', 'name.eth')).toEqual({
      knownEnsPairs: [['docs.example', 'name.eth']],
      resolvedProtocol: 'ipns',
    });
    expect(mod.extractEnsResolutionMetadata('https://example.com', 'name.eth')).toEqual({
      knownEnsPairs: [],
      resolvedProtocol: null,
    });
  });

  test('derives display addresses with ens preservation and radicle conversion', async () => {
    const mod = await loadNavigationUtils();

    expect(
      mod.deriveDisplayAddress({
        url: 'http://127.0.0.1:1633/bzz/abcdef/path',
        bzzRoutePrefix: 'http://127.0.0.1:1633/bzz/',
        homeUrlNormalized: 'file:///app/pages/home.html',
        ipfsRoutePrefix: 'http://127.0.0.1:8080/ipfs/',
        ipnsRoutePrefix: 'http://127.0.0.1:8080/ipns/',
        radicleApiPrefix: 'radapi://local/api/v1/repos/',
        knownEnsNames: new Map([['abcdef', 'name.eth']]),
      })
    ).toBe('bzz://name.eth/path');

    expect(
      mod.deriveDisplayAddress({
        url: 'radapi://local/api/v1/repos/zabc123/tree/main',
        bzzRoutePrefix: 'http://127.0.0.1:1633/bzz/',
        homeUrlNormalized: 'file:///app/pages/home.html',
        ipfsRoutePrefix: 'http://127.0.0.1:8080/ipfs/',
        ipnsRoutePrefix: 'http://127.0.0.1:8080/ipns/',
        radicleApiPrefix: 'radapi://local/api/v1/repos/',
      })
    ).toBe('rad://zabc123/tree/main');
  });

  test('builds view-source navigation for dweb and gateway urls', async () => {
    const mod = await loadNavigationUtils();

    expect(
      mod.buildViewSourceNavigation({
        value: 'view-source:bzz://abcdef/path',
        bzzRoutePrefix: 'http://127.0.0.1:1633/bzz/',
        homeUrlNormalized: 'file:///app/pages/home.html',
        ipfsRoutePrefix: 'http://127.0.0.1:8080/ipfs/',
        ipnsRoutePrefix: 'http://127.0.0.1:8080/ipns/',
      })
    ).toEqual({
      addressValue: 'view-source:bzz://abcdef/path',
      loadUrl: 'view-source:http://127.0.0.1:1633/bzz/abcdef/path',
    });

    expect(
      mod.buildViewSourceNavigation({
        value: 'view-source:http://127.0.0.1:1633/bzz/abcdef/docs',
        bzzRoutePrefix: 'http://127.0.0.1:1633/bzz/',
        homeUrlNormalized: 'file:///app/pages/home.html',
        ipfsRoutePrefix: 'http://127.0.0.1:8080/ipfs/',
        ipnsRoutePrefix: 'http://127.0.0.1:8080/ipns/',
        knownEnsNames: new Map([['abcdef', 'name.eth']]),
      })
    ).toEqual({
      addressValue: 'view-source:bzz://name.eth/docs',
      loadUrl: 'view-source:http://127.0.0.1:1633/bzz/abcdef/docs',
    });
  });

  test('buildViewSourceNavigation skips gateway rewrite for ENS-host transport URLs', async () => {
    // bzz://name.eth/path can't be rewritten to a gateway URL here because
    // the host needs ENS resolution first. The view-source dispatch in
    // navigation.js calls resolveEns and then re-enters with the resolved
    // bzz://<hash>/ form. This test guards against the regex matching the
    // ENS host as if it were a hex Swarm reference.
    const mod = await loadNavigationUtils();

    expect(
      mod.buildViewSourceNavigation({
        value: 'view-source:bzz://meinhard.eth/page',
        bzzRoutePrefix: 'http://127.0.0.1:1633/bzz/',
        homeUrlNormalized: 'file:///app/pages/home.html',
        ipfsRoutePrefix: 'http://127.0.0.1:8080/ipfs/',
        ipnsRoutePrefix: 'http://127.0.0.1:8080/ipns/',
      })
    ).toEqual({
      addressValue: 'view-source:bzz://meinhard.eth/page',
      loadUrl: 'view-source:bzz://meinhard.eth/page',
    });

    expect(
      mod.buildViewSourceNavigation({
        value: 'view-source:ipfs://vitalik.eth/docs',
        bzzRoutePrefix: 'http://127.0.0.1:1633/bzz/',
        homeUrlNormalized: 'file:///app/pages/home.html',
        ipfsRoutePrefix: 'http://127.0.0.1:8080/ipfs/',
        ipnsRoutePrefix: 'http://127.0.0.1:8080/ipns/',
      })
    ).toEqual({
      addressValue: 'view-source:ipfs://vitalik.eth/docs',
      loadUrl: 'view-source:ipfs://vitalik.eth/docs',
    });
  });

  test('derives switched tab display values for loading, internal pages, and view-source', async () => {
    const mod = await loadNavigationUtils({
      history: 'history.html',
    });

    expect(
      mod.deriveSwitchedTabDisplay({
        url: 'https://loading.example',
        isLoading: true,
        addressBarSnapshot: 'typed value',
        bzzRoutePrefix: 'http://127.0.0.1:1633/bzz/',
        homeUrlNormalized: 'file:///app/pages/home.html',
      })
    ).toBe('typed value');

    expect(
      mod.deriveSwitchedTabDisplay({
        url: 'file:///app/pages/history.html',
        bzzRoutePrefix: 'http://127.0.0.1:1633/bzz/',
        homeUrlNormalized: 'file:///app/pages/home.html',
      })
    ).toBe('freedom://history');

    expect(
      mod.deriveSwitchedTabDisplay({
        url: 'view-source:http://127.0.0.1:1633/bzz/abcdef/docs',
        isViewingSource: true,
        bzzRoutePrefix: 'http://127.0.0.1:1633/bzz/',
        homeUrlNormalized: 'file:///app/pages/home.html',
        ipfsRoutePrefix: 'http://127.0.0.1:8080/ipfs/',
        ipnsRoutePrefix: 'http://127.0.0.1:8080/ipns/',
        knownEnsNames: new Map([['abcdef', 'name.eth']]),
      })
    ).toBe('view-source:bzz://name.eth/docs');

    expect(
      mod.deriveSwitchedTabDisplay({
        url: 'file:///app/pages/home.html',
        bzzRoutePrefix: 'http://127.0.0.1:1633/bzz/',
        homeUrlNormalized: 'file:///app/pages/home.html',
      })
    ).toBe('');

    // A tab parked on an error page restores the friendly target from the
    // `url` param, not the raw file:// error.html URL.
    expect(
      mod.deriveSwitchedTabDisplay({
        url: 'file:///app/pages/error.html?error=ERR_CONNECTION_REFUSED&url=ipfs%3A%2F%2Fvitalik.eth&protocol=ipfs&retry=ipfs%3A%2F%2Fvitalik.eth',
        bzzRoutePrefix: 'http://127.0.0.1:1633/bzz/',
        homeUrlNormalized: 'file:///app/pages/home.html',
        ipfsRoutePrefix: 'http://127.0.0.1:8080/ipfs/',
        ipnsRoutePrefix: 'http://127.0.0.1:8080/ipns/',
      })
    ).toBe('ipfs://vitalik.eth');

    // Same rule for the name-resolution interstitials (#235): a tab parked
    // on one restores the blocked name, never the interstitial's file:// path.
    expect(
      mod.deriveSwitchedTabDisplay({
        url: 'file:///app/pages/ens-unverified.html?name=retry.tez&uri=ipfs%3A%2F%2FQmRetryTez',
        bzzRoutePrefix: 'http://127.0.0.1:1633/bzz/',
        homeUrlNormalized: 'file:///app/pages/home.html',
      })
    ).toBe('retry.tez');

    expect(
      mod.deriveSwitchedTabDisplay({
        url: 'file:///app/pages/ens-conflict.html?name=lagged.tez&block=%7B%7D&groups=%5B%5D',
        bzzRoutePrefix: 'http://127.0.0.1:1633/bzz/',
        homeUrlNormalized: 'file:///app/pages/home.html',
      })
    ).toBe('lagged.tez');

    // Fail-safe: an interstitial with no `name` param clears the address bar
    // rather than falling through to its on-disk path — the same fallback the
    // active-tab did-navigate handler applies.
    expect(
      mod.deriveSwitchedTabDisplay({
        url: 'file:///app/pages/ens-conflict.html',
        bzzRoutePrefix: 'http://127.0.0.1:1633/bzz/',
        homeUrlNormalized: 'file:///app/pages/home.html',
      })
    ).toBe('');

    expect(
      mod.deriveSwitchedTabDisplay({
        url: 'file:///app/pages/ens-unverified.html?uri=ipfs%3A%2F%2FQmRetryTez',
        bzzRoutePrefix: 'http://127.0.0.1:1633/bzz/',
        homeUrlNormalized: 'file:///app/pages/home.html',
      })
    ).toBe('');

    // The interstitial test runs on the committed URL as-is, never on the
    // `view-source:` inner URL: viewing an interstitial's source is source
    // text, not the block itself, and the active-tab handler's view-source
    // branch (which runs ahead of its interstitial branch) shows
    // `view-source:<inner display>`. Both surfaces have to agree.
    expect(
      mod.deriveSwitchedTabDisplay({
        url: 'view-source:file:///app/pages/ens-conflict.html?name=lagged.tez&block=%7B%7D',
        isViewingSource: true,
        bzzRoutePrefix: 'http://127.0.0.1:1633/bzz/',
        homeUrlNormalized: 'file:///app/pages/home.html',
      })
    ).toBe('view-source:file:///app/pages/ens-conflict.html?name=lagged.tez&block=%7B%7D');

    // #235 regression: a remote page served at a chrome-look-alike path must
    // never dictate the switched-tab address bar. `deriveSwitchedTabDisplay`
    // used to run both the interstitial and the error-page recovery on a bare
    // `/<file>.html` substring test, so `https://evil.test/error.html?url=…`
    // repainted the address bar (protocol icon included) with the attacker's
    // chosen value while the webview rendered the attacker's page.
    expect(
      mod.deriveSwitchedTabDisplay({
        url: 'https://evil.test/error.html?error=offline&url=bzz%3A%2F%2Fvitalik.eth&protocol=swarm',
        bzzRoutePrefix: 'http://127.0.0.1:1633/bzz/',
        homeUrlNormalized: 'file:///app/pages/home.html',
      })
    ).toBe('https://evil.test/error.html?error=offline&url=bzz%3A%2F%2Fvitalik.eth&protocol=swarm');

    expect(
      mod.deriveSwitchedTabDisplay({
        url: 'https://evil.test/ens-conflict.html?name=bank.eth',
        bzzRoutePrefix: 'http://127.0.0.1:1633/bzz/',
        homeUrlNormalized: 'file:///app/pages/home.html',
      })
    ).toBe('https://evil.test/ens-conflict.html?name=bank.eth');
  });

  test('computes bookmark bar state and extracts original urls from error pages', async () => {
    const mod = await loadNavigationUtils();

    expect(
      mod.getBookmarkBarState({
        url: '',
        bookmarkBarOverride: false,
        homeUrl: 'file:///app/pages/home.html',
        homeUrlNormalized: 'file:///app/pages/home.html',
      })
    ).toEqual({
      isHomePage: true,
      visible: true,
    });

    expect(
      mod.getBookmarkBarState({
        url: 'https://example.com',
        bookmarkBarOverride: true,
        homeUrl: 'file:///app/pages/home.html',
        homeUrlNormalized: 'file:///app/pages/home.html',
      })
    ).toEqual({
      isHomePage: false,
      visible: true,
    });

    expect(
      mod.getOriginalUrlFromErrorPage(
        'file:///app/pages/error.html?error=offline&url=https%3A%2F%2Fexample.com',
        'file:///app/pages/error.html'
      )
    ).toBe('https://example.com');
    expect(mod.getOriginalUrlFromErrorPage('https://example.com')).toBeNull();
    expect(mod.getOriginalUrlFromErrorPage('not-a-url/error.html?')).toBeNull();
    // Only the shell's own error page counts (#235).
    expect(
      mod.getOriginalUrlFromErrorPage('https://evil.test/error.html?url=bzz%3A%2F%2Fvitalik.eth')
    ).toBeNull();
    expect(
      mod.getOriginalUrlFromErrorPage('file:///app/pages/error.html.evil?url=https%3A%2F%2Fa.test')
    ).toBeNull();
  });
});
