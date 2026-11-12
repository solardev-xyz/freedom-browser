'use strict';

/**
 * Page prompts: which pending prompt each window shows, and the decisions
 * on them (freedom-core design 0011, "Requests and handles" and "The prompt
 * protocol"; step PRQ-4).
 *
 * A prompt is a handle main issued for a live request record
 * (`page-requests.js`). Main keeps every open prompt of a window in order of
 * arrival, and the guest the window's chrome last reported in front
 * (`page:foreground`). It shows one prompt per window: the oldest open one
 * of the guest in front, of any kind. The rest wait, each on its tab's
 * badge and in the window's count. When another guest comes to the front,
 * the shown prompt is hidden and keeps its place, and the new guest's
 * oldest shows. Which prompt is shown is main's state, changed before main
 * tells the chrome, so a decision counts only for the handle main shows at
 * that moment.
 *
 * Before APS, between main and the chrome:
 *
 *   page:prompt-pending  main -> chrome  { handle, guest }
 *   page:prompt          main -> chrome  { handle, guest, kind, site, view }
 *   page:prompt-hidden   main -> chrome  { handle }
 *   page:prompt-closed   main -> chrome  { handle, reason }
 *   page:decide          chrome -> main  { handle, approve, choices } -> { ok } | { ok: false, reason }
 *   page:foreground      chrome -> main  { guest }
 *
 * `site` is main's, from the request's attested key. Nothing the chrome
 * sends names a site, a guest's key or a payload: a decision is an answer
 * to the handle shown, and the dispatcher acts on its own record.
 *
 * A prompt that shows has no deadline from then on, hidden again or not
 * (`page-requests.js` `markShown`). One that never showed closes at its
 * method's deadline (`expired`), and nothing shows it after.
 *
 * Every open prompt's view is charged to its window and to the browser
 * (0011, "Bounds": "Prompt views"), a page's prompt and the window's own
 * alike, so what main keeps for prompts nobody has answered is bounded
 * whoever opens them. A view is charged at the UTF-8 bytes of its JSON, as
 * the approvals document measures it, and a window's own prompt (the
 * wallet's, which has no request record and so no request charge) also at
 * the request it answers, which its caller holds while it waits. A prompt
 * that doesn't fit is never opened (`admit`): the caller gets `-32005`.
 * The charge is let go when the prompt closes, and moves with its view on
 * `update`. A view over the 4 MiB the approvals document shows is charged in
 * full but not kept: the prompt holds `null`, which shows the fixed error,
 * and can only be rejected.
 */

const { measurePageRequest } = require('../../shared/page-request-bounds');

const CHANNELS = Object.freeze({
  PENDING: 'page:prompt-pending',
  PROMPT: 'page:prompt',
  HIDDEN: 'page:prompt-hidden',
  CLOSED: 'page:prompt-closed',
  DECIDE: 'page:decide',
  FOREGROUND: 'page:foreground',
});

// One per today's prompt (design 0011, "The prompt protocol"), and a Safe
// send's signing board (PRQ-5b), as a Safe message's has its own.
const KINDS = Object.freeze([
  'eth.connect',
  'eth.send',
  'eth.sign',
  'eth.safe_message',
  'eth.safe_send',
  'swarm.connect',
  'swarm.publish',
  'swarm.feed',
  'swarm.messaging',
  'swarm.manifest',
  'radicle.connect',
  'radicle.node',
  'radicle.sign',
  'vault.unlock',
]);
const KIND_SET = new Set(KINDS);

// The E2E harness's own prompt, to exercise the approvals document's
// rendering and input rules (APS-1). Main issues it only while the
// harness's test hooks are on (`page-requests.js`); it is no wallet kind.
const TEST_KIND = 'test.prompt';

// The kinds that count against a document's one pending wallet prompt.
// Swarm and Radicle keep their own limits on their prompts.
const WALLET_KINDS = new Set([
  'eth.connect',
  'eth.send',
  'eth.sign',
  'eth.safe_message',
  'eth.safe_send',
  'vault.unlock',
]);

const DECIDE_KEYS = new Set(['handle', 'approve', 'choices']);

