'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHash, randomUUID } = require('crypto');
const { execFile } = require('child_process');
const { dictationError } = require('./dictation-service');
const { WHISPER_VERSION, WHISPER_REVISION, MODEL_SHA256, MODEL_BYTES, MODEL_URL, MODEL_NAME, SUPPORTED_TARGETS } = require('../../shared/dictation-runtime');

const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
// An install's staging directory cannot outlive its download deadline by this
// much; older ones belong to a killed or crashed process.
const ABANDONED_INSTALL_MS = 2 * DOWNLOAD_TIMEOUT_MS;
// Per process: the installed marker and size are cheap to forge, so the model's
// content is hashed once per app start (and again whenever the file changes).
const verifiedModels = new Map();

const fileIdentity = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;

async function fileSha256(file) {
  // Streamed in 1 MiB reads so the main process keeps serving the UI meanwhile.
  const digest = createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1024 * 1024 })) digest.update(chunk);
  return digest.digest('hex');
}

function run(executable, args, { signal, cwd } = {}) {
  // Do not pass provider credentials, Node preload flags or dynamic-library
  // search overrides from the browser environment to downloaded executables.
  const env = { PATH: process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32') : '/usr/bin:/bin', ...(process.platform === 'win32'
    ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: os.tmpdir() }
    : { HOME: cwd, TMPDIR: cwd, LANG: 'en_US.UTF-8' }) };
  return new Promise((resolve, reject) => {
    let result;
    let closed = false;
    const settle = () => {
      if (!result || !closed) return;
      if (result.error || signal?.aborted) reject(dictationError(signal?.aborted ? 'DICTATION_CANCELLED' : 'DICTATION_LOCAL',
        signal?.aborted ? 'Dictation cancelled.' : 'Local transcription could not run. Try downloading the local files again.'));
      else resolve(result.stdout);
    };
    const child = execFile(executable, args, { cwd, env, windowsHide: true, timeout: 120000,
      killSignal: 'SIGKILL', maxBuffer: 256 * 1024, encoding: 'utf8' }, (error, stdout) => {
      result = { error, stdout };
      settle();
    });
    // Own cancellation: Node's AbortSignal path can use SIGTERM and clear the
    // timeout before the child exits. Force termination and retain the close
    // barrier before deleting audio or finishing shutdown.
    const abort = () => child.kill('SIGKILL');
    child.once('close', () => {
      signal?.removeEventListener('abort', abort);
      closed = true; settle();
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

class LocalDictation {
  constructor({ dataDir, fetch: fetchImpl = globalThis.fetch, platform = process.platform, arch = process.arch,
    packaged = __dirname.split(path.sep).includes('app.asar'), resourcesPath = process.resourcesPath, runtimeDir } = {}) {
    this.supported = SUPPORTED_TARGETS.includes(`${platform}-${arch}`);
    this.platform = platform;
    this.arch = arch;
    // No fallback to an unrelated dev binary when a packaged helper is absent.
    this.runtimeDir = runtimeDir || (packaged ? path.join(resourcesPath || '', 'dictation-runtime')
      : path.resolve(__dirname, '../../../out/dictation-runtime', `${{ darwin: 'mac', win32: 'win', linux: 'linux' }[platform]}-${arch}`));
    this.root = path.join(dataDir, 'dictation-local', `whisper-base-${MODEL_SHA256.slice(0, 12)}`);
    this.model = path.join(this.root, 'ggml-base.bin');
    this.executable = path.join(this.runtimeDir, `whisper-cli${platform === 'win32' ? '.exe' : ''}`);
    this.fetch = fetchImpl;
    this.scratchRoot = path.join(dataDir, 'dictation-audio');
    // Only our generated phrase directories live here. Recover interrupted
    // cleanup on startup; never sweep the shared OS temporary directory.
    this.scratchCleanupFailed = false;
    try {
      const stat = fs.lstatSync(this.scratchRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid audio scratch directory');
      for (const entry of fs.readdirSync(this.scratchRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && /^phrase-[A-Za-z0-9]+$/.test(entry.name))
          fs.rmSync(path.join(this.scratchRoot, entry.name), { recursive: true, force: true });
      }
    } catch (error) {
      // Cleanup failure disables local recording, never ordinary browser startup.
      this.scratchCleanupFailed = error.code !== 'ENOENT';
    }
    // A killed or crashed model download leaves its ~150 MB staging directory.
    try {
      const parent = path.dirname(this.root);
      for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^\.install-[A-Za-z0-9]+$/.test(entry.name)) continue;
        const stage = path.join(parent, entry.name);
        if (Date.now() - fs.lstatSync(stage).mtimeMs > ABANDONED_INSTALL_MS) fs.rmSync(stage, { recursive: true, force: true });
      }
    } catch { /* Missing or unreadable: nothing to reclaim, and startup continues. */ }
  }

  runtimeReady() {
    try {
      const binary = fs.lstatSync(this.executable);
      const manifest = JSON.parse(fs.readFileSync(path.join(this.runtimeDir, 'manifest.json'), 'utf8'));
      return binary.isFile() && !binary.isSymbolicLink() && binary.size > 0 &&
        manifest.version === WHISPER_VERSION && manifest.revision === WHISPER_REVISION &&
        manifest.platform === this.platform && manifest.arch === this.arch && Array.isArray(manifest.libraries) &&
        (this.arch !== 'x64' || manifest.libraries.some(file => file.name.includes('ggml-cpu-haswell'))) &&
        manifest.libraries.every(file => {
          if (!/^[A-Za-z0-9_.-]+$/.test(file.name)) return false;
          const stat = fs.lstatSync(path.join(this.runtimeDir, file.name));
          return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0;
        });
    } catch { return false; }
  }

  // Identity of an installed-looking model, or null. Cheap and synchronous.
  installedModel() {
    if (!this.supported || !this.runtimeReady()) return null;
    try {
      const model = fs.lstatSync(this.model);
      const marker = JSON.parse(fs.readFileSync(path.join(this.root, 'installed.json'), 'utf8'));
      return model.isFile() && !model.isSymbolicLink() && model.size === MODEL_BYTES && marker.modelSha256 === MODEL_SHA256
        ? fileIdentity(model) : null;
    } catch { return null; }
  }

  ready() {
    const identity = this.installedModel();
    if (!identity) return false;
    this.verifyModel(); // Starts (once per file identity) the check that recording awaits.
    return verifiedModels.get(this.model)?.valid !== false;
  }

  // Resolves true only if the installed model's content has the pinned hash.
  verifyModel() {
    const identity = this.installedModel();
    if (!identity) return Promise.resolve(false);
    const known = verifiedModels.get(this.model);
    if (known?.identity === identity) return known.result;
    const entry = { identity };
    entry.result = fileSha256(this.model).then(digest => digest === MODEL_SHA256, () => false).then(valid => {
      // A file replaced while hashing proves nothing; its next use hashes again.
      if (this.installedModel() === identity) return (entry.valid = valid);
      if (verifiedModels.get(this.model) === entry) verifiedModels.delete(this.model);
      return false;
    });
    verifiedModels.set(this.model, entry);
    return entry.result;
  }

  async download(url, hash, destination, signal, progress, label) {
    signal = AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]);
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

  async install(signal, progress = () => {}) {
    if (!this.supported) throw dictationError('DICTATION_LOCAL', 'Local dictation is not available on this architecture yet.');
    if (!this.runtimeReady()) throw dictationError('DICTATION_LOCAL', 'The local speech engine is missing. Reinstall Freedom or rebuild the development runtime.');
    if (await this.verifyModel()) return;
    const parent = path.dirname(this.root);
    await fs.promises.mkdir(parent, { recursive: true, mode: 0o700 });
    const stage = await fs.promises.mkdtemp(path.join(parent, '.install-'));
    try {
      const ready = path.join(stage, 'ready');
      await fs.promises.mkdir(ready, { mode: 0o700 });
      await this.download(MODEL_URL, MODEL_SHA256, path.join(ready, 'ggml-base.bin'), signal, progress, `Downloading ${MODEL_NAME}`);
      await fs.promises.copyFile(path.join(__dirname, 'dictation-local-notices.txt'), path.join(ready, 'NOTICES.txt'));
      signal.throwIfAborted();
      await fs.promises.writeFile(path.join(ready, 'installed.json'), JSON.stringify({ modelSha256: MODEL_SHA256 }), { mode: 0o600 });
      // Preserve any incomplete previous installation for inspection rather
      // than replacing files underneath another process.
      if (fs.existsSync(this.root)) await fs.promises.rename(this.root, `${this.root}.previous-${randomUUID()}`);
      await fs.promises.rename(path.join(stage, 'ready'), this.root);
      // Hashed while downloading; no second read of the file this run.
      const identity = this.installedModel();
      if (identity) verifiedModels.set(this.model, { identity, valid: true, result: Promise.resolve(true) });
    } finally { await fs.promises.rm(stage, { recursive: true, force: true }); }
  }

  async transcribe(audio, language, signal) {
    if (!this.ready()) throw dictationError('DICTATION_SETUP', 'Download local dictation before recording.');
    if (!await this.verifyModel()) throw dictationError('DICTATION_INTEGRITY', 'The local model did not pass its integrity check. Download local dictation again.');
    if (this.scratchCleanupFailed) throw dictationError('DICTATION_LOCAL', 'Previous temporary audio could not be cleared. Check profile storage access before using local dictation.');
    await fs.promises.mkdir(this.scratchRoot, { recursive: true, mode: 0o700 });
    const stat = await fs.promises.lstat(this.scratchRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw dictationError('DICTATION_LOCAL', 'The local audio directory is unavailable.');
    const scratch = await fs.promises.mkdtemp(path.join(this.scratchRoot, 'phrase-'));
    await fs.promises.chmod(scratch, 0o700);
    try {
      const file = path.join(scratch, 'recording.wav');
      await fs.promises.writeFile(file, audio, { mode: 0o600, flag: 'wx' });
      // The Windows CLI reads argv in the system code page, then treats model
      // paths as UTF-8. Relative ASCII names avoid corrupting Unicode profiles;
      // Node supplies the executable and working directory through wide APIs.
      const output = await run(this.executable, ['--model', path.relative(scratch, this.model), '--file', path.basename(file),
        '--language', language, '--threads', '2', '--no-timestamps', '--no-prints', '--no-gpu'], { signal, cwd: scratch });
      // Diagnostics go to stderr; stdout contains only decoded speech. Keeping
      // plain text avoids creating an additional transcript file on disk.
      const text = output.replace(/\[BLANK_AUDIO\]/g, ' ').trim();
      // Whisper can label a click/hum as [Music], [Musik], etc. Such an
      // annotation alone is not dictated speech. Keep annotations accompanying
      // actual words, and leave token suppression off (it can invent words).
      return /^(?:(?:\[[^[\]\r\n]{1,40}\]|\([^()\r\n]{1,40}\)|\*{1,2}[^*\r\n]{1,40}\*{1,2})\s*)+$/.test(text) ? '' : text;
    } finally { await fs.promises.rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  }
}

module.exports = { LocalDictation };
