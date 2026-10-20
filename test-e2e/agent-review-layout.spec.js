const { test, expect } = require('./fixtures');
const path = require('path');
const root = path.resolve(__dirname, '..');

async function openConversation(electronApp, window) {
  await electronApp.evaluate((_electron, root) => {
    const require = process.getBuiltinModule('module').createRequire(`${root}/package.json`);
    const { AgentProviderResolver } = require(root + '/src/main/agent/provider-resolver');
    AgentProviderResolver.prototype.getStatus = () => ({ configured: true, providerId: 'openai', modelId: 'fixture',
      connections: [{ kind: 'hosted', providerId: 'openai', modelId: 'fixture', favoriteModelIds: ['fixture'] }] });
    AgentProviderResolver.prototype.getCatalog = async () => [{ providerId: 'openai', name: 'OpenAI', models: [{ id: 'fixture', name: 'A long fixture model name' }] }];
  }, root);
  await window.reload();
  await window.locator('#agent-toggle-btn').click();
  await expect(window.locator('#agent-workspace-view')).toBeVisible();
  await electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(win => !win.isDestroyed());
    const emit = event => win.webContents.send('agent:event', { runId: 'layout-fixture', ...event });
    emit({ type: 'run_started', userText: 'Review this page' });
    emit({ type: 'assistant_text_delta', text: 'A short answer.' });
    emit({ type: 'run_finished', status: 'completed', durationMs: 1000, actionCount: 0 });
  });
  await expect(window.locator('#agent-sidebar')).toHaveAttribute('data-presentation', 'column');
}

async function resize(electronApp, width, height = 800) {
  await electronApp.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows().find(win => !win.isDestroyed());
    win.setMinimumSize(320, 300);
    win.setContentSize(size.width, size.height);
  }, { width, height });
}

async function hit(window, selector) {
  return window.locator(selector).evaluate(element => {
    const r = element.getBoundingClientRect();
    const target = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= innerWidth &&
      r.top >= 0 && r.bottom <= innerHeight && (target === element || element.contains(target));
  });
}

test('floating conversation leaves the page interactive and shares narrow corners with Find/downloads', async ({ electronApp, window }, testInfo) => {
  await openConversation(electronApp, window);
  for (const theme of ['dark', 'light']) {
    await window.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await resize(electronApp, 1000);
    await expect.poll(() => window.evaluate(() => {
      const body = document.querySelector('.agent-workspace-body').getBoundingClientRect();
      const composer = document.querySelector('.agent-composer-wrap').getBoundingClientRect();
      const target = document.elementFromPoint(composer.x + 30, (body.bottom + composer.top) / 2);
      return body.bottom < composer.top - 20 && !target?.closest('#agent-sidebar');
    })).toBe(true);
    await window.locator('#agent-prompt').focus();
    await expect(window.locator('.agent-composer')).toHaveCSS('outline-style', 'solid');
    await resize(electronApp, 500);
    await window.evaluate(async theme => {
      const { handleDownloadUpdate } = await import('./lib/downloads-ui.js');
      handleDownloadUpdate({ id: theme === 'dark' ? 8001 : 8002, state: 'progressing', filename: 'A long downloaded document.pdf', received_bytes: 50, total_bytes: 100 });
      document.getElementById('find-bar').hidden = false;
    }, theme);
    await expect.poll(() => hit(window, '#agent-run')).toBe(true);
    await expect.poll(() => hit(window, '#find-bar-input')).toBe(true);
    await expect.poll(() => hit(window, '[data-test="download-cancel"]')).toBe(true);
    await window.screenshot({ path: testInfo.outputPath(`floating-${theme}.png`) });
    await window.evaluate(() => { document.getElementById('find-bar').hidden = true; });
    await window.locator('[data-test="download-close"]').click();
  }
});

