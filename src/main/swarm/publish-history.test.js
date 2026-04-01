jest.mock('electron', () => ({
  app: { getPath: () => '/tmp/test-publish-history' },
  ipcMain: { handle: jest.fn() },
}));

jest.mock('electron-log', () => ({
  info: jest.fn(),
  error: jest.fn(),
}));

// Mock fs to avoid real file I/O
const mockFs = {
  existsSync: jest.fn().mockReturnValue(false),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
};
jest.mock('fs', () => mockFs);

const { addEntry, updateEntry, getEntries, clearEntries, removeEntry } = require('./publish-history');

describe('publish-history', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFs.existsSync.mockReturnValue(false);
    // Force reload by clearing the module's internal cache
    clearEntries();
  });

  test('addEntry creates a record with generated id and timestamp', () => {
    const entry = addEntry({ type: 'file', name: 'test.txt', status: 'uploading' });

    expect(entry.id).toBeTruthy();
    expect(entry.type).toBe('file');
    expect(entry.name).toBe('test.txt');
    expect(entry.status).toBe('uploading');
    expect(entry.timestamp).toBeTruthy();
    expect(entry.reference).toBeNull();
    expect(entry.bzzUrl).toBeNull();
  });

  test('addEntry prepends to the list (newest first)', () => {
    addEntry({ name: 'first' });
    addEntry({ name: 'second' });

    const entries = getEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].name).toBe('second');
    expect(entries[1].name).toBe('first');
  });

  test('addEntry caps the list at 100 entries', () => {
    for (let i = 0; i < 105; i++) {
      addEntry({ name: `entry-${i}` });
    }

    const entries = getEntries();
    expect(entries).toHaveLength(100);
    expect(entries[0].name).toBe('entry-104');
  });

  test('updateEntry updates status and reference', () => {
    const entry = addEntry({ name: 'test', status: 'uploading' });

    const updated = updateEntry(entry.id, {
      status: 'completed',
      reference: 'abc123',
      bzzUrl: 'bzz://abc123',
    });

    expect(updated.status).toBe('completed');
    expect(updated.reference).toBe('abc123');
    expect(updated.bzzUrl).toBe('bzz://abc123');
  });

  test('updateEntry returns null for unknown id', () => {
    const result = updateEntry('nonexistent', { status: 'failed' });
    expect(result).toBeNull();
  });

  test('clearEntries empties the list', () => {
    addEntry({ name: 'test' });
    expect(getEntries()).toHaveLength(1);

    clearEntries();
    expect(getEntries()).toHaveLength(0);
  });

  test('removeEntry removes a specific entry', () => {
    const e1 = addEntry({ name: 'keep' });
    const e2 = addEntry({ name: 'remove' });

    removeEntry(e2.id);

    const entries = getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('keep');
  });

  test('getEntries returns a copy, not the internal array', () => {
    addEntry({ name: 'test' });
    const entries = getEntries();
    entries.push({ name: 'injected' });

    expect(getEntries()).toHaveLength(1);
  });

  test('save writes versioned JSON to disk', () => {
    addEntry({ name: 'test' });

    expect(mockFs.writeFileSync).toHaveBeenCalled();
    const calls = mockFs.writeFileSync.mock.calls;
    const [, data] = calls[calls.length - 1];
    const parsed = JSON.parse(data);
    expect(parsed.version).toBe(1);
    expect(parsed.entries).toHaveLength(1);
  });
});
