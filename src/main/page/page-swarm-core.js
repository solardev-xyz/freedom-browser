'use strict';

/**
 * window.swarm on the core's backend (freedom-core design 0015, "The
 * protocol", D5, D13, D16, "Results for pages", and the 2026-11-28
 * amendment; SWM-7, PR 7.2): the backend call page-swarm.js makes once its
 * own checks, prompts and grant writes are done (its `execute`), sent to
 * freedom-cored as `swarm.request` in place of the JS backend's
 * `executeSwarmMethod`.
 *
 * **Unused until SWM-7's flip.** page-swarm.js's `execute` stays on the JS
 * backend (swarm-provider-ipc.js) until PR 7.4 selects this one on the
 * core's backend (`swarmCoreDependencies`); only tests select it before.
 *
 *   - **The request** goes as `swarm.request { method, params, approval,
 *     deadline_ms }` under `page`, with the request's PageContext and, for a
 *     DNS name over IPNS, its `transport_key` (page-core-requests.js, as
 *     page-eip1193.js sends its requests), under which the core resolves the
 *     name itself at each of its checks. `method` and `params` are in the
 *     typed form (swarm-typed.js `writePageParams`); `approval` is how main
 *     approved it, `user` (its prompt) or `auto` (the site's rule), and none
 *     for a method without approval; `deadline_ms` is the page's own timer
 *     for the method (page-methods.js: 60 s or 300 s), which the core's
 *     `swarm` deadline takes, and the request's hang watchdog is that plus
 *     the margin. A document whose key differs from a transport key no
 *     check can pass is answered keyless, unsent.
 *   - **The parent** (swarm-shell.js): from the request's `onSent`, before
 *     the core can ask anything for it, main opens it in the executor's
 *     registry with its grammar row (from the params), the params read back
 *     from the typed form main sent (`readTyped`), the page's key, the
 *     node's backend captured as it is sent (`antBackend()` on the guest's
 *     session), the request's signal and its deadline, the held parts of an
 *     upload (each part the page's own bytes, never copied there), and for
 *     `swarm_subscribe` the document its subscription is bound to and how
 *     its messages go there (`subscriber`, SWM-4's D16, which
 *     `shell.swarm_subscribe` opens it for). So a core's ask can name only
 *     that request's own parent, row, parts and node, never another
 *     document's. The parent ends with the request: its answer, its cancel,
 *     its deadline.
 *   - **Point 7:** the request is registered in main's one registry of
 *     running core requests from its `onSent` until it ends, so the core's
 *     `approval.recheck` for it is served by the one handler the EIP-1193
 *     relay serves (page-core-requests.js), live; the relay's own asks
 *     (`approval.request`, `eip1193.select_chain`) find it crossed.
 *   - **The answer** comes typed, `{ result_typed }` or `{ error_typed:
 *     { code, message, data? } }` (D5), and is decoded (`readPlain`) into the
 *     page's `{ result }` or `{ error }`; anything else is `-32603`. Its
 *     charge (the Swarm I/O pool, `{ pool }`: 7.1's release) is held until
 *     page-requests has handed the page's answer on (`whenAnswered`, then a
 *     turn), whatever page-swarm.js answered with it. A charge main has no
 *     room for is dropped, and the page gets `4900` `busy`, as the core's
 *     own admission answers. A successful write resets the vault's
 *     auto-lock timer, as the JS backend did (design 0015, What stays in
 *     main). A write the node refused for want of publishing set up comes
 *     back with its `4900` and setup reason, which page-swarm.js routes to
 *     the setup screen as it does for the JS backend.
 *   - **Cancel:** the request goes with the page request's signal, aborted
 *     when main answers the page (its deadline, its document gone): the
 *     core is told, and the parent ends at once, every call of it
 *     (dialling, streaming a part or a body) with it. A signal already
 *     aborted sends nothing.
 *   - **`swarm_unsubscribe`** never reaches the core (D5): main ends one of
 *     the document's own subscriptions in the subscription registry, as the
 *     JS backend's `handleUnsubscribe` did, with its answers.
 */

