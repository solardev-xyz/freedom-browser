/**
 * Main's approval records for the core's Safe sends (approval-records.js;
 * freedom-core design 0016, the SAFE-3 plan's point 5, its PR 6):
 * - ethers' hash of a SafeTx's ten fields is the one freedom-core's Safe
 *   vectors pin (vectors/safe.json, made with protocol-kit 8.0.11);
 * - a record is made only when that hash, for the Safe on Gnosis, is the
 *   core's `safe_tx_hash`; a refusal leaves the Safe's record as it was;
 * - a drop names its SafeTx, `forget` drops whatever the Safe had, and a
 *   record binds its own SafeTx and no other;
 * - nothing is written anywhere, and a fresh module (a restart) holds none.
 * The stages around it (the decision, the propose, the discard, the
 * execution, a crash at each, a downgrade) run in core-sends.test.js.
 */

const fs = require('fs');
const path = require('path');
const records = require('./approval-records');

const ZERO = '0x0000000000000000000000000000000000000000';

// freedom-core's vectors/safe.json `safeTxs` (main 59eafeab): the Safe, the
// SafeTx's fields as safe-pending.json keeps them, and Safe's hash of them.
const VECTORS = Object.freeze([
  {
    id: 'erc20-transfer',
    address: '0x8F1132f7B388b973465304434Fe202874AebCa87',
    safeTx: {
      to: '0x44f649fc8Dc77694E6ABEF1aA966983Dd6ED7C64',
      value: '0',
      data: '0xa9059cbb00000000000000000000000058a57ed9d8d624cbd12e2c467d34787555bb1b250000000000000000000000000000000000000000000000000de0b6b3a7640000',
      operation: 0,
      baseGas: '0',
      gasPrice: '0',
      gasToken: ZERO,
      refundReceiver: ZERO,
      nonce: 3,
      safeTxGas: '0',
    },
    hash: '0x4ab66f94a7275ab9e8f9de1bd04b81c6155627e0eb488f1e7c1050dd9228e62a',
  },
  {
    id: 'nonce-2^53-1',
    address: '0x8F1132f7B388b973465304434Fe202874AebCa87',
    safeTx: {
      to: '0x58A57ed9d8d624cBD12e2C467D34787555bB1b25',
      value: '1',
      data: '0x',
      operation: 0,
      baseGas: '0',
      gasPrice: '0',
      gasToken: ZERO,
      refundReceiver: ZERO,
      nonce: 9007199254740991,
      safeTxGas: '0',
    },
    hash: '0xc4a62c10638480caba3914faa68498ecce811e8c288d0a0644f37a097c6ae88a',
  },
  {
    id: 'two-of-three',
    address: '0xcfe8648d28Ee53000aC7C480Da4BE4BDa8BEacba',
    safeTx: {
      to: '0x58A57ed9d8d624cBD12e2C467D34787555bB1b25',
      value: '1000000000000000000',
      data: '0x',
      operation: 0,
      baseGas: '0',
      gasPrice: '0',
      gasToken: ZERO,
      refundReceiver: ZERO,
      nonce: 9,
      safeTxGas: '0',
    },
    hash: '0xf2facd14536e4dabebdf57c9ba6270e2f7bd7cbbaea141f03163de382112653f',
  },
]);

const [V] = VECTORS;
const prepared = (overrides = {}) => ({
  address: V.address,
  chainId: 100,
  safeTx: V.safeTx,
  safeTxHash: V.hash,
  ...overrides,
});
const RECORD = { address: V.address, chainId: 100, hash: V.hash };

beforeEach(() => {
  records._reset();
});

