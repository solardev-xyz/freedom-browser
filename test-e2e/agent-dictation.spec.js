const http = require('http');
const { WebSocketServer } = require('ws');
const { test, expect } = require('./fixtures');
const { openProviderSettings } = require('./agent-provider-fixture');

let server;
let endpoint;
const recordings = [];
let hold = false;
let heldResponse;
let sockets;
const liveEvents = [];

test.beforeAll(async () => {
  server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    recordings.push(Buffer.concat(chunks));
    if (hold) { heldResponse = response; return; }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ text: 'a small browser game' }));
  });
  sockets = new WebSocketServer({ server });
  sockets.on('connection', socket => {
    let next = 1; let previous = null; let partial = false;
    socket.on('message', data => {
      const event = JSON.parse(data.toString()); liveEvents.push(event);
      const send = value => socket.send(JSON.stringify(value));
      if (event.type === 'session.update') send({ type: 'session.updated' });
      if (event.type === 'input_audio_buffer.append' && !partial) {
        partial = true;
        send({ type: 'conversation.item.input_audio_transcription.delta', item_id: `phrase-${next}`, delta: 'a small browser' });
      }
      if (event.type === 'input_audio_buffer.commit') {
        const id = `phrase-${next++}`;
        send({ type: 'input_audio_buffer.committed', item_id: id, previous_item_id: previous }); previous = id;
        send({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript: 'a small browser game' });
        partial = false;
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => {
  for (const socket of sockets.clients) socket.terminate();
  sockets.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
});
test.beforeEach(() => { hold = false; heldResponse = null; liveEvents.length = 0; });

async function prepare(window, electronApp, providerId = 'openrouter') {
  await window.emulateMedia({ reducedMotion: 'reduce' });
  await electronApp.evaluate(async (_electron, endpoint) => {
    const fetch = globalThis.fetch;
    globalThis.fetch = (url, options) => fetch(String(url).includes('openrouter.ai/api/v1/audio/transcriptions') ? endpoint : url, options);
    const https = process.getBuiltinModule('https');
    const http = process.getBuiltinModule('http');
    const original = https.request;
    https.request = (options, ...rest) => {
      if (options.host !== 'api.openai.com' || !options.path?.startsWith('/v1/realtime')) return original(options, ...rest);
      const local = { ...options, protocol: 'http:', host: '127.0.0.1', port: Number(new URL(endpoint).port), defaultPort: 80 };
      delete local.createConnection;
      return http.request(local, ...rest);
    };
  }, endpoint);
  const connected = await window.evaluate(async providerId => {
    const result = await window.electronAPI.getAgentProviderCatalog();
    const model = result.catalog.find(provider => provider.providerId === providerId).models[0].id;
    return window.electronAPI.configureHostedAgentProvider(providerId, model, 'dictation-fixture-key');
  }, providerId);
  expect(connected.ok).toBe(true);
  await window.locator('#agent-toggle-btn').click();
  await expect(window.locator('#agent-workspace-view')).toBeVisible();
  await window.evaluate(() => {
    // Real Chromium audio graph and AudioWorklet, with a deterministic source
    // instead of recording the developer's microphone or asking for OS access.
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext({ sampleRate: 16000 });
      const oscillator = context.createOscillator(); oscillator.frequency.value = 300;
      const destination = context.createMediaStreamDestination();
      oscillator.connect(destination); oscillator.start(); await context.resume();
      window.dictationTestStream = destination.stream;
      window.dictationTestContext = context;
      return destination.stream;
    };
  });
}

test('first microphone click uses a connected service immediately without setup', async ({ window, electronApp }) => {
  await prepare(window, electronApp);
  expect((await window.evaluate(() => window.electronAPI.getAgentDictationState())).preferences.providerId).toBe(null);
  await window.locator('#agent-prompt').fill('Build');
  await window.locator('#agent-dictation').click();
  await expect(window.locator('#agent-dictation-panel')).toBeHidden();
  await expect(window.locator('#agent-dictation-feedback')).toContainText('Listening · OpenRouter');
  expect((await window.evaluate(() => window.electronAPI.getAgentDictationState())).preferences.providerId).toBe('openrouter');
  await window.waitForTimeout(600);
  await window.locator('#agent-dictation').click();
  await expect(window.locator('#agent-prompt')).toHaveValue('Build a small browser game');
  await expect(window.locator('#agent-transcript')).toBeHidden();
});

test('chevron opens a compact provider menu in both themes; selection does not record or send', async ({ window, electronApp }, testInfo) => {
  await prepare(window, electronApp);
  const prompt = window.locator('#agent-prompt');
  await prompt.fill('Build');
  const menu = window.locator('#agent-dictation-menu');
  for (const theme of ['dark', 'light']) {
    await window.evaluate(theme => window.electronAPI.saveSettings({ theme }), theme);
    for (const [width, height] of [[1100, 800], [760, 560], [420, 640]]) {
      await electronApp.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows().find(window => window.isVisible()).setSize(...size), [width, height]);
      await window.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await window.locator('#agent-dictation-options').click();
      await expect(menu).toBeVisible();
      await expect(menu.getByRole('menuitemradio', { name: /OpenRouter/ })).toHaveAttribute('aria-checked', 'true');
      await expect(menu.getByRole('menuitem', { name: 'Voice dictation settings…' })).toBeInViewport();
      await expect(window.locator('#agent-dictation-panel')).toBeHidden();
      await expect(window.locator('#agent-dictation')).toBeInViewport();
      await window.screenshot({ path: testInfo.outputPath(`dictation-menu-${theme}-${width}.png`) });
      await window.keyboard.press('Escape');
      await expect(menu).toBeHidden();
    }
  }
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.isVisible()).setSize(1100, 800));
  await window.locator('#agent-dictation-options').click();
  await menu.getByRole('menuitemradio', { name: /OpenRouter/ }).click();
  await expect(menu).toBeHidden();
  await expect(prompt).toHaveValue('Build');
  await expect(window.locator('#agent-dictation-feedback')).toBeHidden();
  await window.locator('#agent-dictation').click();
  await expect(window.locator('#agent-dictation-feedback')).toContainText('Listening');
  await expect(prompt).toHaveAttribute('readonly', '');
  await expect(window.locator('#agent-run')).toBeDisabled();
  // Wait for actual audio frames, not a substituted transcription IPC method.
  await window.waitForTimeout(800);
  const before = recordings.length;
  await window.locator('#agent-dictation').click();
  await expect(prompt).toHaveValue('Build a small browser game');
  await expect(window.locator('#agent-run')).toBeEnabled();
  await expect(window.locator('#agent-transcript')).toBeHidden();
  expect(recordings.length).toBe(before + 1);
  expect(Buffer.from(JSON.parse(recordings.at(-1).toString()).input_audio.data, 'base64').subarray(0, 4).toString()).toBe('RIFF');
  expect(recordings.at(-1).includes(Buffer.from('Build'))).toBe(false);
  expect(await window.evaluate(() => window.dictationTestStream.getTracks().every(track => track.readyState === 'ended'))).toBe(true);

  await window.locator('#agent-dictation').click();
  await expect(menu).toBeHidden();
  await expect(window.locator('#agent-dictation-feedback')).toContainText('Listening');
  await window.keyboard.press('Escape');
  await expect(prompt).toHaveValue('Build a small browser game');
  await expect(window.locator('#agent-sidebar')).toBeVisible();
  expect(await window.evaluate(() => window.dictationTestStream.getTracks().every(track => track.readyState === 'ended'))).toBe(true);
});

