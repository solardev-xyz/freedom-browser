// Engine functions are deterministic test doubles: these tests exercise validation
// and argument binding, not Poseidon correctness. Native qualification covers crypto.
let mockPoseidon, mockHash, mockSelector, mockPosition, mockTokenHash;
jest.mock('./railgun-engine-runtime', () => ({
  verifyRailgunEngineRuntime: jest.fn(() => '/test/shield-selector.asar'),
}));
jest.mock(
  '/test/shield-selector.asar/node_modules/@railgun-community/engine/dist/utils/poseidon',
  () => ({
    get initPoseidonPromise() {
      return mockPoseidon;
    },
  }),
  { virtual: true }
);
jest.mock(
  '/test/shield-selector.asar/node_modules/@railgun-community/engine/dist/note/note-util',
  () => ({
    getTokenDataERC20: (tokenAddress) => ({ tokenType: 0, tokenAddress, tokenSubID: '0' }),
    getTokenDataHash: (...args) => mockTokenHash(...args),
  }),
  { virtual: true }
);
jest.mock(
  '/test/shield-selector.asar/node_modules/@railgun-community/engine/dist/note/erc20/shield-note-erc20',
  () => ({ ShieldNoteERC20: { getShieldNoteHash: (...args) => mockHash(...args) } }),
  { virtual: true }
);
jest.mock(
  '/test/shield-selector.asar/node_modules/@railgun-community/engine/dist/poi/blinded-commitment',
  () => ({ BlindedCommitment: { getForShieldOrTransact: (...args) => mockSelector(...args) } }),
  { virtual: true }
);
jest.mock(
  '/test/shield-selector.asar/node_modules/@railgun-community/engine/dist/poi/global-tree-position',
  () => ({ getGlobalTreePosition: (...args) => mockPosition(...args) }),
  { virtual: true }
);
const { createHash } = require('crypto');
const { run } = require('./railgun-poi-shield-selector-job');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
const { normalizeRailgunPoiShieldInput } = require('./railgun-poi-shield-selector-data');
const { normalizeRailgunPrivateCapsule } = require('./railgun-private-capsule');
const { sample } = require('../../../scripts/fixtures/railgun-own-txid-data');
const pins = require('./railgun-shield-pins.json');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const sha = (v) => createHash('sha256').update(v).digest('hex');
const refused = {
  code: 'RAILGUN_POI_SHIELD_SELECTOR_REFUSED',
  message: 'Railgun Shield POI selector unavailable',
};
let input, controller, request, guardReport;
beforeEach(() => {
  jest.clearAllMocks();
  verifyRailgunEngineRuntime.mockImplementation(() => '/test/shield-selector.asar');
  mockPoseidon = Promise.resolve();
  mockTokenHash = jest.fn(() => 17n);
  mockHash = jest.fn((npk, token, value) => npk + token + value);
  mockPosition = jest.fn((tree, position) => BigInt(tree) * 65536n + BigInt(position));
  mockSelector = jest.fn((hash, npk, position) => hex(BigInt(hash) + npk + position));
  controller = new AbortController();
  request = jest.fn(async () => JSON.stringify({ id: 1, value: null }));
  guardReport = jest.fn(() => ({ attempts: 0, canaries: 1, hooks: ['test.guard'] }));
  input = {
    archive: '/test/shield-selector.asar',
    bindingDigest: '2'.repeat(64),
    facts: {
      npk: hex(7),
      token: pins.wrappedNative,
      value: '1000',
      tree: 3,
      position: 23456,
      noteHash: hex(1024),
    },
  };
});
const execute = (text = JSON.stringify(input)) =>
  run(text, {
    request,
    signal: controller.signal,
    guardReport,
  });