describe("ethers' hash of a SafeTx", () => {
  test.each(VECTORS.map((v) => [v.id, v]))("is the core's vector's (%s)", (_id, v) => {
    expect(records.safeTxHashOf(v.address, 100, v.safeTx)).toBe(v.hash);
    // Any case of the addresses spells the same SafeTx.
    const lower = { ...v.safeTx, to: v.safeTx.to.toLowerCase() };
    expect(records.safeTxHashOf(v.address.toLowerCase(), 100, lower)).toBe(v.hash);
  });

  test('of exactly the ten fields, or a throw', () => {
    const { nonce: _nonce, ...nine } = V.safeTx;
    expect(() => records.safeTxHashOf(V.address, 100, nine)).toThrow('Invalid Safe transaction');
    expect(() => records.safeTxHashOf(V.address, 100, { ...V.safeTx, extra: 1 })).toThrow(
      'Invalid Safe transaction'
    );
    expect(() => records.safeTxHashOf(V.address, 100, null)).toThrow('Invalid Safe transaction');
    expect(() => records.safeTxHashOf('0x1234', 100, V.safeTx)).toThrow('Invalid Safe address');
  });
});

describe('a record', () => {
  test("is made when ethers' hash of the fields, for the Safe on Gnosis, is the core's safe_tx_hash", () => {
    expect(records.recordFor(5)).toBeNull();
    const made = records.record(5, prepared());
    expect(made).toEqual(RECORD);
    expect(records.recordFor(5)).toEqual(RECORD);
    expect(Object.isFrozen(records.recordFor(5))).toBe(true);
    // The core's hash in any case, the address in any case.
    records._reset();
    records.record(
      5,
      prepared({
        address: V.address.toLowerCase(),
        safeTxHash: V.hash.toUpperCase().replace('0X', '0x'),
      })
    );
    expect(records.recordFor(5)).toEqual(RECORD);
  });

  test.each([
    ['another hash', { safeTxHash: VECTORS[1].hash }],
    ['a field changed (its nonce)', { safeTx: { ...V.safeTx, nonce: 4 } }],
    ['a field changed (its value)', { safeTx: { ...V.safeTx, value: '1' } }],
    ['another Safe', { address: VECTORS[2].address }],
    ['another chain', { chainId: 1 }],
    ['the chain as text', { chainId: '100' }],
    ['a field missing', { safeTx: { ...V.safeTx, nonce: undefined } }],
    ['no hash', { safeTxHash: undefined }],
    ['a malformed hash', { safeTxHash: V.hash.slice(0, 64) }],
    ['a malformed address', { address: 'nope' }],
  ])("is refused for %s, the Safe's record left as it was", (_name, overrides) => {
    expect(() => records.record(5, prepared(overrides))).toThrow("doesn't match its hash");
    expect(records.recordFor(5)).toBeNull();
    const older = records.record(5, {
      ...prepared(),
      safeTx: VECTORS[1].safeTx,
      safeTxHash: VECTORS[1].hash,
    });
    expect(() => records.record(5, prepared(overrides))).toThrow("doesn't match its hash");
    expect(records.recordFor(5)).toBe(older);
  });

  test('verify checks as record does, and records nothing', () => {
    expect(records.verify(prepared())).toEqual(RECORD);
    expect(records.recordFor(5)).toBeNull();
    expect(() => records.verify(prepared({ chainId: 1 }))).toThrow("doesn't match its hash");
    expect(() => records.verify()).toThrow("doesn't match its hash");
  });

  test("a newer decision replaces the Safe's record; each Safe has its own", () => {
    records.record(5, prepared());
    const newer = { ...prepared(), safeTx: VECTORS[1].safeTx, safeTxHash: VECTORS[1].hash };
    records.record(5, newer);
    expect(records.recordFor(5)).toEqual({ ...RECORD, hash: VECTORS[1].hash });
    records.record(
      6,
      prepared({
        address: VECTORS[2].address,
        safeTx: VECTORS[2].safeTx,
        safeTxHash: VECTORS[2].hash,
      })
    );
    expect(records.recordFor(6)).toEqual({
      address: VECTORS[2].address,
      chainId: 100,
      hash: VECTORS[2].hash,
    });
    expect(records.recordFor(5).hash).toBe(VECTORS[1].hash);
  });

  test('a Safe index is a wallet index', () => {
    for (const index of [-1, 1.5, '5', null, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => records.record(index, prepared())).toThrow('Invalid Safe index');
    }
  });
});

