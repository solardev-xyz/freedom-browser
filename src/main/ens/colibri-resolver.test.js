const mockLogInfo = jest.fn();
const mockLogWarn = jest.fn();
jest.mock('../logger', () => ({
  info: (...args) => mockLogInfo(...args),
  warn: (...args) => mockLogWarn(...args),
  error: jest.fn(),
  debug: jest.fn(),
}));

// Colibri runs in freedom-colibrid, behind colibri-service.js (freedom-core
// design 0014). This suite covers the main-process client lifecycle above
// it, so the service is replaced by in-process fake clients; the service has
// its own suites, and its contract runs on the real binary in
// colibri-service-contract.test.js.
// Mock-prefixed names so Jest's "out-of-scope variable" guard permits them
// in the factories (a factory runs before top-level `const` initializers).
// Every client's `request` goes through `mockRequest(client, ...)`, so a
// test scripts answers across rebuilds and sees which client asked. Once a
// test sets the service's `real`, that module itself answers in the fake's
// place.
const mockCreateClient = jest.fn();
const mockEnsureWorker = jest.fn(() => Promise.resolve());
const mockRequest = jest.fn();
const mockClientInstances = [];
/** The service's own calls. */
const mockService = {
  createClient: jest.fn(),
  ensureWorker: jest.fn(),
  endPrivateSession: jest.fn(),
  stopAll: jest.fn(() => Promise.resolve()),
  real: null,
};
jest.mock('./colibri-service', () => {
  const fake = {
    ensureWorker: (...args) => {
      mockService.ensureWorker(...args);
      return mockEnsureWorker(...args);
    },
    endPrivateSession: (...args) => mockService.endPrivateSession(...args),
    stopAll: (...args) => mockService.stopAll(...args),
    createClient: (config) => {
      mockService.createClient(config);
      mockCreateClient(config);
      const client = { config, destroy: jest.fn() };
      client.request = jest.fn((...args) => mockRequest(client, ...args));
      mockClientInstances.push(client);
      return client;
    },
  };
  const current = () => mockService.real ?? fake;
  return {
    ensureWorker: (...args) => current().ensureWorker(...args),
    endPrivateSession: (...args) => current().endPrivateSession(...args),
    stopAll: (...args) => current().stopAll(...args),
    createClient: (config) => current().createClient(config),
  };
});
// colibri-service.js reads whether the build is packaged from here.
jest.mock('electron', () => ({ app: { isPackaged: false } }));

// The registry is mocked; tests still pump a legacy-shaped object via
// mockLoadSettings and the mock translates the two fields this module
// reads (prover URL, zkProof) into the registry shape.
const mockLoadSettings = jest.fn();
jest.mock('../networks/network-registry', () => ({
  getNetwork: () => ({ zkProof: (mockLoadSettings() || {}).ensColibriZkProof !== false }),
  getEndpoints: (_chainId, role) =>
    role === 'prover'
      // Empty setting → the builtin prover (stand-in for colibri-corpus).
      ? [((mockLoadSettings() || {}).ensColibriProverUrl || 'https://test-prover.example').trim()]
      : [],
}));

// Only hostOf is imported. Re-exporting the whole ens-resolver here would
// pull every ENS dependency into the test.
jest.mock('../ens-resolver', () => ({
  hostOf: (url) => { try { return new URL(url).host; } catch { return url; } },
}));

const colibriResolver = require('./colibri-resolver');
const {
  requestViaColibri,
  endPrivateColibriSession,
  registerColibriPrivateCleanup,
  clearColibriClientForTest,
} = colibriResolver;
const {
  runWithPrivateLogContext,
  openPrivateSession,
  endPrivateSession,
} = require('../private/private-log-context');

const DEFAULTS = {
  ensColibriProverUrl: '',
  ensColibriZkProof: true,
};

beforeEach(() => {
  clearColibriClientForTest();
  jest.clearAllMocks();
  mockClientInstances.length = 0;
  mockLoadSettings.mockReturnValue({ ...DEFAULTS });
  mockRequest.mockResolvedValue('0x2a');
});

