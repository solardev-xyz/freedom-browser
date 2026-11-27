/**
 * Main's typed-data binding (apdu-binding.js; freedom-core design 0016,
 * Main's typed-data binding, LDG-3 PR 2) without the vectors: the stream's
 * bytes on hand-made typed data, in both branches as the Admission
 * assembles them, each refusal before the first APDU, and the binding's
 * shape as PR 1's Admission takes it. apdu-binding.vectors.test.js holds the
 * module to every typed-data case and family of the pinned core's vectors.
 */

const { TypedDataEncoder, getIcapAddress, keccak256, concat } = require('ethers');
const { BOUNDS, HEADER, bindTypedData } = require('./apdu-binding');

// 44'/60'/0'/0/0, as the grammar encodes a path: n, then n big-endian elements.
const P = '058000002c8000003c800000000000000000000000';

const MAIL = {
  domain: {
    name: 'Ether Mail',
    version: '1',
    chainId: 1,
    verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
  },
  types: {
    Person: [
      { name: 'name', type: 'string' },
      { name: 'wallet', type: 'address' },
    ],
    Mail: [
      { name: 'from', type: 'Person' },
      { name: 'to', type: 'Person' },
      { name: 'contents', type: 'string' },
    ],
  },
  message: {
    from: { name: 'Cow', wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826' },
    to: { name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' },
    contents: 'Hello, Bob!',
  },
};

// The Mail example's definitions, values and signing APDU, as vectors/ledger.json's
// typed-mail case records them (after its address check and B0 01).
const MAIL_STREAM = [
  'e01a00000c454950373132446f6d61696e',
  'e01a00ff0605046e616d65',
  'e01a00ff09050776657273696f6e',
  'e01a00ff0a422007636861696e4964',
  'e01a00ff130311766572696679696e67436f6e7472616374',
  'e01a0000044d61696c',
  'e01a00ff0d0006506572736f6e0466726f6d',
  'e01a00ff0b0006506572736f6e02746f',
  'e01a00ff0a0508636f6e74656e7473',
  'e01a000006506572736f6e',
  'e01a00ff0605046e616d65',
  'e01a00ff08030677616c6c6574',
  'e01c00000c454950373132446f6d61696e',
  'e01c00ff0c000a4574686572204d61696c',
  'e01c00ff03000131',
  'e01c00ff03000101',
  'e01c00ff160014cccccccccccccccccccccccccccccccccccccccc',
  'e01c0000044d61696c',
  'e01c00ff050003436f77',
  'e01c00ff160014cd2a3d9f938e13cd947ec05abc7fe734df8dd826',
  'e01c00ff050003426f62',
  'e01c00ff160014bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  'e01c00ff0d000b48656c6c6f2c20426f6221',
  'e00c000115058000002c8000003c800000000000000000000000',
];

function hashOf(typedData) {
  return TypedDataEncoder.hash(typedData.domain, typedData.types, typedData.message);
}

/**
 * The typed part of an operation as PR 1's Admission (core/ledger-grammar.js)
 * assembles it around the binding, in hex: the binding's APDUs, then
 * `E0 0C 00 01 P`; or, past Q23's gate, the first `E0 1A` and
 * `E0 0C 00 00 P ‖ domainSeparator ‖ structHash`. A refusal as it is.
 */
function typedDataApdus({ typedData, expectedHash, path, hashOnly = false }) {
  const binding = bindTypedData({ typedData, expectedHash });
  if (binding.rule) return binding;
  const apdus = binding.apdus.map((a) => a.toString('hex'));
  const lc = (hex) => (hex.length / 2).toString(16).padStart(2, '0');
  const hashes = binding.domainSeparator.toString('hex') + binding.structHash.toString('hex');
  return {
    apdus: hashOnly
      ? [apdus[0], 'e00c0000' + lc(path + hashes) + path + hashes]
      : [...apdus, 'e00c0001' + lc(path) + path],
    hashes: {
      domainSeparator: '0x' + binding.domainSeparator.toString('hex'),
      structHash: '0x' + binding.structHash.toString('hex'),
    },
  };
}

/** The binding of `typedData` under its own ethers hash. */
function bind(typedData, options = {}) {
  return typedDataApdus({ typedData, expectedHash: hashOf(typedData), path: P, ...options });
}

/** The values' APDUs of a one-field primary type `T { <type> v }` holding `value`. */
function valueApdus(type, value) {
  const result = bind({ domain: {}, types: { T: [{ name: 'v', type }] }, message: { v: value } });
  expect(result.rule).toBeUndefined();
  // EIP712Domain, T and its field; E0 1C EIP712Domain, E0 1C T; then v's; then E0 0C.
  return result.apdus.slice(5, -1);
}

function descriptorOf(type, name = 'v') {
  const result = bind({
    domain: {},
    types: { T: [{ name, type }] },
    message: { [name]: sampleValue(type) },
  });
  expect(result.rule).toBeUndefined();
  return result.apdus[2];
}

function sampleValue(type) {
  if (type.endsWith('[]')) return [];
  if (type.endsWith(']')) {
    const open = type.lastIndexOf('[');
    const n = Number(type.slice(open + 1, -1));
    return Array.from({ length: n }, () => sampleValue(type.slice(0, open)));
  }
  if (type.startsWith('bytes') && type !== 'bytes')
    return '0x' + '00'.repeat(Number(type.slice(5)));
  if (type === 'string') return '';
  if (type === 'bytes') return '0x';
  if (type === 'bool') return false;
  if (type === 'address') return '0x' + '00'.repeat(20);
  return 0;
}

describe('the stream, field by field', () => {
  test('the Mail example: definitions in order of their names, values depth first, then E0 0C 00 01 P', () => {
    const result = typedDataApdus({ typedData: MAIL, expectedHash: hashOf(MAIL), path: P });
    expect(result.apdus).toStrictEqual(MAIL_STREAM);
    expect(result.hashes).toStrictEqual({
      domainSeparator: TypedDataEncoder.hashDomain(MAIL.domain),
      structHash: TypedDataEncoder.from(MAIL.types).hash(MAIL.message),
    });
  });

  test('the expected hash is compared in any case of its hex digits', () => {
    const result = typedDataApdus({
      typedData: MAIL,
      expectedHash: '0x' + hashOf(MAIL).slice(2).toUpperCase(),
      path: P,
    });
    expect(result.apdus).toStrictEqual(MAIL_STREAM);
  });

  test('the types go in ascending byte order of their names, EIP712Domain among them', () => {
    const typedData = {
      domain: {},
      types: {
        a: [{ name: 'x', type: 'uint8' }],
        Z: [
          { name: 'p', type: 'a' },
          { name: 'q', type: '_b' },
          { name: 'r', type: '$c' },
        ],
        _b: [{ name: 'y', type: 'bool' }],
        $c: [],
      },
      message: { p: { x: 1 }, q: { y: true }, r: {} },
    };
    const names = bind(typedData)
      .apdus.filter((a) => a.startsWith(HEADER.TYPE_NAME))
      .map((a) => Buffer.from(a.slice(10), 'hex').toString());
    expect(names).toStrictEqual(['$c', 'EIP712Domain', 'Z', '_b', 'a']);
  });

  test("the domain's fields are getPayload's, in its order, the null ones skipped", () => {
    const typedData = {
      domain: { salt: '0x' + '11'.repeat(32), chainId: '0x64', name: 'N', version: null },
      types: { T: [] },
      message: {},
    };
    const apdus = bind(typedData).apdus;
    expect(apdus.slice(0, 4)).toStrictEqual([
      'e01a00000c454950373132446f6d61696e',
      'e01a00ff0605046e616d65',
      'e01a00ff0a422007636861696e4964',
      'e01a00ff074620' + '0473616c74',
    ]);
    // E0 1C EIP712Domain, then name, chainId 100, salt.
    expect(apdus.slice(5, 9)).toStrictEqual([
      'e01c00000c454950373132446f6d61696e',
      'e01c00ff0300014e',
      'e01c00ff03000164',
      'e01c00ff220020' + '11'.repeat(32),
    ]);
  });

  test("each field's descriptor: type byte, custom name, size, dimensions, name", () => {
    expect(descriptorOf('uint256', 'chainId')).toBe('e01a00ff0a422007636861696e4964');
    expect(descriptorOf('int8')).toBe('e01a00ff04410101' + '76');
    expect(descriptorOf('bytes32', 'n')).toBe('e01a00ff044620016e');
    expect(descriptorOf('bytes')).toBe('e01a00ff03070176');
    expect(descriptorOf('bool')).toBe('e01a00ff03040176');
    expect(descriptorOf('address')).toBe('e01a00ff03030176');
    expect(descriptorOf('string')).toBe('e01a00ff03050176');
    // uint8[2][]: the array and size bits, size 1, two dimensions as written.
    expect(descriptorOf('uint8[2][]')).toBe('e01a00ff08c2010201020001' + '76');
    expect(descriptorOf('uint8[255]')).toBe('e01a00ff07c20101' + '01ff' + '0176');
    // `uint` and `int` are ethers' uint256 and int256.
    expect(descriptorOf('uint')).toBe(descriptorOf('uint256'));
    expect(descriptorOf('int[]')).toBe(descriptorOf('int256[]'));
    const nested = bind({
      domain: {},
      types: { P: [{ name: 'n', type: 'string' }], T: [{ name: 'from', type: 'P[]' }] },
      message: { from: [] },
    });
    expect(nested.apdus[4]).toBe('e01a00ff' + '0a' + '80' + '0150' + '0100' + '0466726f6d');
  });

  test('integers: minimal big-endian bytes, one zero byte for 0, negatives in their width', () => {
    const data = (type, value) => valueApdus(type, value).map((a) => a.slice(10));
    expect(data('uint8', 0)).toStrictEqual(['000100']);
    expect(data('uint256', '0x2105')).toStrictEqual(['00022105']);
    expect(data('uint256', '255')).toStrictEqual(['0001ff']);
    expect(data('uint256', '256')).toStrictEqual(['00020100']);
    expect(data('int8', -1)).toStrictEqual(['0001ff']);
    expect(data('int8', -128)).toStrictEqual(['000180']);
    expect(data('int8', 127)).toStrictEqual(['00017f']);
    expect(data('int16', -1)).toStrictEqual(['0002ffff']);
    expect(data('int16', '-256')).toStrictEqual(['0002ff00']);
    expect(data('int256', -1)).toStrictEqual(['0020' + 'ff'.repeat(32)]);
    expect(data('uint256', (2n ** 256n - 1n).toString())).toStrictEqual(['0020' + 'ff'.repeat(32)]);
  });

  test('bools, addresses, bytes and strings as the encoders write them', () => {
    const data = (type, value) => valueApdus(type, value).map((a) => a.slice(10));
    expect(data('bool', true)).toStrictEqual(['000101']);
    expect(data('bool', false)).toStrictEqual(['000100']);
    expect(data('address', '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826')).toStrictEqual([
      '0014cd2a3d9f938e13cd947ec05abc7fe734df8dd826',
    ]);
    expect(data('bytes', '0x')).toStrictEqual(['0000']);
    expect(data('bytes', '0xABcd')).toStrictEqual(['0002abcd']);
    expect(data('bytes4', '0x01020304')).toStrictEqual(['000401020304']);
    expect(data('string', '')).toStrictEqual(['0000']);
    expect(data('string', 'é😀')).toStrictEqual(['0006c3a9f09f9880']);
  });

  test('a value goes whole, its 2-byte length first, in pieces of 255 (deviation field-pieces)', () => {
    for (const [length, sizes] of [
      [0, [2]],
      [253, [255]],
      [254, [255, 1]],
      [508, [255, 255]],
      [509, [255, 255, 1]],
      [65535, [...Array(257).fill(255), 2]],
    ]) {
      const bytes = Buffer.alloc(length, 0).map((_, i) => i % 251);
      const apdus = valueApdus('bytes', '0x' + bytes.toString('hex'));
      expect(apdus.map((a) => parseInt(a.slice(8, 10), 16))).toStrictEqual(sizes);
      expect(apdus.map((a) => a.slice(0, 8))).toStrictEqual([
        ...Array(sizes.length - 1).fill(HEADER.VALUE_MORE),
        HEADER.VALUE_LAST,
      ]);
      const joined = Buffer.from(apdus.map((a) => a.slice(10)).join(''), 'hex');
      expect(joined.readUInt16BE(0)).toBe(length);
      expect(joined.subarray(2).equals(bytes)).toBe(true);
    }
  });

  test('arrays: the outermost dimension first, each its length, then its entries', () => {
    const apdus = valueApdus('uint8[2][]', [
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
    expect(apdus).toStrictEqual([
      'e01c000f0103',
      'e01c000f0102',
      'e01c00ff03000101',
      'e01c00ff03000102',
      'e01c000f0102',
      'e01c00ff03000103',
      'e01c00ff03000104',
      'e01c000f0102',
      'e01c00ff03000105',
      'e01c00ff03000106',
    ]);
    expect(valueApdus('string[]', [])).toStrictEqual(['e01c000f0100']);
  });

  test("a struct's values in its declared order, nested ones depth first; extra message keys unread", () => {
    const typedData = {
      domain: { chainId: 1 },
      types: {
        Inner: [
          { name: 'b', type: 'uint8' },
          { name: 'a', type: 'uint8' },
        ],
        Outer: [
          { name: 'z', type: 'Inner[]' },
          { name: 'y', type: 'uint8' },
        ],
      },
      message: { y: 9, z: [{ a: 2, b: 1 }], ignored: 'x' },
    };
    const apdus = bind(typedData).apdus;
    expect(apdus.slice(-6)).toStrictEqual([
      'e01c0000054f75746572',
      'e01c000f0101',
      'e01c00ff03000101',
      'e01c00ff03000102',
      'e01c00ff03000109',
      'e00c000115' + P,
    ]);
  });

  test('the input is not changed', () => {
    const copy = JSON.parse(JSON.stringify(MAIL));
    bind(copy);
    bind(copy, { hashOnly: true });
    expect(copy).toStrictEqual(JSON.parse(JSON.stringify(MAIL)));
  });
});

describe('the hash-only branch (Q23)', () => {
  test("the first E0 1A, then E0 0C 00 00 P ‖ domainSeparator ‖ hashStruct(message), ethers' hashes", () => {
    const result = typedDataApdus({
      typedData: MAIL,
      expectedHash: hashOf(MAIL),
      path: P,
      hashOnly: true,
    });
    const { domainSeparator, structHash } = result.hashes;
    expect(domainSeparator).toBe(TypedDataEncoder.hashDomain(MAIL.domain));
    expect(structHash).toBe(TypedDataEncoder.from(MAIL.types).hash(MAIL.message));
    expect(keccak256(concat(['0x1901', domainSeparator, structHash]))).toBe(hashOf(MAIL));
    expect(result.apdus).toStrictEqual([
      MAIL_STREAM[0],
      'e00c000055' + P + domainSeparator.slice(2) + structHash.slice(2),
    ]);
  });

  test('the same refusals as the stream field by field: both are encoded whole first', () => {
    const typedData = {
      domain: {},
      types: { T: [{ name: 'v', type: 'uint8[]' }] },
      message: { v: Array(256).fill(0) },
    };
    expect(bind(typedData, { hashOnly: true })).toStrictEqual({
      rule: 'payload',
      reason: 'device-bounds',
      bound: { name: 'array_entries', size: 256 },
    });
  });
});

describe('refused before the first APDU, rule payload', () => {
  test("a typed data whose ethers hash isn't expected_hash", () => {
    const hash = hashOf(MAIL);
    const other = hash.slice(0, -1) + (hash.endsWith('0') ? '1' : '0');
    for (const hashOnly of [false, true]) {
      expect(
        typedDataApdus({ typedData: MAIL, expectedHash: other, path: P, hashOnly })
      ).toStrictEqual({
        rule: 'payload',
        reason: 'hash-mismatch',
      });
    }
    for (const expectedHash of [undefined, hash.slice(2), hash + '00', '0x' + 'g'.repeat(64), 7]) {
      expect(typedDataApdus({ typedData: MAIL, expectedHash, path: P }).reason).toBe(
        'hash-mismatch'
      );
    }
  });

  test('a name outside the identifiers or __proto__ (deviation name-ascii)', () => {
    const field = (name) => ({
      domain: {},
      types: { T: [{ name, type: 'uint8' }] },
      message: { [name]: 1 },
    });
    for (const name of ['é', 'a😀', 'a b', '1a', '', 'a-b']) {
      expect(bind(field(name))).toStrictEqual({ rule: 'payload', reason: 'name-ascii' });
    }
    const typeNamed = (name) => ({
      domain: {},
      types: { [name]: [{ name: 'v', type: 'uint8' }] },
      message: { v: 1 },
    });
    expect(bind(typeNamed('Té')).reason).toBe('name-ascii');
    const proto = JSON.parse(
      '{"domain":{},"types":{"T":[{"name":"__proto__","type":"uint8"}]},"message":{}}'
    );
    expect(
      typedDataApdus({ typedData: proto, expectedHash: '0x' + '00'.repeat(32), path: P }).reason
    ).toBe('name-ascii');
  });

  test("what ethers accepts and fc-evm doesn't: a bool that isn't a boolean, a type named like a primitive, an ICAP address", () => {
    for (const value of ['false', 0, 1, null]) {
      const typedData = {
        domain: {},
        types: { T: [{ name: 'v', type: 'bool' }] },
        message: { v: value },
      };
      expect(bind(typedData)).toStrictEqual({ rule: 'payload', reason: 'typed-data' });
    }
    const missing = { domain: {}, types: { T: [{ name: 'v', type: 'bool' }] }, message: {} };
    expect(bind(missing).reason).toBe('typed-data');
    const icap = getIcapAddress('0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826');
    const typedData = {
      domain: {},
      types: { T: [{ name: 'v', type: 'address' }] },
      message: { v: icap },
    };
    expect(bind(typedData)).toStrictEqual({ rule: 'payload', reason: 'typed-data' });
    for (const name of ['uint256', 'uint7', 'bytes33', 'bool', 'string', 'address', 'bytes']) {
      const types = { [name]: [{ name: 'v', type: 'uint8' }], T: [{ name: 'w', type: name }] };
      const result = typedDataApdus({
        typedData: { domain: {}, types, message: { w: 1 } },
        expectedHash: '0x' + '00'.repeat(32),
        path: P,
      });
      expect(result.reason).toBe('typed-data');
    }
  });

  test("a typed_data outside the core's form, or ethers' parse refused", () => {
    const cases = [
      null,
      'text',
      { types: MAIL.types, message: MAIL.message },
      { ...MAIL, domain: [] },
      { ...MAIL, message: null },
      { ...MAIL, types: [] },
      { ...MAIL, types: { ...MAIL.types, EIP712Domain: [] } },
      { ...MAIL, types: { Mail: MAIL.types.Mail } },
      { ...MAIL, types: { ...MAIL.types, Person: [{ name: 'name' }] } },
      { ...MAIL, types: { ...MAIL.types, Person: 'string name' } },
      { ...MAIL, domain: { ...MAIL.domain, colour: 'blue' } },
      { ...MAIL, message: { ...MAIL.message, contents: 5 } },
      // A diamond ethers would walk for ever: assertBoundedTypeGraph's.
      {
        domain: {},
        types: Object.fromEntries(
          Array.from({ length: 40 }, (_, i) => [
            `T${i}`,
            i === 39
              ? []
              : [
                  { name: 'a', type: `T${i + 1}` },
                  { name: 'b', type: `T${i + 1}` },
                ],
          ])
        ),
        message: {},
      },
    ];
    for (const typedData of cases) {
      const result = typedDataApdus({ typedData, expectedHash: '0x' + '00'.repeat(32), path: P });
      expect(result).toStrictEqual({ rule: 'payload', reason: 'typed-data' });
    }
  });

  test("an array suffix the device wouldn't rebuild (LEDGER_TYPE_NOT_CANONICAL)", () => {
    for (const type of ['uint8[02]', 'uint8[2][01]', 'uint8[00]']) {
      const typedData = {
        domain: {},
        types: { T: [{ name: 'v', type }] },
        message: { v: sampleValue(type.replace(/\[0+(\d)/g, '[$1')) },
      };
      expect(bind(typedData)).toStrictEqual({ rule: 'payload', reason: 'not-canonical' });
    }
    const zero = {
      domain: {},
      types: { T: [{ name: 'v', type: 'uint8[0]' }] },
      message: { v: [] },
    };
    expect(bind(zero).apdus).toContain('e01c000f0100');
  });

  test('what a Ledger cannot carry (deviation device-bounds), the bound and its size', () => {
    const one = (type, value, name = 'v') =>
      bind({ domain: {}, types: { T: [{ name, type }] }, message: { [name]: value } });
    const bound = (result) => {
      expect(result.rule).toBe('payload');
      expect(result.reason).toBe('device-bounds');
      return result.bound;
    };
    // Three definitions, two roots, the length, the entries, E0 0C.
    expect(one('uint8[]', Array(255).fill(0)).apdus).toHaveLength(3 + 2 + 1 + 255 + 1);
    expect(bound(one('uint8[]', Array(256).fill(0)))).toStrictEqual({
      name: 'array_entries',
      size: 256,
    });
    expect(bound(one('uint8[256]', Array(256).fill(0)))).toStrictEqual({
      name: 'fixed_size',
      size: 256,
    });
    // A string field's name of 253 characters makes a 255-byte definition; 254, 256.
    expect(one('string', '', 'a'.repeat(253)).apdus[2].slice(8, 10)).toBe('ff');
    expect(bound(one('string', '', 'a'.repeat(254)))).toStrictEqual({
      name: 'definition',
      size: 256,
    });
    expect(bound(one('string', '', 'a'.repeat(256)))).toStrictEqual({
      name: 'name_bytes',
      size: 256,
    });
    const longType = { domain: {}, types: { ['T'.repeat(256)]: [] }, message: {} };
    expect(bound(bind(longType))).toStrictEqual({ name: 'name_bytes', size: 256 });
    expect(one('bytes', '0x' + '00'.repeat(65535)).rule).toBeUndefined();
    expect(bound(one('bytes', '0x' + '00'.repeat(65536)))).toStrictEqual({
      name: 'value_encoding_bytes',
      size: 65536,
    });
    const dims = 'uint8' + '[]'.repeat(256);
    expect(bound(one(dims, []))).toStrictEqual({ name: 'dimensions', size: 256 });
  });

  test('more than 2,048 APDUs in the operation, the address check, B0 01 and E0 0C counted', () => {
    // EIP712Domain and T (2), T's 8 fields (8), the two roots (2), each
    // field's length (8): 20, then the entries, one APDU each.
    const atBound = (entries) => {
      const types = {
        T: Array.from({ length: 8 }, (_, i) => ({ name: `f${i}`, type: 'uint8[]' })),
      };
      const message = {};
      let left = entries;
      for (let i = 0; i < 8; i += 1) {
        const n = Math.min(255, left);
        message[`f${i}`] = Array(n).fill(0);
        left -= n;
      }
      return bind({ domain: {}, types, message });
    };
    const fits = atBound(BOUNDS.apdus_per_operation - 3 - 20);
    expect(fits.apdus).toHaveLength(BOUNDS.apdus_per_operation - 2);
    const over = atBound(BOUNDS.apdus_per_operation - 3 - 20 + 1);
    expect(over).toStrictEqual({
      rule: 'payload',
      reason: 'device-bounds',
      bound: { name: 'apdus_per_operation', size: BOUNDS.apdus_per_operation + 1 },
    });
    // A value's pieces count before any is made.
    const pieces = bind({
      domain: {},
      types: { T: [{ name: 'v', type: 'bytes[]' }] },
      message: { v: Array(8).fill('0x' + '00'.repeat(65535)) },
    });
    expect(pieces.bound.name).toBe('apdus_per_operation');
  });
});

describe("the binding's shape, as the Admission takes it", () => {
  test('framed Buffers, a type name first, the definitions then the values; two 32-byte hashes', () => {
    const binding = bindTypedData({ typedData: MAIL, expectedHash: hashOf(MAIL) });
    expect(Object.keys(binding).sort()).toStrictEqual(['apdus', 'domainSeparator', 'structHash']);
    expect(binding.apdus.map((a) => a.toString('hex'))).toStrictEqual(MAIL_STREAM.slice(0, -1));
    for (const apdu of binding.apdus) {
      expect(Buffer.isBuffer(apdu)).toBe(true);
      expect(apdu[4]).toBe(apdu.length - 5);
    }
    expect(binding.apdus[0].subarray(0, 4).toString('hex')).toBe(HEADER.TYPE_NAME);
    const kinds = binding.apdus.map((a) => a.subarray(0, 2).toString('hex'));
    expect(kinds.lastIndexOf('e01a')).toBeLessThan(kinds.indexOf('e01c'));
    expect(kinds.every((k) => k === 'e01a' || k === 'e01c')).toBe(true);
    expect(binding.domainSeparator).toStrictEqual(
      Buffer.from(TypedDataEncoder.hashDomain(MAIL.domain).slice(2), 'hex')
    );
    expect(binding.structHash).toHaveLength(32);
  });

  test('each call gives its own Buffers', () => {
    const one = bindTypedData({ typedData: MAIL, expectedHash: hashOf(MAIL) });
    one.apdus[0].fill(0);
    one.domainSeparator.fill(0);
    const two = bindTypedData({ typedData: MAIL, expectedHash: hashOf(MAIL) });
    expect(two.apdus[0].toString('hex')).toBe(MAIL_STREAM[0]);
    expect(two.domainSeparator).toStrictEqual(
      Buffer.from(TypedDataEncoder.hashDomain(MAIL.domain).slice(2), 'hex')
    );
  });

  test('no arguments, or no typed data, is a refusal, never a throw', () => {
    expect(bindTypedData()).toStrictEqual({ rule: 'payload', reason: 'hash-mismatch' });
    expect(bindTypedData({ expectedHash: hashOf(MAIL) })).toStrictEqual({
      rule: 'payload',
      reason: 'typed-data',
    });
  });
});
