'use strict';

/**
 * The Swarm dispatcher for page requests (freedom-core design 0011, "The
 * dispatcher"; step PRQ-7).
 *
 * The chrome's `swarm-provider.js` keyed a page's Swarm request on its own
 * record of the tab's URL and named the site to main
 * (`swarm:provider-execute`, `origin`). Main now serves the request itself,
 * from the attested requester (`page-documents.js`): `executeSwarmMethod`
 * takes the requester's key, never a string a renderer sends.
 *
 * PRQ-7a: the methods that need neither a prompt nor the permission
 * manifest's check, the chrome's public methods:
 *
 *   - `swarm_readChunk`, `swarm_readData`, `swarm_readSingleOwnerChunk`:
 *     permission-free. The key picks only a rate, the read budget's bucket
 *     and whether it is a connected site's, so it runs on the document's key
 *     as it stands, with no resolution. A document with no key reads on the
 *     anonymous budget, in one bucket shared by every keyless document.
 *   - `swarm_getCapabilities` (whether the site is connected),
 *     `swarm_readFeedEntry` and `swarm_listFeeds` (the site's feed records:
 *     a feed read by `name` takes its topic and owner from them):
 *     name-revalidated. For a DNS name over IPNS the name is resolved again
 *     before the key is first used, the document must still hold it in the
 *     same run as the use, and after the method's wait the name is resolved
 *     again before the answer goes out. A document with no key, and one
 *     whose name has moved off its IPNS key, is refused with nothing read
 *     ("This page has no address to connect from yet").
 *
 * PRQ-7b: connecting, the manifest check and messaging, with their prompts
 * (held per window by `page-prompts.js`, which the chrome renders):
 *
 *   - The permission manifest is checked by main, for the document's own
 *     URL and key, before each of these methods but `swarm_unsubscribe`,
 *     once per document (eagerly for `swarm_requestAccess`), as the chrome
 *     did per navigation. A consent shows as main's prompt
 *     (`swarm.manifest`); its token never leaves main, and main decides it,
 *     under the key's lock, once the name answers again.
 *   - `swarm_requestAccess`: a connected site is marked used; otherwise
 *     main prompts (`swarm.connect`) and, on the user's approval, writes the
 *     grant itself, for the requester's key. A site connected by this
 *     request hears `connect`, every live document of its key; a site whose
 *     grant is revoked hears `disconnect`, every live document of its key
 *     (`registerSwarmPageEvents`).
 *   - `swarm_getMessagingIdentity`, `swarm_subscribe`, `swarm_sendPss`,
 *     `swarm_sendGsoc`: a connected site without the messaging grant is
 *     asked for it (`swarm.messaging`, grant mode), and main writes it. A
 *     send otherwise asks per message (`swarm.messaging`), unless the site's
 *     messaging rule answers, which it never does for a tab in Agent
 *     custody, read live: when the rule is chosen, and again just before the
 *     send, after its last wait. "Always allow" on a send sets the rule, by
 *     main.
 *   - A subscription is bound to its document: its messages go to that
 *     document alone, through `sendEvent` (with the document's nonce, and
 *     for a name-keyed document after the name answers again), and it ends
 *     with the document. One whose name moves off its IPNS key ends at its
 *     next message. `swarm_unsubscribe` is exempt: it ends one of the
 *     document's own subscriptions, with no resolution.
 *
 * Every grant write main makes on a decision runs under the key's lock,
 * after the name answers again, in the same run as its check that the
 * document still holds its key. Every effect (a send, a subscription
 * opened) is checked the same way just before it, after the method's last
 * wait (`meta.page.effect` in `swarm-provider-ipc.js`).
 *
 * Every method answers `4900` while the Identity & Wallet switch is off, as
 * the chrome did. The chrome's own path (`swarm:provider-execute`) refuses
 * the moved methods: the preload no longer sends them there, and a chrome
 * that names a site for them asks for something only a page may.
 *
 * PRQ-7c: publishing, with its prompt (`swarm.publish`):
 *
 *   - `swarm_publishData`, `swarm_publishFiles`, `swarm_publishChunk`: the
 *     manifest checked first, as for messaging; a site that isn't
 *     connected is refused; otherwise main prompts (`swarm.publish`, with
 *     main's view of what the page would publish), unless the site's
 *     publish rule answers, which it never does for a tab in Agent custody,
 *     read live: when the rule is chosen, and again just before the upload,
 *     after its last wait. "Always allow", the prompt's one choice, sets
 *     the rule, by main. The upload is the effect: the name, custody, the
 *     rule, the connection and the document are checked just before it, in
 *     the same run (`meta.page.effect`). An upload that went out after a
 *     passing check answers with its reference, even if the name moves
 *     afterwards, as a send answers as sent; what it leaves held under the
 *     key, the tag's owner, is recorded only while the name still answers
 *     (`meta.page.afterEffect`). The two large uploads arrive on their
 *     tickets (`page:reserve`), and each copy main makes of their bytes is
 *     reported against the request's charge (`meta.page.copied`).
 *   - `swarm_getUploadStatus`: the tag's owner is held under the key, so
 *     the name is resolved before the read and again before the answer.
 *   - A write the node refuses because publishing isn't set up (`4900`
 *     with a setup reason) takes the user to the setup screen, as the
 *     chrome did: main tells the requesting window's chrome.
 *
 * PRQ-7d moves feeds and signing, with their prompts.
 */

