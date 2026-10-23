/**
 * The bridge is main's only path to the renderer session broker; these
 * tests fake electron's window/IPC surface and drive both directions:
 * job publication (webContents.send) and response settlement (ipcMain.on).
 */

const mockWebContents = {
  id: 7,
  isDestroyed: jest.fn(() => false),
  send: jest.fn(),
};
const mockWindow = { webContents: mockWebContents };

let mockFocusedWindow = mockWindow;
let mockAllWindows = [mockWindow];
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
  },
}));

const { requestRemoteSignature, registerRemoteSignerIpc } = require('./bridge');

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
    expect(requestSent(7, sentJobId())).toEqual({ allowed: true });
    jest.advanceTimersByTime(1001);
    await expect(live).rejects.toMatchObject({ code: 'REMOTE_OUTCOME_UNKNOWN' });

    const late = requestRemoteSignature(PAYMENT, 1000);
    const jobId = sentJobId();
    jest.advanceTimersByTime(1001);
    await expect(late).rejects.toMatchObject({ code: 'REMOTE_TIMEOUT' });
    expect(requestSent(7, jobId)).toEqual({ allowed: false });
  });

  test('another webContents is refused, and marks nothing', async () => {
    const promise = requestRemoteSignature(PAYMENT, 1000);
    expect(requestSent(999, sentJobId())).toEqual({ allowed: false });
    jest.advanceTimersByTime(1001);
    await expect(promise).rejects.toMatchObject({ code: 'REMOTE_TIMEOUT' });
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
