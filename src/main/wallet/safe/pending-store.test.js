const path = require('path');
const fs = require('fs');
const os = require('os');

let mockTestDir;
jest.mock('electron', () => ({
  app: {
    getPath: (name) => {
      if (name === 'userData') return mockTestDir;
      return mockTestDir;
    },
  },
}));

const {
  getPending,
  setPending,
  clearPending,
  listPendingIndexes,
  _resetForTests,
} = require('./pending-store');

describe('Safe pending-store atomic resilience', () => {
  beforeEach(() => {
    mockTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-pending-test-'));
    _resetForTests();
  });

  afterEach(() => {
    _resetForTests();
    try {
      fs.rmSync(mockTestDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  test('normal CRUD operations persist and clear entries', () => {
    expect(getPending(5)).toBeNull();
    expect(listPendingIndexes()).toEqual([]);

    const entry = { safeTxHash: '0x1234', signatures: ['0xaa'] };
    setPending(5, entry);

    expect(getPending(5)).toEqual(entry);
    expect(listPendingIndexes()).toEqual([5]);

    // Check on disk
    const onDisk = JSON.parse(fs.readFileSync(path.join(mockTestDir, 'safe-pending.json'), 'utf-8'));
    expect(onDisk['5']).toEqual(entry);

    // Add another safe index
    setPending(8, { safeTxHash: '0x5678', signatures: [] });
    expect(listPendingIndexes().sort((a, b) => a - b)).toEqual([5, 8]);

    // Clear index 5
    clearPending(5);
    expect(getPending(5)).toBeNull();
    expect(getPending(8)).not.toBeNull();
    expect(listPendingIndexes()).toEqual([8]);

    // Cache reset reloads from disk
    _resetForTests();
    expect(getPending(8)).toEqual({ safeTxHash: '0x5678', signatures: [] });
  });

  test('a torn/corrupt file is moved aside to .corrupt-<timestamp> and preserved', () => {
    const storePath = path.join(mockTestDir, 'safe-pending.json');
    const tornContent = '{"5": {"safeTxHash": "0xbroken", "signatures": ["0x';
    fs.writeFileSync(storePath, tornContent, 'utf-8');

    // Loading detects corruption, moves aside, and starts fresh in memory
    expect(getPending(5)).toBeNull();
    expect(listPendingIndexes()).toEqual([]);

    // The corrupt file was moved aside
    const files = fs.readdirSync(mockTestDir);
    const corruptBackup = files.find((f) => f.startsWith('safe-pending.json.corrupt-'));
    expect(corruptBackup).toBeDefined();

    // The content in the corrupt backup is exactly preserved
    const preservedContent = fs.readFileSync(path.join(mockTestDir, corruptBackup), 'utf-8');
    expect(preservedContent).toBe(tornContent);

    // Subsequent write creates a new valid file without touching the corrupt backup
    setPending(5, { safeTxHash: '0xvalid', signatures: [] });
    const freshContent = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
    expect(freshContent['5'].safeTxHash).toBe('0xvalid');
    expect(fs.existsSync(path.join(mockTestDir, corruptBackup))).toBe(true);
  });

  test('a non-object root is quarantined rather than treated as valid state', () => {
    const storePath = path.join(mockTestDir, 'safe-pending.json');
    fs.writeFileSync(storePath, '["not", "an", "object"]', 'utf-8');

    expect(getPending(5)).toBeNull();

    const files = fs.readdirSync(mockTestDir);
    const corruptBackup = files.find((f) => f.startsWith('safe-pending.json.corrupt-'));
    expect(corruptBackup).toBeDefined();
  });

  test('a failed atomic write preserves the existing file and cleans up temp files', () => {
    const storePath = path.join(mockTestDir, 'safe-pending.json');
    const initialEntry = { safeTxHash: '0xinitial', signatures: [] };
    setPending(5, initialEntry);

    // Spy on renameSync to simulate a failure (e.g. disk full / EPERM)
    const originalRenameSync = fs.renameSync;
    const renameSpy = jest.spyOn(fs, 'renameSync').mockImplementation((src, dest) => {
      if (typeof src === 'string' && src.includes('.tmp')) {
        throw new Error('EACCES: permission denied, rename');
      }
      return originalRenameSync(src, dest);
    });

    try {
      // Attempting to set pending should log failure and keep previous on-disk content
      setPending(5, { safeTxHash: '0xshould_fail', signatures: [] });

      // Existing file on disk remains unchanged with initial content
      const onDisk = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
      expect(onDisk['5']).toEqual(initialEntry);

      // Temporary files are unlinked and do not linger
      const files = fs.readdirSync(mockTestDir);
      const lingeringTmp = files.filter((f) => f.endsWith('.tmp'));
      expect(lingeringTmp).toHaveLength(0);
    } finally {
      renameSpy.mockRestore();
    }
  });
});
