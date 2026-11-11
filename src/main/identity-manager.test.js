const fs = require('fs');
const os = require('os');
const path = require('path');
const IPC = require('../shared/ipc-channels');
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
    isUnlocked: jest.fn(() => true),
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
    isUnlocked: jest.fn(() => true),
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

// Anvil/Hardhat-default test keys — well-known, never funded on mainnet.
const PHONE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const STRANGER_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';

/**
 * A fake phone: adding a phone account has the phone sign a check as the
 * account (#1078). `phone.wallet` is the key it signs with; a test swaps
 * `phone.answer` to answer otherwise.
 */
function makePhone() {
  const { Wallet, getBytes } = require('ethers');
  const phone = {
    wallet: new Wallet(PHONE_KEY),
    answer: ({ params }) => phone.wallet.signMessage(getBytes(params[0])),
    requestRemoteSignature: jest.fn(async (job) => phone.answer(job)),
  };
  return phone;
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
      expect.any(String),
      { beforeWrite: expect.any(Function) }
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
  let phone;

  const LEDGER_ADDRESS = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C';
  const LEDGER_PATH = "44'/60'/0'/0/0";
  const HARDWARE_INDEX_BASE = 1000000;

  const loadIdentityManager = () =>
    loadMainModule(require.resolve('./identity-manager'), {
      userDataDir: tmpDir,
      extraMocks: {
        [require.resolve('./identity')]: () => ({
          getMnemonic: jest.fn(() => null), // vault locked — ledger ops must not need it
          isUnlocked: jest.fn(() => false),
        }),
        [require.resolve('./wallet/remote/bridge')]: () => ({
          requestRemoteSignature: phone.requestRemoteSignature,
        }),
      },
    });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-manager-ledger-'));
    envSnapshot = snapshotEnv();
    process.env.FREEDOM_IDENTITY_DATA = tmpDir;
    phone = makePhone();
    identityManager = loadIdentityManager().mod;
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

    const wallet = await identityManager.addRemoteWallet('', phone.wallet.address);

    expect(wallet).toEqual({
      index: HARDWARE_INDEX_BASE,
      name: 'Phone 1',
      address: phone.wallet.address,
      type: 'remote',
      addressCheck: 'matched',
    });
    expect(readVaultMeta().derivedWallets[1]).toEqual(wallet);
  });

  test('addRemoteWallet has the phone sign a fresh check as the account first (#1078)', async () => {
    seedMainWallet();

    await identityManager.addRemoteWallet('My Phone', phone.wallet.address);

    expect(phone.requestRemoteSignature).toHaveBeenCalledTimes(1);
    const [job] = phone.requestRemoteSignature.mock.calls[0];
    expect(job).toMatchObject({
      method: 'personal_sign',
      address: phone.wallet.address,
      purpose: 'account-check',
    });
    expect(job.params[1]).toBe(phone.wallet.address);
    const challenge = Buffer.from(job.params[0].slice(2), 'hex').toString('utf8');
    expect(challenge).toContain(phone.wallet.address);
    expect(challenge).toMatch(/Nonce: [0-9a-f]{64}$/);
  });

  test('addRemoteWallet refuses an address the phone does not sign as (#1078)', async () => {
    seedMainWallet();
    const before = readVaultMeta();
    // The chrome names an address; the phone behind the session holds another.
    const { Wallet } = require('ethers');
    phone.wallet = new Wallet(STRANGER_KEY);

    await expect(identityManager.addRemoteWallet('Planted', new Wallet(PHONE_KEY).address))
      .rejects.toMatchObject({
        code: 'REMOTE_ADDRESS_MISMATCH',
        message: "Your phone answered from a different account than the one you picked. The account wasn't added.",
      });
    expect(readVaultMeta()).toEqual(before);
  });

  test('addRemoteWallet refuses a phone that says the account is not its own (EIP-1193 4100)', async () => {
    seedMainWallet();
    const before = readVaultMeta();
    phone.answer = async () => {
      throw Object.assign(new Error('Unauthorized'), { code: 'REMOTE_WRONG_ACCOUNT' });
    };

    await expect(identityManager.addRemoteWallet('Planted', phone.wallet.address))
      .rejects.toMatchObject({ code: 'REMOTE_ADDRESS_MISMATCH' });
    expect(readVaultMeta()).toEqual(before);
  });

  test.each([
    ['no answer in time', () => Object.assign(new Error('timeout'), { code: 'REMOTE_TIMEOUT' })],
    ['the user cancels', () => Object.assign(new Error('cancelled'), { code: 'REMOTE_USER_CANCELLED' })],
    ['a rejection on the phone', () => Object.assign(new Error('rejected'), { code: 'REMOTE_USER_REJECTED' })],
  ])('addRemoteWallet adds nothing on %s (#1078)', async (_label, makeError) => {
    seedMainWallet();
    const before = readVaultMeta();
    phone.answer = async () => {
      throw makeError();
    };

    const refusal = identityManager.addRemoteWallet('My Phone', phone.wallet.address);
    await expect(refusal).rejects.toMatchObject({
      code: 'REMOTE_ADDRESS_UNPROVEN',
      message: expect.stringMatching(/didn't confirm that it holds this account, so it wasn't added/),
    });
    await expect(refusal).rejects.toHaveProperty('cause.code', makeError().code);
    expect(readVaultMeta()).toEqual(before);
  });

  test('addRemoteWallet adds nothing for a malformed answer', async () => {
    seedMainWallet();
    const before = readVaultMeta();
    phone.answer = async () => 'not-a-signature';

    await expect(identityManager.addRemoteWallet('My Phone', phone.wallet.address))
      .rejects.toMatchObject({ code: 'REMOTE_ADDRESS_UNPROVEN' });
    expect(readVaultMeta()).toEqual(before);
  });

  test('the add IPC answers a refusal with its code', async () => {
    seedMainWallet();
    const { mod, ipcMain } = loadIdentityManager();
    mod.registerIdentityIpc();
    const { Wallet } = require('ethers');
    phone.wallet = new Wallet(STRANGER_KEY);

    await expect(ipcMain.invoke('wallet:add-remote-wallet', 'Planted', new Wallet(PHONE_KEY).address))
      .resolves.toMatchObject({ success: false, code: 'REMOTE_ADDRESS_MISMATCH' });
  });

  test('addRemoteWallet rejects bad addresses and duplicates across account types', async () => {
    seedMainWallet();
    await identityManager.addLedgerWallet('My Stax', LEDGER_ADDRESS, LEDGER_PATH);

    await expect(identityManager.addRemoteWallet('Bad', '0x123'))
      .rejects.toThrow('Invalid Phone account address');
    // The same address already added as a Ledger account is still a duplicate.
    await expect(identityManager.addRemoteWallet('Again', LEDGER_ADDRESS.toLowerCase()))
      .rejects.toThrow(/already in your wallet list/);
    // Neither asks the phone.
    expect(phone.requestRemoteSignature).not.toHaveBeenCalled();
  });

  test('remote accounts behave like device accounts across the record seams', async () => {
    seedMainWallet();
    const address = phone.wallet.address;
    const wallet = await identityManager.addRemoteWallet('My Phone', address);

    expect(identityManager.getWalletRecord(wallet.index)).toMatchObject({
      type: 'remote',
      address,
      addressCheck: 'matched',
    });
    await expect(identityManager.getUserWalletKey(wallet.index))
      .rejects.toThrow('This account has no derivable private key');

    await identityManager.setActiveWalletIndex(wallet.index);
    await expect(identityManager.getActiveWalletAddress()).resolves.toBe(address);

    const wallets = await identityManager.getDerivedWallets();
    expect(wallets[1]).toMatchObject({ type: 'remote', address, addressCheck: 'matched' });
  });

  describe('a phone record added before the check (#1078)', () => {
    const seedOldPhone = (extra = {}) =>
      writeVaultMeta({
        activeWalletIndex: 0,
        addresses: { userWallet: '0x0000000000000000000000000000000000000001' },
        derivedWallets: [
          { index: 0, name: 'Main Wallet', address: '0x0000000000000000000000000000000000000001' },
          { index: HARDWARE_INDEX_BASE, name: 'Old Phone', address: phone.wallet.address, type: 'remote', ...extra },
        ],
        nextHardwareWalletIndex: HARDWARE_INDEX_BASE + 1,
      });

    test('starts unchecked, becomes mismatched and then matched, and is never deleted', () => {
      seedOldPhone();

      expect(identityManager.getWalletRecord(HARDWARE_INDEX_BASE)).toMatchObject({ addressCheck: 'unchecked' });

      expect(identityManager.recordRemoteAddressCheck(HARDWARE_INDEX_BASE, false)).toBe('mismatched');
      expect(readVaultMeta().derivedWallets[1]).toMatchObject({
        address: phone.wallet.address,
        addressCheck: 'mismatched',
      });

      expect(identityManager.recordRemoteAddressCheck(HARDWARE_INDEX_BASE, true)).toBe('matched');
      expect(readVaultMeta().derivedWallets[1]).toMatchObject({ addressCheck: 'matched' });

      // A matched record stays matched: a later answer from another account
      // is the phone on another account.
      expect(identityManager.recordRemoteAddressCheck(HARDWARE_INDEX_BASE, false)).toBe('matched');
      expect(readVaultMeta().derivedWallets).toHaveLength(2);

      // Only phone records carry the state.
      expect(identityManager.recordRemoteAddressCheck(0, true)).toBeNull();
      expect(readVaultMeta().derivedWallets[0]).not.toHaveProperty('addressCheck');
    });

    test('checkRemoteWallet keeps a match', async () => {
      seedOldPhone();

      await expect(identityManager.checkRemoteWallet(HARDWARE_INDEX_BASE)).resolves.toMatchObject({
        index: HARDWARE_INDEX_BASE,
        addressCheck: 'matched',
      });
      expect(phone.requestRemoteSignature).toHaveBeenCalledWith(
        expect.objectContaining({ walletIndex: HARDWARE_INDEX_BASE, purpose: 'account-check' })
      );
      expect(readVaultMeta().derivedWallets[1]).toMatchObject({ addressCheck: 'matched' });
    });

    test('checkRemoteWallet marks a phone on another account mismatched, and keeps the record', async () => {
      seedOldPhone();
      const { Wallet } = require('ethers');
      phone.wallet = new Wallet(STRANGER_KEY);
      const oldAddress = new Wallet(PHONE_KEY).address;

      await expect(identityManager.checkRemoteWallet(HARDWARE_INDEX_BASE)).resolves.toMatchObject({
        addressCheck: 'mismatched',
      });
      expect(readVaultMeta().derivedWallets[1]).toMatchObject({
        name: 'Old Phone',
        address: oldAddress,
        addressCheck: 'mismatched',
      });
    });

    test('checkRemoteWallet leaves the record as it was when no answer comes', async () => {
      seedOldPhone();
      const before = readVaultMeta();
      phone.answer = async () => {
        throw Object.assign(new Error('timeout'), { code: 'REMOTE_TIMEOUT' });
      };

      await expect(identityManager.checkRemoteWallet(HARDWARE_INDEX_BASE))
        .rejects.toMatchObject({ code: 'REMOTE_TIMEOUT' });
      expect(readVaultMeta()).toEqual(before);
    });

    test('checkRemoteWallet only checks phone records', async () => {
      seedOldPhone();
      await expect(identityManager.checkRemoteWallet(0)).rejects.toThrow(/not a phone account/);
      await expect(identityManager.checkRemoteWallet(HARDWARE_INDEX_BASE + 5)).rejects.toThrow(/not a phone account/);
      expect(phone.requestRemoteSignature).not.toHaveBeenCalled();
    });

    test('the check IPC answers with the state, or the failure and its code', async () => {
      seedOldPhone();
      const { mod, ipcMain } = loadIdentityManager();
      mod.registerIdentityIpc();

      await expect(ipcMain.invoke('wallet:check-remote-wallet', HARDWARE_INDEX_BASE)).resolves.toMatchObject({
        success: true,
        wallet: { index: HARDWARE_INDEX_BASE, addressCheck: 'matched' },
      });

      phone.answer = async () => {
        throw Object.assign(new Error('Request cancelled.'), { code: 'REMOTE_USER_CANCELLED' });
      };
      await expect(ipcMain.invoke('wallet:check-remote-wallet', HARDWARE_INDEX_BASE)).resolves.toEqual({
        success: false,
        error: 'Request cancelled.',
        code: 'REMOTE_USER_CANCELLED',
      });
    });
  });
});

