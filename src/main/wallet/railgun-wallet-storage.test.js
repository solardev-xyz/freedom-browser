const { createRailgunWalletStorage } = require('./railgun-wallet-storage');
const { paths } = require('./railgun-frontier');
const id = 'a'.repeat(64),
  prefix = paths.metadata().toString();
const walletPrefix = [
  Buffer.from('wallet').toString('hex').padStart(64, '0'),
  id,
  'aa36a7'.padStart(64, '0'),
].join(':');
const b64 = (text) => Buffer.from(text).toString('base64');
let router, publicDispatch, walletDispatch, lifetime, sequence;
function setup() {
  lifetime = new AbortController();
  publicDispatch = jest.fn(async (wire) => {
    const value = JSON.parse(wire);
    return JSON.stringify({ id: value.id, value: value.method === 'open' ? 1 : null });
  });
  walletDispatch = jest.fn(publicDispatch.getMockImplementation());
  router = createRailgunWalletStorage({
    publicSnapshot: { signal: lifetime.signal, dispatch: publicDispatch },
    walletSession: { signal: lifetime.signal, claimDispatch: () => ({ dispatch: walletDispatch }) },
    walletId: id,
  });
  sequence = 0;
}
const call = (channel, method, args, localId = 1) =>
  router.dispatch(
    JSON.stringify({ id: ++sequence, channel, wire: JSON.stringify({ id: localId, method, args }) })
  );
beforeEach(setup);
afterEach(() => router.close());
test('keeps public and derived streams separate and remaps only the enclosing request', async () => {
  const result = JSON.parse(await call('public', 'get', { key: b64(prefix) }));
  expect(result.id).toBe(1);
  expect(JSON.parse(result.value)).toEqual({ id: 1, value: null });
  await call('wallet', 'batch', {
    operations: [{ type: 'put', key: b64(walletPrefix + ':details'), value: b64('derived') }],
  });
  expect(publicDispatch).toHaveBeenCalledTimes(1);
  expect(walletDispatch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(walletDispatch.mock.calls[0][0]).id).toBe(1);
  router.assertIdle();
});
test.each(['batch', 'clear', 'txBegin', 'txRead', 'rpc', 'sourceNext', 'visitSource'])(
  'rejects %s on the public channel before dispatch',
  async (method) => {
    await expect(call('public', method, {})).rejects.toThrow();
    expect(publicDispatch).not.toHaveBeenCalled();
    expect(router.signal.aborted).toBe(true);
  }
);
test.each(['clear', 'txBegin', 'txRead', 'rpc', 'sourceNext', 'visitSource'])(
  'rejects %s on the wallet channel',
  async (method) => {
    await expect(call('wallet', method, {})).rejects.toThrow();
    expect(walletDispatch).not.toHaveBeenCalled();
  }
);
test.each([
  prefix,
  walletPrefix.replace(id, 'b'.repeat(64)),
  walletPrefix + '-outside',
  'nft-token-cache',
])('rejects cross-domain derived key %s', async (key) => {
  await expect(
    call('wallet', 'batch', { operations: [{ type: 'put', key: b64(key), value: b64('value') }] })
  ).rejects.toThrow();
  expect(walletDispatch).not.toHaveBeenCalled();
});
test('a mixed valid/invalid batch reaches neither store', async () => {
  await expect(
    call('wallet', 'batch', {
      operations: [
        { type: 'put', key: b64(walletPrefix + ':valid'), value: b64('value') },
        { type: 'del', key: b64(walletPrefix + ':bad') },
      ],
    })
  ).rejects.toThrow();
  expect(walletDispatch).not.toHaveBeenCalled();
});
test('getMany cannot cross from the tree into another namespace', async () => {
  await expect(
    call('public', 'getMany', { keys: [b64(prefix), b64(walletPrefix)] })
  ).rejects.toThrow();
  expect(publicDispatch).not.toHaveBeenCalled();
});
test('cursor IDs belong to their own channel and block completion until ended', async () => {
  await call('public', 'open', { options: { gte: b64(prefix), lte: b64(prefix + '~') } });
  expect(() => router.assertIdle()).toThrow();
  await call('public', 'nextMany', { cursor: 1, limit: 128 }, 2);
  await call('public', 'end', { cursor: 1 }, 3);
  router.assertIdle();
  await expect(call('wallet', 'next', { cursor: 1 })).rejects.toThrow();
});
test.each([
  {},
  { gte: b64(prefix) },
  { gte: b64(prefix), lte: b64(prefix + '~outside') },
  { gte: b64(prefix), gt: b64(prefix), lte: b64(prefix + '~') },
])('refuses unbounded or ambiguous iterator options', async (options) => {
  await expect(call('public', 'open', { options })).rejects.toThrow();
  expect(publicDispatch).not.toHaveBeenCalled();
});
test('a seek cannot escape the opened public namespace', async () => {
  await call('public', 'open', { options: { gte: b64(prefix), lte: b64(prefix + '~') } });
  await expect(
    call('public', 'seek', { cursor: 1, target: b64(walletPrefix) }, 2)
  ).rejects.toThrow();
  expect(publicDispatch).toHaveBeenCalledTimes(1);
});
test('revocation discards a late storage reply', async () => {
  let resolve;
  publicDispatch.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  const running = call('public', 'get', { key: b64(prefix) });
  expect(() => router.assertIdle()).toThrow();
  lifetime.abort();
  resolve(JSON.stringify({ id: 1, value: b64('late') }));
  await expect(running).rejects.toThrow();
});

