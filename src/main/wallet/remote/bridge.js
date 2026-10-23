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
 * 'remote-signer:request-sent' (renderer → main, invoked) { jobId } before
 * the request itself goes to the phone. Main answers { allowed }: for a
 * live job it marks the request possibly sent and allows it; a job it has
 * already settled (its timeout) is refused, and the renderer sends nothing.
 * One handler turn does both, so no timeout can fall between them.
 *
 * A payment that reached the phone may have been sent: the phone signs
 * and broadcasts it itself. Once allowed, its lost answer (main's timeout,
 * a dropped session, the user closing the dialog) is therefore
 * REMOTE_OUTCOME_UNKNOWN, never a failure (freedom-core design 0005,
 * "Retrying an intent"). So is any error the phone answers with, except
 * the explicit refusals that mean the wallet didn't run the request
 * (EIP-1193 4001 rejected, 4100 unauthorized, 4200 unsupported): an
 * internal or unrecognised error proves nothing about the broadcast.
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

/** A payment the phone may have sent: its request was allowed to go. */
function paymentMayHaveLeft(job) {
  return job.method === PAYMENT_METHOD && job.requestSent;
}

// The phone wallet's answers that say it didn't run the request (EIP-1193):
// rejected by the user, unauthorized account, unsupported method.
const PHONE_REFUSALS = new Set([4001, 4100, 4200]);

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
 * error object straight from the phone wallet (EIP-1193 codes); plain
 * code = a REMOTE_* the renderer minted (a dropped session, the user
 * closing the dialog). For a payment that may have left, only the phone's
 * explicit refusals (PHONE_REFUSALS) say it wasn't sent; anything else,
 * the phone's internal or unrecognised errors included, leaves its outcome
 * unknown.
 */
function errorOf(job, error) {
  const answered = error.rpcCode !== undefined;
  if (paymentMayHaveLeft(job) && !(answered && PHONE_REFUSALS.has(error.rpcCode))) {
    console.warn(
      '[RemoteSigner] No definite answer to a payment request that reached the phone:',
      answered ? `rpc ${error.rpcCode}` : error.code || REMOTE_ERROR_CODES.UNKNOWN,
      error.message || ''
    );
    return createRemoteError(REMOTE_ERROR_CODES.OUTCOME_UNKNOWN);
  }
  if (answered) {
    return mapRemoteRpcError({ code: error.rpcCode, message: error.message });
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

  // Asked before the request itself goes over the session. A live job is
  // marked possibly sent and allowed, in this one turn, so main's timeout
  // can't fall between the two; a settled job (timed out) is refused, and
  // the renderer then sends nothing. Once allowed, a payment's lost answer
  // is unknown.
  ipcMain.handle('remote-signer:request-sent', (event, payload) => {
    const job = jobOf(event, payload?.jobId);
    if (!job) return { allowed: false };
    job.requestSent = true;
    return { allowed: true };
  });
}

module.exports = { requestRemoteSignature, registerRemoteSignerIpc };
