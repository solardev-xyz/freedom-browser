const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {
  ANT_PROCESS_MARKER_FILE,
  clearAntProcessMarker,
  fetchNodeOverlay,
  findOwnLiveAntd,
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
