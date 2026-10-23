const http = require('http');
const { test, expect } = require('./fixtures');

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
  for (const theme of ['dark', 'light']) {
    await window.evaluate(theme => window.electronAPI.saveSettings({ theme }), theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`ai-off-${theme}.png`) });
  }
  // Page tools (WebMCP) are decided at launch: the row says so and offers
  // the restart once AI is turned on (#803).
  await expect(page.locator('#enable-ai-restart-help')).toHaveText('Page tools that websites offer Agent take effect after restart.');
  await expect(page.locator('#enable-ai-restart')).toBeHidden();
  await page.locator('#enable-ai').check();
  await expect(window.locator('#agent-toggle-btn')).toBeVisible();
  await expect(page.locator('#enable-ai-restart')).toBeVisible();
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
  await page.locator('#ai-provider-breadcrumbs').getByRole('link', { name: 'AI', exact: true }).click();
  await expect(page.locator('#ai-open-agent')).toBeVisible();
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
  await expect(home.locator('#whats-new')).toBeHidden();
  expect(await window.evaluate(() => window.electronAPI.getSettings())).toMatchObject({ enableAi: false, aiInvitationDismissed: true });
  await electronApp.close();
  const restarted = await relaunchApp();
  const restartedHome = await guest(restarted, 'home');
  await expect(restartedHome.locator('#ai-invitation')).toBeHidden();
  await expect(restartedHome.locator('#whats-new')).toBeHidden();
  const chrome = await restarted.firstWindow();
  await expect(chrome.locator('#agent-toggle-btn')).toBeHidden();
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
  expect(await home.evaluate(() => window.freedomAPI.saveSettings({ aiInvitationDismissed: true }))).toBe(true);
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
  await expect(restartedSettings.locator('#enable-ai-restart-help')).toBeVisible();
  await expect(restartedSettings.locator('#enable-ai-restart')).toBeHidden();
  await restartedSettings.locator('#enable-ai').uncheck();
  await expect(restartedChrome.locator('#agent-toggle-btn')).toBeHidden();
  await restartedSettings.locator('#enable-ai').check();
  await expect(restartedChrome.locator('#agent-toggle-btn')).toBeVisible();
  await expect(restartedSettings.locator('#enable-ai-restart')).toBeHidden();
});

test('What’s new remains discoverable with AI enabled and fits both themes at narrow widths', async ({ electronApp, window }, testInfo) => {
  test.setTimeout(60_000);
  const home = await guest(electronApp, 'home');
  await expect(home.locator('#whats-new')).toBeVisible();
  await expect(home.locator('#ai-invitation-state')).toHaveText('Off');
  expect(await window.evaluate(() => window.electronAPI.getSettings())).toMatchObject({ enableAi: false });
  await window.evaluate(() => window.electronAPI.saveSettings({ enableAi: true }));
  await expect(home.locator('#ai-invitation')).toBeVisible();
  await expect(home.locator('#ai-invitation-state')).toHaveText('On');
  await expect(window.locator('#agent-toggle-btn')).toBeVisible();
  await expect(home.locator('.whats-new-row')).toHaveCount(1);
  await home.locator('#ai-invitation-open').click();
  await expect(window.locator('#agent-sidebar')).toBeVisible();
  await expect(home).toHaveURL(/\/pages\/home.html$/);
  await window.locator('#agent-sidebar-close').click();
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
        const state = el.querySelector('#ai-invitation-state').getBoundingClientRect();
        const chevron = el.querySelector('.whats-new-chevron').getBoundingClientRect();
        const dismiss = el.querySelector('#ai-invitation-dismiss').getBoundingClientRect();
        return state.right <= chevron.left && chevron.right <= dismiss.left && dismiss.right <= innerWidth;
      })).toBe(true);
      await home.evaluate(() => scrollTo(0, 0));
      await home.screenshot({ animations: 'disabled',
        path: testInfo.outputPath(`whats-new-${theme}-${width}.png`) });
      await home.locator('#ai-invitation').scrollIntoViewIfNeeded();
      await expect.poll(() => home.locator('#ai-invitation').evaluate(el =>
        el.getBoundingClientRect().bottom <= innerHeight + 1)).toBe(true);
      await home.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await home.screenshot({ animations: 'disabled',
        path: testInfo.outputPath(`whats-new-${theme}-${width}-bottom.png`) });
    }
  }
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
  await page.locator('#enable-ai').check();
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
  await page.locator('#enable-ai').check();
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

// #782: Set up Agent is a sheet under its header — same edges, as tall as
// what it holds, and nothing of the page reads through it.
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
      await expect.poll(() => window.evaluate(() => {
        const sheet = document.getElementById('agent-setup-view');
        const header = document.querySelector('#agent-sidebar .agent-sidebar-header');
        const s = sheet.getBoundingClientRect();
        const h = header.getBoundingClientRect();
        const content = [...sheet.children].filter((el) => el.getClientRects().length)
          .reduce((bottom, el) => Math.max(bottom, el.getBoundingClientRect().bottom), 0);
        const opaque = (el) => {
          const alpha = getComputedStyle(el).backgroundColor.match(/rgba?\(([^)]+)\)/)[1].split(',')[3];
          return alpha === undefined || Number(alpha) === 1;
        };
        return {
          left: Math.round(s.left - h.left),
          right: Math.round(s.right - h.right),
          slack: s.bottom - content <= 32,
          opaque: opaque(sheet),
          // The header it hangs from too: light theme's glass let the page show through (#803).
          headerOpaque: opaque(header),
        };
      })).toEqual({ left: 0, right: 0, slack: true, opaque: true, headerOpaque: true });
      await window.screenshot({ path: testInfo.outputPath(`setup-sheet-${theme}-${width}.png`) });
      await window.locator('#agent-sidebar-close').click();
    }
  }
});
