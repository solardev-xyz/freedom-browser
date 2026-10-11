const { encodeFrame, FrameDecoder, FrameError, MAX_PAYLOAD } = require('./frame');

describe('frames', () => {
  test('round-trips under any chunking', () => {
    const messages = [{ a: 1 }, { big: 'x'.repeat(70_000) }, [1, 2, 3], {}];
    const stream = Buffer.concat(messages.map(encodeFrame));
    for (const size of [1, 2, 5, 7, 4096, stream.length]) {
      const decoder = new FrameDecoder();
      const out = [];
      for (let i = 0; i < stream.length; i += size) {
        out.push(...decoder.push(stream.subarray(i, i + size)));
      }
      expect(out).toEqual(messages);
      expect(decoder.isAtBoundary()).toBe(true);
    }
  });

  test('matches the Rust wire format', () => {
    // u32 BE length of kind + payload, kind 0x01, JSON payload.
    expect(encodeFrame({}).toString('hex')).toBe('00000003017b7d');
  });

  test('rejects bad frames and stays failed', () => {
    const zero = new FrameDecoder();
    expect(() => zero.push(Buffer.from([0, 0, 0, 0, 1]))).toThrow(FrameError);
    expect(() => zero.push(Buffer.from('{}'))).toThrow(FrameError);

    const kind = new FrameDecoder();
    expect(() => kind.push(Buffer.from([0, 0, 0, 1, 2]))).toThrow(/unknown frame kind/);

    const big = Buffer.alloc(5);
    big.writeUInt32BE(MAX_PAYLOAD + 2, 0);
    big[4] = 1;
    expect(() => new FrameDecoder().push(big)).toThrow(/bad frame length/);

    const json = Buffer.concat([Buffer.from([0, 0, 0, 2, 1]), Buffer.from('{')]);
    expect(() => new FrameDecoder().push(json)).toThrow(/invalid JSON/);
  });

  test('reports a cut frame', () => {
    const frame = encodeFrame({ a: 1 });
    const decoder = new FrameDecoder();
    expect(decoder.push(frame.subarray(0, frame.length - 1))).toEqual([]);
    expect(decoder.isAtBoundary()).toBe(false);
  });

  test('refuses to encode an oversized payload', () => {
    expect(() => encodeFrame({ x: 'y'.repeat(MAX_PAYLOAD) })).toThrow(FrameError);
  });
});
