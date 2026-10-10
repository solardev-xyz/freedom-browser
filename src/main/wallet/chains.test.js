// Actual network-registry layering; only config-file I/O and Electron are mocked.
const mockFiles = {};
const mockWrite = jest.fn();
jest.mock('node:fs', () => ({
  readFileSync: (filename) => {
    const name = require('node:path').basename(filename);
    if (!(name in mockFiles))
      throw Object.assign(Error('absent fixture config'), { code: 'ENOENT' });
    return mockFiles[name];
  },
  writeFileSync: (...args) => mockWrite(...args),
}));
const builtinChains = require('../../shared/chains.json');
const registry = require('../networks/network-registry');
const { getChain, getTxExplorerUrl } = require('./chains');
const TX = '0x' + '12'.repeat(32);
const SEPOLIA = { chainId: 11155111, name: 'Sepolia fixture', nativeSymbol: 'ETH' };
function configure({ chains = builtinChains, custom = {} } = {}) {
  Object.assign(mockFiles, {
    'chains.json': JSON.stringify(chains),
    'custom-chains.json': JSON.stringify(custom),
    'endpoint-sources.json': '{}',
    'network-config.json': '{}',
  });
  registry.invalidate();
}
beforeEach(() => {
  jest.clearAllMocks();
  configure();
});
afterEach(() => expect(mockWrite).not.toHaveBeenCalled());

test('unknown chain returns existing null sentinel', () => {
  expect(getChain(11155111)).toBeNull();
  expect(getTxExplorerUrl(11155111, TX)).toBeNull();
});
test.each(['managed', 'custom'])(
  '%s Sepolia without explorer is configured but has no transaction link',
  (layer) => {
    configure(
      layer === 'managed'
        ? { chains: { ...builtinChains, 11155111: SEPOLIA } }
        : { custom: { 11155111: SEPOLIA } }
    );
    expect(getChain(11155111)).toMatchObject({ chainId: 11155111, builtin: layer === 'managed' });
    expect(getTxExplorerUrl(11155111, TX)).toBeNull();
    expect(getTxExplorerUrl('11155111', TX)).toBeNull();
  }
);
test.each([1, 100, 8453])('built-in chain %i preserves its exact explorer URL', (chainId) => {
  expect(getTxExplorerUrl(chainId, TX)).toBe(`${builtinChains[chainId].blockExplorer}/tx/${TX}`);
});
test.each([
  undefined,
  null,
  '',
  '  ',
  7,
  {},
  [],
  'explorer.example',
  '/explorer',
  'https:explorer.example',
  'https://',
  'javascript:alert(1)',
  'file:///tmp/explorer',
  'ftp://explorer.example',
  ' https://explorer.example',
  'https://explorer.example ',
  'https://user:password@explorer.example',
  'https://explorer.example?chain=1',
  'https://explorer.example#transactions',
])('invalid explorer base %p has no transaction link', (blockExplorer) => {
  configure({ custom: { 11155111: { ...SEPOLIA, blockExplorer } } });
  expect(getChain(11155111)).not.toBeNull();
  expect(getTxExplorerUrl(11155111, TX)).toBeNull();
});
test.each([
  'https://sepolia.etherscan.io',
  'https://explorer.example/network/sepolia',
  'http://127.0.0.1:8080/explorer',
  'https://explorer.example/',
])('valid custom explorer base %s preserves existing composition', (blockExplorer) => {
  configure({ custom: { 11155111: { ...SEPOLIA, blockExplorer } } });
  expect(getTxExplorerUrl(11155111, TX)).toBe(`${blockExplorer}/tx/${TX}`);
});
