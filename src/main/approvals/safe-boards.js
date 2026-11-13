'use strict';

/**
 * The Safe signing boards in the approvals document (freedom-core design
 * 0011, "The approvals document"; step APS-3b), with the approvals
 * document on (the default; FREEDOM_APPROVALS_DOCUMENT=0 turns it off).
 *
 * Three boards collect a Safe's owner signatures:
 *
 *   eth.safe_message   a page's Safe message, after the user approved the
 *                      Safe's `eth.sign` (or the site's rule answered);
 *   eth.safe_send      a page's Safe send, after the user approved its
 *                      `eth.send`;
 *   wallet.safe_board  the wallet's own SafeTx: after its `wallet.safe_send`
 *                      approval, or a parked one taken up again.
 *
 * With the document on, main runs each board as a loop and the chrome
 * renders none of them. Each turn main reads its own state of the session
 * or the SafeTx and shows the board in the window's panel with main's view
 * of it: the Safe, the threshold, the signatures collected, the owners
 * (with main's names for them), the SafeTx main holds (a send's) or the
 * method (a message's), and the executor. The message session's token, a
 * capability for the `wallet:safe-message-*` IPC, never goes into a view.
 *
 * The user picks one choice and presses Approve: an owner to sign with, or
 * (a send) discarding the SafeTx, which asks again before it discards.
 * Main does it, and shows the board again with the new state. A Ledger or a
 * phone owner shows the panel's device wait while main signs: the
 * decision's invocation is answered (`released`) only once the step is
 * done. A locked vault asks for its unlock in the panel. Reject leaves the
 * board: a send's SafeTx waits (parked, as before), a message is cancelled.
 *
 * Once the threshold is met, main completes a message (the caller,
 * `page-signing.js`) or executes a send. An executor's fee the fee check
 * stops for is asked in the panel as `wallet.executor_send`, from the offer
 * main itself made, and asked again above the threshold
 * (`wallet-approvals.js`). A failed execution shows the board with the
 * reason and a "try again" choice; a SafeTx another transaction superseded
 * offers only its discard.
 *
 * A send's board is bound to one SafeTx (its hash): the one its page's
 * request started, or (the wallet's) the one pending when it opens. Each
 * turn reads that entry's state and SafeTx together, and each step after a
 * wait (a signature, a discard, an execution) names it, in the same run as
 * the step (`safe-transactions.js` refuses another). Once another SafeTx,
 * or none, is pending, the board ends (`gone`): a choice made on one SafeTx
 * never acts on another.
 *
 * The wallet's board lives as long as its window. Closed during a device's
 * or the unlock's wait, the board ends there: nothing more is asked or
 * executed. A signature the device returns meanwhile is kept, on the SafeTx
 * it was made for, which waits (parked) as after Reject.
 *
 * A board's decision mints nothing (`page-requests.js`): the Safe's request
 * was approved, and its one token minted, before the board opened.
 */

const BOARD_KINDS = Object.freeze({
  MESSAGE: 'eth.safe_message',
  SEND: 'eth.safe_send',
  WALLET: 'wallet.safe_board',
});
const BOARD_KIND_SET = new Set(Object.values(BOARD_KINDS));

// What a board shows: the owners to sign with, an execution to try again,
// a superseded SafeTx's discard, or a discard to confirm.
const STEPS = Object.freeze({ COLLECT: 'collect', RETRY: 'retry', SUPERSEDED: 'superseded', DISCARD: 'discard' });

// A device's own "declined" is a row's note; a closed QR is no note at all.
const DECLINED = new Set(['LEDGER_USER_REJECTED', 'REMOTE_USER_REJECTED']);
const QUIET = new Set(['REMOTE_USER_CANCELLED']);
const FEE_CHECK_NEEDS_CONFIRMATION = 'FEE_CHECK_NEEDS_CONFIRMATION';
const SAFE_NEEDS_FUNDS = 'SAFE_NEEDS_FUNDS';
// Another SafeTx (or none) pending than the one the step names.
const SAFE_DISCARDED = 'SAFE_DISCARDED';
// The most of main's own error message a view carries.
const MAX_MESSAGE = 300;

