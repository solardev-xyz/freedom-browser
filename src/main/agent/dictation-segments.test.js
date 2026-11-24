const { DictationSegments, pcmToWav } = require('./dictation-segments');

const frame = (voice = true, rate = 16000) => {
  const pcm = Buffer.alloc(rate / 10 * 2);
  if (voice) for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(Math.round(Math.sin(i / 8) * 3000), i);
  return pcm;
};

test('silence makes no requests and speech is emitted at a natural pause before recording ends', () => {
  const onSegment = jest.fn(); const segments = new DictationSegments({ onSegment });
  for (let i = 0; i < 20; i++) segments.append(frame(false));
  expect(onSegment).not.toHaveBeenCalled();
  for (let i = 0; i < 10; i++) segments.append(frame());
  for (let i = 0; i < 6; i++) segments.append(frame(false));
  expect(onSegment).toHaveBeenCalledTimes(1);
  expect(onSegment.mock.calls[0][0].length).toBe(18 * 3200);
  for (let i = 0; i < 10; i++) segments.append(frame(false));
  segments.flush(); expect(onSegment).toHaveBeenCalledTimes(1);
});

test.each([16000, 24000])('continuous speech is bounded without dropped or repeated samples at %i Hz', rate => {
  const onSegment = jest.fn(); const onAudio = jest.fn(); const frames = [];
  const segments = new DictationSegments({ sampleRate: rate, onSegment, onAudio });
  for (let i = 0; i < 125; i++) { const pcm = frame(true, rate); frames.push(pcm); segments.append(pcm); }
  expect(onSegment).toHaveBeenCalledTimes(2); segments.flush();
  expect(onSegment).toHaveBeenCalledTimes(3);
  expect(Buffer.concat(onSegment.mock.calls.map(([pcm]) => pcm))).toEqual(Buffer.concat(frames));
  expect(Buffer.concat(onAudio.mock.calls.map(([pcm]) => pcm))).toEqual(Buffer.concat(frames));
  const wav = pcmToWav(onSegment.mock.calls[0][0], rate);
  expect(wav.readUInt32LE(24)).toBe(rate); expect(wav.readUInt32LE(40)).toBe(rate * 12);
});
