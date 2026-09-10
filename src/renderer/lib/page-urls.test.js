describe('page-urls', () => {
  const originalWindow = global.window;

  const loadModule = async (internalPages = {}) => {
    jest.resetModules();
    global.window = {
      location: { href: 'file:///app/index.html' },
      internalPages: { routable: internalPages },
    };
    return import('./page-urls.js');
  };

  afterEach(() => {
    global.window = originalWindow;
  });

  test('builds internal page urls from window.internalPages', async () => {
    const routablePages = {
      history: 'history.html',
    };
    routablePages['protocol-test'] = 'protocol-test.html';

    const mod = await loadModule(routablePages);

    expect(mod.internalPages).toEqual({
      history: 'file:///app/pages/history.html',
      'protocol-test': 'file:///app/pages/protocol-test.html',
    });
    expect(mod.homeUrl).toBe('file:///app/pages/home.html');
    expect(mod.errorUrlBase).toBe('file:///app/pages/error.html');
  });

  test('detects protocols for history recording', async () => {
    const mod = await loadModule();

    expect(mod.detectProtocol('ens://vitalik.eth')).toBe('ens');
    expect(mod.detectProtocol('bzz://hash')).toBe('swarm');
    expect(mod.detectProtocol('ipfs://cid')).toBe('ipfs');
    expect(mod.detectProtocol('ipns://name')).toBe('ipns');
    expect(mod.detectProtocol('web3://0x0000000000000000000000000000000000000000.eip155-1/')).toBe(
      'onchain'
    );
    expect(mod.detectProtocol('rad://rid')).toBe('radicle');
    expect(mod.detectProtocol('https://example.com')).toBe('https');
    expect(mod.detectProtocol('http://example.com')).toBe('http');
    expect(mod.detectProtocol('')).toBe('unknown');
  });

  test('filters non-recordable history entries', async () => {
    const mod = await loadModule();

    expect(mod.isHistoryRecordable('', 'https://example.com')).toBe(false);
    expect(mod.isHistoryRecordable('freedom://history', 'file:///app/pages/history.html')).toBe(false);
    expect(mod.isHistoryRecordable('view-source:https://example.com', 'view-source:https://example.com')).toBe(false);
    expect(mod.isHistoryRecordable('https://example.com', 'file:///app/pages/error.html')).toBe(false);
    expect(mod.isHistoryRecordable('https://example.com', mod.homeUrl)).toBe(false);
    expect(mod.isHistoryRecordable('https://example.com', 'https://example.com')).toBe(true);
    // Interstitials (#235): recording them would put the interstitial's own
    // file:// path and title into history and the autocomplete dropdown.
    expect(
      mod.isHistoryRecordable('lagged.tez', 'file:///app/pages/ens-conflict.html?name=lagged.tez')
    ).toBe(false);
    expect(
      mod.isHistoryRecordable('retry.tez', 'file:///app/pages/ens-unverified.html?name=retry.tez')
    ).toBe(false);
    // The onchain trust gate is the same: the app's code never ran, so the
    // `web3://` display URL is not a visit. Recording it would file the
    // gate's warning title against the app, and the caller's once-per-URL
    // dedup would keep a later real load from replacing it.
    const gatedApp = 'web3://0x00000095643cffa7d9fae407a84dfcb6406456c6/';
    for (const gateUrl of [
      `file:///app/pages/onchain-unverified.html?target=${encodeURIComponent(gatedApp)}&token=t`,
      'file:///app/pages/onchain-unverified.html?conflict=1',
    ]) {
      expect(mod.isHistoryRecordable(gatedApp, gateUrl)).toBe(false);
    }
    // A remote look-alike path is real content and stays recordable.
    expect(
      mod.isHistoryRecordable(
        'https://evil.test/pages/onchain-unverified.html',
        'https://evil.test/pages/onchain-unverified.html'
      )
    ).toBe(true);
    // The app itself, once it actually loads, is still recorded.
    expect(mod.isHistoryRecordable(gatedApp, 'web3://0x00000095643cffa7d9fae407a84dfcb6406456c6.eip155-1/')).toBe(
      true
    );
  });

  test('reads the blocked name from interstitial page urls', async () => {
    const mod = await loadModule();

    expect(
      mod.getInterstitialDisplayName(
        'file:///app/pages/ens-unverified.html?name=retry.tez&uri=ipfs%3A%2F%2FQmRetryTez'
      )
    ).toBe('retry.tez');
    expect(
      mod.getInterstitialDisplayName('file:///app/pages/ens-conflict.html?name=lagged.tez&block=%7B%7D')
    ).toBe('lagged.tez');
    // No name param, not an interstitial, or unparseable — never a file:// path.
    expect(mod.getInterstitialDisplayName('file:///app/pages/ens-conflict.html')).toBeNull();
    expect(mod.getInterstitialDisplayName('file:///app/pages/error.html?url=bzz%3A%2F%2Fabc')).toBeNull();
    expect(mod.getInterstitialDisplayName('https://example.com')).toBeNull();
    expect(mod.getInterstitialDisplayName(null)).toBeNull();

    expect(mod.isInterstitialPageUrl('file:///app/pages/ens-unverified.html?name=a.eth')).toBe(true);
    expect(mod.isInterstitialPageUrl('file:///app/pages/ens-conflict.html?name=a.eth')).toBe(true);
    expect(mod.isInterstitialPageUrl('file:///app/pages/error.html')).toBe(false);
    expect(mod.isInterstitialPageUrl(undefined)).toBe(false);
  });

  test('remote look-alike paths are never mistaken for chrome pages', async () => {
    const mod = await loadModule();

    // #235 regression: the interstitial/error-page tests used to match on a
    // `/<file>.html` substring, so any remote page could serve that path and
    // take over the address bar with its own `?name=` / `?url=` value while
    // rendering attacker HTML.
    for (const hostile of [
      'https://evil.test/ens-conflict.html?name=bank.eth',
      'https://evil.test/ens-unverified.html?name=bank.eth',
      'https://evil.test/pages/ens-conflict.html?name=bank.eth',
      'http://127.0.0.1:8080/ipfs/Qm123/ens-conflict.html?name=bank.eth',
      // Same base with extra path/host characters glued on is not our page.
      'file:///app/pages/ens-conflict.html.evil?name=bank.eth',
      'file:///app/pages/ens-conflict.htmlx?name=bank.eth',
    ]) {
      expect(mod.isInterstitialPageUrl(hostile)).toBe(false);
      expect(mod.getInterstitialDisplayName(hostile)).toBeNull();
    }

    for (const hostile of [
      'https://evil.test/error.html?url=bzz%3A%2F%2Fvitalik.eth',
      'https://evil.test/pages/error.html?url=bzz%3A%2F%2Fvitalik.eth',
      'file:///app/pages/error.html.evil?url=bzz%3A%2F%2Fvitalik.eth',
    ]) {
      expect(mod.isErrorPageUrl(hostile)).toBe(false);
      // A remote look-alike is real content, so it stays history-recordable.
      expect(mod.isHistoryRecordable(hostile, hostile)).toBe(true);
    }

    expect(mod.isErrorPageUrl('file:///app/pages/error.html')).toBe(true);
    expect(mod.isErrorPageUrl('file:///app/pages/error.html?url=https%3A%2F%2Fa.test')).toBe(true);
    expect(mod.isErrorPageUrl('file:///app/pages/error.html#frag')).toBe(true);
    expect(mod.isErrorPageUrl(undefined)).toBe(false);
  });

  test('maps internal page urls back to freedom:// names', async () => {
    const mod = await loadModule({
      history: 'history.html',
      links: 'links.html',
      settings: 'settings.html',
    });

    expect(mod.getInternalPageName('file:///app/pages/history.html')).toBe('history');
    expect(mod.getInternalPageName('file:///app/pages/links.html')).toBe('links');
    expect(mod.getInternalPageName('https://example.com')).toBeNull();

    // Hash fragments become sub-paths for sub-page deep links
    // (freedom://settings/appearance → settings.html#appearance).
    expect(mod.getInternalPageName('file:///app/pages/settings.html')).toBe('settings');
    expect(mod.getInternalPageName('file:///app/pages/settings.html#appearance')).toBe(
      'settings/appearance'
    );
    expect(mod.getInternalPageName('file:///app/pages/settings.html#updates')).toBe(
      'settings/updates'
    );
    expect(mod.getInternalPageName('')).toBeNull();
  });

  // #312: the private window's start page is a new-tab page like the home
  // page, in both the friendly and the resolved form. Everything else — other
  // internal pages, ordinary web pages — is not.
  test('recognises the home and private start pages as new-tab pages', async () => {
    const mod = await loadModule({
      home: 'home.html',
      private: 'private.html',
      settings: 'settings.html',
    });

    expect(mod.isNewTabPageUrl('file:///app/pages/home.html')).toBe(true);
    expect(mod.isNewTabPageUrl('freedom://home')).toBe(true);
    expect(mod.isNewTabPageUrl('file:///app/pages/private.html')).toBe(true);
    expect(mod.isNewTabPageUrl('freedom://private')).toBe(true);
    expect(mod.isNewTabPageUrl('freedom://private/')).toBe(true);

    expect(mod.isNewTabPageUrl('file:///app/pages/settings.html')).toBe(false);
    expect(mod.isNewTabPageUrl('freedom://settings')).toBe(false);
    expect(mod.isNewTabPageUrl('about:blank')).toBe(false);
    expect(mod.isNewTabPageUrl('')).toBe(false);
    expect(mod.isNewTabPageUrl(null)).toBe(false);
    // A remote look-alike path must not pass as chrome's own page (#235).
    expect(mod.isNewTabPageUrl('https://evil.test/pages/private.html')).toBe(false);
  });

  // The name-keyed form the internal-page singleton rules in `tabs.js` use:
  // a new-tab page is deliberately *not* a singleton tab.
  test('recognises the new-tab pages by name, sub-path and all', async () => {
    const mod = await loadModule({ home: 'home.html', private: 'private.html' });

    expect(mod.isNewTabPageName('home')).toBe(true);
    expect(mod.isNewTabPageName('private')).toBe(true);
    expect(mod.isNewTabPageName('HOME')).toBe(true);
    expect(mod.isNewTabPageName('home/anything')).toBe(true);

    expect(mod.isNewTabPageName('settings')).toBe(false);
    expect(mod.isNewTabPageName('')).toBe(false);
    expect(mod.isNewTabPageName(null)).toBe(false);
    expect(mod.isNewTabPageName(undefined)).toBe(false);
  });

  test('extracts the web3 target only from the bundled onchain interstitial', async () => {
    const mod = await loadModule();
    const target = 'web3://0x00000095643cffa7d9fae407a84dfcb6406456c6.eip155-1/swap';
    const internal = `file:///app/pages/onchain-unverified.html?target=${encodeURIComponent(target)}`;

    expect(mod.getOnchainInterstitialTarget(internal)).toBe(target);
    expect(
      mod.getOnchainInterstitialTarget(
        `https://example.com/pages/onchain-unverified.html?target=${encodeURIComponent(target)}`
      )
    ).toBeNull();
    expect(
      mod.getOnchainInterstitialTarget(
        'file:///app/pages/onchain-unverified.html?target=https%3A%2F%2Fevil.example'
      )
    ).toBeNull();

    // The page test itself is separate from the target extraction, so chrome
    // surfaces can fail safe (blank address bar, no history entry) on a gate
    // URL whose target is missing or not a web3: URL.
    expect(mod.isOnchainInterstitialPageUrl(internal)).toBe(true);
    expect(mod.isOnchainInterstitialPageUrl('file:///app/pages/onchain-unverified.html')).toBe(true);
    expect(
      mod.isOnchainInterstitialPageUrl(
        'https://evil.test/pages/onchain-unverified.html?target=web3%3A%2F%2F0x1'
      )
    ).toBe(false);
    expect(mod.isOnchainInterstitialPageUrl('file:///app/pages/error.html')).toBe(false);
    expect(mod.isOnchainInterstitialPageUrl(undefined)).toBe(false);

    // Both interstitial families answer to one predicate, so surfaces that
    // must refuse the shell's own page URL outright (the context menu's View
    // Page Source item, the `view-source:` navigation dispatch) can't cover
    // one family and miss the other.
    expect(mod.isTrustInterstitialPageUrl(internal)).toBe(true);
    expect(mod.isTrustInterstitialPageUrl('file:///app/pages/ens-unverified.html?name=a.eth')).toBe(
      true
    );
    expect(mod.isTrustInterstitialPageUrl('file:///app/pages/ens-conflict.html?name=a.tez')).toBe(
      true
    );
    expect(mod.isTrustInterstitialPageUrl('file:///app/pages/error.html?url=https://a.test')).toBe(
      false
    );
    expect(mod.isTrustInterstitialPageUrl('https://evil.test/pages/ens-conflict.html')).toBe(false);
    expect(mod.isTrustInterstitialPageUrl('https://example.com/')).toBe(false);
  });

  test('parses ens inputs with prefixes, paths, and invalid names', async () => {
    const mod = await loadModule();

    expect(mod.parseEnsInput('ens://Vitalik.ETH/docs?q=1')).toEqual({
      name: 'vitalik.eth',
      suffix: '/docs?q=1',
      assertedTransport: null,
    });
    expect(mod.parseEnsInput('name.box#top')).toEqual({
      name: 'name.box',
      suffix: '#top',
      assertedTransport: null,
    });
    expect(mod.parseEnsInput('alice.wei/site')).toEqual({
      name: 'alice.wei',
      suffix: '/site',
      assertedTransport: null,
    });
    expect(mod.parseEnsInput('apoorv.gwei/site')).toEqual({
      name: 'apoorv.gwei',
      suffix: '/site',
      assertedTransport: null,
    });
    expect(mod.parseEnsInput('example.com')).toBeNull();
    expect(mod.parseEnsInput('')).toBeNull();
  });

  test('parses transport-prefixed ens inputs (bzz://, ipfs://, ipns://)', async () => {
    // Issue #16: bzz://meinhard.eth should resolve via ENS the same way
    // ens://meinhard.eth or a bare meinhard.eth does. Same applies to
    // ipfs://name.eth and ipns://name.eth so any DWeb scheme can carry an
    // ENS host. The `assertedTransport` field surfaces the typed scheme
    // so the renderer can enforce cross-transport assertion at resolution
    // time (typed bzz:// + IPFS contenthash → error).
    const mod = await loadModule();

    expect(mod.parseEnsInput('bzz://meinhard.eth')).toEqual({
      name: 'meinhard.eth',
      suffix: '',
      assertedTransport: 'bzz',
    });
    expect(mod.parseEnsInput('bzz://Meinhard.ETH/path?x=1')).toEqual({
      name: 'meinhard.eth',
      suffix: '/path?x=1',
      assertedTransport: 'bzz',
    });
    expect(mod.parseEnsInput('ipfs://vitalik.eth/docs')).toEqual({
      name: 'vitalik.eth',
      suffix: '/docs',
      assertedTransport: 'ipfs',
    });
    expect(mod.parseEnsInput('ipns://app.box#fragment')).toEqual({
      name: 'app.box',
      suffix: '#fragment',
      assertedTransport: 'ipns',
    });
    expect(mod.parseEnsInput('ipfs://alice.wei/docs')).toEqual({
      name: 'alice.wei',
      suffix: '/docs',
      assertedTransport: 'ipfs',
    });
    expect(mod.parseEnsInput('ipfs://apoorv.gwei/docs')).toEqual({
      name: 'apoorv.gwei',
      suffix: '/docs',
      assertedTransport: 'ipfs',
    });

    // Transport prefixes with non-ENS hosts must NOT be treated as ENS input;
    // letting bzz://<hash> through would attempt an ENS lookup against a
    // Swarm reference.
    expect(mod.parseEnsInput('bzz://abcdef0123456789')).toBeNull();
    expect(mod.parseEnsInput('ipfs://QmHash')).toBeNull();
  });

  test('parses .tez website names without accepting the ENS scheme', async () => {
    const mod = await loadModule();

    expect(mod.parseEnsInput('Docs.Example.TEZ/guide?q=1')).toEqual({
      name: 'docs.example.tez',
      suffix: '/guide?q=1',
      assertedTransport: null,
      system: 'tezos',
    });
    expect(mod.parseEnsInput('ipfs://docs.example.tez/guide')).toEqual({
      name: 'docs.example.tez',
      suffix: '/guide',
      assertedTransport: 'ipfs',
      system: 'tezos',
    });
    expect(mod.parseEnsInput('ens://docs.example.tez')).toBeNull();
  });
});
