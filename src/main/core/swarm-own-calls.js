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
 *   fault, `CoreError` `internal`. The protocol's own errors (`cancelled`,
 *   `busy`, `core_unavailable`, `not_moved`, …) stay the client's
 *   `CoreError`s.
 *
 * **Parts** (`publish()`): `{ path?, bytes }` (held, a Uint8Array) or
 * `{ path?, file, size }` (a picked file's absolute path and the size main
 * gave it). A `data` part of at most 64 KiB goes inline (`{ bytes, base64
 * }`); every other part streams (`{ bytes, part }`, numbered in order),
 * so a collection's params stay one frame whatever its files hold, as the
 * vectors' `shell` cases send them. `walkDirectory()` gives a picked
 * folder's parts as bee-js's `makeCollectionFromFS` finds its files.
 */

const fs = require('fs');
const nodePath = require('path');
const { CoreError } = require('./core-client');
const { SWARM_DEADLINE_MS, idleWatchdogMs, isIdleMethod, watchdogMs } = require('./core-deadlines');
const { rowFor } = require('./swarm-grammar');
const { INLINE_BYTES, TypedFormError, readPlain } = require('./swarm-typed');
const { swarmIoPool } = require('./swarm-io-pool');

const SHELL = Object.freeze({ caller: 'shell' });
const HEX = /^[0-9a-f]+$/;

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

/**
 * `method`'s answer read: its result, or what the service threw, thrown
 * again (`thrownError`). Throws `CoreError` `internal` for any other form.
 *
 * @param {string} method
 * @param {*} answer - the request's result
 * @returns {*}
 */
function readOwnAnswer(method, answer) {
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
  return method === 'swarm.publish' ? publishResult(method, value) : value;
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
      parent?.close();
    }
    // Pooled, the result comes with its release (service-client.js): held
    // until it is read.
    const { result, release } = pool ? reply : { result: reply, release: () => {} };
    try {
      return readOwnAnswer(method, result);
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
  createSwarmOwnCalls,
  publishParams,
  readOwnAnswer,
  swarmOwnCalls,
  walkDirectory,
};