const { createRailgunWalletSnapshotStreams } = require('./railgun-wallet-storage');
function deferredStreamValue() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function streamFamily() {
  const parent = new AbortController();
  const calls = [];
  let upstreamSequence = 0;
  const snapshot = Object.freeze({
    signal: parent.signal,
    checkpoint: Object.freeze({ marker: 'genuine checkpoint reference' }),
    visitSource: jest.fn(),
    dispatch: jest.fn(async (wire) => {
      const request = JSON.parse(wire);
      expect(request.id).toBe(++upstreamSequence);
      expect(['get', 'getMany', 'open', 'next', 'nextMany', 'seek', 'end']).toContain(
        request.method
      );
      calls.push(request);
      return JSON.stringify({ id: request.id, value: null });
    }),
  });
  return { parent, snapshot, calls, family: createRailgunWalletSnapshotStreams(snapshot) };
}
const streamWire = (id, method = 'get') =>
  JSON.stringify({ id, method, args: { key: b64(prefix) } });
const settleTurns = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test('two genuine wallet routers restart local IDs while one snapshot sequence continues', async () => {
  const f = streamFamily(),
    values = [];
  for (let run = 0; run < 2; run++) {
    const expected = Object.freeze({ run });
    expect(
      await f.family.run(async (snapshot) => {
        expect(snapshot.checkpoint).toBe(f.snapshot.checkpoint);
        expect(snapshot.visitSource).toBeUndefined();
        expect(Object.keys(snapshot).sort()).toEqual(['checkpoint', 'dispatch', 'signal']);
        const consumer = createRailgunWalletStorage({
          publicSnapshot: snapshot,
          walletSession: { signal: f.parent.signal },
          walletGrant: { dispatch: jest.fn() },
          walletId: id,
        });
        try {
          for (let local = 1; local <= 2; local++) {
            const reply = JSON.parse(
              await consumer.dispatch(
                JSON.stringify({ id: local, channel: 'public', wire: streamWire(local) })
              )
            );
            expect(reply.id).toBe(local);
            expect(JSON.parse(reply.value)).toEqual({ id: local, value: null });
          }
          consumer.assertIdle();
          values.push(snapshot.signal);
          return expected;
        } finally {
          consumer.close();
        }
      })
    ).toBe(expected);
  }
  expect(f.calls.map((call) => call.id)).toEqual([1, 2, 3, 4]);
  expect(values.every((signal) => signal.aborted)).toBe(true);
  expect(f.parent.signal.aborted).toBe(false);
});

