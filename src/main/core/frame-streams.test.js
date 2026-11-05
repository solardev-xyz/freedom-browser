/**
 * frame.js's stream frames beyond freedom-core's `vectors/streams.json`
 * (`stream-vectors.test.js`, which runs only with a freedom-core checkout):
 * the abort JSON's edges as serde reads them, main's outbox, a failure that
 * sticks, the abort codes by connection and direction (design 0009), and
 * the core's connection at protocol 2 (`StreamDuplex`).
 */

const {
  encodeAbort,
  encodeData,
  encodeEnd,
  encodeFrame,
  encodeStreamCredit,
  serviceKinds,
  CORE_KINDS,
  CORE_STREAM_KINDS,
  FrameDecoder,
  FrameError,
  StreamDuplex,
  StreamOutbox,
  StreamReceiver,
  StreamSender,
  ABORT_CODES,
  CORE_BODY_ABORT_CODES,
  PIECE_ABORT_CODES,
  SERVICE_ABORT_CODES,
  KIND_ABORT,
  KIND_DATA,
  KIND_END,
  KIND_STREAM_CREDIT,
} = require('./frame');

// Escapes are built here, not written: a backslash, then the rest.
const BS = String.fromCharCode(92);

/** An abort frame for stream 7 carrying `json` as its payload. */
function abortFrame(json) {
  const payload = Buffer.from(json, 'utf8');
  const frame = Buffer.alloc(13 + payload.length);
  frame.writeUInt32BE(9 + payload.length, 0);
  frame[4] = KIND_ABORT;
  frame.writeUInt32BE(7, 9);
  payload.copy(frame, 13);
  return frame;
}

function decodeAbort(json) {
  const decoder = new FrameDecoder({ kinds: serviceKinds('receiver') });
  try {
    const [frame] = decoder.push(abortFrame(json));
    return { code: frame.code, message: frame.message };
  } catch (err) {
    if (err instanceof FrameError) return err.category;
    throw err;
  }
}

describe("an abort's JSON, as serde reads it", () => {
  test.each([
    ['escaped member names', `{"${BS}u0063ode":"busy","m${BS}u0065ssage":"m"}`, 'm'],
    ['an escaped code', `{"code":"bus${BS}u0079","message":"m"}`, 'm'],
    [
      'a surrogate pair',
      `{"code":"busy","message":"${BS}ud83d${BS}ude80"}`,
      String.fromCodePoint(0x1f680),
    ],
    [
      'every simple escape',
      `{"code":"busy","message":"${BS}"${BS}${BS}${BS}/${BS}b${BS}f${BS}n${BS}r${BS}t"}`,
      '"\\/\b\f\n\r\t',
    ],
    [
      'raw UTF-8',
      `{"code":"busy","message":"caf${String.fromCharCode(0xe9)}"}`,
      `caf${String.fromCharCode(0xe9)}`,
    ],
  ])('takes %s', (_label, json, message) => {
    expect(decodeAbort(json)).toEqual({ code: 'busy', message });
  });

  test.each([
    ['a lone high surrogate', `{"code":"busy","message":"${BS}ud83d"}`],
    ['a lone low surrogate', `{"code":"busy","message":"${BS}ude80"}`],
    ['a high surrogate before a non-surrogate', `{"code":"busy","message":"${BS}ud83d${BS}u0041"}`],
    ['a raw control character', `{"code":"busy","message":"a${String.fromCharCode(1)}b"}`],
    ['an unknown escape', `{"code":"busy","message":"${BS}x41"}`],
    ['a short unicode escape', `{"code":"busy","message":"${BS}u41"}`],
    ['a trailing comma', '{"code":"busy","message":"m",}'],
    ['a byte order mark', `${String.fromCharCode(0xfeff)}{"code":"busy","message":"m"}`],
    ['an empty object', '{}'],
    ['a null message', '{"code":"busy","message":null}'],
    ['an object message', '{"code":"busy","message":{}}'],
    ['a duplicate message', '{"code":"busy","message":"a","message":"b"}'],
    ['an unterminated string', '{"code":"busy","message":"m}'],
    ['single quotes', "{'code':'busy','message':'m'}"],
  ])('refuses %s', (_label, json) => {
    expect(decodeAbort(json)).toBe('abort_payload');
  });
});

