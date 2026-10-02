const { createRailgunRemote } = require('./railgun-remote');
class AbstractLevelDOWN {}
class AbstractIterator {}
let controller, send, remote;
const reply = (wire, value) => JSON.stringify({ id: JSON.parse(wire).id, value });
beforeEach(() => {
  controller = new AbortController();
  send = jest.fn(async (wire) => reply(wire, null));
  remote = createRailgunRemote({
    AbstractLevelDOWN,
    AbstractIterator,
    send,
    signal: controller.signal,
  });
});
afterEach(() => {
  remote.close();
  jest.useRealTimers();
});
const invoke = (object, method, ...args) =>
  new Promise((resolve, reject) =>
    object[method](...args, (error, ...values) => (error ? reject(error) : resolve(values)))
  );
test('concurrent RPC replies are correlated by request ID even when reordered', async () => {
  const tasks = [];
  send.mockImplementation((wire) => new Promise((resolve) => tasks.push({ wire, resolve })));
  const a = remote.provider.request({ method: 'eth_blockNumber', params: [] });
  const b = remote.provider.request({ method: 'eth_chainId', params: [] });
  await Promise.resolve();
  expect(tasks.map((task) => JSON.parse(task.wire).id)).toEqual([1, 2]);
  tasks[1].resolve(reply(tasks[1].wire, '0xaa36a7'));
  expect(await b).toBe('0xaa36a7');
  tasks[0].resolve(reply(tasks[0].wire, '0x123'));
  expect(await a).toBe('0x123');
});
test.each(['wrong-id', 'extra-key', 'malformed', 'oversized'])(
  'a %s reply revokes the client',
  async (mode) => {
    send.mockImplementation(async (wire) =>
      mode === 'wrong-id'
        ? JSON.stringify({ id: 999, value: null })
        : mode === 'extra-key'
          ? JSON.stringify({ id: JSON.parse(wire).id, value: null, authority: true })
          : mode === 'oversized'
            ? ' '.repeat(2 * 1024 * 1024 + 1)
            : '{'
    );
    await expect(
      remote.provider.request({ method: 'eth_blockNumber', params: [] })
    ).rejects.toThrow('Railgun session unavailable');
    expect(remote.signal.aborted).toBe(true);
  }
);
test('abort rejects a stuck transport promptly and ignores late delivery', async () => {
  let deliver, wire;
  send.mockImplementation((value) => {
    wire = value;
    return new Promise((resolve) => {
      deliver = resolve;
    });
  });
  const task = remote.provider.request({ method: 'eth_blockNumber', params: [] });
  const rejected = expect(task).rejects.toThrow('Railgun session unavailable');
  await Promise.resolve();
  controller.abort();
  await rejected;
  deliver(reply(wire, '0x123'));
  await expect(remote.provider.request({ method: 'eth_chainId', params: [] })).rejects.toThrow();
  expect(send).toHaveBeenCalledTimes(1);
});
test('transport deadline and already-aborted startup send no later work', async () => {
  jest.useFakeTimers();
  send.mockImplementation(() => new Promise(() => {}));
  const task = remote.provider.request({ method: 'eth_chainId', params: [] });
  const rejected = expect(task).rejects.toThrow();
  await Promise.resolve();
  jest.advanceTimersByTime(30000);
  await rejected;
  expect(remote.signal.aborted).toBe(true);
  jest.useRealTimers();
  const calls = send.mock.calls.length;
  await expect(
    invoke(remote.leveldown, '_put', Buffer.from('k'), Buffer.from('v'), {})
  ).rejects.toThrow();
  expect(send).toHaveBeenCalledTimes(calls);
});
test('NotFound is recoverable and does not revoke RPC or later storage', async () => {
  await expect(invoke(remote.leveldown, '_get', Buffer.from('missing'), {})).rejects.toMatchObject({
    notFound: true,
  });
  expect(remote.signal.aborted).toBe(false);
  send.mockImplementation(async (wire) => reply(wire, Buffer.from('value').toString('base64')));
  expect(await invoke(remote.leveldown, '_get', Buffer.from('k'), { asBuffer: false })).toEqual([
    'value',
  ]);
});
test('seek and end queue behind an unresolved remote iterator open', async () => {
  let opened;
  const methods = [];
  send.mockImplementation((wire) => {
    const message = JSON.parse(wire);
    methods.push(message.method);
    if (message.method === 'open')
      return new Promise((resolve) => {
        opened = () => resolve(reply(wire, 7));
      });
    expect(message.args.cursor).toBe(7);
    return Promise.resolve(
      reply(
        wire,
        message.method === 'nextMany'
          ? {
              rows: [[Buffer.from('b').toString('base64'), Buffer.from('v').toString('base64')]],
              done: true,
            }
          : null
      )
    );
  });
  const iterator = remote.leveldown._iterator({ keyAsBuffer: false, valueAsBuffer: false });
  iterator._seek(Buffer.from('b'));
  const next = invoke(iterator, '_next');
  await Promise.resolve();
  expect(methods).toEqual(['open']);
  opened();
  expect(await next).toEqual(['b', 'v']);
  await invoke(iterator, '_end');
  expect(methods).toEqual(['open', 'seek', 'nextMany', 'end']);
});
test('closing while an iterator is opening rejects reads without another transport call', async () => {
  send.mockImplementation(() => new Promise(() => {}));
  const iterator = remote.leveldown._iterator({});
  await Promise.resolve();
  const next = invoke(iterator, '_next');
  const rejected = expect(next).rejects.toThrow();
  remote.close();
  await rejected;
  await invoke(iterator, '_end');
  expect(send).toHaveBeenCalledTimes(1);
});
test('buffered iteration reduces round trips while seek discards cached rows without consuming the limit', async () => {
  const b = (v) => Buffer.from(v).toString('base64');
  let offset = 0;
  send.mockImplementation(async (wire) => {
    const { method, args } = JSON.parse(wire);
    if (method === 'open') {
      expect(args.options.limit).toBe(-1);
      return reply(wire, 1);
    }
    if (method === 'seek') {
      offset = 50;
      return reply(wire, null);
    }
    if (method === 'end') return reply(wire, null);
    expect(method).toBe('nextMany');
    const rows = Array.from({ length: Math.min(args.limit, 100 - offset) }, () => [
      b(String(offset++)),
      b('value'),
    ]);
    return reply(wire, { rows, done: offset === 100 });
  });
  const iterator = remote.leveldown._iterator({ limit: 5, keyAsBuffer: false });
  expect((await invoke(iterator, '_next'))[0]).toBe('0');
  expect((await invoke(iterator, '_next'))[0]).toBe('1');
  iterator._seek(Buffer.from('50'));
  expect((await invoke(iterator, '_next'))[0]).toBe('50');
  expect((await invoke(iterator, '_next'))[0]).toBe('51');
  expect((await invoke(iterator, '_next'))[0]).toBe('52');
  expect(await invoke(iterator, '_next')).toEqual([]);
  await invoke(iterator, '_end');
  expect(send.mock.calls.filter(([wire]) => JSON.parse(wire).method === 'nextMany')).toHaveLength(
    2
  );
});
test.each([
  { rows: [], done: false },
  { rows: [[null, '!']], done: true },
  { rows: [], done: true, extra: true },
  { rows: Array(129).fill([null, null]), done: false },
])('refuses malformed multirow replies %j', async (value) => {
  send.mockImplementation(async (wire) =>
    reply(wire, JSON.parse(wire).method === 'open' ? 1 : value)
  );
  const iterator = remote.leveldown._iterator({});
  await expect(invoke(iterator, '_next')).rejects.toThrow();
  expect(remote.signal.aborted).toBe(true);
});
test('a large read burst queues in FIFO order with at most eight requests in flight', async () => {
  let inflight = 0,
    peak = 0;
  const ids = [];
  send.mockImplementation(async (wire) => {
    inflight++;
    peak = Math.max(peak, inflight);
    const message = JSON.parse(wire);
    ids.push(message.id);
    await new Promise((resolve) => setImmediate(resolve));
    inflight--;
    return reply(wire, message.args.params[0]);
  });
  const values = await Promise.all(
    Array.from({ length: 128 }, (_, i) =>
      remote.provider.request({ method: 'eth_blockNumber', params: [i] })
    )
  );
  expect(values).toEqual(Array.from({ length: 128 }, (_, i) => i));
  expect(ids).toEqual(Array.from({ length: 128 }, (_, i) => i + 1));
  expect(peak).toBe(8);
  expect(remote.signal.aborted).toBe(false);
});
test('cancellation drops queued requests without sending them', async () => {
  send.mockImplementation(() => new Promise(() => {}));
  const tasks = Array.from({ length: 64 }, () =>
    expect(remote.provider.request({ method: 'eth_blockNumber', params: [] })).rejects.toThrow()
  );
  await Promise.resolve();
  expect(send).toHaveBeenCalledTimes(8);
  controller.abort();
  await Promise.all(tasks);
  expect(send).toHaveBeenCalledTimes(8);
});
test.each(['count', 'bytes'])(
  'queue %s overflow fails closed without forwarding waiting requests',
  async (mode) => {
    send.mockImplementation(() => new Promise(() => {}));
    const tasks = Array.from({ length: 8 }, () =>
      expect(remote.provider.request({ method: 'eth_blockNumber', params: [] })).rejects.toThrow()
    );
    await Promise.resolve();
    const count = mode === 'count' ? 1025 : 9;
    for (let i = 0; i < count; i++)
      tasks.push(
        expect(
          remote.provider.request({
            method: 'eth_blockNumber',
            params: mode === 'count' ? [] : ['x'.repeat(1024 * 1024)],
          })
        ).rejects.toThrow()
      );
    await Promise.all(tasks);
    expect(send).toHaveBeenCalledTimes(8);
    expect(remote.signal.aborted).toBe(true);
  }
);
test('queued inputs are copied before callers can mutate them', async () => {
  const held = [];
  send.mockImplementation(
    (wire) =>
      new Promise((resolve) =>
        held.push(() => resolve(reply(wire, JSON.parse(wire).args.params[0])))
      )
  );
  const active = Array.from({ length: 8 }, () =>
    remote.provider.request({ method: 'eth_blockNumber', params: [0] })
  );
  const input = { method: 'eth_blockNumber', params: [7] };
  const waiting = remote.provider.request(input);
  input.params[0] = 99;
  await Promise.resolve();
  held[0]();
  await active[0];
  await new Promise((resolve) => setImmediate(resolve));
  expect(held).toHaveLength(9);
  held[8]();
  expect(await waiting).toBe(7);
  held.slice(1, 8).forEach((resolve) => resolve());
  await Promise.all(active);
});
test('multi-get uses one request and rejects a partial response', async () => {
  send.mockImplementation(async (wire) => {
    expect(JSON.parse(wire).method).toBe('getMany');
    return reply(wire, [Buffer.from('value').toString('base64'), null]);
  });
  expect(
    await invoke(remote.leveldown, '_getMany', [Buffer.from('a'), Buffer.from('b')], {
      asBuffer: false,
    })
  ).toEqual([['value', undefined]]);
  expect(send).toHaveBeenCalledTimes(1);
  send.mockImplementation(async (wire) => reply(wire, []));
  await expect(invoke(remote.leveldown, '_getMany', [Buffer.from('a')], {})).rejects.toThrow();
  expect(remote.signal.aborted).toBe(true);
});

