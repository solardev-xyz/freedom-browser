'use strict';

const { createFixtureRelayExchange } = require('./railgun-relay-handoff-model');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function tick() {
  await Promise.resolve();
  await Promise.resolve();
}
function setup(options = {}) {
  const records = options.records || [];
  const owners = { close: jest.fn(), usable: true };
  const permit = Object.freeze({});
  const request = {
    id: 'attempt-a',
    envelope: 'public-fake-envelope',
    context: { peer: 'peer-a', expiry: 100 },
  };
  const key = { label: 'fake-key-a' };
  const send = deferred();
  const stop = deferred();
  stop.resolve();
  let live = true;
  const authority = {
    current: jest.fn(() => live && owners.usable),
    claim: jest.fn(() => permit),
  };
  const journal = {
    begin: jest.fn(async (input) => {
      if (records.some((record) => record.id === input.id)) throw new Error('duplicate attempt');
      records.push({ id: input.id, state: 'uncertain' });
    }),
    acknowledge: jest.fn(async (input, hash) => {
      Object.assign(
        records.find((record) => record.id === input.id),
        { state: 'acknowledged', hash }
      );
    }),
  };
  const transport = { send: jest.fn(() => send.promise), stop: jest.fn(() => stop.promise) };
  const decode = jest.fn(async (ownKey, message) => ({
    authenticated: ownKey.label === message.key,
    valid: message.valid !== false,
    hash: message.hash,
  }));
  const ports = { request, key, authority, journal, transport, decode };
  const create = () => createFixtureRelayExchange(ports);
  return {
    ...ports,
    create,
    send,
    stop,
    records,
    permit,
    owners,
    revoke: () => {
      live = false;
    },
  };
}
const message = (hash = 'fake-hash') => ({ key: 'fake-key-a', hash });

it('claims once synchronously, journals before send, and returns the exact original send promise/value', async () => {
  const h = setup();
  const gate = deferred();
  h.journal.begin.mockImplementation(async () => {
    await gate.promise;
    h.records.push({ id: h.request.id, state: 'uncertain' });
  });
  const e = h.create();
  const admission = e.admit();
  expect(h.authority.claim).toHaveBeenCalledTimes(1);
  expect(() => e.admit()).toThrow('refused');
  expect(h.transport.send).not.toHaveBeenCalled();
  gate.resolve();
  const result = await admission;
  expect(result.send).toBe(h.send.promise);
  expect(h.transport.send).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'attempt-a' }),
    h.permit
  );
  const acknowledgement = Object.freeze({ lightPush: true });
  h.send.resolve(acknowledgement);
  expect(await result.send).toBe(acknowledgement);
  let replied = false;
  result.response.then(() => {
    replied = true;
  });
  await tick();
  expect(replied).toBe(false); // Transport success is not a broadcaster response.
  e.close();
  await e.closed;
  expect(await result.response).toEqual({ status: 'uncertain', reason: 'closed' });
});

it('snapshots nested request, exchange key and incoming message before awaits', async () => {
  const h = setup();
  const begin = deferred();
  const decode = deferred();
  h.journal.begin.mockImplementation(() => begin.promise);
  h.decode.mockImplementation(async (key, value) => {
    await decode.promise;
    return { authenticated: key.label === value.key, valid: true, hash: value.hash };
  });
  const e = h.create();
  const admission = e.admit();
  h.request.context.peer = 'mutated';
  h.key.label = 'mutated';
  begin.resolve();
  await admission;
  expect(h.transport.send.mock.calls[0][0].context.peer).toBe('peer-a');
  expect(Object.isFrozen(h.transport.send.mock.calls[0][0].context)).toBe(true);
  const m = message();
  const received = e.receive(m);
  m.key = 'mutated';
  m.hash = 'mutated';
  h.journal.acknowledge.mockResolvedValue();
  decode.resolve();
  expect(await received).toBe(true);
  expect(h.journal.acknowledge.mock.calls[0][1]).toBe('fake-hash');
  h.send.resolve();
  e.close();
  await e.closed;
});

