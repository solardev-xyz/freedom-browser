'use strict';

/**
 * Main's own Swarm node methods on the core's backend (freedom-core design
 * 0015, "Methods main calls", D5 and D13; SWM-8, the SWM-6 to SWM-9 plan's
 * PR 8.3): `swarm.publish`, `swarm.stamps` and `swarm.upload_status`, sent
 * as `shell`, each opened in main's executor (core/swarm-shell.js) from its
 * `onSent` as page-swarm-core.js opens a page's `swarm.request`. Shared by
 * freedom://publish (swarm/publish-service.js, swarm/stamp-service.js) and,
 * from PR 8.4, the agent's publication controller and postage readiness;
 * `call()` takes any method with a grammar row (`swarm.feed`'s among them).
 *
 * Only on the core's backend: the executor admits no parent on `js`
 * (`open()` throws there), and the callers pick these by
 * `swarmBackendKind()`.
 *
 * - **The request:** `method` with main's own JSON params (design 0015,
 *   "Main's own node methods' params"), under its watchdog:
 *   `swarm.publish` is an idle method, sent with its idle watchdog
 *   (core-deadlines.js `idleWatchdogMs`), which the executor moves on with
 *   the request's progress (the asks naming it, main's answers, the frames
 *   of its streams; swarm-shell.js); the others carry the `swarm` deadline
 *   (300 s) and its hang watchdog. Its result is charged to the Swarm I/O
 *   pool until it is read (`{ pool }`).
 * - **The parent** (swarm-shell.js `open()`): its grammar row from the
 *   params (`rowFor`), the params, no key (main's own), the node's backend
 *   captured as it is sent (`antBackend()` on the default session, as
 *   ant-storage-api.js dials), the caller's signal, the `swarm` deadline
 *   (none for `swarm.publish`), and the source of each part the params
 *   name: a held buffer, or a picked file `{ path, bytes }` main opens
 *   when the core asks for it. A parent that can't be opened (main's own
 *   bug) ends the request: the core is told, and the call throws
 *   `internal`.
 * - **The answer** (D5): `{ result_typed }`, the service's result, or
 *   `{ error_typed: { message, code?, status?, capacity? } }`, what the
 *   reference's service threw as its callers read it, thrown here again
 *   as an Error with those members (`isNoUsableBatchError` reads `code`,
 *   the agent `status` and `capacity`). Anything else is the core's
 *   fault, `CoreError` `internal`: so is a result of `swarm.publish`,
 *   `swarm.stamps` or `swarm.upload_status` that isn't exactly the shape
 *   the core gives (a member missing, one more, or one of another type).
 *   The protocol's own errors (`cancelled`, `busy`, `core_unavailable`,
 *   `not_moved`, …) stay the client's `CoreError`s.
 * - **The row's insert:** a `swarm.publish` with `history` that the core
 *   answers with its history store's fixed error (`HISTORY_FAILED_MESSAGE`,
 *   no other member) before it asked main anything for it failed at the
 *   row's insert (or the bound's trim that follows it), where js's
 *   `addEntry` throws before the handler's `try`: it is thrown as a
 *   `HistoryInsertError`, which freedom://publish's handlers let reject the
 *   invoke, as on js. The same error after an ask is a later row write's,
 *   which the core retries (`history-retry`): an Error like any other.
 *
 * **Parts** (`publish()`): `{ path?, bytes }` (held, a Uint8Array) or
 * `{ path?, file, size }` (a picked file's absolute path and the size main
 * gave it). A `data` part of at most 64 KiB goes inline (`{ bytes, base64
 * }`); every other part streams (`{ bytes, part }`, numbered in order),
 * so a collection's params stay one frame whatever its files hold, as the
 * vectors' `shell` cases send them. `walkDirectory()` gives a picked
 * folder's parts as bee-js's `makeCollectionFromFS` finds its files.
 *
 * **One frame:** the params still name every part, so a folder of many
 * files can pass the request frame (frame.js `MAX_PAYLOAD`, 1 MiB), which
 * the client refuses unsent. `publishFits()` measures the request as the
 * client frames it, with the widest ID, so a caller can refuse it first,
 * the same way whatever ID it would get.
 */

