// The Swarm node's cache (#579), shown in one place only: Settings → Nodes →
// Swarm cache. Its usage line is read from `GET /debugstore` by the main
// process; its size picker writes the size the node starts with and applies it
// live (`PUT /v0/cache/capacity`); Clear cache sends `POST /v0/cache/clear`.
// The node window (the toolbar's Nodes menu) has no cache row at all.
//
// The harness runs no node. The usage, clear and live-size groups serve those
// routes from a fake antd and run the real main-process cache service
// (swarm/ant-cache.js) against it, with the node's status, spawn time and data
// dir under the test's control, so every state goes through the real parser,
// the real client and the real settings page. The picker group drives the real
// picker with no node. Set SWARM_CACHE_SHOTS_DIR to keep a screenshot of every
// state in both themes.

const fs = require('fs');
const path = require('path');
const { test, expect } = require('./fixtures');

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const SHOTS = process.env.SWARM_CACHE_SHOTS_DIR || null;

// Ant v0.5.61's `/debugstore` for `used`/`pinned` bytes under a `cap`.
const debugstore = ({ used = 0, pinned = 0, cap = 2 * GIB }) => ({
  Upload: { TotalUploaded: 0, TotalSynced: 0, PendingUpload: 0 },
  Pinning: { TotalCollections: pinned ? 1 : 0, TotalChunks: pinned / 4096 },
  Cache: { Size: used / 4096, Capacity: cap / 4096 },
  Reserve: { SizeWithinRadius: 0, TotalSize: 0, Capacity: 0, LastBinIDs: null, Epoch: 0 },
  ChunkStore: {
    TotalChunks: (used + pinned) / 4096,
    SharedSlots: 0,
    ReferenceCount: (used + pinned) / 4096,
  },
});

// Ant v0.5.61's `GET /v0/cache` for `used`/`pinned` bytes under a `cap`.
const v0cache = ({ used = 0, pinned = 0, cap = 2 * GIB }) => ({
  disk_enabled: true,
  used_bytes: used,
  capacity_bytes: cap,
  pinned_bytes: pinned,
  chunks: Math.ceil(used / 4096),
  pinned_chunks: Math.ceil(pinned / 4096),
  file_bytes: used + pinned,
  memory_chunks: 0,
  memory_capacity_chunks: 8192,
});

