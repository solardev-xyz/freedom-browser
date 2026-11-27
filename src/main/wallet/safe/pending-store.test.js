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
  getStoreNotice,
  _resetForTests,
  _internals,
} = require('./pending-store');

function fsError(code) {
  const err = new Error(`${code}: simulated`);
  err.code = code;
  return err;
}

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
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(mockTestDir, 'safe-pending.json'), 'utf-8')
    );
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

  test('a corrupt file reports a notice naming the set-aside copy', () => {
    const storePath = path.join(mockTestDir, 'safe-pending.json');
    fs.writeFileSync(storePath, '{"5": {', 'utf-8');
    expect(getStoreNotice()).toBeNull();
    expect(listPendingIndexes()).toEqual([]);
    const notice = getStoreNotice();
    expect(notice.kind).toBe('quarantined');
    expect(fs.existsSync(notice.path)).toBe(true);
    expect(notice.message).toContain(notice.path);
  });

  test('a read I/O error is not quarantined, not cached, and heals on retry (R1-F2)', () => {
    const storePath = path.join(mockTestDir, 'safe-pending.json');
    const entry = { safeTxHash: '0x03', signatures: ['0xaa'] };
    fs.writeFileSync(storePath, JSON.stringify({ 3: entry }), 'utf-8');
    const before = fs.readFileSync(storePath, 'utf-8');

    const realRead = fs.readFileSync;
    const readSpy = jest.spyOn(fs, 'readFileSync').mockImplementationOnce((file, ...rest) => {
      if (file === storePath) throw fsError('EMFILE');
      return realRead(file, ...rest);
    });
    try {
      expect(() => listPendingIndexes()).toThrow(
        expect.objectContaining({ code: 'SAFE_PENDING_UNREADABLE' })
      );
    } finally {
      readSpy.mockRestore();
    }

    expect(fs.readdirSync(mockTestDir).filter((f) => f.includes('.corrupt-'))).toEqual([]);
    expect(fs.readFileSync(storePath, 'utf-8')).toBe(before);
    expect(getStoreNotice()).toBeNull();

    // The next call reads again and finds the entry
    expect(getPending(3)).toEqual(entry);
  });

  test('writes are refused while the store is unreadable', () => {
    const storePath = path.join(mockTestDir, 'safe-pending.json');
    fs.writeFileSync(storePath, JSON.stringify({ 3: { safeTxHash: '0x03' } }), 'utf-8');
    const before = fs.readFileSync(storePath, 'utf-8');

    const realRead = fs.readFileSync;
    const readSpy = jest.spyOn(fs, 'readFileSync').mockImplementation((file, ...rest) => {
      if (file === storePath) throw fsError('EBUSY');
      return realRead(file, ...rest);
    });
    try {
      expect(() => setPending(7, { safeTxHash: '0x07' })).toThrow(
        expect.objectContaining({ code: 'SAFE_PENDING_UNREADABLE' })
      );
      expect(() => clearPending(3)).toThrow(
        expect.objectContaining({ code: 'SAFE_PENDING_UNREADABLE' })
      );
    } finally {
      readSpy.mockRestore();
    }
    expect(fs.readFileSync(storePath, 'utf-8')).toBe(before);
  });

  test('a corrupt file that cannot be set aside is never overwritten (R1-F1)', () => {
    const storePath = path.join(mockTestDir, 'safe-pending.json');
    const torn = '{"3": {"safeTxHash": "0x03", "signatures": ["0x';
    fs.writeFileSync(storePath, torn, 'utf-8');

    const realRename = fs.renameSync;
    const renameSpy = jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (from === storePath) throw fsError('EPERM');
      return realRename(from, to);
    });
    try {
      expect(() => getPending(3)).toThrow(
        expect.objectContaining({ code: 'SAFE_PENDING_UNREADABLE' })
      );
      expect(() => setPending(7, { safeTxHash: '0x07' })).toThrow(
        expect.objectContaining({ code: 'SAFE_PENDING_UNREADABLE' })
      );
    } finally {
      renameSpy.mockRestore();
    }
    expect(fs.readFileSync(storePath, 'utf-8')).toBe(torn);
    expect(fs.readdirSync(mockTestDir).filter((f) => f.includes('.corrupt-'))).toEqual([]);

    // Once the rename works, the damaged copy is set aside and writes resume
    expect(getPending(3)).toBeNull();
    const corrupt = fs.readdirSync(mockTestDir).find((f) => f.includes('.corrupt-'));
    expect(fs.readFileSync(path.join(mockTestDir, corrupt), 'utf-8')).toBe(torn);
    setPending(7, { safeTxHash: '0x07' });
    expect(JSON.parse(fs.readFileSync(storePath, 'utf-8'))).toEqual({ 7: { safeTxHash: '0x07' } });
  });

  test('a failed write throws, keeps the previous file, and leaves memory matching disk (R1-M1)', () => {
    const storePath = path.join(mockTestDir, 'safe-pending.json');
    const initialEntry = { safeTxHash: '0xinitial', signatures: [] };
    setPending(5, initialEntry);

    const realWrite = fs.writeFileSync;
    const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation((target, ...rest) => {
      if (typeof target === 'number') throw fsError('ENOSPC');
      return realWrite(target, ...rest);
    });
    try {
      expect(() => setPending(5, { safeTxHash: '0xshould_fail', signatures: [] })).toThrow(
        /ENOSPC/
      );
      expect(() => setPending(9, { safeTxHash: '0x09', signatures: [] })).toThrow(/ENOSPC/);
      expect(() => clearPending(5)).toThrow(/ENOSPC/);
    } finally {
      writeSpy.mockRestore();
    }

    expect(getPending(5)).toEqual(initialEntry);
    expect(getPending(9)).toBeNull();
    expect(JSON.parse(fs.readFileSync(storePath, 'utf-8'))).toEqual({ 5: initialEntry });
    expect(fs.readdirSync(mockTestDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  test('mutating a returned entry does not change the stored one', () => {
    setPending(5, { safeTxHash: '0x05', signatures: [] });
    const entry = getPending(5);
    entry.superseded = true;
    entry.signatures.push('0xaa');
    expect(getPending(5)).toEqual({ safeTxHash: '0x05', signatures: [] });
  });

  test('a rename over a held file is retried on EPERM/EBUSY (R1-M2)', () => {
    const storePath = path.join(mockTestDir, 'safe-pending.json');
    const realRename = fs.renameSync;
    let failures = 2;
    const renameSpy = jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === storePath && failures > 0) {
        failures -= 1;
        throw fsError(failures ? 'EBUSY' : 'EPERM');
      }
      return realRename(from, to);
    });
    try {
      setPending(5, { safeTxHash: '0x05' });
      expect(renameSpy).toHaveBeenCalledTimes(3);
    } finally {
      renameSpy.mockRestore();
    }
    expect(JSON.parse(fs.readFileSync(storePath, 'utf-8'))).toEqual({ 5: { safeTxHash: '0x05' } });
  });

  test('a non-retryable rename error throws at once', () => {
    const storePath = path.join(mockTestDir, 'safe-pending.json');
    const realRename = fs.renameSync;
    const renameSpy = jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === storePath) throw fsError('EXDEV');
      return realRename(from, to);
    });
    try {
      expect(() => setPending(5, { safeTxHash: '0x05' })).toThrow(/EXDEV/);
      expect(renameSpy).toHaveBeenCalledTimes(1);
    } finally {
      renameSpy.mockRestore();
    }
    expect(fs.existsSync(storePath)).toBe(false);
    expect(fs.readdirSync(mockTestDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  test('stale crash-orphaned temp files are swept on first load; fresh ones and .corrupt copies stay (R1-M2)', () => {
    const old = new Date(Date.now() - _internals.STALE_TMP_MS - 5_000);
    const stale = path.join(mockTestDir, 'safe-pending.json.0123456789abcdef.tmp');
    const fresh = path.join(mockTestDir, 'safe-pending.json.fedcba9876543210.tmp');
    const corrupt = path.join(mockTestDir, 'safe-pending.json.corrupt-1700000000000');
    const unrelated = path.join(mockTestDir, 'other.json.0123456789abcdef.tmp');
    for (const file of [stale, fresh, corrupt, unrelated]) {
      fs.writeFileSync(file, 'x');
    }
    for (const file of [stale, corrupt, unrelated]) {
      fs.utimesSync(file, old, old);
    }

    listPendingIndexes();

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(corrupt)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
  });
});
