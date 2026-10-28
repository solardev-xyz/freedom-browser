const http = require('http');
const { test, expect } = require('./fixtures');
const { configureOllamaAgent } = require('./agent-provider-fixture');

// An absent choice must remain off even when the rest of the harness opts in.
test.use({ aiEnabled: null });
let server;
let baseUrl;
let requests = 0;

test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    requests += 1;
    if (request.url === '/api/tags') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ models: [{ name: 'freedom-onboarding-fixture' }] }));
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
});
test.afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
});

async function guest(app, name) {
  let page;
  await expect.poll(() => {
    page = app.windows().find(page => page.url().includes(`/pages/${name}.html`));
    return Boolean(page);
  }).toBe(true);
  return page;
}

async function settings(app, window) {
  await window.locator('#address-input').fill('freedom://settings/ai');
  await window.locator('#address-input').press('Enter');
  const page = await guest(app, 'settings');
  await page.waitForLoadState('load');
  await expect(page.locator('#enable-ai')).toBeVisible();
  return page;
}

// Turning AI on with no model stays on the AI page and offers the next step
// (#836) rather than navigating to the provider picker.
async function enableAiAndStay(page) {
  await page.locator('#enable-ai').check();
  await expect(page.locator('#ai-connect-model')).toBeVisible();
  await expect(page).toHaveURL(/#ai$/);
}

test('fresh profile discovers AI, explicitly enables it, connects in Settings and preserves its draft across disable', async ({ electronApp, window }, testInfo) => {
  const home = await guest(electronApp, 'home');
  await expect(window.locator('#agent-toggle-btn')).toBeHidden();
  await expect(home.locator('#ai-invitation')).toBeVisible();
  for (const theme of ['dark', 'light']) {
    await window.evaluate(theme => window.electronAPI.saveSettings({ theme }), theme);
    await expect(home.locator('html')).toHaveAttribute('data-theme', theme);
    await home.screenshot({ animations: 'disabled', path: testInfo.outputPath(`home-ai-${theme}.png`) });
  }
  const before = requests;
  const blocked = await window.evaluate(() => window.electronAPI.getAgentProviderCatalog());
  expect(blocked).toMatchObject({ ok: false, error: { code: 'AGENT_DISABLED' } });
  expect(requests).toBe(before);
  await home.locator('#ai-invitation-open').click();
  const page = await guest(electronApp, 'settings');
  await expect(page.locator('#enable-ai')).not.toBeChecked();
  await expect(page.locator('#ai-provider-settings')).toBeHidden();
  // A fresh profile has nothing saved, so it is not told its saved chats,
  // connections and projects are kept, and with AI off there is no restart
  // to talk about yet (#854).
  await expect.poll(() => page.evaluate(() => window.freedomAPI.getAgentSetupState())).toEqual({ ok: true, configured: false, kept: false });
  // The note ships hidden, so "hidden" holds before Settings has applied
  // anything; give the page's own setup read time to land first.
  await window.waitForTimeout(500);
  await expect(page.locator('#ai-disabled-note')).toBeHidden();
  await expect(page.locator('#ai').getByText(/AI is off/)).toBeHidden();
  await expect(page.locator('#enable-ai-restart-help')).toBeHidden();
  for (const theme of ['dark', 'light']) {
    await window.evaluate(theme => window.electronAPI.saveSettings({ theme }), theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`ai-off-${theme}.png`) });
  }
  // Page tools (WebMCP) are decided at launch: once AI is turned on the row
  // says so and offers the restart, together (#803, #854).
  await expect(page.locator('#enable-ai-restart-help')).toHaveText('Page tools that websites offer Agent take effect after restart.');
  await expect(page.locator('#enable-ai-restart')).toBeHidden();
  await page.locator('#enable-ai').check();
  await expect(page.locator('#enable-ai-restart-help')).toBeVisible();
  await expect(window.locator('#agent-toggle-btn')).toBeVisible();
  // With no model yet, turning AI on stays on the AI page and offers
  // "Connect a model" instead of navigating under the user's hand (#836).
  await expect(page.locator('#ai-connect-model')).toBeVisible();
  await expect(page.locator('#ai-open-agent')).toBeHidden();
  await expect(page.locator('#ai-next-help')).toHaveText('Choose a provider account or a local model for Agent to use.');
  await window.waitForTimeout(500);
  await expect(page).toHaveURL(/#ai$/);
  await expect(page.locator('#enable-ai-restart')).toBeVisible();
  for (const theme of ['dark', 'light']) {
    await window.evaluate(theme => window.electronAPI.saveSettings({ theme }), theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`ai-on-no-model-${theme}.png`) });
  }
  // The offered step leads to the provider picker.
  await page.locator('#ai-connect-model').click();
  await expect(page).toHaveURL(/#ai\/providers\/add$/);
  await expect(page.locator('#agent-provider-choices')).toBeVisible();
  await page.locator('#ai-provider-breadcrumbs').getByRole('link', { name: 'AI', exact: true }).click();
  await expect(page).toHaveURL(/#ai$/);
  await expect(page.locator('#enable-ai-restart')).toBeVisible();
  // The button and the toggle share one centre line, not the text baseline
  // that left the text-less toggle sitting higher (#834).
  const middles = await page.evaluate(() =>
    ['#enable-ai-restart', '#ai .toggle:has(#enable-ai)'].map(sel => {
      const r = document.querySelector(sel).getBoundingClientRect();
      return r.top + r.height / 2;
    }),
  );
  expect(Math.abs(middles[0] - middles[1])).toBeLessThanOrEqual(0.5);
  // ...with the row's 16px gap between them, not the 8px that left the
  // button almost touching the switch and inside its focus ring (#862).
  const gap = await page.evaluate(() =>
    document.querySelector('#ai .toggle:has(#enable-ai)').getBoundingClientRect().left -
    document.querySelector('#enable-ai-restart').getBoundingClientRect().right,
  );
  expect(gap).toBeGreaterThanOrEqual(16);
  // No model yet: the row says what it is for.
  await expect(page.locator('#ai-providers-summary')).toHaveText('Connect accounts and manage local models');
  // The button follows this launch, not the click: reopened, Settings still
  // offers the restart this launch needs.
  await page.evaluate(() => {
    window.__beforeReload = true;
    location.reload();
  });
  await expect.poll(() => page.evaluate(() => !window.__beforeReload && document.readyState === 'complete').catch(() => false)).toBe(true);
  await expect(page.locator('#enable-ai')).toBeChecked();
  await expect(page.locator('#enable-ai-restart')).toBeVisible();
  await page.getByRole('link', { name: /Models & providers.*Connect accounts/ }).click();
  await expect(page.locator('#agent-provider-add')).toBeVisible();
  await page.locator('#agent-provider-add').click();
  await page.locator('#agent-provider-choices').getByRole('button', { name: 'Ollama', exact: true }).click();
  await page.locator('#agent-provider-advanced > summary').click();
  await page.locator('#agent-ollama-url').fill(baseUrl);
  await page.locator('#agent-provider-save').click();
  await expect(page.locator('#agent-provider-status')).toHaveText('Connected');
  // The first model connected opens Agent on the start page, not over the
  // Settings form, which stays open in its own tab (#864).
  await expect(window.locator('#agent-prompt')).toBeVisible();
  const activeUrl = () => window.evaluate(() => document.querySelector('webview:not(.hidden)')?.getURL() || '');
  await expect.poll(activeUrl).toContain('/pages/home.html');
  for (const theme of ['dark', 'light']) {
    await window.evaluate(theme => window.electronAPI.saveSettings({ theme }), theme);
    await expect(home.locator('html')).toHaveAttribute('data-theme', theme);
    await window.screenshot({ animations: 'disabled', path: testInfo.outputPath(`first-connect-agent-${theme}.png`) });
  }
  await window.locator('#agent-sidebar-close').click();
  await window.locator('.tab', { hasText: 'Settings' }).click();
  await expect.poll(activeUrl).toContain('/pages/settings.html');
  await page.locator('#ai-provider-breadcrumbs').getByRole('link', { name: 'AI', exact: true }).click();
  await expect(page.locator('#ai-open-agent')).toBeVisible();
  await expect(page.locator('#ai-connect-model')).toBeHidden();
  // The Models & providers row names the connected model (#862).
  await expect(page.locator('#ai-providers-summary')).toHaveText('Ollama · freedom-onboarding-fixture');
  for (const theme of ['dark', 'light']) {
    await window.evaluate(theme => window.electronAPI.saveSettings({ theme }), theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`ai-connected-${theme}.png`) });
  }
  await page.locator('#ai-open-agent').click();
  await expect(window.locator('#agent-prompt')).toBeVisible();
  await window.locator('#agent-prompt').fill('Keep this draft while I change settings');
  // Closing the floating surface does not discard a draft.
  await window.locator('#agent-sidebar-close').click();
  await page.locator('#enable-ai').uncheck();
  await expect(window.locator('#agent-toggle-btn')).toBeHidden();
  await expect(window.locator('#agent-sidebar')).toBeHidden();
  await expect(page.locator('#enable-ai-restart')).toBeHidden();
  await expect(page.locator('#enable-ai-restart-help')).toBeHidden();
  // One "AI is off" message (#835): the note, announced through its live
  // wrapper; the status line, which said it again, is left empty. A model is
  // connected now, so there is something kept to tell about (#854).
  await expect(page.locator('#enable-ai')).toBeEnabled();
  await expect(page.locator('#ai-disabled-note')).toBeVisible();
  // It sits a card's note distance below the switch card, not 4px (#854).
  const noteGap = await page.evaluate(() =>
    document.getElementById('ai-disabled-note').getBoundingClientRect().top -
      document.querySelector('#ai > .card').getBoundingClientRect().bottom,
  );
  expect(noteGap).toBeGreaterThanOrEqual(16);
  for (const theme of ['dark', 'light']) {
    await window.evaluate(theme => window.electronAPI.saveSettings({ theme }), theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`ai-off-kept-${theme}.png`) });
  }
  await expect(page.locator('#ai-disabled-note').locator('xpath=..')).toHaveAttribute('aria-live', 'polite');
  await expect(page.locator('#ai-settings-status')).toBeEmpty();
  await expect(page.locator('#ai').getByText(/AI is off/)).toHaveCount(1);
  expect(await window.locator('#agent-prompt').inputValue()).toContain('Keep this draft');
  const status = await window.evaluate(() => window.electronAPI.getAgentProviderStatus());
  expect(status.status.configured).toBe(true);
  await page.locator('#enable-ai').check();
  await expect(page.locator('#ai-open-agent')).toBeVisible();
  await page.locator('#ai-open-agent').click();
  await expect(window.locator('#agent-prompt')).toHaveValue('Keep this draft while I change settings');
});

