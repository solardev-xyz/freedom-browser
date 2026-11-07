const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createTempUserDataDir,
  loadMainModule,
  removeTempUserDataDir,
} = require('../../test/helpers/main-process-test-utils');

const ENV_KEYS = [
  'FREEDOM_ANT_DATA',
  'FREEDOM_BEE_DATA',
  'FREEDOM_IPFS_DATA',
  'FREEDOM_RADICLE_DATA',
  'FREEDOM_IDENTITY_DATA',
];

function snapshotEnv() {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

/**
 * A fake of core/vault-backend: the identity core's vault, as main sees it.
 * Addresses are derived as `0xderived<index>`; the Bee wallet is `0xbee`.
 */
function makeVaultBackendMock({ exists = true, unlocked = true } = {}) {
  const state = { exists, unlocked };
  const locked = () => Object.assign(new Error('Vault is locked'), { code: 'vault_locked' });
  const addresses = { user_wallet: '0xuser', bee_wallet: '0xbee' };
  return {
    state,
    status: jest.fn(async () => ({
      exists: state.exists,
      unlocked: state.unlocked,
      epoch: null,
      fingerprint: null,
    })),
    createVault: jest.fn(async () => {
      Object.assign(state, { exists: true, unlocked: true });
      return { mnemonic: 'test mnemonic', addresses };
    }),
    importVault: jest.fn(async () => {
      Object.assign(state, { exists: true, unlocked: true });
      return { addresses };
    }),
    unlock: jest.fn(async () => {
      state.unlocked = true;
      return { addresses };
    }),
    lock: jest.fn(async () => {
      state.unlocked = false;
    }),
    touch: jest.fn(),
    addresses: jest.fn(async ({ accounts = [], publishers = [] } = {}) => {
      if (!state.unlocked) throw locked();
      return {
        user_wallets: accounts.map((account) => ({ account, address: `0xderived${account}` })),
        bee_wallet: '0xbee',
        publishers: publishers.map((index) => ({ origin_index: index, address: `0xpub${index}` })),
        radicle: { public_key: '00', did: 'did:key:zTest', node_id: 'zTest' },
      };
    }),
    writeNodeIdentity: jest.fn(async (spec) =>
      spec.node === 'bee'
        ? { status: 'installed', address: '0xbee' }
        : { status: 'installed', did: 'did:key:zTest', node_id: 'zTest' }
    ),
    radicleDid: jest.fn(async () => 'did:key:zTest'),
  };
}

function vaultBackendMocks(backend) {
  return { [require.resolve('./core/vault-backend')]: () => ({ vaultBackend: backend }) };
}

describe('identity-manager profile paths', () => {
  let tempDirs = [];
  let envSnapshot;

  beforeEach(() => {
    tempDirs = [];
    envSnapshot = snapshotEnv();
    restoreEnv(envSnapshot);
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
    for (const dir of tempDirs) {
      removeTempUserDataDir(dir);
    }
    jest.restoreAllMocks();
  });

  function tempDir(prefix) {
    const dir = createTempUserDataDir(prefix);
    tempDirs.push(dir);
    return dir;
  }

  test('injects node identities into env-resolved profile data dirs', async () => {
    const userDataDir = tempDir('identity-manager-user-data-');
    const identityDir = tempDir('identity-manager-identity-');
    const antDir = tempDir('identity-manager-ant-');
    const ipfsDir = tempDir('identity-manager-ipfs-');
    const radicleDir = tempDir('identity-manager-radicle-');
    process.env.FREEDOM_IDENTITY_DATA = identityDir;
    process.env.FREEDOM_ANT_DATA = antDir;
    process.env.FREEDOM_IPFS_DATA = ipfsDir;
    process.env.FREEDOM_RADICLE_DATA = radicleDir;

    const backend = makeVaultBackendMock({ exists: false, unlocked: false });
    const activeProfile = {
      id: 'profiled',
      source: 'catalog',
      metadata: {
        nodes: {
          bee: { apiPort: 11644, p2pPort: 12644 },
        },
      },
    };
    const { mod } = loadMainModule(require.resolve('./identity-manager'), {
      userDataDir,
      extraMocks: {
        ...vaultBackendMocks(backend),
        [require.resolve('./profile-resolver')]: () => ({
          getActiveProfile: jest.fn(() => activeProfile),
        }),
      },
    });

    await mod.createNewVault('password123');
    await mod.injectBeeIdentity();
    await mod.injectIpfsIdentity();
    await mod.injectRadicleIdentity('ProfileAlias');

    expect(mod.getIdentityDataDir()).toBe(identityDir);
    expect(mod.getAntDataDir()).toBe(antDir);
    expect(mod.getIpfsDataDir()).toBe(ipfsDir);
    expect(mod.getRadicleDataDir()).toBe(radicleDir);

    // The core writes the node identities, into the profile's directories,
    // with the profile's Bee ports.
    expect(backend.writeNodeIdentity).toHaveBeenCalledWith(
      { node: 'bee', data_dir: antDir, api_port: 11644, p2p_port: 12644 },
      expect.any(String)
    );
    expect(backend.writeNodeIdentity).toHaveBeenCalledWith(
      { node: 'radicle', home: radicleDir, alias: 'ProfileAlias' },
      expect.any(String)
    );
    expect(backend.writeNodeIdentity).toHaveBeenCalledTimes(2);
  });
});

describe('identity-manager and the core (freedom-browser#651 review)', () => {
  let tempDirs = [];
  let envSnapshot;

  beforeEach(() => {
    tempDirs = [];
    envSnapshot = snapshotEnv();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
    for (const dir of tempDirs) removeTempUserDataDir(dir);
    jest.restoreAllMocks();
  });

  function setup(backend, extraMocks = {}) {
    const dirs = {};
    for (const name of ['userData', 'identity', 'ant', 'radicle']) {
      dirs[name] = createTempUserDataDir(`identity-manager-${name}-`);
      tempDirs.push(dirs[name]);
    }
    process.env.FREEDOM_IDENTITY_DATA = dirs.identity;
    process.env.FREEDOM_ANT_DATA = dirs.ant;
    process.env.FREEDOM_RADICLE_DATA = dirs.radicle;
    const activeProfile = {
      id: 'profiled',
      source: 'catalog',
      metadata: { nodes: { bee: { apiPort: 11644, p2pPort: 12644 } } },
    };
    const { mod } = loadMainModule(require.resolve('./identity-manager'), {
      userDataDir: dirs.userData,
      extraMocks: {
        ...vaultBackendMocks(backend),
        [require.resolve('./profile-resolver')]: () => ({
          getActiveProfile: jest.fn(() => activeProfile),
        }),
        ...extraMocks,
      },
    });
    const guard = require('./core/node-identity-guard');
    guard.setStartupRecovery(null);
    return { mod, guard, dirs };
  }

  const unavailable = () =>
    Object.assign(new Error('The core exited'), { code: 'core_unavailable' });

  test('a node is blocked from before its wipe until a write installs it', async () => {
    const backend = makeVaultBackendMock({ exists: true, unlocked: true });
    const { mod, guard } = setup(backend);
    let duringWrite;
    backend.writeNodeIdentity.mockImplementationOnce(async () => {
      duringWrite = guard.nodeBlockReason('bee');
      throw unavailable();
    });
    await expect(mod.injectBeeIdentity()).rejects.toThrow('The core exited');
    expect(duringWrite).toMatch(/being updated/);
    // Outcome unknown: Bee stays blocked, even after the core reports again.
    expect(guard.nodeBlockReason('bee')).toMatch(/did not finish/);
    guard.setStartupRecovery(null);
    expect(guard.nodeBlockReason('bee')).toMatch(/did not finish/);
    // A reconciled install reports only its status; the address comes from
    // the vault, read before the write.
    backend.writeNodeIdentity.mockResolvedValueOnce({ status: 'installed', reconciled: true });
    await expect(mod.injectBeeIdentity()).resolves.toEqual({ address: '0xbee' });
    expect(guard.nodeBlockReason('bee')).toBeNull();

    backend.writeNodeIdentity.mockResolvedValueOnce({ status: 'corrupt', reconciled: true });
    await expect(mod.injectRadicleIdentity()).rejects.toThrow('(corrupt)');
    expect(guard.nodeBlockReason('radicle')).toMatch(/set up node identities again/);
    backend.writeNodeIdentity.mockResolvedValueOnce({ status: 'installed', reconciled: true });
    await expect(mod.injectRadicleIdentity()).resolves.toEqual({ did: 'did:key:zTest' });
    expect(guard.nodeBlockReason('radicle')).toBeNull();
  });

  test('injections of one node run one at a time', async () => {
    const backend = makeVaultBackendMock({ exists: true, unlocked: true });
    const { mod, guard } = setup(backend);
    const writes = [];
    backend.writeNodeIdentity.mockImplementation(
      () =>
        new Promise((resolve) => {
          writes.push(() => resolve({ status: 'installed', address: '0xbee' }));
        })
    );
    const waitForWrites = async (count) => {
      for (let i = 0; i < 200 && writes.length < count; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    const first = mod.injectBeeIdentity();
    const second = mod.injectBeeIdentity();
    await waitForWrites(1);
    // Give the second attempt every chance to start too early.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(writes).toHaveLength(1);
    writes[0]();
    await first;
    // The second attempt starts only now, and blocks Bee until it installs.
    await waitForWrites(2);
    expect(writes).toHaveLength(2);
    expect(guard.nodeBlockReason('bee')).toMatch(/being updated/);
    writes[1]();
    await second;
    expect(guard.nodeBlockReason('bee')).toBeNull();
  });

  test('hasVault reads the vault file while the core is down', async () => {
    const backend = makeVaultBackendMock({ exists: false, unlocked: false });
    const { mod, dirs } = setup(backend);
    backend.status.mockRejectedValue(unavailable());
    await expect(mod.hasVault()).resolves.toBe(false);
    fs.writeFileSync(path.join(dirs.identity, 'identity-vault.json'), '{}');
    await expect(mod.hasVault()).resolves.toBe(true);
    backend.status.mockRejectedValueOnce(Object.assign(new Error('bad'), { code: 'internal' }));
    await expect(mod.hasVault()).rejects.toThrow('bad');
  });

  test('a lost Quick Setup is finished by main: metadata, then the credential', async () => {
    const completeQuickSetup = jest.fn(async () => {});
    const backend = makeVaultBackendMock({ exists: false, unlocked: false });
    const { mod, dirs } = setup(backend, {
      [require.resolve('./quick-unlock')]: () => ({ completeQuickSetup }),
    });
    await mod.importExistingMnemonic('random-pass', 'abandon about', false);
    const { onCommitted } = backend.importVault.mock.calls[0][2];
    const metaPath = path.join(dirs.identity, 'vault-meta.json');
    fs.rmSync(metaPath);
    await onCommitted({ addresses: { user_wallet: '0xu', bee_wallet: '0xb' } });
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    expect(meta).toMatchObject({
      userKnowsPassword: false,
      addresses: { userWallet: '0xu', beeWallet: '0xb' },
    });
    expect(completeQuickSetup).toHaveBeenCalledWith('random-pass');
    // A password the user knows needs no credential.
    await mod.createNewVault('password123');
    await backend.createVault.mock.calls[0][2].onCommitted({ addresses: {} });
    expect(completeQuickSetup).toHaveBeenCalledTimes(1);
  });
});

describe('identity-manager wallet deletion', () => {
  let tmpDir;
  let envSnapshot;
  let mockGetEthereumWalletIdentityReferences;
  let identityManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-manager-test-'));
    envSnapshot = snapshotEnv();
    process.env.FREEDOM_IDENTITY_DATA = tmpDir;
    mockGetEthereumWalletIdentityReferences = jest.fn(() => []);
    identityManager = loadMainModule(require.resolve('./identity-manager'), {
      userDataDir: tmpDir,
      extraMocks: {
        [require.resolve('./swarm/feed-store')]: () => ({
          getEthereumWalletIdentityReferences: (...args) =>
            mockGetEthereumWalletIdentityReferences(...args),
        }),
      },
    }).mod;
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeVaultMeta(meta) {
    fs.writeFileSync(path.join(tmpDir, 'vault-meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
  }

  function readVaultMeta() {
    return JSON.parse(fs.readFileSync(path.join(tmpDir, 'vault-meta.json'), 'utf-8'));
  }

  test('blocks deleting wallets referenced by Swarm publisher identities', async () => {
    const references = [{
      origin: 'myapp.eth',
      identityId: 'ethereum-wallet:2',
      active: true,
      feedNames: ['blog'],
      feedCount: 1,
    }];
    mockGetEthereumWalletIdentityReferences.mockReturnValue(references);
    writeVaultMeta({
      activeWalletIndex: 2,
      derivedWallets: [
        { index: 0, name: 'Main Wallet', address: '0x0' },
        { index: 2, name: 'Trading Wallet', address: '0x2' },
      ],
    });

    await expect(identityManager.deleteDerivedWallet(2))
      .rejects.toMatchObject({
        code: 'SWARM_PUBLISHER_IDENTITY_WALLET_IN_USE',
        references,
      });

    expect(mockGetEthereumWalletIdentityReferences).toHaveBeenCalledWith(2);
    expect(readVaultMeta().derivedWallets.map((wallet) => wallet.index)).toEqual([0, 2]);
    expect(readVaultMeta().activeWalletIndex).toBe(2);
  });

  test('deletes unreferenced derived wallet and resets active wallet', async () => {
    writeVaultMeta({
      activeWalletIndex: 2,
      derivedWallets: [
        { index: 0, name: 'Main Wallet', address: '0x0' },
        { index: 2, name: 'Trading Wallet', address: '0x2' },
      ],
    });

    await identityManager.deleteDerivedWallet(2);

    expect(mockGetEthereumWalletIdentityReferences).toHaveBeenCalledWith(2);
    expect(readVaultMeta().derivedWallets.map((wallet) => wallet.index)).toEqual([0]);
    expect(readVaultMeta().activeWalletIndex).toBe(0);
  });

  test('revokes dApp permissions bound to the deleted wallet', async () => {
    // A permission is a standing authorisation to sign with one account
    // (plus its auto-approve rules). Left behind, its walletIndex dangles
    // — for a deleted hardware account, at an index with no signer at all.
    fs.writeFileSync(
      path.join(tmpDir, 'dapp-permissions.json'),
      JSON.stringify({
        'https://swap.example': {
          origin: 'https://swap.example',
          walletIndex: 2,
          chainId: 1,
          autoApprove: { signing: true, transactions: [] },
        },
        'https://keep.example': {
          origin: 'https://keep.example',
          walletIndex: 0,
          chainId: 1,
          autoApprove: { signing: false, transactions: [] },
        },
      }, null, 2),
      'utf-8'
    );

    writeVaultMeta({
      activeWalletIndex: 0,
      derivedWallets: [
        { index: 0, name: 'Main Wallet', address: '0x0' },
        { index: 2, name: 'Trading Wallet', address: '0x2' },
      ],
    });

    await identityManager.deleteDerivedWallet(2);

    const stored = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'dapp-permissions.json'), 'utf-8')
    );
    expect(Object.keys(stored)).toEqual(['https://keep.example']);
  });
});

describe('identity-manager ledger accounts', () => {
  let tmpDir;
  let envSnapshot;
  let identityManager;

  const LEDGER_ADDRESS = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C';
  const LEDGER_PATH = "44'/60'/0'/0/0";
  const HARDWARE_INDEX_BASE = 1000000;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-manager-ledger-'));
    envSnapshot = snapshotEnv();
    process.env.FREEDOM_IDENTITY_DATA = tmpDir;
    identityManager = loadMainModule(require.resolve('./identity-manager'), {
      userDataDir: tmpDir,
      extraMocks: {
        // Vault locked — ledger ops must not need it.
        ...vaultBackendMocks(makeVaultBackendMock({ unlocked: false })),
      },
    }).mod;
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeVaultMeta(meta) {
    fs.writeFileSync(path.join(tmpDir, 'vault-meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
  }

  function readVaultMeta() {
    return JSON.parse(fs.readFileSync(path.join(tmpDir, 'vault-meta.json'), 'utf-8'));
  }

  function seedMainWallet() {
    writeVaultMeta({
      activeWalletIndex: 0,
      addresses: { userWallet: '0x0000000000000000000000000000000000000001' },
      derivedWallets: [
        { index: 0, name: 'Main Wallet', address: '0x0000000000000000000000000000000000000001' },
      ],
    });
  }

  test('addLedgerWallet appends a typed record with device address and path', async () => {
    seedMainWallet();

    const wallet = await identityManager.addLedgerWallet('My Stax', LEDGER_ADDRESS, LEDGER_PATH);

    expect(wallet).toEqual({
      index: HARDWARE_INDEX_BASE,
      name: 'My Stax',
      address: LEDGER_ADDRESS,
      type: 'ledger',
      path: LEDGER_PATH,
    });
    expect(readVaultMeta().derivedWallets).toHaveLength(2);
    expect(readVaultMeta().derivedWallets[1]).toMatchObject({ type: 'ledger', path: LEDGER_PATH });
  });

  test('addLedgerWallet auto-names and works with the vault locked', async () => {
    seedMainWallet();
    const wallet = await identityManager.addLedgerWallet('', LEDGER_ADDRESS, LEDGER_PATH);
    expect(wallet.name).toBe('Ledger 1');
  });

  test('addLedgerWallet rejects duplicates and bad input', async () => {
    seedMainWallet();
    await identityManager.addLedgerWallet('My Stax', LEDGER_ADDRESS, LEDGER_PATH);

    await expect(identityManager.addLedgerWallet('Again', LEDGER_ADDRESS.toLowerCase(), LEDGER_PATH))
      .rejects.toThrow(/already in your wallet list/);
    await expect(identityManager.addLedgerWallet('Bad', '0x123', LEDGER_PATH))
      .rejects.toThrow('Invalid Ledger account address');
    // Mixed-case address with a broken EIP-55 checksum must be rejected too
    await expect(identityManager.addLedgerWallet('Bad', LEDGER_ADDRESS.replace('9', 'a'), LEDGER_PATH))
      .rejects.toThrow('Invalid Ledger account address');
    await expect(identityManager.addLedgerWallet('Bad', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', ''))
      .rejects.toThrow('Missing derivation path');
  });

  test('getDerivedWallets returns the stored device address without derivation', async () => {
    seedMainWallet();
    await identityManager.addLedgerWallet('My Stax', LEDGER_ADDRESS, LEDGER_PATH);

    const wallets = await identityManager.getDerivedWallets();

    expect(wallets).toEqual([
      expect.objectContaining({ index: 0, type: 'mnemonic' }),
      expect.objectContaining({
        index: HARDWARE_INDEX_BASE,
        type: 'ledger',
        address: LEDGER_ADDRESS,
        path: LEDGER_PATH,
      }),
    ]);
  });

  test('getWalletRecord normalizes type and exposes the ledger path', async () => {
    seedMainWallet();
    await identityManager.addLedgerWallet('My Stax', LEDGER_ADDRESS, LEDGER_PATH);

    expect(identityManager.getWalletRecord(0)).toMatchObject({ type: 'mnemonic' });
    expect(identityManager.getWalletRecord(HARDWARE_INDEX_BASE)).toMatchObject({
      type: 'ledger',
      address: LEDGER_ADDRESS,
      path: LEDGER_PATH,
    });
    expect(identityManager.getWalletRecord(99)).toBeNull();
  });

  test('getActiveWalletAddress returns the device address for an active ledger account', async () => {
    seedMainWallet();
    const wallet = await identityManager.addLedgerWallet('My Stax', LEDGER_ADDRESS, LEDGER_PATH);
    await identityManager.setActiveWalletIndex(wallet.index);

    await expect(identityManager.getActiveWalletAddress()).resolves.toBe(LEDGER_ADDRESS);
  });

  test('addRemoteWallet appends a pathless typed record and auto-names', async () => {
    seedMainWallet();

    const wallet = await identityManager.addRemoteWallet('', LEDGER_ADDRESS);

    expect(wallet).toEqual({
      index: HARDWARE_INDEX_BASE,
      name: 'Phone 1',
      address: LEDGER_ADDRESS,
      type: 'remote',
    });
    expect(readVaultMeta().derivedWallets[1]).toEqual(wallet);
  });

  test('addRemoteWallet rejects bad addresses and duplicates across account types', async () => {
    seedMainWallet();
    await identityManager.addLedgerWallet('My Stax', LEDGER_ADDRESS, LEDGER_PATH);

    await expect(identityManager.addRemoteWallet('Bad', '0x123'))
      .rejects.toThrow('Invalid Phone account address');
    // The same address already added as a Ledger account is still a duplicate.
    await expect(identityManager.addRemoteWallet('Again', LEDGER_ADDRESS.toLowerCase()))
      .rejects.toThrow(/already in your wallet list/);
  });

  test('remote accounts behave like device accounts across the record seams', async () => {
    seedMainWallet();
    const wallet = await identityManager.addRemoteWallet('My Phone', LEDGER_ADDRESS);

    expect(identityManager.getWalletRecord(wallet.index)).toMatchObject({
      type: 'remote',
      address: LEDGER_ADDRESS,
    });

    await identityManager.setActiveWalletIndex(wallet.index);
    await expect(identityManager.getActiveWalletAddress()).resolves.toBe(LEDGER_ADDRESS);

    const wallets = await identityManager.getDerivedWallets();
    expect(wallets[1]).toMatchObject({ type: 'remote', address: LEDGER_ADDRESS });
  });
});

describe('identity-manager safe accounts', () => {
  let tmpDir;
  let envSnapshot;
  let identityManager;
  let ownerIndexes;

  const SAFE_ADDRESS = '0x41aD4887971f90BB3fE4d83eCa65177281283261';
  const LEDGER_ADDRESS = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C';
  const SALT = '20260710';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-manager-safe-'));
    envSnapshot = snapshotEnv();
    process.env.FREEDOM_IDENTITY_DATA = tmpDir;
    identityManager = loadMainModule(require.resolve('./identity-manager'), {
      userDataDir: tmpDir,
      extraMocks: {
        // Vault locked — safe ops must not need it.
        ...vaultBackendMocks(makeVaultBackendMock({ unlocked: false })),
      },
    }).mod;
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeVaultMeta(meta) {
    fs.writeFileSync(path.join(tmpDir, 'vault-meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
  }

  function readVaultMeta() {
    return JSON.parse(fs.readFileSync(path.join(tmpDir, 'vault-meta.json'), 'utf-8'));
  }

  async function seedOwners() {
    writeVaultMeta({
      activeWalletIndex: 0,
      addresses: { userWallet: '0x0000000000000000000000000000000000000001' },
      derivedWallets: [
        { index: 0, name: 'Main Wallet', address: '0x0000000000000000000000000000000000000001' },
      ],
    });
    const ledger = await identityManager.addLedgerWallet(
      'My Stax',
      LEDGER_ADDRESS,
      "44'/60'/0'/0/0"
    );
    ownerIndexes = [0, ledger.index];
  }

  const addSafe = (name = 'Joint', overrides = {}) =>
    identityManager.addSafeWallet(name, {
      address: SAFE_ADDRESS,
      owners: ownerIndexes,
      threshold: 1,
      saltNonce: SALT,
      ...overrides,
    });

  test('addSafeWallet appends a typed record with init params frozen in vault-meta', async () => {
    await seedOwners();

    const wallet = await addSafe();

    expect(wallet).toEqual({
      index: 1000001,
      name: 'Joint',
      address: SAFE_ADDRESS,
      type: 'safe',
      owners: ownerIndexes,
      threshold: 1,
      saltNonce: SALT,
      deployed: {},
    });
    expect(readVaultMeta().derivedWallets[2]).toMatchObject({
      type: 'safe',
      owners: ownerIndexes,
      threshold: 1,
      saltNonce: SALT,
    });
  });

  test('addSafeWallet auto-names and works with the vault locked', async () => {
    await seedOwners();
    const wallet = await addSafe('');
    expect(wallet.name).toBe('Safe 1');
  });

  test('addSafeWallet enforces the 1/2 and 2/3 presets only', async () => {
    await seedOwners();
    const phone = await identityManager.addRemoteWallet(
      'My Phone',
      '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
    );
    const threeOwners = [...ownerIndexes, phone.index];

    // 2/2 is deliberately not offered (lose either device → bricked)
    await expect(addSafe('Bad', { threshold: 2 })).rejects.toThrow(/1 of 2 or 2 of 3/);
    await expect(addSafe('Bad', { owners: threeOwners, threshold: 3 })).rejects.toThrow(/1 of 2 or 2 of 3/);
    await expect(addSafe('Bad', { owners: [0], threshold: 1 })).rejects.toThrow(/1 of 2 or 2 of 3/);
    // valid 2/3
    await expect(addSafe('Resilient', { owners: threeOwners, threshold: 2 })).resolves.toMatchObject({
      threshold: 2,
    });
  });

  test('addSafeWallet rejects unknown, duplicate, and safe owners', async () => {
    await seedOwners();

    await expect(addSafe('Bad', { owners: [0, 99] })).rejects.toThrow(/99/);
    await expect(addSafe('Bad', { owners: [0, 0] })).rejects.toThrow(/duplicate/i);

    const safe = await addSafe();
    await expect(
      addSafe('Nested', {
        address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        owners: [0, safe.index],
      })
    ).rejects.toThrow(/cannot own/i);
  });

  test('record seams expose the safe fields', async () => {
    await seedOwners();
    const wallet = await addSafe();

    expect(identityManager.getWalletRecord(wallet.index)).toMatchObject({
      type: 'safe',
      address: SAFE_ADDRESS,
      owners: ownerIndexes,
      threshold: 1,
      saltNonce: SALT,
      deployed: {},
    });

    const wallets = await identityManager.getDerivedWallets();
    expect(wallets[2]).toMatchObject({ type: 'safe', owners: ownerIndexes, threshold: 1 });

  });

  test('markSafeDeployed persists per-chain deployment state', async () => {
    await seedOwners();
    const wallet = await addSafe();

    await identityManager.markSafeDeployed(wallet.index, 100);

    expect(identityManager.getWalletRecord(wallet.index).deployed).toEqual({ 100: true });
    expect(readVaultMeta().derivedWallets[2].deployed).toEqual({ 100: true });

    await expect(identityManager.markSafeDeployed(0, 100)).rejects.toThrow(/not a Safe/i);
  });

  test('an owner of a safe cannot be deleted while the safe exists', async () => {
    await seedOwners();
    const safe = await addSafe();

    await expect(identityManager.deleteDerivedWallet(ownerIndexes[1])).rejects.toThrow(/owner of "Joint"/);

    // deleting the safe frees its owners
    await identityManager.deleteDerivedWallet(safe.index);
    await expect(identityManager.deleteDerivedWallet(ownerIndexes[1])).resolves.toBeUndefined();
  });

  test('deleting a Safe discards its pending SafeTx and live message session', async () => {
    await seedOwners();
    const safe = await addSafe();

    // Half-signed leftovers are keyed by the Safe's WALLET INDEX — they
    // must go with the record, or a later account reusing the index
    // would inherit (or be blocked by) them.
    const { setPending, getPending } = require('./wallet/safe/pending-store');
    const messageSessions = require('./wallet/safe/message-sessions');
    setPending(safe.index, { safeTxHash: '0xdead', threshold: 1, signatures: [] });
    const detach = jest.fn();
    messageSessions.setSession(safe.index, { token: 'session-token', detach });

    await identityManager.deleteDerivedWallet(safe.index);

    expect(getPending(safe.index)).toBeNull();
    expect(messageSessions.getSession(safe.index)).toBeNull();
    expect(detach).toHaveBeenCalled(); // webContents lifecycle listeners unhooked
    // the on-disk store no longer carries the entry either
    const pendingFile = path.join(tmpDir, 'safe-pending.json');
    expect(JSON.parse(fs.readFileSync(pendingFile, 'utf-8'))).toEqual({});
  });

  test('an account created after deleting the highest-index Safe starts with a clean slate', async () => {
    await seedOwners();
    const safe = await addSafe(); // highest index in the vault

    const { setPending, getPending } = require('./wallet/safe/pending-store');
    setPending(safe.index, { safeTxHash: '0xdead', threshold: 1, signatures: [] });

    await identityManager.deleteDerivedWallet(safe.index);

    // Device-account indexes are monotonic and never reused, even after a
    // highest-index Safe is deleted.
    const successor = await identityManager.addRemoteWallet(
      'New Phone',
      '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
    );
    expect(successor.index).toBe(safe.index + 1);
    expect(getPending(successor.index)).toBeNull();
    expect(require('./wallet/safe/message-sessions').getSession(successor.index)).toBeNull();
  });
});

/**
 * A wallet's `index` is both the account id every persisted reference
 * stores (dApp permissions, Swarm publisher identities, activeWalletIndex)
 * and — for mnemonic accounts — the BIP-44 account index the key is
 * derived at. Hardware accounts must therefore never take an index out of
 * the mnemonic range, and a freed hardware index must never be handed to
 * another device account: either would silently rebind persisted
 * references to a different address and signing backend, and squatting a
 * derivation index strands whatever the mnemonic account there holds.
 */
describe('identity-manager wallet index allocation', () => {
  let tmpDir;
  let envSnapshot;
  let identityManager;

  const LEDGER_A = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C';
  const LEDGER_B = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const LEDGER_PATH = "44'/60'/0'/0/0";
  const HARDWARE_INDEX_BASE = 1000000;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-manager-index-'));
    envSnapshot = snapshotEnv();
    process.env.FREEDOM_IDENTITY_DATA = tmpDir;
    identityManager = loadMainModule(require.resolve('./identity-manager'), {
      userDataDir: tmpDir,
      extraMocks: {
        // Unlocked: the core derives `0xderived<index>`.
        ...vaultBackendMocks(makeVaultBackendMock()),
        [require.resolve('./swarm/feed-store')]: () => ({
          getEthereumWalletIdentityReferences: jest.fn(() => []),
        }),
      },
    }).mod;
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function readVaultMeta() {
    return JSON.parse(fs.readFileSync(path.join(tmpDir, 'vault-meta.json'), 'utf-8'));
  }

  function seedMainWallet() {
    fs.writeFileSync(
      path.join(tmpDir, 'vault-meta.json'),
      JSON.stringify({
        activeWalletIndex: 0,
        addresses: { userWallet: '0xderived0' },
        derivedWallets: [{ index: 0, name: 'Main Wallet', address: '0xderived0' }],
      }, null, 2),
      'utf-8'
    );
  }

  test('a ledger never takes a freed mnemonic derivation index', async () => {
    seedMainWallet();
    const second = await identityManager.createDerivedWallet('Wallet 2');
    expect(second.index).toBe(1);

    await identityManager.deleteDerivedWallet(1);
    const ledger = await identityManager.addLedgerWallet('', LEDGER_A, LEDGER_PATH);

    expect(ledger.index).toBe(HARDWARE_INDEX_BASE);

    // Derivation index 1 is still mintable, so funds sent to it before the
    // delete stay reachable.
    const recreated = await identityManager.createDerivedWallet('Wallet 2 again');
    expect(recreated.index).toBe(1);
    expect(recreated.address).toBe(second.address);
    expect(identityManager.getWalletRecord(1)).toMatchObject({ type: 'mnemonic' });
  });

  test('mnemonic accounts keep allocating from the low range once a ledger exists', async () => {
    seedMainWallet();
    await identityManager.addLedgerWallet('', LEDGER_A, LEDGER_PATH);

    const next = await identityManager.createDerivedWallet('Wallet 2');

    expect(next.index).toBe(1);
    expect(readVaultMeta().derivedWallets.map((wallet) => wallet.index))
      .toEqual([0, HARDWARE_INDEX_BASE, 1]);
  });

  test('a deleted ledger does not hand its index to the next device account', async () => {
    seedMainWallet();
    const first = await identityManager.addLedgerWallet('', LEDGER_A, LEDGER_PATH);
    await identityManager.deleteDerivedWallet(first.index);

    const second = await identityManager.addLedgerWallet('', LEDGER_B, LEDGER_PATH);

    expect(second.index).toBe(HARDWARE_INDEX_BASE + 1);
    expect(readVaultMeta().nextHardwareWalletIndex).toBe(HARDWARE_INDEX_BASE + 2);
  });

  test('stays above ledger indexes already on disk when the counter is missing', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'vault-meta.json'),
      JSON.stringify({
        activeWalletIndex: 0,
        addresses: { userWallet: '0xderived0' },
        derivedWallets: [
          { index: 0, name: 'Main Wallet', address: '0xderived0' },
          {
            index: HARDWARE_INDEX_BASE + 4,
            name: 'Ledger 1',
            address: LEDGER_A,
            type: 'ledger',
            path: LEDGER_PATH,
          },
        ],
      }, null, 2),
      'utf-8'
    );

    const added = await identityManager.addLedgerWallet('', LEDGER_B, LEDGER_PATH);

    expect(added.index).toBe(HARDWARE_INDEX_BASE + 5);
  });

  test('skips a legacy low-index ledger when minting a mnemonic wallet', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'vault-meta.json'),
      JSON.stringify({
        activeWalletIndex: 0,
        addresses: { userWallet: '0xderived0' },
        derivedWallets: [
          { index: 0, name: 'Main Wallet', address: '0xderived0' },
          { index: 1, name: 'Ledger 1', address: LEDGER_A, type: 'ledger', path: LEDGER_PATH },
        ],
      }, null, 2),
      'utf-8'
    );

    const next = await identityManager.createDerivedWallet('Wallet 2');

    expect(next.index).toBe(2);
    expect(identityManager.getWalletRecord(1)).toMatchObject({ type: 'ledger' });
  });
});

/**
 * Regression guard for issue #90: Bee's restart after (re)injection is owned by
 * injectBeeIdentity via the lifecycle hook (stop → wipe → start), so Bee must
 * NOT also be reported in `needsRestart` — otherwise the renderer restarts it a
 * second time. Radicle has no lifecycle hook and must still be reported. Native
 * IPFS uses ephemeral identities for retrieval today, so it must not report a
 * restart or a durable injected identity.
 *
 * The lazily-loaded `./identity` module is mocked so the test exercises the
 * orchestration/branch logic without real key derivation or node binaries.
 */
describe('injectAllIdentities restart reporting (issue #90)', () => {
  let root;
  let dataDirs;
  let envSnapshot;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-mgr-'));
    dataDirs = {
      identity: path.join(root, 'identity'),
      bee: path.join(root, 'bee'),
      ipfs: path.join(root, 'ipfs'),
      radicle: path.join(root, 'radicle'),
    };
    for (const dir of Object.values(dataDirs)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    envSnapshot = snapshotEnv();
    process.env.FREEDOM_IDENTITY_DATA = dataDirs.identity;
    process.env.FREEDOM_ANT_DATA = dataDirs.bee;
    process.env.FREEDOM_IPFS_DATA = dataDirs.ipfs;
    process.env.FREEDOM_RADICLE_DATA = dataDirs.radicle;
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
    if (root && fs.existsSync(root)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function loadIdentityManager(
    dataDirsForLoad,
    fsOffloadOverrides = null,
    backend = makeVaultBackendMock()
  ) {
    return loadMainModule(require.resolve('./identity-manager'), {
      extraMocks: {
        ...vaultBackendMocks(backend),
        ...(fsOffloadOverrides
          ? {
              [require.resolve('./fs-offload')]: () => ({
                ...jest.requireActual('./fs-offload'),
                ...fsOffloadOverrides,
              }),
            }
          : {}),
      },
      userDataDir: dataDirsForLoad.identity,
    }).mod;
  }

  function seedBeeInjected() {
    fs.mkdirSync(path.join(dataDirs.bee, 'keys'), { recursive: true });
    fs.writeFileSync(path.join(dataDirs.bee, 'keys', 'swarm.key'), '{}');
  }

  function seedIpfsIdentityMetadata() {
    fs.writeFileSync(
      path.join(dataDirs.identity, 'ipfs-identity.json'),
      JSON.stringify({ peerId: 'QmExisting', activeWithNativeNode: false }, null, 2)
    );
  }

  function seedRadicleInjected() {
    fs.mkdirSync(path.join(dataDirs.radicle, 'keys'), { recursive: true });
    fs.writeFileSync(path.join(dataDirs.radicle, 'keys', 'radicle'), 'key');
  }

  test('force reinjection reports no node for restart: both restart themselves (R-8)', async () => {
    // Bee/Radicle are injected. A stale IPFS identity metadata file from older
    // builds must be ignored because native freedom-ipfs now reports ephemeral
    // identity mode instead of a prepared durable PeerID.
    seedBeeInjected();
    seedIpfsIdentityMetadata();
    seedRadicleInjected();

    const mgr = loadIdentityManager(dataDirs);
    await mgr.createNewVault('password-123');
    const withStopped = jest.fn((work) => work());
    mgr.setRadicleLifecycle({ withStopped });

    const results = await mgr.injectAllIdentities('FreedomBrowser', true);

    expect(results.needsRestart).toEqual([]);
    expect(results.bee.reinjected).toBe(true);
    expect(results.radicle.reinjected).toBe(true);
    // Radicle's restart is the section's (withRadicleStopped restarts it).
    expect(withStopped).toHaveBeenCalledTimes(1);
    expect(results.ipfs).toMatchObject({
      mode: 'ephemeral',
      active: false,
      peerId: null,
      stableIdentitySupported: false,
    });
  });

  // R-8 on integration: the core writes the key (vaultBackend.writeNodeIdentity),
  // so these script the core's mock instead of the JS identity module.
  async function loadForRekey() {
    seedRadicleInjected();
    const storage = path.join(dataDirs.radicle, 'storage');
    fs.mkdirSync(storage, { recursive: true });
    const keyPath = path.join(dataDirs.radicle, 'keys', 'radicle');
    const backend = makeVaultBackendMock();
    const mgr = loadIdentityManager(dataDirs, null, backend);
    const guard = require('./core/node-identity-guard');
    guard.setStartupRecovery(null);
    await mgr.createNewVault('password-123');
    backend.writeNodeIdentity.mockClear();
    return { mgr, backend, guard, storage, keyPath };
  }

  test('a Radicle re-key stops the node first, then wipes and writes the key (R-8)', async () => {
    const { mgr, backend, guard, storage } = await loadForRekey();
    const steps = [];
    const write = backend.writeNodeIdentity.getMockImplementation();
    backend.writeNodeIdentity.mockImplementation(async (spec, ...rest) => {
      steps.push(`key written (storage ${fs.existsSync(storage) ? 'kept' : 'wiped'})`);
      return write(spec, ...rest);
    });
    mgr.setRadicleLifecycle({
      withStopped: async (work) => {
        steps.push('stopped');
        try {
          return await work();
        } finally {
          steps.push(`restart (${guard.nodeBlockReason('radicle') ? 'blocked' : 'allowed'})`);
        }
      },
    });

    await expect(mgr.injectRadicleIdentity('Alias')).resolves.toEqual({
      did: 'did:key:zTest',
    });
    expect(steps).toEqual(['stopped', 'key written (storage wiped)', 'restart (allowed)']);
    expect(backend.writeNodeIdentity).toHaveBeenCalledTimes(1);
    expect(backend.writeNodeIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ node: 'radicle', alias: 'Alias' }),
      expect.any(String)
    );
  });

  test('a Radicle re-key wipes nothing before the stop completes (R-8)', async () => {
    const { mgr, backend, storage } = await loadForRekey();
    let finishStop;
    mgr.setRadicleLifecycle({
      withStopped: async (work) => {
        await new Promise((resolve) => {
          finishStop = resolve;
        });
        return work();
      },
    });

    const injecting = mgr.injectRadicleIdentity('Alias');
    for (let i = 0; i < 50 && !finishStop; i += 1) await new Promise((r) => setImmediate(r));
    expect(finishStop).toEqual(expect.any(Function));
    // Anything that ran outside the section has had its turn by now.
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
    expect(fs.existsSync(storage)).toBe(true);
    expect(backend.writeNodeIdentity).not.toHaveBeenCalled();

    finishStop();
    await expect(injecting).resolves.toEqual({ did: 'did:key:zTest' });
    expect(fs.existsSync(storage)).toBe(false);
    expect(backend.writeNodeIdentity).toHaveBeenCalledTimes(1);
  });

  test('a Radicle re-key whose node will not stop leaves storage/ and the key (R-8)', async () => {
    const { mgr, backend, guard, storage, keyPath } = await loadForRekey();
    mgr.setRadicleLifecycle({
      withStopped: async () => {
        throw new Error('The Radicle node did not stop, so its data was not reset');
      },
    });

    await expect(mgr.injectRadicleIdentity('Alias')).rejects.toThrow('did not stop');
    expect(fs.existsSync(storage)).toBe(true);
    expect(fs.readFileSync(keyPath, 'utf8')).toBe('key');
    expect(backend.writeNodeIdentity).not.toHaveBeenCalled();
    // Nothing was wiped, so nothing blocks the node.
    expect(guard.nodeBlockReason('radicle')).toBeNull();
  });

  test('a failed Radicle key write keeps the node blocked for the restart (R-8)', async () => {
    const { mgr, backend, guard } = await loadForRekey();
    backend.writeNodeIdentity.mockResolvedValueOnce({ status: 'corrupt', reconciled: true });
    let atRestart;
    mgr.setRadicleLifecycle({
      withStopped: async (work) => {
        try {
          return await work();
        } finally {
          atRestart = guard.nodeBlockReason('radicle');
        }
      },
    });

    await expect(mgr.injectRadicleIdentity('Alias')).rejects.toThrow('(corrupt)');
    expect(atRestart).toMatch(/set up node identities again/);
  });

  test('first-time injection reports nothing for restart', async () => {
    const mgr = loadIdentityManager(dataDirs);
    await mgr.createNewVault('password-123');

    const results = await mgr.injectAllIdentities('FreedomBrowser', false);

    expect(results.needsRestart).toEqual([]);
    expect(results.ipfs).toMatchObject({
      mode: 'ephemeral',
      active: false,
      peerId: null,
      stableIdentitySupported: false,
    });
  });

  // #513: an older profile's Radicle home is carried into the short home
  // asynchronously. Injection must wait for that to land before judging
  // whether Radicle already has an identity — otherwise it reads "missing",
  // re-injects, and wipes the node/cobs/storage that were on their way in.
  test('waits for a pending Radicle home migration before judging injection', async () => {
    const mgr = loadMainModule(require.resolve('./identity-manager'), {
      extraMocks: {
        ...vaultBackendMocks(makeVaultBackendMock()),
        [require.resolve('./profile-paths')]: () => ({
          ...jest.requireActual('./profile-paths'),
          prepareRadicleDataDir: async () => {
            await new Promise((r) => setTimeout(r, 10));
            // The migration lands: identity and seeded storage arrive.
            seedRadicleInjected();
            fs.mkdirSync(path.join(dataDirs.radicle, 'storage', 'repo'), { recursive: true });
            return dataDirs.radicle;
          },
        }),
      },
      userDataDir: dataDirs.identity,
    }).mod;
    await mgr.createNewVault('password-123');

    const results = await mgr.injectAllIdentities('FreedomBrowser', false);

    expect(results.radicle).toMatchObject({ alreadyInjected: true });
    expect(fs.existsSync(path.join(dataDirs.radicle, 'storage', 'repo'))).toBe(true);
  });

  test('status reports native IPFS ephemeral identity mode', async () => {
    seedIpfsIdentityMetadata();

    const mgr = loadIdentityManager(dataDirs);
    await mgr.createNewVault('password-123');

    await expect(mgr.getIdentityStatus()).resolves.toMatchObject({
      ipfsInjected: false,
      ipfsIdentityPrepared: false,
      ipfsIdentityMode: 'ephemeral',
      ipfsStableIdentitySupported: false,
      ipfsNativeIdentityActive: false,
      addresses: {
        ipfsPeerId: null,
      },
    });
  });

  // antd self-generates identity.json + signing.key when it starts on a data
  // dir without an injected keystore (e.g. auto-started at launch before the
  // vault was unlocked). If the wipe leaves those behind, antd keeps the
  // throwaway identity instead of the swarm.key we inject — running under the
  // wrong wallet (no stamps/chequebook). The wipe must remove them while
  // preserving the keystore that injection is about to (re)write.
  test('wipeStaleBeeState removes antd self-generated identity but keeps swarm.key', async () => {
    const beeDir = dataDirs.bee;
    fs.mkdirSync(path.join(beeDir, 'keys'), { recursive: true });
    fs.mkdirSync(path.join(beeDir, 'statestore'), { recursive: true });
    fs.writeFileSync(path.join(beeDir, 'statestore', 'CURRENT'), 'x');
    fs.writeFileSync(path.join(beeDir, 'identity.json'), '{"eth":"0xthrowaway"}');
    fs.writeFileSync(path.join(beeDir, 'signing.key'), 'throwaway');
    fs.writeFileSync(path.join(beeDir, 'keys', 'swarm.key'), '{}');
    fs.writeFileSync(path.join(beeDir, 'keys', 'libp2p_v2.key'), 'old');

    const mgr = loadIdentityManager(dataDirs);
    const beeWasRunning = await mgr.wipeStaleBeeState(beeDir);

    expect(beeWasRunning).toBe(false);
    expect(fs.existsSync(path.join(beeDir, 'identity.json'))).toBe(false);
    expect(fs.existsSync(path.join(beeDir, 'signing.key'))).toBe(false);
    expect(fs.existsSync(path.join(beeDir, 'statestore'))).toBe(false);
    expect(fs.existsSync(path.join(beeDir, 'keys', 'libp2p_v2.key'))).toBe(false);
    // The keystore is preserved — injection rewrites it immediately after.
    expect(fs.existsSync(path.join(beeDir, 'keys', 'swarm.key'))).toBe(true);
  });

  // #513: the Windows EPERM/EBUSY retry loop (issue #90) used to Atomics.wait
  // between attempts, freezing the main thread for up to ~4.5 s. The back-off
  // is now an async delay, and the deletes themselves run in a worker.
  test('wipeStaleBeeState retries a locked dir with an async back-off', async () => {
    const beeDir = dataDirs.bee;
    fs.mkdirSync(path.join(beeDir, 'statestore'), { recursive: true });
    fs.writeFileSync(path.join(beeDir, 'statestore', 'LOCK'), 'x');

    const realOffload = jest.requireActual('./fs-offload');
    let lockedAttempts = 0;
    const removePath = jest.fn((target, opts) => {
      if (target.endsWith('statestore') && lockedAttempts < 2) {
        lockedAttempts += 1;
        return Promise.reject(Object.assign(new Error('locked'), { code: 'EPERM' }));
      }
      return realOffload.removePath(target, opts);
    });
    const rmSyncSpy = jest.spyOn(fs, 'rmSync');
    let ticks = 0;
    const ticker = setInterval(() => {
      ticks += 1;
    }, 10);

    try {
      const mgr = loadIdentityManager(dataDirs, { removePath });
      await mgr.wipeStaleBeeState(beeDir);
    } finally {
      clearInterval(ticker);
      rmSyncSpy.mockRestore();
    }

    expect(lockedAttempts).toBe(2);
    expect(fs.existsSync(path.join(beeDir, 'statestore'))).toBe(false);
    expect(rmSyncSpy).not.toHaveBeenCalled();
    // Back-off was 100 ms + 200 ms; the event loop kept running through it.
    expect(ticks).toBeGreaterThan(10);
  });

  test('wipeStaleBeeState surfaces a still-locked dir after the retry budget', async () => {
    const beeDir = dataDirs.bee;
    fs.mkdirSync(path.join(beeDir, 'statestore'), { recursive: true });
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const rmSpy = jest.fn(() =>
      Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' }))
    );

    try {
      const mgr = loadIdentityManager(dataDirs, { removePath: rmSpy });
      const wiping = mgr.wipeStaleBeeState(beeDir);
      let done = false;
      const settled = expect(wiping).rejects.toThrow(/still in use/).finally(() => {
        done = true;
      });
      // The back-off timers are scheduled after real (un-faked) fs I/O, so keep
      // advancing until the wipe gives up rather than flushing once.
      for (let i = 0; i < 200 && !done; i += 1) {
        await jest.advanceTimersByTimeAsync(100);
        await new Promise((r) => setImmediate(r));
      }
      await settled;
      expect(rmSpy).toHaveBeenCalledTimes(10);
    } finally {
      jest.useRealTimers();
    }
    expect(fs.existsSync(path.join(beeDir, 'statestore'))).toBe(true);
  });
});

// #946's cases on integration: the core writes the keystore and config.yaml
// (vaultBackend.writeNodeIdentity), so these script the core's mock instead
// of the JS identity module, over a real data directory and the real
// keystore module.
describe('Swarm keystore password (K-3)', () => {
  let root;
  let envSnapshot;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-keystore-'));
    envSnapshot = snapshotEnv();
    process.env.FREEDOM_IDENTITY_DATA = path.join(root, 'identity');
    process.env.FREEDOM_ANT_DATA = path.join(root, 'ant');
    process.env.FREEDOM_IPFS_DATA = path.join(root, 'ipfs');
    process.env.FREEDOM_RADICLE_DATA = path.join(root, 'radicle');
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    restoreEnv(envSnapshot);
    fs.rmSync(root, { recursive: true, force: true });
  });

  // The vault's derived Swarm account, and another identity's.
  const VAULT_BEE = '0x' + 'b2'.repeat(20);
  const OTHER_BEE = '0x' + 'a1'.repeat(20);
  const antDir = () => path.join(root, 'ant');
  const swarmKeyPath = () => path.join(antDir(), 'keys', 'swarm.key');
  const sealPath = () => path.join(antDir(), 'keys', 'keystore-password.sealed');
  const configPath = () => path.join(antDir(), 'config.yaml');
  const statestore = () => path.join(antDir(), 'statestore');
  const pssKey = () => path.join(antDir(), 'keys', 'pss.key');
  // A Web3 v3 keystore's unencrypted `address` (no 0x, lowercase); the
  // password it was "encrypted" with is recorded so a test can check the
  // pair on disk.
  const writeKeystore = (address, password = 'lost-password') => {
    fs.mkdirSync(path.dirname(swarmKeyPath()), { recursive: true });
    fs.writeFileSync(
      swarmKeyPath(),
      JSON.stringify({ address: address.slice(2).toLowerCase(), version: 3, password })
    );
  };
  const keystoreOnDisk = () => JSON.parse(fs.readFileSync(swarmKeyPath(), 'utf8'));
  const configPassword = () =>
    fs.readFileSync(configPath(), 'utf8').match(/^password: (.+)$/m)?.[1] ?? null;
  // A seal of the current keystore's password, as a main release with #946
  // left it (keys/keystore-password.sealed, record version 2).
  const writeSeal = (password) => {
    const keystoreSha256 = require('crypto')
      .createHash('sha256')
      .update(fs.readFileSync(swarmKeyPath()))
      .digest('hex');
    fs.writeFileSync(
      sealPath(),
      JSON.stringify({
        version: 2,
        ciphertext: Buffer.from(`v11${password}`).toString('base64'),
        keystoreSha256,
      }),
      { mode: 0o600 }
    );
  };
  // Stale node state a re-key with a new key wipes, and a recovery (same
  // key) keeps.
  const writeNodeState = () => {
    fs.mkdirSync(statestore(), { recursive: true });
    fs.mkdirSync(path.dirname(pssKey()), { recursive: true });
    fs.writeFileSync(pssKey(), 'pss');
  };

  /**
   * identity-manager on the core's mock. Its Bee write is the core's
   * nodes.write_identity as main sees it: keys/swarm.key under a fresh
   * random password, and config.yaml holding that password, both installed.
   * `hold(n)` is awaited before the n-th write lands.
   */
  function load(safeStorage, { hold = null } = {}) {
    const backend = makeVaultBackendMock();
    const addresses = backend.addresses.getMockImplementation();
    backend.addresses.mockImplementation(async (request) => ({
      ...(await addresses(request)),
      bee_wallet: VAULT_BEE,
    }));
    const written = [];
    backend.writeNodeIdentity.mockImplementation(async (spec) => {
      if (spec.node !== 'bee') return { status: 'installed', did: 'did:key:zTest', node_id: 'zTest' };
      const password = require('crypto').randomBytes(32).toString('hex');
      written.push(password);
      if (hold) await hold(written.length);
      writeKeystore(VAULT_BEE, password);
      fs.writeFileSync(
        configPath(),
        `# Bee Configuration (generated by identity injection)\napi-addr: 127.0.0.1:${spec.api_port}\n` +
          `p2p-addr: :${spec.p2p_port}\ndata-dir: ${spec.data_dir}\npassword: ${password}\n`,
        { mode: 0o600 }
      );
      return { status: 'installed', address: VAULT_BEE };
    });
    const { mod } = loadMainModule(require.resolve('./identity-manager'), {
      userDataDir: path.join(root, 'identity'),
      electronOverrides: { safeStorage },
      extraMocks: {
        ...vaultBackendMocks(backend),
        [require.resolve('./profile-resolver')]: () => ({ getActiveProfile: jest.fn(() => null) }),
        // The real modules: mocks an earlier describe registered stay registered.
        [require.resolve('./profile-paths')]: () => jest.requireActual('./profile-paths'),
        [require.resolve('./fs-offload')]: () => jest.requireActual('./fs-offload'),
      },
    });
    const guard = require('./core/node-identity-guard');
    guard.setStartupRecovery(null);
    return { mod, backend, written, guard, keystore: require('./swarm/ant-keystore-password') };
  }

  const keychain = () => ({
    isAsyncEncryptionAvailable: jest.fn(async () => true),
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: jest.fn(async (text) => Buffer.from(`v11${text}`)),
    decryptStringAsync: jest.fn(async (buffer) => ({
      result: buffer.toString().slice(3),
      shouldReEncrypt: false,
    })),
  });
  const noKeyring = () => ({ ...keychain(), isAsyncEncryptionAvailable: jest.fn(async () => false) });

  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  const beeWrite = () => ({ node: 'bee', data_dir: antDir(), api_port: 1633, p2p_port: 1634 });
  const gate = () => {
    let release;
    const held = new Promise((resolve) => (release = resolve));
    return { held, release: () => release() };
  };

  // Step 2 of the audit: the core's password goes into config.yaml; the next
  // node start seals it (ant-manager ensureConfig's migration).
  test.each([
    ['with a keyring', keychain],
    ['without one', noKeyring],
  ])(
    'injection (%s) seals nothing, keeps the core password in config.yaml and drops the old seal',
    async (_label, storage) => {
      writeKeystore(VAULT_BEE, 'old-password');
      writeSeal('old-password');
      const safeStorage = storage();
      const { mod, backend, written } = load(safeStorage);
      await mod.createNewVault('password123');
      await mod.injectBeeIdentity();

      expect(backend.writeNodeIdentity).toHaveBeenCalledWith(beeWrite(), expect.any(String));
      expect(keystoreOnDisk().password).toBe(written[0]);
      expect(configPassword()).toBe(written[0]);
      // The old keystore's seal is gone, and nothing new is sealed.
      expect(fs.existsSync(sealPath())).toBe(false);
      expect(safeStorage.encryptStringAsync).not.toHaveBeenCalled();
    }
  );

  // Step 1: the wipe and the write run under the keystore lock, so a node
  // start's config step that holds it (ant-manager ensureConfig, awaiting
  // the keychain) finishes first.
  test('an injection waits for a keystore operation in progress before it wipes or writes', async () => {
    writeKeystore(VAULT_BEE, 'old-password');
    writeNodeState();
    const { mod, backend, keystore, guard } = load(keychain());
    const stop = jest.fn(async () => true);
    mod.setBeeLifecycle({ stop, start: jest.fn(async () => {}) });
    await mod.createNewVault('password123');

    const lock = gate();
    const startConfig = keystore.withKeystoreLock(antDir(), () => lock.held);
    const injection = mod.injectBeeIdentity();
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 5));

    // Blocked, but nothing stopped, wiped or written while the lock is held.
    expect(guard.nodeBlockReason('bee')).not.toBeNull();
    expect(stop).not.toHaveBeenCalled();
    expect(backend.writeNodeIdentity).not.toHaveBeenCalled();
    expect(fs.existsSync(statestore())).toBe(true);
    expect(fs.existsSync(pssKey())).toBe(true);

    lock.release();
    await startConfig;
    await injection;
    expect(stop).toHaveBeenCalledTimes(1);
    expect(backend.writeNodeIdentity).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(statestore())).toBe(false);
    expect(guard.nodeBlockReason('bee')).toBeNull();
  });

  test("a node start's config step waits for the injection's write and its seal removal", async () => {
    writeKeystore(VAULT_BEE, 'old-password');
    writeSeal('old-password');
    const write = gate();
    const { mod, keystore, written } = load(keychain(), { hold: () => write.held });
    await mod.createNewVault('password123');

    const injection = mod.injectBeeIdentity();
    await settle();
    const seen = [];
    const startConfig = keystore.withKeystoreLock(antDir(), () => {
      seen.push({ password: keystoreOnDisk().password, sealed: fs.existsSync(sealPath()) });
    });
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(seen).toEqual([]);

    write.release();
    await injection;
    await startConfig;
    // It saw the new keystore, with no seal of the old one beside it.
    expect(seen).toEqual([{ password: written[0], sealed: false }]);
  });

  test('an unlock re-encrypts the keystore the node could not open, then starts it', async () => {
    writeKeystore(VAULT_BEE);
    writeSeal('lost-password');
    writeNodeState();
    const { mod, backend, written, guard } = load(keychain());
    let needed = true;
    const stop = jest.fn(async () => true);
    const start = jest.fn(async () => {
      needed = false;
    });
    mod.setBeeLifecycle({ stop, start, needsKeyReinjection: () => needed });

    await mod.unlockVault('password123');
    await settle();

    // The core writes the same derived key with a new password; nothing is
    // wiped, the seal that would not open is gone, the node starts again.
    expect(backend.writeNodeIdentity).toHaveBeenCalledTimes(1);
    expect(backend.writeNodeIdentity).toHaveBeenCalledWith(beeWrite(), expect.any(String));
    expect(keystoreOnDisk()).toMatchObject({ address: VAULT_BEE.slice(2), password: written[0] });
    expect(configPassword()).toBe(written[0]);
    expect(fs.existsSync(sealPath())).toBe(false);
    expect(fs.existsSync(statestore())).toBe(true);
    expect(fs.existsSync(pssKey())).toBe(true);
    expect(stop).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
    expect(guard.nodeBlockReason('bee')).toBeNull();
    expect(mod.isBeeIdentityInjected()).toBe(true);

    // Nothing to do on an unlock when the node opened its keystore.
    await mod.unlockVault('password123');
    await settle();
    expect(backend.writeNodeIdentity).toHaveBeenCalledTimes(1);
  });

  test('a recovery waits for a keystore operation in progress before it checks or writes', async () => {
    writeKeystore(VAULT_BEE);
    const { mod, backend, keystore } = load(keychain());
    const start = jest.fn(async () => {});
    mod.setBeeLifecycle({ start, needsKeyReinjection: () => true });

    const lock = gate();
    const startConfig = keystore.withKeystoreLock(antDir(), () => lock.held);
    const recovery = mod.reencryptBeeKeystore();
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(backend.writeNodeIdentity).not.toHaveBeenCalled();

    lock.release();
    await startConfig;
    await expect(recovery).resolves.toBe(true);
    expect(backend.writeNodeIdentity).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
  });

  test('recovery needs the unlocked vault and writes nothing without it', async () => {
    writeKeystore(VAULT_BEE);
    const { mod, backend } = load(keychain());
    backend.state.unlocked = false;
    mod.setBeeLifecycle({ start: jest.fn(), needsKeyReinjection: () => true });

    await expect(mod.reencryptBeeKeystore()).rejects.toThrow('Vault is locked');
    expect(backend.writeNodeIdentity).not.toHaveBeenCalled();
  });

  test('a recovery write the core did not install keeps the node blocked, and not started', async () => {
    writeKeystore(VAULT_BEE);
    const { mod, backend, guard } = load(keychain());
    backend.writeNodeIdentity.mockImplementation(async () => ({ status: 'corrupt' }));
    const start = jest.fn();
    mod.setBeeLifecycle({ start, needsKeyReinjection: () => true });

    await expect(mod.reencryptBeeKeystore()).rejects.toThrow('did not finish (corrupt)');
    expect(guard.nodeBlockReason('bee')).not.toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  // The K-3 review's reproduction: a keystore for account A, its sealed
  // password lost, and a vault that derives account B. Recovery must keep
  // A's keystore, the only encrypted copy of A's key, not write B's over it.
  test("recovery never overwrites another identity's keystore", async () => {
    writeKeystore(OTHER_BEE);
    const before = fs.readFileSync(swarmKeyPath(), 'utf8');
    const { mod, backend, keystore, guard } = load(keychain());
    const start = jest.fn(async () => {});
    const refuseKeyReinjection = jest.fn();
    mod.setBeeLifecycle({ start, needsKeyReinjection: () => true, refuseKeyReinjection });

    await mod.unlockVault('password123');
    await settle();

    expect(backend.writeNodeIdentity).not.toHaveBeenCalled();
    expect(fs.readFileSync(swarmKeyPath(), 'utf8')).toBe(before);
    expect(keystore.hasSealedPassword(antDir())).toBe(false);
    expect(start).not.toHaveBeenCalled();
    expect(guard.nodeBlockReason('bee')).toBeNull();
    expect(refuseKeyReinjection).toHaveBeenCalledWith(
      'Swarm keystore belongs to a different identity: re-inject manually'
    );
    await expect(mod.reencryptBeeKeystore()).rejects.toThrow(keystore.IDENTITY_MISMATCH_MESSAGE);
  });

  test('recovery refuses a keystore whose identity it cannot read', async () => {
    fs.mkdirSync(path.dirname(swarmKeyPath()), { recursive: true });
    fs.writeFileSync(swarmKeyPath(), JSON.stringify({ version: 3, crypto: {} }));
    const { mod, backend } = load(keychain());
    const refuseKeyReinjection = jest.fn();
    mod.setBeeLifecycle({ start: jest.fn(), needsKeyReinjection: () => true, refuseKeyReinjection });

    await mod.unlockVault('password123');
    await settle();

    expect(backend.writeNodeIdentity).not.toHaveBeenCalled();
    expect(refuseKeyReinjection).toHaveBeenCalledTimes(1);
  });

  // The K-3 review's reordering: recovery A held in the core's write, a
  // second unlock meanwhile, then A released. One recovery runs, and the
  // keystore on disk opens with the password config.yaml holds.
  test('overlapping unlocks run one recovery, ending with a matching pair', async () => {
    writeKeystore(VAULT_BEE);
    const write = gate();
    const { mod, backend } = load(keychain(), { hold: (n) => n === 1 && write.held });
    let needed = true;
    const start = jest.fn(async () => {
      needed = false;
    });
    mod.setBeeLifecycle({ start, needsKeyReinjection: () => needed });

    await mod.unlockVault('password123');
    await settle();
    expect(backend.writeNodeIdentity).toHaveBeenCalledTimes(1);
    const second = mod.reencryptBeeKeystore();
    await mod.unlockVault('password123');
    await settle();
    write.release();
    await second;
    await settle();

    expect(backend.writeNodeIdentity).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(configPassword()).toBe(keystoreOnDisk().password);
  });

  test('an injection during a recovery waits, and the last pair written matches', async () => {
    writeKeystore(VAULT_BEE);
    const write = gate();
    const { mod, backend, written } = load(keychain(), { hold: (n) => n === 1 && write.held });
    mod.setBeeLifecycle({ start: jest.fn(async () => {}), needsKeyReinjection: () => true });

    await mod.unlockVault('password123');
    await settle();
    const injection = mod.injectBeeIdentity();
    // Long enough for an unserialized injection to reach its own write.
    for (let i = 0; i < 20 && backend.writeNodeIdentity.mock.calls.length < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // The injection has not written while the recovery holds the write.
    expect(backend.writeNodeIdentity).toHaveBeenCalledTimes(1);
    write.release();
    await injection;
    await settle();

    expect(backend.writeNodeIdentity).toHaveBeenCalledTimes(2);
    expect(keystoreOnDisk().password).toBe(written[1]);
    expect(configPassword()).toBe(written[1]);
  });
});

describe('identity file repair at startup (K-3)', () => {
  const posixTest = process.platform === 'win32' ? test.skip : test;
  let root;
  let envSnapshot;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-repair-'));
    envSnapshot = snapshotEnv();
    process.env.FREEDOM_IDENTITY_DATA = path.join(root, 'identity');
    fs.mkdirSync(process.env.FREEDOM_IDENTITY_DATA);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
    restoreEnv(envSnapshot);
    fs.rmSync(root, { recursive: true, force: true });
  });

  posixTest('narrows an older 0644 vault and credential, and leaves a planted link alone', () => {
    const dir = process.env.FREEDOM_IDENTITY_DATA;
    const vaultPath = path.join(dir, 'identity-vault.json');
    fs.writeFileSync(vaultPath, '{"version":1}');
    fs.chmodSync(vaultPath, 0o644);
    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'x');
    fs.chmodSync(outside, 0o644);
    fs.symlinkSync(outside, path.join(dir, 'quick-unlock.dat'));

    const { mod } = loadMainModule(require.resolve('./identity-manager'), {
      userDataDir: root,
    });
    mod.repairIdentityFiles();

    expect(fs.statSync(vaultPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(outside).mode & 0o777).toBe(0o644);
  });

  posixTest('narrows an older 0644 credential that is a regular file, its bytes kept', () => {
    const dir = process.env.FREEDOM_IDENTITY_DATA;
    fs.chmodSync(dir, 0o755);
    const credentialPath = path.join(dir, 'quick-unlock.dat');
    fs.writeFileSync(credentialPath, 'encrypted:legacy');
    fs.chmodSync(credentialPath, 0o644);

    const { mod } = loadMainModule(require.resolve('./identity-manager'), {
      userDataDir: root,
    });
    mod.repairIdentityFiles();

    expect(fs.statSync(credentialPath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(credentialPath, 'utf8')).toBe('encrypted:legacy');
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });
});