const defaultLog = require('../logger');
const { readPlain, readTyped, writePageParams } = require('../core/swarm-typed');
const { paramParts, rowFor } = require('../core/swarm-grammar');
const { watchdogMs } = require('../core/core-deadlines');
const { swarmIoPool } = require('../core/swarm-io-pool');
const { methodRow } = require('./page-methods');
const { bindingOf, getCoreRequests, pageContextOf } = require('./page-core-requests');

const METHOD = 'swarm.request';
// The core's `swarm` deadline when a method has no timer of its own.
const SWARM_DEADLINE_MS = 300_000;
const INTERNAL_ERROR_CODE = -32603;

const NOT_RUNNING = Object.freeze({ code: INTERNAL_ERROR_CODE, message: 'The identity core is not running' });
const NO_ANSWER = Object.freeze({ code: INTERNAL_ERROR_CODE, message: 'The identity core gave no answer for the page' });
const NOT_HELD = Object.freeze({
  code: INTERNAL_ERROR_CODE,
  message: "The request couldn't be opened for the identity core's calls",
});
// Params main can't write in the typed form, or read back from it: bytes
// past 64 KiB where no method reads bytes, which every method refuses.
const INVALID_PARAMS = Object.freeze({ code: -32602, message: 'Invalid parameters' });
// As the core's admission answers a page's request it has no place for
// (D5), and as main answers one whose result it has no room to hold.
const BUSY = Object.freeze({ code: 4900, message: 'busy', data: Object.freeze({ reason: 'busy' }) });
const NO_ADDRESS = Object.freeze({
  code: 4100,
  message: 'This page has no address to connect from yet',
  data: Object.freeze({ reason: 'no_address' }),
});

// The writes whose success resets the vault's auto-lock timer, as
// swarm-provider-ipc.js's executeSwarmMethod does.
const VAULT_TIMER_METHODS = new Set([
  'swarm_publishData',
  'swarm_publishFiles',
  'swarm_publishChunk',
  'swarm_createFeed',
  'swarm_updateFeed',
  'swarm_writeFeedEntry',
  'swarm_writeSingleOwnerChunk',
  'swarm_getSigningIdentity',
]);

const error = (base) => ({ error: { ...base, ...(base.data ? { data: { ...base.data } } : {}) } });

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function failure(err) {
  if (err?.code === 'busy') return error(BUSY);
  const message = typeof err?.message === 'string' && err.message ? err.message : 'Internal error';
  return { error: { code: INTERNAL_ERROR_CODE, message } };
}

// As swarm-provider-ipc.js's invalidParams.
const invalidParams = (message, reason) => ({ error: { code: -32602, message, data: { reason } } });

/** The core's typed answer as the page gets it, or `-32603`. */
function pageAnswer(reply) {
  if (!isPlainObject(reply)) return error(NO_ANSWER);
  const keys = Object.keys(reply);
  if (keys.length !== 1 || (keys[0] !== 'result_typed' && keys[0] !== 'error_typed')) return error(NO_ANSWER);
  let value;
  try {
    value = readPlain(reply[keys[0]]);
  } catch {
    return error(NO_ANSWER);
  }
  if (keys[0] === 'result_typed') return { result: value };
  if (!isPlainObject(value) || !Object.keys(value).every((key) => ['code', 'message', 'data'].includes(key))) {
    return error(NO_ANSWER);
  }
  const { code, message } = value;
  if (!Number.isSafeInteger(code) || typeof message !== 'string') return error(NO_ANSWER);
  return { error: Object.hasOwn(value, 'data') ? { code, message, data: value.data } : { code, message } };
}

