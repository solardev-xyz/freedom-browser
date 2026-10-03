let mockMode, mockTask, mockExit, mockDeferExit;
jest.mock('./railgun-prover-runtime', () => ({ verifyRailgunProverRuntime: (v) => v }));
jest.mock('./railgun-process', () => ({
  startRailgunProcess: jest.fn((options) => {
    let finish, reject;
    const closed = new Promise((resolve) => {
      finish = resolve;
    });
    mockExit = () =>
      finish({ code: mockMode === 'crash' ? 'RAILGUN_PROCESS_FAILED' : 'RAILGUN_PROCESS_CLOSED' });
    mockTask = {
      closed,
      close: jest.fn(() => {
        if (!mockDeferExit) mockExit();
        reject?.(Error('closed'));
      }),
    };
    const wait = new Promise((_resolve, r) => {
      reject = r;
    });
    wait.catch(() => {});
    options.broker.signal.addEventListener('abort', () => mockTask.close(), { once: true });
    mockTask.ready = Promise.resolve().then(async () => {
      if (mockMode === 'hang') return wait;
      const input = JSON.parse(options.input);
      const value = {
        inputSha256: require('crypto').createHash('sha256').update(options.input).digest('hex'),
        payloadSha256: require('crypto')
          .createHash('sha256')
          .update(JSON.stringify(input.payload))
          .digest('hex'),
        proofVerified: true,
        sourceAuthenticated: false,
        membershipAuthenticated: false,
        rootAccepted: false,
        disclosureEnabled: false,
        spendingEnabled: false,
        guards: { attempts: 0, canaries: 1, hooks: ['test.guard'] },
        proverSha256: require('./railgun-prover-manifest.json').sha256,
      };
      if (mockMode === 'digest') value.inputSha256 = '0'.repeat(64);
      if (mockMode === 'pin') value.proverSha256 = '0'.repeat(64);
      if (mockMode === 'authority') value.disclosureEnabled = true;
      if (mockMode === 'guards') value.guards.attempts = 1;
      if (mockMode === 'proof') value.proofVerified = false;
      if (mockMode === 'payload') value.payloadSha256 = '0'.repeat(64);
      if (mockMode === 'extra') value.extra = true;
      const wire = JSON.stringify({
        id: 1,
        method: ['key', 'input', 'get', 'provider'].includes(mockMode) ? mockMode : 'result',
        value,
      });
      if (mockMode === 'missing') return;
      await options.broker.dispatch(wire);
      if (mockMode === 'duplicate') await options.broker.dispatch(wire);
    });
    return mockTask;
  }),
}));
const { createPrivacyScope } = require('../networks/privacy-context');
const { verifyRailgunPoiPayload } = require('./railgun-poi-verifier');
const { startRailgunProcess } = require('./railgun-process');
const { REQUIRED_LIST } = require('./railgun-poi-records');
const hex = (n) => '0x' + n.toString(16).padStart(64, '0');
function payload(unshield = false) {
  return {
    listKey: REQUIRED_LIST,
    proof: {
      pi_a: ['1', '2'],
      pi_b: [
        ['3', '4'],
        ['5', '6'],
      ],
      pi_c: ['7', '8'],
    },
    poiMerkleroots: [hex(3n).slice(2)],
    txidMerkleroot: hex(4n).slice(2),
    txidMerklerootIndex: 6,
    blindedCommitmentsOut: unshield ? [] : [hex(5n)],
    railgunTxidIfHasUnshield: unshield ? hex(6n) : '0x00',
  };
}
let scope, controller, input;
beforeEach(async () => {
  jest.clearAllMocks();
  mockMode = 'valid';
  mockDeferExit = false;
  scope = createPrivacyScope({
    profileId: 'detached-fixture',
    signal: new AbortController().signal,
  });
  controller = new AbortController();
  input = {
    handle: scope.getContext({
      kind: 'private-account',
      protocol: 'railgun',
      deployment: 'sepolia',
      chainId: 11155111,
      principal: 'test-account',
      role: 'prover',
      operation: 'poi-verify',
    }),
    proverArchive: '/test/prover.asar',
    artifactDirectory: '/test/artifacts',
    payload: payload(),
    signal: controller.signal,
  };
});

