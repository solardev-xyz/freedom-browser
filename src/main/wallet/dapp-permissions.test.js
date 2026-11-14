/**
 * dapp-permissions.js once `dapp-permissions.json` has moved to the identity
 * core (freedom-core design 0012, APB-2): every write goes to the core's
 * write methods (simulated here, test/helpers/simulated-approvals.js; the
 * real core in signing-confirmation.integration.test.js), main writes the
 * file nowhere (a spy on `fs`), and main's copy of the store follows the
 * core's answers and events.
 */
const fs = require('fs');
const { EventEmitter } = require('events');

// Mock electron with IPC capture
const ipcHandlers = {};
jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => '/nonexistent') },
  ipcMain: {
    handle: (channel, handler) => {
      ipcHandlers[channel] = handler;
    },
    removeHandler: () => {},
  },
}));

// The identity core's dApp store and its write methods, simulated.
const mockApprovals = require('../../../test/helpers/simulated-approvals').simulatedApprovals();
jest.mock('../core/vault-backend', () => ({ vaultBackend: { approval: mockApprovals.approval } }));

const {
  getPermission,
  grantPermission,
  revokePermission,
  revokePermissionsForWalletIndex,
  getAllPermissions,
  removeTransactionAutoApprove,
  getSigningAutoApprove,
  setSigningAutoApprove,
  updateLastUsed,
  updateWalletIndex,
  onGrantChanged,
  attachCore,
  whenLoaded,
  refreshPermissions,
  registerDappPermissionsIpc,
  _resetCache,
} = require('./dapp-permissions');
const sharedOriginUtils = require('../../shared/origin-utils');

const SITE = 'https://app.example';
const TOKEN = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const APPROVE = '0x095ea7b3';
// A page's PageContext (design 0012), for its own key.
const pageFor = (key, extra = {}) => ({
  origin: sharedOriginUtils.normalizeOrigin(key),
  top_origin: sharedOriginUtils.normalizeOrigin(key),
  frame: 1,
  navigation: 1,
  agent: false,
  ...extra,
});
const grant = (key, walletIndex = 0, chainId = 1) => grantPermission(key, walletIndex, chainId, pageFor(key));
const storage = (applied) =>
  Object.assign(new Error('The permission file could not be written'), { code: 'storage', data: { store: 'dapp', applied } });

let logs;
beforeEach(() => {
  _resetCache();
  mockApprovals.reset();
  logs = {
    log: jest.spyOn(console, 'log').mockImplementation(() => {}),
    warn: jest.spyOn(console, 'warn').mockImplementation(() => {}),
    error: jest.spyOn(console, 'error').mockImplementation(() => {}),
  };
});

afterEach(() => {
  jest.restoreAllMocks();
});

const writes = () =>
  mockApprovals.calls.filter((call) =>
    ['approval.grant', 'approval.revoke', 'approval.touch', 'approval.forget_account'].includes(call.method)
  );
const lastWrite = () => writes().at(-1);

describe('dapp-permissions — origin normalization consistency', () => {
  // Each row: [input, expectedNormalizedKey], as getPermissionKey maps them.
  const cases = [
    ['https://app.example.com', 'https://app.example.com'],
    ['https://app.example.com/path/to/page', 'https://app.example.com'],
    ['http://localhost:1234/foo', 'http://localhost:1234'],
    ['vitalik.eth', 'vitalik.eth'],
    ['vitalik.eth/blog', 'vitalik.eth'],
    ['ens://vitalik.eth', 'vitalik.eth'],
    ['ens://vitalik.eth/#/path', 'vitalik.eth'],
    ['VITALIK.ETH', 'vitalik.eth'],
    ['mysite.box', 'mysite.box'],
    ['bzz://abc123def/page/index.html', 'bzz://abc123def'],
    ['ipfs://QmHash/docs', 'ipfs://QmHash'],
    ['ipns://host/guide', 'ipns://host'],
    ['rad://z123abc/tree', 'rad://z123abc'],
    [
      'web3://0x00000095643cffa7d9fae407a84dfcb6406456c6:100/swap',
      'web3://0x00000095643cffa7d9fae407a84dfcb6406456c6:100',
    ],
  ];

  test.each(cases)('%s reads as %s', async (input, expected) => {
    expect(sharedOriginUtils.normalizeOrigin(input)).toBe(expected);
    await grant(input);
    expect(getPermission(input)?.origin).toBe(expected);
    expect(getPermission(expected)?.origin).toBe(expected);
  });

  test('ENS forms that used to diverge resolve to the same record', async () => {
    await grant('vitalik.eth', 2, 1);
    for (const form of ['vitalik.eth', 'ens://vitalik.eth', 'VITALIK.ETH', 'vitalik.eth/blog']) {
      expect(getPermission(form)?.walletIndex).toBe(2);
    }
  });
});