const noChoices = (raw) => (Object.keys(raw).length === 0 ? {} : null);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const messageOf = (err) =>
  typeof err?.message === 'string' && err.message.length > 0 ? err.message.slice(0, MAX_MESSAGE) : null;

const approved = (decision) => decision?.approve === true;

/**
 * What a board's decision may choose, for the view main shows: an unsigned
 * owner of that view to sign with, its execution tried again, or (a send's)
 * discard. Anything else is refused, and the prompt stays.
 */
function boardChoices(board, view) {
  const unsigned = new Set(view.owners.filter((owner) => !owner.signed).map((owner) => owner.index));
  return (raw) => {
    if (!isPlainObject(raw)) return null;
    const keys = Object.keys(raw);
    if (raw.action === 'sign') {
      return view.step === STEPS.COLLECT &&
        keys.length === 2 &&
        keys.includes('owner') &&
        Number.isSafeInteger(raw.owner) &&
        unsigned.has(raw.owner)
        ? { action: 'sign', owner: raw.owner }
        : null;
    }
    if (keys.length !== 1) return null;
    if (raw.action === 'retry') return view.step === STEPS.RETRY ? { action: 'retry' } : null;
    if (raw.action === 'discard') return board === 'send' ? { action: 'discard' } : null;
    return null;
  };
}

// Whether window `windowId` is open: then `onClosed` runs once it closes,
// until the returned stop is called. Null for a window already closed.
function defaultWatchWindow(windowId, onClosed) {
  const { BrowserWindow } = require('electron');
  const win = BrowserWindow.fromId(windowId);
  if (!win || win.isDestroyed()) return null;
  win.once('closed', onClosed);
  return () => {
    try {
      win.removeListener('closed', onClosed);
    } catch {
      // Gone with its window.
    }
  };
}

/**
 * @param {object} deps
 * @param {() => Promise<object[]>} deps.getDerivedWallets main's wallet list.
 * @param {(chainId: number) => string|null} [deps.chainName]
 * @param {(chainId: number) => string|null} [deps.nativeSymbol]
 * @param {object} deps.sends `{ state(i), sign(i, owner?, safeTxHash), execute(i, options),
 *   cancel(i, safeTxHash), tx(i, safeTxHash) }` (`safe-transactions.js`): `state` and `tx` read
 *   synchronously, `tx` the SafeTx main holds while it is `safeTxHash`'s; `sign`, `cancel` and
 *   `execute` (`options.safeTxHash`) refuse another SafeTx with SAFE_DISCARDED.
 * @param {object} deps.messages `{ state(i, token), sign(i, owner?, token) }` (`safe-messages.js`).
 * @param {(err: Error) => boolean} [deps.isVaultLocked]
 * @param {(windowId: number, spec: object) => Promise<object>} deps.walletPrompt
 *   a window's own prompt (`page-requests.js`).
 * @param {(windowId: number, view: object) => Promise<object>} deps.walletUnlock
 *   a window's own vault unlock (`page-requests.js`).
 * @param {(windowId: number, offer: object) => Promise<object|null>} deps.confirmExecutorFee
 *   the executor's fee asked in the panel: the fee confirmation, or null.
 * @param {(tx: object) => object|null} [deps.transferOf]
 * @param {(windowId: number, onClosed: Function) => (Function|null)} [deps.watchWindow]
 *   a window's close heard, until the stop it returns; null for a window closed already.
 */