it.each([false, true])(
  'a journal failure (committed=%s) is uncertain and never retried',
  async (committed) => {
    const h = setup();
    const error = new Error('ambiguous journal error');
    h.journal.begin.mockImplementation(async () => {
      if (committed) h.records.push({ id: h.request.id, state: 'uncertain' });
      throw error;
    });
    const e = h.create();
    await expect(e.admit()).rejects.toBe(error);
    expect(e.inspect()).toMatchObject({ state: 'uncertain', used: true, sendInvoked: false });
    expect(() => e.admit()).toThrow('refused');
    expect(h.transport.send).not.toHaveBeenCalled();
    expect(h.records).toHaveLength(committed ? 1 : 0);
    e.close();
    await e.closed;
  }
);

it.each(['close', 'revoke'])(
  'a %s in the begin-to-send gap keeps the admitted record and sends nothing',
  async (action) => {
    const h = setup();
    const gate = deferred();
    h.journal.begin.mockImplementation(async () => {
      h.records.push({ id: h.request.id, state: 'uncertain' });
      await gate.promise;
    });
    const e = h.create();
    const admission = e.admit();
    if (action === 'close') e.close();
    else h.revoke();
    let drained = false;
    e.closed.then(() => {
      drained = true;
    });
    await tick();
    expect(drained).toBe(false);
    gate.resolve();
    await expect(admission).rejects.toMatchObject({ code: 'FIXTURE_RELAY_REFUSED' });
    expect(h.records).toEqual([{ id: 'attempt-a', state: 'uncertain' }]);
    expect(h.transport.send).not.toHaveBeenCalled();
    e.close();
    await e.closed;
  }
);

it('pre-admission revocation does no journal or send work', async () => {
  const h = setup();
  const e = h.create();
  h.revoke();
  expect(() => e.admit()).toThrow('refused');
  expect(h.journal.begin).not.toHaveBeenCalled();
  expect(h.transport.send).not.toHaveBeenCalled();
  expect(e.inspect().state).toBe('ready');
  e.close();
  await e.closed;
});

it('close retains a held original send through rejection and preserves its exact error', async () => {
  const h = setup();
  const e = h.create();
  const result = await e.admit();
  const error = new Error('transport disconnected');
  let drained = false;
  e.closed.then(() => {
    drained = true;
  });
  e.close();
  expect(await result.response).toEqual({ status: 'uncertain', reason: 'closed' });
  await tick();
  expect(drained).toBe(false);
  const observed = expect(result.send).rejects.toBe(error);
  h.send.reject(error);
  await observed;
  await e.closed;
  expect(h.transport.send).toHaveBeenCalledTimes(1);
  expect(h.owners.close).not.toHaveBeenCalled();
  expect(h.owners.usable).toBe(true);
});

it('synchronous send failure retains an uncertain record and cannot retry', async () => {
  const h = setup();
  const error = new Error('synchronous transport failure');
  h.transport.send.mockImplementation(() => {
    throw error;
  });
  const e = h.create();
  await expect(e.admit()).rejects.toBe(error);
  expect(h.records[0].state).toBe('uncertain');
  expect(() => e.admit()).toThrow('refused');
  expect(h.transport.send).toHaveBeenCalledTimes(1);
  e.close();
  await e.closed;
});

it('two operation-local fake keys cannot cross-settle and duplicate valid replies persist once', async () => {
  const a = setup();
  const b = setup();
  b.key.label = 'fake-key-b';
  b.request.id = 'attempt-b';
  const x = a.create();
  const y = b.create();
  const xr = await x.admit();
  const yr = await y.admit();
  expect(await y.receive(message())).toBe(false);
  expect(b.journal.acknowledge).not.toHaveBeenCalled();
  expect(await x.receive({ key: 'fake-key-b', hash: 'b' })).toBe(false);
  expect(await x.receive(message('a'))).toBe(true);
  expect(await y.receive({ key: 'fake-key-b', hash: 'b' })).toBe(true);
  expect(await x.receive(message('conflict'))).toBe(false);
  expect(await xr.response).toEqual({ status: 'acknowledged', hash: 'a' });
  expect(await yr.response).toEqual({ status: 'acknowledged', hash: 'b' });
  expect(a.journal.acknowledge).toHaveBeenCalledTimes(1);
  expect(b.journal.acknowledge).toHaveBeenCalledTimes(1);
  a.send.resolve();
  b.send.resolve();
  x.close();
  y.close();
  await Promise.all([x.closed, y.closed]);
});

