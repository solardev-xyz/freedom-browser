const fs = require('fs');
const os = require('os');
const path = require('path');

// The dispatcher's a singleton — mock it so install assertions don't trip
// over residue from other suites (same pattern as request-rewriter.test.js).
jest.mock('../webrequest-dispatcher', () => {
  const handlers = [];
  return {
    registerWebRequestHandler: jest.fn((event, name, handler) => {
      handlers.push({ event, name, handler });
    }),
    _getHandlers: () => handlers,
  };
});

jest.mock('../settings-store', () => ({
  loadSettings: jest.fn(),
}));

// Electron is absent under Jest, which is what the "no landed update" default
// exercises (the service catches the failure). Tests that need the Swarm
// update layer point this at a fake userData dir.
const mockElectron = { userData: null };
jest.mock('electron', () => ({
  get app() {
    if (!mockElectron.userData) throw new Error('electron unavailable');
    return { getPath: () => mockElectron.userData, isPackaged: false };
  },
}));

const dispatcherMock = require('../webrequest-dispatcher');
const { loadSettings } = require('../settings-store');
const {
  installAdblockInterception,
  adblockRequestForDispatch,
  getCosmeticFilters,
  getScriptlets,
  stripTrustedScriptlets,
  refreshEngine,
  cleanupAdblockWebContents,
  setAllowlistedHosts,
  getAdblockStatus,
  getEnabledCategories,
  getEnabledFeedCategories,
  _resetAdblockForTests,
} = require('./service');

const DEFAULT_TEST_SETTINGS = {
  adblockEnabled: true,
  adblockAds: true,
  adblockPrivacy: true,
  adblockCookies: false,
  adblockAnnoyances: false,
};

// Minimal ABP-syntax fixture lists, one per category. The ads list also
// carries cosmetic (element-hiding) rules exercised by getCosmeticFilters.
const FIXTURE_LISTS = {
  'easylist.txt': [
    '||ads.tracker.test^$third-party',
    '@@||ads.tracker.test/acceptable^',
    'news.example##.hostname-ad',
    '##.generic-ad',
  ].join('\n'),
  'easyprivacy.txt': '||telemetry.test^',
  'easylist-cookies.txt': '||cookiewall.test^',
};

const MANIFEST = {
  version: '2026-07-05',
  categories: {
    ads: { file: 'easylist.txt' },
    privacy: { file: 'easyprivacy.txt' },
    cookies: { file: 'easylist-cookies.txt' },
  },
};

let artifactsDir;

function writeFixtureArtifacts() {
  artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adblock-test-'));
  fs.writeFileSync(path.join(artifactsDir, 'manifest.json'), JSON.stringify(MANIFEST));
  for (const [name, text] of Object.entries(FIXTURE_LISTS)) {
    fs.writeFileSync(path.join(artifactsDir, name), text);
  }
}

// A fake userData holding a landed Swarm update that carries only 'ads' —
// what the update-manager writes when only ads+privacy were enabled at
// download time. Returns the userData dir (caller cleans up).
function writeUpdateLayer() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'adblock-userdata-'));
  const updated = path.join(userData, 'adblock', 'updated');
  fs.mkdirSync(updated, { recursive: true });
  fs.writeFileSync(path.join(updated, 'easylist.txt'), '||updated-ads.test^');
  fs.writeFileSync(
    path.join(updated, 'manifest.json'),
    JSON.stringify({
      version: '2026-08-01',
      feedVersion: 9,
      categories: { ads: { file: 'easylist.txt', title: 'EasyList', ruleCount: 1 } },
    })
  );
  return userData;
}

// A subresource request as the dispatcher hands it to handlers.
function makeDetails(overrides = {}) {
  return {
    url: 'https://ads.tracker.test/banner.js',
    resourceType: 'script',
    webContentsId: 7,
    referrer: '',
    ...overrides,
  };
}

// Record the tab's top-level navigation so first-party context exists.
function navigateTab(webContentsId, url) {
  adblockRequestForDispatch({ url, resourceType: 'mainFrame', webContentsId, referrer: '' });
}

beforeAll(() => {
  writeFixtureArtifacts();
});

afterAll(() => {
  fs.rmSync(artifactsDir, { recursive: true, force: true });
});

