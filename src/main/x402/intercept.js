/**
 * x402 navigation interception — main-process plumbing.
 *
 * Dispatcher handlers + state stores. No UI; the interstitial + signing
 * wiring lives in WP4.
 *
 *   `x402-capture` (onBeforeSendHeaders): records `{method, range}` per
 *     `details.id` so the detector (which only sees response headers)
 *     can derive a retry key for shape-keyed bucketing. Skipped for
 *     non-x402 resource types (images/stylesheets/fonts/scripts).
 *
 *   `x402-cleanup` (onCompleted, onErrorOccurred): drops the captured
 *     entry; a TTL backstop on `requestContext.set` covers lifecycle
 *     events Electron silently drops.
 *
 *   `x402-detect` (onHeadersReceived): parses `PAYMENT-REQUIRED` /
 *     `X-PAYMENT-REQUIRED` on 402 responses. V1 servers that ship the
 *     payment requirements in the response *body* are not supported by
 *     this path — webRequest cannot read response bodies.
 *
 *   `x402-inject` (onBeforeSendHeaders): attaches the signed PAYMENT-
 *     SIGNATURE / X-PAYMENT header to the followed retry. Re-derives
 *     the retry key from the request's own headers (Chromium preserves
 *     them across the 307); FIFO-shifts the matching bucket so
 *     concurrent same-URL Range retries can't cross-feed.
 *
 *   `x402-receipt` (onHeadersReceived): logs settlement responses.
 *     Keyed by `details.id` (stable inject → response), so receipt
 *     attribution stays exact across concurrent retries; same id
 *     serves the detector's loop guard (server-rejected retry).
 *
 * All stores expose `clear*` helpers for test isolation.
 */

const { webContents } = require('electron');
const crypto = require('crypto');

const log = require('../logger');
const { parsePaymentRequired } = require('@x402/core/schemas');
const { registerWebRequestHandler } = require('../webrequest-dispatcher');
const paymentHistory = require('../payment-history');
const { KINDS: PAYMENT_KINDS, STATUSES: PAYMENT_STATUSES } = paymentHistory;
const { findCoveringPermission } = require('./payment-utils');
const { tryConsume } = require('./permissions');
const { isVaultLockedError } = require('../wallet/vault-errors');
const { normalizeOrigin } = require('../../shared/origin-utils');

// Header names used on the wire. V2 uses the un-prefixed names; V1 (Coinbase
// original) ships with the `X-` prefix. Centralised so WP4 callers reference
// the same constants the dispatch path checks.
const X402_HEADERS = Object.freeze({
  REQUIRED_V2: 'PAYMENT-REQUIRED',
  REQUIRED_V1: 'X-PAYMENT-REQUIRED',
  SIGNATURE_V2: 'PAYMENT-SIGNATURE',
  SIGNATURE_V1: 'X-PAYMENT',
  RESPONSE_V2: 'PAYMENT-RESPONSE',
  RESPONSE_V1: 'X-PAYMENT-RESPONSE',
});

// Source of consent for a pending payment. `CAP` = auto-pay against an
// active per-origin allowance (the cap IS the consent — if it doesn't
// cover at inject time, the signature must be withheld). `MANUAL` =
// user explicitly clicked Pay in the sidebar (the click is the consent,
// independent of cap state). Used by `injectPaymentSignatureHandler`'s
// withhold gate.
const AUTHORIZED_BY = Object.freeze({
  CAP: 'cap',
  MANUAL: 'manual',
});

const VALID_SIGNATURE_HEADERS = new Set([
  X402_HEADERS.SIGNATURE_V2,
  X402_HEADERS.SIGNATURE_V1,
]);

/**
 * Outgoing signature header name for a given protocol version. Lives next
 * to the constants so callers don't accidentally pair the wrong header
 * with the wrong version. Unknown versions default to V2 — zod-validated
 * input can only be 1 or 2, so the default just keeps a malformed payload
 * from crashing the renderer mid-flow.
 */
function outgoingHeaderForVersion(version) {
  return version === 1 ? X402_HEADERS.SIGNATURE_V1 : X402_HEADERS.SIGNATURE_V2;
}

// === State stores ========================================================

// "Server said this URL needs a payment." Keyed by webContentsId because
// the interstitial UI looks up "the latest detection for the tab the user
// is on." Replacing on each detection (rather than appending) matches a
// typical Chromium navigation: one 402 → one interstitial → one approval.
const detectedPayments = new Map();

// Signed headers waiting to attach to a followed retry. Keyed by request
// shape: `${webContentsId}|${method}|${url}|${range ?? ''}`. FIFO buckets
// so two concurrent same-URL requests with different Range headers each
// pick up their own signature. Value: signed[].
const pendingPayments = new Map();

// Receipt context for a specific in-flight signed request. Keyed by the
// followed request's `details.id` — stable through to the response, so
// receipt attribution is exact even when multiple same-URL retries are
// in flight. The `awaitingResponse.has(details.id)` check on every
// response is the fast-path miss for the 99.99% of responses that aren't
// settlement responses (no header iteration needed). It also tightens
// security: PAYMENT-RESPONSE headers are only honoured for requests we
// armed ourselves, never arbitrary server-side headers.
const awaitingResponse = new Map();

// Captured outgoing request shape, keyed by `details.id`. The detector
// on `onHeadersReceived` reads this to derive a retry key — the response
// event doesn't carry request headers. Cleared on lifecycle end; TTL on
// `set()` backstops lifecycle events Electron drops (SW shims, proxy
// chains). Capture is skipped for non-x402 resource types to keep the
// map's working set small. Value: { webContentsId, method, range,
// capturedAt }.
const requestContext = new Map();
const REQUEST_CONTEXT_TTL_MS = 60_000;
// Amortize the lazy TTL sweep so a busy session doesn't pay an O(n)
// scan on every captured request. One sweep per second is plenty given
// the TTL is 60s.
const REQUEST_CONTEXT_SWEEP_INTERVAL_MS = 1000;
let requestContextLastSweepAt = 0;

// Resource types where the browser issues high-volume requests that
// will never be x402-paywalled (image galleries, CSS, web fonts). The
// capture handler runs on every request, so skipping these cuts the
// per-request cost and bounds `requestContext`'s working set.
const X402_IRRELEVANT_RESOURCE_TYPES = new Set([
  'image',
  'stylesheet',
  'font',
  'script',
]);

