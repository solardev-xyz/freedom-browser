const { test, expect } = require('./fixtures');
const { _electron: electron } = require('@playwright/test');
const { closeApp } = require('./close-app');
const path = require('path');
const fs = require('fs');
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
  // setContentSize returns before the renderer lays out the new size, and the
  // compact Agent layout reacts to the resize event. Wait until the page sees
  // the window's actual width (macOS may clamp it to the screen) and a frame
  // has passed, so pane state read next reflects the new layout.
  await expect.poll(() => electronApp.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(win => !win.isDestroyed());
    const seen = await win.webContents.executeJavaScript(
      'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(innerWidth))))'
    );
    return seen === win.getContentBounds().width;
  })).toBe(true);
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
    await expect(window.locator('.agent-floating-ghost')).toHaveCount(0);
    await window.screenshot({ animations: 'disabled', path: testInfo.outputPath(`floating-${theme}.png`) });
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
    await window.screenshot({ animations: 'disabled', path: testInfo.outputPath(`agent-first-${theme}.png`) });
    await window.evaluate(() => document.body.classList.add('browser-fullscreen'));
    await expect(window.locator('#agent-sidebar')).toBeHidden();
    const pageWidth = await window.locator('#agent-page-surface').evaluate(el => el.getBoundingClientRect().width);
    expect(pageWidth).toBe(await window.evaluate(() => innerWidth));
    await window.evaluate(() => document.body.classList.remove('browser-fullscreen'));
    await expect(window.locator('#agent-sidebar')).toBeVisible();
    await window.locator('#agent-workspace-sidebar-toggle').click();
  }
  await window.locator('#agent-session-sidebar-toggle').click();
  await window.locator('#agent-mode-toggle').click();
  await window.locator('#agent-mode-browser').click();
  await expect(window.locator('body')).not.toHaveClass(/agent-first-mode/);
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
  const workspaceToggle = window.locator('#agent-workspace-sidebar-toggle');
  if (await workspaceToggle.getAttribute('aria-expanded') === 'false') await workspaceToggle.click();
  const input = window.locator('#address-input');
  await input.fill(page);
  await input.press('Enter');
  await expect.poll(() => window.evaluate(async () => {
    try { return await document.querySelector('webview:not(.hidden)').executeJavaScript('document.title'); }
    catch { return ''; }
  })).toBe('Permission fixture');
  await expect.poll(() => window.evaluate(() => document.querySelector('webview:not(.hidden)').isLoading())).toBe(false);
  await resize(electronApp, 600, 600);
  if (await workspaceToggle.getAttribute('aria-expanded') === 'false') await workspaceToggle.click();
  await window.evaluate(async () => {
    await document.querySelector('webview:not(.hidden)').executeJavaScript('document.getElementById("ask").click(); true');
  });
  await expect(window.locator('#permission-prompt')).toBeVisible();
  for (const width of [600, 380]) {
    await resize(electronApp, width, 600);
    await expect.poll(() => hit(window, '#permission-prompt-allow')).toBe(true);
    await window.screenshot({ animations: 'disabled', path: testInfo.outputPath(`permission-${width}.png`) });
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
    await window.screenshot({ animations: 'disabled', path: testInfo.outputPath(`long-content-${theme}.png`) });
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
  await window.locator('#agent-workspace-sidebar-toggle').click();
  await expect(window.locator('#agent-task-pages')).toBeHidden();
});


