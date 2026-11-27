/**
 * The typed data the pinned core accepts before fc-ledger
 * (typed-data-subset.js), through main's typed-data binding: for each rule
 * of the module's table, typed data fc-evm refuses is refused `payload`
 * with that rule's `check`, before any APDU, even under ethers' own hash of
 * it; and the edge fc-evm accepts still binds (or reaches a Ledger bound,
 * where fc-evm's edge is past the device's). Then the core's order where it
 * decides the reason. apdu-binding.vectors.test.js runs fc-evm's own
 * typed-data vectors (vectors/signing.json) through the binding too.
 */

const { TypedDataEncoder, getIcapAddress } = require('ethers');
const { bindTypedData } = require('./apdu-binding');
const { LIMITS, MAX_VIEW_LEN, checkTypedDataSubset } = require('./typed-data-subset');

const ZERO_HASH = '0x' + '00'.repeat(32);
const ADDRESS = '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826';

function typed(types, message, domain = {}) {
  return { domain, types, message };
}

/** A primary type `T { <type> v }` holding `value`. */
function one(type, value) {
  return typed({ T: [{ name: 'v', type }] }, { v: value });
}

/** ethers' own hash where it has one: a refusal below is never a hash mismatch. */
function hashOf(typedData) {
  try {
    return TypedDataEncoder.hash(typedData.domain, typedData.types, typedData.message);
  } catch {
    return ZERO_HASH;
  }
}

function bind(typedData) {
  return bindTypedData({ typedData, expectedHash: hashOf(typedData) });
}

const nested = (depth, leaf) => (depth === 0 ? leaf : [nested(depth - 1, leaf)]);

/** `count` types in a chain, each but the last holding an empty array of the next. */
function typeChain(count) {
  const types = {};
  for (let i = 0; i < count; i += 1) {
    types[`T${i}`] = i + 1 < count ? [{ name: 'n', type: `T${i + 1}[]` }] : [];
  }
  return typed(types, count > 1 ? { n: [] } : {});
}

/** A primary type of `count` uint8 fields, each 0. */
function fields(count) {
  const list = Array.from({ length: count }, (_, i) => ({ name: `f${i}`, type: 'uint8' }));
  return typed({ T: list }, Object.fromEntries(list.map((f) => [f.name, 0])));
}

/** 1,024 fields in four types of 256 under M's 256, and a fifth type of `extra`. */
function totalFields(extra) {
  const list = (n, prefix) =>
    Array.from({ length: n }, (_, i) => ({ name: `${prefix}${i}`, type: 'uint8' }));
  const refs = ['A', 'B', 'C', 'D'].map((t) => ({ name: t.toLowerCase(), type: `${t}[]` }));
  const types = {
    M: [...list(252, 'm'), ...refs],
    A: list(256, 'a'),
    B: list(256, 'b'),
    C: list(256, 'c'),
    D: list(extra, 'd'),
  };
  const message = Object.fromEntries([
    ...list(252, 'm').map((f) => [f.name, 0]),
    ...refs.map((f) => [f.name, []]),
  ]);
  return typed(types, message);
}

/** `depth` structs in a chain, the last a uint8 field: its value at depth `depth` (fc-evm's count). */
function structChain(depth) {
  const types = {};
  for (let i = 0; i < depth; i += 1) {
    types[`S${i}`] =
      i + 1 < depth ? [{ name: 'n', type: `S${i + 1}` }] : [{ name: 'v', type: 'uint8' }];
  }
  let message = { v: 1 };
  for (let i = depth - 2; i >= 0; i -= 1) message = { n: message };
  return typed(types, message);
}

/** encodeType text across the type hashes, counted as fc-evm counts it (each type reachable). */
function typeText(types) {
  const own = (name) =>
    `${name}(${types[name].map((f) => `${f.type} ${f.name}`).join(',')})`.length;
  const below = (name, seen = new Set()) => {
    for (const field of types[name]) {
      const base = field.type.split('[')[0];
      if (types[base] && !seen.has(base)) {
        seen.add(base);
        below(base, seen);
      }
    }
    return seen;
  };
  return Object.keys(types).reduce(
    (sum, name) => sum + own(name) + [...below(name)].reduce((s, n) => s + own(n), 0),
    0
  );
}

/**
 * 57 types in a chain, three 200-character fields each, and T0 (whose text
 * only its own hash holds) padded with fields until the text is `total`.
 */