test('invitation dismissal persists across a real restart without enabling AI', async ({ electronApp, window, relaunchApp }) => {
  const home = await guest(electronApp, 'home');
  await expect(home.locator('#ai-invitation')).toBeVisible();
  await home.locator('#ai-invitation-dismiss').click();
  await expect(home.locator('#ai-invitation')).toBeHidden();
  await expect(home.locator('#home-intro')).toBeFocused();
  expect(await window.evaluate(() => window.electronAPI.getSettings())).toMatchObject({ enableAi: false, aiInvitationDismissed: 'enable' });
  await electronApp.close();
  const restarted = await relaunchApp();
  const restartedHome = await guest(restarted, 'home');
  await expect(restartedHome.locator('#ai-invitation')).toBeHidden();
  const chrome = await restarted.firstWindow();
  await expect(chrome.locator('#agent-toggle-btn')).toBeHidden();
});

// #881: a dismissal hides only the step it was made on. Reaching a later step
// shows the banner again, and Settings → AI offers to show a dismissed step's
// banner again only while that dismissal is what hides it.
test('dismissing one setup step leaves the later ones, and Settings can show the banner again', async ({ electronApp, window }) => {
  test.setTimeout(60_000);
  const stored = async () => (await window.evaluate(() => window.electronAPI.getSettings())).aiInvitationDismissed;
  const home = await guest(electronApp, 'home');
  const heading = home.locator('#ai-invitation-heading');
  await expect(heading).toHaveText('Meet Freedom Agent');
  await home.locator('#ai-invitation-dismiss').click();
  await expect(home.locator('#ai-invitation')).toBeHidden();
  expect(await stored()).toBe('enable');

  // AI on without a model: the dismissed introduction does not hide this step.
  await window.evaluate(() => window.electronAPI.saveSettings({ enableAi: true }));
  await expect(home.locator('#ai-invitation')).toBeVisible();
  await expect(heading).toHaveText('Finish setting up Freedom Agent');
  await home.locator('#ai-invitation-dismiss').click();
  await expect(home.locator('#ai-invitation')).toBeHidden();
  expect(await stored()).toBe('connect');

  // A connected model, then AI off: "Agent is off" shows despite both earlier
  // dismissals.
  const configured = await window.evaluate(baseUrl => window.electronAPI.configureOllamaAgentProvider(undefined, baseUrl), baseUrl);
  expect(configured?.ok).toBe(true);
  await window.evaluate(() => window.electronAPI.saveSettings({ enableAi: false }));
  await expect(home.locator('#ai-invitation')).toBeVisible();
  await expect(heading).toHaveText('Freedom Agent is off');
  await home.locator('#ai-invitation-dismiss').click();
  await expect(home.locator('#ai-invitation')).toBeHidden();
  expect(await stored()).toBe('resume');

  const page = await settings(electronApp, window);
  const reset = page.locator('#ai-invitation-reset');
  await expect(reset).toBeVisible();
  await expect(reset).toHaveText('Show the Freedom Agent banner on the start page again');
  // AI on with the model connected: the start page has nothing to show, so
  // Settings offers nothing to bring back; AI off again hides "resume" again.
  await page.locator('#enable-ai').check();
  await expect(reset).toBeHidden();
  await page.locator('#enable-ai').uncheck();
  await expect(reset).toBeVisible();
  await reset.click();
  await expect(reset).toBeHidden();
  await expect(page.locator('#enable-ai')).toBeFocused();
  expect(await stored()).toBe(false);

  await window.locator('#address-input').fill('freedom://home');
  await window.locator('#address-input').press('Enter');
  const back = await guest(electronApp, 'home');
  await expect(back.locator('#ai-invitation')).toBeVisible();
  await expect(back.locator('#ai-invitation-heading')).toHaveText('Freedom Agent is off');
});