describe('identity-manager safe accounts', () => {
  let tmpDir;
  let envSnapshot;
  let identityManager;
  let ownerIndexes;
  let phone;

  const SAFE_ADDRESS = '0x41aD4887971f90BB3fE4d83eCa65177281283261';
  const LEDGER_ADDRESS = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C';
  const SALT = '20260710';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-manager-safe-'));
    envSnapshot = snapshotEnv();
    process.env.FREEDOM_IDENTITY_DATA = tmpDir;
    phone = makePhone();
    identityManager = loadMainModule(require.resolve('./identity-manager'), {
      userDataDir: tmpDir,
      extraMocks: {
        [require.resolve('./identity')]: () => ({
          getMnemonic: jest.fn(() => null), // vault locked — safe ops must not need it
          isUnlocked: jest.fn(() => false),
        }),
        [require.resolve('./wallet/remote/bridge')]: () => ({
          requestRemoteSignature: phone.requestRemoteSignature,
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

  test('addSafeWallet refuses a phone owner its phone has not shown it holds, until it has (#1078)', async () => {
    // A phone record from before the phone check: the chrome's word.
    writeVaultMeta({
      activeWalletIndex: 0,
      addresses: { userWallet: '0x0000000000000000000000000000000000000001' },
      derivedWallets: [
        { index: 0, name: 'Main Wallet', address: '0x0000000000000000000000000000000000000001' },
        { index: 1000000, name: 'Old Phone', address: phone.wallet.address, type: 'remote' },
      ],
      nextHardwareWalletIndex: 1000001,
    });
    ownerIndexes = [0, 1000000];

    await expect(addSafe()).rejects.toMatchObject({
      code: 'REMOTE_ACCOUNT_UNCHECKED',
      message: expect.stringMatching(/"Old Phone" can't own a Safe until it has been checked on your phone/),
    });
    expect(readVaultMeta().derivedWallets).toHaveLength(2);

    identityManager.recordRemoteAddressCheck(1000000, false);
    await expect(addSafe()).rejects.toMatchObject({
      code: 'REMOTE_ACCOUNT_UNCHECKED',
      message: expect.stringMatching(/your phone last answered from a different account/),
    });
    expect(readVaultMeta().derivedWallets).toHaveLength(2);

    // Checked on the phone: it can own the Safe now.
    await identityManager.checkRemoteWallet(1000000);
    await expect(addSafe()).resolves.toMatchObject({ type: 'safe', owners: [0, 1000000] });
  });

  test('addSafeWallet takes a phone owner added through the phone check', async () => {
    await seedOwners();
    const added = await identityManager.addRemoteWallet('My Phone', phone.wallet.address);

    await expect(addSafe('Joint', { owners: [0, added.index] })).resolves.toMatchObject({
      owners: [0, added.index],
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

    await expect(identityManager.getUserWalletKey(wallet.index))
      .rejects.toThrow('This account has no derivable private key');
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

  function loadIdentityManager(dataDirsForLoad, fsOffloadOverrides = null) {
    return loadMainModule(require.resolve('./identity-manager'), {
      extraMocks: {
        [require.resolve('./identity')]: () => makeRestartIdentityMock(),
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

    const results = await mgr.injectAllIdentities('FreedomBrowser', true);

    expect(results.needsRestart).toEqual([]);
    expect(results.bee.reinjected).toBe(true);
    expect(results.radicle.reinjected).toBe(true);
    expect(results.ipfs).toMatchObject({
      mode: 'ephemeral',
      active: false,
      peerId: null,
      stableIdentitySupported: false,
    });
  });

  test('a Radicle re-key wipes and writes the key inside the stopped-node section (R-8)', async () => {
    seedRadicleInjected();
    const storage = path.join(dataDirs.radicle, 'storage');
    fs.mkdirSync(storage, { recursive: true });
    const mgr = loadIdentityManager(dataDirs);
    await mgr.createNewVault('password-123');

    const steps = [];
    let finishStop;
    mgr.setRadicleLifecycle({
      withStopped: async (work) => {
        steps.push('stop requested');
        await new Promise((resolve) => {
          finishStop = resolve;
        });
        steps.push('stopped');
        try {
          return await work();
        } finally {
          steps.push(`restarted (storage ${fs.existsSync(storage) ? 'kept' : 'wiped'})`);
        }
      },
    });

    const injecting = mgr.injectRadicleIdentity('Alias');
    for (let i = 0; i < 50 && !finishStop; i += 1) await new Promise((r) => setImmediate(r));
    // The node has not stopped yet: nothing is wiped.
    expect(fs.existsSync(storage)).toBe(true);
    finishStop();
    const { did } = await injecting;
    expect(did).toMatch(/^did:key:/);
    expect(steps).toEqual(['stop requested', 'stopped', 'restarted (storage wiped)']);
  });

  test('a Radicle re-key whose node will not stop wipes nothing (R-8)', async () => {
    seedRadicleInjected();
    const storage = path.join(dataDirs.radicle, 'storage');
    fs.mkdirSync(storage, { recursive: true });
    const mgr = loadIdentityManager(dataDirs);
    await mgr.createNewVault('password-123');
    const keyPath = path.join(dataDirs.radicle, 'keys', 'radicle');
    const keyBefore = fs.existsSync(keyPath) ? fs.readFileSync(keyPath, 'utf8') : null;
    mgr.setRadicleLifecycle({
      withStopped: async () => {
        throw new Error('shutdown failed');
      },
    });

    await expect(mgr.injectRadicleIdentity('Alias')).rejects.toThrow('shutdown failed');
    expect(fs.existsSync(storage)).toBe(true);
    expect(fs.existsSync(keyPath) ? fs.readFileSync(keyPath, 'utf8') : null).toBe(keyBefore);
  });

  test('a revocation inside the stopped-node section refuses the new key (R-8)', async () => {
    seedRadicleInjected();
    const mgr = loadIdentityManager(dataDirs);
    await mgr.createNewVault('password-123');
    const keyPath = path.join(dataDirs.radicle, 'keys', 'radicle');
    const keyBefore = fs.existsSync(keyPath) ? fs.readFileSync(keyPath, 'utf8') : null;
    let sawError = null;
    mgr.setRadicleLifecycle({
      withStopped: async (work) => {
        // The vault's authority ends (as on quit) once the node is stopped.
        mgr.closeVaultAuthority();
        try {
          return await work();
        } catch (err) {
          sawError = err;
          throw err;
        }
      },
    });

    await expect(mgr.injectRadicleIdentity('Alias')).rejects.toThrow();
    expect(sawError).not.toBeNull();
    expect(fs.existsSync(keyPath) ? fs.readFileSync(keyPath, 'utf8') : null).toBe(keyBefore);
  });

  // Review note 2b: Ant was re-keyed before Radicle, so a Radicle stop that
  // failed left Ant on the new identity and Radicle on the old one, and the
  // user saw only "Setup failed".
  function notStopped(message) {
    return Object.assign(new Error(message), { code: 'RADICLE_NOT_STOPPED' });
  }

  test('a forced re-key changes Ant only once Radicle is proved stopped (R-8)', async () => {
    seedBeeInjected();
    seedRadicleInjected();
    const mgr = loadIdentityManager(dataDirs);
    await mgr.createNewVault('password-123');
    const steps = [];
    mgr.setBeeLifecycle({
      stop: async () => {
        steps.push('ant stopped for its re-key');
        return false;
      },
    });
    mgr.setRadicleLifecycle({
      withStopped: async (work) => {
        steps.push('radicle stopped');
        const did = await work();
        steps.push('radicle re-keyed');
        return did;
      },
    });

    const results = await mgr.injectAllIdentities('FreedomBrowser', true);
    expect(steps).toEqual(['radicle stopped', 'ant stopped for its re-key', 'radicle re-keyed']);
    expect(results.bee.reinjected).toBe(true);
    expect(results.radicle.reinjected).toBe(true);
  });

  test('a Radicle stop that fails re-keys no node and says so (R-8)', async () => {
    seedBeeInjected();
    seedRadicleInjected();
    const mgr = loadIdentityManager(dataDirs);
    await mgr.createNewVault('password-123');
    const beeStop = jest.fn(async () => false);
    mgr.setBeeLifecycle({ stop: beeStop });
    mgr.setRadicleLifecycle({
      withStopped: async () => {
        throw notStopped('The Radicle node did not answer its shutdown within 30s');
      },
    });
    const swarmKey = path.join(dataDirs.bee, 'keys', 'swarm.key');

    const err = await mgr.injectAllIdentities('FreedomBrowser', true).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('RADICLE_NOT_STOPPED');
    expect(err.message).toMatch(/Radicle node could not be stopped, so no node was given the new identity/);
    expect(err.message).toMatch(/within 30s/);
    expect(err.message).toMatch(/Ant and Radicle keep their current identities/);
    expect(err.message).toMatch(/run identity setup again/);
    // Ant was never touched.
    expect(beeStop).not.toHaveBeenCalled();
    expect(fs.readFileSync(swarmKey, 'utf8')).toBe('{}');
  });

  test('a Radicle failure after Ant was re-keyed names which node has which identity (R-8)', async () => {
    seedBeeInjected();
    seedRadicleInjected();
    const radicleStorage = path.join(dataDirs.radicle, 'storage');
    fs.mkdirSync(radicleStorage, { recursive: true });
    fs.mkdirSync(path.join(dataDirs.bee, 'statestore'), { recursive: true });
    const keyPath = path.join(dataDirs.radicle, 'keys', 'radicle');
    // Ant's wipe works; Radicle's own wipe, inside its section, fails.
    const actual = jest.requireActual('./fs-offload');
    let err;
    try {
      const mgr = loadIdentityManager(dataDirs, {
        removePath: async (target, opts) => {
          if (target.startsWith(dataDirs.radicle)) {
            throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
          }
          return actual.removePath(target, opts);
        },
      });
      await mgr.createNewVault('password-123');
      const beeStop = jest.fn(async () => false);
      mgr.setBeeLifecycle({ stop: beeStop });
      mgr.setRadicleLifecycle({ withStopped: async (work) => work() });
      err = await mgr.injectAllIdentities('FreedomBrowser', true).catch((e) => e);
      expect(beeStop).toHaveBeenCalledTimes(1);
    } finally {
      jest.dontMock(require.resolve('./fs-offload'));
    }
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/Radicle was not given the new identity: permission denied/);
    expect(err.message).toMatch(/Ant already uses the new identity; Radicle keeps its old one/);
    expect(err.message).toMatch(/Run identity setup again/);
    // Ant's state was reset for its new key; Radicle's key and data were not.
    expect(fs.existsSync(path.join(dataDirs.bee, 'statestore'))).toBe(false);
    expect(fs.readFileSync(keyPath, 'utf8')).toBe('key');
    expect(fs.existsSync(radicleStorage)).toBe(true);
  });

  test('an Ant failure inside Radicle\'s section is reported as it is (R-8)', async () => {
    seedBeeInjected();
    seedRadicleInjected();
    // Ant's wipe fails (its first stale directory cannot be removed).
    const mgr = loadIdentityManager(dataDirs, {
      removePath: async () => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      },
    });
    await mgr.createNewVault('password-123');
    mgr.setBeeLifecycle({ stop: async () => false });
    fs.mkdirSync(path.join(dataDirs.bee, 'statestore'), { recursive: true });
    const radicleStorage = path.join(dataDirs.radicle, 'storage');
    fs.mkdirSync(radicleStorage, { recursive: true });
    const sections = [];
    mgr.setRadicleLifecycle({
      withStopped: async (work) => {
        sections.push('radicle stopped');
        return work();
      },
    });
    let err;
    try {
      err = await mgr.injectAllIdentities('FreedomBrowser', true).catch((e) => e);
    } finally {
      jest.dontMock(require.resolve('./fs-offload'));
    }
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('permission denied');
    // Radicle's own wipe never ran.
    expect(fs.existsSync(radicleStorage)).toBe(true);
    expect(sections).toEqual(['radicle stopped']);
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
        [require.resolve('./identity')]: () => makeRestartIdentityMock(),
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

  function load(safeStorage) {
    const identityMock = {
      ...makeRestartIdentityMock(),
      getMnemonic: jest.fn(() => 'test test test test test test test test test test test about'),
    };
    identityMock.deriveAllKeys = jest.fn(() => ({
      userWallet: { address: '0xuser', privateKey: '0x01' },
      beeWallet: { address: VAULT_BEE, privateKey: '0x02' },
      ipfsKey: { privateKey: '0x03', publicKey: '0x04' },
      radicleKey: { privateKey: '0x05', publicKey: '0x06' },
    }));
    identityMock.injectBeeKey = jest.fn(async (dataDir, privateKey, password) => {
      expect(privateKey).toBe('0x02');
      writeKeystore(VAULT_BEE, password);
    });
    const { mod } = loadMainModule(require.resolve('./identity-manager'), {
      userDataDir: path.join(root, 'identity'),
      electronOverrides: { safeStorage },
      extraMocks: { [require.resolve('./identity')]: () => identityMock },
    });
    return { mod, identityMock, keystore: require('./swarm/ant-keystore-password') };
  }

  const keychain = () => ({
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (text) => Buffer.from(`v11${text}`),
    decryptStringAsync: async (buffer) => ({
      result: buffer.toString().slice(3),
      shouldReEncrypt: false,
    }),
  });

  test('injection seals the keystore password and leaves it out of config.yaml', async () => {
    const { mod, identityMock, keystore } = load(keychain());
    await mod.createNewVault('password123');
    await mod.injectBeeIdentity();

    const password = identityMock.injectBeeKey.mock.calls[0][2];
    expect(identityMock.createBeeConfig).toHaveBeenCalledWith(
      path.join(root, 'ant'),
      null,
      expect.any(Number),
      expect.any(Number)
    );
    expect(await keystore.unsealPassword(path.join(root, 'ant'))).toBe(password);
  });

  test('without a keyring injection keeps the password in config.yaml, sealing nothing', async () => {
    const { mod, identityMock, keystore } = load({
      ...keychain(),
      isAsyncEncryptionAvailable: async () => false,
    });
    await mod.createNewVault('password123');
    await mod.injectBeeIdentity();

    const password = identityMock.injectBeeKey.mock.calls[0][2];
    expect(identityMock.createBeeConfig).toHaveBeenCalledWith(
      path.join(root, 'ant'),
      password,
      expect.any(Number),
      expect.any(Number)
    );
    expect(keystore.hasSealedPassword(path.join(root, 'ant'))).toBe(false);
  });

  test('an unlock re-encrypts the keystore the node could not open, then starts it', async () => {
    const { mod, identityMock, keystore } = load(keychain());
    writeKeystore(VAULT_BEE);
    const start = jest.fn(async () => {
      needed = false;
    });
    let needed = true;
    mod.setBeeLifecycle({ start, needsKeyReinjection: () => needed });

    await mod.unlockVault('password123');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    // Same derived key, a new password, sealed; the node starts again.
    expect(identityMock.injectBeeKey).toHaveBeenCalledWith(
      path.join(root, 'ant'),
      '0x02',
      expect.stringMatching(/^[0-9a-f]{64}$/),
      expect.objectContaining({ beforeWrite: expect.any(Function) })
    );
    const password = identityMock.injectBeeKey.mock.calls[0][2];
    expect(await keystore.unsealPassword(path.join(root, 'ant'))).toBe(password);
    expect(start).toHaveBeenCalledTimes(1);

    // Nothing to do on an unlock when the node opened its keystore.
    needed = false;
    await mod.unlockVault('password123');
    await new Promise((resolve) => setImmediate(resolve));
    expect(identityMock.injectBeeKey).toHaveBeenCalledTimes(1);
  });

  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  };

  // The Ant side of the pairing (ant-manager createAntLifecycle): a start
  // that stops for re-injection sets the flag and tells the subscriber.
  function antSide({ startFails = () => false } = {}) {
    const side = { needed: false, listener: null };
    side.stopForReinjection = () => {
      side.needed = true;
      side.listener?.();
    };
    side.hooks = {
      start: jest.fn(async () => {
        if (startFails()) side.stopForReinjection();
        else side.needed = false;
      }),
      needsKeyReinjection: () => side.needed,
      refuseKeyReinjection: jest.fn(() => {
        side.needed = false;
      }),
      onKeyReinjectionNeeded: (listener) => {
        side.listener = listener;
      },
    };
    return side;
  }

  test('a start that fails while the vault is unlocked recovers without a lock and unlock', async () => {
    const { mod, identityMock, keystore } = load(keychain());
    writeKeystore(VAULT_BEE);
    const ant = antSide();
    mod.setBeeLifecycle(ant.hooks);
    await mod.unlockVault('password123');
    await settle();
    expect(identityMock.injectBeeKey).not.toHaveBeenCalled();

    // The sealed password stops decrypting at a later start (a reset keychain).
    ant.stopForReinjection();
    await settle();

    expect(identityMock.injectBeeKey).toHaveBeenCalledTimes(1);
    expect(await keystore.unsealPassword(antDir())).toBe(keystoreOnDisk().password);
    expect(ant.hooks.start).toHaveBeenCalledTimes(1);
    expect(ant.needed).toBe(false);
  });

  test('a start that fails while the vault is locked waits for the unlock', async () => {
    const { mod, identityMock } = load(keychain());
    writeKeystore(VAULT_BEE);
    const ant = antSide();
    mod.setBeeLifecycle(ant.hooks);

    ant.stopForReinjection();
    await settle();
    expect(identityMock.injectBeeKey).not.toHaveBeenCalled();

    await mod.unlockVault('password123');
    await settle();
    expect(identityMock.injectBeeKey).toHaveBeenCalledTimes(1);
    expect(ant.hooks.start).toHaveBeenCalledTimes(1);
  });

  test("a recovery's own start that fails again is not recovered in a loop", async () => {
    const { mod, identityMock } = load(keychain());
    writeKeystore(VAULT_BEE);
    const ant = antSide({ startFails: () => true });
    mod.setBeeLifecycle(ant.hooks);
    await mod.unlockVault('password123');
    await settle();

    ant.stopForReinjection();
    await settle();
    await settle();

    expect(identityMock.injectBeeKey).toHaveBeenCalledTimes(1);
    expect(ant.hooks.start).toHaveBeenCalledTimes(1);
    // Still asked for: the next unlock tries again.
    expect(ant.needed).toBe(true);
  });

  // K-1 x K-3: a recovery holds no key across an await. A lock while it
  // waits for the keystore lock stops it before any key is read, and the
  // next unlock runs its own recovery rather than joining the stale one.
  test('a lock while a recovery waits for the keystore lock stops it; the next unlock recovers', async () => {
    const { mod, identityMock, keystore } = load(keychain());
    identityMock.lockVault = jest.fn();
    writeKeystore(VAULT_BEE);
    const ant = antSide();
    mod.setBeeLifecycle(ant.hooks);
    await mod.unlockVault('password123');
    await settle();

    let release;
    const held = keystore.withKeystoreLock(antDir(), () => new Promise((r) => (release = r)));
    const stale = mod.reencryptBeeKeystore();
    await settle();
    await mod.lockVault();
    // Unlocked again while the stale recovery still waits: this unlock's
    // own recovery queues behind it instead of joining it.
    ant.needed = true;
    await mod.unlockVault('password123');
    release();
    await held;
    await expect(stale).rejects.toThrow(/locked/i);
    await settle();
    expect(identityMock.injectBeeKey).toHaveBeenCalledTimes(1);
    expect(await keystore.unsealPassword(antDir())).toBe(keystoreOnDisk().password);
    expect(ant.hooks.start).toHaveBeenCalledTimes(1);
  });

  test('a lock while a recovery builds the keystore stops it before the write', async () => {
    const { mod, identityMock, keystore } = load(keychain());
    identityMock.lockVault = jest.fn();
    writeKeystore(VAULT_BEE);
    const before = fs.readFileSync(swarmKeyPath(), 'utf8');
    let built;
    identityMock.injectBeeKey = jest.fn(async (dataDir, privateKey, password, opts) => {
      await new Promise((r) => (built = r));
      opts.beforeWrite();
      writeKeystore(VAULT_BEE, password);
    });
    const ant = antSide();
    mod.setBeeLifecycle(ant.hooks);
    await mod.unlockVault('password123');
    await settle();

    ant.needed = true;
    const recovery = mod.reencryptBeeKeystore();
    await settle();
    expect(identityMock.injectBeeKey).toHaveBeenCalledTimes(1);
    await mod.lockVault();
    built();
    await expect(recovery).rejects.toThrow(/locked/i);
    expect(fs.readFileSync(swarmKeyPath(), 'utf8')).toBe(before);
    expect(keystore.hasSealedPassword(antDir())).toBe(false);
    expect(ant.hooks.start).not.toHaveBeenCalled();
  });

  test("a start that fails while unlocked still never overwrites another identity's keystore", async () => {
    const { mod, identityMock } = load(keychain());
    writeKeystore(OTHER_BEE);
    const before = fs.readFileSync(swarmKeyPath(), 'utf8');
    const ant = antSide();
    mod.setBeeLifecycle(ant.hooks);
    await mod.unlockVault('password123');
    await settle();

    ant.stopForReinjection();
    await settle();

    expect(identityMock.injectBeeKey).not.toHaveBeenCalled();
    expect(fs.readFileSync(swarmKeyPath(), 'utf8')).toBe(before);
    expect(ant.hooks.refuseKeyReinjection).toHaveBeenCalledTimes(1);
    expect(ant.hooks.start).not.toHaveBeenCalled();
  });

  test('an Ant data directory Freedom refuses fails the recovery, not the unlock', async () => {
    const { mod, identityMock } = load(keychain());
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, antDir());
    const ant = antSide();
    ant.needed = true;
    mod.setBeeLifecycle(ant.hooks);

    await expect(mod.unlockVault('password123')).resolves.toBeUndefined();
    await settle();
    expect(identityMock.injectBeeKey).not.toHaveBeenCalled();
    await expect(mod.reencryptBeeKeystore()).rejects.toThrow(/symbolic link/);
  });

  // The K-3 review's reproduction: a keystore for account A, its sealed
  // password lost, and a vault that derives account B. Recovery must keep
  // A's keystore, the only encrypted copy of A's key, not write B's over it.
  test("recovery never overwrites another identity's keystore", async () => {
    const { mod, identityMock, keystore } = load(keychain());
    writeKeystore(OTHER_BEE);
    const before = fs.readFileSync(swarmKeyPath(), 'utf8');
    const start = jest.fn(async () => {});
    const refuseKeyReinjection = jest.fn();
    mod.setBeeLifecycle({ start, needsKeyReinjection: () => true, refuseKeyReinjection });

    await mod.unlockVault('password123');
    await settle();

    expect(identityMock.injectBeeKey).not.toHaveBeenCalled();
    expect(fs.readFileSync(swarmKeyPath(), 'utf8')).toBe(before);
    expect(keystore.hasSealedPassword(antDir())).toBe(false);
    expect(start).not.toHaveBeenCalled();
    expect(refuseKeyReinjection).toHaveBeenCalledWith(
      'Swarm keystore belongs to a different identity: re-inject manually'
    );
    await expect(mod.reencryptBeeKeystore()).rejects.toThrow(keystore.IDENTITY_MISMATCH_MESSAGE);
  });

  test('recovery refuses a keystore whose identity it cannot read', async () => {
    const { mod, identityMock } = load(keychain());
    fs.mkdirSync(path.dirname(swarmKeyPath()), { recursive: true });
    fs.writeFileSync(swarmKeyPath(), JSON.stringify({ version: 3, crypto: {} }));
    const refuseKeyReinjection = jest.fn();
    mod.setBeeLifecycle({ start: jest.fn(), needsKeyReinjection: () => true, refuseKeyReinjection });

    await mod.unlockVault('password123');
    await settle();

    expect(identityMock.injectBeeKey).not.toHaveBeenCalled();
    expect(refuseKeyReinjection).toHaveBeenCalledTimes(1);
  });

  // The K-3 review's reordering: recovery A held at its sealing call after
  // writing its keystore, a second unlock meanwhile, then A released. One
  // recovery runs, and the keystore on disk opens with the sealed password.
  test('overlapping unlocks run one recovery, ending with a matching pair', async () => {
    const storage = keychain();
    let releaseSeal;
    const held = new Promise((resolve) => (releaseSeal = resolve));
    const encrypt = storage.encryptStringAsync;
    storage.encryptStringAsync = jest.fn(async (text) => {
      if (storage.encryptStringAsync.mock.calls.length === 1) await held;
      return encrypt(text);
    });
    const { mod, identityMock, keystore } = load(storage);
    writeKeystore(VAULT_BEE);
    let needed = true;
    const start = jest.fn(async () => {
      needed = false;
    });
    mod.setBeeLifecycle({ start, needsKeyReinjection: () => needed });

    await mod.unlockVault('password123');
    await settle();
    expect(storage.encryptStringAsync).toHaveBeenCalledTimes(1);
    const second = mod.reencryptBeeKeystore();
    await mod.unlockVault('password123');
    await settle();
    releaseSeal();
    await second;
    await settle();

    expect(identityMock.injectBeeKey).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(await keystore.unsealPassword(antDir())).toBe(keystoreOnDisk().password);
  });

  test('an injection during a recovery waits, and the last pair written matches', async () => {
    const storage = keychain();
    let releaseSeal;
    const held = new Promise((resolve) => (releaseSeal = resolve));
    const encrypt = storage.encryptStringAsync;
    storage.encryptStringAsync = jest.fn(async (text) => {
      if (storage.encryptStringAsync.mock.calls.length === 1) await held;
      return encrypt(text);
    });
    const { mod, identityMock, keystore } = load(storage);
    writeKeystore(VAULT_BEE);
    mod.setBeeLifecycle({ start: jest.fn(async () => {}), needsKeyReinjection: () => true });

    await mod.unlockVault('password123');
    await settle();
    const injection = mod.injectBeeIdentity();
    // Long enough for an unserialized injection to reach its own write.
    for (let i = 0; i < 20 && identityMock.injectBeeKey.mock.calls.length < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // The injection has not written its keystore while the recovery holds the lock.
    expect(identityMock.injectBeeKey).toHaveBeenCalledTimes(1);
    releaseSeal();
    await injection;
    await settle();

    expect(identityMock.injectBeeKey).toHaveBeenCalledTimes(2);
    expect(await keystore.unsealPassword(antDir())).toBe(keystoreOnDisk().password);
    expect(keystoreOnDisk().password).toBe(identityMock.injectBeeKey.mock.calls[1][2]);
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
  posixTest('an identity folder that is a link: the IPC handlers answer with the refusal, not a throw', async () => {
    const dir = process.env.FREEDOM_IDENTITY_DATA;
    const real = path.join(root, 'moved-identity');
    fs.renameSync(dir, real);
    fs.symlinkSync(real, dir);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    // get-status prepares the Radicle home first; an override skips the
    // control-socket length check a long temp root (macOS) would trip.
    process.env.FREEDOM_RADICLE_DATA = path.join(root, 'radicle');

    const { mod, ipcMain } = loadMainModule(require.resolve('./identity-manager'), {
      userDataDir: root,
    });
    expect(() => mod.registerIdentityIpc()).not.toThrow();

    const explained = `Freedom will not use ${dir} because it is a symbolic link.`;
    await expect(ipcMain.invoke('identity:get-vault-meta')).resolves.toBeNull();
    await expect(ipcMain.invoke(IPC.IDENTITY_HAS_VAULT)).resolves.toEqual({
      hasVault: false,
      error: expect.stringContaining(explained),
    });
    await expect(ipcMain.invoke(IPC.IDENTITY_GET_STATUS)).resolves.toEqual({
      error: expect.stringContaining(explained),
    });
    // Followed nowhere: the folder behind the link is left as it was.
    expect(fs.lstatSync(dir).isSymbolicLink()).toBe(true);
  });
  posixTest('a linked Radicle or Ant home costs only that node: get-status still reports the vault', async () => {
    const dir = process.env.FREEDOM_IDENTITY_DATA;
    fs.writeFileSync(path.join(dir, 'identity-vault.json'), '{"version":1}');
    fs.writeFileSync(
      path.join(dir, 'vault-meta.json'),
      JSON.stringify({ addresses: { userWallet: '0xabc', beeWallet: '0xdef' } })
    );
    for (const [env, name] of [
      ['FREEDOM_RADICLE_DATA', 'radicle'],
      ['FREEDOM_ANT_DATA', 'ant'],
    ]) {
      const real = path.join(root, `moved-${name}`);
      fs.mkdirSync(real);
      fs.symlinkSync(real, path.join(root, name));
      process.env[env] = path.join(root, name);
    }

    const { mod, ipcMain } = loadMainModule(require.resolve('./identity-manager'), {
      userDataDir: root,
    });
    mod.registerIdentityIpc();

    const status = await ipcMain.invoke(IPC.IDENTITY_GET_STATUS);
    expect(status.error).toBeUndefined();
    expect(status).toMatchObject({
      hasVault: true,
      beeInjected: false,
      radicleInjected: false,
      addresses: { userWallet: '0xabc', beeWallet: '0xdef', radicleDid: null },
    });
    expect(console.warn).toHaveBeenCalledWith(
      '[IdentityManager] Radicle data folder unavailable:',
      expect.stringContaining('symbolic link')
    );
    expect(console.warn).toHaveBeenCalledWith(
      '[IdentityManager] Ant data folder unavailable:',
      expect.stringContaining('symbolic link')
    );
  });

  // A linked node home used to fail injectAllIdentities outright, after the
  // vault (and, in quick setup, Touch ID) already existed, so onboarding
  // never reached its last step. Each node is now injected on its own.
  function linkHome(env, name) {
    const real = path.join(root, `moved-${name}`);
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(root, name));
    process.env[env] = path.join(root, name);
    return real;
  }
  function realHome(env, name) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    process.env[env] = dir;
    return dir;
  }
  function loadWithMockIdentity() {
    const identityMock = makeRestartIdentityMock();
    const { mod } = loadMainModule(require.resolve('./identity-manager'), {
      extraMocks: {
        [require.resolve('./identity')]: () => identityMock,
        // An earlier suite's fs-offload stub (a dir that stays busy) is still
        // registered; these tests want the real deletes.
        [require.resolve('./fs-offload')]: () => jest.requireActual('./fs-offload'),
        // Likewise the #513 suite's profile-paths stub, whose
        // prepareRadicleDataDir answers that suite's own Radicle home.
        [require.resolve('./profile-paths')]: () => jest.requireActual('./profile-paths'),
      },
      userDataDir: root,
    });
    return { mod, identityMock };
  }

  posixTest('a linked Radicle home: injectAll still sets up Ant and reports Radicle refused', async () => {
    const real = linkHome('FREEDOM_RADICLE_DATA', 'radicle');
    realHome('FREEDOM_ANT_DATA', 'ant');
    const { mod, identityMock } = loadWithMockIdentity();
    await mod.createNewVault('password-123');

    const results = await mod.injectAllIdentities('FreedomBrowser', false);

    expect(results.bee).toMatchObject({ address: '0xbee' });
    expect(identityMock.injectBeeKey).toHaveBeenCalled();
    expect(results.radicle).toEqual({
      refused: true,
      error: expect.stringContaining('because it is a symbolic link'),
    });
    expect(results.needsRestart).toEqual([]);
    expect(identityMock.injectRadicleKey).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      '[IdentityManager] Radicle identity not injected:',
      expect.stringContaining('symbolic link')
    );
    // Followed nowhere: nothing was written behind the link.
    expect(fs.readdirSync(real)).toEqual([]);
  });

  posixTest('a linked Ant home: injectAll still sets up Radicle and reports Ant refused', async () => {
    const real = linkHome('FREEDOM_ANT_DATA', 'ant');
    realHome('FREEDOM_RADICLE_DATA', 'radicle');
    const { mod, identityMock } = loadWithMockIdentity();
    await mod.createNewVault('password-123');

    const results = await mod.injectAllIdentities('FreedomBrowser', true);

    expect(results.bee).toEqual({
      refused: true,
      error: expect.stringContaining('because it is a symbolic link'),
    });
    expect(identityMock.injectBeeKey).not.toHaveBeenCalled();
    expect(results.radicle).toMatchObject({ did: 'did:key:zTest' });
    expect(identityMock.injectRadicleKey).toHaveBeenCalled();
    expect(fs.readdirSync(real)).toEqual([]);
  });

  // A real home whose keys/ is a link used to be refused only by the key
  // write, after the stale-state wipe (and, for Ant, after the running node
  // was stopped and never restarted). It is now refused before either.
  function linkKeysDir(home, name) {
    const outside = path.join(root, `outside-${name}-keys`);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(home, 'keys'));
    return outside;
  }

  posixTest('a linked keys/ in a real Ant home: refused before Ant is stopped or wiped', async () => {
    const home = realHome('FREEDOM_ANT_DATA', 'ant');
    realHome('FREEDOM_RADICLE_DATA', 'radicle');
    fs.mkdirSync(path.join(home, 'statestore'));
    fs.writeFileSync(path.join(home, 'identity.json'), '{}');
    const outside = linkKeysDir(home, 'ant');
    const { mod, identityMock } = loadWithMockIdentity();
    const stop = jest.fn(async () => true);
    const start = jest.fn(async () => {});
    mod.setBeeLifecycle({ stop, start });
    await mod.createNewVault('password-123');

    const results = await mod.injectAllIdentities('FreedomBrowser', true);

    expect(results.bee).toEqual({
      refused: true,
      error: expect.stringContaining('symbolic link'),
    });
    expect(stop).not.toHaveBeenCalled();
    expect(identityMock.injectBeeKey).not.toHaveBeenCalled();
    expect(identityMock.createBeeConfig).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(home, 'statestore'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'identity.json'))).toBe(true);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(results.radicle).toMatchObject({ did: 'did:key:zTest' });
  });

  posixTest('a linked keys/ in a real Radicle home: refused before node/cobs/storage are wiped', async () => {
    realHome('FREEDOM_ANT_DATA', 'ant');
    const home = realHome('FREEDOM_RADICLE_DATA', 'radicle');
    for (const dir of ['node', 'cobs', 'storage']) fs.mkdirSync(path.join(home, dir));
    const outside = linkKeysDir(home, 'radicle');
    const { mod, identityMock } = loadWithMockIdentity();
    await mod.createNewVault('password-123');

    const results = await mod.injectAllIdentities('FreedomBrowser', false);

    expect(results.radicle).toEqual({
      refused: true,
      error: expect.stringContaining('symbolic link'),
    });
    expect(identityMock.injectRadicleKey).not.toHaveBeenCalled();
    for (const dir of ['node', 'cobs', 'storage']) {
      expect(fs.existsSync(path.join(home, dir))).toBe(true);
    }
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(results.bee).toMatchObject({ address: '0xbee' });
  });

  test('a node failure that is not a refused link still fails injectAll', async () => {
    realHome('FREEDOM_ANT_DATA', 'ant');
    realHome('FREEDOM_RADICLE_DATA', 'radicle');
    const { mod, identityMock } = loadWithMockIdentity();
    identityMock.injectRadicleKey.mockImplementation(() => {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    });
    await mod.createNewVault('password-123');

    await expect(mod.injectAllIdentities('FreedomBrowser', false)).rejects.toThrow('disk full');
  });
});
