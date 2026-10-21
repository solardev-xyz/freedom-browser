'use strict';

// Finite native qualification with public sample audio, never a microphone or
// provider account. Uses the production installer, CLI adapter, and cleanup.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Readable } = require('stream');
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { LocalDictation } = require('../src/main/agent/dictation-local');
const { MODEL_SHA256, WHISPER_REVISION } = require('../src/shared/dictation-runtime');

async function smoke() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom dictation smoke '));
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
    assert.match(text, /ask not what your country can do for you/i);
    assert.deepEqual(fs.readdirSync(local.scratchRoot), []);
    const cancel = new AbortController(); cancel.abort();
    await assert.rejects(local.transcribe(audio, 'en', cancel.signal), { code: 'DICTATION_CANCELLED' });
    assert.deepEqual(fs.readdirSync(local.scratchRoot), []);
    await assert.rejects(local.transcribe(Buffer.from('invalid audio'), 'auto', new AbortController().signal));
    assert.deepEqual(fs.readdirSync(local.scratchRoot), []);
    console.log(JSON.stringify({ platform: process.platform, arch: process.arch, revision: WHISPER_REVISION,
      install: true, transcription: true, cancellation: true, failureCleanup: true, elapsedMs: Date.now() - started }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

smoke().catch(error => { console.error(error); process.exitCode = 1; });
