'use strict';

/**
 * Page requests: the channels between a tab's preload and main, the request
 * records and their handles, and delivery (freedom-core design 0011, "The
 * way in", "Requests and handles" and "Events"; step PRQ-2).
 *
 *   page:hello    preload -> main (send)    { nonce }
 *   page:request  preload -> main (invoke)  { nonce, provider, method, params }
 *                                           -> { result } | { error }
 *   page:event    main -> preload           { nonce, provider, event, data }
 *                 (WebFrameMain.send)
 *
 * A request is refused, before anything runs, when its method has no row in
 * the closed method table (`page-methods.js`), when the table refuses it, or
 * when no dispatcher serves it. Then main attests the sender
 * (`page-documents.js`: a tab, not private, not a preview, the top frame,
 * the current document's nonce, the frame URL on the document's transport
 * key) and admits the request only while its document, its window and the
 * browser each have room for one more in flight. Only then does main record
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
 * No provider method is served here yet: `dispatchers` is empty in the app,
 * so every method still takes today's path through the chrome, and the
 * preload sends none on `page:request`. The path runs through a test hook
 * only (`enablePageRequestTestHooks`), which the E2E harness turns on. Later
 * steps (PRQ-3 to PRQ-8) move each provider's methods.
 */

const crypto = require('crypto');
const {
  CLASS,
  PROVIDERS,
  methodRow,
  eventRow,
  unknownMethodError,
  timeoutError,
} = require('./page-methods');
const { createPageDocuments } = require('./page-documents');

const CHANNELS = Object.freeze({
  HELLO: 'page:hello',
  REQUEST: 'page:request',
  EVENT: 'page:event',
});

// Requests in flight (design 0011, "The numbers", proposed). PRQ-2b adds
// the byte budgets beside these counts.
const BOUNDS = Object.freeze({ document: 64, window: 256, browser: 1024 });

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
 *   what main did.
 */
function createPageRequests({
  documents = createPageDocuments(),
  webContentsFromId = (id) => require('electron').webContents.fromId(id),
  dispatchers = {},
  hooks = {},
  bounds = BOUNDS,
  randomHex = (bytes) => crypto.randomBytes(bytes).toString('hex'),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let lastId = 0;
  const records = new Map(); // id -> record
  const byDocument = new Map(); // `${guest}:${navigation}` -> Set<record>
  const perWindow = new Map(); // window id -> requests in flight
  const handles = new Map(); // handle -> record
  const handleListeners = new Set();

  const trace = (entry) => {
    try {
      hooks.onTrace?.(entry);
    } catch {
      // A test hook never changes what main does.
    }
  };

  const documentKey = (requester) => `${requester.guest}:${requester.navigation}`;

  function dispatcherFor(provider, method) {
    if (typeof hooks.dispatch === 'function') return hooks.dispatch;
    const dispatcher = dispatchers[`${provider}:${method}`];
    return typeof dispatcher === 'function' ? dispatcher : null;
  }

  // The count bounds: room for one more request in the document, its window
  // and the browser.
  function hasRoom(requester) {
    const inDocument = byDocument.get(documentKey(requester))?.size || 0;
    const inWindow = perWindow.get(requester.window) || 0;
    return inDocument < bounds.document && inWindow < bounds.window && records.size < bounds.browser;
  }

  function stopDeadline(record) {
    if (record.timer === null) return;
    clearTimer(record.timer);
    record.timer = null;
  }

  function open(requester, provider, method, row) {
    const record = {
      id: ++lastId,
      key: documentKey(requester),
      window: requester.window,
      requester,
      provider,
      method,
      row,
      handle: null,
      shown: false,
      timer: null,
      answered: false,
      settled: false,
      released: false,
      resolve: null,
      reply: null,
    };
    record.reply = new Promise((resolve) => {
      record.resolve = resolve;
    });
    records.set(record.id, record);
    if (!byDocument.has(record.key)) byDocument.set(record.key, new Set());
    byDocument.get(record.key).add(record);
    perWindow.set(record.window, (perWindow.get(record.window) || 0) + 1);
    record.timer = setTimer(() => expire(record), row.timeoutMs);
    record.timer?.unref?.();
    trace({ kind: 'recorded', id: record.id, provider, method, guest: requester.guest, navigation: requester.navigation });
    return record;
  }

  // The record leaves the bounds once it is answered and its work is over.
  function release(record) {
    if (record.released || !record.answered || !record.settled) return;
    record.released = true;
    stopDeadline(record);
    closeHandle(record, CLOSED.CANCELLED);
    records.delete(record.id);
    const inDocument = byDocument.get(record.key);
    inDocument?.delete(record);
    if (inDocument && inDocument.size === 0) byDocument.delete(record.key);
    const inWindow = (perWindow.get(record.window) || 1) - 1;
    if (inWindow > 0) perWindow.set(record.window, inWindow);
    else perWindow.delete(record.window);
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

  // A document ended: its handles close, and nothing is answered to it.
  documents.onEnded(({ guest, navigation, reason }) => {
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
      openHandle: () => openHandle(record),
      markShown: () => markShown(record),
    });
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
    if (!isPlainObject(payload)) return errorOf(INVALID_REQUEST);
    const { nonce, provider, method, params } = payload;
    if (typeof provider !== 'string' || !PROVIDER_SET.has(provider)) return errorOf(INVALID_REQUEST);
    if (typeof method !== 'string' || !method) return errorOf(INVALID_REQUEST);
    const row = methodRow(provider, method);
    if (!row) return { error: unknownMethodError(provider, method) };
    if (row.class === CLASS.REFUSED) return { error: { ...row.error } };
    const dispatch = dispatcherFor(provider, method);
    if (!dispatch) return { error: unknownMethodError(provider, method) };
    const attested = documents.attestNow(event, nonce);
    if (!attested.ok) {
      trace({ kind: 'refused', provider, method, reason: attested.reason });
      return refusal(attested.reason);
    }
    if (!hasRoom(attested.requester)) {
      trace({ kind: 'refused', provider, method, reason: 'limit' });
      return errorOf(LIMIT_EXCEEDED);
    }
    const record = open(attested.requester, provider, method, row);
    run(record, dispatch, event, nonce, attested.naming, params);
    return record.reply;
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
   * before an event (from PRQ-3), a name-revalidated event never goes to a
   * name-keyed document.
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

  /** Requests in flight, for tests and diagnostics. */
  function stats() {
    return {
      browser: records.size,
      windows: Object.fromEntries(perWindow),
      documents: Object.fromEntries([...byDocument].map(([key, set]) => [key, set.size])),
      handles: handles.size,
    };
  }

  function register(ipcMain) {
    ipcMain.on(CHANNELS.HELLO, (event, payload) => {
      hello(event, payload);
    });
    ipcMain.handle(CHANNELS.REQUEST, (event, payload) => request(event, payload));
  }

  return {
    track: (contents) => documents.track(contents),
    hello,
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

function getPageRequests() {
  if (!shared) shared = createPageRequests({ hooks: sharedHooks });
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
    sendEvent: (target, provider, event, data) => getPageRequests().sendEvent(target, provider, event, data),
    stats: () => getPageRequests().stats(),
  };
}

module.exports = {
  CHANNELS,
  BOUNDS,
  CLOSED,
  GONE,
  createPageRequests,
  getPageRequests,
  registerPageRequestsIpc,
  trackPageGuest,
  testPageRoutes,
  enablePageRequestTestHooks,
};
