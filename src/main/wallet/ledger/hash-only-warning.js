'use strict';

/**
 * The hash-only warning's surfaces (freedom-core design 0016, "Typed data
 * on the device (Q23)"; the LDG-3 plan's points 12 and 19; LDG-3's PR 11),
 * on the core's Ledger backend (FREEDOM_LEDGER_BACKEND=core).
 *
 * A Ledger that can't show typed data field by field (a Nano S) answers
 * `6D00` to the operation's first `E0 1A`, and then shows only two hashes.
 * Main's relay holds that answer (core/ledger-relay.js `hashOnlySurface`)
 * until the warning that the device shows only hashes is on screen, with
 * the two hashes main computed, so the device never asks first: the core
 * sends `E0 0C 00 00` only after main's `{ answer, hash_only: "shown" }`.
 * This module is that hook: `hashOnlySurfaceFor(target)` gives the relay a
 * function that puts the warning up for one request and resolves true
 * once it is on screen, and false when it can't be shown (no window, a
 * hidden one, a report that never comes), which the relay answers with the
 * bare `6d00`: LEDGER_UNKNOWN, nothing signed.
 *
 * **Where it shows** (0016: "in the surface that waits on the device, where
 * one is open"):
 * - **The approvals document's waiting state** (approvals-document.js
 *   `presentHashOnly`), when the document runs and waits, in the target's
 *   window, on that very approval: a page prompt's approve (`handle`, the
 *   handle the core's `{ device }` names) or a Safe board's owner row
 *   (`owner`, the owner the board's decision picked).
 * - **Otherwise the chrome's notice over the tab** (`guest`, the tab's
 *   webContents id, and `site`, both what the chrome shows): a request no
 *   surface waits on, one a standing rule approved, an x402 payment, an
 *   approve the Agent's sheet gave, and, under FREEDOM_APPROVALS_DOCUMENT=0
 *   (the development rollback), every one. It stays until the operation
 *   ends.
 *
 * **"On screen"** (point 12): the surface reports after two
 * `requestAnimationFrame`s, with its document visible and the warning laid
 * out, and main counts a report only from that window's own document or
 * chrome, for the warning it sent last, while the window is visible and
 * not minimized.
 *
 * **The target** is read where the request starts, as `request-window.js`
 * reads the window: each entry point runs its work inside
 * `withHashOnlyTarget`, which adds to what the outer one set (a page's
 * request its tab and site, page-requests.js; a page's device signature
 * the approve's handle, page-devices.js; a Safe board's owner row its
 * owner and window, safe-boards.js; an x402 payment its tab, x402/sign-flow.js),
 * and `currentHashOnlySurface()` captures it, with the request's window,
 * when the signer is asked: the relay calls the hook later, from the
 * core's APDU, outside every entry point.
 *
 * **Cancel** (point 19, a user decision still open; the recommended option
 * is built): the notice over a tab has a Cancel button, which cancels the
 * request (main's own cancel of the relay's parent: the core is told, and
 * the device let go). To drop it: `NOTICE_CANCEL` here, the button in the
 * chrome's notice, `cancel` in its preload, and the relay's `cancel`
 * argument to the hook.
 *
 *   ledger:hash-only-notice         main -> chrome  { id, site, domainSeparator, structHash }
 *                                                   | { id, closed: true }
 *   ledger:hash-only-notice-shown   chrome -> main  { id }: on screen
 *   ledger:hash-only-notice-cancel  chrome -> main  { id }: the user's Cancel (point 19)
 */

const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');
const { requestWindowId, chromeWindowIdOf } = require('../../windows/request-window');

const CHANNELS = Object.freeze({
  NOTICE: 'ledger:hash-only-notice',
  NOTICE_SHOWN: 'ledger:hash-only-notice-shown',
  NOTICE_CANCEL: 'ledger:hash-only-notice-cancel',
});

/** A hash as main's binding gives it (core/ledger-relay.js `hashText`). */
const HASH = /^0x[0-9a-f]{64}$/;
/** A notice's id: 16 random bytes, as 32 lowercase hex digits. */
const NOTICE_ID = /^[0-9a-f]{32}$/;
/** The most of a site's text a notice carries. */
const MAX_SITE = 300;