const fs = require('fs');
const nodePath = require('path');
const { CoreError } = require('./core-client');
const { SWARM_DEADLINE_MS, idleWatchdogMs, isIdleMethod, watchdogMs } = require('./core-deadlines');
const { MAX_ID, MAX_PAYLOAD } = require('./frame');
const { rowFor } = require('./swarm-grammar');
const { INLINE_BYTES, TypedFormError, readPlain } = require('./swarm-typed');
const { swarmIoPool } = require('./swarm-io-pool');

const SHELL = Object.freeze({ caller: 'shell' });
const HEX = /^[0-9a-f]+$/;

/**
 * The core's text for a publish history it can't open, read or write
 * (freedom-cored `swarm/stores.rs` `HISTORY_FAILED`). `swarm.publish`
 * answers it as `{ error_typed: { message } }`, with no `code`, `status`
 * or `capacity`, where its row's insert fails (fc-swarm-provider
 * `shell_publish.rs`: "`addEntry` throws before the handler's `try`"), and
 * where a later write of the row fails as well.
 */
const HISTORY_FAILED_MESSAGE = 'The publish history could not be read or written';

/**
 * `swarm.publish`'s history row not inserted: the core's history store
 * failed the insert, or the bound's trim right after it, before anything
 * else of the publish ran (`readOwnAnswer`'s caller saw no ask naming it).
 * js's `addEntry` throws before the handler's `try` there, so the handlers
 * let this reject the invoke.
 */
class HistoryInsertError extends Error {
  constructor(message = HISTORY_FAILED_MESSAGE) {
    super(message);
  }
}

/** A part the params name, to the executor's source of it. */
function isHeld(part) {
  return part !== null && typeof part === 'object' && part.bytes instanceof Uint8Array;
}

function isPicked(part) {
  return (
    part !== null &&
    typeof part === 'object' &&
    typeof part.file === 'string' &&
    nodePath.isAbsolute(part.file) &&
    Number.isSafeInteger(part.size) &&
    part.size >= 0
  );
}

/**
 * `swarm.publish`'s params (main's JSON, design 0015, "Main's own node
 * methods' params") and the sources of the parts they stream.
 *
 * @param {object} spec
 * @param {'data'|'file'|'collection'} spec.kind
 * @param {Array<object>} spec.parts - `{ path?, bytes }` or `{ path?, file, size }`
 * @param {string} [spec.name] - a file's name (required for `file`)
 * @param {string} [spec.contentType]
 * @param {string} [spec.indexDocument] - a collection's
 * @param {boolean} [spec.encrypt]
 * @param {string} [spec.batch] - a given batch, 64 hex
 * @param {boolean} spec.deferred
 * @param {{type: 'data'|'file'|'directory', name: string}} [spec.history]
 *   - the freedom://publish row the core keeps around the upload
 * @returns {{ params: object, sources: Map<number, Uint8Array|{path: string, bytes: number}> }}
 */