function defaultDependencies() {
  return {
    coreClient: () => require('../core/core-process').getCoreClient(),
    swarmShell: () => require('../core/core-process').getSwarmShell(),
    coreRequests: getCoreRequests(),
    pool: swarmIoPool,
    // The node's transport, captured as the request is sent: on the guest's
    // session, whose proxy and onion gate a remote node is reached through.
    nodeBackend: (context) => {
      let session;
      try {
        session = require('electron').webContents.fromId(context.requester.guest)?.session ?? null;
      } catch {
        session = null;
      }
      return require('../swarm/bzz-protocol').antBackend({ session });
    },
    resetVaultTimer: () => require('../vault-timer').resetVaultAutoLockTimer(),
    subscriptions: () => require('../swarm/subscription-registry'),
    now: () => Date.now(),
    // A turn after the page's answer is handed on: Electron has written the
    // reply by then, whatever chain of promises carried it.
    defer: (fn) => setImmediate(fn),
    log: defaultLog,
  };
}

/**
 * page-swarm.js's `execute` on the core's backend.
 *
 * @param {object} [deps] injected for tests; each defaults to main's own.
 * @returns {(method: string, params: *, key: string, meta?: object,
 *   request?: { context: object, approval?: 'user'|'auto'|null }) =>
 *   Promise<object>} the page's `{ result }` or `{ error }`
 */
