const ipcHandlers = {};
jest.mock('electron', () => ({
  ipcMain: {
    handle: (channel, handler) => {
      ipcHandlers[channel] = handler;
    },
    removeHandler: () => {},
  },
  dialog: { showOpenDialog: (...args) => mockShowOpenDialog(...args) },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
}));
const mockShowOpenDialog = jest.fn();

const mockUploadData = jest.fn();
const mockUploadFile = jest.fn();
const mockUploadFilesFromDirectory = jest.fn();
const mockUploadCollection = jest.fn();
const mockRetrieveTag = jest.fn();
const mockGetPostageBatches = jest.fn();

jest.mock('@ethersphere/bee-js', () => ({
  Bee: jest.fn().mockImplementation(() => ({
    data: {
      upload: mockUploadData,
    },
    file: {
      upload: mockUploadFile,
    },
    collection: {
      upload: mockUploadCollection,
      uploadFromDirectory: mockUploadFilesFromDirectory,
    },
    tag: {
      get: mockRetrieveTag,
    },
    stamp: {
      getAll: mockGetPostageBatches,
    },
  })),
}));

jest.mock('../service-registry', () => ({
  getAntApiUrl: jest.fn().mockReturnValue('http://127.0.0.1:1633'),
}));

jest.mock('electron-log', () => ({
  info: jest.fn(),
  error: jest.fn(),
}));

jest.mock('./publish-history', () => ({
  addEntry: jest.fn(() => ({ id: 'test-history-id' })),
  updateEntry: jest.fn(),
}));

jest.mock('../profile-paths', () => ({
  createProfileTempDir: jest.fn(() => '/tmp/freedom-profile-swarm-publish'),
}));

// Mock fs for file operations
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  statSync: jest.fn(),
  createReadStream: jest.fn(() => ({ pipe: jest.fn(), on: jest.fn() })),
  readdirSync: jest.fn(),
}));

jest.mock('fs/promises', () => ({
  readdir: jest.fn().mockResolvedValue([]),
  stat: jest.fn().mockResolvedValue({ size: 0 }),
}));

const fs = require('fs');
const fsp = require('fs/promises');
const {
  normalizeUploadResult,
  normalizeTag,
  publishCollection,
  registerPublishIpc,
  USER_ORIGIN,
} = require('./publish-service');

registerPublishIpc();

// A stand-in webContents: the pick tokens are bound to sender.id.
function makeSender(id = 1) {
  const listeners = {};
  return {
    id,
    once: (name, fn) => {
      listeners[name] = fn;
    },
    emit: (name) => listeners[name]?.(),
  };
}
const SENDER = makeSender(1);

async function invokeIpc(channel, ...args) {
  return invokeIpcFrom(SENDER, channel, ...args);
}

async function invokeIpcFrom(sender, channel, ...args) {
  const handler = ipcHandlers[channel];
  if (!handler) throw new Error(`No handler for ${channel}`);
  return handler({ sender }, ...args);
}

// Run the native picker (stubbed to choose `chosenPath`) and return its token.
async function pick(kind, chosenPath, sender = SENDER) {
  mockShowOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [chosenPath] });
  const result = await invokeIpcFrom(
    sender,
    kind === 'file' ? 'swarm:pick-file' : 'swarm:pick-directory'
  );
  expect(result.success).toBe(true);
  return result.token;
}

function makeRef(hex) {
  return { toHex: () => hex };
}

function makeBatch(id, remainingBytes, ttlSeconds) {
  return {
    batchID: { toHex: () => id },
    usable: true,
    remainingSize: { toBytes: () => remainingBytes },
    duration: { toSeconds: () => ttlSeconds },
  };
}

