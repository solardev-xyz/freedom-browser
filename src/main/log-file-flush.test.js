const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The installed electron-log's own Logger and File classes: log-file-flush.js
// reaches into the File's fields and relies on the Logger running hooks per
// transport before the transport writes, so a version that changes either has
// to fail here.
const electronLog = require('electron-log/node');
const File = require('electron-log/src/node/transports/file/File');
const NullFile = require('electron-log/src/node/transports/file/NullFile');
const {
  createLogFileHook,
  drainLogFile,
  flushLogFileSync,
  wantsSyncLogFile,
} = require('./log-file-flush');

let dir;
let logPath;
let seq = 0;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-file-flush-'));
  logPath = path.join(dir, 'main.log');
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const read = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '');
// Message text only, without electron-log's date/level prefix.
const lines = () =>
  read()
    .split(os.EOL)
    .filter(Boolean)
    .map((l) => l.replace(/^\[[^\]]*\] \[\w+\]\s+/, ''));
const waitIdle = async (file) => {
  while (file.hasActiveAsyncWriting || file.asyncWriteQueue.length) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

// A fresh electron-log logger set up the way logger.js sets up the app's.
function makeLogger() {
  seq += 1;
  const log = electronLog.create({ logId: `log-file-flush-test-${seq}` });
  log.transports.console.level = false;
  log.transports.file.level = 'info';
  log.transports.file.resolvePathFn = () => logPath;
  log.transports.file.sync = false;
  log.hooks.push(createLogFileHook());
  return log;
}

describe('with the hook installed', () => {
  test('a warn line is on disk when log.warn returns, after every earlier line, in order', async () => {
    const log = makeLogger();
    for (let i = 0; i < 20; i += 1) log.info(`info ${i}`);
    const file = log.transports.file.getFile();
    // The premise: the first batch is in flight, the rest queued, nothing on disk.
    expect(file.hasActiveAsyncWriting).toBe(true);
    expect(read()).toBe('');

    log.warn('the warning');
    // No awaiting: everything, the in-flight batch included, is already written.
    const expected = [...Array.from({ length: 20 }, (_, i) => `info ${i}`), 'the warning'];
    expect(lines()).toEqual(expected);

    // The in-flight batch's open callback lands afterwards and must not write it again.
    await waitIdle(file);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(lines()).toEqual(expected);
    expect(file.size).toBe(Buffer.byteLength(read()));
  });

  test('error behaves like warn', () => {
    const log = makeLogger();
    log.info('before');
    log.error('the error');
    expect(lines()).toEqual(['before', 'the error']);
  });

  test('info goes back to async after a warn, with no duplicates or reordering', async () => {
    const log = makeLogger();
    log.info('a');
    log.warn('w1');
    log.info('b');
    log.info('c');
    const file = log.transports.file.getFile();
    expect(file.writeAsync).toBe(true);
    expect(lines()).toEqual(['a', 'w1']);
    log.error('e1');
    expect(lines()).toEqual(['a', 'w1', 'b', 'c', 'e1']);
    for (let i = 0; i < 10; i += 1) log.info(`tail ${i}`);
    await waitIdle(file);
    expect(lines()).toEqual([
      'a',
      'w1',
      'b',
      'c',
      'e1',
      ...Array.from({ length: 10 }, (_, i) => `tail ${i}`),
    ]);
    expect(file.size).toBe(Buffer.byteLength(read()));
  });

  test('an info-only burst never calls writeFileSync and batches its opens', async () => {
    const log = makeLogger();
    log.info('first'); // creates the file (electron-log's testFileWriting)
    const file = log.transports.file.getFile();
    await waitIdle(file);

    const writeFileSync = jest.spyOn(fs, 'writeFileSync');
    const open = jest.spyOn(fs, 'open');
    for (let i = 0; i < 830; i += 1) log.info(`[Ant chain] eth_call via myotis ${i}`);
    expect(writeFileSync).not.toHaveBeenCalled();
    await waitIdle(file);
    expect(writeFileSync).not.toHaveBeenCalled();
    // One open per batch, not per line: the whole burst queues behind one write.
    expect(open.mock.calls.length).toBeLessThanOrEqual(2);
    const all = lines();
    expect(all).toHaveLength(831);
    expect(new Set(all).size).toBe(831);
    expect(all[830]).toBe('[Ant chain] eth_call via myotis 829');
  });

  test('flushLogFileSync rescues the in-flight batch, in order, and pins sync', async () => {
    const log = makeLogger();
    log.info('in-flight');
    log.info('queued');
    const file = log.transports.file.getFile();
    expect(file.hasActiveAsyncWriting).toBe(true);
    flushLogFileSync(log.transports.file);
    expect(lines()).toEqual(['in-flight', 'queued']);

    log.info('after flush'); // stays synchronous: the process is on its way out
    expect(lines()).toEqual(['in-flight', 'queued', 'after flush']);
    await waitIdle(file);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(lines()).toEqual(['in-flight', 'queued', 'after flush']);
  });

  test('drainLogFile keeps order without waiting on the batch writer', async () => {
    const log = makeLogger();
    for (let i = 0; i < 50; i += 1) log.info(`line ${i}`);
    await drainLogFile(log.transports.file);
    log.info('after drain');
    expect(lines()).toEqual([...Array.from({ length: 50 }, (_, i) => `line ${i}`), 'after drain']);
    const file = log.transports.file.getFile();
    await waitIdle(file);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(lines()).toHaveLength(51);
  });

  test('a failing synchronous write is swallowed', () => {
    const log = makeLogger();
    log.info('queued');
    const file = log.transports.file.getFile();
    const errors = [];
    file.on('error', (e) => errors.push(e));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('EACCES');
    });
    expect(() => flushLogFileSync(log.transports.file)).not.toThrow();
    expect(file.asyncWriteQueue).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
  });

  test('a warn right before SIGKILL is on disk after every info line before it', () => {
    // A real hard kill: a child process using the installed electron-log's
    // File transport logs, warns, and SIGKILLs itself — no handler runs.
    const script = `
      const log = require('electron-log/node').create({ logId: 'kill' });
      log.transports.console.level = false;
      log.transports.file.level = 'info';
      log.transports.file.resolvePathFn = () => process.env.LOG_PATH;
      log.transports.file.sync = false;
      if (process.env.WITH_HOOK === '1') {
        log.hooks.push(require(process.env.FLUSH_MODULE).createLogFileHook());
      }
      for (let i = 0; i < 200; i += 1) log.info('info ' + i);
      log.warn('last words');
      log.info('lost after the warning');
      process.kill(process.pid, 'SIGKILL');
    `;
    const run = (withHook) =>
      spawnSync(process.execPath, ['-e', script], {
        cwd: path.join(__dirname, '..', '..'),
        env: {
          ...process.env,
          LOG_PATH: logPath,
          WITH_HOOK: withHook ? '1' : '0',
          FLUSH_MODULE: require.resolve('./log-file-flush'),
        },
        timeout: 30000,
      });

    // Control: electron-log's async writer alone loses the warning.
    const control = run(false);
    expect(control.signal).toBe('SIGKILL');
    expect(lines()).not.toContain('last words');
    fs.rmSync(logPath, { force: true });

    const result = run(true);
    expect(result.signal).toBe('SIGKILL');
    const got = lines();
    expect(got.slice(0, 201)).toEqual([
      ...Array.from({ length: 200 }, (_, i) => `info ${i}`),
      'last words',
    ]);
    expect(new Set(got).size).toBe(got.length);
  });
});

