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
    child.unref = jest.fn();
    child.stdout = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = jest.fn();
    fork = jest.fn(() => child);
    jest.doMock('child_process', () => ({ fork }));
    jest.doMock('fs', () => ({ existsSync: () => true, accessSync: jest.fn(), mkdirSync: jest.fn(), constants: { X_OK: 1 } }));
    const { MyotisProcess } = require('./myotis-process');
    callbacks = { onStatus: jest.fn(), onUnavailable: jest.fn(), onExit: jest.fn(), onLifecycle: jest.fn() };
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

  test.each(['win32', 'darwin', 'linux'])('supervisor detach is Windows-only and preserves observed pipes on %s', (platform) => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    try {
      Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
      const { MyotisProcess } = require('./myotis-process');
      new MyotisProcess({ addonPath: '/addon.node', network: 'mainnet', dataDir: '/data', ...callbacks });
      const options = fork.mock.calls.at(-1)[2];
      expect(options.detached).toBe(platform === 'win32');
      expect(options.stdio).toEqual(['pipe', 'pipe', 'ignore', 'ipc']);
      expect(options.serialization).toBe('json');
      expect(options.execArgv).toEqual([process.execPath]);
      expect(child.listenerCount('exit')).toBeGreaterThan(0);
      expect(child.stdout.listenerCount('end')).toBeGreaterThan(0);
      expect(child.unref).not.toHaveBeenCalled();
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
    }
  });

  test('bounds native admission and queue, with independently bounded status', async () => {
    ready();
    const requests = Array.from({ length: 17 }, () => processClient.request('call').catch((e) => e));
    const overflow = processClient.request('call');
    await expect(overflow).rejects.toThrow('queue is full');
    expect(processClient.active.size).toBe(1);
    expect(processClient.queue).toHaveLength(16);
    const status = processClient.request('status').catch((e) => e);
    await expect(processClient.request('status')).rejects.toThrow('already pending');
    expect(processClient.active.size).toBe(2);
    const sent = child.send.mock.calls.at(-1)[0];
    reply(sent, { snapPeers: 1 });
    await status;
    expect(callbacks.onStatus).toHaveBeenCalledWith({ snapPeers: 1 });
    const stopping = processClient.stop();
    verifiedExit();
    await stopping;
    await Promise.all(requests);
  });

  test('preserves the verified head through the real bounded status snapshot', async () => {
    ready();
    const expected = {
      beaconState: 'SYNCED', currentPeriod: 1400, targetPeriod: 1400,
      peerCount: 12, snapPeers: 3, finalizedBlockNumber: 25684100,
      optimisticBlockNumber: 25684159, elReaderAvailable: true, elHunting: false,
    };
    const status = processClient.request('status');
    reply(child.send.mock.calls.at(-1)[0], { ...expected, engineLogs: 'private payload' });
    await status;
    expect(callbacks.onStatus).toHaveBeenLastCalledWith(expected);
    for (const value of ['25684159', Infinity, NaN]) {
      const next = processClient.request('status');
      reply(child.send.mock.calls.at(-1)[0], { optimisticBlockNumber: value });
      await next;
      expect(callbacks.onStatus).toHaveBeenLastCalledWith({});
    }
  });

  test('soft caller expiry retains native admission; only the hard watchdog stops a stuck generation', async () => {
    ready();
    const pending = Array.from({ length: 4 }, () => processClient.request('call', [], 100).catch((e) => e));
    jest.advanceTimersByTime(100);
    expect(processClient.accepting).toBe(true);
    expect(callbacks.onUnavailable).not.toHaveBeenCalled();
    expect(processClient.active.size).toBe(1);
    expect(processClient.queue).toHaveLength(0);
    const next = processClient.request('call').catch((e) => e);
    expect(child.send.mock.calls.filter(([m]) => m.type === 'request')).toHaveLength(1);
    jest.advanceTimersByTime(99900);
    expect(processClient.accepting).toBe(false);
    expect(processClient.active.size).toBe(1);
    expect(callbacks.onUnavailable).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1500);
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
    receipt('reaped', { exitCode: -1, signal: 9, forced: true });
    expect(processClient.active.size).toBe(1);
    child.stdout.emit('end'); child.emit('exit', 0, null);
    expect(processClient.active.size).toBe(0);
    await Promise.all([...pending, next]);
  });

  test('late actual completion releases its slot without delivering a timed-out result or stopping the chain', async () => {
    ready();
    const first = processClient.request('call', [], 100).catch((e) => e);
    const sent = child.send.mock.calls.at(-1)[0];
    jest.advanceTimersByTime(100);
    expect((await first).code).toBe('MYOTIS_UNAVAILABLE');
    const second = processClient.request('call');
    expect(processClient.queue).toHaveLength(1);
    reply(sent, { resultHex: '0xlate' });
    expect(processClient.active.size).toBe(1);
    expect(processClient.queue).toHaveLength(0);
    reply(child.send.mock.calls.at(-1)[0], { resultHex: '0xfresh' });
    await expect(second).resolves.toEqual({ resultHex: '0xfresh' });
    expect(processClient.accepting).toBe(true);
    expect(callbacks.onUnavailable).not.toHaveBeenCalled();
  });

  test('started broadcast caller expiry is uncertain while unsent queued expiry is not', async () => {
    ready();
    const first = processClient.request('broadcast', ['0xsigned'], 100).catch((e) => e);
    const queued = processClient.request('broadcast', ['0xunsent'], 100).catch((e) => e);
    jest.advanceTimersByTime(100);
    expect((await first).code).toBe('MYOTIS_BROADCAST_UNCERTAIN');
    expect((await queued).code).toBe('MYOTIS_UNAVAILABLE');
    expect(processClient.accepting).toBe(true);
    expect(processClient.active.size).toBe(1);
    expect(child.send.mock.calls.filter(([m]) => m.op === 'broadcast')).toHaveLength(1);
    processClient.stop(); verifiedExit();
  });

  test('does not forward an expired queue entry even before its timer callback runs', async () => {
    ready();
    const first = processClient.request('call');
    const sent = child.send.mock.calls.at(-1)[0];
    const queued = processClient.request('call', [], 10).catch((error) => error);
    jest.setSystemTime(Date.now() + 11);
    reply(sent);
    await first;
    expect((await queued).code).toBe('MYOTIS_UNAVAILABLE');
    expect(child.send.mock.calls.filter(([m]) => m.type === 'request')).toHaveLength(1);
  });

  test('retains the pending status permit until the ten-second hard deadline stops the generation', async () => {
    ready();
    const status = processClient.request('status', [], 10000).catch((error) => error);
    jest.advanceTimersByTime(6001);
    expect(processClient.accepting).toBe(true);
    expect(processClient.active.size).toBe(1);
    await expect(processClient.request('status')).rejects.toThrow('already pending');
    jest.advanceTimersByTime(3999);
    expect(processClient.accepting).toBe(false);
    expect(processClient.active.size).toBe(1);
    expect(callbacks.onUnavailable).toHaveBeenCalledTimes(1);
    verifiedExit();
    expect(processClient.active.size).toBe(0);
    await status;
  });

  test('queued deadlines remove only unsent work and do not retire healthy native work', async () => {
    ready();
    const active = [processClient.request('call').catch((e) => e)];
    const queued = processClient.request('call', [], 10);
    const rejected = expect(queued).rejects.toThrow('queue deadline');
    jest.advanceTimersByTime(10);
    await rejected;
    expect(processClient.accepting).toBe(true);
    expect(processClient.active.size).toBe(1);
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

  test('accepts ownership reported after control revocation and verifies that clean exit', async () => {
    // A stop can revoke control while the supervisor is still starting its
    // child. It then reports ownership, retires the child and exits 0, so the
    // terminal receipt is proof and the data directory stays reusable.
    const stopping = processClient.stop();
    jest.advanceTimersByTime(1500);
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    receipt('owned');
    expect(child.send.mock.calls.some(([message]) => message.type === 'start')).toBe(false);
    verifiedExit();
    await expect(stopping).resolves.toBe(true);
    expect(processClient.exited).toBe(true);
    expect(callbacks.onExit).toHaveBeenCalledTimes(1);
    const events = callbacks.onLifecycle.mock.calls.map(([event]) => event);
    expect(events.find((event) => event.event === 'supervisor-exit')).toMatchObject({
      classification: 'verified', code: 0, receipt: 'reaped', forced: false,
    });
    expect(events.some((event) => event.event === 'unavailable')).toBe(false);
  });

  // Only a receipt from this generation, whose bounded fields all parse, may
  // classify an exit as verified. Everything else quarantines the directory.
  test.each([
    ['another generation', { generation: 'other' }],
    ['a non-boolean forced flag', { forced: 'no' }],
    ['a missing forced flag', { forced: undefined }],
    ['a fractional child exit code', { exitCode: 1.5 }],
    ['a child exit code above the 32-bit range', { exitCode: 0x100000000 }],
    ['a child exit code below -1', { exitCode: -2 }],
    ['a missing child exit code', { exitCode: undefined }],
    ['a negative signal', { signal: -1 }],
    ['a signal above the platform range', { signal: 129 }],
    ['a missing signal', { signal: undefined }],
  ])('a reaped receipt with %s leaves the exit unconfirmed', async (_label, change) => {
    ready();
    receipt('reaped', { exitCode: 0, signal: 0, forced: false, ...change });
    child.stdout.emit('end');
    child.emit('exit', 0, null);
    expect(processClient.exited).toBe(false);
    const events = callbacks.onLifecycle.mock.calls.map(([event]) => event);
    expect(events.find((event) => event.event === 'supervisor-exit')).toMatchObject({
      classification: 'unconfirmed',
    });
    jest.advanceTimersByTime(5000);
    await expect(processClient.stop()).resolves.toBe(false);
    expect(callbacks.onExit).not.toHaveBeenCalled();
  });

  test('an oversized receipt stream is refused even when it would otherwise parse', async () => {
    ready();
    // Well-formed apart from its size: only the 1 KiB stream cap rejects it.
    receipt('reaped', { exitCode: 0, signal: 0, forced: false, pad: 'a'.repeat(1024) });
    child.stdout.emit('end');
    child.emit('exit', 0, null);
    expect(processClient.exited).toBe(false);
    const events = callbacks.onLifecycle.mock.calls.map(([event]) => event);
    expect(events.find((event) => event.event === 'supervisor-exit')).toMatchObject({
      classification: 'unconfirmed', receipt: 'invalid',
    });
    jest.advanceTimersByTime(5000);
    await expect(processClient.stop()).resolves.toBe(false);
  });

  test('supervisor loss without terminal proof never authorizes data reuse', async () => {
    ready();
    child.emit('exit', null, 'SIGKILL'); child.stdout.emit('end');
    jest.advanceTimersByTime(5000);
    await expect(processClient.stop()).resolves.toBe(false);
    expect(processClient.exited).toBe(false);
    expect(callbacks.onExit).not.toHaveBeenCalled();
  });

  test('propagates native anchor mismatch as a bounded storage error', () => {
    receipt('owned');
    child.emit('message', { type: 'started', generation: processClient.generation, ok: false, failure: 'anchor-mismatch' });
    expect(callbacks.onUnavailable).toHaveBeenCalledWith(expect.any(String), 'CHECKPOINT_STORAGE');
    expect(processClient.accepting).toBe(false);
  });

  test('logs bounded startup and unknown-exit facts without addon payloads', async () => {
    receipt('owned');
    child.emit('message', {
      type: 'started', generation: processClient.generation, ok: false,
      failure: 'secret addon exception with request payload',
    });
    child.emit('exit', 67, null);
    child.stdout.emit('end');
    processClient.finishExit();
    expect(callbacks.onLifecycle).toHaveBeenCalledWith({
      generation: processClient.generation, event: 'startup-failed', failure: 'unknown',
    });
    const events = callbacks.onLifecycle.mock.calls.map(([event]) => event);
    expect(events.filter((event) => event.event === 'supervisor-exit')).toEqual([{
      generation: processClient.generation, event: 'supervisor-exit',
      classification: 'unconfirmed', code: 67, signal: null, receipt: 'missing',
      childExitCode: null, childSignal: null, forced: null,
    }]);
    expect(events.length).toBeLessThanOrEqual(6);
    expect(JSON.stringify(events)).not.toMatch(/secret|payload|addon\.node|\/data/);
    expect(processClient.exited).toBe(false);
    jest.advanceTimersByTime(5000);
    await expect(processClient.stop()).resolves.toBe(false);
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
  test('forwards the imported checkpoint only after supervisor ownership', () => {
    const { MyotisProcess } = require('./myotis-process');
    const checkpoint = { chainId: 100, network: 'gnosis', root: '0x' + 'ab'.repeat(32), slot: 123 };
    processClient = new MyotisProcess({ addonPath: '/addon.node', network: 'gnosis', dataDir: '/owned', checkpoint, ...callbacks });
    expect(child.send).not.toHaveBeenCalled();
    receipt('owned');
    expect(child.send).toHaveBeenCalledWith(expect.objectContaining({ checkpoint, dataDir: '/owned' }), expect.any(Function));
    child.emit('message', { type: 'started', generation: processClient.generation, ok: true, checkpointSupported: true });
    expect(processClient.checkpointSupported).toBe(true);
  });

  test('old addon capability remains false unless explicitly reported', () => {
    ready();
    expect(processClient.checkpointSupported).toBe(false);
  });

  test('a verified late exit supersedes the old false stop result', async () => {
    ready();
    const stopping = processClient.stop();
    await jest.advanceTimersByTimeAsync(5001);
    await expect(stopping).resolves.toBe(false);
    verifiedExit();
    expect(processClient.exited).toBe(true);
    await expect(processClient.stop()).resolves.toBe(true);
    expect(callbacks.onExit).toHaveBeenCalledTimes(1);
  });

  test.each(['load', 'abi', 'methods'])('%s startup failures request installation repair with a bounded category', async failure => {
    child.emit('message', { type: 'started', generation: processClient.generation, ok: false, failure });
    await expect(processClient.startPromise).resolves.toBe(false);
    expect(callbacks.onUnavailable).toHaveBeenCalledWith(expect.any(String), 'CHECKPOINT_INSTALLATION');
  });

});
