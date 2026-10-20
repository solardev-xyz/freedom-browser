'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHash, randomUUID } = require('crypto');
const { execFile } = require('child_process');
const { dictationError } = require('./dictation-service');

// Optional user-requested downloads, never part of ordinary browser startup.
// Runtime digests are the upstream GitHub release digests. The multilingual
// model archive was independently SHA-256 hashed before pinning it here.
const RELEASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';
const RUNTIMES = Object.freeze({
  'darwin-arm64': ['osx-arm64-shared', 'b10e5c7e2c30ea03de9c442655d14860d9edc475c6251d58a8f5f06e913a1d56'],
  'darwin-x64': ['osx-x64-shared', '54aad64acee9d2d596535a6080d6f22602a720af5460e1d50461b1e1b06bee40'],
  'linux-x64': ['linux-x64-shared-no-tts', 'd0f96c8b65c6cd0974fada22737e337de81bc8cd2abbec2e39caf358b1eec5fc'],
  'linux-arm64': ['linux-aarch64-shared-cpu', '4e3734f82bc1379fd91f219f5869c7e9d03b7a4f7561907d8abca4849c51a789'],
  'win32-x64': ['win-x64-shared-MT-Release-no-tts', '4b0a94f7b5c606b1b64a19a831c2127559e4b3d34e195465ebc7be73d9ed4783'],
});
const MODEL_HASH = '911b2083efd7c0dca2ac3b358b75222660dc09fb716d64fbfc417ba6c99ff3de';
const MODEL_FILES = ['base-encoder.int8.onnx', 'base-decoder.int8.onnx', 'base-tokens.txt'];

function run(executable, args, { signal, cwd, maxBuffer = 256 * 1024, binary = false } = {}) {
  // Do not pass provider credentials, Node preload flags or dynamic-library
  // search overrides from the browser environment to downloaded executables.
  const env = { PATH: process.env.PATH, ...(process.platform === 'win32'
    ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: os.tmpdir() }
    : { HOME: os.tmpdir(), TMPDIR: os.tmpdir(), LANG: 'en_US.UTF-8' }) };
  return new Promise((resolve, reject) => {
    execFile(executable, args, { cwd, env, signal, windowsHide: true, timeout: 120000,
      killSignal: 'SIGKILL', maxBuffer, encoding: binary ? 'buffer' : 'utf8' }, (error, stdout) => {
      if (error) reject(dictationError(signal?.aborted ? 'DICTATION_CANCELLED' : 'DICTATION_LOCAL',
        signal?.aborted ? 'Dictation cancelled.' : 'Local transcription could not run. Try downloading the local files again.'));
      else resolve(stdout);
    });
  });
}

class LocalDictation {
  constructor({ dataDir, fetch: fetchImpl = globalThis.fetch, platform = process.platform, arch = process.arch } = {}) {
    this.asset = RUNTIMES[`${platform}-${arch}`];
    this.supported = Boolean(this.asset);
    this.platform = platform;
    this.root = path.join(dataDir, 'dictation-local', `sherpa-1.13.8-whisper-base-${platform}-${arch}`);
    this.executable = path.join(this.root, 'runtime', 'bin', `sherpa-onnx-offline${platform === 'win32' ? '.exe' : ''}`);
    this.fetch = fetchImpl;
    this.tar = platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar';
  }

  ready() {
    if (!this.supported) return false;
    try {
      return [this.executable, ...MODEL_FILES.map(file => path.join(this.root, 'model', file)), path.join(this.root, 'installed.json'), path.join(this.root, 'NOTICES.txt')]
        .every(file => { const stat = fs.lstatSync(file); return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0; });
    } catch { return false; }
  }