test('a tagged write group streams bounded frames and commits only after all writes', async () => {
  const commands = [];
  send.mockImplementation(async (wire) => {
    const command = JSON.parse(wire);
    commands.push(command);
    expect(Buffer.byteLength(wire)).toBeLessThanOrEqual(2 * 1024 * 1024);
    return reply(wire, command.method === 'txBegin' ? 1 : null);
  });
  const operations = Array.from({ length: 2500 }, (_, i) => ({
    type: 'put',
    key: Buffer.from(String(i)),
    value: Buffer.from('value'),
  }));
  await remote.withTransaction(async () => {
    await Promise.all([
      invoke(remote.leveldown, '_batch', operations, {}),
      invoke(remote.leveldown, '_put', Buffer.from('metadata'), Buffer.from('done'), {}),
    ]);
  });
  expect(commands[0].method).toBe('txBegin');
  expect(commands.at(-1).method).toBe('txCommit');
  const stages = commands.filter((c) => c.method === 'txStage');
  expect(stages.reduce((n, c) => n + c.args.operations.length, 0)).toBe(2501);
  expect(stages.every((c) => c.args.transaction === 1 && c.args.operations.length <= 1024)).toBe(
    true
  );
});
test('callback failure aborts rather than commits its staged group', async () => {
  const commands = [];
  send.mockImplementation(async (wire) => {
    const c = JSON.parse(wire);
    commands.push(c.method);
    return reply(wire, c.method === 'txBegin' ? 1 : null);
  });
  await expect(
    remote.withTransaction(async () => {
      await invoke(remote.leveldown, '_put', Buffer.from('a'), Buffer.from('b'), {});
      throw new Error('group failed');
    })
  ).rejects.toThrow();
  expect(commands).toEqual(['txBegin', 'txStage', 'txAbort']);
  expect(remote.signal.aborted).toBe(true);
});
test('large values split on frame bytes as well as operation count', async () => {
  const stages = [];
  send.mockImplementation(async (wire) => {
    const c = JSON.parse(wire);
    if (c.method === 'txStage') stages.push(wire);
    return reply(wire, c.method === 'txBegin' ? 1 : null);
  });
  await remote.withTransaction(() =>
    invoke(
      remote.leveldown,
      '_batch',
      [0, 1].map((i) => ({
        type: 'put',
        key: Buffer.from(String(i)),
        value: Buffer.alloc(1024 * 1024),
      })),
      {}
    )
  );
  expect(stages).toHaveLength(2);
  expect(stages.every((wire) => Buffer.byteLength(wire) <= 2 * 1024 * 1024)).toBe(true);
});

