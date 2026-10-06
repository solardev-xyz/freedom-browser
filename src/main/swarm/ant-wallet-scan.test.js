const {
  parseWalletScan,
  isWalletScanFinished,
  walletScanPercent,
  mayRediscoverUnreported,
} = require('./ant-wallet-scan');

// Bodies as antd v0.5.59 serves them (captured from a live run, 2026-10-05).
const DONE = { state: 'done', from: 16514506, scannedThrough: 48602801, head: 48603825 };
const RETRYING = {
  state: 'retrying',
  from: null,
  scannedThrough: null,
  head: null,
  error: 'http: error sending request for url (<url>)',
};

describe('parseWalletScan', () => {
  test('reads the shape antd reports', () => {
    expect(parseWalletScan(DONE)).toEqual({ ...DONE, error: null });
    expect(parseWalletScan(RETRYING)).toEqual(RETRYING);
    expect(parseWalletScan({ state: 'pending' })).toEqual({
      state: 'pending',
      from: null,
      scannedThrough: null,
      head: null,
      error: null,
    });
  });

  test('an absent or malformed field is no report', () => {
    for (const raw of [undefined, null, 'scanning', 7, []]) {
      expect(parseWalletScan(raw)).toBeNull();
    }
  });

  test('a state this release does not know is kept as unknown, never finished', () => {
    const scan = parseWalletScan({ state: 'verifying' });
    expect(scan.state).toBe('unknown');
    expect(isWalletScanFinished(scan)).toBe(false);
  });

  test('drops non-integer block numbers and an error outside retrying', () => {
    const scan = parseWalletScan({
      state: 'scanning',
      from: '1',
      scannedThrough: -4,
      head: 1.5,
      error: 'x',
    });
    expect(scan).toMatchObject({ from: null, scannedThrough: null, head: null, error: null });
  });
});

test('done and confirming are finished; pending, scanning and retrying are not', () => {
  expect(isWalletScanFinished(parseWalletScan(DONE))).toBe(true);
  expect(isWalletScanFinished(parseWalletScan({ state: 'confirming' }))).toBe(true);
  for (const state of ['pending', 'scanning', 'retrying']) {
    expect(isWalletScanFinished(parseWalletScan({ state }))).toBe(false);
  }
  expect(isWalletScanFinished(null)).toBe(false);
});

describe('walletScanPercent', () => {
  const scanning = (scannedThrough) =>
    parseWalletScan({ state: 'scanning', from: 100, scannedThrough, head: 199 });

  test('is the share of this run’s blocks read so far', () => {
    expect(scanning(100)).toBeTruthy();
    expect(walletScanPercent(scanning(100))).toBe(1);
    expect(walletScanPercent(scanning(149))).toBe(50);
  });

  test('never says 100 while the scan runs, and is null before the first window', () => {
    expect(walletScanPercent(scanning(199))).toBe(99);
    expect(walletScanPercent(scanning(500))).toBe(99);
    expect(walletScanPercent(scanning(null))).toBeNull();
    expect(walletScanPercent(parseWalletScan(RETRYING))).toBeNull();
    expect(walletScanPercent(parseWalletScan({ state: 'pending' }))).toBeNull();
  });

  test('a finished scan has no progress to show', () => {
    expect(walletScanPercent(parseWalletScan(DONE))).toBeNull();
  });

  test('counts from an earlier origin, as antd resets `from` to its resume point on a retry', () => {
    const resumed = parseWalletScan({
      state: 'scanning',
      from: 150,
      scannedThrough: 159,
      head: 199,
    });
    expect(walletScanPercent(resumed)).toBe(20);
    expect(walletScanPercent(resumed, 100)).toBe(60);
    // A later or invalid origin is ignored.
    expect(walletScanPercent(resumed, 170)).toBe(20);
    expect(walletScanPercent(resumed, -1)).toBe(20);
    expect(walletScanPercent(resumed, null)).toBe(20);
  });
});

test('only antd v0.5.58 (or an antd of unknown version) may rediscover without reporting it', () => {
  expect(mayRediscoverUnreported('antd/0.5.58')).toBe(true);
  expect(mayRediscoverUnreported('antd/v0.5.58')).toBe(true);
  expect(mayRediscoverUnreported('antd/dev')).toBe(true);
  expect(mayRediscoverUnreported('antd/0.5.59')).toBe(false);
  expect(mayRediscoverUnreported('antd/0.5.45')).toBe(false);
  expect(mayRediscoverUnreported('antd/0.6.0')).toBe(false);
  expect(mayRediscoverUnreported('2.4.0-5b1b7e5c')).toBe(false);
  expect(mayRediscoverUnreported(null)).toBe(false);
});
