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
 */

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
 * @param {(entry: object) => void} [options.trace]
 */
function createPagePrompts({ send, markShown, decided, trace = () => {} }) {
  const windows = new Map(); // window id -> { front: guest id | null, shown: entry | null }
  const open = new Map(); // handle -> entry, in order of arrival
  let lastOrder = 0;

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
   */
  function add({ handle, record, window: windowId, guest, document, kind, site, view, choices, released }) {
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
      view,
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
   * restarts its input delay. Returns whether the handle was open.
   */
  function update(handle, view) {
    const entry = open.get(handle);
    if (!entry) return false;
    entry.view = view;
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

  return { add, update, closed, foreground, decide, kindOf, walletPromptOpen, forgetWindow, state };
}

module.exports = {
  CHANNELS,
  KINDS,
  KIND_SET,
  TEST_KIND,
  WALLET_KINDS,
  createPagePrompts,
};
