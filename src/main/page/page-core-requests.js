'use strict';

/**
 * The page requests main has sent the identity core, while they run, and
 * the core's `approval.recheck` for any of them (freedom-core design 0012,
 * APR-5; design 0015, D1, and its 2026-11-28 amendment).
 *
 * Two dispatchers send a page's request to the core under `page`: the
 * EIP-1193 relay (`eip1193.request`, page-eip1193.js) and window.swarm on
 * the core's backend (`swarm.request`, page-swarm-core.js). Each registers
 * its request here from its `onSent`, by the 0001 id on the process it was
 * written to, with the PageContext it sent, and removes it once the core
 * has answered or main has cancelled it. One registry, so one handler
 * serves the core's recheck for both: a Swarm request's recheck reads the
 * same live facts an Ethereum one does, and never falls through to a
 * registry that doesn't hold it (which would refuse it, the core would read
 * the refusal as not live, and every Swarm effect would be refused).
 *
 *   - **`approval.recheck { request, page }`:** `{ live, agent }`, read
 *     now, with nothing awaited: whether the request is still open and its
 *     document current and holding its key, and whether the Agent holds its
 *     tab (the PageContext's `agent`, read live). A DNS name over IPNS is
 *     the core's to resolve, with the PageContext's `transport_key`, before
 *     and after its recheck (APR-5f).
 *   - **Crossed:** a request main doesn't hold on that process (it ended,
 *     or was never sent), a PageContext other than the one main sent (each
 *     of its fields, and the transport key exactly as main sent it, none for
 *     a page sent none), or a member past `{ request, page }`, is
 *     `invalid_argument`, which the core reads as not live: the effect
 *     doesn't go. A family's own asks (`approval.request` and
 *     `eip1193.select_chain`, the EIP-1193 relay's) find only its own
 *     requests (`entryFor`'s `family`): a Swarm request named in one is
 *     crossed too.
 */

const { ShellError } = require('../core/service-client');

const PAGE_FIELDS = Object.freeze(['origin', 'top_origin', 'frame', 'navigation', 'agent']);
// What the core echoes of a PageContext: its fields, and `transport_key`
// where main sent one (cored 0.21.0, APR-5f), never a null.
const ECHO_FIELDS = new Set([...PAGE_FIELDS, 'transport_key']);
// A DNS name over IPNS: the document's transport key, `ipns://` and the
// IPNS key's letters and digits (design 0011's binding).
const IPNS_TRANSPORT = /^ipns:\/\/[A-Za-z0-9]+$/;
const RECHECK_KEYS = new Set(['request', 'page']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const hasOnlyKeys = (value, keys) => Object.keys(value).every((key) => keys.has(key));

const invalid = () => new ShellError('invalid_argument');

/**
 * A document's name binding: its transport key for a DNS name over IPNS
 * (its key differs from its transport key, which is `ipns://` and letters
 * and digits), `null` for a document with no binding, and `false` for a key
 * that differs from a transport key of any other form, which no check can
 * pass.
 */
function bindingOf(requester) {
  const { key, transportKey } = requester;
  if (!key || key === transportKey) return null;
  return typeof transportKey === 'string' && IPNS_TRANSPORT.test(transportKey) ? transportKey : false;
}

/**
 * The document's PageContext as main sends it to the core, with the empty
 * origin for one with no key, and for a DNS name over IPNS its transport
 * key (APR-5f), under which the core checks the name itself. Omitted for
 * any other document.
 */
function pageContextOf(context) {
  const { requester } = context;
  const page = context.pageContext();
  const out = {
    origin: requester.key || '',
    top_origin: requester.topKey || requester.key || '',
    frame: page.frame,
    navigation: page.navigation,
    agent: page.agent === true,
  };
  const binding = bindingOf(requester);
  if (binding) out.transport_key = binding;
  return out;
}

/**
 * A registry of running page requests. Each entry is the dispatcher's own
 * object, with at least `family` (`'eip1193'` or `'swarm'`), `context` (the
 * page request's, page-requests.js) and `page` (the PageContext main sent).
 */
function createCoreRequests() {
  // `${generation}:${id}` -> the request main sent the core, while it runs.
  const running = new Map();

  /**
   * Registers `entry` as request `id` on process `generation` (as `onSent`
   * reports them). Returns its removal, which removes only that entry.
   */
  function add(generation, id, entry) {
    const key = `${generation}:${id}`;
    running.set(key, entry);
    return () => {
      if (running.get(key) === entry) running.delete(key);
    };
  }

  /**
   * The request a core's request names, with the PageContext main sent, of
   * `family` when one is given. Throws `invalid_argument` for anything else
   * (above, Crossed).
   */
  function entryFor(params, generation, keys, family = null) {
    if (!isPlainObject(params) || !hasOnlyKeys(params, keys) || !Number.isSafeInteger(params.request)) throw invalid();
    const entry = running.get(`${generation}:${params.request}`);
    if (!entry || (family !== null && entry.family !== family)) throw invalid();
    const page = params.page;
    if (!isPlainObject(page) || !hasOnlyKeys(page, ECHO_FIELDS)) throw invalid();
    if (!PAGE_FIELDS.every((field) => page[field] === entry.page[field])) throw invalid();
    // The transport key echoed as main sent it: a missing, null or other
    // one for a bound page is crossed, and so is one for a page sent none.
    if (page.transport_key !== entry.page.transport_key) throw invalid();
    return entry;
  }

  /**
   * The core's `approval.recheck`, for a request of either family: answered
   * from what main holds now, with nothing awaited.
   */
  function recheck(params, { generation } = {}) {
    const { context } = entryFor(params, generation, RECHECK_KEYS);
    const live = !context.signal.aborted && context.isCurrent() && context.holdsKey();
    return { live, agent: context.pageContext().agent === true };
  }

  /** How many requests run, of `family` or of both. */
  function size(family = null) {
    if (family === null) return running.size;
    let count = 0;
    for (const entry of running.values()) if (entry.family === family) count += 1;
    return count;
  }

  return Object.freeze({ add, entryFor, recheck, size });
}

let shared = null;

/** Main's one registry, shared by the EIP-1193 relay and window.swarm on the core. */
function getCoreRequests() {
  if (!shared) shared = createCoreRequests();
  return shared;
}

module.exports = {
  PAGE_FIELDS,
  bindingOf,
  pageContextOf,
  createCoreRequests,
  getCoreRequests,
};
