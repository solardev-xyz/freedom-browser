/**
 * Remote-signer IPC bridge.
 *
 * The openlv session lives in the chrome renderer (WebRTC is native
 * there), but signing policy stays in main: the remote signer backend
 * (./signer.js) calls `requestRemoteSignature` here, which publishes the
 * job to the renderer session broker and waits for its response. Main
 * never trusts the answer as-is — the backend verifies every signature
 * against the account record before returning it.
 *
 * One channel pair:
 *   main → renderer  'remote-signer:request' { jobId, walletIndex, address, method, params }
 *   renderer → main  'remote-signer:response' { jobId, result } | { jobId, error: {code, message} }
 * plus 'remote-signer:abort' (main → renderer) when a job dies in main
 * (timeout) so the QR dialog can close itself, and
 * 'remote-signer:request-sent' (renderer → main) { jobId } just before the
 * request itself goes to the phone.
 *
 * A payment that reached the phone may have been sent: the phone signs
 * and broadcasts it itself. Its lost answer (main's timeout, a dropped
 * session, the user closing the dialog) is therefore REMOTE_OUTCOME_UNKNOWN,
 * never a failure (freedom-core design 0005, "Retrying an intent"). Only
 * the phone wallet's own error answer says it wasn't sent.
 *
 * Responses are only accepted from the webContents the job was sent to —
 * a dApp webview must not be able to answer (or cancel) signing jobs.
 */

const { randomUUID } = require('crypto');

const { ipcMain, BrowserWindow } = require('electron');

const { REMOTE_ERROR_CODES, createRemoteError, mapRemoteRpcError } = require('./errors');

// Scanning a QR and confirming on a phone is slow; the renderer session
// enforces its own (shorter) protocol timeouts — this is the backstop.
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** jobId → {resolve, reject, timer, webContents, method, requestSent} */
const pendingJobs = new Map();

// The phone signs and broadcasts this method's payment itself.
const PAYMENT_METHOD = 'eth_sendTransaction';

/** A payment the phone may have sent: its request reached the phone. */
function paymentMayHaveLeft(job) {
  return job.method === PAYMENT_METHOD && job.requestSent;
}

/** A job of `sender`'s, or null (unknown, settled, or another webContents's). */
function jobOf(event, jobId) {
  const job = pendingJobs.get(jobId);
  if (!job) return null; // already settled (timeout) or forged jobId
  if (event.sender.id !== job.webContents.id) {
    console.warn('[RemoteSigner] Ignoring a message from unexpected webContents', event.sender.id);
    return null;
  }
  return job;
}

function getTargetWindow() {
  return BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
}

function settleJob(jobId, settle) {
  const job = pendingJobs.get(jobId);
  if (!job) return;
  pendingJobs.delete(jobId);
  clearTimeout(job.timer);
  settle(job);
}

/**
 * Publish a signing job to the renderer session broker and await the
 * phone's answer.
 *
 * @param {{walletIndex: number, address: string, method: string, params: unknown[]}} job
 * @param {number} [timeoutMs]
 * @returns {Promise<unknown>} The JSON-RPC result from the phone (unverified).
 */
function requestRemoteSignature(job, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const win = getTargetWindow();
  if (!win || win.webContents.isDestroyed()) {
    return Promise.reject(createRemoteError(REMOTE_ERROR_CODES.NO_UI));
  }

  const jobId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      settleJob(jobId, (job) => {
        if (!job.webContents.isDestroyed()) {
          job.webContents.send('remote-signer:abort', { jobId });
        }
        reject(
          createRemoteError(
            paymentMayHaveLeft(job)
              ? REMOTE_ERROR_CODES.OUTCOME_UNKNOWN
              : REMOTE_ERROR_CODES.TIMEOUT
          )
        );
      });
    }, timeoutMs);

    pendingJobs.set(jobId, {
      resolve,
      reject,
      timer,
      webContents: win.webContents,
      method: job.method,
      requestSent: false,
    });

    win.webContents.send('remote-signer:request', { jobId, ...job });
  });
}

/**
 * The error a renderer-reported failure stands for. rpcCode = a JSON-RPC
 * error object straight from the phone wallet (EIP-1193 codes): its own
 * answer, so the outcome is known. Plain code = a REMOTE_* the renderer
 * minted (a dropped session, the user closing the dialog): no answer from
 * the phone, so a payment it may have received is unknown.
 */
function errorOf(job, error) {
  if (error.rpcCode !== undefined) {
    return mapRemoteRpcError({ code: error.rpcCode, message: error.message });
  }
  if (paymentMayHaveLeft(job)) {
    console.warn(
      '[RemoteSigner] No answer to a payment request that reached the phone:',
      error.code || REMOTE_ERROR_CODES.UNKNOWN,
      error.message || ''
    );
    return createRemoteError(REMOTE_ERROR_CODES.OUTCOME_UNKNOWN);
  }
  return createRemoteError(error.code || REMOTE_ERROR_CODES.UNKNOWN, error.message);
}

function registerRemoteSignerIpc() {
  ipcMain.on('remote-signer:response', (event, payload) => {
    const { jobId, result, error } = payload || {};
    const job = jobOf(event, jobId);
    if (!job) return;
    settleJob(jobId, ({ resolve, reject }) => {
      if (error) {
        reject(errorOf(job, error));
      } else {
        resolve(result);
      }
    });
  });

  // Sent before the request itself goes over the session, so from here on
  // the phone may hold it: a payment's lost answer is then unknown.
  ipcMain.on('remote-signer:request-sent', (event, payload) => {
    const job = jobOf(event, payload?.jobId);
    if (job) job.requestSent = true;
  });
}

module.exports = { requestRemoteSignature, registerRemoteSignerIpc };
