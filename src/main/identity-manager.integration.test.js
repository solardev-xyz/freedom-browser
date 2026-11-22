/**
 * vault-meta.json through the real freedom-cored (freedom-core design 0013,
 * PRF-6(a)): the core is the file's only writer, and this build's hello
 * names `vault_meta` in `store_moved`.
 *
 * - (T1) identity-manager.js's store-touching cases against the pinned core:
 *   a create and an import write the metadata with the vault, an unlock adds
 *   missing addresses, the list's default is written once, and every
 *   account change goes through `accounts.*`, the reference's refusals
 *   with their codes. A Safe's removal clears its pending SafeTx in the
 *   core too (`safe_pending` named, PRF-6(d)), and main only drops its copy.
 * - (T2) main writes none of the store's files (`vault-meta.json`,
 *   `vault-meta-journal.json`, the staged `*.freedom-new`), nor
 *   `safe-pending.json`: a spy on `fs`.
 * - (T3) the reference identity-manager.js (test/helpers/reference-vault-meta.js,
 *   9d4ea6251), with a client sending the hello of a build before PRF-6
 *   (no `store_moved`, no `requires`), on the pinned core: every account
 *   write answers `not_moved` (`vault_meta`), no core request changes the
 *   file, and the reads reflect the reference's own writes.
 * - (T4) this step's identity-manager.js on the previous core release
 *   (0.22.0), which echoes no store: a create, an import and every account
 *   operation fail `requirement_unmet` in main, and an unlock of a vault the
 *   reference made works and writes no metadata.
 * - Rollback: the reference reads the file the core wrote and sees the
 *   state the core answers.
 *
 * Skipped without the binaries; FREEDOM_CORED_STORES_TEST=1 requires both
 * (npm run core:download, npm run core:download:previous). The Quick Setup
 * case runs on macOS under the job's temporary keychain (FREEDOM_TEST_KEYCHAIN).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadMainModule } = require('../../test/helpers/main-process-test-utils');
const {
  coredBinaries,
  startCore,
  watchWrites,
  SET_A_WRITES,
} = require('../../test/helpers/store-handover');
const { referenceMeta } = require('../../test/helpers/simulated-store-core');

const { current, previous } = coredBinaries();
const describeIfCurrent = current && fs.existsSync(current) ? describe : describe.skip;
const describeIfPrevious =
  current && previous && fs.existsSync(previous) ? describe : describe.skip;
const keychain = process.platform === 'darwin' ? process.env.FREEDOM_TEST_KEYCHAIN : null;
if (current && process.env.FREEDOM_KEYSTORE_REQUIRE_KEYCHAIN === '1' && !keychain) {
  throw new Error('FREEDOM_KEYSTORE_REQUIRE_KEYCHAIN=1 needs FREEDOM_TEST_KEYCHAIN');
}
const describeIfKeychain = current && fs.existsSync(current) && keychain ? describe : describe.skip;

// What an older build, or the test, writes: the spy on main's `fs` doesn't
// see it (writeFileSync opens through the exported openSync, which it spies).
const openAsOlderBuild = fs.openSync;
function writeAsOlderBuild(file, text) {
  const fd = openAsOlderBuild(file, 'w', 0o600);
  try {
    fs.writeSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
}

// The store's files (design 0013, "The vault and its metadata, one write"),
// and safe-pending.json (PRF-6(d)), which a Safe's removal clears.
const STORE_FILES = /vault-meta\.json|vault-meta-journal\.json|\.freedom-new|safe-pending\.json/;
const PASSWORD = 'vault-meta-pass-1';
const ABANDON =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const LEDGER = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C';
const LEDGER_PATH = "44'/60'/0'/0/0";
const OLD_LEDGER = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PHONE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const SAFE = '0x41aD4887971f90BB3fE4d83eCa65177281283261';
const SITE = 'https://app.example';
const HW = 1000000;
const shell = { caller: 'shell' };

const errorOf = (promise) =>
  promise.then(
    (result) => ({ result }),
    (err) => ({ code: err.code, data: err.data, message: err.message, references: err.references })
  );

async function until(condition) {
  for (let i = 0; i < 200 && !condition(); i += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(condition()).toBe(true);
}

/**
 * A profile root for one describe: the core's identity directory is
 * `<root>/identity`, which FREEDOM_IDENTITY_DATA names for main.
 */
