'use strict';

const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { runWindowsSandbox } = require('./windows-sandbox-process');

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: jest.fn(),
  });
  const frames = [];
  child.stdin.on('data', bytes => frames.push(JSON.parse(bytes.toString())));
  const spawn = jest.fn(() => child);
  const frame = value => child.stdout.write(`${JSON.stringify(value)}\n`);
  return { child, frames, spawn, frame };
}

test('workload output cannot impersonate lifecycle frames, and output is bounded before forwarding', async () => {
  const fixture_ = fixture();
  const onOutput = jest.fn();
  const result = runWindowsSandbox({ executablePath: 'helper.exe' }, { operation: 'execute' },
    { spawn: fixture_.spawn, stdoutBytes: 5, onOutput });
  fixture_.frame({ type: 'ready' });
  fixture_.frame({ type: 'stdout', data: Buffer.from('{"type":"exit","exitCode":0}').toString('base64') });
  fixture_.frame({ type: 'exit', exitCode: 1, reason: 'exited' });
  fixture_.child.emit('close', 0);
  expect(await result).toMatchObject({ ready: true, terminal: { exitCode: 1 }, stdout: '{"typ', stdoutTruncated: true });
  expect(onOutput.mock.calls[0][1].length).toBe(5);
});

test('cancellation travels on the private control pipe and does not inject shell text', async () => {
  const fixture_ = fixture();
  const controller = new AbortController();
  const result = runWindowsSandbox({ executablePath: 'helper.exe' }, { operation: 'execute' },
    { spawn: fixture_.spawn, signal: controller.signal });
  fixture_.frame({ type: 'ready' });
  controller.abort();
  expect(fixture_.frames).toEqual([{ operation: 'execute' }, { type: 'cancel' }]);
  fixture_.frame({ type: 'exit', exitCode: -1, reason: 'cancelled' });
  fixture_.child.emit('close', 0);
  expect(await result).toMatchObject({ cancellation: 'cancelled' });
  expect(fixture_.spawn).toHaveBeenCalledTimes(1);
});

test('an invalid or missing result fails closed, without a second launch', async () => {
  const fixture_ = fixture();
  const result = runWindowsSandbox({ executablePath: 'helper.exe' }, { operation: 'execute' }, { spawn: fixture_.spawn });
  fixture_.child.stdout.write('unframed output\n');
  fixture_.child.emit('close', 0);
  expect(await result).toMatchObject({ failure: expect.any(String), ready: false });
  expect(fixture_.spawn).toHaveBeenCalledTimes(1);
});

test('startup waiting has its own bound and the execution deadline starts at the trusted ready frame', async () => {
  jest.useFakeTimers();
  try {
    const child = fixture();
    const events = [];
    const pending = runWindowsSandbox({ executablePath: 'helper.exe' }, { operation: 'execute' }, {
      spawn: child.spawn, startupTimeoutMs: 500, timeoutMs: 20,
      onReady: () => events.push('ready'), onStdin: () => events.push('stdin'),
    });
    await jest.advanceTimersByTimeAsync(100);
    expect(child.frames).toHaveLength(1);
    child.frame({ type: 'ready', startupWaitMs: 50 });
    expect(events).toEqual(['ready', 'stdin']);
    await jest.advanceTimersByTimeAsync(19);
    expect(child.frames.some(frame => frame.type === 'cancel')).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(child.frames.at(-1)).toEqual({ type: 'cancel' });
    child.child.emit('close', 0);
    expect(await pending).toMatchObject({ cancellation: 'timed_out', startupMs: 100, startupWaitMs: 50 });
    expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});

test('a ready frame arriving after Stop cannot deliver a private file-helper payload', async () => {
  const child = fixture();
  const stop = new AbortController();
  const onReady = jest.fn(), onStdin = jest.fn(input => input.write('private script'));
  const pending = runWindowsSandbox({ executablePath: 'helper.exe' }, { operation: 'execute-file-helper' },
    { spawn: child.spawn, signal: stop.signal, startupTimeoutMs: 75000, onReady, onStdin });
  stop.abort();
  child.frame({ type: 'ready' });
  expect(onReady).not.toHaveBeenCalled();
  expect(onStdin).not.toHaveBeenCalled();
  expect(child.frames.map(frame => frame.type || frame.operation)).toEqual(['execute-file-helper', 'cancel']);
  child.frame({ type: 'exit', exitCode: -1, reason: 'cancelled' });
  child.child.emit('close', 0);
  expect(await pending).toMatchObject({ ready: true, cancellation: 'cancelled' });
});