function createSafeBoards({
  getDerivedWallets,
  chainName = () => null,
  nativeSymbol = () => null,
  sends,
  messages,
  isVaultLocked = (err) => err?.code === 'VAULT_LOCKED',
  walletPrompt,
  walletUnlock,
  confirmExecutorFee,
  transferOf = () => null,
  watchWindow = defaultWatchWindow,
}) {
  // The Safes whose wallet board is open: one at a time each.
  const walletBoards = new Set();

  async function walletsByIndex() {
    let list;
    try {
      list = await getDerivedWallets();
    } catch {
      list = null;
    }
    const byIndex = new Map();
    for (const wallet of Array.isArray(list) ? list : []) {
      if (Number.isSafeInteger(wallet?.index)) byIndex.set(wallet.index, wallet);
    }
    return byIndex;
  }

  const nameOf = (wallets, index) => {
    const name = wallets.get(index)?.name;
    return typeof name === 'string' ? name : '';
  };
  const addressOf = (value) => (typeof value === 'string' ? value : null);

  function accountOf(wallets, index) {
    return { index, name: nameOf(wallets, index), address: addressOf(wallets.get(index)?.address) };
  }

  function chainOf(chainId) {
    let name;
    let symbol;
    try {
      name = chainName(chainId) || null;
    } catch {
      name = null;
    }
    try {
      symbol = nativeSymbol(chainId) || null;
    } catch {
      symbol = null;
    }
    return { id: chainId, name, symbol: symbol || 'xDAI' };
  }

  function decimal(value) {
    try {
      const n = BigInt(value ?? 0);
      return n < 0n ? '0' : n.toString();
    } catch {
      return '0';
    }
  }

  // The SafeTx main holds, as it executes it.
  function txOf(source) {
    const data = typeof source?.data === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(source.data) ? source.data.toLowerCase() : '0x';
    return { to: typeof source?.to === 'string' ? source.to : '', value: decimal(source?.value), data };
  }

  /** Main's view of a board: no token, nothing the chrome said. */
  async function viewOf(board, safeIndex, state, { step, notes, error }) {
    const wallets = await walletsByIndex();
    const view = {
      safe: accountOf(wallets, safeIndex),
      threshold: state.threshold,
      collected: state.collected,
      owners: (Array.isArray(state.owners) ? state.owners : []).map((owner) => ({
        index: owner.index,
        name: nameOf(wallets, owner.index),
        address: addressOf(owner.address),
        type: typeof owner.type === 'string' ? owner.type : 'mnemonic',
        signed: owner.signed === true,
      })),
      notes: [...notes].map(([owner, note]) => ({ owner, note: note.note, message: note.message })),
      step,
      error,
    };
    if (board === 'message') {
      view.method = state.display?.method === 'personal_sign' ? 'personal_sign' : 'eth_signTypedData_v4';
      return view;
    }
    // Read with the state, from the same entry (`runBoard`).
    const tx = txOf(state.tx);
    let transfer;
    try {
      transfer = transferOf(tx) || null;
    } catch {
      transfer = null;
    }
    view.chain = chainOf(state.chainId);
    view.tx = tx;
    view.transfer = transfer;
    view.executor = Number.isSafeInteger(state.executorIndex) ? accountOf(wallets, state.executorIndex) : null;
    return view;
  }

  /**
   * One board, from its first view to its end. `ask({ view, choices,
   * released })` shows the board and settles with the decision; `unlock`
   * asks for the vault unlocked and resolves whether it is; `confirmFee`
   * asks for the executor's fee. Resolves with the board's outcome:
   * `complete` (a message whose threshold is met), `executed`, `parked`,
   * `discarded`, `rejected` (a message), `closed`, `gone` (nothing left to
   * show, or another SafeTx pending than the board's), or `{ error }`.
   * `safeTxHash` binds a send's board to that SafeTx; without it, to the
   * one pending as it opens. `signal`, aborted, ends the board after the
   * wait it is in (`closed`).
   */
  async function runBoard(board, { safeIndex, safeTxHash = null, token = null, ask, unlock, confirmFee, signal = null }) {
    // The SafeTx a send's board shows and acts on, once known.
    let bound = board === 'message' || typeof safeTxHash !== 'string' ? null : safeTxHash;
    // A send's state and the SafeTx it shows, read in one run from the
    // board's entry: null once another one, or none, is pending.
    const sendState = () => {
      const state = sends.state(safeIndex);
      if (!state || typeof state.safeTxHash !== 'string') return null;
      if (bound === null) bound = state.safeTxHash;
      if (state.safeTxHash !== bound) return null;
      const tx = sends.tx(safeIndex, bound);
      return tx ? { ...state, tx } : null;
    };
    const api =
      board === 'message'
        ? {
            state: () => messages.state(safeIndex, token),
            sign: (owner) => messages.sign(safeIndex, owner, token),
          }
        : { state: sendState, sign: (owner) => sends.sign(safeIndex, owner, bound) };
    // After each wait: the window closed (the wallet's board), or the
    // board's SafeTx no longer the one pending, ends the board.
    const ended = () => {
      if (signal?.aborted === true) return { outcome: 'closed', reason: 'closed' };
      if (board === 'message') return null;
      let current;
      try {
        current = sends.state(safeIndex)?.safeTxHash;
      } catch {
        current = null;
      }
      return bound !== null && current === bound ? null : { outcome: 'gone' };
    };
    const notes = new Map(); // owner index -> { note, message }
    let error = null; // { code, message }: why the last execution didn't land
    let confirming = false; // a send's discard, asked again
    let feeConfirmation = null;
    // The last decision's invocation, answered once what it started is done.
    let release = () => {};
    const releasePrevious = () => {
      const done = release;
      release = () => {};
      done();
    };
    const readState = async () => {
      try {
        return (await api.state()) || null;
      } catch {
        return null;
      }
    };

    async function signOwner(owner) {
      notes.delete(owner);
      for (let attempt = 0; ; attempt += 1) {
        try {
          await api.sign(owner);
          return;
        } catch (err) {
          // Not the board's SafeTx: the next turn ends the board.
          if (err?.code === SAFE_DISCARDED) return;
          if (attempt === 0 && isVaultLocked(err)) {
            releasePrevious();
            if (await unlock('sign')) {
              if (ended()) return;
              continue;
            }
            notes.set(owner, { note: 'locked', message: null });
            return;
          }
          if (DECLINED.has(err?.code)) notes.set(owner, { note: 'declined', message: null });
          else if (!QUIET.has(err?.code)) notes.set(owner, { note: 'failed', message: messageOf(err) });
          return;
        }
      }
    }

    // A send's execution: its outcome, or null to show the board again.
    async function execute() {
      releasePrevious();
      // The board's SafeTx, named in the same run as its execution.
      const end = ended();
      if (end) return end;
      const confirmation = feeConfirmation;
      feeConfirmation = null;
      let result;
      try {
        result = await sends.execute(safeIndex, {
          ...(confirmation ? { feeConfirmation: confirmation } : {}),
          safeTxHash: bound,
        });
      } catch (err) {
        if (err?.code === SAFE_DISCARDED) return { outcome: 'gone' };
        if (isVaultLocked(err)) {
          if (!(await unlock('send'))) error = { code: 'locked', message: null };
          return null;
        }
        if (err?.code === FEE_CHECK_NEEDS_CONFIRMATION && isPlainObject(err.offer)) {
          // Main's own offer, never the chrome's copy of it.
          let confirmed;
          try {
            confirmed = await confirmFee(err.offer);
          } catch {
            confirmed = null;
          }
          if (confirmed) feeConfirmation = confirmed;
          else error = { code: 'fee', message: null };
          return null;
        }
        error = { code: err?.code === SAFE_NEEDS_FUNDS ? 'needs-funds' : 'failed', message: messageOf(err) };
        return null;
      }
      if (result?.status === 'executed' && typeof result.executed?.hash === 'string') {
        return {
          outcome: 'executed',
          safeTxHash: result.safeTxHash,
          display: result.display,
          executed: { hash: result.executed.hash, explorerUrl: result.executed.explorerUrl ?? null },
        };
      }
      // Superseded: the board says so. Anything else is no execution.
      if (result?.status !== 'superseded') error = { code: 'failed', message: null };
      return null;
    }

    try {
      let state = await readState();
      // The sweep when a board opens: the free vault signatures.
      if (state && state.status !== 'superseded' && state.collected < state.threshold) {
        try {
          await api.sign(undefined);
        } catch {
          // A locked vault: its owners stay rows to sign.
        }
      }
      for (;;) {
        // The window closed during the last wait (a device's, the unlock's,
        // the fee's): nothing more is asked or executed.
        if (signal?.aborted === true) return { outcome: 'closed', reason: 'closed' };
        state = await readState();
        if (!state) return { outcome: 'gone' };
        const superseded = board !== 'message' && state.status === 'superseded';
        if (!superseded && !confirming && !error && state.collected >= state.threshold) {
          if (board === 'message') return { outcome: 'complete' };
          const done = await execute();
          if (done) return done;
          continue;
        }
        const step = confirming
          ? STEPS.DISCARD
          : superseded
            ? STEPS.SUPERSEDED
            : error
              ? STEPS.RETRY
              : STEPS.COLLECT;
        const view = await viewOf(board, safeIndex, state, { step, notes, error });
        const stale = ended();
        if (stale) return stale;
        let releaseThis;
        const released = new Promise((resolve) => {
          releaseThis = resolve;
        });
        // Shown first, then the last decision answered: the panel goes from
        // one board to the next without closing between them.
        const pending = ask({ view, choices: boardChoices(board, view), released });
        releasePrevious();
        release = releaseThis;
        const decision = await pending;
        if (decision?.error) return { error: decision.error };
        if (decision?.closed) return { outcome: 'closed', reason: decision.closed };
        // A choice on the SafeTx shown, and only while it is still pending.
        const end = ended();
        if (end) return end;
        if (!approved(decision)) {
          if (confirming) {
            // "Keep": back to the board.
            confirming = false;
            continue;
          }
          return { outcome: board === 'message' ? 'rejected' : 'parked' };
        }
        const choice = decision.choices || {};
        if (choice.action === 'discard') {
          if (!confirming) {
            confirming = true;
            continue;
          }
          confirming = false;
          try {
            sends.cancel(safeIndex, bound);
          } catch (err) {
            if (err?.code === SAFE_DISCARDED) return { outcome: 'gone' };
            error = { code: 'failed', message: messageOf(err) };
            continue;
          }
          return { outcome: 'discarded', safeTxHash: bound };
        }
        confirming = false;
        if (choice.action === 'retry') {
          error = null;
          continue;
        }
        if (choice.action === 'sign') await signOwner(choice.owner);
      }
    } finally {
      releasePrevious();
    }
  }

  const unlockWith = (prompt) => async (reason) => {
    try {
      return approved(await prompt({ kind: 'vault.unlock', view: { reason }, choices: noChoices }));
    } catch {
      return false;
    }
  };

  /** A page's Safe message, its session `token` main's: `complete` once its owners have signed. */
  function runMessageBoard(context, { safeIndex, token }) {
    return runBoard('message', {
      safeIndex,
      token,
      ask: ({ view, choices, released }) => context.prompt({ kind: BOARD_KINDS.MESSAGE, view, choices, released }),
      unlock: unlockWith((spec) => context.prompt(spec)),
      confirmFee: async () => null,
    });
  }

  /**
   * A page's Safe send, the SafeTx `safeTxHash` its request started:
   * `executed`, `parked` or `discarded`, among others.
   */
  function runSendBoard(context, { safeIndex, safeTxHash }) {
    return runBoard('send', {
      safeIndex,
      safeTxHash,
      ask: ({ view, choices, released }) => context.prompt({ kind: BOARD_KINDS.SEND, view, choices, released }),
      unlock: unlockWith((spec) => context.prompt(spec)),
      confirmFee: (offer) => confirmExecutorFee(context.requester?.window, offer),
    });
  }

  /**
   * The wallet's own board for the Safe's pending SafeTx, in window
   * `windowId`'s panel: a window prompt, shown whichever tab is in front.
   * One at a time per Safe (`open` for another while it runs). It ends
   * when its window closes, whatever wait it is in.
   */
  async function openWalletBoard(windowId, safeIndex) {
    if (!Number.isInteger(windowId)) return { outcome: 'no-window' };
    if (!Number.isSafeInteger(safeIndex) || safeIndex < 0) return { outcome: 'gone' };
    if (walletBoards.has(safeIndex)) return { outcome: 'open' };
    const lifetime = new AbortController();
    let unwatch;
    try {
      unwatch = watchWindow(windowId, () => lifetime.abort());
    } catch {
      unwatch = null;
    }
    if (typeof unwatch !== 'function') return { outcome: 'no-window' };
    walletBoards.add(safeIndex);
    try {
      return await runBoard('send', {
        safeIndex,
        signal: lifetime.signal,
        ask: ({ view, choices, released }) =>
          walletPrompt(windowId, { kind: BOARD_KINDS.WALLET, view, choices, released }),
        unlock: async (reason) => {
          try {
            return approved(await walletUnlock(windowId, { reason }));
          } catch {
            return false;
          }
        },
        confirmFee: (offer) => confirmExecutorFee(windowId, offer),
      });
    } finally {
      walletBoards.delete(safeIndex);
      unwatch();
    }
  }

  return { runMessageBoard, runSendBoard, openWalletBoard, viewOf, boardChoices };
}