// "Auto-pay tried to sign but the vault was locked; the user will unlock
// via the sidebar and the dedicated x402:resume-unlock IPC will fire to
// resume." Keyed by webContentsId. The value carries a snapshot of the
// original detection PLUS its authorizedBy marker, so the resume signs
// the right charge with the right consent — even if a newer 402 has
// since replaced `detectedPayments[id]` while the unlock dialog was open.
// Source-separated from x402:approve so a manual approval click on a
// different charge cannot consume this token.
const pendingUnlockResume = new Map();

// Vault unlocks should be quick (Touch ID is instant; password is
// seconds). 5 minutes is generous and matches "user walked away then
// came back" — beyond that the page would normally have lost state too.
const UNLOCK_RESUME_TTL_MS = 5 * 60 * 1000;

// "A non-cap-covered subresource 402 is parked here, holding the
// dispatcher's onHeadersReceived callback open until the sidebar tells
// us the user approved or rejected." Keyed by detectionId (per-detection
// identity, distinct from webContentsId so a newer 402 on the same tab
// can't redirect the user's eventual click to a different charge — the
// P2b "approved A, paid B" race fix). Single-card UI: a newer detection
// supersedes any older entries for the same webContents.
//
// Each value: { resolve, reject, webContentsId, url, requirements,
// resourceType, createdAt, timer }. resolve/reject are the Promise
// handles the detector awaits.
const pendingApprovals = new Map();
const PENDING_APPROVAL_TTL_MS = 5 * 60 * 1000;

// "Cap-covered subresource detector hit `Vault is locked`; the original
// page fetch is being held open while the sidebar prompts the user to
// unlock." Keyed by webContentsId. Value: { resolve, reject, timer }.
// The detector awaits this Promise; x402:resume-unlock settles it after
// the user unlocks, and the detector then retries sign + returns 307
// inline. No resume token is needed on this path — the detection
// snapshot lives in the detector's closure. Distinct from
// `pendingUnlockResume`, which serves the mainFrame setImmediate path
// where the original detector closure is already gone by the time the
// user unlocks.
const pendingUnlockWaits = new Map();

// Retry key bridges the original 402-bearing request and the followed
// retry: same (tab, method, URL, range) → same FIFO bucket. Empty-string
// fallbacks keep the key shape stable so identical requests collapse
// rather than spraying across `undefined`-laden keys. Assumes `url` does
// not contain a literal `|`; Chromium percent-encodes pipes in URLs.
function computeRetryKey({ webContentsId, method, url, range }) {
  return `${webContentsId ?? ''}|${method ?? 'GET'}|${url}|${range ?? ''}`;
}

// Pending signatures expire after `PENDING_TTL_MS`. EIP-3009 carries its
// own `validAfter`/`validBefore` window (typically the requirements'
// `maxTimeoutSeconds`, default 60s), so even if a stale signature were
// somehow attached the facilitator would reject it; this is hygiene to
// keep the Map from accumulating stranded signatures across long-lived
// sessions and to avoid attaching a long-stale signature to a same-URL
// request that happens to fire much later.
const PENDING_TTL_MS = 60_000;

/**
 * Stash a signed header for the dispatcher to attach on the matching
 * retry. Pushed to a FIFO bucket keyed by request shape; the injector
 * shifts the bucket on the first matching request.
 *
 * Validates `header` + `value` strictly — typos would silently fail the
 * payment. Receipt-context fields (`origin`, `chainId`, `asset`,
 * `amount`, `payTo`, `fromAddress`) ride along to the injector and from
 * there into the receipt; the receipts module validates its own input.
 *
 * `authorizedBy` distinguishes the consent source for the inject-time
 * cap-consume gate; see `AUTHORIZED_BY`. Cap signatures MUST NOT attach
 * if `tryConsume` fails at inject (race-over); manual ones proceed
 * regardless. Undefined → MANUAL for backward-compat.
 *
 * `requestShape` defaults to `{ method: 'GET', range: null }` —
 * preserves no-Range behaviour for callers that predate request-shape
 * keying. Sign-flow passes the captured shape so concurrent Range
 * requests bucket correctly.
 *
 * @param {number} webContentsId
 * @param {string} url
 * @param {{
 *   header: 'PAYMENT-SIGNATURE' | 'X-PAYMENT',
 *   value: string,
 *   authorizedBy?: 'cap' | 'manual',
 *   origin?: string, chainId?: number, asset?: string, amount?: string,
 *   payTo?: string, fromAddress?: string,
 * }} signed
 * @param {{ method?: string, range?: string | null }} [requestShape]
 */
function setPendingPayment(webContentsId, url, signed, requestShape) {
  if (!signed || !VALID_SIGNATURE_HEADERS.has(signed.header)) {
    throw new Error(`x402: invalid pending-payment header: ${signed?.header}`);
  }
  if (typeof signed.value !== 'string' || signed.value.length === 0) {
    throw new Error('x402: pending-payment value must be a non-empty string');
  }
  const now = Date.now();
  // Lazy sweep: pages that never retry would otherwise leave entries
  // stranded. Fires only when this Map is already being touched, so no
  // timer to manage.
  for (const [k, bucket] of pendingPayments) {
    while (bucket.length > 0 && bucket[0].expiresAt && now > bucket[0].expiresAt) {
      bucket.shift();
    }
    if (bucket.length === 0) pendingPayments.delete(k);
  }
  const key = computeRetryKey({
    webContentsId,
    method: requestShape?.method,
    url,
    range: requestShape?.range,
  });
  const bucket = pendingPayments.get(key) ?? [];
  bucket.push({ ...signed, expiresAt: now + PENDING_TTL_MS });
  pendingPayments.set(key, bucket);
}

function getDetectedPayment(webContentsId) {
  return detectedPayments.get(webContentsId) ?? null;
}

function clearDetectedPayment(webContentsId) {
  detectedPayments.delete(webContentsId);
}

function clearAllPendingPayments() {
  pendingPayments.clear();
}

function clearAllDetectedPayments() {
  detectedPayments.clear();
}

function clearAllAwaitingResponse() {
  awaitingResponse.clear();
}

function clearAllRequestContext() {
  requestContext.clear();
  requestContextLastSweepAt = 0;
}

