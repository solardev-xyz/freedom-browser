const { encodeDictationWav } = require('./dictation-recorder');

test('dictation PCM chunks become one valid mono 16kHz WAV without dropping samples', () => {
  const first = new Int16Array([12, -60, 300]);
  const second = new Int16Array([1000, -2200]);
  const bytes = encodeDictationWav([first.buffer, second.buffer]);
  const wav = Buffer.from(bytes);
  expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
  expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
  expect(wav.readUInt16LE(22)).toBe(1); expect(wav.readUInt32LE(24)).toBe(16000);
  expect(wav.readUInt32LE(40)).toBe(10);
  expect(wav.subarray(44)).toEqual(Buffer.concat([Buffer.from(first.buffer), Buffer.from(second.buffer)]));
});

test('the spectrum uses the capture graph and releases its animation, nodes and microphone on finish', async () => {
  const { createDictationRecorder } = require('./dictation-recorder');
  const source = { connect: jest.fn(), disconnect: jest.fn() };
  const analyser = { frequencyBinCount: 256, disconnect: jest.fn(), getByteFrequencyData: jest.fn(bins => {
    bins.fill(0); bins[9] = 255;
  }) };
  const node = { connect: jest.fn(), disconnect: jest.fn(), addEventListener: jest.fn(), removeEventListener: jest.fn(), port: {} };
  node.port.postMessage = () => node.port.onmessage({ data: 'flushed' });
  const context = { sampleRate: 16000, destination: {}, audioWorklet: { addModule: jest.fn(async () => {}) },
    createMediaStreamSource: () => source, createAnalyser: () => analyser,
    createGain: () => ({ gain: {}, connect: jest.fn(), disconnect: jest.fn() }),
    resume: jest.fn(async () => {}), close: jest.fn(async () => {}) };
  const original = Object.fromEntries(['AudioContext', 'AudioWorkletNode', 'requestAnimationFrame', 'cancelAnimationFrame'].map(key => [key, global[key]]));
  let frame;
  global.AudioContext = jest.fn(() => context);
  global.AudioWorkletNode = jest.fn(() => node);
  global.requestAnimationFrame = jest.fn(callback => { frame = callback; return 7; });
  global.cancelAnimationFrame = jest.fn();
  const track = { addEventListener: jest.fn(), removeEventListener: jest.fn(), stop: jest.fn() };
  const onSpectrum = jest.fn();
  try {
    const recorder = await createDictationRecorder({ getTracks: () => [track] }, jest.fn(), jest.fn(), { onSpectrum });
    expect(source.connect).toHaveBeenCalledWith(node);
    expect(source.connect).toHaveBeenCalledWith(analyser);
    frame(0);
    const levels = Array.from(onSpectrum.mock.calls[0][0]);
    expect(levels).toHaveLength(18); expect(Math.max(...levels)).toBe(1); expect(Math.min(...levels)).toBe(0);
    await recorder.finish();
    expect(global.cancelAnimationFrame).toHaveBeenCalledWith(7);
    expect(track.stop).toHaveBeenCalled(); expect(analyser.disconnect).toHaveBeenCalled(); expect(context.close).toHaveBeenCalled();
    const calls = onSpectrum.mock.calls.length;
    frame(40); expect(onSpectrum).toHaveBeenCalledTimes(calls);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete global[key]; else global[key] = value;
    }
  }
});
