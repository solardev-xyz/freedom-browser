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

  test('parses ens inputs with prefixes, paths, and invalid names', async () => {
    const mod = await loadModule();

    expect(mod.parseEnsInput('ens://Vitalik.ETH/docs?q=1')).toEqual({
      name: 'vitalik.eth',
      suffix: '/docs?q=1',
    });
    expect(mod.parseEnsInput('name.box#top')).toEqual({
      name: 'name.box',
      suffix: '#top',
    });
    expect(mod.parseEnsInput('example.com')).toBeNull();
    expect(mod.parseEnsInput('')).toBeNull();
  });
});
