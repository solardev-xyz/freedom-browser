/**
 * Main's dweb fetch admission (freedom-core design 0006, deviation
 * `fetch-admission`): 256 active, 512 waiting, a 503 beyond, and every slot
 * freed on its terminal path, the session closing included.
 */

const {
  createFetchAdmission,
  AdmissionFull,
  MAX_ACTIVE,
  MAX_WAITING,
} = require('./fetch-admission');

const turn = () => new Promise((resolve) => setImmediate(resolve));

test("the design's bounds", () => {
  expect([MAX_ACTIVE, MAX_WAITING]).toEqual([256, 512]);
});

test('admits up to the active bound at once, then queues up to the waiting bound', async () => {
  const admission = createFetchAdmission({ maxActive: 2, maxWaiting: 2 });
  const first = await admission.acquire();
  const second = await admission.acquire();
  expect([first.waited, second.waited]).toEqual([false, false]);
  const waiting = [admission.acquire(), admission.acquire()];
  expect(admission.stats()).toEqual({ active: 2, waiting: 2 });
  // Beyond both bounds: refused at once.
  await expect(admission.acquire()).rejects.toBeInstanceOf(AdmissionFull);

  // Slots go to the waiters in order, as fetches end.
  first.release();
  const third = await waiting[0];
  expect(third.waited).toBe(true);
  expect(admission.stats()).toEqual({ active: 2, waiting: 1 });
  // A release is counted once, however often it is called.
  first.release();
  expect(admission.stats()).toEqual({ active: 2, waiting: 1 });
  second.release();
  await waiting[1];
  expect(admission.stats()).toEqual({ active: 2, waiting: 0 });
});

test('a waiter whose page aborts leaves the queue', async () => {
  const admission = createFetchAdmission({ maxActive: 1, maxWaiting: 4 });
  const held = await admission.acquire();
  const controller = new AbortController();
  const waiting = admission.acquire({ signal: controller.signal });
  const next = admission.acquire();
  controller.abort();
  await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
  expect(admission.stats()).toEqual({ active: 1, waiting: 1 });
  held.release();
  await expect(next).resolves.toMatchObject({ waited: true });
  // An already-aborted request takes nothing.
  const aborted = new AbortController();
  aborted.abort();
  await expect(admission.acquire({ signal: aborted.signal })).rejects.toMatchObject({
    name: 'AbortError',
  });
});

test("a session's close refuses its waiters and stops its active fetches", async () => {
  const admission = createFetchAdmission({ maxActive: 2, maxWaiting: 4 });
  const privateFetch = await admission.acquire({ partition: 'private-1' });
  const defaultFetch = await admission.acquire();
  const privateWaiter = admission.acquire({ partition: 'private-1' });
  const defaultWaiter = admission.acquire();

  admission.closeSession('private-1');
  await expect(privateWaiter).rejects.toThrow('The session closed');
  expect(privateFetch.stop.aborted).toBe(true);
  expect(defaultFetch.stop.aborted).toBe(false);
  // The stopped fetch frees its slot as it ends.
  privateFetch.release();
  await expect(defaultWaiter).resolves.toMatchObject({ waited: true });
  await turn();
  expect(admission.stats()).toEqual({ active: 2, waiting: 0 });
});
