/**
 * SWM-7's flip (freedom-core design 0015, SWM-7; the SWM-6 to SWM-9 plan's
 * PR 7.4): page-swarm.js's default deps pick window.swarm's backend by the
 * process's Swarm backend (swarm/swarm-backend-kind.js, read once):
 *
 * - on `core`, page-swarm-core.js's `swarmCoreDependencies()`: every
 *   method's backend call goes there with the request (`{ context,
 *   approval }`), and a document's subscriptions end there; the JS
 *   provider is never reached;
 * - on `js`, the JS provider's: `executeSwarmMethod` with exactly its four
 *   arguments, and its own ends of a document's subscriptions; the core's
 *   deps are never made;
 * - picked once per dispatcher set, at its first use, from the switch as
 *   it was latched, never read again.
 *
 * The dispatcher's checks, prompts and grant writes are the same on both
 * (injected here); the core's path end to end is
 * page-swarm-flip.integration.test.js's, against the real freedom-cored.
 */

const mockKind = jest.fn(() => 'js');
jest.mock('../swarm/swarm-backend-kind', () => ({ swarmBackendKind: () => mockKind() }));
const mockSpi = {
  executeSwarmMethod: jest.fn(async () => ({ result: { from: 'js' } })),
  endDocumentSubscriptions: jest.fn(),
  endDocumentSubscription: jest.fn(),
};
jest.mock('../swarm/swarm-provider-ipc', () => mockSpi);
const mockCore = {
  execute: jest.fn(async () => ({ result: { from: 'core' } })),
  endDocumentSubscriptions: jest.fn(),
  endDocumentSubscription: jest.fn(),
};
const mockSwarmCoreDependencies = jest.fn(() => mockCore);
jest.mock('./page-swarm-core', () => ({ swarmCoreDependencies: (...args) => mockSwarmCoreDependencies(...args) }));

const { createSwarmDispatchers } = require('./page-swarm');

const KEY = 'https://app.example';
const REF = 'a1'.repeat(32);

beforeEach(() => {
  jest.clearAllMocks();
  mockKind.mockImplementation(() => 'js');
});

/**
 * The dispatchers with every dep but the backend's injected: a connected
 * site with the messaging grant, no manifest, the name holding while
 * `world.holds`.
 */
function dispatchers(world) {
  return createSwarmDispatchers({
    identityWalletEnabled: () => true,
    grantsLoaded: async () => true,
    getPermission: () => ({ autoApprove: { publish: false, feeds: false, signing: false, messaging: false } }),
    grantPermission: async () => {},
    updateLastUsed: async () => {},
    hasMessagingGrant: () => true,
    grantMessaging: async () => {},
    getAutoApprove: () => false,
    setAutoApprove: async () => {},
    lockOrigin: (_key, task) => task(),
    checkManifest: async () => ({ kind: 'legacy' }),
    decideManifest: async () => ({ allowed: true }),
    releaseManifest: () => {},
    guestContents: () => ({ isDestroyed: () => false }),
    inCustody: () => false,
    isVaultUnlocked: async () => true,
    hasFeedGrant: () => true,
    routeToSetup: () => {},
    ...(world.deps || {}),
  });
}

/** A page's request context, as page-requests.js hands a dispatcher one. */
function contextOf(world, method, params) {
  return {
    requester: { key: KEY, topKey: KEY, transportKey: KEY, guest: 1, window: 1, navigation: 1, url: `${KEY}/` },
    method,
    params,
    signal: new AbortController().signal,
    isCurrent: () => true,
    nameHolds: async () => world.holds,
    holdsKey: () => world.holds,
    keylessOnceUnheld: () => {},
    pageContext: () => ({ origin: KEY, top_origin: KEY, frame: 1, navigation: 1, agent: false }),
    prompt: async () => ({ approve: true, choices: {} }),
    sendEvent: async () => ({ ok: true }),
    liveDocuments: () => [],
    afterAnswer: () => {},
    onDocumentEnded: (fn) => world.ended.push(fn),
  };
}

