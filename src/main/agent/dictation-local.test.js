const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHash } = require('crypto');
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
