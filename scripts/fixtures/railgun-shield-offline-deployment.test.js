const { Interface, keccak256, id, toBeHex } = require('ethers');
jest.mock('fs', () => ({ statSync: jest.fn(), readFileSync: jest.fn() }));
jest.mock('../../src/main/wallet/railgun-shield-pins.json', () => {
  const real = jest.requireActual('../../src/main/wallet/railgun-shield-pins.json');
  const { keccak256 } = jest.requireActual('ethers');
  return {
    ...real,
    codeHashes: Object.fromEntries(
      ['proxy', 'relayAdapt', 'wrappedNative', 'implementation'].map((name, i) => [
        name,
        keccak256('0x600' + i),
      ])
    ),
  };
});
const fs = require('fs');
const pins = require('../../src/main/wallet/railgun-shield-pins.json');
const { createOfflineShieldDeployment } = require('./railgun-shield-offline-deployment');
const filename = '/private/tmp/public-bytecode-fixture.json';
const abi = new Interface([
  'function railgun() view returns (address)',
  'function wBase() view returns (address)',
  'function shieldFee() view returns (uint120)',
  'function tokenBlocklist(address) view returns (bool)',
]);
let fixture;
const call = (method, params) => ({ jsonrpc: '2.0', id: 1, method, params });
function load() {
  fs.readFileSync.mockReturnValue(Buffer.from(JSON.stringify(fixture)));
  return createOfflineShieldDeployment(filename);
}
function anchored() {
  const deployment = load();
  const header = deployment.request(call('eth_getBlockByNumber', ['latest', false]));
  return { deployment, header, block: { blockHash: header.hash, requireCanonical: true } };
}
beforeEach(() => {
  jest.clearAllMocks();
  fixture = {
    schema: 'railgun-public-contract-bytecodes-v1',
    chainId: 11155111,
    code: {
      proxy: '0x6000',
      relayAdapt: '0x6001',
      wrappedNative: '0x6002',
      implementation: '0x6003',
    },
  };
  fs.statSync.mockReturnValue({ isFile: () => true, size: 1000 });
});
test('verifies every code hash and serves the bounded deployment reads at one anchor', () => {
  const { deployment, header, block } = anchored();
  expect(deployment.request(call('eth_chainId', []))).toBe('0xaa36a7');
  for (const name of Object.keys(fixture.code)) {
    const code = deployment.request(call('eth_getCode', [pins[name], block]));
    expect(keccak256(code)).toBe(pins.codeHashes[name]);
  }
  expect(
    deployment.request(
      call('eth_getStorageAt', [
        pins.proxy,
        toBeHex(BigInt(id('eip1967.proxy.implementation')) - 1n, 32),
        block,
      ])
    )
  ).toBe('0x' + pins.implementation.slice(2).padStart(64, '0'));
  expect(
    deployment.request(
      call('eth_getStorageAt', [
        pins.proxy,
        toBeHex(BigInt(id('eip1967.proxy.paused')) - 1n, 32),
        block,
      ])
    )
  ).toBe('0x' + '0'.repeat(64));
  for (const [to, method, args, expected] of [
    [pins.relayAdapt, 'railgun', [], pins.proxy],
    [pins.relayAdapt, 'wBase', [], pins.wrappedNative],
    [pins.proxy, 'shieldFee', [], BigInt(pins.shieldFeeBps)],
    [pins.proxy, 'tokenBlocklist', [pins.wrappedNative], false],
  ]) {
    const result = deployment.request(
      call('eth_call', [{ to, data: abi.encodeFunctionData(method, args) }, block])
    );
    expect(result).toBe(abi.encodeFunctionResult(method, [expected]).toLowerCase());
  }
  expect(deployment.request(call('eth_getBlockByNumber', [header.number, false]))).toEqual(header);
  expect(deployment.report()).toMatchObject({
    publicBytecodeMatchesPins: true,
    syntheticHeadersSlotsAndGetters: true,
    liveDeploymentQualified: false,
    methods: {
      eth_chainId: 1,
      eth_getCode: 4,
      eth_getStorageAt: 2,
      eth_call: 4,
      eth_getBlockByNumber: 2,
    },
  });
});
test.each(['proxy', 'relayAdapt', 'wrappedNative', 'implementation'])(
  'rejects altered %s bytecode',
  (name) => {
    fixture.code[name] += '00';
    expect(load).toThrow();
  }
);
test('refuses an extra contract, wrong schema, or chain before serving requests', () => {
  fixture.code.other = '0x6000';
  expect(load).toThrow();
  fixture.code = {
    proxy: '0x6000',
    relayAdapt: '0x6001',
    wrappedNative: '0x6002',
    implementation: '0x6003',
  };
  fixture.chainId = 1;
  expect(load).toThrow();
  fixture.chainId = 11155111;
  fixture.schema = 'unreviewed';
  expect(load).toThrow();
});
test('bounds both stat and actual bytes and requires an absolute file', () => {
  expect(() => createOfflineShieldDeployment('relative.json')).toThrow();
  fs.statSync.mockReturnValue({ isFile: () => true, size: 256001 });
  expect(load).toThrow();
  expect(fs.readFileSync).not.toHaveBeenCalled();
  fs.statSync.mockReturnValue({ isFile: () => true, size: 1000 });
  fs.readFileSync.mockReturnValue(Buffer.alloc(256001, 32));
  expect(() => createOfflineShieldDeployment(filename)).toThrow();
});
test('refuses reads before anchor, stale anchors, noncanonical anchors and unknown addresses', () => {
  const deployment = load();
  expect(() => deployment.request(call('eth_getCode', [pins.proxy, 'latest']))).toThrow();
  const old = deployment.request(call('eth_getBlockByNumber', ['latest', false]));
  const header = deployment.request(call('eth_getBlockByNumber', ['latest', false]));
  expect(header.hash).not.toBe(old.hash);
  for (const block of [
    'latest',
    { blockHash: old.hash, requireCanonical: true },
    { blockHash: header.hash, requireCanonical: false },
  ])
    expect(() => deployment.request(call('eth_getCode', [pins.proxy, block]))).toThrow();
  expect(() =>
    deployment.request(
      call('eth_getCode', [
        '0x' + '1'.repeat(40),
        { blockHash: header.hash, requireCanonical: true },
      ])
    )
  ).toThrow();
});
test('refuses unknown methods, extra call fields, wrong targets, arguments and slots', () => {
  const { deployment, block } = anchored();
  for (const request of [
    call('eth_sendRawTransaction', ['0x1234', block]),
    call('eth_getStorageAt', [pins.proxy, '0x' + '0'.repeat(64), block]),
    call('eth_call', [{ to: pins.proxy, data: abi.encodeFunctionData('railgun') }, block]),
    call('eth_call', [
      { to: pins.proxy, data: abi.encodeFunctionData('tokenBlocklist', [pins.proxy]) },
      block,
    ]),
    call('eth_call', [
      { to: pins.proxy, data: abi.encodeFunctionData('shieldFee'), from: pins.proxy },
      block,
    ]),
    call('eth_call', [{ to: pins.proxy, data: abi.encodeFunctionData('shieldFee') + '00' }, block]),
  ])
    expect(() => deployment.request(request)).toThrow();
  expect(deployment.report().methods.eth_sendRawTransaction).toBe(1);
});