test('menu switches provider without recording and opens voice management directly', async ({ window, electronApp }) => {
  await prepare(window, electronApp);
  await window.evaluate(async () => {
    const result = await window.electronAPI.getAgentProviderCatalog();
    const model = result.catalog.find(provider => provider.providerId === 'openai').models[0].id;
    await window.electronAPI.configureHostedAgentProvider('openai', model, 'dictation-fixture-key');
    await window.electronAPI.chooseAgentDictation({ providerId: 'openrouter', language: 'de', requireZeroRetention: true });
  });
  const menu = window.locator('#agent-dictation-menu');
  await window.locator('#agent-prompt').fill('Keep my draft');
  await window.locator('#agent-dictation-options').click();
  await menu.getByRole('menuitemradio', { name: /OpenAI/ }).click();
  await expect(menu).toBeHidden();
  await expect.poll(() => window.evaluate(async () => (await window.electronAPI.getAgentDictationState()).preferences)).toEqual({
    providerId: 'openai', language: 'de', requireZeroRetention: true,
  });
  await expect(window.locator('#agent-dictation-feedback')).toBeHidden();
  await window.locator('#agent-dictation-options').click();
  await window.locator('#menu-backdrop').click({ position: { x: 2, y: 2 } });
  await expect(menu).toBeHidden(); await expect(window.locator('#agent-sidebar')).toBeVisible();
  await window.locator('#agent-dictation-options').click();
  await menu.getByRole('menuitem', { name: 'Voice dictation settings…' }).click();
  let settings;
  await expect.poll(() => {
    settings = window.context().pages().find(page => page.url().includes('/pages/settings.html'));
    return settings?.url();
  }).toContain('#ai/voice');
  await expect(settings.locator('#ai-dictation-settings')).toBeInViewport();
  await expect(window.locator('#agent-sidebar')).toBeHidden();
  await expect(window.locator('#agent-prompt')).toHaveValue('Keep my draft');
});

