/**
 * The typed form's writers and plain reader (swarm-typed.js `writeTyped`,
 * `readPlain`; freedom-core design 0015, D5 and D7: the Swarm store ops'
 * members and answers, SWM-6's PR 6.1; and `writePageParams`, a page's
 * params, SWM-7's PR 7.2). The reader of a page's params is
 * swarm-grammar.test.js's; the vectors' members and answers are
 * swarm-stores.vectors.test.js's, and the vectors' page params
 * page-swarm-core.vectors.test.js's.
 */

const {
  INLINE_TOTAL,
  SwarmData,
  TypedFormError,
  readPlain,
  readTyped,
  writePageParams,
  writeTyped,
} = require('./swarm-typed');

/** What goes on the wire: the typed value through JSON and back. */
const wire = (typed) => JSON.parse(JSON.stringify(typed));

describe('writeTyped', () => {
  test.each([
    ['a string', 'héllo', { string: 'héllo' }],
    ['the empty string', '', { string: '' }],
    ['a lone surrogate', '\ud800x', { string: '\ud800x' }],
    ['an integer', 42, { number: '42' }],
    ['a fraction', -1.5, { number: '-1.5' }],
    ['zero', 0, { number: '0' }],
    ['negative zero', -0, { number: '-0' }],
    ['NaN', NaN, { number: 'NaN' }],
    ['Infinity', Infinity, { number: 'Infinity' }],
    ['-Infinity', -Infinity, { number: '-Infinity' }],
    ['a large number', 1e21, { number: '1e+21' }],
    ['a small number', 5e-7, { number: '5e-7' }],
    ['a BigInt', -123n, { bigint: '-123' }],
    ['true', true, { boolean: true }],
    ['false', false, { boolean: false }],
    ['null', null, { null: true }],
    ['undefined', undefined, { undefined: true }],
    ['an empty array', [], { array: [] }],
    ['an empty object', {}, { object: [] }],
  ])('%s', (_label, value, typed) => {
    expect(writeTyped(value)).toEqual(typed);
    const back = readTyped(wire(writeTyped(value)));
    expect(Object.is(back, value) || (typeof value === 'object' && back !== null)).toBe(true);
  });

  test('arrays keep their holes and order; objects their own keys in order, __proto__ included', () => {
    const sparse = [1, 0, 'x'];
    delete sparse[1];
    sparse.length = 5;
    expect(writeTyped(sparse)).toEqual({
      array: [{ number: '1' }, { hole: true }, { string: 'x' }, { hole: true }, { hole: true }],
    });
    const back = readTyped(wire(writeTyped(sparse)));
    expect(back).toHaveLength(5);
    expect(1 in back).toBe(false);
    expect(4 in back).toBe(false);

    const own = JSON.parse('{"b":1,"__proto__":{"polluted":true},"2":"two","a":[null]}');
    const typed = writeTyped(own);
    expect(typed.object.map(([key]) => key)).toEqual(['2', 'b', '__proto__', 'a']);
    const read = readTyped(wire(typed));
    expect(Object.keys(read)).toEqual(['2', 'b', '__proto__', 'a']);
    expect(Object.hasOwn(read, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(read)).toBe(Object.prototype);
    expect({}.polluted).toBeUndefined();

    const nullProto = Object.assign(Object.create(null), { k: 'v' });
    expect(writeTyped(nullProto)).toEqual({ object: [['k', { string: 'v' }]] });

    // Another realm's plain objects and arrays (structuredClone's, a vm's) are plain too.
    const typedK = { object: [['k', { array: [{ number: '1' }] }]] };
    expect(writeTyped(structuredClone({ k: [1] }))).toEqual(typedK);
    expect(writeTyped(require('vm').runInNewContext('({ k: [1] })'))).toEqual(typedK);
    expect(() => writeTyped(require('vm').runInNewContext('new Date(0)'))).toThrow(
      /an object of class Date is no store value/
    );
  });

  test('only own enumerable string keys are written; a value met twice, not inside itself, is written twice', () => {
    const value = { a: 1 };
    Object.defineProperty(value, 'hidden', { value: 2, enumerable: false });
    value[Symbol('s')] = 3;
    expect(writeTyped(value)).toEqual({ object: [['a', { number: '1' }]] });
    const shared = { x: 1 };
    expect(writeTyped([shared, { y: shared }])).toEqual({
      array: [
        { object: [['x', { number: '1' }]] },
        { object: [['y', { object: [['x', { number: '1' }]] }]] },
      ],
    });
  });

  test.each([
    ['a symbol', Symbol('s'), /a symbol has no typed form/],
    ['a function', () => {}, /a function has no typed form/],
    ['a Date', new Date(0), /an object of class Date is no store value/],
    ['a Map', new Map(), /an object of class Map is no store value/],
    ['a Set', new Set(), /an object of class Set is no store value/],
    ['a Buffer', Buffer.from('a'), /an object of class Buffer is no store value/],
    ['a Uint8Array', new Uint8Array(1), /an object of class Uint8Array is no store value/],
    ['an ArrayBuffer', new ArrayBuffer(1), /an object of class ArrayBuffer is no store value/],
    ['an Error', new Error('e'), /an object of class Error is no store value/],
    ['a class instance', new (class Thing {})(), /an object of class Thing is no store value/],
    ['one deep inside', { a: [{ b: new Date(0) }] }, /an object of class Date is no store value/],
  ])('%s throws a TypedFormError', (_label, value, message) => {
    expect(() => writeTyped(value)).toThrow(TypedFormError);
    expect(() => writeTyped(value)).toThrow(message);
  });

  test('a value inside itself throws a TypedFormError', () => {
    const loop = { a: {} };
    loop.a.back = loop;
    expect(() => writeTyped(loop)).toThrow(/a value holds itself/);
    const list = [];
    list.push(list);
    expect(() => writeTyped(list)).toThrow(/a value holds itself/);
  });
});

describe('readPlain', () => {
  test('reads every plain tag as readTyped does', () => {
    const a = [1, 0, 2];
    delete a[1];
    const typed = writeTyped({ s: 's', n: -0, b: 1n, t: true, z: null, u: undefined, a });
    expect(readPlain(wire(typed))).toEqual(readTyped(wire(typed)));
    expect(Object.is(readPlain(wire(typed)).n, -0)).toBe(true);
  });

  test.each([
    ['bytes', { bytes: 1, kind: 'Buffer', base64: 'YQ==' }],
    ['string bytes', { string_bytes: 1, base64: 'YQ==' }],
    ['bytes elsewhere', { bytes_elsewhere: 1, kind: 'Buffer', base64: 'YQ==' }],
    ['bytes deep inside', { object: [['a', { array: [{ bytes: 1, kind: 'Buffer', part: 0 }] }]] }],
  ])('refuses %s, which no store op answers', (_label, typed) => {
    expect(readTyped(typed)).toBeDefined();
    expect(() => readPlain(typed)).toThrow(TypedFormError);
    expect(() => readPlain(typed)).toThrow(/where no bytes can be/);
  });

  test('readTyped still reads data as SwarmData', () => {
    expect(readTyped({ bytes: 1, kind: 'Buffer', base64: 'YQ==' })).toBeInstanceOf(SwarmData);
  });
});

describe('writePageParams', () => {
  const KIB = 1024;
  const b64 = (bytes) => Buffer.from(bytes).toString('base64');

  test('data where a method reads it: bytes of each kind, and a string as its UTF-8', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(writePageParams('swarm_publishData', { data: bytes }).typed).toEqual({
      object: [['data', { bytes: 3, kind: 'Uint8Array', base64: b64(bytes) }]],
    });
    expect(writePageParams('swarm_sendPss', { data: Buffer.from('ab') }).typed.object[0][1]).toEqual({
      bytes: 2,
      kind: 'Buffer',
      base64: b64('ab'),
    });
    expect(writePageParams('swarm_publishChunk', { data: bytes.buffer }).typed.object[0][1]).toEqual({
      bytes: 3,
      kind: 'ArrayBuffer',
      base64: b64(bytes),
    });
    expect(writePageParams('swarm_writeFeedEntry', { data: { type: 'Buffer', data: [7, 8] } }).typed.object[0][1]).toEqual({
      bytes: 2,
      kind: 'BufferJSON',
      base64: b64([7, 8]),
    });
    // A lone surrogate is U+FFFD's three bytes, as Buffer.from writes it.
    const out = writePageParams('swarm_sendGsoc', { data: 'é\ud800' });
    expect(out.typed.object[0][1]).toEqual({ string_bytes: 5, base64: b64(Buffer.from('é\ud800', 'utf-8')) });
    expect(out.copies).toBe(5);
    // A view writes its own bytes, never the rest of its buffer.
    const wide = new Uint8Array([9, 9, 1, 2, 9]).subarray(2, 4);
    expect(writePageParams('swarm_writeSingleOwnerChunk', { data: wide }).typed.object[0][1].base64).toBe(b64([1, 2]));
  });

  test("a file's bytes take no string, and a value normalizeBytes refuses keeps its tag", () => {
    const typed = writePageParams('swarm_publishFiles', {
      files: [
        { path: 'a', bytes: new Uint8Array([1]) },
        { path: 'b', bytes: 'text' },
      ],
    }).typed;
    const [first, second] = typed.object[0][1].array;
    expect(first.object[1][1]).toEqual({ bytes: 1, kind: 'Uint8Array', base64: b64([1]) });
    expect(second.object[1][1]).toEqual({ string: 'text' });
    expect(writePageParams('swarm_publishData', { data: 42 }).typed.object[0][1]).toEqual({ number: '42' });
    // No method reads `data` as data for a read: bytes there are elsewhere.
    expect(writePageParams('swarm_readChunk', { data: 'x' }).typed.object[0][1]).toEqual({ string: 'x' });
  });

  test('past 64 KiB a part, numbered in the order written, holding the page\'s own view', () => {
    const big = new Uint8Array(64 * KIB + 1);
    const small = new Uint8Array(10);
    const out = writePageParams('swarm_publishFiles', {
      files: [
        { path: 'big', bytes: big },
        { path: 'small', bytes: small },
        { path: 'big2', bytes: big },
      ],
    });
    const items = out.typed.object[0][1].array.map((file) => file.object[1][1]);
    expect(items[0]).toEqual({ bytes: 64 * KIB + 1, kind: 'Uint8Array', part: 0 });
    expect(items[1]).toEqual({ bytes: 10, kind: 'Uint8Array', base64: b64(small) });
    expect(items[2]).toEqual({ bytes: 64 * KIB + 1, kind: 'Uint8Array', part: 1 });
    expect(out.parts.get(0)).toBe(big);
    expect(out.parts.get(1)).toBe(big);
    expect(out.copies).toBe(0);
    // A string's part is its UTF-8, copied.
    const text = 'é'.repeat(40 * KIB);
    const copy = writePageParams('swarm_publishData', { data: text });
    expect(copy.typed.object[0][1]).toEqual({ string_bytes: 80 * KIB, part: 0 });
    expect(Buffer.from(copy.parts.get(0)).equals(Buffer.from(text, 'utf-8'))).toBe(true);
    expect(copy.copies).toBe(80 * KIB);
  });

  test('inline data stays within its total; the rest goes as parts', () => {
    const file = (i) => ({ path: String(i), bytes: new Uint8Array(64 * KIB) });
    const count = INLINE_TOTAL / (64 * KIB) + 2;
    const out = writePageParams('swarm_publishFiles', { files: Array.from({ length: count }, (_, i) => file(i)) });
    const tags = out.typed.object[0][1].array.map((f) => f.object[1][1]);
    expect(tags.filter((t) => 'base64' in t)).toHaveLength(INLINE_TOTAL / (64 * KIB));
    expect(tags.slice(-2).map((t) => t.part)).toEqual([0, 1]);
    expect(Buffer.byteLength(JSON.stringify(out.typed))).toBeLessThan(512 * KIB);
  });

  test('everything else plainly: bytes elsewhere, holes, -0, BigInts, undefined, key order', () => {
    const holes = [1, 0];
    delete holes[1];
    const typed = writePageParams('swarm_readChunk', {
      reference: new Uint8Array([5]),
      buf: { type: 'Buffer', data: [1] },
      holes,
      n: -0,
      big: 2n ** 70n,
      u: undefined,
      s: '\ud800',
    }).typed;
    expect(typed).toEqual({
      object: [
        ['reference', { bytes_elsewhere: 1, kind: 'Uint8Array', base64: b64([5]) }],
        ['buf', { object: [['type', { string: 'Buffer' }], ['data', { array: [{ number: '1' }] }]] }],
        ['holes', { array: [{ number: '1' }, { hole: true }] }],
        ['n', { number: '-0' }],
        ['big', { bigint: (2n ** 70n).toString() }],
        ['u', { undefined: true }],
        ['s', { string: '\ud800' }],
      ],
    });
    expect(writePageParams('swarm_listFeeds', undefined).typed).toEqual({ undefined: true });
  });

  test('reads back as the grammar takes it', () => {
    const big = new Uint8Array(70 * KIB);
    const out = writePageParams('swarm_publishData', { data: big, name: 'n' });
    const back = readTyped(JSON.parse(JSON.stringify(out.typed)));
    expect(back.data).toBeInstanceOf(SwarmData);
    expect(back.data).toMatchObject({ kind: 'Uint8Array', length: 70 * KIB, part: 0, bytes: null });
    expect(back.name).toBe('n');
  });

  test('refuses what has no typed form', () => {
    const list = [];
    list.push(list);
    expect(() => writePageParams('swarm_readChunk', list)).toThrow(TypedFormError);
    expect(() => writePageParams('swarm_readChunk', { f: () => 1 })).toThrow(/a function has no typed form/);
  });
});
