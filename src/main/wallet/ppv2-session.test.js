jest.mock('../identity/vault', () => ({ getMnemonic: () => 'test test test test test test test test test test test junk',
  getSessionSignal: () => mockVault.signal }));
jest.mock('../profile-resolver', () => ({ getActiveProfile: () => mockProfile }));
jest.mock('../settings-store', () => ({ isWalletTorExperimentAvailable: () => mockAvailable }));
jest.mock('../networks/kohaku-provider', () => ({ createKohakuProvider: () => ({}) }));
jest.mock('../networks/kohaku-network-router', () => ({ createKohakuNetworkRouter: () => ({}) }));
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { createPrivacyScope } = require('../networks/privacy-context');
const { createPPv2Keystore } = require('../identity/ppv2-keys');
const { createPPv2Storage } = require('./ppv2-storage');
const { PPV2_CANDIDATE, openPPv2Session } = require('./ppv2-session');
const { resetPrivacySession } = require('./privacy-session');
const { configuration } = require('../../../test/helpers/ppv2-session-fixture');
let mockVault, mockProfile, mockAvailable, config, host, params, candidate, scope;
const snapshot = () => Object.freeze({ instanceId: async () => config.ownerAddress, isRegistered: async () => false,
  balance: async () => [], notes: async () => [], prepareRegisterKeystore: async () => ({ __type: 'publicOperation', txs: [] }) });
const handle = (role, index = 0) => scope.getContext({ kind: 'private-account', principal: `ppv2:${index}`,
  protocol: 'privacy-pools-v2', deployment: 'sepolia', chainId: 11155111, role });