test('recomputes preimage hash and global position, emits only exact diagnostic evidence', async () => {
  const text = JSON.stringify(input);
  await execute(text);
  expect(mockTokenHash).toHaveBeenCalledWith({
    tokenType: 0,
    tokenAddress: pins.wrappedNative,
    tokenSubID: '0',
  });
  expect(mockHash).toHaveBeenCalledTimes(1);
  expect(mockHash).toHaveBeenCalledWith(7n, 17n, 1000n);
  expect(mockPosition).toHaveBeenCalledWith(3, 23456);
  expect(mockSelector).toHaveBeenCalledWith(hex(1024), 7n, 220064n);
  expect(request).toHaveBeenCalledTimes(1);
  expect(JSON.parse(request.mock.calls[0][0])).toEqual({
    id: 1,
    method: 'result',
    value: {
      inputSha256: sha(text),
      bindingDigest: input.bindingDigest,
      blindedCommitment: hex(221095),
      selectorDerived: true,
      ownershipAuthenticated: false,
      sourceAuthenticated: false,
      membershipAuthenticated: false,
      disclosureEnabled: false,
      spendingEnabled: false,
      guards: { attempts: 0, canaries: 1, hooks: ['test.guard'] },
      inventory: require('./railgun-engine-manifest.json').inventory.sha256,
    },
  });
});

test.each([
  [
    'envelope-extra',
    (v) => {
      v.extra = true;
    },
  ],
  [
    'binding-case',
    (v) => {
      v.bindingDigest = 'A'.repeat(64);
    },
  ],
  [
    'binding-prefix',
    (v) => {
      v.bindingDigest = '0x' + v.bindingDigest;
    },
  ],
  [
    'facts-extra',
    (v) => {
      v.facts.extra = true;
    },
  ],
  [
    'facts-missing',
    (v) => {
      delete v.facts.npk;
    },
  ],
  [
    'npk-field',
    (v) => {
      v.facts.npk = hex(FIELD);
    },
  ],
  [
    'hash-field',
    (v) => {
      v.facts.noteHash = hex(FIELD);
    },
  ],
  [
    'npk-prefix',
    (v) => {
      v.facts.npk = v.facts.npk.slice(2);
    },
  ],
  [
    'hash-case',
    (v) => {
      v.facts.noteHash = '0x' + 'A'.repeat(64);
    },
  ],
  [
    'token',
    (v) => {
      v.facts.token = '0x' + '34'.repeat(20);
    },
  ],
  [
    'zero-value',
    (v) => {
      v.facts.value = '0';
    },
  ],
  [
    'numeric-value',
    (v) => {
      v.facts.value = 1000;
    },
  ],
  [
    'large-value',
    (v) => {
      v.facts.value = (1n << 120n).toString();
    },
  ],
  [
    'negative-tree',
    (v) => {
      v.facts.tree = -1;
    },
  ],
  [
    'large-tree',
    (v) => {
      v.facts.tree = 65536;
    },
  ],
  [
    'fraction-position',
    (v) => {
      v.facts.position = 1.5;
    },
  ],
  [
    'large-position',
    (v) => {
      v.facts.position = 65536;
    },
  ],
  [
    'oversize',
    (v) => {
      v.archive = 'x'.repeat(8193);
    },
  ],
])('independently refuses %s before runtime/hash/result', async (_name, mutate) => {
  mutate(input);
  await expect(execute()).rejects.toMatchObject(refused);
  expect(verifyRailgunEngineRuntime).not.toHaveBeenCalled();
  expect(mockHash).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});

test.each(['npk', 'value', 'noteHash'])(
  'rejects inconsistent %s at the engine hash comparison',
  async (key) => {
    if (key === 'npk') input.facts.npk = hex(8);
    if (key === 'value') input.facts.value = '1001';
    if (key === 'noteHash') input.facts.noteHash = hex(1025);
    await expect(execute()).rejects.toMatchObject(refused);
    expect(mockHash).toHaveBeenCalledTimes(1);
    expect(mockSelector).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  }
);

