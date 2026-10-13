const {
  encodeBegin,
  encodeCredit,
  encodeFrame,
  frameHeader,
  FrameDecoder,
  FrameError,
  Reassembler,
  KIND_BEGIN,
  KIND_CREDIT,
  KIND_FRAGMENT,
  KIND_JSON,
  KIND_LAST,
  MAX_MESSAGE,
  MAX_PAYLOAD,
} = require('./frame');

const MIB = 1024 * 1024;

/** The whole messages among `frames`. */
const messages = (frames) => frames.filter((f) => f.kind === KIND_JSON).map((f) => f.message);

function rawFrame(kind, payload) {
  const bytes = Buffer.from(payload);
  return Buffer.concat([frameHeader(kind, bytes.length), bytes]);
}

/** Feeds `stream` in `size`-byte pieces and returns every frame. */
function decodeAll(stream, size) {
  const decoder = new FrameDecoder();
  const out = [];
  for (let i = 0; i < stream.length; i += size) {
    out.push(...decoder.push(stream.subarray(i, i + size)));
  }
  expect(decoder.isAtBoundary()).toBe(true);
  return out;
}

describe('frames', () => {
  test('round-trips under any chunking', () => {
    const values = [{ a: 1 }, { big: 'x'.repeat(70_000) }, [1, 2, 3], {}];
    const stream = Buffer.concat(values.map(encodeFrame));
    for (const size of [1, 2, 5, 7, 4096, stream.length]) {
      expect(messages(decodeAll(stream, size))).toEqual(values);
    }
  });

  test('matches the Rust wire format', () => {
    // u32 BE length of kind + payload, kind 0x01, JSON payload.
    expect(encodeFrame({}).toString('hex')).toBe('00000003017b7d');
    // fc-protocol's Begin::encode and credit_frame.
    expect(
      encodeBegin(7, 3 * MIB)
        .subarray(5)
        .toString()
    ).toBe('{"id":7,"bytes":3145728}');
    expect(encodeBegin(7, 3 * MIB)[4]).toBe(KIND_BEGIN);
    expect(encodeCredit().toString('hex')).toBe('0000000113');
    expect(frameHeader(KIND_LAST, MAX_PAYLOAD).toString('hex')).toBe('0010000111');
    expect(() => frameHeader(KIND_FRAGMENT, MAX_PAYLOAD + 1)).toThrow(/too_large/);
  });

  test('takes the fragment kinds and refuses the rest', () => {
    const stream = Buffer.concat([
      encodeFrame({ a: 1 }),
      rawFrame(KIND_FRAGMENT, 'x'),
      rawFrame(KIND_LAST, 'y'),
      encodeBegin(3, 10),
      encodeCredit(),
    ]);
    const frames = decodeAll(stream, 3);
    expect(frames.map((f) => f.kind)).toEqual([0x01, 0x10, 0x11, 0x12, 0x13]);
    expect(frames[0].message).toEqual({ a: 1 });
    expect(frames[1].payload.toString()).toBe('x');
    expect(frames[3].payload.toString()).toBe('{"id":3,"bytes":10}');
    expect(frames[4].payload).toHaveLength(0);
    // Phase 4's kinds stay reserved, and nothing else is a kind.
    for (const kind of [0x00, 0x02, 0x0f, 0x14, 0x7f, 0xff]) {
      expect(() => new FrameDecoder().push(Buffer.from([0, 0, 0, 1, kind]))).toThrow(
        /unknown_kind/
      );
    }
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
    // A fragment is a frame too: at most 1 MiB.
    big[4] = KIND_FRAGMENT;
    expect(() => new FrameDecoder().push(big)).toThrow(/bad_length/);

    const json = Buffer.concat([Buffer.from([0, 0, 0, 2, 1]), Buffer.from('{')]);
    expect(() => new FrameDecoder().push(json)).toThrow(/invalid_json/);
  });

  test('requires valid UTF-8, like the Rust decoder', () => {
    const frameOf = (bytes) =>
      rawFrame(
        KIND_JSON,
        Buffer.concat([Buffer.from('{"a":"'), Buffer.from(bytes), Buffer.from('"}')])
      );
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
    expect(messages(decoder.push(frame.subarray(12)))).toEqual([{ a: 'é' }]);
  });

  test('errors carry a fixed category, never input text', () => {
    let error;
    try {
      new FrameDecoder().push(rawFrame(KIND_JSON, '{"password":"SECRET_SENTINEL'));
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
    // A header alone is cut too.
    const header = new FrameDecoder();
    header.push(frame.subarray(0, 5));
    expect(header.isAtBoundary()).toBe(false);
  });

  test('refuses to encode an oversized payload', () => {
    expect(() => encodeFrame({ x: 'y'.repeat(MAX_PAYLOAD) })).toThrow(FrameError);
  });

  describe('the chunk list', () => {
    /** Counts the bytes copied while `fn` runs: Buffer.concat's output and
     * Buffer#copy's, the two ways a decoder can copy. */
    function copiedWhile(fn) {
      let copied = 0;
      const concat = jest.spyOn(Buffer, 'concat');
      const copy = jest.spyOn(Buffer.prototype, 'copy');
      try {
        fn();
        for (const result of concat.mock.results) copied += result.value.length;
        for (const result of copy.mock.results) copied += result.value;
      } finally {
        concat.mockRestore();
        copy.mockRestore();
      }
      return copied;
    }

    test('a frame within one chunk is a view of it', () => {
      const chunk = Buffer.concat([rawFrame(KIND_FRAGMENT, 'abc'), rawFrame(KIND_LAST, 'de')]);
      const decoder = new FrameDecoder();
      let frames;
      expect(copiedWhile(() => (frames = decoder.push(chunk)))).toBe(0);
      for (const f of frames) expect(f.payload.buffer).toBe(chunk.buffer);
    });

    test('decodes many 1 MiB frames in linear time: each byte is copied at most once', () => {
      // 64 MiB of full frames, cut into 4 KiB reads that straddle every
      // frame. Joining the input on each read, as a single buffer does,
      // copies about 8 GiB here.
      const frame = rawFrame(KIND_FRAGMENT, Buffer.alloc(MAX_PAYLOAD, 7));
      const count = 64;
      const decoder = new FrameDecoder();
      const READ = 4093;
      let decoded = 0;
      let position = 0;
      const total = frame.length * count;
      const copied = copiedWhile(() => {
        while (position < total) {
          // Each read is a fresh buffer, as a pipe's are.
          const size = Math.min(READ, total - position);
          const piece = Buffer.allocUnsafe(size);
          for (let filled = 0; filled < size;) {
            const at = (position + filled) % frame.length;
            filled += frame.copy(piece, filled, at, Math.min(frame.length, at + size - filled));
          }
          position += size;
          for (const f of decoder.push(piece)) {
            expect(f.payload.length).toBe(MAX_PAYLOAD);
            decoded += 1;
          }
        }
      });
      expect(decoded).toBe(count);
      expect(decoder.isAtBoundary()).toBe(true);
      // The test's own copies into each read, plus at most every byte once.
      expect(copied).toBeLessThanOrEqual(2 * total);
    });

    test('a frame in many tiny reads is copied once, and read chunks are released', () => {
      const payload = Buffer.alloc(MIB);
      for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
      const stream = Buffer.concat([rawFrame(KIND_LAST, payload), encodeFrame({ after: true })]);
      const decoder = new FrameDecoder();
      const frames = [];
      const copied = copiedWhile(() => {
        for (let i = 0; i < stream.length; i += 16) {
          frames.push(...decoder.push(stream.subarray(i, i + 16)));
          // Never more chunks held than one frame's.
          expect(decoder.chunks.length - decoder.head).toBeLessThanOrEqual(MIB / 16 + 2);
        }
      });
      expect(frames[0].payload.equals(payload)).toBe(true);
      expect(frames[1].message).toEqual({ after: true });
      expect(copied).toBeLessThanOrEqual(stream.length);
      expect(decoder.chunks).toEqual([]);
    });
  });
});

describe('Reassembler', () => {
  const frame = (kind, payload) => ({ kind, payload: Buffer.from(payload) });
  const json = (message) => ({ kind: KIND_JSON, message });
  const begin = (id, bytes) => frame(KIND_BEGIN, JSON.stringify({ id, bytes }));
  /** Request 7 is pending. */
  const pending = (id) => id === 7;
  const never = () => {
    throw new Error('asked outside a begin');
  };

  test('begin headers must be exactly { id, bytes }', () => {
    const r = new Reassembler();
    expect(r.push(frame(KIND_BEGIN, ' { "bytes" : 5, "id" : 7 } '), pending)).toBeNull();
    for (const bad of [
      '{"id":7}',
      '{"bytes":5}',
      '{"id":7,"bytes":5,"extra":1}',
      '{"id":7,"id":7,"bytes":5}',
      '{"id":7,"bytes":5,"bytes":5}',
      '{"id":0,"bytes":5}',
      '{"id":9007199254740992,"bytes":5}',
      '{"id":7,"bytes":-1}',
      '{"id":7,"bytes":1.5}',
      '{"id":"7","bytes":5}',
      '[7,5]',
      'null',
      '',
      Buffer.from([0xff]),
    ]) {
      expect(() => new Reassembler().push(frame(KIND_BEGIN, bad), pending)).toThrow(/begin_header/);
    }
  });

  test('a split response reassembles in any chunking, whole messages between', () => {
    const response = { type: 'response', id: 7, result: 'x'.repeat(2 * MAX_PAYLOAD + 1000) };
    const payload = Buffer.from(JSON.stringify(response));
    const parts = [encodeBegin(7, payload.length)];
    for (let offset = 0; offset < payload.length; offset += MAX_PAYLOAD) {
      const end = Math.min(payload.length, offset + MAX_PAYLOAD);
      parts.push(
        rawFrame(end === payload.length ? KIND_LAST : KIND_FRAGMENT, payload.subarray(offset, end))
      );
      parts.push(encodeFrame({ type: 'event', event: 'x.y', data: {} }));
    }
    const stream = Buffer.concat(parts);
    for (const size of [7, 4096, MIB, stream.length]) {
      const r = new Reassembler();
      const out = decodeAll(stream, size)
        .map((f) => r.push(f, pending))
        .filter(Boolean);
      // Each whole message as it arrives, the last one after the response.
      expect(out.map((d) => d.type)).toEqual(['message', 'message', 'response', 'message']);
      expect(out[2]).toEqual({ type: 'response', id: 7, message: response });
      expect(r.inProgress()).toBe(false);
      expect(r.peerCredit).toBe(false);
    }
  });

  test('the reservation is exactly the declared size', () => {
    const r = new Reassembler();
    r.push(begin(7, 3 * MIB), pending);
    expect(r.inProgress()).toBe(true);
    const reserved = r.current.buffer;
    expect(reserved.length).toBe(3 * MIB);
    r.push(frame(KIND_FRAGMENT, Buffer.alloc(MIB, 1)), pending);
    expect(r.current.buffer).toBe(reserved);
  });

  test('credit allows one response at a time', () => {
    const r = new Reassembler();
    expect(r.peerCredit).toBe(true);
    r.push(begin(7, 2), pending);
    expect(r.push(frame(KIND_LAST, '{}'), pending)).toEqual({
      type: 'response',
      id: 7,
      message: {},
    });
    // Spent: another begin waits for this side's credit frame.
    expect(r.peerCredit).toBe(false);
    r.grant();
    expect(r.push(begin(7, 2), pending)).toBeNull();
  });

  test('whole messages and credit pass through, also mid-response', () => {
    const r = new Reassembler();
    expect(r.push(json({}), never)).toEqual({ type: 'message', message: {} });
    expect(r.push(frame(KIND_CREDIT, ''), never)).toEqual({ type: 'credit' });
    r.push(begin(7, 5), pending);
    r.push(frame(KIND_FRAGMENT, '[1'), pending);
    // Responses to other requests, and every other message, still pass: a
    // request may even reuse the number, as the peer's IDs are its own.
    for (const message of [
      [],
      null,
      { type: 'response', id: 8, result: {} },
      { type: 'response', id: 9, error: { code: 'busy', message: 'b' } },
      { type: 'request', id: 7, method: 'shell.rpc', context: { caller: 'shell' } },
      { type: 'cancel', id: 7 },
      { type: 'event', event: 'e.f', data: {} },
    ]) {
      expect(r.push(json(message), pending)).toEqual({ type: 'message', message });
    }
    expect(r.push(frame(KIND_CREDIT, ''), pending)).toEqual({ type: 'credit' });
    expect(r.push(frame(KIND_LAST, ',2]'), pending)).toEqual({
      type: 'response',
      id: 7,
      message: [1, 2],
    });
  });

  /** Feeds `frames` to a fresh reassembler and returns its first error's
   * category, checking that it stays failed with nothing in reassembly. */
  function firstError(frames) {
    const r = new Reassembler();
    for (const f of frames) {
      try {
        r.push(f, pending);
      } catch (err) {
        expect(err).toBeInstanceOf(FrameError);
        expect(() => r.push(json({}), pending)).toThrow(err);
        expect(r.inProgress()).toBe(false);
        return err.category;
      }
    }
    throw new Error('no error');
  }

  test.each([
    // A begin while the sender holds no credit: one in reassembly...
    ['begin_without_credit', [begin(7, 10), begin(7, 10)]],
    // ...or one completed whose credit hasn't come back.
    ['begin_without_credit', [begin(7, 1), frame(KIND_LAST, '1'), begin(7, 1)]],
    // An unknown ID: not a pending request of the receiver's.
    ['begin_unknown_id', [begin(8, 10)]],
    // A size over the message cap, or none at all.
    ['begin_size', [begin(7, MAX_MESSAGE + 1)]],
    ['begin_size', [begin(7, 2 ** 64)]],
    ['begin_size', [begin(7, 0)]],
    ['begin_header', [frame(KIND_BEGIN, '{"id":7}')]],
    // An empty fragment, or an empty last one.
    ['empty_fragment', [begin(7, 10), frame(KIND_FRAGMENT, '')]],
    ['empty_fragment', [begin(7, 10), frame(KIND_LAST, '')]],
    // A fragment or last frame with no response in reassembly.
    ['fragment_without_begin', [frame(KIND_FRAGMENT, 'x')]],
    ['fragment_without_begin', [frame(KIND_LAST, 'x')]],
    ['fragment_without_begin', [begin(7, 1), frame(KIND_LAST, '1'), frame(KIND_LAST, '2')]],
    // A length mismatch: past the size, or a last one that leaves it short.
    ['fragment_length', [begin(7, 3), frame(KIND_FRAGMENT, 'abcd')]],
    ['fragment_length', [begin(7, 3), frame(KIND_FRAGMENT, 'ab'), frame(KIND_LAST, 'cd')]],
    ['fragment_length', [begin(7, 3), frame(KIND_LAST, 'ab')]],
    // Complete but not last: the next byte is one too many.
    ['fragment_length', [begin(7, 2), frame(KIND_FRAGMENT, 'ab'), frame(KIND_LAST, 'c')]],
    ['credit_payload', [frame(KIND_CREDIT, 'x')]],
    // A whole response for the request whose response has begun, an error
    // or a result, before any fragment or between them.
    [
      'duplicate_response',
      [begin(7, 10), json({ type: 'response', id: 7, error: { code: 'internal', message: 'x' } })],
    ],
    [
      'duplicate_response',
      [begin(7, 10), frame(KIND_FRAGMENT, 'abc'), json({ type: 'response', id: 7, result: null })],
    ],
    // The completed response decodes as a whole message does.
    ['invalid_json', [begin(7, 1), frame(KIND_LAST, '{')]],
    ['invalid_utf8', [begin(7, 1), frame(KIND_LAST, Buffer.from([0xff]))]],
    // A kind that carries no part of a message (a decoder never produces one).
    ['unknown_kind', [frame(0x02, '')]],
  ])('%s', (category, frames) => {
    expect(firstError(frames)).toBe(category);
  });

  test('the pending check is asked only at a begin, once every other check passed', () => {
    const asked = [];
    const record = (id) => {
      asked.push(id);
      return true;
    };
    const r = new Reassembler();
    r.push(begin(7, 2), record);
    r.push(frame(KIND_LAST, '{}'), never);
    expect(asked).toEqual([7]);
    // No credit, a bad size: refused before the ID is looked at, so the
    // receiver may claim it there.
    expect(() => r.push(begin(9, 2), record)).toThrow(/begin_without_credit/);
    expect(() => new Reassembler().push(begin(9, 0), record)).toThrow(/begin_size/);
    expect(asked).toEqual([7]);
  });

  test('the credit frame decodes as credit', () => {
    const [credit] = new FrameDecoder().push(encodeCredit());
    expect(new Reassembler().push(credit, never)).toEqual({ type: 'credit' });
  });
});
