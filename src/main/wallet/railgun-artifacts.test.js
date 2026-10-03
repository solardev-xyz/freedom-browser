const { Interface } = require('ethers');
const mockLoad = jest.fn();
let mockManifest;
jest.mock('./privacy-artifacts', () => ({
  createPrivacyArtifactLoader: ({ manifest }) => {
    mockManifest = manifest;
    return { load: mockLoad };
  },
}));
const { createPrivacyScope } = require('../networks/privacy-context');
const {
  manifest,
  loadRailgunArtifacts,
  assertRailgunArtifactVerifier,
} = require('./railgun-artifacts');
const deployment = require('../../../docs/qualification/railgun-sepolia-deployment-2026-10-02.json');
const abi = new Interface([
  'function getVerificationKey(uint256,uint256) view returns ((string artifactsIPFSHash,(uint256 x,uint256 y) alpha1,(uint256[2] x,uint256[2] y) beta2,(uint256[2] x,uint256[2] y) gamma2,(uint256[2] x,uint256[2] y) delta2,(uint256 x,uint256 y)[] ic))',
]);
let scope, handle, vkey;
beforeEach(() => {
  scope = createPrivacyScope({
    profileId: 'railgun-artifacts-test',
    signal: new AbortController().signal,
  });
  handle = scope.getContext({
    kind: 'private-account',
    principal: 'fixture',
    protocol: 'railgun',
    deployment: 'fixture',
    chainId: 11155111,
    role: 'artifacts',
  });
  const key = abi.decodeFunctionResult(
    'getVerificationKey',
    deployment.verificationKeys[0].encoded
  )[0];
  const g1 = (p) => [p.x.toString(), p.y.toString(), '1'];
  const g2 = (p) => [
    [p.x[1].toString(), p.x[0].toString()],
    [p.y[1].toString(), p.y[0].toString()],
    ['1', '0'],
  ];
  vkey = {
    protocol: 'groth16',
    curve: 'bn128',
    nPublic: 4,
    vk_alpha_1: g1(key.alpha1),
    vk_beta_2: g2(key.beta2),
    vk_gamma_2: g2(key.gamma2),
    vk_delta_2: g2(key.delta2),
    IC: key.ic.map(g1),
  };
  mockLoad
    .mockReset()
    .mockImplementation(async (name) =>
      name.endsWith('.vkey') ? Buffer.from(JSON.stringify(vkey)) : Buffer.alloc(10, 1)
    );
});
afterEach(() => scope.close());
const load = () =>
  loadRailgunArtifacts({ handle, directory: '/unused-reviewed-test-fixture', variant: '01x01' });
test('pins all artifacts before loading and accepts only the exact matching deployed verifier', async () => {
  const artifacts = await load();
  expect(mockManifest).toBe(manifest['01x01']);
  expect(mockManifest.every((e) => /^[0-9a-f]{64}$/.test(e.sha256) && e.size > 0)).toBe(true);
  expect(Object.isFrozen(artifacts.vkey.IC[0])).toBe(true);
  expect(() =>
    assertRailgunArtifactVerifier(artifacts, deployment.verificationKeys[0].encoded)
  ).not.toThrow();
  expect(() =>
    assertRailgunArtifactVerifier(artifacts, deployment.verificationKeys[1].encoded)
  ).toThrow();
  expect(() =>
    assertRailgunArtifactVerifier({ ...artifacts }, deployment.verificationKeys[0].encoded)
  ).toThrow();
  expect(() =>
    assertRailgunArtifactVerifier(artifacts, deployment.verificationKeys[0].encoded + '00')
  ).toThrow();
  scope.close();
  expect(() =>
    assertRailgunArtifactVerifier(artifacts, deployment.verificationKeys[0].encoded)
  ).toThrow();
});
test('an altered coordinate cannot match a deployed verifier', async () => {
  vkey.vk_beta_2[0].reverse();
  const artifacts = await load();
  expect(() =>
    assertRailgunArtifactVerifier(artifacts, deployment.verificationKeys[0].encoded)
  ).toThrow();
});
test('unknown circuit and failed artifact load cannot fall back to networking or another shape', async () => {
  await expect(
    loadRailgunArtifacts({ handle, directory: '/unused', variant: '08x02' })
  ).rejects.toThrow();
  expect(mockLoad).not.toHaveBeenCalled();
  const wasm = Buffer.alloc(10, 7);
  mockLoad.mockImplementationOnce(async () => wasm).mockRejectedValueOnce(Error('digest mismatch'));
  await expect(load()).rejects.toThrow();
  expect(wasm.every((b) => b === 0)).toBe(true);
});
