export function encodeDictationWav(chunks) {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(44 + size);
  const view = new DataView(bytes.buffer);
  const ascii = (offset, value) => { for (let i = 0; i < value.length; i += 1) bytes[offset + i] = value.charCodeAt(i); };
  ascii(0, 'RIFF'); view.setUint32(4, size + 36, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, size, true);
  let offset = 44;
  for (const chunk of chunks) { bytes.set(new Uint8Array(chunk), offset); offset += chunk.byteLength; }
  return bytes;
}

export async function createDictationRecorder(stream, onLimit, onLost, { onChunk, onSpectrum, sampleRate = 16000 } = {}) {
  let context;
  let source;
  let node;
  let gain;
  let analyser;
  let spectrumFrame;
  let ended = false;
  let flushed;
  let durationTimer;
  const chunks = [];
  let length = 0;
  const tracks = stream.getTracks();
  const lost = () => { if (!ended) onLost(); };
  const close = () => {
    ended = true;
    clearTimeout(durationTimer);
    if (spectrumFrame !== undefined) cancelAnimationFrame(spectrumFrame);
    for (const track of tracks) { track.removeEventListener('ended', lost); track.stop(); }
    node?.disconnect(); source?.disconnect(); gain?.disconnect(); analyser?.disconnect();
    node?.removeEventListener('processorerror', lost);
    void context?.close().catch(() => {});
  };
  try {
    context = new AudioContext({ sampleRate });
    await context.audioWorklet.addModule('./lib/dictation-worklet.js');
    node = new AudioWorkletNode(context, 'freedom-dictation-capture', { processorOptions: { sampleRate } });
    node.addEventListener('processorerror', lost);
    node.port.onmessage = event => {
      if (ended) return;
      if (event.data === 'flushed') { flushed?.(); return; }
      if (!(event.data instanceof ArrayBuffer)) return;
      const remaining = sampleRate * 2 * 120 - length;
      if (remaining <= 0) return;
      const chunk = event.data.slice(0, remaining);
      if (onChunk) onChunk(new Uint8Array(chunk)); else chunks.push(chunk);
      length += chunk.byteLength;
      if (length >= sampleRate * 2 * 120) onLimit();
    };
    source = context.createMediaStreamSource(stream);
    gain = context.createGain();
    gain.gain.value = 0;
    source.connect(node); node.connect(gain); gain.connect(context.destination);
    if (onSpectrum) {
      analyser = context.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.65;
      source.connect(analyser);
      const bins = new Uint8Array(analyser.frequencyBinCount);
      const levels = new Float32Array(18);
      let lastFrame = -Infinity;
      const updateSpectrum = time => {
        if (ended) return;
        // The analyser shares the capture graph and samples 18 bands at
        // 30fps, without another stream, audio upload or canvas repaint.
        if (time - lastFrame >= 1000 / 30) {
          lastFrame = time;
          analyser.getByteFrequencyData(bins);
          for (let band = 0; band < levels.length; band += 1) {
            const low = Math.floor(80 * (6000 / 80) ** (band / levels.length) * analyser.fftSize / context.sampleRate);
            const high = Math.max(low + 1, Math.ceil(80 * (6000 / 80) ** ((band + 1) / levels.length) * analyser.fftSize / context.sampleRate));
            let peak = 0;
            for (let bin = low; bin < Math.min(high, bins.length); bin += 1) peak = Math.max(peak, bins[bin]);
            levels[band] = (peak / 255) ** 1.5;
          }
          onSpectrum(levels);
        }
        spectrumFrame = requestAnimationFrame(updateSpectrum);
      };
      spectrumFrame = requestAnimationFrame(updateSpectrum);
    }
    for (const track of tracks) track.addEventListener('ended', lost);
    await context.resume();
    durationTimer = setTimeout(onLimit, 120000);
    return {
      cancel() { close(); chunks.length = 0; },
      async finish() {
        let timer;
        try {
          await new Promise(resolve => {
            flushed = resolve;
            timer = setTimeout(resolve, 500);
            node.port.postMessage('flush');
          });
          close();
          return encodeDictationWav(chunks);
        } finally { clearTimeout(timer); close(); chunks.length = 0; }
      },
    };
  } catch (error) { close(); throw error; }
}
