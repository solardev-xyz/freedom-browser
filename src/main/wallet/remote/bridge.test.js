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
