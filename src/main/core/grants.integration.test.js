/**
 * The Swarm and Radicle permission files through the real freedom-cored
 * (freedom-core design 0012, APB-3): with `swarm` and `radicle` in the
 * hello's `grant_moved`, the core writes both files and main writes
 * neither. Main's stores (swarm/swarm-permissions.js,
 * radicle/radicle-permissions.js) send each change to the core's write
 * methods, a page's under `page` for its own key, the chrome's narrowing as
 * `chrome`, a manifest's projection as `shell`, and read the core's records
 * back (core/grants.js). The file stays in the reference's format, so an
 * older build reads the same grants (rollback, Q10). A page's SOC goes under
 * `page` with `{ swarm, soc }`, checked against the core's Swarm store. A
 * page's rule-answered Radicle write goes through main's provider, which
 * asks the core (`approval.radicle_write`, cored 0.16.0) to judge it and
 * count it in R-6.
 * Skipped unless FREEDOM_CORED_PATH points at a build, e.g.
 *   FREEDOM_CORED_PATH=…/freedom-cored-bin/linux-x64/freedom-cored npx jest src/main/core/grants.integration
 * or FREEDOM_CORED_APPROVALS_TEST=1 asks for the binary `npm run core:download`
 * fetched, which must then be there (CI's e2e-desktop job, on each OS).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const required = process.env.FREEDOM_CORED_APPROVALS_TEST === '1';
const binary = process.env.FREEDOM_CORED_PATH || (required ? require('./cored-binary').getCoredBinaryPath() : null);
if (required && !fs.existsSync(binary)) {
  throw new Error('FREEDOM_CORED_APPROVALS_TEST=1 needs freedom-cored: run npm run core:download');
}
const describeIfBinary = binary ? describe : describe.skip;
const quietLog = { info() {}, warn() {}, error() {} };
const ABANDON =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const SITE = 'https://app.example';
const RID = 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5';
const OTHER = 'https://other.example';
const OLD = 'https://old.example';
const page = (origin, overrides = {}) => ({
  origin,
  top_origin: origin,
  frame: 4,
  navigation: 9,
  agent: false,
  ...overrides,
});

// What an older build wrote before the move: the core takes it over as it is.
const OLD_SWARM = {
  [OLD]: {
    origin: OLD,
    connectedAt: 1700000000000,
    lastUsed: 1700000000000,
    autoApprove: { publish: true, feeds: false, signing: false, messaging: false },
  },
};
const OLD_RADICLE = {
  [OLD]: {
    origin: OLD,
    connectedAt: 1700000000000,
    lastUsed: 1700000000000,
    signing: true,
    autoApprove: { node: false, signing: true },
  },
};

/** The reference's reading of a file (the stores before APB-3): its text, parsed, by key. */
function referenceRead(file) {
  const text = fs.readFileSync(file, 'utf8');
  // Today's format, byte for byte: JSON.stringify(…, null, 2).
  expect(JSON.stringify(JSON.parse(text), null, 2)).toBe(text);
  return JSON.parse(text);
}

