'use strict';

/**
 * Page requests: the channels between a tab's preload and main, the request
 * records and their handles, and delivery (freedom-core design 0011, "The
 * way in", "Requests and handles" and "Events"; step PRQ-2).
 *
 *   page:hello    preload -> main (send)    { nonce }
 *   page:reserve  preload -> main (invoke)  { nonce, method, bytes }
 *                                           -> { ticket } | { error }
 *   page:request  preload -> main (invoke)  { nonce, provider, method, params, ticket? }
 *                                           -> { result } | { error }
 *   page:event    main -> preload           { nonce, provider, event, data }
 *                 (WebFrameMain.send)
 *
 * A request that carries a ticket burns it on arrival, before any other
 * check. It is then refused, before anything runs, when its method has no
 * row in the closed method table (`page-methods.js`), when the table
 * refuses it, or when no dispatcher serves it; when the size walk
 * (`shared/page-request-bounds.js`) refuses it; or when it is over 1 MiB and
 * brings no ticket main holds. Then main attests the sender
 * (`page-documents.js`: a tab, not private, not a preview, the top frame,
 * the current document's nonce, the frame URL on the document's transport
 * key), checks a ticket's binding, and charges the request to its document,
 * its window and the browser (`page-budgets.js`). Only then does main record
 * it.
 *
 * Every record has main's deadline: today's page-world time limit for its
 * method, counted from its arrival in main, until its prompt shows
 * (`markShown`). At the deadline main answers "Request timed out", closes
 * the record's handle (`expired`) and drops any late result. A shown prompt
 * has no deadline.
 *
 * Main checks the document again before it answers, and answers nothing to a
 * document that has gone (`GONE`, which reaches no page: Electron delivers an
 * invoke's answer to the context that invoked it, and that context went with
 * its document). Work already started finishes; its record, and its place in
 * the bounds, are let go once it has.
 *
 * Every event carries the target document's nonce, and the preload drops one
 * that isn't its own: main's check alone can't hold, since
 * `WebFrameMain.send` targets a frame, and the frame can commit a new
 * document between the check and the delivery.
 *
 * The app serves Ethereum's methods here (PRQ-3 to PRQ-5, `page-ethereum.js`),
 * all of Swarm's (PRQ-7a to 7d, `page-swarm.js`) and all of Radicle's
 * (PRQ-8a to 8c, `page-radicle.js`): the preload sends those on
 * `page:request`, and every other method (Ethereum's own that main doesn't
 * serve) is refused or still takes today's path through the chrome. The E2E
 * harness can route and serve any method through a test hook
 * (`enablePageRequestTestHooks`).
 *
 * `page:bind-name { guest, name, key }` (the design's "Names over IPNS")
 * comes from the chrome, before it loads `ipns://<key>` for a DNS name: it
 * holds the name for the guest's next main-frame commit, which main checks
 * against its own resolution (`page-documents.js`). The chrome may name only
 * a guest it hosts.
 *
 * A dispatcher that needs the user opens a prompt (`context.prompt`, PRQ-4):
 * a handle main issues, held and shown per window by `page-prompts.js`,
 * which the chrome renders and answers with `page:decide`. The chrome
 * reports the guest in front with `page:foreground`. One wallet prompt is
 * pending per document at a time; a second request gets `-32002`. The
 * prompt carries main's `site`, the request's attested key, and whatever the
 * user decides, the dispatcher acts on its own record.
 *
 * With the approvals document on (APS-1, APS-2; the default, `FREEDOM_APPROVALS_DOCUMENT=0` its rollback,
 * `approvals/approvals-document.js`), `page:prompt`, `page:prompt-hidden`
 * and `page:prompt-closed` go to the window's approvals document instead,
 * the chrome keeps `page:prompt-pending` and `page:prompt-closed` for its
 * badges and count, and the chrome's `page:decide` is refused: a decision
 * counts only from the window's own approvals document (`decideInWindow`),
 * the Safe signing boards' too, which main runs there (APS-3b,
 * `approvals/safe-boards.js`).
 *
 * A record prompts one prompt at a time, and may prompt again once its
 * prompt is decided (PRQ-5: a vault unlock and then the signature, a Safe's
 * approval and then its signing board, or a send's fee asked again at the
 * press). An approved wallet prompt keeps the document's one wallet slot for
 * its record until main answers it, so the record's next prompt, or its
 * effect, isn't raced by another, unless the record gives it up while it
 * waits with nothing to show (`leaveWalletSlot`).
 *
 * A page's own request is decided through the identity core's dispatcher
 * (design 0012, APB-4): the core mints and spends its approval token, and
 * main only traces it (`context.traceCoreToken`).
 *
 * A connect, a signature or a send in a tab the Agent holds goes to the
 * core like any page's, and the Agent's sheet answers the core's prompt on
 * a handle main opens for its decision (design 0012, "The Agent's answer",
 * APB-5: `context.agentPrompt`). Main mints no page token itself: the
 * agent's own issuer was removed in APB-5b.
 *
 * **Reject while a Ledger waits** (freedom-core design 0016, "Deadlines,
 * cancel and unplugging", deviation `cancel`; LDG-3's PR 10): on the core's
 * Ledger backend, the device step of an approved request (a page's
 * signature or send from a Ledger account, `page-devices.js`,
 * `page-core-sends.js`) says so (`context.deviceWait()`) as it starts; main
 * then tells the surface that decided it (`page:prompt-waiting { handle }`,
 * the window's approvals document, or with it off the chrome) that Reject
 * still reaches it. The surface's Reject (`page:cancel { handle }`, or the
 * document's `approvals:cancel`, `cancelInWindow`) answers the request
 * rejected (4001) at once, which aborts the record's `signal`, the device
 * step's: main cancels the core's `sign.*` and the relay lets go of the
 * device. Before the step says so, or on the JS backend, where the device
 * can't be stopped, nothing is cancellable and the surface keeps Reject
 * off, as before. A send's wait ends at its commit (`context.endDeviceWait()`,
 * in the same run as the commit of its signed bytes): a Reject that came
 * first wins and nothing is committed; one after it is refused
 * `not-waiting`, and the page hears the send's own outcome.
 */

const crypto = require('crypto');
const {
  PAGE_REQUEST_LIMITS,
  measurePageRequest,
  pageRequestMaxBytes,
  pageRequestWalkError,
} = require('../../shared/page-request-bounds');
const { BUDGETS, TICKETS, chargeOf, createPageBudgets } = require('./page-budgets');
const {
  CLASS,
  PROVIDERS,
  methodRow,
  eventRow,
  unknownMethodError,
  timeoutError,
} = require('./page-methods');
const { createPageDocuments, transportKeyOf } = require('./page-documents');
const { normalizeOrigin } = require('../../shared/origin-utils');
const { runInWindow } = require('../windows/request-window');
const {
  CHANNELS: PROMPT_CHANNELS,
  KIND_SET,
  TEST_KIND,
  WALLET_KINDS,
  PROMPT_BUDGETS,
  LIMIT_EXCEEDED: PROMPT_LIMIT_EXCEEDED,
  createPagePrompts,
} = require('./page-prompts');

const CHANNELS = Object.freeze({
  HELLO: 'page:hello',
  RESERVE: 'page:reserve',
  REQUEST: 'page:request',
  EVENT: 'page:event',
  BIND_NAME: 'page:bind-name',
  ...PROMPT_CHANNELS,
});

const REQUEST_KEYS = new Set(['nonce', 'provider', 'method', 'params', 'ticket']);
const CANCEL_KEYS = new Set(['handle']);
// A page's answer when the user rejected its request while the Ledger
// waited (EIP-1193's 4001, as every other rejection).
const USER_REJECTED = Object.freeze({ code: 4001, message: 'User rejected the request' });
const RESERVE_KEYS = new Set(['nonce', 'method', 'bytes']);
const FOREGROUND_KEYS = new Set(['guest']);
const PASSWORD_KEYS = new Set(['password']);
// The wallet's own prompts (APS-3): the window's, not a page's. From
// APS-3b, its Safe board and the vault unlock a board's step needs; from
// APS-5, x402's payment.
const WALLET_PROMPT_KINDS = new Set([
  'wallet.send',
  'wallet.safe_send',
  'wallet.intent_resend',
  'wallet.intent_replace',
  'wallet.intent_close',
  'wallet.executor_send',
  'wallet.safe_board',
  'wallet.vault_unlock',
  'wallet.x402_payment',
]);
// What a wallet prompt shows where a page's shows its site.
const WALLET_SITE = Object.freeze({ key: 'freedom:wallet', label: 'Your wallet' });
// The longest vault password a decision may carry.
const MAX_PASSWORD_LENGTH = 1024;