test('an unrelated read during a write scope fails instead of seeing provisional state', async () => {
  let entered, release;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  send.mockImplementation(async (wire) =>
    reply(wire, JSON.parse(wire).method === 'txBegin' ? 1 : null)
  );
  const group = remote.withTransaction(async () => {
    await invoke(remote.leveldown, '_put', Buffer.from('node'), Buffer.from('new'), {});
    entered();
    await hold;
  });
  const rejected = expect(group).rejects.toThrow();
  await started;
  await expect(invoke(remote.leveldown, '_get', Buffer.from('node'), {})).rejects.toThrow();
  release();
  await rejected;
  expect(send.mock.calls.map(([wire]) => JSON.parse(wire).method)).not.toContain('txCommit');
});
test('tagged reads capture their group before entering the FIFO', async () => {
  const methods = [];
  send.mockImplementation(async (wire) => {
    const c = JSON.parse(wire);
    methods.push(c);
    return reply(wire, c.method === 'txBegin' ? 1 : null);
  });
  await remote.withTransaction(async () => {
    await invoke(remote.leveldown, '_put', Buffer.from('node'), Buffer.from('new'), {});
    await expect(invoke(remote.leveldown, '_get', Buffer.from('metadata'), {})).rejects.toThrow(
      'NotFound'
    );
  });
  expect(methods.find((c) => c.method === 'txRead').args).toEqual({
    transaction: 1,
    method: 'get',
    args: { key: Buffer.from('metadata').toString('base64') },
  });
  expect(methods.at(-1).method).toBe('txCommit');
});

test('polling remains available while a write scope holds storage', async () => {
  let entered, release;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  send.mockImplementation(async (wire) => {
    const m = JSON.parse(wire).method;
    return reply(wire, m === 'txBegin' ? 1 : m === 'rpc' ? '0x1' : null);
  });
  const group = remote.withTransaction(async () => {
    await invoke(remote.leveldown, '_put', Buffer.from('a'), Buffer.from('b'), {});
    entered();
    await hold;
  });
  await started;
  expect(await remote.provider.request({ method: 'eth_blockNumber', params: [] })).toBe('0x1');
  release();
  await group;
  expect(remote.signal.aborted).toBe(false);
});
