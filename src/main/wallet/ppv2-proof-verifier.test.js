jest.mock('./privacy-process', () => ({ runPrivacyProcess: (...args) => mockRun(...args) }));
jest.mock('./ppv2-runtime', () => ({ getPPv2VerifierEntry: () => '/reviewed/serial-prover.cjs' }));
const { createPrivacyScope } = require('../networks/privacy-context');
const { verifyPPv2Proof } = require('./ppv2-proof-verifier');
const { relayFixture } = require('../../../test/helpers/ppv2-relay-fixture');
let scope, args, mockRun;
beforeEach(() => {
  scope = createPrivacyScope({ profileId: 'fixture', signal: new AbortController().signal });
  const { publicSignals, ...proof } = JSON.parse(relayFixture().body).proof;
  args = {
    handle: scope.getContext({
      kind: 'private-account',
      principal: 'fixture',
      protocol: 'privacy-pools-v2',
      deployment: 'sepolia',
      chainId: 11155111,
      role: 'prover',
    }),
    sdkEntry: '/reviewed/sdk.cjs',
    circuit: 'transact_1x1',
    proof: { proof, publicSignals },
    vkey: new Uint8Array(100),
  };
  mockRun = jest.fn(async () => ({ result: { verified: true } }));
});
afterEach(() => scope.close());
test.each([
  ['deposit', 4],
  ['ragequit', 7],
  ['transact_1x1', 8],
])('sends only copied public verification inputs for %s', async (circuit, length) => {
  args.circuit = circuit;
  args.proof.publicSignals = args.proof.publicSignals.slice(0, length);
  await verifyPPv2Proof(args);
  const invocation = mockRun.mock.calls[0][0];
  expect(Object.keys(invocation.input).sort()).toEqual([
    'circuit',
    'proof',
    'proverEntry',
    'sdkEntry',
    'vkey',
  ]);
  expect(invocation.input.proof).not.toBe(args.proof);
  expect(invocation.input.vkey).not.toBe(args.vkey);
  expect(invocation.input.proverEntry).toBe('/reviewed/serial-prover.cjs');
  expect(invocation).toMatchObject({ timeoutMs: 30000, heapMb: 256, rssMb: 768 });
  expect(invocation.validateResult({ verified: true })).toBe(true);
  expect(invocation.validateResult({ verified: false })).toBe(false);
  expect(invocation.validateResult({ verified: 'true' })).toBe(false);
});
test('refuses widened circuits and malformed proofs before starting verification', async () => {
  await expect(verifyPPv2Proof({ ...args, circuit: 'transact_2x2' })).rejects.toThrow();
  await expect(verifyPPv2Proof({ ...args, proof: {} })).rejects.toThrow();
  await expect(verifyPPv2Proof({ ...args, vkey: new Uint8Array(8193) })).rejects.toThrow();
  expect(mockRun).not.toHaveBeenCalled();
});
test('verification failure or revocation prevents acceptance', async () => {
  mockRun.mockRejectedValueOnce(new Error('failed proof'));
  await expect(verifyPPv2Proof(args)).rejects.toThrow();
  mockRun.mockImplementationOnce(async () => {
    scope.close();
    return { result: { verified: true } };
  });
  await expect(verifyPPv2Proof(args)).rejects.toMatchObject({ code: 'PRIVACY_CONTEXT_REVOKED' });
});
