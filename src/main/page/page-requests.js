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
 * The app serves the Ethereum reads here (PRQ-3, `page-ethereum.js`):
 * the preload sends those on `page:request`, and every other method still
 * takes today's path through the chrome. The E2E harness can route and
 * serve any method through a test hook (`enablePageRequestTestHooks`).
 * Later steps (PRQ-4 to PRQ-8) move the rest.
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
 * A record prompts one prompt at a time, and may prompt again once its
 * prompt is decided (PRQ-5: a vault unlock and then the signature, a Safe's
 * approval and then its signing board, or a send's fee asked again at the
 * press). An approved wallet prompt keeps the document's one wallet slot for
 * its record until main answers it, so the record's next prompt, or its
 * effect, isn't raced by another, unless the record gives it up while it
 * waits with nothing to show (`leaveWalletSlot`).
 *
 * Main's own issuer (PRQ-5, design 0011 "Approval tokens"): a page kind's
 * approval token is minted only for a live record whose prompt the user has
 * just approved (`context.confirm`), bound to that prompt's handle and the
 * requester's attested key, with the account and payload the dispatcher
 * holds. The dispatcher spends it itself (`context.spend`), after checking
 * the document again: a token for a document that has gone is refused and
 * burnt. An approval mints one token.
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
const signingConfirmation = require('../wallet/signing-confirmation');
const { CHANNELS: PROMPT_CHANNELS, KIND_SET, WALLET_KINDS, createPagePrompts } = require('./page-prompts');

const CHANNELS = Object.freeze({
  HELLO: 'page:hello',
  RESERVE: 'page:reserve',
  REQUEST: 'page:request',
  EVENT: 'page:event',
  BIND_NAME: 'page:bind-name',
  ...PROMPT_CHANNELS,
});

const REQUEST_KEYS = new Set(['nonce', 'provider', 'method', 'params', 'ticket']);
const RESERVE_KEYS = new Set(['nonce', 'method', 'bytes']);
const FOREGROUND_KEYS = new Set(['guest']);

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