it('malformed authenticated reply consumes the wait, preserves uncertainty, and never resends', async () => {
  const h = setup();
  const e = h.create();
  const result = await e.admit();
  expect(await e.receive({ ...message(), valid: false })).toBe(false);
  expect(await result.response).toEqual({ status: 'uncertain', reason: 'malformed-response' });
  expect(await e.receive(message())).toBe(false);
  expect(h.journal.acknowledge).not.toHaveBeenCalled();
  expect(h.transport.send).toHaveBeenCalledTimes(1);
  h.send.resolve();
  e.close();
  await e.closed;
});

it('close drains a held decode but rejects its late result and all later intake', async () => {
  const h = setup();
  const gate = deferred();
  h.decode.mockReturnValue(gate.promise);
  const e = h.create();
  await e.admit();
  const callback = e.receive(message());
  h.send.resolve();
  e.close();
  let drained = false;
  e.closed.then(() => {
    drained = true;
  });
  await tick();
  expect(drained).toBe(false);
  expect(await e.receive(message())).toBe(false);
  expect(h.decode).toHaveBeenCalledTimes(1);
  gate.resolve({ authenticated: true, valid: true, hash: 'late' });
  expect(await callback).toBe(false);
  await e.closed;
  expect(h.journal.acknowledge).not.toHaveBeenCalled();
});

it('already admitted acknowledgement persistence drains across close without exposing mutable decoded data', async () => {
  const h = setup();
  const ack = deferred();
  const entered = deferred();
  const decoded = { authenticated: true, valid: true, hash: 'first' };
  h.decode.mockResolvedValue(decoded);
  h.journal.acknowledge.mockImplementation(() => {
    entered.resolve();
    return ack.promise;
  });
  const e = h.create();
  const result = await e.admit();
  const callback = e.receive(message());
  await entered.promise;
  decoded.hash = 'changed';
  h.send.resolve();
  e.close();
  let drained = false;
  e.closed.then(() => {
    drained = true;
  });
  await tick();
  expect(drained).toBe(false);
  ack.resolve();
  expect(await callback).toBe(true);
  await e.closed;
  expect(await result.response).toEqual({ status: 'acknowledged', hash: 'first' });
});

it('cleanup failure stays observable and close waits for the original cleanup barrier', async () => {
  const h = setup();
  const stop = deferred();
  h.transport.stop.mockReturnValue(stop.promise);
  const e = h.create();
  e.close();
  e.close();
  let drained = false;
  e.closed.catch(() => {
    drained = true;
  });
  await tick();
  expect(drained).toBe(false);
  const error = new Error('cleanup failure');
  const observed = expect(e.closed).rejects.toBe(error);
  stop.reject(error);
  await observed;
  expect(h.transport.stop).toHaveBeenCalledTimes(1);
});

it.each(['after-begin', 'after-send'])(
  'restart at %s preserves fake history, never rehydrates a permit or resends',
  async (point) => {
    const h = setup();
    const gate = deferred();
    if (point === 'after-begin')
      h.journal.begin.mockImplementation(async () => {
        h.records.push({ id: h.request.id, state: 'uncertain' });
        await gate.promise;
      });
    const e = h.create();
    const admission = e.admit();
    if (point === 'after-send') await admission;
    // Explicit crash simulation: only copied public records survive, not closures/keys.
    const saved = structuredClone(h.records);
    const fresh = setup({ records: saved });
    const recovered = fresh.create();
    await expect(recovered.admit()).rejects.toThrow('duplicate attempt');
    expect(fresh.authority.claim).toHaveBeenCalledTimes(1); // Fresh fake claim, not rehydrated authority.
    expect(fresh.journal.begin).toHaveBeenCalledTimes(1);
    expect(fresh.transport.send).not.toHaveBeenCalled();
    expect(saved).toEqual([{ id: 'attempt-a', state: 'uncertain' }]);
    e.close();
    gate.resolve();
    if (point === 'after-begin') await expect(admission).rejects.toThrow('refused');
    h.send.resolve();
    recovered.close();
    await Promise.all([e.closed, recovered.closed]);
  }
);

