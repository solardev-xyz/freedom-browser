/** Structurally valid public test intent; never a real note or proof. */
const { Interface, AbiCoder, keccak256 } = require('ethers');
const { TRANSACT_ABI, BOUND_PARAMS } = require('../../src/main/wallet/railgun-private-policy');
const {
  validateRailgunPrivateSigningIntent,
} = require('../../src/main/wallet/railgun-private-intent');
const pins = require('../../src/main/wallet/railgun-shield-pins.json');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const field = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const abi = new Interface([TRANSACT_ABI]);
function capsule(walletId, n = 1) {
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
    [hex(n)],
    [hex(3)],
    bound,
    [hex(BigInt(recipient)), [0, pins.wrappedNative, 0], 1000],
  ];
  return {
    version: 1,
    walletId,
    engineSha256: '7'.repeat(64),
    selection: { kind, tree: 0, position: n, recipient },
    noteHash: hex(5),
    pathElements: Array(16).fill(hex(6)),
    preparation: {
      transaction: {
        chainId: pins.chainId,
        to: pins.proxy,
        value: '0',
        data: abi.encodeFunctionData('transact', [[tx]]),
      },
      expected: {
        kind,
        tree: 0,
        merkleRoot: hex(1),
        nullifier: hex(n),
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
  };
}
function facts(c) {
  return {
    tree: c.selection.tree,
    position: c.selection.position,
    nullifier: c.preparation.expected.nullifier,
    noteHash: c.noteHash,
    kind: c.selection.kind,
    intentDigest: validateRailgunPrivateSigningIntent(
      c.preparation.transaction,
      c.preparation.expected
    ).digest,
    checkpointHash: 'a'.repeat(64),
    poiDigest: 'b'.repeat(64),
  };
}
module.exports = { capsule, facts };