afterEach(() => {
  controller.abort();
  scope.close();
  jest.useRealTimers();
});
test('returns only immutable diagnostic evidence after exit, with no key/storage/provider channel', async () => {
  const result = await verifyRailgunPoiPayload(input);
  expect(result).toMatchObject({
    proofVerified: true,
    utilityExitObserved: true,
    spendingEnabled: false,
    sourceAuthenticated: false,
    rootAccepted: false,
    metadataAuthenticated: false,
  });
  expect(Object.isFrozen(result)).toBe(true);
  expect(result.membershipAuthenticated).toBe(false);
  expect(mockTask.close).toHaveBeenCalled();
  const options = startRailgunProcess.mock.calls[0][0];
  for (const field of ['binaryKey', 'storage', 'createProvider'])
    expect(options[field]).toBeUndefined();
  expect(Object.keys(JSON.parse(options.input)).sort()).toEqual([
    'artifactDirectory',
    'payload',
    'proverArchive',
  ]);
});
test.each([
  'key',
  'input',
  'get',
  'provider',
  'digest',
  'pin',
  'authority',
  'guards',
  'proof',
  'payload',
  'extra',
  'missing',
  'duplicate',
  'crash',
])('refuses %s without leaving a utility alive', async (mode) => {
  mockMode = mode;
  await expect(verifyRailgunPoiPayload(input)).rejects.toMatchObject({
    code: 'RAILGUN_POI_VERIFICATION_REFUSED',
  });
  expect(mockTask.close).toHaveBeenCalled();
});
test.each(['timeout', 'caller', 'parent'])(
  'drains observed exit after %s revocation',
  async (mode) => {
    jest.useFakeTimers();
    mockMode = 'hang';
    mockDeferExit = true;
    let settled = false;
    const pending = verifyRailgunPoiPayload({ ...input, timeoutMs: 20 });
    const outcome = pending.catch((error) => {
      settled = true;
      return error;
    });
    await Promise.resolve();
    if (mode === 'timeout') await jest.advanceTimersByTimeAsync(21);
    if (mode === 'caller') controller.abort();
    if (mode === 'parent') scope.close();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockTask.close).toHaveBeenCalled();
    expect(settled).toBe(false);
    mockExit();
    expect(await outcome).toMatchObject({ code: 'RAILGUN_POI_VERIFICATION_REFUSED' });
  }
);
test('refuses malformed payload, wrong role and oversized input before starting', async () => {
  await expect(
    verifyRailgunPoiPayload({ ...input, payload: { ...input.payload, extra: true } })
  ).rejects.toThrow();
  await expect(
    verifyRailgunPoiPayload({ ...input, artifactDirectory: '/' + 'x'.repeat(32768) })
  ).rejects.toThrow();
  const handle = scope.getContext({
    kind: 'private-account',
    principal: 'test-account',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'engine',
    operation: 'poi-verify',
  });
  await expect(verifyRailgunPoiPayload({ ...input, handle })).rejects.toThrow();
  expect(startRailgunProcess).not.toHaveBeenCalled();
});
test('snapshots caller payload before the asynchronous job', async () => {
  const pending = verifyRailgunPoiPayload(input);
  input.payload.txidMerklerootIndex++;
  const result = await pending;
  const snapshot = JSON.parse(startRailgunProcess.mock.calls[0][0].input).payload;
  expect(snapshot.txidMerklerootIndex).toBe(6);
  expect(result.payloadSha256).toBe(
    require('crypto').createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
  );
});
test.each(['caller', 'parent', 'deadline'])(
  'refuses %s revocation after result before delayed exit',
  async (mode) => {
    mockDeferExit = true;
    let now = 10;
    const clock = jest.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      let settled = false;
      const outcome = verifyRailgunPoiPayload({ ...input, timeoutMs: 1000 }).catch((e) => {
        settled = true;
        return e;
      });
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(mockTask.close).toHaveBeenCalled();
      expect(settled).toBe(false);
      if (mode === 'caller') controller.abort();
      if (mode === 'parent') scope.close();
      if (mode === 'deadline') now = 1011;
      mockExit();
      expect(await outcome).toMatchObject({ code: 'RAILGUN_POI_VERIFICATION_REFUSED' });
    } finally {
      clock.mockRestore();
    }
  }
);
