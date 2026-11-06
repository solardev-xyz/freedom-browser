// The Ant backend a `bzz:` request captures, with its verification
// (freedom-core design 0009, Modes and Verify plans): an external Ant, a
// reused one among them, carries `verify: true` while the profile's "Verify
// content from this node" is on; Ant has no probe. The bundled Ant, and every
// Ant against a core without the verifier (protocol 1), keep the two-key
// reference. The handler's use of it is in bzz-protocol.test.js.
const mockRegistry = { mode: 'bundled', url: 'http://127.0.0.1:1633' };
jest.mock('../service-registry', () => ({
  MODE: { BUNDLED: 'bundled', EXTERNAL: 'external', REUSED: 'reused' },
  getAntApiUrl: () => mockRegistry.url,
  getService: () => (mockRegistry.mode ? { mode: mockRegistry.mode } : undefined),
}));
let mockProfile = null;
jest.mock('../profile-resolver', () => ({ getActiveProfile: () => mockProfile }));
let mockVerifier = null;
jest.mock('../core/dweb-verify', () => ({ dwebVerifier: () => mockVerifier }));
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { antBackend } = require('./bzz-protocol');

const profile = (bee) => ({ metadata: { nodes: { bee } } });

beforeEach(() => {
  mockRegistry.mode = 'bundled';
  mockRegistry.url = 'http://127.0.0.1:1633';
  mockProfile = null;
  mockVerifier = {};
});

describe("the Ant backend's verification", () => {
  test('an external Ant verifies by default', () => {
    mockRegistry.mode = 'external';
    expect(antBackend().ref).toEqual({ ant: 'external', up: true, verify: true });
    mockProfile = profile({ mode: 'external', externalApi: 'http://10.0.0.2:1633' });
    expect(antBackend().ref).toEqual({ ant: 'external', up: true, verify: true });
  });

  test('a reused Ant counts as external, and verifies too', () => {
    mockRegistry.mode = 'reused';
    mockProfile = profile({ mode: 'managed' });
    expect(antBackend().ref).toEqual({ ant: 'external', up: true, verify: true });
  });

  test('with the setting off, the two-key reference', () => {
    mockProfile = profile({ mode: 'external', verify: false });
    for (const mode of ['external', 'reused']) {
      mockRegistry.mode = mode;
      expect(antBackend().ref).toEqual({ ant: 'external', up: true });
    }
  });

  test('a change applies to the backends captured after it (Binding)', () => {
    mockRegistry.mode = 'external';
    mockProfile = profile({ mode: 'external' });
    const before = antBackend();
    mockProfile.metadata.nodes.bee.verify = false;
    const after = antBackend();
    expect(before.ref).toEqual({ ant: 'external', up: true, verify: true });
    expect(after.ref).toEqual({ ant: 'external', up: true });
  });

  test('a node that is not up keeps the member: its plan is the 503', () => {
    mockRegistry.mode = 'external';
    mockRegistry.url = null;
    expect(antBackend().ref).toEqual({ ant: 'external', up: false, verify: true });
  });

  test('the bundled Ant keeps its exact two-key reference, setting or not', () => {
    mockProfile = profile({ mode: 'managed', verify: true });
    expect(antBackend().ref).toEqual({ ant: 'bundled', up: true });
    mockRegistry.url = null;
    expect(antBackend().ref).toEqual({ ant: 'bundled', up: false });
  });

  test('against a core without the verifier (protocol 1), the two-key reference', () => {
    mockVerifier = null;
    mockRegistry.mode = 'external';
    expect(antBackend().ref).toEqual({ ant: 'external', up: true });
    mockRegistry.mode = 'reused';
    expect(antBackend().ref).toEqual({ ant: 'external', up: true });
  });

  test('Ant has no probe and no `car`: capturing dials nothing', () => {
    mockRegistry.mode = 'external';
    const fetchImpl = jest.fn();
    const backend = antBackend({ fetchImpl });
    expect(backend.car).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
