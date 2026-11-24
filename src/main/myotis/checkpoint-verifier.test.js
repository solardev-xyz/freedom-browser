jest.mock('./checkpoint-colibrid', () => ({ acquireColibridCheckpoint: jest.fn() }));
const { acquireColibridCheckpoint } = require('./checkpoint-colibrid');
const {
  acquireCheckpoint,
  validateCheckpoint,
  CHECKPOINT_NETWORKS,
  MAX_AGE_MS,
} = require('./checkpoint-verifier');

const NOW = Date.UTC(2026, 8, 14, 21);
function checkpoint(chainId = 1) {
  const config = CHECKPOINT_NETWORKS[chainId];
  const slot =
    Math.floor((NOW / 1000 - config.genesis) / config.secondsPerSlot / config.slotsPerEpoch) *
      config.slotsPerEpoch -
    config.slotsPerEpoch;
  return {
    schemaVersion: 2,
    chainId,
    network: config.network,
    root: '0x' + '12'.repeat(32),
    slot,
    verifiedAt: NOW,
    sources: config.sources.slice(0, config.participants),
    finalizedEpoch: slot / config.slotsPerEpoch,
  };
}

// The check itself, its bounds and its evidence are checkpoint-colibrid's
// (checkpoint-colibrid.test.js).
describe('the verifier', () => {
  afterEach(() => acquireColibridCheckpoint.mockReset());

  test("freedom-colibrid's one-shot process, with the caller's options", async () => {
    const options = { signal: new AbortController().signal, onDiagnostic: () => {} };
    acquireColibridCheckpoint.mockResolvedValue(checkpoint(100));
    await expect(acquireCheckpoint(100, options)).resolves.toEqual(checkpoint(100));
    expect(acquireColibridCheckpoint).toHaveBeenCalledWith(100, options);
  });

  test('its failure is the caller\'s, as it gave it', async () => {
    const failure = Object.assign(new Error('stale'), { code: 'CHECKPOINT_STALE' });
    acquireColibridCheckpoint.mockRejectedValue(failure);
    await expect(acquireCheckpoint(1)).rejects.toBe(failure);
    expect(acquireColibridCheckpoint).toHaveBeenCalledWith(1, {});
  });
});

describe('checkpoint record validation', () => {
  test.each([1, 100])('validates pinned chain %i', (chainId) => {
    expect(validateCheckpoint(checkpoint(chainId), chainId, { now: NOW })).toEqual(
      checkpoint(chainId)
    );
  });

  test.each([
    { sources: ['https://mainnet1.colibri-proof.tech'] },
    { root: '0x' + '00'.repeat(32) },
    { slot: 1.5 },
    { network: 'gnosis' },
    { schemaVersion: 3 },
    { finalizedEpoch: -1 },
  ])('rejects malformed or unpinned record %p', (patch) => {
    expect(() => validateCheckpoint({ ...checkpoint(), ...patch }, 1, { now: NOW })).toThrow(
      expect.objectContaining({ code: 'CHECKPOINT_MISMATCH' })
    );
  });

  test.each([
    [],
    [CHECKPOINT_NETWORKS[1].sources[0]],
    Array(2).fill(CHECKPOINT_NETWORKS[1].sources[0]),
    CHECKPOINT_NETWORKS[1].sources.slice(0, 4),
    ['https://unapproved.invalid', CHECKPOINT_NETWORKS[1].sources[0]],
  ])('missing, duplicate or unapproved voters cannot authorize a record: %p', (...sources) => {
    expect(() => validateCheckpoint({ ...checkpoint(), sources }, 1, { now: NOW })).toThrow();
  });

  test('legacy single-authority records can resume but cannot authorize new recovery', () => {
    const value = { ...checkpoint(), schemaVersion: 1, source: CHECKPOINT_NETWORKS[1].source };
    delete value.sources;
    expect(() => validateCheckpoint(value, 1, { now: NOW })).toThrow();
    expect(validateCheckpoint(value, 1, { now: NOW, fresh: false })).toEqual(value);
  });

  test('aged record is valid structurally for native snapshot freshness evaluation', () => {
    const value = checkpoint();
    const later = NOW + MAX_AGE_MS + 1;
    expect(() => validateCheckpoint(value, 1, { now: later })).toThrow(
      expect.objectContaining({ code: 'CHECKPOINT_STALE' })
    );
    expect(validateCheckpoint(value, 1, { now: later, fresh: false })).toEqual(value);
    expect(() =>
      validateCheckpoint({ ...value, sources: ['https://other.test'] }, 1, { fresh: false })
    ).toThrow(expect.objectContaining({ code: 'CHECKPOINT_MISMATCH' }));
  });

  test('a record verified in the future is a clock error', () => {
    expect(() =>
      validateCheckpoint({ ...checkpoint(), verifiedAt: NOW + 1 }, 1, { now: NOW })
    ).toThrow(expect.objectContaining({ code: 'CHECKPOINT_CLOCK' }));
  });
});
