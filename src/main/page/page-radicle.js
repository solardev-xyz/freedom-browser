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
 * PRQ-8b: seeding.
 *
 *   - `radicle_seed`, `radicle_unseed`: a site that isn't connected is
 *     refused; otherwise main prompts (`radicle.node`, with the repository id
 *     as the method accepts it), unless the site's node rule answers, which it
 *     never does for a tab in Agent custody, read live: when the rule is
 *     chosen, and again just before the node action. No prompt offers to turn
 *     the rule on, as none did before.
 *   - `radicle_sync` restarts a fetch for a repository already seeded, with no
 *     prompt; `radicle_getSeedStatus` reads a fetch's state and subscribes the
 *     site to its transitions.
 *   - Each node action (a seed, an unseed, a sync's fetch) is its effect: the
 *     name, custody and the rule (for a request the rule answered), the
 *     connection and the document's key are checked just before it, after
 *     the method's last wait, in the same run as the action and the site's
 *     last use (`page.effect`). An action that went out after a passing check
 *     answers as done, even if the name moves afterwards: the seeding policy
 *     changed for the request the user approved.
 *   - `seedStatus` goes to every live document of the site's key, from main
 *     (`setSeedStatusSink`), each delivery to a name-keyed document only once
 *     the name answers again. Each document has its own queue, one delivery
 *     at a time, holding for each repository how its last fetch ended
 *     (fetched, failed or cancelled), if that hasn't gone yet, and its latest
 *     status after that, for at most `SEED_STATUS_QUEUE` repositories: a
 *     newer status replaces an older one but never an ending, and past the
 *     bound the oldest waiting repository goes.
 *
 * PRQ-8c: signing, and the last of window.radicle.
 *
 *   - `radicle_getIdentity` and the four COB writes need the site's signing
 *     grant. A connected site without it is asked for it first
 *     (`radicle.sign`, grant mode), and main writes it.
 *   - `radicle_getIdentity` discloses the user's Radicle identity: a read
 *     under the key, answered keyless once the name has moved.
 *   - Each COB write needs the user's approval: main's per-write prompt
 *     (`radicle.sign`, write mode), showing exactly what the write signs, or
 *     the site's "always allow writes" rule, rate-limited per site, which
 *     never answers for a tab in Agent custody, read live. A rule-answered
 *     write past the limit falls back to the prompt. "Always allow", the
 *     prompt's one choice outside custody, sets or clears the rule, by main.
 *   - Each write is its effect: the add-on signs and publishes in one call,
 *     so the guard runs just before it, after every wait main controls, and
 *     checks the name, the connection and the signing grant, custody and the
 *     rule for a rule-answered write, and the document's key, in the same run
 *     as the call and the site's last use. A write that went out after a
 *     passing check answers as written, even if the name moves meanwhile.
 *
 * With PRQ-8c every window.radicle method is main's: the chrome's route
 * (`radicle:provider-execute`) is gone, and none of the chrome's channels
 * writes a Radicle grant or turns a rule on.
 */

/** PRQ-8a: the methods that read under the key, with no prompt. */
const RADICLE_READ_METHODS = Object.freeze(['radicle_getCapabilities', 'radicle_getNodeStatus', 'radicle_listSeededRepos']);

/** PRQ-8a: connecting and disconnecting. */
const RADICLE_CONNECT_METHODS = Object.freeze(['radicle_requestAccess', 'radicle_disconnect']);

/** PRQ-8b: seeding. */
const RADICLE_SEED_METHODS = Object.freeze(['radicle_seed', 'radicle_unseed', 'radicle_sync', 'radicle_getSeedStatus']);

/** PRQ-8c: signing. */
const RADICLE_SIGN_METHODS = Object.freeze([
  'radicle_getIdentity',
  'radicle_createIssue',
  'radicle_commentIssue',
  'radicle_editIssueState',
  'radicle_commentPatch',
]);

/** Every method main's Radicle dispatcher serves: all of window.radicle's. */
const RADICLE_PAGE_METHODS = Object.freeze([
  ...RADICLE_READ_METHODS,
  ...RADICLE_CONNECT_METHODS,
  ...RADICLE_SEED_METHODS,
  ...RADICLE_SIGN_METHODS,
]);

// The writes a per-write prompt or the site's signing rule answers.
const WRITE_METHODS = new Set(RADICLE_SIGN_METHODS.filter((method) => method !== 'radicle_getIdentity'));

// The node actions a prompt or the site's node rule answers.
const NODE_METHODS = new Set(['radicle_seed', 'radicle_unseed']);

// The repositories whose statuses wait, at most, for one document.
const SEED_STATUS_QUEUE = 64;
// The states a fetch ends in (seed-status.js). A fetch that starts after
// one begins a new record, with no trace of how the last one ended.
const SEED_ENDINGS = new Set(['fetched', 'failed', 'cancelled']);

// A method whose only use of the key comes before any wait: the answer is
// checked against the key in the same run as it is made, with nothing to
// resolve again. It is also the one read that needs no connection.
const NO_WAIT = new Set(['radicle_getCapabilities']);

// A keyless document's answer to a method that uses the key, as the chrome
// refused a keyless page's site methods (design 0011, "Keys").
const NO_ADDRESS = Object.freeze({
  code: 4100,
  message: 'This page has no address to connect from yet',
  data: Object.freeze({ reason: 'no_address' }),
});
// The answers the chrome's radicle-provider.js gave until main took its
// requests, kept for pages: a method that needs the connection, for a site
// without one, and a rejected prompt.
const NOT_CONNECTED = Object.freeze({ code: 4100, message: 'Origin not authorized. Call radicle_requestAccess first.' });
const USER_REJECTED = Object.freeze({ code: 4001, message: 'User rejected the request' });
// The method's own answer for a repository id it doesn't accept.
const INVALID_RID = Object.freeze({
  code: -32602,
  message: 'Invalid Radicle repository ID',
  data: Object.freeze({ reason: 'invalid_rid' }),
});
// executeRadicleMethod's answer for a connection revoked before the action.
const CONNECTION_GONE = Object.freeze({
  code: 4100,
  message: 'Origin not connected',
  data: Object.freeze({ reason: 'not_connected' }),
});
// As main answers a request Agent custody refuses (radicle-provider-ipc.js).
const AGENT_CUSTODY = Object.freeze({
  code: 4100,
  message: 'A page in Agent custody needs approval for this action',
  data: Object.freeze({ reason: 'agent_custody' }),
});
// executeRadicleMethod's answer for a signing grant revoked before a write.
const SIGNING_GONE = Object.freeze({
  code: 4100,
  message: 'Origin lacks the signing grant',
  data: Object.freeze({ reason: 'signing_not_granted' }),
});
// A node action its rule answered, whose rule was turned off before it.
const RULE_OFF = Object.freeze({
  code: 4100,
  message: 'This action needs the user\'s approval',
  data: Object.freeze({ reason: 'not_auto_approved' }),
});
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
    getAutoApprove: (key, type) => permissions().getAutoApprove(key, type),
    updateLastUsed: (key) => permissions().updateLastUsed(key),
    validateRid: (rid) => require('../radicle-manager').validateAndNormalizeRid(rid),
    inCustody: (guest) => require('./page-signing').guestInCustody(guest),
    hasSigningGrant: (key) => permissions().hasSigningGrant(key),
    grantSigning: (key) => permissions().grantSigning(key),
    setAutoApprove: (key, type, enabled) => permissions().setAutoApprove(key, type, enabled),
    validateWrite: (method, params) => require('../radicle/cob-service').validateWrite(method, params),
    writeRefusal: () => require('../radicle-manager').radicleWriteRefusal(),
  };
}

