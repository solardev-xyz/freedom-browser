const { EventEmitter } = require('events');

// All lifecycle events below are in-memory fakes. No native process is spawned.
describe('MyotisProcess', () => {
  let child;
  let processClient;
  let fork;
  let callbacks;
  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    child = new EventEmitter();
    child.send = jest.fn((_message, cb) => cb?.(null));
    child.kill = jest.fn();
    child.stdout = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = jest.fn();
    fork = jest.fn(() => child);
    jest.doMock('child_process', () => ({ fork }));
    jest.doMock('fs', () => ({ existsSync: () => true, accessSync: jest.fn(), mkdirSync: jest.fn(), constants: { X_OK: 1 } }));
    const { MyotisProcess } = require('./myotis-process');
    callbacks = { onStatus: jest.fn(), onUnavailable: jest.fn(), onExit: jest.fn() };
    processClient = new MyotisProcess({ addonPath: '/addon.node', network: 'mainnet', dataDir: '/data', ...callbacks });
  });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });
  function receipt(type, extra = {}) {
    child.stdout.emit('data', Buffer.from(JSON.stringify({ type, generation: processClient.generation, ...extra }) + '\n'));
  }
  function ready() {
    receipt('owned');
    child.emit('message', { type: 'started', generation: processClient.generation, ok: true });
  }
  function reply(request, result = { value: 1 }) {
    child.emit('message', { ...request, type: 'reply', ok: true, result });
  }
  function verifiedExit() {
    receipt('reaped', { exitCode: 0, signal: 0, forced: false });
    child.stdout.emit('end');
    child.emit('exit', 0, null);
  }

  test('withholds native startup until supervisor ownership and filters environment', () => {
    expect(child.send).not.toHaveBeenCalled();
    ready();
    expect(child.send.mock.calls[0][0]).toMatchObject({ type: 'start', network: 'mainnet' });
    const options = fork.mock.calls[0][2];
    expect(options.execArgv).toEqual([process.execPath]);
    expect(options.env.ELECTRON_RUN_AS_NODE).toBe('1');
    for (const key of Object.keys(options.env)) {
      expect(['ELECTRON_RUN_AS_NODE', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']).toContain(key);
    }
    expect(options.stdio).toEqual(['pipe', 'pipe', 'ignore', 'ipc']);
  });

  test('bounds native admission and queue, with independently bounded status', async () => {
    ready();
    const requests = Array.from({ length: 18 }, () => processClient.request('call').catch((e) => e));
    const overflow = processClient.request('call');
    await expect(overflow).rejects.toThrow('queue is full');
    expect(processClient.active.size).toBe(2);
    expect(processClient.queue).toHaveLength(16);
    const status = processClient.request('status').catch((e) => e);
    await expect(processClient.request('status')).rejects.toThrow('already pending');
    expect(processClient.active.size).toBe(3);
    const sent = child.send.mock.calls.at(-1)[0];
    reply(sent, { snapPeers: 1 });
    await status;
    expect(callbacks.onStatus).toHaveBeenCalledWith({ snapPeers: 1 });
    const stopping = processClient.stop();
    verifiedExit();
    await stopping;
    await Promise.all(requests);
  });

  test('timed-out native requests retain permits, reject queue and cannot refill', async () => {
    ready();
    const pending = Array.from({ length: 4 }, () => processClient.request('call', [], 100).catch((e) => e));
    const sent = child.send.mock.calls.filter(([m]) => m.type === 'request').map(([m]) => m);
    jest.advanceTimersByTime(100);
    expect(processClient.accepting).toBe(false);
    expect(callbacks.onUnavailable).toHaveBeenCalledTimes(1);
    expect(processClient.active.size).toBe(2);
    expect(processClient.queue).toHaveLength(0);
    await expect(processClient.request('call')).rejects.toThrow('unavailable');
    reply(sent[0]);
    expect(processClient.active.size).toBe(1);
    expect(child.send.mock.calls.filter(([m]) => m.type === 'request')).toHaveLength(2);
    jest.advanceTimersByTime(1500);
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
    verifiedExit();
    expect(processClient.active.size).toBe(0);
    await Promise.all(pending);
  });

  test('queued deadlines remove only unsent work and do not retire healthy native work', async () => {
    ready();
    const active = [processClient.request('call').catch((e) => e), processClient.request('call').catch((e) => e)];
    const queued = processClient.request('call', [], 10);
    const rejected = expect(queued).rejects.toThrow('queue deadline');
    jest.advanceTimersByTime(10);
    await rejected;
    expect(processClient.accepting).toBe(true);
    expect(processClient.active.size).toBe(2);
    processClient.stop(); verifiedExit(); await Promise.all(active);
  });

  test('requires native terminal receipt AND OS supervisor exit; kill/ack are insufficient', async () => {
    ready();
    const stopping = processClient.stop();
    child.emit('message', { type: 'stopped', generation: processClient.generation });
    receipt('reaped', { exitCode: 0, signal: 0, forced: false });
    expect(processClient.exited).toBe(false);
    child.stdout.emit('end');
    expect(processClient.exited).toBe(false);
    child.emit('exit', 0, null);
    await expect(stopping).resolves.toBe(true);
    expect(callbacks.onExit).toHaveBeenCalledTimes(1);
  });

  test('supervisor loss without terminal proof never authorizes data reuse', async () => {
    ready();
    child.emit('exit', null, 'SIGKILL'); child.stdout.emit('end');
    jest.advanceTimersByTime(5000);
    await expect(processClient.stop()).resolves.toBe(false);
    expect(processClient.exited).toBe(false);
    expect(callbacks.onExit).not.toHaveBeenCalled();
  });

  test('ignores stale generation and duplicate reply identities', async () => {
    ready();
    const result = processClient.request('call');
    const sent = child.send.mock.calls.at(-1)[0];
    reply({ ...sent, generation: 'old' });
    expect(processClient.active.size).toBe(1);
    reply(sent);
    await expect(result).resolves.toEqual({ value: 1 });
    reply(sent);
    expect(processClient.active.size).toBe(0);
  });

  test('lost dispatched broadcast is uncertain; queued broadcast was never sent', async () => {
    ready();
    const broadcast = processClient.request('broadcast', ['0xsigned']);
    const uncertain = expect(broadcast).rejects.toMatchObject({ code: 'MYOTIS_BROADCAST_UNCERTAIN' });
    const active = processClient.request('call').catch((e) => e);
    const queued = processClient.request('broadcast', ['0xunsent']);
    const unsent = expect(queued).rejects.toMatchObject({ code: 'MYOTIS_UNAVAILABLE' });
    processClient.stop();
    await uncertain; await unsent; await active;
    verifiedExit();
  });
});
