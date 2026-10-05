// Host lifecycle with a controlled utility. No genuine crypto/store claim.
jest.mock('./railgun-native-assertions', () => ({
  assert: require('assert/strict'),
  assertEmpty: jest.fn(),
}));
jest.mock('../../src/main/networks/privacy-context', () => ({
  getPrivacyContext: jest.fn(),
  createPrivacyScope: jest.fn(),
}));
jest.mock('../../src/main/wallet/railgun-process', () => ({ startRailgunProcess: jest.fn() }));
const { project } = require('./railgun-combined-poi-terminal-ingest');
const context = require('../../src/main/networks/privacy-context');
const processModule = require('../../src/main/wallet/railgun-process');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
let h, options, task, exit, ready, scope, caller, result;
beforeEach(() => {
  jest.clearAllMocks();
  caller = new AbortController();
  scope = new AbortController();
  h = {
    enrollment: { getContext: () => ({}) },
    archive: '/mock',
    signal: caller.signal,
    row: { nullifiers: [hex(1)] },
    history: { rows: [{ commitments: [hex(2)] }], checkpoints: [{ count: 1 }] },
  };
  result = {
    rows: [...h.history.rows, { ...h.row, verificationHash: hex(8) }],
    checkpoints: [...h.history.checkpoints, { count: 2 }],
    state: { count: 2 },
    guards: { attempts: 0, canaries: 1, hooks: ['mock'] },
  };
  exit = deferred();
  ready = deferred();
  task = { ready: ready.promise, closed: exit.promise, close: jest.fn() };
  context.getPrivacyContext.mockReturnValue({
    profileId: 'p',
    subject: { kind: 'private-account' },
    signal: caller.signal,
  });
  context.createPrivacyScope.mockReturnValue({
    signal: scope.signal,
    getContext: () => ({}),
    close: jest.fn(() => scope.abort()),
  });
  processModule.startRailgunProcess.mockImplementation((value) => {
    options = value;
    return task;
  });
});
const send = (value) => options.broker.dispatch(JSON.stringify({ id: 1, method: 'result', value }));
const normal = () =>
  exit.resolve({
    code: 'RAILGUN_PROCESS_CLOSED',
    exitCode: 15,
    escalated: false,
    peerDisconnected: false,
  });
test('result is withheld through actual closed barrier, including normal nonzero exit code', async () => {
  let settled = false;
  const work = project(h).finally(() => {
    settled = true;
  });
  await send(result);
  ready.resolve();
  await new Promise(setImmediate);
  expect(task.close).toHaveBeenCalledTimes(1);
  expect(settled).toBe(false);
  normal();
  expect(await work).toEqual(result);
  expect(context.createPrivacyScope.mock.results[0].value.close).toHaveBeenCalled();
});
test('caller abort during held child close cannot return result or abandon drain', async () => {
  let settled = false;
  const work = project(h).finally(() => {
    settled = true;
  });
  const rejected = expect(work).rejects.toThrow();
  await send(result);
  ready.resolve();
  await Promise.resolve();
  caller.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  normal();
  await rejected;
});
test('ready rejection still closes and awaits exit before refusal', async () => {
  let settled = false;
  const work = project(h).finally(() => {
    settled = true;
  });
  const refused = expect(work).rejects.toThrow('bad');
  ready.reject(Error('bad'));
  await Promise.resolve();
  expect(task.close).toHaveBeenCalled();
  expect(settled).toBe(false);
  normal();
  await refused;
});
test('throwing close cannot skip awaited closed', async () => {
  let settled = false;
  task.close.mockImplementation(() => {
    throw Error('close');
  });
  const work = project(h).finally(() => {
    settled = true;
  });
  const refused = expect(work).rejects.toThrow('close');
  await send(result);
  ready.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  normal();
  await refused;
});
test.each(['bad-id', 'copied-prefix', 'rewritten-transcript', 'duplicate-result'])(
  'sticky %s refusal cannot be rescued by ready',
  async (mode) => {
    const work = project(h);
    const refused = expect(work).rejects.toThrow();
    if (mode === 'duplicate-result') await send(result);
    const changed = JSON.parse(JSON.stringify(result));
    if (mode === 'copied-prefix') changed.rows[0].commitments = [hex(99)];
    if (mode === 'rewritten-transcript') changed.checkpoints[0].transcript = 'new';
    await expect(
      mode === 'bad-id'
        ? options.broker.dispatch(JSON.stringify({ id: 2, method: 'result', value: changed }))
        : send(changed)
    ).rejects.toThrow();
    expect(scope.signal.aborted).toBe(true);
    await expect(send(result)).rejects.toThrow();
    ready.resolve();
    normal();
    await refused;
  }
);
test.each([
  { code: 'RAILGUN_SESSION_REVOKED' },
  { escalated: true },
  { peerDisconnected: true },
  { exitCode: null },
])('invalid exit %p cannot publish', async (override) => {
  const work = project(h);
  const refused = expect(work).rejects.toThrow();
  await send(result);
  ready.resolve();
  exit.resolve({
    code: 'RAILGUN_PROCESS_CLOSED',
    exitCode: 0,
    escalated: false,
    peerDisconnected: false,
    ...override,
  });
  await refused;
});