describe('the stream encoders', () => {
  test('refuse what a decoder would', () => {
    expect(() => encodeAbort(1, 'deadline', 'm')).toThrow('abort_payload');
    expect(() => encodeStreamCredit(1, 2 ** 32)).toThrow(RangeError);
    expect(() => encodeData(2 ** 53, Buffer.from([1]))).toThrow('stream_id');
    expect(() => encodeEnd(1.5)).toThrow('stream_id');
  });

  test('an abort whose message holds a lone surrogate is refused; a pair round-trips', () => {
    const high = String.fromCharCode(0xd800);
    const low = String.fromCharCode(0xdc00);
    for (const message of [high, low, `a${high}`, `${low}b`, `${low}${high}`]) {
      expect(() => encodeAbort(7, 'internal', message)).toThrow('abort_payload');
    }
    const decoder = new FrameDecoder({ kinds: serviceKinds('receiver') });
    for (const message of [`${high}${low}`, String.fromCodePoint(0x1f680), `x${high}${low}y`]) {
      const [frame] = decoder.push(encodeAbort(7, 'internal', message));
      expect(frame).toEqual({ kind: KIND_ABORT, id: 7, code: 'internal', message });
    }
  });

  test("an abort's JSON is what the service writes", () => {
    expect(encodeAbort(7, 'cancelled', 'Cancelled').subarray(13).toString()).toBe(
      '{"code":"cancelled","message":"Cancelled"}'
    );
  });
});

describe("main's outbox", () => {
  const decodeAll = (frames) => {
    const decoder = new FrameDecoder({ kinds: serviceKinds('sender') });
    return frames.flatMap((frame) => decoder.push(frame));
  };
  const drain = (outbox) => {
    const out = [];
    for (let frame = outbox.next(); frame; frame = outbox.next()) out.push(frame);
    return decodeAll(out);
  };

  test("merges a stream's unwritten credit, in the order the streams first had some", () => {
    const outbox = new StreamOutbox();
    outbox.credit(5, 100);
    outbox.credit(3, 1);
    outbox.credit(5, 200);
    expect(outbox.size).toBe(2);
    expect(drain(outbox)).toEqual([
      { kind: KIND_STREAM_CREDIT, id: 5, credit: 300 },
      { kind: KIND_STREAM_CREDIT, id: 3, credit: 1 },
    ]);
    expect(outbox.size).toBe(0);
  });

  test("a cancel drops its stream's unwritten credit, and is queued once", () => {
    const outbox = new StreamOutbox();
    outbox.credit(5, 100);
    outbox.credit(6, 7);
    outbox.cancel(5);
    outbox.cancel(5);
    expect(outbox.size).toBe(2);
    expect(drain(outbox)).toEqual([
      { kind: KIND_STREAM_CREDIT, id: 6, credit: 7 },
      { kind: 0x01, message: { type: 'cancel', id: 5 } },
    ]);
  });

  test('a merged credit past a u32 goes in more than one frame', () => {
    const outbox = new StreamOutbox();
    outbox.credit(5, 2 ** 32 - 1);
    outbox.credit(5, 2);
    expect(drain(outbox)).toEqual([
      { kind: KIND_STREAM_CREDIT, id: 5, credit: 2 ** 32 - 1 },
      { kind: KIND_STREAM_CREDIT, id: 5, credit: 2 },
    ]);
  });

  test('refuses what is not a credit or a stream', () => {
    const outbox = new StreamOutbox();
    expect(() => outbox.credit(5, 0)).toThrow('credit_zero');
    expect(() => outbox.credit(0, 1)).toThrow('stream_id');
    expect(() => outbox.cancel(-1)).toThrow('stream_id');
    expect(outbox.next()).toBeNull();
  });

  test('cancels are 0001 cancel messages', () => {
    const outbox = new StreamOutbox();
    outbox.cancel(9);
    expect(outbox.next()).toEqual(encodeFrame({ type: 'cancel', id: 9 }));
  });
});

