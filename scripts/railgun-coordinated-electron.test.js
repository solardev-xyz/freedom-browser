const { createFeed } = require('./railgun-coordinated-electron');
test('source feed streams bounded ordered chunks with producer backpressure', async () => {
  let visited = 0;
  const feed = createFeed(async (consume) => {
    for (let n = 0; n < 300; n++) {
      visited++;
      await consume({ n });
    }
  }, new AbortController().signal);
  await new Promise((resolve) => setImmediate(resolve));
  expect(visited).toBe(129);
  const batches = [];
  for (;;) {
    const value = await feed.next();
    if (value === null) break;
    batches.push(value);
  }
  await feed.done;
  expect(batches.map((v) => v.length)).toEqual([128, 128, 44]);
  expect(batches.flat().map((v) => v.n)).toEqual(Array.from({ length: 300 }, (_, i) => i));
  feed.close();
});
test('abort rejects a blocked producer and future reads', async () => {
  const controller = new AbortController();
  const feed = createFeed(async (consume) => {
    for (let n = 0; n < 300; n++) await consume({ n });
  }, controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await expect(feed.done).rejects.toThrow('cancelled');
  await expect(feed.next()).rejects.toThrow('cancelled');
  feed.close();
});
test('source failure rejects its blocked reader rather than reporting EOF', async () => {
  let reject;
  const feed = createFeed(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
    new AbortController().signal
  );
  const result = feed.next();
  reject(new Error('Source integrity refused'));
  await expect(result).rejects.toThrow('integrity');
  await expect(feed.done).rejects.toThrow('integrity');
  feed.close();
});
test('closing a blocked producer releases the visit and refuses subsequent reads', async () => {
  const feed = createFeed(async (consume) => {
    for (let n = 0; n < 300; n++) await consume({ n });
  }, new AbortController().signal);
  await new Promise((resolve) => setImmediate(resolve));
  feed.close();
  await expect(feed.done).rejects.toThrow('closed');
  await expect(feed.next()).rejects.toThrow('closed');
});
