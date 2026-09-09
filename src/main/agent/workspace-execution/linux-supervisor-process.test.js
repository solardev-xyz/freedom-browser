'use strict';

const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { parser, cleanupProven, runLinuxOwner } = require('./linux-supervisor-process');
const { supported, validElf } = require('./linux-supervisor-runtime');
const buildId = 'a'.repeat(64);
const ready = '{"type":"READY","protocol":1}\n';
function finalRecord(extra = {}) {
  return { type: 'FINAL', protocol: 1, buildId, reason: 'completed', stage: 'lifetime', created: true,
    armed: true, released: true, execAttempted: true, observed: true, retired: true,
    reaped: true, uncertain: false, initCode: 0, initSignal: 0, monitorObserved: true,
    monitorCode: 0, monitorSignal: 0, error: 0, ...extra };
}
const encode = (r) => `${JSON.stringify(r)}\n`;
function fixture(options = {}) {
  const child = new EventEmitter(); child.exitCode = null;
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdio = [child.stdin, child.stdout, child.stderr, new PassThrough(), new PassThrough()];
  child.kill = jest.fn(() => { throw new Error('Forbidden numeric signal'); });
  const controls = []; child.stdio[3].on('data', (c) => controls.push(c.toString()));
  const runtime = { fd: 55, executablePath: '/trusted/owner', sourceSha256: buildId, close: jest.fn(async () => {}) };
  const spawnProcess = jest.fn(() => child);
  const promise = runLinuxOwner('/usr/bin/bwrap', ['--version'], { runtime, spawnProcess, timeoutMs: 1000, ...options });
  function end(record = finalRecord()) {
    child.stdio[4].end(encode(record)); child.stdout.end(); child.stderr.end();
    child.exitCode = 0; child.emit('exit', 0, null);
  }
  return { child, controls, runtime, spawnProcess, promise, end };
}