/**
 * @param {object} [deps] injected for tests; each defaults to main's own.
 * @returns {Record<string, (context: object) => Promise<object>>} the
 *   dispatchers, keyed `radicle:<method>`, for `createPageRequests`.
 */
function createRadicleDispatchers(deps = {}) {
  const {
    execute,
    getPermission,
    grantPermission,
    profileDisabled,
    getAutoApprove,
    updateLastUsed,
    validateRid,
    inCustody,
    hasSigningGrant,
    grantSigning,
    setAutoApprove,
    validateWrite,
    writeRefusal,
  } = { ...defaultDependencies(), ...deps };

  // Whether the agent holds the tab now. Unknown custody counts as custody:
  // no rule answers for it.
  const custody = (guest) => {
    try {
      return inCustody(guest) === true;
    } catch {
      return true;
    }
  };

  const validRid = (rid) => {
    try {
      return typeof rid === 'string' ? validateRid(rid) || null : null;
    } catch {
      return null;
    }
  };

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
    // The chrome refused an unconnected site first, with its own answer.
    if (!NO_WAIT.has(method) && !getPermission(requester.key)) return error(NOT_CONNECTED);
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

  /**
   * A node action's guard (`page.effect`): after the method's last wait, the
   * name again, the connection, then, for a request the rule answered,
   * custody and the rule itself, then the document's key, and the site's
   * last use and the action in the same run.
   */
  async function guardEffect(context, nameCheck, ruled, run) {
    const { requester } = context;
    const key = requester.key;
    if (!(await context.nameHolds(nameCheck))) return { refused: error(NO_ADDRESS).error };
    if (!getPermission(key)) return { refused: error(CONNECTION_GONE).error };
    if (ruled && custody(requester.guest)) return { refused: error(AGENT_CUSTODY).error };
    if (ruled && getAutoApprove(key, 'node') !== true) return { refused: error(RULE_OFF).error };
    if (!context.holdsKey()) return { refused: error(NO_ADDRESS).error };
    try {
      updateLastUsed(key);
    } catch {
      // The action stands; the timestamp didn't change.
    }
    return { value: await run() };
  }

  /**
   * A seed or an unseed (PRQ-8b): the connection, then the site's node rule
   * or main's prompt, and the action under the guard.
   */
  async function nodeAction(context) {
    const { requester, method, params } = context;
    const key = requester.key;
    if (!key) return error(NO_ADDRESS);
    // An action that went out after a passing check answers as done, even
    // if the name moves afterwards. Every refusal before it answers keyless.
    const nameCheck = {};
    if (!(await context.nameHolds(nameCheck))) return error(NO_ADDRESS);
    if (!getPermission(key)) return error(NOT_CONNECTED);
    // The prompt shows the repository: only one the method accepts.
    const rid = validRid(params?.rid);
    if (!rid) return error(INVALID_RID);
    // A standing rule is chosen only outside Agent custody, read live now.
    // A request that goes to its prompt keeps it, whatever custody does
    // next; one the rule answers reads custody again just before its action.
    const ruled = getAutoApprove(key, 'node') === true && !custody(requester.guest);
    if (!ruled) {
      const decision = await context.prompt({
        kind: 'radicle.node',
        view: { method, rid },
        choices: (raw) => (Object.keys(raw).length === 0 ? {} : null),
      });
      if (decision.error) return { error: decision.error };
      if (decision.closed || decision.approve !== true) return error(USER_REJECTED);
    }
    return execute(method, params, key, {
      page: { effect: (run) => guardEffect(context, nameCheck, ruled, run) },
    });
  }

  /**
   * `radicle_sync` (PRQ-8b): a fetch restarted for a repository already
   * seeded, with no prompt. The fetch is its effect, started under the guard
   * after the manager's own wait (the seeding policy's read).
   */
  async function sync(context) {
    const { requester, method, params } = context;
    const key = requester.key;
    if (!key) return error(NO_ADDRESS);
    const nameCheck = {};
    if (!(await context.nameHolds(nameCheck))) return error(NO_ADDRESS);
    if (!getPermission(key)) return error(NOT_CONNECTED);
    return execute(method, params, key, {
      page: { effect: (run) => guardEffect(context, nameCheck, false, run) },
    });
  }

  // Exempt, revocation only: the site gives up its own grants, with no
  // resolution. A document with no key holds none.
  async function disconnect(context) {
    const { requester } = context;
    if (!requester.key) return error(NO_ADDRESS);
    if (!getPermission(requester.key)) return error(NOT_CONNECTED);
    return execute('radicle_disconnect', {}, requester.key);
  }

  const hasSigning = (key) => {
    try {
      return hasSigningGrant(key) === true;
    } catch {
      return false;
    }
  };

  /**
   * The signing grant, asked for once (`radicle.sign`, grant mode) and
   * written by main for the requester's key, under the same checks as every
   * grant write. Resolves null when the site holds it, or the answer that
   * ends the request.
   */
  async function signingGranted(context, nameCheck) {
    const { requester, method } = context;
    const key = requester.key;
    if (hasSigning(key)) return null;
    const decision = await context.prompt({
      kind: 'radicle.sign',
      view: { mode: 'grant', method },
      choices: (raw) => (Object.keys(raw).length === 0 ? {} : null),
    });
    if (decision.error) return { error: decision.error };
    if (decision.closed || decision.approve !== true) return error(USER_REJECTED);
    let written;
    try {
      // A grant another document of the key wrote meanwhile is kept. A
      // connection revoked meanwhile takes no signing grant.
      written = await writeUnderKey(context, nameCheck, () => {
        if (!hasSigning(key)) grantSigning(key);
      });
    } catch (err) {
      return { error: failure(err, 'Failed to save the signing grant') };
    }
    if (!written) return error(NO_ADDRESS);
    return null;
  }

  /**
   * `radicle_getIdentity` (PRQ-8c): the signing grant, then the identity,
   * which discloses the user's DID and node id: the name is resolved before
   * and after its wait, and the answer goes out only while the document
   * still holds the key.
   */
  async function identity(context) {
    const { requester, method, params } = context;
    const key = requester.key;
    if (!key) return error(NO_ADDRESS);
    const keyless = { keyless: error(NO_ADDRESS) };
    if (!(await context.nameHolds(keyless))) return error(NO_ADDRESS);
    if (!getPermission(key)) return error(NOT_CONNECTED);
    const granted = await signingGranted(context, keyless);
    if (granted) return granted;
    if (!(await context.nameHolds(keyless))) return error(NO_ADDRESS);
    // From here to the grants' read and the last use, one run.
    if (!context.holdsKey()) return error(NO_ADDRESS);
    const out = await execute(method, params, key);
    if (!(await context.nameHolds(keyless))) return error(NO_ADDRESS);
    return out;
  }

  /**
   * A signed write's guard (`page.effect`): after every wait main controls,
   * the name again, the connection and the signing grant, then, for a write
   * the rule answered, custody and the rule itself, then the document's key,
   * and the site's last use and the write in the same run.
   */
  async function guardWrite(context, nameCheck, ruled, run) {
    const { requester } = context;
    const key = requester.key;
    if (!(await context.nameHolds(nameCheck))) return { refused: error(NO_ADDRESS).error };
    if (!getPermission(key)) return { refused: error(CONNECTION_GONE).error };
    if (!hasSigning(key)) return { refused: error(SIGNING_GONE).error };
    if (ruled && custody(requester.guest)) return { refused: error(AGENT_CUSTODY).error };
    if (ruled && getAutoApprove(key, 'signing') !== true) return { refused: error(RULE_OFF).error };
    if (!context.holdsKey()) return { refused: error(NO_ADDRESS).error };
    try {
      updateLastUsed(key);
    } catch {
      // The write stands; the timestamp didn't change.
    }
    return { value: await run() };
  }

  /**
   * A COB write (PRQ-8c): the connection, the signing grant, then the site's
   * rule or main's per-write prompt, and the write under the guard.
   */
  async function write(context) {
    const { requester, method, params } = context;
    const key = requester.key;
    if (!key) return error(NO_ADDRESS);
    // A write that went out after a passing check answers as written, even
    // if the name moves meanwhile: it is signed and published for the
    // request the user approved. Every refusal before it answers keyless.
    const nameCheck = {};
    if (!(await context.nameHolds(nameCheck))) return error(NO_ADDRESS);
    if (!getPermission(key)) return error(NOT_CONNECTED);
    const granted = await signingGranted(context, nameCheck);
    if (granted) return granted;
    // The prompt shows exactly what the write signs: params the write
    // refuses are refused before it, with the method's own answer.
    let fields;
    try {
      fields = validateWrite(method, params);
    } catch (err) {
      return {
        error: {
          code: -32602,
          message: typeof err?.message === 'string' ? err.message : 'Invalid params',
          ...(err?.reason ? { data: { reason: err.reason } } : {}),
        },
      };
    }
    // Under the Radicle service, a node running with a throwaway key can't
    // publish (freedom-core design 0008, `needs_vault`): refused before the
    // write's prompt, with executeRadicleMethod's answer, which main gives
    // again just before the write if the node restarts meanwhile.
    const refusal = writeRefusal();
    if (refusal) {
      return { error: { code: 4900, message: refusal.message, data: { reason: refusal.reason } } };
    }
    // A standing rule is chosen only outside Agent custody, read live now.
    // A request that goes to its prompt keeps it, whatever custody does
    // next; one the rule answers reads custody again just before its write.
    const agentHeld = custody(requester.guest);
    const ruleOn = !agentHeld && getAutoApprove(key, 'signing') === true;
    if (ruleOn) {
      const out = await execute(method, params, key, {
        approval: 'auto',
        page: { effect: (run) => guardWrite(context, nameCheck, true, run) },
      });
      // Past the rule's limit, the write asks the user instead.
      if (out?.error?.data?.reason !== 'auto_write_limit') return out;
      if (!(await context.nameHolds(nameCheck))) return error(NO_ADDRESS);
    }
    const decision = await context.prompt({
      kind: 'radicle.sign',
      view: { mode: 'write', method, ...fields, agentHeld, alwaysAllow: ruleOn },
      // "Always allow", the write prompt's one choice outside custody.
      choices: (raw) => {
        const names = Object.keys(raw);
        if (agentHeld) return names.length === 0 ? {} : null;
        if (!names.every((name) => name === 'alwaysAllow')) return null;
        if (raw.alwaysAllow !== undefined && typeof raw.alwaysAllow !== 'boolean') return null;
        return raw.alwaysAllow === undefined ? {} : { alwaysAllow: raw.alwaysAllow };
      },
    });
    if (decision.error) return { error: decision.error };
    if (decision.closed || decision.approve !== true) return error(USER_REJECTED);
    const alwaysAllow = decision.choices.alwaysAllow;
    if (typeof alwaysAllow === 'boolean' && alwaysAllow !== ruleOn) {
      let written;
      try {
        written = await writeUnderKey(context, nameCheck, () => setAutoApprove(key, 'signing', alwaysAllow));
      } catch (err) {
        return { error: failure(err, 'Failed to save the signing rule') };
      }
      if (!written) return error(NO_ADDRESS);
    }
    return execute(method, params, key, {
      approval: 'user',
      page: { effect: (run) => guardWrite(context, nameCheck, false, run) },
    });
  }

  const dispatchers = {};
  for (const method of RADICLE_READ_METHODS) dispatchers[`radicle:${method}`] = underKey;
  dispatchers['radicle:radicle_requestAccess'] = requestAccess;
  dispatchers['radicle:radicle_disconnect'] = disconnect;
  for (const method of NODE_METHODS) dispatchers[`radicle:${method}`] = nodeAction;
  dispatchers['radicle:radicle_sync'] = sync;
  // A fetch's state, and the site's subscription to it: a read under the key.
  dispatchers['radicle:radicle_getSeedStatus'] = underKey;
  dispatchers['radicle:radicle_getIdentity'] = identity;
  for (const method of WRITE_METHODS) dispatchers[`radicle:${method}`] = write;
  return dispatchers;
}

