'use strict';

/**
 * Main's device steps for the identity core's `{ device }` answers
 * (freedom-core design 0012, APR-5d-2; step APB-4b).
 *
 * The core can't make a Ledger's, a phone's or a Safe's signature (until
 * 0016). For a page's signature from one of those accounts it shows its own
 * `eth.sign` prompt through main, mints the page-kind token for the
 * request's document and the approve's handle, and answers
 * `eip1193.request` with `{ device: { type, kind, account, payload,
 * expected_hash?, handle, token } }` for main to spend as before:
 *
 *   - **A Ledger** (`ledger`): on the core's Ledger backend
 *     (FREEDOM_LEDGER_BACKEND=core; freedom-core design 0016, D8 and
 *     "Approvals: enforced"; the LDG-3 plan's point 10), the token is
 *     presented to `sign.message` or `sign.typed_data` with the Ledger key,
 *     under `page` with the request's PageContext, as a vault account's
 *     signature presents its own: the core spends it as it is presented,
 *     before the first APDU, and signs on its device lane, whose APDUs
 *     main's relay carries to the device (`signers.js`
 *     `createCoreLedgerBackend`). `eip1193.request` itself never drives
 *     the device (L6 is a later step, and main declares no hello field for
 *     it). On the JS backend the token is spent through the core first
 *     (`approval.spend`, under `page` with the request's PageContext), and
 *     the device asked only after. Either way, a typed-data request must
 *     hash to the `expected_hash` the token bound, or nothing is signed
 *     (`signers.js`).
 *   - **A phone** (`remote`): the token goes with the core's job
 *     (`phone.job`, PHN-2), which spends it, and the core checks the phone's
 *     answer against what the job bound.
 *   - **A Safe** (`safe`, `safe-message`): the token is spent for the Safe
 *     approval its owners present, and the message's session runs as
 *     before: the vault owners sign at once, and a device owner's signature
 *     goes through the Safe's board.
 *
 * Each presents the core's `payload` unchanged, so the spend binds what the
 * core bound for the request. After a device signs, main checks the
 * document's name again itself (a DNS name over IPNS) and that it still
 * holds its key, and withholds the signature otherwise.
 *
 * For an approve the Agent's sheet gave, in a tab it holds (design 0012,
 * "The Agent's answer", A7-6), main also checks that the Agent still holds
 * the tab, where the agent's own route checked it: before the token is
 * presented, and as the signer's last step, right before the device is
 * asked (`beforeSign`). A Safe's is never the sheet's (A7-3).
 *
 * The token is a bearer secret: it goes only to the core (its spend, or a
 * Ledger's `sign.*` on the core's backend), is never logged or put in an
 * error, and never reaches a renderer. Main discards it
 * once the step ends, spent or not.
 *
 * On the core's Ledger backend a Ledger's signature can be cancelled
 * (freedom-core design 0016, "Deadlines, cancel and unplugging", deviation
 * `cancel`; LDG-3's PR 10): the step says so as it starts
 * (`context.deviceWait()`, so the surface that approved it keeps Reject),
 * and signs with the request's `signal`, which aborts once main answers
 * the request (that Reject, its document gone, its deadline): main then
 * cancels the core's `sign.*` and the relay lets go of the device. The
 * page hears a rejection, as for the device's own.
 */

const INTERNAL_ERROR_CODE = -32603;
const NO_ADDRESS = Object.freeze({ code: 4100, message: 'This page has no address to connect from yet' });
const USER_REJECTED = Object.freeze({ code: 4001, message: 'User rejected the request' });
// A device's own "declined" is the user's rejection, and so is their
// Cancel while a Ledger waits (LEDGER_CANCELLED).
const DEVICE_REJECTIONS = new Set([
  'LEDGER_USER_REJECTED',
  'LEDGER_CANCELLED',
  'REMOTE_USER_REJECTED',
  'REMOTE_USER_CANCELLED',
]);
// Custody ended after the sheet's approve (A7-6), in the agent route's words.
const CUSTODY_LOST = 'Signing was not confirmed: the Agent no longer holds this tab';