// Colibri 3.0.3 runs an `eth_call` on contract code from a public RPC,
// unchecked against the proven code hash, and proves nothing for a call
// that reads no storage. So it serves no ENS, reverse or NameNFT lookup
// (#1076): the module has no adapter for one. The private session's two
// exports (#1058) only end it.
test('offers chain-data requests only, with no name-resolution adapter', () => {
  expect(Object.keys(colibriResolver).sort()).toEqual([
    'clearColibriClientForTest',
    'endPrivateColibriSession',
    'registerColibriPrivateCleanup',
    'requestViaColibri',
    'stopColibri',
  ]);
});

// The client lifecycle is the resolver's own.
describe('the client lifecycle', () => {
  /** The service's own end of the private session. */
  const mockEndPrivateSession = mockService.endPrivateSession;

  describe('the Colibri client', () => {
    const BLOCK = ['eth_blockNumber', []];
    const asked = (client, method = 'eth_blockNumber', params = []) => [
      client,
      { method, params },
      { deadlineMs: undefined },
    ];

    test('constructs the client lazily with the configured prover', async () => {
      expect(mockCreateClient).not.toHaveBeenCalled();
      await requestViaColibri(1, ...BLOCK);
      expect(mockCreateClient).toHaveBeenCalledTimes(1);
      expect(mockCreateClient).toHaveBeenCalledWith({
        chainId: 1,
        proverUrl: 'https://test-prover.example',
        zkProof: true,
      });
    });

    // The client first, so the service knows the lane's settings when it
    // readies the lane (a native lane stopped under other ones starts again).
    test("creates the first client, then uses it only once the chain's process is ready", async () => {
      let releaseWorker;
      mockEnsureWorker.mockImplementationOnce(() => new Promise((resolve) => { releaseWorker = resolve; }));
      const pending = requestViaColibri(1, ...BLOCK);
      await Promise.resolve();
      expect(mockCreateClient).toHaveBeenCalledTimes(1);
      expect(mockEnsureWorker).toHaveBeenCalledWith(1);
      expect(mockCreateClient.mock.invocationCallOrder[0])
        .toBeLessThan(mockEnsureWorker.mock.invocationCallOrder[0]);
      expect(mockRequest).not.toHaveBeenCalled();
      releaseWorker();
      await expect(pending).resolves.toBe('0x2a');
      expect(mockRequest).toHaveBeenCalledWith(...asked(mockClientInstances[0]));
    });

    test("fails the request when the chain's process cannot start, destroying the client", async () => {
      mockEnsureWorker.mockRejectedValueOnce(new Error('Colibri worker failed to start: boom'));
      await expect(requestViaColibri(1, ...BLOCK)).rejects.toThrow(/failed to start/);
      expect(mockClientInstances).toHaveLength(1);
      expect(mockClientInstances[0].destroy).toHaveBeenCalledTimes(1);
      expect(mockClientInstances[0].request).not.toHaveBeenCalled();
      await expect(requestViaColibri(1, ...BLOCK)).resolves.toBe('0x2a');
      expect(mockClientInstances).toHaveLength(2);
      expect(mockClientInstances[1].destroy).not.toHaveBeenCalled();
    });

    test('reuses the singleton across calls when settings are unchanged', async () => {
      await requestViaColibri(1, ...BLOCK);
      await requestViaColibri(1, 'eth_getBalance', ['0xabc', 'latest']);
      expect(mockCreateClient).toHaveBeenCalledTimes(1);
      expect(mockRequest).toHaveBeenCalledWith(
        ...asked(mockClientInstances[0], 'eth_getBalance', ['0xabc', 'latest'])
      );
    });

    test('concurrent first calls collapse onto one construction', async () => {
      const results = await Promise.all([
        requestViaColibri(1, ...BLOCK),
        requestViaColibri(1, ...BLOCK),
        requestViaColibri(1, ...BLOCK),
      ]);
      expect(mockCreateClient).toHaveBeenCalledTimes(1);
      expect(results).toEqual(['0x2a', '0x2a', '0x2a']);
    });

    test('rebuilds the client when the prover URL changes', async () => {
      await requestViaColibri(1, ...BLOCK);
      const firstClient = mockClientInstances[0];
      mockLoadSettings.mockReturnValue({
        ...DEFAULTS,
        ensColibriProverUrl: 'https://other-prover.example',
      });
      await requestViaColibri(1, ...BLOCK);
      expect(mockCreateClient).toHaveBeenCalledTimes(2);
      expect(mockCreateClient.mock.calls[1][0].proverUrl).toBe('https://other-prover.example');
      expect(firstClient.destroy).toHaveBeenCalledTimes(1);
      expect(mockClientInstances[1].destroy).not.toHaveBeenCalled();
    });

    test('rebuilds the client when zk_proof toggles', async () => {
      await requestViaColibri(1, ...BLOCK);
      mockLoadSettings.mockReturnValue({ ...DEFAULTS, ensColibriZkProof: false });
      await requestViaColibri(1, ...BLOCK);
      expect(mockCreateClient).toHaveBeenCalledTimes(2);
      expect(mockCreateClient.mock.calls[1][0].zkProof).toBe(false);
    });

    test('does not let an obsolete in-flight build replace newer settings', async () => {
      let releaseWorker;
      mockEnsureWorker.mockImplementationOnce(() => new Promise((resolve) => { releaseWorker = resolve; }));

      const first = requestViaColibri(1, 'eth_getBalance', ['0x01', 'latest']);
      mockLoadSettings.mockReturnValue({
        ...DEFAULTS,
        ensColibriProverUrl: 'https://new-prover.example',
      });
      const second = requestViaColibri(1, 'eth_getBalance', ['0x02', 'latest']);

      releaseWorker();
      await Promise.all([first, second]);

      expect(mockCreateClient).toHaveBeenCalledTimes(2);
      const byProver = (url) => mockClientInstances.find((c) => c.config.proverUrl === url);
      const oldClient = byProver('https://test-prover.example');
      const newClient = byProver('https://new-prover.example');
      expect(oldClient.destroy).toHaveBeenCalledTimes(1);
      expect(newClient.destroy).not.toHaveBeenCalled();
      expect(mockRequest).toHaveBeenCalledWith(...asked(newClient, 'eth_getBalance', ['0x01', 'latest']));
      expect(mockRequest).toHaveBeenCalledWith(...asked(newClient, 'eth_getBalance', ['0x02', 'latest']));
      expect(oldClient.request).not.toHaveBeenCalled();
    });

    test('respects a custom prover URL from settings', async () => {
      mockLoadSettings.mockReturnValue({
        ...DEFAULTS,
        ensColibriProverUrl: 'https://custom.example/keyXYZ',
      });
      await requestViaColibri(1, ...BLOCK);
      expect(mockCreateClient.mock.calls[0][0].proverUrl).toBe('https://custom.example/keyXYZ');
    });

    test('propagates errors from the client (e.g. verification failure)', async () => {
      const err = new Error('proof verification failed');
      mockRequest.mockRejectedValue(err);
      await expect(requestViaColibri(1, ...BLOCK)).rejects.toBe(err);
      expect(mockCreateClient).toHaveBeenCalledTimes(1);
    });

    test('rebuilds once and retries a CALL_EXCEPTION without revert data', async () => {
      const err = Object.assign(new Error('full ethers message with 0x' + 'ab'.repeat(200)), {
        code: 'CALL_EXCEPTION',
        shortMessage: 'missing revert data',
        info: { error: { code: -32603, message: 'prover returned no response' } },
      });
      mockRequest.mockRejectedValueOnce(err).mockResolvedValueOnce('0xfeed');

      await expect(requestViaColibri(1, ...BLOCK)).resolves.toBe('0xfeed');

      expect(mockRequest).toHaveBeenCalledTimes(2);
      expect(mockCreateClient).toHaveBeenCalledTimes(2);
      expect(mockClientInstances[0].destroy).toHaveBeenCalledTimes(1);
      expect(mockLogWarn).toHaveBeenCalledWith(
        '[colibri] chain 1 request failed; rebuilding client and retrying once ' +
        'error="missing revert data" code=CALL_EXCEPTION rpcCode=-32603 ' +
        'rpcMessage="prover returned no response" revert=none'
      );
    });

    test('bounds a retryable failure to one rebuild', async () => {
      const err = Object.assign(new Error('request timed out'), { code: 'TIMEOUT' });
      mockRequest.mockRejectedValue(err);

      await expect(requestViaColibri(1, ...BLOCK)).rejects.toBe(err);

      expect(mockRequest).toHaveBeenCalledTimes(2);
      expect(mockCreateClient).toHaveBeenCalledTimes(2);
    });

    test('does not destroy a failed shared client while a sibling request still uses it', async () => {
      let rejectFirst;
      let resolveSibling;
      mockRequest
        .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }))
        .mockImplementationOnce(() => new Promise((resolve) => { resolveSibling = resolve; }))
        .mockResolvedValueOnce('0xrecovered');

      const first = requestViaColibri(1, ...BLOCK);
      const sibling = requestViaColibri(1, ...BLOCK);
      while (mockRequest.mock.calls.length < 2) await Promise.resolve();
      const sharedClient = mockClientInstances[0];

      rejectFirst(Object.assign(new Error('network unavailable'), { code: 'NETWORK_ERROR' }));
      await expect(first).resolves.toBe('0xrecovered');
      expect(sharedClient.destroy).not.toHaveBeenCalled();

      resolveSibling('0xsibling');
      await expect(sibling).resolves.toBe('0xsibling');
      expect(sharedClient.destroy).toHaveBeenCalledTimes(1);
    });

    test('does not retry an EVM revert carrying verified revert data', async () => {
      const err = Object.assign(new Error('execution reverted'), {
        code: 'CALL_EXCEPTION',
        data: '0xdeadbeef',
      });
      mockRequest.mockRejectedValue(err);

      await expect(requestViaColibri(1, ...BLOCK)).rejects.toBe(err);

      expect(mockRequest).toHaveBeenCalledTimes(1);
      expect(mockCreateClient).toHaveBeenCalledTimes(1);
    });
  });

  describe('requestViaColibri', () => {
    test('creates and reuses an independent Gnosis client', async () => {
      mockLoadSettings.mockReturnValue({ ...DEFAULTS });
      await expect(
        requestViaColibri(100, 'eth_getBalance', ['0xabc', 'latest'])
      ).resolves.toBe('0x2a');
      const gnosisClient = mockClientInstances[0];
      expect(mockCreateClient).toHaveBeenCalledWith(expect.objectContaining({ chainId: 100 }));
      expect(gnosisClient.request).toHaveBeenCalledWith({
        method: 'eth_getBalance',
        params: ['0xabc', 'latest'],
      }, { deadlineMs: undefined });

      await requestViaColibri(1, 'eth_blockNumber');
      expect(mockCreateClient).toHaveBeenCalledTimes(2);
    });

    test('hands the caller deadline to the client', async () => {
      await requestViaColibri(100, 'eth_call', [{}, 'latest'], { deadlineMs: 2000 });
      expect(mockClientInstances[0].request).toHaveBeenCalledWith(
        { method: 'eth_call', params: [{}, 'latest'] },
        { deadlineMs: 2000 },
      );
    });

    test('rebuilds the affected chain client once after a network failure', async () => {
      await requestViaColibri(100, 'eth_blockNumber');
      const firstClient = mockClientInstances[0];
      firstClient.request
        .mockRejectedValueOnce(Object.assign(new Error('network unavailable'), {
          code: 'NETWORK_ERROR',
        }));

      await expect(requestViaColibri(100, 'eth_blockNumber')).resolves.toBe('0x2a');

      expect(firstClient.destroy).toHaveBeenCalledTimes(1);
      expect(mockCreateClient).toHaveBeenCalledTimes(2);
      expect(mockClientInstances[1].request).toHaveBeenCalledTimes(1);
    });
  });

  // PRIVATE MODE GUARD (Colibri store, #1058): a read in a private window's
  // async context runs on the chain's private process, whose store is in memory
  // only; every other read keeps the normal, disk-backed lane.
  describe('private windows', () => {
    const inPrivate = (fn) => runWithPrivateLogContext(true, fn);
    // A private window is open for each test; the last one closing ends the
    // session in private-log-context first, then runs the cleanup hook.
    const closeLastPrivateWindow = () => {
      endPrivateSession();
      endPrivateColibriSession();
    };
    beforeEach(() => openPrivateSession());
    afterEach(() => endPrivateSession());
    const NORMAL = { chainId: 1, proverUrl: 'https://test-prover.example', zkProof: true };
    const PRIVATE = { ...NORMAL, private: true };
    const lanes = () => mockCreateClient.mock.calls.map(([config]) => config);

    // Chain data is Colibri's only caller: names don't use it (#1076).
    test.each([
      ['a balance read', () => requestViaColibri(1, 'eth_getBalance', ['0xabc', 'latest'])],
      ['a code read', () => requestViaColibri(1, 'eth_getCode', ['0xabc', 'latest'])],
    ])('%s from a private window runs on the private process', async (_label, read) => {
      await inPrivate(read);
      expect(lanes()).toEqual([PRIVATE]);
      expect(mockEnsureWorker).toHaveBeenCalledWith(1, { private: true });
      expect(mockEnsureWorker).not.toHaveBeenCalledWith(1);
    });

    test.each([
      ['a balance read', () => requestViaColibri(1, 'eth_getBalance', ['0xabc', 'latest'])],
      ['a code read', () => requestViaColibri(1, 'eth_getCode', ['0xabc', 'latest'])],
    ])('%s from a normal window keeps the normal process, as before', async (_label, read) => {
      await read();
      expect(lanes()).toEqual([NORMAL]);
      expect(mockEnsureWorker.mock.calls).toEqual([[1]]);
    });

    test('the two lanes keep separate clients side by side', async () => {
      await requestViaColibri(1, 'eth_blockNumber');
      await inPrivate(() => requestViaColibri(1, 'eth_blockNumber'));
      await requestViaColibri(1, 'eth_blockNumber');
      await inPrivate(() => requestViaColibri(1, 'eth_blockNumber'));
      expect(lanes()).toEqual([NORMAL, PRIVATE]);
      const [normal, priv] = mockClientInstances;
      expect(normal.request).toHaveBeenCalledTimes(2);
      expect(priv.request).toHaveBeenCalledTimes(2);
      expect(normal.destroy).not.toHaveBeenCalled();
      expect(priv.destroy).not.toHaveBeenCalled();
    });

    test('a retry after a transient failure stays on the private lane', async () => {
      await inPrivate(() => requestViaColibri(1, 'eth_blockNumber'));
      mockClientInstances[0].request.mockRejectedValueOnce(new Error('fetch failed'));
      await expect(inPrivate(() => requestViaColibri(1, 'eth_blockNumber'))).resolves.toBe('0x2a');
      expect(lanes()).toEqual([PRIVATE, PRIVATE]);
    });

    test('ending the private session drops the private clients only', async () => {
      await requestViaColibri(1, 'eth_blockNumber');
      await inPrivate(() => requestViaColibri(1, 'eth_blockNumber'));
      await inPrivate(() => requestViaColibri(100, 'eth_blockNumber'));
      const [normal, priv, privGnosis] = mockClientInstances;

      closeLastPrivateWindow();
      openPrivateSession();

      expect(mockEndPrivateSession).toHaveBeenCalledTimes(1);
      expect(priv.destroy).toHaveBeenCalledTimes(1);
      expect(privGnosis.destroy).toHaveBeenCalledTimes(1);
      expect(normal.destroy).not.toHaveBeenCalled();

      // The normal lane keeps its client; the next private read builds anew.
      await requestViaColibri(1, 'eth_blockNumber');
      await inPrivate(() => requestViaColibri(1, 'eth_blockNumber'));
      expect(mockClientInstances).toHaveLength(4);
      expect(mockCreateClient.mock.calls[3][0]).toEqual(PRIVATE);
      expect(normal.request).toHaveBeenCalledTimes(2);
    });

    test('a private client still in use when the session ends is destroyed once released', async () => {
      let release;
      await inPrivate(() => requestViaColibri(1, 'eth_blockNumber'));
      const [priv] = mockClientInstances;
      priv.request.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
      const pending = inPrivate(() => requestViaColibri(1, 'eth_blockNumber'));
      await Promise.resolve();
      await Promise.resolve();

      closeLastPrivateWindow();
      expect(priv.destroy).not.toHaveBeenCalled();
      release('0x1');
      await expect(pending).resolves.toBe('0x1');
      expect(priv.destroy).toHaveBeenCalledTimes(1);
    });

    test('a private build in flight when the session ends is discarded, with no rebuild', async () => {
      let releaseWorker;
      mockEnsureWorker.mockImplementationOnce(() => new Promise((resolve) => { releaseWorker = resolve; }));
      const pending = inPrivate(() => requestViaColibri(1, 'eth_blockNumber'));
      pending.catch(() => {});
      await Promise.resolve();

      closeLastPrivateWindow();
      releaseWorker();

      // The client built for the ended session is destroyed at once, and the
      // request is refused rather than rebuilt for the next session.
      await expect(pending).rejects.toMatchObject({
        message: 'Colibri private session ended',
        colibriBystander: true,
      });
      expect(lanes()).toEqual([PRIVATE]);
      expect(mockClientInstances[0].destroy).toHaveBeenCalledTimes(1);
      expect(mockEnsureWorker).toHaveBeenCalledTimes(1);
    });

    // Codex review of #1070, finding 2: a read can wait on Myotis or the
    // network before it reaches Colibri, so a private one can still be waiting
    // when its last window closes.
    test('a private read whose session ended before it reached Colibri starts nothing', async () => {
      let releaseMyotis;
      const myotis = new Promise((resolve) => { releaseMyotis = resolve; });
      const pending = inPrivate(async () => {
        await myotis;
        return requestViaColibri(1, 'eth_getBalance', ['0xabc', 'latest']);
      });
      pending.catch(() => {});

      closeLastPrivateWindow();
      openPrivateSession(); // the next private window, before the read resumes
      releaseMyotis();

      await expect(pending).rejects.toMatchObject({
        message: 'Colibri private session ended',
        colibriBystander: true,
      });
      expect(mockEnsureWorker).not.toHaveBeenCalled();
      expect(mockCreateClient).not.toHaveBeenCalled();
      // The new session's own reads are served.
      await expect(inPrivate(() => requestViaColibri(1, 'eth_blockNumber'))).resolves.toBe('0x2a');
      expect(lanes()).toEqual([PRIVATE]);
    });

    test('a private read entered with no private window open starts nothing', async () => {
      endPrivateSession();
      await expect(inPrivate(() => requestViaColibri(1, 'eth_blockNumber'))).rejects.toMatchObject({
        message: 'Colibri private session ended',
      });
      expect(mockEnsureWorker).not.toHaveBeenCalled();
      // A normal read is unaffected.
      await expect(requestViaColibri(1, 'eth_blockNumber')).resolves.toBe('0x2a');
    });

    test('a retry after the session ended is refused too', async () => {
      await inPrivate(() => requestViaColibri(1, 'eth_blockNumber'));
      mockClientInstances[0].request.mockImplementationOnce(async () => {
        closeLastPrivateWindow();
        throw new Error('fetch failed');
      });
      await expect(inPrivate(() => requestViaColibri(1, 'eth_blockNumber'))).rejects.toMatchObject({
        message: 'Colibri private session ended',
      });
      expect(lanes()).toEqual([PRIVATE]);
    });

    test('the cleanup hook ends the session only once the last private window has closed', () => {
      let hook;
      let open = 2;
      registerColibriPrivateCleanup({
        registerPrivateCleanup: (fn) => { hook = fn; },
        getPrivateWindowCount: () => open,
      });
      open = 1;
      hook('private-a');
      expect(mockEndPrivateSession).not.toHaveBeenCalled();
      open = 0;
      hook('private-b');
      expect(mockEndPrivateSession).toHaveBeenCalledTimes(1);
    });
  });
});

