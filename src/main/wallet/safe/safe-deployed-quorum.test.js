/**
 * A Safe's deployed mark through the real chain router (#1066, #1092, #1094).
 *
 * The mark trusts the router's `verified` label: on a verified eth_getCode
 * read, or on the verified receipt of the deployment Freedom sent. These
 * tests run safe-service and transaction-service's receipt wait against
 * the real router, with one dishonest RPC endpoint configured in the two
 * ways that used to make its word a verified quorum: its URL listed twice,
 * a quorum with m = 1, and one provider listed under two URLs (a trailing
 * slash, two paths, two API keys, two loopback names or ports). None writes
 * the mark. Two distinct endpoints
 * that agree still do. Colibri's word counts only where the router's own
 * rules (#1048) label it verified: its unproven "no such receipt" leaves an
 * endpoint's mined receipt unverified, while its proven receipt marks.
 */

const { ownerWallet } = require('./__tests__/helpers/test-owners');

const OWNERS = [ownerWallet(0).address, ownerWallet(2).address];
const SAFE_ADDRESS = '0x41aD4887971f90BB3fE4d83eCa65177281283261';
const DEPLOY_HASH = '0x' + 'ab'.repeat(32);
const SAFE_CODE = '0x60806040';
const FORGER = 'https://forger.example';
const HONEST = ['https://honest.example', 'https://honest-too.example'];

const mockWalletRecords = {
  0: { index: 0, name: 'Main Wallet', address: OWNERS[0], type: 'mnemonic' },
  2: { index: 2, name: 'My Stax', address: OWNERS[1], type: 'ledger' },
  5: {
    index: 5,
    name: 'Joint',
    address: SAFE_ADDRESS,
    type: 'safe',
    owners: [0, 2],
    threshold: 1,
    saltNonce: '7508',
    deployed: {},
  },
};
const mockMarkSafeDeployed = jest.fn(async (index, chainId) => {
  const { verifiedDeployedMark } = jest.requireActual('./deployed-mark');
  const record = mockWalletRecords[index];
  record.deployed = { ...record.deployed, [chainId]: verifiedDeployedMark() };
});
jest.mock('../../identity-manager', () => {
  const { verifiedDeployments } = jest.requireActual('./deployed-mark');
  return {
    getWalletRecord: (index) => {
      const record = mockWalletRecords[index];
      if (!record) return null;
      return record.type === 'safe'
        ? { ...record, deployed: verifiedDeployments(record.deployed) }
        : record;
    },
    addSafeWallet: jest.fn(),
    markSafeDeployed: (...args) => mockMarkSafeDeployed(...args),
    WALLET_TYPES: { MNEMONIC: 'mnemonic', LEDGER: 'ledger', REMOTE: 'remote', SAFE: 'safe' },
  };
});

// The chain: whether the deployment has been sent, which every honest
// endpoint then reports. The forger reports it whatever happened.
const mockChain = { sent: false };
const mockDeploySafe = jest.fn(async () => {
  mockChain.sent = true;
  return { safeAddress: SAFE_ADDRESS, tx: { hash: DEPLOY_HASH } };
});
jest.mock('./safe-executor', () => ({
  predictSafeAddress: jest.fn(async () => SAFE_ADDRESS),
  buildDeploymentTransaction: jest.fn(async () => ({
    safeAddress: SAFE_ADDRESS,
    to: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67',
    value: '0',
    data: '0xdeadbeef',
  })),
  deploySafe: (...args) => mockDeploySafe(...args),
  pickDefaultExecutor: jest.requireActual('./safe-executor').pickDefaultExecutor,
}));

// The receipt wait (waitForTransaction, getTransactionStatus) stays real.
jest.mock('../transaction-service', () => ({
  ...jest.requireActual('../transaction-service'),
  estimateGas: jest.fn(async () => ({ gasLimit: '300000' })),
  getGasPrices: jest.fn(async () => ({
    type: 'eip1559',
    maxFeePerGas: '2000000000',
    maxPriorityFeePerGas: '1000000000',
  })),
}));

// The executor's balance: enough to pay for the activation.
jest.mock('../provider-manager', () => ({
  getEip1193Provider: () => ({ request: async () => '0xde0b6b3a7640000' }),
}));

