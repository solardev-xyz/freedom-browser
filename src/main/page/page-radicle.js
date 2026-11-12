'use strict';

/**
 * The Radicle dispatcher for page requests (freedom-core design 0011, "The
 * dispatcher"; step PRQ-8).
 *
 * The chrome's `radicle-provider.js` keyed a page's Radicle request on its
 * own record of the tab's URL, showed Radicle's prompts, wrote the grants
 * through `radicle:grant-permission` and named the site to main
 * (`radicle:provider-execute`, `origin`). Main now serves the request itself,
 * from the attested requester (`page-documents.js`): `executeRadicleMethod`
 * takes the requester's key, never a string a renderer sends.
 *
 * PRQ-8a: the reads, connecting and disconnecting.
 *
 *   - `radicle_getCapabilities` (whether the site is connected),
 *     `radicle_getNodeStatus` (the node id, behind the signing grant) and
 *     `radicle_listSeededRepos` (the user's seeded repositories, behind the
 *     connection): name-revalidated. For a DNS name over IPNS the name is
 *     resolved again before the key is first used, the document must still
 *     hold it in the same run as the use, and after the method's wait the
 *     name is resolved again before the answer goes out. A document with no
 *     key, and one whose name has moved off its IPNS key, is refused with
 *     nothing read ("This page has no address to connect from yet").
 *   - `radicle_requestAccess`: a connected site is marked used; otherwise
 *     main prompts (`radicle.connect`, held per window by `page-prompts.js`,
 *     which the chrome renders) and, on the user's approval, writes the
 *     grant itself, for the requester's key, once the name answers again and
 *     in the same run as its check that the document still holds the key. A
 *     site connected by this request hears `connect`, every live document of
 *     its key, the one that asked first and only if its answer was the
 *     connection.
 *   - `radicle_disconnect` is exempt: it only gives up the site's own grants,
 *     which narrows them, so it runs with no resolution. A Radicle grant
 *     revoked, by the page, by the chrome or by anything else in main, is
 *     told to every live document of its key (`registerRadiclePageEvents`).
 *
 * Every grant event goes out in the key's order (`inGrantOrder`), so each
 * document hears a connect and a later revocation in their order, even while
 * a name's resolution holds one of them.
 *
 * The other methods (seeding, signing) still take the chrome's path until
 * their parts move them (PRQ-8b, PRQ-8c).
 */

/** PRQ-8a: the methods that read under the key, with no prompt. */
const RADICLE_READ_METHODS = Object.freeze(['radicle_getCapabilities', 'radicle_getNodeStatus', 'radicle_listSeededRepos']);

/** PRQ-8a: connecting and disconnecting. */
const RADICLE_CONNECT_METHODS = Object.freeze(['radicle_requestAccess', 'radicle_disconnect']);

/** Every method main's Radicle dispatcher serves. */
const RADICLE_PAGE_METHODS = Object.freeze([...RADICLE_READ_METHODS, ...RADICLE_CONNECT_METHODS]);

// A method whose only use of the key comes before any wait: the answer is
// checked against the key in the same run as it is made, with nothing to
// resolve again.
const NO_WAIT = new Set(['radicle_getCapabilities']);

// A keyless document's answer to a method that uses the key, as the chrome
// refused a keyless page's site methods (design 0011, "Keys").
const NO_ADDRESS = Object.freeze({
  code: 4100,
  message: 'This page has no address to connect from yet',
  data: Object.freeze({ reason: 'no_address' }),
});
// The chrome's answer to a rejected prompt (radicle-consent.js).
const USER_REJECTED = Object.freeze({ code: 4001, message: 'User rejected the request' });
// executeRadicleMethod's answer while Radicle is off for this profile.
const PROFILE_DISABLED = Object.freeze({
  code: 4900,
  message: 'Radicle is disabled for this profile',
  data: Object.freeze({ reason: 'profile-disabled' }),
});
const INTERNAL_ERROR_CODE = -32603;

const error = (base) => ({ error: { ...base, ...(base.data ? { data: { ...base.data } } : {}) } });

function failure(err, fallback) {
  const message = typeof err?.message === 'string' && err.message ? err.message : fallback;
  return { code: INTERNAL_ERROR_CODE, message };
}

const sameDocument = (a, b) => a.guest === b.guest && a.navigation === b.navigation;

function defaultDependencies() {
  const permissions = () => require('../radicle/radicle-permissions');
  const provider = () => require('../radicle/radicle-provider-ipc');
  return {
    execute: (method, params, key, options) => provider().executeRadicleForPage(method, params, key, options),
    getPermission: (key) => permissions().getPermission(key),
    grantPermission: (key) => permissions().grantPermission(key),
    profileDisabled: () => require('../radicle-manager').isDisabledForProfile(),
  };
}

/**
 * @param {object} [deps] injected for tests; each defaults to main's own.
 * @returns {Record<string, (context: object) => Promise<object>>} the
 *   dispatchers, keyed `radicle:<method>`, for `createPageRequests`.
 */