describe('dapp-permissions — every write goes to the identity core (APB-2)', () => {
  test('a connect is written by the core under the page, for its own key, and read back', async () => {
    const written = await grant(SITE, 3, 100);
    expect(written).toMatchObject({ origin: SITE, walletIndex: 3, chainId: 100 });
    expect(lastWrite()).toEqual({
      method: 'approval.grant',
      params: { store: 'dapp', change: { op: 'connect', account: 3, chain_id: 100 } },
      page: pageFor(SITE),
    });
    expect(getPermission(SITE)).toEqual(mockApprovals.dapp.entry(SITE));
    expect(getAllPermissions()).toEqual([mockApprovals.dapp.entry(SITE)]);
  });

  test("a page's write for another key than its own is refused before the core is asked", async () => {
    await expect(grantPermission(SITE, 0, 1, pageFor('https://other.example'))).rejects.toThrow(/own page/);
    await expect(grantPermission(SITE, 0, 1, null)).rejects.toThrow(/own page/);
    await expect(updateWalletIndex(SITE, 0, pageFor('https://other.example'))).rejects.toThrow(/own page/);
    expect(await setSigningAutoApprove(SITE, true, null)).toBe(false);
    expect(await updateLastUsed(SITE, 1, null)).toBe(false);
    expect(writes()).toEqual([]);
  });

  test('the account, the last use and the chain: under the page', async () => {
    await grant(SITE, 0, 1);
    expect(await updateWalletIndex(SITE, 4, pageFor(SITE))).toBe(true);
    expect(getPermission(SITE).walletIndex).toBe(4);
    expect(await updateLastUsed(SITE, 10, pageFor(SITE))).toBe(true);
    expect(mockApprovals.calls.slice(-2).map(({ method, params, page }) => ({ method, params, page }))).toEqual([
      { method: 'approval.grant', params: { store: 'dapp', change: { op: 'account', account: 4 } }, page: pageFor(SITE) },
      { method: 'approval.touch', params: { store: 'dapp', chain_id: 10 }, page: pageFor(SITE) },
    ]);
    expect(mockApprovals.dapp.entry(SITE).chainId).toBe(10);
  });

  test('"Always allow" for signing is Q9\'s limited rule, written under the page; turning it off is the chrome\'s', async () => {
    await grant(SITE);
    expect(await setSigningAutoApprove(SITE, true, pageFor(SITE))).toBe(true);
    expect(lastWrite()).toMatchObject({
      method: 'approval.grant',
      params: { store: 'dapp', change: { op: 'signing' } },
      page: pageFor(SITE),
    });
    expect(mockApprovals.dapp.entry(SITE).autoApprove).toEqual({
      signing: false,
      transactions: [],
      limited: { signing: { grantedAt: expect.any(Number) }, transactions: [] },
    });
    expect(await setSigningAutoApprove(SITE, false)).toBe(true);
    expect(lastWrite()).toEqual({
      method: 'approval.revoke',
      params: { store: 'dapp', key: SITE, what: 'signing' },
      page: 'chrome',
    });
    expect(mockApprovals.dapp.entry(SITE).autoApprove.limited.signing).toBeNull();
  });

  // The core answers `{ grant: null }` when the key holds no grant (removed
  // behind main's copy): nothing was written, so the change fails, as a
  // connect not recorded does, and main's copy drops the stale grant.
  test('an account change the core answers with no grant rejects, and main\'s copy drops the grant', async () => {
    await grant(SITE, 0, 1);
    mockApprovals.dapp.entries.delete(SITE);
    await expect(updateWalletIndex(SITE, 4, pageFor(SITE))).rejects.toThrow('The account change was not recorded');
    expect(lastWrite()).toEqual({
      method: 'approval.grant',
      params: { store: 'dapp', change: { op: 'account', account: 4 } },
      page: pageFor(SITE),
    });
    expect(getPermission(SITE)).toBeNull();
    expect(logs.error).toHaveBeenCalledWith(expect.stringContaining('the core holds no grant'));
    // A reply with nothing in it is no write either.
    await grant(SITE, 0, 1);
    jest.spyOn(mockApprovals.approval, 'grant').mockResolvedValueOnce({});
    await expect(updateWalletIndex(SITE, 4, pageFor(SITE))).rejects.toThrow('The account change was not recorded');
  });

  test('a contract rule is removed by its call, today\'s and the limited one, as the chrome\'s', async () => {
    await grant(SITE);
    mockApprovals.dapp.entries.get(SITE).autoApprove.transactions.push({ to: TOKEN, selector: APPROVE, chainId: 100, maxValue: '0' });
    expect(await removeTransactionAutoApprove(SITE, TOKEN.toUpperCase().replace('0X', '0x'), APPROVE, 100)).toBe(true);
    expect(lastWrite()).toEqual({
      method: 'approval.revoke',
      params: { store: 'dapp', key: SITE, what: { transaction: { to: TOKEN, selector: APPROVE, chain_id: 100 } } },
      page: 'chrome',
    });
    expect(await removeTransactionAutoApprove(SITE, TOKEN, APPROVE, 100)).toBe(false);
  });

  test('a revoke is the chrome\'s and an account deleted main\'s own, and each leaves main\'s copy as the core holds it', async () => {
    await grant(SITE, 2);
    await grant('https://keep.example', 0);
    await grant('https://also.example', 2);
    expect((await revokePermissionsForWalletIndex(2)).sort()).toEqual(['https://also.example', SITE]);
    expect(lastWrite()).toEqual({ method: 'approval.forget_account', params: { wallet_index: 2 }, page: null });
    expect(getPermission(SITE)).toBeNull();
    expect(getPermission('https://keep.example')).not.toBeNull();
    expect(await revokePermission('https://keep.example')).toBe(true);
    expect(lastWrite()).toEqual({
      method: 'approval.revoke',
      params: { store: 'dapp', key: 'https://keep.example', what: 'grant' },
      page: 'chrome',
    });
    expect(getPermission('https://keep.example')).toBeNull();
    expect(await revokePermission('https://keep.example')).toBe(false);
    expect(await revokePermissionsForWalletIndex(9)).toEqual([]);
  });

  test('main writes dapp-permissions.json nowhere: a spy on fs', async () => {
    const spies = [
      'writeFileSync',
      'appendFileSync',
      'renameSync',
      'copyFileSync',
      'truncateSync',
      'unlinkSync',
      'rmSync',
      'openSync',
      'writeFile',
      'rename',
      'open',
    ].map((name) => jest.spyOn(fs, name));
    const promises = ['writeFile', 'rename', 'open', 'appendFile', 'copyFile', 'rm', 'unlink'].map((name) =>
      jest.spyOn(fs.promises, name)
    );
    registerDappPermissionsIpc();
    await grant(SITE);
    await updateWalletIndex(SITE, 1, pageFor(SITE));
    await updateLastUsed(SITE, 10, pageFor(SITE));
    await setSigningAutoApprove(SITE, true, pageFor(SITE));
    await setSigningAutoApprove(SITE, false);
    await removeTransactionAutoApprove(SITE, TOKEN, APPROVE, 100);
    await ipcHandlers['dapp:revoke-permission']({}, SITE);
    await grant(SITE, 1);
    await revokePermissionsForWalletIndex(1);
    await refreshPermissions();
    for (const spy of [...spies, ...promises]) {
      for (const [file] of spy.mock.calls) expect(String(file)).not.toMatch(/dapp-permissions\.json/);
    }
    expect(writes().map((call) => call.method)).toEqual([
      'approval.grant',
      'approval.grant',
      'approval.touch',
      'approval.grant',
      'approval.revoke',
      'approval.revoke',
      'approval.revoke',
      'approval.grant',
      'approval.forget_account',
    ]);
  });
});

