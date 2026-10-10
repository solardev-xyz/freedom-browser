const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, 'railgun-submitter-host.js'), 'utf8');
const { getAddress } = require('ethers');
const WALLET_TYPES = { MNEMONIC: 'mnemonic' }; // identity-manager's public record type
const address = '0x1111111111111111111111111111111111111111';
const nextAddress = '0x2222222222222222222222222222222222222222';
const refused = expect.objectContaining({ code: 'RAILGUN_SUBMITTER_HOST_REFUSED' });
function load({ realm, mainThread = true } = {}) {
  const state = { record: { index: 0, type: WALLET_TYPES.MNEMONIC, address } };
  const read = jest.fn(() => state.record),
    imports = [];
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    process: { type: realm },
    require(name) {
      imports.push(name);
      if (name === 'worker_threads') return { isMainThread: mainThread };
      if (name === '../identity-manager') return { getWalletRecord: read, WALLET_TYPES };
      if (name === 'ethers') return { getAddress };
      if (name === 'assert') return require('assert');
      throw new Error('Unexpected import');
    },
  });
  return { state, read, imports, factory: module.exports.createRailgunSubmitterHost };
}
test('fixed main-only factory is lazy and exposes no record or signer', () => {
  const m = load(),
    host = m.factory();
  expect(Object.keys(host)).toEqual(['readMetadata']);
  expect(Object.isFrozen(host)).toBe(true);
  expect(m.imports).toEqual(['assert', 'worker_threads']);
  expect(m.read).not.toHaveBeenCalled();
  m.state.record.privateField = 'not exported';
  const result = host.readMetadata();
  expect(result).toEqual({ index: 0, type: WALLET_TYPES.MNEMONIC, address });
  expect(Object.isFrozen(result)).toBe(true);
  expect(result).not.toBe(m.state.record);
  expect(m.read.mock.calls).toEqual([[0]]);
});
test('reads actual wallet zero afresh on every call and normalizes a valid checksum', () => {
  const m = load(),
    host = m.factory();
  const a = host.readMetadata();
  m.state.record = { index: 0, type: WALLET_TYPES.MNEMONIC, address: nextAddress };
  const b = host.readMetadata();
  expect(a.address).toBe(address);
  expect(b.address).toBe(nextAddress);
  expect(m.read.mock.calls).toEqual([[0], [0]]);
  const checksummed = getAddress('0x52908400098527886e0f7030069857d2e4169ee7');
  m.state.record.address = checksummed;
  expect(host.readMetadata().address).toBe(checksummed.toLowerCase());
});
test.each([
  null,
  { index: 1, type: WALLET_TYPES.MNEMONIC, address },
  { index: '0', type: WALLET_TYPES.MNEMONIC, address },
  { index: 0, type: 'foreign', address },
  { index: 0, type: WALLET_TYPES.MNEMONIC, address: '0x' + '0'.repeat(40) },
  { index: 0, type: WALLET_TYPES.MNEMONIC, address: 'bad' },
])('refuses absent or invalid public submitter metadata: %p', (record) => {
  const m = load(),
    host = m.factory();
  m.state.record = record;
  expect(() => host.readMetadata()).toThrow();
  expect(m.read.mock.calls).toEqual([[0]]);
});
test('propagates the original metadata read failure without fallback', () => {
  const m = load(),
    error = new Error('synthetic read failure');
  m.read.mockImplementation(() => {
    throw error;
  });
  expect(() => m.factory().readMetadata()).toThrow(error);
  expect(m.imports).not.toContain('ethers');
});
test.each([undefined, null, 42, { privateField: 'must-not-reach-ethers' }])(
  'rejects a non-string address before ethers can include its value in an error: %p',
  (value) => {
    const m = load();
    m.state.record.address = value;
    expect(() => m.factory().readMetadata()).toThrow(
      expect.objectContaining({ code: 'ERR_ASSERTION' })
    );
    expect(m.imports).not.toContain('ethers');
  }
);
test.each([{ realm: 'renderer' }, { realm: 'utility' }, { mainThread: false }])(
  'refuses a foreign realm before metadata access: %p',
  (options) => {
    const m = load(options);
    expect(() => m.factory()).toThrow(refused);
    expect(m.read).not.toHaveBeenCalled();
  }
);
test('rejects an injected factory or alternate account argument before reading', () => {
  const m = load();
  expect(() => m.factory({ getWalletRecord() {} })).toThrow(refused);
  expect(() => m.factory().readMetadata(1)).toThrow(refused);
  expect(m.read).not.toHaveBeenCalled();
});
