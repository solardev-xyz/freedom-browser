/**
 * Shared Safe test identities: three anvil/hardhat-default keys (well
 * known, never funded on mainnet) standing in for a mnemonic, a Ledger
 * and a phone owner record, plus the signer fake both test suites hand
 * out from their `getSigner` mocks. Kept requireable from inside
 * jest.mock factories (no jest globals in here).
 */

const { Wallet } = require('ethers');
const { withoutDomainType } = require('../../../signing-utils');

// wallet index → private key; indexes mirror the mocked wallet records
// (0 mnemonic, 2 ledger, 4 remote).
const OWNER_KEYS = {
  0: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  2: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  4: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
};

const ownerWallet = (walletIndex) => new Wallet(OWNER_KEYS[walletIndex]);

/**
 * Signer fake mirroring the factory contract: full EIP-712 wire payload
 * in, signature out; signTransaction included for executor broadcasts.
 */
function createTestSigner(walletIndex) {
  const wallet = ownerWallet(walletIndex);
  return {
    getAddress: async () => wallet.address,
    signTransaction: (tx) => wallet.signTransaction(tx),
    signTypedData: async ({ domain, types, message }) =>
      wallet.signTypedData(domain, withoutDomainType(types), message),
  };
}

module.exports = { OWNER_KEYS, ownerWallet, createTestSigner };