// A fake antd answering `/debugstore` with `globalThis.__debugstore` (an
// object, or `{ status, raw }` for a non-JSON / error answer), `GET /v0/cache`
// with `__cacheStatus` (a 404 while that is null, as on a node before v0.5.61), `POST
// /v0/cache/clear` and `PUT /v0/cache/capacity` with `globalThis.__clearAnswer`
// / `__capacityAnswer` (`{ status, body }`, recording each write in
// `__writes`), and the real cache service wired to it in place of the app's
// own, behind the same IPC handlers ant-manager registers.
async function wireFakeNode(electronApp, dataDir) {
  await electronApp.evaluate(async ({ ipcMain, webContents }, dir) => {
    const load = process.mainModule.require;
    const http = load('http');
    const antCache = load('./src/main/swarm/ant-cache');
    globalThis.__debugstore = null;
    globalThis.__antStatus = 'running';
    globalThis.__spawnedAt = null;
    globalThis.__debugstoreHits = 0;
    globalThis.__writes = [];
    globalThis.__clearAnswer = null;
    globalThis.__capacityAnswer = null;
    globalThis.__afterClear = null;
    globalThis.__cacheStatus = null;
    const server = http.createServer((req, res) => {
      // `GET /v0/cache`: 404 (a node without it, so the service reads
      // `/debugstore`) unless `__cacheStatus` is set.
      if (req.method === 'GET' && req.url === '/v0/cache') {
        globalThis.__debugstoreHits += 1;
        const live = globalThis.__cacheStatus;
        res.writeHead(live ? 200 : 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(live || { code: 404 }));
        return;
      }
      if (req.method === 'GET' && req.url === '/debugstore') {
        globalThis.__debugstoreHits += 1;
        const answer = globalThis.__debugstore;
        if (answer && answer.raw !== undefined) {
          res.writeHead(answer.status, { 'Content-Type': 'text/plain' });
          res.end(answer.raw);
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(answer));
        return;
      }
      const writes = {
        'POST /v0/cache/clear': '__clearAnswer',
        'PUT /v0/cache/capacity': '__capacityAnswer',
      };
      const key = writes[`${req.method} ${req.url}`];
      if (key) {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          globalThis.__writes.push({
            method: req.method,
            url: req.url,
            body,
            origin: req.headers.origin ?? null,
            contentType: req.headers['content-type'] ?? null,
          });
          const answer = globalThis[key] || { status: 404, body: { code: 404 } };
          // The cache after the write, as the next read sees it: a clear
          // leaves `__afterClear` (a `/v0/cache` body when it has
          // `disk_enabled`, else a `/debugstore` one); a resize sets the
          // live cap.
          if (answer.status === 200 && key === '__clearAnswer' && globalThis.__afterClear) {
            const after = globalThis.__afterClear;
            if ('disk_enabled' in after) globalThis.__cacheStatus = after;
            else globalThis.__debugstore = after;
          }
          if (answer.status === 200 && key === '__capacityAnswer' && globalThis.__cacheStatus) {
            globalThis.__cacheStatus = {
              ...globalThis.__cacheStatus,
              capacity_bytes: JSON.parse(body).bytes,
            };
          }
          res.writeHead(answer.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(answer.body));
        });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"code":404}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    globalThis.__fakeAntServer = server;
    const base = `http://127.0.0.1:${server.address().port}`;
    const svc = antCache.createAntCacheService({
      getNodeStatus: () => ({ status: globalThis.__antStatus, error: null }),
      getApiBase: () => base,
      getSpawnedAt: () => globalThis.__spawnedAt,
      getDataDir: () => dir,
    });
    // ant-manager's handlers, over this node: the view of a node Freedom runs.
    const view = () =>
      antCache.cacheSettingsView({
        stored: load('./src/main/settings-store').loadSettings().antCacheCapacityBytes,
        profileMode: 'managed',
        nodeActive: globalThis.__antStatus === 'running',
      });
    const status = async () => {
      const usage = await svc.getStatus();
      return { ...usage, ...antCache.clearAvailability(usage, view()) };
    };
    const replace = (channel, handler) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
    };
    replace('ant:cache-status', () => status());
    replace('ant:cache-clear', async () => {
      const { canClear, clearReason } = await status();
      if (!canClear) return { ok: false, error: clearReason };
      return svc.clearCache();
    });
    replace('ant:cache-get-settings', () => view());
    replace('ant:cache-set-size', (_e, bytes) =>
      antCache.applyCacheSize(bytes, {
        getView: view,
        save: (size) =>
          load('./src/main/settings-store').saveSettings({ antCacheCapacityBytes: size }),
        isNodeActive: () => globalThis.__antStatus === 'running',
        setLiveCapacity: (size) => svc.setCapacity(size),
      })
    );
    // The node status change the settings page hears about through the
    // publish setup broadcast, as the real service sends it.
    globalThis.__pushNodeStatus = () => {
      const state = load('./src/main/swarm/publish-setup-service')
        .getPublishSetupService()
        .getState();
      const payload = { ...state, node: { ...state.node, status: globalThis.__antStatus } };
      for (const wc of webContents.getAllWebContents()) {
        if (wc.getURL().includes('/pages/settings.html')) wc.send('swarm:setup-state', payload);
      }
    };
  }, dataDir);
}

const setAnswers = (electronApp, answers) =>
  electronApp.evaluate((_e, a) => Object.assign(globalThis, a), answers);

const fakeWrites = (electronApp) => electronApp.evaluate(() => globalThis.__writes);

async function feed(
  electronApp,
  { status = 'running', answer = null, spawnedAt = null, broadcast = false }
) {
  await electronApp.evaluate(
    (_e, s) => {
      globalThis.__antStatus = s.status;
      globalThis.__debugstore = s.answer;
      globalThis.__spawnedAt = s.spawnedAt === 'now' ? Date.now() : s.spawnedAt;
      if (s.broadcast) globalThis.__pushNodeStatus();
    },
    { status, answer, spawnedAt, broadcast }
  );
}