test('Agent-first compact overlays, address menus and fullscreen restore work in both themes', async ({ electronApp, window }, testInfo) => {
  await openConversation(electronApp, window);
  await resize(electronApp, 600);
  await window.locator('#agent-first-toggle').click();
  for (const theme of ['dark', 'light']) {
    await window.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await expect.poll(() => hit(window, '#agent-session-sidebar-toggle')).toBe(true);
    await expect.poll(() => hit(window, '#agent-workspace-sidebar-toggle')).toBe(true);
    await window.locator('#agent-session-sidebar-toggle').click();
    await expect(window.locator('body')).not.toHaveClass(/agent-session-sidebar-closed/);
    await window.locator('#agent-workspace-sidebar-toggle').click();
    await expect(window.locator('body')).toHaveClass(/agent-session-sidebar-closed/);
    await expect(window.locator('body')).not.toHaveClass(/agent-workspace-sidebar-closed/);
    await expect(window.locator('#agent-page-surface')).toHaveCSS('transform', 'none');
    await expect(window.locator('#agent-task-pages')).toBeVisible();
    await expect.poll(() => hit(window, '#address-input')).toBe(true);
    await expect.poll(() => window.evaluate(() => {
      const r = document.querySelector('#agent-page-surface').getBoundingClientRect();
      return !!document.elementFromPoint(r.right - 30, r.bottom - 30)?.closest('#agent-page-surface');
    })).toBe(true);
    await window.locator('#address-input').fill('swarm');
    // Autocomplete suggestions live above their own menu backdrop.
    await expect(window.locator('#autocomplete-dropdown')).toBeVisible();
    await expect.poll(() => hit(window, '#autocomplete-dropdown')).toBe(true);
    await window.keyboard.press('Escape');
    await window.screenshot({ path: testInfo.outputPath(`agent-first-${theme}.png`) });
    await window.evaluate(() => document.body.classList.add('browser-fullscreen'));
    await expect(window.locator('#agent-sidebar')).toBeHidden();
    const pageWidth = await window.locator('#agent-page-surface').evaluate(el => el.getBoundingClientRect().width);
    expect(pageWidth).toBe(await window.evaluate(() => innerWidth));
    await window.evaluate(() => document.body.classList.remove('browser-fullscreen'));
    await expect(window.locator('#agent-sidebar')).toBeVisible();
    await window.locator('#agent-workspace-sidebar-toggle').click();
  }
});

test('narrow chrome keeps the address field and native controls within the window', async ({ electronApp, window }) => {
  for (const width of [380, 500]) {
    await resize(electronApp, width);
    const bounds = await window.evaluate(() => {
      const r = id => document.getElementById(id).getBoundingClientRect().toJSON();
      return { input: r('address-input'), nodes: r('bee-menu-button'), star: r('add-bookmark-btn') };
    });
    expect(bounds.input.width).toBeGreaterThanOrEqual(90);
    expect(bounds.star.right).toBeLessThanOrEqual(bounds.nodes.left);
  }
});

test('re-hosted page permission controls remain reachable at narrow widths', async ({ electronApp, window, harness }, testInfo) => {
  const page = 'bzz://' + 'd'.repeat(64) + '/';
  await harness.setContentFixture(page, { body: '<!doctype html><title>Permission fixture</title><button id="ask" onclick="Notification.requestPermission()">Ask</button>' });
  await openConversation(electronApp, window);
  await window.locator('#agent-first-toggle').click();
  const input = window.locator('#address-input');
  await input.fill(page);
  await input.press('Enter');
  await expect.poll(() => window.evaluate(async () => {
    try { return await document.querySelector('webview:not(.hidden)').executeJavaScript('document.title'); }
    catch { return ''; }
  })).toBe('Permission fixture');
  await resize(electronApp, 600, 600);
  await window.locator('#agent-workspace-sidebar-toggle').click();
  await window.evaluate(async () => {
    await document.querySelector('webview:not(.hidden)').executeJavaScript('document.getElementById("ask").click(); true');
  });
  await expect(window.locator('#permission-prompt')).toBeVisible();
  for (const width of [600, 380]) {
    await resize(electronApp, width, 600);
    await expect.poll(() => hit(window, '#permission-prompt-allow')).toBe(true);
    await window.screenshot({ path: testInfo.outputPath(`permission-${width}.png`) });
  }
  await window.locator('#permission-prompt-block').click();
  await expect(window.locator('#permission-prompt')).toBeHidden();
});

test('downloads remain usable with the wallet open and an empty Agent-first page pane', async ({ electronApp, window }) => {
  await resize(electronApp, 500);
  await window.locator('#wallet-toggle-btn').click();
  await window.evaluate(async () => {
    const { handleDownloadUpdate } = await import('./lib/downloads-ui.js');
    handleDownloadUpdate({ id: 9001, state: 'progressing', filename: 'Download.txt', received_bytes: 50, total_bytes: 100 });
  });
  await expect.poll(() => hit(window, '[data-test="download-cancel"]')).toBe(true);
  await expect(window.locator('.download-card')).toHaveCSS('width', '320px');
  await openConversation(electronApp, window);
  await window.locator('#agent-first-toggle').click();
  await window.evaluate(async () => {
    const { handleDownloadUpdate } = await import('./lib/downloads-ui.js');
    handleDownloadUpdate({ id: 9002, state: 'progressing', filename: 'Download.txt', received_bytes: 50, total_bytes: 100 });
    document.body.classList.add('agent-workspace-page-empty');
  });
  await expect.poll(() => hit(window, '[data-test="download-cancel"]')).toBe(true);
  await window.locator('[data-test="download-close"]').click();
});