/**
 * The executor's fee, asked in window `windowId`'s panel as
 * `wallet.executor_send` (`wallet-approvals.js`): main's own offer, the
 * token minted on the user's approval there, and asked again above the
 * threshold. Resolves with the fee confirmation `executeSafePending` takes,
 * or null.
 */
async function confirmExecutorFee(windowId, offer) {
  const approvals = require('./wallet-approvals').getWalletApprovals();
  if (!approvals || !Number.isInteger(windowId) || !isPlainObject(offer)) return null;
  const signing = require('../wallet/signing-confirmation');
  const { executorIndex, ...payload } = offer;
  try {
    signing.bindingFor(signing.KINDS.EXECUTOR_SEND, executorIndex, payload);
  } catch {
    return null;
  }
  const outcome = await approvals.confirm(
    { windowId, kind: signing.KINDS.EXECUTOR_SEND, index: executorIndex, payload, feeChecked: true },
    () => signing.issueConfirmation(signing.KINDS.EXECUTOR_SEND, executorIndex, payload)
  );
  if (!outcome?.approved || typeof outcome.token !== 'string') return null;
  const fees =
    payload.maxFeePerGas != null && payload.maxPriorityFeePerGas != null
      ? { maxFeePerGas: payload.maxFeePerGas, maxPriorityFeePerGas: payload.maxPriorityFeePerGas }
      : { gasPrice: payload.gasPrice };
  return { confirmation: outcome.token, gasLimit: payload.gasLimit, fees };
}