// A handle: 32 random bytes, made by main.
const HANDLE_BYTES = 32;

// The reasons a handle closes (design 0011, "The prompt protocol").
const CLOSED = Object.freeze({
  DECIDED: 'decided',
  NAVIGATED: 'navigated',
  CLOSED: 'closed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
});

// What an invoke answers when the document that asked has gone. It reaches
// no page (see the file header), and the preload drops it anyway.
const GONE = Object.freeze({ gone: true });

const PROVIDER_SET = new Set(PROVIDERS);

const errorOf = (base, data) => ({ error: data === undefined ? { ...base } : { ...base, data } });
const LIMIT_EXCEEDED = { code: -32005, message: 'Limit exceeded' };
const INVALID_REQUEST = { code: -32602, message: 'Invalid parameters' };
const INTERNAL_ERROR = { code: -32603, message: 'Internal error' };
const UNAUTHORIZED = { code: 4100, message: 'Unauthorized' };
// EIP-1193's "request already pending": a document's second wallet prompt.
const PROMPT_PENDING = { code: -32002, message: 'Another wallet request is already pending' };

/** A refused requester: the attestation's reason, nothing more. */
const refusal = (reason) => errorOf(UNAUTHORIZED, { reason });

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// A dispatcher's answer as the page gets it: `{ result }` or `{ error }`,
// the error with a numeric code and a string message. The error's message
// and every string in its `data` lose any RPC API key, current or retired
// (design 0013 (e)): a chain read's error carries the node's free text
// through the core, and a keyed endpoint can quote its key in it.
function normalizeAnswer(answer) {
  if (answer && typeof answer === 'object' && Object.prototype.hasOwnProperty.call(answer, 'error') && answer.error) {
    return { error: normalizeError(answer.error) };
  }
  return { result: answer && typeof answer === 'object' ? answer.result : undefined };
}

function normalizeError(error) {
  const { withoutStoredKeys, keyRedactedData } = require('../wallet/rpc-errors');
  const out = {
    code: Number.isInteger(error?.code) ? error.code : INTERNAL_ERROR.code,
    message: withoutStoredKeys(
      typeof error?.message === 'string' && error.message ? error.message : INTERNAL_ERROR.message
    ),
  };
  if (error && typeof error === 'object' && error.data !== undefined) {
    // None when it can't be redacted (rpc-errors.js keyRedactedData).
    const data = keyRedactedData(error.data);
    if (data !== undefined) out.data = data;
  }
  return out;
}

// The `ticket` a payload carries as an own property, whatever kind of
// object it is, or undefined.
function presentedTicket(payload) {
  if (payload === null || typeof payload !== 'object') return undefined;
  try {
    return Object.prototype.hasOwnProperty.call(payload, 'ticket') ? payload.ticket : undefined;
  } catch {
    return undefined;
  }
}

// Only the keys a request of this kind has.
function hasOnlyKeys(payload, keys) {
  for (const key in payload) {
    if (!keys.has(key)) return false;
  }
  return true;
}

function isLive(contents) {
  try {
    return Boolean(contents) && contents.isDestroyed() === false;
  } catch {
    return false;
  }
}

// Whether the agent holds guest `guestId`'s tab now (`agent-tab-custody.js`):
// a PageContext's `agent` (design 0012), read as main sends the request.
function defaultIsAgentGuest(guestId) {
  return require('../wallet/agent-tab-custody').isAgentPageId(guestId);
}

// The chrome window `contents` is the chrome of, as main's own record: the
// sender policy lets only a chrome window's top frame reach the prompt
// channels, and this names its window.
function defaultChromeWindowOf(contents) {
  const { BrowserWindow } = require('electron');
  const win = BrowserWindow.fromWebContents(contents);
  if (!win || win.isDestroyed() || win.webContents !== contents) return null;
  return Number.isInteger(win.id) ? win.id : null;
}

function defaultSendToWindow(windowId, channel, payload) {
  const { BrowserWindow } = require('electron');
  const win = BrowserWindow.fromId(windowId);
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.send(channel, payload);
}

// Whether the window is open: only then is its close watched.
function defaultWatchWindow(windowId, onClosed) {
  const { BrowserWindow } = require('electron');
  const win = BrowserWindow.fromId(windowId);
  if (!win || win.isDestroyed()) return false;
  win.once('closed', onClosed);
  return true;
}

/**
 * @param {object} [options]
 * @param {object} [options.documents] page-documents.js's API.
 * @param {(id: number) => object} [options.webContentsFromId]
 * @param {Record<string, Function>} [options.dispatchers] `provider:method`
 *   -> `async (context) => ({ result } | { error })`. Empty in the app.
 * @param {object} [options.hooks] test hooks, read at each use: `dispatch`
 *   serves every method with a row, `beforeEventSend(message, target)` may
 *   hold an event between main's check and the send, `holdRequest(payload)`
 *   may hold a request's delivery before main takes it, `onTrace(entry)`
 *   hears what main did, and `onCopy(entry)` hears each copy a dispatcher
 *   reports (`context.copied`), with whether the request's charge is in
 *   place.
 * @param {(contents: object) => number|null} [options.chromeWindowOf] the
 *   chrome window a sender is the chrome of.
 * @param {(windowId: number, channel: string, payload: object) => void} [options.sendToWindow]
 *   to a window's chrome.
 * @param {{send: (windowId: number, channel: string, payload: object) => void}|null} [options.approvals]
 *   the approvals documents (APS-1), when their flag is on: they get the
 *   prompts the chrome otherwise renders, and the chrome's decisions are
 *   refused.
 * @param {(password: string) => Promise<void>} [options.unlockVault] main's
 *   own unlock, for a `vault.unlock` decided in the approvals document
 *   (APS-2), which carries the password; throws when it is wrong.
 * @param {() => Promise<boolean>} [options.touchIdAvailable] whether main
 *   can unlock with Touch ID here (APS-3: macOS, quick unlock set up).
 * @param {() => Promise<{success: boolean}>} [options.unlockWithTouchId]
 *   main's own Touch ID unlock, whose password never leaves main.
 * @param {(guestId: number) => boolean} [options.isAgentGuest] whether the
 *   agent holds a guest's tab now: a PageContext's `agent`.
 */
