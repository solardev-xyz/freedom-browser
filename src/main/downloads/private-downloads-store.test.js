// PRIVATE MODE GUARD (downloads): the in-memory partition-scoped store.
// Deliberately requires the module directly, with no electron or
// better-sqlite3 mocks — proving it has no persistence dependencies is
// part of the guarantee under test.

const store = require('./private-downloads-store');

describe('private-downloads-store', () => {
  beforeEach(() => {
    store._resetState();
  });

  const insert = (overrides = {}) =>
    store.insertDownload({
      url: 'https://example.com/secret.zip',
      filename: 'secret.zip',
      savePath: '/tmp/secret.zip',
      mimeType: 'application/zip',
      totalBytes: 1024,
      partition: 'private-a',
      ...overrides,
    });

  test('inserts rows with negative, unique ids and the SQLite row shape', () => {
    const first = insert();
    const second = insert({ filename: 'other.zip' });

    expect(first.id).toBeLessThan(0);
    expect(second.id).toBeLessThan(0);
    expect(second.id).not.toBe(first.id);
    expect(first).toEqual(
      expect.objectContaining({
        url: 'https://example.com/secret.zip',
        filename: 'secret.zip',
        save_path: '/tmp/secret.zip',
        mime_type: 'application/zip',
        total_bytes: 1024,
        received_bytes: 0,
        state: 'in_progress',
        start_time: expect.any(Number),
        end_time: null,
        is_private: 1,
        session_partition: 'private-a',
      })
    );
    expect(store.getCount()).toBe(2);
  });

  test('updates use patch semantics and untouched fields survive', () => {
    const row = insert();

    expect(store.updateDownload(row.id, { receivedBytes: 500 })).toBe(true);
    let stored = store.getDownloadById(row.id);
    expect(stored.received_bytes).toBe(500);
    expect(stored.state).toBe('in_progress');
    expect(stored.total_bytes).toBe(1024);

    expect(
      store.updateDownload(row.id, { receivedBytes: 1024, state: 'completed', endTime: 123 })
    ).toBe(true);
    stored = store.getDownloadById(row.id);
    expect(stored.state).toBe('completed');
    expect(stored.end_time).toBe(123);

    expect(store.updateDownload(-9999, { state: 'completed' })).toBe(false);
  });

  test('queries are partition-scoped and newest first', () => {
    insert({ filename: 'a.zip', startTime: 100 });
    insert({ filename: 'b.zip', startTime: 300 });
    insert({ filename: 'other-window.zip', partition: 'private-b', startTime: 200 });

    const rows = store.getDownloads('private-a');
    expect(rows.map((r) => r.filename)).toEqual(['b.zip', 'a.zip']);
    expect(store.getDownloads('private-b').map((r) => r.filename)).toEqual(['other-window.zip']);
    expect(store.getDownloads('private-unknown')).toEqual([]);
  });

  test('search matches filename or url case-insensitively within the partition', () => {
    insert({ filename: 'Report.PDF', url: 'https://example.com/Report.PDF' });
    insert({ filename: 'photo.png', url: 'bzz://somehash/photo.png' });
    insert({ filename: 'Report.PDF', partition: 'private-b' });

    expect(store.searchDownloads('private-a', 'report')).toHaveLength(1);
    expect(store.searchDownloads('private-a', 'SOMEHASH')).toHaveLength(1);
    expect(store.searchDownloads('private-a', 'nothing')).toHaveLength(0);
    expect(store.searchDownloads('private-a', 'report', 1)).toHaveLength(1);
  });

  test('returned rows are copies — mutating them never corrupts the store', () => {
    const row = insert();
    const fetched = store.getDownloadById(row.id);
    fetched.url = 'tampered';
    expect(store.getDownloadById(row.id).url).toBe('https://example.com/secret.zip');
  });

  test('removeDownload drops a single row', () => {
    const row = insert();
    expect(store.removeDownload(row.id)).toBe(true);
    expect(store.removeDownload(row.id)).toBe(false);
    expect(store.getDownloadById(row.id)).toBe(null);
  });

  test('clearSettled keeps in-progress rows and other partitions', () => {
    const settled = insert({ filename: 'done.zip' });
    store.updateDownload(settled.id, { state: 'completed', endTime: Date.now() });
    insert({ filename: 'live.zip' });
    const otherSettled = insert({ filename: 'other.zip', partition: 'private-b' });
    store.updateDownload(otherSettled.id, { state: 'cancelled', endTime: Date.now() });

    expect(store.clearSettled('private-a')).toBe(1);
    expect(store.getDownloads('private-a').map((r) => r.filename)).toEqual(['live.zip']);
    expect(store.getDownloads('private-b')).toHaveLength(1);
  });

  test('dropPartition evaporates every row for that window only', () => {
    insert();
    insert({ filename: 'two.zip' });
    insert({ filename: 'keep.zip', partition: 'private-b' });

    expect(store.dropPartition('private-a')).toBe(2);
    expect(store.getCount()).toBe(1);
    expect(store.getDownloads('private-a')).toEqual([]);
    expect(store.dropPartition(null)).toBe(0);
    expect(store.dropPartition('')).toBe(0);
  });
});