describe("main's receiver", () => {
  test('a protocol error fails it for good, and every record goes', () => {
    const receiver = new StreamReceiver();
    receiver.request(5);
    receiver.request(6);
    let error;
    try {
      receiver.receive({ kind: 0x03, id: 5 });
    } catch (err) {
      error = err;
    }
    expect(error.category).toBe('stream_not_open');
    expect(() => receiver.reply(6, true)).toThrow(error);
    expect(() => receiver.request(7)).toThrow(error);
    expect(receiver.outstanding()).toBe(0);
    expect(receiver.failed).toBe(error);
  });

  test("main's own request order is its bug, not the connection's", () => {
    const receiver = new StreamReceiver();
    receiver.request(5);
    expect(() => receiver.request(5)).toThrow('request_order');
    expect(receiver.failed).toBeNull();
    receiver.request(6);
    expect(receiver.outstanding()).toBe(2);
  });
});

/** Runs `fn`; a FrameError becomes its category. */
function category(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof FrameError) return err.category;
    throw err;
  }
}

describe('abort codes by connection and direction (design 0009)', () => {
  test("every code decodes, in fc-protocol's order, and each set is the design's", () => {
    expect([...ABORT_CODES]).toEqual([
      'cancelled',
      'internal',
      'body_stream_error',
      'stopped',
      'busy',
      'verification_failed',
      'unverifiable',
      'malformed',
      'piece_failed',
      'stalled',
    ]);
    expect([...SERVICE_ABORT_CODES]).toEqual([
      'cancelled',
      'internal',
      'body_stream_error',
      'stopped',
      'busy',
    ]);
    expect([...CORE_BODY_ABORT_CODES].sort()).toEqual([
      'busy',
      'cancelled',
      'malformed',
      'piece_failed',
      'unverifiable',
      'verification_failed',
    ]);
    expect([...PIECE_ABORT_CODES].sort()).toEqual(['body_stream_error', 'cancelled', 'stalled']);
    const decoder = new FrameDecoder({ kinds: serviceKinds('receiver') });
    for (const code of ABORT_CODES) {
      expect(decoder.push(encodeAbort(7, code, 'm'))).toEqual([
        { kind: KIND_ABORT, id: 7, code, message: 'm' },
      ]);
    }
  });

  test.each([
    ["a service's body", undefined, SERVICE_ABORT_CODES],
    ["the core's verified body", CORE_BODY_ABORT_CODES, CORE_BODY_ABORT_CODES],
    ["a piece main sends (the core's side)", PIECE_ABORT_CODES, PIECE_ABORT_CODES],
  ])('a receiver of %s takes its codes; any other is abort_code', (_label, codes, allowed) => {
    for (const code of ABORT_CODES) {
      const receiver = new StreamReceiver(codes && { codes });
      receiver.request(1);
      receiver.reply(1, true);
      const got = category(() => receiver.receive({ kind: KIND_ABORT, id: 1, code, message: 'm' }));
      if (allowed.has(code)) {
        expect([code, got]).toEqual([code, { type: 'abort', id: 1, code, message: 'm' }]);
      } else {
        expect([code, got]).toEqual([code, 'abort_code']);
        expect(receiver.failed.category).toBe('abort_code');
      }
    }
  });

  test('the code is checked before the ID, as fc-protocol checks it', () => {
    const receiver = new StreamReceiver();
    expect(
      category(() => receiver.receive({ kind: KIND_ABORT, id: 9, code: 'stalled', message: 'm' }))
    ).toBe('abort_code');
    const retiring = new StreamReceiver({ codes: CORE_BODY_ABORT_CODES });
    retiring.request(1);
    retiring.cancel(1);
    retiring.reply(1, true);
    expect(
      category(() => retiring.receive({ kind: KIND_ABORT, id: 1, code: 'internal', message: 'm' }))
    ).toBe('abort_code');
  });

  test("a sender refuses a code outside its streams' set, and the stream stays open", () => {
    for (const [codes, allowed] of [
      [undefined, SERVICE_ABORT_CODES],
      [PIECE_ABORT_CODES, PIECE_ABORT_CODES],
      [CORE_BODY_ABORT_CODES, CORE_BODY_ABORT_CODES],
    ]) {
      for (const code of ABORT_CODES) {
        const sender = new StreamSender(codes && { codes });
        sender.request(1);
        sender.head(1, Buffer.from('{}'), true);
        if (allowed.has(code)) {
          expect([code, sender.abort(1, code)]).toEqual([code, 'ok']);
        } else {
          expect([code, sender.abort(1, code)]).toEqual([code, { refused: 'code' }]);
          expect(sender.room(1)).toBe(128 * 1024);
        }
      }
    }
  });
});