describe('publish-service', () => {
  describe('normalizeUploadResult', () => {
    test('normalizes a bee-js UploadResult', () => {
      const result = normalizeUploadResult(
        { reference: makeRef('abc123'), tagUid: 42 },
        'batch-hex',
        1024
      );
      expect(result).toEqual({
        reference: 'abc123',
        bzzUrl: 'bzz://abc123',
        tagUid: 42,
        batchIdUsed: 'batch-hex',
        bytesSize: 1024,
      });
    });

    test('handles missing tagUid and missing bytesSize', () => {
      const result = normalizeUploadResult({ reference: makeRef('def') }, null);
      expect(result.tagUid).toBeNull();
      expect(result.batchIdUsed).toBeNull();
      expect(result.bytesSize).toBeNull();
    });
  });

  describe('normalizeTag', () => {
    test('computes progress from sent count and done flag', () => {
      expect(
        normalizeTag({ uid: 1, split: 100, synced: 75, seen: 10, stored: 90, sent: 85 })
      ).toEqual({
        tagUid: 1,
        split: 100,
        seen: 10,
        stored: 90,
        sent: 85,
        synced: 75,
        progress: 85,
        done: false,
      });
    });

    test('marks done when acknowledged and already-seen chunks cover split', () => {
      const tag = normalizeTag({ uid: 2, split: 10, synced: 5, seen: 10, stored: 10, sent: 10 });
      expect(tag.done).toBe(true);
      expect(tag.progress).toBe(100);
    });

    test('handles zero split gracefully', () => {
      const tag = normalizeTag({ uid: 3, split: 0, synced: 0 });
      expect(tag.progress).toBe(0);
      expect(tag.done).toBe(false);
    });
  });

  describe('publishCollection', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    test('uploads exact in-memory files without a staging directory', async () => {
      mockGetPostageBatches.mockResolvedValue([makeBatch('batch4', 1000000000, 86400)]);
      mockUploadCollection.mockResolvedValue({
        reference: makeRef('collectionref'),
        tagUid: 40,
      });
      const files = [
        { path: 'index.html', bytes: Buffer.from('<main>Hello</main>') },
        { path: 'assets/app.js', bytes: Buffer.from('ready();') },
      ];

      const result = await publishCollection(files, {});

      expect(result).toEqual({
        reference: 'collectionref',
        bzzUrl: 'bzz://collectionref',
        tagUid: 40,
        batchIdUsed: 'batch4',
        bytesSize: Buffer.byteLength('<main>Hello</main>ready();'),
      });
      expect(mockUploadCollection).toHaveBeenCalledWith(
        'batch4',
        [
          expect.objectContaining({ path: 'index.html', size: 18, file: expect.any(Object) }),
          expect.objectContaining({ path: 'assets/app.js', size: 8, file: expect.any(Object) }),
        ],
        expect.objectContaining({ pin: true, deferred: true, indexDocument: 'index.html' })
      );
      const uploaded = mockUploadCollection.mock.calls[0][1];
      await expect(uploaded[0].file.arrayBuffer()).resolves.toEqual(
        Uint8Array.from(files[0].bytes).buffer
      );
      await expect(uploaded[1].file.arrayBuffer()).resolves.toEqual(
        Uint8Array.from(files[1].bytes).buffer
      );
    });
  });

  describe('Swarm encryption for private draft links (#741 E)', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    test('encrypt: true reaches the collection and data uploads; it is never on by default', async () => {
      const { publishData } = require('./publish-service');
      mockUploadCollection.mockResolvedValue({ reference: makeRef('e'.repeat(128)), tagUid: 41 });
      mockUploadFile.mockResolvedValue({ reference: makeRef('e'.repeat(128)), tagUid: 42 });
      const files = [{ path: 'index.html', bytes: Buffer.from('<p>draft</p>') }];
      const collection = await publishCollection(files, { batchId: 'batch5', encrypt: true });
      expect(mockUploadCollection.mock.calls[0][2]).toMatchObject({ encrypt: true });
      expect(collection.bzzUrl).toBe(`bzz://${'e'.repeat(128)}`);
      await publishData('draft text', { batchId: 'batch5', encrypt: true });
      expect(mockUploadFile.mock.calls[0][3]).toMatchObject({ encrypt: true });
      await publishCollection(files, { batchId: 'batch5' });
      await publishData('public text', { batchId: 'batch5', encrypt: 'yes' });
      expect(mockUploadCollection.mock.calls[1][2]).not.toHaveProperty('encrypt');
      expect(mockUploadFile.mock.calls[1][3]).not.toHaveProperty('encrypt');
    });

    test('an encrypted tag address is reported as the reference', () => {
      expect(normalizeTag({ uid: 1, split: 2, synced: 2, address: 'E'.repeat(128) }).reference).toBe('e'.repeat(128));
      expect(normalizeTag({ uid: 1, split: 2, synced: 2, address: 'e'.repeat(100) })).not.toHaveProperty('reference');
    });
  });

  describe('IPC handlers', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    test('swarm:publish-data uploads via file.upload and returns normalized result', async () => {
      mockGetPostageBatches.mockResolvedValue([
        makeBatch('batch1', 1000000000, 86400),
      ]);
      mockUploadFile.mockResolvedValue({
        reference: makeRef('dataref123'),
        tagUid: 10,
      });

      const result = await invokeIpc('swarm:publish-data', 'hello world');
      expect(result.success).toBe(true);
      expect(result.reference).toBe('dataref123');
      expect(result.bzzUrl).toBe('bzz://dataref123');
      expect(result.tagUid).toBe(10);
      // batchIdUsed and bytesSize are captured in the history row but not
      // surfaced in the IPC reply — the renderer doesn't use them.
      expect(result.batchIdUsed).toBeUndefined();
      expect(result.bytesSize).toBeUndefined();
      expect(mockUploadFile).toHaveBeenCalledWith(
        'batch1',
        'hello world',
        'data',
        expect.objectContaining({ pin: true, deferred: false, contentType: 'text/plain' })
      );
    });

    test('swarm:publish-data marks history entry as failed on upload error', async () => {
      const { addEntry, updateEntry } = require('./publish-history');
      mockGetPostageBatches.mockResolvedValue([makeBatch('batch1', 1000000000, 86400)]);
      mockUploadFile.mockRejectedValue(new Error('Bee upload failed'));

      const result = await invokeIpc('swarm:publish-data', 'test');
      expect(result.success).toBe(false);
      expect(addEntry).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'uploading', origin: USER_ORIGIN })
      );
      expect(updateEntry).toHaveBeenCalledWith('test-history-id', {
        status: 'failed',
        errorMessage: 'Bee upload failed',
      });
    });

    // A batch bought moments ago that storer peers have not synced: the page
    // reads "try again shortly", the history keeps the node's own words.
    test('swarm:publish-data explains a batch the network does not know yet', async () => {
      const { updateEntry } = require('./publish-history');
      const nodeError = "Unprocessable Entity: {\"code\":422,\"message\":\"push chunk failed: pushsync: postage batch 0xb8be73e4475fe3166d58a935d31bcfae417e6265143ba037cd271e89430b6ab1 rejected by 2 peer(s) as not found on-chain (peer said: invalid stamp: batchstore get: get batch b8be73e4475fe3166d58a935d31bcfae417e6265143ba037cd271e89430b6ab1: storage: not found, not found)\"}";
      mockGetPostageBatches.mockResolvedValue([makeBatch('batch1', 1000000000, 86400)]);
      mockUploadFile.mockRejectedValue(new Error(nodeError));

      const result = await invokeIpc('swarm:publish-data', 'test');
      expect(result).toEqual({
        success: false,
        error: 'Your storage is still reaching the Swarm network. Try again in a minute.',
      });
      expect(updateEntry).toHaveBeenCalledWith('test-history-id', {
        status: 'failed',
        errorMessage: nodeError,
      });
    });

    test('swarm:publish-data fails when no usable batch', async () => {
      mockGetPostageBatches.mockResolvedValue([]);

      const result = await invokeIpc('swarm:publish-data', 'test');
      expect(result.success).toBe(false);
      expect(result.error).toContain('No usable postage batch');
      // freedom://publish offers the setup on this one.
      expect(result.needsStorage).toBe(true);
    });

    test('swarm:publish-data offers storage recovery when existing batches are full', async () => {
      mockGetPostageBatches.mockResolvedValue([makeBatch('full', 0, 86400)]);
      const result = await invokeIpc('swarm:publish-data', 'test');
      expect(result.success).toBe(false);
      expect(result.error).toContain('enough capacity');
      expect(result.needsStorage).toBe(true);
      expect(mockUploadFile).not.toHaveBeenCalled();
    });

    test('swarm:publish-data rejects empty input', async () => {
      const result = await invokeIpc('swarm:publish-data', null);
      expect(result.success).toBe(false);
    });

    test('swarm:publish-file uploads from filesystem path using stream', async () => {
      const mockStream = { pipe: jest.fn(), on: jest.fn() };
      fs.existsSync.mockReturnValue(true);
      fs.statSync.mockReturnValue({ size: 5000, isDirectory: () => false });
      fs.createReadStream.mockReturnValue(mockStream);
      mockGetPostageBatches.mockResolvedValue([makeBatch('batch2', 1000000000, 86400)]);
      mockUploadFile.mockResolvedValue({
        reference: makeRef('fileref456'),
        tagUid: 20,
      });

      const token = await pick('file', '/tmp/test.txt');
      const result = await invokeIpc('swarm:publish-file', token);
      expect(result.success).toBe(true);
      expect(result.reference).toBe('fileref456');
      expect(fs.createReadStream).toHaveBeenCalledWith('/tmp/test.txt');
      expect(mockUploadFile).toHaveBeenCalledWith(
        'batch2',
        mockStream,
        'test.txt',
        expect.objectContaining({ pin: true, deferred: true, size: 5000 })
      );
    });

    test('swarm:publish-file rejects missing file', async () => {
      fs.existsSync.mockReturnValue(false);

      const token = await pick('file', '/home/u/docs/nonexistent.txt');
      const result = await invokeIpc('swarm:publish-file', token);
      expect(result.success).toBe(false);
      expect(result.error).toBe('File not found: nonexistent.txt');
      expect(result.error).not.toContain('/home/u');
    });

    test('swarm:publish-directory reports a missing folder by name only', async () => {
      fs.existsSync.mockReturnValue(false);

      const token = await pick('directory', '/home/u/sites/blog');
      const result = await invokeIpc('swarm:publish-directory', token);
      expect(result).toEqual({ success: false, error: 'Directory not found: blog' });
    });

    test('swarm:publish-directory resolves by name only when the folder vanishes between the checks', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.statSync.mockImplementationOnce(() => {
        throw Object.assign(
          new Error("ENOENT: no such file or directory, stat '/home/u/sites/blog'"),
          { code: 'ENOENT', syscall: 'stat', path: '/home/u/sites/blog' }
        );
      });

      const token = await pick('directory', '/home/u/sites/blog');
      const result = await invokeIpc('swarm:publish-directory', token);
      expect(result).toEqual({ success: false, error: 'Directory not found: blog' });
    });

    test('an fs error during publish (file vanished after the check) never returns the absolute path', async () => {
      fs.existsSync.mockReturnValue(true);
      const enoent = Object.assign(
        new Error("ENOENT: no such file or directory, stat '/home/u/docs/x.txt'"),
        { code: 'ENOENT', syscall: 'stat', path: '/home/u/docs/x.txt' }
      );
      fs.statSync.mockImplementationOnce(() => { throw enoent; });

      const token = await pick('file', '/home/u/docs/x.txt');
      const result = await invokeIpc('swarm:publish-file', token);
      expect(result).toEqual({ success: false, error: 'Could not read "x.txt" (ENOENT)' });
      expect(require('./publish-history').updateEntry).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ status: 'failed', errorMessage: 'Could not read "x.txt" (ENOENT)' })
      );
    });

    test('swarm:publish-directory uploads with auto index.html detection', async () => {
      fs.existsSync.mockImplementation((p) => {
        if (p === '/tmp/site') return true;
        if (p === '/tmp/site/index.html') return true;
        return false;
      });
      fs.statSync.mockImplementation((p) => {
        if (p === '/tmp/site') return { isDirectory: () => true, size: 0 };
        return { size: 1000 };
      });
      fsp.readdir.mockResolvedValue([
        { name: 'index.html', isDirectory: () => false, isFile: () => true },
        { name: 'style.css', isDirectory: () => false, isFile: () => true },
      ]);
      fsp.stat.mockResolvedValue({ size: 1000 });
      mockGetPostageBatches.mockResolvedValue([makeBatch('batch3', 1000000000, 86400)]);
      mockUploadFilesFromDirectory.mockResolvedValue({
        reference: makeRef('dirref789'),
        tagUid: 30,
      });

      const token = await pick('directory', '/tmp/site');
      const result = await invokeIpc('swarm:publish-directory', token);
      expect(result.success).toBe(true);
      expect(result.reference).toBe('dirref789');
      expect(mockUploadFilesFromDirectory).toHaveBeenCalledWith(
        'batch3',
        '/tmp/site',
        expect.objectContaining({
          pin: true,
          deferred: true,
          indexDocument: 'index.html',
        })
      );
    });

    test('the pickers answer with a token and a name, never the path', async () => {
      mockShowOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/home/u/notes.txt'] });
      const result = await invokeIpc('swarm:pick-file');
      expect(result).toEqual({ success: true, token: expect.stringMatching(/^[0-9a-f]{64}$/), name: 'notes.txt' });
      expect(JSON.stringify(result)).not.toContain('/home/u');
      expect(mockShowOpenDialog).toHaveBeenLastCalledWith(undefined, expect.objectContaining({ properties: ['openFile'] }));

      mockShowOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/home/u/site'] });
      const dir = await invokeIpc('swarm:pick-directory');
      expect(dir.token).toMatch(/^[0-9a-f]{64}$/);
      expect(mockShowOpenDialog).toHaveBeenLastCalledWith(undefined, expect.objectContaining({ properties: ['openDirectory'] }));
    });

    test('a cancelled pick returns no token', async () => {
      mockShowOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
      expect(await invokeIpc('swarm:pick-file')).toEqual({ success: true, token: null });
    });

    test('a pick without a sender id mints nothing', async () => {
      const result = await ipcHandlers['swarm:pick-file']({});
      expect(result.success).toBe(false);
      expect(mockShowOpenDialog).not.toHaveBeenCalled();
    });

    describe('publish handlers accept only a pick token', () => {
      const publishHistory = require('./publish-history');

      beforeEach(() => {
        fs.existsSync.mockReturnValue(true);
        fs.statSync.mockReturnValue({ size: 5, isDirectory: () => true });
        mockGetPostageBatches.mockResolvedValue([makeBatch('b', 1000000000, 86400)]);
        mockUploadFile.mockResolvedValue({ reference: makeRef('ref'), tagUid: 1 });
        mockUploadFilesFromDirectory.mockResolvedValue({ reference: makeRef('ref'), tagUid: 1 });
        jest.clearAllMocks();
      });

      const expectNothingPublished = () => {
        expect(publishHistory.addEntry).not.toHaveBeenCalled();
        expect(mockUploadFile).not.toHaveBeenCalled();
        expect(mockUploadFilesFromDirectory).not.toHaveBeenCalled();
        expect(fs.createReadStream).not.toHaveBeenCalled();
      };

      test.each([
        ['swarm:publish-file', '/home/u/.ssh/id_ed25519'],
        ['swarm:publish-directory', '/home/u/.ssh'],
      ])('%s refuses a raw filesystem path', async (channel, rawPath) => {
        const result = await invokeIpc(channel, rawPath);
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/choose the file or folder again/i);
        expectNothingPublished();
      });

      test.each([['swarm:publish-file'], ['swarm:publish-directory']])(
        '%s refuses a missing token',
        async (channel) => {
          const result = await invokeIpc(channel, undefined);
          expect(result.success).toBe(false);
          expectNothingPublished();
        }
      );

      test('a token publishes once; reusing it is refused', async () => {
        const token = await pick('file', '/home/u/a.txt');
        expect((await invokeIpc('swarm:publish-file', token)).success).toBe(true);
        jest.clearAllMocks();
        const again = await invokeIpc('swarm:publish-file', token);
        expect(again.success).toBe(false);
        expectNothingPublished();
      });

      test('a token from another sender is refused', async () => {
        const token = await pick('file', '/home/u/a.txt', makeSender(2));
        const result = await invokeIpc('swarm:publish-file', token);
        expect(result.success).toBe(false);
        expectNothingPublished();
      });

      test('an expired token is refused', async () => {
        const { TOKEN_TTL_MS } = require('./publish-pick-tokens');
        const realNow = Date.now;
        const start = realNow();
        Date.now = () => start;
        try {
          const token = await pick('directory', '/home/u/site');
          Date.now = () => start + TOKEN_TTL_MS + 1;
          const result = await invokeIpc('swarm:publish-directory', token);
          expect(result.success).toBe(false);
          expectNothingPublished();
        } finally {
          Date.now = realNow;
        }
      });

      test('a file token cannot publish a directory', async () => {
        const token = await pick('file', '/home/u');
        const result = await invokeIpc('swarm:publish-directory', token);
        expect(result.success).toBe(false);
        expectNothingPublished();
      });

      test('tokens die with the webContents that picked', async () => {
        const sender = makeSender(3);
        const token = await pick('file', '/home/u/a.txt', sender);
        sender.emit('destroyed');
        const result = await invokeIpcFrom(sender, 'swarm:publish-file', token);
        expect(result.success).toBe(false);
        expectNothingPublished();
      });
    });

    test('swarm:get-upload-status returns normalized tag', async () => {
      mockRetrieveTag.mockResolvedValue({
        uid: 42,
        split: 200,
        synced: 150,
        seen: 10,
        stored: 190,
        sent: 170,
      });

      const result = await invokeIpc('swarm:get-upload-status', 42);
      expect(result.success).toBe(true);
      expect(result.progress).toBe(85); // based on sent/split, not synced/split
      expect(result.done).toBe(false);
      expect(result.tagUid).toBe(42);
    });

    test('swarm:get-upload-status rejects non-number input', async () => {
      const result = await invokeIpc('swarm:get-upload-status', 'abc');
      expect(result.success).toBe(false);
    });
  });
});

