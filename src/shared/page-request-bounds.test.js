const fs = require('fs');
const path = require('path');
const {
  PAGE_REQUEST_LIMITS,
  PAGE_REQUEST_PAYLOADS,
  pageRequestMaxBytes,
  pageRequestUtf8Length,
  measurePageRequest,
  pageRequestWalkError,
} = require('./page-request-bounds');

const MiB = 1024 * 1024;
const NONCE = 'a'.repeat(32);
const block = (source) => {
  const begin = source.indexOf('// BEGIN page-request-bounds');
  const end = source.indexOf('// END page-request-bounds');
  expect(begin).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(begin);
  return source.slice(begin, end);
};

// A request as the preload sends it; `fill` takes the rest of `target` bytes.
const envelope = (provider, method, params) => ({ nonce: NONCE, provider, method, params });
const envelopeBytes = (provider, method) =>
  'nonce'.length + 'provider'.length + 'method'.length + 'params'.length + NONCE.length + provider.length + method.length;

describe('the size walk (freedom-core design 0011, "The size and the charge")', () => {
  test('the preload runs the same walk, byte for byte', () => {
    const shared = fs.readFileSync(path.join(__dirname, 'page-request-bounds.js'), 'utf8');
    const preload = fs.readFileSync(path.join(__dirname, '..', 'main', 'webview-preload.js'), 'utf8');
    expect(block(preload)).toBe(block(shared));
    expect(block(shared).length).toBeGreaterThan(2000);
  });

  test('the two uploads\' sizes are today\'s payload limits plus 64 KiB; every other method 1 MiB', () => {
    const swarm = fs.readFileSync(path.join(__dirname, '..', 'main', 'swarm', 'swarm-provider-ipc.js'), 'utf8');
    expect(swarm).toContain('maxDataBytes: 10 * 1024 * 1024,');
    expect(swarm).toContain('maxFilesBytes: 50 * 1024 * 1024,');
    // Each oversized error is the one the method gives today.
    expect(swarm).toContain('message: `Payload exceeds maximum size of ${LIMITS.maxDataBytes} bytes`');
    expect(swarm).toContain('message: `Total size exceeds maximum of ${LIMITS.maxFilesBytes} bytes`');
    expect(PAGE_REQUEST_PAYLOADS['swarm:swarm_publishData'].message).toBe(`Payload exceeds maximum size of ${10 * MiB} bytes`);
    expect(PAGE_REQUEST_PAYLOADS['swarm:swarm_publishFiles'].message).toBe(`Total size exceeds maximum of ${50 * MiB} bytes`);

    expect(pageRequestMaxBytes('swarm', 'swarm_publishData')).toBe(10 * MiB + 64 * 1024);
    expect(pageRequestMaxBytes('swarm', 'swarm_publishFiles')).toBe(50 * MiB + 64 * 1024);
    for (const [provider, method] of [
      ['swarm', 'swarm_readChunk'],
      ['ethereum', 'eth_call'],
      ['radicle', 'radicle_createIssue'],
      ['ethereum', 'swarm_publishData'],
      ['swarm', '__proto__'],
      ['swarm', 'hasOwnProperty'],
    ]) {
      expect(pageRequestMaxBytes(provider, method)).toBe(MiB);
    }
    expect(PAGE_REQUEST_LIMITS).toEqual({
      maxValues: 10000,
      maxDepth: 32,
      bigintBits: 256,
      bigintBytes: 32,
      defaultBytes: MiB,
      ticketAbove: MiB,
    });
  });

  test('a request of exactly its method\'s size passes, and one byte more is refused', () => {
    for (const [provider, method, wrap] of [
      ['swarm', 'swarm_readChunk', (data) => ({ data })],
      ['ethereum', 'eth_call', (data) => [data]],
      ['swarm', 'swarm_publishData', (data) => ({ data })],
      ['swarm', 'swarm_publishFiles', (data) => ({ data })],
    ]) {
      const max = pageRequestMaxBytes(provider, method);
      const rest = envelopeBytes(provider, method) + (provider === 'ethereum' ? 0 : 'data'.length);
      for (const make of [(n) => 'x'.repeat(n), (n) => new Uint8Array(n)]) {
        const exact = envelope(provider, method, wrap(make(max - rest)));
        expect(measurePageRequest(exact, max)).toEqual({
          ok: true,
          size: max,
          values: provider === 'ethereum' ? 6 : 6,
          names: provider === 'ethereum' ? 4 : 5,
        });
        const over = envelope(provider, method, wrap(make(max - rest + 1)));
        expect(measurePageRequest(over, max)).toEqual({ ok: false, reason: 'size', size: max + 1 });
      }
    }
  });

  test('UTF-8 of every string and property name, binary at its buffer\'s length, 32 per BigInt, nothing for the rest', () => {
    const walk = (value) => measurePageRequest(value, MiB);
    expect(walk('abc').size).toBe(3);
    expect(walk(String.fromCharCode(0xe9)).size).toBe(2);
    expect(walk(String.fromCharCode(0x20ac)).size).toBe(3);
    expect(walk(String.fromCodePoint(0x1f600)).size).toBe(4);
    expect(walk('\ud800').size).toBe(3);
    expect(walk('\udc00x').size).toBe(4);
    expect(walk({ [`cl${String.fromCharCode(0xe9)}`]: String.fromCharCode(0xe9) }).size).toBe(6);
    expect(walk(new Uint8Array(10)).size).toBe(10);
    expect(walk(new ArrayBuffer(7)).size).toBe(7);
    // A view counts its whole buffer, whatever part of it it shows.
    expect(walk(new Uint8Array(new ArrayBuffer(100), 10, 5)).size).toBe(100);
    expect(walk(Buffer.from('abcd')).size).toBeGreaterThanOrEqual(4);
    expect(walk(123n).size).toBe(32);
    expect(walk([1, 2.5, -0, NaN, true, false, null, undefined])).toEqual({ ok: true, size: 0, values: 9, names: 0 });
    // `{ type: 'Buffer', data }` is an array of numbers to the walk.
    expect(walk({ type: 'Buffer', data: [1, 2, 3] })).toEqual({ ok: true, size: 'typeBuffer'.length + 'data'.length, values: 6, names: 2 });
    expect(walk(Object.assign(Object.create(null), { a: 'b' })).size).toBe(2);
  });

  test('the UTF-8 length is TextEncoder\'s, and stops past its cap', () => {
    const encoder = new TextEncoder();
    const ch = (...units) => String.fromCharCode(...units);
    const samples = ['', 'plain', ch(0x100, 0x100, 0x100), ch(0x61, 0x1, 0x62), ch(0x7ff, 0x800, 0xffff),
      ch(0xd83d, 0xde00, 0x78, 0xd83d, 0xde00), ch(0xd800), ch(0x61, 0xdfff), ch(0xd83d, 0xd83d), ch(0x6f, 0x6b, 0xd800)];
    for (let i = 0; i < 200; i += 1) {
      samples.push(String.fromCharCode(...Array.from({ length: 20 }, () => Math.floor(Math.random() * 0x10000))));
    }
    for (const text of samples) expect(pageRequestUtf8Length(text, Infinity)).toBe(encoder.encode(text).length);
    // A string longer than the cap is past it, without a walk.
    const long = 'x'.repeat(100 * MiB);
    const started = Date.now();
    expect(pageRequestUtf8Length(long, MiB)).toBeGreaterThan(MiB);
    expect(measurePageRequest(long, MiB)).toEqual({ ok: false, reason: 'size', size: 100 * MiB });
    expect(Date.now() - started).toBeLessThan(500);
  });

  test('anything but the types it takes is refused', () => {
    class Thing {}
    for (const value of [
      new Map(),
      new Set(),
      new Date(),
      /x/,
      new Error('x'),
      new DataView(new ArrayBuffer(4)),
      new Int8Array(2),
      new Uint16Array(2),
      new Uint8ClampedArray(2),
      new Float64Array(2),
      new BigInt64Array(2),
      new String('boxed'),
      new Thing(),
      () => 1,
      Symbol('s'),
    ]) {
      expect(measurePageRequest({ params: [value] }, MiB)).toEqual({ ok: false, reason: 'type', size: expect.any(Number) });
    }
  });

  test('10,000 values pass and one more is refused; a sparse array or a cycle is refused at once', () => {
    // The root and its array are two values.
    expect(measurePageRequest({ a: new Array(9998).fill(0) }, MiB)).toEqual({ ok: true, size: 1, values: 10000, names: 1 });
    expect(measurePageRequest({ a: new Array(9999).fill(0) }, MiB)).toEqual({ ok: false, reason: 'values', size: 1 });
    const wide = {};
    for (let i = 0; i < 9999; i += 1) wide[`k${i}`] = '';
    expect(measurePageRequest(wide, MiB).ok).toBe(true);
    wide.k9999 = '';
    expect(measurePageRequest(wide, MiB).reason).toBe('values');
    const started = Date.now();
    expect(measurePageRequest({ a: new Array(1e9) }, MiB).reason).toBe('values');
    // A cycle (structured clone keeps one) nests deeper at every turn.
    const cycle = { a: [] };
    cycle.a.push(cycle, cycle);
    expect(measurePageRequest(cycle, MiB).reason).toBe('depth');
    expect(Date.now() - started).toBeLessThan(500);
  });

  test('32 levels pass and 33 are refused', () => {
    const nest = (levels) => {
      let value = 0;
      for (let i = 1; i < levels; i += 1) value = [value];
      return value;
    };
    expect(measurePageRequest(nest(32), MiB)).toEqual({ ok: true, size: 0, values: 32, names: 0 });
    expect(measurePageRequest(nest(33), MiB).reason).toBe('depth');
  });

  test('a BigInt of 256 bits passes as 32 bytes; 257 bits, or millions, are refused', () => {
    const max = (1n << 256n) - 1n;
    expect(measurePageRequest({ v: max }, MiB)).toEqual({ ok: true, size: 1 + 32, values: 2, names: 1 });
    expect(measurePageRequest({ v: -max }, MiB).ok).toBe(true);
    expect(measurePageRequest({ v: 1n << 256n }, MiB).reason).toBe('bigint');
    expect(measurePageRequest({ v: -(1n << 256n) }, MiB).reason).toBe('bigint');
    const huge = (1n << 4_000_000n) + 1n;
    const started = Date.now();
    expect(measurePageRequest({ v: huge }, MiB).reason).toBe('bigint');
    expect(measurePageRequest({ v: -huge }, MiB).reason).toBe('bigint');
    expect(Date.now() - started).toBeLessThan(500);
  });

  test('main\'s own ticket is left out at the top level only', () => {
    const ticket = 'f'.repeat(64);
    const base = measurePageRequest({ a: 'b' }, MiB);
    expect(measurePageRequest({ a: 'b', ticket }, MiB, { skipKey: 'ticket' })).toEqual(base);
    expect(measurePageRequest({ a: 'b', ticket }, MiB).size).toBe(base.size + 6 + 64);
    expect(measurePageRequest({ a: { ticket } }, MiB, { skipKey: 'ticket' }).size).toBe(1 + 6 + 64);
  });

  test('the preload\'s copy of a view that doesn\'t span its buffer is what it measures', () => {
    const buffer = new ArrayBuffer(1000);
    const partial = new Uint8Array(buffer, 10, 20);
    const whole = new Uint8Array(30);
    const params = { a: partial, b: [whole, partial] };
    const replaced = [];
    const result = measurePageRequest({ params }, MiB, {
      replaceView: (view) => {
        replaced.push(view);
        return view.slice();
      },
    });
    expect(replaced).toEqual([partial, partial]);
    expect(params.a).not.toBe(partial);
    expect(params.a.buffer.byteLength).toBe(20);
    expect(params.b[0]).toBe(whole);
    expect(params.b[1].buffer.byteLength).toBe(20);
    expect(result.size).toBe('params'.length + 1 + 20 + 1 + 30 + 20);
    // Main, which replaces nothing, measures that request the same.
    expect(measurePageRequest({ params }, MiB)).toEqual(result);
  });

  test('the error for each refusal', () => {
    expect(pageRequestWalkError('size', 'swarm', 'swarm_readChunk', MiB + 1)).toEqual({ code: -32005, message: 'Limit exceeded' });
    expect(pageRequestWalkError('size', 'swarm', 'swarm_publishData', 11 * MiB)).toEqual({
      code: -32602,
      message: 'Payload exceeds maximum size of 10485760 bytes',
      data: { reason: 'payload_too_large', limit: 10 * MiB, actual: 11 * MiB },
    });
    expect(pageRequestWalkError('size', 'swarm', 'swarm_publishFiles', 51 * MiB)).toEqual({
      code: -32602,
      message: 'Total size exceeds maximum of 52428800 bytes',
      data: { reason: 'payload_too_large', limit: 50 * MiB, actual: 51 * MiB },
    });
    expect(pageRequestWalkError('values')).toEqual({ code: -32005, message: 'Limit exceeded' });
    expect(pageRequestWalkError('depth')).toEqual({ code: -32005, message: 'Limit exceeded' });
    expect(pageRequestWalkError('bigint')).toEqual({ code: -32602, message: 'Invalid parameters' });
    expect(pageRequestWalkError('type')).toEqual({ code: -32602, message: 'Invalid parameters' });
  });
});