// K-3 on integration: the core writes node keys and configs (nodes.write_identity)
// below the data directory main hands it, through handles anchored there, but
// leaves that directory itself alone. Main makes it owner-only first.
describe('node identities are written into owner-only roots (K-3)', () => {
  const posixTest = process.platform === 'win32' ? test.skip : test;
  let root;
  let envSnapshot;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-roots-'));
    envSnapshot = snapshotEnv();
    for (const key of ENV_KEYS) delete process.env[key];
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
    restoreEnv(envSnapshot);
    fs.rmSync(root, { recursive: true, force: true });
  });

  posixTest("an older build's 0755 Ant data dir and Radicle home are 0700 when the core writes", async () => {
    const antDir = path.join(root, 'ant-data');
    const radicleDir = path.join(root, 'radicle-data');
    for (const dir of [antDir, radicleDir]) {
      fs.mkdirSync(dir, { mode: 0o755 });
      fs.chmodSync(dir, 0o755);
    }
    const backend = makeVaultBackendMock();
    const modeAtWrite = {};
    const write = backend.writeNodeIdentity.getMockImplementation();
    backend.writeNodeIdentity.mockImplementation(async (spec) => {
      modeAtWrite[spec.node] = fs.statSync(spec.data_dir || spec.home).mode & 0o777;
      return write(spec);
    });
    const { mod } = loadMainModule(require.resolve('./identity-manager'), {
      userDataDir: root,
      extraMocks: {
        ...vaultBackendMocks(backend),
        [require.resolve('./profile-resolver')]: () => ({ getActiveProfile: jest.fn(() => null) }),
        // The real modules: mocks an earlier describe registered stay registered.
        [require.resolve('./profile-paths')]: () => jest.requireActual('./profile-paths'),
        [require.resolve('./fs-offload')]: () => jest.requireActual('./fs-offload'),
      },
    });

    await mod.injectBeeIdentity();
    await mod.injectRadicleIdentity('Alias');

    expect(backend.writeNodeIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ node: 'bee', data_dir: antDir }),
      expect.any(String)
    );
    expect(backend.writeNodeIdentity).toHaveBeenCalledWith(
      { node: 'radicle', home: radicleDir, alias: 'Alias' },
      expect.any(String)
    );
    expect(modeAtWrite).toEqual({ bee: 0o700, radicle: 0o700 });
  });

  // Review #1029 R1-2: a root that cannot be made owner-only is never handed
  // to the core.
  posixTest('a 0755 root whose fchmod fails is refused, and the core writes nothing', async () => {
    const antDir = path.join(root, 'ant-data');
    const radicleDir = path.join(root, 'radicle-data');
    for (const dir of [antDir, radicleDir]) {
      fs.mkdirSync(dir, { mode: 0o755 });
      fs.chmodSync(dir, 0o755);
    }
    const backend = makeVaultBackendMock();
    const { mod } = loadMainModule(require.resolve('./identity-manager'), {
      userDataDir: root,
      extraMocks: {
        ...vaultBackendMocks(backend),
        [require.resolve('./profile-resolver')]: () => ({ getActiveProfile: jest.fn(() => null) }),
        // The real modules: mocks an earlier describe registered stay registered.
        [require.resolve('./profile-paths')]: () => jest.requireActual('./profile-paths'),
        [require.resolve('./fs-offload')]: () => jest.requireActual('./fs-offload'),
      },
    });
    jest.spyOn(fs, 'fchmodSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM: operation not permitted, fchmod'), { code: 'EPERM' });
    });

    await expect(mod.injectBeeIdentity()).rejects.toThrow('could not make it owner-only');
    await expect(mod.injectRadicleIdentity('Alias')).rejects.toThrow(
      'could not make it owner-only'
    );

    expect(backend.writeNodeIdentity).not.toHaveBeenCalled();
    expect(fs.statSync(antDir).mode & 0o777).toBe(0o755);
    expect(fs.statSync(radicleDir).mode & 0o777).toBe(0o755);
  });
});