beforeEach(async () => {
  loadSettings.mockReturnValue({ ...DEFAULT_TEST_SETTINGS });
  _resetAdblockForTests();
  installAdblockInterception({ artifactsDir });
  await refreshEngine();
  navigateTab(7, 'https://news.example/story');
});

describe('installAdblockInterception', () => {
  test('registers an onBeforeRequest handler named adblock', () => {
    const entries = dispatcherMock
      ._getHandlers()
      .filter((h) => h.event === 'onBeforeRequest' && h.name === 'adblock');
    expect(entries.length).toBeGreaterThan(0);
  });
});

describe('adblockRequestForDispatch', () => {
  test('blocks a third-party request matching an enabled list', () => {
    expect(adblockRequestForDispatch(makeDetails())).toEqual({ cancel: true });
  });

  test('blocks requests from the privacy category', () => {
    expect(
      adblockRequestForDispatch(
        makeDetails({ url: 'https://telemetry.test/beacon', resourceType: 'ping' })
      )
    ).toEqual({ cancel: true });
  });

  test('respects @@ exception rules', () => {
    expect(
      adblockRequestForDispatch(makeDetails({ url: 'https://ads.tracker.test/acceptable/x.js' }))
    ).toBe(null);
  });

  test('never cancels main-frame navigation, even to a listed host', () => {
    expect(
      adblockRequestForDispatch(
        makeDetails({ url: 'https://ads.tracker.test/', resourceType: 'mainFrame' })
      )
    ).toBe(null);
  });

  test('does not load lists for disabled categories', () => {
    expect(
      adblockRequestForDispatch(makeDetails({ url: 'https://cookiewall.test/banner.js' }))
    ).toBe(null);
  });

  test('rebuilds the engine when a category setting changes', async () => {
    loadSettings.mockReturnValue({ ...DEFAULT_TEST_SETTINGS, adblockCookies: true });
    await refreshEngine();
    expect(
      adblockRequestForDispatch(makeDetails({ url: 'https://cookiewall.test/banner.js' }))
    ).toEqual({ cancel: true });
  });

  test('passes everything through when adblockEnabled is false', () => {
    loadSettings.mockReturnValue({ ...DEFAULT_TEST_SETTINGS, adblockEnabled: false });
    expect(adblockRequestForDispatch(makeDetails())).toBe(null);
  });

  test('ignores non-http(s) and loopback URLs', () => {
    expect(adblockRequestForDispatch(makeDetails({ url: 'file:///tmp/x.js' }))).toBe(null);
    expect(
      adblockRequestForDispatch(makeDetails({ url: 'http://127.0.0.1:1633/bzz/abc/ad.js' }))
    ).toBe(null);
  });

  test('bypasses the engine for allowlisted top-level hosts, including subdomains', () => {
    setAllowlistedHosts(['news.example']);
    expect(adblockRequestForDispatch(makeDetails())).toBe(null);

    navigateTab(7, 'https://m.news.example/story');
    expect(adblockRequestForDispatch(makeDetails())).toBe(null);

    setAllowlistedHosts([]);
    expect(adblockRequestForDispatch(makeDetails())).toEqual({ cancel: true });
  });

  test('normalizes allowlist entries at store time', () => {
    setAllowlistedHosts(['WWW.News.Example.', '', null]);
    expect(adblockRequestForDispatch(makeDetails())).toBe(null);
  });

  test('scopes the allowlist to the requesting tab', () => {
    setAllowlistedHosts(['news.example']);
    navigateTab(8, 'https://other.example/');
    expect(adblockRequestForDispatch(makeDetails({ webContentsId: 8 }))).toEqual({
      cancel: true,
    });
  });

  test('falls back to referrer for first-party context when the tab is unknown', () => {
    // No mainFrame was recorded for webContents 99 (e.g. service worker).
    const details = makeDetails({
      webContentsId: 99,
      url: 'https://ads.tracker.test/banner.js',
      referrer: 'https://news.example/story',
    });
    expect(adblockRequestForDispatch(details)).toEqual({ cancel: true });
  });

  test('does not block first-party requests for third-party-only rules', () => {
    navigateTab(7, 'https://ads.tracker.test/home');
    expect(adblockRequestForDispatch(makeDetails())).toBe(null);
  });
});

