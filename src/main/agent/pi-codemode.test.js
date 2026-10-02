'use strict';

const { serializeSessionTools } = require('./pi-codemode');

test('read batches overlap but writes and subsequent reads keep their order', async () => {
  const events = [];
  let releaseReads;
  const pendingRead = new Promise(resolve => { releaseReads = resolve; });
  const [read, write] = serializeSessionTools([
    { name: 'read', execute: async (_id, { index }) => {
      events.push(`read-${index}`);
      if (index < 3) await pendingRead;
      return index;
    } },
    { name: 'write', execute: async () => { events.push('write'); } },
  ]);
  const first = read.execute('a', { index: 1 });
  const second = read.execute('b', { index: 2 });
  const changed = write.execute('c', {});
  const later = read.execute('d', { index: 3 });
  await Promise.resolve();
  expect(events).toEqual(['read-1', 'read-2']);
  releaseReads();
  expect(await Promise.all([first, second, changed, later])).toEqual([1, 2, undefined, 3]);
  expect(events).toEqual(['read-1', 'read-2', 'write', 'read-3']);
});

test('a cancelled queued mutation never executes, and a failure does not poison later calls', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const execute = jest.fn(async (_id, { fail }) => { if (fail) throw new Error('failed'); });
  const [read, write] = serializeSessionTools([{ name: 'read', execute: () => pending }, { name: 'write', execute }]);
  const signal = new AbortController();
  const reading = read.execute('a', {});
  const cancelled = write.execute('b', {}, signal.signal);
  signal.abort();
  release();
  await reading;
  await expect(cancelled).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
  await expect(write.execute('c', { fail: true })).rejects.toThrow('failed');
  await write.execute('d', {});
  expect(execute).toHaveBeenCalledTimes(2);
});
