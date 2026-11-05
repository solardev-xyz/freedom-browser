const { EventEmitter } = require('events');
const { DictationRealtime } = require('./dictation-realtime');

function setup() {
  const socket = new EventEmitter(); socket.send = jest.fn(); socket.terminate = jest.fn(); socket.bufferedAmount = 0;
  const connect = jest.fn(() => socket); const onTranscript = jest.fn(); const onError = jest.fn();
  const controller = new AbortController();
  const live = new DictationRealtime({ apiKey: 'fixture-key', language: 'de', signal: controller.signal, connect, onTranscript, onError });
  const event = value => socket.emit('message', Buffer.from(JSON.stringify(value)));
  socket.emit('open'); event({ type: 'session.updated' });
  return { live, socket, event, connect, onTranscript, onError, controller };
}

test('authenticates only to the pinned endpoint and exposes partial words before an audio turn is committed', async () => {
  const ctx = setup();
  expect(ctx.connect).toHaveBeenCalledWith('wss://api.openai.com/v1/realtime?intent=transcription', expect.objectContaining({
    headers: { Authorization: 'Bearer fixture-key' }, followRedirects: false,
  }));
  expect(JSON.parse(ctx.socket.send.mock.calls[0][0]).session.audio.input).toEqual({
    format: { type: 'audio/pcm', rate: 24000 }, transcription: { model: 'gpt-live-transcribe', languages: ['de'] }, turn_detection: null,
  });
  await ctx.live.append(Buffer.from([1, 2]));
  ctx.event({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'one', delta: 'Hello' });
  expect(ctx.onTranscript).toHaveBeenLastCalledWith({ text: 'Hello', stableText: '' });
  ctx.live.commit(); ctx.event({ type: 'input_audio_buffer.committed', item_id: 'one', previous_item_id: null });
  const result = ctx.live.finish();
  ctx.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'one', transcript: 'Hallo!' });
  await expect(result).resolves.toBe('Hallo!');
  expect(ctx.onTranscript).toHaveBeenLastCalledWith({ text: 'Hallo!', stableText: 'Hallo!' }); ctx.live.close();
});

test('reconciles corrected final text in audio order even when the second phrase completes first', async () => {
  const ctx = setup();
  ctx.live.commit(); ctx.event({ type: 'input_audio_buffer.committed', item_id: 'one', previous_item_id: null });
  ctx.live.commit(); ctx.event({ type: 'input_audio_buffer.committed', item_id: 'two', previous_item_id: 'one' });
  ctx.event({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'one', delta: 'Unfinished' });
  const result = ctx.live.finish();
  ctx.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'two', transcript: 'Second.' });
  expect(ctx.onTranscript).toHaveBeenLastCalledWith({ text: 'Unfinished Second.', stableText: '' });
  ctx.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'one', transcript: 'First.' });
  await expect(result).resolves.toBe('First. Second.'); ctx.live.close();
});

test('cancellation closes the connection and provider bodies never become user-facing errors', async () => {
  const ctx = setup(); ctx.live.commit();
  const result = ctx.live.finish(); await Promise.resolve();
  ctx.event({ type: 'error', error: { message: 'secret body including credential' } });
  await expect(result).rejects.toThrow('OpenAI could not transcribe');
  expect(ctx.socket.terminate).toHaveBeenCalled();
  expect(JSON.stringify(ctx.onError.mock.calls)).not.toContain('secret');
  const other = setup(); other.controller.abort(); expect(other.socket.terminate).toHaveBeenCalled();
});


test('commit acknowledgement order is retained when predecessor metadata is omitted', async () => {
  const ctx = setup();
  ctx.live.commit(); ctx.event({ type: 'input_audio_buffer.committed', item_id: 'one' });
  ctx.live.commit(); ctx.event({ type: 'input_audio_buffer.committed', item_id: 'two' });
  const result = ctx.live.finish();
  ctx.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'two', transcript: 'Second.' });
  ctx.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'one', transcript: 'First.' });
  await expect(result).resolves.toBe('First. Second.'); ctx.live.close();
});