it('registers retained admission before a journal port can synchronously close it', async () => {
  const h = setup();
  const gate = deferred();
  let e;
  h.journal.begin.mockImplementation(() => {
    e.close();
    return gate.promise;
  });
  e = h.create();
  const admission = e.admit();
  let drained = false;
  e.closed.then(() => {
    drained = true;
  });
  await tick();
  expect(drained).toBe(false);
  gate.resolve();
  await expect(admission).rejects.toThrow('refused');
  await e.closed;
  expect(h.transport.send).not.toHaveBeenCalled();
});

it('close before admission refuses synchronously without consulting a journal', async () => {
  const h = setup();
  const e = h.create();
  e.close();
  expect(() => e.admit()).toThrow('refused');
  expect(h.journal.begin).not.toHaveBeenCalled();
  expect(h.authority.claim).not.toHaveBeenCalled();
  await e.closed;
});

it('a refusing fake authority cannot begin storage or send', async () => {
  const h = setup();
  const error = new Error('fake authority refused');
  h.authority.claim.mockImplementation(() => {
    throw error;
  });
  const e = h.create();
  expect(() => e.admit()).toThrow(error);
  expect(h.journal.begin).not.toHaveBeenCalled();
  expect(h.transport.send).not.toHaveBeenCalled();
  e.close();
  await e.closed;
});

it.each(['decode', 'acknowledge'])(
  'original %s callback failure drains and does not retry',
  async (port) => {
    const h = setup();
    const error = new Error('fake callback failure');
    if (port === 'decode') h.decode.mockRejectedValue(error);
    else h.journal.acknowledge.mockRejectedValue(error);
    const e = h.create();
    const result = await e.admit();
    await expect(e.receive(message())).rejects.toBe(error);
    expect((await result.response).status).toBe('uncertain');
    expect(await e.receive(message())).toBe(false);
    h.send.resolve();
    e.close();
    await e.closed;
    expect(h.transport.send).toHaveBeenCalledTimes(1);
  }
);

it('latches before current can reenter admission', async () => {
  const h = setup();
  let e;
  h.authority.current.mockImplementationOnce(() => {
    expect(() => e.admit()).toThrow('refused');
    return true;
  });
  e = h.create();
  await e.admit();
  expect(h.authority.claim).toHaveBeenCalledTimes(1);
  expect(h.journal.begin).toHaveBeenCalledTimes(1);
  expect(h.transport.send).toHaveBeenCalledTimes(1);
  h.send.resolve();
  e.close();
  await e.closed;
});

it('latches before claim can reenter admission', async () => {
  const h = setup();
  let e;
  h.authority.claim.mockImplementationOnce(() => {
    expect(() => e.admit()).toThrow('refused');
    return h.permit;
  });
  e = h.create();
  await e.admit();
  expect(h.authority.claim).toHaveBeenCalledTimes(1);
  expect(h.journal.begin).toHaveBeenCalledTimes(1);
  expect(h.transport.send).toHaveBeenCalledTimes(1);
  h.send.resolve();
  e.close();
  await e.closed;
});

it('claim-triggered close refuses before journal begin or send', async () => {
  const h = setup();
  let e;
  h.authority.claim.mockImplementationOnce(() => {
    e.close();
    return h.permit;
  });
  e = h.create();
  expect(() => e.admit()).toThrow('refused');
  expect(e.inspect()).toMatchObject({ used: true, state: 'ready', sendInvoked: false });
  expect(h.journal.begin).not.toHaveBeenCalled();
  expect(h.transport.send).not.toHaveBeenCalled();
  expect(() => e.admit()).toThrow('refused');
  await e.closed;
});