// Capture outgoing request shape so the detector (which gets only
// response headers) can derive the same retry key the injector will
// compute on the followed retry. Runs on every request — must stay
// cheap. Range is the only discriminator we track today; add others
// (Accept, Origin, custom headers) when a real endpoint demands it.
function captureRequestContextHandler(details) {
  if (typeof details?.id !== 'number') return null;
  // Skip resource types that never receive x402 paywalls. Galleries,
  // CSS-heavy SPAs, and font-laden sites would otherwise flood the
  // map for no benefit.
  if (X402_IRRELEVANT_RESOURCE_TYPES.has(details.resourceType)) return null;
  const now = Date.now();
  // Amortized lazy TTL sweep. The lifecycle handlers do the bulk of
  // the cleanup; this scan is a backstop for events Electron drops
  // (SW shims, proxy chains).
  if (now - requestContextLastSweepAt > REQUEST_CONTEXT_SWEEP_INTERVAL_MS) {
    requestContextLastSweepAt = now;
    for (const [id, entry] of requestContext) {
      if (now - entry.capturedAt > REQUEST_CONTEXT_TTL_MS) {
        requestContext.delete(id);
      }
    }
  }
  requestContext.set(details.id, {
    webContentsId: details.webContentsId,
    method: details.method ?? 'GET',
    range: getHeaderValue(details.requestHeaders, 'Range'),
    capturedAt: now,
  });
  return null;
}

function clearRequestContextHandler(details) {
  if (typeof details?.id === 'number') {
    awaitingResponse.delete(details.id);
    requestContext.delete(details.id);
  }
  return null;
}

/**
 * Stash a snapshot+authorizedBy for the unlock-resume path. Single slot
 * per tab — a second locked-vault auto-pay before unlock replaces the
 * first (consistent with how `detectedPayments` itself is single-slot).
 */
function setPendingUnlockResume(webContentsId, { detection, authorizedBy }) {
  pendingUnlockResume.set(webContentsId, {
    detection,
    authorizedBy,
    createdAt: Date.now(),
  });
}

/**
 * One-shot read of the unlock-resume token for `webContentsId`. Returns
 * `null` if absent or past TTL.
 */
function consumePendingUnlockResume(webContentsId) {
  const entry = pendingUnlockResume.get(webContentsId);
  if (!entry) return null;
  pendingUnlockResume.delete(webContentsId);
  if (Date.now() - entry.createdAt > UNLOCK_RESUME_TTL_MS) return null;
  return entry;
}

function clearAllPendingUnlockResume() {
  pendingUnlockResume.clear();
}

/**
 * Register a wait for the cap-covered subresource locked-vault retry
 * loop. The detector awaits the returned Promise; `x402:resume-unlock`
 * settles it after the user unlocks. One wait per webContents — a fresh
 * locked-vault aborts the older entry so the previous detector returns
 * cleanly instead of hanging. An expiry timer mirrors the resume-token
 * TTL so a same-tab navigation (or any path that doesn't fire
 * `cleanupWebContents`) can't strand the entry.
 */
function setPendingUnlockWait(webContentsId) {
  abortPendingUnlockWait(webContentsId, new Error('superseded by newer locked-vault wait'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => abortPendingUnlockWait(webContentsId, new Error('unlock-wait expired')),
      UNLOCK_RESUME_TTL_MS,
    );
    timer.unref?.();
    pendingUnlockWaits.set(webContentsId, { resolve, reject, timer });
  });
}

function hasPendingUnlockWait(webContentsId) {
  return pendingUnlockWaits.has(webContentsId);
}

function settlePendingUnlockWait(webContentsId) {
  const entry = pendingUnlockWaits.get(webContentsId);
  if (!entry) return false;
  pendingUnlockWaits.delete(webContentsId);
  clearTimeout(entry.timer);
  entry.resolve();
  return true;
}

function abortPendingUnlockWait(webContentsId, reason = new Error('aborted')) {
  const entry = pendingUnlockWaits.get(webContentsId);
  if (!entry) return false;
  pendingUnlockWaits.delete(webContentsId);
  clearTimeout(entry.timer);
  entry.reject(reason);
  return true;
}

function clearAllPendingUnlockWaits() {
  for (const [id] of pendingUnlockWaits) {
    abortPendingUnlockWait(id, new Error('cleared'));
  }
}

/**
 * Mint a detectionId. Prefers Electron's stable per-request `details.id`
 * (a non-negative integer) so the id is greppable in logs.
 */
function mintDetectionId(details) {
  if (typeof details?.id === 'number' && details.id >= 0) {
    return `req-${details.id}`;
  }
  return `gen-${crypto.randomUUID()}`;
}

/**
 * Create a pending approval entry and return a Promise the detector
 * awaits. Resolves with `{ approved: boolean, grant? }` when the user
 * decides (IPC), or rejects when the entry is aborted (tab destroyed,
 * superseded by a newer detection).
 */
function setPendingApproval(detectionId, ctx) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => expirePendingApproval(detectionId), PENDING_APPROVAL_TTL_MS);
    timer.unref?.();
    pendingApprovals.set(detectionId, {
      resolve,
      reject,
      detectionId,
      webContentsId: ctx.webContentsId,
      url: ctx.url,
      requirements: ctx.requirements,
      // Bound while the webview is alive so the TTL message still reaches
      // the sidebar if the tab has gone in the meantime.
      notifyHost: ctx.notifyHost ?? hostSenderFor(ctx.webContentsId),
      timer,
    });
  });
}

function hasPendingApproval(detectionId) {
  return pendingApprovals.has(detectionId);
}

function getPendingApproval(detectionId) {
  return pendingApprovals.get(detectionId) ?? null;
}

function deletePendingApprovalEntry(detectionId) {
  const entry = pendingApprovals.get(detectionId);
  if (!entry) return null;
  pendingApprovals.delete(detectionId);
  clearTimeout(entry.timer);
  return entry;
}

function settlePendingApproval(detectionId, decision) {
  const entry = deletePendingApprovalEntry(detectionId);
  if (!entry) return false;
  entry.resolve(decision);
  return true;
}

function abortPendingApproval(detectionId, reason) {
  const entry = deletePendingApprovalEntry(detectionId);
  if (!entry) return false;
  entry.reject(reason);
  return true;
}

function expirePendingApproval(detectionId) {
  const entry = deletePendingApprovalEntry(detectionId);
  if (!entry) return false;
  const current = detectedPayments.get(entry.webContentsId);
  if (current?.detectionId === detectionId) {
    detectedPayments.delete(entry.webContentsId);
  }
  const reason = new Error('approval expired');
  entry.reject(reason);
  entry.notifyHost('x402:approval-result', {
    detectionId,
    success: false,
    error: 'Approval expired. Reload the resource to retry.',
  });
  return true;
}