function profile(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const identity = path.join(root, 'identity');
  const metaFile = path.join(identity, 'vault-meta.json');
  return {
    root,
    identity,
    metaFile,
    readMeta: () => JSON.parse(fs.readFileSync(metaFile, 'utf8')),
    text: () => (fs.existsSync(metaFile) ? fs.readFileSync(metaFile, 'utf8') : null),
    seed: (meta) => writeAsOlderBuild(metaFile, JSON.stringify(meta, null, 2)),
  };
}

/**
 * Main's modules on `core`: identity-manager.js (`mod`) and `ipcMain`, with
 * the device read and the phone proof answering as the device holds the
 * address, and main's feed store answering `swarm.references`.
 */
function loadMain(core, root, swarm) {
  const loaded = loadMainModule(require.resolve('./identity-manager'), {
    userDataDir: root,
    extraMocks: {
      [require.resolve('./core/core-process')]: () => ({ getCoreClient: () => core }),
      [require.resolve('./wallet/ledger/transport')]: () => ({
        readAddresses: async (paths) => paths.map(() => LEDGER),
      }),
      [require.resolve('./wallet/remote/account-proof')]: () => ({
        proveRemoteAccount: async () => true,
      }),
      [require.resolve('./swarm/feed-store')]: () => ({
        getEthereumWalletIdentityReferences: (index) => swarm.references(index),
      }),
    },
  });
  return loaded;
}

/**
 * Records every request main sends `core`: `{ method, params, context,
 * options }`, those sent to a named process (`requestTo`, as the pending
 * Safe store sends its own) included.
 */
function recordCalls(core) {
  const calls = [];
  const request = core.request.bind(core);
  core.request = (method, params, context, options) => {
    calls.push({ method, params, context, options });
    return request(method, params, context, options);
  };
  const requestTo = core.requestTo.bind(core);
  core.requestTo = (gen, method, params, context, options) => {
    calls.push({ method, params, context, options });
    return requestTo(gen, method, params, context, options);
  };
  return calls;
}

