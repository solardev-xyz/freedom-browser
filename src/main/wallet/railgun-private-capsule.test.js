const { Interface, AbiCoder, keccak256 } = require('ethers');
const { TRANSACT_ABI, BOUND_PARAMS } = require('./railgun-private-policy');
const {
  normalizeRailgunPrivateCapsule,
  digestRailgunPrivateCapsule,
} = require('./railgun-private-capsule');
const pins = require('./railgun-shield-pins.json');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const field = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
let input;
beforeEach(() => {
  const recipient = '0x' + '12'.repeat(20),
    kind = 'railgun-token-unshield';
  const bound = [0, 0, 1, pins.chainId, '0x' + '0'.repeat(40), hex(0), []];
  const tx = [
    [
      [0, 0],
      [
        [0, 0],
        [0, 0],
      ],
      [0, 0],
    ],
    hex(1),
    [hex(2)],
    [hex(3)],
    bound,
    [hex(BigInt(recipient)), [0, pins.wrappedNative, 0], 1000],
  ];
  input = {
    version: 1,
    walletId: '1'.repeat(64),
    engineSha256: require('./railgun-engine-manifest.json').sha256,
    selection: { kind, tree: 0, position: 1, recipient },
    preparation: {
      transaction: {
        chainId: pins.chainId,
        to: pins.proxy,
        value: '0',
        data: new Interface([TRANSACT_ABI]).encodeFunctionData('transact', [[tx]]),
      },
      expected: {
        kind,
        tree: 0,
        merkleRoot: hex(1),
        nullifier: hex(2),
        commitment: hex(3),
        boundParamsHash: hex(
          BigInt(keccak256(AbiCoder.defaultAbiCoder().encode([BOUND_PARAMS], [bound]))) % field
        ),
        recipient,
        amount: '1000',
      },
      expectedHash: hex(4),
      recipient,
      amount: '1000',
    },
    noteHash: hex(5),
    pathElements: Array(16).fill(hex(6)),
  };
});
test('copies all nested data and hashes canonical order without granting cryptographic validity', () => {
  const capsule = normalizeRailgunPrivateCapsule(input),
    digest = digestRailgunPrivateCapsule(input);
  input.preparation.expected = Object.fromEntries(
    Object.entries(input.preparation.expected).reverse()
  );
  input.preparation.transaction = Object.fromEntries(
    Object.entries(input.preparation.transaction).reverse()
  );
  expect(digestRailgunPrivateCapsule(input)).toBe(digest);
  expect(digestRailgunPrivateCapsule(JSON.parse(JSON.stringify(input)))).toBe(digest);
  input.pathElements[0] = hex(7);
  expect(capsule.pathElements[0]).toBe(hex(6));
  expect(digestRailgunPrivateCapsule(input)).not.toBe(digest);
  for (const value of [
    capsule,
    capsule.selection,
    capsule.preparation,
    capsule.preparation.transaction,
    capsule.preparation.expected,
    capsule.pathElements,
  ])
    expect(Object.isFrozen(value)).toBe(true);
  expect(capsule.spendingEnabled).toBeUndefined();
});
test('recorded engine provenance does not strand a version-one capsule after an upgrade', () => {
  input.engineSha256 = 'f'.repeat(64);
  expect(normalizeRailgunPrivateCapsule(input).engineSha256).toBe('f'.repeat(64));
});
test.each([
  'version',
  'engine',
  'wallet',
  'short-path',
  'long-path',
  'path-field',
  'note-field',
  'negative-index',
  'large-index',
  'kind',
  'recipient',
  'amount',
  'message',
  'key',
  'witness',
  'signature',
])('refuses malformed or secret-bearing capsule %s', (mode) => {
  if (mode === 'version') input.version = 2;
  if (mode === 'engine') input.engineSha256 = 'invalid';
  if (mode === 'wallet') input.walletId = 'not a wallet';
  if (mode === 'short-path') input.pathElements.pop();
  if (mode === 'long-path') input.pathElements.push(hex(6));
  if (mode === 'path-field') input.pathElements[0] = hex(field);
  if (mode === 'note-field') input.noteHash = hex(field);
  if (mode === 'negative-index') input.selection.position = -1;
  if (mode === 'large-index') input.selection.position = 65536;
  if (mode === 'kind') input.selection.kind = 'shield';
  if (mode === 'recipient') input.selection.recipient = '0x' + '34'.repeat(20);
  if (mode === 'amount') input.preparation.amount = '999';
  if (mode === 'message') input.preparation.expectedHash = hex(field);
  if (['key', 'witness', 'signature'].includes(mode)) input[mode] = {};
  expect(() => normalizeRailgunPrivateCapsule(input)).toThrow();
});

