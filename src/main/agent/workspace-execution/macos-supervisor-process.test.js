'use strict';

const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const {
  SupervisorStatusParser, runMacosSupervisor, STATUS_DRAIN_MS, OUTPUT_DRAIN_MS,
  CANCELLATION_RECEIPT_MS, NATIVE_DEADLINE_SLACK_MS, STARTUP_TIMEOUT_MS, OUTPUT_DRAIN_LIMIT_MS,
} = require('./macos-supervisor-process');

const ready = () => ({ v: 1, type: 'ready' });
const final = (overrides = {}) => ({
  v: 1, type: 'final', reason: 'completed', spawned: true, releaseIssued: true,
  rootExitObserved: true, rootReaped: true, groupVerified: true, cleanupUncertain: false,
  exitCode: 0, signal: null, finalKillAttempted: true, signalErrors: [], setupError: null,
  ...overrides,
});
const line = (record) => `${JSON.stringify(record)}\n`;

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 12345;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdio = [child.stdin, child.stdout, child.stderr, new PassThrough(), new PassThrough()];
  child.kill = jest.fn();
  child.unref = jest.fn();
  child.commands = [];
  child.stdio[3].on('data', (chunk) => child.commands.push(chunk.toString()));
  return child;
}

describe('native supervisor trusted status framing', () => {
  test('accepts fragmented records and preserves raw failed signal evidence', () => {
    const parser = new SupervisorStatusParser();
    const receipt = final({ cleanupUncertain: true, signalErrors: [{ phase: 'kill', errno: 1 }] });
    const bytes = Buffer.from(line(ready()) + line(receipt));
    for (const byte of bytes) parser.write(Buffer.from([byte]));
    parser.end();
    expect(parser.final).toEqual(receipt);
    expect(Object.isFrozen(parser.final.signalErrors)).toBe(true);
  });

  test('accepts initialization failure without a READY or payload release', () => {
    const parser = new SupervisorStatusParser();
    parser.write(line(final({ reason: 'setup_failed', spawned: false, releaseIssued: false,
      rootExitObserved: false, rootReaped: false, groupVerified: false, exitCode: null,
      finalKillAttempted: false, setupError: 2 })));
    expect(() => parser.end()).not.toThrow();
  });

  test.each([
    ['duplicate ready', () => line(ready()) + line(ready())],
    ['duplicate final', () => line(ready()) + line(final()) + line(final())],
    ['unknown key', () => line(ready()) + line(final({ pid: 42 }))],
    ['impossible exit evidence', () => line(ready()) + line(final({ exitCode: 0, signal: 9 }))],
    ['release before ready', () => line(final())],
    ['unreaped success', () => line(ready()) + line(final({ rootReaped: false }))],
    ['setup failure after release', () => line(ready()) + line(final({ reason: 'setup_failed' }))],
    ['unknown version', () => line({ v: 2, type: 'ready' })],
    ['oversized record', () => `${' '.repeat(1024)}\n`],
    ['oversized stream', () => ' '.repeat(2049)],
  ])('rejects %s', (_name, make) => {
    const parser = new SupervisorStatusParser();
    expect(() => parser.write(make())).toThrow();
  });

  test('rejects invalid UTF-8 and unterminated or missing final evidence', () => {
    expect(() => new SupervisorStatusParser().write(Buffer.from([0xff, 10]))).toThrow();
    const parser = new SupervisorStatusParser();
    parser.write(line(ready()));
    expect(() => parser.end()).toThrow();
    const other = new SupervisorStatusParser();
    other.write(line(ready()) + line(final()) + ' ');
    expect(() => other.end()).toThrow();
  });
});