function typeTextOf(total) {
  const types = {};
  for (let i = 0; i < 57; i += 1) {
    const list = [0, 1, 2].map((j) => ({ name: `f${j}`.padEnd(200, 'x'), type: 'uint8' }));
    if (i + 1 < 57) list.push({ name: 'n', type: `T${i + 1}[]` });
    types[`T${i}`] = list;
  }
  const left = total - typeText(types);
  // Each field ",uint8 <name>" adds 7 and its name: names of 4 to 200.
  const count = Math.ceil(left / 207);
  for (let k = 0; k < count; k += 1) {
    const adds = Math.floor(left / count) + (k < left % count ? 1 : 0);
    types.T0.push({ name: `p${String(k).padStart(3, '0')}`.padEnd(adds - 7, 'x'), type: 'uint8' });
  }
  if (typeText(types) !== total) throw new Error(`type text ${typeText(types)}, not ${total}`);
  const message = Object.fromEntries(types.T0.map((f) => [f.name, f.name === 'n' ? [] : 0]));
  return typed(types, message);
}

/**
 * `total` values (fields and array entries, fc-evm's count): M's two fields,
 * each 255 arrays of empty structs, filled in order.
 */
function values(total) {
  let structs = total - 2 - 2 * 255;
  const field = () =>
    Array.from({ length: 255 }, () => {
      const n = Math.min(255, structs);
      structs -= n;
      return Array.from({ length: n }, () => ({}));
    });
  return typed(
    {
      M: [
        { name: 'a', type: 'E[][]' },
        { name: 'b', type: 'E[][]' },
      ],
      E: [],
    },
    { a: field(), b: field() }
  );
}

/**
 * Typed data whose view, as the core writes it with the longest reports, is
 * `length` bytes: T's string `s` (quotes, a backslash, control characters,
 * é and an emoji, escaped as serde_json escapes them), and one key T doesn't
 * declare, padded. The view's text is JSON.stringify's, which escapes as
 * serde_json does.
 */
function viewOf(length, domain = {}) {
  const s = `q"\\${String.fromCharCode(1)}${String.fromCharCode(10)}é😀`;
  const present = Object.keys(domain);
  const view = (key) =>
    JSON.stringify({
      types: {
        T: [{ name: 's', type: 'string' }],
        EIP712Domain: present.map((name) => ({
          name,
          type: { name: 'string', chainId: 'uint256' }[name],
        })),
      },
      domain: Object.fromEntries(
        present.map((name) => [
          name,
          name === 'chainId' ? '0x' + domain[name].toString(16) : domain[name],
        ])
      ),
      primary_type: 'T',
      message: { s },
      ignored: [key],
      named_type: 'mismatch',
      chain: present.includes('chainId') ? 'mismatch' : 'absent',
    });
  const key = 'k'.repeat(length - Buffer.byteLength(view(''), 'utf8'));
  return typed({ T: [{ name: 's', type: 'string' }] }, { s, [key]: 0 }, domain);
}

const LONE_HIGH = String.fromCharCode(0xd83d);
const LONE_LOW = String.fromCharCode(0xdc00);

/**
 * Each rule: what fc-evm (or the params' JSON, or the request's shape)
 * refuses, as [label, typed data]; and the edge it accepts, as [label,
 * typed data, the Ledger bound it reaches instead of binding].
 */