describe('a drop', () => {
  test("names its SafeTx (any case): another SafeTx's record stays", () => {
    records.record(5, prepared());
    expect(records.drop(5, VECTORS[1].hash)).toBe(false);
    expect(records.recordFor(5)).toEqual(RECORD);
    expect(records.drop(5, V.hash.toUpperCase().replace('0X', '0x'))).toBe(true);
    expect(records.recordFor(5)).toBeNull();
    expect(records.drop(5, V.hash)).toBe(false);
  });

  test("one that names no hash drops the Safe's record; forget drops whatever it was", () => {
    records.record(5, prepared());
    expect(records.drop(5, undefined)).toBe(true);
    expect(records.recordFor(5)).toBeNull();
    records.record(5, prepared());
    records.forget(5);
    expect(records.recordFor(5)).toBeNull();
    // Nothing held: nothing to do.
    records.forget(7);
    expect(records.drop(7, V.hash)).toBe(false);
  });

  test('is never undone: a dropped record comes back only with a new decision', () => {
    records.record(5, prepared());
    records.drop(5, V.hash);
    expect(records.binds(5, { address: V.address, chainId: 100, safeTx: V.safeTx })).toBe(false);
    expect(records.recordFor(5)).toBeNull();
  });
});

describe('binds', () => {
  test('its own SafeTx, for its Safe on its chain, and no other', () => {
    records.record(5, prepared());
    const bound = (overrides = {}) =>
      records.binds(5, { address: V.address, chainId: 100, safeTx: V.safeTx, ...overrides });
    expect(bound()).toBe(true);
    expect(bound({ address: V.address.toLowerCase() })).toBe(true);
    expect(bound({ safeTx: { ...V.safeTx, nonce: 4 } })).toBe(false);
    expect(bound({ safeTx: { ...V.safeTx, to: VECTORS[2].address } })).toBe(false);
    expect(bound({ safeTx: { ...V.safeTx, data: '0x' } })).toBe(false);
    expect(bound({ safeTx: { ...V.safeTx, operation: 1 } })).toBe(false);
    expect(bound({ safeTx: VECTORS[1].safeTx })).toBe(false);
    expect(bound({ address: VECTORS[2].address })).toBe(false);
    expect(bound({ chainId: 1 })).toBe(false);
    expect(bound({ safeTx: { ...V.safeTx, extra: 1 } })).toBe(false);
    expect(bound({ safeTx: null })).toBe(false);
    expect(records.binds(6, { address: V.address, chainId: 100, safeTx: V.safeTx })).toBe(false);
    expect(records.binds(5)).toBe(false);
  });
});

describe('in memory only', () => {
  test('the module loads nothing that writes (ethers only)', () => {
    const source = fs.readFileSync(path.join(__dirname, 'approval-records.js'), 'utf8');
    const required = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    expect(required).toEqual(['ethers']);
  });

  test('an fs spy sees no write through record, drop, forget and binds', () => {
    const names = [
      'writeFileSync',
      'appendFileSync',
      'renameSync',
      'copyFileSync',
      'openSync',
      'mkdirSync',
      'writeSync',
      'createWriteStream',
      'writeFile',
      'appendFile',
      'rename',
      'copyFile',
      'open',
      'mkdir',
      'write',
    ];
    const promised = ['writeFile', 'appendFile', 'rename', 'copyFile', 'open', 'mkdir'];
    const spies = [
      ...names.map((name) => jest.spyOn(fs, name)),
      ...promised.map((name) => jest.spyOn(fs.promises, name)),
    ];
    try {
      records.record(5, prepared());
      records.binds(5, { address: V.address, chainId: 100, safeTx: V.safeTx });
      records.drop(5, V.hash);
      records.record(5, prepared());
      records.forget(5);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });

  test('a restart (a fresh module) holds no record', () => {
    records.record(5, prepared());
    let fresh = null;
    jest.isolateModules(() => {
      fresh = require('./approval-records');
    });
    expect(fresh).not.toBe(records);
    expect(fresh.recordFor(5)).toBeNull();
    expect(fresh.binds(5, { address: V.address, chainId: 100, safeTx: V.safeTx })).toBe(false);
    expect(records.recordFor(5)).toEqual(RECORD);
  });
});
