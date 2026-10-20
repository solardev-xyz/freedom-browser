const http = require('http');
const fs = require('fs');
const path = require('path');
const { test, expect } = require('./fixtures');
const { configureOllamaAgent } = require('./agent-provider-fixture');

let server;
let baseUrl;
let inferenceRequests = 0;

test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/tags') {
      response.end(JSON.stringify({ models: [{ name: 'freedom-examples-fixture' }] }));
    } else {
      inferenceRequests += 1;
      response.writeHead(500);
      response.end(JSON.stringify({ error: 'Examples must not run without Send' }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
});
test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

test('examples fill editable drafts without sending and respect conversation chronology', async ({ electronApp, window }) => {
  await window.emulateMedia({ reducedMotion: 'reduce' });
  await configureOllamaAgent(window, baseUrl);
  const prompt = window.locator('#agent-prompt');
  const examples = window.locator('#agent-examples');
  const before = inferenceRequests;
  const buttons = examples.getByRole('button');
  await expect(buttons).toHaveCount(4);
  for (let i = 0; i < 4; i += 1) {
    const button = buttons.nth(i);
    const draft = await button.getAttribute('data-agent-example');
    const position = await prompt.boundingBox();
    await button.focus();
    await button.press('Enter');
    await expect(prompt).toBeFocused();
    await expect(prompt).toHaveValue(draft);
    await expect(window.locator('#agent-run')).toBeEnabled();
    await expect(examples).toBeVisible();
    await expect(button).toBeDisabled();
    expect((await prompt.boundingBox()).y).toBeCloseTo(position.y, 0);
    await prompt.fill('My own edited prompt');
    expect((await prompt.boundingBox()).y).toBeCloseTo(position.y, 0);
    await window.locator('#agent-sidebar-close').click();
    await window.locator('#agent-toggle-btn').click();
    await expect(prompt).toHaveValue('My own edited prompt');
    await expect(examples).toBeVisible();
    await expect(button).toBeDisabled();
    expect((await prompt.boundingBox()).y).toBeCloseTo(position.y, 0);
    await prompt.fill('');
    await expect(examples).toBeVisible();
  }
  expect(inferenceRequests).toBe(before);
  await electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(win => !win.isDestroyed());
    for (const event of [
      { type: 'run_started', userText: 'A real conversation' },
      { type: 'assistant_text_delta', text: 'A finished response' },
      { type: 'run_finished', status: 'completed', durationMs: 1000, actionCount: 0 },
    ]) win.webContents.send('agent:event', { runId: 'examples-fixture', conversationId: 'examples-conversation', ...event });
  });
  await expect(window.locator('#agent-empty-state')).toBeHidden();
  await expect(examples).toBeHidden();
  // The run above is a renderer fixture, so clear it through the matching event.
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find(win => !win.isDestroyed()).webContents.send('agent:event',
      { type: 'conversation_cleared', conversationId: 'examples-conversation' });
  });
  await expect(examples).toBeVisible();
});

test('first send moves the composer from its visible launcher position', async ({ window }) => {
  await window.emulateMedia({ reducedMotion: 'no-preference' });
  await configureOllamaAgent(window, baseUrl);
  await window.locator('#agent-prompt').fill('Build a small browser game');
  await window.locator('.agent-sidebar-inner').evaluate(async element => {
    await Promise.allSettled(element.getAnimations().map(animation => animation.finished));
  });
  const before = await window.locator('#agent-composer').boundingBox();
  const launcher = await window.locator('.agent-sidebar-inner').boundingBox();
  await window.evaluate(() => {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function(frames, timing) {
      if (this.id === 'agent-composer') {
        const after = this.getBoundingClientRect();
        const translation = frames[0].transform.match(/translate\(([-.\d]+)px,\s*([-.\d]+)px\)/);
        window.exampleFlight = { sourceY: after.y + Number(translation[2]) };
      }
      return animate.call(this, frames, timing);
    };
    new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (!node.classList?.contains('agent-floating-ghost')) continue;
        const cards = node.querySelector('.agent-examples');
        window.exampleGhost = {
          height: node.getBoundingClientRect().height,
          cardsVisible: Boolean(cards && !cards.hidden),
          inert: node.inert,
          duplicateIds: node.querySelectorAll('[id]').length,
        };
      }
    }).observe(document.body, { childList: true });
  });
  await window.locator('#agent-prompt').press('Enter');
  await expect.poll(() => window.evaluate(() => Boolean(window.exampleFlight && window.exampleGhost))).toBe(true);
  const { flight, ghost } = await window.evaluate(() => ({ flight: window.exampleFlight, ghost: window.exampleGhost }));
  expect(flight.sourceY).toBeCloseTo(before.y, 0);
  expect(ghost.height).toBeCloseTo(launcher.height, 0);
  expect(ghost).toMatchObject({ cardsVisible: false, inert: true, duplicateIds: 0 });
});