describe("dapp-permissions — a failed write, as the core reports it (design 0012, \"A failed write\")", () => {
  test('a widening that failed is not applied: the connect rejects, and main\'s copy has no grant', async () => {
    jest.spyOn(mockApprovals.approval, 'grant').mockRejectedValueOnce(storage(false));
    await expect(grant(SITE)).rejects.toMatchObject({ code: 'storage' });
    expect(getPermission(SITE)).toBeNull();
    expect(logs.error).toHaveBeenCalledWith(expect.stringContaining('Failed to save permissions'), expect.anything());
    // A rule that failed: not on.
    await grant(SITE);
    jest.spyOn(mockApprovals.approval, 'grant').mockRejectedValueOnce(storage(false));
    expect(await setSigningAutoApprove(SITE, true, pageFor(SITE))).toBe(false);
  });

  test('a narrowing that failed stands, not saved: the revoke holds in main\'s copy, logged as unsaved', async () => {
    await grant(SITE);
    jest.spyOn(mockApprovals.approval, 'revoke').mockRejectedValueOnce(storage(true));
    expect(await revokePermission(SITE)).toBe(true);
    expect(getPermission(SITE)).toBeNull();
    expect(logs.error).toHaveBeenCalledWith(expect.stringContaining("couldn't be saved"));
    await grant(SITE);
    jest.spyOn(mockApprovals.approval, 'revoke').mockRejectedValueOnce(storage(true));
    expect(await setSigningAutoApprove(SITE, false)).toBe(true);
  });

  test('a core that answers nothing changes nothing in main\'s copy', async () => {
    await grant(SITE);
    jest
      .spyOn(mockApprovals.approval, 'revoke')
      .mockRejectedValueOnce(Object.assign(new Error('core is not running'), { code: 'core_unavailable' }));
    expect(await revokePermission(SITE)).toBe(false);
    expect(getPermission(SITE)).not.toBeNull();
  });

  test('applied but not durable (`durable: false`) is warned about, and stands', async () => {
    const original = mockApprovals.approval.grant;
    jest.spyOn(mockApprovals.approval, 'grant').mockImplementationOnce(async (...args) => ({
      ...(await original(...args)),
      durable: false,
    }));
    await grant(SITE);
    expect(getPermission(SITE)).not.toBeNull();
    expect(logs.warn).toHaveBeenCalledWith(expect.stringContaining('may not survive a power loss'));
  });
});

