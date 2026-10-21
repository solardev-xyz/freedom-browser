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
