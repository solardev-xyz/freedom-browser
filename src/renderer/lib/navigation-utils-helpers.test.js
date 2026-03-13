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
    expect(mod.extractEnsResolutionMetadata('ipns://docs.example/path', 'name.eth')).toEqual({
      knownEnsPairs: [['docs.example', 'name.eth']],
      resolvedProtocol: 'ipfs',
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
        radicleApiPrefix: 'http://127.0.0.1:8780/api/v1/repos/',
        knownEnsNames: new Map([['abcdef', 'name.eth']]),
      })
    ).toBe('ens://name.eth/path');

    expect(
      mod.deriveDisplayAddress({
        url: 'http://127.0.0.1:8780/api/v1/repos/zabc123/tree/main',
        bzzRoutePrefix: 'http://127.0.0.1:1633/bzz/',
        homeUrlNormalized: 'file:///app/pages/home.html',
        ipfsRoutePrefix: 'http://127.0.0.1:8080/ipfs/',
        ipnsRoutePrefix: 'http://127.0.0.1:8080/ipns/',
        radicleApiPrefix: 'http://127.0.0.1:8780/api/v1/repos/',
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
      addressValue: 'view-source:ens://name.eth/docs',
      loadUrl: 'view-source:http://127.0.0.1:1633/bzz/abcdef/docs',
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
    ).toBe('view-source:ens://name.eth/docs');

    expect(
      mod.deriveSwitchedTabDisplay({
        url: 'file:///app/pages/home.html',
        bzzRoutePrefix: 'http://127.0.0.1:1633/bzz/',
        homeUrlNormalized: 'file:///app/pages/home.html',
      })
    ).toBe('');
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
    expect(mod.getOriginalUrlFromErrorPage('https://example.com', 'file:///app/pages/error.html')).toBeNull();
    expect(mod.getOriginalUrlFromErrorPage('not-a-url/error.html?', 'file:///app/pages/error.html')).toBeNull();
  });
});