function createPageRequests({
  documents = createPageDocuments(),
  webContentsFromId = (id) => require('electron').webContents.fromId(id),
  dispatchers = {},
  hooks = {},
  budgets: budgetBounds = BUDGETS,
  promptBudgets = PROMPT_BUDGETS,
  tickets: ticketBounds = TICKETS,
  randomHex = (bytes) => crypto.randomBytes(bytes).toString('hex'),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  chromeWindowOf = defaultChromeWindowOf,
  sendToWindow = defaultSendToWindow,
  watchWindow = defaultWatchWindow,
  approvals = null,
  unlockVault = async () => {
    throw new Error('no vault');
  },
  touchIdAvailable = async () => false,
  unlockWithTouchId = async () => ({ success: false }),
  isAgentGuest = defaultIsAgentGuest,
} = {}) {
  let lastId = 0;
  const records = new Map(); // id -> record
  const byDocument = new Map(); // `${guest}:${navigation}` -> Set<record>
  const handles = new Map(); // handle -> record
  // A decided handle -> its record, while the record's device step can be
  // cancelled (`deviceWait`), until main answers the record or its
  // signature is committed (`endDeviceWait`).
  const waits = new Map();
  const handleListeners = new Set();

  const trace = (entry) => {
    try {
      hooks.onTrace?.(entry);
    } catch {
      // A test hook never changes what main does.
    }
  };

  // Where a prompt message goes: the chrome, or with the approvals
  // document's flag on, the window's approvals document for what it shows,
  // and the chrome for its badges and count.
  const toChrome = (windowId, channel, payload) => {
    try {
      sendToWindow(windowId, channel, payload);
    } catch {
      // A window mid-teardown: its handles close with its guests.
    }
  };
  const toApprovals = (windowId, channel, payload) => {
    try {
      approvals.send(windowId, channel, payload);
    } catch {
      // The same.
    }
  };
  function sendPromptMessage(windowId, channel, payload) {
    if (!approvals) return toChrome(windowId, channel, payload);
    if (channel === PROMPT_CHANNELS.PENDING) return toChrome(windowId, channel, payload);
    if (channel === PROMPT_CHANNELS.CLOSED) {
      toChrome(windowId, channel, payload);
      return toApprovals(windowId, channel, payload);
    }
    toApprovals(windowId, channel, payload);
  }

  const prompts = createPagePrompts({
    send: sendPromptMessage,
    // A window's own prompt (the wallet's, `walletPrompt`) has no record.
    markShown: (entry) => (entry.record ? markShown(entry.record) : true),
    decided: (entry) => (entry.record ? decidedEntry(entry) : prompts.closed(entry.handle, CLOSED.DECIDED)),
    // A changed view past the prompt budget (`page-prompts.js` `update`).
    cancel: (entry) =>
      entry.record ? closeHandle(entry.record, CLOSED.CANCELLED) : prompts.closed(entry.handle, CLOSED.CANCELLED),
    trace,
    budgets: promptBudgets,
  });
  const watchedWindows = new Set();
  // document key -> the record whose wallet request outside main's own
  // prompts holds the document's one wallet slot: the Agent's sheet
  // deciding on it (`agentPrompt`), or a prompt approved and not yet
  // answered.
  const walletOperations = new Map();

  const budgets = createPageBudgets({
    budgets: budgetBounds,
    tickets: ticketBounds,
    isCurrent: (requester) => documentHolds(requester),
    randomHex,
    setTimer,
    clearTimer,
    onTrace: trace,
  });

  const documentKey = (requester) => `${requester.guest}:${requester.navigation}`;

  function dispatcherFor(provider, method) {
    if (typeof hooks.dispatch === 'function') return hooks.dispatch;
    const dispatcher = dispatchers[`${provider}:${method}`];
    return typeof dispatcher === 'function' ? dispatcher : null;
  }

  function stopDeadline(record) {
    if (record.timer === null) return;
    clearTimer(record.timer);
    record.timer = null;
  }

  function open(requester, provider, method, row, charge, chargeBytes) {
    const record = {
      id: ++lastId,
      key: documentKey(requester),
      window: requester.window,
      requester,
      provider,
      method,
      row,
      charge,
      chargeBytes,
      handle: null,
      shown: false,
      timer: null,
      answered: false,
      settled: false,
      released: false,
      resolve: null,
      reply: null,
      // The answer if the document no longer holds its key when main
      // answers (`nameHolds`).
      keyless: undefined,
      // What runs once the answer has reached the document (`afterAnswer`).
      after: null,
      // Resolves once the record is answered, whether or not the document
      // is still there, with how (`whenAnswered`).
      answeredGate: null,
      openAnsweredGate: null,
      answerOutcome: null,
      // Aborted when the record is answered, for a dispatcher that waits on
      // something outside main's prompts (`signal`).
      aborter: null,
      // The identity core's id for the prompt the record's handle shows, if
      // the core asked for it (design 0012, APR-5).
      corePrompt: null,
      // While the Agent's sheet decides on the record's handle
      // (`agentPrompt`): aborted when that handle closes.
      sheet: null,
    };
    record.reply = new Promise((resolve) => {
      record.resolve = resolve;
    });
    records.set(record.id, record);
    if (!byDocument.has(record.key)) byDocument.set(record.key, new Set());
    byDocument.get(record.key).add(record);
    record.timer = setTimer(() => expire(record), row.timeoutMs);
    record.timer?.unref?.();
    trace({
      kind: 'recorded',
      id: record.id,
      provider,
      method,
      guest: requester.guest,
      navigation: requester.navigation,
      charge: chargeBytes,
    });
    return record;
  }

  // The record, and its charge, go once it is answered and its work, which
  // holds its payload and every copy, is over.
  function release(record) {
    if (record.released || !record.answered || !record.settled) return;
    record.released = true;
    stopDeadline(record);
    closeHandle(record, CLOSED.CANCELLED);
    records.delete(record.id);
    const inDocument = byDocument.get(record.key);
    inDocument?.delete(record);
    if (inDocument && inDocument.size === 0) byDocument.delete(record.key);
    budgets.release(record.charge);
    trace({ kind: 'released', id: record.id });
  }

  // Answer a record once: to its document if that is still current, and
  // with nothing a page sees if it has gone. Any later answer is dropped.
  function answer(record, value) {
    if (record.answered) {
      trace({ kind: 'dropped', id: record.id });
      return false;
    }
    record.answered = true;
    stopDeadline(record);
    if (record.handle && waits.get(record.handle) === record) waits.delete(record.handle);
    // A wallet operation still running for it (its deadline, its document
    // gone) is told to stop, and its document's slot is free again.
    if (walletOperations.get(record.key) === record) walletOperations.delete(record.key);
    record.aborter?.abort();
    const current = documents.isCurrent(record.requester);
    // A request that read under a name answers as a keyless document's
    // would once the name no longer holds, checked in the same run as the
    // reply (`nameHolds`).
    if (current && record.keyless !== undefined && value && !value.error && !documents.holdsKey(record.requester)) {
      trace({ kind: 'name-lost', id: record.id });
      value = { ...record.keyless };
    }
    record.resolve(current ? value : GONE);
    // `ok`: the document that asked got a result, not an error (its
    // deadline, a name lost) and not nothing (it had gone).
    record.answerOutcome = Object.freeze({ delivered: current, ok: Boolean(current && value && !value.error) });
    record.openAnsweredGate?.(record.answerOutcome);
    trace({ kind: current ? 'answered' : 'gone', id: record.id, value: current ? value : undefined });
    const after = record.after;
    record.after = null;
    release(record);
    if (current && after && value !== GONE) {
      try {
        Promise.resolve(after(value)).catch(() => {});
      } catch {
        // What follows an answer never changes it.
      }
    }
    return current;
  }

  function settle(record) {
    record.settled = true;
    release(record);
  }

  // Main's deadline, for a record whose prompt never showed.
  function expire(record) {
    record.timer = null;
    if (record.answered || record.shown) return;
    closeHandle(record, CLOSED.EXPIRED);
    trace({ kind: 'expired', id: record.id });
    answer(record, { error: timeoutError(record.provider) });
  }

  function closeHandle(record, reason) {
    const handle = record.handle;
    if (!handle || handles.get(handle) !== record) return false;
    handles.delete(handle);
    record.handleClosed = reason;
    // The Agent's sheet deciding on this handle is withdrawn (`agentPrompt`).
    record.sheet?.abort();
    const closed = Object.freeze({ handle, window: record.window, guest: record.requester.guest, reason });
    trace({ kind: 'handle-closed', id: record.id, reason });
    prompts.closed(handle, reason);
    for (const listener of handleListeners) {
      try {
        listener(closed);
      } catch {
        // One listener's failure must not keep the others from hearing it.
      }
    }
    return true;
  }

  // A decision on a record's prompt: the handle closes, decided. An
  // approved wallet prompt keeps the document's wallet slot for its record
  // until main answers it.
  function decidedEntry(entry) {
    const { record } = entry;
    if (entry.decided?.approve === true && !record.answered) {
      if (WALLET_KINDS.has(entry.kind) && !walletOperations.has(record.key)) walletOperations.set(record.key, record);
    }
    closeHandle(record, CLOSED.DECIDED);
  }

  // A handle for the record's prompt: 32 random bytes, scoped to its window.
  // One at a time: the open one, or a new one once the last has closed.
  function openHandle(record) {
    if (record.answered) return null;
    if (record.handle && handles.get(record.handle) === record) return record.handle;
    const handle = randomHex(HANDLE_BYTES);
    record.handle = handle;
    handles.set(handle, record);
    trace({ kind: 'handle-opened', id: record.id });
    return handle;
  }

  // The record's prompt has shown: from now on it has no deadline.
  function markShown(record) {
    if (!record.handle || handles.get(record.handle) !== record || record.answered) return false;
    record.shown = true;
    stopDeadline(record);
    return true;
  }

  // document key -> what dispatchers asked to hear when it ends
  // (`context.onDocumentEnded`): a subscription bound to the document.
  const endListeners = new Map();

  // A document ended: its handles close, nothing is answered to it, and its
  // reservation, waiting or granted, is released.
  documents.onEnded(({ guest, navigation, reason }) => {
    const ended = endListeners.get(`${guest}:${navigation}`);
    endListeners.delete(`${guest}:${navigation}`);
    for (const listener of ended || []) {
      try {
        listener();
      } catch {
        // One listener's failure must not keep the others from hearing it.
      }
    }
    budgets.documentEnded(`${guest}:${navigation}`, GONE);
    const inDocument = byDocument.get(`${guest}:${navigation}`);
    if (!inDocument) return;
    const closeReason = reason === 'closed' ? CLOSED.CLOSED : CLOSED.NAVIGATED;
    for (const record of [...inDocument]) {
      closeHandle(record, closeReason);
      answer(record, GONE);
    }
  });

  /**
   * Hear once when the record's document ends (a navigation, its guest
   * destroyed, its window closed), for what outlives the request but not
   * the document: a subscription bound to it. One that has already ended is
   * told at once. Returns a function that stops it.
   */
  function onDocumentEnded(record, listener) {
    if (typeof listener !== 'function') return () => {};
    if (!documents.isCurrent(record.requester)) {
      try {
        listener();
      } catch {
        // Told; what it does is its own.
      }
      return () => {};
    }
    if (!endListeners.has(record.key)) endListeners.set(record.key, new Set());
    endListeners.get(record.key).add(listener);
    return () => endListeners.get(record.key)?.delete(listener);
  }

  function contextOf(record, params) {
    return Object.freeze({
      id: record.id,
      requester: record.requester,
      provider: record.provider,
      method: record.method,
      class: record.row.class,
      params,
      isCurrent: () => documents.isCurrent(record.requester),
      nameHolds: (options) => nameHolds(record, options),
      // What the request answers if its document no longer holds its key
      // when main answers it, as `nameHolds`' option sets it, with nothing
      // resolved: for an answer the identity core checked the name for.
      keylessOnceUnheld: (keyless) => {
        if (keyless !== undefined && record.keyless === undefined) record.keyless = keyless;
      },
      holdsKey: () => documents.holdsKey(record.requester),
      openHandle: () => openHandle(record),
      markShown: () => markShown(record),
      prompt: (spec) => prompt(record, spec),
      // Whether the window's approvals document decides (APS-2): a vault
      // account's prompt then asks for the vault unlocked first, which the
      // chrome's own screens did in place.
      approvalsDocument: Boolean(approvals),
      // The identity core cancelled the prompt it asked for (design 0012,
      // APR-5): the record's open handle closes, cancelled, if its record
      // keeps that prompt id.
      // A token the identity core minted for the record's approval, or
      // spent, traced as the Agent's are (`agentMint`, `spend`): `phase` is
      // `minted` or `spent`. The token itself never comes here.
      traceCoreToken: (phase, kind) =>
        (phase === 'minted' || phase === 'spent') &&
        trace({ kind: `token-${phase}`, id: record.id, token: kind, by: 'core' }),
      cancelPrompt: (corePrompt) =>
        typeof corePrompt === 'string' && record.corePrompt === corePrompt && closeHandle(record, CLOSED.CANCELLED),
      // The open prompt's content changed: it shows again with this view.
      updatePrompt: (view) =>
        Boolean(record.handle) && handles.get(record.handle) === record && prompts.update(record.handle, view),
      // The requesting document's PageContext, under which a page's request
      // goes to the identity core (design 0012), never as main's own.
      pageContext: () => pageContextOf(record),
      agentPrompt: (spec) => agentPrompt(record, spec),
      leaveWalletSlot: () => leaveWalletSlot(record),
      // The device step of an approved request can be cancelled now (the
      // core's Ledger backend): Reject reaches it until main answers, or
      // until its signature is committed (`endDeviceWait`).
      deviceWait: () => deviceWait(record),
      endDeviceWait: () => endDeviceWait(record),
      // Aborted when main answers the record: for a dispatcher that waits on
      // something outside main's prompts.
      get signal() {
        return abortSignalOf(record);
      },
      afterAnswer: (fn) => {
        if (typeof fn === 'function' && !record.answered) record.after = fn;
      },
      // Resolves once main has answered the record, the document there or
      // gone, with `{ delivered, ok }`: for events queued at an effect, sent
      // after the answer, and to the document that asked only if it got a
      // result.
      whenAnswered: () => whenAnswered(record),
      liveDocuments: () => documents.liveDocuments(),
      sendEvent: (target, event, data) => sendEvent(target, record.provider, event, data),
      onDocumentEnded: (listener) => onDocumentEnded(record, listener),
      inGrantOrder: (key, job) => inGrantOrder(key, job),
      inChainOrder: (windowId, job) => inChainOrder(windowId, job),
      copied: (label) => copied(record, label),
    });
  }

  function whenAnswered(record) {
    if (record.answered) return Promise.resolve(record.answerOutcome);
    if (!record.answeredGate) {
      record.answeredGate = new Promise((resolve) => {
        record.openAnsweredGate = resolve;
      });
    }
    return record.answeredGate;
  }

  // Events in order (design 0011, "Events"; PRQ-6): one change's sends run
  // after the last change's in the same domain, so each document hears the
  // changes in their order, and the last it hears is main's state, even
  // when a send waits on a name's resolution. A domain per permission key
  // for its grant's events (a connect, a revocation, an account change), and
  // one per window for its chain's.
  const eventQueues = new Map();

  function inOrder(domain, job) {
    const before = eventQueues.get(domain) || Promise.resolve();
    const done = before.then(() => job()).catch(() => undefined);
    eventQueues.set(domain, done);
    done.then(() => {
      if (eventQueues.get(domain) === done) eventQueues.delete(domain);
    });
    return done;
  }

  /** Run `job` (it sends a grant's events for `key`) after the key's earlier ones. */
  function inGrantOrder(key, job) {
    return inOrder(`grant:${normalizeOrigin(key)}`, job);
  }

  /** Run `job` (it sends window `windowId`'s chain events) after its earlier ones. */
  function inChainOrder(windowId, job) {
    return inOrder(`chain:${windowId}`, job);
  }

  /**
   * Ask the user (design 0011, "Requests and handles"): open the record's
   * handle and hold its prompt in its window, shown while its guest is in
   * front. `site` is main's, from the record. Settles with the decision,
   * `{ approve, choices }` (`choices` as `spec.choices` checked them), with
   * `{ closed: reason }` when the handle closes otherwise, or with
   * `{ error }`, `-32002`, while the document has another wallet prompt
   * open.
   */
  async function prompt(record, spec = {}) {
    if (spec?.kind === 'vault.unlock' && approvals) return unlockPrompt(record, spec);
    return promptOnce(record, spec);
  }

  // A decision's password for the vault, or null.
  const passwordChoices = (raw) =>
    isPlainObject(raw) &&
    hasOnlyKeys(raw, PASSWORD_KEYS) &&
    typeof raw.password === 'string' &&
    raw.password.length > 0 &&
    raw.password.length <= MAX_PASSWORD_LENGTH
      ? { password: raw.password }
      : null;
  // A decision for Touch ID instead (APS-3), where main offers it.
  const touchIdChoice = (raw) =>
    isPlainObject(raw) && Object.keys(raw).length === 1 && raw.touchId === true ? { touchId: true } : null;

  /**
   * With the approvals document on (APS-2), a vault unlock takes the
   * password in the document, and main unlocks with it: the dispatcher
   * hears an approval only once the vault is open, with no choices, as the
   * chrome's unlock gave it. A wrong password shows the prompt again,
   * saying so (`failed`). The password goes nowhere else.
   */
  function unlockPrompt(record, spec) {
    // The identity core's unlock (design 0012, APR-5d-2): each prompt's
    // handle record keeps the core's prompt id.
    const corePrompt = typeof spec?.corePrompt === 'string' ? { corePrompt: spec.corePrompt } : {};
    return unlockLoop(
      {
        id: record.id,
        ask: (shown) => promptOnce(record, { ...shown, kind: 'vault.unlock', ...corePrompt }),
        over: () => record.answered,
      },
      spec
    );
  }

  /**
   * A window's own vault unlock (APS-3b): a step of the wallet's own Safe
   * board (`approvals/safe-boards.js`), which no page asked for. As a page's
   * unlock: the password in the document, main unlocking with it, and an
   * approval only once the vault is open. Only with the approvals document on.
   */
  function walletUnlock(windowId, view = {}) {
    if (!approvals) return Promise.resolve({ closed: CLOSED.CANCELLED });
    return unlockLoop(
      {
        id: null,
        ask: (shown) => walletPrompt(windowId, { ...shown, kind: 'wallet.vault_unlock' }),
        over: () => false,
      },
      { view }
    );
  }

  // The unlock's prompts, for a record or a window: `ask` shows one.
  async function unlockLoop({ id, ask, over }, { view = {} } = {}) {
    let touchId = false;
    try {
      touchId = (await touchIdAvailable()) === true;
    } catch {
      touchId = false;
    }
    const offered = touchId ? { ...view, touchId: true } : view;
    let shown = offered;
    for (;;) {
      // The password goes from the decision's check straight to this
      // attempt: the decision main keeps carries no choices, and the
      // decision's invocation is answered once the attempt is done, so
      // nothing holds a password past its own attempt (Codex, #1208).
      let password = null;
      let viaTouchId = false;
      let attemptDone;
      const released = new Promise((resolve) => {
        attemptDone = resolve;
      });
      const choices = (raw) => {
        if (touchId && touchIdChoice(raw)) {
          viaTouchId = true;
          return {};
        }
        const checked = passwordChoices(raw);
        if (!checked) return null;
        password = checked.password;
        return {};
      };
      let decision;
      try {
        decision = await ask({ view: shown, choices, released });
        if (decision.error || decision.closed || decision.approve !== true) return decision;
        const attempt = password;
        password = null;
        try {
          if (viaTouchId) {
            const result = await unlockWithTouchId();
            if (result?.success !== true) throw new Error(result?.error || 'Touch ID failed');
          } else {
            await unlockVault(attempt);
          }
        } catch {
          trace({ kind: 'unlock-failed', id });
          if (over()) return { closed: CLOSED.CANCELLED };
          shown = { ...offered, failed: true };
          continue;
        }
      } finally {
        attemptDone();
      }
      trace({ kind: 'unlocked', id });
      // A core's prompt: the handle the approval was made on, and the
      // prompt id its record kept (`promptOnce`).
      const named = typeof decision.prompt === 'string' ? { handle: decision.handle, prompt: decision.prompt } : {};
      return Object.freeze({ approve: true, choices: Object.freeze({}), from: decision.from, ...named });
    }
  }

  async function promptOnce(record, { kind, view = {}, choices, released, corePrompt } = {}) {
    const testKind = kind === TEST_KIND && hooks.testPrompts === true;
    if (!KIND_SET.has(kind) && !testKind) throw new Error(`page-requests: no prompt of kind ${kind}`);
    if (record.answered) return { closed: CLOSED.CANCELLED };
    if (record.handle && handles.get(record.handle) === record) {
      throw new Error('page-requests: a record prompts one prompt at a time');
    }
    if (WALLET_KINDS.has(kind) && walletSlotTaken(record)) {
      trace({ kind: 'prompt-refused', id: record.id, reason: 'pending' });
      return { error: { ...PROMPT_PENDING } };
    }
    // Room for its view in the prompt budget (0011, "Prompt views"), taken
    // before the handle opens: past it, the page gets `-32005` and nothing
    // opens. The request itself is charged already.
    const charge = prompts.admit(record.window, { view });
    if (!charge) {
      trace({ kind: 'prompt-refused', id: record.id, reason: 'budget' });
      return { error: { ...PROMPT_LIMIT_EXCEEDED } };
    }
    // The charge passes to the prompt once `add` holds it; until then it is
    // ours, and a throw on the way (the handle's random bytes, say) lets it
    // go and closes a handle that opened, so no charge outlives its prompt.
    let handle = null;
    let entry = null;
    try {
      handle = openHandle(record);
      if (!handle) return { closed: CLOSED.CANCELLED };
      // The identity core's own prompt (design 0012, APR-5): its handle
      // record keeps the core's prompt id while the handle is open.
      record.corePrompt = typeof corePrompt === 'string' ? corePrompt : null;
      const { requester } = record;
      entry = prompts.add({
        handle,
        record,
        window: record.window,
        guest: requester.guest,
        document: record.key,
        kind,
        site: { key: requester.key, label: requester.key },
        view,
        choices,
        released,
        charge,
      });
    } finally {
      if (!entry) {
        prompts.release(charge);
        if (handle) closeHandle(record, CLOSED.CANCELLED);
      }
    }
    if (record.corePrompt === null) return entry.decision;
    // A core's prompt: the decision names the handle it was made on and the
    // prompt id that handle's record kept, for main's answer to the core.
    const named = Object.freeze({ handle, prompt: record.corePrompt });
    return entry.decision.then((decision) => Object.freeze({ ...decision, ...named }));
  }

  /**
   * The wallet's own prompt (design 0011, APS-3): a prompt of the window
   * itself, which no page asked for, shown in its approvals document when
   * nothing older is, whichever tab is in front. Settles with the decision,
   * `{ approve, choices }`, or `{ closed: reason }`. Only with the
   * approvals document on; it then decides alone.
   *
   * It has no request to answer, so `released` says when what its decision
   * started is done (`wallet-approvals.js`: the token minted, or refused, or
   * the prompt shown again), and the decision's invocation is answered then.
   * A window closed meanwhile (during the caller's fee check, say) gets no
   * prompt: it closes at once.
   *
   * It has no request record either, so nothing else bounds it: its view,
   * and `holds`, the request it answers (the chrome's, which its caller
   * keeps while it waits), are charged to the prompt budget (0011, "Prompt
   * views"). Past it, it settles at once with `{ error }`, `-32005`, and
   * nothing opens.
   */
  function walletPrompt(windowId, { kind, view = {}, choices, released, holds } = {}) {
    if (!approvals) return Promise.resolve({ closed: CLOSED.CANCELLED });
    if (!WALLET_PROMPT_KINDS.has(kind)) throw new Error(`page-requests: no wallet prompt of kind ${kind}`);
    if (!Number.isInteger(windowId) || !watch(windowId)) return Promise.resolve({ closed: CLOSED.CLOSED });
    const charge = prompts.admit(windowId, { view, holds });
    if (!charge) {
      trace({ kind: 'wallet-prompt-refused', window: windowId, prompt: kind, reason: 'budget' });
      return Promise.resolve({ error: { ...PROMPT_LIMIT_EXCEEDED } });
    }
    // As promptOnce: the charge is ours until `add` holds it.
    let handle = null;
    let entry = null;
    try {
      handle = randomHex(HANDLE_BYTES);
      trace({ kind: 'wallet-prompt', window: windowId, prompt: kind });
      entry = prompts.add({
        handle,
        record: null,
        window: windowId,
        guest: null,
        document: null,
        kind,
        site: WALLET_SITE,
        view,
        choices,
        released: released instanceof Promise ? released : Promise.resolve(),
        charge,
      });
    } finally {
      if (!entry) {
        prompts.release(charge);
        if (handle) prompts.closed(handle, CLOSED.CANCELLED);
      }
    }
    return entry.decision;
  }

  /**
   * The requesting document as the identity core knows a page (designs 0011
   * and 0012, "PageContext"): its attested key, its top-level key, its frame
   * and its number, and whether the agent holds its tab, read now.
   */
  function pageContextOf(record) {
    const requester = record.requester;
    let agent;
    try {
      agent = isAgentGuest(requester.guest) === true;
    } catch {
      // Unknown custody counts as the agent's: no standing rule answers it.
      agent = true;
    }
    return {
      origin: requester.key,
      top_origin: requester.topKey || requester.key,
      frame: requester.frame,
      navigation: requester.navigation,
      agent,
    };
  }

  // Whether a name-revalidated method may use its document's key now
  // (design 0011, "Which methods check the name"): the document current,
  // with a key, and for a DNS name over IPNS the name resolved again to the
  // document's IPNS key, after which, since the resolution was awaited, the
  // document is checked again, its frame must still be on its transport
  // key, and the document must still hold the key: another request's check
  // of the same name may have ended the binding while this one's answer
  // waited to run. A document with no name binding resolves nothing.
  //
  // `keyless` is what the request answers if, when main answers it, its
  // document no longer holds the key (`answer`): a dispatcher whose answer
  // reveals what the key holds (eth_accounts' account) passes it, so no
  // check that ran before the binding ended can let that answer out after.
  async function nameHolds(record, { keyless } = {}) {
    if (keyless !== undefined && record.keyless === undefined) record.keyless = keyless;
    const checked = await documents.recheckName(record.requester);
    const holds =
      checked.ok &&
      documents.holdsKey(record.requester) &&
      (!checked.resolved || documentHolds(record.requester));
    if (checked.resolved) trace({ kind: 'name-checked', id: record.id, holds });
    return holds;
  }

  // A dispatcher made or caused a copy of the request's bytes (design 0011,
  // "Measured, not assumed"): its charge must already be in place.
  function copied(record, label) {
    const inPlace = !record.charge.released && record.charge.bytes >= record.chargeBytes;
    try {
      hooks.onCopy?.({ id: record.id, label, charged: record.charge.bytes, charge: record.chargeBytes, inPlace });
    } catch {
      // A test hook never changes what main does.
    }
    return inPlace;
  }

  // Whether the record's document already has a wallet request waiting on
  // the user: a wallet prompt of main's, or another record's wallet
  // operation.
  function walletSlotTaken(record) {
    if (prompts.walletPromptOpen(record.key)) return true;
    const holder = walletOperations.get(record.key);
    return Boolean(holder) && holder !== record;
  }

  /**
   * The Agent's sheet deciding on the identity core's prompt for this
   * record, in a tab the Agent holds (design 0012, "The Agent's answer",
   * APB-5): a 0011 handle on the record, which keeps the core's prompt id
   * (`corePrompt`), in the document's one wallet slot, as main's own prompt
   * is. The handle is not shown in the approvals document, so the record's
   * deadline keeps running: at it, the handle closes (`expired`) and the
   * sheet is withdrawn.
   *
   * `run({ signal, open })` asks the agent service: `signal` aborts when the
   * handle closes (the core's cancel, the document gone, the deadline) or
   * main answers the record. It resolves with `{ handled: false }` when the
   * agent service doesn't take the prompt, `{ refused: error }` when it
   * refuses it without asking the sheet, `{ approve: true, choices }` or
   * `{ approve: false }` for the sheet's decision, or `{ closed: true }` for
   * a sheet withdrawn.
   *
   * Settles with `{ handled: false }` (the handle closed, the slot free, for
   * the user's prompt to take the same prompt id), `{ error }` (`-32002`
   * while the slot is taken), `{ closed: reason }`, or the decision named
   * with the handle it was made on and the prompt id: `{ approve, choices,
   * handle, prompt, from: 'agent' }`, or `{ refused, handle, prompt }`. An
   * approve keeps the slot for the record until main answers it, as an
   * approved prompt does.
   */
  async function agentPrompt(record, { corePrompt, run } = {}) {
    if (typeof corePrompt !== 'string' || typeof run !== 'function') throw new Error('page-requests: a sheet needs a core prompt');
    if (record.answered) return { closed: CLOSED.CANCELLED };
    if (record.handle && handles.get(record.handle) === record) {
      throw new Error('page-requests: a record prompts one prompt at a time');
    }
    if (walletSlotTaken(record)) {
      trace({ kind: 'prompt-refused', id: record.id, reason: 'pending' });
      return { error: { ...PROMPT_PENDING } };
    }
    const handle = openHandle(record);
    if (!handle) return { closed: CLOSED.CANCELLED };
    record.corePrompt = corePrompt;
    const sheet = new AbortController();
    record.sheet = sheet;
    walletOperations.set(record.key, record);
    const answered = abortSignalOf(record);
    const signal = AbortSignal.any([sheet.signal, answered]);
    trace({ kind: 'sheet-opened', id: record.id });
    let outcome;
    try {
      outcome = await run({ signal, open: () => !record.answered && handles.get(handle) === record });
    } catch {
      outcome = { closed: true };
    } finally {
      if (record.sheet === sheet) record.sheet = null;
    }
    const named = { handle, prompt: corePrompt };
    const free = () => {
      if (walletOperations.get(record.key) === record) walletOperations.delete(record.key);
    };
    // Closed meanwhile (the core's cancel, the document gone, the deadline):
    // that is the answer, whatever the sheet said after.
    if (handles.get(handle) !== record || record.answered) {
      free();
      trace({ kind: 'sheet-closed', id: record.id, reason: record.handleClosed || CLOSED.CANCELLED });
      return { closed: record.handleClosed || CLOSED.CANCELLED };
    }
    if (outcome?.approve === true && isPlainObject(outcome.choices)) {
      closeHandle(record, CLOSED.DECIDED);
      trace({ kind: 'sheet-decided', id: record.id, approve: true });
      return Object.freeze({ approve: true, choices: Object.freeze({ ...outcome.choices }), from: 'agent', ...named });
    }
    free();
    if (outcome?.approve === false) {
      closeHandle(record, CLOSED.DECIDED);
      trace({ kind: 'sheet-decided', id: record.id, approve: false });
      return Object.freeze({ approve: false, choices: Object.freeze({}), from: 'agent', ...named });
    }
    closeHandle(record, CLOSED.CANCELLED);
    if (outcome?.handled === false) {
      trace({ kind: 'sheet-declined', id: record.id });
      return { handled: false };
    }
    if (isPlainObject(outcome?.refused)) {
      trace({ kind: 'sheet-refused', id: record.id });
      return Object.freeze({ refused: { ...outcome.refused }, ...named });
    }
    trace({ kind: 'sheet-closed', id: record.id, reason: CLOSED.CANCELLED });
    return { closed: CLOSED.CANCELLED };
  }

  // The record's signal, aborted once main answers it.
  function abortSignalOf(record) {
    if (!record.aborter) {
      record.aborter = new AbortController();
      if (record.answered) record.aborter.abort();
    }
    return record.aborter.signal;
  }

  /**
   * A record that goes on waiting with no prompt open and nothing of its
   * own to show (PRQ-5b: a Safe send whose board the user left, waiting for
   * the SafeTx's outcome) gives up its document's wallet slot, which its
   * approved prompt kept: the document's next wallet request may prompt.
   */
  function leaveWalletSlot(record) {
    if (walletOperations.get(record.key) === record) walletOperations.delete(record.key);
  }

  /**
   * `page:decide` from a chrome window: a decision for the handle that
   * window shows at this moment, and for nothing else. Answers `{ ok: true }`
   * once the request it decided has been answered (the dispatcher has acted
   * on it: a grant written, or nothing), or why it was refused.
   */
  async function decide(event, payload) {
    let windowId;
    try {
      windowId = chromeWindowOf(event?.sender);
    } catch {
      windowId = null;
    }
    if (!Number.isInteger(windowId)) return { ok: false, reason: 'not-a-window' };
    // With the approvals document's flag on, only it decides (APS-1), the
    // Safe boards included (APS-3b).
    if (approvals) {
      trace({ kind: 'decide', window: windowId, ok: false, reason: 'approvals-document' });
      return { ok: false, reason: 'approvals-document' };
    }
    return decideIn(windowId, payload, 'chrome');
  }

  // A decision is answered once the request it decided has been, or, for a
  // vault unlock, once its attempt is: its invocation, and the password its
  // payload carried, go no further than that.
  async function decideIn(windowId, payload, from) {
    const outcome = prompts.decide(windowId, payload, from);
    trace({ kind: 'decide', window: windowId, from, ok: outcome.ok, reason: outcome.reason });
    if (!outcome.ok) return outcome;
    // A window's own prompt always has `released`; a page's has its record.
    await (outcome.entry.released || outcome.entry.record?.reply);
    return { ok: true };
  }

  /**
   * A decision from window `windowId`'s approvals document, which has
   * checked its sender and main's input delay
   * (`approvals/approvals-document.js`). It counts only for the handle that
   * window shows at this moment, as the chrome's did.
   */
  function decideInWindow(windowId, payload) {
    if (!approvals || !Number.isInteger(windowId)) return Promise.resolve({ ok: false, reason: 'not-a-window' });
    return decideIn(windowId, payload, 'approvals');
  }

  /**
   * The record's device step can be cancelled from here on (the core's
   * Ledger backend, LDG-3's PR 10): the approved handle is kept until main
   * answers the record or its signature is committed (`endDeviceWait`), and
   * the surface that decided it hears that Reject still reaches it. Only a
   * prompt the user decided, still unanswered. Returns whether it can be
   * cancelled.
   */
  function deviceWait(record) {
    const handle = record.handle;
    if (record.answered || record.deviceSigned) return false;
    if (!handle || record.handleClosed !== CLOSED.DECIDED) return false;
    if (waits.get(handle) === record) return true;
    waits.set(handle, record);
    trace({ kind: 'device-wait', id: record.id });
    sendPromptMessage(record.window, PROMPT_CHANNELS.WAITING, { handle });
    return true;
  }

  /**
   * The commit boundary of the record's device step (a send's signed bytes
   * about to enter the intent records, `page-core-sends.js`), run in the
   * same synchronous step as the commit it guards: exactly one of the
   * signature and a Reject wins. Unanswered, the record's wait ends here, so
   * a later Reject is `not-waiting` and the page hears the send's own
   * outcome; returns true. Answered first (a Reject, its document gone: its
   * `signal` aborted), returns false, and nothing may be committed.
   */
  function endDeviceWait(record) {
    if (record.answered) return false;
    record.deviceSigned = true;
    if (record.handle && waits.get(record.handle) === record) {
      waits.delete(record.handle);
      trace({ kind: 'device-signed', id: record.id });
    }
    return true;
  }

  /**
   * Reject while the Ledger waits, from window `windowId`'s surface for the
   * handle it decided: the request is answered rejected at once, which
   * aborts its device step (`context.signal`). `{ ok: true, notice }`, the
   * text to show (point 18, wallet/ledger/errors.js), or why not.
   */
  function cancelIn(windowId, payload, from) {
    if (!isPlainObject(payload) || !hasOnlyKeys(payload, CANCEL_KEYS) || typeof payload.handle !== 'string') {
      return { ok: false, reason: 'invalid' };
    }
    const record = waits.get(payload.handle);
    if (!record || record.window !== windowId || record.answered) {
      trace({ kind: 'cancel', window: windowId, from, ok: false, reason: 'not-waiting' });
      return { ok: false, reason: 'not-waiting' };
    }
    trace({ kind: 'cancel', id: record.id, window: windowId, from, ok: true });
    answer(record, { error: { ...USER_REJECTED } });
    return { ok: true, notice: require('../wallet/ledger/errors').ledgerCancelledNotice() };
  }

  /**
   * `page:cancel { handle }` from a chrome window, with the approvals
   * document off: Reject while the Ledger waits, for a handle that window
   * decided. With the document on, only the document's counts
   * (`cancelInWindow`), as its decisions do.
   */
  function cancel(event, payload) {
    let windowId;
    try {
      windowId = chromeWindowOf(event?.sender);
    } catch {
      windowId = null;
    }
    if (!Number.isInteger(windowId)) return { ok: false, reason: 'not-a-window' };
    if (approvals) return { ok: false, reason: 'approvals-document' };
    return cancelIn(windowId, payload, 'chrome');
  }

  /** Reject while the Ledger waits, from window `windowId`'s approvals document. */
  function cancelInWindow(windowId, payload) {
    if (!approvals || !Number.isInteger(windowId)) return { ok: false, reason: 'not-a-window' };
    return cancelIn(windowId, payload, 'approvals');
  }

  /**
   * `page:foreground { guest }` from a chrome window: the guest now in front
   * of that window, or `null` for a tab with no page. Only a live guest the
   * window hosts; anything else is ignored. It only chooses which pending
   * prompt shows.
   */
  function foreground(event, payload) {
    let windowId;
    try {
      windowId = chromeWindowOf(event?.sender);
    } catch {
      windowId = null;
    }
    if (!Number.isInteger(windowId)) return false;
    if (!isPlainObject(payload) || !hasOnlyKeys(payload, FOREGROUND_KEYS)) return false;
    const { guest } = payload;
    if (guest !== null) {
      if (!Number.isInteger(guest)) return false;
      try {
        const contents = webContentsFromId(guest);
        if (!isLive(contents) || contents.getType() !== 'webview') return false;
        const hostId = contents.hostWebContents?.id;
        if (!Number.isInteger(hostId) || hostId !== event.sender.id) return false;
      } catch {
        return false;
      }
    }
    watch(windowId);
    prompts.foreground(windowId, guest);
    return true;
  }

  // Forget a window's prompts when it closes: its own close with it.
  // Whether the window is open and watched; one closed already is not.
  function watch(windowId) {
    if (watchedWindows.has(windowId)) return true;
    let open;
    try {
      open =
        watchWindow(windowId, () => {
          watchedWindows.delete(windowId);
          prompts.forgetWindow(windowId);
        }) !== false;
    } catch {
      open = false;
    }
    if (open) watchedWindows.add(windowId);
    return open;
  }

  async function run(record, dispatch, event, nonce, naming, params) {
    try {
      if (naming) {
        // The document's name check is pending: wait for it, and attest
        // again in full, since the guest may have navigated meanwhile.
        const attested = await documents.attest(event, nonce);
        if (!attested.ok) {
          answer(record, refusal(attested.reason));
          return;
        }
        record.requester = attested.requester;
      }
      if (record.answered) return;
      let out;
      try {
        // For the window that hosts the tab: a phone account's job shows
        // its QR in that window's sidebar (APS-4, `request-window.js`).
        out = await runInWindow(record.window, () => dispatch(contextOf(record, params)));
      } catch (err) {
        out = { error: { code: err?.code, message: err?.message, data: err?.data } };
      }
      answer(record, normalizeAnswer(out));
    } finally {
      settle(record);
    }
  }

  /**
   * `page:bind-name` from the chrome: hold `name` for the next main-frame
   * commit of `guest`, a tab of the sending chrome window, on `ipns://<key>`.
   * Main checks the name itself at that commit; this decides nothing.
   */
  function bindName(event, payload) {
    if (!isPlainObject(payload)) return false;
    const { guest, name, key } = payload;
    if (!Number.isInteger(guest)) return false;
    let contents;
    try {
      contents = webContentsFromId(guest);
      if (!isLive(contents) || contents.getType() !== 'webview') return false;
      const hostId = contents.hostWebContents?.id;
      if (!Number.isInteger(hostId) || hostId !== event?.sender?.id) return false;
    } catch {
      return false;
    }
    const bound = documents.bindName({ guest, name, key });
    trace({ kind: 'bind-name', guest, ok: bound });
    return bound;
  }

  /** `page:hello`: bind the nonce to the sender's current document. */
  function hello(event, payload) {
    const result = documents.hello(event, payload);
    trace({ kind: 'hello', result });
    return result;
  }

  /**
   * `page:request`. Answers `{ result }` or `{ error }`, or `GONE` once the
   * document that asked has gone.
   */
  function request(event, payload) {
    // A ticket is burnt on arrival, before any other check, whether the
    // request is then served or refused, and whatever it arrived on: an
    // array or any other container can carry an own `ticket` through IPC
    // too. None is presented twice.
    const ticket = budgets.burn(presentedTicket(payload));
    const refuse = (answer, reason) => {
      budgets.refuseTicket(ticket);
      trace({ kind: 'refused', reason });
      return answer;
    };
    if (!isPlainObject(payload)) return refuse(errorOf(INVALID_REQUEST), 'shape');
    const presented = Object.prototype.hasOwnProperty.call(payload, 'ticket');
    if (!hasOnlyKeys(payload, REQUEST_KEYS)) return refuse(errorOf(INVALID_REQUEST), 'shape');
    const { nonce, provider, method, params } = payload;
    if (typeof provider !== 'string' || !PROVIDER_SET.has(provider)) return refuse(errorOf(INVALID_REQUEST), 'shape');
    if (typeof method !== 'string' || !method) return refuse(errorOf(INVALID_REQUEST), 'shape');
    const row = methodRow(provider, method);
    if (!row) return refuse({ error: unknownMethodError(provider, method) }, 'unlisted');
    if (row.class === CLASS.REFUSED) return refuse({ error: { ...row.error } }, 'refused');
    const dispatch = dispatcherFor(provider, method);
    if (!dispatch) return refuse({ error: unknownMethodError(provider, method) }, 'no-dispatcher');
    // Measured first, before main keeps, copies or validates anything.
    const measured = measurePageRequest(payload, pageRequestMaxBytes(provider, method), { skipKey: 'ticket' });
    if (!measured.ok) {
      return refuse({ error: pageRequestWalkError(measured.reason, provider, method, measured.size) }, measured.reason);
    }
    // A large request needs a ticket main holds, and any ticket presented
    // must be one.
    if ((presented && !ticket) || (measured.size > PAGE_REQUEST_LIMITS.ticketAbove && !ticket)) {
      return refuse(errorOf(LIMIT_EXCEEDED), 'ticket');
    }
    const attested = documents.attestNow(event, nonce);
    if (!attested.ok) return refuse(refusal(attested.reason), attested.reason);
    const chargeBytes = chargeOf(provider, method, measured);
    let charge;
    if (ticket) {
      // The ticket's charge, the most a request of its size can be charged,
      // moves to the request with no gap; or both go on a mismatch.
      charge = budgets.takeTicket(ticket, attested.requester, method, measured.size);
      if (!charge) {
        trace({ kind: 'refused', reason: 'ticket-binding' });
        return errorOf(LIMIT_EXCEEDED);
      }
    } else {
      charge = budgets.admit(attested.requester, chargeBytes);
      if (!charge) {
        trace({ kind: 'refused', reason: 'limit' });
        return errorOf(LIMIT_EXCEEDED);
      }
    }
    const record = open(attested.requester, provider, method, row, charge, chargeBytes);
    run(record, dispatch, event, nonce, attested.naming, params);
    return record.reply;
  }

  /**
   * `page:reserve`: a turn for a request over 1 MiB. Answers `{ ticket }`
   * when its turn comes, or `{ error }`, or `GONE` once the document that
   * asked has gone.
   */
  function reserve(event, payload) {
    if (!isPlainObject(payload) || !hasOnlyKeys(payload, RESERVE_KEYS)) return errorOf(INVALID_REQUEST);
    const attested = documents.attestNow(event, payload.nonce);
    if (!attested.ok) {
      trace({ kind: 'refused', reason: attested.reason });
      return refusal(attested.reason);
    }
    return budgets.reserve(attested.requester, { method: payload.method, bytes: payload.bytes }, refusal);
  }

  // What a waiting reservation passes again before its ticket is made: the
  // guest live, the document current, its frame the guest's main frame and
  // not detached, and the frame URL on the document's transport key.
  function documentHolds(requester) {
    if (!documents.isCurrent(requester)) return false;
    const frame = liveMainFrame(requester);
    if (!frame) return false;
    try {
      return transportKeyOf(frame.url) === requester.transportKey;
    } catch {
      return false;
    }
  }

  // The guest's main frame, if it is still the target's frame.
  function liveMainFrame(target) {
    try {
      const guest = webContentsFromId(target.guest);
      if (!isLive(guest)) return null;
      const frame = guest.mainFrame;
      if (!frame || frame.detached || frame.frameTreeNodeId !== target.frame) return null;
      return frame;
    } catch {
      return null;
    }
  }

  /**
   * Send `event` to the target document (an attested requester), with its
   * nonce: only an event with a row, only while the document is current,
   * and only to its guest's main frame. A name-revalidated event goes to a
   * name-keyed document only once main has resolved the name again to the
   * document's IPNS key (design 0011, "Events"); a name that no longer
   * answers ends the binding, and the event isn't sent.
   *
   * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
   */
  async function sendEvent(target, provider, event, data) {
    const outcome = await deliverEvent(target, provider, event, data);
    if (!outcome.ok) {
      trace({
        kind: 'event-refused',
        provider,
        event,
        guest: target?.guest ?? null,
        navigation: target?.navigation ?? null,
        reason: outcome.reason,
      });
    }
    return outcome;
  }

  // The checks and the send. Up to its first wait it runs in the caller's
  // turn: an event that resolves no name is sent before `sendEvent` returns
  // its promise, so events sent one after another arrive in that order.
  async function deliverEvent(target, provider, event, data) {
    const row = eventRow(provider, event);
    if (!row) return { ok: false, reason: 'unlisted' };
    if (!target || !documents.isCurrent(target)) return { ok: false, reason: 'navigated' };
    const named = row.class === CLASS.NAME_REVALIDATED && target.key !== target.transportKey;
    if (named) {
      const checked = await documents.recheckName(target);
      if (!checked.ok || !documents.holdsKey(target) || !documentHolds(target)) {
        return { ok: false, reason: 'name-moved' };
      }
    }
    const message = { nonce: target.nonce, provider, event, data };
    if (typeof hooks.beforeEventSend === 'function') await hooks.beforeEventSend(message, target);
    if (named && !documents.holdsKey(target)) return { ok: false, reason: 'name-moved' };
    const frame = liveMainFrame(target);
    if (!frame) return { ok: false, reason: 'navigated' };
    try {
      frame.send(CHANNELS.EVENT, message);
    } catch {
      return { ok: false, reason: 'navigated' };
    }
    trace({ kind: 'event-sent', provider, event, guest: target.guest, navigation: target.navigation });
    return { ok: true };
  }

  /** The open handle `handle` of window `windowId`'s requests, or null. */
  function findHandle(windowId, handle) {
    const record = typeof handle === 'string' ? handles.get(handle) : null;
    if (!record || record.window !== windowId) return null;
    return Object.freeze({ id: record.id, handle, requester: record.requester, shown: record.shown });
  }

  /** Hear of every handle that closes. Returns a function that stops it. */
  function onHandleClosed(listener) {
    if (typeof listener !== 'function') return () => {};
    handleListeners.add(listener);
    return () => handleListeners.delete(listener);
  }

  /** Requests in flight and what they are charged, for tests and diagnostics. */
  function stats() {
    return { ...budgets.usage(), records: records.size, handles: handles.size };
  }

  function register(ipcMain) {
    ipcMain.on(CHANNELS.HELLO, (event, payload) => {
      hello(event, payload);
    });
    ipcMain.on(CHANNELS.BIND_NAME, (event, payload) => {
      bindName(event, payload);
    });
    ipcMain.handle(CHANNELS.RESERVE, (event, payload) => reserve(event, payload));
    ipcMain.handle(CHANNELS.REQUEST, async (event, payload) => {
      // Test only: a request held on its way in, before main takes it.
      if (typeof hooks.holdRequest === 'function') await hooks.holdRequest(payload);
      return request(event, payload);
    });
    ipcMain.handle(CHANNELS.DECIDE, (event, payload) => decide(event, payload));
    ipcMain.handle(CHANNELS.CANCEL, (event, payload) => cancel(event, payload));
    ipcMain.on(CHANNELS.FOREGROUND, (event, payload) => {
      foreground(event, payload);
    });
  }

  return {
    track: (contents) => documents.track(contents),
    liveDocuments: () => documents.liveDocuments(),
    inGrantOrder,
    inChainOrder,
    bindName,
    hello,
    reserve,
    request,
    sendEvent,
    findHandle,
    onHandleClosed,
    decide,
    decideInWindow,
    cancel,
    cancelInWindow,
    walletPrompt,
    walletUnlock,
    foreground,
    promptState: () => prompts.state(),
    promptUsage: () => prompts.usage(),
    stats,
    register,
  };
}

