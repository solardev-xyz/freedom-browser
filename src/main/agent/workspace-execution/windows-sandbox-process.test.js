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
