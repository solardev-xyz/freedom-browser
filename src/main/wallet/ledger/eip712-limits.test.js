/**
 * Each case goes through the real hw-app-eth to a fake device, which records
 * what arrives. The check must pass a payload exactly when that matches a
 * correct encoding of it, so a hw-app-eth release that fixes or changes a
 * flaw fails here rather than leaving the check out of date.
 */

const Transport = require('@ledgerhq/hw-transport').default;
const Eth = require('@ledgerhq/hw-app-eth').default;
// Value encodings aren't in question here, so the reference uses hw-app-eth's own.
const { EIP712_TYPE_ENCODERS } = require('@ledgerhq/hw-app-eth/lib/modules/EIP712/utils');

const { getBigInt } = require('ethers');

const { getEip712WirePayload } = require('../signing-utils');
const { LEDGER_ERROR_CODES } = require('./errors');
const { findLedgerTypedDataProblem, assertLedgerCanSendTypedData } = require('./eip712-limits');

// Like transport.js: no lookups in Ledger's hosted services.
const OFFLINE_LOAD_CONFIG = {
  nftExplorerBaseURL: null,
  pluginBaseURL: null,
  extraPlugins: null,
  cryptoassetsBaseURL: null,
  calServiceURL: null,
};
const PATH = "44'/60'/0'/0/0";

/** Records the EIP-712 messages it receives, joining a value's pieces. */
class FakeDevice extends Transport {
  constructor() {
    super();
    this.received = [];
    this.pendingValue = null;
  }

  async exchange(apdu) {
    const [cla, ins, p1, p2] = apdu;
    const data = apdu.subarray(5);
    const ok = Buffer.from([0x90, 0x00]);
    if (cla === 0xb0 && ins === 0x01) {
      return Buffer.concat([
        Buffer.from([1, 8]),
        Buffer.from('Ethereum'),
        Buffer.from([6]),
        Buffer.from('1.17.0'),
        ok,
      ]);
    }
    if (ins === 0x1a)
      this.received.push([p2 === 0x00 ? 'name' : 'definition', data.toString('hex')]);
    if (ins === 0x1c && p2 === 0x00) this.received.push(['root', data.toString('hex')]);
    if (ins === 0x1c && p2 === 0x0f) this.received.push(['array', data.toString('hex')]);
    if (ins === 0x1c && p2 === 0xff) {
      this.pendingValue = Buffer.concat([this.pendingValue || Buffer.alloc(0), data]);
      if (p1 === 0x00) {
        this.received.push(['value', this.pendingValue.toString('hex')]);
        this.pendingValue = null;
      }
    }
    if (ins === 0x1e) this.received.push(['filter', data.toString('hex')]);
    if (ins === 0x0c) return Buffer.concat([Buffer.alloc(65, 1), ok]);
    return ok;
  }
}

async function sendToFakeDevice(payload) {
  const device = new FakeDevice();
  const eth = new Eth(device, 'w0w', OFFLINE_LOAD_CONFIG);
  try {
    await eth.signEIP712Message(PATH, payload);
    return device.received;
  } catch {
    return null;
  }
}

class Unencodable extends Error {}

function oneByte(n) {
  if (n > 255) throw new Unencodable();
  return [n];
}
function withLength(bytes) {
  return [...oneByte(bytes.length), ...bytes];
}
function apduData(bytes) {
  if (bytes.length > 255) throw new Unencodable();
  return Buffer.from(bytes).toString('hex');
}

function splitArrays(type) {
  const sizes = [];
  let base = type;
  for (let m = /\[(\d*)\]$/.exec(base); m; m = /\[(\d*)\]$/.exec(base)) {
    // The protocol carries a size as a number, so "[01]", which ethers hashes as written, can't be sent.
    if (m[1] !== '' && String(Number(m[1])) !== m[1]) throw new Unencodable();
    sizes.unshift(m[1] === '' ? null : Number(m[1]));
    base = base.slice(0, m.index);
  }
  return { base, sizes };
}

/** How the Ethereum app's EIP-712 protocol describes a base type, or a struct. */
function describe712(types, base) {
  if (Object.hasOwn(types, base)) return { key: 0 };
  const int = /^(u?int)(\d+)$/.exec(base);
  if (int)
    return {
      key: int[1] === 'int' ? 1 : 2,
      typeSize: Number(int[2]) / 8,
      encoder: int[1],
      bits: Number(int[2]),
    };
  const fixed = /^bytes(\d+)$/.exec(base);
  if (fixed)
    return { key: 6, typeSize: Number(fixed[1]), encoder: 'bytes', bits: Number(fixed[1]) };
  return { key: { address: 3, bool: 4, string: 5, bytes: 7 }[base], encoder: base };
}