describe('without the batch writer (electron-log File as created)', () => {
  test('flushLogFileSync writes the queue at once and makes later lines synchronous', async () => {
    const file = new File({ path: logPath, writeAsync: true });
    const transport = { getFile: () => file };
    expect(file.size).toBe(0);
    file.writeLine('one');
    file.writeLine('two');
    flushLogFileSync(transport);
    // 'one' is electron-log's own in-flight batch, out of reach; it lands later.
    expect(read()).toBe(`two${os.EOL}`);
    file.writeLine('three');
    expect(read()).toContain(`three${os.EOL}`);
    await waitIdle(file);
    expect(read().split(os.EOL).filter(Boolean).sort()).toEqual(['one', 'three', 'two']);
  });

  test('drainLogFile waits for electron-log’s in-flight batch, bounded', async () => {
    const file = new File({ path: logPath, writeAsync: true });
    file.hasActiveAsyncWriting = true; // a batch that never completes
    file.asyncWriteQueue = [`queued${os.EOL}`];
    const started = Date.now();
    await drainLogFile({ getFile: () => file }, { timeoutMs: 30, pollMs: 5 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    expect(read()).toBe(`queued${os.EOL}`);
    expect(file.writeAsync).toBe(false);
  });
});

test.each([
  ['no transport', undefined],
  [
    'getFile throws',
    {
      getFile: () => {
        throw new Error('no path');
      },
    },
  ],
  ['NullFile', { getFile: () => new NullFile({ path: '/nonexistent/main.log' }) }],
])('%s is a no-op', async (_label, t) => {
  expect(() => flushLogFileSync(t)).not.toThrow();
  await expect(drainLogFile(t)).resolves.toBeUndefined();
  const hook = createLogFileHook();
  const msg = { level: 'warn', data: ['x'] };
  expect(hook(msg, t, 'file')).toBe(msg);
});

test('the hook ignores other transports', () => {
  const hook = createLogFileHook();
  const getFile = jest.fn();
  const msg = { level: 'warn', data: ['x'] };
  expect(hook(msg, { getFile }, 'console')).toBe(msg);
  expect(getFile).not.toHaveBeenCalled();
});

test('wantsSyncLogFile is on only for FREEDOM_LOG_SYNC=1', () => {
  expect(wantsSyncLogFile({})).toBe(false);
  expect(wantsSyncLogFile({ FREEDOM_LOG_SYNC: '' })).toBe(false);
  expect(wantsSyncLogFile({ FREEDOM_LOG_SYNC: '0' })).toBe(false);
  expect(wantsSyncLogFile({ FREEDOM_LOG_SYNC: 'true' })).toBe(false);
  expect(wantsSyncLogFile({ FREEDOM_LOG_SYNC: '1' })).toBe(true);
  // A Windows `set X=1 && …` keeps the trailing space.
  expect(wantsSyncLogFile({ FREEDOM_LOG_SYNC: '1 ' })).toBe(true);
});