function publishParams({
  kind,
  parts,
  name,
  contentType,
  indexDocument,
  encrypt,
  batch,
  deferred,
  history,
}) {
  if (!['data', 'file', 'collection'].includes(kind)) throw new TypeError('no kind');
  if (!Array.isArray(parts)) throw new TypeError('parts is an array');
  if (typeof deferred !== 'boolean') throw new TypeError('deferred is a boolean');
  const sources = new Map();
  const wire = parts.map((part) => {
    const out = {};
    if (part.path !== undefined) out.path = part.path;
    if (isHeld(part)) {
      out.bytes = part.bytes.byteLength;
      if (kind === 'data' && part.bytes.byteLength <= INLINE_BYTES) {
        out.base64 = Buffer.from(
          part.bytes.buffer,
          part.bytes.byteOffset,
          part.bytes.byteLength
        ).toString('base64');
        return out;
      }
      out.part = sources.size;
      sources.set(out.part, part.bytes);
      return out;
    }
    if (isPicked(part)) {
      out.bytes = part.size;
      out.part = sources.size;
      sources.set(out.part, { path: part.file, bytes: part.size });
      return out;
    }
    throw new TypeError('a part is held bytes or a picked file');
  });
  const params = { kind, parts: wire };
  if (name !== undefined) params.name = name;
  if (contentType !== undefined) params.content_type = contentType;
  if (indexDocument !== undefined) params.index_document = indexDocument;
  if (encrypt === true) params.encrypt = true;
  if (batch !== undefined && batch !== null) params.batch = batch;
  params.pin = true;
  params.deferred = deferred;
  if (history !== undefined) params.history = { type: history.type, name: history.name };
  return { params, sources };
}

/**
 * A picked folder's files, as bee-js 13.2.0's `makeCollectionFromFS` finds
 * them for `uploadFromDirectory`: each regular file under `dir` (a symlink,
 * which the folder's entry doesn't say is a file, is left out, as are
 * sockets and devices), in the order `opendir` gives, a subfolder's files
 * ahead of those found before it, each with its size from `stat`. Paths
 * are joined with `/` on every platform (bee-js joins them with the
 * platform's separator, which on Windows sent `sub\file`, as #1052 found
 * for a page's files).
 *
 * @param {string} dir - the picked folder's absolute path
 * @returns {Promise<Array<{path: string, file: string, size: number}>>}
 */
async function walkDirectory(dir) {
  const walk = async (relative) => {
    const entries = await fs.promises.opendir(relative ? nodePath.join(dir, relative) : dir);
    let collection = [];
    for await (const entry of entries) {
      const file = nodePath.join(dir, relative, entry.name);
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isFile()) {
        collection.push({ path, file, size: (await fs.promises.stat(file)).size });
      } else if (entry.isDirectory()) {
        collection = [...(await walk(path)), ...collection];
      }
    }
    return collection;
  };
  return walk('');
}

/**
 * The bytes of `method`'s request with `params` as the client frames it
 * (service-client.js: `{ type, id, method, params, context }` as JSON, the
 * context `shell`), with the widest ID (frame.js `MAX_ID`): whatever ID
 * the request gets, its frame is no longer.
 */
function requestBytes(method, params) {
  const request = { type: 'request', id: MAX_ID, method, params, context: SHELL };
  return Buffer.byteLength(JSON.stringify(request), 'utf8');
}

/**
 * Whether the `swarm.publish` of `spec` (`publishParams`' spec) fits one
 * request frame (frame.js `MAX_PAYLOAD`, 1 MiB), measured by
 * `requestBytes`. One that doesn't is refused unsent by the client
 * (`Request too large`), and only past a bound that depends on its ID's
 * digits; a caller that checks this first refuses it the same way every
 * time.
 *
 * @param {object} spec
 * @returns {boolean}
 */
function publishFits(spec) {
  return requestBytes('swarm.publish', publishParams(spec).params) <= MAX_PAYLOAD;
}

const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** A malformed answer: the core's fault. */
function malformed(method, why) {
  return new CoreError('internal', `The core's ${method} answer is malformed: ${why}`);
}

/**
 * What a shell method threw (`{ message, code?, status?, capacity? }`), as
 * an Error with those members; anything else is malformed.
 */
