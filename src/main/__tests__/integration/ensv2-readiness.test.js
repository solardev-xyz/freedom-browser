// Explicit opt-in: these assertions hit mainnet and real CCIP gateways.
// NODE_OPTIONS=--experimental-vm-modules ENSV2_E2E=1 npm run test:unit -- --runInBand src/main/__tests__/integration/ensv2-readiness.test.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mockDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-ensv2-'));
jest.mock('electron', () => ({
  app: { getPath: () => mockDataDir },
  ipcMain: { handle: jest.fn() },
}));
jest.mock('../../logger', () => ({ info() {}, warn() {}, error() {}, debug() {} }));
jest.mock('../../private/private-windows', () => ({ isPrivateWebContents: () => false }));
const registry = require('../../networks/network-registry');
const resolver = require('../../ens-resolver');
const enabled = process.env.ENSV2_E2E === '1';
const methods = (process.env.ENSV2_METHODS || 'direct,quorum,default').split(',');
const cases = [
  ['ur.integration-tests.eth', '0x2222222222222222222222222222222222222222', 1],
  ['test.offchaindemo.eth', '0x779981590E7Ccc0CFAe8040Ce7151324747cDb97', 1],
  ['gregskril.com', '0x179A862703a4adfb29896552DF9e307980D19285', 1],
  ['test.ses.eth', '0x2B0F09F23193de2Fb66258a10886B9f06903276c', 1],
  ['test.ses.eth', '0x7d3a48269416507E6d207a9449E7800971823Ffa', 8453],
];
(enabled ? describe : describe.skip).each(methods)('ENSv2 mainnet via %s', (method) => {
  let original;
  beforeAll(() => {
    original = registry.getNetwork;
    const network = original(1);
    jest.spyOn(registry, 'getNetwork').mockImplementation((chain) =>
      chain === 1
        ? {
            ...network,
            verification: {
              ...network.verification,
              order: method === 'default' ? ['myotis', 'colibri', 'quorum'] : [method],
            },
          }
        : original(chain)
    );
    resolver.invalidateCachedProvider();
  });
  afterAll(() => {
    registry.getNetwork.mockRestore();
    require('../../ens/colibri-resolver').clearColibriClientForTest();
  });
  test.each(cases)(
    '%s resolves to %s on chain %s',
    async (name, address, chainId) => {
      const result = await resolver.resolveEnsAddress(name, chainId);
      if (!result.success) throw new Error(JSON.stringify(result));
      expect(result.address.toLowerCase()).toBe(address.toLowerCase());
      if (method === 'colibri') expect(result.trust.method).toBe('colibri');
      if (method === 'quorum') expect(result.trust.quorum.achieved).toBe(true);
    },
    120000
  );
});