test('fullscreen conceals and restores Agent without stopping its run', async ({ electronApp, window }) => {
  await openConversation(electronApp, window);
  const fullscreen = enabled => electronApp.evaluate(({ Menu, BrowserWindow }, enabled) => {
    const win = BrowserWindow.getAllWindows().find(win => !win.isDestroyed());
    if (win.isFullScreen() !== enabled) Menu.getApplicationMenu().getMenuItemById('fullscreen').click();
  }, enabled);
  for (const agentFirst of [false, true]) {
    if (agentFirst) {
      await resize(electronApp, 600);
      await window.locator('#agent-first-toggle').click();
      await window.locator('#agent-workspace-sidebar-toggle').click();
    }
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find(win => !win.isDestroyed()).webContents.send('agent:event', {
        runId: 'active-layout-fixture', type: 'run_started', userText: 'Keep working',
      });
    });
    await expect(window.locator('#agent-run-status')).toContainText('Running');
    await fullscreen(true);
    await expect(window.locator('body')).toHaveClass(/browser-fullscreen/);
    await expect(window.locator('#agent-sidebar')).toBeHidden();
    await expect.poll(() => window.locator('#agent-page-surface').evaluate(el => {
      const r = el.getBoundingClientRect();
      return r.width === innerWidth && r.height === innerHeight;
    })).toBe(true);
    await fullscreen(false);
    await expect(window.locator('body')).not.toHaveClass(/browser-fullscreen/);
    await expect(window.locator('#agent-run-status')).toContainText('Running');
    if (agentFirst) await expect(window.locator('body')).not.toHaveClass(/agent-workspace-sidebar-closed/);
  }
});

test('ordinary tab menus exclude Claim and long Agent-first content scrolls within its column', async ({ electronApp, window }, testInfo) => {
  await window.locator('.tab').first().click({ button: 'right' });
  await expect(window.locator('#tab-context-menu')).toBeVisible();
  await expect(window.locator('#tab-context-menu [data-action="claim-agent-tab"]')).toBeHidden();
  await expect(window.locator('#tab-context-menu [data-action="mute"]')).toBeVisible();
  await window.keyboard.press('Escape');
  await openConversation(electronApp, window);
  await window.locator('#agent-first-toggle').click();
  await electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(win => !win.isDestroyed());
    const emit = event => win.webContents.send('agent:event', { runId: 'long-layout-fixture', ...event });
    emit({ type: 'run_started', userText: 'Explain this long table' });
    emit({ type: 'assistant_text_delta', text: Array(70).fill('A readable paragraph that grows with the conversation.').join('\n\n') + '\n\n| Unbroken header | Another header |\n| --- | --- |\n| Example | More text |\n\n```js\n' + 'x'.repeat(1000) + '\n```' });
    emit({ type: 'run_finished', status: 'completed', durationMs: 1000, actionCount: 0 });
  });
  await expect(window.locator('.agent-output th').first()).toHaveCSS('white-space', 'nowrap');
  const geometry = await window.evaluate(() => {
    const scroller = document.querySelector('.agent-workspace-scroll');
    const bubble = document.querySelector('.agent-output:last-child');
    const code = document.querySelector('.agent-output pre');
    return { viewport: scroller.clientWidth, content: scroller.scrollWidth,
      bubbleHeight: bubble.clientHeight, bubbleContent: bubble.scrollHeight,
      codeWidth: code.clientWidth, codeContent: code.scrollWidth };
  });
  expect(geometry.content).toBe(geometry.viewport);
  expect(geometry.bubbleContent).toBe(geometry.bubbleHeight);
  expect(geometry.codeContent).toBeGreaterThan(geometry.codeWidth);
  await window.locator('.agent-workspace-scroll').hover();
  await window.mouse.wheel(0, -20000);
  await expect.poll(() => window.locator('.agent-workspace-scroll').evaluate(el => el.scrollTop)).toBe(0);
  for (const theme of ['dark', 'light']) {
    await window.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await window.screenshot({ path: testInfo.outputPath(`long-content-${theme}.png`) });
  }
});

test('before-paint platform styling leaves Linux window controls and Agent pane toggles reachable', async ({ electronApp, window }) => {
  await openConversation(electronApp, window);
  await window.locator('#agent-first-toggle').click();
  await window.evaluate(() => {
    document.documentElement.dataset.platform = 'linux';
    document.getElementById('window-controls').classList.add('visible');
  });
  for (const width of [600, 1100, 1440]) {
    await resize(electronApp, width);
    await expect.poll(() => hit(window, '#close-btn')).toBe(true);
    await expect.poll(() => hit(window, '#agent-session-sidebar-toggle')).toBe(true);
    await expect.poll(() => hit(window, '#agent-workspace-sidebar-toggle')).toBe(true);
    await expect(window.locator('.agent-first-titlebar-left')).toHaveCSS('padding-left', '12px');
  }
});