const RULES = [
  {
    check: 'json-value',
    refused: [
      ['a BigInt (ethers takes it)', one('uint256', 1n)],
      ['undefined, which JSON drops', typed({ T: [] }, { extra: undefined })],
      ['a function', typed({ T: [] }, { extra: () => 0 })],
      ['NaN', typed({ T: [] }, { extra: NaN })],
      ['Infinity', one('uint256', Infinity)],
      ['a Uint8Array (ethers takes it)', one('bytes', new Uint8Array([1]))],
      ['a hole', one('uint8[]', [, 1])], // eslint-disable-line no-sparse-arrays
      ['a Date', typed({ T: [] }, { extra: new Date(0) })],
    ],
    accepted: [
      ['their JSON forms', one('uint256', '1')],
      [
        'null, true, numbers and objects in keys T leaves unread',
        typed({ T: [] }, { a: null, b: true, c: 1.5, d: { e: [] } }),
      ],
      [
        'an object without a prototype',
        typed({ T: [] }, Object.assign(Object.create(null), { a: 1 })),
      ],
    ],
  },
  {
    check: 'json-surrogate',
    refused: [
      ['a lone low surrogate (ethers hashes it)', one('string', `a${LONE_LOW}`)],
      ['a lone high surrogate', one('string', `${LONE_HIGH}a`)],
      ['in a key T leaves unread', typed({ T: [] }, { [`k${LONE_LOW}`]: 1 })],
      ['in the domain', typed({ T: [] }, {}, { name: LONE_LOW })],
    ],
    accepted: [['a surrogate pair', one('string', `${LONE_HIGH}${LONE_LOW}`)]],
  },
  {
    check: 'json-depth',
    refused: [
      ['125 arrays deep in a key T leaves unread', typed({ T: [] }, { junk: nested(125, 0) })],
    ],
    accepted: [['124 arrays deep', typed({ T: [] }, { junk: nested(124, 0) })]],
  },
  {
    check: 'typed-data-object',
    refused: [
      ['null', null],
      ['a string', JSON.stringify(one('uint8', 1))],
      ['an array', [one('uint8', 1)]],
    ],
    accepted: [
      ['domain, types and message', one('uint8', 1)],
      ["a primaryType beside them (x402's), unread", { ...one('uint8', 1), primaryType: 'U' }],
    ],
  },
  {
    check: 'types-object',
    refused: [['types an array', typed([], {})]],
    accepted: [['no field', typed({ T: [] }, {})]],
  },
  {
    check: 'types-count',
    refused: [['257 types', typeChain(257)]],
    accepted: [['256 types', typeChain(256)]],
  },
  {
    check: 'domain-type-name',
    refused: [
      [
        'a type named EIP712Domain',
        typed({ T: [{ name: 'd', type: 'EIP712Domain' }], EIP712Domain: [] }, { d: {} }),
      ],
    ],
    accepted: [
      [
        'EIP712domain',
        typed({ T: [{ name: 'd', type: 'EIP712domain' }], EIP712domain: [] }, { d: {} }),
      ],
    ],
  },
  {
    check: 'proto-name',
    refused: [
      [
        'a type',
        JSON.parse(
          '{"domain":{},"types":{"__proto__":[{"name":"v","type":"uint8"}]},"message":{"v":1}}'
        ),
      ],
      [
        'a field',
        JSON.parse(
          '{"domain":{},"types":{"T":[{"name":"__proto__","type":"uint8"}]},"message":{"__proto__":1}}'
        ),
      ],
    ],
    accepted: [
      [
        '__proto and proto__',
        typed({ __proto: [{ name: 'p', type: 'proto__' }], proto__: [] }, { p: {} }),
      ],
      [
        '__proto__ as a key T leaves unread',
        JSON.parse('{"domain":{},"types":{"T":[]},"message":{"__proto__":1}}'),
      ],
    ],
  },
  {
    check: 'identifier',
    refused: [
      ['a type Té', typed({ Té: [] }, {})],
      ['a type 1T', typed({ '1T': [] }, {})],
      ['a type of 257 characters', typed({ ['T'.repeat(257)]: [] }, {})],
      ['a field a b', typed({ T: [{ name: 'a b', type: 'uint8' }] }, { 'a b': 1 })],
      ['an empty field name', typed({ T: [{ name: '', type: 'uint8' }] }, { '': 1 })],
      [
        'a field of 257 characters',
        typed({ T: [{ name: 'f'.repeat(257), type: 'string' }] }, { ['f'.repeat(257)]: '' }),
      ],
    ],
    accepted: [
      ['$_ and _9', typed({ $_: [{ name: '_9', type: 'uint8' }] }, { _9: 1 })],
      ['a type of 255 characters', typed({ ['T'.repeat(255)]: [] }, {})],
      ['a type of 256, past the device', typed({ ['T'.repeat(256)]: [] }, {}), 'name_bytes'],
      [
        'a field of 256, past the device',
        typed({ T: [{ name: 'f'.repeat(256), type: 'string' }] }, { ['f'.repeat(256)]: '' }),
        'name_bytes',
      ],
    ],
  },
  {
    check: 'primitive-name',
    refused: [
      'bool',
      'string',
      'address',
      'bytes',
      'uint256',
      'int8',
      'bytes32',
      'uint7',
      'uint08',
      'bytes33',
      'int0',
    ].map((name) => [
      name,
      typed(
        { [name]: [{ name: 'v', type: 'uint8' }], T: [{ name: 'w', type: name }] },
        { w: { v: 1 } }
      ),
    ]),
    accepted: [
      [
        'uint and int, which shadow the aliases',
        typed(
          {
            T: [
              { name: 'u', type: 'uint' },
              { name: 'i', type: 'int[]' },
            ],
            uint: [],
            int: [],
          },
          { u: {}, i: [] }
        ),
      ],
      [
        'Bool and uint256x',
        typed({ Bool: [{ name: 'x', type: 'uint256x' }], uint256x: [] }, { x: {} }),
      ],
    ],
  },
  {
    check: 'field-list',
    refused: [['a string', typed({ T: 'uint8 v' }, {})]],
    accepted: [['an empty list', typed({ T: [] }, {})]],
  },
  {
    check: 'field-count',
    refused: [
      ['257 fields in a type', fields(257)],
      ['1,025 in all', totalFields(1)],
    ],
    accepted: [
      ['256 fields in a type', fields(256)],
      ['1,024 in all', totalFields(0)],
    ],
  },
  {
    check: 'field-shape',
    refused: [
      ['no type', typed({ T: [{ name: 'v' }] }, {})],
      ['a number for a name', typed({ T: [{ name: 1, type: 'uint8' }] }, {})],
      ['a field that is a string', typed({ T: ['uint8 v'] }, {})],
    ],
    accepted: [
      [
        'strings, other keys unread',
        typed({ T: [{ name: 'v', type: 'uint8', extra: 1 }] }, { v: 1 }),
      ],
    ],
  },
  {
    check: 'duplicate-field',
    refused: [
      [
        'two fields v',
        typed(
          {
            T: [
              { name: 'v', type: 'uint8' },
              { name: 'v', type: 'bool' },
            ],
          },
          { v: 1 }
        ),
      ],
    ],
    accepted: [
      [
        'v and V',
        typed(
          {
            T: [
              { name: 'v', type: 'uint8' },
              { name: 'V', type: 'bool' },
            ],
          },
          { v: 1, V: true }
        ),
      ],
    ],
  },
  {
    check: 'dimensions',
    refused: [['33 dimensions', one('uint8' + '[]'.repeat(33), [])]],
    accepted: [['32 dimensions', one('uint8' + '[]'.repeat(32), [])]],
  },
  {
    check: 'circular',
    refused: [
      ['a field of its own type', typed({ T: [{ name: 'n', type: 'T[]' }] }, { n: [] })],
      [
        'a cycle the primary type reaches',
        typed(
          {
            M: [{ name: 'a', type: 'A[]' }],
            A: [{ name: 'b', type: 'B[]' }],
            B: [{ name: 'a', type: 'A[]' }],
          },
          { a: [] }
        ),
      ],
    ],
    accepted: [
      [
        'a cycle it doesn’t reach, as ethers',
        typed(
          {
            M: [{ name: 'v', type: 'uint8' }],
            A: [{ name: 'b', type: 'B[]' }],
            B: [{ name: 'a', type: 'A[]' }],
          },
          { v: 1 }
        ),
      ],
    ],
  },
  {
    check: 'width',
    refused: [
      'uint7',
      'uint0',
      'uint264',
      'uint08',
      'int9',
      'bytes0',
      'bytes33',
      'bytes01',
      'uint1' + '0'.repeat(20),
    ].map((type) => [type, one(type, 0)]),
    accepted: [
      ['uint8', one('uint8', 255)],
      ['int256', one('int256', -1)],
      ['bytes1', one('bytes1', '0x01')],
      ['bytes32', one('bytes32', '0x' + '01'.repeat(32))],
    ],
  },
  {
    check: 'unknown-type',
    refused: [
      ['a type not declared', one('Missing', {})],
      ['EIP712Domain', one('EIP712Domain', {})],
      ['a suffix split_array doesn’t read', one('uint8[a]', [])],
      ['a space', one('uint8 ', 0)],
    ],
    accepted: [['a declared one', typed({ T: [{ name: 's', type: 'S' }], S: [] }, { s: {} })]],
  },
  {
    check: 'primary-type',
    refused: [
      ['two roots', typed({ T: [], U: [] }, {})],
      ['none', typed({ A: [{ name: 'b', type: 'B[]' }], B: [{ name: 'a', type: 'A[]' }] }, {})],
      ['no type', typed({}, {})],
    ],
    accepted: [['one', typed({ T: [] }, {})]],
  },
  {
    check: 'type-text',
    refused: [['1 MiB and a byte', typeTextOf(LIMITS.typeText + 1)]],
    accepted: [['1 MiB', typeTextOf(LIMITS.typeText)]],
  },
  {
    check: 'domain-object',
    refused: [
      ['an array', typed({ T: [] }, {}, [])],
      ['null', typed({ T: [] }, {}, null)],
      ['absent', { types: { T: [] }, message: {} }],
    ],
    accepted: [['empty', typed({ T: [] }, {}, {})]],
  },
  {
    check: 'domain-key',
    refused: [['colour', typed({ T: [] }, {}, { colour: 'blue' })]],
    accepted: [['colour null, skipped', typed({ T: [] }, {}, { colour: null, name: 'N' })]],
  },
  {
    check: 'depth',
    refused: [
      ['33 structs (the review’s)', structChain(33)],
      ['34 structs (the review’s)', structChain(34)],
      ['32 dimensions with an entry', one('uint8' + '[]'.repeat(32), nested(32, 1))],
    ],
    accepted: [
      ['32 structs', structChain(32)],
      ['31 dimensions with an entry', one('uint8' + '[]'.repeat(31), nested(31, 1))],
    ],
  },
  {
    check: 'struct-object',
    refused: [
      [
        'a string for a struct without fields (ethers takes it)',
        typed({ T: [{ name: 's', type: 'S' }], S: [] }, { s: 'x' }),
      ],
      ['an array', typed({ T: [{ name: 's', type: 'S' }], S: [] }, { s: [] })],
      ['a message that is an array', typed({ T: [] }, [])],
    ],
    accepted: [['an object', typed({ T: [{ name: 's', type: 'S' }], S: [] }, { s: {} })]],
  },
  {
    check: 'missing',
    refused: [
      [
        'null for a struct without fields (ethers takes it)',
        typed({ T: [{ name: 's', type: 'S' }], S: [] }, { s: null }),
      ],
      ['absent', typed({ T: [{ name: 's', type: 'S' }], S: [] }, {})],
      ['a bool absent (ethers signs false)', one('bool', null)],
      ['toString, from no prototype', typed({ T: [{ name: 'toString', type: 'string' }] }, {})],
    ],
    accepted: [
      ['toString present', typed({ T: [{ name: 'toString', type: 'string' }] }, { toString: 'x' })],
    ],
  },
  {
    check: 'values',
    refused: [['100,001', values(LIMITS.values + 1)]],
    accepted: [['100,000', values(LIMITS.values)]],
  },
  {
    check: 'array',
    refused: [
      ['a string', one('uint8[]', 'x')],
      ['an object', one('uint8[]', { 0: 1, length: 1 })],
    ],
    accepted: [['an array', one('uint8[]', [1])]],
  },
  {
    check: 'array-length',
    refused: [
      ['3 for 2', one('uint8[2]', [1, 2, 3])],
      ['an inner 1 for 2', one('uint8[2][]', [[1]])],
    ],
    accepted: [['2 for 2', one('uint8[2][]', [[1, 2]])]],
  },
  {
    check: 'quantity',
    refused: [
      '+1',
      ' 1',
      '1 ',
      '\t1',
      '1\n',
      '0b1',
      '0o7',
      '-',
      '--1',
      '-+1',
      '1e3',
      '0x',
      '-0x',
      '1_0',
      '',
      '0x1g',
      '0x' + 'f'.repeat(65),
      (2n ** 256n).toString(),
    ].map((v) => [JSON.stringify(v), one('uint256', v)]),
    accepted: [
      ['0', one('uint256', '0')],
      ['-0', one('uint256', '-0')],
      ['00012', one('uint256', '00012')],
      ['0X1F', one('uint256', '0X1F')],
      ['-0x10', one('int256', '-0x10')],
      ['leading zeros past 64 digits', one('uint256', '0x' + '0'.repeat(100) + '1')],
      ['2^256 - 1', one('uint256', (2n ** 256n - 1n).toString())],
    ],
  },
  {
    check: 'safe-integer',
    refused: [1.5, 2 ** 53, -(2 ** 53), 1e21].map((v) => [String(v), one('int256', v)]),
    accepted: [
      ['2^53 - 1', one('uint256', 2 ** 53 - 1)],
      ['-(2^53 - 1)', one('int256', -(2 ** 53 - 1))],
      ['-0', one('uint8', -0)],
      ['1e2', one('uint8', 1e2)],
    ],
  },
  {
    check: 'number',
    refused: [
      ['true', one('uint8', true)],
      ['an object', one('uint8', {})],
      ['an array', one('uint8', [1])],
    ],
    accepted: [['a number', one('uint8', 1)]],
  },
  {
    check: 'uint-range',
    refused: [
      ['256 for uint8', one('uint8', 256)],
      ['-1', one('uint8', -1)],
      ['"-0x1"', one('uint256', '-0x1')],
    ],
    accepted: [
      ['255', one('uint8', '0xff')],
      ['"-0"', one('uint8', '-0')],
    ],
  },
  {
    check: 'int-range',
    refused: [
      ['128 for int8', one('int8', 128)],
      ['-129', one('int8', '-129')],
      ['-2^255 - 1', one('int256', (-(2n ** 255n) - 1n).toString())],
    ],
    accepted: [
      ['127', one('int8', 127)],
      ['-128', one('int8', -128)],
      ['-2^255', one('int256', (-(2n ** 255n)).toString())],
    ],
  },
  {
    check: 'bytes',
    refused: ['abcd', '0xabc', '0xzz', '0x 1', '0x+1', 5].map((v) => [
      JSON.stringify(v),
      one('bytes', v),
    ]),
    accepted: [
      ['0x', one('bytes', '0x')],
      ['0XAbCd', one('bytes', '0XAbCd')],
    ],
  },
  {
    check: 'bytes-length',
    refused: [['3 bytes for bytes4', one('bytes4', '0x010203')]],
    accepted: [['4', one('bytes4', '0x01020304')]],
  },
  {
    check: 'string',
    refused: [['a number', one('string', 5)]],
    accepted: [['empty', one('string', '')]],
  },
  {
    check: 'address',
    refused: [
      ['ICAP (ethers takes it)', one('address', getIcapAddress(ADDRESS))],
      ['no prefix (ethers takes it)', one('address', ADDRESS.slice(2).toLowerCase())],
      ['0X', one('address', '0X' + ADDRESS.slice(2).toLowerCase())],
      ['a wrong checksum', one('address', ADDRESS.slice(0, -1) + '7')],
      ['39 digits', one('address', ADDRESS.slice(0, -1))],
    ],
    accepted: [
      ['lower case', one('address', ADDRESS.toLowerCase())],
      ['upper case', one('address', '0x' + ADDRESS.slice(2).toUpperCase())],
      ['EIP-55', one('address', ADDRESS)],
    ],
  },
  {
    check: 'bool',
    refused: ['false', 0, 1].map((v) => [JSON.stringify(v), one('bool', v)]),
    accepted: [['false', one('bool', false)]],
  },
  {
    check: 'view-size',
    refused: [
      ['a byte past the longest view', viewOf(MAX_VIEW_LEN + 1)],
      [
        'with a chainId, counted as a mismatch',
        viewOf(MAX_VIEW_LEN + 1, { name: 'N', chainId: 31 }),
      ],
    ],
    accepted: [
      ['the longest view', viewOf(MAX_VIEW_LEN)],
      ['with a chainId', viewOf(MAX_VIEW_LEN, { name: 'N', chainId: 31 })],
    ],
  },
];

