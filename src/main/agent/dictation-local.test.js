const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHash } = require('crypto');
const { EventEmitter } = require('events');
jest.mock('child_process', () => ({ execFile: jest.fn() }));
const { execFile } = require('child_process');
const { LocalDictation } = require('./dictation-local');
const { WHISPER_VERSION, WHISPER_REVISION, MODEL_BYTES, MODEL_SHA256, MODEL_URL } = require('../../shared/dictation-runtime');

function fixture(root, options = {}) {
  const runtimeDir = path.join(root, 'runtime'); fs.mkdirSync(runtimeDir, { recursive: true });
  const local = new LocalDictation({ dataDir: root, runtimeDir, ...options });
  fs.writeFileSync(local.executable, 'fixture executable');
  const libraries = local.arch === 'x64' ? [{ name: 'libggml-cpu-haswell.so' }] : [];
  for (const file of libraries) fs.writeFileSync(path.join(runtimeDir, file.name), 'fixture library');
  fs.writeFileSync(path.join(runtimeDir, 'manifest.json'), JSON.stringify({
    version: WHISPER_VERSION, revision: WHISPER_REVISION, platform: local.platform, arch: local.arch, libraries,
  }));
  return local;
}
afterEach(() => execFile.mockReset());

describe('optional local dictation downloads', () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'dictation-local-test-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('does nothing on construction and clearly marks unsupported architectures', async () => {
    const fetch = jest.fn();
    const local = new LocalDictation({ dataDir: root, platform: 'win32', arch: 'arm64', fetch });
    expect(local.supported).toBe(false); expect(local.ready()).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]); expect(fetch).not.toHaveBeenCalled();
    await expect(local.install(new AbortController().signal)).rejects.toMatchObject({ code: 'DICTATION_LOCAL' });
  });

  test('downloads into a new file and refuses a checksum mismatch before extraction', async () => {
    const data = Buffer.from('a fixed harmless archive fixture');
    const fetch = jest.fn(async () => new Response(data));
    const local = new LocalDictation({ dataDir: root, fetch });
    const destination = path.join(root, 'archive');
    await expect(local.download('https://example.invalid/fixture', '0'.repeat(64), destination, new AbortController().signal, () => {}, 'Fixture'))
      .rejects.toMatchObject({ code: 'DICTATION_INTEGRITY' });
    expect(fs.readFileSync(destination)).toEqual(data);
    const valid = path.join(root, 'checked');
    await local.download('https://example.invalid/fixture', createHash('sha256').update(data).digest('hex'), valid,
      new AbortController().signal, () => {}, 'Fixture');
    expect(fs.readFileSync(valid)).toEqual(data); expect(local.ready()).toBe(false);
  });

  test('a failed HTTP download never creates an install or executable', async () => {
    const local = fixture(root, { fetch: async () => new Response('', { status: 503 }) });
    await expect(local.install(new AbortController().signal)).rejects.toMatchObject({ code: 'DICTATION_DOWNLOAD' });
    expect(local.ready()).toBe(false);
    expect(fs.readdirSync(path.dirname(local.root))).toEqual([]);
  });
});


