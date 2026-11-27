/**
 * The hash-only warning over a tab (freedom-core design 0016, "Typed data
 * on the device (Q23)"; the LDG-3 plan's points 12 and 19; LDG-3's PR 11),
 * on the core's Ledger backend (FREEDOM_LEDGER_BACKEND=core).
 *
 * A Ledger that can't show typed data field by field shows only two
 * hashes, and main holds the device until this warning is on screen
 * (main/wallet/ledger/hash-only-warning.js). Main shows it here for a
 * request no approval surface waits on (a standing rule's, an x402
 * payment's, one the Agent's sheet approved) and, under
 * FREEDOM_APPROVALS_DOCUMENT=0, for every one; otherwise the approvals
 * document's waiting state shows it, with the same copy (a test pins the
 * two).
 *
 * Main sends `{ id, site, domainSeparator, structHash }`: the notice shows
 * the two hashes as the device will show them, over the content area, and
 * is reported on screen after two animation frames, with the window
 * visible and the notice laid out. `{ id, closed: true }` takes it down
 * when the operation ends. Its Cancel (point 19, the recommended option of
 * a decision still open; remove the button, its handler and the preload's
 * `cancelHashOnlyNotice` to drop it) cancels the request.
 */

/** The warning's copy: the approvals document's (approvals-kinds.js `HASH_ONLY_COPY`). */
export const HASH_ONLY_COPY = Object.freeze({
  title: "This Ledger can't show the request's details",
  body:
    'It will show only two hashes, not what you are signing. Check that they match the ones below, ' +
    'and approve on the Ledger only if you trust this request.',
  domain: 'Domain hash',
  message: 'Message hash',
});

const ID = /^[0-9a-f]{32}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const MAX_SITE = 300;

/** A hash as the Ethereum app shows it: `0x`, then its 64 digits in capitals. */
export const deviceHash = (hash) => '0x' + hash.slice(2).toUpperCase();

/** A notice message from main, checked: `{ id, site, domainSeparator, structHash }`, `{ id, closed }`, or null. */
export function checkNotice(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  if (typeof message.id !== 'string' || !ID.test(message.id)) return null;
  if (message.closed === true) return { id: message.id, closed: true };
  const { domainSeparator, structHash } = message;
  if (typeof domainSeparator !== 'string' || !HASH.test(domainSeparator)) return null;
  if (typeof structHash !== 'string' || !HASH.test(structHash)) return null;
  const site = typeof message.site === 'string' && message.site ? message.site.slice(0, MAX_SITE) : null;
  return { id: message.id, site, domainSeparator, structHash, closed: false };
}

const laidOut = (node) =>
  typeof node.checkVisibility === 'function' ? node.checkVisibility() : node.getClientRects().length > 0;

let els = null;
let shownId = null;
let frame = null;

function stopFrames() {
  if (frame !== null) window.cancelAnimationFrame(frame);
  frame = null;
}

function hide() {
  stopFrames();
  shownId = null;
  els.notice.hidden = true;
  els.domain.textContent = '';
  els.message.textContent = '';
  els.site.textContent = '';
  els.site.hidden = true;
}

function show(notice, api) {
  stopFrames();
  shownId = notice.id;
  els.site.textContent = notice.site ? `From ${notice.site}` : '';
  els.site.hidden = !notice.site;
  els.domain.textContent = deviceHash(notice.domainSeparator);
  els.message.textContent = deviceHash(notice.structHash);
  els.cancel.disabled = false;
  els.notice.hidden = false;
  const { id } = notice;
  frame = window.requestAnimationFrame(() => {
    frame = window.requestAnimationFrame(() => {
      frame = null;
      if (shownId !== id) return;
      if (document.visibilityState !== 'visible' || !laidOut(els.notice)) return;
      api.hashOnlyNoticeShown(id);
    });
  });
}

export function initLedgerHashOnlyNotice() {
  const api = window.ledger;
  if (typeof api?.onHashOnlyNotice !== 'function') return false;
  const byId = (id) => document.getElementById(id);
  els = {
    notice: byId('ledger-hash-only-notice'),
    title: byId('ledger-hash-only-title'),
    site: byId('ledger-hash-only-site'),
    body: byId('ledger-hash-only-body'),
    domainLabel: byId('ledger-hash-only-domain-label'),
    domain: byId('ledger-hash-only-domain'),
    messageLabel: byId('ledger-hash-only-message-label'),
    message: byId('ledger-hash-only-message'),
    cancel: byId('ledger-hash-only-cancel'),
  };
  if (Object.values(els).some((node) => !node)) return false;
  els.title.textContent = HASH_ONLY_COPY.title;
  els.body.textContent = HASH_ONLY_COPY.body;
  els.domainLabel.textContent = HASH_ONLY_COPY.domain;
  els.messageLabel.textContent = HASH_ONLY_COPY.message;
  // Point 19: the request is cancelled; main takes the notice down as it ends.
  els.cancel.addEventListener('click', () => {
    if (shownId === null) return;
    els.cancel.disabled = true;
    api.cancelHashOnlyNotice(shownId);
  });
  api.onHashOnlyNotice((message) => {
    const notice = checkNotice(message);
    if (!notice) return;
    if (notice.closed) {
      if (shownId === notice.id) hide();
      return;
    }
    show(notice, api);
  });
  return true;
}