/**
 * What a correct sender would send for this payload, or null if it can't be
 * sent at all. Values come from the site's own typed data, not ethers' payload.
 */
function correctEncoding(payload) {
  const { types, primaryType } = payload;
  const { domain, message: msg } = originals.get(payload);
  try {
    const sent = [];
    for (const typeName of Object.keys(types).sort()) {
      sent.push(['name', apduData([...Buffer.from(typeName)])]);
      for (const { name, type } of types[typeName]) {
        const { base, sizes } = splitArrays(type);
        const d = describe712(types, base);
        const bytes = [(sizes.length ? 0x80 : 0) | (d.typeSize !== undefined ? 0x40 : 0) | d.key];
        if (d.key === 0) bytes.push(...withLength([...Buffer.from(base)]));
        if (d.typeSize !== undefined) bytes.push(d.typeSize);
        if (sizes.length) {
          bytes.push(...oneByte(sizes.length));
          for (const size of sizes) bytes.push(...(size === null ? [0] : [1, ...oneByte(size)]));
        }
        bytes.push(...withLength([...Buffer.from(name)]));
        sent.push(['definition', apduData(bytes)]);
      }
    }
    const walk = (type, v) => {
      const array = /\[(\d*)\]$/.exec(type);
      if (array) {
        sent.push(['array', Buffer.from(oneByte(v.length)).toString('hex')]);
        for (const entry of v) walk(type.slice(0, array.index), entry);
      } else if (Object.hasOwn(types, type)) {
        for (const field of types[type]) walk(field.type, v[field.name]);
      } else {
        const d = describe712(types, type);
        // An integer means its number, however the site wrote it ("0x0001" is 1).
        const canonical = d.encoder.endsWith('int') ? getBigInt(v).toString() : v;
        const encoded = EIP712_TYPE_ENCODERS[d.encoder.toUpperCase()](canonical, d.bits);
        if (encoded.length > 0xffff) throw new Unencodable();
        sent.push([
          'value',
          Buffer.concat([
            Buffer.from([encoded.length >> 8, encoded.length & 0xff]),
            encoded,
          ]).toString('hex'),
        ]);
      }
    };
    sent.push(['root', apduData([...Buffer.from('EIP712Domain')])]);
    walk('EIP712Domain', domain);
    sent.push(['root', apduData([...Buffer.from(primaryType)])]);
    walk(primaryType, msg);
    return sent;
  } catch (err) {
    if (err instanceof Unencodable) return null;
    throw err;
  }
}

/** The device keeps definitions by struct name, so the order of the structs' blocks doesn't matter. */
function sortDefinitionBlocks(sent) {
  const rootAt = sent.findIndex(([kind]) => kind === 'root');
  const definitions = rootAt === -1 ? sent : sent.slice(0, rootAt);
  const blocks = [];
  for (const item of definitions) {
    if (item[0] === 'name' || !blocks.length) blocks.push([]);
    blocks[blocks.length - 1].push(item);
  }
  blocks.sort(([[, a]], [[, b]]) => (a < b ? -1 : a > b ? 1 : 0));
  return [...blocks.flat(), ...(rootAt === -1 ? [] : sent.slice(rootAt))];
}

async function arrivesIntact(payload) {
  const expected = correctEncoding(payload);
  const received = await sendToFakeDevice(payload);
  if (expected === null || received === null) return false;
  return (
    JSON.stringify(sortDefinitionBlocks(received)) ===
    JSON.stringify(sortDefinitionBlocks(expected))
  );
}

const DOMAIN = {
  name: 'Freedom test',
  version: '1',
  chainId: 100,
  verifyingContract: '0x' + '11'.repeat(20),
};
// The typed data each payload was made from, as the site sent it.
const originals = new WeakMap();
function payloadOf(types, message, domain = DOMAIN) {
  const { payload } = getEip712WirePayload({ domain, types, message });
  originals.set(payload, { domain, message });
  return payload;
}
const nested = (innerFields, inner) =>
  payloadOf({ Outer: [{ name: 'inner', type: 'Inner' }], Inner: innerFields }, { inner });