function createRadicleDispatchers(deps = {}) {
  const { execute, getPermission, grantPermission, profileDisabled } = { ...defaultDependencies(), ...deps };

  const disabled = () => {
    try {
      return profileDisabled() === true;
    } catch {
      return false;
    }
  };

  /**
   * A grant write on the user's decision, for the requester's key: the name
   * checked again, then the document's key and the write in one run.
   * Resolves false with nothing written. A write that throws rejects.
   */
  async function writeUnderKey(context, keyless, write) {
    if (!(await context.nameHolds(keyless))) return false;
    if (!context.holdsKey()) return false;
    write();
    return true;
  }

  // A new connection's `connect`, queued in the key's order at the write
  // itself: once main has answered the request, to the document that asked
  // if its answer was the connection, then to every other live document of
  // the key. The grant exists once written, so the key's other documents
  // hear it however the request ended.
  function announceConnect(context) {
    const { requester } = context;
    const key = requester.key;
    context.inGrantOrder(key, async () => {
      const answered = await context.whenAnswered();
      const others = context.liveDocuments().filter((doc) => doc.key === key && !sameDocument(doc, requester));
      if (answered?.ok === true) await context.sendEvent(requester, 'connect', { origin: key });
      for (const doc of others) await context.sendEvent(doc, 'connect', { origin: key });
    });
  }

  // Name-revalidated: before the key's first use, in the same run as it,
  // and after the method's wait.
  async function underKey(context) {
    const { requester, method, params } = context;
    if (!requester.key) return error(NO_ADDRESS);
    const keyless = { keyless: error(NO_ADDRESS) };
    if (!(await context.nameHolds(keyless))) return error(NO_ADDRESS);
    // From here to the method's first use of the key (its grant read in
    // executeRadicleMethod's first run), one run: no other check can end
    // the binding in between.
    if (!context.holdsKey()) return error(NO_ADDRESS);
    const out = await execute(method, params, requester.key);
    if (!NO_WAIT.has(method) && !(await context.nameHolds(keyless))) return error(NO_ADDRESS);
    return out;
  }

  async function requestAccess(context) {
    const { requester } = context;
    const key = requester.key;
    if (!key) return error(NO_ADDRESS);
    const keyless = { keyless: error(NO_ADDRESS) };
    if (!(await context.nameHolds(keyless))) return error(NO_ADDRESS);
    // No prompt for a connection this profile can't use.
    if (disabled()) return error(PROFILE_DISABLED);
    if (!getPermission(key)) {
      const decision = await context.prompt({
        kind: 'radicle.connect',
        view: {},
        choices: (raw) => (Object.keys(raw).length === 0 ? {} : null),
      });
      if (decision.error) return { error: decision.error };
      if (decision.closed || decision.approve !== true) return error(USER_REJECTED);
      let written;
      try {
        written = await writeUnderKey(context, keyless, () => {
          // A grant another document of the key wrote meanwhile is kept,
          // with its signing grant and rules, and was announced by it.
          if (getPermission(key)) return;
          grantPermission(key);
          announceConnect(context);
        });
      } catch (err) {
        return { error: failure(err, 'Failed to save the connection') };
      }
      if (!written) return error(NO_ADDRESS);
    }
    // From here to the grant's read and its last use, one run.
    if (!context.holdsKey()) return error(NO_ADDRESS);
    return execute('radicle_requestAccess', {}, key);
  }

  // Exempt, revocation only: the site gives up its own grants, with no
  // resolution. A document with no key holds none.
  async function disconnect(context) {
    const { requester } = context;
    if (!requester.key) return error(NO_ADDRESS);
    return execute('radicle_disconnect', {}, requester.key);
  }

  const dispatchers = {};
  for (const method of RADICLE_READ_METHODS) dispatchers[`radicle:${method}`] = underKey;
  dispatchers['radicle:radicle_requestAccess'] = requestAccess;
  dispatchers['radicle:radicle_disconnect'] = disconnect;
  return dispatchers;
}

/**
 * Radicle's `disconnect` from main (design 0011, "Events"): a Radicle grant
 * revoked, by the page's own `radicle_disconnect`, by the chrome or by
 * anything else in main, is told to every live document of its key, in the
 * key's order with its other grant events.
 *
 * @param {{ liveDocuments: Function, sendEvent: Function, inGrantOrder: Function }} requests
 *   the page-requests instance.
 * @param {object} [deps] `onRevoke`, `getPermission` and `normalizeKey`,
 *   the permission store's.
 * @returns {() => void} stops it.
 */
function registerRadiclePageEvents(requests, deps = {}) {
  const permissions = () => require('../radicle/radicle-permissions');
  const onRevoke = deps.onRevoke || ((listener) => permissions().onRevoke(listener));
  const getPermission = deps.getPermission || ((key) => permissions().getPermission(key));
  const normalizeKey = deps.normalizeKey || ((key) => require('../../shared/origin-utils').normalizeOrigin(key));
  const sameKey = (doc, key) => {
    if (!doc.key) return false;
    try {
      return normalizeKey(doc.key) === key;
    } catch {
      return false;
    }
  };
  return onRevoke((key) => {
    if (typeof key !== 'string' || !key || getPermission(key)) return;
    let docs;
    try {
      docs = requests.liveDocuments().filter((doc) => sameKey(doc, key));
    } catch {
      return;
    }
    requests.inGrantOrder(key, async () => {
      for (const doc of docs) await requests.sendEvent(doc, 'radicle', 'disconnect', { origin: key });
    });
  });
}

module.exports = {
  RADICLE_READ_METHODS,
  RADICLE_CONNECT_METHODS,
  RADICLE_PAGE_METHODS,
  createRadicleDispatchers,
  registerRadiclePageEvents,
};