const error = (base) => ({ error: { ...base } });

function failure(err, fallback = 'Signing failed') {
  if (DEVICE_REJECTIONS.has(err?.code)) return error(USER_REJECTED);
  const message = typeof err?.message === 'string' && err.message ? err.message : fallback;
  return { error: { code: INTERNAL_ERROR_CODE, message } };
}

function defaultDeviceDependencies() {
  return {
    walletList: async () => require('../identity-manager').getDerivedWallets(),
    getSigner: (walletIndex, authorized) => require('../wallet/signers').getSigner(walletIndex, authorized),
    // A Safe message's token, spent through the identity core (design 0012).
    spendSafe: (confirmation) => require('../wallet/signing-confirmation').spendSafeConfirmation(confirmation),
    discardToken: (token) => require('../wallet/signing-confirmation').discardConfirmation(token),
    startSafeMessage: (options) => require('../wallet/safe/safe-messages').startSafeMessage(options),
    completeSafeMessage: (safeIndex, token) => require('../wallet/safe/safe-messages').completeSafeMessage(safeIndex, token),
    cancelSafeMessage: (safeIndex, token) => require('../wallet/safe/safe-messages').cancelSafeMessage(safeIndex, token),
    // The boards main runs in the approvals document (APS-3b).
    safeBoards: () => require('../approvals/safe-boards').getSafeBoards(),
    // Whether a Ledger's wait can be cancelled: the core's Ledger backend.
    ledgerCancels: () => require('../wallet/ledger/ledger-backend-kind').ledgerBackendKind() === 'core',
  };
}

/**
 * @param {object} [deps] injected for tests; each defaults to main's own.
 */