const MiB = 1024 * 1024;
// Open prompts and the bytes of their views (and of the requests a
// window's own prompts answer), per window and in the browser (0011, "The
// numbers"). One view of the most the approvals document shows fits a
// window twice and the browser four times; an honest view is a few KiB.
const PROMPT_BUDGETS = Object.freeze({
  window: Object.freeze({ count: 64, bytes: 8 * MiB }),
  browser: Object.freeze({ count: 256, bytes: 16 * MiB }),
});
// The most of a view the approvals document shows (in parts, APS-4;
// `approvals-document.js` MAX_PARTED_VIEW_BYTES). Over it, main keeps none.
const MAX_SHOWN_VIEW_BYTES = 4 * MiB;
const LIMIT_EXCEEDED = Object.freeze({ code: -32005, message: 'Limit exceeded' });

/**
 * A view's size: the UTF-8 bytes of its JSON, as the approvals document
 * measures it. Infinity for one that can't be serialized, which is never
 * admitted.
 */
function viewSize(view) {
  try {
    const json = JSON.stringify(view);
    return typeof json === 'string' ? Buffer.byteLength(json, 'utf8') : 0;
  } catch {
    return Infinity;
  }
}

/**
 * The size of the request a window's own prompt answers, by the page
 * requests' walk, which stops past `max`. Infinity past it, or for a
 * request the walk refuses.
 */
