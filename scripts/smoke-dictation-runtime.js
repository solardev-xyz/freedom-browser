'use strict';

// Finite native qualification with public sample audio, never a microphone or
// provider account. Uses the production installer, CLI adapter, and cleanup.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Readable } = require('stream');
const assert = require('assert/strict');
const { createHash } = require('crypto');
const childProcess = require('child_process');
const execFile = childProcess.execFile;
const nativeProcesses = new Set();
let onSpawn = () => {};
// Observe real children without replacing the production spawn/kill behavior.
childProcess.execFile = (...args) => {
  const child = execFile(...args);
  nativeProcesses.add(child);
  child.once('spawn', () => onSpawn(child));
  child.once('close', () => nativeProcesses.delete(child));
  return child;
};
const { LocalDictation } = require('../src/main/agent/dictation-local');
childProcess.execFile = execFile;
const { MODEL_SHA256, WHISPER_REVISION } = require('../src/shared/dictation-runtime');
const { pcmToWav } = require('../src/main/agent/dictation-segments');

function clickAudio() {
  const pcm = Buffer.alloc(17600 * 2);
  let seed = 42;
  for (let i = 0; i < 17600; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const amplitude = i >= 6400 && i < 8000 ? 1500 : 20;
    pcm.writeInt16LE(Math.round((seed / 0x100000000 * 2 - 1) * amplitude), i * 2);
  }
  return pcmToWav(pcm);
}

async function smoke() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom dictation Jürgen 测试 '));
  const model = process.argv[2];
  const sample = process.argv[3];
  if (!sample) throw new Error('Usage: node scripts/smoke-dictation-runtime.js MODEL_FILE SAMPLE_WAV');
  try {
    assert.equal(createHash('sha256').update(fs.readFileSync(model)).digest('hex'), MODEL_SHA256);
    const local = new LocalDictation({ dataDir: root, fetch: async () =>
      new Response(Readable.toWeb(fs.createReadStream(model)), { headers: { 'content-length': fs.statSync(model).size } }) });
    assert.equal(local.ready(), false);
    await local.install(new AbortController().signal);
    assert.equal(local.ready(), true);
    const audio = fs.readFileSync(sample);
    const started = Date.now();
    const text = await local.transcribe(audio, 'en', new AbortController().signal);
    const transcriptionMs = Date.now() - started;
    assert.match(text, /ask not what your country can do for you/i);
    assert.deepEqual(fs.readdirSync(local.scratchRoot), []);
    assert.equal(await local.transcribe(clickAudio(), 'auto', new AbortController().signal), '', 'Non-speech must not become dictated text');
    assert.deepEqual(fs.readdirSync(local.scratchRoot), []);
    const cancel = new AbortController();
    let cancelTimer;
    let cancelledRunningProcess = false;
    onSpawn = child => {
      cancelTimer = setTimeout(() => {
        cancelledRunningProcess = child.exitCode === null && child.signalCode === null;
        cancel.abort();
      }, 150);
    };
    try {
      await assert.rejects(local.transcribe(audio, 'en', cancel.signal), { code: 'DICTATION_CANCELLED' });
    } finally { clearTimeout(cancelTimer); onSpawn = () => {}; }
    assert.equal(cancelledRunningProcess, true);
    assert.equal(nativeProcesses.size, 0, 'Cancellation must await native process closure');
    assert.deepEqual(fs.readdirSync(local.scratchRoot), []);
    await assert.rejects(local.transcribe(Buffer.from('invalid audio'), 'auto', new AbortController().signal));
    assert.deepEqual(fs.readdirSync(local.scratchRoot), []);
    console.log(JSON.stringify({ platform: process.platform, arch: process.arch, revision: WHISPER_REVISION,
      install: true, transcription: true, unicodeProfile: true, nonSpeech: true, cancellation: true, cancelledRunningProcess,
      failureCleanup: true, transcriptionMs, elapsedMs: Date.now() - started }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

smoke().catch(error => { console.error(error); process.exitCode = 1; });
