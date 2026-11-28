/**
 * The typed form's writer and plain reader (swarm-typed.js `writeTyped`,
 * `readPlain`; freedom-core design 0015, D5 and D7: the Swarm store ops'
 * members and answers, SWM-6's PR 6.1). The reader of a page's params is
 * swarm-grammar.test.js's; the vectors' members and answers are
 * swarm-stores.vectors.test.js's.
 */

const { SwarmData, TypedFormError, readPlain, readTyped, writeTyped } = require('./swarm-typed');

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