function thrownError(method, value) {
  if (!isPlainObject(value)) throw malformed(method, 'error_typed is not an object');
  const { message, code, status, capacity } = value;
  const extra = Object.keys(value).filter(
    (k) => !['message', 'code', 'status', 'capacity'].includes(k)
  );
  if (
    typeof message !== 'string' ||
    (Object.hasOwn(value, 'code') && typeof code !== 'string') ||
    (Object.hasOwn(value, 'status') && !Number.isSafeInteger(status)) ||
    (Object.hasOwn(value, 'capacity') && !isPlainObject(capacity)) ||
    extra.length > 0
  ) {
    throw malformed(method, 'error_typed is not { message, code?, status?, capacity? }');
  }
  const err = new Error(message);
  if (Object.hasOwn(value, 'code')) err.code = code;
  if (Object.hasOwn(value, 'status')) err.status = status;
  if (Object.hasOwn(value, 'capacity')) err.capacity = { ...capacity };
  return err;
}

/** `swarm.publish`'s result read strictly: `{ reference, tag_uid, batch, bytes }`. */
function publishResult(method, value) {
  const ok =
    isPlainObject(value) &&
    Object.keys(value).length === 4 &&
    typeof value.reference === 'string' &&
    (value.reference.length === 64 || value.reference.length === 128) &&
    HEX.test(value.reference) &&
    (value.tag_uid === null ||
      (typeof value.tag_uid === 'number' && Number.isFinite(value.tag_uid))) &&
    typeof value.batch === 'string' &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes >= 0;
  if (!ok) throw malformed(method, 'not { reference, tag_uid, batch, bytes }');
  return value;
}

const isNumber = (value) => typeof value === 'number';
const isBoolean = (value) => typeof value === 'boolean';
const isString = (value) => typeof value === 'string';
/** A batch's ID as the core writes it: 64 lowercase hex (`hex()`). */
const isBatchId = (value) => isString(value) && /^[0-9a-f]{64}$/.test(value);
/** `asNumberString(amount)`: an integer's decimal text. */
const isIntegerText = (value) => isString(value) && /^-?[0-9]+$/.test(value);
/** `normalizeTag`'s `reference`: 64 or 128 hex, in lower case. */
const isReference = (value) => isString(value) && /^[0-9a-f]{64}(?:[0-9a-f]{64})?$/.test(value);

/**
 * Whether `value` is an object with exactly the members `required` names,
 * each of its type, and of `optional`'s only those it names, each of its
 * type.
 */
function shaped(value, required, optional) {
  if (!isPlainObject(value)) return false;
  for (const [key, typed] of Object.entries(required)) {
    if (!Object.hasOwn(value, key) || !typed(value[key])) return false;
  }
  return Object.keys(value).every(
    (key) =>
      Object.hasOwn(required, key) || (Object.hasOwn(optional, key) && optional[key](value[key]))
  );
}

/**
 * A `swarm.stamps` batch (fc-swarm-provider `shell_stamps.rs`
 * `batch_value`): bee-js's `mapPostageBatch` fields, as numbers and
 * strings, then the node's own `exists`, `propagating` and `batchTTL`
 * where it sent them.
 */
const BATCH = Object.freeze({
  batchID: isBatchId,
  utilization: isNumber,
  usable: isBoolean,
  label: isString,
  depth: isNumber,
  amount: isIntegerText,
  bucketDepth: isNumber,
  blockNumber: isNumber,
  immutableFlag: isBoolean,
  usage: isNumber,
  usageText: isString,
  size: isNumber,
  remainingSize: isNumber,
  theoreticalSize: isNumber,
  duration: isNumber,
});
const BATCH_RAW = Object.freeze({
  exists: isBoolean,
  propagating: isBoolean,
  batchTTL: isNumber,
});

/**
 * `swarm.upload_status`'s result (fc-swarm-provider `replies.rs`
 * `normalize_tag`): `normalizeTag`'s object, its `reference` only where
 * the tag's address is one.
 */
const TAG = Object.freeze({
  tagUid: isNumber,
  split: isNumber,
  seen: isNumber,
  stored: isNumber,
  sent: isNumber,
  synced: isNumber,
  progress: isNumber,
  done: isBoolean,
});
const TAG_REFERENCE = Object.freeze({ reference: isReference });