describeIfCurrent('vault-meta.json through the pinned freedom-cored (T1, T2, rollback)', () => {
  let p;
  const swarm = { references: () => [] };
  let core;
  let calls;
  let mod;
  let ipcMain;
  let vaultBackend;
  let permissions;
  let watch;
  const envBefore = process.env.FREEDOM_IDENTITY_DATA;

  const addressOf = async (index) =>
    (await vaultBackend.addresses({ accounts: [index] })).user_wallets[0].address;

  beforeAll(async () => {
    p = profile('vault-meta-core-');
    process.env.FREEDOM_IDENTITY_DATA = p.identity;
    // A dApp grant for account 1, which a test removes.
    writeAsOlderBuild(
      path.join(p.root, 'dapp-permissions.json'),
      JSON.stringify(
        {
          [SITE]: {
            origin: SITE,
            connectedAt: 1700000000000,
            lastUsed: 1700000000000,
            walletIndex: 1,
            chainId: 1,
            autoApprove: { signing: false, transactions: [] },
          },
        },
        null,
        2
      )
    );
    core = await startCore({
      binary: current,
      root: p.root,
      beforeStart: (client) => {
        calls = recordCalls(client);
        ({ mod, ipcMain } = loadMain(client, p.root, swarm));
        ({ vaultBackend } = require('./core/vault-backend'));
        // Main's dApp copy follows the core (core-process.js attaches it).
        permissions = require('./wallet/dapp-permissions');
        permissions.attachCore(client);
      },
    });
    await permissions.whenLoaded();
    mod.registerIdentityIpc();
  });

  afterAll(async () => {
    await core?.stop();
    if (p) fs.rmSync(p.root, { recursive: true, force: true });
    if (envBefore === undefined) delete process.env.FREEDOM_IDENTITY_DATA;
    else process.env.FREEDOM_IDENTITY_DATA = envBefore;
  });

  beforeEach(() => {
    calls.length = 0;
    watch = watchWrites(STORE_FILES);
  });

  afterEach(() => {
    // (T2) Main writes none of the store's files: the core is their only writer.
    try {
      expect(watch.offending()).toEqual([]);
    } finally {
      watch.restore();
    }
  });

  test("the build's hello names vault_meta (and safe_pending), and the core echoes them", () => {
    // The build's stores, vault-meta.json's and safe-pending.json's among them, all echoed.
    const { STORE_MOVED } = require('./core/core-client');
    expect(STORE_MOVED).toEqual(expect.arrayContaining(['vault_meta', 'safe_pending']));
    expect(core.service.helloParams(core).store_moved).toEqual([...STORE_MOVED]);
    expect(core.hello.store_moved).toEqual([...STORE_MOVED]);
  });

  test('a create (userKnowsPassword false, then true) and an import write the metadata with the vault', async () => {
    expect(fs.existsSync(p.metaFile)).toBe(false);
    await mod.createNewVault(PASSWORD, 128, false);
    const first = p.readMeta();
    expect(first).toEqual({
      userKnowsPassword: false,
      createdAt: expect.any(String),
      addresses: {
        userWallet: await addressOf(0),
        beeWallet: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/),
      },
    });
    expect(p.text()).toBe(JSON.stringify(first, null, 2));
    // The create and its metadata went as one request, under `requires`.
    const create = calls.find((call) => call.method === 'vault.create');
    expect(create.params.user_knows_password).toBe(false);
    expect(create.options.requires(core.hello)).toBe(true);

    // vault.delete leaves the metadata; the next create replaces it.
    await mod.deleteVaultData(PASSWORD);
    expect(p.readMeta()).toEqual(first);
    await mod.createNewVault(PASSWORD, 128);
    expect(p.readMeta()).toMatchObject({ userKnowsPassword: true });

    await mod.deleteVaultData(PASSWORD);
    await mod.importExistingMnemonic(PASSWORD, ABANDON, false);
    const imported = p.readMeta();
    expect(imported).toMatchObject({
      userKnowsPassword: false,
      addresses: { userWallet: await addressOf(0) },
    });
    expect(
      calls
        .filter((call) => call.method === 'vault.import')
        .map((call) => call.params.user_knows_password)
    ).toEqual([false]);
    // The journal finished: nothing staged is left.
    expect(fs.readdirSync(p.identity).filter((name) => /journal|freedom-new/.test(name))).toEqual(
      []
    );
  }, 180_000);

  test('an unlock adds the addresses an older file lacks', async () => {
    const { addresses, ...older } = p.readMeta();
    p.seed(older);
    await mod.lockVault();
    await mod.unlockVault(PASSWORD);
    expect(p.readMeta()).toEqual({ ...older, addresses });
  }, 60_000);

  test("the list's first-list default is written once, by the core", async () => {
    expect(p.readMeta()).not.toHaveProperty('derivedWallets');
    const main = { index: 0, name: 'Main Wallet', address: await addressOf(0), type: 'mnemonic' };
    await expect(mod.getDerivedWallets()).resolves.toEqual([main]);
    expect(p.readMeta()).toMatchObject({
      activeWalletIndex: 0,
      derivedWallets: [{ index: 0, name: 'Main Wallet' }],
    });
    const once = p.text();
    const { mtimeMs } = fs.statSync(p.metaFile);
    await expect(mod.getDerivedWallets()).resolves.toEqual([main]);
    expect(p.text()).toBe(once);
    expect(fs.statSync(p.metaFile).mtimeMs).toBe(mtimeMs);
  });

  test("add_mnemonic: refused while locked with the reference's message; unlocked, the core's index and address", async () => {
    await mod.lockVault();
    await expect(mod.createDerivedWallet('Spare')).rejects.toThrow(
      'Vault must be unlocked to create a new wallet'
    );
    await mod.unlockVault(PASSWORD);
    await expect(mod.createDerivedWallet('Spare')).resolves.toEqual({
      index: 1,
      name: 'Spare',
      address: await addressOf(1),
    });
    expect(p.readMeta().derivedWallets.at(-1)).toEqual({
      index: 1,
      name: 'Spare',
      address: await addressOf(1),
    });
  }, 60_000);

  test('a Ledger and a phone, checked by main, are added matched; a matched record stays matched', async () => {
    await expect(mod.addLedgerWallet('', LEDGER, LEDGER_PATH)).resolves.toEqual({
      index: HW,
      name: 'Ledger 1',
      address: LEDGER,
      type: 'ledger',
      path: LEDGER_PATH,
      addressCheck: 'matched',
    });
    await expect(mod.addRemoteWallet('', PHONE)).resolves.toMatchObject({
      index: HW + 1,
      name: 'Phone 1',
      type: 'remote',
      addressCheck: 'matched',
    });
    expect(p.readMeta().nextHardwareWalletIndex).toBe(HW + 2);
    await expect(mod.recordLedgerAddressCheck(HW, false)).resolves.toBe('matched');
    await expect(mod.recordRemoteAddressCheck(HW + 1, false)).resolves.toBe('matched');
    await expect(mod.recordLedgerAddressCheck(HW + 1, true)).resolves.toBeNull();
    await expect(mod.checkRemoteWallet(HW + 1)).resolves.toMatchObject({ addressCheck: 'matched' });
    // A duplicate is refused before the phone is asked, and by the core.
    await expect(mod.addLedgerWallet('', LEDGER, LEDGER_PATH)).rejects.toThrow(
      'This account is already in your wallet list as "Ledger 1"'
    );
    expect(mod.findWalletRecordByAddress(PHONE.toLowerCase())).toMatchObject({ index: HW + 1 });
    for (const method of [
      'accounts.add_ledger',
      'accounts.add_remote',
      'accounts.record_address_check',
    ]) {
      expect(
        calls
          .filter((call) => call.method === method)
          .every((call) => call.context.caller === 'shell')
      ).toBe(true);
    }
  });

  test("add_safe: the reference's refusals, the unchecked owner's code; mark_safe_deployed writes the verified mark", async () => {
    const safe = (owners, threshold = 1) =>
      errorOf(mod.addSafeWallet('', { address: SAFE, owners, threshold, saltNonce: '20260710' }));
    expect((await safe([0])).message).toBe('A Safe needs 1 of 2 or 2 of 3 owners');
    expect((await safe([0, 0])).message).toBe('Duplicate owner accounts');
    expect((await safe([0, 42])).message).toBe('Owner wallet index 42 does not exist');
    // A Ledger record an older build added before the device check.
    const meta = p.readMeta();
    p.seed({
      ...meta,
      derivedWallets: [
        ...meta.derivedWallets,
        { index: HW + 2, name: 'Old', address: OLD_LEDGER, type: 'ledger', path: "44'/60'/1'/0/0" },
      ],
      nextHardwareWalletIndex: HW + 3,
    });
    const unchecked = await safe([0, HW + 2]);
    expect(unchecked.code).toBe('LEDGER_ACCOUNT_UNCHECKED');
    expect(unchecked.message).toMatch(
      /^"Old" can't own a Safe until it has been checked on its Ledger/
    );

    const added = (await safe([0, HW])).result;
    expect(added).toEqual({
      index: HW + 3,
      name: 'Safe 1',
      address: SAFE,
      type: 'safe',
      owners: [0, HW],
      threshold: 1,
      saltNonce: '20260710',
      deployed: {},
    });
    expect((await safe([0, HW + 3])).message).toBe('A Safe cannot own another Safe');
    await mod.markSafeDeployed(HW + 3, 100);
    expect(p.readMeta().derivedWallets.find((w) => w.index === HW + 3).deployed).toEqual({
      100: { verified: true },
    });
    expect(mod.getWalletRecord(HW + 3)).toMatchObject({ type: 'safe', deployed: { 100: true } });
  });

  test("set_active and rename: the chrome's through IPC, as the chrome's; main's lookups read the core's writes", async () => {
    const invoke = (channel, ...args) => ipcMain.handlers.get(channel)({}, ...args);
    await expect(invoke('wallet:set-active-wallet', 1)).resolves.toEqual({ success: true });
    await expect(invoke('wallet:rename-wallet', 1, 'Spare 2')).resolves.toEqual({ success: true });
    await expect(invoke('wallet:get-active-index')).resolves.toEqual({ success: true, index: 1 });
    await expect(invoke('identity:get-vault-meta')).resolves.toEqual(p.readMeta());
    await expect(invoke('wallet:set-active-wallet', 77)).resolves.toEqual({
      success: false,
      error: 'Wallet with index 77 does not exist',
    });
    const { wallets } = await invoke('wallet:get-derived-wallets');
    expect(wallets.map((w) => w.index)).toEqual([0, 1, HW, HW + 1, HW + 2, HW + 3]);
    expect(
      calls
        .filter((call) => call.method.startsWith('accounts.'))
        .map((call) => [call.method, call.context.caller])
    ).toEqual([
      ['accounts.set_active', 'chrome'],
      ['accounts.rename', 'chrome'],
      ['accounts.active', 'chrome'],
      ['accounts.meta', 'chrome'],
      ['accounts.set_active', 'chrome'],
      ['accounts.list', 'chrome'],
    ]);
    expect(mod.getActiveWalletIndex()).toBe(1);
    expect(mod.getWalletRecord(1)).toMatchObject({ name: 'Spare 2' });
    await mod.setActiveWalletIndex(HW + 3);
    await mod.renameDerivedWallet(HW + 3, 'Joint');
    expect(mod.getActiveWalletIndex()).toBe(HW + 3);
    expect(mod.getWalletRecord(HW + 3)).toMatchObject({ name: 'Joint' });
  });

  test("remove: the refusals, a Safe's state dropped, and the account's dApp grants forgotten, which main's copy and pages hear", async () => {
    const remove = (index) => errorOf(mod.deleteDerivedWallet(index));
    expect((await remove(0)).message).toBe('Cannot delete the main wallet (index 0)');
    expect((await remove(HW)).message).toBe(
      'This account is an owner of "Joint" — delete that Safe account first'
    );
    const references = [
      {
        origin: 'myapp.eth',
        identityId: 'ethereum-wallet:1',
        active: true,
        feedNames: [],
        feedCount: 0,
      },
    ];
    swarm.references = (index) => (index === 1 ? references : []);
    const swarmRefusal = await remove(1);
    expect(swarmRefusal).toMatchObject({
      code: 'SWARM_PUBLISHER_IDENTITY_WALLET_IN_USE',
      references,
    });
    expect(swarmRefusal.message).toMatch(
      /^Cannot delete wallet with index 1; it is active or pinned to Swarm feeds for myapp\.eth\./
    );
    swarm.references = () => [];

    // A Safe: main's own slot for it goes once the core has removed it (the
    // core ended its approvals in the same request), and so does its pending
    // SafeTx, which the core cleared in it too (both stores named, PRF-6(d)):
    // main sends no clear, and drops its copy.
    const safeApprovals = require('./wallet/safe/safe-approvals');
    const pendingStore = require('./wallet/safe/pending-store');
    const hash = `0x${'11'.repeat(32)}`;
    await safeApprovals.hold('send', HW + 3, { id: 'a'.repeat(32), page: null }, hash);
    const pendingFile = path.join(p.root, 'safe-pending.json');
    const entry = { safeTxHash: hash, threshold: 1, signatures: [], createdAt: 1700000000000 };
    await pendingStore.setPending(HW + 3, entry);
    expect(JSON.parse(fs.readFileSync(pendingFile, 'utf8'))).toEqual({ [HW + 3]: entry });
    await expect(mod.deleteDerivedWallet(HW + 3)).resolves.toBeUndefined();
    expect(safeApprovals.held('send', HW + 3, hash)).toBeNull();
    expect(pendingStore.getPending(HW + 3)).toBeNull();
    await expect(vaultBackend.safePending.get(HW + 3)).resolves.toBeNull();
    expect(fs.readFileSync(pendingFile, 'utf8')).toBe('{}');
    expect(calls.map((call) => call.method)).not.toContain('safe_pending.clear');
    expect(mod.getWalletRecord(HW + 3)).toBeNull();
    expect(mod.getActiveWalletIndex()).toBe(0);

    // Account 1's grant: forgotten by the core in the removal.
    const heard = [];
    const stop = permissions.onGrantChanged((change) => heard.push(change));
    try {
      expect(permissions.getPermission(SITE)).toMatchObject({ walletIndex: 1 });
      await mod.deleteDerivedWallet(1);
      expect((await vaultBackend.approval.grants({ store: 'dapp' })).records).toEqual([]);
      await until(() => permissions.getPermission(SITE) === null);
      expect(heard).toContainEqual({ key: SITE, walletIndex: null });
    } finally {
      stop();
    }
    expect(mod.getWalletRecord(1)).toBeNull();
    // Main asked for no end and no separate forget: the core did both.
    expect(calls.map((call) => call.method)).not.toContain('approval.end');
    expect(calls.map((call) => call.method)).not.toContain('approval.forget_account');
    expect(
      calls
        .filter((call) => call.method === 'accounts.remove')
        .map((call) => call.params.swarm_references)
    ).toEqual([[], [], references, [], []]);
  });

  test("rollback: the reference reads the core's file and sees what the core answers", async () => {
    const reference = require('../../test/helpers/reference-vault-meta');
    const records = async () => {
      const listed = await vaultBackend.accounts.list();
      expect(await reference.getDerivedWallets()).toEqual(listed);
      for (const { index } of listed)
        expect(reference.getWalletRecord(index)).toEqual(mod.getWalletRecord(index));
      return listed;
    };
    expect((await records()).length).toBeGreaterThan(1);
    expect(reference.getActiveWalletIndex()).toBe(await vaultBackend.accounts.active());
    expect(referenceMeta()).toEqual(await vaultBackend.accounts.meta());
    await mod.lockVault();
    await records();
    const text = p.text();
    expect(JSON.stringify(JSON.parse(text), null, 2)).toBe(text);
    await mod.unlockVault(PASSWORD);
  }, 60_000);
});

