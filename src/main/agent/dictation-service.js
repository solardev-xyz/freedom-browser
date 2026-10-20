'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { grantDictationCapture, revokeDictationCapture } = require('./dictation-capture');

const LANGUAGES = Object.freeze(['auto', 'en', 'de', 'es', 'fr', 'it', 'pt', 'nl', 'pl', 'ja', 'zh', 'ko', 'uk']);
const CLOUD = Object.freeze({
  openai: { name: 'OpenAI', url: 'https://api.openai.com/v1/audio/transcriptions', model: 'gpt-transcribe', price: 'About $0.0045 per minute' },
  openrouter: { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1/audio/transcriptions', model: 'openai/whisper-large-v3', price: 'Usage billed to OpenRouter' },
  venice: { name: 'Venice', url: 'https://api.venice.ai/api/v1/audio/transcriptions', model: 'openai/whisper-large-v3', price: 'About $0.006 per minute' },
  'near-ai': { name: 'NEAR AI', url: 'https://cloud-api.near.ai/v1/audio/transcriptions', model: 'openai/whisper-large-v3', price: 'Usage billed to NEAR AI' },
});
const MAX_AUDIO_BYTES = 44 + 16000 * 2 * 120;
const MAX_TEXT = 32000;

function dictationError(code, message) {
  return Object.assign(new Error(message), { code });
}

function validateAudio(value) {
  if (!(value instanceof Uint8Array) || value.byteLength < 3244 || value.byteLength > MAX_AUDIO_BYTES)
    throw dictationError('DICTATION_AUDIO', 'Record between a moment and two minutes of speech.');
  const audio = Buffer.from(value);
  if (audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE' ||
      audio.toString('ascii', 12, 16) !== 'fmt ' || audio.readUInt32LE(16) !== 16 ||
      audio.readUInt16LE(20) !== 1 || audio.readUInt16LE(22) !== 1 ||
      audio.readUInt32LE(24) !== 16000 || audio.readUInt32LE(28) !== 32000 ||
      audio.readUInt16LE(32) !== 2 || audio.readUInt16LE(34) !== 16 ||
      audio.toString('ascii', 36, 40) !== 'data' || audio.readUInt32LE(40) !== audio.length - 44 ||
      audio.readUInt32LE(4) !== audio.length - 8 || audio.length % 2)
    throw dictationError('DICTATION_AUDIO', 'The recording could not be read. Please record again.');
  let energy = 0;
  for (let offset = 44; offset < audio.length; offset += 2) energy += audio.readInt16LE(offset) ** 2;
  if (Math.sqrt(energy / ((audio.length - 44) / 2)) < 20)
    throw dictationError('DICTATION_SILENCE', 'No speech detected. Check your microphone and try again.');
  return audio;
}

async function readTranscript(response) {
  if (!response.ok) {
    await response.body?.cancel?.();
    const message = [401, 403].includes(response.status) ? 'The transcription service did not accept this connection. Check it in Settings → AI.'
      : response.status === 429 ? 'The transcription service is busy or has reached its usage limit. Please try again.'
      : 'Transcription failed. Check the service connection, model access and balance, then try again.';
    throw dictationError('DICTATION_PROVIDER', message);
  }
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 256 * 1024) throw dictationError('DICTATION_RESPONSE', 'The transcription response was too large. Try a shorter recording.');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  let text;
  try { text = JSON.parse(Buffer.concat(chunks).toString('utf8')).text; } catch { /* A malformed response is never a transcript. */ }
  if (typeof text !== 'string' || text.length > MAX_TEXT)
    throw dictationError('DICTATION_RESPONSE', 'The service did not return a usable transcript. Please try again.');
  if (!text.trim()) throw dictationError('DICTATION_SILENCE', 'No speech detected. Please try again.');
  return text.trim();
}