function abortPendingApprovalsForTab(webContentsId, reason) {
  for (const [id, entry] of pendingApprovals) {
    if (entry.webContentsId === webContentsId) {
      abortPendingApproval(id, reason);
    }
  }
}

function clearAllPendingApprovals() {
  for (const [, entry] of pendingApprovals) {
    clearTimeout(entry.timer);
    entry.reject(new Error('cleared'));
  }
  pendingApprovals.clear();
}

/**
 * Drop any state held for a webContents that is going away. Called from
 * the `'destroyed'` handler in `webcontents-setup.js` — without it, a tab
 * that hits a 402 (or gets an interstitial-approved pending payment) and
 * then closes leaks one Map entry per such tab over the session.
 */
// For Maps whose VALUES carry `webContentsId` (awaitingResponse,
// requestContext — keys are numeric details.id). Snapshot before mutating;
// V8's Map iteration is safe under delete but the snapshot keeps the
// invariant explicit.
function deleteByWebContents(map, webContentsId) {
  for (const [k, entry] of [...map]) {
    if (entry?.webContentsId === webContentsId) map.delete(k);
  }
}

function appendX402PaymentRecord(expected, status, { txHash = null, metadata = undefined } = {}) {
  paymentHistory.append({
    kind: PAYMENT_KINDS.X402,
    url: expected.url,
    origin: expected.origin,
    chainId: expected.chainId,
    asset: expected.asset,
    amount: expected.amount,
    fromAddress: expected.fromAddress,
    toAddress: expected.payTo,
    txHash,
    status,
    metadata,
  });
}

function finalizeAwaitingResponsesForWebContents(webContentsId, cleanupReason) {
  for (const [requestId, entry] of [...awaitingResponse]) {
    if (entry?.webContentsId !== webContentsId) continue;
    awaitingResponse.delete(requestId);
    try {
      appendX402PaymentRecord(entry, PAYMENT_STATUSES.NO_RECEIPT, {
        metadata: { cleanupReason },
      });
    } catch (err) {
      log.error(`[x402:settled] cleanup receipt append failed: ${err.message}`);
    }
  }
}

/**
 * Tell the sidebar that every approval card bound to this tab is dead.
 *
 * Aborting the pending-approval entries is not enough: a card whose Pay
 * click already went through has NO entry left (the IPC settled it) and
 * is sitting on an open-ended device confirmation, holding the sidebar's
 * signature-flight lock. That lock is released only by an
 * `x402:approval-result`, so if the tab dies mid-signature the sidebar
 * stays locked for the rest of the session. `cancelled` tells the card
 * the request itself is gone — tear down rather than offer a retry
 * against a detection nothing can settle.
 */
function notifyApprovalCardsCancelled(webContentsId, error) {
  const detectionIds = new Set();
  const detected = detectedPayments.get(webContentsId);
  if (detected?.detectionId) detectionIds.add(detected.detectionId);
  for (const [detectionId, entry] of pendingApprovals) {
    if (entry.webContentsId === webContentsId) detectionIds.add(detectionId);
  }
  if (detectionIds.size === 0) return;
  const notify = hostSenderFor(webContentsId);
  for (const detectionId of detectionIds) {
    notify('x402:approval-result', {
      detectionId,
      success: false,
      cancelled: true,
      error,
    });
  }
}

function cleanupWebContents(webContentsId) {
  notifyApprovalCardsCancelled(webContentsId, 'The tab that requested this payment was closed.');
  detectedPayments.delete(webContentsId);
  pendingUnlockResume.delete(webContentsId);
  // Abort any in-flight awaits for this tab — without this the detector
  // would hang forever and dispatcher callbacks would never release.
  abortPendingApprovalsForTab(webContentsId, new Error('tab destroyed'));
  abortPendingUnlockWait(webContentsId, new Error('tab destroyed'));
  // `pendingPayments` keys start with `${webContentsId}|` (the retry-key
  // format), so prefix match drops them in one pass.
  const prefix = `${webContentsId}|`;
  for (const key of [...pendingPayments.keys()]) {
    if (key.startsWith(prefix)) pendingPayments.delete(key);
  }
  finalizeAwaitingResponsesForWebContents(webContentsId, 'tab destroyed');
  deleteByWebContents(requestContext, webContentsId);
  // Last event for this tab has gone out — drop the host binding so the
  // map doesn't grow one entry per tab over the session. A signature
  // still on the device keeps its own reference to the bound sender, so
  // its result event survives this.
  hostSenders.delete(webContentsId);
}

// === Header parsing ======================================================

// Electron's response headers come as `{ Name: ['value', ...] }` and
// request headers as `{ Name: 'value' }`, both with arbitrary casing.
// Match case-insensitively, return the first value, handle either shape.
function getHeaderValue(headers, name) {
  if (!headers) return null;
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) {
      const v = headers[key];
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return null;
}

function originKeyForUrl(url) {
  try {
    const parsed = new URL(url);
    return normalizeOrigin(parsed.origin === 'null' ? url : parsed.origin);
  } catch {
    return null;
  }
}

/**
 * Decode a base64-encoded JSON PaymentRequired header and validate it
 * against `@x402/core`'s zod schema (handles V1 + V2 via a discriminated
 * union on `x402Version`). Returns `null` on any parse, base64, or schema
 * failure so the caller can fail open and just render the 402 page.
 *
 * @param {string} value
 * @returns {object | null}
 */
function parsePaymentRequiredHeader(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  let decoded;
  try {
    decoded = Buffer.from(value, 'base64').toString('utf-8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return null;
  }
  const result = parsePaymentRequired(parsed);
  return result.success ? result.data : null;
}

// Strip query + fragment for logs; the URL might carry tokens the user
// would rather not see in logfiles.
function sanitizeUrlForLog(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '<invalid-url>';
  }
}

// Electron exposes `statusLine` as e.g. "HTTP/1.1 402 Payment Required"
// or "HTTP/2 402 …". `statusCode` is not in the details object Electron
// 30+ ships, so we match the space-padded code inside the line — fast
// (no array allocation) and tolerant of an HTTP/2 status line that
// drops the reason phrase entirely (just "HTTP/2 402"). Same shape as
// `isStatus2xx` below.
function isStatus402(statusLine) {
  return typeof statusLine === 'string' && / 402(?: |$)/.test(statusLine);
}

