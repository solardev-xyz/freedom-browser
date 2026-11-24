/* global AudioWorkletProcessor, registerProcessor, sampleRate */

// Capture/resample off the renderer thread. No audio is played back or stored.
class DictationCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.rate = options.processorOptions.sampleRate;
    this.buffer = new Int16Array(this.rate / 10);
    this.offset = 0;
    this.phase = 0;
    this.sum = 0;
    this.count = 0;
    this.port.onmessage = event => {
      if (event.data === 'flush') {
        if (this.offset) this.port.postMessage(this.buffer.slice(0, this.offset).buffer);
        this.offset = 0;
        this.port.postMessage('flushed');
      }
    };
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (const sample of channel) {
      this.sum += sample;
      this.count += 1;
      this.phase += this.rate;
      if (this.phase < sampleRate) continue;
      this.phase -= sampleRate;
      this.buffer[this.offset++] = Math.round(Math.max(-1, Math.min(1, this.sum / this.count)) * 32767);
      this.sum = 0;
      this.count = 0;
      if (this.offset === this.buffer.length) {
        this.port.postMessage(this.buffer.buffer, [this.buffer.buffer]);
        this.buffer = new Int16Array(this.rate / 10);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('freedom-dictation-capture', DictationCaptureProcessor);