function heldSize(holds, max) {
  if (holds === undefined) return 0;
  const measured = measurePageRequest(holds, max);
  return measured.ok ? measured.size : Infinity;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasOnlyKeys(value, keys) {
  for (const key in value) {
    if (!keys.has(key)) return false;
  }
  return true;
}

/**
 * @param {object} options
 * @param {(windowId: number, channel: string, payload: object) => void} options.send
 *   to the window's chrome.
 * @param {(entry: object) => boolean} options.markShown the entry's record
 *   has shown: it has no deadline from now on.
 * @param {(entry: object) => void} options.decided close the entry's handle
 *   as decided (`page-requests.js`), which comes back here as `closed`.
 * @param {(entry: object) => void} [options.cancel] close the entry's handle
 *   as cancelled: its changed view doesn't fit the budget.
 * @param {(entry: object) => void} [options.trace]
 * @param {{window: {count: number, bytes: number}, browser: {count: number, bytes: number}}} [options.budgets]
 */
function createPagePrompts({ send, markShown, decided, cancel, trace = () => {}, budgets = PROMPT_BUDGETS }) {
  const windows = new Map(); // window id -> { front: guest id | null, shown: entry | null }
  const open = new Map(); // handle -> entry, in order of arrival
  let lastOrder = 0;
  // What open prompts are charged: per window, and in the browser.
  const charged = new Map(); // window id -> { count, bytes }
  const total = { count: 0, bytes: 0 };
  const cancelEntry = typeof cancel === 'function' ? cancel : (entry) => closed(entry.handle, 'cancelled');

  const windowState = (windowId) => {
    let state = windows.get(windowId);
    if (!state) {
      state = { front: null, shown: null };
      windows.set(windowId, state);
    }
    return state;
  };

  const tell = (windowId, channel, payload) => {
    trace({ kind: 'prompt-message', window: windowId, channel, payload });
    try {
      send(windowId, channel, payload);
    } catch {
      // A window mid-teardown: its handles close with its guests.
    }
  };

  // The window's oldest open prompt of the guest in front, or of the
  // window itself (the wallet's own, APS-3, which no tab asked for), or null.
  function oldestInFront(windowId, front) {
    for (const entry of open.values()) {
      if (entry.window !== windowId) continue;
      if (entry.guest === null || (front !== null && entry.guest === front)) return entry;
    }
    return null;
  }

  // Show what the window should show: changed here first, then told.
  function arrange(windowId) {
    const state = windowState(windowId);
    const want = oldestInFront(windowId, state.front);
    if (state.shown === want) return;
    const previous = state.shown;
    state.shown = null;
    if (previous && open.get(previous.handle) === previous) {
      tell(windowId, CHANNELS.HIDDEN, { handle: previous.handle });
    }
    if (!want) return;
    state.shown = want;
    markShown(want);
    want.shownOnce = true;
    tell(windowId, CHANNELS.PROMPT, {
      handle: want.handle,
      guest: want.guest,
      kind: want.kind,
      site: { ...want.site },
      view: want.view,
    });
  }

  const usageOf = (windowId) => charged.get(windowId) || { count: 0, bytes: 0 };

  // Whether `bytes` more, and `count` more prompts, fit the window's and the
  // browser's budgets.
  const fits = (windowId, count, bytes) => {
    const used = usageOf(windowId);
    return (
      Number.isFinite(bytes) &&
      used.count + count <= budgets.window.count &&
      used.bytes + bytes <= budgets.window.bytes &&
      total.count + count <= budgets.browser.count &&
      total.bytes + bytes <= budgets.browser.bytes
    );
  };

  const take = (windowId, count, bytes) => {
    const used = usageOf(windowId);
    const next = { count: used.count + count, bytes: used.bytes + bytes };
    if (next.count === 0 && next.bytes === 0) charged.delete(windowId);
    else charged.set(windowId, next);
    total.count += count;
    total.bytes += bytes;
  };

  /**
   * Room for a new prompt in window `windowId`: its view, and for a window's
   * own prompt the request it answers (`holds`). Returns the charge, taken
   * now, or null when the window's or the browser's budget is full, and
   * nothing is held. The caller opens the prompt with it (`add`) at once,
   * or lets it go (`release`).
   */
  function admit(windowId, { view, holds } = {}) {
    const viewBytes = viewSize(view);
    const heldBytes = heldSize(holds, budgets.window.bytes);
    const bytes = viewBytes + heldBytes;
    if (!fits(windowId, 1, bytes)) {
      trace({ kind: 'prompt-over-budget', window: windowId, bytes: Number.isFinite(bytes) ? bytes : null, usage: usage() });
      return null;
    }
    take(windowId, 1, bytes);
    return { window: windowId, viewBytes, heldBytes, released: false };
  }

  /** Let a charge go: its prompt closed, or never opened. */
  function release(charge) {
    if (!charge || charge.released) return;
    charge.released = true;
    take(charge.window, -1, -(charge.viewBytes + charge.heldBytes));
  }

  // What the prompt keeps of a view: none of one over what the approvals
  // document shows, whose fixed error needs nothing of it.
  const kept = (view, viewBytes) => (viewBytes > MAX_SHOWN_VIEW_BYTES ? null : view);

  /** For tests and diagnostics: what open prompts are charged. */
  function usage() {
    const out = { count: total.count, bytes: total.bytes, windows: {} };
    for (const [windowId, used] of charged) out.windows[windowId] = { ...used };
    return out;
  }

  /** The open prompt's kind, or null. */
  function kindOf(handle) {
    return open.get(handle)?.kind ?? null;
  }

  /** Whether the document already has an open wallet prompt. */
  function walletPromptOpen(documentKey) {
    for (const entry of open.values()) {
      if (entry.document === documentKey && WALLET_KINDS.has(entry.kind)) return true;
    }
    return false;
  }

  /**
   * Hold a new prompt. `decision` settles with `{ approve, choices }` when
   * the user decides it, or `{ closed: reason }` when it closes otherwise.
   * `released`, when given, settles once what the decision started is done
   * (a vault unlock's attempt), and the decision's invocation is answered
   * then rather than when its whole request is (`page-requests.js`).
   *
   * `charge` is the prompt's, from `admit`; without one it is admitted
   * here. Returns null, and opens nothing, when it doesn't fit.
   */
  function add({ handle, record, window: windowId, guest, document, kind, site, view, choices, released, charge }) {
    const taken = charge || admit(windowId, { view });
    if (!taken) return null;
    let settle;
    const decision = new Promise((resolve) => {
      settle = resolve;
    });
    const entry = {
      handle,
      record,
      window: windowId,
      guest,
      document,
      kind,
      site: Object.freeze({ key: site.key, label: site.label }),
      view: kept(view, taken.viewBytes),
      charge: taken,
      choices: typeof choices === 'function' ? choices : () => ({}),
      order: ++lastOrder,
      shownOnce: false,
      decided: null,
      released: released instanceof Promise ? released : null,
      settle,
      decision,
    };
    open.set(handle, entry);
    tell(windowId, CHANNELS.PENDING, { handle, guest });
    arrange(windowId);
    return entry;
  }

  /**
   * The prompt's content changed (a dispatcher has more to show): it shows
   * again with the new view if it is the one shown, and the renderer
   * restarts its input delay. Its charge moves to the new view; a view that
   * doesn't fit closes the prompt as cancelled. Returns whether the handle
   * is open.
   */
  function update(handle, view) {
    const entry = open.get(handle);
    if (!entry) return false;
    const { charge } = entry;
    const viewBytes = viewSize(view);
    const grows = Number.isFinite(viewBytes) ? viewBytes - charge.viewBytes : Infinity;
    if (grows > 0 && !fits(entry.window, 0, grows)) {
      trace({ kind: 'prompt-over-budget', window: entry.window, handle, bytes: Number.isFinite(viewBytes) ? viewBytes : null, usage: usage() });
      cancelEntry(entry);
      return false;
    }
    take(entry.window, 0, viewBytes - charge.viewBytes);
    charge.viewBytes = viewBytes;
    entry.view = kept(view, viewBytes);
    if (windowState(entry.window).shown !== entry) return true;
    trace({ kind: 'prompt-updated', handle });
    tell(entry.window, CHANNELS.PROMPT, {
      handle: entry.handle,
      guest: entry.guest,
      kind: entry.kind,
      site: { ...entry.site },
      view: entry.view,
    });
    return true;
  }

  /** A handle closed, for any reason: its prompt goes, and the next shows. */
  function closed(handle, reason) {
    const entry = open.get(handle);
    if (!entry) return;
    open.delete(handle);
    release(entry.charge);
    const state = windowState(entry.window);
    if (state.shown === entry) state.shown = null;
    tell(entry.window, CHANNELS.CLOSED, { handle, reason });
    entry.settle(entry.decided || { closed: reason });
    arrange(entry.window);
  }

  /**
   * `page:foreground` from window `windowId`'s chrome: `guest` is in front
   * now, or no guest (`null`, a tab with no page). The caller has checked
   * that the sender is that window's chrome and that the guest is a live
   * guest the window hosts.
   */
  function foreground(windowId, guest) {
    const state = windowState(windowId);
    state.front = guest;
    trace({ kind: 'foreground', window: windowId, guest });
    arrange(windowId);
  }

  /**
   * `page:decide` from window `windowId`'s chrome. It counts only for the
   * handle that window shows at this moment.
   *
   * `from` names the surface the decision came from (`chrome` or
   * `approvals`), which main's issuer reads (`page-requests.js` `confirm`).
   *
   * @returns {{ok: true, entry: object} | {ok: false, reason: string}}
   */
  function decide(windowId, payload, from = 'chrome') {
    if (!isPlainObject(payload) || !hasOnlyKeys(payload, DECIDE_KEYS)) return { ok: false, reason: 'invalid' };
    const { handle, approve } = payload;
    if (typeof handle !== 'string' || typeof approve !== 'boolean') return { ok: false, reason: 'invalid' };
    const entry = open.get(handle);
    // Another window's handle is no handle of this one's.
    if (!entry || entry.window !== windowId) return { ok: false, reason: 'closed' };
    if (windowState(windowId).shown !== entry) return { ok: false, reason: 'not-shown' };
    let choices = {};
    if (approve) {
      const raw = payload.choices === undefined ? {} : payload.choices;
      if (!isPlainObject(raw)) return { ok: false, reason: 'invalid' };
      let checked;
      try {
        checked = entry.choices(raw);
      } catch {
        checked = null;
      }
      if (!checked) return { ok: false, reason: 'invalid' };
      choices = checked;
    }
    entry.decided = Object.freeze({ approve, choices, from });
    trace({ kind: 'decided', handle, approve });
    decided(entry);
    return { ok: true, entry };
  }

  /** Forget a closed window. Its own prompts (the wallet's) close with it. */
  function forgetWindow(windowId) {
    for (const entry of [...open.values()]) {
      if (entry.window === windowId && entry.guest === null) closed(entry.handle, 'closed');
    }
    windows.delete(windowId);
  }

  /** For tests and diagnostics: what each window shows and holds. */
  function state() {
    const out = {};
    for (const [windowId, value] of windows) {
      out[windowId] = {
        front: value.front,
        shown: value.shown ? value.shown.handle : null,
        open: [...open.values()].filter((entry) => entry.window === windowId).map((entry) => entry.handle),
      };
    }
    return out;
  }

  return { admit, release, add, update, closed, foreground, decide, kindOf, walletPromptOpen, forgetWindow, state, usage };
}

module.exports = {
  CHANNELS,
  KINDS,
  KIND_SET,
  TEST_KIND,
  WALLET_KINDS,
  PROMPT_BUDGETS,
  MAX_SHOWN_VIEW_BYTES,
  LIMIT_EXCEEDED,
  createPagePrompts,
};