// PRIVATE MODE GUARD coverage: publishing (and therefore publish-history
// writing) is rejected for private-window senders. jest.mock is hoisted,
// so this stub is in place before publish-service is required above.
jest.mock('../private/private-windows', () => ({
  isPrivateWebContents: (wc) => wc?.isPrivate === true,
}));

describe('private-window publish guard', () => {
  const PRIVATE_EVENT = { sender: { isPrivate: true } };
  const publishHistory = require('./publish-history');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test.each([
    ['swarm:publish-data', 'hello world'],
    ['swarm:publish-file', '/tmp/some-file.txt'],
    ['swarm:publish-directory', '/tmp/some-dir'],
  ])('%s rejects private senders without touching history or the node', async (channel, arg) => {
    const handler = ipcHandlers[channel];
    const result = await handler(PRIVATE_EVENT, arg);

    expect(result).toEqual({
      success: false,
      error: 'Publishing is unavailable in private windows',
    });
    expect(publishHistory.addEntry).not.toHaveBeenCalled();
    expect(publishHistory.updateEntry).not.toHaveBeenCalled();
    expect(mockUploadData).not.toHaveBeenCalled();
    expect(mockUploadFile).not.toHaveBeenCalled();
    expect(mockUploadFilesFromDirectory).not.toHaveBeenCalled();
  });
});