// #777: the AI switch is the consent step, so the start page cannot flip it
// itself, and the experimental WebMCP API is only exposed to pages for a
// launch with AI on (a process-wide switch, so enabling AI applies to it from
// the next start).
test('with AI off pages get no WebMCP, the start page cannot enable AI, and Settings does from the next launch', async ({ electronApp, window, relaunchApp }) => {
  test.setTimeout(60_000);
  const url = 'https://webmcp-gate.test/';
  const fixture = { body: '<!doctype html><title>WebMCP gate</title><p>Fixture</p>' };
  const modelContext = async (app) => {
    // A relaunched app can answer evaluate() before main has installed the harness.
    await expect.poll(() => app.evaluate(() => Boolean(globalThis.__FREEDOM_TEST_HARNESS__))).toBe(true);
    await app.evaluate((_e, { url, fixture }) => globalThis.__FREEDOM_TEST_HARNESS__.setContentFixture(url, fixture), { url, fixture });
    let chrome;
    await expect.poll(() => {
      chrome = app.windows().find(page => page.url().endsWith('/renderer/index.html'));
      return Boolean(chrome);
    }).toBe(true);
    await chrome.locator('#address-input').fill(url);
    await chrome.locator('#address-input').press('Enter');
    let page;
    await expect.poll(() => {
      page = app.windows().find(page => page.url() === url);
      return Boolean(page);
    }).toBe(true);
    await page.waitForLoadState('load');
    return page.evaluate(() => [isSecureContext, typeof document.modelContext]);
  };

  const home = await guest(electronApp, 'home');
  expect(await home.evaluate(() => window.freedomAPI.saveSettings({ enableAi: true }))).toBe(false);
  expect(await window.evaluate(() => window.electronAPI.getSettings())).toMatchObject({ enableAi: false });
  await expect(window.locator('#agent-toggle-btn')).toBeHidden();
  expect(await home.evaluate(() => window.freedomAPI.saveSettings({ aiInvitationDismissed: 'enable' }))).toBe(true);
  expect(await modelContext(electronApp)).toEqual([true, 'undefined']);

  const page = await settings(electronApp, window);
  await page.locator('#enable-ai').check();
  await expect(window.locator('#agent-toggle-btn')).toBeVisible();
  expect(await modelContext(electronApp)).toEqual([true, 'undefined']);

  await electronApp.close();
  const restarted = await relaunchApp();
  // Let the relaunched chrome finish bootstrapping (its first tab is the start
  // page) before typing into it. On the macOS runner the window shows its
  // address bar well before the first tab exists, and an Enter pressed in
  // that window never returned (CI run 39865561125); the sibling restart test
  // above waits the same way.
  await guest(restarted, 'home');
  expect(await modelContext(restarted)).toEqual([true, 'object']);
  // This launch has page tools, so Settings offers no restart, not even after
  // turning AI off and on again (#803).
  const restartedChrome = restarted.windows().find(page => page.url().endsWith('/renderer/index.html'));
  const restartedSettings = await settings(restarted, restartedChrome);
  await expect(restartedSettings.locator('#enable-ai')).toBeChecked();
  await expect(restartedSettings.locator('#enable-ai-restart-help')).toBeHidden();
  await expect(restartedSettings.locator('#enable-ai-restart')).toBeHidden();
  await restartedSettings.locator('#enable-ai').uncheck();
  await expect(restartedChrome.locator('#agent-toggle-btn')).toBeHidden();
  await restartedSettings.locator('#enable-ai').check();
  await expect(restartedChrome.locator('#agent-toggle-btn')).toBeVisible();
  await expect(restartedSettings.locator('#enable-ai-restart')).toBeHidden();
});