describe('cleanupAdblockWebContents', () => {
  test('drops the tab context so later requests lose first-party state', () => {
    const beacon = { url: 'https://telemetry.test/beacon' };
    setAllowlistedHosts(['news.example']);
    expect(adblockRequestForDispatch(makeDetails(beacon))).toBe(null);
    cleanupAdblockWebContents(7);
    // Without top-level context the allowlist no longer applies. (Rules
    // scoped $third-party stop matching too — unknown source is treated
    // as first-party for safety — so probe with an unscoped rule.)
    expect(adblockRequestForDispatch(makeDetails(beacon))).toEqual({ cancel: true });
  });
});

describe('getCosmeticFilters', () => {
  test('initial call returns hostname-specific hiding rules', () => {
    const res = getCosmeticFilters({
      url: 'https://news.example/story',
      sourceId: 7,
      initial: true,
    });
    expect(res.active).toBe(true);
    expect(res.styles).toContain('.hostname-ad');
    // Generic rules need DOM features, absent on the initial call.
    expect(res.styles).not.toContain('.generic-ad');
  });

  test('feature call returns generic rules matching provided classes/ids', () => {
    const res = getCosmeticFilters({
      url: 'https://news.example/story',
      sourceId: 7,
      classes: ['generic-ad', 'unrelated'],
      ids: [],
      hrefs: [],
    });
    expect(res.active).toBe(true);
    expect(res.styles).toContain('.generic-ad');
  });

  test('is inactive for an allowlisted top-level host', () => {
    setAllowlistedHosts(['news.example']);
    expect(
      getCosmeticFilters({ url: 'https://news.example/story', sourceId: 7, initial: true })
    ).toEqual({
      active: false,
      styles: '',
    });
  });

  test('scopes the allowlist to the tab top-level host, not the frame', () => {
    setAllowlistedHosts(['news.example']);
    // A third-party subframe within the allowlisted tab is also spared.
    expect(
      getCosmeticFilters({ url: 'https://widget.other/frame', sourceId: 7, initial: true })
    ).toEqual({ active: false, styles: '' });
  });

  test('is inactive when adblock is disabled', () => {
    loadSettings.mockReturnValue({ ...DEFAULT_TEST_SETTINGS, adblockEnabled: false });
    expect(getCosmeticFilters({ url: 'https://news.example/story', initial: true })).toEqual({
      active: false,
      styles: '',
    });
  });

  test('ignores non-http(s) frames', () => {
    expect(getCosmeticFilters({ url: 'bzz://abc/', initial: true })).toEqual({
      active: false,
      styles: '',
    });
  });
});

describe('engine cache', () => {
  let cacheDir;

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adblock-cache-'));
  });

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  test('writes a serialized engine and can rebuild from it without list files', async () => {
    _resetAdblockForTests();
    installAdblockInterception({ artifactsDir, cacheDir });
    await refreshEngine();
    expect(fs.readdirSync(cacheDir).filter((f) => f.startsWith('engine-'))).toHaveLength(1);

    // Same manifest (same cache key) but no list files on disk: blocking
    // still works, proving the engine came from the serialized cache.
    const manifestOnly = fs.mkdtempSync(path.join(os.tmpdir(), 'adblock-manifest-'));
    fs.copyFileSync(
      path.join(artifactsDir, 'manifest.json'),
      path.join(manifestOnly, 'manifest.json')
    );
    _resetAdblockForTests();
    installAdblockInterception({ artifactsDir: manifestOnly, cacheDir });
    await refreshEngine();
    navigateTab(7, 'https://news.example/story');
    expect(adblockRequestForDispatch(makeDetails())).toEqual({ cancel: true });

    fs.rmSync(manifestOnly, { recursive: true, force: true });
  });

  test('a category change misses the cache, rebuilds, and prunes stale caches', async () => {
    _resetAdblockForTests();
    installAdblockInterception({ artifactsDir, cacheDir });
    await refreshEngine();

    loadSettings.mockReturnValue({ ...DEFAULT_TEST_SETTINGS, adblockCookies: true });
    await refreshEngine();
    navigateTab(7, 'https://news.example/story');
    expect(
      adblockRequestForDispatch(makeDetails({ url: 'https://cookiewall.test/banner.js' }))
    ).toEqual({ cancel: true });
    expect(fs.readdirSync(cacheDir).filter((f) => f.startsWith('engine-'))).toHaveLength(1);
  });
});

