const {
  runWithPrivateLogContext,
  isPrivateLogContext,
  redactForLog,
  redactUrlForLog,
} = require('./private-log-context');

describe('private-log-context', () => {
  test('outside a private context nothing is redacted', () => {
    expect(isPrivateLogContext()).toBe(false);
    expect(redactForLog('secret.eth')).toBe('secret.eth');
    expect(redactUrlForLog('bzz://secret.eth/x')).toBe('bzz://secret.eth/x');
  });

  test('runWithPrivateLogContext(false) does not mark the subtree', () => {
    runWithPrivateLogContext(false, () => {
      expect(isPrivateLogContext()).toBe(false);
      expect(redactForLog('secret.eth')).toBe('secret.eth');
    });
  });

  test('the context survives awaits, timers and promise chains', async () => {
    // This is the whole point: the resolver logs its name several awaits
    // deep (consensus wave → decode → cache-and-log), so a flag that only
    // held for the synchronous part of the call would guard nothing.
    await runWithPrivateLogContext(true, async () => {
      expect(isPrivateLogContext()).toBe(true);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 1));
      await Promise.all([
        (async () => {
          await new Promise((resolve) => setImmediate(resolve));
          expect(redactForLog('secret.eth')).toBe('<private>');
        })(),
      ]);
      expect(isPrivateLogContext()).toBe(true);
    });
    // ...and does not leak back out to the caller.
    expect(isPrivateLogContext()).toBe(false);
  });

  test('concurrent private and normal work do not bleed into each other', async () => {
    const seen = [];
    await Promise.all([
      runWithPrivateLogContext(true, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        seen.push(['private', redactForLog('secret.eth')]);
      }),
      runWithPrivateLogContext(false, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        seen.push(['normal', redactForLog('public.eth')]);
      }),
    ]);
    expect(seen).toEqual([
      ['normal', 'public.eth'],
      ['private', '<private>'],
    ]);
  });

  test('the return value (including a rejection) passes through', async () => {
    expect(runWithPrivateLogContext(true, () => 42)).toBe(42);
    await expect(
      runWithPrivateLogContext(true, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(isPrivateLogContext()).toBe(false);
  });

  test('redactUrlForLog keeps the transport, drops the destination', () => {
    runWithPrivateLogContext(true, () => {
      // Non-special dweb schemes have no origin — keep the scheme only.
      expect(redactUrlForLog('bzz://secret.eth/dir/page.html?q=1')).toBe('bzz://<private>');
      expect(redactUrlForLog('ipfs://secret.eth/page.html')).toBe('ipfs://<private>');
      expect(redactUrlForLog('rad://z3gqcJUoA1n9HaHKufZs5FCSGazv5/tree')).toBe('rad://<private>');
      // Gateway URLs: which gateway is the diagnostic, the path is the
      // content reference.
      expect(redactUrlForLog(`http://127.0.0.1:1633/bzz/${'a'.repeat(64)}/x`)).toBe(
        'http://127.0.0.1:1633/<private>'
      );
      // Unparseable input still yields no destination.
      expect(redactUrlForLog('not a url')).toBe('<private>');
      expect(redactUrlForLog(null)).toBe('<private>');
    });
  });
});

// #1058: a private context remembers its private session, so work that
// outlives the session can tell.
describe('private session', () => {
  const {
    privateSessionLive,
    openPrivateSession,
    endPrivateSession,
  } = require('./private-log-context');

  // Work entered in a private context now, which checks the session each
  // time it is asked to, from inside that context.
  function privateWork() {
    const asks = [];
    const done = runWithPrivateLogContext(true, async () => {
      const answers = [];
      for (;;) {
        const ask = await new Promise((resolve) => asks.push(resolve));
        if (!ask) return answers;
        answers.push([isPrivateLogContext(), privateSessionLive()]);
      }
    });
    const step = async (more = true) => {
      while (asks.length === 0) await new Promise((resolve) => setImmediate(resolve));
      asks.shift()(more);
      await new Promise((resolve) => setImmediate(resolve));
    };
    return { step, done };
  }

  afterEach(() => endPrivateSession());

  test('a private context is live while the session it was entered in is open', async () => {
    openPrivateSession();
    const work = privateWork();
    await work.step();
    // A normal context is never live.
    expect(privateSessionLive()).toBe(false);
    endPrivateSession();
    await work.step();
    // The next session does not revive it.
    openPrivateSession();
    await work.step();
    await work.step(false);
    await expect(work.done).resolves.toEqual([[true, true], [true, false], [true, false]]);
    runWithPrivateLogContext(true, () => expect(privateSessionLive()).toBe(true));
  });

  test('a private context entered with no private window open is never live', async () => {
    endPrivateSession();
    const work = privateWork();
    await work.step();
    openPrivateSession();
    await work.step();
    await work.step(false);
    await expect(work.done).resolves.toEqual([[true, false], [true, false]]);
  });
});