class DictationService {
  constructor({ dataDir, providerStore, local, fetch: fetchImpl = globalThis.fetch, assertEnabled, onEvent = () => {} }) {
    this.file = path.join(dataDir, 'dictation.json');
    this.providerStore = providerStore;
    this.local = local;
    this.fetch = fetchImpl;
    this.assertEnabled = assertEnabled;
    this.onEvent = onEvent;
    this.sessions = new Map();
    this.installations = new Map();
    this.preferences = { providerId: null, language: 'auto', requireZeroRetention: true };
    try {
      const stat = fs.lstatSync(this.file);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size < 4096) {
        const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if ((saved.providerId === 'local' || Object.hasOwn(CLOUD, saved.providerId)) && LANGUAGES.includes(saved.language))
          this.preferences = { providerId: saved.providerId, language: saved.language, requireZeroRetention: saved.requireZeroRetention !== false };
      }
    } catch { /* First use, or an invalid preference: ask for a fresh choice. */ }
  }

  state() {
    this.assertEnabled();
    const status = this.providerStore.getPublicStatus();
    const options = [{ providerId: 'local', name: 'On this device', model: 'Whisper Base',
      available: this.local.supported, ready: this.local.ready(),
      detail: 'Audio stays on this device. One-time download of about 230 MB.', price: 'No usage charges' }];
    for (const connection of status.connections) {
      const provider = CLOUD[connection.providerId];
      if (!provider || connection.kind !== 'hosted') continue;
      const allowed = connection.privacyPolicy !== 'tee';
      options.push({ providerId: connection.providerId, name: provider.name, model: provider.model,
        available: allowed, ready: true, price: provider.price,
        requireZeroRetention: connection.privacyPolicy === 'zdr',
        detail: allowed ? `Audio is sent to ${provider.name} over HTTPS. Chat end-to-end encryption does not cover dictation.`
          : 'Dictation does not meet this connection’s TEE-only policy.' });
    }
    const connected = options.filter(option => option.providerId !== 'local' && option.available && option.ready);
    return { preferences: { ...this.preferences }, options, languages: [...LANGUAGES],
      suggestedProviderId: (connected.find(option => option.providerId === status.providerId) || connected[0])?.providerId || null };
  }

  choose(input) {
    this.assertEnabled();
    if (!input || !LANGUAGES.includes(input.language) || typeof input.requireZeroRetention !== 'boolean' ||
        !this.state().options.some(option => option.providerId === input.providerId && option.available))
      throw dictationError('DICTATION_CHOICE', 'Choose an available dictation service and language.');
    this.cancelAll();
    this.preferences = { providerId: input.providerId, language: input.language, requireZeroRetention: input.requireZeroRetention };
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.preferences), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, this.file);
    return this.state();
  }

  async install(sender) {
    this.assertEnabled();
    if (this.installations.size) throw dictationError('DICTATION_BUSY', 'A local dictation download is already in progress.');
    const controller = new AbortController();
    const destroyed = () => controller.abort();
    sender.once?.('destroyed', destroyed);
    this.installations.set(sender, controller);
    try {
      await this.local.install(controller.signal, progress => this.onEvent(sender, { type: 'download', ...progress }));
      this.assertEnabled();
      return this.state();
    } finally {
      sender.off?.('destroyed', destroyed);
      this.installations.delete(sender);
    }
  }

  begin(sender) {
    this.assertEnabled();
    this.cancel(sender);
    const state = this.state();
    const providerId = this.preferences.providerId || state.suggestedProviderId;
    const option = state.options.find(option => option.providerId === providerId && option.available && option.ready);
    if (!option) throw dictationError('DICTATION_SETUP', 'Choose a dictation service or download the local model first.');
    if (!this.preferences.providerId) this.choose({ ...this.preferences, providerId });
    const id = randomUUID();
    const controller = new AbortController();
    const session = { id, controller, preferences: { ...this.preferences }, recording: true };
    session.destroyed = () => this.cancel(sender);
    session.timeout = setTimeout(() => this.cancel(sender), 3 * 60_000);
    session.timeout.unref?.();
    sender.once?.('destroyed', session.destroyed);
    this.sessions.set(sender, session);
    grantDictationCapture(sender, id);
    return { id, name: option.name, local: option.providerId === 'local' };
  }

  async transcribe(sender, payload) {
    this.assertEnabled();
    const session = this.sessions.get(sender);
    if (!session || session.id !== payload?.id || !session.recording)
      throw dictationError('DICTATION_EXPIRED', 'This recording has ended. Please start again.');
    session.recording = false;
    revokeDictationCapture(sender, session.id);
    try {
      const audio = validateAudio(payload.audio);
      const { providerId, language, requireZeroRetention } = session.preferences;
      const signal = AbortSignal.any([session.controller.signal, AbortSignal.timeout(120000)]);
      let text;
      if (providerId === 'local') text = await this.local.transcribe(audio, language, signal);
      else {
        const provider = CLOUD[providerId];
        const connection = this.providerStore.getSelection(providerId);
        const currentOption = this.state().options.find(option => option.providerId === providerId && option.available);
        if (connection?.kind !== 'hosted' || !connection.apiKey ||
            !currentOption)
          throw dictationError('DICTATION_SETUP', 'The dictation connection changed. Choose a service again.');
        let body;
        const headers = { Authorization: `Bearer ${connection.apiKey}` };
        if (providerId === 'openrouter') {
          headers['Content-Type'] = 'application/json';
          body = JSON.stringify({ model: provider.model, input_audio: { data: audio.toString('base64'), format: 'wav' },
            ...(language !== 'auto' && { language }), provider: { zdr: requireZeroRetention || currentOption.requireZeroRetention === true }, response_format: 'json' });
        } else {
          body = new FormData();
          body.set('model', provider.model);
          if (language !== 'auto') body.set(providerId === 'openai' ? 'languages[]' : 'language', language);
          body.set('response_format', 'json');
          body.set('file', new Blob([audio], { type: 'audio/wav' }), 'dictation.wav');
        }
        text = await readTranscript(await this.fetch(provider.url, { method: 'POST', headers, body, signal, redirect: 'error' }));
      }
      signal.throwIfAborted();
      this.assertEnabled();
      if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT)
        throw dictationError('DICTATION_RESPONSE', 'No usable speech was returned. Please try again.');
      return { text: text.trim(), providerId };
    } finally { this.end(sender, session); }
  }

  end(sender, session) {
    if (this.sessions.get(sender) !== session) return;
    clearTimeout(session.timeout);
    sender.off?.('destroyed', session.destroyed);
    revokeDictationCapture(sender, session.id);
    this.sessions.delete(sender);
  }

  cancel(sender) {
    this.installations.get(sender)?.abort();
    const session = this.sessions.get(sender);
    if (!session) return;
    session.controller.abort();
    this.end(sender, session);
    this.onEvent(sender, { type: 'cancelled', id: session.id });
  }

  cancelAll() {
    for (const controller of this.installations.values()) controller.abort();
    for (const sender of this.sessions.keys()) this.cancel(sender);
  }
}

module.exports = { DictationService, LANGUAGES, CLOUD, validateAudio, dictationError };