test('independently valid different-note capsule at the same position cannot reuse the preimage', async () => {
  const capsule = sample().capsule;
  capsule.noteHash = hex(1024);
  const creator = {
    type: 'Shield',
    tree: capsule.selection.tree,
    position: capsule.selection.position,
    preimage: {
      npk: hex(7),
      value: capsule.preparation.amount,
      token: { tokenType: 0, tokenAddress: pins.wrappedNative, tokenSubID: hex(0) },
    },
    ciphertext: { encryptedBundle: [hex(8), hex(9), hex(10)], shieldKey: hex(11) },
  };
  Object.assign(input, normalizeRailgunPoiShieldInput(capsule, creator));
  await execute();
  request.mockClear();
  const stale = JSON.parse(JSON.stringify(capsule));
  stale.noteHash = hex(1025);
  expect(normalizeRailgunPrivateCapsule(stale).selection).toEqual(capsule.selection);
  const changed = normalizeRailgunPoiShieldInput(stale, creator);
  expect(changed.bindingDigest).not.toBe(input.bindingDigest);
  Object.assign(input, changed);
  await expect(execute()).rejects.toMatchObject(refused);
  expect(request).not.toHaveBeenCalled();
});

test('consistent changed facts are a new request; the binding digest is echoed, not authenticated', async () => {
  await execute();
  const first = JSON.parse(request.mock.calls[0][0]).value;
  input.facts.npk = hex(8);
  input.facts.noteHash = hex(1025);
  input.facts.position++;
  await execute();
  const second = JSON.parse(request.mock.calls[1][0]).value;
  expect(second.inputSha256).toBe(sha(JSON.stringify(input)));
  expect(second.inputSha256).not.toBe(first.inputSha256);
  expect(second.blindedCommitment).not.toBe(first.blindedCommitment);
  expect(second.bindingDigest).toBe(first.bindingDigest);
  expect(second.ownershipAuthenticated).toBe(false);
});

test.each(['pre-abort', 'pin', 'hash-error', 'guards', 'selector-field', 'ack'])(
  'sanitizes %s failure and never emits additional broker requests',
  async (mode) => {
    if (mode === 'pre-abort') controller.abort();
    if (mode === 'pin')
      verifyRailgunEngineRuntime.mockImplementation(() => {
        throw Error('private path');
      });
    if (mode === 'hash-error')
      mockHash.mockImplementation(() => {
        throw Error('private preimage');
      });
    if (mode === 'guards') guardReport.mockReturnValue({ attempts: 1 });
    if (mode === 'selector-field') mockSelector.mockReturnValue(hex(FIELD));
    if (mode === 'ack') request.mockResolvedValue(JSON.stringify({ id: 2, value: null }));
    await expect(execute()).rejects.toMatchObject(refused);
    expect(request).toHaveBeenCalledTimes(mode === 'ack' ? 1 : 0);
    if (mode === 'pre-abort') expect(verifyRailgunEngineRuntime).not.toHaveBeenCalled();
  }
);

test('abort during engine initialization is observed before hashing or requesting', async () => {
  let release;
  mockPoseidon = new Promise((resolve) => {
    release = resolve;
  });
  let settled = false;
  const outcome = execute().catch((e) => {
    settled = true;
    return e;
  });
  controller.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  release();
  expect(await outcome).toMatchObject(refused);
  expect(mockHash).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});

test('abort while result acknowledgment is pending cannot complete successfully', async () => {
  let acknowledge, requestStarted;
  const arrived = new Promise((resolve) => {
    requestStarted = resolve;
  });
  request.mockImplementation(
    () =>
      new Promise((resolve) => {
        acknowledge = resolve;
        requestStarted();
      })
  );
  let settled = false;
  const outcome = execute().catch((e) => {
    settled = true;
    return e;
  });
  await arrived;
  controller.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  acknowledge(JSON.stringify({ id: 1, value: null }));
  expect(await outcome).toMatchObject(refused);
  expect(request).toHaveBeenCalledTimes(1);
});