test('startup removes only abandoned profile-owned phrase directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dictation-stale-test-'));
  try {
    const scratch = path.join(root, 'dictation-audio');
    fs.mkdirSync(path.join(scratch, 'phrase-Ab1234'), { recursive: true });
    fs.writeFileSync(path.join(scratch, 'phrase-Ab1234', 'recording.wav'), 'private fixture audio');
    fs.writeFileSync(path.join(scratch, 'unrelated.txt'), 'keep');
    new LocalDictation({ dataDir: root });
    expect(fs.readdirSync(scratch)).toEqual(['unrelated.txt']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test('a model install is atomic, downloads no executable and leaves legacy installations alone', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dictation-model-test-'));
  try {
    const local = fixture(root);
    const legacy = path.join(root, 'dictation-local', 'sherpa-1.13.8-whisper-base-win32-x64');
    fs.mkdirSync(legacy, { recursive: true }); fs.writeFileSync(path.join(legacy, 'keep'), 'legacy');
    const download = jest.spyOn(local, 'download').mockImplementation(async (_url, _hash, destination) => {
      const fd = fs.openSync(destination, 'wx'); fs.ftruncateSync(fd, MODEL_BYTES); fs.closeSync(fd);
    });
    await local.install(new AbortController().signal);
    expect(local.ready()).toBe(true);
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0].slice(0, 2)).toEqual([MODEL_URL, MODEL_SHA256]);
    expect(fs.readFileSync(path.join(legacy, 'keep'), 'utf8')).toBe('legacy');
    expect(fs.readdirSync(local.root).sort()).toEqual(['NOTICES.txt', 'ggml-base.bin', 'installed.json']);
    expect(execFile).not.toHaveBeenCalled();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a missing or incompatible bundled runtime fails before a model download, without dev fallback', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dictation-runtime-test-'));
  try {
    const fetch = jest.fn();
    const local = new LocalDictation({ dataDir: root, packaged: true, resourcesPath: root, fetch });
    expect(local.executable).toBe(path.join(root, 'dictation-runtime', process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'));
    await expect(local.install(new AbortController().signal)).rejects.toThrow('speech engine is missing');
    expect(fetch).not.toHaveBeenCalled();
    const other = fixture(root);
    fs.writeFileSync(path.join(other.runtimeDir, 'manifest.json'), JSON.stringify({ version: 'old' }));
    expect(other.runtimeReady()).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Whisper uses discrete arguments, strips credential environment, returns text and clears audio on success or cancellation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dictation Jürgen 测试-'));
  const saved = process.env.OPENAI_API_KEY;
  try {
    process.env.OPENAI_API_KEY = 'not-a-real-key';
    const local = fixture(root);
    jest.spyOn(local, 'ready').mockReturnValue(true);
    const signal = new AbortController().signal;
    execFile.mockImplementation((_exe, _args, options, callback) => {
      expect(fs.existsSync(path.join(options.cwd, 'recording.wav'))).toBe(true);
      expect(options.env.OPENAI_API_KEY).toBeUndefined();
      const child = new EventEmitter();
      queueMicrotask(() => { callback(null, ' Hello world. \n'); child.emit('close', 0); });
      return child;
    });
    await expect(local.transcribe(Buffer.from('fixture audio'), 'de', signal)).resolves.toBe('Hello world.');
    const [, args, options] = execFile.mock.calls[0];
    expect(args).toEqual(['--model', path.relative(options.cwd, local.model), '--file', 'recording.wav',
      '--language', 'de', '--threads', '2', '--no-timestamps', '--no-prints', '--no-gpu']);
    expect(args.every(arg => /^[\x20-\x7e]*$/.test(arg))).toBe(true);
    expect(path.resolve(options.cwd, args[1])).toBe(local.model);
    expect(fs.readdirSync(local.scratchRoot)).toEqual([]);
    const abort = new AbortController(); abort.abort();
    execFile.mockImplementation((_exe, _args, _options, callback) => {
      const child = new EventEmitter();
      child.kill = jest.fn();
      queueMicrotask(() => { callback(new Error('aborted')); child.emit('close', null, 'SIGKILL'); });
      return child;
    });
    await expect(local.transcribe(Buffer.from('fixture'), 'auto', abort.signal)).rejects.toMatchObject({ code: 'DICTATION_CANCELLED' });
    expect(fs.readdirSync(local.scratchRoot)).toEqual([]);
  } finally {
    if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.each([
  ['\n [BLANK_AUDIO]\n', ''],
  ['[Musik]', ''],
  ['(music) [Silence]', ''],
  ['* Musik *', ''],
  ['*musique* *musique*', ''],
  ['**Musik**', ''],
  ['[BLANK_AUDIO] Hello world. [BLANK_AUDIO]', 'Hello world.'],
  ['[Music] Hello world.', '[Music] Hello world.'],
  ['Say [hello] to everyone.', 'Say [hello] to everyone.'],
  ['Use *italic* emphasis.', 'Use *italic* emphasis.'],
])('local output %j excludes non-speech-only annotations', async (output, expected) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dictation-tags-test-'));
  try {
    const local = fixture(root);
    jest.spyOn(local, 'ready').mockReturnValue(true);
    execFile.mockImplementation((_exe, _args, _options, callback) => {
      const child = new EventEmitter();
      queueMicrotask(() => { callback(null, output); child.emit('close', 0); });
      return child;
    });
    await expect(local.transcribe(Buffer.from('fixture audio'), 'auto', new AbortController().signal)).resolves.toBe(expected);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('cancellation waits for the native process to close before deleting audio or resolving shutdown work', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dictation-cancel-close-test-'));
  try {
    const local = fixture(root);
    jest.spyOn(local, 'ready').mockReturnValue(true);
    const controller = new AbortController();
    const child = new EventEmitter();
    child.kill = jest.fn();
    let callback;
    execFile.mockImplementation((_exe, _args, _options, done) => { callback = done; return child; });
    const pending = local.transcribe(Buffer.from('fixture audio'), 'en', controller.signal);
    let settled = false;
    const outcome = pending.catch(error => { settled = true; return error; });
    while (!callback) await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    callback(null, 'late text after cancellation');
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(fs.readdirSync(local.scratchRoot)).toHaveLength(1);
    child.emit('close', null, 'SIGKILL');
    await expect(outcome).resolves.toMatchObject({ code: 'DICTATION_CANCELLED' });
    expect(fs.readdirSync(local.scratchRoot)).toEqual([]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an invalid audio scratch directory disables local inference without breaking browser construction', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dictation-blocked-test-'));
  try {
    fs.writeFileSync(path.join(root, 'dictation-audio'), 'not a directory');
    const local = new LocalDictation({ dataDir: root });
    jest.spyOn(local, 'ready').mockReturnValue(true);
    await expect(local.transcribe(Buffer.alloc(100), 'auto', new AbortController().signal)).rejects.toThrow('could not be cleared');
    expect(fs.readFileSync(path.join(root, 'dictation-audio'), 'utf8')).toBe('not a directory');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
