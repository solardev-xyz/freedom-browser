const http = require('http');
const { test, expect } = require('./fixtures');
const { openProviderSettings } = require('./agent-provider-fixture');

let server;
let endpoint;
const recordings = [];
let hold = false;
let heldResponse;

test.beforeAll(async () => {
  server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    recordings.push(Buffer.concat(chunks));
    if (hold) { heldResponse = response; return; }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ text: 'a small browser game' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
test.beforeEach(() => { hold = false; heldResponse = null; });

async function prepare(window, electronApp) {
  await window.emulateMedia({ reducedMotion: 'reduce' });
  await electronApp.evaluate((_electron, endpoint) => {
    const fetch = globalThis.fetch;
    globalThis.fetch = (url, options) => fetch(String(url).includes('api.openai.com/v1/audio/transcriptions') ? endpoint : url, options);
  }, endpoint);
  const connected = await window.evaluate(async () => {
    const result = await window.electronAPI.getAgentProviderCatalog();
    const model = result.catalog.find(provider => provider.providerId === 'openai').models[0].id;
    return window.electronAPI.configureHostedAgentProvider('openai', model, 'dictation-fixture-key');
  });
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

test('first-use consent, real audio capture, cloud upload and editable insertion without sending', async ({ window, electronApp }, testInfo) => {
  await prepare(window, electronApp);
  const prompt = window.locator('#agent-prompt');
  await prompt.fill('Build');
  await window.locator('#agent-dictation').click();
  const chooser = window.locator('#agent-dictation-panel');
  await expect(chooser).toBeVisible();
  await chooser.getByLabel('Dictation service').selectOption('openai');
  await expect(chooser).toContainText('Audio is sent to OpenAI');
  for (const theme of ['dark', 'light']) {
    await window.evaluate(theme => window.electronAPI.saveSettings({ theme }), theme);
    for (const [width, height] of [[1100, 800], [760, 560], [420, 640]]) {
      await electronApp.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows().find(window => window.isVisible()).setSize(...size), [width, height]);
      await expect(chooser.getByRole('button', { name: 'Use for dictation' })).toBeInViewport();
      await expect(window.locator('#agent-dictation')).toBeInViewport();
      await window.screenshot({ path: testInfo.outputPath(`dictation-chooser-${theme}-${width}.png`) });
    }
  }
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.isVisible()).setSize(1100, 800));
  await chooser.getByRole('button', { name: 'Use for dictation' }).click();
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
  expect(recordings.at(-1).includes(Buffer.from('RIFF'))).toBe(true);
  expect(recordings.at(-1).includes(Buffer.from('Build'))).toBe(false);
  expect(await window.evaluate(() => window.dictationTestStream.getTracks().every(track => track.readyState === 'ended'))).toBe(true);

  await window.locator('#agent-dictation').click();
  await expect(chooser).toBeHidden();
  await expect(window.locator('#agent-dictation-feedback')).toContainText('Listening');
  await window.keyboard.press('Escape');
  await expect(prompt).toHaveValue('Build a small browser game');
  await expect(window.locator('#agent-sidebar')).toBeVisible();
  expect(await window.evaluate(() => window.dictationTestStream.getTracks().every(track => track.readyState === 'ended'))).toBe(true);
});

test('closing during transcription discards late text and releases audio', async ({ window, electronApp }) => {
  await prepare(window, electronApp);
  await window.evaluate(() => window.electronAPI.chooseAgentDictation({ providerId: 'openai', language: 'de', requireZeroRetention: true }));
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
    await voice.getByLabel('Dictation service').selectOption('openai');
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