/** PRQ-7a: the methods that need no prompt and no manifest check. */
const SWARM_READ_METHODS = Object.freeze([
  'swarm_getCapabilities',
  'swarm_readChunk',
  'swarm_readData',
  'swarm_readSingleOwnerChunk',
  'swarm_readFeedEntry',
  'swarm_listFeeds',
]);

/** PRQ-7b: connecting. */
const SWARM_CONNECT_METHODS = Object.freeze(['swarm_requestAccess']);

/** PRQ-7b: messaging. */
const SWARM_MESSAGING_METHODS = Object.freeze([
  'swarm_getMessagingIdentity',
  'swarm_subscribe',
  'swarm_unsubscribe',
  'swarm_sendPss',
  'swarm_sendGsoc',
]);

/** PRQ-7c: publishing. */
const SWARM_PUBLISH_METHODS = Object.freeze([
  'swarm_publishData',
  'swarm_publishFiles',
  'swarm_publishChunk',
  'swarm_getUploadStatus',
]);

/** Every method main's Swarm dispatcher serves, and so the preload routes to main. */
const SWARM_PAGE_METHODS = Object.freeze([
  ...SWARM_READ_METHODS,
  ...SWARM_CONNECT_METHODS,
  ...SWARM_MESSAGING_METHODS,
  ...SWARM_PUBLISH_METHODS,
]);

// The permission-free ones: the key is a rate, never authority.
const PERMISSION_FREE = new Set(['swarm_readChunk', 'swarm_readData', 'swarm_readSingleOwnerChunk']);

// A method whose only use of the key comes before any wait: the answer is
// checked against the key in the same run as it goes out, with nothing to
// resolve again.
const NO_WAIT = new Set(['swarm_listFeeds']);

// The sends a site's messaging rule may answer.
const SEND_METHODS = new Set(['swarm_sendPss', 'swarm_sendGsoc']);

// The uploads a site's publish rule may answer.
const UPLOAD_METHODS = new Set(['swarm_publishData', 'swarm_publishFiles', 'swarm_publishChunk']);

// The writes that need publishing set up, and the node's reasons that say
// it isn't (`checkSwarmPreFlight`): a failure for one of them takes the
// user to the setup screen, as the chrome's swarm-provider.js did.
const SETUP_ROUTED = new Set([...UPLOAD_METHODS, ...SEND_METHODS]);
const SETUP_REASONS = new Set(['node-stopped', 'node-not-ready', 'ultra-light-mode', 'no-usable-stamps']);

// What a messaging prompt may show of a topic: what the method accepts.
const MAX_TOPIC_BYTES = 256;
// What a publish prompt may show of the page's own text (a content type, a
// name): one bound for each, past which it isn't shown. A path is shown only
// as the method accepts it (`LIMITS.maxPathBytes`), and at most three.
const MAX_VIEW_TEXT_BYTES = 256;
const MAX_VIEW_PATH_BYTES = 100;
const VIEW_PATHS = 3;