describe('refreshEngine', () => {
  test('leaves blocking disabled when the artifacts dir is missing', async () => {
    _resetAdblockForTests();
    installAdblockInterception({ artifactsDir: path.join(artifactsDir, 'nope') });
    await refreshEngine();
    navigateTab(7, 'https://news.example/story');
    expect(adblockRequestForDispatch(makeDetails())).toBe(null);
  });

  test('re-resolves the artifacts dir each build when not pinned (FREEDOM_ADBLOCK_DIR)', async () => {
    // When no artifactsDir is injected, refreshEngine picks up a dir change
    // between builds — this is what lets a just-promoted Swarm update apply
    // in-session instead of only after a restart.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'adblock-empty-'));
    fs.writeFileSync(
      path.join(empty, 'manifest.json'),
      JSON.stringify({ version: 'x', categories: {} })
    );

    _resetAdblockForTests();
    process.env.FREEDOM_ADBLOCK_DIR = empty;
    installAdblockInterception({}); // no pinned artifactsDir
    await refreshEngine();
    navigateTab(7, 'https://news.example/story');
    expect(adblockRequestForDispatch(makeDetails())).toBe(null); // empty list -> no block

    // Point the env at the real fixture and rebuild: the new dir takes effect.
    process.env.FREEDOM_ADBLOCK_DIR = artifactsDir;
    await refreshEngine();
    expect(adblockRequestForDispatch(makeDetails())).toEqual({ cancel: true });

    delete process.env.FREEDOM_ADBLOCK_DIR;
    fs.rmSync(empty, { recursive: true, force: true });
  });

  test('a slower earlier build cannot overwrite a newer one (settings race)', async () => {
    // Settings changes fire refreshEngine() without awaiting each other.
    // Build #1 sees cookies enabled and is made artificially slow (its
    // cookies-list read blocks on a gate); build #2 sees them disabled
    // again. However the two interleave, the engine must end up
    // reflecting the newest settings: cookies not blocked. Caching is off
    // so both builds really parse list text.
    _resetAdblockForTests();
    installAdblockInterception({ artifactsDir, cacheDir: null });

    const realReadFile = fs.promises.readFile;
    let releaseCookiesRead;
    const gate = new Promise((resolve) => (releaseCookiesRead = resolve));
    const readFileSpy = jest
      .spyOn(fs.promises, 'readFile')
      .mockImplementation(async (file, ...args) => {
        if (String(file).includes('easylist-cookies')) await gate;
        return realReadFile(file, ...args);
      });

    try {
      loadSettings.mockReturnValue({ ...DEFAULT_TEST_SETTINGS, adblockCookies: true });
      const first = refreshEngine();
      await Promise.resolve(); // let build #1 capture the cookies-on settings
      loadSettings.mockReturnValue({ ...DEFAULT_TEST_SETTINGS });
      const second = refreshEngine();

      // Give any ungated build time to finish, then unblock the slow one.
      await new Promise((resolve) => setTimeout(resolve, 50));
      releaseCookiesRead();
      await Promise.all([first, second]);
    } finally {
      readFileSpy.mockRestore();
    }

    navigateTab(7, 'https://news.example/story');
    expect(
      adblockRequestForDispatch(makeDetails({ url: 'https://cookiewall.test/banner.js' }))
    ).toBe(null);
    // The newest build is live, not merely "no engine at all".
    expect(adblockRequestForDispatch(makeDetails())).toEqual({ cancel: true });
  });

  test('a landed update invalidates an engine cache built from the floor alone', async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adblock-cache-'));
    process.env.FREEDOM_ADBLOCK_DIR = artifactsDir;

    // Build (and cache) from the bundled floor only.
    _resetAdblockForTests();
    installAdblockInterception({ cacheDir });
    await refreshEngine();
    navigateTab(7, 'https://news.example/story');
    expect(adblockRequestForDispatch(makeDetails())).toEqual({ cancel: true });

    // Now an update lands for 'ads'. The cached engine must not be reused.
    const userData = writeUpdateLayer();
    mockElectron.userData = userData;
    _resetAdblockForTests();
    installAdblockInterception({ cacheDir });
    await refreshEngine();
    navigateTab(7, 'https://news.example/story');
    expect(
      adblockRequestForDispatch(makeDetails({ url: 'https://updated-ads.test/x.js' }))
    ).toEqual({ cancel: true });

    mockElectron.userData = null;
    delete process.env.FREEDOM_ADBLOCK_DIR;
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  test('skips unreadable list files without disabling the rest', async () => {
    const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'adblock-broken-'));
    fs.writeFileSync(
      path.join(broken, 'manifest.json'),
      JSON.stringify({
        version: 'x',
        categories: {
          ads: { file: 'missing.txt' },
          privacy: { file: 'easyprivacy.txt' },
        },
      })
    );
    fs.writeFileSync(path.join(broken, 'easyprivacy.txt'), FIXTURE_LISTS['easyprivacy.txt']);

    _resetAdblockForTests();
    installAdblockInterception({ artifactsDir: broken });
    await refreshEngine();
    navigateTab(7, 'https://news.example/story');

    expect(
      adblockRequestForDispatch(makeDetails({ url: 'https://telemetry.test/beacon' }))
    ).toEqual({ cancel: true });

    fs.rmSync(broken, { recursive: true, force: true });
  });
});