const debugstoreHits = (electronApp) => electronApp.evaluate(() => globalThis.__debugstoreHits);

// No `/debugstore` read lands for a few poll intervals.
async function expectNoReads(electronApp, page) {
  const hits = await debugstoreHits(electronApp);
  await page.waitForTimeout(3_500);
  expect(await debugstoreHits(electronApp)).toBe(hits);
}

const setTheme = (window, theme) =>
  window.evaluate((t) => window.electronAPI.saveSettings({ theme: t }), theme);

async function shoot(target, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await target.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

// -----------------------------------------------------------------------------
// Settings → Nodes → Swarm cache size
// -----------------------------------------------------------------------------

async function openNodesSettings(window, electronApp) {
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill('freedom://settings/nodes');
  await input.press('Enter');
  let page;
  await expect
    .poll(() => {
      page = electronApp.windows().find((p) => p.url().includes('/pages/settings.html'));
      return Boolean(page);
    })
    .toBe(true);
  await expect(page.locator('#swarm-cache-row')).toBeVisible();
  return page;
}

// Replaces the picker's two IPC handlers: `view` is what the main process
// reports, and a set records the size and answers `answer`.
async function stubCacheIpc(electronApp, { view, answer }) {
  await electronApp.evaluate(
    ({ ipcMain }, s) => {
      globalThis.__cacheView = s.view;
      globalThis.__cacheSets = [];
      const replace = (channel, handler) => {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, handler);
      };
      replace('ant:cache-get-settings', () => globalThis.__cacheView);
      replace('ant:cache-set-size', (_e, bytes) => {
        globalThis.__cacheSets.push(bytes);
        globalThis.__cacheView = { ...globalThis.__cacheView, bytes };
        // Saved as the real handler does, so the settings broadcast agrees.
        if (s.answer.ok) {
          process.mainModule
            .require('./src/main/settings-store')
            .saveSettings({ antCacheCapacityBytes: bytes });
        }
        return s.answer;
      });
    },
    { view, answer }
  );
}

const SIZES = [
  [512 * MIB, '512 MB'],
  [GIB, '1 GB'],
  [2 * GIB, '2 GB (default)'],
  [5 * GIB, '5 GB'],
  [10 * GIB, '10 GB'],
  [16 * GIB, '16 GB'],
].map(([bytes, label]) => ({ bytes, label }));

async function shootSettings(window, page, name) {
  if (!SHOTS) return;
  for (const theme of ['dark', 'light']) {
    await setTheme(window, theme);
    await page.evaluate(() => {
      const row = document.getElementById('swarm-cache-row');
      let box = row.parentElement;
      while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) {
        box = box.parentElement;
      }
      const scroller = box || document.scrollingElement;
      scroller.scrollTop += row.getBoundingClientRect().top - 260;
    });
    await page.waitForTimeout(300);
    // The settings page's own viewport: an element shot inside the webview
    // is not scrolled to.
    await shoot(page, `${theme}-settings-${name}`);
  }
}

