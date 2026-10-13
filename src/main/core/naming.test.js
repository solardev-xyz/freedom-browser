const { EventEmitter } = require('events');

jest.mock('electron', () => ({ net: {}, session: {}, app: { isPackaged: false } }));
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../ens-prefetch', () => ({ prefetchGatewayUrl: jest.fn() }));
jest.mock('../ipfs/gateway-transport', () => ({ netGatewayFetch: jest.fn() }));
const mockTransitions = [];
jest.mock('../myotis/myotis-manager', () => ({
  isEnabled: () => true,
  isReady: () => false,
  onAvailabilityTransition: (listener) => mockTransitions.push(listener),
}));
jest.mock('../ens-resolver', () => ({
  getEffectiveRpcEndpoints: () => ['https://a.rpc.example'],
  getDirectRpcCandidate: () => ({ url: null }),
  resolutionPolicy: () => ({ order: ['quorum'] }),
  fastNormalize: (name) => name.toLowerCase(),
}));
jest.mock('../tezos-domains-resolver', () => ({ getRpcEndpoints: () => [] }));
jest.mock('../networks/network-registry', () => ({
  getNetwork: () => ({}),
  getEndpoints: () => [],
  validateRpcUrl: () => null,
}));

const {
  attachNaming,
  detachNaming,
  namingDriver,
  namingSettingsChanged,
  namingCachesCleared,
} = require('./naming');

test('attached before the core starts: executors, driver, transitions, settings and caches', async () => {
  const client = new EventEmitter();
  const handled = [];
  client.handle = (method) => handled.push(method);
  const { config, running } = attachNaming(client);
  // Its count of verifier operations, for chain data's to share.
  expect(running).toEqual({ myotis: 0, colibri: 0 });
  expect(handled.sort()).toEqual([
    'shell.gateway',
    'shell.prefetch',
    'shell.rpc',
    'shell.tezos',
    'shell.verified',
  ]);
  expect(namingDriver()).not.toBeNull();
  const availability = jest.spyOn(config, 'availability').mockResolvedValue({});
  const configure = jest.spyOn(config, 'configure').mockResolvedValue({});
  // Today's ENS listener reacts to chain 1 alone.
  mockTransitions.forEach((listener) => listener({ chainId: 10 }));
  expect(availability).not.toHaveBeenCalled();
  mockTransitions.forEach((listener) => listener({ chainId: 1, ready: true }));
  expect(availability).toHaveBeenCalledTimes(1);
  namingSettingsChanged();
  expect(configure).toHaveBeenCalledWith({ reset: true });
  // clearEnsResolutionCaches: what a Myotis transition clears, no settings.
  namingCachesCleared();
  expect(availability).toHaveBeenCalledTimes(2);
  expect(configure).toHaveBeenCalledTimes(1);
  // Stopped for good: no driver, so lookups fail; nothing reaches the core.
  detachNaming();
  expect(namingDriver()).toBeNull();
  namingSettingsChanged();
  namingCachesCleared();
  mockTransitions.forEach((listener) => listener({ chainId: 1 }));
  expect(configure).toHaveBeenCalledTimes(1);
  expect(availability).toHaveBeenCalledTimes(2);
});
