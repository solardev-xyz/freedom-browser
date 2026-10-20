const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHash } = require('crypto');
jest.mock('child_process', () => ({ execFile: jest.fn() }));
const { execFile } = require('child_process');
const { LocalDictation } = require('./dictation-local');

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
    const local = new LocalDictation({ dataDir: root, fetch: async () => new Response('', { status: 503 }) });
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


test('Windows install places dependent libraries beside the executable without replacing archive bin files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dictation-dll-test-'));
  try {
    const local = new LocalDictation({ dataDir: root, platform: 'win32', arch: 'x64' });
    jest.spyOn(local, 'download').mockResolvedValue();
    const stem = 'sherpa-onnx-v1.13.8-win-x64-shared-MT-Release-no-tts';
    const entries = ['bin/sherpa-onnx-offline.exe', 'lib/onnxruntime.dll', 'lib/shared.dll', 'bin/shared.dll'];
    execFile.mockImplementation((_exe, args, _options, callback) => {
      if (args[0] === '-tjf') callback(null, entries.map(entry => `${stem}/${entry}`).join('\n'));
      else callback(null, Buffer.from(args[2]));
    });
    await local.install(new AbortController().signal);
    expect(local.ready()).toBe(true);
    expect(fs.readFileSync(path.join(local.root, 'runtime', 'bin', 'onnxruntime.dll'), 'utf8')).toContain('/lib/onnxruntime.dll');
    expect(fs.readFileSync(path.join(local.root, 'runtime', 'bin', 'shared.dll'), 'utf8')).toContain('/bin/shared.dll');
  } finally { execFile.mockReset(); fs.rmSync(root, { recursive: true, force: true }); }
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