test('the start-page banner follows setup and fits both themes at narrow widths', async ({ electronApp, window }, testInfo) => {
  test.setTimeout(60_000);
  const home = await guest(electronApp, 'home');
  const open = home.locator('#ai-invitation-open');
  await expect(home.locator('#ai-invitation-heading')).toHaveText('Meet Freedom Agent');
  await expect(open).toHaveText('Set up');
  await expect(open).toHaveAttribute('href', 'freedom://settings/ai');
  expect(await window.evaluate(() => window.electronAPI.getSettings())).toMatchObject({ enableAi: false });
  await window.evaluate(() => window.electronAPI.saveSettings({ enableAi: true }));
  await expect(home.locator('#ai-invitation-heading')).toHaveText('Finish setting up Freedom Agent');
  await expect(open).toHaveText('Connect a model');
  await expect(open).toHaveAttribute('href', 'freedom://settings/ai/providers/add');
  await expect(window.locator('#agent-toggle-btn')).toBeVisible();
  // #861: the pill reads "Beta" as rendered, like Settings' .resolver-badge.
  expect(await home.locator('.setup-banner-tag').evaluate(el => el.innerText)).toBe('Beta');
  for (const theme of ['dark', 'light']) {
    await window.evaluate(theme => window.electronAPI.saveSettings({ theme }), theme);
    await expect(home.locator('html')).toHaveAttribute('data-theme', theme);
    for (const width of [1280, 760, 390, 320]) {
      await electronApp.evaluate(({ BrowserWindow }, width) => {
        const win = BrowserWindow.getAllWindows().find(win => !win.isDestroyed());
        win.setMinimumSize(320, 300);
        win.setContentSize(width, 900);
      }, width);
      await expect.poll(() => home.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await home.locator('#ai-invitation').evaluate(el => {
        const action = el.querySelector('#ai-invitation-open').getBoundingClientRect();
        const dismiss = el.querySelector('#ai-invitation-dismiss').getBoundingClientRect();
        return action.right <= dismiss.left && dismiss.right <= el.getBoundingClientRect().right;
      })).toBe(true);
      await home.evaluate(() => scrollTo(0, 0));
      await home.screenshot({ animations: 'disabled',
        path: testInfo.outputPath(`setup-banner-${theme}-${width}.png`) });
    }
  }
  // A connected model finishes setup: the banner goes away on its own.
  const configured = await window.evaluate(baseUrl => window.electronAPI.configureOllamaAgentProvider(undefined, baseUrl), baseUrl);
  expect(configured?.ok).toBe(true);
  await expect(home.locator('#ai-invitation')).toBeHidden();
  // A model still connected with AI turned off: say it is off, not "Meet".
  await window.evaluate(() => window.electronAPI.saveSettings({ enableAi: false }));
  await expect(home.locator('#ai-invitation-heading')).toHaveText('Freedom Agent is off');
  await expect(open).toHaveText('Turn on');
  await expect(open).toHaveAttribute('href', 'freedom://settings/ai');
});

// Only a first model connected on this Settings page opens Agent: not one
// connected elsewhere (another window, the API), and not a reconnect after
// removing the only one.
test('Settings opens Agent only for the first model connected on that page', async ({ electronApp, window }) => {
  test.setTimeout(60_000);
  const page = await settings(electronApp, window);
  await enableAiAndStay(page);
  await expect(page.locator('#ai-settings-status')).toHaveText('');
  await expect(page.locator('#ai-open-agent')).toBeHidden();
  const configured = await window.evaluate(baseUrl => window.electronAPI.configureOllamaAgentProvider(undefined, baseUrl), baseUrl);
  expect(configured?.ok).toBe(true);
  await expect(page.locator('#ai-open-agent')).toBeVisible();
  await expect(page.locator('#ai-connect-model')).toBeHidden();
  // A model connected elsewhere is named here too.
  await expect(page.locator('#ai-providers-summary')).toHaveText('Ollama · freedom-onboarding-fixture');
  await window.waitForTimeout(1000);
  await expect(window.locator('#agent-sidebar')).toBeHidden();
  const removed = await window.evaluate(() => window.electronAPI.removeAgentProvider('ollama'));
  expect(removed?.ok).toBe(true);
  await expect(page.locator('#ai-open-agent')).toBeHidden();
  await expect(page.locator('#ai-connect-model')).toBeVisible();
  // Removing the model takes its name off the row again (#862).
  await expect(page.locator('#ai-providers-summary')).toHaveText('Connect accounts and manage local models');
  await page.getByRole('link', { name: /Models & providers.*Connect accounts/ }).click();
  await page.locator('#agent-provider-add').click();
  await page.locator('#agent-provider-choices').getByRole('button', { name: 'Ollama', exact: true }).click();
  await page.locator('#agent-provider-advanced > summary').click();
  await page.locator('#agent-ollama-url').fill(baseUrl);
  await page.locator('#agent-provider-save').click();
  await expect(page.locator('#agent-provider-status')).toHaveText('Connected');
  await window.waitForTimeout(1000);
  await expect(window.locator('#agent-sidebar')).toBeHidden();
});

// A failed status load offers no "Connect a model": not from the status the
// page replays when AI is turned off and on again, and not left standing once
// the load fails. The AI page itself says the load failed.
test('a failed model status load shows its error on the AI page and no Connect button', async ({ electronApp, window }, testInfo) => {
  const page = await settings(electronApp, window);
  await enableAiAndStay(page);
  await page.locator('#enable-ai').uncheck();
  await expect(page.locator('#ai-next-step')).toBeHidden();
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('agent:provider:get-status');
    ipcMain.handle('agent:provider:get-status', () => ({ ok: false, error: { code: 'TEST_FAILURE', message: 'Status unavailable' } }));
  });
  // Record whether Connect is ever on screen, from before the switch until
  // the load has failed: a stale offer that comes and goes counts too.
  await page.evaluate(() => {
    window.__connectSeen = false;
    const button = document.getElementById('ai-connect-model');
    const sample = () => {
      if (button.getClientRects().length) window.__connectSeen = true;
      window.__connectProbe = requestAnimationFrame(sample);
    };
    sample();
    new MutationObserver(() => {
      if (button.getClientRects().length) window.__connectSeen = true;
    }).observe(document.getElementById('ai'), { attributes: true, subtree: true, childList: true });
  });
  await page.locator('#enable-ai').check();
  await expect(page.locator('#ai-settings-status')).toHaveText('Could not load the agent model. Open AI settings again to retry.');
  await expect(page.locator('#ai-next-step')).toBeHidden();
  expect(await page.evaluate(() => window.__connectSeen)).toBe(false);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('ai-status-failed.png') });
  // A status-only failure on a fresh visit, with the catalogue loading fine.
  await page.evaluate(() => {
    window.__beforeReload = true;
    location.reload();
  });
  await expect.poll(() => page.evaluate(() => !window.__beforeReload && document.readyState === 'complete').catch(() => false)).toBe(true);
  await expect(page.locator('#enable-ai')).toBeChecked();
  await expect(page.locator('#ai-settings-status')).toHaveText('Could not load the agent model. Open AI settings again to retry.');
  await expect(page.locator('#ai-connect-model')).toBeHidden();
});

