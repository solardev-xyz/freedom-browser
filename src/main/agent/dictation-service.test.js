const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { pathToFileURL } = require('url');
const { DictationService, validateAudio } = require('./dictation-service');
const { permitsDictationCapture } = require('./dictation-capture');

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

  const choose = providerId => service.choose({ providerId, language: 'de', requireZeroRetention: true });

  test('offers only supported connected API services and an explicit local option', () => {
    expect(service.state().options.map(option => option.providerId)).toEqual(['local', 'openai', 'venice', 'near-ai', 'openrouter']);
    expect(service.state().preferences.providerId).toBe(null);
    expect(() => service.begin(owner)).toThrow('Choose a dictation service');
    choose('venice');
    expect(fs.readFileSync(path.join(root, 'dictation.json'), 'utf8')).not.toContain('credential');
    store.getPublicStatus.mockReturnValue({ connections: [] });
    expect(() => service.begin(owner)).toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each(['openai', 'venice', 'near-ai'])('%s uploads only validated audio and transcription settings', async providerId => {
    choose(providerId);
    const session = service.begin(owner);
    expect(permitsDictationCapture(owner, { mediaTypes: ['audio'] })).toBe(true);
    await expect(service.transcribe(owner, { id: session.id, audio: recording() })).resolves.toMatchObject({ text: 'A dictated prompt.', providerId });
    const [url, request] = fetchImpl.mock.calls[0];
    expect(url).toContain('/audio/transcriptions');
    expect(request.redirect).toBe('error');
    expect(request.headers.Authorization).toBe('Bearer test-only-credential');
    expect(request.body.get('file').type).toBe('audio/wav');
    expect([...request.body.keys()].sort()).toEqual(['file', providerId === 'openai' ? 'languages[]' : 'language', 'model', 'response_format'].sort());
    expect(permitsDictationCapture(owner, { mediaTypes: ['audio'] })).toBe(false);
    expect(owner.listenerCount('destroyed')).toBe(0);
  });

  test('OpenRouter explicitly requires zero-retention routing and sends no conversation context', async () => {
    choose('openrouter');
    await service.transcribe(owner, { id: service.begin(owner).id, audio: recording() });
    const request = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(request.provider).toEqual({ zdr: true });
    expect(request.input_audio.format).toBe('wav');
    expect(Buffer.from(request.input_audio.data, 'base64')).toEqual(recording());
    expect(Object.keys(request).sort()).toEqual(['model', 'input_audio', 'language', 'provider', 'response_format'].sort());
  });

  test('a ZDR-only connection remains enforced even when dictation preferences request standard routing', async () => {
    store.getPublicStatus.mockReturnValue({ connections: [{ providerId: 'openrouter', kind: 'hosted', privacyPolicy: 'zdr' }] });
    service.choose({ providerId: 'openrouter', language: 'auto', requireZeroRetention: false });
    await service.transcribe(owner, { id: service.begin(owner).id, audio: recording() });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).provider.zdr).toBe(true);
  });

  test('the owning recording is single-use and cannot be consumed by another sender', async () => {
    choose('venice'); const session = service.begin(owner);
    await expect(service.transcribe(sender(), { id: session.id, audio: recording() })).rejects.toMatchObject({ code: 'DICTATION_EXPIRED' });
    await service.transcribe(owner, { id: session.id, audio: recording() });
    await expect(service.transcribe(owner, { id: session.id, audio: recording() })).rejects.toMatchObject({ code: 'DICTATION_EXPIRED' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('cancel aborts a pending request and cannot return a late transcript', async () => {
    choose('venice');
    let resolve;
    fetchImpl.mockImplementation(() => new Promise(done => { resolve = done; }));
    const pending = service.transcribe(owner, { id: service.begin(owner).id, audio: recording() });
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
    await expect(service.transcribe(owner, { id: session.id, audio: recording() })).rejects.toMatchObject({ code: 'DICTATION_SETUP' });
    enabled = false;
    expect(() => service.begin(owner)).toThrow('off');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('local transcription uses no model-provider request', async () => {
    choose('local');
    const audio = recording();
    await expect(service.transcribe(owner, { id: service.begin(owner).id, audio })).resolves.toMatchObject({ text: 'Local transcript.' });
    expect(local.transcribe).toHaveBeenCalledWith(audio, 'de', expect.any(AbortSignal));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('invalid audio, silence, oversized responses and provider errors fail without leaking response bodies', async () => {
    choose('venice');
    const malformed = recording(); malformed.writeUInt16LE(2, 22);
    expect(() => validateAudio(malformed)).toThrow();
    const silent = recording(); silent.fill(0, 44);
    expect(() => validateAudio(silent)).toThrow('No speech');
    fetchImpl.mockResolvedValue(new Response('private upstream body with a credential', { status: 401 }));
    await expect(service.transcribe(owner, { id: service.begin(owner).id, audio: recording() })).rejects.toThrow('did not accept');
    fetchImpl.mockResolvedValue(new Response('x'.repeat(270000)));
    await expect(service.transcribe(owner, { id: service.begin(owner).id, audio: recording() })).rejects.toThrow('too large');
    fetchImpl.mockResolvedValue(new Response('{"wrong":"value"}'));
    await expect(service.transcribe(owner, { id: service.begin(owner).id, audio: recording() })).rejects.toThrow('usable transcript');
  });

  test('a TEE-only connection cannot silently downgrade audio requests', () => {
    store.getPublicStatus.mockReturnValue({ connections: [{ kind: 'hosted', providerId: 'venice', privacyPolicy: 'tee' }] });
    expect(service.state().options.find(option => option.providerId === 'venice').available).toBe(false);
    expect(() => choose('venice')).toThrow();
  });
});

module.exports = { recording };