  async download(url, hash, destination, signal, progress, label) {
    signal = AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)]);
    const response = await this.fetch(url, { signal });
    if (!response.ok || !response.body) throw dictationError('DICTATION_DOWNLOAD', 'The local dictation download failed. Please try again.');
    const reader = response.body.getReader();
    const file = await fs.promises.open(destination, 'wx', 0o600);
    const digest = createHash('sha256');
    let bytes = 0;
    let lastUpdate = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        signal.throwIfAborted();
        bytes += value.length;
        if (bytes > 260 * 1024 * 1024) throw dictationError('DICTATION_DOWNLOAD', 'The local download was unexpectedly large.');
        digest.update(value);
        let offset = 0;
        while (offset < value.length) {
          const result = await file.write(value, offset, value.length - offset);
          if (!result.bytesWritten) throw dictationError('DICTATION_DOWNLOAD', 'The local download could not be saved. Check available disk space.');
          offset += result.bytesWritten;
        }
        if (Date.now() - lastUpdate > 250) {
          progress({ label, bytes, total: Number(response.headers.get('content-length')) || 0 });
          lastUpdate = Date.now();
        }
      }
    } finally { await file.close(); await reader.cancel().catch(() => {}); }
    if (digest.digest('hex') !== hash) throw dictationError('DICTATION_INTEGRITY', 'The local download did not pass its integrity check. Please try again.');
  }

  async extract(archive, entry, destination, signal) {
    const bytes = await run(this.tar, ['-xOf', archive, entry], { signal, binary: true, maxBuffer: 160 * 1024 * 1024 });
    if (!bytes.length) return false; // Archive symlinks are not extracted.
    await fs.promises.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(destination, bytes, { mode: 0o600, flag: 'wx' });
    return true;
  }

  async install(signal, progress = () => {}) {
    if (!this.supported) throw dictationError('DICTATION_LOCAL', 'Local dictation is not available on this architecture yet.');
    if (this.ready()) return;
    const parent = path.dirname(this.root);
    await fs.promises.mkdir(parent, { recursive: true, mode: 0o700 });
    const stage = await fs.promises.mkdtemp(path.join(parent, '.install-'));
    try {
      const stem = `sherpa-onnx-v1.13.8-${this.asset[0]}`;
      const runtimeArchive = path.join(stage, 'runtime.tar.bz2');
      const modelArchive = path.join(stage, 'model.tar.bz2');
      await this.download(`${RELEASE}/v1.13.8/${stem}.tar.bz2`, this.asset[1], runtimeArchive, signal, progress, 'Downloading speech engine');
      const listing = await run(this.tar, ['-tjf', runtimeArchive], { signal });
      const executable = `sherpa-onnx-offline${this.platform === 'win32' ? '.exe' : ''}`;
      const entries = listing.split(/\r?\n/).filter(entry => entry === `${stem}/bin/${executable}` ||
        new RegExp(`^${stem}/(?:lib|bin)/[A-Za-z0-9_.+-]+\\.(?:dylib|dll|so(?:\\.[0-9.]+)?)$`).test(entry));
      if (!entries.includes(`${stem}/bin/${executable}`)) throw dictationError('DICTATION_DOWNLOAD', 'The downloaded speech engine was incomplete.');
      progress({ label: 'Preparing speech engine' });
      for (const entry of entries) {
        const relative = entry.slice(stem.length + 1);
        await this.extract(runtimeArchive, entry, path.join(stage, 'ready', 'runtime', relative), signal);
      }
      // Linux distributions load the versioned SONAME. Some upstream archives
      // carry aliases as tar symlinks; create only these fixed local aliases.
      const libDir = path.join(stage, 'ready', 'runtime', 'lib');
      if (this.platform === 'linux') {
        const libraries = await fs.promises.readdir(libDir);
        for (const file of libraries.filter(file => /^libonnxruntime\.so\.[0-9.]+$/.test(file))) {
          for (const alias of ['libonnxruntime.so', 'libonnxruntime.so.1']) {
            try { await fs.promises.copyFile(path.join(libDir, file), path.join(libDir, alias), fs.constants.COPYFILE_EXCL); }
            catch (error) { if (error.code !== 'EEXIST') throw error; }
          }
        }
      }
      await this.download(`${RELEASE}/asr-models/sherpa-onnx-whisper-base.tar.bz2`, MODEL_HASH, modelArchive, signal, progress, 'Downloading multilingual Whisper');
      progress({ label: 'Preparing multilingual Whisper' });
      for (const file of MODEL_FILES) await this.extract(modelArchive, `sherpa-onnx-whisper-base/${file}`, path.join(stage, 'ready', 'model', file), signal);
      await fs.promises.chmod(path.join(stage, 'ready', 'runtime', 'bin', executable), 0o700);
      await fs.promises.copyFile(path.join(__dirname, 'dictation-local-notices.txt'), path.join(stage, 'ready', 'NOTICES.txt'));
      signal.throwIfAborted();
      await fs.promises.writeFile(path.join(stage, 'ready', 'installed.json'), JSON.stringify({ runtime: this.asset[1], model: MODEL_HASH }), { mode: 0o600 });
      // Preserve any incomplete previous installation for inspection rather
      // than replacing files underneath another process.
      if (fs.existsSync(this.root)) await fs.promises.rename(this.root, `${this.root}.previous-${randomUUID()}`);
      await fs.promises.rename(path.join(stage, 'ready'), this.root);
    } finally { await fs.promises.rm(stage, { recursive: true, force: true }); }
  }

  async transcribe(audio, language, signal) {
    if (!this.ready()) throw dictationError('DICTATION_SETUP', 'Download local dictation before recording.');
    const scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'freedom-dictation-'));
    try {
      const file = path.join(scratch, 'recording.wav');
      await fs.promises.writeFile(file, audio, { mode: 0o600, flag: 'wx' });
      const model = path.join(this.root, 'model');
      const output = await run(this.executable, ['--print-args=false', '--model-type=whisper',
        `--whisper-encoder=${path.join(model, MODEL_FILES[0])}`, `--whisper-decoder=${path.join(model, MODEL_FILES[1])}`,
        `--tokens=${path.join(model, MODEL_FILES[2])}`, `--whisper-language=${language === 'auto' ? '' : language}`,
        '--whisper-task=transcribe', '--num-threads=2', file], { signal, cwd: scratch });
      for (const line of output.split(/\r?\n/).reverse()) {
        try { const result = JSON.parse(line); if (typeof result.text === 'string') return result.text.trim(); }
        catch { /* Progress and timing lines are not transcripts. */ }
      }
      throw dictationError('DICTATION_RESPONSE', 'Local dictation did not return a transcript. Please try again.');
    } finally { await fs.promises.rm(scratch, { recursive: true, force: true }); }
  }
}

module.exports = { LocalDictation, RUNTIMES, MODEL_HASH };