describeIfBinary('the Swarm and Radicle files with the real freedom-cored (APB-3)', () => {
  let root;
  let core;
  let calls;
  let swarm;
  let radicle;
  let vaultBackend;
  let fsSpies;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'grant-files-'));
    fs.writeFileSync(path.join(root, 'swarm-permissions.json'), JSON.stringify(OLD_SWARM, null, 2), { mode: 0o600 });
    fs.writeFileSync(path.join(root, 'radicle-permissions.json'), JSON.stringify(OLD_RADICLE, null, 2), {
      mode: 0o600,
    });
    const { CoreClient } = require('./core-client');
    core = new CoreClient({
      spawn,
      command: binary,
      args: ['serve', '--data-dir', path.join(root, 'identity'), '--lock-dir', path.join(root, 'locks')],
      log: quietLog,
      shellVersion: 'jest',
      grantRoot: root,
    });
    calls = [];
    const request = core.request.bind(core);
    core.request = (method, params, context, options) => {
      calls.push({ method, context, params });
      return request(method, params, context, options);
    };
    jest.resetModules();
    jest.doMock('./core-process', () => ({ getCoreClient: () => core }));
    jest.doMock('electron', () => ({ ipcMain: { handle() {}, removeHandler() {} } }));
    jest.doMock('../private/private-sender', () => ({ isPrivateSender: () => false }));
    // Main's Radicle provider (radicle-provider-ipc.js) over a running node
    // that can publish, and an add-on whose writes are counted, not made.
    jest.doMock('../logger', () => ({ info() {}, warn() {}, error() {}, debug() {} }));
    jest.doMock('../radicle-embedded', () => ({}));
    jest.doMock('../radicle-manager', () => ({
      getCurrentStatus: () => ({ status: 'running', error: null }),
      isDisabledForProfile: () => false,
      radicleWriteRefusal: () => null,
      STATUS: { STOPPED: 'stopped', STARTING: 'starting', RUNNING: 'running', ERROR: 'error' },
    }));
    jest.doMock('../radicle/cob-service', () => ({ commentIssue: jest.fn(async () => ({ id: 'b'.repeat(40) })) }));
    require('./grants').attachGrants(core);
    swarm = require('../swarm/swarm-permissions');
    radicle = require('../radicle/radicle-permissions');
    ({ vaultBackend } = require('./vault-backend'));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    await core.start();
    expect(await swarm.whenLoaded()).toBe(true);
    expect(await radicle.whenLoaded()).toBe(true);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    require('./grants').detachGrants();
    await core.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    calls.length = 0;
    // Main writes nothing in the grant root: every change is the core's.
    fsSpies = [
      'writeFileSync',
      'appendFileSync',
      'truncateSync',
      'copyFileSync',
      'renameSync',
      'unlinkSync',
      'rmSync',
      'openSync',
    ].map((method) => jest.spyOn(fs, method));
  });

  afterEach(() => {
    for (const spy of fsSpies) {
      for (const [file] of spy.mock.calls) {
        expect(path.resolve(String(file)).startsWith(root)).toBe(false);
      }
      spy.mockRestore();
    }
  });

  const writes = () =>
    calls
      .filter(({ method }) => ['approval.grant', 'approval.revoke', 'approval.touch'].includes(method))
      .map(({ method, context, params }) => [method, context.caller, params]);

  test("the hello moves both files (with APB-2's dApp file), and main reads the grants an older build left through the core", () => {
    expect([...core.service.helloParams(core).grant_moved].sort()).toEqual(['dapp', 'radicle', 'swarm']);
    expect(swarm.getPermission(OLD)).toEqual(OLD_SWARM[OLD]);
    expect(swarm.getAutoApprove(OLD, 'publish')).toBe(true);
    expect(radicle.getPermission(OLD)).toEqual(OLD_RADICLE[OLD]);
    expect(radicle.hasSigningGrant(OLD)).toBe(true);
  });

  test("a page's Swarm grants: written by the core under page, narrowed by the chrome; an older build reads the same file", async () => {
    await swarm.grantPermission(SITE, { page: page(SITE) });
    expect(await swarm.setAutoApprove(SITE, 'publish', true, { page: page(SITE) })).toBe(true);
    expect(await swarm.grantMessaging(SITE, { page: page(SITE) })).toBe(true);
    expect(await swarm.updateLastUsed(SITE, { page: page(SITE) })).toBe(true);
    expect(await swarm.setAutoApprove(SITE, 'messaging', true, { page: page(SITE) })).toBe(true);
    expect(await swarm.setAutoApprove(SITE, 'publish', false)).toBe(true);
    expect(await swarm.revokeMessaging(SITE)).toBe(true);
    expect(writes()).toEqual([
      ['approval.grant', 'page', { store: 'swarm', change: { op: 'connect' } }],
      ['approval.grant', 'page', { store: 'swarm', change: { op: 'flag', flag: 'publish' } }],
      ['approval.grant', 'page', { store: 'swarm', change: { op: 'messaging' } }],
      ['approval.touch', 'page', { store: 'swarm' }],
      ['approval.grant', 'page', { store: 'swarm', change: { op: 'flag', flag: 'messaging' } }],
      ['approval.revoke', 'chrome', { store: 'swarm', key: SITE, what: { flag: 'publish' } }],
      ['approval.revoke', 'chrome', { store: 'swarm', key: SITE, what: 'messaging' }],
    ]);
    // What main holds is what the core wrote, and what an older build reads.
    const file = referenceRead(path.join(root, 'swarm-permissions.json'));
    expect(Object.keys(file)).toEqual([OLD, SITE]);
    expect(file[SITE]).toEqual(swarm.getPermission(SITE));
    expect(file[SITE].autoApprove).toEqual({ publish: false, feeds: false, signing: false, messaging: false });
    expect(file[SITE].messaging).toBeUndefined();
    expect(file[OLD]).toEqual(OLD_SWARM[OLD]);
    expect(swarm.getAllPermissions()).toEqual(Object.values(file).sort((a, b) => b.lastUsed - a.lastUsed));
    // A page writes only its own key: refused before anything is sent.
    calls.length = 0;
    await expect(swarm.grantPermission(OTHER, { page: page(SITE) })).rejects.toThrow('only its own');
    expect(writes()).toEqual([]);
  });

  test("a manifest's projection is main's own (shell), naming the key", async () => {
    await swarm.grantPermission(OTHER, { source: 'manifest' });
    expect(await swarm.setAutoApprove(OTHER, 'feeds', true, { source: 'manifest' })).toBe(true);
    expect(writes()).toEqual([
      ['approval.grant', 'shell', { store: 'swarm', change: { op: 'connect', key: OTHER } }],
      ['approval.grant', 'shell', { store: 'swarm', change: { op: 'flag', flag: 'feeds', key: OTHER } }],
    ]);
    expect(referenceRead(path.join(root, 'swarm-permissions.json'))[OTHER].autoApprove.feeds).toBe(true);
    expect(await swarm.revokePermission(OTHER, { source: 'manifest' })).toBe(true);
    expect(referenceRead(path.join(root, 'swarm-permissions.json'))[OTHER]).toBeUndefined();
    expect(swarm.getPermission(OTHER)).toBeNull();
  });

  test("a page's Radicle grants: the core's, under page; a fresh last use asks nothing; the chrome narrows", async () => {
    await radicle.grantPermission(SITE, { page: page(SITE) });
    expect(await radicle.grantSigning(SITE, { page: page(SITE) })).toBe(true);
    expect(await radicle.setAutoApprove(SITE, 'signing', true, { page: page(SITE) })).toBe(true);
    // Used a moment ago (the connect): the core writes no fresher last use.
    expect(await radicle.updateLastUsed(SITE, { page: page(SITE) })).toBe(true);
    expect(await radicle.setAutoApprove(SITE, 'signing', false, { caller: 'chrome' })).toBe(true);
    expect(writes()).toEqual([
      ['approval.grant', 'page', { store: 'radicle', change: { op: 'connect' } }],
      ['approval.grant', 'page', { store: 'radicle', change: { op: 'signing' } }],
      ['approval.grant', 'page', { store: 'radicle', change: { op: 'flag', flag: 'signing' } }],
      ['approval.revoke', 'chrome', { store: 'radicle', key: SITE, what: { flag: 'signing' } }],
    ]);
    const file = referenceRead(path.join(root, 'radicle-permissions.json'));
    expect(file[SITE]).toEqual(radicle.getPermission(SITE));
    expect(file[SITE]).toMatchObject({ origin: SITE, signing: true, autoApprove: { node: false, signing: false } });
    // Radicle's grants come from a page only: main never asks as itself.
    await expect(radicle.grantPermission(OTHER)).rejects.toThrow('only from its prompt');
    await expect(
      vaultBackend.approval.grant({ store: 'radicle', change: { op: 'connect', key: OTHER } })
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(await radicle.revokePermission(SITE, { caller: 'chrome' })).toBe(true);
    expect(referenceRead(path.join(root, 'radicle-permissions.json'))[SITE]).toBeUndefined();
    expect(radicle.getPermission(SITE)).toBeNull();
  });

  // Design 0012, "A page's Radicle write" (cored 0.16.0): main's provider
  // asks the core last, under the page, for the page's own key; the core
  // judges the write with its own grant and counts a covered one in R-6 (a
  // burst of 5, one per 30 s), forgetting the count with each revoke.
  describe("a page's rule-answered Radicle write, judged and counted by the core (R-6)", () => {
    let provider;
    let cob;
    const radicleWrites = () =>
      calls.filter(({ method }) => method === 'approval.radicle_write').map(({ context, params }) => [context, params]);
    const write = (as, approval = 'auto') =>
      provider.executeRadicleMethod('radicle_commentIssue', { rid: RID, issueId: 'ab12cd', body: 'hi' }, as.origin, {
        approval,
        pageContext: () => as,
      });
    async function withRule(key) {
      await radicle.grantPermission(key, { page: page(key) });
      expect(await radicle.grantSigning(key, { page: page(key) })).toBe(true);
      expect(await radicle.setAutoApprove(key, 'signing', true, { page: page(key) })).toBe(true);
    }

    beforeAll(() => {
      provider = require('../radicle/radicle-provider-ipc');
      cob = require('../radicle/cob-service');
    });

    beforeEach(() => {
      cob.commentIssue.mockClear();
    });

    afterEach(async () => {
      for (const key of [SITE, OTHER]) if (radicle.getPermission(key)) await radicle.revokePermission(key);
    });

    test('five at once are covered and written; the sixth is refused auto_write_limit, unwritten; a revoke starts the count again', async () => {
      await withRule(SITE);
      for (let i = 0; i < 5; i += 1) await expect(write(page(SITE))).resolves.toEqual({ id: 'b'.repeat(40) });
      await expect(write(page(SITE))).rejects.toMatchObject({ code: 4100, data: { reason: 'auto_write_limit' } });
      expect(cob.commentIssue).toHaveBeenCalledTimes(5);
      // Each asked under the page, for its own key.
      expect(radicleWrites()).toEqual(Array(6).fill([{ caller: 'page', page: page(SITE) }, { key: SITE }]));
      // The user's approval goes on without the core's count.
      await expect(write(page(SITE), 'user')).resolves.toEqual({ id: 'b'.repeat(40) });
      expect(radicleWrites()).toHaveLength(6);
      // Another site has a count of its own.
      await withRule(OTHER);
      await expect(write(page(OTHER))).resolves.toEqual({ id: 'b'.repeat(40) });
      // The page's own disconnect revokes the grant, and the core forgets the
      // count: connected again with its rule, five more at once.
      await expect(provider.executeRadicleMethod('radicle_disconnect', {}, SITE, { pageContext: () => page(SITE) })).resolves.toEqual({
        connected: false,
      });
      expect(calls.filter(({ method }) => method === 'approval.revoke').at(-1)).toMatchObject({
        context: { caller: 'page' },
        params: { store: 'radicle', key: SITE, what: 'grant' },
      });
      await withRule(SITE);
      for (let i = 0; i < 5; i += 1) await expect(write(page(SITE))).resolves.toEqual({ id: 'b'.repeat(40) });
      await expect(write(page(SITE))).rejects.toMatchObject({ data: { reason: 'auto_write_limit' } });
      expect(cob.commentIssue).toHaveBeenCalledTimes(12);
    });

    test('a tab in custody, no rule, another key, or not a page: never covered', async () => {
      await withRule(SITE);
      // In custody (or custody not sent): the write isn't made.
      await expect(write(page(SITE, { agent: true }))).rejects.toMatchObject({ code: 4100, data: { reason: 'agent_custody' } });
      expect(await radicle.admitAutoWrite(SITE, { page: { ...page(SITE), agent: undefined } })).toEqual({ covered: false, reason: 'custody' });
      expect(cob.commentIssue).not.toHaveBeenCalled();
      // The rule turned off, as the core holds it.
      expect(await radicle.setAutoApprove(SITE, 'signing', false, { caller: 'chrome' })).toBe(true);
      expect(await radicle.admitAutoWrite(SITE, { page: page(SITE) })).toEqual({ covered: false, reason: 'no_rule' });
      // Another key than the page's own: refused by main before it asks, and
      // by the core.
      calls.length = 0;
      await expect(radicle.admitAutoWrite(OTHER, { page: page(SITE) })).rejects.toThrow('only its own');
      expect(radicleWrites()).toEqual([]);
      await expect(vaultBackend.approval.radicleWrite({ key: OTHER }, page(SITE))).rejects.toMatchObject({ code: 'forbidden' });
      // The chrome and main itself: the method table's refusal.
      await expect(vaultBackend.approval.radicleWrite({ key: SITE }, 'chrome')).rejects.toMatchObject({ code: 'forbidden' });
      await expect(vaultBackend.approval.radicleWrite({ key: SITE })).rejects.toMatchObject({ code: 'forbidden' });
    });
  });

  describe("a page's SOC, under page with its approval", () => {
    const KEY = { kind: 'bee_wallet' };
    const chunk = { identifier: Buffer.alloc(32, 7), payload: Buffer.from('chunk') };
    const signs = (options) => vaultBackend.sign.soc(KEY, chunk, options);
    const refusal = async (promise) => {
      try {
        await promise;
      } catch (err) {
        return { code: err.code, reason: err.data?.reason };
      }
      throw new Error('expected a refusal');
    };

    beforeAll(async () => {
      await vaultBackend.importVault('testpass1', ABANDON);
    });

    test('user signs for a connected site, and for no other; auto needs the rule and no custody; main\'s own as shell', async () => {
      const connected = page(SITE);
      await swarm.grantPermission(SITE, { page: connected });
      const user = (soc) => ({ page: connected, authorization: { swarm: 'user', soc } });
      expect((await signs(user('feed'))).signature).toMatch(/^0x[0-9a-f]{130}$/);
      expect((await signs(user('raw'))).signature).toMatch(/^0x[0-9a-f]{130}$/);
      // Another site has no grant.
      expect(await refusal(signs({ page: page(OTHER), authorization: { swarm: 'user', soc: 'raw' } }))).toEqual({
        code: 'not_authorized',
        reason: expect.any(String),
      });
      // `auto`: the request's flag, outside custody.
      const auto = (soc, context = connected) => ({ page: context, authorization: { swarm: 'auto', soc } });
      expect((await refusal(signs(auto('raw')))).code).toBe('not_authorized');
      expect(await swarm.setAutoApprove(SITE, 'signing', true, { page: connected })).toBe(true);
      expect((await signs(auto('raw'))).signature).toMatch(/^0x/);
      expect((await refusal(signs(auto('feed')))).code).toBe('not_authorized');
      expect((await refusal(signs(auto('raw', page(SITE, { agent: true }))))).code).toBe('not_authorized');
      // Revoked: nothing signs for it.
      expect(await swarm.revokePermission(SITE)).toBe(true);
      expect((await refusal(signs(user('raw')))).code).toBe('not_authorized');
      // Main's own SOC, with no page behind it.
      expect((await signs()).signature).toMatch(/^0x/);
      const socs = calls.filter(({ method }) => method === 'swarm.sign_soc');
      expect(socs.map(({ context }) => context.caller)).toEqual([
        'page',
        'page',
        'page',
        'page',
        'page',
        'page',
        'page',
        'page',
        'shell',
      ]);
    });
  });

  // cored 0.18.0 (APR-5b): every page method but `eip1193.request`, which
  // main doesn't send yet (APB-4), answers an empty PageContext.origin
  // `invalid_argument`, and the core serves on. A null origin is a protocol
  // error, after which the core exits: main refuses it before it is sent.
  test("an empty origin is the core's invalid_argument; a null one never leaves main; the core serves on", async () => {
    const generation = core.current;
    const theCores = { code: 'invalid_argument', message: "a page request needs its page's origin" };
    await expect(vaultBackend.approval.touch({ store: 'swarm' }, page(''))).rejects.toMatchObject(theCores);
    await expect(vaultBackend.approval.radicleWrite({ key: '' }, page(''))).rejects.toMatchObject(theCores);
    calls.length = 0;
    const mains = { code: 'invalid_argument', message: 'A page request needs its page’s context' };
    await expect(vaultBackend.approval.touch({ store: 'swarm' }, page(null))).rejects.toMatchObject(mains);
    await expect(vaultBackend.approval.radicleWrite({ key: SITE }, page(SITE, { top_origin: null }))).rejects.toMatchObject(mains);
    expect(calls).toEqual([]);
    await expect(vaultBackend.approval.touch({ store: 'swarm' }, page(SITE))).resolves.toBeDefined();
    expect(core.current).toBe(generation);
  });
});
