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
 * (timeout) so the QR dialog can close itself.
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

/** jobId → {resolve, reject, timer, webContents} */
const pendingJobs = new Map();

function getTargetWindow() {
  return BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
}

/**
 * Record on a rejection whether the request ever reached the phone. A
 * phone that never saw an eth_sendTransaction cannot have broadcast it,
 * so callers journaling an irreversible send can tell "provably unsent"
 * from "the phone may still have broadcast it" (timeout or cancel after
 * the request was already on the phone).
 */
function markDelivery(err, deliveredAttempts, answeringAttempt) {
  const attempts = deliveredAttempts instanceof Set ? deliveredAttempts : new Set();
  err.requestDelivered = attempts.size > 0;
  // "New code" re-runs the same job as a fresh attempt, so an earlier
  // attempt may already be on the phone (and broadcast) when a later one
  // is refused. A refusal only proves nothing went out when no attempt
  // other than the one answering was ever delivered; an answer that names
  // no attempt (timeout, renderer-minted error) counts every delivery.
  err.otherAttemptDelivered = [...attempts].some((a) => a !== answeringAttempt);
  return err;
}

function attemptOf(payload) {
  return Number.isSafeInteger(payload?.attempt) && payload.attempt > 0 ? payload.attempt : undefined;
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
    return Promise.reject(markDelivery(createRemoteError(REMOTE_ERROR_CODES.NO_UI)));
  }

  const jobId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      settleJob(jobId, ({ webContents, deliveredAttempts }) => {
        if (!webContents.isDestroyed()) {
          webContents.send('remote-signer:abort', { jobId });
        }
        reject(markDelivery(createRemoteError(REMOTE_ERROR_CODES.TIMEOUT), deliveredAttempts));
      });
    }, timeoutMs);

    pendingJobs.set(jobId, { resolve, reject, timer, webContents: win.webContents, deliveredAttempts: new Set() });

    win.webContents.send('remote-signer:request', { jobId, ...job });
  });
}

function registerRemoteSignerIpc() {
  // The renderer reports the moment it hands the request to the phone
  // (after QR link and chain switch), so main knows from then on that a
  // timeout or cancel leaves the outcome uncertain. Each attempt (a
  // "New code" retry is a new one) reports its own number; one without a
  // number still counts as a delivery.
  ipcMain.on('remote-signer:delivered', (event, payload) => {
    const job = pendingJobs.get(payload?.jobId);
    if (!job || event.sender.id !== job.webContents.id) return;
    job.deliveredAttempts.add(attemptOf(payload) ?? 'unnumbered');
  });
  ipcMain.on('remote-signer:response', (event, payload) => {
    const { jobId, result, error } = payload || {};
    const job = pendingJobs.get(jobId);
    if (!job) return; // already settled (timeout) or forged jobId
    if (event.sender.id !== job.webContents.id) {
      console.warn('[RemoteSigner] Ignoring response from unexpected webContents', event.sender.id);
      return;
    }
    settleJob(jobId, ({ resolve, reject, deliveredAttempts }) => {
      if (error) {
        // rpcCode = a JSON-RPC error object straight from the phone wallet
        // (EIP-1193 codes); plain code = a REMOTE_* the renderer minted.
        reject(markDelivery(
          error.rpcCode !== undefined
            ? mapRemoteRpcError({ code: error.rpcCode, message: error.message })
            : createRemoteError(error.code || REMOTE_ERROR_CODES.UNKNOWN, error.message),
          deliveredAttempts,
          attemptOf(payload),
        ));
      } else {
        resolve(result);
      }
    });
  });
}

module.exports = { requestRemoteSignature, registerRemoteSignerIpc };