describe('artifact layers', () => {
  let userData;

  beforeEach(() => {
    userData = writeUpdateLayer();
    mockElectron.userData = userData;
    // Stand in for the bundled floor (the real one is gitignored).
    process.env.FREEDOM_ADBLOCK_DIR = artifactsDir;
  });

  afterEach(() => {
    mockElectron.userData = null;
    delete process.env.FREEDOM_ADBLOCK_DIR;
    fs.rmSync(userData, { recursive: true, force: true });
  });

  async function buildWithLayers(settings) {
    _resetAdblockForTests();
    loadSettings.mockReturnValue({ ...DEFAULT_TEST_SETTINGS, ...settings });
    installAdblockInterception({ cacheDir: null }); // no pinned artifactsDir
    await refreshEngine();
    navigateTab(7, 'https://news.example/story');
  }

  test('an update wins for the categories it carries', async () => {
    await buildWithLayers();
    expect(
      adblockRequestForDispatch(makeDetails({ url: 'https://updated-ads.test/x.js' }))
    ).toEqual({ cancel: true });
    // The bundled ads list is replaced, not merged, for that category.
    expect(adblockRequestForDispatch(makeDetails())).toBe(null);
  });

  test('a category the update omits still blocks from the bundled floor', async () => {
    // The update landed while only ads+privacy were on; the user then enables
    // cookie banners. That category must block immediately from the bundled
    // list rather than silently do nothing until the feed version bumps.
    await buildWithLayers({ adblockCookies: true });
    expect(
      adblockRequestForDispatch(makeDetails({ url: 'https://cookiewall.test/banner.js' }))
    ).toEqual({ cancel: true });
    // Privacy, absent from the update too, keeps blocking as well.
    expect(
      adblockRequestForDispatch(makeDetails({ url: 'https://telemetry.test/beacon' }))
    ).toEqual({ cancel: true });
  });

  test('reports the update version and merged categories in the status', async () => {
    await buildWithLayers({ adblockCookies: true });
    const status = getAdblockStatus();
    expect(status.listsVersion).toBe('2026-08-01');
    expect(Object.keys(status.categories).sort()).toEqual(['ads', 'cookies', 'privacy']);
  });
});