describe('dapp-permissions — main\'s copy follows the core', () => {
  const coreClient = () => Object.assign(new EventEmitter(), { request: jest.fn() });

  test('read whole at each handshake: a page\'s request waits for the first', async () => {
    mockApprovals.dapp.seed(SITE, { origin: SITE, connectedAt: 1, lastUsed: 1, walletIndex: 0, chainId: 1, autoApprove: { signing: false, transactions: [] } });
    const client = coreClient();
    attachCore(client);
    let loaded = false;
    const waiting = whenLoaded().then(() => {
      loaded = true;
    });
    await Promise.resolve();
    expect(loaded).toBe(false);
    expect(getPermission(SITE)).toBeNull();
    client.emit('ready', {});
    await waiting;
    expect(getPermission(SITE)).toMatchObject({ walletIndex: 0 });
    // A restarted core reads the file again: what it no longer holds goes.
    const told = [];
    onGrantChanged((change) => told.push(change));
    mockApprovals.dapp.entries.delete(SITE);
    client.emit('ready', {});
    await new Promise((resolve) => setImmediate(resolve));
    expect(getPermission(SITE)).toBeNull();
    expect(told).toEqual([{ key: SITE, walletIndex: null }]);
  });

  test('with no core attached, nothing waits; a core that fails to start leaves the store unread', async () => {
    await expect(whenLoaded()).resolves.toBeUndefined();
    const client = coreClient();
    attachCore(client);
    const waiting = whenLoaded();
    client.emit('failed', 'spawn');
    await expect(waiting).resolves.toBeUndefined();
  });

  test('each approval.changed reads the key again: a rule the core wrote, a grant revoked elsewhere', async () => {
    const client = coreClient();
    attachCore(client);
    client.emit('ready', {});
    await whenLoaded();
    await grant(SITE, 1);
    const told = [];
    onGrantChanged((change) => told.push(change));
    mockApprovals.dapp.allowTransaction(SITE, TOKEN, APPROVE, 100, '5');
    client.emit('event', 'approval.changed', { store: 'dapp', key: SITE });
    await new Promise((resolve) => setImmediate(resolve));
    expect(getPermission(SITE).autoApprove.limited.transactions).toHaveLength(1);
    expect(told).toEqual([]);
    mockApprovals.dapp.entries.get(SITE).walletIndex = 2;
    client.emit('event', 'approval.changed', { store: 'dapp', key: SITE });
    await new Promise((resolve) => setImmediate(resolve));
    expect(told).toEqual([{ key: SITE, walletIndex: 2 }]);
    // Another store's change isn't this one's.
    const before = mockApprovals.calls.length;
    client.emit('event', 'approval.changed', { store: 'swarm', key: SITE });
    expect(mockApprovals.calls.length).toBe(before);
  });
});

