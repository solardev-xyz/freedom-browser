'use strict';

// Lightweight endpointing on Chromium's noise-suppressed PCM. Keep a short
// pre-roll, finish at pauses, and bound uninterrupted phrases to six seconds.
// No overlap/re-upload of earlier phrases, and no requests for silence alone.
class DictationSegments {
  constructor({ sampleRate = 16000, onAudio = () => {}, onSegment }) {
    this.rate = sampleRate;
    this.onAudio = onAudio;
    this.onSegment = onSegment;
    this.parts = [];
    this.preRoll = [];
    this.samples = 0;
    this.silence = 0;
    this.active = false;
  }

  append(pcm) {
    let energy = 0;
    for (let i = 0; i < pcm.length; i += 2) energy += pcm.readInt16LE(i) ** 2;
    const count = pcm.length / 2;
    const speech = Math.sqrt(energy / count) >= 80;
    if (!this.active) {
      if (!speech) {
        this.preRoll.push(pcm);
        while (this.preRoll.reduce((n, part) => n + part.length, 0) > this.rate * .4) this.preRoll.shift();
        return;
      }
      this.active = true;
      for (const part of this.preRoll) this.push(part);
      this.preRoll = [];
    }
    this.push(pcm);
    this.silence = speech ? 0 : this.silence + count;
    if (this.samples >= this.rate * 6 || this.silence >= this.rate * .6) this.flush();
  }

  push(pcm) {
    this.parts.push(pcm);
    this.samples += pcm.length / 2;
    this.onAudio(pcm);
  }

  flush() {
    if (!this.active) return;
    const pcm = Buffer.concat(this.parts);
    this.parts = []; this.samples = 0; this.silence = 0; this.active = false;
    this.onSegment(pcm);
  }

  clear() { this.parts = []; this.preRoll = []; }
}

function pcmToWav(pcm, sampleRate = 16000) {
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
  wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
  return wav;
}

module.exports = { DictationSegments, pcmToWav };