test.describe('Settings: the Swarm cache usage line', () => {
  test('every state, through the real parser, against a fake antd', async ({
    electronApp,
    window,
  }, testInfo) => {
    // Three no-reads windows of 3.5 s each, and (with SWARM_CACHE_SHOTS_DIR)
    // a theme round trip per state.
    test.setTimeout(SHOTS ? 180_000 : 60_000);
    const dataDir = testInfo.outputPath('ant-data');
    fs.mkdirSync(dataDir, { recursive: true });
    // A cache file from a previous run, big enough not to be an empty cache.
    fs.writeFileSync(path.join(dataDir, 'chunks.sqlite'), Buffer.alloc(2 * MIB));
    await wireFakeNode(electronApp, dataDir);

    // In use, with pinned content: read as soon as the section opens.
    await feed(electronApp, { answer: debugstore({ used: 1.3 * GIB, pinned: 120 * MIB }) });
    const page = await openNodesSettings(window, electronApp);
    const usage = page.locator('#swarm-cache-usage');
    const value = page.locator('#swarm-cache-usage-text');
    const note = page.locator('#swarm-cache-usage-note');
    await expect(value).toHaveText('1.3 GB of 2 GB · 120 MB pinned');
    await expect(usage).toHaveText('In use: 1.3 GB of 2 GB · 120 MB pinned');
    await expect(note).toBeHidden();
    await shootSettings(window, page, 'in-use-pinned');

    // Polled while on screen: the next reading lands without reopening.
    await feed(electronApp, { answer: debugstore({ used: 300 * MIB }) });
    await expect(value).toHaveText('300 MB of 2 GB', { timeout: 6_000 });
    await shootSettings(window, page, 'in-use');

    // The disk cache couldn't be opened.
    await feed(electronApp, { answer: debugstore({ cap: 0 }) });
    await expect(value).toHaveText('Unavailable', { timeout: 6_000 });
    await expect(note).toBeVisible();
    await expect(note).toHaveText(/couldn't open its disk cache/);
    await shootSettings(window, page, 'disk-off');

    // Ant still counting the cache it just opened.
    await feed(electronApp, { answer: debugstore({ used: 0 }), spawnedAt: 'now' });
    await expect(value).toHaveText('Counting… (2 GB max)', { timeout: 6_000 });
    await expect(note).toHaveText(/still counting/);
    await shootSettings(window, page, 'counting');

    // The same all-zero answer from a node spawned long ago is a real empty cache.
    await feed(electronApp, { answer: debugstore({ used: 0 }), spawnedAt: 1 });
    await expect(value).toHaveText('0 B of 2 GB', { timeout: 6_000 });
    await expect(note).toBeHidden();

    // A node without the route, and garbage.
    await feed(electronApp, { answer: { status: 404, raw: '{"code":404}' } });
    await expect(value).toHaveText('Unknown', { timeout: 6_000 });
    await expect(note).toHaveText(/doesn't report its cache/);
    await shootSettings(window, page, 'unreadable');
    await feed(electronApp, { answer: { status: 200, raw: '<html>not json' } });
    await expect(value).toHaveText('Unknown', { timeout: 6_000 });

    // Starting: no figure yet, says so. Followed at once, not on the next poll.
    await feed(electronApp, {
      status: 'starting',
      answer: debugstore({ used: GIB }),
      broadcast: true,
    });
    await expect(value).toHaveText('Starting…', { timeout: 2_000 });
    await expect(note).toHaveText('Shown once the Swarm node is running.');
    await shootSettings(window, page, 'starting');

    // Stopped: says so, and the node is no longer asked.
    await feed(electronApp, {
      status: 'stopped',
      answer: debugstore({ used: GIB }),
      broadcast: true,
    });
    await expect(value).toHaveText('Not running', { timeout: 2_000 });
    await expect(note).toHaveText('Shown while the Swarm node is running.');
    await shootSettings(window, page, 'not-running');
    await expectNoReads(electronApp, page);

    // The node comes back: polling picks up again without touching the page.
    await feed(electronApp, { answer: debugstore({ used: GIB }), broadcast: true });
    await expect(value).toHaveText('1 GB of 2 GB', { timeout: 2_000 });
    await feed(electronApp, { answer: debugstore({ used: 2 * GIB }) });
    await expect(value).toHaveText('2 GB of 2 GB', { timeout: 6_000 });

    // Another section: the row is off screen, so nothing is read.
    await page.evaluate(() => {
      location.hash = 'appearance';
    });
    await expect(page.locator('#swarm-cache-row')).toBeHidden();
    await expectNoReads(electronApp, page);

    // Back on Nodes: read at once, and polled again.
    await feed(electronApp, { answer: debugstore({ used: 512 * MIB }) });
    await page.evaluate(() => {
      location.hash = 'nodes';
    });
    await expect(value).toHaveText('512 MB of 2 GB', { timeout: 2_000 });
    await feed(electronApp, { answer: debugstore({ used: GIB }) });
    await expect(value).toHaveText('1 GB of 2 GB', { timeout: 6_000 });

    // Search results covering the section hide it too.
    const field = page.locator('#settings-search');
    await field.click();
    await field.pressSequentially('theme');
    await expect(page.locator('#settings-search-results')).toBeVisible();
    await expect(page.locator('#swarm-cache-row')).toBeHidden();
    await expectNoReads(electronApp, page);

    await electronApp.evaluate(() => globalThis.__fakeAntServer.close());
  });
});

test.describe('The node window', () => {
  test('has no cache row: the Nodes menu is as it was before #579', async ({ window }) => {
    await window.locator('#bee-menu-button').click();
    await expect(window.locator('#bee-menu-dropdown')).toHaveClass(/\bopen\b/);
    await expect(window.locator('[id^="bee-cache"]')).toHaveCount(0);
    await expect(window.locator('#bee-menu-dropdown')).not.toContainText(/cache/i);
    expect(await window.evaluate(() => typeof window.ant?.cacheStatus)).toBe('undefined');
  });
});

test.describe('Settings: Swarm cache size', () => {
  test('the real picker: six sizes, 2 GB default, saved when the node is off', async ({
    electronApp,
    window,
  }) => {
    const page = await openNodesSettings(window, electronApp);
    const select = page.locator('#swarm-cache-size');
    await expect(select).toBeEnabled();
    await expect(page.locator('label[for="swarm-cache-size"]')).toHaveText('Swarm cache size');
    await expect(select.locator('option')).toHaveText(SIZES.map((s) => s.label));
    await expect(select).toHaveValue(String(2 * GIB));
    await shootSettings(window, page, 'picker');

    // The harness runs no node: nothing restarts, so nothing asks first.
    let asked = false;
    page.on('dialog', (dialog) => {
      asked = true;
      dialog.dismiss();
    });
    await select.selectOption(String(GIB));
    await expect(page.locator('#swarm-cache-status')).toHaveText(
      'Swarm cache set to 1 GB. It applies the next time the Swarm node starts.'
    );
    expect(asked).toBe(false);
    const saved = await window.evaluate(() => window.electronAPI.getSettings());
    expect(saved.antCacheCapacityBytes).toBe(GIB);
    await expect(select).toHaveValue(String(GIB));
  });

  // R1-F1 on #588: a profile whose node already has a cache from an older
  // Freedom, before its first start with this setting. The real handlers.
  test('an upgrader before the first start sees 10 GB and can choose 2 GB', async ({
    electronApp,
    window,
  }) => {
    const cacheFile = await electronApp.evaluate(() => {
      const load = process.mainModule.require;
      const file = load('path').join(
        load('./src/main/profile-paths').getAntDataDir(),
        'chunks.sqlite'
      );
      load('fs').writeFileSync(file, '');
      return file;
    });
    try {
      expect(
        (await window.evaluate(() => window.electronAPI.getSettings())).antCacheCapacityBytes
      ).toBeNull();
      const page = await openNodesSettings(window, electronApp);
      const select = page.locator('#swarm-cache-size');
      await expect(select).toHaveValue(String(10 * GIB));
      await shootSettings(window, page, 'upgrader');
      await select.selectOption(String(2 * GIB));
      await expect(page.locator('#swarm-cache-status')).toHaveText(
        'Swarm cache set to 2 GB (default). It applies the next time the Swarm node starts.'
      );
      const saved = await window.evaluate(() => window.electronAPI.getSettings());
      expect(saved.antCacheCapacityBytes).toBe(2 * GIB);
      await expect(select).toHaveValue(String(2 * GIB));
    } finally {
      fs.rmSync(cacheFile, { force: true });
    }
  });

  // R1-M3 on #588: a second change while the first is still re-reading the
  // view is dropped, not applied as a second, overlapping restart.
  test('a second change during the first one is not applied twice', async ({
    electronApp,
    window,
  }) => {
    await stubCacheIpc(electronApp, {
      view: {
        bytes: 2 * GIB,
        defaultBytes: 2 * GIB,
        sizes: SIZES,
        managed: true,
        reason: '',
        nodeActive: false,
      },
      answer: { ok: true, live: false },
    });
    const page = await openNodesSettings(window, electronApp);
    const select = page.locator('#swarm-cache-size');
    await expect(select).toHaveValue(String(2 * GIB));
    // The re-read on change now takes a while.
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('ant:cache-get-settings');
      ipcMain.handle(
        'ant:cache-get-settings',
        () => new Promise((resolve) => setTimeout(() => resolve(globalThis.__cacheView), 500))
      );
    });
    await page.evaluate(() => {
      const el = document.getElementById('swarm-cache-size');
      el.value = String(5 * 1024 ** 3);
      el.dispatchEvent(new Event('change'));
      el.value = String(10 * 1024 ** 3);
      el.dispatchEvent(new Event('change'));
    });
    await expect(page.locator('#swarm-cache-status')).toHaveText(
      'Swarm cache set to 5 GB. It applies the next time the Swarm node starts.'
    );
    expect(await electronApp.evaluate(() => globalThis.__cacheSets)).toEqual([5 * GIB]);
    await expect(select).toHaveValue(String(5 * GIB));
    await expect(select).toBeEnabled();
  });

  test('settings search finds it by cache, storage and disk space', async ({
    electronApp,
    window,
  }) => {
    const page = await openNodesSettings(window, electronApp);
    const field = page.locator('#settings-search');
    for (const query of ['cache', 'storage', 'disk space']) {
      await field.click();
      await field.fill('');
      await field.pressSequentially(query);
      await expect(page.locator('#settings-search-results')).toBeVisible();
      const hit = page
        .locator('#settings-search-list .settings-search-result')
        .filter({ hasText: 'Swarm cache size' });
      await expect(hit).toHaveCount(1);
      await expect(hit.locator('.settings-search-section')).toHaveText('Nodes');
    }
  });

  test('a node Freedom does not run: disabled, with the reason', async ({
    electronApp,
    window,
  }) => {
    const reason = "Freedom doesn't run this Swarm node. Set its cache size where it runs.";
    await stubCacheIpc(electronApp, {
      view: {
        bytes: 2 * GIB,
        defaultBytes: 2 * GIB,
        sizes: SIZES,
        managed: false,
        reason,
        nodeActive: false,
      },
      answer: { ok: false, error: reason },
    });
    const page = await openNodesSettings(window, electronApp);
    await expect(page.locator('#swarm-cache-size')).toBeDisabled();
    await expect(page.locator('#swarm-cache-status')).toHaveText(reason);
    await expect(page.locator('#swarm-cache-row')).toHaveClass(/\bdisabled\b/);
    await shootSettings(window, page, 'external');
  });
});

