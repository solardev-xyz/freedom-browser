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
