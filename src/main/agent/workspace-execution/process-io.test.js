'use strict';

const { EventEmitter } = require('events');
const {
  createReadinessOutputForwarder,
  createStdinControl,
  notifyOutput,
} = require('./process-io');

describe('workspace process IO', () => {
  test('forwards stdout only after the trusted readiness marker', () => {
    const received = [];
    const forward = createReadinessOutputForwarder('ready\n', (stream, chunk) => {
      received.push([stream, chunk.toString('utf8')]);
    });
    forward(Buffer.from('rea'));
    forward(Buffer.from('dy\nhello'));
    forward(Buffer.from(' world'));
    expect(received).toEqual([
      ['stdout', 'hello'],
      ['stdout', ' world'],
    ]);
  });

  test('does not forward stdout from a process that lacks the readiness marker', () => {
    const callback = jest.fn();
    const forward = createReadinessOutputForwarder('ready\n', callback);
    forward(Buffer.from('refused\n'));
    forward(Buffer.from('secret'));
    expect(callback).not.toHaveBeenCalled();
  });

  test('contains observer errors and exposes bounded process stdin control', () => {
    expect(() =>
      notifyOutput(
        () => {
          throw new Error('observer');
        },
        'stderr',
        'x'
      )
    ).not.toThrow();
    const stdin = new EventEmitter();
    stdin.destroyed = false;
    stdin.write = jest.fn();
    const child = { stdin, exitCode: null };
    const control = createStdinControl(child);
    expect(control.write(Buffer.from('hello'))).toBe(true);
    expect(stdin.write).toHaveBeenCalledWith(Buffer.from('hello'));
    child.exitCode = 0;
    expect(control.write(Buffer.from('again'))).toBe(false);
  });
});
