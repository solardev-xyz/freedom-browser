/**
 * `swarm:get-stamps` on the core's backend (stamp-service.js; freedom-core
 * design 0015, "Methods main calls": `swarm.stamps`, "Main's own node
 * methods' params"; the SWM-6 to SWM-9 plan's PR 8.3): one `swarm.stamps`
 * through main's own calls (core/swarm-own-calls.js, the test's here), no
 * bee-js and no raw `/stamps` read of main's, each batch normalized to the
 * Freedom batch model as the JS backend normalizes bee-js's. Against the
 * pinned core's `vectors/swarm.json` (FREEDOM_CORE_SWARM_VECTORS), the
 * core's recorded answer normalizes as the reference's batches do.
 * publish-service-core.integration.test.js compares both backends against
 * the real core.
 */

const ipcHandlers = {};
jest.mock('electron', () => ({
  ipcMain: {
    handle: (channel, handler) => {
      ipcHandlers[channel] = handler;
    },
    removeHandler: () => {},
  },
}));
jest.mock('electron-log', () => ({ info: jest.fn(), error: jest.fn() }));
jest.mock('../service-registry', () => ({ getAntApiUrl: () => 'http://127.0.0.1:1633' }));
jest.mock('./swarm-backend-kind', () => ({ swarmBackendKind: () => 'core' }));
// bee-js's path and main's raw read are the JS backend's: never asked on core.
const mockBeeJs = { getAll: jest.fn() };
jest.mock('@ethersphere/bee-js', () => ({
  Bee: jest.fn().mockImplementation(() => ({ stamp: { getAll: mockBeeJs.getAll } })),
}));
const mockRawStamps = jest.fn();
jest.mock('./ant-storage-api', () => ({ getStamps: (...args) => mockRawStamps(...args) }));
const mockCalls = { stamps: jest.fn() };
jest.mock('../core/swarm-own-calls', () => ({ swarmOwnCalls: () => mockCalls }));

const { readPlain } = require('../core/swarm-typed');
const { swarmVectors } = require('../../../test/helpers/swarm-vectors');
const { normalizeBatch, normalizeCoreBatch, registerSwarmIpc } = require('./stamp-service');

registerSwarmIpc();

const invoke = (channel, ...args) => ipcHandlers[channel]({}, ...args);
const VECTORS = swarmVectors('swarm.json');
const testIfVectors = VECTORS ? test : test.skip;

/** A batch as the core's `swarm.stamps` answers it. */
const coreBatch = (overrides = {}) => ({
  batchID: 'a1'.repeat(32),
  utilization: 0,
  usable: true,
  label: 'freedom',
  depth: 22,
  amount: '100000000000',
  bucketDepth: 16,
  blockNumber: 1000,
  immutableFlag: true,
  usage: 0,
  usageText: '0%',
  size: 7070000000,
  remainingSize: 7070000000,
  theoreticalSize: 17179869184,
  duration: 2000,
  exists: true,
  batchTTL: 2000,
  ...overrides,
});

beforeEach(() => jest.clearAllMocks());
afterEach(() => {
  expect(mockBeeJs.getAll).not.toHaveBeenCalled();
  expect(mockRawStamps).not.toHaveBeenCalled();
});

test('swarm:get-stamps is one swarm.stamps, each batch the Freedom batch model, its expiry counted from now', async () => {
  const now = Date.parse('2026-11-28T12:00:00.000Z');
  const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
  try {
    mockCalls.stamps.mockResolvedValueOnce([
      coreBatch(),
      coreBatch({
        batchID: 'c3'.repeat(32),
        usable: false,
        duration: 10,
        batchTTL: 10,
        propagating: true,
      }),
      coreBatch({
        batchID: 'b2'.repeat(32),
        immutableFlag: false,
        usage: 1,
        remainingSize: 0,
        exists: false,
      }),
    ]);
    const answer = await invoke('swarm:get-stamps');
    expect(mockCalls.stamps).toHaveBeenCalledWith();
    expect(answer).toEqual({
      success: true,
      stamps: [
        {
          batchId: 'a1'.repeat(32),
          depth: 22,
          usable: true,
          pending: false,
          isMutable: false,
          sizeBytes: 7070000000,
          remainingBytes: 7070000000,
          usagePercent: 0,
          ttlSeconds: 2000,
          expiresApprox: new Date(now + 2000 * 1000).toISOString(),
        },
        {
          batchId: 'c3'.repeat(32),
          depth: 22,
          usable: false,
          pending: true,
          isMutable: false,
          sizeBytes: 7070000000,
          remainingBytes: 7070000000,
          usagePercent: 0,
          ttlSeconds: 10,
          expiresApprox: new Date(now + 10 * 1000).toISOString(),
        },
        {
          batchId: 'b2'.repeat(32),
          depth: 22,
          usable: true,
          pending: false,
          isMutable: true,
          sizeBytes: 7070000000,
          remainingBytes: 0,
          usagePercent: 100,
          ttlSeconds: 2000,
          expiresApprox: new Date(now + 2000 * 1000).toISOString(),
        },
      ],
    });
  } finally {
    clock.mockRestore();
  }
});

test("pending is read from the batch's own exists, propagating and batchTTL, as from the node's raw /stamps", () => {
  const pending = (overrides) =>
    normalizeCoreBatch(coreBatch({ usable: false, ...overrides })).pending;
  expect(pending({})).toBe(true);
  expect(pending({ propagating: false })).toBe(false);
  expect(pending({ exists: false })).toBe(false);
  expect(pending({ batchTTL: 0 })).toBe(false);
  expect(normalizeCoreBatch(coreBatch({ duration: 0, batchTTL: 0 })).expiresApprox).toBeNull();
});

test("the core's error, or an answer that isn't a list, fails the handler as bee-js's did", async () => {
  mockCalls.stamps.mockRejectedValueOnce(
    Object.assign(new Error('Internal Server Error: {"code":500,"message":"stamps failed"}'), {
      status: 500,
    })
  );
  expect(await invoke('swarm:get-stamps')).toEqual({
    success: false,
    error: 'Internal Server Error: {"code":500,"message":"stamps failed"}',
  });
  mockCalls.stamps.mockResolvedValueOnce({ batchID: 'a1'.repeat(32) });
  expect(await invoke('swarm:get-stamps')).toEqual({
    success: false,
    error: "The core's swarm.stamps answer is not a list",
  });
});

testIfVectors(
  "the core's recorded swarm.stamps answers normalize as the reference's batches and raw /stamps do",
  () => {
    const cases = VECTORS.shell.filter((c) => c.method === 'swarm.stamps' && !c.steps[0].params.id);
    const listed = cases.filter((c) => c.steps[0].reference.result?.length);
    expect(listed.length).toBeGreaterThan(0);
    const now = Date.parse('2026-11-28T12:00:00.000Z');
    for (const c of listed) {
      const [step] = c.steps;
      const raw = c.world.node.stamps.stamps;
      const answered = readPlain(step.answer.result_typed);
      const fromCore = answered.map((batch) => normalizeCoreBatch(batch, now));
      // The reference's batches, as bee-js mapped them, with the node's own entries.
      const fromReference = step.reference.result.map((batch, i) => ({
        ...normalizeBatch(batch, raw[i]),
        expiresApprox:
          batch.duration > 0 ? new Date(now + batch.duration * 1000).toISOString() : null,
      }));
      expect({ id: c.id, stamps: fromCore }).toEqual({ id: c.id, stamps: fromReference });
    }
  }
);
