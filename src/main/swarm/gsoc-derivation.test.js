// Real bee-js, real worker thread: moving GSOC mining off the main thread
// (#503) must not move any room. Each topic below is derived both by the
// synchronous main-thread implementation this replaced (copied verbatim) and
// by the new worker-backed `deriveGsoc`, and both must also equal the pinned
// address — the latter guards the frozen derivation constants themselves.
const { Bee, Bytes, Identifier } = require('@ethersphere/bee-js');

const mockBee = new Bee('http://127.0.0.1:1633');
jest.mock('./swarm-service', () => ({
  getBee: () => mockBee,
  selectBestBatch: jest.fn(),
  toHex: (value) => value?.toHex?.() || String(value || ''),
}));
jest.mock('electron-log', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const miner = require('./gsoc-miner');
const { deriveGsoc, _resetGsocCache } = require('./messaging-service');

// The pre-#503 implementation, run inline on this thread.
function legacyDeriveGsoc(topic) {
  const keccakOfUtf8 = (text) => Bytes.keccak256(Buffer.from(text, 'utf-8')).toUint8Array();
  const identifier = new Identifier(keccakOfUtf8(topic));
  const targetOverlay = keccakOfUtf8('freedom-gsoc-v1:' + topic);
  const signer = mockBee.messaging.gsocMine(targetOverlay, identifier, 12);
  const address = mockBee
    .calculateSingleOwnerChunkAddress(identifier, signer.publicKey().address())
    .toHex();
  return { identifier, signer, address };
}

// Pinned from the pre-#503 messaging-service.js on main (6b5c2ea7), run
// unmodified: topic → [SOC address, mined signer key].
const FIXED = {
  'room:doc-42': ['457d444476f6de5d990d9465662d55462efd4be2ef34303bf922cedc7d89b1a9', '1118'],
  'chat': ['afa2b50effd3d1c01bd48e2dcc1fcc44fa704bf271ac8f9e02dd5f28705e3d0e', '0bc2'],
  '': ['e2332de4d1d4ee3fa8b5a4ce074cc425633a54aa6083772ec3b1f51bb100811a', '0e21'],
  'ünïcødé ✓ room': ['73301bdfed3f790d629c4f9c55472fe9d6eea366cebfe9183cd87856f3dd8973', '23aa'],
};

beforeEach(() => {
  _resetGsocCache();
  miner.resetForTest();
});

afterAll(() => miner.resetForTest());

// Both derivations mine for real: ~1.5 s each for the slowest topic here
// ('ünïcødé ✓ room', mined key 0x23aa) on an idle dev box. Run back to back
// they took 3.0 s of jest's 5 s default, and two jest runs side by side were
// enough to push that topic over (#535). So the worker is started first and
// the inline copy mines on this thread while it runs: same two derivations,
// same assertions, about half the wall time.
//
// The 20 s ceiling sits above the miner's own 15 s runaway bound
// (MINE_TIMEOUT_MS), so a worker that really stalls fails with the miner's
// `gsoc_mining_timeout` rather than with jest's generic timeout.
test.each(Object.keys(FIXED))('topic %p derives identically on the worker', async (topic) => {
  const derivation = deriveGsoc(topic, { origin: 'https://test.example' });
  const legacy = legacyDeriveGsoc(topic);
  const derived = await derivation;

  expect(derived.signer.toHex()).toBe(legacy.signer.toHex());
  expect(derived.identifier.toHex()).toBe(legacy.identifier.toHex());
  expect(derived.address).toBe(legacy.address);
  expect(derived.signer.publicKey().address().toHex())
    .toBe(legacy.signer.publicKey().address().toHex());
  const [address, signerTail] = FIXED[topic];
  expect(derived.address).toBe(address);
  expect(derived.signer.toHex()).toBe(signerTail.padStart(64, '0'));
}, 20_000);

test('a real runaway job is terminated and the next job still mines', async () => {
  // Proximity 256 can never be met, so bee-js walks its whole 0xffff-key
  // range (~5 s) — stand-in for a runaway. A short timeout must kill it.
  miner.resetForTest({ timeoutMs: 300 });
  const started = Date.now();
  await expect(miner.mineSigner(new Uint8Array(32), new Uint8Array(32), 256))
    .rejects.toMatchObject({ reason: 'gsoc_mining_timeout' });
  expect(Date.now() - started).toBeLessThan(2_000);

  miner.resetForTest();
  const legacy = legacyDeriveGsoc('after-timeout');
  await expect(deriveGsoc('after-timeout', { origin: 'https://test.example' }))
    .resolves.toMatchObject({ address: legacy.address });
}, 20_000);