/** The domain's fields, each a scalar of its type, before the message. */
const DOMAIN_SCALARS = [
  ['chainId "+1"', { chainId: '+1' }, 'quantity'],
  ['chainId -1', { chainId: -1 }, 'uint-range'],
  ['chainId 1.5', { chainId: 1.5 }, 'safe-integer'],
  [
    'an ICAP verifyingContract (ethers takes it)',
    { verifyingContract: getIcapAddress(ADDRESS) },
    'address',
  ],
  [
    'a verifyingContract without 0x (ethers takes it)',
    { verifyingContract: ADDRESS.slice(2) },
    'address',
  ],
  ['a salt of 31 bytes', { salt: '0x' + '11'.repeat(31) }, 'bytes-length'],
  ['a salt that isn’t hex', { salt: 7 }, 'bytes'],
  ['a name that isn’t a string', { name: 5 }, 'string'],
  ['a version that isn’t a string', { version: true }, 'string'],
];

const reasonOf = (check) =>
  check === 'identifier' || check === 'proto-name' ? 'name-ascii' : 'typed-data';

describe.each(RULES)('rule $check', ({ check, refused, accepted }) => {
  test('what fc-evm refuses is refused payload for it, before any APDU', () => {
    for (const [label, typedData] of refused) {
      expect([label, bind(typedData)]).toStrictEqual([
        label,
        { rule: 'payload', reason: reasonOf(check), check },
      ]);
    }
  }, 60000);

  test('the edge fc-evm accepts binds', () => {
    for (const [label, typedData, deviceBound] of accepted) {
      expect([label, checkTypedDataSubset(typedData)]).toStrictEqual([label, null]);
      const result = bind(typedData);
      if (deviceBound) {
        expect([label, result.reason, result.bound?.name]).toStrictEqual([
          label,
          'device-bounds',
          deviceBound,
        ]);
      } else {
        expect([label, result.rule, result.apdus.length > 0]).toStrictEqual([
          label,
          undefined,
          true,
        ]);
      }
    }
  }, 60000);
});

