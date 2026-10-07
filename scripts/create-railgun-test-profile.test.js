/** Offline: the vault and public metadata a new disposable profile gets, with the
 * real identity vault, identity-manager and production submitter metadata
 * reader. No Electron, safeStorage, profile lock or network. */
const fs = require('fs'),
  os = require('os'),
  path = require('path');
const { provisionTestProfileVault } = require('./create-railgun-test-profile');
const identity = require('../src/main/identity');
const identityManager = require('../src/main/identity-manager');
const signers = require('../src/main/wallet/signers');
const { readRailgunSubmitterMetadata } = require('../src/main/wallet/railgun-private-submission');
const submitterMetadata = require('./write-railgun-submitter-metadata');

const PASSWORD = 'q'.repeat(44);
const NOW = new Date('2026-10-07T21:00:00.000Z');
let root, savedIdentityData;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-test-profile-')));
  savedIdentityData = process.env.FREEDOM_IDENTITY_DATA;
});
afterEach(() => {
  identity.lockVault();
  if (savedIdentityData === undefined) delete process.env.FREEDOM_IDENTITY_DATA;
  else process.env.FREEDOM_IDENTITY_DATA = savedIdentityData;
  fs.rmSync(root, { recursive: true, force: true });
});

test('loading the script starts no Electron, profile or vault work', () => {
  expect(Object.keys(require('./create-railgun-test-profile'))).toEqual([
    'provisionTestProfileVault',
  ]);
  expect(fs.readdirSync(root)).toEqual([]);
});

test("a new profile's vault carries identity-manager's public wallet-0 record", async () => {
  const identityDir = path.join(root, 'identity');
  process.env.FREEDOM_IDENTITY_DATA = identityDir;
  await provisionTestProfileVault(identityDir, PASSWORD, NOW);
  expect(fs.readdirSync(identityDir).sort()).toEqual(['identity-vault.json', 'vault-meta.json']);
  // The vault stays locked; its mnemonic derives the recorded addresses.
  expect(identity.isUnlocked()).toBe(false);
  await identity.unlockVault(identityDir, PASSWORD, 0);
  const keys = identity.deriveAllKeys(identity.getMnemonic());
  const owner = (await signers.getSigner(0).getAddress()).toLowerCase();
  identity.lockVault();
  expect(fs.readFileSync(path.join(identityDir, 'vault-meta.json'), 'utf8')).toBe(
    JSON.stringify(
      {
        userKnowsPassword: false,
        createdAt: NOW.toISOString(),
        addresses: { userWallet: keys.userWallet.address, beeWallet: keys.beeWallet.address },
      },
      null,
      2
    )
  );
  // Production's recovered history reads the enrolled EOA as the submitter.
  expect(readRailgunSubmitterMetadata()).toEqual({
    index: 0,
    type: 'mnemonic',
    address: owner,
  });
  expect(identityManager.getWalletRecord(0)).toMatchObject({ index: 0, type: 'mnemonic' });
  // The one-time provisioning script finds it already present and changes nothing.
  const before = fs.readFileSync(path.join(identityDir, 'vault-meta.json'));
  await identity.unlockVault(identityDir, PASSWORD, 0);
  const derived = await submitterMetadata.deriveSubmitter({ identity, signers });
  identity.lockVault();
  expect(
    submitterMetadata.provisionSubmitterMetadata({ identityDir, derived, expected: owner }).result
  ).toBe('already-present');
  expect(fs.readFileSync(path.join(identityDir, 'vault-meta.json')).equals(before)).toBe(true);
});

test('refuses an identity directory production would not read, and never replaces a vault', async () => {
  const identityDir = path.join(root, 'identity');
  const elsewhere = path.join(root, 'elsewhere');
  fs.mkdirSync(elsewhere);
  process.env.FREEDOM_IDENTITY_DATA = elsewhere;
  await expect(provisionTestProfileVault(identityDir, PASSWORD, NOW)).rejects.toThrow();
  expect(fs.existsSync(identityDir)).toBe(false);
  expect(fs.readdirSync(elsewhere)).toEqual([]);
  // An existing vault is refused by identity/vault before any metadata write.
  process.env.FREEDOM_IDENTITY_DATA = identityDir;
  await identity.createVault(identityDir, PASSWORD);
  const vault = fs.readFileSync(path.join(identityDir, 'identity-vault.json'));
  await expect(provisionTestProfileVault(identityDir, PASSWORD, NOW)).rejects.toThrow(
    'Vault already exists'
  );
  expect(fs.readdirSync(identityDir)).toEqual(['identity-vault.json']);
  expect(fs.readFileSync(path.join(identityDir, 'identity-vault.json')).equals(vault)).toBe(true);
});