const mockRegistry = {
  getNetwork: jest.fn(),
  getEndpoints: jest.fn(),
  getEndpointSources: jest.fn(() => []),
  getEndpointSourceList: jest.fn(() => []),
};
jest.mock('../../networks/network-registry', () => mockRegistry);
jest.mock('../../myotis/myotis-manager', () => ({ NETWORKS: new Map(), isReady: () => false }));
// Colibri is unavailable unless a test gives it an answer.
const mockColibri = { answer: null };
jest.mock('../../ens/colibri-resolver', () => ({
  requestViaColibri: async (_chainId, method, params) => {
    if (!mockColibri.answer) throw new Error('Colibri is not available');
    return mockColibri.answer(method, params);
  },
}));
jest.mock('../../logger', () => ({ verbose: jest.fn(), warn: jest.fn() }));

const { clearAdaptiveRoutingForTest } = require('../../networks/chain-data-router');
const { DEPLOY_CHAIN_ID, getSafeStatus, activateSafe } = require('./safe-service');

const MINED_RECEIPT = {
  transactionHash: DEPLOY_HASH,
  blockNumber: '0x10',
  blockHash: '0x' + 'cd'.repeat(32),
  status: '0x1',
};

// What an endpoint answers: the honest ones the chain's state, the forger
// (any URL that isn't one of the honest ones) a deployed Safe and a
// successful receipt.
function answer(url, method) {
  const deployed = !HONEST.includes(url) || mockChain.sent;
  if (method === 'eth_getCode') return deployed ? SAFE_CODE : '0x';
  if (method === 'eth_getTransactionReceipt') return deployed ? MINED_RECEIPT : null;
  throw new Error(`unexpected ${method}`);
}

/** Gnosis read from `endpoints`, quorum first, as the E2E fixtures read it. */
function useEndpoints(endpoints, quorum = {}) {
  mockRegistry.getNetwork.mockReturnValue({
    access: { readOrder: ['quorum', 'direct'] },
    quorum: { timeoutMs: 1000, ...quorum },
  });
  mockRegistry.getEndpoints.mockImplementation((_chainId, role) =>
    role === 'rpc' ? endpoints : []
  );
  global.fetch = jest.fn(async (url, init) => {
    const { method } = JSON.parse(init.body);
    return { ok: true, json: async () => ({ result: answer(url, method) }) };
  });
}

const originalFetch = global.fetch;
let warn;

beforeEach(() => {
  jest.clearAllMocks();
  clearAdaptiveRoutingForTest();
  mockChain.sent = false;
  mockColibri.answer = null;
  mockWalletRecords[5].deployed = {};
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  global.fetch = originalFetch;
});

describe.each([
  ['its URL listed twice', [FORGER, FORGER], {}],
  ['a quorum with m = 1', [FORGER], { m: 1 }],
  ['its URL with and without a trailing slash', [FORGER, `${FORGER}/`], {}],
  ['its host on two paths', [`${FORGER}/one`, `${FORGER}/two`], {}],
  [
    'two API keys at one keyed provider',
    ['https://lb.drpc.live/gnosis/key-one', 'https://lb.drpc.live/gnosis/key-two'],
    {},
  ],
  ['as 127.0.0.1 and localhost', ['http://127.0.0.1:8545', 'http://localhost:8545'], {}],
  ['on two loopback ports', ['http://127.0.0.1:8545', 'http://127.0.0.1:18549'], {}],
])('one dishonest endpoint, %s', (_name, endpoints, quorum) => {
  test('its eth_getCode does not mark the Safe deployed', async () => {
    useEndpoints(endpoints, quorum);

    await expect(getSafeStatus(5)).rejects.toMatchObject({ code: 'SAFE_UNVERIFIED' });
    expect(mockMarkSafeDeployed).not.toHaveBeenCalled();
    expect(mockWalletRecords[5].deployed).toEqual({});
  });

  test('its receipt for the activation does not mark the Safe deployed', async () => {
    useEndpoints(endpoints, quorum);
    // It answers "no code" until the activation is sent, then a successful
    // receipt and the Safe's code, whether or not it relayed anything.
    global.fetch = jest.fn(async (url, init) => {
      const { method } = JSON.parse(init.body);
      const result = method === 'eth_getCode' && !mockChain.sent ? '0x' : answer(url, method);
      return { ok: true, json: async () => ({ result }) };
    });

    await expect(activateSafe(5)).rejects.toMatchObject({
      code: 'SAFE_UNVERIFIED',
      message: /sent the activation, but couldn't verify/,
    });
    expect(mockDeploySafe).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls.map(([, init]) => JSON.parse(init.body).method)).toContain(
      'eth_getTransactionReceipt'
    );
    expect(mockMarkSafeDeployed).not.toHaveBeenCalled();
    expect(mockWalletRecords[5].deployed).toEqual({});
  });
});

