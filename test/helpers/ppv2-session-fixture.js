/** Public, synthetic controlled-service addresses. Never real wallet data. */
const address = (byte) => `0x${byte.repeat(40)}`;
function configuration() {
  return {
    chainId: 11155111,
    ownerAddress: address('a'),
    deploymentBlock: 100,
    deployment: {
      poolAddress: address('1'),
      entrypointAddress: address('2'),
      keystoreAddress: address('3'),
      aspRegistryAddress: address('4'),
      relaySwapsAddress: address('0'),
    },
    contracts: ['1', '2', '3', '4'].map((byte) => ({
      address: address(byte),
      selectors: [],
      eventTopics: [],
    })),
    asp: { baseUrl: 'https://service.example.test/asp', publicKey: `0x${'12'.repeat(32)}` },
    relayers: [
      {
        url: 'https://service.example.test/relayer',
        address: address('b'),
        chainId: 11155111,
        name: 'Controlled fixture',
        chainType: 'evm',
        status: 'active',
        processorAddress: address('c'),
      },
    ],
    artifacts: { gatewayUrls: ['https://artifacts.example.test/ipfs/'], manifest: {} },
    networks: [
      { role: 'asp', endpoints: [{ url: 'https://service.example.test/asp/', methods: ['GET'] }] },
      {
        role: 'relayer',
        endpoints: [{ url: 'https://service.example.test/relayer/quote', methods: ['POST'] }],
      },
    ],
  };
}
module.exports = { configuration };
