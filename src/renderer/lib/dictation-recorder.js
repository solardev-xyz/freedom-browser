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

export async function createDictationRecorder(stream, onLimit, onLost) {
  let context;
  let source;
  let node;
  let gain;
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
    for (const track of tracks) { track.removeEventListener('ended', lost); track.stop(); }
    node?.disconnect(); source?.disconnect(); gain?.disconnect();
    node?.removeEventListener('processorerror', lost);
    void context?.close().catch(() => {});
  };
  try {
    context = new AudioContext({ sampleRate: 16000 });
    await context.audioWorklet.addModule('./lib/dictation-worklet.js');
    node = new AudioWorkletNode(context, 'freedom-dictation-capture');
    node.addEventListener('processorerror', lost);
    node.port.onmessage = event => {
      if (ended) return;
      if (event.data === 'flushed') { flushed?.(); return; }
      if (!(event.data instanceof ArrayBuffer)) return;
      const remaining = 16000 * 2 * 120 - length;
      if (remaining <= 0) return;
      const chunk = event.data.slice(0, remaining);
      chunks.push(chunk);
      length += chunk.byteLength;
      if (length >= 16000 * 2 * 120) onLimit();
    };
    source = context.createMediaStreamSource(stream);
    gain = context.createGain();
    gain.gain.value = 0;
    source.connect(node); node.connect(gain); gain.connect(context.destination);
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
