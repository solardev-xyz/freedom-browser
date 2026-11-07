// The Ant backend a `bzz:` request captures, with its verification
// (freedom-core design 0009, Modes and Verify plans): an external Ant, a
// reused one among them, carries `verify: true` while the profile's "Verify
// content from this node" is on; Ant has no probe. The bundled Ant, and every
// Ant while the core's verifier isn't attached, keep the two-key
// reference. The profile's strict mode (design 0009, Strict mode) is captured
// with it: `strict: true` on an external Ant while "Load only verified content
// from external nodes" is on. The handler's use of it is in
// bzz-protocol.test.js.
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
let mockSettings = {};
jest.mock('../settings-store', () => ({ loadSettings: () => mockSettings }));
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { antBackend } = require('./bzz-protocol');

const profile = (bee) => ({ metadata: { nodes: { bee } } });

beforeEach(() => {
  mockRegistry.mode = 'bundled';
  mockRegistry.url = 'http://127.0.0.1:1633';
  mockProfile = null;
  mockVerifier = {};
  mockSettings = {};
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

  test('without the verifier attached, the two-key reference', () => {
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

describe('strict mode on the Ant backend', () => {
  const STRICT = { loadOnlyVerifiedContent: true };

  test('an external or reused Ant carries `strict`, its verification on or off', () => {
    mockSettings = STRICT;
    for (const mode of ['external', 'reused']) {
      mockRegistry.mode = mode;
      mockProfile = profile({ mode: mode === 'reused' ? 'managed' : 'external' });
      expect(antBackend().ref).toEqual({ ant: 'external', up: true, verify: true, strict: true });
      // Verification off: the core refuses its content with strict mode's
      // first message.
      mockProfile.metadata.nodes.bee.verify = false;
      expect(antBackend().ref).toEqual({ ant: 'external', up: true, strict: true });
    }
    // A node that isn't up keeps it: its plan is the 503 all the same.
    mockRegistry.url = null;
    expect(antBackend().ref).toEqual({ ant: 'external', up: false, strict: true });
  });

  test('off by default, and on only for `true`', () => {
    mockRegistry.mode = 'external';
    for (const value of [undefined, false, 'true', 1, null]) {
      mockSettings = { loadOnlyVerifiedContent: value };
      expect(antBackend().ref).toEqual({ ant: 'external', up: true, verify: true });
    }
  });

  test('a change applies to the backends captured after it (Binding)', () => {
    mockRegistry.mode = 'external';
    const before = antBackend();
    mockSettings = STRICT;
    const on = antBackend();
    mockSettings = {};
    const off = antBackend();
    expect(before.ref).toEqual({ ant: 'external', up: true, verify: true });
    expect(on.ref).toEqual({ ant: 'external', up: true, verify: true, strict: true });
    expect(off.ref).toEqual({ ant: 'external', up: true, verify: true });
  });

  test("the bundled Ant is untouched: its content is the node's own", () => {
    mockSettings = STRICT;
    expect(antBackend().ref).toEqual({ ant: 'bundled', up: true });
    mockRegistry.url = null;
    expect(antBackend().ref).toEqual({ ant: 'bundled', up: false });
  });

  test('without the verifier attached, the two-key reference', () => {
    mockSettings = STRICT;
    mockVerifier = null;
    for (const mode of ['external', 'reused']) {
      mockRegistry.mode = mode;
      expect(antBackend().ref).toEqual({ ant: 'external', up: true });
      mockProfile = profile({ mode: 'external', verify: false });
      expect(antBackend().ref).toEqual({ ant: 'external', up: true });
      mockProfile = null;
    }
  });
});
