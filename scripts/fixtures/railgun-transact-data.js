/** Public structural transaction fixture: ciphertext/proof are not valid crypto. */
const { Interface } = require('ethers');
const { TRANSACT_ABI } = require('../../src/main/wallet/railgun-private-policy');
const pins = require('../../src/main/wallet/railgun-shield-pins.json');
const abi = new Interface([TRANSACT_ABI]);
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
function fixture(unshield = false) {
  const zero = '0x' + '0'.repeat(40),
    recipient = '0x' + '12'.repeat(20);
  const inner = {
    proof: { a: { x: 1n, y: 2n }, b: { x: [3n, 4n], y: [5n, 6n] }, c: { x: 7n, y: 8n } },
    merkleRoot: hex(9),
    nullifiers: [hex(10)],
    commitments: [hex(11)],
    boundParams: {
      treeNumber: 0n,
      minGasPrice: 0n,
      unshield: unshield ? 1n : 0n,
      chainID: BigInt(pins.chainId),
      adaptContract: zero,
      adaptParams: hex(0),
      commitmentCiphertext: unshield
        ? []
        : [
            {
              ciphertext: [hex(1), hex(2), hex(3), hex(4)],
              blindedSenderViewingKey: hex(5),
              blindedReceiverViewingKey: hex(6),
              annotationData: '0x1234',
              memo: '0x',
            },
          ],
    },
    unshieldPreimage: {
      npk: hex(unshield ? BigInt(recipient) : 0),
      token: { tokenType: 0n, tokenAddress: unshield ? pins.wrappedNative : zero, tokenSubID: 0n },
      value: unshield ? 1000n : 0n,
    },
  };
  const transaction = () => ({
    chainId: pins.chainId,
    from: '0x' + '34'.repeat(20),
    to: pins.proxy,
    value: '0',
    data: abi.encodeFunctionData('transact', [[inner]]),
  });
  return { inner, transaction, recipient };
}
module.exports = { fixture };
