const ipcHandlers = {};
jest.mock('electron', () => ({
  ipcMain: {
    handle: (channel, handler) => {
      ipcHandlers[channel] = handler;
    },
    removeHandler: () => {},
  },
}));

const mockUploadData = jest.fn();
const mockUploadFile = jest.fn();
const mockUploadFilesFromDirectory = jest.fn();
const mockRetrieveTag = jest.fn();
const mockGetPostageBatches = jest.fn();

jest.mock('@ethersphere/bee-js', () => ({
  Bee: jest.fn().mockImplementation(() => ({
    uploadData: mockUploadData,
    uploadFile: mockUploadFile,
    uploadFilesFromDirectory: mockUploadFilesFromDirectory,
    retrieveTag: mockRetrieveTag,
    getPostageBatches: mockGetPostageBatches,
  })),
}));

jest.mock('../service-registry', () => ({
  getBeeApiUrl: jest.fn().mockReturnValue('http://127.0.0.1:1633'),
}));

jest.mock('electron-log', () => ({
  info: jest.fn(),
  error: jest.fn(),
}));

jest.mock('./publish-history', () => ({
  addEntry: jest.fn(() => ({ id: 'test-history-id' })),
  updateEntry: jest.fn(),
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
const { normalizeUploadResult, normalizeTag, registerPublishIpc } = require('./publish-service');

registerPublishIpc();

async function invokeIpc(channel, ...args) {
  const handler = ipcHandlers[channel];
  if (!handler) throw new Error(`No handler for ${channel}`);
  return handler({}, ...args);
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
        'batch-hex'
      );
      expect(result).toEqual({
        reference: 'abc123',
        bzzUrl: 'bzz://abc123',
        tagUid: 42,
        batchIdUsed: 'batch-hex',
      });
    });

    test('handles missing tagUid', () => {
      const result = normalizeUploadResult({ reference: makeRef('def') }, null);
      expect(result.tagUid).toBeNull();
      expect(result.batchIdUsed).toBeNull();
    });
  });

  describe('normalizeTag', () => {
    test('computes progress from sent count and done flag', () => {
      expect(normalizeTag({ uid: 1, split: 100, synced: 75, seen: 80, stored: 90, sent: 85 })).toEqual({
        tagUid: 1,
        split: 100,
        seen: 80,
        stored: 90,
        sent: 85,
        synced: 75,
        progress: 85,
        done: false,
      });
    });

    test('marks done when sent >= split', () => {
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

  describe('IPC handlers', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    test('swarm:publish-data uploads via uploadFile and returns normalized result', async () => {
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
      expect(result.batchIdUsed).toBe('batch1');
      expect(mockUploadFile).toHaveBeenCalledWith(
        'batch1',
        'hello world',
        'data',
        expect.objectContaining({ pin: true, deferred: false, contentType: 'text/plain' })
      );
    });

    test('swarm:publish-data marks history entry as failed on upload error', async () => {
      const { addEntry, updateEntry } = require('./publish-history');
      mockGetPostageBatches.mockResolvedValue([
        makeBatch('batch1', 1000000000, 86400),
      ]);
      mockUploadFile.mockRejectedValue(new Error('Bee upload failed'));

      const result = await invokeIpc('swarm:publish-data', 'test');
      expect(result.success).toBe(false);
      expect(addEntry).toHaveBeenCalledWith(expect.objectContaining({ status: 'uploading' }));
      expect(updateEntry).toHaveBeenCalledWith('test-history-id', { status: 'failed' });
    });

    test('swarm:publish-data fails when no usable batch', async () => {
      mockGetPostageBatches.mockResolvedValue([]);

      const result = await invokeIpc('swarm:publish-data', 'test');
      expect(result.success).toBe(false);
      expect(result.error).toContain('No usable postage batch');
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
      mockGetPostageBatches.mockResolvedValue([
        makeBatch('batch2', 1000000000, 86400),
      ]);
      mockUploadFile.mockResolvedValue({
        reference: makeRef('fileref456'),
        tagUid: 20,
      });

      const result = await invokeIpc('swarm:publish-file', '/tmp/test.txt');
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

      const result = await invokeIpc('swarm:publish-file', '/tmp/nonexistent.txt');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
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
      mockGetPostageBatches.mockResolvedValue([
        makeBatch('batch3', 1000000000, 86400),
      ]);
      mockUploadFilesFromDirectory.mockResolvedValue({
        reference: makeRef('dirref789'),
        tagUid: 30,
      });

      const result = await invokeIpc('swarm:publish-directory', '/tmp/site');
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

    test('swarm:get-upload-status returns normalized tag', async () => {
      mockRetrieveTag.mockResolvedValue({
        uid: 42,
        split: 200,
        synced: 150,
        seen: 180,
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