// Ant v0.5.61's `POST /v0/cache/clear` answer.
const clearReport = ({ freed, before, after }) => ({
  freed_bytes: freed,
  removed_chunks: freed / 4096,
  file_bytes_before: before,
  file_bytes_after: after,
  memory_chunks_removed: 12,
  status: { disk_enabled: true, used_bytes: 0, capacity_bytes: 2 * GIB, pinned_bytes: 0 },
});

const CONFIRM =
  "Clear the Swarm cache?\n\nSwarm pages you've opened will load from the network again. Pinned and published content is kept.";

test.describe('Settings: Clear Swarm cache', () => {
  async function setUp(electronApp, window, testInfo) {
    const dataDir = testInfo.outputPath('ant-data');
    fs.mkdirSync(dataDir, { recursive: true });
    await wireFakeNode(electronApp, dataDir);
    await feed(electronApp, { answer: debugstore({ used: 1.3 * GIB, pinned: 120 * MIB }) });
    const page = await openNodesSettings(window, electronApp);
    await expect(page.locator('#swarm-cache-usage-text')).toHaveText(
      '1.3 GB of 2 GB · 120 MB pinned'
    );
    return page;
  }

  test('asks first, then clears through the fake antd and says what it freed', async ({
    electronApp,
    window,
  }, testInfo) => {
    test.setTimeout(SHOTS ? 120_000 : 60_000);
    const page = await setUp(electronApp, window, testInfo);
    const button = page.locator('#swarm-cache-clear');
    const result = page.locator('#swarm-cache-clear-status');
    await expect(page.locator('#swarm-cache-clear-row .row-label')).toHaveText('Clear Swarm cache');
    await expect(button).toHaveText('Clear cache');
    await expect(button).toBeEnabled();
    await expect(page.locator('#swarm-cache-clear-reason')).toBeHidden();
    await expect(result).toHaveAttribute('role', 'status');
    await expect(result).toHaveAttribute('aria-live', 'polite');
    await shootSettings(window, page, 'clear-ready');

    await setAnswers(electronApp, {
      __clearAnswer: {
        status: 200,
        body: clearReport({ freed: 1.3 * GIB, before: 1.5 * GIB, after: 130 * MIB }),
      },
      // Read live from `/v0/cache` from here on.
      __cacheStatus: v0cache({ used: 1.3 * GIB, pinned: 120 * MIB }),
      __afterClear: v0cache({ used: 0, pinned: 120 * MIB }),
    });

    // Cancel: nothing is sent.
    const messages = [];
    let accept = false;
    page.on('dialog', (dialog) => {
      messages.push(dialog.message());
      return accept ? dialog.accept() : dialog.dismiss();
    });
    await button.click();
    await expect.poll(() => messages.length).toBe(1);
    expect(messages[0]).toBe(CONFIRM);
    await page.waitForTimeout(300);
    expect(await fakeWrites(electronApp)).toEqual([]);
    await expect(result).toBeEmpty();

    // OK: one POST from the main process, no Origin, and the result.
    accept = true;
    await button.click();
    await expect(result).toHaveText('Freed 1.3 GB.');
    expect(await fakeWrites(electronApp)).toEqual([
      { method: 'POST', url: '/v0/cache/clear', body: '', origin: null, contentType: null },
    ]);
    // The usage line shows the emptied cache at once; pins are still there.
    await expect(page.locator('#swarm-cache-usage-text')).toHaveText(
      '0 B of 2 GB · 120 MB pinned',
      {
        timeout: 2_000,
      }
    );
    await expect(button).toBeEnabled();
    await shootSettings(window, page, 'cleared');
    await electronApp.evaluate(() => globalThis.__fakeAntServer.close());
  });

  test('a failed clear says why and keeps the button', async ({
    electronApp,
    window,
  }, testInfo) => {
    const page = await setUp(electronApp, window, testInfo);
    await setAnswers(electronApp, {
      __clearAnswer: {
        status: 500,
        body: { code: 500, message: 'clear disk cache: database is locked' },
      },
    });
    page.on('dialog', (dialog) => dialog.accept());
    await page.locator('#swarm-cache-clear').click();
    await expect(page.locator('#swarm-cache-clear-status')).toHaveText(
      "The Swarm cache wasn't cleared. The Swarm node couldn't clear its cache (500: clear disk cache: database is locked)."
    );
    await expect(page.locator('#swarm-cache-clear')).toBeEnabled();
    await expect(page.locator('#swarm-cache-usage-text')).toHaveText(
      '1.3 GB of 2 GB · 120 MB pinned'
    );
    expect(await fakeWrites(electronApp)).toHaveLength(1);
    await shootSettings(window, page, 'clear-failed');

    // A node without the route.
    await setAnswers(electronApp, { __clearAnswer: null });
    await page.locator('#swarm-cache-clear').click();
    await expect(page.locator('#swarm-cache-clear-status')).toHaveText(
      "The Swarm cache wasn't cleared. This Swarm node can't clear its cache while it runs."
    );
    await electronApp.evaluate(() => globalThis.__fakeAntServer.close());
  });

  test('off, with the reason, while the node is stopped or has no disk cache', async ({
    electronApp,
    window,
  }, testInfo) => {
    test.setTimeout(SHOTS ? 120_000 : 60_000);
    const page = await setUp(electronApp, window, testInfo);
    const button = page.locator('#swarm-cache-clear');
    const reason = page.locator('#swarm-cache-clear-reason');

    await feed(electronApp, { answer: debugstore({ cap: 0 }) });
    await expect(button).toBeDisabled({ timeout: 6_000 });
    await expect(reason).toHaveText(
      "The node's disk cache isn't available, so there is nothing to clear."
    );
    await shootSettings(window, page, 'clear-disk-off');

    // The broadcast only repaints at once when it changes the node status the
    // page last heard, which in the harness may already be "stopped"; the
    // next poll (every 3 s) picks it up either way.
    await feed(electronApp, { status: 'stopped', answer: debugstore({}), broadcast: true });
    await expect(reason).toHaveText('Available while the Swarm node is running.', {
      timeout: 6_000,
    });
    await expect(button).toBeDisabled();
    await shootSettings(window, page, 'clear-not-running');

    // A click on the disabled button sends nothing.
    await button.click({ force: true });
    await page.waitForTimeout(300);
    expect(await fakeWrites(electronApp)).toEqual([]);

    // Back up: offered again.
    await feed(electronApp, { answer: debugstore({ used: GIB }), broadcast: true });
    await expect(button).toBeEnabled({ timeout: 2_000 });
    await expect(reason).toBeHidden();
    await electronApp.evaluate(() => globalThis.__fakeAntServer.close());
  });
});

