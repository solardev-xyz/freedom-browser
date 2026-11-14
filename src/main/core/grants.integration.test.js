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
 * `page` with `{ swarm, soc }`, checked against the core's Swarm store.
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
});