// The chrome's answer while the Identity & Wallet switch is off.
const DISCONNECTED = Object.freeze({ code: 4900, message: 'Swarm provider is not available' });
// A keyless document's answer to a method that uses the key, as the chrome
// refused a keyless page's site methods (design 0011, "Keys").
const NO_ADDRESS = Object.freeze({
  code: 4100,
  message: 'This page has no address to connect from yet',
  data: Object.freeze({ reason: 'no_address' }),
});
// The chrome's answers, as its swarm-provider.js and swarm-connect.js gave
// them.
const NOT_CONNECTED = Object.freeze({ code: 4100, message: 'Origin not authorized. Call swarm_requestAccess first.' });
const CONNECT_REJECTED = Object.freeze({ code: 4001, message: 'User rejected Swarm access' });
const PUBLISH_REJECTED = Object.freeze({ code: 4001, message: 'User rejected publish' });
const USER_REJECTED = Object.freeze({ code: 4001, message: 'User rejected the request' });
const MANIFEST_UNRESOLVED = Object.freeze({ code: 4900, message: 'Could not refresh this app’s permission manifest' });
// As main answers a request Agent custody refuses.
const AGENT_CUSTODY = Object.freeze({
  code: 4100,
  message: 'The origin is not authorized for this operation',
  data: Object.freeze({ reason: 'agent_custody' }),
});
// A send its rule answered, whose rule was turned off before it went out.
const RULE_OFF = Object.freeze({
  code: 4100,
  message: 'The origin is not authorized for this operation',
  data: Object.freeze({ reason: 'not_auto_approved' }),
});
const INTERNAL_ERROR_CODE = -32603;
// The key a keyless document's permission-free reads are rated on.
const KEYLESS_BUCKET = '';

const error = (base) => ({ error: { ...base, ...(base.data ? { data: { ...base.data } } : {}) } });

function failure(err, fallback) {
  const message = typeof err?.message === 'string' && err.message ? err.message : fallback;
  return { code: INTERNAL_ERROR_CODE, message };
}

const documentKeyOf = (requester) => `${requester.guest}:${requester.navigation}`;

/** A message's size, as the chrome's prompt showed it, or null. */
function payloadBytes(data) {
  if (typeof data === 'string') return Buffer.byteLength(data, 'utf-8');
  if (data instanceof Uint8Array || data instanceof ArrayBuffer) return data.byteLength;
  if (data && typeof data === 'object' && data.type === 'Buffer' && Array.isArray(data.data)) return data.data.length;
  return null;
}

// The page's text, if it is a string within `max` UTF-8 bytes.
const boundedText = (value, max) =>
  typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf-8') <= max ? value : undefined;

/**
 * The publish prompt's view (design 0011, "What a prompt shows"): the method
 * and the kind of upload, main's own; of the page's, the sizes main measured,
 * and its text only as far as each field's bound: a data upload's content
 * type and name, and the first paths of a files upload, each as the method
 * accepts a path.
 */
function publishView(method, params) {
  if (method === 'swarm_publishFiles') {
    const files = Array.isArray(params?.files) ? params.files : [];
    let size = 0;
    const paths = [];
    for (const file of files) {
      size += payloadBytes(file?.bytes) ?? 0;
      if (paths.length < VIEW_PATHS) {
        const shown = boundedText(file?.path, MAX_VIEW_PATH_BYTES);
        if (shown !== undefined) paths.push(shown);
      }
    }
    return { method, kind: 'files', count: files.length, size, paths };
  }
  const size = payloadBytes(params?.data) ?? 0;
  if (method === 'swarm_publishChunk') return { method, kind: 'chunk', size };
  const view = { method, kind: 'data', size };
  const contentType = boundedText(params?.contentType, MAX_VIEW_TEXT_BYTES);
  if (contentType !== undefined) view.contentType = contentType;
  const name = boundedText(params?.name, MAX_VIEW_TEXT_BYTES);
  if (name !== undefined) view.name = name;
  return view;
}

// "Always allow", where a prompt offers it, and nothing else.
const alwaysAllowChoice = (raw) =>
  Object.keys(raw).every((name) => name === 'alwaysAllow') &&
  (raw.alwaysAllow === undefined || typeof raw.alwaysAllow === 'boolean')
    ? { alwaysAllow: raw.alwaysAllow === true }
    : null;

/**
 * The messaging prompt's view (design 0011, "What a prompt shows"): the
 * method and the prompt's mode, main's own; the page's topic, as the
 * method accepts it, and the message's size. Nothing else of the page's.
 */