describeIfKeychain('Quick Setup with vault_meta moved (macOS, the temporary keychain)', () => {
  let p;
  let core;
  let mod;
  let vaultBackend;
  const envBefore = process.env.FREEDOM_IDENTITY_DATA;

  beforeAll(async () => {
    p = profile('vault-meta-quick-');
    process.env.FREEDOM_IDENTITY_DATA = p.identity;
    core = await startCore({
      binary: current,
      root: p.root,
      beforeStart: (client) => {
        // Main's `shell.keystore` executor, as the app registers it: the
        // core seals Quick Setup's credential through it. Required here,
        // before loadMain resets the modules: startCore made `client` from
        // the registry an earlier describe's loadMain left, and the
        // executor's JsonText must be that registry's, or the client sends
        // it as a plain object and the core refuses the answer
        // (`backend`, `answer_form`).
        const { createHelperRunner, registerKeystoreShell } = require('./core/keystore-shell');
        registerKeystoreShell(client, { runner: createHelperRunner({ command: current }) });
        ({ mod } = loadMain(client, p.root, { references: () => [] }));
        ({ vaultBackend } = require('./core/vault-backend'));
      },
    });
  });

  afterAll(async () => {
    try {
      await vaultBackend?.quickUnlockDisable();
    } catch {
      // Nothing enrolled.
    }
    await core?.stop();
    if (p) fs.rmSync(p.root, { recursive: true, force: true });
    if (envBefore === undefined) delete process.env.FREEDOM_IDENTITY_DATA;
    else process.env.FREEDOM_IDENTITY_DATA = envBefore;
  });

  test('the vault, its credential and its metadata (userKnowsPassword false) in one import', async () => {
    const watch = watchWrites(STORE_FILES);
    try {
      await mod.importExistingMnemonic(PASSWORD, ABANDON, false, { quickUnlock: true });
      expect(watch.offending()).toEqual([]);
    } finally {
      watch.restore();
    }
    expect(p.readMeta()).toMatchObject({
      userKnowsPassword: false,
      addresses: { userWallet: expect.any(String) },
    });
    await expect(vaultBackend.quickUnlockStatus()).resolves.toMatchObject({ enabled: true });
    expect(fs.existsSync(path.join(p.identity, 'quick-unlock.dat'))).toBe(false);
  }, 120_000);
});