/**
 * `seedStatus` from main (design 0011, "Events"; PRQ-8b): each site's seed
 * status to every live document of its key. Each document has its own
 * queue, sent one at a time through `sendEvent` (with the document's nonce,
 * and to a name-keyed document only once the name answers again). For each
 * repository the queue holds at most two statuses: how its last fetch ended
 * (fetched, failed or cancelled), until it has gone, and the latest status
 * after it. A newer status replaces the latest one, and a newer ending
 * replaces both, so a document always hears how a fetch ended before a
 * later fetch's start, but a fetch's steps may be cut short. At most `max`
 * repositories wait; past it the oldest waiting goes, with its statuses. A
 * document that has gone, or whose name has moved, has its queue dropped.
 *
 * @param {{ liveDocuments: Function, sendEvent: Function }} requests
 * @param {{ normalizeKey?: Function, max?: number }} [options]
 * @returns {(key: string, status: object) => void} the sink.
 */
function createSeedStatusDelivery(requests, { normalizeKey, max = SEED_STATUS_QUEUE } = {}) {
  const normalize = normalizeKey || ((key) => require('../../shared/origin-utils').normalizeOrigin(key));
  // `${guest}:${navigation}` -> { doc, waiting: Map<slot, status>, sending },
  // a slot `end:<rid>` (an ending) or `now:<rid>` (the latest status after it).
  const outboxes = new Map();
  const ridOf = (slot) => slot.slice(4);

  // Queue a repository's status behind everything waiting. An ending takes
  // the place of the repository's statuses waiting; any other status that
  // of its latest one, behind its ending.
  function enqueue(waiting, rid, status) {
    if (SEED_ENDINGS.has(status.state)) {
      waiting.delete(`now:${rid}`);
      waiting.delete(`end:${rid}`);
      waiting.set(`end:${rid}`, status);
    } else {
      waiting.delete(`now:${rid}`);
      waiting.set(`now:${rid}`, status);
    }
    const rids = new Set([...waiting.keys()].map(ridOf));
    while (rids.size > max) {
      const oldest = ridOf(waiting.keys().next().value);
      waiting.delete(`end:${oldest}`);
      waiting.delete(`now:${oldest}`);
      rids.delete(oldest);
    }
  }

  const sameKey = (doc, key) => {
    if (!doc.key) return false;
    try {
      return normalize(doc.key) === key;
    } catch {
      return false;
    }
  };

  async function pump(id, outbox) {
    if (outbox.sending) return;
    outbox.sending = true;
    const { doc } = outbox;
    try {
      while (outbox.waiting.size > 0 && outboxes.get(id) === outbox) {
        const [slot, status] = outbox.waiting.entries().next().value;
        outbox.waiting.delete(slot);
        const outcome = await requests.sendEvent(doc, 'radicle', 'seedStatus', status);
        // A document that has gone, or whose name has moved, hears no more.
        if (!outcome?.ok) {
          outboxes.delete(id);
          return;
        }
      }
    } catch {
      outboxes.delete(id);
      return;
    } finally {
      outbox.sending = false;
    }
    if (outboxes.get(id) === outbox && outbox.waiting.size === 0) outboxes.delete(id);
  }

  return function deliver(origin, status) {
    if (typeof origin !== 'string' || !origin || !status || typeof status !== 'object') return;
    let key;
    let docs;
    try {
      key = normalize(origin);
      docs = requests.liveDocuments().filter((doc) => sameKey(doc, key));
    } catch {
      return;
    }
    const rid = typeof status.rid === 'string' ? status.rid : '';
    for (const doc of docs) {
      const id = `${doc.guest}:${doc.navigation}`;
      let outbox = outboxes.get(id);
      if (!outbox) {
        outbox = { doc, waiting: new Map(), sending: false };
        outboxes.set(id, outbox);
      }
      enqueue(outbox.waiting, rid, status);
      void pump(id, outbox);
    }
  };
}

