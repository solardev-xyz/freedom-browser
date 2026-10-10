/** Public shape-only fixture. Electron qualification supplies a real proof. */
const { AbiCoder, keccak256, Wallet, TypedDataEncoder } = require('ethers');
const { FIELD, NATIVE } = require('../../src/main/wallet/ppv2-deposit-policy');
const { ROUTING } = require('../../src/main/wallet/ppv2-relay-policy');
const word = (v) => `0x${BigInt(v).toString(16).padStart(64, '0')}`;
const quoteWallet = Wallet.createRandom(); // Ephemeral fixture signer; no stored key.
// Independent transcription of the pinned upstream relayer type, not imported
// from the implementation under test. E2E additionally signs with upstream viem.
const quoteTypes = {
  RelayWithdrawalCommitment: [
    { name: 'data', type: 'bytes' },
    { name: 'asset', type: 'address' },
    { name: 'expiration', type: 'uint256' },
    { name: 'amountSent', type: 'uint256' },
    { name: 'amountReceived', type: 'uint256' },
  ],
};
function signQuote(fee, processor, overrides = {}, wallet = quoteWallet) {
  return wallet.signingKey.sign(
    TypedDataEncoder.hash(
      {
        name: 'Privacy Pools Relayer',
        version: '1',
        chainId: 11155111,
        verifyingContract: processor,
        ...overrides,
      },
      quoteTypes,
      fee
    )
  ).serialized;
}
function relayFixture({ recipient = `0x${'11'.repeat(20)}` } = {}) {
  const coder = AbiCoder.defaultAbiCoder(),
    relayer = `0x${'22'.repeat(20)}`,
    processor = `0x${'33'.repeat(20)}`;
  const data = coder.encode([ROUTING], [[recipient, relayer, 100n, 0n]]);
  const noteData = [{ hint: word(3), data: '0xabcd' }];
  const context =
    BigInt(
      keccak256(
        coder.encode(
          ['tuple(address processor,bytes data)', 'tuple(bytes32 hint,bytes data)[]'],
          [[processor, data], noteData]
        )
      )
    ) % FIELD;
  const signals = [1n, 2n, 3n, 4n, 5n, 6000n, BigInt(NATIVE), context].map(word);
  const payload = {
    proof: {
      pi_a: ['0x1', '0x2', '0x1'],
      pi_b: [
        ['0x1', '0x2'],
        ['0x3', '0x4'],
        ['0x1', '0x0'],
      ],
      pi_c: ['0x5', '0x6', '0x1'],
      protocol: 'groth16',
      curve: 'bn128',
      publicSignals: signals,
    },
    noteData,
    signedFeeCommitment: {
      data,
      asset: NATIVE,
      expiration: Date.now() + 300000,
      feeAmount: '100',
      signedRelayerCommitment: `0x${'ab'.repeat(65)}`,
      recipient,
      amountSent: '6000',
      amountReceived: '5900',
      extraGas: false,
    },
    inputNullifierNumber: 1,
    outputCommitmentNumber: 1,
  };
  const intent = {
    kind: 'ppv2-native-withdrawal',
    chainId: 11155111,
    owner: `0x${'55'.repeat(20)}`,
    inputValue: '10000',
    pool: `0x${'44'.repeat(20)}`,
    processor,
    relayer,
    quoteSigner: quoteWallet.address.toLowerCase(),
    recipient,
    amount: '5900',
    maxFee: '100',
    commitment: word(9),
    publicSignals: signals,
  };
  payload.signedFeeCommitment.signedRelayerCommitment = signQuote(
    payload.signedFeeCommitment,
    processor
  );
  return {
    intent,
    endpoint: 'https://relay.example.test/v1/relay/evm/11155111/withdrawal',
    body: JSON.stringify(payload),
  };
}
module.exports = { relayFixture, word, signQuote };
