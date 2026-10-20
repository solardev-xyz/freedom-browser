'use strict';

const WebSocket = require('ws');

const failure = message => Object.assign(new Error(message), { code: 'DICTATION_LIVE' });

class DictationRealtime {
  constructor({ apiKey, language, signal, onTranscript, onError,
    connect = (url, options) => new WebSocket(url, options) }) {
    this.items = new Map();
    this.order = [];
    this.commits = [];
    this.pending = 0;
    this.closed = false;
    this.onTranscript = onTranscript;
    this.onError = onError;
    this.socket = connect('wss://api.openai.com/v1/realtime?intent=transcription', {
      headers: { Authorization: `Bearer ${apiKey}` }, handshakeTimeout: 10000,
      maxPayload: 256 * 1024, followRedirects: false,
    });
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    // A connection may fail before the first audio frame awaits readiness.
    this.ready.catch(() => {});
    this.readyTimer = setTimeout(() => this.fail(failure('Live transcription did not connect. Please try again.')), 10000);
    this.socket.on('open', () => {
      try { this.send({ type: 'session.update', session: { type: 'transcription', audio: { input: {
        format: { type: 'audio/pcm', rate: 24000 }, transcription: { model: 'gpt-live-transcribe',
          ...(language !== 'auto' && { languages: [language] }) }, turn_detection: null,
      } } } }); }
      catch { this.fail(failure('Live transcription could not start. Please try again.')); }
    });
    this.socket.on('message', data => this.message(data));
    this.socket.on('error', () => this.fail(failure('Live transcription could not connect. Check the OpenAI connection and access.')));
    this.socket.on('close', () => { if (!this.closed) this.fail(failure('Live transcription disconnected. Please try again.')); });
    this.abort = () => this.fail(failure('Dictation cancelled.'));
    this.signal = signal;
    signal.addEventListener('abort', this.abort, { once: true });
    if (signal.aborted) this.abort();
  }

  send(event) {
    if (this.error) throw this.error;
    if (this.socket.bufferedAmount > 512 * 1024) throw failure('The transcription connection cannot keep up. Please try again.');
    this.socket.send(JSON.stringify(event));
  }

  message(data) {
    if (this.closed) return;
    try {
      const event = JSON.parse(data.toString());
      if (event.type === 'session.updated') { clearTimeout(this.readyTimer); this.resolveReady(); return; }
      if (event.type === 'error' || event.type === 'conversation.item.input_audio_transcription.failed')
        throw failure('OpenAI could not transcribe this recording. Check model access and try again.');
      if (event.type === 'input_audio_buffer.committed') {
        if (!this.pending || typeof event.item_id !== 'string' || this.commits.some(item => item.id === event.item_id))
          throw failure('The live transcript could not be ordered. Please try again.');
        this.commits.push({ id: event.item_id, previous: event.previous_item_id || null });
        if (!this.items.has(event.item_id)) this.items.set(event.item_id, { text: '', final: false });
        // Completion events may arrive out of order. Commits follow the audio
        // order through previous_item_id; never order by completion time.
        this.order = [];
        let previous = null;
        for (let i = 0; i < this.commits.length; i += 1) {
          const item = this.commits.find(item => item.previous === previous);
          if (!item) throw failure('The live transcript could not be ordered. Please try again.');
          this.order.push(item.id); previous = item.id;
        }
        this.order.push(...[...this.items.keys()].filter(id => !this.order.includes(id)));
        return;
      }
      if (typeof event.item_id === 'string' && !this.items.has(event.item_id) &&
          event.type === 'conversation.item.input_audio_transcription.delta') {
        this.items.set(event.item_id, { text: '', final: false }); this.order.push(event.item_id);
      }
      const item = this.items.get(event.item_id);
      if (!item) return;
      if (event.type === 'conversation.item.input_audio_transcription.delta' && !item.final && typeof event.delta === 'string') item.text += event.delta;
      else if (event.type === 'conversation.item.input_audio_transcription.completed' && !item.final && typeof event.transcript === 'string') {
        item.text = event.transcript; item.final = true; this.pending -= 1;
      } else return;
      const text = this.text();
      if (text.length > 32000) throw failure('The transcript is too long. Please finish this recording.');
      this.onTranscript({ text, stableText: this.stableText() });
      if (!this.pending) this.resolveFinish?.(text);
    } catch (error) { this.fail(error.code === 'DICTATION_LIVE' ? error : failure('The live transcription response could not be read.')); }
  }

  text() { return this.order.map(id => this.items.get(id).text.trim()).filter(Boolean).join(' '); }
  stableText() {
    const parts = [];
    for (const id of this.order) { const item = this.items.get(id); if (!item.final) break; parts.push(item.text.trim()); }
    return parts.filter(Boolean).join(' ');
  }
  async append(pcm) { await this.ready; this.send({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') }); }
  commit() { this.pending += 1; this.send({ type: 'input_audio_buffer.commit' }); }
  async finish() {
    await this.ready;
    if (this.error) throw this.error;
    if (!this.pending) return this.text();
    return new Promise((resolve, reject) => {
      this.resolveFinish = resolve; this.rejectFinish = reject;
      this.finishTimer = setTimeout(() => this.fail(failure('The final transcript took too long. Please try again.')), 30000);
    });
  }
  fail(error) {
    if (this.closed) return;
    this.error = error;
    this.rejectReady(error); this.rejectFinish?.(error);
    this.close(); this.onError(error);
  }
  close() {
    this.closed = true;
    clearTimeout(this.readyTimer); clearTimeout(this.finishTimer);
    this.signal.removeEventListener('abort', this.abort);
    this.socket.terminate();
  }
}

module.exports = { DictationRealtime };
