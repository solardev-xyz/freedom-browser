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
        message.method === 'next'
          ? [Buffer.from('b').toString('base64'), Buffer.from('v').toString('base64')]
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
  expect(methods).toEqual(['open', 'seek', 'next', 'end']);
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
test('in-flight capacity revokes all outstanding calls', async () => {
  send.mockImplementation(() => new Promise(() => {}));
  const tasks = Array.from({ length: 8 }, () =>
    expect(remote.provider.request({ method: 'eth_blockNumber', params: [] })).rejects.toThrow()
  );
  await Promise.resolve();
  await expect(
    remote.provider.request({ method: 'eth_blockNumber', params: [] })
  ).rejects.toThrow();
  await Promise.all(tasks);
  expect(send).toHaveBeenCalledTimes(8);
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
