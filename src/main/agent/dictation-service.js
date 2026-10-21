'use strict';

const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { grantDictationCapture, revokeDictationCapture } = require('./dictation-capture');
const { DictationSegments, pcmToWav } = require('./dictation-segments');
const { DictationRealtime } = require('./dictation-realtime');

const LANGUAGES = Object.freeze(['auto', 'en', 'de', 'es', 'fr', 'it', 'pt', 'nl', 'pl', 'ja', 'zh', 'ko', 'uk']);
const CLOUD = Object.freeze({
  openai: { name: 'OpenAI', price: 'Live dictation: about $0.017 per minute' },
  openrouter: { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1/audio/transcriptions', model: 'openai/whisper-large-v3', price: 'Usage billed to OpenRouter' },
  // Classification of these exact speech models/endpoints, not inherited from
  // the selected chat model. Provider claims, not independent audio attestation.
  // Checked 2026-10-21: docs.venice.ai/models/speech-to-text and
  // docs.near.ai/cloud/guides/specialized-endpoints.
  venice: { name: 'Venice', url: 'https://api.venice.ai/api/v1/audio/transcriptions', model: 'openai/whisper-large-v3', privacy: 'private', price: 'About $0.006 per minute' },
  'near-ai': { name: 'NEAR AI', url: 'https://cloud-api.near.ai/v1/audio/transcriptions', model: 'openai/whisper-large-v3', privacy: 'tee', price: 'Usage billed to NEAR AI' },
});
const MAX_TEXT = 32000;

function dictationError(code, message) {
  return Object.assign(new Error(message), { code });
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
  constructor({ dataDir, providerStore, local, fetch: fetchImpl = globalThis.fetch, assertEnabled, onEvent = () => {},
    createRealtime = options => new DictationRealtime(options) }) {
    this.file = path.join(dataDir, 'dictation.json');
    this.providerStore = providerStore;
    this.local = local;
    this.fetch = fetchImpl;
    this.assertEnabled = assertEnabled;
    this.onEvent = onEvent;
    this.createRealtime = createRealtime;
    this.sessions = new Map();
    this.operations = new Set();
    this.installations = new Map();
    this.preferences = { providerId: null, language: 'auto', openrouterAudioConsent: false };
    try {
      const stat = fs.lstatSync(this.file);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size < 4096) {
        const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if ((saved.providerId === null || saved.providerId === 'local' || Object.hasOwn(CLOUD, saved.providerId)) && LANGUAGES.includes(saved.language))
          this.preferences = { providerId: saved.providerId, language: saved.language, openrouterAudioConsent: saved.openrouterAudioConsent === true };
        // Legacy retention flags describe the former coupled policy, not consent
        // to send audio. Require a dedicated acknowledgement after migration.
      }
    } catch { /* First use, or an invalid preference: ask for a fresh choice. */ }
  }

  state(preferences = this.preferences) {
    this.assertEnabled();
    const status = this.providerStore.getPublicStatus();
    const options = [{ providerId: 'local', name: 'On this device', model: 'Whisper Base',
      available: this.local.supported, ready: this.local.ready(),
      detail: 'Audio stays on this device. One-time download of about 230 MB.', price: 'No usage charges' }];
    for (const connection of status.connections) {
      const provider = CLOUD[connection.providerId];
      if (!provider || connection.kind !== 'hosted') continue;
      const privacyDetail = provider.privacy === 'tee'
        ? 'NEAR AI reports that this speech model runs in a TEE. Freedom has not independently verified audio requests.'
        : provider.privacy === 'private' ? 'Venice classifies this speech model as Private. This is a provider claim.' : '';
      options.push({ providerId: connection.providerId, name: provider.name, model: connection.providerId === 'openai' ? 'gpt-live-transcribe' : provider.model,
        available: true, ready: true, price: provider.price,
        privacyClassification: provider.privacy || null,
        consentRequired: connection.providerId === 'openrouter' && preferences.openrouterAudioConsent !== true,
        ...(connection.providerId === 'openrouter' && { consentDisclosure: 'Audio is sent to OpenRouter using standard routing. Zero data retention is unavailable for dictation. Your chat privacy settings do not apply to audio. Usage is billed to OpenRouter.' }),
        detail: `Audio is sent to ${provider.name} while you speak. ${privacyDetail ? `${privacyDetail} ` : ''}Chat end-to-end encryption does not cover dictation.` });
    }
    const connected = options.filter(option => option.providerId !== 'local' && option.available && option.ready);
    return { preferences: { ...this.preferences }, options, languages: [...LANGUAGES],
      suggestedProviderId: (connected.find(option => option.providerId === status.providerId) || connected[0])?.providerId || null };
  }

  choose(input) {
    this.assertEnabled();
    const next = { ...this.preferences, ...input };
    const selecting = input && Object.hasOwn(input, 'providerId');
    if (!input || !LANGUAGES.includes(next.language) || (input.acceptOpenRouterAudio !== undefined && (input.acceptOpenRouterAudio !== true || input.providerId !== 'openrouter')) ||
        (selecting && !this.state(next).options.some(option => option.providerId === next.providerId && option.available)))
      throw dictationError('DICTATION_CHOICE', 'Choose an available dictation service and language.');
    const preferences = { providerId: next.providerId, language: next.language,
      openrouterAudioConsent: this.preferences.openrouterAudioConsent || input.acceptOpenRouterAudio === true };
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(preferences), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, this.file);
    this.preferences = preferences;
    // Preference edits never cancel an independent model installation, and a
    // no-op first-use save must not interrupt another window's recording.
    for (const [sender, session] of this.sessions) {
      if (session.preferences.providerId !== preferences.providerId ||
          session.preferences.language !== preferences.language)
        this.failSession(sender, session, dictationError('DICTATION_CHANGED', 'Dictation settings changed.'));
    }
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
    if (option.consentRequired) throw dictationError('DICTATION_CONSENT', 'Review OpenRouter audio privacy before recording.');
    if (!this.preferences.providerId) this.choose({ ...this.preferences, providerId });
    const id = randomUUID();
    const controller = new AbortController();
    const session = { id, controller, preferences: { ...this.preferences }, recording: true,
      sampleRate: providerId === 'openai' ? 24000 : 16000, sequence: 0, bytes: 0, pending: Promise.resolve(),
      queued: 0, text: '', stableText: '',
      connectionFingerprint: providerId === 'local' ? null : this.connectionFingerprint(providerId) };
    const publish = result => {
      if (controller.signal.aborted || this.sessions.get(sender) !== session) return;
      session.text = result.text; session.stableText = result.stableText;
      this.onEvent(sender, { type: 'transcript', id, ...result });
    };
    const enqueue = task => {
      if (session.queued >= 100) throw dictationError('DICTATION_BUSY', 'Transcription cannot keep up. Please finish and try again.');
      session.queued += 1;
      session.pending = session.pending.then(async () => {
        controller.signal.throwIfAborted();
        await task();
      }).catch(error => this.failSession(sender, session, error)).finally(() => { session.queued -= 1; });
      const operation = session.pending;
      this.operations.add(operation);
      operation.then(() => this.operations.delete(operation), () => this.operations.delete(operation));
    };
    session.segments = new DictationSegments({ sampleRate: session.sampleRate,
      onAudio: providerId === 'openai' ? pcm => {
        if (!session.live) {
          const connection = this.connection('openai');
          session.live = this.createRealtime({ apiKey: connection.apiKey, language: session.preferences.language,
            signal: controller.signal, onTranscript: publish, onError: error => this.failSession(sender, session, error) });
        }
        enqueue(() => session.live.append(pcm));
      } : undefined,
      onSegment: pcm => {
        if (providerId === 'openai') enqueue(() => session.live.commit());
        else {
          if (session.queued >= 8) throw dictationError('DICTATION_BUSY', 'Transcription cannot keep up. Please finish and try again.');
          enqueue(async () => {
            let text;
            try { text = await this.transcribeAudio(pcmToWav(pcm), session.preferences, controller.signal); }
            catch (error) { if (error.code === 'DICTATION_SILENCE') return; throw error; }
            controller.signal.throwIfAborted();
            text = [session.stableText, text].filter(Boolean).join(' ');
            if (text.length > MAX_TEXT) throw dictationError('DICTATION_RESPONSE', 'The transcript is too long. Please finish this recording.');
            publish({ text, stableText: text });
          });
        }
      } });
    session.destroyed = () => this.cancel(sender);
    session.timeout = setTimeout(() => this.cancel(sender), 3 * 60_000);
    session.timeout.unref?.();
    sender.once?.('destroyed', session.destroyed);
    this.sessions.set(sender, session);
    grantDictationCapture(sender, id);
    return { id, name: option.name, local: option.providerId === 'local', sampleRate: session.sampleRate,
      mode: providerId === 'openai' ? 'live' : 'phrases' };
  }

  connection(providerId) {
    if (providerId === 'openrouter' && !this.preferences.openrouterAudioConsent)
      throw dictationError('DICTATION_CONSENT', 'Review OpenRouter audio privacy before recording.');
    const connection = this.providerStore.getSelection(providerId);
    if (connection?.kind !== 'hosted' || !connection.apiKey ||
        !this.state().options.some(option => option.providerId === providerId && option.available))
      throw dictationError('DICTATION_SETUP', 'The dictation connection changed. Choose a service again.');
    return connection;
  }

  connectionFingerprint(providerId) {
    const connection = this.connection(providerId);
    return createHash('sha256').update(JSON.stringify([connection.kind, connection.apiKey])).digest('hex');
  }

  failSession(sender, session, error) {
    if (session.failure || session.controller.signal.aborted || this.sessions.get(sender) !== session) return;
    session.failure = error;
    this.onEvent(sender, { type: 'error', id: session.id, stableText: session.stableText,
      message: error?.code?.startsWith('DICTATION_') ? error.message : 'Transcription stopped. Please try again.' });
    session.controller.abort();
    this.end(sender, session);
  }

  append(sender, payload) {
    this.assertEnabled();
    const session = this.sessions.get(sender);
    if (!session || session.id !== payload?.id || !session.recording)
      throw dictationError('DICTATION_EXPIRED', 'This recording has ended. Please start again.');
    const pcm = payload.audio;
    if (payload.sequence !== session.sequence || !(pcm instanceof Uint8Array) || pcm.byteLength < 2 ||
        pcm.byteLength % 2 || pcm.byteLength > session.sampleRate * 2 ||
        session.bytes + pcm.byteLength > session.sampleRate * 2 * 120)
      throw dictationError('DICTATION_AUDIO', 'The live recording could not be read. Please record again.');
    // Connection changes revoke live sessions through connectionsChanged().
    // Do not decrypt credentials/stat model files on every 100 ms PCM frame.
    try {
      session.sequence += 1; session.bytes += pcm.byteLength;
      session.segments.append(Buffer.from(pcm));
    }
    catch (error) { this.failSession(sender, session, error); throw error; }
    return {};
  }

  async finish(sender, payload) {
    this.assertEnabled();
    const session = this.sessions.get(sender);
    if (!session || session.id !== payload?.id || !session.recording)
      throw dictationError('DICTATION_EXPIRED', 'This recording has ended. Please start again.');
    session.recording = false;
    revokeDictationCapture(sender, session.id);
    clearTimeout(session.timeout);
    session.timeout = setTimeout(() => this.cancel(sender), 120000);
    session.timeout.unref?.();
    try {
      session.segments.flush();
      await session.pending;
      if (session.failure) throw session.failure;
      const text = session.live ? await session.live.finish() : session.text;
      session.controller.signal.throwIfAborted();
      this.assertEnabled();
      if (!text?.trim()) throw dictationError('DICTATION_SILENCE', 'No speech detected. Please try again.');
      return { text: text.trim(), providerId: session.preferences.providerId };
    } finally { this.end(sender, session); }
  }

  async transcribeAudio(audio, { providerId, language }, signal) {
    this.assertEnabled();
    signal = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
    let text;
    if (providerId === 'local') text = await this.local.transcribe(audio, language, signal);
    else {
      const provider = CLOUD[providerId];
      const connection = this.connection(providerId);
      const currentOption = this.state().options.find(option => option.providerId === providerId && option.available);
      if (connection?.kind !== 'hosted' || !connection.apiKey ||
          !currentOption)
        throw dictationError('DICTATION_SETUP', 'The dictation connection changed. Choose a service again.');
      let body;
      const headers = { Authorization: `Bearer ${connection.apiKey}` };
      if (providerId === 'openrouter') {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify({ model: provider.model, input_audio: { data: audio.toString('base64'), format: 'wav' },
          ...(language !== 'auto' && { language }), response_format: 'json' });
      } else {
        body = new FormData();
        body.set('model', provider.model);
        if (language !== 'auto') body.set('language', language);
        body.set('response_format', 'json');
        body.set('file', new Blob([audio], { type: 'audio/wav' }), 'dictation.wav');
      }
      text = await readTranscript(await this.fetch(provider.url, { method: 'POST', headers, body, signal, redirect: 'error' }));
    }
    signal.throwIfAborted();
    if (typeof text !== 'string' || text.length > MAX_TEXT)
      throw dictationError('DICTATION_RESPONSE', 'No usable transcript was returned. Please try again.');
    if (!text.trim()) throw dictationError('DICTATION_SILENCE', 'No speech detected. Please try again.');
    return text.trim();
  }

  end(sender, session) {
    if (this.sessions.get(sender) !== session) return;
    clearTimeout(session.timeout);
    session.controller.abort();
    session.live?.close();
    session.segments?.clear();
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

  connectionsChanged() {
    for (const [sender, session] of this.sessions) {
      if (session.preferences.providerId === 'local') continue;
      try {
        if (this.connectionFingerprint(session.preferences.providerId) === session.connectionFingerprint) continue;
      } catch { /* Removed, unavailable or stricter-policy connections revoke capture. */ }
      this.failSession(sender, session, dictationError('DICTATION_CHANGED', 'The dictation connection changed.'));
    }
  }

  cancelAll() {
    for (const controller of this.installations.values()) controller.abort();
    for (const sender of this.sessions.keys()) this.cancel(sender);
  }

  async drain() { await Promise.allSettled([...this.operations]); }
}

module.exports = { DictationService, LANGUAGES, CLOUD, dictationError };