describe("on the core's backend", () => {
  beforeEach(() => mockKind.mockImplementation(() => 'core'));

  test("every backend call is page-swarm-core.js's, with the request; the JS provider is never reached", async () => {
    const world = { holds: true, ended: [] };
    const set = dispatchers(world);
    const read = contextOf(world, 'swarm_readChunk', { reference: REF });
    expect(await set['swarm:swarm_readChunk'](read)).toEqual({ result: { from: 'core' } });
    expect(mockCore.execute).toHaveBeenCalledTimes(1);
    expect(mockCore.execute).toHaveBeenCalledWith('swarm_readChunk', { reference: REF }, KEY, undefined, {
      context: read,
      approval: null,
    });
    const listed = contextOf(world, 'swarm_listFeeds', {});
    expect(await set['swarm:swarm_listFeeds'](listed)).toEqual({ result: { from: 'core' } });
    expect(mockCore.execute).toHaveBeenCalledTimes(2);
    expect(mockSpi.executeSwarmMethod).not.toHaveBeenCalled();
    // Picked once, from the latched switch, with no deps of the test's.
    expect(mockSwarmCoreDependencies).toHaveBeenCalledTimes(1);
    expect(mockSwarmCoreDependencies).toHaveBeenCalledWith();
    expect(mockKind).toHaveBeenCalledTimes(1);
  });

  test("a document's subscriptions end through the core's deps", async () => {
    const world = { holds: true, ended: [] };
    const set = dispatchers(world);
    mockCore.execute.mockResolvedValueOnce({ result: { subscriptionId: 'sub-1', kind: 'pss', key: 'c3'.repeat(32) } });
    const subscribe = contextOf(world, 'swarm_subscribe', { kind: 'pss', topic: 'chat' });
    expect(await set['swarm:swarm_subscribe'](subscribe)).toEqual({
      result: { subscriptionId: 'sub-1', kind: 'pss', key: 'c3'.repeat(32) },
    });
    // The subscription's request went to the core with the document and
    // its delivery.
    const [, , , meta] = mockCore.execute.mock.calls.at(-1);
    expect(meta.page.document).toBe('1:1');
    expect(typeof meta.page.deliverTo).toBe('function');
    // The document goes: its subscriptions with it.
    expect(world.ended).toHaveLength(1);
    world.ended[0]();
    expect(mockCore.endDocumentSubscriptions).toHaveBeenCalledWith('1:1');
    // A subscription whose name moved during its wait ends at once.
    mockCore.execute.mockImplementationOnce(async () => {
      world.holds = false;
      return { result: { subscriptionId: 'sub-2', kind: 'pss', key: 'c3'.repeat(32) } };
    });
    const moved = contextOf(world, 'swarm_subscribe', { kind: 'pss', topic: 'chat' });
    expect((await set['swarm:swarm_subscribe'](moved)).error).toMatchObject({ code: 4100 });
    expect(mockCore.endDocumentSubscription).toHaveBeenCalledWith('1:1', 'sub-2');
    expect(mockSpi.endDocumentSubscriptions).not.toHaveBeenCalled();
    expect(mockSpi.endDocumentSubscription).not.toHaveBeenCalled();
    expect(mockSpi.executeSwarmMethod).not.toHaveBeenCalled();
  });

  test('a test may still inject its own backend', async () => {
    const world = { holds: true, ended: [] };
    const execute = jest.fn(async () => ({ result: 'injected' }));
    const set = dispatchers({ ...world, deps: { execute } });
    expect(await set['swarm:swarm_readChunk'](contextOf(world, 'swarm_readChunk', { reference: REF }))).toEqual({
      result: 'injected',
    });
    expect(mockCore.execute).not.toHaveBeenCalled();
    expect(mockSwarmCoreDependencies).not.toHaveBeenCalled();
  });
});

describe('on the JS backend', () => {
  test("every backend call is the JS provider's, with exactly its four arguments", async () => {
    const world = { holds: true, ended: [] };
    const set = dispatchers(world);
    expect(await set['swarm:swarm_readChunk'](contextOf(world, 'swarm_readChunk', { reference: REF }))).toEqual({
      result: { from: 'js' },
    });
    expect(mockSpi.executeSwarmMethod.mock.calls).toEqual([['swarm_readChunk', { reference: REF }, KEY, undefined]]);
    mockSpi.executeSwarmMethod.mockResolvedValueOnce({ result: { subscriptionId: 'sub-1' } });
    await set['swarm:swarm_subscribe'](contextOf(world, 'swarm_subscribe', { kind: 'pss', topic: 'chat' }));
    expect(mockSpi.executeSwarmMethod.mock.calls.at(-1)).toHaveLength(4);
    world.ended[0]();
    expect(mockSpi.endDocumentSubscriptions).toHaveBeenCalledWith('1:1');
    expect(mockSwarmCoreDependencies).not.toHaveBeenCalled();
    expect(mockCore.execute).not.toHaveBeenCalled();
    expect(mockKind).toHaveBeenCalledTimes(1);
  });

  test('nothing is picked, and the switch not read, before the first backend call', () => {
    dispatchers({ holds: true, ended: [] });
    expect(mockKind).not.toHaveBeenCalled();
    expect(mockSwarmCoreDependencies).not.toHaveBeenCalled();
  });
});