function notConfirmed(reason) {
  const err = new Error(`Signing was not confirmed: ${reason}`);
  err.code = signingConfirmation.NOT_CONFIRMED;
  return err;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// A dispatcher's answer as the page gets it: `{ result }` or `{ error }`,
// the error with a numeric code and a string message.
function normalizeAnswer(answer) {
  if (answer && typeof answer === 'object' && Object.prototype.hasOwnProperty.call(answer, 'error') && answer.error) {
    return { error: normalizeError(answer.error) };
  }
  return { result: answer && typeof answer === 'object' ? answer.result : undefined };
}

function normalizeError(error) {
  const out = {
    code: Number.isInteger(error?.code) ? error.code : INTERNAL_ERROR.code,
    message: typeof error?.message === 'string' && error.message ? error.message : INTERNAL_ERROR.message,
  };
  if (error && typeof error === 'object' && error.data !== undefined) out.data = error.data;
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

function defaultWatchWindow(windowId, onClosed) {
  const { BrowserWindow } = require('electron');
  BrowserWindow.fromId(windowId)?.once('closed', onClosed);
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
 */
function createPageRequests({
  documents = createPageDocuments(),
  webContentsFromId = (id) => require('electron').webContents.fromId(id),
  dispatchers = {},
  hooks = {},
  budgets: budgetBounds = BUDGETS,
  tickets: ticketBounds = TICKETS,
  randomHex = (bytes) => crypto.randomBytes(bytes).toString('hex'),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  chromeWindowOf = defaultChromeWindowOf,
  sendToWindow = defaultSendToWindow,
  watchWindow = defaultWatchWindow,
} = {}) {
  let lastId = 0;
  const records = new Map(); // id -> record
  const byDocument = new Map(); // `${guest}:${navigation}` -> Set<record>
  const handles = new Map(); // handle -> record
  const handleListeners = new Set();

  const trace = (entry) => {
    try {
      hooks.onTrace?.(entry);
    } catch {
      // A test hook never changes what main does.
    }
  };

  const prompts = createPagePrompts({
    send: (windowId, channel, payload) => sendToWindow(windowId, channel, payload),
    markShown: (entry) => markShown(entry.record),
    decided: (entry) => decidedEntry(entry),
    trace,
  });
  const watchedWindows = new Set();
  // document key -> the record whose wallet operation outside main's
  // prompts (the agent service's own approval) holds the document's one
  // wallet slot (`walletOperation`).
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
      // Aborted when the record is answered, for a wallet operation it runs
      // (`walletOperation`).
      aborter: null,
      // The handle of the prompt the user last approved, until main's issuer
      // mints its one token (`confirm`), and the handle that token is for.
      approved: null,
      tokenHandle: null,
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
  // approval is what main's issuer may mint the record's token on, and an
  // approved wallet prompt keeps the document's wallet slot for its record
  // until main answers it.
  function decidedEntry(entry) {
    const { record } = entry;
    if (entry.decided?.approve === true && !record.answered) {
      record.approved = entry.handle;
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

  // A document ended: its handles close, nothing is answered to it, and its
  // reservation, waiting or granted, is released.
  documents.onEnded(({ guest, navigation, reason }) => {
    budgets.documentEnded(`${guest}:${navigation}`, GONE);
    const inDocument = byDocument.get(`${guest}:${navigation}`);
    if (!inDocument) return;
    const closeReason = reason === 'closed' ? CLOSED.CLOSED : CLOSED.NAVIGATED;
    for (const record of [...inDocument]) {
      closeHandle(record, closeReason);
      answer(record, GONE);
    }
  });

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
      holdsKey: () => documents.holdsKey(record.requester),
      openHandle: () => openHandle(record),
      markShown: () => markShown(record),
      prompt: (spec) => prompt(record, spec),
      confirm: (kind, accountIndex, payload, bound) => confirm(record, kind, accountIndex, payload, bound),
      spend: (token, kind, accountIndex, payload) => spend(record, token, kind, accountIndex, payload),
      walletOperation: (run) => walletOperation(record, run),
      leaveWalletSlot: () => leaveWalletSlot(record),
      // Aborted when main answers the record: for a dispatcher that waits on
      // something outside main's prompts.
      get signal() {
        return abortSignalOf(record);
      },
      afterAnswer: (fn) => {
        if (typeof fn === 'function' && !record.answered) record.after = fn;
      },
      liveDocuments: () => documents.liveDocuments(),
      sendEvent: (target, event, data) => sendEvent(target, record.provider, event, data),
      inGrantOrder: (key, job) => inGrantOrder(key, job),
      inChainOrder: (windowId, job) => inChainOrder(windowId, job),
      copied: (label) => copied(record, label),
    });
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
  async function prompt(record, { kind, view = {}, choices } = {}) {
    if (!KIND_SET.has(kind)) throw new Error(`page-requests: no prompt of kind ${kind}`);
    if (record.answered) return { closed: CLOSED.CANCELLED };
    if (record.handle && handles.get(record.handle) === record) {
      throw new Error('page-requests: a record prompts one prompt at a time');
    }
    if (WALLET_KINDS.has(kind) && walletSlotTaken(record)) {
      trace({ kind: 'prompt-refused', id: record.id, reason: 'pending' });
      return { error: { ...PROMPT_PENDING } };
    }
    const handle = openHandle(record);
    if (!handle) return { closed: CLOSED.CANCELLED };
    const { requester } = record;
    const entry = prompts.add({
      handle,
      record,
      window: record.window,
      guest: requester.guest,
      document: record.key,
      kind,
      site: { key: requester.key, label: requester.key },
      view,
      choices,
    });
    return entry.decision;
  }

  /**
   * Main's own issuer (design 0011, "Approval tokens"): a token of a page
   * kind, for this live record only, on the approval of the prompt the user
   * just decided, bound to that prompt's handle and the requester's attested
   * key. The account and payload are the dispatcher's, from the request main
   * holds. One approval mints one token. Throws (`SIGNING_NOT_CONFIRMED`)
   * with nothing minted otherwise. The token never leaves main.
   */
  function confirm(record, kind, accountIndex, payload, bound) {
    const handle = record.approved;
    if (record.answered || !handle || !documents.isCurrent(record.requester) || !record.requester.key) {
      throw notConfirmed('no live request approved by the user');
    }
    const { token } = signingConfirmation.issuePageConfirmation(
      kind,
      accountIndex,
      payload,
      { handle, key: record.requester.key },
      bound
    );
    record.approved = null;
    record.tokenHandle = handle;
    trace({ kind: 'token-minted', id: record.id, token: kind });
    return token;
  }

  /**
   * Spend the record's token for the request it is about to sign: the
   * document checked again first, and the token refused and burnt if the
   * document has gone or no longer holds its key. Returns what the token
   * bound (`{ hash }` for typed data).
   */
  function spend(record, token, kind, accountIndex, payload) {
    if (record.answered || !documents.isCurrent(record.requester) || !documents.holdsKey(record.requester)) {
      signingConfirmation.discardConfirmation(token);
      throw notConfirmed('the document that asked has gone');
    }
    const handle = record.tokenHandle;
    record.tokenHandle = null;
    try {
      return signingConfirmation.consumePageConfirmation(token, kind, accountIndex, payload, {
        handle,
        key: record.requester.key,
      });
    } finally {
      trace({ kind: 'token-spent', id: record.id, token: kind });
    }
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
   * A wallet operation that asks the user somewhere other than main's
   * prompts: the agent service's own approval, for a tab the agent holds
   * (design 0011, "Agent custody"). It takes the document's one wallet slot
   * as a prompt does, so the document's next wallet request gets `-32002`
   * while it runs, and it lives within the record: `run({ signal, open })`
   * gets a signal aborted when main answers the record (its deadline, its
   * document gone, its window closed) and `open()`, true until then. An
   * effect the operation makes must check `open()` first.
   *
   * Settles with `{ done: value }`, or `{ error }`: `-32002` while the slot
   * is taken, or a record already answered.
   */
  async function walletOperation(record, run) {
    if (record.answered) return { error: { ...INTERNAL_ERROR } };
    if (walletSlotTaken(record)) {
      trace({ kind: 'prompt-refused', id: record.id, reason: 'pending' });
      return { error: { ...PROMPT_PENDING } };
    }
    walletOperations.set(record.key, record);
    try {
      const value = await run({ signal: abortSignalOf(record), open: () => !record.answered });
      return { done: value };
    } finally {
      if (walletOperations.get(record.key) === record) walletOperations.delete(record.key);
    }
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
    const outcome = prompts.decide(windowId, payload);
    trace({ kind: 'decide', window: windowId, ok: outcome.ok, reason: outcome.reason });
    if (!outcome.ok) return outcome;
    await outcome.entry.record.reply;
    return { ok: true };
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
    if (!watchedWindows.has(windowId)) {
      watchedWindows.add(windowId);
      try {
        watchWindow(windowId, () => {
          watchedWindows.delete(windowId);
          prompts.forgetWindow(windowId);
        });
      } catch {
        // Forgotten with the process, then.
      }
    }
    prompts.foreground(windowId, guest);
    return true;
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
        out = await dispatch(contextOf(record, params));
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
    foreground,
    promptState: () => prompts.state(),
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
    shared = createPageRequests({
      documents: createPageDocuments({ resolveEnsContent: resolveBoundName }),
      dispatchers: createEthereumDispatchers(),
      hooks: sharedHooks,
    });
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
 * Test only: the methods the harness routes through `page:request`, for the
 * preload's boot switch. Empty unless the harness enabled the hooks and set
 * some.
 */
function testPageRoutes() {
  if (sharedHooks.enabled !== true || !Array.isArray(sharedHooks.routes)) return [];
  return sharedHooks.routes.filter((route) => typeof route === 'string');
}

/**
 * Test only: turn on the hooks that run the new path (the E2E harness,
 * under FREEDOM_TEST_MODE). Returns what the harness exposes to specs.
 */
function enablePageRequestTestHooks() {
  sharedHooks.enabled = true;
  sharedHooks.routes = [];
  const trace = [];
  sharedHooks.onTrace = (entry) => {
    trace.push(entry);
    if (trace.length > 1000) trace.shift();
  };
  return {
    trace,
    setRoutes: (routes) => {
      sharedHooks.routes = Array.isArray(routes) ? routes.slice() : [];
    },
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
  testPageRoutes,
  enablePageRequestTestHooks,
};
