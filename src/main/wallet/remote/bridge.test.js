/**
 * The bridge is main's only path to the renderer session broker; these
 * tests fake electron's window/IPC surface and drive both directions:
 * job publication (webContents.send) and response settlement (ipcMain.on).
 * `requestRemoteSignature` is main's own relay, kept for the account check
 * (./account-proof.js); `requestPhoneJob` relays the identity core's jobs,
 * with the core's phone methods mocked.
 */

const mockWebContents = {
  id: 7,
  isDestroyed: jest.fn(() => false),
  send: jest.fn(),
};
const mockWindow = { webContents: mockWebContents };

let mockFocusedWindow = mockWindow;
let mockAllWindows = [mockWindow];
// BrowserWindow.fromId's windows, by id.
const mockWindowsById = new Map();
const mockIpcMainHandlers = {};

jest.mock('electron', () => ({
  ipcMain: {
    on: (channel, handler) => {
      mockIpcMainHandlers[channel] = handler;
    },
    handle: (channel, handler) => {
      mockIpcMainHandlers[channel] = handler;
    },
  },
  BrowserWindow: {
    getFocusedWindow: () => mockFocusedWindow,
    getAllWindows: () => mockAllWindows,
    fromId: (id) => mockWindowsById.get(id) ?? null,
  },
}));

// The identity core's phone methods (design 0012, PHN-2), which the bridge
// reaches through vault-backend: `phone.job`, `phone.sent`, `phone.result`.
const mockPhone = { job: jest.fn(), sent: jest.fn(), result: jest.fn() };
jest.mock('../../core/vault-backend', () => ({ vaultBackend: { phone: mockPhone } }));

const { requestPhoneJob, requestRemoteSignature, registerRemoteSignerIpc } = require('./bridge');

registerRemoteSignerIpc();
const respond = (senderId, payload) =>
  mockIpcMainHandlers['remote-signer:response']({ sender: { id: senderId } }, payload);
const requestSent = (senderId, jobId) =>
  mockIpcMainHandlers['remote-signer:request-sent']({ sender: { id: senderId } }, { jobId });

const JOB = { walletIndex: 3, address: '0xabc', method: 'personal_sign', params: ['0x68690a', '0xabc'] };

/** The jobId assigned to the most recently published job. */
function sentJobId() {
  const calls = mockWebContents.send.mock.calls.filter(([ch]) => ch === 'remote-signer:request');
  return calls[calls.length - 1][1].jobId;
}

beforeEach(() => {
  mockWebContents.send.mockClear();
  mockWebContents.isDestroyed.mockReturnValue(false);
  mockFocusedWindow = mockWindow;
  mockAllWindows = [mockWindow];
  mockPhone.job.mockReset();
  mockPhone.sent.mockReset();
  mockPhone.result.mockReset();
});

