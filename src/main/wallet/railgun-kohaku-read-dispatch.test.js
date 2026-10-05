/** Port doubles exercise sequencing only; they do not issue genuine owners. */
const { dispatchRailgunKohakuRead: dispatch } = require('./railgun-kohaku-read-dispatch');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function fixture(value = []) {
  const events = [],
    captured = { account: {}, view: {} },
    refusal = Object.assign(Error('sanitized'), { code: 'REFUSED' });
  const invoke = jest.fn(function (..._args) {
    events.push('invoke');
    expect(this).toBe(captured.view);
    return value;
  });
  for (const method of ['instanceId', 'balance', 'notes']) captured.view[method] = invoke;
  const ports = {
    capture: jest.fn(() => {
      events.push('capture');
      return captured;
    }),
    recheck: jest.fn((input) => {
      events.push('recheck');
      expect(input).toBe(captured);
    }),
    retain: jest.fn((work) => {
      events.push('retain');
      return work;
    }),
    refused: jest.fn(() => {
      events.push('refused');
      return refusal;
    }),
  };
  return { events, captured, refusal, invoke, ports };
}
test.each(['instanceId', 'balance', 'notes'])(
  '%s preserves receiver, argument references, retained promise and original value',
  async (method) => {
    const result = Object.freeze([]),
      s = fixture(result),
      filters = [],
      args = [filters, true];
    const pending = dispatch(s.ports, method, args);
    expect(pending).toBe(s.ports.retain.mock.calls[0][0]);
    expect(s.events).toEqual(['capture', 'invoke', 'retain']);
    expect(s.invoke.mock.calls[0][0]).toBe(filters);
    expect(s.invoke.mock.calls[0][1]).toBe(true);
    expect(await pending).toBe(result);
    expect(s.events).toEqual(['capture', 'invoke', 'retain', 'recheck']);
    expect(s.invoke).toHaveBeenCalledTimes(1);
    expect(s.ports.capture).toHaveBeenCalledTimes(1);
    expect(s.ports.recheck).toHaveBeenCalledTimes(1);
    expect(s.ports.refused).not.toHaveBeenCalled();
  }
);
test('held work is retained immediately and rechecked only after original settlement', async () => {
  const gate = deferred(),
    s = fixture(gate.promise);
  const pending = dispatch(s.ports, 'notes', []);
  let finished = false;
  pending.then(() => {
    finished = true;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  expect(s.ports.retain).toHaveBeenCalledTimes(1);
  expect(s.ports.recheck).not.toHaveBeenCalled();
  const result = [];
  gate.resolve(result);
  expect(await pending).toBe(result);
  expect(s.events).toEqual(['capture', 'invoke', 'retain', 'recheck']);
});
test('post-settlement revoked capture refuses original value without retry', async () => {
  const gate = deferred(),
    s = fixture(gate.promise);
  const pending = dispatch(s.ports, 'notes', []);
  s.ports.recheck.mockImplementation(() => {
    throw Error('private owner detail');
  });
  gate.resolve({ sensitive: true });
  await expect(pending).rejects.toBe(s.refusal);
  expect(s.invoke).toHaveBeenCalledTimes(1);
  expect(s.ports.refused).toHaveBeenCalledTimes(1);
});
test.each(['capture', 'lookup', 'invoke', 'iterator', 'rejection'])(
  '%s failure is an asynchronous sanitized refusal with original work tracking rules',
  async (step) => {
    const gate = deferred(),
      s = fixture(gate.promise),
      secret = Error('private detail');
    let args = [];
    if (step === 'capture')
      s.ports.capture.mockImplementation(() => {
        throw secret;
      });
    if (step === 'lookup')
      Object.defineProperty(s.captured.view, 'notes', {
        get() {
          throw secret;
        },
      });
    if (step === 'invoke')
      s.invoke.mockImplementation(() => {
        throw secret;
      });
    if (step === 'iterator')
      args = {
        [Symbol.iterator]() {
          throw secret;
        },
      };
    let pending;
    expect(() => {
      pending = dispatch(s.ports, 'notes', args);
    }).not.toThrow();
    expect(pending).toBeInstanceOf(Promise);
    if (step === 'rejection') gate.reject(secret);
    await expect(pending).rejects.toBe(s.refusal);
    expect(s.ports.retain).toHaveBeenCalledTimes(step === 'rejection' ? 1 : 0);
    expect(s.ports.recheck).not.toHaveBeenCalled();
    expect(s.ports.refused).toHaveBeenCalledTimes(1);
  }
);
test('method getter and argument iteration retain original evaluation order', async () => {
  const s = fixture([]);
  Object.defineProperty(s.captured.view, 'notes', {
    get() {
      s.events.push('lookup');
      return s.invoke;
    },
  });
  const args = {
    *[Symbol.iterator]() {
      s.events.push('iterate');
      yield undefined;
    },
  };
  await dispatch(s.ports, 'notes', args);
  expect(s.events).toEqual(['capture', 'lookup', 'iterate', 'invoke', 'retain', 'recheck']);
});
test.each(['close', 'status', 'prepareTransfer', 'submit', '__proto__', undefined])(
  'unknown internal method %s cannot turn the seam into an arbitrary view call',
  async (method) => {
    const s = fixture();
    await expect(dispatch(s.ports, method, [])).rejects.toBe(s.refusal);
    expect(s.ports.capture).not.toHaveBeenCalled();
    expect(s.invoke).not.toHaveBeenCalled();
    expect(s.ports.retain).not.toHaveBeenCalled();
  }
);