describe('two distinct endpoints that agree', () => {
  test('their eth_getCode marks the Safe deployed', async () => {
    useEndpoints(HONEST);
    mockChain.sent = true;

    await expect(getSafeStatus(5)).resolves.toMatchObject({ deployed: true });
    expect(mockMarkSafeDeployed).toHaveBeenCalledWith(5, DEPLOY_CHAIN_ID);
    expect(mockWalletRecords[5].deployed).toEqual({ [DEPLOY_CHAIN_ID]: { verified: true } });
  });

  test('their receipt for the activation marks the Safe deployed', async () => {
    useEndpoints(HONEST);

    await expect(activateSafe(5)).resolves.toEqual({
      safeAddress: SAFE_ADDRESS,
      hash: DEPLOY_HASH,
    });
    expect(mockMarkSafeDeployed).toHaveBeenCalledWith(5, DEPLOY_CHAIN_ID);
    // The receipt marked it: no eth_getCode after the activation.
    const methods = global.fetch.mock.calls.map(([, init]) => JSON.parse(init.body).method);
    expect(methods.lastIndexOf('eth_getCode')).toBeLessThan(
      methods.indexOf('eth_getTransactionReceipt')
    );
  });
});

// Gnosis read from Colibri, then one dishonest endpoint. The router asks
// Colibri last for a transaction lookup, to prove what the endpoint reported.
function useColibriThenForger() {
  mockRegistry.getNetwork.mockReturnValue({
    access: { readOrder: ['colibri', 'direct'] },
    quorum: { timeoutMs: 1000 },
  });
  mockRegistry.getEndpoints.mockImplementation((_chainId, role) => {
    if (role === 'rpc') return [FORGER];
    if (role === 'prover') return ['https://prover.example'];
    return [];
  });
  // The forger answers "no code" until the activation is sent, then a
  // successful receipt and the Safe's code.
  global.fetch = jest.fn(async (url, init) => {
    const { method } = JSON.parse(init.body);
    const result = method === 'eth_getCode' && !mockChain.sent ? '0x' : answer(url, method);
    return { ok: true, json: async () => ({ result }) };
  });
}

describe("Colibri's answer counts only where the router labels it verified", () => {
  test('its unproven absence leaves the endpoint receipt unverified: no mark', async () => {
    useColibriThenForger();
    // Colibri reports the transaction unknown (#1048: an absence is never
    // proven) and serves no eth_getCode here.
    mockColibri.answer = (method) => {
      if (method === 'eth_getTransactionReceipt') return null;
      throw new Error(`Colibri does not serve ${method} here`);
    };

    await expect(activateSafe(5)).rejects.toMatchObject({ code: 'SAFE_UNVERIFIED' });
    expect(mockDeploySafe).toHaveBeenCalledTimes(1);
    expect(mockMarkSafeDeployed).not.toHaveBeenCalled();
    expect(mockWalletRecords[5].deployed).toEqual({});
  });

  test('its proven receipt for the activation marks the Safe deployed', async () => {
    useColibriThenForger();
    mockColibri.answer = (method, params) => {
      if (method === 'eth_getTransactionReceipt' && params[0] === DEPLOY_HASH) return MINED_RECEIPT;
      throw new Error(`Colibri does not serve ${method} here`);
    };

    await expect(activateSafe(5)).resolves.toEqual({
      safeAddress: SAFE_ADDRESS,
      hash: DEPLOY_HASH,
    });
    expect(mockMarkSafeDeployed).toHaveBeenCalledWith(5, DEPLOY_CHAIN_ID);
  });
});