const withString = (text) => payloadOf({ Note: [{ name: 'text', type: 'string' }] }, { text });
const withDomainName = (length) =>
  payloadOf(
    { Note: [{ name: 'text', type: 'string' }] },
    { text: 'x' },
    { ...DOMAIN, name: 'd'.repeat(length) }
  );
const withBytes = (length) =>
  payloadOf({ Blob: [{ name: 'data', type: 'bytes' }] }, { data: '0x' + 'ab'.repeat(length) });
const withArray = (type, entries) => payloadOf({ List: [{ name: 'xs', type }] }, { xs: entries });
const withFieldName = (name, type = 'uint8') =>
  payloadOf({ Item: [{ name, type }] }, { [name]: type === 'string' ? 'x' : 1 });
const withStruct = (structName) =>
  payloadOf(
    { Outer: [{ name: 'inner', type: structName }], [structName]: [{ name: 'n', type: 'uint8' }] },
    { inner: { n: 7 } }
  );
const asPrimaryType = (structName) =>
  payloadOf({ [structName]: [{ name: 'n', type: 'uint8' }] }, { n: 7 });
const safeTx = (calldataLength) =>
  payloadOf(
    {
      SafeTx: [
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'data', type: 'bytes' },
        { name: 'operation', type: 'uint8' },
        { name: 'safeTxGas', type: 'uint256' },
        { name: 'baseGas', type: 'uint256' },
        { name: 'gasPrice', type: 'uint256' },
        { name: 'gasToken', type: 'address' },
        { name: 'refundReceiver', type: 'address' },
        { name: 'nonce', type: 'uint256' },
      ],
    },
    {
      to: '0x' + '22'.repeat(20),
      value: 0,
      data: '0x' + 'cd'.repeat(calldataLength),
      operation: 0,
      safeTxGas: 0,
      baseGas: 0,
      gasPrice: 0,
      gasToken: '0x' + '00'.repeat(20),
      refundReceiver: '0x' + '00'.repeat(20),
      nonce: 3,
    },
    { chainId: 100, verifyingContract: '0x' + '33'.repeat(20) }
  );

const passes = (payload) => findLedgerTypedDataProblem(payload) === null;

