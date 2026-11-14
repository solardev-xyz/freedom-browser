/**
 * x402 payment client.
 *
 * Wires `@x402/core`'s `x402Client` to the wallet's signer factory so
 * payment authorizations are signed by whatever backend the wallet index
 * resolves to (vault key today, hardware wallet later) — no raw keys
 * leave the main process, and the same auto-lock UX that protects dApp
 * signing protects x402 payments.
 *
 * Higher layers (the navigation interceptor / interstitial) call
 * `createX402Client(walletIndex)` after the user has approved a payment,
 * then drive the returned client to produce the `PAYMENT-SIGNATURE`
 * header value.
 */

const { x402Client } = require('@x402/core/client');
const { ExactEvmScheme } = require('@x402/evm/exact/client');
const { ExactEvmSchemeV1 } = require('@x402/evm/exact/v1/client');

const { getSigner } = require('../wallet/signers');

// V1 servers use string network names (not CAIP-2); unknown ones fall
// through to whichever V2 `accepts[]` entry the server also exposed.
// Base Sepolia was supported earlier in the branch; removed because
// the asset allowlist no longer carries Sepolia USDC — a V1 server
// billing on sepolia would parse OK but the asset would be unknown
// and the Pay button would be disabled. Drop it from the network
// allowlist so the failure shows up consistently at protocol time.
const V1_NETWORKS = ['base', 'ethereum'];

/**
 * Construct an `x402Client` whose signing flows through the wallet's
 * signer for the given index.
 *
 * Both V2 (CAIP-2, registered with the `eip155:*` glob) and V1 (legacy
 * string network names) schemes are wired so the client can produce
 * payment payloads against either flavour of x402 server.
 *
 * The schemes receive `@x402/evm`'s `ClientEvmSigner` shape — just
 * `address` + `signTypedData`. No `readContract` etc., so EIP-2612 /
 * ERC-20-approval extensions aren't supported; the base USDC / EIP-3009
 * flow doesn't need them. The address is resolved once at construction —
 * this also resets the vault auto-lock timer, so the typical "build then
 * immediately sign" flow doesn't race the timeout; each signTypedData
 * call re-runs the unlock check in case the vault re-locked.
 *
 * @param {number} [walletIndex=0]
 * @returns {Promise<import('@x402/core/client').x402Client>}
 */
async function createX402Client(walletIndex = 0, { beforeSign } = {}) {
  const walletSigner = getSigner(walletIndex);
  const signer = {
    address: await walletSigner.getAddress(),
    signTypedData: (...args) => { beforeSign?.(); return walletSigner.signTypedData(...args); },
  };

  const client = new x402Client();
  client.register('eip155:*', new ExactEvmScheme(signer));
  for (const network of V1_NETWORKS) {
    client.registerV1(network, new ExactEvmSchemeV1(signer));
  }
  // Surface the signer's address on the client so the payment-history
  // recorder can stamp `from_address` without re-unlocking the vault.
  client.address = signer.address;
  return client;
}

module.exports = {
  createX402Client,
  V1_NETWORKS,
};