// 2xx detection for the receipt logger. "HTTP/1.1 200 OK" / "HTTP/2 204"
// both qualify; non-2xx responses (auth failures, server errors) land as
// receipts with status:'failed' so the user can see "I signed but got
// nothing back."
function isStatus2xx(statusLine) {
  if (typeof statusLine !== 'string') return false;
  return / 2\d\d(?: |$)/.test(statusLine);
}

// Fire an event at the HOST window's renderer (the browser shell that
// owns the sidebar). The webview that hit the 402 is a child of the
// host webContents; sending to host puts the event in front of the
// wallet sidebar UI.
//
// The host is resolved THROUGH the webview, so once the tab is closed
// `webContents.fromId()` returns nothing and every later event for that
// tab is dropped — including `x402:approval-result`, the sidebar's only
// release for a signature already sitting on the device. The shell that
// owns the card outlives its tabs, so we remember the host we resolved
// while the webview was alive and fall back to it once the live lookup
// fails. Remembered hosts are dropped in `cleanupWebContents`, after the
// tab's last event has gone out; a sender bound earlier (the detector's,
// for a signature still on the device) keeps its own reference.
const hostSenders = new Map();

function resolveHost(webviewWebContentsId) {
  return webContents.fromId(webviewWebContentsId)?.hostWebContents ?? null;
}

/**
 * Bind a sender for one webview. Call it while the webview is still alive
 * (the detector does, at detection time) and the events it fires later
 * survive the tab being closed.
 */
function hostSenderFor(webviewWebContentsId) {
  let remembered = resolveHost(webviewWebContentsId) ?? hostSenders.get(webviewWebContentsId);
  if (remembered) hostSenders.set(webviewWebContentsId, remembered);
  return (channel, payload) => {
    // Live lookup wins — the remembered host is only a fallback for a
    // webview that has since gone away.
    const live = resolveHost(webviewWebContentsId);
    if (live) {
      remembered = live;
      hostSenders.set(webviewWebContentsId, live);
    }
    const host = live ?? remembered;
    if (!host || host.isDestroyed?.()) {
      log.warn(`[x402] no host webContents for ${webviewWebContentsId}; ${channel} dropped`);
      return;
    }
    host.send(channel, payload);
  };
}

function sendToHost(webviewWebContentsId, channel, payload) {
  hostSenderFor(webviewWebContentsId)(channel, payload);
}

function clearAllHostSenders() {
  hostSenders.clear();
}

// === Dispatcher handlers =================================================

// Fire the sidebar's vault-unlock event. Single call site so the payload
// shape and log call stay consistent across the subresource self-307
// path (detector holds the response open via pendingUnlockWaits) and the
// mainFrame setImmediate path (detector closure is gone, resume token is
// stashed instead).
function notifyVaultUnlockNeeded(webContentsId, url) {
  sendToHost(webContentsId, 'x402:unlock-needed', {
    webContentsId,
    origin: originKeyForUrl(url) ?? url,
  });
}

// mainFrame helper: the setImmediate dispatch has already lost its
// closure to the sign-throw, so the detection snapshot has to be stashed
// for x402:resume-unlock to consume. Subresource path doesn't call this
// — its detector keeps the snapshot in scope and awaits a wait entry
// instead. See `setPendingUnlockResume` / `X402_RESUME_UNLOCK`.
function requestVaultUnlockForAutoPay(webContentsId, detection, url) {
  setPendingUnlockResume(webContentsId, { detection, authorizedBy: AUTHORIZED_BY.CAP });
  notifyVaultUnlockNeeded(webContentsId, url);
}

/**
 * Detect 402+PAYMENT-REQUIRED in a response and either auto-pay (cap
 * covers) or surface an approval card. Async so the cap-covered
 * subresource path can sign inline and return a same-URL 307 directive.
 *
 * Test contract: many tests in `intercept.test.js` and `ipc.test.js`
 * call this handler without awaiting and rely on the side effects
 * (`detectedPayments.set`, `sendToHost`, `setImmediate` scheduling)
 * happening synchronously before the first `await`. Preserve that
 * ordering when modifying this function.
 */