// The app's one instance, and its test hooks: inert until the E2E harness
// enables them (test-harness.js, only under FREEDOM_TEST_MODE).
const sharedHooks = {};
let shared = null;

// Main's own resolution of a bound name, or the harness's stand-in for it
// (real ENS needs the network).
function resolveBoundName(name) {
  if (sharedHooks.enabled === true && typeof sharedHooks.resolveName === 'function') {
    return sharedHooks.resolveName(name);
  }
  return require('../ens-resolver').resolveEnsContent(name);
}

function getPageRequests() {
  if (!shared) {
    const { createEthereumDispatchers } = require('./page-ethereum');
    const { createSwarmDispatchers, registerSwarmPageEvents } = require('./page-swarm');
    const { createRadicleDispatchers, registerRadiclePageEvents } = require('./page-radicle');
    const { isApprovalsDocumentEnabled, getApprovalsDocuments } = require('../approvals/approvals-document');
    shared = createPageRequests({
      documents: createPageDocuments({ resolveEnsContent: resolveBoundName }),
      dispatchers: {
        // The identity core answers the reads, the connect and the switch
        // (design 0012, APB-4a).
        ...createEthereumDispatchers({ relay: require('./page-eip1193').getEip1193Relay() }),
        ...createSwarmDispatchers(),
        ...createRadicleDispatchers(),
      },
      hooks: sharedHooks,
      approvals: isApprovalsDocumentEnabled() ? getApprovalsDocuments() : null,
      unlockVault: (password) => require('../identity-manager').unlockVault(password),
      touchIdAvailable: async () => {
        const quickUnlock = require('../quick-unlock');
        return (await quickUnlock.canUseTouchId()) === true && (await quickUnlock.isQuickUnlockEnabled()) === true;
      },
      unlockWithTouchId: () => require('../quick-unlock').unlockWithTouchId(),
    });
    registerSwarmPageEvents(shared);
    registerRadiclePageEvents(shared);
  }
  return shared;
}