describe('delivery, for callers journaling a send', () => {
  const { isRemoteSendProvablyUnsent } = require('./errors');
  const SEND = { ...JOB, method: 'eth_sendTransaction', params: [{ to: '0xdef' }] };

  test('a refusal of the delivered payment proves nothing was sent', async () => {
    const promise = requestRemoteSignature(SEND);
    const jobId = sentJobId();
    requestSent(7, jobId);
    respond(7, { jobId, attempt: 1, error: { rpcCode: 4001, message: 'no' } });
    const err = await promise.catch((e) => e);
    expect(err).toMatchObject({
      code: 'REMOTE_USER_REJECTED',
      requestDelivered: true,
      otherAttemptDelivered: false,
    });
    expect(isRemoteSendProvablyUnsent(err)).toBe(true);
  });

  test("a refusal before the request went (the chain switch) is proof", async () => {
    const promise = requestRemoteSignature(SEND);
    const jobId = sentJobId();
    respond(7, { jobId, attempt: 1, error: { rpcCode: 4001, message: 'no' } });
    const err = await promise.catch((e) => e);
    expect(err).toMatchObject({ code: 'REMOTE_USER_REJECTED', requestDelivered: false });
    expect(isRemoteSendProvablyUnsent(err)).toBe(true);
  });

  test("a delivered payment's lost answer is no proof", async () => {
    jest.useFakeTimers();
    try {
      const promise = requestRemoteSignature(SEND, 1000);
      requestSent(7, sentJobId());
      jest.advanceTimersByTime(1001);
      const err = await promise.catch((e) => e);
      expect(err).toMatchObject({ code: 'REMOTE_OUTCOME_UNKNOWN', requestDelivered: true });
      expect(isRemoteSendProvablyUnsent(err)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a refusal of a request that is not a payment counts another attempt as delivered', async () => {
    // Such a request may get a new code after it went, so another attempt
    // may have reached the phone: fail closed.
    const promise = requestRemoteSignature(JOB);
    const jobId = sentJobId();
    requestSent(7, jobId);
    respond(7, { jobId, error: { rpcCode: 4001, message: 'no' } });
    const err = await promise.catch((e) => e);
    expect(err).toMatchObject({ requestDelivered: true, otherAttemptDelivered: true });
    expect(isRemoteSendProvablyUnsent(err)).toBe(false);
  });
});

describe('requestRemoteSignature', () => {
  test('publishes the job to the renderer and resolves with its result', async () => {
    const promise = requestRemoteSignature(JOB);

    expect(mockWebContents.send).toHaveBeenCalledWith(
      'remote-signer:request',
      expect.objectContaining({ ...JOB, jobId: expect.any(String) }),
    );

    respond(7, { jobId: sentJobId(), result: '0xsignature' });
    await expect(promise).resolves.toBe('0xsignature');
  });

  test('rejects with the renderer-reported error code and message', async () => {
    const promise = requestRemoteSignature(JOB);
    respond(7, { jobId: sentJobId(), error: { code: 'REMOTE_USER_CANCELLED' } });
    await expect(promise).rejects.toMatchObject({ code: 'REMOTE_USER_CANCELLED' });
  });

  test('maps phone JSON-RPC errors (EIP-1193) to REMOTE_* codes', async () => {
    const promise = requestRemoteSignature(JOB);
    respond(7, { jobId: sentJobId(), error: { rpcCode: 4001, message: 'User denied.' } });
    await expect(promise).rejects.toMatchObject({ code: 'REMOTE_USER_REJECTED' });
  });

  test('falls back to the first window when none is focused', async () => {
    mockFocusedWindow = null;
    const promise = requestRemoteSignature(JOB);
    respond(7, { jobId: sentJobId(), result: 'ok' });
    await expect(promise).resolves.toBe('ok');
  });

  test('rejects with REMOTE_NO_UI when no window exists', async () => {
    mockFocusedWindow = null;
    mockAllWindows = [];
    await expect(requestRemoteSignature(JOB)).rejects.toMatchObject({ code: 'REMOTE_NO_UI' });
  });

  test('ignores responses from a webContents the job was not sent to', async () => {
    const promise = requestRemoteSignature(JOB);
    const jobId = sentJobId();

    // A dApp webview must not be able to answer signing jobs.
    respond(999, { jobId, result: '0xforged' });

    respond(7, { jobId, result: '0xreal' });
    await expect(promise).resolves.toBe('0xreal');
  });

  test('ignores responses for unknown or already-settled jobs', async () => {
    expect(() => respond(7, { jobId: 'no-such-job', result: 'x' })).not.toThrow();
    expect(() => respond(7, undefined)).not.toThrow();
  });

  test('records on each rejection whether the request reached the phone', async () => {
    jest.useFakeTimers();
    try {
      const undelivered = requestRemoteSignature(JOB, 1000);
      // A handshake from another webContents does not count.
      requestSent(99, sentJobId());
      jest.advanceTimersByTime(1001);
      await expect(undelivered).rejects.toMatchObject({ code: 'REMOTE_TIMEOUT', requestDelivered: false });

      const late = requestRemoteSignature(JOB, 1000);
      requestSent(7, sentJobId());
      jest.advanceTimersByTime(1001);
      await expect(late).rejects.toMatchObject({ code: 'REMOTE_TIMEOUT', requestDelivered: true });

      const cancelled = requestRemoteSignature(JOB, 1000);
      const jobId = sentJobId();
      requestSent(7, jobId);
      respond(7, { jobId, error: { code: 'REMOTE_USER_CANCELLED' } });
      await expect(cancelled).rejects.toMatchObject({ code: 'REMOTE_USER_CANCELLED', requestDelivered: true });
    } finally {
      jest.useRealTimers();
    }
  });

  test('a missing window rejects as undelivered', async () => {
    mockFocusedWindow = null;
    mockAllWindows = [];
    await expect(requestRemoteSignature(JOB)).rejects.toMatchObject({ code: 'REMOTE_NO_UI', requestDelivered: false });
  });

  test('times out with REMOTE_TIMEOUT and tells the renderer to abort', async () => {
    jest.useFakeTimers();
    try {
      const promise = requestRemoteSignature(JOB, 1000);
      const jobId = sentJobId();

      jest.advanceTimersByTime(1001);
      await expect(promise).rejects.toMatchObject({ code: 'REMOTE_TIMEOUT' });
      expect(mockWebContents.send).toHaveBeenCalledWith('remote-signer:abort', { jobId });

      // A late renderer response for the dead job is ignored.
      expect(() => respond(7, { jobId, result: '0xlate' })).not.toThrow();
    } finally {
      jest.useRealTimers();
    }
  });
});

// A phone signs and broadcasts a payment itself: once its request reached
// the phone, a lost answer leaves the payment possibly sent (design 0005,
// "Retrying an intent"), so it is unknown, never a failure to try again.
describe('a payment whose request reached the phone', () => {
  const PAYMENT = {
    walletIndex: 3,
    address: '0xabc',
    method: 'eth_sendTransaction',
    params: [{ from: '0xabc', to: '0xdef', value: '0x1', chainId: '0x64' }],
  };

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("main's timeout is an unknown outcome, and the renderer is told to stop", async () => {
    const promise = requestRemoteSignature(PAYMENT, 1000);
    const jobId = sentJobId();
    requestSent(7, jobId);

    jest.advanceTimersByTime(1001);
    await expect(promise).rejects.toMatchObject({
      code: 'REMOTE_OUTCOME_UNKNOWN',
      message: expect.stringMatching(/unknown whether this payment was sent.*phone's wallet/),
    });
    expect(mockWebContents.send).toHaveBeenCalledWith('remote-signer:abort', { jobId });
  });

  test.each([
    ['the user stopped waiting', { code: 'REMOTE_USER_CANCELLED' }],
    [
      'the session dropped',
      { code: 'REMOTE_UNKNOWN', message: 'Request timed out: no response after acknowledgement' },
    ],
    ['no code at all', {}],
  ])('a renderer-reported failure (%s) is an unknown outcome', async (_name, error) => {
    const promise = requestRemoteSignature(PAYMENT);
    const jobId = sentJobId();
    requestSent(7, jobId);
    respond(7, { jobId, error });
    await expect(promise).rejects.toMatchObject({ code: 'REMOTE_OUTCOME_UNKNOWN' });
  });

  test("the phone wallet's own error is its answer: the outcome is known", async () => {
    const promise = requestRemoteSignature(PAYMENT);
    const jobId = sentJobId();
    requestSent(7, jobId);
    respond(7, { jobId, error: { rpcCode: 4001, message: 'User denied.' } });
    await expect(promise).rejects.toMatchObject({ code: 'REMOTE_USER_REJECTED' });
  });

  test('a hash from the phone still resolves', async () => {
    const promise = requestRemoteSignature(PAYMENT);
    const jobId = sentJobId();
    requestSent(7, jobId);
    respond(7, { jobId, result: '0x' + 'ab'.repeat(32) });
    await expect(promise).resolves.toBe('0x' + 'ab'.repeat(32));
  });
});

describe('before the request reached the phone, or for a signature', () => {
  const PAYMENT = { ...JOB, method: 'eth_sendTransaction', params: [{}] };

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('a payment never sent to the phone times out as before', async () => {
    const promise = requestRemoteSignature(PAYMENT, 1000);
    jest.advanceTimersByTime(1001);
    await expect(promise).rejects.toMatchObject({ code: 'REMOTE_TIMEOUT' });
  });

  test('a payment never sent to the phone is cancelled as before', async () => {
    const promise = requestRemoteSignature(PAYMENT);
    respond(7, { jobId: sentJobId(), error: { code: 'REMOTE_USER_CANCELLED' } });
    await expect(promise).rejects.toMatchObject({ code: 'REMOTE_USER_CANCELLED' });
  });

  test('a signature on the phone times out as before: a signature pays nothing', async () => {
    const promise = requestRemoteSignature(JOB, 1000);
    requestSent(7, sentJobId());
    jest.advanceTimersByTime(1001);
    await expect(promise).rejects.toMatchObject({ code: 'REMOTE_TIMEOUT' });
  });

  test('only the webContents the job went to can say its request was sent', async () => {
    const promise = requestRemoteSignature(PAYMENT, 1000);
    const jobId = sentJobId();
    requestSent(999, jobId);
    expect(() => requestSent(7, 'no-such-job')).not.toThrow();
    jest.advanceTimersByTime(1001);
    await expect(promise).rejects.toMatchObject({ code: 'REMOTE_TIMEOUT' });
  });
});

// Review of #787, M1: the request goes only with main's leave, given in the
// same turn that marks the payment possibly sent.
describe('remote-signer:request-sent is a handshake', () => {
  const PAYMENT = { ...JOB, method: 'eth_sendTransaction', params: [{}] };

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('a live job is allowed and marked; a timed-out one is refused and stays a timeout', async () => {
    const live = requestRemoteSignature(PAYMENT, 1000);
    // The mark is made in the handler's own turn, before its reply.
    const allowed = requestSent(7, sentJobId());
    jest.advanceTimersByTime(1001);
    await expect(allowed).resolves.toEqual({ allowed: true });
    await expect(live).rejects.toMatchObject({ code: 'REMOTE_OUTCOME_UNKNOWN' });

    const late = requestRemoteSignature(PAYMENT, 1000);
    const jobId = sentJobId();
    jest.advanceTimersByTime(1001);
    await expect(late).rejects.toMatchObject({ code: 'REMOTE_TIMEOUT' });
    await expect(requestSent(7, jobId)).resolves.toEqual({ allowed: false });
  });

  test('another webContents is refused, and marks nothing', async () => {
    const promise = requestRemoteSignature(PAYMENT, 1000);
    await expect(requestSent(999, sentJobId())).resolves.toEqual({ allowed: false });
    jest.advanceTimersByTime(1001);
    await expect(promise).rejects.toMatchObject({ code: 'REMOTE_TIMEOUT' });
  });

  test("main's own relay never asks the identity core", async () => {
    const promise = requestRemoteSignature(PAYMENT, 1000);
    await expect(requestSent(7, sentJobId())).resolves.toEqual({ allowed: true });
    jest.advanceTimersByTime(1001);
    await expect(promise).rejects.toMatchObject({ code: 'REMOTE_OUTCOME_UNKNOWN' });
    expect(mockPhone.sent).not.toHaveBeenCalled();
    expect(mockPhone.result).not.toHaveBeenCalled();
  });
});

// Review of #787, M2: once a payment may have reached the phone, only the
// phone wallet's explicit refusals say it wasn't sent.
describe("the phone's error answers to a payment it may hold", () => {
  const PAYMENT = { ...JOB, method: 'eth_sendTransaction', params: [{}] };
  const answer = async (job, error, { sent = true } = {}) => {
    const promise = requestRemoteSignature(job);
    const jobId = sentJobId();
    if (sent) requestSent(7, jobId);
    respond(7, { jobId, error });
    return promise.catch((err) => err.code);
  };

  test.each([
    ['an internal error', { rpcCode: -32603, message: 'No response after submitting' }],
    ['an unrecognised code', { rpcCode: -32000, message: 'insufficient funds' }],
    ['a code outside EIP-1193', { rpcCode: 4902, message: 'Unrecognized chain' }],
  ])('%s is an unknown outcome', async (_name, error) => {
    await expect(answer(PAYMENT, error)).resolves.toBe('REMOTE_OUTCOME_UNKNOWN');
  });

  test.each([
    [4001, 'REMOTE_USER_REJECTED'],
    [4100, 'REMOTE_WRONG_ACCOUNT'],
    [4200, 'REMOTE_UNSUPPORTED'],
  ])('the explicit refusal %s says it was not sent', async (rpcCode, code) => {
    await expect(answer(PAYMENT, { rpcCode, message: 'refused' })).resolves.toBe(code);
  });

  test('before the request went, and for a signature, an error is mapped as before', async () => {
    const internal = { rpcCode: -32603, message: 'Internal error' };
    await expect(answer(PAYMENT, internal, { sent: false })).resolves.toBe('REMOTE_UNKNOWN');
    await expect(answer(JOB, internal)).resolves.toBe('REMOTE_UNKNOWN');
  });
});

describe('the window that asked (design 0011, APS-4)', () => {
  const { runInWindow } = require('../../windows/request-window');
  const FLAG = 'FREEDOM_APPROVALS_DOCUMENT';
  const otherContents = { id: 9, isDestroyed: jest.fn(() => false), send: jest.fn() };
  const otherWindow = { id: 2, webContents: otherContents, isDestroyed: jest.fn(() => false) };
  let saved;

  beforeEach(() => {
    saved = process.env[FLAG];
    otherContents.send.mockClear();
    otherWindow.isDestroyed.mockReturnValue(false);
    mockWindowsById.clear();
    mockWindowsById.set(2, otherWindow);
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[FLAG];
    else process.env[FLAG] = saved;
  });

  const requestsTo = (contents) => contents.send.mock.calls.filter(([channel]) => channel === 'remote-signer:request');

  test('with the document on, the job goes to the window that asked, not the focused one', async () => {
    process.env[FLAG] = '1';
    // Window 2 asks; window 1 (mockWindow) has focus.
    const pending = runInWindow(2, () => requestRemoteSignature(JOB, 60_000));
    expect(requestsTo(otherContents)).toHaveLength(1);
    expect(requestsTo(mockWebContents)).toHaveLength(0);
    const { jobId } = requestsTo(otherContents)[0][1];
    // Only the chrome it went to may answer.
    respond(7, { jobId, result: '0xfocused' });
    respond(9, { jobId, result: '0xasked' });
    await expect(pending).resolves.toBe('0xasked');
  });

  test('the window is found however many awaits lie between the entry point and the job', async () => {
    process.env[FLAG] = '1';
    const pending = runInWindow(2, async () => {
      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      return requestRemoteSignature(JOB, 60_000);
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(requestsTo(otherContents)).toHaveLength(1);
    respond(9, { jobId: requestsTo(otherContents)[0][1].jobId, result: '0xok' });
    await expect(pending).resolves.toBe('0xok');
  });

  test('a window that asked and has closed gets nothing, and no other window does', async () => {
    process.env[FLAG] = '1';
    otherWindow.isDestroyed.mockReturnValue(true);
    await expect(runInWindow(2, () => requestRemoteSignature(JOB))).rejects.toMatchObject({ code: 'REMOTE_NO_UI' });
    mockWindowsById.clear();
    await expect(runInWindow(2, () => requestRemoteSignature(JOB))).rejects.toMatchObject({ code: 'REMOTE_NO_UI' });
    expect(requestsTo(otherContents)).toHaveLength(0);
    expect(requestsTo(mockWebContents)).toHaveLength(0);
  });

  test('without a window that asked (work outside every entry point), the focused window, as before', async () => {
    process.env[FLAG] = '1';
    const pending = requestRemoteSignature(JOB, 60_000);
    expect(requestsTo(mockWebContents)).toHaveLength(1);
    respond(7, { jobId: sentJobId(), result: '0xok' });
    await expect(pending).resolves.toBe('0xok');
  });

  test('with the document off, the focused window, whichever window asked', async () => {
    process.env[FLAG] = '0';
    const pending = runInWindow(2, () => requestRemoteSignature(JOB, 60_000));
    expect(requestsTo(mockWebContents)).toHaveLength(1);
    expect(requestsTo(otherContents)).toHaveLength(0);
    respond(7, { jobId: sentJobId(), result: '0xok' });
    await expect(pending).resolves.toBe('0xok');
  });
});


// The identity core's jobs (design 0012, PHN-2): the core opens the job
// from the request's authorization, main relays the core's request under
// the core's id, and the core judges the answer.
describe('requestPhoneJob', () => {
  const { isRemoteSendProvablyUnsent } = require('./errors');
  const HASH = '0x' + 'ab'.repeat(32);
  const PAGE = { origin: 'https://app.example', frame: 1 };
  const AUTHORIZATION = { token: 't-1', kind: 'message' };
  const MESSAGE = {
    walletIndex: 3,
    address: '0xabc',
    method: 'message',
    payload: { message: '0x6869' },
  };
  const PAYMENT = {
    walletIndex: 3,
    address: '0xabc',
    method: 'transaction',
    payload: { tx: { to: '0xdef', value: '1', chain_id: 100 } },
    chain: { chainId: '0x64' },
  };
  const SIGN_REQUEST = { method: 'personal_sign', params: ['0x6869', '0xabc'] };
  const SEND_REQUEST = {
    method: 'eth_sendTransaction',
    params: [{ from: '0xabc', to: '0xdef', value: '0x1', chainId: '0x64' }],
  };
  const refusal = (code, reason, data = {}) =>
    Object.assign(new Error(reason || code), { code, data: { ...(reason ? { reason } : {}), ...data } });

  let jobs = 0;
  let jobId;
  /** The core opens each job under a fresh id, with `request` to relay. */
  function opens(request = SIGN_REQUEST, extra = {}) {
    mockPhone.job.mockImplementation(async () => {
      jobs += 1;
      jobId = `core-job-${jobs}`;
      return { job: jobId, expires_in_ms: 300_000, request, ...extra };
    });
  }

  /** Lets the bridge's awaits (phone.job, beforeRelay) run. */
  async function settle() {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  }

  /** The request relayed to the chrome last, once the bridge has relayed it. */
  async function relayed() {
    await settle();
    const calls = mockWebContents.send.mock.calls.filter(([ch]) => ch === 'remote-signer:request');
    return calls.length ? calls[calls.length - 1][1] : null;
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    opens();
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    console.warn.mockRestore();
  });

  describe('the job the core opens', () => {
    test('phone.job gets the account, address, method, payload, authorization and target, under the page', async () => {
      const pending = requestPhoneJob({ ...MESSAGE, authorization: AUTHORIZATION, page: PAGE });
      await relayed();
      expect(mockPhone.job).toHaveBeenCalledWith(
        {
          account: 3,
          address: '0xabc',
          method: 'message',
          payload: { message: '0x6869' },
          authorization: AUTHORIZATION,
          // The webContents main relays to: the core's chrome for the job.
          target: 7,
        },
        PAGE
      );
      mockPhone.result.mockResolvedValue({ signature: '0xsig' });
      respond(7, { jobId, result: '0xsig' });
      await expect(pending).resolves.toBe('0xsig');
    });

    test("main's own job: no authorization, and no page (as shell)", async () => {
      requestPhoneJob(MESSAGE);
      await relayed();
      const [params, page] = mockPhone.job.mock.calls[0];
      expect(params).not.toHaveProperty('authorization');
      expect(page).toBeNull();
    });

    test("relays the core's request under the core's job id, with the chain and purpose", async () => {
      opens(SEND_REQUEST);
      requestPhoneJob({ ...PAYMENT, purpose: 'pay' });
      await expect(relayed()).resolves.toEqual({
        jobId: 'core-job-' + jobs,
        walletIndex: 3,
        address: '0xabc',
        method: 'eth_sendTransaction',
        params: SEND_REQUEST.params,
        chain: { chainId: '0x64' },
        purpose: 'pay',
      });
    });

    test('with no window, the core is never asked, and nothing was delivered', async () => {
      mockFocusedWindow = null;
      mockAllWindows = [];
      await expect(requestPhoneJob(MESSAGE)).rejects.toMatchObject({
        code: 'REMOTE_NO_UI',
        requestDelivered: false,
      });
      expect(mockPhone.job).not.toHaveBeenCalled();
    });

    test('a busy core is REMOTE_BUSY, and nothing went to the phone', async () => {
      mockPhone.job.mockRejectedValue(refusal('busy'));
      const err = await requestPhoneJob(PAYMENT).catch((e) => e);
      expect(err).toMatchObject({ code: 'REMOTE_BUSY', requestDelivered: false });
      expect(isRemoteSendProvablyUnsent(err)).toBe(true);
      expect(await relayed()).toBeNull();
    });

    test("the core's refusal of the authorization is SIGNING_NOT_CONFIRMED, its reason kept", async () => {
      mockPhone.job.mockRejectedValue(refusal('not_authorized', 'unknown_token'));
      await expect(requestPhoneJob({ ...MESSAGE, authorization: AUTHORIZATION })).rejects.toMatchObject({
        code: 'SIGNING_NOT_CONFIRMED',
        reason: 'unknown_token',
        message: expect.stringContaining('unknown or already used confirmation'),
        requestDelivered: false,
      });
      mockPhone.job.mockRejectedValue(refusal('forbidden'));
      await expect(requestPhoneJob(MESSAGE)).rejects.toMatchObject({
        code: 'SIGNING_NOT_CONFIRMED',
        requestDelivered: false,
      });
      expect(await relayed()).toBeNull();
    });

    test("any other failure of phone.job passes on as it is", async () => {
      const locked = refusal('vault_locked');
      mockPhone.job.mockRejectedValue(locked);
      await expect(requestPhoneJob(MESSAGE)).rejects.toBe(locked);
      expect(locked.requestDelivered).toBe(false);
    });
  });

  describe("the caller's last check (beforeRelay)", () => {
    test('runs after the core opened the job, right before the relay', async () => {
      const order = [];
      mockPhone.job.mockImplementation(async () => {
        order.push('phone.job');
        return { job: 'core-job-check', expires_in_ms: 300_000, request: SIGN_REQUEST };
      });
      mockWebContents.send.mockImplementation((channel) => order.push(channel));
      try {
        requestPhoneJob({ ...MESSAGE, beforeRelay: async () => order.push('beforeRelay') });
        await relayed();
        expect(order).toEqual(['phone.job', 'beforeRelay', 'remote-signer:request']);
      } finally {
        mockWebContents.send.mockImplementation(() => {});
      }
    });

    test("a refusal ends the core's job as main's own (REMOTE_USER_CANCELLED), relays nothing, and is the caller's", async () => {
      const refused = new Error('the rule was revoked');
      mockPhone.result.mockResolvedValue({ outcome: 'failed', code: 'REMOTE_USER_CANCELLED' });
      await expect(
        requestPhoneJob({
          ...MESSAGE,
          beforeRelay: async () => {
            throw refused;
          },
        })
      ).rejects.toBe(refused);
      expect(mockPhone.result).toHaveBeenCalledWith(
        { job: jobId, sender: 7, error: { code: 'REMOTE_USER_CANCELLED' } },
        null
      );
      expect(await relayed()).toBeNull();
    });

    test("a window closed during the check ends the core's job as REMOTE_NO_UI", async () => {
      mockPhone.result.mockResolvedValue({ outcome: 'failed', code: 'REMOTE_NO_UI' });
      const pending = requestPhoneJob({
        ...MESSAGE,
        beforeRelay: async () => {
          mockWebContents.isDestroyed.mockReturnValue(true);
        },
      });
      await expect(pending).rejects.toMatchObject({ code: 'REMOTE_NO_UI', requestDelivered: false });
      expect(mockPhone.result).toHaveBeenCalledWith(
        { job: jobId, sender: 7, error: { code: 'REMOTE_NO_UI' } },
        null
      );
    });
  });

  describe("the chrome's handshake (remote-signer:request-sent)", () => {
    test('becomes phone.sent with the IPC sender\'s id, and is allowed', async () => {
      opens(SEND_REQUEST);
      requestPhoneJob(PAYMENT);
      await relayed();
      mockPhone.sent.mockResolvedValue({});
      await expect(requestSent(7, jobId)).resolves.toEqual({ allowed: true });
      expect(mockPhone.sent).toHaveBeenCalledWith({ job: jobId, sender: 7 });
    });

    test('a core refusal of the mark is not allowed', async () => {
      opens(SEND_REQUEST);
      requestPhoneJob(PAYMENT);
      await relayed();
      mockPhone.sent.mockRejectedValue(refusal('not_authorized', 'expired'));
      await expect(requestSent(7, jobId)).resolves.toEqual({ allowed: false });
    });

    test('another webContents is refused by main, and the core is never asked', async () => {
      requestPhoneJob(PAYMENT);
      await relayed();
      await expect(requestSent(999, jobId)).resolves.toEqual({ allowed: false });
      expect(mockPhone.sent).not.toHaveBeenCalled();
    });

    test("main's timeout during the core's turn: not allowed, and the payment's outcome is unknown", async () => {
      opens(SEND_REQUEST);
      const pending = requestPhoneJob(PAYMENT, 1000);
      await relayed();
      let marked;
      mockPhone.sent.mockReturnValue(new Promise((resolve) => (marked = resolve)));
      mockPhone.result.mockResolvedValue({ outcome: 'unknown' });
      const allowed = requestSent(7, jobId);
      jest.advanceTimersByTime(1001);
      marked({});
      await expect(allowed).resolves.toEqual({ allowed: false });
      await expect(pending).rejects.toMatchObject({ code: 'REMOTE_OUTCOME_UNKNOWN', requestDelivered: true });
    });
  });

  describe("the chrome's answer (remote-signer:response)", () => {
    test("becomes phone.result with the IPC sender's id and the result", async () => {
      const pending = requestPhoneJob(MESSAGE);
      await relayed();
      mockPhone.result.mockResolvedValue({ signature: '0xsig' });
      respond(7, { jobId, result: '0xsig' });
      await expect(pending).resolves.toBe('0xsig');
      expect(mockPhone.result).toHaveBeenCalledWith({ job: jobId, sender: 7, result: '0xsig' });
      // The chrome's answer goes as `chrome`: the method's default caller.
      expect(mockPhone.result.mock.calls[0]).toHaveLength(1);
    });

    test('an answer with no result goes as null', async () => {
      const pending = requestPhoneJob(MESSAGE);
      await relayed();
      mockPhone.result.mockResolvedValue({ outcome: 'unknown' });
      respond(7, { jobId });
      await pending.catch(() => {});
      expect(mockPhone.result).toHaveBeenCalledWith({ job: jobId, sender: 7, result: null });
    });

    test.each([
      ['an EIP-1193 error', { rpcCode: 4001, message: 'User denied.' }, { rpc_code: 4001, message: 'User denied.' }],
      ["a code the chrome minted", { code: 'REMOTE_USER_CANCELLED' }, { code: 'REMOTE_USER_CANCELLED' }],
      [
        'extra fields, dropped',
        { rpcCode: -32603, code: 'X', message: 'm', stack: 's', data: { a: 1 } },
        { rpc_code: -32603, code: 'X', message: 'm' },
      ],
      ['fields of the wrong type, dropped', { rpcCode: '4001', code: 5, message: { a: 1 } }, {}],
      ['a non-integer rpc code, dropped', { rpcCode: 4001.5 }, {}],
    ])('an error (%s) goes as { rpc_code?, code?, message? }', async (_name, error, expected) => {
      const pending = requestPhoneJob(MESSAGE);
      await relayed();
      mockPhone.result.mockResolvedValue({ outcome: 'failed', code: 'REMOTE_USER_REJECTED' });
      respond(7, { jobId, error });
      await pending.catch(() => {});
      expect(mockPhone.result).toHaveBeenCalledWith({ job: jobId, sender: 7, error: expected });
    });

    test('an answer from another webContents is ignored by the bridge and never reaches the core', async () => {
      const pending = requestPhoneJob(MESSAGE);
      await relayed();
      mockPhone.result.mockResolvedValue({ signature: '0xreal' });
      respond(999, { jobId, result: '0xforged' });
      await settle();
      expect(mockPhone.result).not.toHaveBeenCalled();
      respond(7, { jobId, result: '0xreal' });
      await expect(pending).resolves.toBe('0xreal');
      expect(mockPhone.result).toHaveBeenCalledTimes(1);
      expect(mockPhone.result).toHaveBeenCalledWith({ job: jobId, sender: 7, result: '0xreal' });
    });

    test('a second answer while the first is with the core is ignored', async () => {
      const pending = requestPhoneJob(MESSAGE);
      await relayed();
      let judged;
      mockPhone.result.mockReturnValue(new Promise((resolve) => (judged = resolve)));
      respond(7, { jobId, result: '0xfirst' });
      respond(7, { jobId, result: '0xsecond' });
      expect(mockPhone.result).toHaveBeenCalledTimes(1);
      judged({ signature: '0xfirst' });
      await expect(pending).resolves.toBe('0xfirst');
    });

    test('an answer for an unknown or settled job is ignored', async () => {
      expect(() => respond(7, { jobId: 'no-such-core-job', result: 'x' })).not.toThrow();
      await settle();
      expect(mockPhone.result).not.toHaveBeenCalled();
    });
  });

  describe("the core's judgement of the answer", () => {
    async function answered(reply, { request = SEND_REQUEST, sent = true } = {}) {
      opens(request);
      const pending = requestPhoneJob(request === SEND_REQUEST ? PAYMENT : MESSAGE);
      await relayed();
      if (sent) {
        mockPhone.sent.mockResolvedValue({});
        await requestSent(7, jobId);
      }
      if (reply instanceof Error) mockPhone.result.mockRejectedValue(reply);
      else mockPhone.result.mockResolvedValue(reply);
      respond(7, { jobId, result: HASH });
      return pending;
    }

    test('a signature resolves as it is', async () => {
      await expect(answered({ signature: '0xsig' }, { request: SIGN_REQUEST })).resolves.toBe('0xsig');
    });

    test('verified: the hash, its outcome and the job, with the rule the core wrote', async () => {
      const pending = answered({ outcome: 'verified', hash: HASH, rule: { added: true } });
      await expect(pending).resolves.toEqual({
        hash: HASH,
        outcome: 'verified',
        job: jobId,
        rule: { added: true },
      });
    });

    test('unverified: the hash, its outcome and the job, for its later phone.checked', async () => {
      await expect(answered({ outcome: 'unverified', hash: HASH })).resolves.toEqual({
        hash: HASH,
        outcome: 'unverified',
        job: jobId,
      });
    });

    test('unknown with a hash: its record not saved (durable: false)', async () => {
      await expect(answered({ outcome: 'unknown', hash: HASH, durable: false })).resolves.toEqual({
        hash: HASH,
        outcome: 'unknown',
        job: jobId,
        durable: false,
      });
    });

    test('a rule that is not an object, or a durable that is not false, is not passed on', async () => {
      const reply = await answered({ outcome: 'unverified', hash: HASH, rule: 'yes', durable: true });
      expect(reply).toEqual({ hash: HASH, outcome: 'unverified', job: jobId });
    });

    test("failed: the phone's refusal, in the core's code and message", async () => {
      const err = await answered({ outcome: 'failed', code: 'REMOTE_USER_REJECTED' }).catch((e) => e);
      expect(err).toMatchObject({ code: 'REMOTE_USER_REJECTED', requestDelivered: true });
      expect(err.message).toMatch(/rejected on your phone/i);
      expect(isRemoteSendProvablyUnsent(err)).toBe(true);

      const custom = await answered({ outcome: 'failed', code: 'REMOTE_UNSUPPORTED', message: 'no such method' }).catch(
        (e) => e
      );
      expect(custom).toMatchObject({ code: 'REMOTE_UNSUPPORTED', message: 'no such method' });
    });

    test.each([[{ outcome: 'unknown' }], [{ outcome: 'verified' }], [{}], [null]])(
      'an answer that shows nothing (%p) is an unknown outcome',
      async (reply) => {
        await expect(answered(reply)).rejects.toMatchObject({
          code: 'REMOTE_OUTCOME_UNKNOWN',
          message: expect.stringMatching(/couldn't be read/),
        });
      }
    );
  });

  describe("the core's refusals of the answer", () => {
    async function refused(reason, { request = SEND_REQUEST, sent = true, data = {} } = {}) {
      opens(request);
      const pending = requestPhoneJob(request === SEND_REQUEST ? PAYMENT : MESSAGE);
      await relayed();
      if (sent) {
        mockPhone.sent.mockResolvedValue({});
        await requestSent(7, jobId);
      }
      mockPhone.result.mockRejectedValue(refusal('not_authorized', reason, data));
      respond(7, { jobId, result: HASH });
      return pending.catch((e) => e);
    }

    test("a payment's wrong_transaction: the phone sent something, kept with what it sent", async () => {
      const transaction = { from: '0xabc', to: '0x999', value: '5', chain_id: 100 };
      const err = await refused('wrong_transaction', { data: { transaction } });
      expect(err).toMatchObject({ code: 'REMOTE_WRONG_TRANSACTION', phoneSent: true, transaction });
      expect(isRemoteSendProvablyUnsent(err)).toBe(false);
    });

    test("a payment's wrong_account: the phone sent something", async () => {
      const err = await refused('wrong_account');
      expect(err).toMatchObject({ code: 'REMOTE_WRONG_ACCOUNT', phoneSent: true });
      expect(err).not.toHaveProperty('transaction');
      expect(isRemoteSendProvablyUnsent(err)).toBe(false);
    });

    test("even with no handshake, a payment the core saw sent is never proof it wasn't", async () => {
      const err = await refused('wrong_transaction', { sent: false });
      expect(err).toMatchObject({ code: 'REMOTE_WRONG_TRANSACTION', phoneSent: true, requestDelivered: false });
      expect(isRemoteSendProvablyUnsent(err)).toBe(false);
    });

    test("a signature's wrong_account is REMOTE_WRONG_ACCOUNT, and sent nothing", async () => {
      const err = await refused('wrong_account', { request: SIGN_REQUEST });
      expect(err).toMatchObject({ code: 'REMOTE_WRONG_ACCOUNT' });
      expect(err).not.toHaveProperty('phoneSent');
    });

    test('bad_response is REMOTE_BAD_RESPONSE', async () => {
      await expect(refused('bad_response', { request: SIGN_REQUEST })).resolves.toMatchObject({
        code: 'REMOTE_BAD_RESPONSE',
      });
    });

    test("expired is a timeout for a signature, and an unknown outcome for a payment that went", async () => {
      await expect(refused('expired', { request: SIGN_REQUEST })).resolves.toMatchObject({
        code: 'REMOTE_TIMEOUT',
      });
      await expect(refused('expired')).resolves.toMatchObject({ code: 'REMOTE_OUTCOME_UNKNOWN' });
      await expect(refused('expired', { sent: false })).resolves.toMatchObject({ code: 'REMOTE_TIMEOUT' });
      // The core's own word that the outcome is unknown.
      await expect(
        refused('expired', { sent: false, data: { outcome: 'unknown' } })
      ).resolves.toMatchObject({ code: 'REMOTE_OUTCOME_UNKNOWN' });
    });

    test.each([['settled'], ['unknown_job']])(
      '%s: no answer the core took, unknown for a payment that went',
      async (reason) => {
        await expect(refused(reason, { request: SIGN_REQUEST })).resolves.toMatchObject({
          code: 'REMOTE_UNKNOWN',
        });
        await expect(refused(reason)).resolves.toMatchObject({ code: 'REMOTE_OUTCOME_UNKNOWN' });
        await expect(refused(reason, { sent: false })).resolves.toMatchObject({ code: 'REMOTE_UNKNOWN' });
      }
    );

    test('wrong_sender keeps the job open: a later answer from its own chrome still settles it', async () => {
      const pending = requestPhoneJob(MESSAGE);
      await relayed();
      mockPhone.result.mockRejectedValueOnce(refusal('not_authorized', 'wrong_sender'));
      respond(7, { jobId, result: '0xfirst' });
      await settle();
      mockPhone.result.mockResolvedValueOnce({ signature: '0xsecond' });
      respond(7, { jobId, result: '0xsecond' });
      await expect(pending).resolves.toBe('0xsecond');
      expect(mockPhone.result).toHaveBeenCalledTimes(2);
    });
  });

  describe("main's own timeout", () => {
    test("tells the core as shell (caller null) with REMOTE_TIMEOUT, and the chrome to stop", async () => {
      const pending = requestPhoneJob(MESSAGE, 1000);
      await relayed();
      mockPhone.result.mockResolvedValue({ outcome: 'failed', code: 'REMOTE_TIMEOUT' });
      jest.advanceTimersByTime(1001);
      await expect(pending).rejects.toMatchObject({ code: 'REMOTE_TIMEOUT', requestDelivered: false });
      expect(mockPhone.result).toHaveBeenCalledWith(
        { job: jobId, sender: 7, error: { code: 'REMOTE_TIMEOUT' } },
        null
      );
      expect(mockWebContents.send).toHaveBeenCalledWith('remote-signer:abort', { jobId });
      // A late answer for the dead job never reaches the core.
      mockPhone.result.mockClear();
      respond(7, { jobId, result: '0xlate' });
      await settle();
      expect(mockPhone.result).not.toHaveBeenCalled();
    });

    test("the core's own life bounds main's wait", async () => {
      opens(SIGN_REQUEST, { expires_in_ms: 500 });
      const pending = requestPhoneJob(MESSAGE, 1000);
      await relayed();
      mockPhone.result.mockResolvedValue({ outcome: 'failed', code: 'REMOTE_TIMEOUT' });
      jest.advanceTimersByTime(501);
      await expect(pending).rejects.toMatchObject({ code: 'REMOTE_TIMEOUT' });
    });

    test("a payment that went is an unknown outcome, whatever the core's reply", async () => {
      opens(SEND_REQUEST);
      const pending = requestPhoneJob(PAYMENT, 1000);
      await relayed();
      mockPhone.sent.mockResolvedValue({});
      await requestSent(7, jobId);
      mockPhone.result.mockResolvedValue({});
      jest.advanceTimersByTime(1001);
      const err = await pending.catch((e) => e);
      expect(err).toMatchObject({ code: 'REMOTE_OUTCOME_UNKNOWN', requestDelivered: true });
      expect(isRemoteSendProvablyUnsent(err)).toBe(false);
    });

    test("the core's `unknown` makes it an unknown outcome", async () => {
      const pending = requestPhoneJob(MESSAGE, 1000);
      await relayed();
      mockPhone.result.mockResolvedValue({ outcome: 'unknown' });
      jest.advanceTimersByTime(1001);
      await expect(pending).rejects.toMatchObject({ code: 'REMOTE_OUTCOME_UNKNOWN' });
    });

    test("a core that refuses main's end: its refusal decides", async () => {
      const pending = requestPhoneJob(MESSAGE, 1000);
      await relayed();
      mockPhone.result.mockRejectedValue(refusal('not_authorized', 'settled'));
      jest.advanceTimersByTime(1001);
      await expect(pending).rejects.toMatchObject({ code: 'REMOTE_UNKNOWN' });
    });

    test('an answer already with the core decides: the timeout does nothing', async () => {
      const pending = requestPhoneJob(MESSAGE, 1000);
      await relayed();
      let judged;
      mockPhone.result.mockReturnValue(new Promise((resolve) => (judged = resolve)));
      respond(7, { jobId, result: '0xsig' });
      jest.advanceTimersByTime(1001);
      expect(mockPhone.result).toHaveBeenCalledTimes(1);
      expect(mockWebContents.send).not.toHaveBeenCalledWith('remote-signer:abort', { jobId });
      judged({ signature: '0xsig' });
      await expect(pending).resolves.toBe('0xsig');
    });
  });
});