describe("the domain's scalars", () => {
  test.each(DOMAIN_SCALARS)('%s: refused', (_, domain, check) => {
    expect(bind(typed({ T: [] }, {}, domain))).toStrictEqual({
      rule: 'payload',
      reason: 'typed-data',
      check,
    });
  });

  test('each of its forms fc-evm takes binds', () => {
    const domain = {
      name: 'N',
      version: '1',
      chainId: '0x' + 'f'.repeat(64),
      verifyingContract: ADDRESS,
      salt: '0X' + 'AB'.repeat(32),
    };
    for (const chainId of [domain.chainId, 1, '1', 0]) {
      expect(bind(typed({ T: [] }, {}, { ...domain, chainId })).rule).toBeUndefined();
    }
  });
});

describe("the core's order, where it decides the reason", () => {
  test('the type count before any name', () => {
    const types = typeChain(257).types;
    expect(bind(typed({ é: [], ...types }, {})).check).toBe('types-count');
  });

  test('every type name before any field; in the order the types are written', () => {
    expect(bind(typed({ T: 'x', 'U V': [] }, {})).check).toBe('identifier');
    expect(bind(typed({ é: [], EIP712Domain: [] }, {})).reason).toBe('name-ascii');
    expect(bind(typed({ EIP712Domain: [], é: [] }, {})).check).toBe('domain-type-name');
  });

  test("a type's field count and each field's shape before its name", () => {
    const many = fields(257).types.T;
    many[0] = { name: 'é', type: 'uint8' };
    expect(bind(typed({ T: many }, {})).check).toBe('field-count');
    expect(bind(typed({ T: [{ name: 'é' }] }, {})).check).toBe('field-shape');
  });

  test('the JSON before the types, the types before the domain, the domain before the message', () => {
    expect(bind(typed({ é: [] }, { v: 1n })).check).toBe('json-value');
    expect(bind({ message: {}, domain: [] }).check).toBe('types-object');
    expect(bind(typed({ é: [] }, {}, { colour: 1 })).check).toBe('identifier');
    expect(
      bind(typed({ T: [{ name: 'v', type: 'uint8' }] }, { v: '+1' }, { colour: 1 })).check
    ).toBe('domain-key');
  });

  test('fc-evm before the hash: under another hash, the check still', () => {
    expect(
      bindTypedData({ typedData: one('uint256', '+1'), expectedHash: ZERO_HASH })
    ).toStrictEqual({
      rule: 'payload',
      reason: 'typed-data',
      check: 'quantity',
    });
  });
});

test("the longest view: one frame less the signing response at the largest ID (signing.rs's max_view_len)", () => {
  const reply = JSON.stringify({
    type: 'response',
    id: Number.MAX_SAFE_INTEGER,
    result: { signature: '0x' + '00'.repeat(65), view: 0 },
  });
  expect(MAX_VIEW_LEN).toBe(2 ** 20 - (reply.length - 1));
  expect(MAX_VIEW_LEN).toBe(1048369);
});

test('the input is not changed, and a refusal is never a throw', () => {
  const typedData = one('uint256', '+1');
  const copy = JSON.parse(JSON.stringify(typedData));
  bind(typedData);
  expect(typedData).toStrictEqual(copy);
  const cyclic = typed({ T: [] }, {});
  cyclic.message.self = cyclic.message;
  expect(bind(cyclic)).toStrictEqual({
    rule: 'payload',
    reason: 'typed-data',
    check: 'json-depth',
  });
});