function messagingView(method, params, grantMode) {
  const view = { method, grantMode };
  const topic = params?.topic;
  if (typeof topic === 'string' && topic.length > 0 && Buffer.byteLength(topic, 'utf-8') <= MAX_TOPIC_BYTES) view.topic = topic;
  if (SEND_METHODS.has(method)) {
    const size = payloadBytes(params?.data);
    if (size !== null) view.size = size;
  }
  return view;
}

function defaultDependencies() {
  const permissions = () => require('../swarm/swarm-permissions');
  const provider = () => require('../swarm/swarm-provider-ipc');
  const manifests = () => require('../swarm/permission-manifests');
  return {
    identityWalletEnabled: () => require('../settings-store').loadSettings()?.enableIdentityWallet === true,
    execute: (method, params, key, meta) => provider().executeSwarmMethod(method, params, key, meta),
    getPermission: (key) => permissions().getPermission(key),
    grantPermission: (key) => permissions().grantPermission(key),
    updateLastUsed: (key) => permissions().updateLastUsed(key),
    hasMessagingGrant: (key) => permissions().hasMessagingGrant(key),
    grantMessaging: (key) => permissions().grantMessaging(key),
    getAutoApprove: (key, type) => permissions().getAutoApprove(key, type),
    setAutoApprove: (key, type, enabled) => permissions().setAutoApprove(key, type, enabled),
    lockOrigin: (key, task) => require('../swarm/origin-mutation-lock').withOriginLock(key, task),
    checkManifest: (request) => manifests().checkPageManifest(request),
    decideManifest: (key, token, outcome, guard) => manifests().decidePageManifest(key, token, outcome, guard),
    releaseManifest: (token) => manifests().releasePageManifest(token),
    guestContents: (id) => require('electron').webContents.fromId(id),
    inCustody: (guest) => require('./page-signing').guestInCustody(guest),
    endDocumentSubscriptions: (document) => provider().endDocumentSubscriptions(document),
    endDocumentSubscription: (document, id) => provider().endDocumentSubscription(document, id),
    routeToSetup: (requester, reason) => {
      const { BrowserWindow } = require('electron');
      const win = BrowserWindow.fromId(requester.window);
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
      win.webContents.send(require('../../shared/ipc-channels').SWARM_PUBLISH_SETUP_NEEDED, {
        origin: requester.key,
        reason,
      });
    },
  };
}

/**
 * @param {object} [deps] injected for tests; each defaults to main's own.
 * @returns {Record<string, (context: object) => Promise<object>>} the
 *   dispatchers, keyed `swarm:<method>`, for `createPageRequests`.
 */
