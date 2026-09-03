/**
 * Offline EIP-1193 stub chain for SafeExecutor unit tests.
 *
 * Answers exactly the RPC surface protocol-kit touches for counterfactual
 * work: the canonical Safe 1.4.1 contracts read as deployed, everything
 * else as empty, and `proxyCreationCode()` replays the on-chain constant
 * (recorded once from the real SafeProxyFactory 1.4.1 on Gnosis at
 * 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67 — it is identical on every
 * chain, that's the point of the canonical deployment). Optional
 * `deployedSafes` simulate already-deployed Safes with a live nonce.
 *
 * Unstubbed methods/calls throw so a protocol-kit upgrade that starts
 * reading something new fails loudly instead of silently mis-testing.
 */

const { Interface, getAddress } = require('ethers');
const deployments = require('@safe-global/safe-deployments');

const SAFE_VERSION = '1.4.1';

// eth_call response of SafeProxyFactory.proxyCreationCode() (ABI-encoded
// bytes), recorded from Gnosis. Deterministic protocol constant for 1.4.1.
const PROXY_CREATION_CODE_RESPONSE =
  '0x000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000001e6608060405234801561001057600080fd5b506040516101e63803806101e68339818101604052602081101561003357600080fd5b8101908080519060200190929190505050600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff1614156100ca576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260228152602001806101c46022913960400191505060405180910390fd5b806000806101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff1602179055505060ab806101196000396000f3fe608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea264697066735822122003d1488ee65e08fa41e58e888a9865554c535f2c77126a82cb4c0f917f31441364736f6c63430007060033496e76616c69642073696e676c65746f6e20616464726573732070726f76696465640000000000000000000000000000000000000000000000000000';

const SAFE_INTERFACE = new Interface([
  'function proxyCreationCode() view returns (bytes)',
  'function nonce() view returns (uint256)',
  'function VERSION() view returns (string)',
  'function getThreshold() view returns (uint256)',
  'function getOwners() view returns (address[])',
]);

/** Canonical 1.4.1 contract addresses from the safe-deployments registry. */
function canonicalAddresses() {
  return [
    deployments.getSafeSingletonDeployment({ version: SAFE_VERSION }),
    deployments.getSafeL2SingletonDeployment({ version: SAFE_VERSION }),
    deployments.getProxyFactoryDeployment({ version: SAFE_VERSION }),
    deployments.getMultiSendDeployment({ version: SAFE_VERSION }),
    deployments.getMultiSendCallOnlyDeployment({ version: SAFE_VERSION }),
    deployments.getFallbackHandlerDeployment({ version: SAFE_VERSION }),
  ]
    .filter(Boolean)
    .map((d) => getAddress(d.defaultAddress));
}

/**
 * @param {Object} opts
 * @param {number} opts.chainId
 * @param {Object.<string, {nonce?: number, threshold?: number, owners?: string[]}>}
 *   [opts.deployedSafes] - Safes that read as deployed, keyed by address
 * @returns {{request: Function}} EIP-1193 provider
 */
function createStubChain({ chainId, deployedSafes = {} }) {
  const codeAddresses = new Set(canonicalAddresses().map((a) => a.toLowerCase()));
  const safes = Object.fromEntries(
    Object.entries(deployedSafes).map(([address, safe]) => [address.toLowerCase(), safe])
  );

  const encodeResult = (name, values) => SAFE_INTERFACE.encodeFunctionResult(name, values);

  const call = ({ to, data }) => {
    const selector = (data || '').slice(0, 10);
    const safe = safes[(to || '').toLowerCase()];
    switch (selector) {
      case SAFE_INTERFACE.getFunction('proxyCreationCode').selector:
        return PROXY_CREATION_CODE_RESPONSE;
      case SAFE_INTERFACE.getFunction('nonce').selector:
        return encodeResult('nonce', [safe?.nonce ?? 0]);
      case SAFE_INTERFACE.getFunction('VERSION').selector:
        return encodeResult('VERSION', [SAFE_VERSION]);
      case SAFE_INTERFACE.getFunction('getThreshold').selector:
        return encodeResult('getThreshold', [safe?.threshold ?? 1]);
      case SAFE_INTERFACE.getFunction('getOwners').selector:
        return encodeResult('getOwners', [safe?.owners ?? []]);
      default:
        throw new Error(`stub-chain: unstubbed eth_call ${selector} to ${to}`);
    }
  };

  return {
    request: async ({ method, params }) => {
      switch (method) {
        case 'eth_chainId':
          return '0x' + chainId.toString(16);
        case 'eth_accounts':
          return [];
        case 'eth_getCode': {
          const address = params[0].toLowerCase();
          const deployed = codeAddresses.has(address) || address in safes;
          return deployed ? '0x60806040' : '0x';
        }
        case 'eth_call':
          return call(params[0]);
        case 'eth_blockNumber':
          return '0x1';
        default:
          throw new Error(`stub-chain: unstubbed method ${method}`);
      }
    },
  };
}

module.exports = { createStubChain, canonicalAddresses };