// What the resolver asks of the service, and what it logs.
describe('the service', () => {
  const CONFIG = { chainId: 1, proverUrl: 'https://test-prover.example', zkProof: true };

  test('serves a read: its lane readied, its client created, the deadline passed', async () => {
    await expect(requestViaColibri(1, 'eth_blockNumber', [], { deadlineMs: 2000 })).resolves.toBe(
      '0x2a'
    );
    expect(mockService.ensureWorker).toHaveBeenCalledWith(1);
    expect(mockService.createClient).toHaveBeenCalledWith(CONFIG);
    expect(mockClientInstances[0].request).toHaveBeenCalledWith(
      { method: 'eth_blockNumber', params: [] },
      { deadlineMs: 2000 }
    );
    expect(mockLogInfo).toHaveBeenCalledWith(
      '[colibri] chain 1 client ready (prover=test-prover.example, zk=true)'
    );
  });

  test("the private lane, the session's end and the quit", async () => {
    openPrivateSession();
    try {
      await runWithPrivateLogContext(true, () => requestViaColibri(1, 'eth_blockNumber'));
      expect(mockService.ensureWorker).toHaveBeenCalledWith(1, { private: true });
      expect(mockService.createClient).toHaveBeenCalledWith({ ...CONFIG, private: true });
    } finally {
      endPrivateSession();
    }
    endPrivateColibriSession();
    expect(mockService.endPrivateSession).toHaveBeenCalledTimes(1);
    expect(mockClientInstances[0].destroy).toHaveBeenCalledTimes(1);
    await colibriResolver.stopColibri();
    expect(mockService.stopAll).toHaveBeenCalledTimes(1);
  });
});

