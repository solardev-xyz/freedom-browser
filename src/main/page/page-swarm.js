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
 * PRQ-7a moves the methods that need neither a prompt nor the permission
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
 * Every method answers `4900` while the Identity & Wallet switch is off, as
 * the chrome did. The chrome's own path (`swarm:provider-execute`) refuses
 * the moved methods: the preload no longer sends them there, and a chrome
 * that names a site for them asks for something only a page may.
 *
 * Later parts of PRQ-7 move connecting, messaging (subscriptions bound to
 * their document), publishing and feeds, with their prompts.
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

/** Every method main's Swarm dispatcher serves, and so the preload routes to main. */
const SWARM_PAGE_METHODS = Object.freeze([...SWARM_READ_METHODS]);

// The permission-free ones: the key is a rate, never authority.
const PERMISSION_FREE = new Set(['swarm_readChunk', 'swarm_readData', 'swarm_readSingleOwnerChunk']);

// A method whose only use of the key comes before any wait: the answer is
// checked against the key in the same run as it goes out, with nothing to
// resolve again.
const NO_WAIT = new Set(['swarm_listFeeds']);

// The chrome's answer while the Identity & Wallet switch is off.
const DISCONNECTED = Object.freeze({ code: 4900, message: 'Swarm provider is not available' });
// A keyless document's answer to a method that uses the key, as the chrome
// refused a keyless page's site methods (design 0011, "Keys").
const NO_ADDRESS = Object.freeze({
  code: 4100,
  message: 'This page has no address to connect from yet',
  data: Object.freeze({ reason: 'no_address' }),
});
// The key a keyless document's permission-free reads are rated on.
const KEYLESS_BUCKET = '';

const error = (base) => ({ error: { ...base, ...(base.data ? { data: { ...base.data } } : {}) } });

function defaultDependencies() {
  return {
    identityWalletEnabled: () => require('../settings-store').loadSettings()?.enableIdentityWallet === true,
    execute: (method, params, key) => require('../swarm/swarm-provider-ipc').executeSwarmMethod(method, params, key),
  };
}

/**
 * @param {object} [deps] injected for tests; each defaults to main's own.
 * @returns {Record<string, (context: object) => Promise<object>>} the
 *   dispatchers, keyed `swarm:<method>`, for `createPageRequests`.
 */
function createSwarmDispatchers(deps = {}) {
  const { identityWalletEnabled, execute } = { ...defaultDependencies(), ...deps };

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

  const serve = (answer) => async (context) => {
    if (!identityWalletEnabled()) return error(DISCONNECTED);
    return answer(context);
  };

  const dispatchers = {};
  for (const method of SWARM_PAGE_METHODS) {
    dispatchers[`swarm:${method}`] = serve(PERMISSION_FREE.has(method) ? permissionFree : underKey);
  }
  return dispatchers;
}

module.exports = {
  SWARM_READ_METHODS,
  SWARM_PAGE_METHODS,
  createSwarmDispatchers,
};
