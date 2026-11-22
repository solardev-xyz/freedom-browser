const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {
  ANT_PROCESS_MARKER_FILE,
  antdLockTryable,
  clearAntProcessMarker,
  fetchNodeOverlay,
  findOwnLiveAntd,
  readAntProcessMarkerState,
  recordAntProcessOverlay,
  writeAntProcessMarker,
} = require('./ant-process-marker');

const OVERLAY = 'ab'.repeat(32);
const OTHER_OVERLAY = 'cd'.repeat(32);

describe('ant-process-marker', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-ant-marker-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeVerified(marker) {
    writeAntProcessMarker(dir, marker);
    recordAntProcessOverlay(dir, marker.pid, OVERLAY);
  }

  test('finds a live antd this profile spawned, on the port it recorded', async () => {
    writeVerified({ pid: 4242, apiPort: 1635, dataDir: '/data' });
    const isProcessAlive = jest.fn(() => true);
    const fetchOverlay = jest.fn(async () => `0x${OVERLAY.toUpperCase()}`);

    expect(await findOwnLiveAntd(dir, { isProcessAlive, fetchOverlay })).toEqual({
      pid: 4242,
      apiPort: 1635,
      dataDir: '/data',
      overlay: OVERLAY,
    });
    expect(isProcessAlive).toHaveBeenCalledWith(4242);
    // R2-M1: probed on its own port, not the default 1633.
    expect(fetchOverlay).toHaveBeenCalledWith(1635);
    expect(await findOwnLiveAntd(dir, { apiPort: 1635, isProcessAlive, fetchOverlay }))
      .toMatchObject({ pid: 4242 });
    expect(await findOwnLiveAntd(dir, { apiPort: 1633, isProcessAlive, fetchOverlay }))
      .toBeNull();
  });

  // R2-M2: a recycled pid next to some other node on the port is not ours.
  test('needs the node on the recorded port to report the recorded overlay', async () => {
    writeVerified({ pid: 4242, apiPort: 1633, dataDir: '/data' });
    const isProcessAlive = () => true;

    expect(await findOwnLiveAntd(dir, {
      isProcessAlive, fetchOverlay: async () => OTHER_OVERLAY,
    })).toBeNull();
    expect(await findOwnLiveAntd(dir, {
      isProcessAlive, fetchOverlay: async () => null,
    })).toBeNull();
  });

  test('a marker that never recorded an overlay does not match', async () => {
    writeAntProcessMarker(dir, { pid: 4242, apiPort: 1633, dataDir: '/data' });
    const fetchOverlay = jest.fn(async () => OVERLAY);
    expect(await findOwnLiveAntd(dir, { isProcessAlive: () => true, fetchOverlay })).toBeNull();
    expect(fetchOverlay).not.toHaveBeenCalled();
  });

  test('records the overlay only on the marker of that pid, and only a valid one', () => {
    writeAntProcessMarker(dir, { pid: 2, apiPort: 1633, dataDir: '/data' });
    const read = () => JSON.parse(fs.readFileSync(path.join(dir, ANT_PROCESS_MARKER_FILE), 'utf-8'));
    recordAntProcessOverlay(dir, 1, OVERLAY);
    recordAntProcessOverlay(dir, 2, 'not-an-overlay');
    recordAntProcessOverlay(dir, 2, null);
    expect(read().overlay).toBeUndefined();
    recordAntProcessOverlay(dir, 2, OVERLAY);
    expect(read()).toEqual({ pid: 2, apiPort: 1633, dataDir: '/data', overlay: OVERLAY });
  });

  test('ignores a marker whose process is gone, or that names this process', async () => {
    const fetchOverlay = async () => OVERLAY;
    writeVerified({ pid: 4242, apiPort: 1633, dataDir: '/data' });
    expect(await findOwnLiveAntd(dir, { isProcessAlive: () => false, fetchOverlay })).toBeNull();

    writeVerified({ pid: process.pid, apiPort: 1633, dataDir: '/data' });
    expect(await findOwnLiveAntd(dir, { isProcessAlive: () => true, fetchOverlay })).toBeNull();
  });

  test('checks liveness and the overlay for real by default', async () => {
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(req.url === '/addresses' ? JSON.stringify({ overlay: OVERLAY }) : '{}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      expect(await fetchNodeOverlay(port)).toBe(OVERLAY);
      writeVerified({ pid: process.ppid, apiPort: port, dataDir: '/data' });
      expect(await findOwnLiveAntd(dir)).toMatchObject({ pid: process.ppid, apiPort: port });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    // Nothing listening any more.
    expect(await fetchNodeOverlay(port)).toBeNull();
    expect(await findOwnLiveAntd(dir)).toBeNull();
  });

  // The profile move's orphan check (freedom-core design 0013, MD7): any
  // live pid defers the move, overlay or not, with nothing asked of the node,
  // and a marker that is there but can't be read fails closed.
  describe('readAntProcessMarkerState', () => {
    const markerFile = () => path.join(dir, ANT_PROCESS_MARKER_FILE);

    test('a missing marker is none, the only state that lets the move go on', () => {
      expect(readAntProcessMarkerState(dir)).toEqual({ state: 'none' });
    });

    test('a live pid other than this process', () => {
      writeAntProcessMarker(dir, { pid: 4242, apiPort: 1633, dataDir: '/data' });
      expect(readAntProcessMarkerState(dir, { isProcessAlive: () => true })).toEqual({
        state: 'live',
        pid: 4242,
      });
      expect(readAntProcessMarkerState(dir, { isProcessAlive: () => false })).toEqual({
        state: 'gone',
        pid: 4242,
      });
      writeAntProcessMarker(dir, { pid: process.pid, apiPort: 1633, dataDir: '/data' });
      expect(readAntProcessMarkerState(dir, { isProcessAlive: () => true })).toEqual({
        state: 'gone',
        pid: process.pid,
      });
      // For real: the parent is alive.
      writeAntProcessMarker(dir, { pid: process.ppid, apiPort: 1633, dataDir: '/data' });
      expect(readAntProcessMarkerState(dir)).toEqual({ state: 'live', pid: process.ppid });
    });

    test('a malformed marker is unreadable', () => {
      fs.writeFileSync(markerFile(), '{not json');
      expect(readAntProcessMarkerState(dir, { isProcessAlive: () => false })).toEqual({
        state: 'unreadable',
        reason: 'malformed',
      });
    });

    test('a truncated marker (a torn in-place write) is unreadable', () => {
      const whole = JSON.stringify({ pid: 4242, apiPort: 1633, dataDir: '/data' }, null, 2);
      for (const length of [0, 1, 10, whole.length - 1]) {
        fs.writeFileSync(markerFile(), whole.slice(0, length));
        expect([length, readAntProcessMarkerState(dir, { isProcessAlive: () => false })]).toEqual([
          length,
          { state: 'unreadable', reason: 'malformed' },
        ]);
      }
    });

    test('a marker naming no integer pid, or not a file, is unreadable', () => {
      for (const text of ['{"pid":"4242"}', '{"pid":0}', '{"pid":-1}', '{"pid":1.5}', '{}', 'null', '[]']) {
        fs.writeFileSync(markerFile(), text);
        expect([text, readAntProcessMarkerState(dir)]).toEqual([
          text,
          { state: 'unreadable', reason: 'no_pid' },
        ]);
      }
      fs.rmSync(markerFile());
      fs.mkdirSync(markerFile());
      expect(readAntProcessMarkerState(dir)).toEqual({
        state: 'unreadable',
        reason: expect.any(String),
      });
    });
  });

  // Where the core's move (0.26.0) tries antd's own lock: a real ant-data/
  // directory holding a regular antd.lock, looked at without following.
  test('antdLockTryable: a real ant-data/ holding a regular antd.lock', () => {
    const antData = path.join(dir, 'ant-data');
    expect(antdLockTryable(dir)).toBe(false);
    fs.mkdirSync(antData);
    expect(antdLockTryable(dir)).toBe(false);
    fs.writeFileSync(path.join(antData, 'antd.lock'), '');
    expect(antdLockTryable(dir)).toBe(true);
    // A link at antd.lock, or a directory there, isn't the lock antd takes.
    fs.rmSync(path.join(antData, 'antd.lock'));
    fs.mkdirSync(path.join(antData, 'antd.lock'));
    expect(antdLockTryable(dir)).toBe(false);
    fs.rmSync(path.join(antData, 'antd.lock'), { recursive: true });
    if (process.platform !== 'win32') {
      fs.writeFileSync(path.join(dir, 'real-lock'), '');
      fs.symlinkSync(path.join(dir, 'real-lock'), path.join(antData, 'antd.lock'));
      expect(antdLockTryable(dir)).toBe(false);
    }
    // ant-data/ itself a link to a directory that holds one: not followed.
    fs.rmSync(antData, { recursive: true });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-ant-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'antd.lock'), '');
      fs.symlinkSync(outside, antData, process.platform === 'win32' ? 'junction' : 'dir');
      expect(antdLockTryable(dir)).toBe(false);
    } finally {
      fs.rmSync(antData, { force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('the marker is replaced whole through lib/atomic-file.js, the overlay rewrite too', () => {
    jest.isolateModules(() => {
      const writes = [];
      jest.doMock('./lib/atomic-file', () => {
        const actual = jest.requireActual('./lib/atomic-file');
        return {
          writeFileAtomicSync: jest.fn((file, data) => {
            writes.push(file);
            return actual.writeFileAtomicSync(file, data);
          }),
        };
      });
      const marker = require('./ant-process-marker');
      const file = path.join(dir, marker.ANT_PROCESS_MARKER_FILE);
      const writeSync = jest.spyOn(fs, 'writeFileSync');
      try {
        expect(marker.writeAntProcessMarker(dir, { pid: 4242, apiPort: 1635, dataDir: '/data' })).toBe(
          true
        );
        marker.recordAntProcessOverlay(dir, 4242, OVERLAY);
        // Never written in place.
        expect(writeSync.mock.calls.map(([target]) => target)).not.toContain(file);
      } finally {
        writeSync.mockRestore();
      }
      expect(writes).toEqual([file, file]);
      expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toMatchObject({ pid: 4242, overlay: OVERLAY });
      // No temp file left beside it.
      expect(fs.readdirSync(dir)).toEqual([marker.ANT_PROCESS_MARKER_FILE]);
    });
  });

  test("a write whose flush fails (durable: false) counts as failed, the overlay rewrite's too", () => {
    writeAntProcessMarker(dir, { pid: 4242, apiPort: 1635, dataDir: '/data' });
    // The real atomic write, with its post-rename flush failing: the temp
    // file's fsync comes first, the flush's second.
    const realSync = fs.fsyncSync;
    let calls = 0;
    const fsync = jest.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      calls += 1;
      if (calls % 2 === 0) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      return realSync(fd);
    });
    try {
      expect(recordAntProcessOverlay(dir, 4242, OVERLAY)).toBe(false);
      expect(writeAntProcessMarker(dir, { pid: 5151, apiPort: 1635, dataDir: '/data' })).toBe(false);
    } finally {
      fsync.mockRestore();
    }
    expect(calls).toBe(4);
    // The renames landed; only their flushes failed.
    expect(readAntProcessMarkerState(dir, { isProcessAlive: () => true })).toEqual({
      state: 'live',
      pid: 5151,
    });
    // And durable again once the flush works.
    expect(recordAntProcessOverlay(dir, 5151, OVERLAY)).toBe(true);
    expect(recordAntProcessOverlay(dir, 4242, OVERLAY)).toBeNull();
  });

  test('a write that fails leaves the old marker and says so', () => {
    writeAntProcessMarker(dir, { pid: 4242, apiPort: 1633, dataDir: '/data' });
    jest.isolateModules(() => {
      jest.doMock('./lib/atomic-file', () => ({
        writeFileAtomicSync: () => {
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        },
      }));
      const marker = require('./ant-process-marker');
      expect(marker.writeAntProcessMarker(dir, { pid: 5151, apiPort: 1633, dataDir: '/data' })).toBe(
        false
      );
    });
    expect(readAntProcessMarkerState(dir, { isProcessAlive: () => true })).toEqual({
      state: 'live',
      pid: 4242,
    });
  });

  test('clears only the marker of the process that exited', () => {
    writeAntProcessMarker(dir, { pid: 2, apiPort: 1633, dataDir: '/data' });
    clearAntProcessMarker(dir, 1);
    expect(fs.existsSync(path.join(dir, ANT_PROCESS_MARKER_FILE))).toBe(true);
    clearAntProcessMarker(dir, 2);
    expect(fs.existsSync(path.join(dir, ANT_PROCESS_MARKER_FILE))).toBe(false);
  });

  test('tolerates a missing dir, a missing pid, or an unreadable marker', async () => {
    expect(() => writeAntProcessMarker(null, { pid: 1, apiPort: 1633 })).not.toThrow();
    expect(() => recordAntProcessOverlay(null, 1, OVERLAY)).not.toThrow();
    writeAntProcessMarker(dir, { pid: undefined, apiPort: 1633 });
    expect(fs.existsSync(path.join(dir, ANT_PROCESS_MARKER_FILE))).toBe(false);
    fs.writeFileSync(path.join(dir, ANT_PROCESS_MARKER_FILE), '{not json');
    expect(await findOwnLiveAntd(dir)).toBeNull();
    expect(await findOwnLiveAntd(null)).toBeNull();
    expect(await fetchNodeOverlay(0)).toBeNull();
  });
});
