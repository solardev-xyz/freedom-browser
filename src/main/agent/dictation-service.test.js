const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { pathToFileURL } = require('url');
const { DictationService } = require('./dictation-service');
const { permitsDictationCapture } = require('./dictation-capture');
const frame = (voice = true) => voice ? recording().subarray(44, 3244) : Buffer.alloc(3200);

function recording() {
  const audio = Buffer.alloc(44 + 32000);
  audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40);
  for (let i = 44; i < audio.length; i += 2) audio.writeInt16LE(Math.round(Math.sin(i / 8) * 3000), i);
  return audio;
}

function sender() {
  const owner = new EventEmitter(); owner.getType = () => 'window'; owner.isDestroyed = () => false;
  owner.getURL = () => pathToFileURL(path.resolve(__dirname, '../../renderer/index.html')).href;
  return owner;
}

async function transcribe(service, owner, { id, audio }) {
  service.append(owner, { id, sequence: 0, audio: audio.subarray(44) });
  return service.finish(owner, { id });
}

describe('dictation service', () => {
  let root, service, store, local, owner, fetchImpl, enabled, events;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dictation-test-'));
    enabled = true; owner = sender(); events = [];
    store = { getPublicStatus: jest.fn(() => ({ providerId: 'venice', connections: [
      ...['openai', 'venice', 'near-ai', 'openrouter'].map(providerId => ({ kind: 'hosted', providerId })),
      { kind: 'subscription', providerId: 'openai-chatgpt' }, { kind: 'subscription', providerId: 'anthropic-claude' },
    ] })), getSelection: jest.fn(providerId => ({ kind: 'hosted', providerId, apiKey: 'test-only-credential' })) };
    local = { supported: true, ready: jest.fn(() => true), install: jest.fn(), transcribe: jest.fn(async () => 'Local transcript.') };
    fetchImpl = jest.fn(async () => new Response(JSON.stringify({ text: 'A dictated prompt.' })));
    service = new DictationService({ dataDir: root, providerStore: store, local, fetch: fetchImpl,
      assertEnabled: () => { if (!enabled) throw new Error('off'); }, onEvent: (_sender, event) => events.push(event) });
  });
  afterEach(() => { service.cancelAll(); fs.rmSync(root, { recursive: true, force: true }); });

  const choose = providerId => service.choose({ providerId, language: 'de', requireZeroRetention: providerId !== 'openrouter' });

  test('offers only supported connected API services and an explicit local option', () => {
    expect(service.state().options.map(option => option.providerId)).toEqual(['local', 'openai', 'venice', 'near-ai', 'openrouter']);
    expect(service.state().preferences.providerId).toBe(null);
    choose('venice');
    expect(fs.readFileSync(path.join(root, 'dictation.json'), 'utf8')).not.toContain('credential');
    store.getPublicStatus.mockReturnValue({ connections: [] });
    expect(() => service.begin(owner)).toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('first microphone use remembers the active supported provider without requiring setup', async () => {
    expect(service.state().suggestedProviderId).toBe('venice');
    await transcribe(service, owner, { id: service.begin(owner).id, audio: recording() });
    expect(service.state().preferences).toEqual({ providerId: 'venice', language: 'auto', requireZeroRetention: true });
    expect(fetchImpl.mock.calls[0][0]).toContain('api.venice.ai');
    const reopened = new DictationService({ dataDir: root, providerStore: store, local, assertEnabled: () => {} });
    expect(reopened.state().preferences.providerId).toBe('venice');
  });

  test('an unsupported chat subscription cannot auto-select a service unable to honor retention', async () => {
    store.getPublicStatus.mockReturnValue({ providerId: 'anthropic-claude', connections: [
      { kind: 'subscription', providerId: 'anthropic-claude' },
      { kind: 'hosted', providerId: 'openrouter' },
      { kind: 'hosted', providerId: 'near-ai', privacyPolicy: 'tee' },
    ] });
    expect(service.state().suggestedProviderId).toBe(null);
    expect(() => service.begin(owner)).toThrow('Choose a dictation service');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('automatic selection respects saved choices and never falls back after a saved connection disappears', () => {
    choose('local');
    service.begin(owner);
    expect(service.state().preferences.providerId).toBe('local');
    choose('near-ai');
    service.begin(owner);
    expect(service.state().preferences.providerId).toBe('near-ai');
    store.getPublicStatus.mockReturnValue({ providerId: 'openrouter', connections: [{ kind: 'hosted', providerId: 'openrouter' }] });
    expect(() => service.begin(owner)).toThrow('Choose a dictation service');
    expect(service.state().preferences.providerId).toBe('near-ai');
  });

  test('without a suitable cloud connection first use requires setup rather than downloading or selecting local', () => {
    store.getPublicStatus.mockReturnValue({ providerId: 'openai-chatgpt', connections: [
      { kind: 'subscription', providerId: 'openai-chatgpt' },
      { kind: 'hosted', providerId: 'near-ai', privacyPolicy: 'tee' },
    ] });
    expect(service.state().suggestedProviderId).toBe(null);
    expect(() => service.begin(owner)).toThrow('Choose a dictation service');
    expect(local.install).not.toHaveBeenCalled();
    expect(service.state().preferences.providerId).toBe(null);
  });

  test.each(['venice', 'near-ai'])('%s uploads only validated audio and transcription settings', async providerId => {
    choose(providerId);
    const session = service.begin(owner);
    expect(permitsDictationCapture(owner, { mediaTypes: ['audio'] })).toBe(true);
    await expect(transcribe(service, owner, { id: session.id, audio: recording() })).resolves.toMatchObject({ text: 'A dictated prompt.', providerId });
    const [url, request] = fetchImpl.mock.calls[0];
    expect(url).toContain('/audio/transcriptions');
    expect(request.redirect).toBe('error');
    expect(request.headers.Authorization).toBe('Bearer test-only-credential');
    expect(request.body.get('file').type).toBe('audio/wav');
    expect([...request.body.keys()].sort()).toEqual(['file', providerId === 'openai' ? 'languages[]' : 'language', 'model', 'response_format'].sort());
    expect(permitsDictationCapture(owner, { mediaTypes: ['audio'] })).toBe(false);
    expect(owner.listenerCount('destroyed')).toBe(0);
  });

  test('explicit standard OpenRouter dictation sends audio without conversation context or unsupported policy flags', async () => {
    choose('openrouter');
    await transcribe(service, owner, { id: service.begin(owner).id, audio: recording() });
    const request = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(request.provider).toBeUndefined();
    expect(request.input_audio.format).toBe('wav');
    expect(Buffer.from(request.input_audio.data, 'base64')).toEqual(recording());
    expect(Object.keys(request).sort()).toEqual(['model', 'input_audio', 'language', 'response_format'].sort());
  });

  test('a ZDR-only connection remains enforced even when dictation preferences request standard routing', async () => {
    store.getPublicStatus.mockReturnValue({ connections: [{ providerId: 'openrouter', kind: 'hosted', privacyPolicy: 'zdr' }] });
    expect(() => service.choose({ providerId: 'openrouter', language: 'auto', requireZeroRetention: false })).toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('the owning recording is single-use and cannot be consumed by another sender', async () => {
    choose('venice'); const session = service.begin(owner);
    await expect(transcribe(service, sender(), { id: session.id, audio: recording() })).rejects.toMatchObject({ code: 'DICTATION_EXPIRED' });
    await transcribe(service, owner, { id: session.id, audio: recording() });
    await expect(transcribe(service, owner, { id: session.id, audio: recording() })).rejects.toMatchObject({ code: 'DICTATION_EXPIRED' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('cancel aborts a pending request and cannot return a late transcript', async () => {
    choose('venice');
    let resolve;
    fetchImpl.mockImplementation(() => new Promise(done => { resolve = done; }));
    const pending = transcribe(service, owner, { id: service.begin(owner).id, audio: recording() });
    await Promise.resolve(); await Promise.resolve();
    service.cancel(owner);
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
    resolve(new Response(JSON.stringify({ text: 'Late text must not be inserted.' })));
    await expect(pending).rejects.toThrow();
    expect(service.sessions.size).toBe(0);
  });

  test('AI disable, sender destruction and connection removal revoke authority', async () => {
    choose('venice'); service.begin(owner); owner.emit('destroyed');
    expect(permitsDictationCapture(owner, { mediaTypes: ['audio'] })).toBe(false);
    const session = service.begin(owner);
    store.getSelection.mockReturnValue(null);
    await expect(transcribe(service, owner, { id: session.id, audio: recording() })).rejects.toMatchObject({ code: 'DICTATION_SETUP' });
    enabled = false;
    expect(() => service.begin(owner)).toThrow('off');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('local transcription uses no model-provider request', async () => {
    choose('local');
    const audio = recording();
    await expect(transcribe(service, owner, { id: service.begin(owner).id, audio })).resolves.toMatchObject({ text: 'Local transcript.' });
    expect(local.transcribe).toHaveBeenCalledWith(audio, 'de', expect.any(AbortSignal));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each(['venice', 'near-ai', 'openrouter', 'local'])('%s emits phrases before Stop and finalizes without transcribing audio twice', async providerId => {
    choose(providerId);
    const session = service.begin(owner);
    let sequence = 0;
    for (let i = 0; i < 10; i++) service.append(owner, { id: session.id, sequence: sequence++, audio: frame() });
    for (let i = 0; i < 6; i++) service.append(owner, { id: session.id, sequence: sequence++, audio: frame(false) });
    await service.sessions.get(owner).pending;
    expect(events.find(event => event.type === 'transcript')).toMatchObject({ id: session.id,
      text: providerId === 'local' ? 'Local transcript.' : 'A dictated prompt.' });
    expect(permitsDictationCapture(owner, { mediaTypes: ['audio'] })).toBe(true);
    const result = await service.finish(owner, { id: session.id });
    expect(result.text).toBe(providerId === 'local' ? 'Local transcript.' : 'A dictated prompt.');
    expect(providerId === 'local' ? local.transcribe : fetchImpl).toHaveBeenCalledTimes(1);
    expect(permitsDictationCapture(owner, { mediaTypes: ['audio'] })).toBe(false);
  });

  test('streaming frames are owned, sequential, bounded and revoked when a connection policy changes', () => {
    choose('venice'); const session = service.begin(owner);
    const append = (who, sequence, audio = frame()) => service.append(who, { id: session.id, sequence, audio });
    expect(() => append(sender(), 0)).toThrow('recording has ended');
    append(owner, 0);
    expect(() => append(owner, 0)).toThrow('could not be read');
    expect(() => append(owner, 1, new Uint8Array(100000))).toThrow('could not be read');
    store.getPublicStatus.mockReturnValue({ connections: [{ kind: 'hosted', providerId: 'venice', privacyPolicy: 'tee' }] });
    service.connectionsChanged();
    expect(() => append(owner, 1)).toThrow('recording has ended');
    expect(permitsDictationCapture(owner, { mediaTypes: ['audio'] })).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('a cancelled phrase cannot publish late text', async () => {
    choose('venice'); const session = service.begin(owner);
    let resolve;
    fetchImpl.mockImplementation(() => new Promise(done => { resolve = done; }));
    for (let i = 0; i < 60; i++) service.append(owner, { id: session.id, sequence: i, audio: frame() });
    const pending = service.sessions.get(owner).pending;
    await Promise.resolve(); await Promise.resolve();
    service.cancel(owner); resolve(new Response(JSON.stringify({ text: 'late' })));
    await pending;
    expect(events.some(event => event.type === 'transcript')).toBe(false);
    expect(service.sessions.size).toBe(0);
  });

  test('shutdown drains cancelled native work before its temporary audio cleanup is considered complete', async () => {
    choose('local'); const session = service.begin(owner); let cleaned = false;
    local.transcribe.mockImplementation((_audio, _language, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => setTimeout(() => { cleaned = true; reject(new Error('cancelled')); }, 5), { once: true });
    }));
    for (let i = 0; i < 60; i++) service.append(owner, { id: session.id, sequence: i, audio: frame() });
    await Promise.resolve(); await Promise.resolve();
    service.cancelAll();
    expect(cleaned).toBe(false); await service.drain(); expect(cleaned).toBe(true);
  });

  test('invalid audio, silence, oversized responses and provider errors fail without leaking response bodies', async () => {
    choose('venice');
    const silent = recording(); silent.fill(0, 44);
    await expect(transcribe(service, owner, { id: service.begin(owner).id, audio: silent })).rejects.toThrow('No speech');
    fetchImpl.mockResolvedValue(new Response('private upstream body with a credential', { status: 401 }));
    await expect(transcribe(service, owner, { id: service.begin(owner).id, audio: recording() })).rejects.toThrow('did not accept');
    fetchImpl.mockResolvedValue(new Response('x'.repeat(270000)));
    await expect(transcribe(service, owner, { id: service.begin(owner).id, audio: recording() })).rejects.toThrow('too large');
    fetchImpl.mockResolvedValue(new Response('{"wrong":"value"}'));
    await expect(transcribe(service, owner, { id: service.begin(owner).id, audio: recording() })).rejects.toThrow('usable transcript');
  });

  test('OpenRouter dictation refuses zero retention instead of sending ignored routing flags', () => {
    expect(() => service.choose({ providerId: 'openrouter', language: 'auto', requireZeroRetention: true })).toThrow();
    expect(service.state().options.find(option => option.providerId === 'openrouter')).toMatchObject({ available: false });
    service.choose({ providerId: 'openrouter', language: 'auto', requireZeroRetention: false });
    service.choose({ requireZeroRetention: true });
    expect(() => service.begin(owner)).toThrow('Choose a dictation service');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('language-only changes preserve an unavailable remembered destination', () => {
    choose('near-ai');
    store.getPublicStatus.mockReturnValue({ connections: [{ kind: 'hosted', providerId: 'openrouter' }] });
    service.choose({ language: 'fr' });
    expect(service.state().preferences).toEqual({ providerId: 'near-ai', language: 'fr', requireZeroRetention: true });
    expect(() => service.begin(owner)).toThrow('Choose a dictation service');
  });

  test('preference saves leave installs and unaffected recordings alone but revoke affected capture', async () => {
    let finishInstall;
    local.install.mockImplementation(signal => new Promise(resolve => { finishInstall = () => { expect(signal.aborted).toBe(false); resolve(); }; }));
    const installing = service.install(sender());
    const capture = service.begin(owner);
    service.choose({ language: 'auto' });
    expect(service.sessions.get(owner).id).toBe(capture.id);
    service.choose({ language: 'de' });
    expect(service.sessions.has(owner)).toBe(false);
    expect(events.find(event => event.type === 'error').message).toContain('settings changed');
    finishInstall(); await installing;
  });

  test('frames do not perform credential reads, while provider changes revoke capture immediately', () => {
    choose('venice'); const session = service.begin(owner);
    store.getSelection.mockClear(); store.getPublicStatus.mockClear(); local.ready.mockClear();
    for (let i = 0; i < 5; i++) service.append(owner, { id: session.id, sequence: i, audio: frame() });
    expect(store.getSelection).not.toHaveBeenCalled(); expect(local.ready).not.toHaveBeenCalled();
    store.getSelection.mockReturnValue(null);
    service.connectionsChanged();
    expect(permitsDictationCapture(owner, { mediaTypes: ['audio'] })).toBe(false);
  });

  test('a Stop flush failure aborts queued uploads before ending the session', async () => {
    choose('venice'); const session = service.begin(owner);
    const active = service.sessions.get(owner);
    let resolveUpload;
    fetchImpl.mockImplementation(() => new Promise(resolve => { resolveUpload = resolve; }));
    for (let i = 0; i < 480; i++) service.append(owner, { id: session.id, sequence: i, audio: frame() });
    service.append(owner, { id: session.id, sequence: 480, audio: frame() });
    await Promise.resolve(); await Promise.resolve();
    await expect(service.finish(owner, { id: session.id })).rejects.toMatchObject({ code: 'DICTATION_BUSY' });
    expect(active.controller.signal.aborted).toBe(true);
    resolveUpload(new Response(JSON.stringify({ text: 'late' }))); await service.drain();
    expect(fetchImpl).toHaveBeenCalledTimes(1); expect(events.some(event => event.type === 'transcript')).toBe(false);
  });

  test('a TEE-only connection cannot silently downgrade audio requests', () => {
    store.getPublicStatus.mockReturnValue({ connections: [{ kind: 'hosted', providerId: 'venice', privacyPolicy: 'tee' }] });
    expect(service.state().options.find(option => option.providerId === 'venice').available).toBe(false);
    expect(() => choose('venice')).toThrow();
  });
});

module.exports = { recording };


test('chat-only mutations and unrelated retention preferences keep an active speech connection', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dictation-identity-test-'));
  const owner = sender();
  const store = { getPublicStatus: () => ({ connections: [{ kind: 'hosted', providerId: 'venice' }] }),
    getSelection: jest.fn(() => ({ kind: 'hosted', apiKey: 'fixture-key', modelId: 'first' })) };
  const service = new DictationService({ dataDir: root, providerStore: store, local: { supported: true, ready: () => true }, assertEnabled() {} });
  try {
    const capture = service.begin(owner);
    service.choose({ requireZeroRetention: false });
    store.getSelection.mockReturnValue({ kind: 'hosted', apiKey: 'fixture-key', modelId: 'second', favoriteModelIds: ['other'] });
    service.connectionsChanged();
    expect(service.sessions.get(owner).id).toBe(capture.id);
    store.getSelection.mockReturnValue({ kind: 'hosted', apiKey: 'new-fixture-key' });
    service.connectionsChanged();
    expect(service.sessions.has(owner)).toBe(false);
  } finally { service.cancelAll(); fs.rmSync(root, { recursive: true, force: true }); }
});
