/**
 * An allowed manifest decide on the core's store, then the connection
 * (freedom-core design 0015, D6; design 0012's amendment: the manifest's
 * projection is written inside the core). The core writes the site's
 * connection inside its `swarm.manifest` decide and tells main a moment
 * later (`approval.changed`), so main's grant mirror (core/grants.js) lags
 * the decide's answer. page-swarm.js's requestAccess reads the grant right
 * after the consent: decidePageManifest resolves only once main's mirror
 * has read the site's grant back, so the user is never asked to connect a
 * second time, and a mirror that doesn't catch up fails the request closed,
 * with no second prompt and no grant assumed.
 *
 * The scripted core here answers the decide and holds the grant reads; on
 * the real core, the window.swarm contract suite's
 * `request-access-manifest-allow` and `request-access-manifest-individual`
 * (page-swarm.contract.test.js, FREEDOM_SWARM_CONTRACT_BACKEND=core) play
 * the same consent.
 */

jest.mock('electron', () => ({
  app: { getPath: () => require('os').tmpdir() },
  ipcMain: { handle: () => {}, removeHandler: () => {} },
  webContents: { fromId: () => null },
}));
jest.mock('electron-log', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../identity-manager', () => ({
  getBeeWalletAddress: async () => null,
  getPublisherAddress: async () => null,
  getDerivedWallets: async () => [],
}));
jest.mock('./bzz-protocol', () => ({ handleBzzRequest: jest.fn() }));
// The hello names `swarm_stores` (no build does before SWM-7's flip): the
// manifest store is the core's.
jest.mock('../core/core-client', () => ({
  ...jest.requireActual('../core/core-client'),
  swarmStoresNamed: () => true,
}));
const mockCore = { client: null };
jest.mock('../core/core-process', () => ({ getCoreClient: () => mockCore.client }));

const { useSimulatedGrantCore, attachedCoreClient } = require('../../../test/helpers/simulated-grant-core');
const { readPlain, writeTyped } = require('../core/swarm-typed');
const { createSwarmDispatchers } = require('../page/page-swarm');

for (const method of ['log', 'warn', 'error']) jest.spyOn(console, method).mockImplementation(() => {});

const SITE = 'https://app.example';
const TOKEN = 'consent-1';

let grants;
let events;

/**
 * The core's `swarm.manifest decide`: an allowed outcome writes the site's
 * connection into the grant store, then `approval.changed`, then the
 * answer; `onDecided` runs as it answers.
 */
function scriptedCore({ onDecided = () => {} } = {}) {
  const decides = [];
  return {
    decides,
    async request(method, params) {
      if (method !== 'swarm.manifest' || params.op !== 'decide') throw new Error(`no ${method} here`);
      const outcome = readPlain(params.outcome);
      const key = readPlain(params.key);
      decides.push({ key, outcome, live: readPlain(params.live) });
      const allowed = outcome !== 'deny';
      if (allowed) {
        await grants.grant({ store: 'swarm', change: { op: 'connect', key } }, null);
        events.changed('swarm', key);
      }
      onDecided();
      return { result_typed: writeTyped({ allowed, mode: outcome }) };
    },
  };
}

/** requestAccess as page-requests.js calls it, its consent the check's: each prompt it shows, and its answer. */
async function requestAccess({ outcome = 'allow' } = {}) {
  const prompts = [];
  const dispatchers = createSwarmDispatchers({
    identityWalletEnabled: () => true,
    checkManifest: async () => ({ kind: 'consent', token: TOKEN, model: { origin: SITE, name: 'Notes', changed: [] } }),
    releaseManifest: () => {},
    execute: async () => ({ result: { connected: true, origin: SITE } }),
    guestContents: () => ({ isDestroyed: () => false }),
    inCustody: () => false,
  });
  const requester = Object.freeze({
    guest: 1,
    window: 1,
    frame: 1,
    navigation: 1,
    url: `${SITE}/`,
    key: SITE,
    transportKey: SITE,
    topKey: SITE,
  });
  const context = {
    id: 1,
    requester,
    provider: 'swarm',
    method: 'swarm_requestAccess',
    params: {},
    isCurrent: () => true,
    nameHolds: async () => true,
    keylessOnceUnheld: () => {},
    holdsKey: () => true,
    prompt: async (spec) => {
      prompts.push(spec.kind);
      if (spec.kind === 'swarm.manifest') return { approve: outcome !== 'deny', choices: { outcome } };
      return { approve: true, choices: {} };
    },
    pageContext: () => ({ origin: SITE, top_origin: SITE, frame: 1, navigation: 1, agent: false }),
    signal: new AbortController().signal,
    afterAnswer: () => {},
    liveDocuments: () => [requester],
    sendEvent: async () => ({ ok: true }),
    onDocumentEnded: () => () => {},
    copied: () => {},
  };
  const answer = await dispatchers['swarm:swarm_requestAccess'](context);
  return { prompts, answer };
}

/** The grant writes main made itself (a page's connect, after a second prompt). */
const mainWrites = (core) => core.calls.filter((call) => call.method === 'approval.grant' && call.caller !== 'shell');

beforeEach(async () => {
  grants = await useSimulatedGrantCore();
  events = attachedCoreClient();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("an allowed manifest decide on the core's store waits for main's mirror", () => {
  test.each(['allow', 'individual'])(
    'outcome %s: the mirror reads the grant back later, and no second swarm.connect prompt shows',
    async (outcome) => {
      // The mirror lags: every read of the key is held until 20 ms after
      // the decide has answered.
      const reads = grants.holdKeyReads();
      mockCore.client = scriptedCore({ onDecided: () => setTimeout(() => reads.release(), 20) });
      const { prompts, answer } = await requestAccess({ outcome });
      expect(prompts).toEqual(['swarm.manifest']);
      expect(answer).toEqual({ result: { connected: true, origin: SITE } });
      expect(mockCore.client.decides).toEqual([{ key: SITE, outcome, live: true }]);
      expect(mainWrites(grants)).toEqual([]);
    }
  );

  test('a read back that fails answers an error: no second prompt, no grant written', async () => {
    const read = grants.grants.bind(grants);
    grants.grants = async (params) => {
      if (params.key !== undefined) throw Object.assign(new Error('the store is unreadable'), { code: 'storage' });
      return read(params);
    };
    mockCore.client = scriptedCore();
    const { prompts, answer } = await requestAccess();
    expect(prompts).toEqual(['swarm.manifest']);
    expect(answer.error).toBeDefined();
    expect(answer.error.code).toBe(-32603);
    expect(mainWrites(grants)).toEqual([]);
  });

  test('a mirror that never catches up fails closed after a grant read watchdog', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    grants.holdKeyReads();
    mockCore.client = scriptedCore();
    const pending = requestAccess();
    await jest.advanceTimersByTimeAsync(14_999);
    let done = false;
    pending.then(() => {
      done = true;
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    const { prompts, answer } = await pending;
    expect(prompts).toEqual(['swarm.manifest']);
    expect(answer.error.code).toBe(-32603);
    expect(mainWrites(grants)).toEqual([]);
  });

  test('a denied decide waits for nothing and asks nothing more', async () => {
    const reads = grants.holdKeyReads();
    mockCore.client = scriptedCore();
    const { prompts, answer } = await requestAccess({ outcome: 'deny' });
    expect(prompts).toEqual(['swarm.manifest']);
    expect(answer.error.code).toBe(4001);
    expect(reads.count).toBe(0);
  });
});