async function detectPaymentRequiredHandler(details) {
  if (!isStatus402(details.statusLine)) return null;

  // Electron sets `webContentsId` undefined (or -1) for requests not tied
  // to a renderer — service workers, favicon discovery, Chromium-internal
  // metadata fetches. We can't re-navigate those, so even if they 402
  // there's nothing useful we can do.
  if (typeof details.webContentsId !== 'number' || details.webContentsId < 0) {
    log.info(
      `[x402:detect] 402 on ${sanitizeUrlForLog(details.url)} not tied to a webContents; ignoring`
    );
    return null;
  }

  const v2 = getHeaderValue(details.responseHeaders, X402_HEADERS.REQUIRED_V2);
  const v1 = getHeaderValue(details.responseHeaders, X402_HEADERS.REQUIRED_V1);
  const headerValue = v2 ?? v1;
  if (!headerValue) {
    log.info(
      `[x402:detect] 402 on ${sanitizeUrlForLog(details.url)} with no payment header — server is not x402, or uses body-only V1`
    );
    return null;
  }

  const requirements = parsePaymentRequiredHeader(headerValue);
  if (!requirements) {
    log.warn(
      `[x402:detect] PAYMENT-REQUIRED on ${sanitizeUrlForLog(details.url)} could not be parsed; ignoring`
    );
    return null;
  }

  // Retry-key shape used by sign-flow → setPendingPayment. Missing
  // capture falls back to a synthetic shape — covers SW-originated
  // requests, proxy chains, and tests driving the detector directly.
  const captured = requestContext.get(details.id);
  const requestShape = {
    method: captured?.method ?? details.method ?? 'GET',
    range: captured?.range ?? null,
  };

  // The data's own x402Version field is the canonical protocol version
  // (zod's discriminated union routed parsing through V1 or V2 already).
  // The header name we found it under is correlated but redundant.
  //
  // `resourceType` decides whether the retry can use `wc.loadURL` (a top-
  // level navigation; correct for `mainFrame`) or has to leave the tab
  // alone (subresource fetches — wc.loadURL would yank the user off the
  // page that initiated the fetch). See sign-flow.js for the gate.
  detectedPayments.set(details.webContentsId, {
    url: details.url,
    requirements,
    resourceType: details.resourceType,
    requestShape,
    detectedAt: Date.now(),
  });
  log.info(
    `[x402:detect] v${requirements.x402Version} payment required for ${sanitizeUrlForLog(details.url)}`
  );

  // Loop guard: 402 on a `details.id` we already armed means the server
  // rejected our signed retry — pass through, let the receipt handler
  // log a `failed` row. Sits ABOVE the cap-coverage check so a depleted
  // cap doesn't push a known-rejected charge into the approval flow.
  if (awaitingResponse.has(details.id)) {
    log.warn(
      `[x402:detect] 402 on a request we already signed (server rejected); ` +
      `not re-signing ${sanitizeUrlForLog(details.url)}`
    );
    return null;
  }

  // Auto-pay branch — if an active cap covers this charge, sign and
  // either (subresource) return a same-URL 307 redirect so Chromium
  // re-issues the request transparently with PAYMENT-SIGNATURE, or
  // (mainFrame) sign via setImmediate + wc.loadURL so we don't block
  // Chromium on the vault round-trip. The subresource path was
  // validated against the test rig end-to-end (lazy paragraphs +
  // fragmented MP4 video with Range headers); Chromium preserves
  // request headers, cookies, and credentials across the same-origin
  // redirect, so no custom protocol or paid-cache is needed.
  // Multi-accept-aware cap coverage: iterate accepts[] in server order
  // and pay against the first entry whose (chainId, asset) matches an
  // active cap with enough headroom. With single-accept requirements
  // this reduces to the legacy `accepts[0]` behavior; with multi-accept
  // it picks the auto-pay-covered entry even if it's not first in the
  // array. See `research/x402-multi-accept-ux.md` §3 for the policy.
  const origin = originKeyForUrl(details.url);
  const covering = origin ? findCoveringPermission(origin, requirements.accepts) : null;
  if (covering) {
    log.info(`[x402:detect] active cap covers ${sanitizeUrlForLog(details.url)} — auto-paying`);
    const id = details.webContentsId;
    const url = details.url;
    // Tag the stored detection with the consent provenance. The
    // selected accept survives via the `detection` snapshot below —
    // sign-flow consumes it from the snapshot (auto-pay path) or from
    // the pendingUnlockResume token (cap-locked unlock-resume path),
    // not from the map slot, so we don't duplicate it here.
    detectedPayments.set(id, {
      ...detectedPayments.get(id),
      authorizedBy: AUTHORIZED_BY.CAP,
    });
    // Snapshot the detection at the point of decision. The mainFrame
    // path captures it for the setImmediate closure (so a second 402 on
    // the same tab firing between schedule and run can't replace
    // detectedPayments[id] and redirect the auto-pay to a different
    // charge). The subresource path uses it inline. The IPC approve path
    // has a parallel latent gap tracked separately; full request-keyed
    // state for both is future work.
    const detection = {
      url,
      requirements,
      resourceType: details.resourceType,
      selectedAccept: covering.accept,
      requestShape,
    };

    if (details.resourceType !== 'mainFrame') {
      // SUBRESOURCE PATH: sign + return a same-URL 307; Chromium follows
      // it and the injector attaches PAYMENT-SIGNATURE on the followed
      // request. The page's fetch resolves with paid bytes — never sees
      // the 402.
      //
      // On `Vault is locked` the loop holds this onHeadersReceived
      // callback open across user unlock: fire unlock-needed, await
      // the wait entry, retry sign. The closure carries the detection
      // snapshot, so no resume token. Wait abort (tab destroyed, newer
      // locked-vault on same tab, TTL) bails to null.
      // Lazy require to dodge the intercept ↔ sign-flow circular dep;
      // hoisted out of the loop so we hit the module cache once.
      const { signAndQueueRetry } = require('./sign-flow');
      while (true) {
        try {
          await signAndQueueRetry(id, { detection, authorizedBy: AUTHORIZED_BY.CAP });
          log.info(`[x402:auto-pay] subresource signed; returning 307 → ${sanitizeUrlForLog(url)}`);
          return {
            statusLine: 'HTTP/1.1 307 Temporary Redirect',
            responseHeaders: { Location: [url] },
          };
        } catch (err) {
          if (!isVaultLockedError(err)) {
            log.error(`[x402:auto-pay] sign failed: ${err.message}\n  stack: ${err.stack}`);
            return null;
          }
          log.info(`[x402:auto-pay] vault locked — holding subresource open, requesting unlock for ${sanitizeUrlForLog(url)}`);
          notifyVaultUnlockNeeded(id, url);
          try {
            await setPendingUnlockWait(id);
          } catch (waitErr) {
            log.info(`[x402:auto-pay] unlock-wait aborted (${waitErr?.message ?? waitErr}); passing 402 through`);
            return null;
          }
        }
      }
    }

    // MAINFRAME PATH (existing — unchanged). setImmediate so we don't
    // block Chromium on the vault round-trip; original 402 renders
    // briefly while wc.loadURL kicks off the retry.
    setImmediate(() => {
      // Lazy require to dodge the intercept ↔ sign-flow circular dep.
      const { signAndQueueRetry } = require('./sign-flow');
      signAndQueueRetry(id, { detection, authorizedBy: AUTHORIZED_BY.CAP }).catch((err) => {
        // Vault auto-locked between detection and sign: the cap already
        // authorised the charge, so we don't need a fresh approval —
        // just a vault unlock. Stash a resume token carrying THIS
        // detection's snapshot + CAP authorization so the unlock-resume
        // signs the right charge even if a newer 402 replaced
        // detectedPayments[id] while the unlock dialog was open.
        if (isVaultLockedError(err)) {
          log.info(`[x402:auto-pay] vault locked — requesting unlock for ${sanitizeUrlForLog(url)}`);
          requestVaultUnlockForAutoPay(id, detection, url);
          return;
        }
        log.error(`[x402:auto-pay] failed: ${err.message}\n  cause: ${err.cause?.message || '(none)'}\n  stack: ${err.stack}`);
      });
    });
    return null;
  }

  // Not cap-covered. The sidebar will pop an approval card. Two flows
  // from here:
  //
  // - mainFrame: fire the event and return null. The page renders the
  //   402 while the user decides; the sidebar's Approve button calls
  //   x402:approve, which signs + wc.loadURL via signAndQueueRetry.
  //   Existing behaviour, unchanged.
  //
  // - Subresource: hold onHeadersReceived open (await the approval
  //   Promise). On approve → sign + return 307; Chromium follows the
  //   redirect and our injector attaches PAYMENT-SIGNATURE on the
  //   followed request. The page's fetch resolves with paid bytes —
  //   never sees the 402. On reject → return null; the page sees the
  //   402. This is WP7.1 Option α (transparent).
  //
  // detectionId identifies THIS specific 402 across event payload, IPC
  // approve/reject, and the pendingApprovals Map. P2b fix: a newer 402
  // arriving on the same tab while the user is still deciding aborts
  // the older entry — the sidebar will have replaced the card anyway.
  const detectionId = mintDetectionId(details);
  abortPendingApprovalsForTab(details.webContentsId, new Error('superseded by newer 402'));
  detectedPayments.set(details.webContentsId, {
    ...detectedPayments.get(details.webContentsId),
    detectionId,
  });
  // Bind the sidebar's host once, here, while the webview is certainly
  // alive: the sign below is an open-ended device confirmation and the
  // card holds the sidebar's signature lock until its result event
  // arrives, so that event must not be addressed through a tab the user
  // can close in the meantime.
  const notifyHost = hostSenderFor(details.webContentsId);
  // Event payload includes `resourceType` so the renderer can pick the
  // right teardown IPC (subresource → x402:reject; mainFrame → x402:cancel
  // which also goBacks the webview).
  notifyHost('x402:approval-needed', {
    webContentsId: details.webContentsId,
    detectionId,
    url: details.url,
    requirements,
    resourceType: details.resourceType,
  });

  // Predicate kept inline rather than a shared helper because there are
  // only two callers (here and dapp-x402.js#reject). If a third appears,
  // extract.
  const isSubresource = details.resourceType && details.resourceType !== 'mainFrame';
  if (!isSubresource) {
    return null;
  }

  // Retry loop: on sign failure (most commonly "Vault is locked"
  // between render and click), we send the failure event AND re-arm
  // pendingApproval so the user's next Pay click — after unlocking
  // inline — settles cleanly and signs. The original held-open fetch
  // stays open across attempts; on eventual success Chromium follows
  // the 307 and the page resolves with paid bytes transparently. Reject
  // or abort (tab destroyed, superseded) exits with null.
  while (true) {
    let decision;
    try {
      decision = await setPendingApproval(detectionId, {
        webContentsId: details.webContentsId,
        url: details.url,
        requirements,
        notifyHost,
      });
    } catch (err) {
      if (err?.message && /aborted|cancelled/i.test(err.message)) {
        log.warn(`[x402:approval] response aborted while waiting for user; webContentsId=${details.webContentsId}: ${err.message}`);
      } else {
        log.info(`[x402:approval] subresource approval aborted: ${err?.message ?? err}`);
      }
      return null;
    }

    if (!decision.approved) {
      log.info(`[x402:approval] subresource ${sanitizeUrlForLog(details.url)} rejected; passing 402 through`);
      return null;
    }

    try {
      const { signAndQueueRetry } = require('./sign-flow');
      const selectedAccept = decision.selectedAcceptIndex != null
        ? requirements.accepts?.[decision.selectedAcceptIndex]
        : requirements.accepts?.[0];
      // Pay click never blocks on a balance RPC — fundability gating
      // is the chooser's job (off cached balances), and the seller's
      // facilitator is the real settlement-time gate. If the cache
      // was stale and signing succeeds against insufficient funds,
      // the response logger writes a `failed` payment-history row.
      await signAndQueueRetry(details.webContentsId, {
        detection: { url: details.url, requirements, resourceType: details.resourceType, requestShape },
        selectedAccept,
        authorizedBy: AUTHORIZED_BY.MANUAL,
        grant: decision.grant,
      });
      log.info(`[x402:approval] subresource ${sanitizeUrlForLog(details.url)} signed; returning 307`);
      notifyHost('x402:approval-result', {
        detectionId,
        success: true,
      });
      return {
        statusLine: 'HTTP/1.1 307 Temporary Redirect',
        responseHeaders: { Location: [details.url] },
      };
    } catch (err) {
      // Vault auto-locked between render and click is the expected
      // recoverable case — the retry loop re-arms pendingApproval so
      // the user can unlock + retry. Anything else is likely a real
      // bug; user can still click Reject to exit.
      if (isVaultLockedError(err)) {
        log.warn(`[x402:approval] sign blocked (${err.message}) for ${sanitizeUrlForLog(details.url)}; awaiting retry`);
      } else {
        log.error(
          `[x402:approval] sign failed AFTER user approved ${sanitizeUrlForLog(details.url)}: ` +
          `${err.message}\n  stack: ${err.stack}`
        );
      }
      notifyHost('x402:approval-result', {
        detectionId,
        success: false,
        error: err.message,
      });
      // fall through to next iteration
    }
  }
}