it('post-begin current-triggered close returning true refuses send with an uncertain record', async () => {
  const h = setup();
  let e;
  h.authority.current
    .mockReturnValueOnce(true)
    .mockReturnValueOnce(true)
    .mockImplementationOnce(() => {
      e.close();
      return true;
    });
  e = h.create();
  await expect(e.admit()).rejects.toThrow('refused');
  expect(h.authority.current).toHaveBeenCalledTimes(3);
  expect(h.transport.send).not.toHaveBeenCalled();
  expect(h.records).toEqual([{ id: 'attempt-a', state: 'uncertain' }]);
  await e.closed;
});

it('initial current-triggered close returning true refuses claim and begin', async () => {
  const h = setup();
  let e;
  h.authority.current.mockImplementationOnce(() => {
    e.close();
    return true;
  });
  e = h.create();
  expect(() => e.admit()).toThrow('refused');
  expect(h.authority.claim).not.toHaveBeenCalled();
  expect(h.journal.begin).not.toHaveBeenCalled();
  expect(h.transport.send).not.toHaveBeenCalled();
  await e.closed;
});

it('failed initial current consumes the model even if the fake owner later becomes current', async () => {
  const h = setup();
  h.authority.current.mockReturnValueOnce(false);
  const e = h.create();
  expect(() => e.admit()).toThrow('refused');
  expect(() => e.admit()).toThrow('refused');
  expect(h.authority.current).toHaveBeenCalledTimes(1);
  expect(h.authority.claim).not.toHaveBeenCalled();
  expect(h.journal.begin).not.toHaveBeenCalled();
  e.close();
  await e.closed;
});

it('send rejection consumes the response wait and deliberately drops a later valid reply', async () => {
  const h = setup();
  const e = h.create();
  const result = await e.admit();
  const error = new Error('send failed');
  const rejected = expect(result.send).rejects.toBe(error);
  h.send.reject(error);
  await rejected;
  expect(await result.response).toEqual({ status: 'uncertain', reason: 'send-error' });
  expect(await e.receive(message())).toBe(false);
  expect(h.decode).not.toHaveBeenCalled();
  expect(h.journal.acknowledge).not.toHaveBeenCalled();
  expect(h.transport.send).toHaveBeenCalledTimes(1);
  e.close();
  await e.closed;
});

it('malformed send promise refuses without invoking a thenable or stranding close', async () => {
  const h = setup();
  const then = jest.fn();
  h.transport.send.mockReturnValue({ then });
  const e = h.create();
  await expect(e.admit()).rejects.toBeInstanceOf(TypeError);
  expect(then).not.toHaveBeenCalled();
  expect(h.records[0].state).toBe('uncertain');
  expect(() => e.admit()).toThrow('refused');
  e.close();
  await e.closed;
});

it('internally observes cleanup rejection while preserving the original rejecting closed promise', () => {
  const { spawnSync } = require('node:child_process');
  const fixture = require.resolve('./railgun-relay-handoff-model');
  const source = `
    const assert = require('node:assert/strict');
    const { createFixtureRelayExchange } = require(${JSON.stringify(fixture)});
    const error = new Error('synthetic cleanup rejection');
    const exchange = createFixtureRelayExchange({
      request: {}, key: {}, authority: {}, journal: {}, decode: null,
      transport: { stop: () => Promise.reject(error) },
    });
    const original = exchange.closed;
    exchange.close();
    setImmediate(async () => {
      assert.equal(exchange.closed, original);
      await assert.rejects(original, value => value === error);
      process.stdout.write('original rejection retained');
    });
  `;
  const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '-e', source], {
    encoding: 'utf8',
    timeout: 5000,
  });
  expect(child.error).toBeUndefined();
  expect(child.signal).toBeNull();
  expect(child.status).toBe(0);
  expect(child.stdout).toBe('original rejection retained');
  expect(child.stderr).toBe('');
});
