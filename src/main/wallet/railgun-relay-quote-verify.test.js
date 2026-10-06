const mock = {};
jest.mock('./railgun-account-enrollment', () => ({
  isRailgunAccountEnrollment: (value) => value === mock.enrollment,
}));
jest.mock('./railgun-engine-runtime', () => ({
  verifyRailgunEngineRuntime: (value) => {
    mock.archive(value);
    return value;
  },
}));
jest.mock('./railgun-process', () => ({ startRailgunProcess: (options) => mock.start(options) }));
const { verifyRailgunRelayQuote } = require('./railgun-relay-quote-verify');
const {
  digest,
  normalizeRailgunRelayQuote,
  EXPECTED_GUARDS,
} = require('./railgun-relay-quote-data');
const pins = require('./railgun-shield-pins.json');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
function setup() {
  const controller = new AbortController(),
    exit = deferred(),
    ready = deferred();
  mock.enrollment = { signal: controller.signal, getContext: jest.fn(() => ({})) };
  mock.archive = jest.fn();
  const closedValue = {
    code: 'RAILGUN_PROCESS_CLOSED',
    exitCode: 15,
    escalated: false,
    peerDisconnected: false,
  };
  const task = {
    closed: exit.promise,
    ready: ready.promise,
    close: jest.fn(() => exit.resolve(closedValue)),
  };
  ready.promise.catch(() => {});
  mock.start = jest.fn((options) => {
    mock.options = options;
    return task;
  });
  const fields = {
    fees: { [pins.wrappedNative]: '0xde0b6b3a7640000' },
    feeExpiration: Date.now() + 240000,
    feesID: 'public',
    railgunAddress: '0zk1' + 'q'.repeat(123),
    identifier: 'public',
    availableWallets: 1,
    version: '8.0.0',
    relayAdapt: pins.relayAdapt,
    requiredPOIListKeys: ['44'.repeat(32)],
    reliability: 0.5,
  };
  const options = {
    enrollment: mock.enrollment,
    archive: '/public/engine.asar',
    signal: controller.signal,
    quote: {
      data: Buffer.from(JSON.stringify(fields)).toString('hex'),
      signature: '03'.repeat(32) + '00'.repeat(32),
    },
    gas: { transactionType: 0, gasEstimate: '84', gasPrice: '1', minGasPrice: '1' },
  };
  const result = () => ({
    id: 1,
    method: 'result',
    value: {
      inputSha256: digest(mock.options.input),
      quoteSha256: normalizeRailgunRelayQuote(options.quote, options.gas).quoteSha256,
      viewingPublicKey: '02'.repeat(32),
      masterPublicKey: '7',
      signatureVerified: true,
      operatorTrusted: false,
      spendingEnabled: false,
      disclosureEnabled: false,
      engineSha256: require('./railgun-engine-manifest.json').sha256,
      guards: structuredClone(EXPECTED_GUARDS),
    },
  });
  return { options, task, exit, ready, closedValue, controller, result };
}
test('genuine owner config is keyless, bounded and result-only; original exit precedes result', async () => {
  const f = setup(),
    pending = verifyRailgunRelayQuote(f.options);
  expect(mock.options).toMatchObject({ binaryKey: false, startupMs: 15000, lifetimeMs: 15000 });
  expect(Object.keys(JSON.parse(mock.options.input)).sort()).toEqual(['archive', 'gas', 'quote']);
  expect(mock.options).not.toHaveProperty('storage');
  expect(mock.options).not.toHaveProperty('createProvider');
  await mock.options.broker.dispatch(JSON.stringify(f.result()));
  f.task.close.mockImplementation(() => {});
  f.ready.resolve();
  let done = false;
  pending.then(() => {
    done = true;
  });
  await Promise.resolve();
  expect(done).toBe(false);
  f.exit.resolve(f.closedValue);
  await expect(pending).resolves.toMatchObject({ signatureVerified: true, operatorTrusted: false });
  expect(f.task.close).toHaveBeenCalledTimes(1);
});
test.each(['key', 'duplicate', 'digest', 'guards', 'authority', 'shape', 'missing'])(
  'broker/ready refusal %s drains',
  async (kind) => {
    const f = setup(),
      pending = verifyRailgunRelayQuote(f.options);
    const message = f.result();
    if (kind === 'key') {
      message.method = 'key';
    }
    if (kind === 'digest') message.value.inputSha256 = '00'.repeat(32);
    if (kind === 'guards') message.value.guards.hooks = ['hook'];
    if (kind === 'authority') message.value.spendingEnabled = true;
    if (kind === 'shape') message.extra = true;
    if (kind === 'duplicate') await mock.options.broker.dispatch(JSON.stringify(message));
    if (kind !== 'missing')
      await mock.options.broker.dispatch(JSON.stringify(message)).catch(() => {});
    f.ready.resolve();
    await expect(pending).rejects.toMatchObject({ code: 'RAILGUN_RELAY_QUOTE_REFUSED' });
    expect(f.task.close).toHaveBeenCalledTimes(1);
  }
);
test('close/abort waits for original child, rejects result and blocks concurrent jobs', async () => {
  const f = setup();
  f.task.close.mockImplementation(() => {});
  const pending = verifyRailgunRelayQuote(f.options);
  await expect(verifyRailgunRelayQuote(f.options)).rejects.toThrow();
  expect(mock.start).toHaveBeenCalledTimes(1);
  f.controller.abort();
  f.ready.reject(Error('aborted'));
  let settled = false;
  pending.catch(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  f.exit.resolve(f.closedValue);
  await expect(pending).rejects.toMatchObject({ code: 'RAILGUN_RELAY_QUOTE_REFUSED' });
});
test.each(['reject', 'malformed'])(
  'unobserved barrier %s quarantines process ownership',
  async (kind) => {
    const f = setup();
    f.task.close.mockImplementation(() => {});
    const pending = verifyRailgunRelayQuote(f.options);
    if (kind === 'reject') f.exit.reject(Error('no observation'));
    else f.exit.resolve({ code: 'closed' });
    f.ready.resolve();
    await expect(pending).rejects.toMatchObject({ code: 'RAILGUN_RELAY_QUOTE_DRAIN_FAILED' });
    await expect(verifyRailgunRelayQuote(f.options)).rejects.toThrow();
    expect(mock.start).toHaveBeenCalledTimes(1);
  }
);
test.each(['escalated', 'peerDisconnected', 'bad-code', 'close-throw'])(
  'observed cleanup problem %s never publishes verification',
  async (kind) => {
    const f = setup();
    if (kind === 'bad-code') f.closedValue.code = 'RAILGUN_PROCESS_TIMEOUT';
    else if (kind === 'close-throw')
      f.task.close.mockImplementation(() => {
        f.exit.resolve(f.closedValue);
        throw Error('cleanup');
      });
    else f.closedValue[kind] = true;
    const pending = verifyRailgunRelayQuote(f.options);
    await mock.options.broker.dispatch(JSON.stringify(f.result()));
    f.ready.resolve();
    await expect(pending).rejects.toMatchObject({ code: 'RAILGUN_RELAY_QUOTE_REFUSED' });
  }
);
test('archive authentication failure prevents process launch', async () => {
  const f = setup();
  mock.archive.mockImplementation(() => {
    throw Error('bad archive');
  });
  await expect(verifyRailgunRelayQuote(f.options)).rejects.toThrow();
  expect(mock.start).not.toHaveBeenCalled();
});
test.each([0, 1, -1])('deliberate-close contract refuses observed exit %s', async (code) => {
  const f = setup();
  f.closedValue.exitCode = code;
  const pending = verifyRailgunRelayQuote(f.options);
  await mock.options.broker.dispatch(JSON.stringify(f.result()));
  f.ready.resolve();
  await expect(pending).rejects.toMatchObject({ code: 'RAILGUN_RELAY_QUOTE_REFUSED' });
});
test('enrollment reentrant abort refuses before process start', async () => {
  const f = setup();
  f.options.enrollment.getContext
    .mockImplementationOnce(() => ({}))
    .mockImplementation(() => {
      f.controller.abort();
      return {};
    });
  await expect(verifyRailgunRelayQuote(f.options)).rejects.toMatchObject({
    code: 'RAILGUN_RELAY_QUOTE_REFUSED',
  });
  expect(mock.start).not.toHaveBeenCalled();
});