// onHeadersReceived (chained after detect). On a successful retry the
// server sends a PAYMENT-RESPONSE header carrying base64-encoded
// settlement metadata (incl. txHash). The receipt logger persists this
// to the Payments-tab ledger.
//
// Gated on `awaitingResponse` so we don't touch headers on every
// subresource fetch — the Map.has check is the fast-path miss for
// 99.99% of responses.
function paymentResponseLoggingHandler(details) {
  // Keyed by `details.id` — armed by the injector; matches on the
  // response side without ambiguity across concurrent retries.
  const expected = awaitingResponse.get(details.id);
  if (!expected) return null;
  awaitingResponse.delete(details.id);

  const success = isStatus2xx(details.statusLine);
  let txHash = null;
  // V1 servers ship the settlement header as `X-PAYMENT-RESPONSE`; V2 drops
  // the `X-` prefix. Prefer the version matching what we signed, fall back
  // to the other so we don't miss a receipt because of header-name drift.
  const isV1 = expected.signedHeader === X402_HEADERS.SIGNATURE_V1;
  const canonical = isV1 ? X402_HEADERS.RESPONSE_V1 : X402_HEADERS.RESPONSE_V2;
  const fallback = isV1 ? X402_HEADERS.RESPONSE_V2 : X402_HEADERS.RESPONSE_V1;
  const value = getHeaderValue(details.responseHeaders, canonical)
    ?? getHeaderValue(details.responseHeaders, fallback);
  if (value) {
    try {
      const decoded = JSON.parse(Buffer.from(value, 'base64').toString('utf-8'));
      if (typeof decoded.txHash === 'string') txHash = decoded.txHash;
    } catch {
      log.warn(
        `[x402:settled] PAYMENT-RESPONSE on ${sanitizeUrlForLog(details.url)} could not be decoded`
      );
    }
  }

  let status;
  if (!success) status = PAYMENT_STATUSES.FAILED;
  else if (txHash) status = PAYMENT_STATUSES.SETTLED;
  else status = PAYMENT_STATUSES.NO_RECEIPT;

  try {
    appendX402PaymentRecord(expected, status, { txHash });
  } catch (err) {
    log.error(`[x402:settled] receipt append failed: ${err.message}`);
  }

  if (txHash) {
    log.info(`[x402:settled] ${sanitizeUrlForLog(details.url)} txHash=${txHash}`);
  }
  return null;
}