const isBatch = (value) => shaped(value, BATCH, BATCH_RAW);

/**
 * `swarm.stamps`' result read strictly: a list of batches, or, for an
 * `id`, the one batch.
 */
function stampsResult(method, value, params) {
  if (params !== null && typeof params === 'object' && Object.hasOwn(params, 'id')) {
    if (!isBatch(value)) throw malformed(method, 'not a batch');
    return value;
  }
  // Indexed, so a hole is no batch.
  const ok = Array.isArray(value) && Array.from(value, (batch) => isBatch(batch)).every(Boolean);
  if (!ok) throw malformed(method, 'not a list of batches');
  return value;
}

/** `swarm.upload_status`'s result read strictly: `normalizeTag`'s object. */
function uploadStatusResult(method, value) {
  if (!shaped(value, TAG, TAG_REFERENCE)) throw malformed(method, "not normalizeTag's object");
  return value;
}

/**
 * `method`'s answer read: its result, or what the service threw, thrown
 * again (`thrownError`). Throws `CoreError` `internal` for any other form,
 * and for a result of `swarm.publish`, `swarm.stamps` (by `params`: a
 * list, or one batch for an `id`) or `swarm.upload_status` that isn't
 * exactly the core's shape.
 *
 * @param {string} method
 * @param {*} answer - the request's result
 * @param {object} [params] - the params it was sent with
 * @returns {*}
 */
function readOwnAnswer(method, answer, params = {}) {
  if (!isPlainObject(answer)) throw malformed(method, 'not an object');
  const keys = Object.keys(answer);
  if (keys.length !== 1 || (keys[0] !== 'result_typed' && keys[0] !== 'error_typed')) {
    throw malformed(method, 'not { result_typed } or { error_typed }');
  }
  let value;
  try {
    value = readPlain(answer[keys[0]]);
  } catch (err) {
    if (err instanceof TypedFormError) throw malformed(method, err.message);
    throw err;
  }
  if (keys[0] === 'error_typed') throw thrownError(method, value);
  switch (method) {
    case 'swarm.publish':
      return publishResult(method, value);
    case 'swarm.stamps':
      return stampsResult(method, value, params);
    case 'swarm.upload_status':
      return uploadStatusResult(method, value);
    default:
      return value;
  }
}

/**
 * Whether `err`, what `readOwnAnswer` threw for a `swarm.publish` with
 * `history`, is its row's insert failing: exactly the core's history
 * store error, with no other member, answered before the core asked main
 * anything for the request (`asked` false: the insert, and the bound's
 * trim after it, come before any node call).
 */
function isRowInsert(method, params, err, asked) {
  return (
    method === 'swarm.publish' &&
    params?.history !== undefined &&
    !asked &&
    !(err instanceof CoreError) &&
    err?.message === HISTORY_FAILED_MESSAGE &&
    !Object.hasOwn(err, 'code') &&
    !Object.hasOwn(err, 'status') &&
    !Object.hasOwn(err, 'capacity')
  );
}

function defaultDependencies() {
  return {
    coreClient: () => require('./core-process').getCoreClient(),
    swarmShell: () => require('./core-process').getSwarmShell(),
    // The node's transport, captured as the request is sent: main's own
    // call, on the default session, as ant-storage-api.js dials.
    nodeBackend: () => require('../swarm/bzz-protocol').antBackend(),
    pool: swarmIoPool,
    now: () => Date.now(),
    log: require('../logger'),
  };
}

/**
 * The calls, over the running core (core-process.js) by default.
 *
 * @param {object} [deps] - test seams: `coreClient()`, `swarmShell()`,
 *   `nodeBackend()`, `pool`, `now()`, `log`
 */
