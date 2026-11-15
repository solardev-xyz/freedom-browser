/**
 * Remote-signer IPC bridge.
 *
 * The openlv session lives in the chrome renderer (WebRTC is native
 * there), but every phone signature and payment is a job of the identity
 * core (design 0012, PHN-1/PHN-2): the core opens it (`phone.job`) for a
 * checked authorization and the window's webContents, this bridge relays
 * the core's request to the renderer session broker under the core's job
 * id, reports `phone.sent`, and hands the phone's answer to the core
 * (`phone.result`), which checks it against what the job bound. Main also
 * checks the sender and verifies every signature before returning it.
 * (The legacy `requestRemoteSignature` relay remains only for main's own
 * account-proof check, #1078.)
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
 * Every rejection also says whether the request reached the phone
 * (`requestDelivered`) and whether another attempt of the job may have
 * (`otherAttemptDelivered`), for callers that journal an irreversible send
 * (`isRemoteSendProvablyUnsent` in ./errors.js). The broker mints no new
 * code for a payment once its request went, so a payment has at most one
 * delivered attempt.
 *
 * The job goes to the chrome of the window that asked, with the approvals
 * document on (getTargetWindow); otherwise to the focused window.
 *
 * Responses are only accepted from the webContents the job was sent to —
 * a dApp webview must not be able to answer (or cancel) signing jobs.
 *
 * The identity core's jobs (freedom-core design 0012, PHN-2; cored 0.18.0):
 * every signature and payment a phone account makes goes through
 * `requestPhoneJob`. The core makes the job from the request's checked
 * authorization (`phone.job`), for the webContents main names as its
 * `target`, and gives the JSON-RPC request to relay; main relays it under
 * the core's job id. `remote-signer:request-sent` becomes `phone.sent`, and
 * `remote-signer:response` becomes `phone.result`, each with `sender`, the
 * id of the webContents whose IPC message brought it (`event.sender.id`,
 * never the message's). The core refuses another sender (`wrong_sender`)
 * and keeps the job open for its own; main keeps its own check as well
 * (`jobOf`). The core checks the answer: a signature must recover to the
 * account, and a payment's reported transaction is compared with the one
 * confirmed once it is visible (`verified`, `unverified`, or `unknown`;
 * a visible different one is refused, `wrong_transaction`). Main's own
 * timeout tells the core (`REMOTE_TIMEOUT`); the core's five minutes are
 * authoritative. `requestRemoteSignature` remains for the account check
 * alone (./account-proof.js), main's own challenge for an account that may
 * have no record yet.
 */

const { randomUUID } = require('crypto');

const { ipcMain, BrowserWindow } = require('electron');

const { REMOTE_ERROR_CODES, UNREADABLE_ANSWER, createRemoteError, mapRemoteRpcError } = require('./errors');
const { requestWindowId } = require('../../windows/request-window');
const { isApprovalsDocumentEnabled } = require('../../approvals/approvals-document');

// Scanning a QR and confirming on a phone is slow; the renderer session
// enforces its own (shorter) protocol timeouts — this is the backstop.
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * jobId → {resolve, reject, timer, webContents, method, requestSent}, and for
 * the core's jobs `core: true` and `answering` (an answer is with the core).
 */
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

/**
 * Record on a rejection whether the request ever reached the phone. A phone
 * that never saw an eth_sendTransaction cannot have broadcast it, so callers
 * journaling an irreversible send can tell "provably unsent" from "the phone
 * may still have broadcast it". Another attempt can have reached the phone
 * only for a request that isn't a payment (a payment gets no new code once
 * its request went), so that is the fail-closed answer for those.
 */
function markDelivery(err, job) {
  const delivered = Boolean(job?.requestSent);
  err.requestDelivered = delivered;
  err.otherAttemptDelivered = delivered && job.method !== PAYMENT_METHOD;
  return err;
}