describe('findLedgerTypedDataProblem', () => {
  test('passes exactly the typed data that reaches the device intact', async () => {
    const cases = [];
    for (let n = 0; n <= 1300; n++) {
      cases.push([`string of ${n} bytes`, withString('s'.repeat(n))]);
      cases.push([`bytes of ${n}`, withBytes(n)]);
    }
    for (const n of [64768, 64769, 65022, 65023, 65024, 65535, 65536])
      cases.push([`bytes of ${n}`, withBytes(n)]);
    for (const n of [126, 127, 128, 254, 255])
      cases.push([`${n} two-byte characters`, withString('é'.repeat(n))]);
    for (const n of [6852, 6884, 6916])
      cases.push([`SafeTx with ${n} bytes of calldata`, safeTx(n)]);
    for (const n of [0, 255, 256, 257])
      cases.push([`uint8[] of ${n}`, withArray('uint8[]', Array(n).fill(1))]);
    for (const n of [255, 256])
      cases.push([`uint8[${n}]`, withArray(`uint8[${n}]`, Array(n).fill(1))]);
    cases.push(['uint8[][] of 256 arrays', withArray('uint8[][]', Array(256).fill([1]))]);
    cases.push([
      'uint8[2][] of 3',
      withArray('uint8[2][]', [
        [1, 2],
        [3, 4],
        [5, 6],
      ]),
    ]);
    for (const n of [251, 252, 253])
      cases.push([`uint8 field name of ${n}`, withFieldName('f'.repeat(n))]);
    for (const n of [252, 253, 254])
      cases.push([`string field name of ${n}`, withFieldName('f'.repeat(n), 'string')]);
    for (const name of ['é', 'naïve', '名前', '🙂'])
      cases.push([`field name ${name}`, withFieldName(name)]);
    for (const name of [
      'Inner',
      'Point',
      'Mintable',
      'Bytes4Holder',
      'Point2',
      'Mint1',
      'Paint256',
      'Hint1000',
      'Bytes',
      'Address',
      'String',
      'Bool',
      'Int',
      'Uint',
      'Custom',
      'custom',
      'Straße',
    ]) {
      cases.push([`struct ${name} as a field type`, withStruct(name)]);
      cases.push([`struct ${name} as the primary type`, asPrimaryType(name)]);
    }
    for (const n of [240, 255, 256])
      cases.push([`primary type name of ${n}`, asPrimaryType('T'.repeat(n))]);
    for (const n of [253, 254, 255]) cases.push([`domain name of ${n} bytes`, withDomainName(n)]);
    cases.push([
      'domain with a salt',
      payloadOf(
        { Note: [{ name: 'text', type: 'string' }] },
        { text: 'x' },
        {
          ...DOMAIN,
          salt: '0x' + '44'.repeat(32),
        }
      ),
    ]);

    // Field order and names hw-app-eth's object lookups change.
    const u8 = (name) => ({ name, type: 'uint8' });
    cases.push(['nested fields "1", "0"', nested([u8('1'), u8('0')], { 1: 1, 0: 2 })]);
    cases.push(['nested fields "0", "1"', nested([u8('0'), u8('1')], { 0: 1, 1: 2 })]);
    cases.push(['nested fields "b", "1"', nested([u8('b'), u8('1')], { b: 1, 1: 2 })]);
    cases.push(['nested fields "b", "a"', nested([u8('b'), u8('a')], { b: 1, a: 2 })]);
    cases.push([
      'top-level fields "1", "0"',
      payloadOf({ Item: [u8('1'), u8('0')] }, { 1: 1, 0: 2 }),
    ]);
    cases.push(['nested field "constructor"', nested([u8('constructor')], { constructor: 3 })]);
    cases.push([
      'nested field "__proto__"',
      nested([u8('__proto__')], JSON.parse('{"__proto__": 3}')),
    ]);
    cases.push([
      'top-level field "__proto__"',
      payloadOf({ Item: [u8('__proto__')] }, JSON.parse('{"__proto__": 3}')),
    ]);

    // A struct named "Custom" is defined, but its values aren't sent.
    const custom = (type, value, fields = [u8('n')]) =>
      payloadOf({ Outer: [{ name: 'c', type }], Custom: fields }, { c: value });
    cases.push(['empty Custom[]', custom('Custom[]', [])]);
    cases.push(['Custom[] of one', custom('Custom[]', [{ n: 1 }])]);
    cases.push(['nested Custom without fields', custom('Custom', {}, [])]);
    const withEmpty = (emptyType) =>
      payloadOf(
        {
          Outer: [{ name: 'c', type: 'Custom' }],
          Custom: [{ name: 'e', type: emptyType }],
          ...(emptyType === 'Empty' ? { Empty: [] } : {}),
        },
        { c: { e: emptyType === 'Empty' ? {} : [] } }
      );
    cases.push(['nested Custom holding only an empty struct', withEmpty('Empty')]);
    cases.push(['nested Custom holding an empty array', withEmpty('uint8[]')]);

    // Spellings ethers accepts and hashes as written.
    for (const type of ['uint', 'int', 'uint256', 'uint8[01]', 'uint8[00]', 'uint8[1]']) {
      const value = type.includes('[') ? Array(Number(type.match(/\[(\d+)\]/)[1])).fill(1) : 5;
      cases.push([`field of type ${type}`, withArray(type, value)]);
    }
    cases.push([
      'struct Point[X] as a field type',
      payloadOf(
        { Outer: [{ name: 'x', type: 'Point[X]' }], 'Point[X]': [u8('n')] },
        { x: { n: 1 } }
      ),
    ]);
    cases.push(['struct Point[X] as the primary type', asPrimaryType('Point[X]')]);
    cases.push([
      'top-level uint8[] field "__proto__"',
      payloadOf(
        { Item: [{ name: '__proto__', type: 'uint8[]' }] },
        JSON.parse('{"__proto__": [1, 2]}')
      ),
    ]);
    cases.push([
      'struct field "__proto__"',
      payloadOf(
        { Outer: [{ name: '__proto__', type: 'Inner' }], Inner: [u8('n')] },
        JSON.parse('{"__proto__": {"n": 4}}')
      ),
    ]);
    for (const name of ['bool', 'Bool']) {
      cases.push([`struct named ${name} as the primary type`, asPrimaryType(name)]);
    }
    cases.push([
      'struct named uint8[] as the primary type',
      payloadOf({ 'uint8[]': [u8('0')] }, [7]),
    ]);
    const empty = (name) => ({ name, type: 'Empty' });
    cases.push([
      'nested fields "1", "0" that send nothing, then "n"',
      payloadOf(
        {
          Outer: [{ name: 'inner', type: 'Inner' }],
          Inner: [empty('1'), empty('0'), u8('n')],
          Empty: [],
        },
        { inner: { 1: {}, 0: {}, n: 7 } }
      ),
    ]);
    cases.push(['nested fields "n", "1"', nested([u8('n'), u8('1')], { n: 1, 1: 2 })]);
    cases.push(['uint8 written as 0x0001', payloadOf({ Item: [u8('n')] }, { n: '0x0001' })]);
    cases.push([
      'structs named "2" and "10"',
      payloadOf(
        {
          Outer: [
            { name: 'a', type: '2' },
            { name: 'b', type: '10' },
          ],
          2: [u8('n')],
          10: [u8('n')],
        },
        { a: { n: 1 }, b: { n: 2 } }
      ),
    ]);

    // Long values deep inside arrays of structs.
    const deep = (text) =>
      payloadOf(
        {
          Outer: [{ name: 'inner', type: 'Inner[]' }],
          Inner: [
            { name: 'ys', type: 'uint8[]' },
            { name: 's', type: 'string' },
          ],
        },
        {
          inner: [
            { ys: [1, 2], s: 'ok' },
            { ys: [], s: text },
          ],
        }
      );
    cases.push(['string of 253 inside an array of structs', deep('s'.repeat(253))]);
    cases.push(['string of 254 inside an array of structs', deep('s'.repeat(254))]);

    const disagreements = [];
    for (const [label, payload] of cases) {
      const intact = await arrivesIntact(payload);
      if (passes(payload) !== intact)
        disagreements.push(
          `${label}: check ${passes(payload) ? 'passes' : 'refuses'}, device got it ${intact ? 'intact' : 'wrong'}`
        );
    }
    expect(disagreements).toEqual([]);
  });

  test('refuses string and bytes values of the lengths hw-app-eth cuts short', () => {
    const refused = (n) => !passes(withBytes(n));
    expect([254, 509, 510, 764, 765, 766, 1019, 1022].every(refused)).toBe(true);
    expect([0, 32, 253, 255, 508, 511, 763, 767, 1018, 1023].some(refused)).toBe(false);
    expect(passes(withString('s'.repeat(254)))).toBe(false);
    // 127 two-byte characters are 254 bytes.
    expect(passes(withString('é'.repeat(127)))).toBe(false);
    expect(passes(withString('é'.repeat(126)))).toBe(true);
  });

  test('passes ordinary Safe calldata and refuses the long lengths that get cut short', () => {
    expect(passes(safeTx(68))).toBe(true);
    expect(passes(safeTx(6852))).toBe(true);
    expect(passes(safeTx(6884))).toBe(false);
  });

  test('refuses arrays over 255 entries, names hw-app-eth announces wrongly and misread structs', () => {
    expect(passes(withArray('uint8[]', Array(255).fill(1)))).toBe(true);
    expect(passes(withArray('uint8[]', Array(256).fill(1)))).toBe(false);
    expect(passes(withArray('uint8[256]', Array(256).fill(1)))).toBe(false);
    expect(passes(withFieldName('é'))).toBe(false);
    expect(passes(withStruct('Straße'))).toBe(false);
    expect(passes(withStruct('Point2'))).toBe(false);
    expect(passes(withStruct('Custom'))).toBe(false);
    expect(passes(asPrimaryType('Point2'))).toBe(true);
  });

  test('looks at the domain as well as the message', () => {
    expect(findLedgerTypedDataProblem(withDomainName(254))).toBe('domain.name is 254 bytes');
  });
});

describe('assertLedgerCanSendTypedData', () => {
  test('throws the typed-data error with the reason, and returns quietly otherwise', () => {
    expect(() => assertLedgerCanSendTypedData(withBytes(32))).not.toThrow();
    let thrown;
    try {
      assertLedgerCanSendTypedData(withBytes(254));
    } catch (err) {
      thrown = err;
    }
    expect(thrown.code).toBe(LEDGER_ERROR_CODES.TYPED_DATA_UNSUPPORTED);
    expect(thrown.message).toMatch(/can't be sent to a Ledger intact/);
    expect(thrown.detail).toBe('message.data is 254 bytes');
  });
});
