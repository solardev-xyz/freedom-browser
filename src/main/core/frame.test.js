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
    expect(() => kind.push(Buffer.from([0, 0, 0, 1, 2]))).toThrow(/unknown_kind/);

    const big = Buffer.alloc(5);
    big.writeUInt32BE(MAX_PAYLOAD + 2, 0);
    big[4] = 1;
    expect(() => new FrameDecoder().push(big)).toThrow(/bad_length/);

    const json = Buffer.concat([Buffer.from([0, 0, 0, 2, 1]), Buffer.from('{')]);
    expect(() => new FrameDecoder().push(json)).toThrow(/invalid_json/);
  });

  test('requires valid UTF-8, like the Rust decoder', () => {
    const frameOf = (bytes) => {
      const payload = Buffer.concat([Buffer.from('{"a":"'), Buffer.from(bytes), Buffer.from('"}')]);
      const header = Buffer.alloc(5);
      header.writeUInt32BE(payload.length + 1, 0);
      header[4] = 1;
      return Buffer.concat([header, payload]);
    };
    // Invalid continuation, truncated multibyte, overlong encoding, lone 0xff.
    for (const bytes of [[0xc3, 0x28], [0xe2, 0x82], [0xc0, 0xaf], [0xff]]) {
      const decoder = new FrameDecoder();
      expect(() => decoder.push(frameOf(bytes))).toThrow(/invalid_utf8/);
      expect(() => decoder.push(encodeFrame({}))).toThrow(FrameError);
    }
    // Valid multibyte text split across chunks still decodes.
    const frame = frameOf([0xc3, 0xa9]);
    const decoder = new FrameDecoder();
    expect(decoder.push(frame.subarray(0, 12))).toEqual([]);
    expect(decoder.push(frame.subarray(12))).toEqual([{ a: 'é' }]);
  });

  test('errors carry a fixed category, never input text', () => {
    const payload = Buffer.from('{"password":"SECRET_SENTINEL');
    const header = Buffer.alloc(5);
    header.writeUInt32BE(payload.length + 1, 0);
    header[4] = 1;
    let error;
    try {
      new FrameDecoder().push(Buffer.concat([header, payload]));
    } catch (err) {
      error = err;
    }
    expect(error.category).toBe('invalid_json');
    expect(error.message).not.toContain('SECRET');
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
