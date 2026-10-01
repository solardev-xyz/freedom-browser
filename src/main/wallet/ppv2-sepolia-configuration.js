/** Main-owned live Sepolia candidate configuration for explicit qualification.
 * The archive is authenticated before reading its ABI/manifest exports.
 */
const { Interface } = require('ethers');
const { readPPv2RuntimeMetadata } = require('./ppv2-runtime');
const { CANDIDATE } = require('./ppv2-sepolia-preflight');
function sepoliaConfiguration(runtime, ownerAddress) {
  const { manifest, abis: abi } = readPPv2RuntimeMetadata(runtime.archive);
  const definitions = [
    [
      CANDIDATE.pool,
      [
        ...abi.POOL_VAULT_ABI,
        ...abi.POOL_VAULT_ALL_EVENTS_ABI,
        ...abi.POOL_VAULT_NOTE_EVENT_ABI,
        ...abi.POOL_VAULT_DEPOSITED_EVENT_ABI,
      ],
    ],
    [CANDIDATE.entrypoint, abi.ENTRYPOINT_ABI],
    [
      CANDIDATE.keystore,
      [...abi.KEYSTORE_ABI, ...abi.KEYSTORE_EVENTS_ABI, ...abi.KEYSTORE_AUTH_EVENTS_ABI],
    ],
    [CANDIDATE.aspRegistry, abi.ASP_REGISTRY_ABI],
  ];
  return {
    chainId: 11155111,
    ownerAddress,
    deploymentBlock: CANDIDATE.deploymentBlock,
    deployment: {
      poolAddress: CANDIDATE.pool,
      entrypointAddress: CANDIDATE.entrypoint,
      keystoreAddress: CANDIDATE.keystore,
      aspRegistryAddress: CANDIDATE.aspRegistry,
      relaySwapsAddress: `0x${'0'.repeat(40)}`,
    },
    contracts: definitions.map(([address, fragments]) => {
      const iface = new Interface(fragments);
      return {
        address,
        selectors: [
          ...new Set(iface.fragments.filter((f) => f.type === 'function').map((f) => f.selector)),
        ],
        eventTopics: [
          ...new Set(iface.fragments.filter((f) => f.type === 'event').map((f) => f.topicHash)),
        ],
      };
    }),
    asp: { baseUrl: CANDIDATE.asp, publicKey: CANDIDATE.aspKey },
    relayers: [
      {
        url: CANDIDATE.relayer,
        address: CANDIDATE.feeRecipient,
        chainId: 11155111,
        name: 'PP staging',
        chainType: 'evm',
        status: 'active',
        processorAddress: CANDIDATE.processor,
        quoteSigner: CANDIDATE.quoteSigner,
      },
    ],
    // Qualified local bytes are staged before proving; no artifact network grant.
    artifacts: { gatewayUrls: ['https://ipfs.io/ipfs/'], manifest },
    networks: [
      { role: 'asp', endpoints: [{ url: `${CANDIDATE.asp}/`, methods: ['GET'] }] },
      {
        role: 'relayer',
        endpoints: [
          { url: `${CANDIDATE.relayer}/v1/details`, methods: ['GET'] },
          { url: `${CANDIDATE.relayer}/v1/quote/evm/11155111/receive`, methods: ['POST'] },
          { url: `${CANDIDATE.relayer}/v1/relay/evm/11155111/withdrawal`, methods: ['POST'] },
        ],
      },
    ],
  };
}
module.exports = { sepoliaConfiguration };