function createSwarmDispatchers(deps = {}) {
  const {
    identityWalletEnabled,
    execute,
    getPermission,
    grantPermission,
    updateLastUsed,
    hasMessagingGrant,
    grantMessaging,
    getAutoApprove,
    setAutoApprove,
    lockOrigin,
    checkManifest,
    decideManifest,
    releaseManifest,
    guestContents,
    inCustody,
    endDocumentSubscriptions,
    endDocumentSubscription,
    routeToSetup,
  } = { ...defaultDependencies(), ...deps };

  // document key -> { eager, promise }: the manifest check, once per document.
  const manifestChecks = new Map();
  // The documents whose end main is listening for.
  const armed = new Set();

  // Whether the agent holds the tab now. Unknown custody counts as custody:
  // no rule answers for it.
  const custody = (guest) => {
    try {
      return inCustody(guest) === true;
    } catch {
      return true;
    }
  };

  // What outlives a request but not its document ends with the document:
  // its manifest check and its subscriptions.
  function armDocument(context) {
    const document = documentKeyOf(context.requester);
    if (armed.has(document)) return;
    armed.add(document);
    context.onDocumentEnded(() => {
      armed.delete(document);
      manifestChecks.delete(document);
      try {
        endDocumentSubscriptions(document);
      } catch {
        // Nothing left to end.
      }
    });
  }

  /**
   * A grant write on the user's decision, for the requester's key: under the
   * key's lock (as the chrome's writes were), the name checked again inside
   * it, then the document's key and the write in one run. Resolves false
   * with nothing written. A write that throws rejects.
   */
  function writeUnderKey(context, keyless, write) {
    return lockOrigin(context.requester.key, async () => {
      if (!(await context.nameHolds(keyless))) return false;
      if (!context.holdsKey()) return false;
      write();
      return true;
    });
  }

  async function refreshManifest(context, keyless, eager) {
    const { requester } = context;
    let result;
    try {
      result = await checkManifest({ key: requester.key, url: requester.url, guest: guestContents(requester.guest), eager });
    } catch (err) {
      return { error: failure(err, 'Could not check this app’s permission manifest') };
    }
    if (result?.kind === 'unresolved') return { error: { ...MANIFEST_UNRESOLVED } };
    if (result?.kind !== 'consent') return { ok: true };
    // The consent is this request's: it goes when the request is done with
    // it, however that ends (a decision, a refusal, its prompt closed by a
    // navigation, its deadline or its window), and if main answers the
    // request first.
    const release = () => {
      try {
        releaseManifest(result.token);
      } catch {
        // Gone already.
      }
    };
    const signal = context.signal;
    signal?.addEventListener?.('abort', release, { once: true });
    try {
      return await decideConsent(context, keyless, result);
    } finally {
      signal?.removeEventListener?.('abort', release);
      release();
    }
  }

  async function decideConsent(context, keyless, result) {
    const { requester } = context;
    if (!(await context.nameHolds(keyless))) return { error: error(NO_ADDRESS).error };
    const decision = await context.prompt({
      kind: 'swarm.manifest',
      view: { model: result.model },
      // The one thing the user picks: managed by the manifest, or one by one.
      choices: (raw) =>
        Object.keys(raw).every((name) => name === 'outcome') && (raw.outcome === 'allow' || raw.outcome === 'individual')
          ? { outcome: raw.outcome }
          : null,
    });
    if (decision.error) return { error: decision.error };
    // Closed some other way: asked again on the next request.
    if (decision.closed) return { error: { ...USER_REJECTED } };
    const outcome = decision.approve === true ? decision.choices.outcome : 'deny';
    let decided;
    try {
      decided = await decideManifest(requester.key, result.token, outcome, {
        recheck: () => context.nameHolds(keyless),
        holds: () => context.holdsKey(),
      });
    } catch (err) {
      return { error: failure(err, 'Could not save the permission manifest decision') };
    }
    if (decided?.refused) return { error: error(NO_ADDRESS).error };
    // A denial stands for the document, as the chrome kept it.
    if (!decided?.allowed) return { error: { ...USER_REJECTED }, keep: true };
    return { ok: true };
  }

  // The manifest check, once per document, as the chrome's was per
  // navigation; an eager one (connecting) once more if only a lazy one ran.
  // One that failed is tried again by the next request.
  async function manifestFresh(context, keyless, eager) {
    const document = documentKeyOf(context.requester);
    armDocument(context);
    let cached = manifestChecks.get(document);
    if (!cached || (eager && !cached.eager)) {
      cached = { eager, promise: refreshManifest(context, keyless, eager) };
      manifestChecks.set(document, cached);
    }
    const outcome = await cached.promise;
    if (outcome.error && !outcome.keep && manifestChecks.get(document) === cached) manifestChecks.delete(document);
    return outcome;
  }

  // Swarm's connect and disconnect: to every live document of the key, the
  // one that asked first.
  async function announce(context, event) {
    const { requester } = context;
    const key = requester.key;
    await context.sendEvent(requester, event, { origin: key });
    const others = context
      .liveDocuments()
      .filter((doc) => doc.key === key && !(doc.guest === requester.guest && doc.navigation === requester.navigation));
    for (const doc of others) await context.sendEvent(doc, event, { origin: key });
  }

  // Permission-free: the document's key as it stands, resolving nothing.
  async function permissionFree(context) {
    const { requester, method, params } = context;
    return execute(method, params, requester.key || KEYLESS_BUCKET);
  }

  // Name-revalidated: before the key's first use, in the same run as it,
  // and after the method's wait.
  async function underKey(context) {
    const { requester, method, params } = context;
    if (!requester.key) return error(NO_ADDRESS);
    const keyless = { keyless: error(NO_ADDRESS) };
    if (!(await context.nameHolds(keyless))) return error(NO_ADDRESS);
    // From here to the method's first use of the key, one run: no other
    // check can end the binding in between.
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
    const connectedBefore = Boolean(getPermission(key));
    const manifest = await manifestFresh(context, keyless, true);
    if (manifest.error) return { error: manifest.error };
    if (!(await context.nameHolds(keyless))) return error(NO_ADDRESS);
    if (getPermission(key)) {
      if (!(await writeUnderKey(context, keyless, () => updateLastUsed(key)))) return error(NO_ADDRESS);
    } else {
      const decision = await context.prompt({
        kind: 'swarm.connect',
        view: {},
        choices: (raw) => (Object.keys(raw).length === 0 ? {} : null),
      });
      if (decision.error) return { error: decision.error };
      if (decision.closed || decision.approve !== true) return error(CONNECT_REJECTED);
      let written;
      try {
        // A grant another document of the key wrote meanwhile is kept, with
        // its rules.
        written = await writeUnderKey(context, keyless, () => {
          if (!getPermission(key)) grantPermission(key);
        });
      } catch (err) {
        return { error: failure(err, 'Failed to save the connection') };
      }
      if (!written) return error(NO_ADDRESS);
    }
    const out = await execute('swarm_requestAccess', {}, key);
    if (!out.error && !connectedBefore) context.afterAnswer(() => announce(context, 'connect'));
    return out;
  }

  /**
   * The effect's guard (`meta.page.effect`): after the method's last wait,
   * the name again, then, for a request a rule answered (`rule`, the rule's
   * type), custody and the rule itself, and the document's key, and the
   * effect in the same run.
   */
  async function guardEffect(context, nameCheck, rule, run) {
    const { requester } = context;
    if (!(await context.nameHolds(nameCheck))) return { refused: error(NO_ADDRESS).error };
    if (rule && custody(requester.guest)) return { refused: error(AGENT_CUSTODY).error };
    if (rule && getAutoApprove(requester.key, rule) !== true) return { refused: error(RULE_OFF).error };
    if (!context.holdsKey()) return { refused: error(NO_ADDRESS).error };
    return { value: await run() };
  }

  /**
   * What an effect that has happened leaves held under the key (an
   * upload's tag owner, `meta.page.afterEffect`): written only while the
   * name still answers, in the same run as the check that the document
   * holds its key. Resolves whether it was written.
   */
  async function afterEffect(context, write) {
    if (!(await context.nameHolds({}))) return false;
    if (!context.holdsKey()) return false;
    write();
    return true;
  }

  // A write the node refused because publishing isn't set up: the setup
  // screen, in the requesting window, while the document is still there.
  function routeSetupFailure(context, out) {
    const reason = out?.error?.data?.reason;
    if (!SETUP_ROUTED.has(context.method) || out?.error?.code !== 4900 || !SETUP_REASONS.has(reason)) return;
    if (!context.isCurrent()) return;
    try {
      routeToSetup(context.requester, reason);
    } catch {
      // The page has its answer either way.
    }
  }

  async function messaging(context) {
    const { requester, method, params } = context;
    const key = requester.key;
    if (!key) return error(NO_ADDRESS);
    const keyless = { keyless: error(NO_ADDRESS) };
    // A send that went out after a passing check answers as sent, even if
    // the name moves afterwards: the message is on the network for the
    // request the user approved. What reveals or binds the key's authority
    // (the messaging identity, a subscription) answers keyless then.
    const isSend = SEND_METHODS.has(method);
    const nameCheck = isSend ? {} : keyless;
    if (!(await context.nameHolds(nameCheck))) return error(NO_ADDRESS);
    const manifest = await manifestFresh(context, nameCheck, false);
    if (manifest.error) return { error: manifest.error };
    if (!(await context.nameHolds(nameCheck))) return error(NO_ADDRESS);
    if (!getPermission(key)) return error(NOT_CONNECTED);
    const granted = hasMessagingGrant(key) === true;
    // A standing rule is chosen only outside Agent custody, read live now.
    // A request that goes to its prompt keeps it, whatever custody does
    // next; one the rule answers reads custody again just before its send.
    const ruled = isSend && granted && getAutoApprove(key, 'messaging') === true && !custody(requester.guest);
    if (!granted) {
      const decision = await context.prompt({
        kind: 'swarm.messaging',
        view: messagingView(method, params, true),
        choices: (raw) => (Object.keys(raw).length === 0 ? {} : null),
      });
      if (decision.error) return { error: decision.error };
      if (decision.closed || decision.approve !== true) return error(USER_REJECTED);
      let written;
      try {
        written = await writeUnderKey(context, nameCheck, () => grantMessaging(key));
      } catch (err) {
        return { error: failure(err, 'Failed to save messaging access') };
      }
      if (!written) return error(NO_ADDRESS);
    } else if (isSend && !ruled) {
      const decision = await context.prompt({
        kind: 'swarm.messaging',
        view: messagingView(method, params, false),
        // "Always allow", the send prompt's one choice.
        choices: alwaysAllowChoice,
      });
      if (decision.error) return { error: decision.error };
      if (decision.closed || decision.approve !== true) return error(USER_REJECTED);
      if (decision.choices.alwaysAllow) {
        let written;
        try {
          written = await writeUnderKey(context, nameCheck, () => setAutoApprove(key, 'messaging', true));
        } catch (err) {
          return { error: failure(err, 'Failed to save the messaging rule') };
        }
        if (!written) return error(NO_ADDRESS);
      }
    }
    // The site's last use, as the chrome marked it before each call.
    try {
      if (!(await writeUnderKey(context, nameCheck, () => updateLastUsed(key)))) return error(NO_ADDRESS);
    } catch {
      // The request stands; the timestamp didn't change.
    }
    const document = documentKeyOf(requester);
    const page = { document, effect: (run) => guardEffect(context, nameCheck, ruled ? 'messaging' : null, run) };
    if (method === 'swarm_subscribe') {
      armDocument(context);
      page.deliverTo = (data) => context.sendEvent(requester, 'message', data);
    }
    const out = await execute(method, params, key, { page });
    routeSetupFailure(context, out);
    if (out.error || isSend) return out;
    // After the method's wait: what reveals or binds the key goes out only
    // while the name still answers.
    if (!(await context.nameHolds(keyless)) || !context.holdsKey()) {
      if (method === 'swarm_subscribe' && typeof out.result?.subscriptionId === 'string') {
        endDocumentSubscription(document, out.result.subscriptionId);
      }
      return error(NO_ADDRESS);
    }
    return out;
  }

  /**
   * An upload (PRQ-7c): the manifest, the connection, then the site's
   * publish rule or main's prompt, and the upload under the effect's guard.
   */
  async function publish(context) {
    const { requester, method, params } = context;
    const key = requester.key;
    if (!key) return error(NO_ADDRESS);
    // An upload that went out after a passing check answers with its
    // reference, even if the name moves afterwards: the content is on the
    // network for the request the user approved, and its reference is
    // public. Every refusal before it answers keyless.
    const nameCheck = {};
    if (!(await context.nameHolds(nameCheck))) return error(NO_ADDRESS);
    const manifest = await manifestFresh(context, nameCheck, false);
    if (manifest.error) return { error: manifest.error };
    if (!(await context.nameHolds(nameCheck))) return error(NO_ADDRESS);
    const permission = getPermission(key);
    if (!permission) return error(NOT_CONNECTED);
    // A standing rule is chosen only outside Agent custody, read live now.
    // A request that goes to its prompt keeps it, whatever custody does
    // next; one the rule answers reads custody again just before its upload.
    const ruled = permission.autoApprove?.publish === true && !custody(requester.guest);
    if (!ruled) {
      const decision = await context.prompt({
        kind: 'swarm.publish',
        view: publishView(method, params),
        // "Always allow", the publish prompt's one choice.
        choices: alwaysAllowChoice,
      });
      if (decision.error) return { error: decision.error };
      if (decision.closed || decision.approve !== true) return error(PUBLISH_REJECTED);
      if (decision.choices.alwaysAllow) {
        let written;
        try {
          written = await writeUnderKey(context, nameCheck, () => setAutoApprove(key, 'publish', true));
        } catch (err) {
          return { error: failure(err, 'Failed to save the publish rule') };
        }
        if (!written) return error(NO_ADDRESS);
      }
    }
    // The site's last use, as the chrome marked it before each call.
    try {
      if (!(await writeUnderKey(context, nameCheck, () => updateLastUsed(key)))) return error(NO_ADDRESS);
    } catch {
      // The request stands; the timestamp didn't change.
    }
    const out = await execute(method, params, key, {
      page: {
        document: documentKeyOf(requester),
        effect: (run) => guardEffect(context, nameCheck, ruled ? 'publish' : null, run),
        afterEffect: (write) => afterEffect(context, write),
        copied: (label) => context.copied(label),
      },
    });
    routeSetupFailure(context, out);
    return out;
  }

  /**
   * `swarm_getUploadStatus` (PRQ-7c): a tag's progress, for the site that
   * owns the tag. The tag's owner is held under the key, so the name is
   * resolved before the read and again before the answer goes out.
   */
  async function uploadStatus(context) {
    const { requester, method, params } = context;
    const key = requester.key;
    if (!key) return error(NO_ADDRESS);
    const keyless = { keyless: error(NO_ADDRESS) };
    if (!(await context.nameHolds(keyless))) return error(NO_ADDRESS);
    const manifest = await manifestFresh(context, keyless, false);
    if (manifest.error) return { error: manifest.error };
    if (!(await context.nameHolds(keyless))) return error(NO_ADDRESS);
    if (!getPermission(key)) return error(NOT_CONNECTED);
    try {
      if (!(await writeUnderKey(context, keyless, () => updateLastUsed(key)))) return error(NO_ADDRESS);
    } catch {
      // The request stands; the timestamp didn't change.
    }
    // From here to the read of the tag's owner, one run.
    if (!context.holdsKey()) return error(NO_ADDRESS);
    const out = await execute(method, params, key);
    if (!(await context.nameHolds(keyless)) || !context.holdsKey()) return error(NO_ADDRESS);
    return out;
  }

  // Exempt, revocation only: one of the document's own subscriptions ends,
  // with no resolution, keyless or not.
  async function unsubscribe(context) {
    const { requester, params } = context;
    return execute('swarm_unsubscribe', params, requester.key || KEYLESS_BUCKET, {
      page: { document: documentKeyOf(requester) },
    });
  }

  const serve = (answer) => async (context) => {
    if (!identityWalletEnabled()) return error(DISCONNECTED);
    return answer(context);
  };

  const dispatchers = {};
  for (const method of SWARM_READ_METHODS) {
    dispatchers[`swarm:${method}`] = serve(PERMISSION_FREE.has(method) ? permissionFree : underKey);
  }
  dispatchers['swarm:swarm_requestAccess'] = serve(requestAccess);
  for (const method of SWARM_MESSAGING_METHODS) {
    dispatchers[`swarm:${method}`] = serve(method === 'swarm_unsubscribe' ? unsubscribe : messaging);
  }
  for (const method of SWARM_PUBLISH_METHODS) {
    dispatchers[`swarm:${method}`] = serve(UPLOAD_METHODS.has(method) ? publish : uploadStatus);
  }
  return dispatchers;
}