// A status that lands after AI was turned off (a refresh still in flight) is
// not the status the next enable has loaded: re-enabling must not replay it as
// a "Connect a model" offer before its own refresh settles.
test('a model status landing after AI is turned off is not replayed as Connect on the next enable', async ({ electronApp, window }) => {
  test.setTimeout(60_000);
  const page = await settings(electronApp, window);
  await enableAiAndStay(page);
  await page.locator('#enable-ai').uncheck();
  await electronApp.evaluate(({ ipcMain }) => {
    globalThis.__statusCalls = 0;
    globalThis.__statusAnswered = false;
    let release;
    globalThis.__releaseStatus = () => release();
    const gate = new Promise(resolve => { release = resolve; });
    ipcMain.removeHandler('agent:provider:get-status');
    ipcMain.handle('agent:provider:get-status', async () => {
      globalThis.__statusCalls += 1;
      await gate;
      globalThis.__statusAnswered = true;
      return { ok: true, status: { configured: false, connections: [] } };
    });
  });
  // Enable, then turn AI off while that enable's status load is in flight.
  await page.locator('#enable-ai').check();
  await expect.poll(() => electronApp.evaluate(() => globalThis.__statusCalls)).toBeGreaterThan(0);
  await page.locator('#enable-ai').uncheck();
  await expect(page.locator('#enable-ai')).toBeEnabled();
  await electronApp.evaluate(() => globalThis.__releaseStatus());
  await expect.poll(() => electronApp.evaluate(() => globalThis.__statusAnswered)).toBe(true);
  // Let the late reply reach the page and run onStatusChange.
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)));
  // The next enable's own load is slow and then fails.
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('agent:provider:get-status');
    ipcMain.handle('agent:provider:get-status', async () => {
      await new Promise(resolve => setTimeout(resolve, 1500));
      return { ok: false, error: { code: 'TEST_FAILURE', message: 'Status unavailable' } };
    });
  });
  await page.evaluate(() => {
    window.__connectSeen = false;
    const button = document.getElementById('ai-connect-model');
    const sample = () => {
      if (button.getClientRects().length) window.__connectSeen = true;
      window.__connectProbe = requestAnimationFrame(sample);
    };
    sample();
    new MutationObserver(() => {
      if (button.getClientRects().length) window.__connectSeen = true;
    }).observe(document.getElementById('ai'), { attributes: true, subtree: true, childList: true });
  });
  await page.locator('#enable-ai').check();
  await expect(page.locator('#ai-settings-status')).toHaveText('Could not load the agent model. Open AI settings again to retry.');
  await expect(page.locator('#ai-next-step')).toBeHidden();
  expect(await page.evaluate(() => window.__connectSeen)).toBe(false);
});

// The Models & providers row names a hosted model by its catalogue name, not
// its raw id (#862), and only from the status this enable loaded: re-enabling
// AI replays the status from before the disable, which must not be named
// until the new enable's own load lands.
test('the Models & providers row names a hosted model by catalogue name, from this enable\'s status only', async ({ electronApp, window }) => {
  test.setTimeout(60_000);
  const page = await settings(electronApp, window);
  await enableAiAndStay(page);
  const catalog = await window.evaluate(() => window.electronAPI.getAgentProviderCatalog());
  expect(catalog?.ok).toBe(true);
  // A hosted model whose display name differs from its id, so the row shows
  // which one it used.
  const pick = catalog.catalog
    .filter(provider => provider.authType === 'api_key')
    .flatMap(provider => (provider.models || []).map(model => ({ providerId: provider.providerId, model })))
    .find(({ model }) => model.name && model.name !== model.id);
  expect(pick).toBeTruthy();
  const hosted = {
    configured: true, kind: 'hosted', providerId: pick.providerId, modelId: pick.model.id,
    connections: [{ kind: 'hosted', providerId: pick.providerId, modelId: pick.model.id }],
  };
  const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const named = new RegExp(` · ${escape(pick.model.name)}$`);
  await electronApp.evaluate(({ ipcMain }, status) => {
    ipcMain.removeHandler('agent:provider:get-status');
    ipcMain.handle('agent:provider:get-status', () => ({ ok: true, status }));
  }, hosted);
  await page.locator('#enable-ai').uncheck();
  await page.locator('#enable-ai').check();
  await expect(page.locator('#ai-open-agent')).toBeVisible();
  await expect(page.locator('#ai-providers-summary')).toHaveText(named);
  await expect(page.locator('#ai-providers-summary')).not.toContainText(` · ${pick.model.id}`);
  // Off, then on again with this enable's status load held: the row must not
  // name the model from before the disable while it waits.
  await page.locator('#enable-ai').uncheck();
  await expect(page.locator('#enable-ai')).toBeEnabled();
  await electronApp.evaluate(({ ipcMain }, status) => {
    globalThis.__statusCalls = 0;
    let release;
    globalThis.__releaseStatus = () => release();
    const gate = new Promise(resolve => { release = resolve; });
    ipcMain.removeHandler('agent:provider:get-status');
    ipcMain.handle('agent:provider:get-status', async () => {
      globalThis.__statusCalls += 1;
      await gate;
      return { ok: true, status };
    });
  }, hosted);
  await page.evaluate(() => {
    window.__namedSeen = false;
    const summary = document.getElementById('ai-providers-summary');
    window.__namedObserver = new MutationObserver(() => {
      if (summary.textContent.includes(' · ')) window.__namedSeen = true;
    });
    window.__namedObserver.observe(summary, { characterData: true, childList: true, subtree: true });
  });
  await page.locator('#enable-ai').check();
  await expect.poll(() => electronApp.evaluate(() => globalThis.__statusCalls)).toBeGreaterThan(0);
  await expect(page.locator('#ai-providers-summary')).toHaveText('Connect accounts and manage local models');
  expect(await page.evaluate(() => {
    window.__namedObserver.disconnect();
    return window.__namedSeen || document.getElementById('ai-providers-summary').textContent.includes(' · ');
  })).toBe(false);
  // Once this enable's own load lands, the row names the model again.
  await electronApp.evaluate(() => globalThis.__releaseStatus());
  await expect(page.locator('#ai-providers-summary')).toHaveText(named);
});