describe("the core's connection at protocol 2", () => {
  test('its kinds are all four stream frames both ways, with fragments; protocol 1 takes none', () => {
    expect(CORE_STREAM_KINDS).toEqual({ fragments: true, streams: 'both' });
    const frames = [encodeData(7, Buffer.from([1])), encodeEnd(7), encodeAbort(7, 'busy', 'm')];
    frames.push(encodeStreamCredit(7, 5));
    const decoder = new FrameDecoder({ kinds: CORE_STREAM_KINDS });
    expect(decoder.push(Buffer.concat(frames)).map((frame) => frame.kind)).toEqual([
      KIND_DATA,
      KIND_END,
      KIND_ABORT,
      KIND_STREAM_CREDIT,
    ]);
    for (const frame of frames) {
      expect(category(() => new FrameDecoder({ kinds: CORE_KINDS }).push(frame))).toBe(
        'unknown_kind'
      );
    }
  });

  test("main's duplex: the core's verified bodies' codes in, a piece's out", () => {
    const duplex = new StreamDuplex();
    duplex.ask(3);
    duplex.answered(3, true);
    expect(
      duplex.receive({ kind: KIND_ABORT, id: 3, code: 'verification_failed', message: 'm' })
    ).toMatchObject({ type: 'abort', code: 'verification_failed' });
    duplex.request(3);
    duplex.sender.head(3, Buffer.from('{}'), true);
    expect(duplex.sender.abort(3, 'verification_failed')).toEqual({ refused: 'code' });
    expect(duplex.sender.abort(3, 'stalled')).toBe('ok');
  });

  test('credit goes to the bodies main sends, data to those it receives; one number may name both', () => {
    const duplex = new StreamDuplex();
    duplex.request(7); // the core's request 7
    duplex.ask(7); // main's request 7
    duplex.sender.head(7, Buffer.from('{}'), true);
    duplex.sender.push(7, Buffer.alloc(10));
    duplex.answered(7, true);
    expect(duplex.receive({ kind: KIND_DATA, id: 7, bytes: Buffer.alloc(4) })).toEqual({
      type: 'data',
      id: 7,
      length: 4,
    });
    expect(duplex.receive({ kind: KIND_STREAM_CREDIT, id: 7, credit: 10 })).toEqual({
      type: 'credit',
      id: 7,
      result: 'taken',
    });
  });

  test("a protocol error in either direction fails both; main's own request order doesn't", () => {
    const duplex = new StreamDuplex();
    duplex.ask(2);
    expect(category(() => duplex.ask(2))).toBe('request_order');
    expect(duplex.failed).toBeNull();
    duplex.request(4);
    duplex.sender.head(4, Buffer.from('{}'), true);
    duplex.sender.push(4, Buffer.alloc(10));
    expect(category(() => duplex.receive({ kind: KIND_STREAM_CREDIT, id: 4, credit: 11 }))).toBe(
      'credit_overgrant'
    );
    expect(duplex.receiver.failed.category).toBe('credit_overgrant');
    expect(category(() => duplex.answered(2, true))).toBe('credit_overgrant');
    expect(duplex.sender.push(4, Buffer.alloc(1))).toEqual({ refused: 'closed' });
    expect(duplex.nextFrame()).toBeNull();
    expect(duplex.pull(2, 10)).toBeNull();
    expect(duplex.withdraw(2)).toBe('nothing');
  });

  test("owed credit goes first, merges while unwritten, and goes at the stream's terminal", () => {
    const duplex = new StreamDuplex();
    duplex.request(1);
    duplex.sender.head(1, Buffer.from('{}'), true);
    for (const id of [2, 3]) {
      duplex.ask(id);
      duplex.answered(id, true);
      duplex.receive({ kind: KIND_DATA, id, bytes: Buffer.alloc(100) });
      duplex.pull(id, 40);
      duplex.pull(id, 60);
    }
    expect(duplex.owed()).toBe(2);
    duplex.receive({ kind: KIND_END, id: 3 });
    expect(duplex.owed()).toBe(1);
    const wrote = [];
    for (let next = duplex.nextFrame(); next; next = duplex.nextFrame()) wrote.push(next.wrote);
    expect(wrote).toEqual([
      { type: 'credit', id: 2, credit: 100 },
      { type: 'head', id: 1 },
    ]);
  });
});
