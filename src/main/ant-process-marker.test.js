const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ANT_PROCESS_MARKER_FILE,
  clearAntProcessMarker,
  findOwnLiveAntd,
  writeAntProcessMarker,
} = require('./ant-process-marker');

describe('ant-process-marker', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-ant-marker-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('finds a live antd this profile spawned on the asked port', () => {
    writeAntProcessMarker(dir, { pid: 4242, apiPort: 1633, dataDir: '/data' });
    const isProcessAlive = jest.fn(() => true);

    expect(findOwnLiveAntd(dir, 1633, { isProcessAlive })).toEqual({
      pid: 4242,
      apiPort: 1633,
      dataDir: '/data',
    });
    expect(isProcessAlive).toHaveBeenCalledWith(4242);
    expect(findOwnLiveAntd(dir, 1635, { isProcessAlive })).toBeNull();
  });

  test('ignores a marker whose process is gone, or that names this process', () => {
    writeAntProcessMarker(dir, { pid: 4242, apiPort: 1633, dataDir: '/data' });
    expect(findOwnLiveAntd(dir, 1633, { isProcessAlive: () => false })).toBeNull();

    writeAntProcessMarker(dir, { pid: process.pid, apiPort: 1633, dataDir: '/data' });
    expect(findOwnLiveAntd(dir, 1633, { isProcessAlive: () => true })).toBeNull();
  });

  test('checks liveness for real by default', () => {
    writeAntProcessMarker(dir, { pid: process.ppid, apiPort: 1633, dataDir: '/data' });
    expect(findOwnLiveAntd(dir, 1633)).toMatchObject({ pid: process.ppid });
  });

  test('clears only the marker of the process that exited', () => {
    writeAntProcessMarker(dir, { pid: 2, apiPort: 1633, dataDir: '/data' });
    clearAntProcessMarker(dir, 1);
    expect(fs.existsSync(path.join(dir, ANT_PROCESS_MARKER_FILE))).toBe(true);
    clearAntProcessMarker(dir, 2);
    expect(fs.existsSync(path.join(dir, ANT_PROCESS_MARKER_FILE))).toBe(false);
  });

  test('tolerates a missing dir, a missing pid, or an unreadable marker', () => {
    expect(() => writeAntProcessMarker(null, { pid: 1, apiPort: 1633 })).not.toThrow();
    writeAntProcessMarker(dir, { pid: undefined, apiPort: 1633 });
    expect(fs.existsSync(path.join(dir, ANT_PROCESS_MARKER_FILE))).toBe(false);
    fs.writeFileSync(path.join(dir, ANT_PROCESS_MARKER_FILE), '{not json');
    expect(findOwnLiveAntd(dir, 1633)).toBeNull();
    expect(findOwnLiveAntd(null, 1633)).toBeNull();
  });
});
