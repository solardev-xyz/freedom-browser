const { createRadReadAdmission, LIMITS, RadReadRefused } = require('./rad-read-admission');

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe('rad: read admission (R-3)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('matches the documented limits', () => {
    expect(LIMITS).toEqual({
      IN_FLIGHT: 2,
      PER_REQUESTER: 8,
      QUEUE_MAX: 32,
      WAIT_MS: 15000,
      RUN_MS: 30000,
    });
  });

  test('runs at most IN_FLIGHT reads at once; the rest wait their turn', async () => {
    const admission = createRadReadAdmission();
    const reads = [deferred(), deferred(), deferred()];
    const started = [];
    const results = reads.map((d, i) =>
      admission.run('a', undefined, () => {
        started.push(i);
        return d.promise;
      })
    );
    await flush();
    expect(started).toEqual([0, 1]);
    expect(admission.stats()).toEqual({ running: 2, waiting: 1 });

    reads[0].resolve('zero');
    await flush();
    expect(started).toEqual([0, 1, 2]);
    reads[1].resolve('one');
    reads[2].resolve('two');
    await expect(Promise.all(results)).resolves.toEqual(['zero', 'one', 'two']);
    expect(admission.stats()).toEqual({ running: 0, waiting: 0 });
  });

  test('one requester cannot fill the queue; others still get in', async () => {
    const admission = createRadReadAdmission();
    const hold = deferred();
    for (let i = 0; i < LIMITS.IN_FLIGHT + LIMITS.PER_REQUESTER; i += 1) {
      admission.run('greedy', undefined, () => hold.promise).catch(() => {});
    }
    await expect(admission.run('greedy', undefined, () => 'x')).rejects.toMatchObject({
      status: 503,
    });
    const other = admission.run('other', undefined, () => 'other');
    expect(admission.stats().waiting).toBe(LIMITS.PER_REQUESTER + 1);
    hold.resolve('done');
    await expect(other).resolves.toBe('other');
  });

  test('the queue as a whole is bounded', async () => {
    const admission = createRadReadAdmission();
    const hold = deferred();
    for (let i = 0; i < LIMITS.IN_FLIGHT + LIMITS.QUEUE_MAX; i += 1) {
      admission.run(`page-${i}`, undefined, () => hold.promise).catch(() => {});
    }
    await expect(admission.run('late', undefined, () => 'x')).rejects.toBeInstanceOf(
      RadReadRefused
    );
    hold.resolve();
  });

  test('a read that waits too long is refused without reaching the add-on', async () => {
    const admission = createRadReadAdmission();
    const hold = deferred();
    admission.run('a', undefined, () => hold.promise);
    admission.run('a', undefined, () => hold.promise);
    const read = jest.fn();
    const waiting = admission.run('b', undefined, read);
    jest.advanceTimersByTime(LIMITS.WAIT_MS);
    await expect(waiting).rejects.toMatchObject({ status: 503 });
    hold.resolve();
    await flush();
    expect(read).not.toHaveBeenCalled();
  });

  test('a read that runs too long is answered 504 but keeps its slot until done', async () => {
    const admission = createRadReadAdmission();
    const slow = deferred();
    const slowRead = admission.run('a', undefined, () => slow.promise);
    const stuck = admission.run('a', undefined, () => new Promise(() => {}));
    stuck.catch(() => {});
    jest.advanceTimersByTime(LIMITS.RUN_MS);
    await expect(slowRead).rejects.toMatchObject({ status: 504 });

    const next = jest.fn(() => 'next');
    const queued = admission.run('b', undefined, next);
    await flush();
    // The add-on is still busy with it: the queued read has not started.
    expect(next).not.toHaveBeenCalled();
    expect(admission.stats().running).toBe(2);

    slow.resolve('late');
    await expect(queued).resolves.toBe('next');
    await expect(stuck).rejects.toMatchObject({ status: 504 });
  });

  test('a read whose page goes away leaves the queue unread', async () => {
    const admission = createRadReadAdmission();
    const hold = deferred();
    admission.run('a', undefined, () => hold.promise);
    admission.run('a', undefined, () => hold.promise);
    const controller = new AbortController();
    const read = jest.fn();
    const waiting = admission.run('b', controller.signal, read);
    expect(admission.stats().waiting).toBe(1);

    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(admission.stats().waiting).toBe(0);
    hold.resolve();
    await flush();
    expect(read).not.toHaveBeenCalled();
  });

  test('an already-cancelled request never runs; one cancelled mid-read keeps its slot', async () => {
    const admission = createRadReadAdmission();
    const controller = new AbortController();
    controller.abort();
    const read = jest.fn();
    await expect(admission.run('a', controller.signal, read)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(read).not.toHaveBeenCalled();

    const live = new AbortController();
    const running = deferred();
    const result = admission.run('a', live.signal, () => running.promise);
    live.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(admission.stats().running).toBe(1);
    running.resolve();
    await flush();
    expect(admission.stats().running).toBe(0);
  });

  test('a running read is told when it has ended: caller gone, or out of time', async () => {
    const admission = createRadReadAdmission();
    const caller = new AbortController();
    const seen = [];
    const goneRead = admission.run('a', caller.signal, (work) => {
      seen.push(work);
      return deferred().promise;
    });
    const slowRead = admission.run('b', undefined, (work) => {
      seen.push(work);
      return deferred().promise;
    });
    await flush();
    expect(seen.map((work) => work.aborted)).toEqual([false, false]);

    caller.abort();
    await expect(goneRead).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen.map((work) => work.aborted)).toEqual([true, false]);

    jest.advanceTimersByTime(LIMITS.RUN_MS);
    await expect(slowRead).rejects.toMatchObject({ status: 504 });
    expect(seen[1].aborted).toBe(true);
  });
  test('free slots go to requesters in turn, not to whoever queued first', async () => {
    const admission = createRadReadAdmission();
    const holds = [];
    const started = [];
    const read = (label) => () => {
      started.push(label);
      const d = deferred();
      holds.push(d);
      return d.promise;
    };
    // 'a' fills both slots and queues three more before 'b' and 'c' arrive.
    for (let i = 0; i < 5; i += 1) admission.run('a', undefined, read(`a${i}`)).catch(() => {});
    admission.run('b', undefined, read('b0')).catch(() => {});
    admission.run('b', undefined, read('b1')).catch(() => {});
    admission.run('c', undefined, read('c0')).catch(() => {});
    await flush();
    expect(started).toEqual(['a0', 'a1']);

    // Finish one running read at a time and watch who gets the slot.
    for (let i = 0; i < 6; i += 1) {
      holds[i].resolve();
      await flush();
    }
    expect(started).toEqual(['a0', 'a1', 'a2', 'b0', 'c0', 'a3', 'b1', 'a4']);
    expect(admission.stats()).toEqual({ running: 2, waiting: 0 });
  });

  test('a tab that keeps its queue full of slow reads cannot push another tab past WAIT_MS', async () => {
    // The R1-M1 repro: 'greedy' keeps 2 running + PER_REQUESTER waiting
    // reads of 4 s each, topping its queue up whenever one finishes. Under
    // one global FIFO a quick read from 'other' waited behind the whole
    // backlog and was refused 503 at WAIT_MS; round-robin serves it at the
    // next free slot.
    const admission = createRadReadAdmission();
    const READ_MS = 4000;
    let stop = false;
    const slow = () => new Promise((resolve) => setTimeout(resolve, READ_MS));
    const refill = () => {
      if (stop) return;
      admission
        .run('greedy', undefined, slow)
        .catch(() => {})
        .finally(refill);
    };
    for (let i = 0; i < LIMITS.IN_FLIGHT + LIMITS.PER_REQUESTER; i += 1) refill();
    await flush();
    expect(admission.stats()).toEqual({
      running: LIMITS.IN_FLIGHT,
      waiting: LIMITS.PER_REQUESTER,
    });

    // Let the greedy tab churn for a while first, so its queue is steady.
    for (let t = 0; t < 3; t += 1) {
      jest.advanceTimersByTime(READ_MS);
      await flush();
    }

    let outcome = null;
    admission
      .run('other', undefined, () => 'quick')
      .then(
        (value) => (outcome = value),
        (err) => (outcome = err)
      );
    for (let t = 0; t < 2 && outcome === null; t += 1) {
      jest.advanceTimersByTime(READ_MS);
      await flush();
    }
    expect(outcome).toBe('quick');
    stop = true;
  });
});