test.describe('Settings: Swarm cache size, live', () => {
  test('a running node takes the new size through PUT /v0/cache/capacity, no restart', async ({
    electronApp,
    window,
  }, testInfo) => {
    const dataDir = testInfo.outputPath('ant-data');
    fs.mkdirSync(dataDir, { recursive: true });
    await wireFakeNode(electronApp, dataDir);
    await setAnswers(electronApp, {
      __cacheStatus: v0cache({ used: 300 * MIB }),
      __capacityAnswer: { status: 200, body: { disk_enabled: true, capacity_bytes: 512 * MIB } },
    });
    const page = await openNodesSettings(window, electronApp);
    const select = page.locator('#swarm-cache-size');
    await expect(select).toBeEnabled();

    // Nothing asks first: no restart.
    let asked = false;
    page.on('dialog', (dialog) => {
      asked = true;
      dialog.dismiss();
    });
    await select.selectOption(String(512 * MIB));
    await expect(page.locator('#swarm-cache-status')).toHaveText('Swarm cache set to 512 MB.');
    expect(asked).toBe(false);
    expect(await fakeWrites(electronApp)).toEqual([
      {
        method: 'PUT',
        url: '/v0/cache/capacity',
        body: JSON.stringify({ bytes: 512 * MIB }),
        origin: null,
        contentType: 'application/json',
      },
    ]);
    // Persisted too: Ant doesn't keep a live size across a restart.
    const saved = await window.evaluate(() => window.electronAPI.getSettings());
    expect(saved.antCacheCapacityBytes).toBe(512 * MIB);
    await expect(select).toHaveValue(String(512 * MIB));
    // The usage line shows the new cap at once, read live from `/v0/cache`.
    await expect(page.locator('#swarm-cache-usage-text')).toHaveText('300 MB of 512 MB', {
      timeout: 2_000,
    });
    await shootSettings(window, page, 'live-size');

    // Ant refuses (no disk cache): saved for the next start, and why.
    await setAnswers(electronApp, {
      __capacityAnswer: {
        status: 503,
        body: { code: 503, message: 'disk chunk cache is not available' },
      },
    });
    await select.selectOption(String(GIB));
    await expect(page.locator('#swarm-cache-status')).toHaveText(
      "Swarm cache set to 1 GB. It applies the next time the Swarm node starts: The node's disk cache isn't available."
    );
    expect(
      (await window.evaluate(() => window.electronAPI.getSettings())).antCacheCapacityBytes
    ).toBe(GIB);
    await electronApp.evaluate(() => globalThis.__fakeAntServer.close());
  });
});
