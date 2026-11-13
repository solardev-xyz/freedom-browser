const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const {
  ProfileSubcommandError,
  run,
  runSync,
  settle,
} = require('./profile-subcommands');

function syncRun(outcome) {
  const calls = [];
  const spawnSync = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, signal: null, stdout: '', stderr: '', ...outcome };
  };
  return { calls, spawnSync };
}

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = jest.fn(() => {
    setImmediate(() => child.emit('close', null, 'SIGKILL'));
  });
  return child;
}

describe('settle: the subcommands\' exits', () => {
  test('exit 0 gives the last JSON line, past the log lines', () => {
    expect(
      settle({
        status: 0,
        stdout: '{"outcome":"opened","id":"work"}\n',
        stderr: '{"level":"info","msg":"profile subcommand confined"}\n',
      })
    ).toEqual({ result: { outcome: 'opened', id: 'work' }, raw: '{"outcome":"opened","id":"work"}' });
  });

  test("migrate's one word is kept as raw text", () => {
    expect(settle({ status: 0, stdout: 'rolled_back\n' })).toEqual({
      result: undefined,
      raw: 'rolled_back',
    });
  });

  test("65 is the reference's refusal, with its own message", () => {
    let error;
    try {
      settle({ status: 65, stdout: '{"error":"refused","message":"Profile not found: work"}\n' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ProfileSubcommandError);
    expect(error.code).toBe('refused');
    expect(error.message).toBe('Profile not found: work');
  });

  test('74 names the storage kind, from stdout or from the log line', () => {
    expect(() => settle({ status: 74, stdout: '{"error":"network_filesystem"}\n' })).toThrow(
      expect.objectContaining({ code: 'storage', kind: 'network_filesystem' })
    );
    expect(() =>
      settle({ status: 74, stdout: 'corrupt\n', stderr: '{"kind":"corrupt","msg":"x"}\n' })
    ).toThrow(expect.objectContaining({ code: 'storage', kind: 'corrupt', raw: 'corrupt' }));
  });

  test("75 is the catalog's write lock, or a delete's gate or forget backlog", () => {
    expect(() => settle({ status: 75, stdout: '{"error":"busy"}\n' })).toThrow(
      expect.objectContaining({ code: 'busy' })
    );
    expect(() => settle({ status: 75, stdout: '{"error":"lock_held","gate":"profile"}\n' })).toThrow(
      expect.objectContaining({ code: 'lock_held', gate: 'profile' })
    );
    expect(() => settle({ status: 75, stdout: '{"error":"forget_backlog"}\n' })).toThrow(
      expect.objectContaining({ code: 'forget_backlog' })
    );
    expect(() => settle({ status: 75, stdout: 'busy\n' })).toThrow(
      expect.objectContaining({ code: 'busy', raw: 'busy' })
    );
  });

  test('usage, confinement, a missing binary, a timeout and anything else', () => {
    expect(() => settle({ status: 64 })).toThrow(expect.objectContaining({ code: 'usage' }));
    expect(() => settle({ status: 77 })).toThrow(expect.objectContaining({ code: 'confinement' }));
    expect(() => settle({ error: Object.assign(new Error('x'), { code: 'ENOENT' }) })).toThrow(
      expect.objectContaining({ code: 'missing' })
    );
    expect(() => settle({ error: Object.assign(new Error('x'), { code: 'ETIMEDOUT' }) })).toThrow(
      expect.objectContaining({ code: 'timeout' })
    );
    expect(() => settle({ status: null, signal: 'SIGSEGV' })).toThrow(
      expect.objectContaining({ code: 'failed' })
    );
  });
});

describe('runSync', () => {
  test("runs in the core's cleared environment, bounded, and measures the wall time", () => {
    const previous = process.env.FREEDOM_PROFILE_SECRET_PROBE;
    process.env.FREEDOM_PROFILE_SECRET_PROBE = 'leak';
    try {
      const { calls, spawnSync } = syncRun({ stdout: '[1,2]\n' });
      const outcome = runSync('/bin/cored', ['profile', 'reserved-ports'], { spawnSync });
      expect(outcome.result).toEqual([1, 2]);
      expect(typeof outcome.ms).toBe('number');
      expect(calls[0].command).toBe('/bin/cored');
      expect(calls[0].args).toEqual(['profile', 'reserved-ports']);
      expect(calls[0].options.timeout).toBe(5000);
      expect(calls[0].options.windowsHide).toBe(true);
      expect(calls[0].options.env.FREEDOM_PROFILE_SECRET_PROBE).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.FREEDOM_PROFILE_SECRET_PROBE;
      else process.env.FREEDOM_PROFILE_SECRET_PROBE = previous;
    }
  });

  test('a timed-out run is a timeout', () => {
    const { spawnSync } = syncRun({
      status: null,
      signal: 'SIGKILL',
      error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    });
    expect(() => runSync('/bin/cored', ['profile', 'open'], { spawnSync })).toThrow(
      expect.objectContaining({ code: 'timeout' })
    );
  });
});

describe('run', () => {
  test('resolves with the result once the process has closed', async () => {
    const child = fakeChild();
    const spawn = jest.fn(() => child);
    const pending = run('/bin/cored', ['profile', 'list', '--app-root', '/a'], { spawn });
    child.stdout.write('[{"id":"default"}]\n');
    child.stdout.end();
    child.stderr.end();
    setImmediate(() => child.emit('close', 0, null));
    await expect(pending).resolves.toEqual(
      expect.objectContaining({ result: [{ id: 'default' }] })
    );
    expect(spawn.mock.calls[0][2].env).not.toHaveProperty('FREEDOM_TEST_MODE');
  });

  test('rejects with the refusal', async () => {
    const child = fakeChild();
    const pending = run('/bin/cored', ['profile', 'rename'], { spawn: () => child });
    child.stdout.write('{"error":"refused","message":"Display name is required"}\n');
    setImmediate(() => child.emit('close', 65, null));
    await expect(pending).rejects.toEqual(
      expect.objectContaining({ code: 'refused', message: 'Display name is required' })
    );
  });

  test('a run past its bound is killed and reads as a timeout', async () => {
    jest.useFakeTimers();
    try {
      const child = fakeChild();
      const pending = run('/bin/cored', ['profile', 'list'], { spawn: () => child, timeoutMs: 50 });
      jest.advanceTimersByTime(60);
      jest.useRealTimers();
      await expect(pending).rejects.toEqual(expect.objectContaining({ code: 'timeout' }));
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      jest.useRealTimers();
    }
  });

  test('a binary that never started is missing', async () => {
    const child = fakeChild();
    child.pid = undefined;
    const pending = run('/missing/cored', ['profile', 'list'], { spawn: () => child });
    child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    await expect(pending).rejects.toEqual(expect.objectContaining({ code: 'missing' }));
  });
});