function registerPageRequestsIpc(ipcMain = require('electron').ipcMain) {
  getPageRequests().register(ipcMain);
}

/** Number a tab guest's documents (webcontents-setup.js). */
function trackPageGuest(contents) {
  getPageRequests().track(contents);
}

/**
 * Test only: turn on the hooks that run the new path (the E2E harness,
 * under FREEDOM_TEST_MODE). Returns what the harness exposes to specs.
 */
function enablePageRequestTestHooks() {
  sharedHooks.enabled = true;
  // The harness's own prompt kind (`test.prompt`), for the approvals
  // document's tests (APS-1).
  sharedHooks.testPrompts = true;
  const trace = [];
  sharedHooks.onTrace = (entry) => {
    trace.push(entry);
    if (trace.length > 1000) trace.shift();
  };
  return {
    trace,
    setDispatch: (dispatch) => {
      sharedHooks.dispatch = typeof dispatch === 'function' ? dispatch : undefined;
    },
    setBeforeEventSend: (hold) => {
      sharedHooks.beforeEventSend = typeof hold === 'function' ? hold : undefined;
    },
    setOnCopy: (hear) => {
      sharedHooks.onCopy = typeof hear === 'function' ? hear : undefined;
    },
    setResolveName: (resolve) => {
      sharedHooks.resolveName = typeof resolve === 'function' ? resolve : undefined;
    },
    setHoldRequest: (hold) => {
      sharedHooks.holdRequest = typeof hold === 'function' ? hold : undefined;
    },
    promptState: () => getPageRequests().promptState(),
    liveDocuments: () => getPageRequests().liveDocuments(),
    sendEvent: (target, provider, event, data) => getPageRequests().sendEvent(target, provider, event, data),
    stats: () => getPageRequests().stats(),
  };
}

module.exports = {
  CHANNELS,
  CLOSED,
  GONE,
  createPageRequests,
  getPageRequests,
  registerPageRequestsIpc,
  trackPageGuest,
  enablePageRequestTestHooks,
};