describe('dapp-permissions — the chrome writes no grant and sets no rule (0011 PRQ-4, PRQ-5a)', () => {
  beforeEach(() => registerDappPermissionsIpc());

  test('dapp:grant-permission is refused for every site, and nothing is written', async () => {
    expect(() => ipcHandlers['dapp:grant-permission']({}, SITE, 0, 1)).toThrow(/own prompt/);
    expect(writes()).toEqual([]);
  });

  test('dapp:set-signing-auto-approve is refused for setting a rule; clearing one is main\'s own', async () => {
    await grant(SITE);
    await setSigningAutoApprove(SITE, true, pageFor(SITE));
    for (const enabled of [true, 'yes', 1, undefined]) {
      expect(() => ipcHandlers['dapp:set-signing-auto-approve']({}, SITE, enabled)).toThrow(/signing prompt/);
    }
    await expect(ipcHandlers['dapp:set-signing-auto-approve']({}, SITE, false)).resolves.toBe(true);
    expect(lastWrite().params).toEqual({ store: 'dapp', key: SITE, what: 'signing' });
  });

  test("the chrome's reads ask the core, as it holds the store now", async () => {
    await grant(SITE);
    await setSigningAutoApprove(SITE, true, pageFor(SITE));
    await updateLastUsed(SITE, 42, pageFor(SITE));
    const read = await ipcHandlers['dapp:get-permission']({}, SITE);
    expect(read).toEqual(mockApprovals.dapp.entry(SITE));
    expect(read.chainId).toBe(42);
    expect(mockApprovals.calls.at(-1)).toEqual({ method: 'approval.grants', params: { store: 'dapp', key: SITE }, page: null });
    expect(await ipcHandlers['dapp:get-all-permissions']({})).toEqual([mockApprovals.dapp.entry(SITE)]);
    // A signing rule stored: Q9's limited one (or today's flag).
    expect(await ipcHandlers['dapp:get-signing-auto-approve']({}, SITE)).toBe(true);
    expect(getSigningAutoApprove(SITE)).toBe(true);
    // A core that can't answer: nothing.
    jest.spyOn(mockApprovals.approval, 'grants').mockRejectedValue(new Error('down'));
    expect(await ipcHandlers['dapp:get-permission']({}, SITE)).toBeNull();
    expect(await ipcHandlers['dapp:get-all-permissions']({})).toEqual([]);
  });
});

describe('dapp-permissions — a revoked grant or a changed account is told (0011 PRQ-6)', () => {
  let told;
  let stop;
  beforeEach(() => {
    told = [];
    stop = onGrantChanged((change) => told.push(change));
  });
  afterEach(() => stop());

  test('a revocation is told once with the normalized key; nothing to revoke tells nothing', async () => {
    await grant('vitalik.eth');
    expect(await revokePermission('ens://vitalik.eth')).toBe(true);
    expect(await revokePermission('vitalik.eth')).toBe(false);
    expect(told).toEqual([{ key: 'vitalik.eth', walletIndex: null }]);
  });

  test("a deleted account's grants are each told as revoked", async () => {
    await grant('https://a.example', 1);
    await grant('https://b.example', 1);
    await grant('https://c.example', 0);
    await revokePermissionsForWalletIndex(1);
    expect(told.sort((x, y) => x.key.localeCompare(y.key))).toEqual([
      { key: 'https://a.example', walletIndex: null },
      { key: 'https://b.example', walletIndex: null },
    ]);
  });

  test('an account change is told with the new account, and only when it changes', async () => {
    await grant(SITE, 0);
    await updateWalletIndex(SITE, 0, pageFor(SITE));
    await updateWalletIndex(SITE, 3, pageFor(SITE));
    expect(told).toEqual([{ key: SITE, walletIndex: 3 }]);
  });

  test('a grant written, its rules and its last use are not told here', async () => {
    await grant(SITE, 0);
    await setSigningAutoApprove(SITE, true, pageFor(SITE));
    await updateLastUsed(SITE, 5, pageFor(SITE));
    expect(told).toEqual([]);
  });

  test("one listener's failure does not keep another from hearing; a stopped listener hears nothing", async () => {
    const stopThrower = onGrantChanged(() => {
      throw new Error('listener');
    });
    const late = [];
    const stopLate = onGrantChanged((change) => late.push(change));
    await grant(SITE);
    await revokePermission(SITE);
    expect(late).toEqual([{ key: SITE, walletIndex: null }]);
    stopLate();
    stopThrower();
    await grant(SITE);
    await revokePermission(SITE);
    expect(late).toHaveLength(1);
  });
});