const storage = new AsyncLocalStorage();

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function safely(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** The members of a target this module reads, each of its type, or none. */
function cleanTarget(target) {
  const out = {};
  if (!isPlainObject(target)) return out;
  if (Number.isInteger(target.windowId)) out.windowId = target.windowId;
  if (typeof target.handle === 'string' && target.handle.length > 0) out.handle = target.handle;
  if (Number.isSafeInteger(target.owner) && target.owner >= 0) out.owner = target.owner;
  if (Number.isInteger(target.guest)) out.guest = target.guest;
  if (typeof target.site === 'string' && target.site.length > 0) out.site = target.site.slice(0, MAX_SITE);
  return out;
}

/**
 * Run `fn` with `target` added to the hash-only target its caller set:
 * `{ windowId?, handle?, owner?, guest?, site? }`.
 */
function withHashOnlyTarget(target, fn) {
  const outer = storage.getStore() || {};
  return storage.run(Object.freeze({ ...outer, ...cleanTarget(target) }), fn);
}

/** The target the current operation runs with, its window the request's when it names none. */
function currentHashOnlyTarget(extra = null) {
  const target = { ...(storage.getStore() || {}), ...cleanTarget(extra) };
  if (!Number.isInteger(target.windowId)) {
    const windowId = requestWindowId();
    if (Number.isInteger(windowId)) target.windowId = windowId;
  }
  return Object.freeze(target);
}

function defaultChromeOf(windowId) {
  const { BrowserWindow } = require('electron');
  const { isChromeIndexUrl } = require('../../ipc-sender-policy');
  const win = BrowserWindow.fromId(windowId);
  if (!win || win.isDestroyed()) return null;
  const contents = win.webContents;
  if (!contents || contents.isDestroyed() || !isChromeIndexUrl(contents.getURL())) return null;
  return contents;
}

function defaultWindowShows(windowId) {
  const { BrowserWindow } = require('electron');
  const win = BrowserWindow.fromId(windowId);
  return Boolean(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized());
}

function defaultFocusedWindowId() {
  const { BrowserWindow } = require('electron');
  const win = BrowserWindow.getFocusedWindow();
  if (!win || win.isDestroyed()) return null;
  return chromeWindowIdOf(win.webContents);
}

/**
 * @param {object} [deps] injected for tests; each defaults to main's own.
 * @param {() => boolean} [deps.documentEnabled] whether the approvals document runs
 * @param {() => object|null} [deps.documents] the approvals documents (`presentHashOnly`)
 * @param {(windowId: number) => object|null} [deps.chromeOf] the window's chrome webContents
 * @param {(windowId: number) => boolean} [deps.windowShows] visible, not minimized
 * @param {() => number|null} [deps.focusedWindowId] the focused chrome window
 * @param {(contents: object) => number|null} [deps.windowOfSender] a chrome sender's window
 * @param {() => string} [deps.randomId] a notice's id
 */
function createHashOnlyWarnings({
  documentEnabled = () => require('../../approvals/approvals-document').isApprovalsDocumentEnabled(),
  documents = () => require('../../approvals/approvals-document').getApprovalsDocuments(),
  chromeOf = defaultChromeOf,
  windowShows = defaultWindowShows,
  focusedWindowId = defaultFocusedWindowId,
  windowOfSender = chromeWindowIdOf,
  randomId = () => crypto.randomBytes(16).toString('hex'),
  log = console,
} = {}) {
  // The notices up, by id: one per operation (the core's device lane runs
  // one at a time).
  const notices = new Map();

  function send(contents, payload) {
    try {
      if (!contents.isDestroyed()) contents.send(CHANNELS.NOTICE, payload);
    } catch {
      // The chrome mid-teardown: the notice goes with it, and no report comes.
    }
  }

  /** The notice over the tab, in window `windowId`'s chrome, until `signal` aborts. */
  function presentNotice(windowId, target, { domainSeparator, structHash }, signal, cancel) {
    const contents = safely(() => chromeOf(windowId), null);
    if (!contents) return Promise.resolve(false);
    const id = randomId();
    return new Promise((resolve) => {
      const notice = {
        id,
        windowId,
        contents,
        cancel: typeof cancel === 'function' ? cancel : null,
        reported: false,
        settle: resolve,
      };
      const settle = (value) => {
        const done = notice.settle;
        notice.settle = null;
        done?.(value);
      };
      notice.report = () => {
        notice.reported = true;
        settle(true);
      };
      notices.set(id, notice);
      send(contents, {
        id,
        site: target.site ?? null,
        domainSeparator,
        structHash,
      });
      // Up until the operation ends (the relay's signal: its parent's end,
      // or main giving up on the report).
      signal.addEventListener(
        'abort',
        () => {
          notices.delete(id);
          send(contents, { id, closed: true });
          settle(false);
        },
        { once: true }
      );
    });
  }

  /**
   * The relay's hook for `target`: the warning up for one request, its two
   * hashes main's binding's; resolves true once it is on screen. `signal`
   * aborts when main stops waiting for the report, or when the parent
   * ends, and takes it down; `cancel` is main's own cancel of the parent.
   */
  async function present(target, { domainSeparator, structHash, signal, cancel } = {}) {
    if (!HASH.test(domainSeparator ?? '') || !HASH.test(structHash ?? '')) return false;
    if (!(signal instanceof AbortSignal) || signal.aborted) return false;
    const clean = cleanTarget(target);
    const windowId = Number.isInteger(clean.windowId) ? clean.windowId : safely(focusedWindowId, null);
    if (!Number.isInteger(windowId)) {
      log.warn?.('[Ledger] no window for the hash-only warning');
      return false;
    }
    const hashes = { domainSeparator, structHash };
    if ((clean.handle || clean.owner !== undefined) && safely(documentEnabled, false)) {
      const waiting = safely(() => documents()?.presentHashOnly?.(windowId, clean, hashes, signal), null);
      if (waiting) return waiting;
    }
    return presentNotice(windowId, clean, hashes, signal, cancel);
  }

  /** The notice a chrome's report names, if it is that window's own and still up. */
  function noticeOf(event, payload) {
    if (!isPlainObject(payload) || Object.keys(payload).length !== 1 || !NOTICE_ID.test(payload.id ?? '')) {
      return null;
    }
    const notice = notices.get(payload.id);
    if (!notice) return null;
    const sender = event?.sender;
    if (!sender || sender !== notice.contents) return null;
    if (safely(() => windowOfSender(sender), null) !== notice.windowId) return null;
    return notice;
  }

  /** `ledger:hash-only-notice-shown { id }`: the notice is on screen. */
  function noticeShown(event, payload) {
    const notice = noticeOf(event, payload);
    if (!notice) return false;
    if (!safely(() => windowShows(notice.windowId), false)) return false;
    notice.report();
    return true;
  }

  /** `ledger:hash-only-notice-cancel { id }`: the user's Cancel (point 19). */
  function noticeCancel(event, payload) {
    const notice = noticeOf(event, payload);
    if (!notice?.cancel) return false;
    safely(() => notice.cancel());
    return true;
  }

  function register(ipcMain) {
    ipcMain.on(CHANNELS.NOTICE_SHOWN, (event, payload) => {
      noticeShown(event, payload);
    });
    ipcMain.on(CHANNELS.NOTICE_CANCEL, (event, payload) => {
      noticeCancel(event, payload);
    });
  }

  /** The relay's hook for `target` (`present`, bound to it). */
  const surfaceFor = (target) => {
    const bound = Object.freeze(cleanTarget(target));
    return (args) => present(bound, args);
  };

  /** For tests: the notices up. */
  const state = () => [...notices.values()].map((n) => ({ id: n.id, windowId: n.windowId, reported: n.reported }));

  return { present, surfaceFor, noticeShown, noticeCancel, register, state };
}

let shared = null;

function getHashOnlyWarnings() {
  if (!shared) {
    shared = createHashOnlyWarnings({ log: { warn: (...args) => require('../../logger').warn(...args) } });
  }
  return shared;
}

/** The relay's hook for an explicit target. */
function hashOnlySurfaceFor(target) {
  return getHashOnlyWarnings().surfaceFor(target);
}

/**
 * The relay's hook for the current operation's target (`withHashOnlyTarget`,
 * and the request's window), captured now, with `extra` added.
 */
function currentHashOnlySurface(extra = null) {
  return hashOnlySurfaceFor(currentHashOnlyTarget(extra));
}

/** The chrome's report and Cancel (wallet/ledger/ipc.js). */
function registerHashOnlyIpc(ipcMain) {
  getHashOnlyWarnings().register(ipcMain);
}

module.exports = {
  CHANNELS,
  createHashOnlyWarnings,
  getHashOnlyWarnings,
  withHashOnlyTarget,
  currentHashOnlyTarget,
  currentHashOnlySurface,
  hashOnlySurfaceFor,
  registerHashOnlyIpc,
};
