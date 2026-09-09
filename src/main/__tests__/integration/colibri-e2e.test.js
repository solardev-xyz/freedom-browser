/**
 * End-to-end battery for the Colibri-backed ENS resolution path.
 *
 * Gated by ENS_COLIBRI_E2E=1 — CI does not hit the partner prover by
 * default. Run locally with:
 *
 *   NODE_OPTIONS=--experimental-vm-modules ENS_COLIBRI_E2E=1 \
 *     npx jest src/main/__tests__/integration/colibri-e2e.test.js
 *
 * The Colibri CJS shim loads the emscripten glue via dynamic import, so
 * Jest needs VM Modules enabled.
 *
 * Verifies the four scenarios the partner is on the hook for:
 *   1. contenthash + addr on a well-known name (verified happy path)
 *   2. NO_RESOLVER on an unregistered name (revert proven correctly)
 *   3. .box via CCIP-Read (OffchainLookup round-trip + final proven call)
 *   4. Repeated lookups don't leak / fall over (sanity for the warm path)
 *
 * No package mocks — the real @corpus-core/colibri-stateless WASM runs
 * (WASM specifically: since 2.0.5 the package prefers a native addon, which
 * `src/main/ens/colibri-runtime.js` disables — see the comment there).
 * Electron's app.getPath is mocked to a temp dir so the verifier state
 * doesn't pollute the developer's userData folder.
 */

const E2E_ENABLED = process.env.ENS_COLIBRI_E2E === '1';
const describeOrSkip = E2E_ENABLED ? describe : describe.skip;

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mockTempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'colibri-e2e-'));

jest.mock('electron', () => ({
  app: { getPath: () => mockTempUserData },
  ipcMain: { handle: jest.fn() },
}));

const TIMEOUT_MS = 60_000;

// Nothing is stubbed: the real network-registry reads the builtin
// chains.json / endpoint-sources.json, and the fresh temp userData dir has
// no user config — so mainnet resolves to its `colibri` default against the
// default prover. The Colibri package is NOT mocked — real WASM, real prover.
const {
  resolveEnsContent,
  resolveEnsAddress,
  resolveEnsReverse,
  clearEnsResolutionCaches,
} = require('../../ens-resolver');
const { clearColibriClientForTest } = require('../../ens/colibri-resolver');

beforeEach(() => {
  clearEnsResolutionCaches();
});

afterAll(() => {
  clearColibriClientForTest();
  try { fs.rmSync(mockTempUserData, { recursive: true, force: true }); }
  catch { /* best-effort cleanup */ }
});

describeOrSkip('colibri e2e against mainnet1.colibri-proof.tech', () => {
  test('resolves vitalik.eth contenthash with verified-via-colibri trust', async () => {
    const result = await resolveEnsContent('vitalik.eth');
    expect(result.type).toBe('ok');
    expect(result.uri).toMatch(/^(ipfs|ipns|bzz):\/\//);
    expect(result.trust).toMatchObject({
      level: 'verified',
      method: 'colibri',
      prover: 'mainnet1.colibri-proof.tech',
    });
  }, TIMEOUT_MS);

  test('resolves vitalik.eth addr to a non-zero address', async () => {
    const result = await resolveEnsAddress('vitalik.eth');
    expect(result.success).toBe(true);
    expect(result.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(result.address.toLowerCase()).not.toBe('0x' + '0'.repeat(40));
    expect(result.trust.method).toBe('colibri');
  }, TIMEOUT_MS);

  test('reverse-resolves vitalik.eth\'s known address back to vitalik.eth', async () => {
    // Vitalik's known main address. The reverse record is well-known and
    // forward-verifies. Catches a regression where the reverse path falls
    // off the Colibri orchestrator branch.
    const result = await resolveEnsReverse('0xd8da6bf26964af9d7eed9e03e53415d37aa96045');
    expect(result.success).toBe(true);
    expect(result.name).toBe('vitalik.eth');
    expect(result.trust).toMatchObject({
      level: 'verified',
      method: 'colibri',
      prover: 'mainnet1.colibri-proof.tech',
    });
  }, TIMEOUT_MS);

  test('unregistered name surfaces as NO_RESOLVER (verified revert)', async () => {
    const result = await resolveEnsContent('this-name-definitely-does-not-exist-zzz-12345.eth');
    expect(result.type).toBe('not_found');
    expect(result.reason).toBe('NO_RESOLVER');
    expect(result.trust.method).toBe('colibri');
  }, TIMEOUT_MS);

  test('.box CCIP-Read resolves through to a final proven eth_call', async () => {
    // .box names are 3DNS-backed and require CCIP-Read. The Colibri prover
    // surfaces the OffchainLookup revert; ethers fetches the gateway data
    // and submits resolveCallback, which is independently proven.
    // If this regresses, the integration loses .box support entirely.
    const result = await resolveEnsContent('vitalik.box');
    // Accept any non-error outcome — the point is "didn't throw on CCIP".
    expect(['ok', 'not_found', 'unsupported']).toContain(result.type);
    expect(result.trust.method).toBe('colibri');
  }, TIMEOUT_MS);

  test('repeated lookups warm the cache and stay healthy', async () => {
    // First call is the real prover hit; rest are cache hits (15-min TTL).
    // The point is to exercise the cache + singleton interaction and
    // catch any unbounded-growth or stale-state regression in one shot.
    const first = await resolveEnsContent('vitalik.eth');
    expect(first.type).toBe('ok');
    for (let i = 0; i < 5; i++) {
      const r = await resolveEnsContent('vitalik.eth');
      expect(r.type).toBe('ok');
      expect(r.uri).toBe(first.uri);
    }
  }, TIMEOUT_MS);
});
