jest.mock('./vault', () => ({
  getMnemonic: () => 'test test test test test test test test test test test junk',
  getSessionSignal: () => mockVault.signal,
}));
let mockVault;
const { createPrivacyScope } = require('../networks/privacy-context');
const { createRailgunKeystore } = require('./privacy-keys');
// Independently generated with derive-railgun-keys 0.1.0, public test mnemonic.
const vectors = [
  [
    'b0958f8bc286ae0832fa83b01b719a225a07ce7b861ff311323f221667b3bd50',
    '9da4b4f0b5493a6ba3f7df0611c3e0842f7e2bb3d640f313b235f1b75c1d80b9',
  ],
  [
    'b54486f7304ca8618bce1ba764b24473592c967fef9ee425b1dafcb1504fe210',
    '9960238a86a7ecff390b7f37f680e7468fa0c41ee3704fcc68f0be82d19be4b2',
  ],
];
let scope, handle;
beforeEach(() => {
  mockVault = new AbortController();
  scope = createPrivacyScope({ profileId: 'test', signal: mockVault.signal });
  handle = scope.getContext({
    kind: 'private-account',
    principal: 'fixture',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'keystore',
  });
});
afterEach(() => scope.close());
test.each([0, 1])(
  'spending/viewing keys at index %i match the independent reference and restore identically',
  async (index) => {
    const keystore = createRailgunKeystore(handle, index);
    const paths = [44, 420].map((purpose) => `m/${purpose}'/1984'/0'/0'/${index}'`);
    for (const [i, path] of paths.entries()) {
      expect(await keystore.deriveAt(path)).toBe(`0x${vectors[index][i]}`);
      expect(await createRailgunKeystore(handle, index).deriveAt(path)).toBe(
        `0x${vectors[index][i]}`
      );
    }
  }
);
test('never exposes public-wallet/Ant paths, another index, or old-session keys', async () => {
  const keystore = createRailgunKeystore(handle);
  for (const path of [
    "m/44'/60'/0'/0/0",
    "m/44'/60'/0'/0/1",
    "m/44'/1984'/0'/0'/1'",
    "m/44'/1984'/0'/0'/0",
    "m/44'/1984'/0'/0'/4294967295'",
  ]) {
    await expect(keystore.deriveAt(path)).rejects.toMatchObject({
      code: 'PRIVATE_DERIVATION_REFUSED',
    });
  }
  mockVault.abort();
  await expect(keystore.deriveAt("m/44'/1984'/0'/0'/0'")).rejects.toMatchObject({
    code: 'PRIVACY_CONTEXT_REVOKED',
  });
});

test('the engine view capability cannot derive spending keys and expires on lock', async () => {
  const { createRailgunViewingKeystore } = require('./privacy-keys');
  const view = createRailgunViewingKeystore(handle, 1);
  expect(await view.deriveAt("m/420'/1984'/0'/0'/1'")).toBe(`0x${vectors[1][1]}`);
  for (const path of ["m/44'/1984'/0'/0'/1'", "m/420'/1984'/0'/0'/0'"])
    await expect(view.deriveAt(path)).rejects.toMatchObject({ code: 'PRIVATE_DERIVATION_REFUSED' });
  mockVault.abort();
  await expect(view.deriveAt("m/420'/1984'/0'/0'/1'")).rejects.toMatchObject({
    code: 'PRIVACY_CONTEXT_REVOKED',
  });
});