test('bounded parser enforces order, build identity, strict types and original terminal state', () => {
  const onReady = jest.fn(); const p = parser(buildId, onReady);
  for (const c of ready + encode(finalRecord())) p.feed(Buffer.from(c));
  expect(onReady).toHaveBeenCalledTimes(1); expect(cleanupProven(p.end())).toBe(true);
});
test.each([
  ready + ready, ready + encode(finalRecord({ buildId: 'b'.repeat(64) })),
  ready + encode(finalRecord({ observed: false })), encode(finalRecord()),
  ready + encode(finalRecord({ reaped: 'true' })), ready + '{broken}\n',
  ready + encode(finalRecord()) + 'x\n', 'x'.repeat(4097),
  ready + encode(finalRecord({ initSignal: 9 })),
  ready + encode(finalRecord({ monitorObserved: false })),
  ready + encode(finalRecord({ initCode: -1 })),
  ready + encode(finalRecord({ stage: '/untrusted/path' })),
  ready + encode(finalRecord({ armed: false })),
  ready + encode(finalRecord({ initSignal: 9 })),
  ready + encode(finalRecord({ monitorObserved: false })),
  ready + encode(finalRecord({ initCode: -1 })),
  ready + encode(finalRecord({ stage: '/untrusted/path' })),
  ready + encode(finalRecord({ armed: false })),
])('refuses malformed, duplicate, mismatched or oversized record %#', (wire) => {
  const p = parser(buildId, () => {});
  expect(() => { p.feed(Buffer.from(wire)); p.end(); }).toThrow();
});
test('partial record/EOF and unknown original outcome are never cleanup proof', () => {
  const p = parser(buildId, () => {}); p.feed(Buffer.from(ready + '{'));
  expect(() => p.end()).toThrow();
  expect(cleanupProven(finalRecord({ reaped: false, uncertain: true }))).toBe(false);
});
test('release follows READY, stdio drains, and native actual zero survives cancellation race', async () => {
  const abort = new AbortController(); const f = fixture({ signal: abort.signal });
  expect(f.controls).toEqual([]);
  f.child.stdio[4].write(ready); expect(f.controls).toEqual(['G']);
  abort.abort(); f.end(finalRecord({ reason: 'cancelled', monitorCode: 0 }));
  const result = await f.promise;
  expect(result.code).toBe(0); expect(result.requested).toBe(true);
  expect(result.transportComplete).toBe(true); expect(f.child.kill).not.toHaveBeenCalled();
  expect(f.spawnProcess.mock.calls[0][0]).toBe('/proc/self/fd/5');
  expect(f.spawnProcess.mock.calls[0][1].slice(0, 5)).toEqual(['--run', '1000', String(process.pid), '--', '/usr/bin/bwrap']);
  expect(f.spawnProcess.mock.calls[0][2].stdio[5]).toBe(55);
});
test('pre-create cancellation never spawns; abort before READY never releases', async () => {
  const abort = new AbortController(); abort.abort(); const a = fixture({ signal: abort.signal });
  await a.promise; expect(a.spawnProcess).not.toHaveBeenCalled();
  const bAbort = new AbortController(); const b = fixture({ signal: bAbort.signal });
  bAbort.abort(); b.child.stdio[4].write(ready);
  b.end(finalRecord({ reason: 'cancelled', released: false, execAttempted: false })); await b.promise;
  expect(b.controls).toEqual(['A']); expect(b.child.kill).not.toHaveBeenCalled();
});
test('output holders have bounded transport drain, not invented product cleanup', async () => {
  jest.useFakeTimers();
  const f = fixture(); f.child.stdio[4].write(ready);
  f.child.stdio[4].end(encode(finalRecord()));
  f.child.emit('exit', 0, null);
  await jest.advanceTimersByTimeAsync(500);
  const result = await f.promise;
  expect(result.transportComplete).toBe(false); expect(f.child.kill).not.toHaveBeenCalled();
  jest.useRealTimers();
});
test('lost owner/status times out transport without signal authority', async () => {
  jest.useFakeTimers(); const f = fixture();
  await jest.advanceTimersByTimeAsync(3500);
  const result = await f.promise;
  expect(result.final).toBeNull(); expect(result.error).toBe('LINUX_OWNER_TRANSPORT_DEADLINE');
  expect(cleanupProven(result.final)).toBe(false); expect(f.child.kill).not.toHaveBeenCalled();
  jest.useRealTimers();
});
test('cancellation bounds pending disposal even with a long original command deadline', async () => {
  jest.useFakeTimers();
  const controller = new AbortController();
  const f = fixture({ timeoutMs: 86400000, signal: controller.signal });
  controller.abort();
  await jest.advanceTimersByTimeAsync(2500);
  const result = await f.promise;
  expect(result.error).toBe('LINUX_OWNER_CANCELLATION_UNCONFIRMED');
  expect(result.final).toBeNull(); expect(f.controls).toEqual(['A']);
  expect(f.child.kill).not.toHaveBeenCalled(); expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
});
test('malformed status requests cancellation and cannot release or prove cleanup', async () => {
  jest.useFakeTimers(); const f = fixture();
  f.child.stdio[4].write('{bad}\n'); f.child.stdio[4].write(ready);
  await jest.advanceTimersByTimeAsync(2500);
  const result = await f.promise;
  expect(f.controls).toEqual(['A']); expect(result.error).toBe('LINUX_OWNER_PROTOCOL');
  expect(cleanupProven(result.final)).toBe(false); expect(f.child.kill).not.toHaveBeenCalled();
  jest.useRealTimers();
});
test('cancellation bounds pending disposal even with a long original command deadline', async () => {
  jest.useFakeTimers();
  const controller = new AbortController();
  const f = fixture({ timeoutMs: 86400000, signal: controller.signal });
  controller.abort();
  await jest.advanceTimersByTimeAsync(2500);
  const result = await f.promise;
  expect(result.error).toBe('LINUX_OWNER_CANCELLATION_UNCONFIRMED');
  expect(result.final).toBeNull(); expect(f.controls).toEqual(['A']);
  expect(f.child.kill).not.toHaveBeenCalled(); expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
});
test('malformed status requests cancellation and cannot release or prove cleanup', async () => {
  jest.useFakeTimers(); const f = fixture();
  f.child.stdio[4].write('{bad}\n'); f.child.stdio[4].write(ready);
  await jest.advanceTimersByTimeAsync(2500);
  const result = await f.promise;
  expect(f.controls).toEqual(['A']); expect(result.error).toBe('LINUX_OWNER_PROTOCOL');
  expect(cleanupProven(result.final)).toBe(false); expect(f.child.kill).not.toHaveBeenCalled();
  jest.useRealTimers();
});
test('platform and ELF gates deny unsupported facilities and architectures', () => {
  expect(supported('linux', 'x64', '6.8.0')).toBe(true);
  for (const tuple of [['linux', 'x64', '5.8'], ['linux', 'arm64', '6.8'], ['darwin', 'x64', '24']])
    expect(supported(...tuple)).toBe(false);
  expect(validElf(Buffer.alloc(64))).toBe(false);
});

test('pre-spawn abort carries positive no-creation evidence', async () => {
  const signal = AbortSignal.abort(); const f = fixture({ signal });
  expect(await f.promise).toMatchObject({ notSpawned: true, requested: true, final: null, ownerExit: null, error: null });
  expect(f.spawnProcess).not.toHaveBeenCalled();
});
test('READY release throw is a control failure, not malformed status', async () => {
  const f = fixture();
  f.child.stdio[3].write = () => { throw new Error('closed'); };
  f.child.stdio[4].write(ready);
  f.end(finalRecord({ reason: 'cancelled', released: false, execAttempted: false }));
  const result = await f.promise;
  expect(result.error).toBe('LINUX_OWNER_CONTROL_FAILED');
  expect(result.notSpawned).toBe(false); expect(f.child.kill).not.toHaveBeenCalled();
});
test('READY after ended control cannot release', async () => {
  const f = fixture(); f.child.stdio[3].end(); f.child.stdio[4].write(ready);
  f.end(finalRecord({ reason: 'control_eof', released: false, execAttempted: false }));
  expect((await f.promise).error).toBe('LINUX_OWNER_CONTROL_FAILED'); expect(f.controls).toEqual([]);
});
test('exec-failure FINAL preserves original monitor127 with complete cleanup', async () => {
  const f = fixture(); f.child.stdio[4].write(ready);
  f.end(finalRecord({ reason: 'exec_failed', monitorCode: 127 }));
  const result = await f.promise;
  expect(result.code).toBe(127); expect(result.error).toBeNull(); expect(cleanupProven(result.final)).toBe(true);
});
