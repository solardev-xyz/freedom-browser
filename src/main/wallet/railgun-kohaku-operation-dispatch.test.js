const {
  dispatchRailgunKohakuPreparedOperation: dispatch,
} = require('./railgun-kohaku-operation-dispatch');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture() {
  const order = [],
    token = Object.freeze({ __type: 'privateOperation' }),
    result = Object.freeze({ status: 'submitted' }),
    refusal = Error('admission refused');
  let available = true;
  const ports = {
    claim: jest.fn((candidate) => {
      if (!available || candidate !== token) throw Error('not a registry claim');
      available = false;
      order.push('claim');
    }),
    invoke: jest.fn(() => {
      order.push('invoke');
      return result;
    }),
    onRejected: jest.fn((error) => {
      order.push('rejected');
      throw error;
    }),
    finish: jest.fn(() => order.push('finish')),
    retain: jest.fn(() => order.push('retain')),
    outward: jest.fn((pending) => {
      order.push('outward');
      return pending;
    }),
    refused: jest.fn(() => refusal),
  };
  return { ports, order, token, result, refusal };
}
// Ports here are controlled sequencing doubles, not ownership/receipt issuers.
test('claim consumes synchronously, invocation is deferred and result/outward identities survive', async () => {
  const { ports, order, token, result, refusal } = fixture();
  const first = dispatch(ports, token),
    repeated = dispatch(ports, token);
  expect(order).toEqual(['claim', 'retain', 'outward']);
  expect(ports.invoke).not.toHaveBeenCalled();
  expect(first).toBe(ports.retain.mock.calls[0][0]);
  expect(first).toBe(ports.outward.mock.calls[0][0]);
  expect(ports.claim.mock.calls[0][0]).toBe(token);
  repeated.catch(() => {});
  await Promise.resolve();
  expect(ports.invoke).toHaveBeenCalledTimes(1);
  expect(ports.finish).not.toHaveBeenCalled();
  await expect(repeated).rejects.toBe(refusal);
  await expect(first).resolves.toBe(result);
  expect(order).toEqual(['claim', 'retain', 'outward', 'invoke', 'finish']);
  expect(ports.invoke).toHaveBeenCalledTimes(1);
  expect(ports.finish).toHaveBeenCalledTimes(1);
});
test('failed claim has no invocation, retention, outward or finish and leaves real token usable', async () => {
  const { ports, token, result, refusal } = fixture();
  await expect(dispatch(ports, { ...token })).rejects.toBe(refusal);
  for (const name of ['invoke', 'retain', 'outward', 'finish', 'onRejected'])
    expect(ports[name]).not.toHaveBeenCalled();
  await expect(dispatch(ports, token)).resolves.toBe(result);
});
test.each(['resolve', 'reject'])(
  'outward cancellation does not replace retained original %s or allow early cleanup',
  async (settlement) => {
    const { ports, token, result, order } = fixture(),
      original = deferred(),
      outward = deferred(),
      failure = Error('original rejection');
    ports.invoke.mockImplementation(() => original.promise);
    ports.outward.mockReturnValue(outward.promise);
    const received = dispatch(ports, token),
      retained = ports.retain.mock.calls[0][0];
    retained.catch(() => {});
    expect(received).toBe(outward.promise);
    expect(retained).not.toBe(received);
    let drained = false;
    retained.finally(() => (drained = true)).catch(() => {});
    outward.resolve({ status: 'recovery-required' });
    await received;
    await tick();
    expect(drained).toBe(false);
    expect(ports.finish).not.toHaveBeenCalled();
    if (settlement === 'resolve') {
      original.resolve(result);
      await expect(retained).resolves.toBe(result);
    } else {
      original.reject(failure);
      await expect(retained).rejects.toBe(failure);
      expect(ports.onRejected).toHaveBeenCalledWith(failure);
    }
    expect(order.at(-1)).toBe('finish');
    expect(drained).toBe(true);
  }
);
test.each(['fulfilled-recovery', 'original-error'])(
  'delegates %s rejection policy without coercing the lane',
  async (policy) => {
    const { ports, token, order } = fixture(),
      error = Object.assign(Error('uncertain'), { code: 'PRIVATE_BROADCAST_UNCERTAIN' }),
      recovery = Object.freeze({ status: 'recovery-required', stage: 'kohaku' });
    ports.invoke.mockRejectedValue(error);
    if (policy === 'fulfilled-recovery') ports.onRejected.mockReturnValue(recovery);
    const pending = dispatch(ports, token);
    if (policy === 'fulfilled-recovery') await expect(pending).resolves.toBe(recovery);
    else await expect(pending).rejects.toBe(error);
    expect(ports.onRejected).toHaveBeenCalledWith(error);
    expect(order.at(-1)).toBe('finish');
    expect(ports.refused).not.toHaveBeenCalled();
  }
);
test('cleanup exception remains the original failure and is not converted into admission refusal', async () => {
  const { ports, token } = fixture(),
    error = Error('cleanup');
  ports.finish.mockImplementation(() => {
    throw error;
  });
  await expect(dispatch(ports, token)).rejects.toBe(error);
  expect(ports.onRejected).not.toHaveBeenCalled();
  expect(ports.refused).not.toHaveBeenCalled();
});
test('no post-result claim or currency check overwrites an acknowledged durable outcome', async () => {
  const { ports, token, result } = fixture();
  ports.invoke.mockImplementation(() => {
    ports.claim.mockImplementation(() => {
      throw Error('expired after durable acknowledgement');
    });
    return result;
  });
  await expect(dispatch(ports, token)).resolves.toBe(result);
  expect(ports.claim).toHaveBeenCalledTimes(1);
});