/**
 * Radicle's events from main (design 0011, "Events"): `disconnect`, a
 * Radicle grant revoked, by the page's own `radicle_disconnect`, by the
 * chrome or by anything else in main, told to every live document of its
 * key, in the key's order with its other grant events; and `seedStatus`
 * (PRQ-8b), each site's seed statuses to every live document of its key
 * (`createSeedStatusDelivery`).
 *
 * @param {{ liveDocuments: Function, sendEvent: Function, inGrantOrder: Function }} requests
 *   the page-requests instance.
 * @param {object} [deps] `onRevoke`, `getPermission` and `normalizeKey`,
 *   the permission store's, and `setSeedStatusSink`, the provider's.
 * @returns {() => void} stops hearing revocations.
 */
function registerRadiclePageEvents(requests, deps = {}) {
  const setSeedStatusSink =
    deps.setSeedStatusSink || ((sink) => require('../radicle/radicle-provider-ipc').setSeedStatusSink(sink));
  setSeedStatusSink(createSeedStatusDelivery(requests, { normalizeKey: deps.normalizeKey }));
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
  RADICLE_SEED_METHODS,
  RADICLE_SIGN_METHODS,
  RADICLE_PAGE_METHODS,
  SEED_STATUS_QUEUE,
  createRadicleDispatchers,
  createSeedStatusDelivery,
  registerRadiclePageEvents,
};
