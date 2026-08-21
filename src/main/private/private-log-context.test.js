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
