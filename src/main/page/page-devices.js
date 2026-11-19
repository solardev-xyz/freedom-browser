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
 *   - **A Ledger** (`ledger`): the token is spent through the core
 *     (`approval.spend`, under `page` with the request's PageContext), and
 *     the device asked only after. A typed-data request is hashed by the
 *     core again first, and must hash to the `expected_hash` the token
 *     bound (`signers.js`).
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
 * The token is a bearer secret: it goes only to the core's spend, is never
 * logged or put in an error, and never reaches a renderer. Main discards it
 * once the step ends, spent or not.
 */

const INTERNAL_ERROR_CODE = -32603;
const NO_ADDRESS = Object.freeze({ code: 4100, message: 'This page has no address to connect from yet' });
const USER_REJECTED = Object.freeze({ code: 4001, message: 'User rejected the request' });
// A device's own "declined" is the user's rejection.
const DEVICE_REJECTIONS = new Set(['LEDGER_USER_REJECTED', 'REMOTE_USER_REJECTED', 'REMOTE_USER_CANCELLED']);

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

  // A Ledger's or a phone's signature, with the core's token.
  async function deviceSignature(context, device, confirmation) {
    const signer = getSigner(device.account, { confirmation });
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
   * main sent the request under.
   *
   * @returns {Promise<{result: string}|{error: object}>}
   */
  async function sign(context, device, page) {
    const { token } = device;
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
        signature = await deviceSignature(context, device, confirmation);
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