test.each(['walletId', 'engine', 'selection', 'preparation', 'noteHash'])(
  'new capsule refuses substituted %s while historical normalization remains separate',
  (mode) => {
    const { normalizeRailgunNewCapsule } = require('./railgun-private-capsule');
    const owned = {
      walletId: input.walletId,
      selection: input.selection,
      preparation: input.preparation,
      noteHash: input.noteHash,
    };
    expect(normalizeRailgunNewCapsule(input, owned)).toEqual(input);
    const changed = structuredClone(input);
    if (mode === 'walletId') changed.walletId = 'f'.repeat(64);
    if (mode === 'engine') changed.engineSha256 = 'f'.repeat(64);
    if (mode === 'selection') changed.selection.position = 2;
    if (mode === 'preparation') changed.preparation.expectedHash = hex(9);
    if (mode === 'noteHash') changed.noteHash = hex(9);
    expect(() => normalizeRailgunNewCapsule(changed, owned)).toThrow();
  }
);

const {
  createRailgunPartialCapsuleData,
  createRailgunLegacyCapsuleData,
} = require('../../../scripts/fixtures/railgun-partial-capsule-data');
// Captured from the unchanged v1 normalizer before adding partial support.
const legacyGoldens = {
  'railgun-private-transfer': {
    canonical:
      '{"version":1,"walletId":"1111111111111111111111111111111111111111111111111111111111111111","engineSha256":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","selection":{"kind":"railgun-private-transfer","tree":0,"position":1,"recipient":"0zk1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq"},"preparation":{"transaction":{"chainId":11155111,"to":"0xecfcf3b4ec647c4ca6d49108b311b7a7c9543fea","value":"0","data":"0xd8ae136a0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000220000000000000000000000000000000000000000000000000000000000000026000000000000000000000000000000000000000000000000000000000000002a00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000aa36a70000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000b000000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000000d000000000000000000000000000000000000000000000000000000000000000e000000000000000000000000000000000000000000000000000000000000000f000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000000211220000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"},"expected":{"kind":"railgun-private-transfer","tree":0,"merkleRoot":"0x0000000000000000000000000000000000000000000000000000000000000001","nullifier":"0x0000000000000000000000000000000000000000000000000000000000000002","commitment":"0x0000000000000000000000000000000000000000000000000000000000000003","boundParamsHash":"0x0ec3eb6441cc05aff59e4f6eeff233fcf3b31cefe581bf6cd8e1200a73169e57"},"expectedHash":"0x0000000000000000000000000000000000000000000000000000000000000007","recipient":"0zk1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq","amount":"1000"},"noteHash":"0x0000000000000000000000000000000000000000000000000000000000000005","pathElements":["0x0000000000000000000000000000000000000000000000000000000000000006","0x0000000000000000000000000000000000000000000000000000000000000006","0x0000000000000000000000000000000000000000000000000000000000000006","0x0000000000000000000000000000000000000000000000000000000000000006","0x0000000000000000000000000000000000000000000000000000000000000006","0x0000000000000000000000000000000000000000000000000000000000000006","0x0000000000000000000000000000000000000000000000000000000000000006","0x0000000000000000000000000000000000000000000000000000000000000006","0x0000000000000000000000000000000000000000000000000000000000000006","0x0000000000000000000000000000000000000000000000000000000000000006","0x0000000000000000000000000000000000000000000000000000000000000006","0x0000000000000000000000000000000000000000000000000000000000000006","0x0000000000000000000000000000000000000000000000000000000000000006","0x0000000000000000000000000000000000000000000000000000000000000006","0x0000000000000000000000000000000000000000000000000000000000000006","0x0000000000000000000000000000000000000000000000000000000000000006"]}',
    canonicalSha256: '3529633853f4521d89c7b8a126ff676e38f58ffd2e0c69eed9eafd177798a199',
    digest: '17da6702e98815d2cd78b0d450d12ae25c41e695ad2cc5dfc570a680fbe3be1f',
  },
  'railgun-token-unshield': {
    canonical:
      '{"version":1,"walletId":"1111111111111111111111111111111111111111111111111111111111111111","engineSha256":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","selection":{"kind":"railgun-token-unshield","tree":0,"position":1,"recipient":"0x1212121212121212121212121212121212121212"},"preparation":{"transaction":{"chainId":11155111,"to":"0xecfcf3b4ec647c4ca6d49108b311b7a7c9543fea","value":"0","data":"0xd8ae136a0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000220000000000000000000000000000000000000000000000000000000000000026000000000000000000000000000000000000000000000000000000000000002a000000000000000000000000012121212121212121212121212121212121212120000000000000000000000000000000000000000000000000000000000000000000000000000000000000000fff9976782d46cc05630d1f6ebab18b2324d6b14000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003e800000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000aa36a70000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e00000000000000000000000000000000000000000000000000000000000000000"},"expected":{"kind":"railgun-token-unshield","tree":0,"merkleRoot":"0x0000000000000000000000000000000000000000000000000000000000000001","nullifier":"0x0000000000000000000000000000000000000000000000000000000000000002","commitment":"0x0000000000000000000000000000000000000000000000000000000000000003","boundParamsHash":"0x11c2654615f012a5e33889078107608a7237afe504a8b4d67f2980384dd971f9","recipient":"0x1212121212121212121212121212121212121212","amount":"1000"},"expectedHash":"0x0000000000000000000000000000000000000000000000000000000000000007","recipient":"0x1212121212121212121212121212121212121212","amount":"1000"},"noteHash":"0x0000000000000000000000000000000000000000000000000000000000000005","pathElements":["0x0000000000000000000000000000000000000000000000000000000000000006","0x0000000000000000000000000000000000000000000000000000000000000006","0x0000000000000000000000000000000000000000000000000000000000000006","0x0000000000000000000000000000000000000000000000000000000000000006","0x0000000000000000000000000000000000000000000000000000000000000006","0x0000000000000000000000000000000000000000000000000000000000000006","0x0000000000000000000000000000000000000000000000000000000000000006","0x0000000000000000000000000000000000000000000000000000000000000006","0x0000000000000000000000000000000000000000000000000000000000000006","0x0000000000000000000000000000000000000000000000000000000000000006","0x0000000000000000000000000000000000000000000000000000000000000006","0x0000000000000000000000000000000000000000000000000000000000000006","0x0000000000000000000000000000000000000000000000000000000000000006","0x0000000000000000000000000000000000000000000000000000000000000006","0x0000000000000000000000000000000000000000000000000000000000000006","0x0000000000000000000000000000000000000000000000000000000000000006"]}',
    canonicalSha256: '6324007a3eba24232cfd39c26f8c02a93197ca7f9739dcff10ab859453007d65',
    digest: '683f64568c66408a76e3dedf0c3f434ebc196543d6348a4ec307b6110e859e47',
  },
};
test.each(Object.keys(legacyGoldens))(
  'preserves exact pre-edit v1 canonical bytes and domain digest for %s',
  (kind) => {
    const fixture = createRailgunLegacyCapsuleData(kind).capsule;
    const canonical = JSON.stringify(normalizeRailgunPrivateCapsule(fixture));
    expect(canonical).toBe(legacyGoldens[kind].canonical);
    expect(require('crypto').createHash('sha256').update(canonical).digest('hex')).toBe(
      legacyGoldens[kind].canonicalSha256
    );
    expect(digestRailgunPrivateCapsule(fixture)).toBe(legacyGoldens[kind].digest);
  }
);
test('v2 canonical data is detached, uses its own domain, and retains existing expectedHash semantics', () => {
  const f = createRailgunPartialCapsuleData();
  const capsule = normalizeRailgunPrivateCapsule(f.capsule);
  const expectedDigest = require('crypto')
    .createHash('sha256')
    .update('freedom:railgun:private-capsule-v2\0')
    .update(JSON.stringify(capsule))
    .digest('hex');
  expect(digestRailgunPrivateCapsule(f.capsule)).toBe(expectedDigest);
  expect(capsule.preparation.expectedHash).toBe(f.capsule.preparation.expectedHash);
  expect(capsule.preparation).not.toHaveProperty('amount');
  expect(capsule.preparation.expected).not.toHaveProperty('inputAmount');
  expect(capsule.preparation.expected).not.toHaveProperty('changeAmount');
  expect(Object.keys(capsule.preparation.expected)).toEqual([
    'kind',
    'tree',
    'merkleRoot',
    'nullifier',
    'changeCommitment',
    'unshieldCommitment',
    'boundParamsHash',
    'recipient',
    'unshieldAmount',
  ]);
  for (const v of [
    capsule,
    capsule.selection,
    capsule.preparation,
    capsule.preparation.expected,
    capsule.preparation.transaction,
    capsule.pathElements,
  ])
    expect(Object.isFrozen(v)).toBe(true);
  f.capsule.preparation.expected = Object.fromEntries(
    Object.entries(f.capsule.preparation.expected).reverse()
  );
  f.capsule.selection = Object.fromEntries(Object.entries(f.capsule.selection).reverse());
  expect(digestRailgunPrivateCapsule(f.capsule)).toBe(expectedDigest);
  f.capsule.pathElements[0] = hex(90);
  f.capsule.preparation.changeAmount = '1';
  expect(capsule.pathElements[0]).toBe(hex(6));
  expect(capsule.preparation.changeAmount).toBe('600');
});
test.each([
  ['v1 partial', (f) => (f.version = 1)],
  ['unknown version', (f) => (f.version = 3)],
  ['string version', (f) => (f.version = '2')],
  ['unknown kind', (f) => (f.selection.kind = 'unshield')],
  ['legacy kind', (f) => (f.selection.kind = 'railgun-token-unshield')],
  ['selection amount', (f) => (f.selection.unshieldAmount = '401')],
  ['ambiguous amount', (f) => (f.preparation.amount = '1000')],
  ['input contradiction', (f) => (f.preparation.inputAmount = '1001')],
  ['change contradiction', (f) => (f.preparation.changeAmount = '599')],
  ['input public', (f) => (f.preparation.expected.inputAmount = '1000')],
  ['change public', (f) => (f.preparation.expected.changeAmount = '600')],
  ['selection extra', (f) => (f.selection.output = 0)],
  ['random', (f) => (f.random = 'secret')],
  ['witness', (f) => (f.preparation.witness = {})],
  ['signature', (f) => (f.preparation.signature = {})],
  ['path', (f) => f.pathElements.pop()],
])('v2 refuses %s', (_label, change) => {
  const f = createRailgunPartialCapsuleData().capsule;
  change(f);
  expect(() => normalizeRailgunPrivateCapsule(f)).toThrow();
});
test.each(['railgun-private-transfer', 'railgun-token-unshield'])(
  'v2 cannot reinterpret legacy %s',
  (kind) => {
    const f = createRailgunLegacyCapsuleData(kind).capsule;
    f.version = 2;
    expect(() => normalizeRailgunPrivateCapsule(f)).toThrow();
  }
);
test.each(['selection', 'preparation', 'wallet', 'engine', 'note'])(
  'new v2 capsule binds genuine main %s',
  (mode) => {
    const { normalizeRailgunNewCapsule } = require('./railgun-private-capsule');
    const f = createRailgunPartialCapsuleData().capsule;
    f.engineSha256 = require('./railgun-engine-manifest.json').sha256;
    const owned = JSON.parse(
      JSON.stringify({
        walletId: f.walletId,
        selection: f.selection,
        preparation: f.preparation,
        noteHash: f.noteHash,
      })
    );
    expect(normalizeRailgunNewCapsule(f, owned)).toEqual(normalizeRailgunPrivateCapsule(f));
    if (mode === 'selection') owned.selection.position++;
    if (mode === 'preparation') owned.preparation.expectedHash = hex(80);
    if (mode === 'wallet') owned.walletId = 'f'.repeat(64);
    if (mode === 'engine') f.engineSha256 = 'f'.repeat(64);
    if (mode === 'note') owned.noteHash = hex(80);
    expect(() => normalizeRailgunNewCapsule(f, owned)).toThrow();
  }
);