function createDeviceSigning(deps = {}) {
  const {
    walletList,
    getSigner,
    spendSafe,
    discardToken,
    startSafeMessage,
    completeSafeMessage,
    cancelSafeMessage,
    safeBoards,
    ledgerCancels,
  } = { ...defaultDeviceDependencies(), ...deps };

  const discard = (token) => {
    try {
      Promise.resolve(discardToken(token)).catch(() => {});
    } catch {
      // Burnt by the core at its life's end all the same.
    }
  };

  // The document still answers its key: a DNS name over IPNS resolved
  // again, and the key held in the same run.
  async function documentHolds(context) {
    return (await context.nameHolds({ keyless: error(NO_ADDRESS) })) && context.holdsKey();
  }

  // The account as main lists it now, of the device type the core named.
  async function deviceAccount(account, type) {
    let listed;
    try {
      listed = await walletList();
    } catch {
      listed = [];
    }
    const found = Array.isArray(listed) ? listed.find((candidate) => candidate?.index === account) : null;
    return found && found.type === type ? found : null;
  }

  // A Ledger's or a phone's signature, with the core's token (presented to
  // the core's `sign.*` for a Ledger on the core's backend, spent first on
  // the JS one), and the caller's last check, if any, right before the
  // device is asked.
  async function deviceSignature(context, device, confirmation, beforeSign) {
    const authorized = beforeSign ? { confirmation, beforeSign } : { confirmation };
    // A Ledger on the core's backend: cancellable until main answers the
    // request, whose signal is main's own cancel of the core's `sign.*`.
    if (device.type === 'ledger' && ledgerCancels()) {
      context.deviceWait?.();
      authorized.signal = context.signal;
    }
    const signer = getSigner(device.account, authorized);
    if (device.kind === 'sign-message') return signer.signMessage(device.payload.message);
    // The page's typed data, which the core hashes again: it must hash to
    // what the token bound, or nothing is spent or signed.
    return signer.signTypedData(context.params?.[1], { expectedHash: device.expectedHash });
  }

  /**
   * A Safe's message, on the Safe approval its token gave: a session main
   * owns, bound to the requester, whose vault owners sign at once. A Safe
   * that needs a device owner's signature shows its board (`eth.safe_message`,
   * or main's board in the approvals document), and main completes the
   * session on its approval. Cancelled if the request ends any other way.
   */
  async function safeMessage(context, device, approval) {
    const { requester } = context;
    const { method, params } = device.payload;
    const safeIndex = device.account;
    let state;
    try {
      state = await startSafeMessage({
        safeIndex,
        request: { method, params },
        display: { kind: 'message', site: requester.key, method },
        requester: { origin: requester.key, webContentsId: requester.guest },
        owner: 'main',
        approval,
      });
    } catch (err) {
      return failure(err);
    }
    const sessionToken = state?.token;
    let completed = false;
    try {
      if (!state?.complete && context.approvalsDocument) {
        const boards = safeBoards();
        if (!boards) return error(USER_REJECTED);
        const board = await boards.runMessageBoard(context, { safeIndex, token: sessionToken });
        if (board.error) return { error: board.error };
        if (board.outcome !== 'complete') return error(USER_REJECTED);
      } else if (!state?.complete) {
        const board = await context.prompt({
          kind: 'eth.safe_message',
          view: { safeIndex, state },
          choices: (raw) => (Object.keys(raw).length === 0 ? {} : null),
        });
        if (board.error) return { error: board.error };
        if (board.closed || board.approve !== true) return error(USER_REJECTED);
      }
      // The signature goes to the page only while the name holds and the
      // document keeps its key.
      if (!(await documentHolds(context))) return error(NO_ADDRESS);
      let signature;
      try {
        ({ signature } = await completeSafeMessage(safeIndex, sessionToken));
      } catch (err) {
        return failure(err);
      }
      completed = true;
      return { result: signature };
    } finally {
      if (!completed) {
        try {
          await cancelSafeMessage(safeIndex, sessionToken);
        } catch {
          // A device step still running: its approval ended, the session
          // goes with its page.
        }
      }
    }
  }

  /**
   * Answer the page from the device, for a `{ device }` the relay checked
   * against its request (`page-eip1193.js`): `{ type, kind, account,
   * payload, expectedHash?, handle, token }`, and `page`, the PageContext
   * main sent the request under. `agent`: the Agent's sheet approved it, so
   * custody is checked again (A7-6).
   *
   * @returns {Promise<{result: string}|{error: object}>}
   */
  async function sign(context, device, page, { agent = false } = {}) {
    const { token } = device;
    // The Agent still holds the tab, read now; unknown counts as lost.
    const held = () => {
      let holds;
      try {
        holds = context.pageContext().agent === true;
      } catch {
        holds = false;
      }
      if (!holds) throw new Error(CUSTODY_LOST);
    };
    // The token as `signers.js` and the Safe's spend present it.
    const confirmation = {
      token,
      kind: device.kind,
      account: device.account,
      payload: device.payload,
      handle: device.handle,
      page,
    };
    try {
      if (!(await deviceAccount(device.account, device.type))) {
        return { error: { code: INTERNAL_ERROR_CODE, message: 'The connected account is no longer available' } };
      }
      if (agent) {
        try {
          held();
        } catch (err) {
          return failure(err);
        }
      }
      context.traceCoreToken?.('spent', device.kind);
      if (device.type === 'safe') {
        let approval;
        try {
          ({ approval } = await spendSafe(confirmation));
        } catch (err) {
          return failure(err);
        }
        if (!approval) return failure(new Error('The identity core gave no Safe approval'));
        return await safeMessage(context, device, approval);
      }
      let signature;
      try {
        signature = await deviceSignature(context, device, confirmation, agent ? async () => held() : null);
      } catch (err) {
        return failure(err);
      }
      // After the device's wait: the name again. A name that moved gets no
      // signature.
      if (!(await documentHolds(context))) return error(NO_ADDRESS);
      return { result: signature };
    } finally {
      // Spent at its presentation; one a request ended before is burnt.
      discard(token);
    }
  }

  return { sign, discard };
}

module.exports = { createDeviceSigning };
