/** Public structural fixtures only: dummy proofs, commitments and ciphertext.
 * No cryptographic validity, recovered ownership or signing authority.
 */
const { Interface, AbiCoder, keccak256 } = require('ethers');
const { TRANSACT_ABI, BOUND_PARAMS } = require('@freedom/railgun-kohaku-adapter/host/data');
const pins = require('./railgun-journal-pins.json');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const abi = new Interface([TRANSACT_ABI]);
function build(kind, inputAmount, unshieldAmount) {
  const partial = kind === 'railgun-partial-unshield';
  const transfer = kind === 'railgun-private-transfer';
  const instanceId = '0zk1' + 'q'.repeat(123);
  const recipient = transfer ? instanceId : '0x' + '12'.repeat(20);
  const bound = {
    treeNumber: 0,
    minGasPrice: 0,
    unshield: transfer ? 0 : 1,
    chainID: pins.chainId,
    adaptContract: '0x' + '0'.repeat(40),
    adaptParams: hex(0),
    commitmentCiphertext:
      !transfer && !partial
        ? []
        : [
            {
              ciphertext: [hex(11), hex(12), hex(13), hex(14)],
              blindedSenderViewingKey: hex(15),
              blindedReceiverViewingKey: hex(16),
              annotationData: '0x1122',
              memo: '0x',
            },
          ],
  };
  const inner = {
    proof: { a: { x: 0, y: 0 }, b: { x: [0, 0], y: [0, 0] }, c: { x: 0, y: 0 } },
    merkleRoot: hex(1),
    nullifiers: [hex(2)],
    commitments: partial ? [hex(3), hex(4)] : [hex(3)],
    boundParams: bound,
    unshieldPreimage: {
      npk: transfer ? hex(0) : hex(BigInt(recipient)),
      token: {
        tokenType: 0,
        tokenAddress: transfer ? '0x' + '0'.repeat(40) : pins.wrappedNative,
        tokenSubID: 0,
      },
      value: transfer ? '0' : unshieldAmount,
    },
  };
  const encode = () => abi.encodeFunctionData('transact', [[inner]]);
  const expected = {
    kind,
    tree: 0,
    merkleRoot: hex(1),
    nullifier: hex(2),
    ...(partial
      ? { changeCommitment: hex(3), unshieldCommitment: hex(4) }
      : { commitment: hex(3) }),
    boundParamsHash: hex(
      BigInt(keccak256(AbiCoder.defaultAbiCoder().encode([BOUND_PARAMS], [bound]))) % FIELD
    ),
    ...(transfer
      ? {}
      : partial
        ? { recipient, unshieldAmount }
        : { recipient, amount: inputAmount }),
  };
  const selection = {
    kind,
    tree: 0,
    position: 1,
    recipient,
    ...(partial ? { unshieldAmount } : {}),
  };
  const preparation = {
    transaction: { chainId: pins.chainId, to: pins.proxy, value: '0', data: encode() },
    expected,
    expectedHash: hex(7),
    recipient,
    ...(partial
      ? {
          inputAmount,
          unshieldAmount,
          changeAmount: (BigInt(inputAmount) - BigInt(unshieldAmount)).toString(),
        }
      : { amount: inputAmount }),
  };
  const capsule = {
    version: partial ? 2 : 1,
    walletId: '1'.repeat(64),
    engineSha256: 'e'.repeat(64),
    selection,
    preparation,
    noteHash: hex(5),
    pathElements: Array(16).fill(hex(6)),
  };
  const owned = {
    read: {
      instanceId,
      received: [
        {
          id: '0:1',
          tree: 0,
          position: 1,
          amount: BigInt(inputAmount),
          spentTxid: false,
          asset: { __type: 'erc20', contract: pins.wrappedNative },
        },
      ],
    },
    ownedPoi: [{ id: '0:1', nullifier: hex(2) }],
    trees: [{ tree: 0, root: hex(1), length: 2 }],
  };
  return {
    capsule,
    owned,
    inner,
    encode,
    request: { kind, noteId: '0:1', recipient, ...(partial ? { unshieldAmount } : {}) },
  };
}
function createRailgunPartialCapsuleData({ inputAmount = '1000', unshieldAmount = '400' } = {}) {
  return build('railgun-partial-unshield', inputAmount, unshieldAmount);
}
function createRailgunLegacyCapsuleData(kind = 'railgun-token-unshield') {
  if (!['railgun-token-unshield', 'railgun-private-transfer'].includes(kind))
    throw Error('Invalid fixture kind');
  return build(kind, '1000', '1000');
}
module.exports = { createRailgunPartialCapsuleData, createRailgunLegacyCapsuleData };
