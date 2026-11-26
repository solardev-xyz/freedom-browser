/**
 * frame.js's stream frames beyond freedom-core's `vectors/streams.json`
 * (`stream-vectors.test.js`, which runs only with a freedom-core checkout):
 * the abort JSON's edges as serde reads them (design 0015's `error_code`
 * among them), main's outbox, a failure that sticks, the abort codes by
 * connection and direction (design 0009), the core's connection at
 * protocol 2 (`StreamDuplex`), the kinds of a service connection that
 * takes main's bodies (design 0014), and design 0015's codes per request
 * on main's duplex: the Swarm sets, `too_large` and an abort's error code.
 */

const {
  encodeAbort,
  encodeBegin,
  encodeCredit,
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
  CORE_UPLOAD_ABORT_CODES,
  PIECE_ABORT_CODES,
  SERVICE_ABORT_CODES,
  SWARM_PART_ABORT_CODES,
  SWARM_PIECE_ABORT_CODES,
  KIND_ABORT,
  KIND_DATA,
  KIND_END,
  KIND_JSON,
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
    const { code, message, errorCode } = frame;
    return errorCode === undefined ? { code, message } : { code, message, errorCode };
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

  // Design 0015: a part's abort may name the errno name its file failed
  // with, `^[A-Z][A-Z0-9_]{0,31}$`, once; fc-protocol's `is_error_code`.
  test.each([
    ['an error code', '{"code":"body_stream_error","message":"m","error_code":"EIO"}', 'EIO'],
    [
      'an escaped member name and value',
      `{"error${BS}u005fcode":"${BS}u0045NOENT","code":"body_stream_error","message":"m"}`,
      'ENOENT',
    ],
    [
      '32 bytes',
      `{"code":"cancelled","message":"m","error_code":"E${'_'.repeat(31)}"}`,
      `E${'_'.repeat(31)}`,
    ],
  ])('takes %s', (_label, json, errorCode) => {
    expect(decodeAbort(json)).toMatchObject({ errorCode });
  });

  test.each([
    ['33 bytes', `{"code":"body_stream_error","message":"m","error_code":"E${'X'.repeat(32)}"}`],
    ['a space in it', '{"code":"body_stream_error","message":"m","error_code":"E IO"}'],
    [
      'a non-ASCII letter',
      `{"code":"body_stream_error","message":"m","error_code":"${String.fromCharCode(0xc9)}IO"}`,
    ],
    ['a boolean', '{"code":"body_stream_error","message":"m","error_code":true}'],
    ['no code', '{"message":"m","error_code":"EIO"}'],
    ['no message', '{"code":"body_stream_error","error_code":"EIO"}'],
    ['another member', '{"code":"body_stream_error","message":"m","errno":"EIO"}'],
  ])('refuses an error code: %s', (_label, json) => {
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

  // Design 0015: as fc-protocol's `Abort::to_json` writes it, the error
  // code after the code and the message, and only of `is_error_code`'s form.
  test('an abort naming an error code writes it last, and it round-trips', () => {
    const frame = encodeAbort(7, 'body_stream_error', 'm', 'ENOENT');
    expect(frame.subarray(13).toString()).toBe(
      '{"code":"body_stream_error","message":"m","error_code":"ENOENT"}'
    );
    expect(new FrameDecoder({ kinds: CORE_STREAM_KINDS }).push(frame)).toEqual([
      { kind: KIND_ABORT, id: 7, code: 'body_stream_error', message: 'm', errorCode: 'ENOENT' },
    ]);
    const longest = `E${'_'.repeat(31)}`;
    expect(decodeAbort(encodeAbort(7, 'cancelled', 'm', longest).subarray(13).toString())).toEqual({
      code: 'cancelled',
      message: 'm',
      errorCode: longest,
    });
    for (const none of [undefined, null]) {
      expect(encodeAbort(7, 'cancelled', 'm', none)).toEqual(encodeAbort(7, 'cancelled', 'm'));
    }
  });

  test.each([
    ['empty', ''],
    ['lower case', 'enoent'],
    ['a leading digit', '1EIO'],
    ['33 bytes', `E${'X'.repeat(32)}`],
    ['a space', 'E IO'],
    ['a number', 5],
    ['an object', {}],
  ])('an error code that is not an errno name is refused: %s', (_label, errorCode) => {
    expect(() => encodeAbort(7, 'body_stream_error', 'm', errorCode)).toThrow('abort_payload');
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
      'too_large',
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

  // Design 0015: only a part main streams the core may name an error code,
  // and main receives none, so every receiver of main's refuses one, its
  // stream's own code or not, before the ID.
  test.each([
    ["a service's body", undefined, 'internal'],
    ["the core's verified body", CORE_BODY_ABORT_CODES, 'cancelled'],
    ["a piece main sends (the core's side)", PIECE_ABORT_CODES, 'body_stream_error'],
  ])('a receiver of %s takes no abort that names an error code', (_label, codes, code) => {
    const abort = { kind: KIND_ABORT, id: 1, code, message: 'm', errorCode: 'EIO' };
    const open = new StreamReceiver(codes && { codes });
    open.request(1);
    open.reply(1, true);
    expect(category(() => open.receive(abort))).toBe('abort_code');
    const retiring = new StreamReceiver(codes && { codes });
    retiring.request(1);
    retiring.cancel(1);
    retiring.reply(1, true);
    expect(category(() => retiring.receive(abort))).toBe('abort_code');
    expect(category(() => new StreamReceiver(codes && { codes }).receive(abort))).toBe(
      'abort_code'
    );
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

  test("bytes its producer reads ahead count against the writer's cap until released", () => {
    const sender = new StreamSender({ dataCap: 64 * 1024 });
    sender.request(1);
    sender.head(1, Buffer.from('{}'), true);
    expect(sender.room(1)).toBe(64 * 1024);
    sender.reserve(60 * 1024);
    expect(sender.room(1)).toBe(4 * 1024);
    // A push the cap would cut below 4 KiB takes nothing.
    sender.reserve(1);
    expect(sender.push(1, Buffer.alloc(8 * 1024))).toEqual({ taken: 0 });
    sender.release(60 * 1024 + 1);
    expect(sender.push(1, Buffer.alloc(8 * 1024))).toEqual({ taken: 8 * 1024 });
    expect(sender.room(1)).toBe(56 * 1024);
    // Never below nothing.
    sender.release(1);
    expect(sender.reserved).toBe(0);
  });

  test("a read's room is claimed from the writer's cap before it starts: no two reads count the same room", () => {
    const sender = new StreamSender({ dataCap: 160 * 1024 });
    for (const id of [1, 2, 3]) {
      sender.request(id);
      sender.head(id, Buffer.from('{}'), true);
    }
    // Up to `most`, as the window and the cap allow, reserved at once.
    expect(sender.claim(1, 64 * 1024)).toBe(64 * 1024);
    expect(sender.claim(2, 64 * 1024)).toBe(64 * 1024);
    expect(sender.reserved).toBe(128 * 1024);
    // The third gets what is left, and then nothing.
    expect(sender.claim(3, 64 * 1024)).toBe(32 * 1024);
    expect(sender.claim(3, 64 * 1024)).toBe(0);
    expect(sender.reserved).toBe(160 * 1024);
    // A claim the cap would cut below 4 KiB takes nothing; one that fits
    // whole below it does.
    sender.release(3 * 1024);
    expect(sender.claim(3, 64 * 1024)).toBe(0);
    expect(sender.claim(3, 2 * 1024)).toBe(2 * 1024);
    sender.release(sender.reserved);
    // `whole`: all of `most` from the cap, or nothing.
    sender.reserve(100 * 1024);
    expect(sender.claim(1, 64 * 1024, { whole: true })).toBe(0);
    sender.release(4 * 1024);
    expect(sender.claim(1, 64 * 1024, { whole: true })).toBe(64 * 1024);
    sender.release(sender.reserved);
    // The window bounds a claim; `whole` needs only some room in it.
    expect(sender.push(2, Buffer.alloc(120 * 1024))).toEqual({ taken: 120 * 1024 });
    expect(sender.claim(2, 64 * 1024)).toBe(8 * 1024);
    sender.release(8 * 1024);
    expect(sender.claim(2, 32 * 1024, { whole: true })).toBe(32 * 1024);
    sender.release(sender.reserved);
    expect(sender.push(2, Buffer.alloc(8 * 1024))).toEqual({ taken: 8 * 1024 });
    expect(sender.claim(2, 64 * 1024)).toBe(0);
    expect(sender.claim(2, 64 * 1024, { whole: true })).toBe(0);
    // No body that takes bytes: null, and nothing claimed.
    sender.finish(3);
    expect(sender.claim(3, 64 * 1024)).toBeNull();
    expect(sender.claim(9, 64 * 1024)).toBeNull();
    expect(sender.reserved).toBe(0);
  });
});

describe("the core's connection at protocol 2", () => {
  test('its kinds are all four stream frames both ways, with fragments; before the hello, none', () => {
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

  test("nextControl takes only what waits for nothing but the writer: main's cancels and credit, the sender's control entries, and an end whose bytes have gone", () => {
    const duplex = new StreamDuplex();
    for (const id of [1, 2, 3]) duplex.request(id);
    duplex.sender.head(1, Buffer.from('{}'), true);
    duplex.sender.head(2, Buffer.from('{}'), true);
    expect(duplex.nextFrame().wrote).toEqual({ type: 'head', id: 1 });
    expect(duplex.nextFrame().wrote).toEqual({ type: 'head', id: 2 });
    // 2's bytes are taken, then it ends; 1 ends with bytes still queued.
    duplex.sender.push(2, Buffer.alloc(10));
    expect(duplex.nextFrame().wrote).toEqual({ type: 'data', id: 2, length: 10 });
    duplex.sender.push(1, Buffer.alloc(10));
    duplex.sender.finish(1);
    duplex.sender.finish(2);
    duplex.sender.reply(3, Buffer.from('{}'));
    duplex.ask(4);
    expect(duplex.withdraw(4)).toBe('send_cancel');
    const wrote = [];
    for (let next = duplex.nextControl(); next; next = duplex.nextControl()) wrote.push(next.wrote);
    expect(wrote).toEqual([
      { type: 'cancel', id: 4 },
      { type: 'reply', id: 3 },
      { type: 'end', id: 2 },
    ]);
    // 1's bytes, then its end, are left to the writer.
    const rest = [];
    for (let next = duplex.nextFrame(); next; next = duplex.nextFrame()) rest.push(next.wrote);
    expect(rest).toEqual([
      { type: 'data', id: 1, length: 10 },
      { type: 'end', id: 1 },
    ]);
  });
});

describe("a service connection that takes main's bodies (design 0014, COL-3)", () => {
  test('either end takes all four stream frames, both ways, and still no fragments', () => {
    const kinds = serviceKinds('both');
    expect(kinds).toEqual({ fragments: false, streams: 'both' });
    const frames = [encodeData(7, Buffer.from([1])), encodeEnd(7), encodeAbort(7, 'busy', 'm')];
    frames.push(encodeStreamCredit(7, 5), encodeFrame({}));
    expect(
      new FrameDecoder({ kinds }).push(Buffer.concat(frames)).map((frame) => frame.kind)
    ).toEqual([KIND_DATA, KIND_END, KIND_ABORT, KIND_STREAM_CREDIT, KIND_JSON]);
    for (const frame of [encodeBegin(7, 10), encodeCredit()]) {
      expect(category(() => new FrameDecoder({ kinds }).push(frame))).toBe('unknown_kind');
    }
    expect(() => serviceKinds('main')).toThrow(TypeError);
  });
});

describe("design 0015's codes, per request, on main's duplex", () => {
  const abort = (id, code, errorCode) =>
    errorCode === undefined
      ? { kind: KIND_ABORT, id, code, message: 'm' }
      : { kind: KIND_ABORT, id, code, message: 'm', errorCode };

  test("the three Swarm sets are the design's, and every code in them decodes", () => {
    expect([...SWARM_PIECE_ABORT_CODES].sort()).toEqual([
      'body_stream_error',
      'cancelled',
      'stalled',
      'too_large',
    ]);
    expect([...SWARM_PART_ABORT_CODES].sort()).toEqual([
      'body_stream_error',
      'cancelled',
      'stalled',
    ]);
    expect([...CORE_UPLOAD_ABORT_CODES].sort()).toEqual([
      'body_stream_error',
      'cancelled',
      'internal',
    ]);
    // The part's set is its own: a set of the same codes names no error code.
    expect(SWARM_PART_ABORT_CODES).not.toBe(PIECE_ABORT_CODES);
    for (const codes of [
      SWARM_PIECE_ABORT_CODES,
      SWARM_PART_ABORT_CODES,
      CORE_UPLOAD_ABORT_CODES,
    ]) {
      for (const code of codes) expect(ABORT_CODES.has(code)).toBe(true);
    }
  });

  test("a body main sends ends with its request's codes, the duplex's a piece's by default", () => {
    const duplex = new StreamDuplex();
    const open = (id, sends) => {
      duplex.request(id, sends);
      expect(duplex.sender.head(id, Buffer.from('{}'), true)).toBe('ok');
    };
    open(1);
    open(2, SWARM_PIECE_ABORT_CODES);
    open(3, SWARM_PART_ABORT_CODES);
    expect(duplex.sender.abort(1, 'too_large')).toEqual({ refused: 'code' });
    expect(duplex.sender.abort(3, 'too_large')).toEqual({ refused: 'code' });
    expect(duplex.sender.abort(2, 'internal')).toEqual({ refused: 'code' });
    // Only a part's body_stream_error names an error code, an errno name.
    expect(duplex.sender.abort(1, 'body_stream_error', 'm', 'EIO')).toEqual({ refused: 'code' });
    expect(duplex.sender.abort(2, 'body_stream_error', 'm', 'EIO')).toEqual({ refused: 'code' });
    expect(duplex.sender.abort(3, 'stalled', 'm', 'EIO')).toEqual({ refused: 'code' });
    expect(duplex.sender.abort(3, 'body_stream_error', 'm', 'eio')).toEqual({ refused: 'code' });
    // Each refusal left its stream open.
    for (const id of [1, 2, 3]) expect(duplex.sender.room(id)).toBe(128 * 1024);
    expect(duplex.sender.abort(2, 'too_large', 'past max_bytes')).toBe('ok');
    expect(duplex.sender.abort(3, 'body_stream_error', 'm', 'EACCES')).toBe('ok');
    expect(duplex.sender.abort(1, 'stalled')).toBe('ok');
    const written = [];
    for (let next = duplex.nextFrame(); next; next = duplex.nextFrame()) {
      written.push([
        next.wrote,
        ...new FrameDecoder({ kinds: CORE_STREAM_KINDS }).push(next.bytes),
      ]);
    }
    const aborts = written.filter(([wrote]) => wrote.type === 'abort');
    expect(aborts).toEqual([
      [
        { type: 'abort', id: 2, code: 'too_large' },
        { kind: KIND_ABORT, id: 2, code: 'too_large', message: 'past max_bytes' },
      ],
      [
        { type: 'abort', id: 3, code: 'body_stream_error', errorCode: 'EACCES' },
        { kind: KIND_ABORT, id: 3, code: 'body_stream_error', message: 'm', errorCode: 'EACCES' },
      ],
      [
        { type: 'abort', id: 1, code: 'stalled' },
        { kind: KIND_ABORT, id: 1, code: 'stalled', message: 'aborted' },
      ],
    ]);
  });

  test('a request keeps its codes through its head, its cancel and its stream', () => {
    const duplex = new StreamDuplex();
    duplex.request(4, SWARM_PIECE_ABORT_CODES);
    // Before its head, a body's code is a code it may take: not open yet.
    expect(duplex.sender.abort(4, 'too_large')).toEqual({ refused: 'not_open' });
    duplex.sender.head(4, Buffer.from('{}'), true);
    expect(duplex.nextFrame().wrote).toEqual({ type: 'head', id: 4 });
    // Open, after its head was written.
    expect(duplex.sender.abort(4, 'internal')).toEqual({ refused: 'code' });
    expect(duplex.sender.abort(4, 'too_large')).toBe('ok');
    // Cancelled before its head: gone, by its own codes.
    duplex.request(5, SWARM_PIECE_ABORT_CODES);
    expect(duplex.cancel(5)).toBe('cancelled');
    expect(duplex.sender.abort(5, 'too_large')).toEqual({ refused: 'gone' });
    expect(duplex.sender.abort(5, 'internal')).toEqual({ refused: 'code' });
    // Once it has gone, the duplex's own codes.
    expect(duplex.sender.abort(9, 'too_large')).toEqual({ refused: 'code' });
    expect(duplex.sender.abort(9, 'stalled')).toEqual({ refused: 'unknown' });
  });

  test("a body main takes ends with its request's codes, the core's verified bodies' by default", () => {
    const duplex = new StreamDuplex({
      allTakes: [CORE_BODY_ABORT_CODES, CORE_UPLOAD_ABORT_CODES],
    });
    duplex.ask(1);
    duplex.ask(2, CORE_UPLOAD_ABORT_CODES);
    duplex.answered(1, true);
    duplex.answered(2, true);
    expect(duplex.receive(abort(2, 'internal'))).toEqual({
      type: 'abort',
      id: 2,
      code: 'internal',
      message: 'm',
    });
    expect(category(() => duplex.receive(abort(1, 'internal')))).toBe('abort_code');
    expect(duplex.failed.category).toBe('abort_code');

    // A retiring upload keeps its codes: dropped, not a protocol error.
    const retiring = new StreamDuplex();
    retiring.ask(3, CORE_UPLOAD_ABORT_CODES);
    expect(retiring.withdraw(3)).toBe('send_cancel');
    expect(retiring.answered(3, true)).toBe('retired');
    expect(retiring.receive(abort(3, 'internal'))).toEqual({ type: 'dropped', id: 3 });
    retiring.ask(4, CORE_UPLOAD_ABORT_CODES);
    retiring.answered(4, true);
    retiring.withdraw(4);
    expect(category(() => retiring.receive(abort(4, 'verification_failed')))).toBe('abort_code');
  });

  test('an abort with no record is checked against every set main takes, then its ID', () => {
    const takes = (allTakes) => {
      const duplex = new StreamDuplex(allTakes && { allTakes });
      duplex.ask(1);
      return duplex;
    };
    const both = [CORE_BODY_ABORT_CODES, CORE_UPLOAD_ABORT_CODES];
    expect(category(() => takes(both).receive(abort(9, 'internal')))).toBe('stream_unknown');
    expect(category(() => takes(both).receive(abort(9, 'piece_failed')))).toBe('stream_unknown');
    expect(category(() => takes(both).receive(abort(9, 'stalled')))).toBe('abort_code');
    expect(category(() => takes(both).receive(abort(9, 'body_stream_error', 'EIO')))).toBe(
      'abort_code'
    );
    // By default, the duplex's own set alone.
    expect(category(() => takes().receive(abort(9, 'internal')))).toBe('abort_code');
  });

  test("the core's side of a part: only its body_stream_error names an error code, which it delivers", () => {
    const receiver = new StreamReceiver({
      codes: PIECE_ABORT_CODES,
      allCodes: [PIECE_ABORT_CODES, SWARM_PIECE_ABORT_CODES, SWARM_PART_ABORT_CODES],
    });
    receiver.request(1, SWARM_PART_ABORT_CODES);
    receiver.reply(1, true);
    expect(receiver.receive(abort(1, 'body_stream_error', 'ENOENT'))).toEqual({
      type: 'abort',
      id: 1,
      code: 'body_stream_error',
      message: 'm',
      errorCode: 'ENOENT',
    });
    receiver.request(2, SWARM_PART_ABORT_CODES);
    receiver.reply(2, true);
    expect(category(() => receiver.receive(abort(2, 'stalled', 'ENOENT')))).toBe('abort_code');
    // No record: a part's codes take it, so its ID decides.
    const none = new StreamReceiver({
      codes: PIECE_ABORT_CODES,
      allCodes: [PIECE_ABORT_CODES, SWARM_PART_ABORT_CODES],
    });
    none.request(1);
    expect(category(() => none.receive(abort(7, 'body_stream_error', 'EIO')))).toBe(
      'stream_unknown'
    );
  });
});