// #410: `##+js(...)` scriptlets, from a resources file named by the manifest.
describe('scriptlets', () => {
  // The shape @ghostery's Resources.parse reads (uBlock's scriptlets in
  // resources.json form). Each scriptlet records the args it was called with
  // on globalThis.__marks, so a test can execute what getScriptlets returns.
  const record = (fnName, tag) =>
    `function ${fnName}(a) { (globalThis.__marks = globalThis.__marks || []).push('${tag}:' + a); }`;
  const RESOURCES = {
    scriptlets: [
      { name: 'mark.js', aliases: ['mk.js'], body: record('mark', 'mark'), dependencies: [] },
      {
        name: 'trusted-mark.js',
        aliases: [],
        body: record('trustedMark', 'trusted'),
        dependencies: [],
        requiresTrust: true,
      },
      // Trust-requiring without the `trusted-` prefix (uBlock has these, e.g.
      // prevent-clipboard-write.js): only the resources file says so.
      {
        name: 'quiet-power.js',
        aliases: ['qp.js'],
        body: record('quietPower', 'quiet'),
        dependencies: [],
        requiresTrust: true,
      },
    ],
    redirects: [],
  };
  const RULES = [
    'video.test##+js(mark, hello)',
    'video.test##+js(trusted-mark, t)',
    'video.test##+js(qp, q)',
  ];

  let dir;
  let cacheDir;

  function writeArtifacts({ resources = RESOURCES, withResources = true, resourcesSha } = {}) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adblock-scriptlets-'));
    const manifest = {
      version: '2026-09-23',
      categories: {
        ads: { file: 'easylist.txt' },
        ublock: { file: 'ublock-filters.txt' },
        privacy: { file: 'easyprivacy.txt' },
      },
    };
    // EasyList carries the same rules on another host, to show which ones an
    // untrusted list keeps.
    fs.writeFileSync(
      path.join(dir, 'easylist.txt'),
      RULES.map((r) => r.replace('video.test', 'easy.test')).join('\n')
    );
    fs.writeFileSync(path.join(dir, 'ublock-filters.txt'), RULES.join('\n'));
    fs.writeFileSync(path.join(dir, 'easyprivacy.txt'), '||telemetry.test^');
    if (withResources) {
      fs.writeFileSync(path.join(dir, 'resources.json'), JSON.stringify(resources));
      manifest.resources = {
        file: 'resources.json',
        version: 'v-test',
        sha256: resourcesSha || 'sha-one',
      };
    }
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  }

  async function install(options = {}) {
    _resetAdblockForTests();
    installAdblockInterception({ artifactsDir: dir, ...options });
    await refreshEngine();
  }

  // Run what the preload would hand executeInMainWorld; return the marks.
  function run(script) {
    delete globalThis.__marks;
    new Function(script)();
    const marks = globalThis.__marks || [];
    delete globalThis.__marks;
    return marks;
  }

  beforeEach(async () => {
    writeArtifacts();
    await install();
    navigateTab(9, 'https://video.test/watch');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (cacheDir) fs.rmSync(cacheDir, { recursive: true, force: true });
    cacheDir = null;
  });

  test('returns runnable code for the frame host, trusted scriptlets included for uBlock lists', () => {
    const { script } = getScriptlets({ url: 'https://video.test/watch', sourceId: 9 });
    expect(run(script).sort()).toEqual(['mark:hello', 'quiet:q', 'trusted:t']);
  });

  test('strips trust-requiring scriptlets from every other list', () => {
    navigateTab(9, 'https://easy.test/');
    const { script } = getScriptlets({ url: 'https://easy.test/', sourceId: 9 });
    expect(run(script)).toEqual(['mark:hello']);
  });

  test('one throwing scriptlet does not stop the others', () => {
    writeArtifacts({
      resources: {
        ...RESOURCES,
        scriptlets: [
          ...RESOURCES.scriptlets,
          {
            name: 'boom.js',
            aliases: [],
            body: 'function boom() { throw new Error("x"); }',
            dependencies: [],
          },
        ],
      },
    });
    fs.writeFileSync(
      path.join(dir, 'ublock-filters.txt'),
      ['video.test##+js(boom)', 'video.test##+js(mark, after)'].join('\n')
    );
    return install().then(() => {
      const { script } = getScriptlets({ url: 'https://video.test/', sourceId: 9 });
      expect(run(script)).toEqual(['mark:after']);
    });
  });

  test('a host without rules gets nothing', () => {
    expect(getScriptlets({ url: 'https://plain.test/', sourceId: 9 })).toEqual({ script: '' });
  });

  test('a sub-frame is matched on its own host', () => {
    // Tab on some other site, frame on video.test (an embedded player).
    navigateTab(9, 'https://blog.test/post');
    const { script } = getScriptlets({ url: 'https://video.test/embed/x', sourceId: 9 });
    expect(run(script)).toContain('mark:hello');
  });

  test('respects the master toggle', () => {
    loadSettings.mockReturnValue({ ...DEFAULT_TEST_SETTINGS, adblockEnabled: false });
    expect(getScriptlets({ url: 'https://video.test/watch', sourceId: 9 })).toEqual({
      script: '',
    });
  });

  test('the uBlock list follows the "Block ads" toggle', async () => {
    loadSettings.mockReturnValue({ ...DEFAULT_TEST_SETTINGS, adblockAds: false });
    await refreshEngine();
    expect(getScriptlets({ url: 'https://video.test/watch', sourceId: 9 })).toEqual({
      script: '',
    });
  });

  test("is off for an allowlisted tab, keyed on the tab's top-level host", () => {
    setAllowlistedHosts(['video.test']);
    expect(getScriptlets({ url: 'https://video.test/watch', sourceId: 9 })).toEqual({
      script: '',
    });
    // A sub-frame of an allowlisted tab is spared too.
    setAllowlistedHosts(['blog.test']);
    navigateTab(9, 'https://blog.test/post');
    expect(getScriptlets({ url: 'https://video.test/embed/x', sourceId: 9 })).toEqual({
      script: '',
    });
  });

  test.each(['file:///app/pages/home.html', 'bzz://abc/', 'ipfs://bafy/', 'wss://video.test/'])(
    'never answers for %s',
    (url) => {
      expect(getScriptlets({ url, sourceId: 9 })).toEqual({ script: '' });
    }
  );

  test('without a resources file the engine still blocks, with no scriptlets', async () => {
    writeArtifacts({ withResources: false });
    await install();
    navigateTab(9, 'https://video.test/watch');
    expect(getScriptlets({ url: 'https://video.test/watch', sourceId: 9 })).toEqual({
      script: '',
    });
    expect(
      adblockRequestForDispatch(makeDetails({ url: 'https://telemetry.test/p', webContentsId: 9 }))
    ).toEqual({ cancel: true });
  });

  test('an unparsable resources file degrades the same way', async () => {
    writeArtifacts();
    fs.writeFileSync(path.join(dir, 'resources.json'), '{not json');
    await install();
    expect(getScriptlets({ url: 'https://video.test/watch', sourceId: 9 })).toEqual({
      script: '',
    });
  });

  test('scriptlets survive the serialized engine cache, and new resources miss it', async () => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adblock-cache-'));
    await install({ cacheDir });
    const [first] = fs.readdirSync(cacheDir).filter((f) => f.startsWith('engine-'));

    // Cache hit: drop the list and resources files; scriptlets still come out.
    fs.rmSync(path.join(dir, 'ublock-filters.txt'));
    fs.rmSync(path.join(dir, 'resources.json'));
    await install({ cacheDir });
    navigateTab(9, 'https://video.test/watch');
    expect(run(getScriptlets({ url: 'https://video.test/watch', sourceId: 9 }).script)).toContain(
      'mark:hello'
    );

    // A different resources digest is a different engine.
    fs.rmSync(dir, { recursive: true, force: true });
    writeArtifacts({ resourcesSha: 'sha-two' });
    await install({ cacheDir });
    const caches = fs.readdirSync(cacheDir).filter((f) => f.startsWith('engine-'));
    expect(caches).toHaveLength(1);
    expect(caches[0]).not.toBe(first);
  });

  test('the uBlock list is enabled with "Block ads" but never requested from the feed', () => {
    expect(getEnabledCategories()).toEqual(['ads', 'ublock', 'privacy']);
    expect(getEnabledFeedCategories()).toEqual(['ads', 'privacy']);
  });
});

describe('stripTrustedScriptlets', () => {
  test('drops trusted-* injections, keeps exceptions and everything else', () => {
    const text = [
      'a.test##+js(trusted-set-constant, x, 1)',
      'a.test##+js(trusted-anything-new)',
      'a.test#@#+js(trusted-set-constant, x, 1)',
      'a.test##+js(set-constant, x, 1)',
      'a.test##.ad',
      '||ads.test^',
    ].join('\n');
    expect(stripTrustedScriptlets(text, new Set()).split('\n')).toEqual([
      '',
      '',
      'a.test#@#+js(trusted-set-constant, x, 1)',
      'a.test##+js(set-constant, x, 1)',
      'a.test##.ad',
      '||ads.test^',
    ]);
  });

  test('uses the resources file for trust-requiring names without the prefix', () => {
    expect(
      stripTrustedScriptlets('a.test##+js(qp, 1)\nb.test##+js(mark)', new Set(['qp'])).split('\n')
    ).toEqual(['', 'b.test##+js(mark)']);
  });
});
