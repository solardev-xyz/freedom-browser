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

function makeProfileIdentityMock() {
  return {
    createVault: jest.fn().mockResolvedValue('test mnemonic'),
    unlockVault: jest.fn().mockResolvedValue(undefined),
    deriveAllKeys: jest.fn(() => ({
      userWallet: { address: '0xuser', privateKey: '0xuser-private' },
      beeWallet: { address: '0xbee', privateKey: '0xbee-private' },
      ipfsKey: { privateKey: Buffer.from('ipfs-private'), publicKey: Buffer.from('ipfs-public') },
      radicleKey: {
        privateKey: Buffer.from('radicle-private'),
        publicKey: Buffer.from('radicle-public'),
      },
    })),
    injectBeeKey: jest.fn().mockResolvedValue(undefined),
    createBeeConfig: jest.fn(),
    injectIpfsKey: jest.fn(() => '12D3KooProfilePeer'),
    injectRadicleKey: jest.fn(() => 'did:key:zProfileRadicle'),
  };
}

function makeRestartIdentityMock() {
  return {
    createVault: jest.fn(async () => 'test test test test test test test test test test test about'),
    unlockVault: jest.fn(async () => {}),
    vaultExists: jest.fn(async () => true),
    isUnlocked: jest.fn(async () => true),
    deriveAllKeys: jest.fn(() => ({
      userWallet: { address: '0xuser', privateKey: '0x01' },
      beeWallet: { address: '0xbee', privateKey: '0x02' },
      ipfsKey: { privateKey: '0x03', publicKey: '0x04' },
      radicleKey: { privateKey: '0x05', publicKey: '0x06' },
    })),
    injectBeeKey: jest.fn(async () => {}),
    createBeeConfig: jest.fn(() => {}),
    injectIpfsKey: jest.fn(() => 'QmTestPeerId'),
    injectRadicleKey: jest.fn(() => 'did:key:zTest'),
    createRadicleIdentity: jest.fn(() => ({ did: 'did:key:zTest' })),
  };
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

    const identityMock = makeProfileIdentityMock();
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
        [require.resolve('./identity')]: () => identityMock,
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

    expect(identityMock.injectBeeKey).toHaveBeenCalledWith(
      antDir,
      '0xbee-private',
      expect.any(String)
    );
    expect(identityMock.createBeeConfig).toHaveBeenCalledWith(
      antDir,
      expect.any(String),
      11644,
      12644
    );
    expect(identityMock.injectIpfsKey).not.toHaveBeenCalled();
    expect(identityMock.injectRadicleKey).toHaveBeenCalledWith(
      radicleDir,
      Buffer.from('radicle-private'),
      Buffer.from('radicle-public'),
      'ProfileAlias'
    );
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
        [require.resolve('./identity')]: () => ({
          getMnemonic: jest.fn(() => null), // vault locked — ledger ops must not need it
          isUnlocked: jest.fn(() => false),
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

  test('getUserWalletKey refuses to derive for a ledger account', async () => {
    seedMainWallet();
    await identityManager.addLedgerWallet('My Stax', LEDGER_ADDRESS, LEDGER_PATH);

    await expect(identityManager.getUserWalletKey(HARDWARE_INDEX_BASE))
      .rejects.toThrow('This account has no derivable private key');
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
    await expect(identityManager.getUserWalletKey(wallet.index))
      .rejects.toThrow('This account has no derivable private key');

    await identityManager.setActiveWalletIndex(wallet.index);
    await expect(identityManager.getActiveWalletAddress()).resolves.toBe(LEDGER_ADDRESS);

    const wallets = await identityManager.getDerivedWallets();
    expect(wallets[1]).toMatchObject({ type: 'remote', address: LEDGER_ADDRESS });
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
        [require.resolve('./identity')]: () => ({
          getMnemonic: jest.fn(() => 'test mnemonic'),
          isUnlocked: jest.fn(() => true),
          deriveUserWallet: jest.fn((_mnemonic, index) => ({
            address: `0xderived${index}`,
          })),
        }),
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

  function loadIdentityManager(dataDirsForLoad) {
    return loadMainModule(require.resolve('./identity-manager'), {
      extraMocks: {
        [require.resolve('./identity')]: () => makeRestartIdentityMock(),
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

  test('force reinjection reports Radicle but NOT Bee/IPFS for restart', async () => {
    // Bee/Radicle are injected. A stale IPFS identity metadata file from older
    // builds must be ignored because native freedom-ipfs now reports ephemeral
    // identity mode instead of a prepared durable PeerID.
    seedBeeInjected();
    seedIpfsIdentityMetadata();
    seedRadicleInjected();

    const mgr = loadIdentityManager(dataDirs);
    await mgr.createNewVault('password-123');

    const results = await mgr.injectAllIdentities('FreedomBrowser', true);

    expect(results.needsRestart).not.toContain('bee');
    expect(results.needsRestart).not.toContain('ipfs');
    expect(results.needsRestart).toEqual(expect.arrayContaining(['radicle']));
    expect(results.bee.reinjected).toBe(true);
    expect(results.ipfs).toMatchObject({
      mode: 'ephemeral',
      active: false,
      peerId: null,
      stableIdentitySupported: false,
    });
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
});
