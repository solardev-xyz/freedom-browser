/** Public fake structural data for tests; no engine, encryption or authority. */
const { AbiCoder, Interface, keccak256 } = require('ethers');
const { TRANSACT_ABI, BOUND_PARAMS } = require('../../src/main/wallet/railgun-private-policy');
const pins = require('../../src/main/wallet/railgun-shield-pins.json');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const hex = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
const ZERO = '0x' + '0'.repeat(40),
  abi = new Interface([TRANSACT_ABI]);
function fixture() {
  const peer = '0zk1' + 'q'.repeat(123),
    self = '0zk1' + 'p'.repeat(123);
  const fields = {
    fees: { [pins.wrappedNative]: '0xde0b6b3a7640000' },
    feeExpiration: 1,
    feesID: 'unsigned-test',
    railgunAddress: peer,
    availableWallets: 1,
    version: '8.0.0',
    relayAdapt: pins.relayAdapt,
    requiredPOIListKeys: [],
    reliability: -1,
  };
  const context = {
    walletId: '11'.repeat(32),
    self: { address: self, masterPublicKey: '7', viewingPublicKey: '02'.repeat(32) },
    peer: { address: peer, masterPublicKey: '8', viewingPublicKey: '03'.repeat(32) },
    quote: {
      data: Buffer.from(JSON.stringify(fields)).toString('hex'),
      signature: '04'.repeat(64),
    },
    gas: { transactionType: 0, gasEstimate: '84', gasPrice: '1', minGasPrice: '1' },
    inputAmount: '700',
    feeAmount: '100',
    selfAmount: '600',
    feeCap: '100',
  };
  const cipher = (n) => ({
    ciphertext: [hex(n), hex(n + 1), hex(n + 2), hex(n + 3)],
    blindedSenderViewingKey: hex(n + 4),
    blindedReceiverViewingKey: hex(n + 5),
    annotationData: '0x1122',
    memo: '0x',
  });
  const bound = {
    treeNumber: 0,
    minGasPrice: 1,
    unshield: 0,
    chainID: pins.chainId,
    adaptContract: ZERO,
    adaptParams: hex(0),
    commitmentCiphertext: [cipher(10), cipher(20)],
  };
  const inner = {
    proof: { a: { x: 0, y: 0 }, b: { x: [0, 0], y: [0, 0] }, c: { x: 0, y: 0 } },
    merkleRoot: hex(7),
    nullifiers: [hex(8)],
    commitments: [hex(9), hex(10)],
    boundParams: bound,
    unshieldPreimage: {
      npk: hex(0),
      token: { tokenType: 0, tokenAddress: ZERO, tokenSubID: 0 },
      value: 0,
    },
  };
  const expected = {
    kind: 'railgun-relay-self-transfer',
    tree: 0,
    merkleRoot: hex(7),
    nullifier: hex(8),
    feeCommitment: hex(9),
    selfCommitment: hex(10),
    boundParamsHash: '',
  };
  const build = () => {
    expected.boundParamsHash = hex(
      BigInt(keccak256(AbiCoder.defaultAbiCoder().encode([BOUND_PARAMS], [bound]))) % FIELD
    );
    return {
      transaction: {
        chainId: pins.chainId,
        to: pins.proxy,
        value: '0',
        data: abi.encodeFunctionData('transact', [[inner]]),
      },
      expected: { ...expected },
      expectedHash: hex(11),
      context: JSON.parse(JSON.stringify(context)),
    };
  };
  return { context, inner, bound, expected, build };
}

function createRailgunRelayUnsignedData() {
  const f = fixture();
  const draft = {
    schema: 'railgun-relay-unsigned-draft-v1',
    walletId: f.context.walletId,
    engineSha256: require('../../src/main/wallet/railgun-engine-manifest.json').sha256,
    selection: { tree: 0, position: 7 },
    noteHash: hex(12),
    pathElements: Array.from({ length: 16 }, (_, i) => hex(i + 1)),
    intent: f.build(),
  };
  return {
    ...f,
    draft,
    request: { selection: { ...draft.selection }, context: JSON.parse(JSON.stringify(f.context)) },
  };
}
module.exports = { createRailgunRelayUnsignedData };