let shared = null;

/** The app's one instance, or null while the approvals document is off. */
function getSafeBoards() {
  const { isApprovalsDocumentEnabled } = require('./approvals-document');
  if (!isApprovalsDocumentEnabled()) return null;
  if (!shared) {
    const registry = () => require('../networks/network-registry').getAllNetworks() || {};
    const transactions = () => require('../wallet/safe/safe-transactions');
    const safeMessages = () => require('../wallet/safe/safe-messages');
    const pageRequests = () => require('../page/page-requests').getPageRequests();
    shared = createSafeBoards({
      getDerivedWallets: () => require('../identity-manager').getDerivedWallets(),
      chainName: (chainId) => registry()?.[chainId]?.name ?? null,
      nativeSymbol: (chainId) => {
        const symbol = registry()?.[chainId]?.nativeSymbol;
        return typeof symbol === 'string' ? symbol : null;
      },
      sends: {
        state: (safeIndex) => transactions().getSafeSendState(safeIndex),
        sign: (safeIndex, owner, safeTxHash) => transactions().signSafePending(safeIndex, owner, { safeTxHash }),
        execute: (safeIndex, options) => transactions().executeSafePending(safeIndex, options),
        cancel: (safeIndex, safeTxHash) => transactions().cancelSafeSend(safeIndex, { safeTxHash }),
        tx: (safeIndex, safeTxHash) => {
          const pending = require('../wallet/safe/pending-store').getPending(safeIndex);
          return pending && pending.safeTxHash === safeTxHash ? (pending.safeTxData ?? null) : null;
        },
      },
      messages: {
        state: (safeIndex, token) => safeMessages().getSafeMessageState(safeIndex, token),
        sign: (safeIndex, owner, token) => safeMessages().signSafeMessage(safeIndex, owner, token),
      },
      isVaultLocked: (err) =>
        err?.code === 'VAULT_LOCKED' || require('../wallet/vault-errors').isVaultLockedError(err),
      walletPrompt: (windowId, spec) => pageRequests().walletPrompt(windowId, spec),
      walletUnlock: (windowId, view) => pageRequests().walletUnlock(windowId, view),
      confirmExecutorFee,
      transferOf: (tx) => require('./wallet-approvals').transferOf(tx),
    });
  }
  return shared;
}

module.exports = {
  BOARD_KINDS,
  BOARD_KIND_SET,
  STEPS,
  boardChoices,
  createSafeBoards,
  confirmExecutorFee,
  getSafeBoards,
};