test('AI Settings is discoverable through navigation and search at narrow width', async ({ electronApp, window }, testInfo) => {
  const page = await settings(electronApp, window);
  await expect(page.locator('.nav-item[data-target="ai"]')).toBeVisible();
  await page.locator('#settings-search').click();
  await page.locator('#settings-search').pressSequentially('Enable AI');
  await expect(page.locator('#settings-search-results')).toContainText('Enable AI features');
  await page.locator('#settings-search').fill('');
  await page.locator('#settings-search').dispatchEvent('input');
  await electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(win => !win.isDestroyed());
    win.setMinimumSize(320, 300);
    win.setContentSize(600, 700);
  });
  await expect(page.locator('#enable-ai')).toBeVisible();
  const bounds = await page.locator('#enable-ai').evaluate(el => {
    const r = el.getBoundingClientRect();
    return r.right <= innerWidth && r.left >= 0;
  });
  expect(bounds).toBe(true);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('ai-narrow.png') });
});


test('AI subpages have breadcrumbs, history and deep links without mixing their content', async ({ electronApp, window }, testInfo) => {
  let page = await settings(electronApp, window);
  await enableAiAndStay(page);
  await expect(page.locator('#ai-settings-links')).toBeVisible();
  await expect(page.locator('#agent-provider-add')).toBeHidden();
  await expect(page.locator('#voice')).toBeHidden();
  await page.getByRole('link', { name: /Models & providers.*Connect accounts/ }).click();
  await expect(page).toHaveURL(/#ai\/providers$/);
  await expect(page.locator('#enable-ai')).toBeHidden();
  await page.locator('#agent-provider-add').click();
  await expect(page).toHaveURL(/#ai\/providers\/add$/);
  await page.locator('#agent-provider-choices').getByRole('button', { name: 'Ollama', exact: true }).click();
  await expect(page).toHaveURL(/#ai\/providers\/ollama$/);
  await expect(page.locator('#ai-provider-breadcrumbs')).toHaveText('AI›Models & providers›Ollama');
  await expect(page.locator('#agent-provider-choices')).toBeHidden();
  await page.locator('#agent-provider-advanced > summary').click();
  await page.locator('#agent-ollama-url').fill(baseUrl);
  // Theme/settings broadcasts must not clear an edited connection form.
  for (const theme of ['dark', 'light']) {
    await window.evaluate(theme => window.electronAPI.saveSettings({ theme }), theme);
    await expect(page.locator('#agent-ollama-url')).toHaveValue(baseUrl);
    await expect(page.locator('#agent-provider-message')).not.toContainText('Loading providers');
    await page.screenshot({ path: testInfo.outputPath(`ai-provider-detail-${theme}.png`) });
  }
  await page.goBack();
  await expect(page).toHaveURL(/#ai\/providers\/add$/);
  await expect(page.locator('#agent-provider-search')).toBeVisible();
  // #897: the provider search is the same control as "Search settings…":
  // focused, it shows only the accent border (no extra AI-page ring), and
  // it does not spellcheck provider names.
  const focusLook = selector => page.evaluate(async sel => {
    const input = document.querySelector(sel);
    input.focus();
    // Let the 0.1s border-color transition finish before reading it.
    await new Promise(resolve => setTimeout(resolve, 300));
    const style = getComputedStyle(input);
    const look = {
      focusVisible: input.matches(':focus-visible'),
      outlineStyle: style.outlineStyle,
      borderColor: style.borderColor,
      fontSize: style.fontSize,
      spellcheck: input.spellcheck,
    };
    input.blur();
    return look;
  }, selector);
  const providerLook = await focusLook('#agent-provider-search');
  expect(providerLook.focusVisible).toBe(true);
  expect(providerLook.outlineStyle).toBe('none');
  expect(providerLook).toEqual(await focusLook('#settings-search'));
  await page.goForward();
  await expect(page.locator('#agent-ollama-url')).toHaveValue('http://127.0.0.1:11434/v1');
  await page.locator('#ai-provider-breadcrumbs').getByRole('link', { name: 'AI', exact: true }).click();
  await page.getByRole('link', { name: /Voice dictation.*Choose where/ }).click();
  await expect(page).toHaveURL(/#ai\/voice$/);
  await expect(page.locator('#providers')).toBeHidden();
  await expect(page.locator('#enable-ai')).toBeHidden();
  await page.evaluate(() => { window.settingsBeforeReload = true; });
  await window.locator('#reload-btn').click();
  await expect.poll(async () => {
    page = await guest(electronApp, 'settings');
    try { return await page.evaluate(() => !window.settingsBeforeReload); }
    catch { return false; }
  }).toBe(true);
  await expect(page.locator('#ai-dictation-settings')).toBeVisible();
  for (const theme of ['dark', 'light']) {
    await window.evaluate(theme => window.electronAPI.saveSettings({ theme }), theme);
    await page.screenshot({ path: testInfo.outputPath(`ai-voice-page-${theme}.png`) });
  }
  await page.evaluate(() => { location.hash = 'ai/providers/not-a-provider'; });
  await expect(page).toHaveURL(/#ai\/providers$/);
  await expect(page.locator('#agent-provider-add')).toBeVisible();
  await page.evaluate(() => { location.hash = 'ai/voice'; });
  await window.evaluate(() => window.electronAPI.saveSettings({ enableAi: false }));
  await expect(page).toHaveURL(/#ai$/);
  await expect(page.locator('#enable-ai')).not.toBeChecked();
  await expect(page.locator('#voice')).toBeHidden();
});

// #782: with AI off nothing of Agent is left behind — no shortcut rows, no
// search results that land on a disabled page, no greyed-out menu item —
// and the stored AI shortcut remaps come back with AI.
test('AI off hides the Agent shortcuts, search results and View menu item until AI is on', async ({ electronApp, window }) => {
  const page = await settings(electronApp, window);
  const viewMenuShowAgent = () => electronApp.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById('toggle-agent');
    return item ? { visible: item.visible, accelerator: item.accelerator ?? null } : null;
  });
  expect(await viewMenuShowAgent()).toEqual({ visible: false, accelerator: null });
  await page.evaluate(() => { location.hash = 'shortcuts'; });
  await expect(page.locator('[data-shortcut-id="tab.new"]')).toBeVisible();
  await expect(page.locator('[data-shortcut-id="view.toggleAgent"]')).toHaveCount(0);
  await expect(page.locator('[data-shortcut-id="agent.startDictation"]')).toHaveCount(0);
  // Ctrl+K is free while Show Agent does not exist.
  const preview = await page.evaluate(() => window.freedomAPI.previewShortcutBinding({
    id: 'tab.new', event: { key: 'k', code: 'KeyK', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false },
  }));
  expect(preview).toMatchObject({ ok: true, conflict: null });

  const search = async (query) => {
    await page.locator('#settings-search').click();
    await page.locator('#settings-search').fill('');
    await page.locator('#settings-search').pressSequentially(query);
    await expect(page.locator('#settings-search-summary')).toContainText(query);
    return page.locator('#settings-search-results .settings-search-result').allInnerTexts();
  };
  for (const query of ['dictation', 'language', 'audio privacy', 'models']) {
    expect((await search(query)).filter((text) => /Voice dictation|Models & providers|Start dictation/.test(text))).toEqual([]);
  }
  expect((await search('enable ai')).join(' ')).toContain('Enable AI features');

  await window.evaluate(() => window.electronAPI.saveSettings({ enableAi: true }));
  await expect.poll(viewMenuShowAgent).toEqual({ visible: true, accelerator: 'CmdOrCtrl+K' });
  expect((await search('language')).join(' ')).toContain('AI › Voice dictation');
  expect((await search('dictation')).join(' ')).toContain('Start dictation');
  await page.locator('#settings-search').fill('');
  await page.locator('#settings-search').dispatchEvent('input');
  await page.evaluate(() => { location.hash = 'shortcuts'; });
  await expect(page.locator('[data-shortcut-id="view.toggleAgent"]')).toBeVisible();
  await expect(page.locator('[data-shortcut-id="agent.startDictation"]')).toBeVisible();
});

// #782: the AI pages look like the rest of Settings.
test('AI settings pages share Settings\' selects, intros, headings and destructive confirmation', async ({ electronApp, window }) => {
  const page = await settings(electronApp, window);
  await enableAiAndStay(page);
  await expect(page.locator('#ai-settings-links')).toBeVisible();
  const style = (selector, props) => page.locator(selector).first().evaluate((el, props) => {
    const cs = getComputedStyle(el);
    return Object.fromEntries(props.map((prop) => [prop, cs.getPropertyValue(prop)]));
  }, props);
  // Intro: the 12 px muted line every other section opens with.
  const introProps = ['font-size', 'color', 'margin-bottom'];
  expect(await style('#ai > .section-description', introProps)).toEqual(
    await style('#shortcuts > p.row-help', introProps)
  );

  // A deep link focuses the heading for screen readers, without a ring.
  await page.evaluate(() => { location.hash = 'ai/voice'; });
  await expect(page.locator('#ai-dictation-settings select')).toBeVisible();
  await expect(page.locator('#ai-voice-page-title')).toBeFocused();
  expect((await style('#ai-voice-page-title', ['outline-style']))['outline-style']).toBe('none');
  // The language select is the page-wide select: chevron, size, radius.
  const selectProps = ['background-image', 'font-size', 'border-radius', 'padding-right'];
  const themeSelect = await style('#theme-mode', selectProps);
  expect(themeSelect['background-image']).toContain('svg');
  expect(await style('#ai-dictation-settings select', selectProps)).toEqual(themeSelect);

  // While OpenAI's page asks how to connect it is "OpenAI", not one of the two ways.
  await page.evaluate(() => { location.hash = 'ai/providers/openai'; });
  await expect(page.locator('#agent-provider-methods')).toBeVisible();
  await expect(page.locator('#ai-provider-page-title')).toHaveText('OpenAI');
  await expect(page.locator('#ai-provider-breadcrumbs')).toHaveText('AI›Models & providers›OpenAI');
  await page.locator('#agent-provider-api').click();
  await expect(page.locator('#agent-api-key')).toBeVisible();
  await expect(page.locator('#ai-provider-page-title')).toHaveText('OpenAI · API');

  // Disconnect deletes a connection: red, and confirmed in the page.
  const connected = await window.evaluate(
    (baseUrl) => window.electronAPI.configureOllamaAgentProvider(undefined, baseUrl), baseUrl);
  expect(connected?.ok).toBe(true);
  await page.evaluate(() => { location.hash = 'ai/providers/ollama'; });
  await expect(page.locator('#agent-provider-status')).toHaveText('Connected');
  const disconnect = page.locator('#agent-provider-disconnect');
  await expect(disconnect).toBeVisible();
  const danger = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--danger)';
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  expect((await style('#agent-provider-disconnect', ['color']))['color']).toBe(danger);
  const dialogs = [];
  page.on('dialog', (dialog) => { dialogs.push(dialog.message()); void dialog.dismiss(); });
  await disconnect.click();
  await expect(page.locator('#agent-provider-disconnect-confirm')).toBeVisible();
  await expect(page.locator('#agent-provider-disconnect-question')).toHaveText('Disconnect Ollama from Agent?');
  await expect(page.locator('#agent-provider-disconnect-cancel')).toBeFocused();
  expect((await style('#agent-provider-disconnect-accept', ['color']))['color']).toBe(danger);
  await page.keyboard.press('Escape');
  await expect(page.locator('#agent-provider-disconnect-confirm')).toBeHidden();
  await expect(disconnect).toBeFocused();
  await expect(page.locator('#agent-provider-status')).toHaveText('Connected');
  await disconnect.click();
  await page.locator('#agent-provider-disconnect-accept').click();
  await expect.poll(async () =>
    (await window.evaluate(() => window.electronAPI.getAgentProviderStatus())).status.configured).toBe(false);
  expect(dialogs).toEqual([]);
});

// #782/#863: a sheet hanging from the floating panel's header — Set up Agent
// and Services share the same one-card rules — measured against it.
const ONE_CARD = {
  left: 0,
  right: 0,
  gap: 0,
  seam: ['0px', '0px', '0px', '0px', '0px', '0px'],
  outerCorners: ['16px', '16px'],
  slack: true,
  opaque: true,
  headerOpaque: true,
  headerShadow: ['inset'],
};
const headerShadow = (window) => window.evaluate(() =>
  getComputedStyle(document.querySelector('#agent-sidebar .agent-sidebar-header')).boxShadow);
function sheetUnderHeader(window, id) {
  return window.evaluate((id) => {
    const sheet = document.getElementById(id);
    const header = document.querySelector('#agent-sidebar .agent-sidebar-header');
    const s = sheet.getBoundingClientRect();
    const h = header.getBoundingClientRect();
    const content = [...sheet.children].filter((el) => el.getClientRects().length)
      .reduce((bottom, el) => Math.max(bottom, el.getBoundingClientRect().bottom), 0);
    const opaque = (el) => {
      const alpha = getComputedStyle(el).backgroundColor.match(/rgba?\(([^)]+)\)/)[1].split(',')[3];
      return alpha === undefined || Number(alpha) === 1;
    };
    const hs = getComputedStyle(header);
    const ss = getComputedStyle(sheet);
    return {
      left: Math.round(s.left - h.left),
      right: Math.round(s.right - h.right),
      gap: Math.round(s.top - h.bottom),
      seam: [hs.borderBottomWidth, hs.borderBottomLeftRadius, hs.borderBottomRightRadius,
        ss.borderTopWidth, ss.borderTopLeftRadius, ss.borderTopRightRadius],
      outerCorners: [hs.borderTopLeftRadius, ss.borderBottomRightRadius],
      slack: s.bottom - content <= 32,
      opaque: opaque(sheet),
      // The header it hangs from too: light theme's glass let the page show through (#803).
      headerOpaque: opaque(header),
      // Open, the header keeps only its inset highlight: the card's drop
      // shadow sits on the sheet, not across the seam (#863).
      headerShadow: hs.boxShadow.split(/,(?![^(]*\))/)
        .map((shadow) => (/\binset\b/.test(shadow) ? 'inset' : 'drop')),
    };
  }, id);
}

// #782: Set up Agent is a sheet under its header — same edges, as tall as
// what it holds, and nothing of the page reads through it. #863: the two are
// one card (no gap, square inner corners, no seam), and the copy names no
// provider brand.
test('Set up Agent sheet lines up with its header and both are opaque at narrow and wide widths', async ({ electronApp, window }, testInfo) => {
  await window.evaluate(() => window.electronAPI.saveSettings({ enableAi: true }));
  await expect(window.locator('#agent-toggle-btn')).toBeVisible();
  for (const theme of ['dark', 'light']) {
    await window.evaluate((theme) => window.electronAPI.saveSettings({ theme }), theme);
    for (const width of [600, 1440]) {
      await electronApp.evaluate(({ BrowserWindow }, width) => {
        const win = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed());
        win.setMinimumSize(320, 300);
        win.setContentSize(width, 800);
      }, width);
      if ((await window.locator('#agent-toggle-btn').getAttribute('aria-expanded')) !== 'true')
        await window.locator('#agent-toggle-btn').click();
      await expect(window.locator('#agent-setup-view')).toBeVisible();
      await expect.poll(() => sheetUnderHeader(window, 'agent-setup-view')).toEqual(ONE_CARD);
      await expect(window.locator('#agent-setup-view .agent-setup-intro')).toHaveText(
        'Agent works with the AI model you choose: a subscription you already have, an API key, or a model running on this computer.'
      );
      await window.screenshot({ path: testInfo.outputPath(`setup-sheet-${theme}-${width}.png`) });
      await window.locator('#agent-sidebar-close').click();
      // Closing dissolves the header's inset highlight with its glass instead
      // of leaving a bright line behind while the panel fades out.
      await expect.poll(() => headerShadow(window)).toBe('none');
    }
  }
});

// The Services sheet (#agent-mcp-panel) shares Set up Agent's one-card rules
// (agent-floating.css's :is([data-agent-view='setup'], [data-agent-view='services'])),
// so it gets the same geometry and close-highlight checks.
test('Services sheet is one card with its header and its highlight dissolves on close', async ({ electronApp, window }, testInfo) => {
  await window.evaluate(() => window.electronAPI.saveSettings({ enableAi: true }));
  await expect(window.locator('#agent-toggle-btn')).toBeVisible();
  await configureOllamaAgent(window, baseUrl);
  for (const theme of ['dark', 'light']) {
    await window.evaluate((theme) => window.electronAPI.saveSettings({ theme }), theme);
    for (const width of [600, 1440]) {
      await electronApp.evaluate(({ BrowserWindow }, width) => {
        const win = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed());
        win.setMinimumSize(320, 300);
        win.setContentSize(width, 800);
      }, width);
      if ((await window.locator('#agent-toggle-btn').getAttribute('aria-expanded')) !== 'true')
        await window.locator('#agent-toggle-btn').click();
      if (await window.locator('#agent-workspace-view').isVisible()) {
        await window.locator('#agent-attachment-button').click();
        await window.locator('#agent-mcp-open').click();
      }
      await expect(window.locator('#agent-mcp-panel')).toBeVisible();
      await expect(window.locator('#agent-sidebar')).toHaveAttribute('data-presentation', 'column');
      await expect(window.locator('#agent-sidebar')).toHaveAttribute('data-agent-view', 'services');
      await expect.poll(() => sheetUnderHeader(window, 'agent-mcp-panel')).toEqual(ONE_CARD);
      await window.screenshot({ path: testInfo.outputPath(`services-sheet-${theme}-${width}.png`) });
      await window.locator('#agent-sidebar-close').click();
      await expect.poll(() => headerShadow(window)).toBe('none');
    }
  }
});