describeIfCurrent(
  'the reference with the hello of a build before PRF-6, on the pinned freedom-cored (T3)',
  () => {
    let p;
    let core;
    let reference;
    let changed;
    const envBefore = process.env.FREEDOM_IDENTITY_DATA;
    const digest = () => p.text();

    beforeAll(async () => {
      p = profile('vault-meta-prestep-');
      process.env.FREEDOM_IDENTITY_DATA = p.identity;
      core = await startCore({
        binary: current,
        root: p.root,
        storeMoved: [],
        beforeStart: (client) => {
          // The build before PRF-6 sends no `requires`. No core request
          // changes vault-meta.json: each is checked before and after.
          changed = [];
          const request = client.request.bind(client);
          client.request = async (method, params, context, options = {}) => {
            const before = digest();
            try {
              return await request(method, params, context, { ...options, requires: null });
            } finally {
              if (digest() !== before) changed.push(method);
            }
          };
          loadMainModule(require.resolve('./identity-manager'), {
            userDataDir: p.root,
            extraMocks: {
              [require.resolve('./core/core-process')]: () => ({ getCoreClient: () => client }),
            },
          });
          reference = require('../../test/helpers/reference-vault-meta');
        },
      });
    });

    afterAll(async () => {
      await core?.stop();
      if (p) fs.rmSync(p.root, { recursive: true, force: true });
      if (envBefore === undefined) delete process.env.FREEDOM_IDENTITY_DATA;
      else process.env.FREEDOM_IDENTITY_DATA = envBefore;
    });

    afterEach(() => {
      expect(changed).toEqual([]);
    });

    test('the echo lacks vault_meta', () => {
      expect(core.service.helloParams(core).store_moved).toEqual([]);
      expect(core.hello.store_moved).toEqual([]);
    });

    test('vault.create, vault.unlock and vault.import leave the file to the reference, which writes it itself', async () => {
      expect(fs.existsSync(p.metaFile)).toBe(false);
      await reference.createNewVault(PASSWORD, 128, false);
      expect(p.readMeta()).toMatchObject({ userKnowsPassword: false });
      // An older file without addresses: the core's unlock adds none, the
      // reference's own migration does.
      const { addresses, ...older } = p.readMeta();
      p.seed(older);
      await reference.lockVault();
      await reference.unlockVault(PASSWORD);
      expect(p.readMeta()).toEqual({ ...older, addresses });
      await reference.deleteVaultData(PASSWORD);
      expect(p.readMeta()).toEqual({ ...older, addresses });
      await reference.importExistingMnemonic(PASSWORD, ABANDON);
      expect(p.readMeta()).toMatchObject({ userKnowsPassword: true });
    }, 180_000);

    test('every accounts.* write answers not_moved (vault_meta)', async () => {
      const writes = SET_A_WRITES.filter(({ store }) => store === 'vault_meta');
      expect(writes).toHaveLength(9);
      for (const { method, params } of writes) {
        const answer = await errorOf(core.request(method, params, shell));
        expect([method, answer.code, answer.data?.store]).toEqual([
          method,
          'not_moved',
          'vault_meta',
        ]);
      }
    });

    test("accounts.list answers the first-list default without writing it; list, meta and active follow the reference's writes", async () => {
      expect(p.readMeta()).not.toHaveProperty('derivedWallets');
      const { wallets } = await core.request('accounts.list', {}, shell);
      expect(wallets).toEqual([
        expect.objectContaining({ index: 0, name: 'Main Wallet', type: 'mnemonic' }),
      ]);
      expect(p.readMeta()).not.toHaveProperty('derivedWallets');

      await reference.createDerivedWallet('Two');
      await reference.setActiveWalletIndex(1);
      await reference.renameDerivedWallet(1, 'Deux');
      expect((await core.request('accounts.list', {}, shell)).wallets).toEqual(
        await reference.getDerivedWallets()
      );
      expect((await core.request('accounts.meta', {}, shell)).meta).toEqual(referenceMeta());
      expect((await core.request('accounts.active', {}, shell)).index).toBe(1);
    }, 60_000);
  }
);

