/**
 * frame.js's stream frames beyond freedom-core's `vectors/streams.json`
 * (`stream-vectors.test.js`): the abort JSON's edges as serde reads them,
 * main's outbox, and a failure that sticks.
 */

const {
  encodeAbort,
  encodeData,
  encodeEnd,
  encodeFrame,
  encodeStreamCredit,
  serviceKinds,
  FrameDecoder,
  FrameError,
  StreamOutbox,
  StreamReceiver,
  KIND_ABORT,
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