// Run the cap consume for an inject attempt and decide whether the
// signature is still authorized to go out. Returns `{ withhold, consumed }`:
//   - withhold: true → caller must drop the pending entry and bail
//   - consumed: true → a cap entry was actually decremented (sidebar
//     banner / recent-payments should refresh)
// See `AUTHORIZED_BY` for the consent model. `undefined` authorizedBy
// is intentionally treated as `MANUAL` — backward-compat with callers
// that predate the field.
function consumeOrWithhold(signed, urlForLog) {
  const hasCapMetadata = !!(
    signed.origin &&
    signed.chainId != null &&
    signed.asset &&
    signed.amount != null
  );
  if (!hasCapMetadata) {
    if (signed.authorizedBy === AUTHORIZED_BY.CAP) {
      log.warn(
        `[x402:inject] cap-authorized signature for ${urlForLog} is missing cap metadata; ` +
        'withholding signature so cap accounting cannot be bypassed'
      );
      return { withhold: true, consumed: false };
    }
    return { withhold: false, consumed: false };
  }
  const consumed = tryConsume(signed.origin, signed.chainId, signed.asset, signed.amount);
  if (consumed) return { withhold: false, consumed: true };
  if (signed.authorizedBy === AUTHORIZED_BY.CAP) {
    log.warn(
      `[x402:inject] cap raced over for ${urlForLog} (authorizedBy=cap); ` +
      `withholding signature, falling back to manual approval`
    );
    return { withhold: true, consumed: false };
  }
  log.warn(
    `[x402:inject] cap consume returned false for ${signed.origin} ${signed.amount} ` +
    `(authorizedBy=${signed.authorizedBy ?? AUTHORIZED_BY.MANUAL}); charge proceeds, cap accounting may be off`
  );
  return { withhold: false, consumed: false };
}

function injectPaymentSignatureHandler(details) {
  // Re-derive the retry key from THIS request's headers. Chromium
  // preserves them across the same-origin 307, so method + URL + Range
  // match what the detector computed and stashed.
  const key = computeRetryKey({
    webContentsId: details.webContentsId,
    method: details.method,
    url: details.url,
    range: getHeaderValue(details.requestHeaders, 'Range'),
  });
  const bucket = pendingPayments.get(key);
  if (!bucket || bucket.length === 0) return null;

  const signed = bucket.shift();
  if (bucket.length === 0) pendingPayments.delete(key);

  // EIP-3009 carries its own validAfter/validBefore; facilitator would
  // reject a stale signature, but don't even attach it.
  if (signed.expiresAt && Date.now() > signed.expiresAt) {
    log.warn(`[x402:inject] pending signature expired for ${sanitizeUrlForLog(details.url)}; dropping`);
    return null;
  }

  const { withhold, consumed } = consumeOrWithhold(signed, sanitizeUrlForLog(details.url));
  if (withhold) return null; // one-shot drop already happened via shift()

  // Silent auto-pay doesn't round-trip through the renderer; without
  // this event the sidebar banner's spend counter stays stale until the
  // next navigation. Origin lets the renderer filter by tab.
  if (consumed) {
    sendToHost(details.webContentsId, 'x402:cap-consumed', { origin: signed.origin });
  }
  // Arm the receipt logger by `details.id` — stable through to the
  // matching response. `webContentsId` rides along for cleanup-by-tab.
  awaitingResponse.set(details.id, {
    webContentsId: details.webContentsId,
    url: details.url,
    origin: signed.origin,
    chainId: signed.chainId,
    asset: signed.asset,
    amount: signed.amount,
    payTo: signed.payTo ?? null,
    fromAddress: signed.fromAddress ?? null,
    signedHeader: signed.header,
  });

  log.info(
    `[x402:inject] attaching ${signed.header} to ${sanitizeUrlForLog(details.url)}`
  );
  return {
    requestHeaders: {
      ...details.requestHeaders,
      [signed.header]: signed.value,
    },
  };
}

// === Installation ========================================================

function installX402Interception() {
  // Capture runs alongside inject on onBeforeSendHeaders; the consumer
  // (the detector on onHeadersReceived) doesn't read until the response
  // round-trips, so their relative order on the chain is irrelevant.
  // Capture is read-only and returns null — it does not interfere with
  // the inject handler that runs next.
  registerWebRequestHandler('onBeforeSendHeaders', 'x402-capture', captureRequestContextHandler);
  registerWebRequestHandler('onBeforeSendHeaders', 'x402-inject', injectPaymentSignatureHandler);
  registerWebRequestHandler('onHeadersReceived', 'x402-detect', detectPaymentRequiredHandler);
  registerWebRequestHandler('onHeadersReceived', 'x402-receipt', paymentResponseLoggingHandler);
  registerWebRequestHandler('onCompleted', 'x402-cleanup', clearRequestContextHandler);
  registerWebRequestHandler('onErrorOccurred', 'x402-cleanup', clearRequestContextHandler);
}

module.exports = {
  X402_HEADERS,
  AUTHORIZED_BY,
  sendToHost,
  outgoingHeaderForVersion,
  installX402Interception,
  captureRequestContextHandler,
  clearRequestContextHandler,
  detectPaymentRequiredHandler,
  injectPaymentSignatureHandler,
  paymentResponseLoggingHandler,
  parsePaymentRequiredHeader,
  setPendingPayment,
  getDetectedPayment,
  clearDetectedPayment,
  clearAllPendingPayments,
  clearAllDetectedPayments,
  clearAllAwaitingResponse,
  clearAllRequestContext,
  consumePendingUnlockResume,
  clearAllPendingUnlockResume,
  setPendingUnlockWait,
  hasPendingUnlockWait,
  settlePendingUnlockWait,
  clearAllPendingUnlockWaits,
  hasPendingApproval,
  getPendingApproval,
  settlePendingApproval,
  abortPendingApproval,
  abortPendingApprovalsForTab,
  clearAllPendingApprovals,
  clearAllHostSenders,
  cleanupWebContents,
};