test('software rendering profiles long-chat scrolling over a playing video', async ({ userDataDir }, testInfo) => {
  test.setTimeout(45000);
  const app = await electron.launch({ args: ['.', '--disable-gpu'], cwd: root,
    env: { ...process.env, FREEDOM_TEST_MODE: '1', FREEDOM_TEST_USER_DATA: userDataDir,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true', LANG: 'en_US.UTF-8' } });
  try {
    const win = await app.firstWindow();
    await win.waitForSelector('#agent-toggle-btn');
    await openConversation(app, win);
    await app.evaluate(() => globalThis.__FREEDOM_TEST_HARNESS__.setContentFixture('https://motion.test/', {
      body: `<!doctype html><title>Moving video</title><canvas hidden width="640" height="480"></canvas>
        <video autoplay muted playsinline style="width:100vw;height:100vh;object-fit:cover"></video>
        <script>
          const canvas = document.querySelector('canvas'), context = canvas.getContext('2d');
          const video = document.querySelector('video');
          video.srcObject = canvas.captureStream(30); video.play();
          let frame = 0;
          function draw() {
            context.fillStyle = frame++ % 2 ? '#164e63' : '#9a3412'; context.fillRect(0,0,640,480);
            context.fillStyle = '#fef3c7'; context.fillRect((frame * 5) % 640,0,160,480);
            requestAnimationFrame(draw);
          }
          draw();
        </script>`,
    }));
    await win.locator('#address-input').fill('https://motion.test/');
    await win.locator('#address-input').press('Enter');
    await expect.poll(() => win.evaluate(async () => {
      try { return await document.querySelector('webview:not(.hidden)').executeJavaScript('document.querySelector("video")?.readyState'); }
      catch { return null; }
    })).toBeGreaterThanOrEqual(2);
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(win => !win.isDestroyed());
      const emit = event => win.webContents.send('agent:event', { runId: 'software-scroll', ...event });
      emit({ type: 'run_started', userText: 'Explain the video' });
      emit({ type: 'assistant_text_delta', text: Array(320).fill('Readable conversation content above a continuously playing video.').join('\n\n') });
      emit({ type: 'run_finished', status: 'completed', durationMs: 1000, actionCount: 0 });
    });
    await expect.poll(() => win.locator('.agent-workspace-scroll').evaluate(el => el.scrollHeight)).toBeGreaterThan(10000);
    const features = await app.evaluate(({ app }) => ({ platform: process.platform,
      electron: process.versions.electron, gpu: app.getGPUFeatureStatus() }));
    const collect = win.evaluate(async () => {
      const gaps = [], longTasks = [];
      let previous = performance.now(), running = true;
      const observe = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(entry => entry.duration)));
      observe.observe({ type: 'longtask' });
      const frame = time => { gaps.push(time - previous); previous = time; if (running) requestAnimationFrame(frame); };
      requestAnimationFrame(frame);
      await new Promise(resolve => setTimeout(resolve, 2000));
      running = false; observe.disconnect(); gaps.sort((a,b) => a-b);
      return { frames: gaps.length, p95Ms: gaps[Math.floor(gaps.length * 0.95)], maxMs: gaps.at(-1), longTasksMs: longTasks,
        scrollTop: document.querySelector('.agent-workspace-scroll').scrollTop,
        movingBubbleBlur: getComputedStyle(document.querySelector('.agent-output')).backdropFilter,
        composerBlur: getComputedStyle(document.querySelector('.agent-composer-wrap')).backdropFilter };
    });
    await win.locator('.agent-workspace-scroll').hover();
    await win.mouse.wheel(0, -100000);
    const metrics = await collect;
    const profile = testInfo.outputPath('software-video-scroll-profile.json');
    fs.writeFileSync(profile, JSON.stringify({ ...features, ...metrics }, null, 2));
    await testInfo.attach('software-video-scroll-profile', { path: profile, contentType: 'application/json' });
    // Timing is evidence, not a hardware-independent pass threshold.
    expect(metrics.frames).toBeGreaterThan(0);
    expect(metrics.movingBubbleBlur).toBe('none');
    expect(metrics.composerBlur).toContain('blur');
    expect(metrics.scrollTop).toBe(0);
  } finally { await closeApp(app); }
});

test('the model thinking is a closed disclosure above its answer and opens on click', async ({ electronApp, window }, testInfo) => {
  await openConversation(electronApp, window);
  await resize(electronApp, 1000);
  await electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(win => !win.isDestroyed());
    const emit = event => win.webContents.send('agent:event', { runId: 'thinking-fixture', ...event });
    emit({ type: 'run_started', userText: 'Explain Swarm postage stamps' });
    emit({ type: 'assistant_thinking_start' });
    emit({ type: 'assistant_thinking_delta', text: '**Recalling how batches work**\n\nA batch is bought with BZZ; ' });
    emit({ type: 'assistant_thinking_delta', text: 'each upload is stamped against it, and it expires when its balance runs out.' });
    emit({ type: 'assistant_thinking_end', durationMs: 2_000 });
    emit({ type: 'assistant_text_delta', text: 'Here is a summary of **Swarm postage stamps**.\n\n' + Array(6).fill('You buy a batch with BZZ, and every upload is stamped against it.').join('\n\n') });
    emit({ type: 'run_finished', status: 'completed', durationMs: 3_000, actionCount: 0 });
  });
  const turn = window.locator('.agent-turn[data-run-id="thinking-fixture"]');
  const thinking = turn.locator('.agent-thinking');
  await expect(thinking).toHaveCount(1);
  await expect(thinking).not.toHaveAttribute('open', '');
  await expect(thinking.locator('summary')).toHaveText('Thinking · 2s');
  await expect(thinking.locator('.agent-thinking-text')).toBeHidden();
  // Above the answer, below the question.
  expect(await turn.evaluate(section => {
    const order = [...section.children];
    return order.indexOf(section.querySelector('.agent-thinking')) < order.indexOf(section.querySelector('.agent-message-row.assistant')) &&
      order.indexOf(section.querySelector('.agent-message-row.user')) < order.indexOf(section.querySelector('.agent-thinking'));
  })).toBe(true);
  for (const theme of ['dark', 'light']) {
    await window.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await thinking.evaluate(el => { el.open = false; el.scrollIntoView({ block: 'start' }); });
    await window.screenshot({ animations: 'disabled', path: testInfo.outputPath(`thinking-closed-${theme}.png`) });
    await thinking.locator('summary').click();
    await expect(thinking).toHaveAttribute('open', '');
    await expect(thinking.locator('.agent-thinking-text')).toBeVisible();
    await expect(thinking.locator('.agent-thinking-text strong')).toHaveText('Recalling how batches work');
    await expect(thinking.locator('.agent-thinking-text')).toContainText('expires when its balance runs out.');
    await window.screenshot({ animations: 'disabled', path: testInfo.outputPath(`thinking-open-${theme}.png`) });
  }
  // Agent-first mode shows the same disclosure in its full-width transcript.
  await window.locator('#agent-first-toggle').click();
  await expect(thinking.locator('summary')).toBeVisible();
  await expect(thinking.locator('.agent-thinking-text')).toBeVisible();
  await thinking.evaluate(el => el.scrollIntoView({ block: 'start' }));
  await window.screenshot({ animations: 'disabled', path: testInfo.outputPath('thinking-agent-first-light.png') });
});