function createSwarmOwnCalls(deps = {}) {
  const { coreClient, swarmShell, nodeBackend, pool, now, log } = {
    ...defaultDependencies(),
    ...deps,
  };
  const read = (fn) => {
    try {
      return fn();
    } catch {
      return null;
    }
  };

  /**
   * One of main's own Swarm requests: `method` with `params` (main's
   * JSON), its parent opened in the executor with `sources` (each part the
   * params stream, by number), cancelled by `signal`. Resolves with the
   * service's result, or rejects with what it threw or the protocol's
   * error.
   *
   * @param {string} method
   * @param {object} params
   * @param {{ sources?: Map|null, signal?: AbortSignal|null }} [options]
   */
  async function call(method, params, { sources = null, signal = null } = {}) {
    const row = rowFor(method, params);
    if (row === null) throw new TypeError(`${method} has no grammar row`);
    const client = read(coreClient);
    const shell = read(swarmShell);
    if (!client || !shell)
      throw new CoreError('core_unavailable', 'The identity core is not running');
    const idle = isIdleMethod(method);
    // Ends the request if its parent can't be opened: the core is told.
    const own = new AbortController();
    const life = signal ? AbortSignal.any([signal, own.signal]) : own.signal;
    let parent = null;
    let unheld = false;
    // Whether the core asked anything naming it (the executor's count),
    // as it ended; taken as asked where the executor can't say.
    let asked = true;
    let reply;
    try {
      reply = await client.request(method, params, SHELL, {
        ...(idle ? { idleWatchdogMs: idleWatchdogMs(method) } : { watchdogMs: watchdogMs(method) }),
        signal: life,
        pool,
        onSent: (id, generation) => {
          try {
            parent = shell.open(
              { generation, id },
              {
                row,
                params,
                backend: nodeBackend(),
                signal: life,
                deadlineAt: idle ? null : now() + SWARM_DEADLINE_MS,
                parts: sources,
              }
            );
          } catch (err) {
            unheld = true;
            log.warn('[Swarm] a request of main could not be opened for the core', {
              row,
              reason: err?.name || 'Error',
            });
            own.abort();
          }
        },
      });
    } catch (err) {
      if (unheld) {
        throw new CoreError(
          'internal',
          "The request couldn't be opened for the identity core's calls"
        );
      }
      throw err;
    } finally {
      if (typeof parent?.asked === 'function') asked = parent.asked();
      parent?.close();
    }
    // Pooled, the result comes with its release (service-client.js): held
    // until it is read.
    const { result, release } = pool ? reply : { result: reply, release: () => {} };
    try {
      return readOwnAnswer(method, result, params);
    } catch (err) {
      if (isRowInsert(method, params, err, asked)) throw new HistoryInsertError(err.message);
      throw err;
    } finally {
      release();
    }
  }

  return Object.freeze({
    call,
    /**
     * `swarm.publish` (`publishParams`' spec): `{ reference, tag_uid,
     * batch, bytes }`.
     */
    publish(spec, { signal = null } = {}) {
      const { params, sources } = publishParams(spec);
      return call('swarm.publish', params, { sources, signal });
    },
    /** `swarm.stamps`: the node's batches, or the one `id` names. */
    stamps({ id } = {}, { signal = null } = {}) {
      return call('swarm.stamps', id === undefined ? {} : { id }, { signal });
    },
    /** `swarm.upload_status`: `normalizeTag`'s object for `tagUid`. */
    uploadStatus(tagUid, { signal = null } = {}) {
      return call('swarm.upload_status', { tag_uid: tagUid }, { signal });
    },
  });
}

let shared = null;
/** The calls over the running core, made once. */
function swarmOwnCalls() {
  if (!shared) shared = createSwarmOwnCalls();
  return shared;
}

module.exports = {
  HISTORY_FAILED_MESSAGE,
  HistoryInsertError,
  createSwarmOwnCalls,
  publishFits,
  publishParams,
  readOwnAnswer,
  requestBytes,
  swarmOwnCalls,
  walkDirectory,
};
