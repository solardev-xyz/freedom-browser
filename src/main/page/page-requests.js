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

const CHANNELS = Object.freeze({
  HELLO: 'page:hello',
  RESERVE: 'page:reserve',
  REQUEST: 'page:request',
  EVENT: 'page:event',
  BIND_NAME: 'page:bind-name',
});

const REQUEST_KEYS = new Set(['nonce', 'provider', 'method', 'params', 'ticket']);
const RESERVE_KEYS = new Set(['nonce', 'method', 'bytes']);

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

/** A refused requester: the attestation's reason, nothing more. */
const refusal = (reason) => errorOf(UNAUTHORIZED, { reason });

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

/**
 * @param {object} [options]
 * @param {object} [options.documents] page-documents.js's API.
 * @param {(id: number) => object} [options.webContentsFromId]
 * @param {Record<string, Function>} [options.dispatchers] `provider:method`
 *   -> `async (context) => ({ result } | { error })`. Empty in the app.
 * @param {object} [options.hooks] test hooks, read at each use: `dispatch`
 *   serves every method with a row, `beforeEventSend(message, target)` may
 *   hold an event between main's check and the send, `onTrace(entry)` hears
 *   what main did, and `onCopy(entry)` hears each copy a dispatcher reports
 *   (`context.copied`), with whether the request's charge is in place.
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
    release(record);
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
    for (const listener of handleListeners) {
      try {
        listener(closed);
      } catch {
        // One listener's failure must not keep the others from hearing it.
      }
    }
    return true;
  }

  // A handle for the record's prompt: 32 random bytes, scoped to its window.
  function openHandle(record) {
    if (record.answered) return null;
    if (record.handle) return handles.get(record.handle) === record ? record.handle : null;
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
      openHandle: () => openHandle(record),
      markShown: () => markShown(record),
      copied: (label) => copied(record, label),
    });
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
   * and only to its guest's main frame. Until main resolves a name again
   * before an event (`documents.recheckName`, from PRQ-6), a
   * name-revalidated event never goes to a name-keyed document.
   *
   * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
   */
  async function sendEvent(target, provider, event, data) {
    const row = eventRow(provider, event);
    if (!row) return { ok: false, reason: 'unlisted' };
    if (!target || !documents.isCurrent(target)) return { ok: false, reason: 'navigated' };
    if (row.class === CLASS.NAME_REVALIDATED && target.key !== target.transportKey) {
      return { ok: false, reason: 'name-unchecked' };
    }
    const message = { nonce: target.nonce, provider, event, data };
    if (typeof hooks.beforeEventSend === 'function') await hooks.beforeEventSend(message, target);
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
    ipcMain.handle(CHANNELS.REQUEST, (event, payload) => request(event, payload));
  }

  return {
    track: (contents) => documents.track(contents),
    bindName,
    hello,
    reserve,
    request,
    sendEvent,
    findHandle,
    onHandleClosed,
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