test('choosing a project review keeps a staged attachment and sends no request', async ({ electronApp, window, userDataDir }) => {
  await configureOllamaAgent(window, baseUrl);
  const file = path.join(userDataDir, 'example-notes.txt');
  fs.writeFileSync(file, 'A project note for review.');
  await electronApp.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, file);
  await window.locator('#agent-attachment-button').click();
  await window.locator('#agent-attach-files').click();
  const attachment = window.locator('#agent-attachment-contexts');
  await expect(attachment).toContainText('example-notes.txt');
  const before = inferenceRequests;
  await window.locator('#agent-examples').getByRole('button', { name: /Review a project/ }).click();
  await expect(window.locator('#agent-prompt')).toHaveValue(/Don't change files/);
  await expect(attachment).toContainText('example-notes.txt');
  await expect(window.locator('#agent-approval')).toBeHidden();
  expect(inferenceRequests).toBe(before);
});

test('examples and composer remain reachable in both themes, small windows and Agent-first mode', async ({ electronApp, window }, testInfo) => {
  await configureOllamaAgent(window, baseUrl);
  for (const theme of ['dark', 'light']) {
    await window.evaluate(theme => window.electronAPI.saveSettings({ theme }), theme);
    for (const [width, height] of [[1100, 800], [760, 560], [420, 640], [760, 420], [380, 500], [380, 540], [380, 610]]) {
      await electronApp.evaluate(({ BrowserWindow }, size) => {
        const win = BrowserWindow.getAllWindows().find(win => !win.isDestroyed());
        win.setMinimumSize(320, 300);
        win.setContentSize(size.width, size.height);
      }, { width, height });
      for (const mode of ['floating', 'agent-first']) {
        if (mode === 'agent-first') await window.locator('#agent-first-toggle').click();
        const compact = mode === 'floating' && (height <= 520 || (width <= 380 && height <= 600));
        if (compact) await expect(window.locator('#agent-examples')).toBeHidden();
        const controls = ['#agent-prompt', '#agent-attachment-button', '#agent-run'];
        if (!compact) controls.unshift('#agent-examples button:last-child');
        for (const selector of controls) {
          if (mode === 'agent-first') await window.locator(selector).scrollIntoViewIfNeeded();
          await expect.poll(() => window.locator(selector).evaluate(element => {
            const r = element.getBoundingClientRect();
            const target = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            return r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= innerWidth &&
              r.top >= 0 && r.bottom <= innerHeight && (target === element || element.contains(target));
          })).toBe(true);
        }
        if (!compact) {
          const cards = await window.locator('#agent-examples').boundingBox();
          const composer = await window.locator('#agent-composer-wrap').boundingBox();
          expect(cards.y).toBeGreaterThanOrEqual(composer.y + composer.height);
          if (mode === 'floating') {
            const glass = await window.locator('.agent-sidebar-inner').boundingBox();
            expect(cards.y).toBeGreaterThan(glass.y + glass.height + 8);
          }
        }
        await window.screenshot({ animations: 'disabled', path: testInfo.outputPath(`examples-${theme}-${width}-${mode}.png`) });
        if (mode === 'agent-first') {
          await window.locator('#agent-examples button').first().click();
          await expect(window.locator('#agent-prompt')).toHaveValue(/Build a small browser game/);
          await window.locator('#agent-prompt').fill('');
          await window.keyboard.press('Escape');
          await expect(window.locator('body')).not.toHaveClass(/agent-first-mode/);
        }
      }
    }
  }
});

test('without a connection, Agent directs users to Settings without running an example', async ({ window }) => {
  const before = inferenceRequests;
  await window.locator('#agent-toggle-btn').click();
  await expect(window.locator('#agent-setup-view')).toBeVisible();
  await expect(window.locator('#agent-examples')).toBeHidden();
  await expect(window.locator('#agent-open-ai-settings')).toBeVisible();
  expect(inferenceRequests).toBe(before);
});