function createSwarmCoreExecute(deps = {}) {
  const {
    coreClient,
    swarmShell,
    coreRequests,
    pool,
    nodeBackend,
    resetVaultTimer,
    subscriptions,
    now,
    defer,
    log,
  } = { ...defaultDependencies(), ...deps };

  const read = (fn) => {
    try {
      return fn();
    } catch {
      return null;
    }
  };

  // The result's charge goes once page-requests has handed the page's
  // answer on (or found its document gone), and a turn after.
  function handOn(context, release) {
    let released = false;
    const go = () => {
      if (released) return;
      released = true;
      release();
    };
    let answered;
    try {
      answered = typeof context.whenAnswered === 'function' ? context.whenAnswered() : null;
    } catch {
      answered = null;
    }
    if (!answered || typeof answered.then !== 'function') {
      go();
      return;
    }
    answered.then(
      () => defer(go),
      () => defer(go)
    );
  }

  // One of the document's own subscriptions ended, as the JS backend's
  // handleUnsubscribe does for a page.
  function unsubscribe(params, meta) {
    if (!params || typeof params !== 'object') return invalidParams('params is required', 'invalid_params');
    const { subscriptionId } = params;
    if (typeof subscriptionId !== 'string' || subscriptionId.length === 0) {
      return invalidParams('subscriptionId is required', 'invalid_params');
    }
    const document = meta?.page?.document;
    if (typeof document !== 'string') return { error: { code: INTERNAL_ERROR_CODE, message: 'Internal error' } };
    try {
      subscriptions().unsubscribeDocument(document, subscriptionId);
      return { result: { unsubscribed: true } };
    } catch (err) {
      if (err?.reason === 'subscription_not_found') return invalidParams(err.message, 'subscription_not_found');
      return failure(err);
    }
  }

  /**
   * The parent's capture, checked before anything is sent: the row its
   * params give, those params read back, and the parts they name, each
   * with the bytes main holds for it. Null for a method with no row (the
   * core makes no call for it). Throws for params main can't read back.
   */
  function captureOf(method, encoded) {
    const params = readTyped(encoded.typed);
    const row = rowFor(method, params);
    if (row === null) return null;
    // What `open()` builds, built here first: a part the params name with
    // no bytes, or bytes no part names, is main's bug, found unsent.
    const declared = paramParts(row, params);
    if (declared.size !== encoded.parts.size) throw new TypeError("the params' parts aren't main's");
    for (const [part, length] of declared) {
      if (encoded.parts.get(part)?.byteLength !== length) throw new TypeError(`part ${part} isn't main's`);
    }
    return { row, params };
  }

  return async function execute(method, params, key, meta, { context = null, approval = null } = {}) {
    if (method === 'swarm_unsubscribe') return unsubscribe(params, meta);
    if (!context) return { error: { code: INTERNAL_ERROR_CODE, message: 'Internal error' } };
    const { requester } = context;
    // A key no name check can pass is never sent as bound (page-eip1193.js
    // answers such a document keyless too).
    if (bindingOf(requester) === false) return error(NO_ADDRESS);
    const client = read(coreClient);
    const shell = read(swarmShell);
    if (!client || !shell) return error(NOT_RUNNING);
    let encoded;
    let capture;
    try {
      encoded = writePageParams(method, params);
      capture = captureOf(method, encoded);
    } catch (err) {
      log.warn('[Swarm] a page request the typed form refuses', { reason: err?.name || 'Error' });
      return error(INVALID_PARAMS);
    }
    if (encoded.copies > 0) meta?.page?.copied?.('typed-data');
    const page = pageContextOf(context);
    const deadlineMs = methodRow('swarm', method)?.timeoutMs ?? null;
    const body = { method: { string: method }, params: encoded.typed };
    if (approval === 'user' || approval === 'auto') body.approval = approval;
    if (deadlineMs !== null) body.deadline_ms = deadlineMs;
    const subscriber =
      method === 'swarm_subscribe' && typeof meta?.page?.document === 'string' && typeof meta.page.deliverTo === 'function'
        ? { document: meta.page.document, deliverTo: meta.page.deliverTo }
        : null;
    // Ends the request if its parent can't be opened: the core is told.
    const own = new AbortController();
    const signal = AbortSignal.any([context.signal, own.signal]);
    const entry = { family: 'swarm', context, method, page };
    let remove = null;
    let parent = null;
    let unheld = false;
    let reply;
    try {
      reply = await client.request(METHOD, body, { caller: 'page', page }, {
        watchdogMs: watchdogMs(METHOD, deadlineMs ?? undefined),
        signal,
        pool,
        onSent: (id, generation) => {
          remove = coreRequests.add(generation, id, entry);
          if (!capture) return;
          try {
            parent = shell.open(
              { generation, id },
              {
                row: capture.row,
                params: capture.params,
                key: page.origin,
                backend: nodeBackend(context),
                signal,
                deadlineAt: now() + (deadlineMs ?? SWARM_DEADLINE_MS),
                parts: encoded.parts,
                subscriber,
              }
            );
          } catch (err) {
            unheld = true;
            log.warn('[Swarm] a page request could not be opened for the core', {
              row: capture.row,
              reason: err?.name || 'Error',
            });
            own.abort();
          }
        },
      });
    } catch (err) {
      return unheld ? error(NOT_HELD) : failure(err);
    } finally {
      remove?.();
      parent?.close();
    }
    // Pooled, the result comes with its release (service-client.js).
    const { result: answered, release } = pool ? reply : { result: reply, release: () => {} };
    const out = pageAnswer(answered);
    handOn(context, release);
    if (VAULT_TIMER_METHODS.has(method) && out.result) {
      try {
        resetVaultTimer();
      } catch {
        // The page has its answer either way.
      }
    }
    return out;
  };
}

/**
 * The deps page-swarm.js's `createSwarmDispatchers` takes on the core's
 * backend (PR 7.4 selects them): `execute` here, and a document's
 * subscriptions ended in the subscription registry itself, never through
 * the JS backend.
 *
 * @param {object} [deps] `createSwarmCoreExecute`'s
 */
function swarmCoreDependencies(deps = {}) {
  const subscriptions = deps.subscriptions || (() => require('../swarm/subscription-registry'));
  return {
    execute: createSwarmCoreExecute(deps),
    endDocumentSubscriptions: (document) => subscriptions().cancelByDocument(document),
    endDocumentSubscription: (document, subscriptionId) => {
      try {
        subscriptions().unsubscribeDocument(document, subscriptionId);
      } catch {
        // Already gone.
      }
    },
  };
}

module.exports = {
  VAULT_TIMER_METHODS,
  createSwarmCoreExecute,
  swarmCoreDependencies,
  pageAnswer,
};