/**
 * The window whose chrome gets the job. With the approvals document on
 * (freedom-core design 0011, APS-4), the window that asked
 * (`windows/request-window.js`): its panel's device wait points to its own
 * sidebar, so the QR must show there, not in whichever window has focus.
 * A window that asked and has closed gets none, and the job fails with
 * REMOTE_NO_UI. An x402 payment asks for the window that hosts its tab
 * (APS-5), and the agent's own transfer for the agent's window (the window
 * whose chrome owns its conversation). Without an asking window (work
 * outside every entry point), or with the document off, the focused window,
 * as before.
 */
function getTargetWindow() {
  if (isApprovalsDocumentEnabled()) {
    const asked = requestWindowId();
    if (asked !== null) {
      const win = BrowserWindow.fromId(asked);
      return win && !win.isDestroyed() ? win : null;
    }
  }
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
    return Promise.reject(markDelivery(createRemoteError(REMOTE_ERROR_CODES.NO_UI)));
  }

  const jobId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      settleJob(jobId, (job) => {
        if (!job.webContents.isDestroyed()) {
          job.webContents.send('remote-signer:abort', { jobId });
        }
        reject(
          markDelivery(
            createRemoteError(
              paymentMayHaveLeft(job)
                ? REMOTE_ERROR_CODES.OUTCOME_UNKNOWN
                : REMOTE_ERROR_CODES.TIMEOUT
            ),
            job
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
    if (job.core) {
      answerCoreJob(jobId, job, event.sender.id, { result, error });
      return;
    }
    settleJob(jobId, ({ resolve, reject }) => {
      if (error) {
        reject(markDelivery(errorOf(job, error), job));
      } else {
        resolve(result);
      }
    });
  });

  // Asked before the request itself goes over the session. A live job is
  // marked possibly sent and allowed, in this one turn, so main's timeout
  // can't fall between the two; a settled job (timed out) is refused, and
  // the renderer then sends nothing. Once allowed, a payment's lost answer
  // is unknown. A core job is marked in main first, so a timeout during the
  // core's turn reads it possibly sent, then marked by the core
  // (`phone.sent`), which refuses a settled or expired one.
  ipcMain.handle('remote-signer:request-sent', async (event, payload) => {
    const job = jobOf(event, payload?.jobId);
    if (!job) return { allowed: false };
    job.requestSent = true;
    if (!job.core) return { allowed: true };
    try {
      await coreBackend().phone.sent({ job: payload.jobId, sender: event.sender.id });
    } catch (err) {
      console.warn('[RemoteSigner] The identity core refused to mark the job sent:', reasonOf(err) || err?.code);
      return { allowed: false };
    }
    return { allowed: pendingJobs.get(payload.jobId) === job };
  });
}

// ---- the identity core's jobs (design 0012, PHN-2) ----

function coreBackend() {
  return require('../../core/vault-backend').vaultBackend;
}

const reasonOf = (err) => (typeof err?.data?.reason === 'string' ? err.data.reason : null);

/** The core's refusal of `phone.job`: nothing went to the phone. */
function jobRefusal(err) {
  if (err?.code === 'busy') return createRemoteError(REMOTE_ERROR_CODES.BUSY);
  if (err?.code === 'not_authorized' || err?.code === 'forbidden') {
    return require('../signing-confirmation').confirmationError(err);
  }
  return err;
}

/**
 * `phone.result`'s `error`, as the core takes it: `{ rpc_code?, code?,
 * message? }`, each only in its own JSON type, so a malformed renderer
 * report is still the phone's answer (unknown, for a payment that may have
 * gone), never a refusal of the request.
 */
function coreErrorOf(error) {
  const out = {};
  if (Number.isSafeInteger(error?.rpcCode)) out.rpc_code = error.rpcCode;
  if (typeof error?.code === 'string') out.code = error.code;
  if (typeof error?.message === 'string') out.message = error.message;
  return out;
}

/**
 * The rejection a core refusal of an answer stands for. A payment's hash
 * the core saw and refused (another sender, recipient, amount, data or
 * chain) says the phone sent something (`phoneSent`), with what it sent
 * (`transaction`), never the confirmed payment.
 */
function answerRefusal(job, err) {
  const reason = reasonOf(err);
  const payment = job.method === PAYMENT_METHOD;
  let refused;
  if (reason === 'wrong_account' || reason === 'wrong_transaction') {
    refused = createRemoteError(
      reason === 'wrong_account' ? REMOTE_ERROR_CODES.WRONG_ACCOUNT : REMOTE_ERROR_CODES.WRONG_TRANSACTION
    );
    if (payment) refused.phoneSent = true;
    if (err.data?.transaction && typeof err.data.transaction === 'object') refused.transaction = err.data.transaction;
  } else if (reason === 'bad_response') {
    refused = createRemoteError(REMOTE_ERROR_CODES.BAD_RESPONSE);
  } else if (reason === 'expired') {
    refused = createRemoteError(
      err.data?.outcome === 'unknown' || paymentMayHaveLeft(job)
        ? REMOTE_ERROR_CODES.OUTCOME_UNKNOWN
        : REMOTE_ERROR_CODES.TIMEOUT
    );
  } else {
    // A settled or unknown job, the core gone, a malformed request: no
    // answer the core took. A payment that may have left stays unknown.
    console.warn('[RemoteSigner] The identity core took no answer for the job:', reason || err?.code);
    refused = createRemoteError(
      paymentMayHaveLeft(job) ? REMOTE_ERROR_CODES.OUTCOME_UNKNOWN : REMOTE_ERROR_CODES.UNKNOWN
    );
  }
  return markDelivery(refused, job);
}

/**
 * What the core's `phone.result` reply resolves or rejects: a signature
 * (`{ signature }`); a payment's hash with its outcome (`verified`, with
 * `rule` when a flagged send's "Always allow" was written; `unverified`,
 * its record saved; `unknown` with `durable: false`, its record not saved)
 * and the job's id, for the payment's later `phone.checked`; or the
 * phone's refusal (`failed`), or an answer that shows nothing (`unknown`).
 */
function settleCoreReply(jobId, job, reply, { resolve, reject }) {
  if (typeof reply?.signature === 'string') {
    resolve(reply.signature);
    return;
  }
  const outcome = reply?.outcome;
  if ((outcome === 'verified' || outcome === 'unverified' || outcome === 'unknown') && typeof reply.hash === 'string') {
    resolve({
      hash: reply.hash,
      outcome,
      job: jobId,
      ...(reply.rule && typeof reply.rule === 'object' ? { rule: reply.rule } : {}),
      ...(reply.durable === false ? { durable: false } : {}),
    });
    return;
  }
  if (outcome === 'failed') {
    reject(markDelivery(createRemoteError(reply.code, typeof reply.message === 'string' ? reply.message : undefined), job));
    return;
  }
  // `unknown` with no hash: an error after the request went, or an answer
  // that isn't a hash. The payment may have been sent.
  reject(markDelivery(createRemoteError(REMOTE_ERROR_CODES.OUTCOME_UNKNOWN, UNREADABLE_ANSWER), job));
}

/**
 * The chrome's answer to a core job, from `sender` (main checked it is the
 * job's webContents): sent to the core, which checks it again and judges
 * it. Main's job is settled by the core's reply, so a second answer while
 * the first is with the core is ignored; a `wrong_sender` refusal leaves
 * the job open for its own chrome, as the core leaves it.
 */
function answerCoreJob(jobId, job, sender, { result, error }) {
  if (job.answering) return;
  job.answering = true;
  const params = { job: jobId, sender };
  if (error) params.error = coreErrorOf(error);
  else params.result = result === undefined ? null : result;
  coreBackend()
    .phone.result(params)
    .then(
      (reply) => settleJob(jobId, (settled) => settleCoreReply(jobId, settled, reply, settled)),
      (err) => {
        if (reasonOf(err) === 'wrong_sender') {
          job.answering = false;
          return;
        }
        settleJob(jobId, ({ reject }) => reject(answerRefusal(job, err)));
      }
    );
}

/**
 * Main's own end of a core job (its timeout, a window gone, the caller's
 * last check refusing before the relay): told to the core as main's own
 * (`shell`), whose reply decides the rejection; main's own mapping if the
 * core can't be asked.
 */
async function endCoreJob(jobId, job, code) {
  let reply;
  try {
    reply = await coreBackend().phone.result({ job: jobId, sender: job.webContents.id, error: { code } }, null);
  } catch (err) {
    return answerRefusal(job, err);
  }
  if (reply?.outcome === 'failed') {
    return markDelivery(createRemoteError(reply.code, typeof reply.message === 'string' ? reply.message : undefined), job);
  }
  return markDelivery(
    createRemoteError(paymentMayHaveLeft(job) || reply?.outcome === 'unknown' ? REMOTE_ERROR_CODES.OUTCOME_UNKNOWN : code),
    job
  );
}

/**
 * A phone account's signature or payment, as an identity core job: the
 * core checks `authorization` (or takes main's own on its word, with none)
 * and opens the job for the target window's chrome; main relays the core's
 * request and returns the core's judgement of the answer.
 *
 * @param {{walletIndex: number, address: string, method: 'message'|'typed_data'|'transaction',
 *   payload: object, authorization?: object, page?: object|null, chain?: object, purpose?: string,
 *   beforeRelay?: () => Promise<void>}} request - `payload` is the `sign.*` method's params
 *   without the key; `beforeRelay`, the caller's last check, awaited after the core opened the
 *   job, right before the request goes to the chrome
 * @param {number} [timeoutMs] - main's backstop; the core's own life is the bound
 * @returns {Promise<string|{hash: string, outcome: string, job: string, rule?: object, durable?: false}>}
 *   a signature, or a payment's hash and outcome
 */
async function requestPhoneJob(request, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const win = getTargetWindow();
  if (!win || win.webContents.isDestroyed()) {
    throw markDelivery(createRemoteError(REMOTE_ERROR_CODES.NO_UI));
  }
  const { walletIndex, address, method, payload, authorization, page = null, chain, purpose, beforeRelay } = request;
  const params = { account: walletIndex, address, method, payload, target: win.webContents.id };
  if (authorization) params.authorization = authorization;
  let opened;
  try {
    opened = await coreBackend().phone.job(params, page);
  } catch (err) {
    throw markDelivery(jobRefusal(err));
  }
  const jobId = opened.job;
  const job = {
    core: true,
    answering: false,
    webContents: win.webContents,
    method: opened.request?.method,
    requestSent: false,
  };
  const ended = async (code, cause = null) => {
    const err = await endCoreJob(jobId, job, code);
    throw cause || err;
  };
  if (beforeRelay) {
    try {
      await beforeRelay();
    } catch (err) {
      return ended(REMOTE_ERROR_CODES.USER_CANCELLED, err);
    }
  }
  if (win.webContents.isDestroyed()) return ended(REMOTE_ERROR_CODES.NO_UI);
  const life = Number(opened.expires_in_ms);
  const wait = Number.isFinite(life) && life > 0 ? Math.min(timeoutMs, life) : timeoutMs;
  return new Promise((resolve, reject) => {
    job.resolve = resolve;
    job.reject = reject;
    job.timer = setTimeout(() => {
      // An answer already with the core decides.
      if (job.answering) return;
      settleJob(jobId, (settled) => {
        if (!settled.webContents.isDestroyed()) settled.webContents.send('remote-signer:abort', { jobId });
        endCoreJob(jobId, settled, REMOTE_ERROR_CODES.TIMEOUT).then(reject);
      });
    }, wait);
    pendingJobs.set(jobId, job);
    win.webContents.send('remote-signer:request', {
      jobId,
      walletIndex,
      address,
      method: opened.request?.method,
      params: opened.request?.params,
      ...(chain ? { chain } : {}),
      ...(purpose ? { purpose } : {}),
    });
  });
}

module.exports = { requestPhoneJob, requestRemoteSignature, registerRemoteSignerIpc };