describe('native supervisor execution transport', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function launch(request = {}, overrides = {}) {
    const child = fakeChild();
    const spawnProcess = jest.fn(() => child);
    const pending = runMacosSupervisor({ executablePath: '/trusted/supervisor',
      profilePath: '/private/profile.sb', cwd: '/workspace', env: { PATH: '/bin' },
      timeoutMs: 10000, stdoutBytes: 5, stderrBytes: 5,
      spawnProcess, request: { command: '/bin/sh', args: ['-c', 'example'], ...request },
      ...overrides });
    return { child, pending, spawnProcess };
  }

  async function complete(child, receipt = final()) {
    child.stdout.end(); child.stderr.end();
    child.stdio[4].end(line(receipt));
    child.emit('exit', 0, null);
    await jest.advanceTimersByTimeAsync(0);
  }

  test('passes only five explicit streams and never gives Node termination authority', async () => {
    const { child, pending, spawnProcess } = launch();
    child.stdio[4].write(line(ready()));
    await complete(child);
    const outcome = await pending;
    expect(spawnProcess).toHaveBeenCalledWith('/trusted/supervisor', [
      '--supervise', '10000', '/private/profile.sb', '--', '/bin/sh', '-c', 'example',
    ], { cwd: '/workspace', env: { PATH: '/bin' }, detached: true,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] });
    expect(child.commands).toEqual(['G']);
    expect(child.kill).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ final: final(), stdoutTruncated: false, stderrTruncated: false });
    expect(jest.getTimerCount()).toBe(0);
  });

  test('waits for queued FINAL after supervisor exit instead of discarding it', async () => {
    const { child, pending } = launch();
    child.stdio[4].write(line(ready()));
    child.emit('exit', 0, null);
    await jest.advanceTimersByTimeAsync(100);
    child.stdio[4].end(line(final()));
    child.stdout.end('hello'); child.stderr.end();
    await jest.advanceTimersByTimeAsync(0);
    expect(await pending).toMatchObject({ final: final(), stdout: 'hello', diagnostics: {} });
  });

  test('FINAL without actual supervisor exit reports uncertainty within a bound', async () => {
    const { child, pending } = launch();
    child.stdio[4].write(line(ready()));
    child.stdio[4].end(line(final()));
    child.stdout.end(); child.stderr.end();
    await jest.advanceTimersByTimeAsync(STATUS_DRAIN_MS);
    expect(await pending).toMatchObject({ final: final(), diagnostics: { supervisorExitUnconfirmed: true } });
    expect(child.unref).toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  test('a late READY after abort cannot release the gate', async () => {
    const abort = new AbortController();
    const { child, pending } = launch({ signal: abort.signal });
    abort.abort();
    child.stdio[4].write(line(ready()));
    await complete(child, final({ reason: 'cancelled', releaseIssued: false, exitCode: 77 }));
    expect(child.commands).toEqual(['A']);
    expect(await pending).toMatchObject({ releaseIssued: false, requestedState: 'cancelled' });
  });

  test('continues draining beyond the collection cap and never parses forged stdout', async () => {
    const onOutput = jest.fn();
    const { child, pending } = launch({ onOutput });
    child.stdout.write(line(ready()) + line(final()));
    expect(child.commands).toEqual([]);
    child.stdio[4].write(line(ready()));
    child.stdout.write('tail'); child.stderr.write('warning');
    await complete(child);
    expect(await pending).toMatchObject({ stdout: '{"v":', stdoutTruncated: true,
      stderr: 'warni', stderrTruncated: true });
    expect(Buffer.concat(onOutput.mock.calls.filter(([stream]) => stream === 'stdout')
      .map(([, chunk]) => chunk)).toString()).toContain('tail');
  });

  test('an output holder cannot postpone a terminal receipt or hide truncation', async () => {
    const { child, pending } = launch();
    child.stdio[4].write(line(ready()));
    child.stdout.write('hello'); child.stderr.end();
    child.stdio[4].end(line(final())); child.emit('exit', 0, null);
    await jest.advanceTimersByTimeAsync(OUTPUT_DRAIN_MS);
    expect(await pending).toMatchObject({ final: final(), stdout: 'hello', stdoutTruncated: true,
      diagnostics: { supervisorOutputDrainExpired: true } });
  });

  test('malformed trailing status invalidates an otherwise successful FINAL', async () => {
    const { child, pending } = launch();
    child.stdio[4].write(line(ready()));
    child.stdout.end(); child.stderr.end();
    child.stdio[4].end(line(final()) + '{}\n'); child.emit('exit', 0, null);
    await jest.advanceTimersByTimeAsync(0);
    expect(await pending).toMatchObject({ final: null, diagnostics: { supervisorProtocolFailed: true } });
  });

  test('a stalled supervisor has bounded cancellation and no numeric kill fallback', async () => {
    const abort = new AbortController();
    let stdin;
    const { child, pending } = launch({ signal: abort.signal, onStdin: (value) => { stdin = value; } });
    child.stdio[4].write(line(ready()));
    expect(stdin.write('before')).toBe(true);
    abort.abort();
    expect(stdin.write('after')).toBe(false);
    await jest.advanceTimersByTimeAsync(CANCELLATION_RECEIPT_MS + OUTPUT_DRAIN_MS);
    expect(await pending).toMatchObject({ final: null,
      diagnostics: { supervisorReceiptDeadlineExpired: true, supervisorExitUnconfirmed: true } });
    expect(child.commands).toEqual(['G', 'A']);
    expect(child.kill).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('timeout remains a timeout even when the native cancellation receipt arrives later', async () => {
    const { child, pending } = launch({}, { timeoutMs: 100 });
    child.stdio[4].write(line(ready()));
    await jest.advanceTimersByTimeAsync(100);
    expect(child.commands).toEqual(['G']);
    await jest.advanceTimersByTimeAsync(NATIVE_DEADLINE_SLACK_MS);
    await complete(child, final({ reason: 'cancelled', exitCode: null, signal: 15 }));
    expect(await pending).toMatchObject({ requestedState: 'timed_out' });
  });

  test('startup backstop preserves infrastructure failure when native abort says cancelled', async () => {
    const { child, pending } = launch();
    await jest.advanceTimersByTimeAsync(STARTUP_TIMEOUT_MS);
    expect(child.commands).toEqual([]);
    await jest.advanceTimersByTimeAsync(NATIVE_DEADLINE_SLACK_MS);
    await complete(child, final({ reason: 'cancelled', releaseIssued: false, exitCode: 77 }));
    expect(await pending).toMatchObject({ requestedState: 'failed',
      diagnostics: { supervisorStartupExpired: true } });
    expect(child.commands).toEqual(['A']);
  });

  test('output progress extends the idle drain until queued output ends', async () => {
    const { child, pending } = launch({}, { stdoutBytes: 100 });
    child.stdio[4].write(line(ready()));
    child.stdio[4].end(line(final())); child.emit('exit', 0, null);
    child.stderr.end();
    await jest.advanceTimersByTimeAsync(OUTPUT_DRAIN_MS - 10);
    child.stdout.write('first');
    await jest.advanceTimersByTimeAsync(OUTPUT_DRAIN_MS - 10);
    child.stdout.end('last');
    await jest.advanceTimersByTimeAsync(0);
    expect(await pending).toMatchObject({ stdout: 'firstlast', stdoutTruncated: false, diagnostics: {} });
  });

  test('continuous output cannot extend the hard drain deadline', async () => {
    const { child, pending } = launch();
    child.stdio[4].write(line(ready()));
    child.stdio[4].end(line(final())); child.emit('exit', 0, null);
    child.stderr.end();
    await jest.advanceTimersByTimeAsync(0);
    for (let elapsed = 0; elapsed < OUTPUT_DRAIN_LIMIT_MS; elapsed += 100) {
      child.stdout.write('.');
      await jest.advanceTimersByTimeAsync(100);
    }
    expect(await pending).toMatchObject({ stdoutTruncated: true,
      diagnostics: { supervisorOutputDrainExpired: true } });
    expect(jest.getTimerCount()).toBe(0);
  });
});
