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

async function prepare(window, electronApp, providerId = 'openrouter', { audioConsent = true } = {}) {
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
  // Recording fixtures acknowledge audio privacy explicitly. Consent-flow
  // tests opt out so capture remains gated by the real main-process service.
  if (providerId === 'openrouter' && audioConsent)
    expect((await window.evaluate(() => window.electronAPI.chooseAgentDictation({ providerId: 'openrouter', acceptOpenRouterAudio: true }))).ok).toBe(true);
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

test('a remembered audio choice starts immediately without repeating setup', async ({ window, electronApp }) => {
  await prepare(window, electronApp);
  expect((await window.evaluate(() => window.electronAPI.getAgentDictationState())).preferences.providerId).toBe('openrouter');
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
      // #870: the check trails the active option (as in the approval menu);
      // the plain Settings action reserves no empty check gutter, so its label
      // lines up with the provider labels.
      const layout = await menu.evaluate(host => {
        const radios = [...host.querySelectorAll('[role="menuitemradio"]')];
        const settings = host.querySelector('[role="menuitem"]');
        const left = item => item.querySelector('strong').getBoundingClientRect().left;
        return {
          checkLast: radios.every(item => item.lastElementChild.classList.contains('agent-dictation-menu-check')),
          checks: radios.map(item => item.querySelector('.agent-dictation-menu-check').textContent),
          settingsCheck: settings.querySelectorAll('.agent-dictation-menu-check').length,
          aligned: radios.every(item => Math.abs(left(item) - left(settings)) < 1),
        };
      });
      expect(layout).toMatchObject({ checkLast: true, settingsCheck: 0, aligned: true });
      expect(layout.checks.filter(mark => mark === '✓').length).toBe(1);
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
  await expect(prompt).not.toHaveAttribute('readonly', '');
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
  await window.waitForTimeout(600);
  await window.keyboard.press('Escape');
  await expect(prompt).toHaveValue('Build a small browser game a small browser game');
  await expect(window.locator('#agent-sidebar')).toBeVisible();
  expect(await window.evaluate(() => window.dictationTestStream.getTracks().every(track => track.readyState === 'ended'))).toBe(true);
});

test('menu switches provider without recording and opens voice management directly', async ({ window, electronApp }) => {
  await prepare(window, electronApp);
  await window.evaluate(async () => {
    const result = await window.electronAPI.getAgentProviderCatalog();
    const model = result.catalog.find(provider => provider.providerId === 'openai').models[0].id;
    await window.electronAPI.configureHostedAgentProvider('openai', model, 'dictation-fixture-key');
    await window.electronAPI.chooseAgentDictation({ providerId: 'openrouter', language: 'de' });
  });
  const menu = window.locator('#agent-dictation-menu');
  await window.locator('#agent-prompt').fill('Keep my draft');
  await window.locator('#agent-dictation-options').click();
  await menu.getByRole('menuitemradio', { name: /OpenAI/ }).click();
  await expect(menu).toBeHidden();
  await expect.poll(() => window.evaluate(async () => (await window.electronAPI.getAgentDictationState()).preferences)).toEqual({
    providerId: 'openai', language: 'de', openrouterAudioConsent: true,
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
  await window.evaluate(() => window.electronAPI.chooseAgentDictation({ providerId: 'openrouter', language: 'de' }));
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

test('Voice settings use service cards and detail pages in both themes, preserving chat and dictation preferences', async ({ window, electronApp }, testInfo) => {
  await prepare(window, electronApp);
  await window.evaluate(async () => {
    const result = await window.electronAPI.getAgentProviderCatalog();
    const model = result.catalog.find(provider => provider.providerId === 'openai').models[0].id;
    await window.electronAPI.configureHostedAgentProvider('openai', model, 'dictation-fixture-key');
    await window.electronAPI.chooseAgentDictation({ providerId: 'openrouter', language: 'auto' });
  });
  const chatModel = (await window.evaluate(() => window.electronAPI.getAgentProviderStatus())).status.modelId;
  const before = recordings.length;
  const settings = await openProviderSettings(window);
  await settings.evaluate(() => { location.hash = 'ai/voice'; });
  const voice = settings.locator('#ai-dictation-settings');
  await expect(voice.getByRole('link', { name: /OpenRouter/ })).toContainText('In use');
  await expect(voice.getByLabel('Dictation service')).toHaveCount(0);
  await voice.getByLabel('Dictation language').selectOption('de');
  await expect.poll(() => window.evaluate(async () => (await window.electronAPI.getAgentDictationState()).preferences.language)).toBe('de');
  await voice.getByRole('link', { name: /OpenAI/ }).click();
  await expect(settings).toHaveURL(/#ai\/voice\/openai$/);
  await expect(settings.locator('#ai-voice-breadcrumbs')).toHaveText('AI›Voice dictation›OpenAI');
  await voice.getByRole('button', { name: 'Use for dictation', exact: true }).click();
  await expect.poll(() => window.evaluate(async () => (await window.electronAPI.getAgentDictationState()).preferences.providerId)).toBe('openai');
  await settings.locator('#ai-voice-breadcrumbs').getByRole('link', { name: 'Voice dictation', exact: true }).click();
  for (const theme of ['dark', 'light']) {
    await window.evaluate(theme => window.electronAPI.saveSettings({ theme }), theme);
    await expect(settings.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(voice.getByRole('link', { name: /OpenAI/ })).toContainText('In use');
    await settings.screenshot({ path: testInfo.outputPath(`voice-services-${theme}.png`) });
    await voice.getByRole('link', { name: /OpenRouter/ }).click();
    await expect(voice).toContainText('Zero data retention is unavailable for dictation');
    await expect(voice.getByRole('checkbox')).toHaveCount(0);
    expect((await window.evaluate(() => window.electronAPI.getAgentDictationState())).preferences).toMatchObject({
      providerId: 'openai', language: 'de', openrouterAudioConsent: true,
    });
    await settings.screenshot({ path: testInfo.outputPath(`voice-openrouter-${theme}.png`) });
    await settings.locator('#ai-voice-breadcrumbs').getByRole('link', { name: 'Voice dictation', exact: true }).click();
    await voice.getByRole('link', { name: /On this device/ }).click();
    await expect(voice.getByRole('button', { name: 'Download & use on this device' })).toBeVisible();
    await expect(voice).toContainText('150 MB');
    await settings.screenshot({ path: testInfo.outputPath(`voice-local-${theme}.png`) });
    await settings.goBack();
    await voice.getByRole('link', { name: 'Add service', exact: true }).click();
    await expect(voice.locator('.voice-service')).toHaveCount(4);
    await settings.screenshot({ path: testInfo.outputPath(`voice-add-${theme}.png`) });
    await voice.getByRole('link', { name: /Venice/ }).click();
    await expect(voice.getByRole('link', { name: 'Connect provider' })).toHaveAttribute('href', '#ai/providers/venice');
    await settings.locator('#ai-voice-breadcrumbs').getByRole('link', { name: 'Voice dictation', exact: true }).click();
  }
  await window.evaluate(() => window.electronAPI.chooseAgentDictation({ providerId: 'openrouter', language: 'de' }));
  await settings.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(voice.getByRole('link', { name: /OpenRouter/ })).toContainText('In use');
  await electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(win => win.isVisible());
    win.setMinimumSize(320, 300); win.setContentSize(640, 760);
  });
  expect(await settings.locator('main.content').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await settings.screenshot({ path: testInfo.outputPath('voice-services-narrow.png') });
  await voice.getByRole('link', { name: /On this device/ }).click();
  await expect(voice.getByRole('button', { name: 'Download & use on this device' })).toBeInViewport();
  await settings.screenshot({ path: testInfo.outputPath('voice-local-narrow.png') });
  expect(recordings.length).toBe(before);
  expect((await window.evaluate(() => window.electronAPI.getAgentProviderStatus())).status.modelId).toBe(chatModel);
  await settings.evaluate(() => { location.hash = 'ai/voice/openrouter'; });
  await expect(voice).toContainText('Audio privacy');
  await settings.locator('.nav-item[data-target="appearance"]').click();
  await expect(settings.locator('#appearance')).toBeVisible();
  await settings.locator('#settings-search').fill('Audio privacy');
  await settings.locator('#settings-search').dispatchEvent('input');
  await expect(settings.locator('#settings-search-list')).toContainText('Audio privacy');
  await settings.locator('#settings-search-list').getByRole('button', { name: /Audio privacy/ }).click();
  await expect(settings).toHaveURL(/#ai\/voice\/openrouter$/);
  await expect(voice).toContainText('Audio privacy');
  await settings.evaluate(() => { location.hash = 'ai/voice/not-a-service'; });
  await expect(settings).toHaveURL(/#ai\/voice$/);
  await settings.getByRole('link', { name: 'AI', exact: true }).click();
  await settings.locator('#enable-ai').uncheck();
  await expect(voice).toBeHidden();
  expect(await window.evaluate(() => window.electronAPI.beginAgentDictation())).toMatchObject({ ok: false, error: { code: 'AGENT_DISABLED' } });
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

test('a phrase appears during a pause while the microphone continues, and Escape keeps the completed draft', async ({ window, electronApp }) => {
  await prepare(window, electronApp);
  await window.locator('#agent-prompt').fill('Build');
  await window.locator('#agent-dictation').click();
  await expect(window.locator('#agent-dictation-feedback')).toContainText('Listening');
  await window.waitForTimeout(500);
  await window.evaluate(() => { window.dictationTestStream.getAudioTracks()[0].enabled = false; });
  await expect(window.locator('#agent-prompt')).toHaveValue('Build a small browser game');
  await expect(window.locator('#agent-dictation-feedback')).toContainText('Listening');
  await window.keyboard.press('Escape');
  await expect(window.locator('#agent-prompt')).toHaveValue('Build a small browser game');
  await expect(window.locator('#agent-run')).toBeEnabled();
});


test('OpenRouter asks once before audio, remembers the choice, and preserves chat zero retention', async ({ window, electronApp }, testInfo) => {
  await prepare(window, electronApp, 'openrouter', { audioConsent: false });
  expect((await window.evaluate(() => window.electronAPI.setAgentProviderPreferences('openrouter', { privacyPolicy: 'zdr' }))).ok).toBe(true);
  const before = recordings.length;
  await window.locator('#agent-dictation').click();
  const panel = window.locator('#agent-dictation-panel');
  await expect(panel).toContainText('Use OpenRouter for dictation?');
  await expect(panel).toContainText('Your chat privacy settings do not apply to audio');
  expect(await window.evaluate(() => Boolean(window.dictationTestStream))).toBe(false);
  expect(recordings.length).toBe(before);
  for (const theme of ['dark', 'light']) {
    await window.evaluate(theme => window.electronAPI.saveSettings({ theme }), theme);
    await window.screenshot({ path: testInfo.outputPath(`audio-consent-${theme}.png`) });
  }
  await panel.getByRole('button', { name: 'Choose another service' }).click();
  await expect(window.locator('#agent-dictation-menu')).toBeVisible();
  expect(await window.evaluate(() => Boolean(window.dictationTestStream))).toBe(false);
  await window.keyboard.press('Escape');
  await window.locator('#agent-dictation').click();
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await window.evaluate(() => window.electronAPI.getAgentDictationState())).preferences.openrouterAudioConsent).toBe(false);
  await window.locator('#agent-dictation').click();
  await panel.getByRole('button', { name: 'Use OpenRouter', exact: true }).click();
  await expect(window.locator('#agent-dictation-feedback')).toContainText('Listening · OpenRouter');
  await window.waitForTimeout(650);
  await window.locator('#agent-dictation').click();
  await expect(window.locator('#agent-prompt')).toHaveValue('a small browser game');
  await window.locator('#agent-dictation').click();
  await expect(panel).toBeHidden();
  await expect(window.locator('#agent-dictation-feedback')).toContainText('Listening · OpenRouter');
  await window.keyboard.press('Escape');
  const policy = await window.evaluate(async () => (await window.electronAPI.getAgentProviderStatus()).status.connections.find(item => item.providerId === 'openrouter').privacyPolicy);
  expect(policy).toBe('zdr');
});

test('Voice settings show audio privacy without a locked chat toggle and can acknowledge standard routing', async ({ window, electronApp }, testInfo) => {
  await prepare(window, electronApp, 'openrouter', { audioConsent: false });
  await window.evaluate(() => window.electronAPI.setAgentProviderPreferences('openrouter', { privacyPolicy: 'zdr' }));
  const before = recordings.length;
  const settings = await openProviderSettings(window);
  await settings.locator('.nav-item[data-target="appearance"]').click();
  await expect(settings.locator('#appearance')).toBeVisible();
  await settings.locator('#settings-search').fill('Audio privacy');
  await expect(settings.locator('#settings-search-list')).toContainText('Voice dictation');
  await settings.locator('#settings-search-list').getByRole('button', { name: /Audio privacy/ }).click();
  await expect(settings).toHaveURL(/#ai\/voice\/openrouter$/);
  const voice = settings.locator('#ai-dictation-settings');
  await expect(voice.getByRole('checkbox')).toHaveCount(0);
  await expect(voice).toContainText('Your chat privacy settings do not apply to audio');
  await voice.getByRole('button', { name: 'Use with standard routing' }).click();
  await expect(voice.getByRole('button', { name: 'Used for dictation' })).toBeVisible();
  for (const theme of ['dark', 'light']) {
    await window.evaluate(theme => window.electronAPI.saveSettings({ theme }), theme);
    await expect(settings.locator('html')).toHaveAttribute('data-theme', theme);
    await settings.screenshot({ path: testInfo.outputPath(`audio-privacy-${theme}.png`) });
  }
  expect(recordings.length).toBe(before);
  expect(await window.evaluate(() => Boolean(window.dictationTestStream))).toBe(false);
  const policy = await window.evaluate(async () => (await window.electronAPI.getAgentProviderStatus()).status.connections.find(item => item.providerId === 'openrouter').privacyPolicy);
  expect(policy).toBe('zdr');
});

test('chat privacy policies leave all three audio services available', async ({ window, electronApp }, testInfo) => {
  await prepare(window, electronApp);
  // Everything below uses fake catalogs, keys and audio in the disposable
  // profile. Never send a request to these live provider hosts from this test.
  await electronApp.evaluate((_electron, endpoint) => {
    const fetch = globalThis.fetch;
    globalThis.fetch = (url, options) => {
      const address = String(url);
      if (address.startsWith('https://api.venice.ai/api/v1/models')) return Promise.resolve(new Response(JSON.stringify({ data: [{
        id: 'dictation-venice-fixture', type: 'text', model_spec: { name: 'Fixture', privacy: 'private', capabilities: { supportsFunctionCalling: true } },
      }] })));
      if (address.startsWith('https://cloud-api.near.ai/v1/model/list')) return Promise.resolve(new Response(JSON.stringify({ models: [{
        modelId: 'dictation-near-fixture', metadata: { providerType: 'vllm', verifiable: true, attestationSupported: true, supportedFeatures: ['tools'] },
      }] })));
      if (['https://api.venice.ai/api/v1/audio/transcriptions', 'https://cloud-api.near.ai/v1/audio/transcriptions'].includes(address)) return fetch(endpoint, options);
      if (address.includes('api.venice.ai') || address.includes('cloud-api.near.ai')) throw new Error('Unexpected provider request in fixture');
      return fetch(url, options);
    };
  }, endpoint);
  const responses = await window.evaluate(async () => {
    const results = [];
    await window.electronAPI.chooseAgentDictation({ providerId: 'openrouter', language: 'de' });
    for (const [providerId, modelId, policy] of [['near-ai', 'dictation-near-fixture', 'tee'], ['venice', 'dictation-venice-fixture', 'private']]) {
      results.push(await window.electronAPI.refreshAgentProviderModels(providerId, 'dictation-fixture-key'));
      results.push(await window.electronAPI.configureHostedAgentProvider(providerId, modelId, 'dictation-fixture-key', policy));
    }
    results.push(await window.electronAPI.setAgentProviderPreferences('openrouter', { privacyPolicy: 'zdr' }));
    return results.map(result => ({ ok: result.ok, error: result.error }));
  });
  expect(responses.every(result => result.ok)).toBe(true);
  await window.locator('#agent-dictation-options').click();
  const menu = window.locator('#agent-dictation-menu');
  await expect(window.locator('#agent-dictation-panel')).toBeHidden();
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitemradio', { name: /OpenRouter/ })).toBeEnabled();
  await expect(menu.getByRole('menuitemradio', { name: /NEAR AI/ })).toBeEnabled();
  await expect(menu.getByRole('menuitemradio', { name: /Venice/ })).toBeEnabled();
  expect(await window.evaluate(() => Boolean(window.dictationTestStream))).toBe(false);
  await menu.getByRole('menuitemradio', { name: /Venice/ }).click();
  await window.locator('#agent-dictation').click();
  await expect(window.locator('#agent-dictation-feedback')).toContainText('Listening · Venice');
  await window.waitForTimeout(650);
  await window.locator('#agent-dictation').click();
  await expect(window.locator('#agent-prompt')).toHaveValue('a small browser game');
  const settings = await openProviderSettings(window);
  await settings.evaluate(() => { location.hash = 'ai/voice'; });
  const voice = settings.locator('#ai-dictation-settings');
  await expect(voice.getByRole('link', { name: /OpenRouter/ })).toContainText('Connected');
  await expect(voice.getByRole('link', { name: /NEAR AI/ })).toContainText('Connected');
  await expect(voice.getByRole('link', { name: /Venice/ })).toContainText('In use');
  for (const theme of ['dark', 'light']) {
    await window.evaluate(theme => window.electronAPI.saveSettings({ theme }), theme);
    await expect(settings.locator('html')).toHaveAttribute('data-theme', theme);
    await settings.screenshot({ path: testInfo.outputPath(`voice-availability-${theme}.png`) });
  }
  await electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(win => win.isVisible());
    win.setMinimumSize(320, 300); win.setContentSize(640, 760);
  });
  expect(await settings.locator('main.content').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  const policies = await window.evaluate(async () => (await window.electronAPI.getAgentProviderStatus()).status.connections.map(item => [item.providerId, item.privacyPolicy]));
  expect(policies).toEqual(expect.arrayContaining([['openrouter', 'zdr'], ['near-ai', 'tee'], ['venice', 'private']]));
});

test('microphone spectrum responds to audio, quiets during silence and respects reduced motion', async ({ window, electronApp }, testInfo) => {
  await prepare(window, electronApp);
  await window.emulateMedia({ reducedMotion: 'no-preference' });
  await window.locator('#agent-prompt').fill('Build');
  await window.locator('#agent-dictation').click();
  const spectrum = window.locator('#agent-dictation-spectrum');
  await expect(spectrum).toHaveAttribute('data-state', 'listening');
  const peak = () => spectrum.locator('span').evaluateAll(bars => Math.max(...bars.map(bar => Number(bar.style.transform.match(/scaleY\(([^)]+)/)?.[1] || 0))));
  await expect.poll(peak).toBeGreaterThan(0.4);
  for (const theme of ['dark', 'light']) {
    await window.evaluate(theme => window.electronAPI.saveSettings({ theme }), theme);
    await expect.poll(() => window.locator('html').getAttribute('data-theme').then(value => value || 'dark')).toBe(theme);
    await window.waitForTimeout(300); // Let the theme's surface-colour transitions settle for the capture.
    await window.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await window.screenshot({ path: testInfo.outputPath(`dictation-spectrum-${theme}.png`) });
  }
  await window.evaluate(() => { window.dictationTestStream.getAudioTracks()[0].enabled = false; });
  await expect.poll(peak).toBeLessThan(0.15);
  await window.emulateMedia({ reducedMotion: 'reduce' });
  expect(await spectrum.locator('span').first().evaluate(bar => getComputedStyle(bar).transform)).toBe('matrix(1, 0, 0, 0.25, 0, 0)');
  await window.keyboard.press('Escape');
  await expect(spectrum).toBeHidden();
  await expect(window.locator('#agent-prompt')).toHaveValue('Build a small browser game');
  await expect(window.locator('#agent-transcript')).toBeHidden();
  expect(await window.evaluate(() => window.dictationTestStream.getTracks().every(track => track.readyState === 'ended'))).toBe(true);
});

test('Return waits for the final audio and sends the completed prompt once; Escape can keep it instead', async ({ window, electronApp }) => {
  await prepare(window, electronApp);
  // Capture only the submission boundary in this disposable profile. Speech
  // still goes through the real worklet, IPC, queue and transcription fixture.
  await electronApp.evaluate(({ ipcMain }) => {
    globalThis.dictationSubmissions = [];
    ipcMain.removeHandler('agent:start');
    ipcMain.handle('agent:start', (_event, request) => {
      globalThis.dictationSubmissions.push(request.prompt);
      return { ok: false, error: { code: 'FIXTURE', message: 'Submission captured by fixture' } };
    });
  });
  const prompt = window.locator('#agent-prompt');
  const startShortcut = process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter';
  await prompt.fill('Build');
  await prompt.press(startShortcut);
  await expect(window.locator('#agent-dictation-feedback')).toContainText('Listening');
  await prompt.press(startShortcut); // Starting again must not finish or submit.
  await expect(window.locator('#agent-dictation-feedback')).toContainText('Listening');
  await prompt.press('Shift+Enter');
  await expect(prompt).toHaveValue('Build\n');
  await window.waitForTimeout(600);
  hold = true;
  await prompt.press('Enter');
  await expect.poll(() => Boolean(heldResponse)).toBe(true);
  await expect(window.locator('#agent-dictation-feedback')).toHaveText('Finishing dictation…');
  expect(await electronApp.evaluate(() => globalThis.dictationSubmissions)).toEqual([]);
  await prompt.press('Enter');
  heldResponse.end(JSON.stringify({ text: 'a final browser game' }));
  await expect.poll(() => electronApp.evaluate(() => globalThis.dictationSubmissions)).toEqual(['Build\na final browser game']);
  await expect(window.locator('#agent-run')).toBeEnabled();
  await prompt.fill('Keep'); hold = false; heldResponse = null;
  await prompt.press(startShortcut);
  await expect(window.locator('#agent-dictation-feedback')).toContainText('Listening');
  await window.waitForTimeout(600); hold = true;
  await prompt.press('Enter');
  await expect.poll(() => Boolean(heldResponse)).toBe(true);
  await prompt.press('Escape');
  heldResponse.end(JSON.stringify({ text: 'these final words' }));
  await expect(prompt).toHaveValue('Keep these final words');
  await expect(window.locator('#agent-run')).toBeEnabled();
  await expect(window.locator('#agent-sidebar')).toBeVisible();
  expect(await electronApp.evaluate(() => globalThis.dictationSubmissions)).toEqual(['Build\na final browser game']);
});