test.each([0, 2, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1])(
  'invalid first local ID %s never reaches the snapshot',
  async (bad) => {
    const f = streamFamily();
    await expect(f.family.run((s) => s.dispatch(streamWire(bad)))).rejects.toThrow();
    expect(f.snapshot.dispatch).not.toHaveBeenCalled();
    await expect(f.family.run(async () => null)).rejects.toThrow();
  }
);
test.each([1, 3])('duplicate/skipped later local ID %s poisons the family', async (bad) => {
  const f = streamFamily();
  await expect(
    f.family.run(async (s) => {
      await s.dispatch(streamWire(1));
      await s.dispatch(streamWire(bad));
    })
  ).rejects.toThrow();
  expect(f.snapshot.dispatch).toHaveBeenCalledTimes(1);
  await expect(f.family.run(async () => null)).rejects.toThrow();
});
test.each(['null', '[]', 'not JSON', 'x'.repeat(2 * 1024 * 1024 + 1)])(
  'malformed or oversized wire refuses before downstream admission %#',
  async (wire) => {
    const f = streamFamily();
    await expect(f.family.run((s) => s.dispatch(wire))).rejects.toThrow();
    expect(f.snapshot.dispatch).not.toHaveBeenCalled();
  }
);
test.each([0, 2, '1', null])(
  'wrong reply ID %s refuses without relabeling acceptance',
  async (id) => {
    const f = streamFamily();
    f.snapshot.dispatch.mockResolvedValue(JSON.stringify({ id, value: null }));
    await expect(f.family.run((s) => s.dispatch(streamWire(1)))).rejects.toThrow();
    await expect(f.family.run(async () => null)).rejects.toThrow();
  }
);
test('out-of-order original reply settlement retains each corresponding local ID', async () => {
  const f = streamFamily(),
    first = deferredStreamValue(),
    second = deferredStreamValue();
  await f.family.run((s) => s.dispatch(streamWire(1)));
  f.snapshot.dispatch
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  const running = f.family.run(async (s) => {
    const one = s.dispatch(streamWire(1)),
      two = s.dispatch(streamWire(2));
    second.resolve(JSON.stringify({ id: 3, value: 'second' }));
    expect(JSON.parse(await two)).toEqual({ id: 2, value: 'second' });
    first.resolve(JSON.stringify({ id: 2, value: 'first' }));
    expect(JSON.parse(await one)).toEqual({ id: 1, value: 'first' });
  });
  await running;
});
test('overlap and synchronous reentry refuse without releasing or aborting the active run', async () => {
  const f = streamFamily(),
    held = deferredStreamValue();
  let active, reentry;
  const original = f.family.run((s) => {
    active = s;
    reentry = f.family.run(async () => {
      throw Error('must not enter');
    });
    reentry.catch(() => {});
    return held.promise;
  });
  await expect(reentry).rejects.toThrow();
  await expect(f.family.run(async () => null)).rejects.toThrow();
  expect(active.signal.aborted).toBe(false);
  const value = { identity: true };
  held.resolve(value);
  expect(await original).toBe(value);
  expect(await f.family.run(async () => value)).toBe(value);
});
test('retained completed dispatcher refuses and cannot affect a later stream', async () => {
  const f = streamFamily();
  let retained;
  await f.family.run(async (s) => {
    retained = s;
    await s.dispatch(streamWire(1));
  });
  await expect(retained.dispatch(streamWire(2))).rejects.toThrow();
  await f.family.run((s) => s.dispatch(streamWire(1)));
  expect(f.calls.map((call) => call.id)).toEqual([1, 2]);
});
test('a caught admitted dispatch rejection still aborts family and refuses success', async () => {
  const f = streamFamily(),
    original = Error('original downstream error');
  f.snapshot.dispatch.mockRejectedValue(original);
  await expect(
    f.family.run(async (s) => {
      await s.dispatch(streamWire(1)).catch(() => {});
      return true;
    })
  ).rejects.toBe(original);
  await expect(f.family.run(async () => null)).rejects.toThrow();
});
test('callback rejection preserves its original identity', async () => {
  const f = streamFamily(),
    original = Error('original callback');
  await expect(
    f.family.run(() => {
      throw original;
    })
  ).rejects.toBe(original);
  await expect(f.family.run(async () => null)).rejects.toThrow();
});
test.each(['fulfill', 'reject'])(
  'early callback %s cannot release pending original storage work',
  async (mode) => {
    const f = streamFamily(),
      held = deferredStreamValue(),
      original = Error('callback');
    f.snapshot.dispatch.mockReturnValue(held.promise);
    let dispatch,
      settled = false,
      stream;
    const running = f.family.run((s) => {
      stream = s;
      dispatch = s.dispatch(streamWire(1));
      dispatch.catch(() => {});
      if (mode === 'reject') throw original;
      return true;
    });
    running.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await settleTurns();
    expect(stream.signal.aborted).toBe(true);
    expect(settled).toBe(false);
    await expect(f.family.run(async () => null)).rejects.toThrow();
    held.resolve(JSON.stringify({ id: 1, value: null }));
    if (mode === 'reject') await expect(running).rejects.toBe(original);
    else await expect(running).rejects.toThrow();
    await expect(dispatch).rejects.toThrow();
    expect(settled).toBe(true);
  }
);
test('parent cancellation waits for original callback and dispatch settlement', async () => {
  const f = streamFamily(),
    held = deferredStreamValue();
  f.snapshot.dispatch.mockReturnValue(held.promise);
  let settled = false,
    stream;
  const running = f.family.run((s) => {
    stream = s;
    return s.dispatch(streamWire(1));
  });
  running.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  f.parent.abort();
  await settleTurns();
  expect(stream.signal.aborted).toBe(true);
  expect(settled).toBe(false);
  held.resolve(JSON.stringify({ id: 1, value: null }));
  await expect(running).rejects.toThrow();
  await expect(f.family.run(async () => null)).rejects.toThrow();
});
test('downstream wallet router namespace restrictions are unchanged', async () => {
  const f = streamFamily();
  await expect(
    f.family.run(async (snapshot) => {
      const consumer = createRailgunWalletStorage({
        publicSnapshot: snapshot,
        walletSession: { signal: f.parent.signal },
        walletGrant: { dispatch: jest.fn() },
        walletId: id,
      });
      try {
        await consumer.dispatch(
          JSON.stringify({
            id: 1,
            channel: 'public',
            wire: JSON.stringify({ id: 1, method: 'get', args: { key: b64(walletPrefix) } }),
          })
        );
      } finally {
        consumer.close();
      }
    })
  ).rejects.toThrow();
  expect(f.snapshot.dispatch).not.toHaveBeenCalled();
});
test('unknown original child closure error takes priority over a caught storage failure', async () => {
  const f = streamFamily();
  const storageError = Error('original storage failure');
  const originalExit = Object.assign(Error('original child exit not observed'), {
    code: 'RAILGUN_WALLET_EXIT_UNOBSERVED',
  });
  f.snapshot.dispatch.mockRejectedValue(storageError);
  await expect(
    f.family.run(async (stream) => {
      await stream.dispatch(streamWire(1)).catch(() => {});
      throw originalExit;
    })
  ).rejects.toBe(originalExit);
  await expect(f.family.run(async () => null)).rejects.toThrow();
});