// The resolver over the service itself (colibri-service.js) and fake
// freedom-colibrid children (test/helpers/fake-colibrid.js): a lane the
// service stopped starts again once a build brings other settings, and
// stays stopped under the same ones.
describe('over the service itself', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { fakeColibrid } = require('../../../test/helpers/fake-colibrid');
  const UNAVAILABLE = 'Colibri service unavailable';
  let tmp;
  let fake;
  let priority;

  const tick = () => new Promise((resolve) => setImmediate(resolve));
  async function untilWarned(text) {
    for (let i = 0; i < 2000; i += 1) {
      if (mockLogWarn.mock.calls.some(([line]) => String(line).includes(text))) return;
      await tick();
    }
    throw new Error(`timed out waiting for "${text}"`);
  }

  beforeEach(async () => {
    // Never a real process's: the fake children's PIDs may be anyone's.
    priority = jest.spyOn(os, 'setPriority').mockImplementation(() => {});
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-colibri-resolver-'));
    fake = fakeColibrid({
      request: (message, child) => setImmediate(() => child.serve(message, { result: '0x10' })),
    });
    mockService.real = jest.requireActual('./colibri-service');
    await mockService.real.resetForTest({
      storageDir: path.join(tmp, 'colibri'),
      spawn: fake.spawn,
      command: '/bin/freedom-colibrid',
      lockDir: path.join(tmp, 'locks'),
      serviceVersion: '0.1.1',
      parentPid: 4242,
      shellVersion: '9.9.9',
      checkGrant: () => null,
    });
  });

  afterEach(async () => {
    clearColibriClientForTest();
    await mockService.real.resetForTest();
    mockService.real = null;
    priority.mockRestore();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const read = () => requestViaColibri(1, 'eth_blockNumber');

  test('a lane stopped by a terminal exit starts again on a build under another prover or ZK', async () => {
    await expect(read()).resolves.toBe('0x10');
    expect(fake.children).toHaveLength(1);

    // Exit 64 stops the lane. Under the same settings it stays stopped:
    // the cached client, and a build of its own.
    fake.children[0].exit(64);
    await untilWarned('chain 1 stopped (exit 64)');
    await expect(read()).rejects.toThrow(UNAVAILABLE);
    clearColibriClientForTest();
    await expect(read()).rejects.toThrow(UNAVAILABLE);
    expect(fake.children).toHaveLength(1);

    // Another prover: the next build starts the lane again.
    mockLoadSettings.mockReturnValue({
      ...DEFAULTS,
      ensColibriProverUrl: 'https://other-prover.example',
    });
    await expect(read()).resolves.toBe('0x10');
    expect(fake.children).toHaveLength(2);

    // Stopped again (exit 74), and ZK turned off: started again.
    fake.children[1].exit(74);
    await untilWarned('chain 1 stopped (exit 74)');
    await expect(read()).rejects.toThrow(UNAVAILABLE);
    expect(fake.children).toHaveLength(2);
    mockLoadSettings.mockReturnValue({
      ...DEFAULTS,
      ensColibriProverUrl: 'https://other-prover.example',
      ensColibriZkProof: false,
    });
    await expect(read()).resolves.toBe('0x10');
    expect(fake.children).toHaveLength(3);
    expect(fake.children[2].sent('colibri.request')[0].params.zk).toBe(false);
  });
});