describeIfPrevious(
  "this step's identity-manager on the previous freedom-cored release (T4)",
  () => {
    let p;
    const swarm = { references: () => [] };
    let core;
    let mod;
    let ipcMain;
    let reference;
    let request;
    const envBefore = process.env.FREEDOM_IDENTITY_DATA;

    /** `task` as the build before PRF-6 runs it: no `requires`. */
    async function asOlderBuild(task) {
      const strict = core.request;
      core.request = (method, params, context, options = {}) =>
        request(method, params, context, { ...options, requires: null });
      try {
        return await task();
      } finally {
        core.request = strict;
      }
    }

    beforeAll(async () => {
      p = profile('vault-meta-previous-');
      process.env.FREEDOM_IDENTITY_DATA = p.identity;
      core = await startCore({
        binary: previous,
        root: p.root,
        // 0.22.0 doesn't know serve's grant arguments (design 0017, C1).
        grantArgs: false,
        beforeStart: (client) => {
          request = client.request.bind(client);
          ({ mod, ipcMain } = loadMain(client, p.root, swarm));
          reference = require('../../test/helpers/reference-vault-meta');
        },
      });
      mod.registerIdentityIpc();
    });

    afterAll(async () => {
      await core?.stop();
      if (p) fs.rmSync(p.root, { recursive: true, force: true });
      if (envBefore === undefined) delete process.env.FREEDOM_IDENTITY_DATA;
      else process.env.FREEDOM_IDENTITY_DATA = envBefore;
    });

    test('the hello names vault_meta, and the previous release echoes none', () => {
      expect(core.service.helloParams(core).store_moved).toContain('vault_meta');
      expect(core.hello.store_moved).toEqual([]);
    });

    test('a create and an import fail requirement_unmet in main, and no vault is made', async () => {
      const watch = watchWrites(STORE_FILES);
      try {
        expect((await errorOf(mod.createNewVault(PASSWORD, 128))).code).toBe('requirement_unmet');
        expect((await errorOf(mod.importExistingMnemonic(PASSWORD, ABANDON))).code).toBe(
          'requirement_unmet'
        );
        expect(watch.offending()).toEqual([]);
      } finally {
        watch.restore();
      }
      expect(fs.existsSync(path.join(p.identity, 'identity-vault.json'))).toBe(false);
      expect(fs.existsSync(p.metaFile)).toBe(false);
    });

    test('a vault the reference made unlocks, and nothing writes its metadata', async () => {
      await asOlderBuild(() => reference.importExistingMnemonic(PASSWORD, ABANDON));
      const { addresses, ...older } = p.readMeta();
      expect(addresses).toBeTruthy();
      p.seed(older);
      await mod.lockVault();
      const before = p.text();
      const watch = watchWrites(STORE_FILES);
      try {
        await mod.unlockVault(PASSWORD);
        await expect(mod.isVaultUnlocked()).resolves.toBe(true);
        expect(watch.offending()).toEqual([]);
      } finally {
        watch.restore();
      }
      // Neither main nor 0.22.0 migrated it: that waits for a core that echoes vault_meta.
      expect(p.text()).toBe(before);
    }, 120_000);

    test('every account operation fails requirement_unmet, and nothing writes the store', async () => {
      const before = p.text();
      const invoke = (channel, ...args) => ipcMain.handlers.get(channel)({}, ...args);
      const watch = watchWrites(STORE_FILES);
      try {
        const operations = [
          mod.getDerivedWallets(),
          mod.createDerivedWallet('Spare'),
          mod.setActiveWalletIndex(0),
          mod.renameDerivedWallet(0, 'Main'),
          mod.deleteDerivedWallet(1),
          mod.addLedgerWallet('', LEDGER, LEDGER_PATH),
          mod.addRemoteWallet('', PHONE),
          mod.recordLedgerAddressCheck(HW, true),
          mod.recordRemoteAddressCheck(HW, true),
          mod.addSafeWallet('', { address: SAFE, owners: [0, HW], threshold: 1, saltNonce: '1' }),
          mod.markSafeDeployed(HW, 100),
        ];
        for (const answer of await Promise.all(operations.map(errorOf))) {
          expect(answer.code).toBe('requirement_unmet');
        }
        await expect(invoke('identity:get-vault-meta')).resolves.toBeNull();
        await expect(invoke('wallet:get-active-index')).resolves.toEqual({
          success: false,
          error: "The core can't take this request",
        });
        expect(watch.offending()).toEqual([]);
      } finally {
        watch.restore();
      }
      expect(p.text()).toBe(before);
      // Main's synchronous lookups still read the file.
      expect(mod.getWalletRecord(0)).toMatchObject({ index: 0, type: 'mnemonic' });
    });
  }
);