test('closing during transcription discards late text and releases audio', async ({ window, electronApp }) => {
  await prepare(window, electronApp);
  await window.evaluate(() => window.electronAPI.chooseAgentDictation({ providerId: 'openrouter', language: 'de', requireZeroRetention: true }));
  await window.locator('#agent-prompt').fill('Keep this draft');
  await window.locator('#agent-dictation').click();
  await expect(window.locator('#agent-dictation-feedback')).toContainText('Listening');
  await window.waitForTimeout(600);
  hold = true;
  await window.locator('#agent-dictation').click();
  await expect.poll(() => Boolean(heldResponse)).toBe(true);
  await window.locator('#agent-sidebar-close').click();
  heldResponse.end(JSON.stringify({ text: 'late unwanted text' }));
  await window.locator('#agent-toggle-btn').click();
  await expect(window.locator('#agent-prompt')).toHaveValue('Keep this draft');
  await expect(window.locator('#agent-run')).toBeEnabled();
  expect(await window.evaluate(() => window.dictationTestStream.getTracks().every(track => track.readyState === 'ended'))).toBe(true);
});

test('Settings offers the same dictation choices in both themes and AI off disables it', async ({ window, electronApp }, testInfo) => {
  await prepare(window, electronApp);
  const settings = await openProviderSettings(window);
  const voice = settings.locator('#ai-dictation-settings');
  for (const theme of ['dark', 'light']) {
    await window.evaluate(theme => window.electronAPI.saveSettings({ theme }), theme);
    await expect(voice.getByLabel('Dictation service')).toBeVisible();
    await voice.getByLabel('Dictation service').selectOption('openrouter');
    await voice.getByLabel('Dictation language').selectOption('de');
    await expect.poll(() => window.evaluate(async () => (await window.electronAPI.getAgentDictationState()).preferences.language)).toBe('de');
    await voice.scrollIntoViewIfNeeded();
    await window.screenshot({ path: testInfo.outputPath(`dictation-settings-${theme}.png`) });
  }
  await settings.locator('#enable-ai').uncheck();
  await expect(voice).toBeHidden();
  const response = await window.evaluate(() => window.electronAPI.beginAgentDictation());
  expect(response).toMatchObject({ ok: false, error: { code: 'AGENT_DISABLED' } });
});

test('OpenAI live words appear before Stop and reconcile to the final editable text', async ({ window, electronApp }) => {
  await prepare(window, electronApp, 'openai');
  await window.locator('#agent-prompt').fill('Build');
  await window.locator('#agent-dictation').click();
  await expect(window.locator('#agent-prompt')).toHaveValue('Build a small browser');
  await expect(window.locator('#agent-dictation-feedback')).toContainText('Listening');
  expect(liveEvents.find(event => event.type === 'session.update').session.audio.input.format.rate).toBe(24000);
  await window.locator('#agent-dictation').click();
  await expect(window.locator('#agent-prompt')).toHaveValue('Build a small browser game');
  await expect(window.locator('#agent-prompt')).not.toHaveAttribute('readonly', '');
  expect(liveEvents.filter(event => event.type === 'input_audio_buffer.commit')).toHaveLength(1);
  expect(liveEvents.some(event => JSON.stringify(event).includes('Build'))).toBe(false);
});

test('a phrase appears during a pause while the microphone continues, and Escape restores the draft', async ({ window, electronApp }) => {
  await prepare(window, electronApp);
  await window.locator('#agent-prompt').fill('Build');
  await window.locator('#agent-dictation').click();
  await expect(window.locator('#agent-dictation-feedback')).toContainText('Listening');
  await window.waitForTimeout(500);
  await window.evaluate(() => { window.dictationTestStream.getAudioTracks()[0].enabled = false; });
  await expect(window.locator('#agent-prompt')).toHaveValue('Build a small browser game');
  await expect(window.locator('#agent-dictation-feedback')).toContainText('Listening');
  await window.keyboard.press('Escape');
  await expect(window.locator('#agent-prompt')).toHaveValue('Build');
  await expect(window.locator('#agent-run')).toBeEnabled();
});