/**
 * Swarm's `disconnect` from main (design 0011, "Events"): a Swarm grant
 * revoked, by the user or by a manifest, is told to every live document of
 * its key. A messaging grant revoked alone leaves the site connected, and
 * tells nothing.
 *
 * @param {{ liveDocuments: Function, sendEvent: Function }} requests the
 *   page-requests instance.
 * @param {object} [deps] `onRevoke` and `getPermission`, the permission
 *   store's.
 */
function registerSwarmPageEvents(requests, deps = {}) {
  const permissions = () => require('../swarm/swarm-permissions');
  const onRevoke = deps.onRevoke || ((listener) => permissions().onRevoke(listener));
  const getPermission = deps.getPermission || ((key) => permissions().getPermission(key));
  return onRevoke((key) => {
    if (typeof key !== 'string' || !key || getPermission(key)) return;
    let docs;
    try {
      docs = requests.liveDocuments().filter((doc) => doc.key === key);
    } catch {
      return;
    }
    (async () => {
      for (const doc of docs) await requests.sendEvent(doc, 'swarm', 'disconnect', { origin: key });
    })().catch(() => {});
  });
}

module.exports = {
  SWARM_READ_METHODS,
  SWARM_CONNECT_METHODS,
  SWARM_MESSAGING_METHODS,
  SWARM_PUBLISH_METHODS,
  SWARM_PAGE_METHODS,
  createSwarmDispatchers,
  registerSwarmPageEvents,
};