beforeEach(() => {
  mockVault = new AbortController(); mockAvailable = true;
  mockProfile = { id: 'fixture', userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-ppv2-state-test-')) };
  scope = createPrivacyScope({ signal: mockVault.signal, profileId: createHash('sha256')
    .update(JSON.stringify([mockProfile.id, mockProfile.userDataDir])).digest('hex') });
  config = configuration();
  candidate = { ...PPV2_CANDIDATE, createPlugin: jest.fn(async (h, p) => { host = h; params = p; return snapshot(); }) };
});
afterEach(() => { mockVault.abort(); scope.close(); resetPrivacySession(); });

test('dedicated signer refuses wallet, Ant, other account and stale-vault derivation', async () => {
  const keys = createPPv2Keystore(handle('keystore'), 0);
  const first = await keys.deriveAt("m/28784'/2'/0'");
  expect(first).toMatch(/^0x[0-9a-f]{64}$/);
  expect(await createPPv2Keystore(handle('keystore'), 0).deriveAt("m/28784'/2'/0'")).toBe(first);
  expect(await createPPv2Keystore(handle('keystore', 1), 1).deriveAt("m/28784'/2'/1'")).not.toBe(first);
  for (const requested of ["m/44'/60'/0'/0/0", "m/44'/60'/0'/0/1", "m/28784'/2'/1'", "m/28784'/1'/0'"]) {
    await expect(keys.deriveAt(requested)).rejects.toMatchObject({ code: 'PRIVATE_DERIVATION_REFUSED' });
  }
  expect(() => createPPv2Keystore(handle('keystore'), 1)).toThrow();
  mockVault = new AbortController();
  await expect(keys.deriveAt("m/28784'/2'/0'")).rejects.toMatchObject({ code: 'PRIVACY_VAULT_LOCKED' });
});

test('encrypts state, restores deterministically and refuses changed identity/deployment bindings', async () => {
  const session = await openPPv2Session({ candidate, configuration: config });
  const key = await host.keystore.deriveAt("m/28784'/2'/0'");
  await host.storage.set('ppv2:controlled:notes', 'private synthetic note');
  await expect(host.storage.set('freedom-ppv2-binding-v1', 'bad')).rejects.toMatchObject({ code: 'PRIVATE_PPV2_STORAGE_REFUSED' });
  const directory = path.join(mockProfile.userDataDir, 'wallet-ppv2-experiment');
  const files = fs.readdirSync(directory);
  expect(files).toHaveLength(1);
  const bytes = fs.readFileSync(path.join(directory, files[0]), 'utf8');
  for (const clear of ['private synthetic note', key, 'TODO-privacy-pools-v2', config.ownerAddress]) expect(bytes).not.toContain(clear);
  session.close();
  const reopened = await openPPv2Session({ candidate, configuration: config });
  expect(await host.storage.get('ppv2:controlled:notes')).toBe('private synthetic note');
  expect(await host.keystore.deriveAt("m/28784'/2'/0'")).toBe(key);
  reopened.close();
  config.deploymentBlock += 1;
  await expect(openPPv2Session({ candidate, configuration: config })).rejects.toMatchObject({ code: 'PRIVATE_PPV2_STATE_MISMATCH' });
  config.deploymentBlock -= 1;
  const restored = await openPPv2Session({ candidate, configuration: config });
  restored.close();
  const file = path.join(directory, files[0]);
  const record = JSON.parse(fs.readFileSync(file, 'utf8')); record.tag = Buffer.alloc(16).toString('base64');
  fs.writeFileSync(file, JSON.stringify(record));
  await expect(openPPv2Session({ candidate, configuration: config })).rejects.toMatchObject({ code: 'PRIVATE_STORAGE_UNREADABLE' });
});

test('binds account/profile storage and rejects a changed SDK binding in the same namespace', async () => {
  const h = handle('storage');
  const first = await createPPv2Storage({ handle: h, accountIndex: 0, binding: { sdk: 'reviewed' } });
  await first.set('ppv2:controlled:x', 'value');
  await expect(createPPv2Storage({ handle: h, accountIndex: 0, binding: { sdk: 'changed' } }))
    .rejects.toMatchObject({ code: 'PRIVATE_PPV2_STATE_MISMATCH' });
  const other = await createPPv2Storage({ handle: handle('storage', 1), accountIndex: 1, binding: { sdk: 'reviewed' } });
  expect(await other.get('ppv2:controlled:x')).toBeNull();
  mockProfile = { ...mockProfile, id: 'other' };
  await expect(first.get('ppv2:controlled:x')).rejects.toMatchObject({ code: 'PRIVATE_PPV2_SCOPE' });
});

test('owns one session per account, isolates close, and exposes no broadcaster, export or proving', async () => {
  const a = await openPPv2Session({ candidate, configuration: config });
  const old = host;
  const b = await openPPv2Session({ candidate, configuration: config, accountIndex: 1 });
  await expect(openPPv2Session({ candidate, configuration: config })).rejects.toMatchObject({ code: 'PRIVATE_PPV2_BUSY' });
  expect(params.deploymentBlock).toBe('0x64');
  expect(() => params.factories.proofService.proveDeposit({})).toThrow();
  expect(a.descriptor).toMatchObject({ verified: false, broadcasting: false, proving: false });
  for (const name of ['prepareShield', 'prepareUnshield', 'prepareTransfer', 'exportAccount', 'importAccount', 'sync', 'broadcast']) expect(a[name]).toBeUndefined();
  a.close();
  await expect(old.keystore.deriveAt("m/28784'/2'/0'")).rejects.toMatchObject({ code: 'PRIVACY_CONTEXT_REVOKED' });
  await expect(old.storage.set('ppv2:controlled:x', 'late')).rejects.toMatchObject({ code: 'PRIVACY_CONTEXT_REVOKED' });
  expect(await b.isRegistered()).toBe(false);
  mockVault.abort();
  await expect(b.isRegistered()).rejects.toMatchObject({ code: 'PRIVACY_CONTEXT_REVOKED' });
});

test('serializes SDK operations and rejects late results when the vault locks', async () => {
  let finish;
  candidate.createPlugin = async () => ({ ...snapshot(), notes: () => new Promise((resolve) => { finish = resolve; }) });
  const session = await openPPv2Session({ candidate, configuration: config });
  const pending = session.notes();
  const failed = expect(pending).rejects.toMatchObject({ code: 'PRIVACY_CONTEXT_REVOKED' });
  await expect(session.balance()).rejects.toMatchObject({ code: 'PRIVATE_PPV2_BUSY' });
  mockVault.abort(); await failed; finish(['late']);
});

test('cancelled factory cannot publish a late session or write state', async () => {
  let finish;
  candidate.createPlugin = async (h) => { host = h; return new Promise((resolve) => { finish = resolve; }); };
  const pending = openPPv2Session({ candidate, configuration: config });
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  const failed = expect(pending).rejects.toMatchObject({ code: 'PRIVACY_CONTEXT_REVOKED' });
  mockVault.abort(); await failed; finish(snapshot());
  await expect(host.storage.set('ppv2:controlled:late', 'x')).rejects.toMatchObject({ code: 'PRIVACY_CONTEXT_REVOKED' });
});

test('refuses production, unreviewed candidates and SDK diagnostics', async () => {
  mockAvailable = false;
  await expect(openPPv2Session({ candidate, configuration: config })).rejects.toMatchObject({ code: 'PRIVATE_PPV2_UNAVAILABLE' });
  mockAvailable = true;
  await expect(openPPv2Session({ candidate: { ...candidate, sdk: 'other' }, configuration: config })).rejects.toThrow();
  await expect(openPPv2Session({ candidate, configuration: { ...config, chainId: 1 } })).rejects.toThrow();
  candidate.createPlugin = async () => ({ ...snapshot(), balance: async () => { throw new Error('sensitive URL and note'); } });
  const session = await openPPv2Session({ candidate, configuration: config });
  await expect(session.balance()).rejects.toMatchObject({ code: 'PRIVATE_PPV2_OPERATION_FAILED', message: 'Controlled PPv2 operation failed' });
  session.close();
  candidate.createPlugin = async () => { throw null; };
  await expect(openPPv2Session({ candidate, configuration: config })).rejects.toMatchObject({ code: 'PRIVATE_PPV2_UNAVAILABLE' });
});
