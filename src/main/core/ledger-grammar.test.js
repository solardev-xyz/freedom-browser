/**
 * Main's APDU grammar on its own (ledger-grammar.js; freedom-core design
 * 0016, The APDU grammar, Bounds; LDG-3's PR 1): the paths, the parents that
 * open an operation, each stream's pieces and refusals, the typed-data
 * stream's shape, and the rules the vectors' forbidden APDUs don't reach
 * (one APDU at a time, an answer that ends the operation, the parent's end,
 * a refusal's aftermath, the hash-only gate's every turn). Runs without the
 * core's vectors; ledger-grammar.vectors.test.js holds the module to them.
 */

const {
  Admission,
  GrammarError,
  HEADERS,
  MAX_INDEX,
  ROWS,
  apdu,
  checkedRecords,
  encodePath,
  operationOf,
  parsePath,
  pathBytes,
  transactionPieceSize,
} = require('./ledger-grammar');

const LIVE_0 = "44'/60'/0'/0/0";
const LEGACY_3 = "44'/60'/0'/3";
const KEY = { kind: 'ledger', index: 1000000 };
const OK = { answer: Buffer.from('9000', 'hex') };
const SIX_D = Buffer.from('6d00', 'hex');
const P = pathBytes(LIVE_0);

const hex = (text) => Buffer.from(text, 'hex');

/** The GrammarError's deviation a build throws, or the build when it doesn't. */
function deviationOf(options) {
  try {
    return new Admission(options);
  } catch (err) {
    if (err instanceof GrammarError) return err.deviation;
    throw err;
  }
}

/** Admits and answers each of `apdus` in turn; the verdicts. */
function play(admission, apdus, answer = () => OK) {
  return apdus.map((bytes, i) => {
    const verdict = admission.admit(bytes);
    if (!verdict.rule) admission.answered(answer(i));
    return verdict;
  });
}

const TYPED_APDUS = [
  apdu(HEADERS.typeName, Buffer.from('EIP712Domain')),
  apdu(HEADERS.typeField, Buffer.from('0504name', 'latin1')),
  apdu(HEADERS.typeName, Buffer.from('Mail')),
  apdu(HEADERS.typeField, Buffer.from('0508contents', 'latin1')),
  apdu(HEADERS.root, Buffer.from('EIP712Domain')),
  apdu(HEADERS.valueLast, Buffer.from('\x00\x02hi', 'latin1')),
  apdu(HEADERS.root, Buffer.from('Mail')),
  apdu(HEADERS.valueMore, Buffer.alloc(255, 0x61)),
  apdu(HEADERS.valueLast, Buffer.from('aa', 'latin1')),
];
const DOMAIN_SEPARATOR = Buffer.alloc(32, 0x11);
const STRUCT_HASH = Buffer.alloc(32, 0x22);

function typed(overrides = {}) {
  return {
    operation: 'sign.typed_data',
    path: LIVE_0,
    params: { key: KEY },
    typedData: {
      apdus: TYPED_APDUS,
      domainSeparator: DOMAIN_SEPARATOR,
      structHash: STRUCT_HASH,
      ...overrides,
    },
  };
}
const HEAD = [apdu(HEADERS.address, P), apdu(HEADERS.app)];
const SIGN = apdu(HEADERS.signFields, P);
const HASH_ONLY = apdu(HEADERS.signHashes, Buffer.concat([P, DOMAIN_SEPARATOR, STRUCT_HASH]));

describe('paths (deviation path-strict)', () => {
  test("parsePath reads a scheme's text exactly, at both ends of the index", () => {
    expect(parsePath(LIVE_0)).toStrictEqual({ scheme: 'live', index: 0 });
    expect(parsePath("44'/60'/2147483647'/0/0")).toStrictEqual({
      scheme: 'live',
      index: MAX_INDEX,
    });
    expect(parsePath("44'/60'/0'/0")).toStrictEqual({ scheme: 'legacy', index: 0 });
    expect(parsePath("44'/60'/0'/2147483647")).toStrictEqual({
      scheme: 'legacy',
      index: MAX_INDEX,
    });
  });

  test.each([
    ["44'/60'/01'/0/0", 'a leading zero'],
    ["44'/60'/2147483648'/0/0", 'an index of 2^31'],
    ["44'/60'/0'/2147483648", 'a legacy index of 2^31'],
    ["44'/60'/99999999999'/0/0", 'eleven digits'],
    ["m/44'/60'/0'/0/0", 'an m/ prefix'],
    ['44h/60h/0h/0/0', 'h for hardened'],
    ["44'/60'/0'/0/1", 'another address index'],
    ["44'/60'/0'/0'", 'a hardened legacy index'],
    ["44'/60'/1'/0", 'a legacy path under another account'],
    ["44'/60'/0'", 'three elements'],
    ["44'/60'/0'/0/0/0", 'six elements'],
    ["44'/61'/0'/0/0", 'another coin'],
    ['', 'nothing'],
  ])('parsePath refuses %s (%s)', (text) => {
    expect(parsePath(text)).toBeNull();
    expect(() => pathBytes(text)).toThrow(GrammarError);
  });

  test('parsePath refuses what is not a string', () => {
    for (const value of [null, undefined, 0, {}, ["44'/60'/0'/0/0"]]) {
      expect(parsePath(value)).toBeNull();
    }
  });

  test('P: the number of elements, then each big-endian, 0x80000000 set when hardened', () => {
    expect(pathBytes(LIVE_0).toString('hex')).toBe('058000002c8000003c800000000000000000000000');
    expect(pathBytes(LEGACY_3).toString('hex')).toBe('048000002c8000003c8000000000000003');
    expect(encodePath({ scheme: 'live', index: MAX_INDEX }).toString('hex')).toBe(
      '058000002c8000003cffffffff0000000000000000'
    );
    expect(() => encodePath({ scheme: 'live', index: MAX_INDEX + 1 })).toThrow(GrammarError);
    expect(() => encodePath({ scheme: 'ledger', index: 0 })).toThrow(GrammarError);
    expect(() => encodePath({ scheme: 'live', index: 1.5 })).toThrow(GrammarError);
  });

  test("checkedRecords: account-checks.js's records at a scheme's path, the first 20", () => {
    const record = (i, extra = {}) => ({ path: `44'/60'/${i}'/0/0`, address: `0x${i}`, ...extra });
    expect(
      checkedRecords([
        record(1),
        { address: '0x2' },
        record(3, { path: '' }),
        record(4, { address: null }),
        record(5, { path: "44'/60'/0'/0/1" }),
        record(6),
        null,
      ]).map((r) => r.path)
    ).toStrictEqual(["44'/60'/1'/0/0", "44'/60'/6'/0/0"]);
    const many = Array.from({ length: 25 }, (_, i) => record(i));
    expect(checkedRecords(many)).toStrictEqual(many.slice(0, 20));
    expect(checkedRecords(undefined)).toStrictEqual([]);
  });
});

describe('the parents that open an operation', () => {
  test('a Ledger key, discovery, adding and the Ledger form of x402.settle open one', () => {
    expect(operationOf('ledger.accounts', { scheme: 'live', start: 0, count: 1 })).toBe(
      'ledger.accounts'
    );
    expect(operationOf('ledger.add', { scheme: 'live', index: 0 })).toBe('ledger.add');
    for (const method of ['sign.transaction', 'sign.message', 'sign.typed_data']) {
      expect(operationOf(method, { key: KEY })).toBe(method);
    }
    expect(operationOf('x402.settle', { reservation: 'r', typed_data: {} })).toBe('x402.settle');
  });

  test("a vault key's sign.*, x402.settle's other forms, the Safe owners' rows until SAFE-3 and any other method open none", () => {
    for (const method of ['sign.transaction', 'sign.message', 'sign.typed_data']) {
      expect(operationOf(method, { key: { kind: 'account', index: 0 } })).toBeNull();
      expect(operationOf(method, {})).toBeNull();
      expect(operationOf(method, undefined)).toBeNull();
    }
    expect(operationOf('x402.settle', { reservation: 'r', signature: '0x' })).toBeNull();
    expect(operationOf('x402.settle', { reservation: 'r', outcome: 'withheld' })).toBeNull();
    expect(operationOf('safe.sign_owner', { safe: 1, owner: 1000000 })).toBeNull();
    expect(operationOf('safe.message_sign', { safe: 1, session: 's', owner: 1000000 })).toBeNull();
    expect(operationOf('sign.soc', { key: KEY })).toBeNull();
    expect(() => new Admission({ operation: 'safe.sign_owner', path: LIVE_0 })).toThrow(
      'No Ledger operation'
    );
  });
});

describe('the streams', () => {
  test("HEADERS are the rows' headers", () => {
    const headers = new Set(
      ROWS.flatMap((r) => (Array.isArray(r.apdus) ? r.apdus.map((a) => a.header) : []))
    );
    expect(new Set(Object.values(HEADERS).map((h) => h.toString('hex')))).toStrictEqual(headers);
    expect(Object.isFrozen(ROWS[0].apdus[0])).toBe(true);
  });

  test("discovery: the scheme's paths from start, then main's records; none waits", () => {
    const admission = new Admission({
      operation: 'ledger.accounts',
      params: { scheme: 'legacy', start: 2, count: 2 },
      records: [{ path: LIVE_0, address: '0xa' }],
    });
    expect(admission.expected.map((b) => b.toString('hex'))).toStrictEqual([
      'e002000011048000002c8000003c8000000000000002',
      'e002000011048000002c8000003c8000000000000003',
      'e002000015058000002c8000003c800000000000000000000000',
    ]);
    expect(play(admission, admission.expected)).toStrictEqual(
      Array(3).fill({ row: 'ledger.accounts', waits: false })
    );
  });

  test.each([
    [{ scheme: 'other', start: 0, count: 1 }, 'params'],
    [{ scheme: 'live', start: 0, count: 0 }, 'params'],
    [{ scheme: 'live', start: 0, count: 21 }, 'params'],
    [{ scheme: 'live', start: -1, count: 1 }, 'params'],
    [{ scheme: 'live', start: '0', count: 1 }, 'params'],
    [{ scheme: 'live', start: MAX_INDEX, count: 2 }, 'path-strict'],
  ])('discovery refuses %j (%s)', (params, deviation) => {
    expect(deviationOf({ operation: 'ledger.accounts', params })).toBe(deviation);
  });

  test('discovery takes 20 paths and starts as high as the last index allows', () => {
    const at = (start, count) =>
      new Admission({ operation: 'ledger.accounts', params: { scheme: 'live', start, count } });
    expect(at(0, 20).expected).toHaveLength(20);
    expect(at(MAX_INDEX, 1).expected[0].toString('hex')).toBe(
      'e002000015058000002c8000003cffffffff0000000000000000'
    );
  });

  test('adding: E0 02 01 00 P, the display on, waiting for the user', () => {
    const admission = new Admission({
      operation: 'ledger.add',
      params: { scheme: 'legacy', index: 3, name: 'L' },
    });
    expect(admission.expected).toStrictEqual([apdu(HEADERS.addressDisplay, pathBytes(LEGACY_3))]);
    expect(play(admission, admission.expected)).toStrictEqual([{ row: 'ledger.add', waits: true }]);
    expect(
      deviationOf({ operation: 'ledger.add', params: { scheme: 'live', index: MAX_INDEX + 1 } })
    ).toBe('path-strict');
    expect(deviationOf({ operation: 'ledger.add', params: { path: LIVE_0 } })).toBe('path-strict');
  });

  test("a signature's path is the record's text, a scheme's only", () => {
    const options = { operation: 'sign.message', params: { key: KEY, message: '0x01' } };
    expect(deviationOf({ ...options, path: "44'/60'/0'/0/1" })).toBe('path-strict');
    expect(deviationOf({ ...options, path: undefined })).toBe('path-strict');
  });

  test.each([
    [LIVE_0, 125, 1],
    [LIVE_0, 126, 2],
    [LIVE_0, 275, 2],
    [LIVE_0, 276, 3],
    [LEGACY_3, 129, 1],
    [LEGACY_3, 130, 2],
  ])('a message at %s of %i bytes goes in %i pieces, the last waiting', (path, length, pieces) => {
    const admission = new Admission({
      operation: 'sign.message',
      path,
      params: { key: KEY, message: '0x' + '5a'.repeat(length) },
    });
    const stream = admission.expected;
    expect(stream).toHaveLength(2 + pieces);
    expect(stream[2].subarray(0, 4)).toStrictEqual(HEADERS.messageFirst);
    expect(stream[2][4]).toBe(Math.min(150, pathBytes(path).length + 4 + length));
    const at = 5 + pathBytes(path).length;
    expect(stream[2].subarray(at, at + 4).readUInt32BE()).toBe(length);
    const verdicts = play(admission, stream);
    expect(verdicts.map((v) => v.waits)).toStrictEqual([
      false,
      false,
      ...Array.from({ length: pieces }, (_, k) => k === pieces - 1),
    ]);
  });

  test.each([
    ['0x', 'empty-message'],
    ['0x0', 'params'],
    ['01', 'params'],
    ['0xzz', 'params'],
    [undefined, 'params'],
  ])('a message %j is refused (%s)', (message, deviation) => {
    expect(
      deviationOf({ operation: 'sign.message', path: LIVE_0, params: { key: KEY, message } })
    ).toBe(deviation);
  });

  test("transactionPieceSize: 255, but a legacy one's last piece never as short as rlp(chainId, 0, 0)", () => {
    const legacy = (chain) => ({ type: 0, chain_id: chain });
    expect(transactionPieceSize(255, legacy('1'))).toBe(255);
    expect(transactionPieceSize(258, { type: 2, chain_id: '1' })).toBe(255);
    expect(transactionPieceSize(510, legacy('1'))).toBe(255);
    expect(transactionPieceSize(259, legacy('1'))).toBe(255);
    // rlp(1) ‖ 80 ‖ 80 is 3 bytes: a last piece of 3 is one a legacy transaction could end at.
    expect(transactionPieceSize(258, legacy('1'))).toBe(254);
    expect(transactionPieceSize(256, legacy('1'))).toBe(252);
    // rlp(2^64) is 10 bytes, so 12.
    expect(transactionPieceSize(267, legacy('18446744073709551616'))).toBe(254);
    expect(transactionPieceSize(268, legacy('18446744073709551616'))).toBe(255);
  });

  const TX = {
    type: 2,
    chain_id: '100',
    nonce: '7',
    gas_limit: '21000',
    to: '0x8ba1f109551bD432803012645Ac136ddd64DBA72',
    value: '1',
    data: '0x',
    max_fee_per_gas: '2',
    max_priority_fee_per_gas: '1',
  };

  test("a transaction: P ‖ T, T ethers' unsigned serialization, the last piece waiting", () => {
    const admission = new Admission({
      operation: 'sign.transaction',
      path: LIVE_0,
      params: { key: KEY, tx: TX },
    });
    const stream = admission.expected;
    expect(stream).toHaveLength(3);
    expect(stream[2].toString('hex')).toBe(
      'e004000036' +
        '058000002c8000003c800000000000000000000000' +
        '02df6407010282520894' +
        '8ba1f109551bd432803012645ac136ddd64dba72' +
        '0180c0'
    );
    expect(play(admission, stream).map((v) => v.waits)).toStrictEqual([false, false, true]);
  });

  test.each([
    [{ type: 1 }, 'type 1'],
    [{ type: '2' }, 'a type that is a string'],
    [{ chain_id: '0' }, 'chain 0'],
    [{ chain_id: '0x64' }, 'a hex chain ID'],
    [{ nonce: '07' }, 'a leading zero'],
    [{ nonce: '9007199254740992' }, "a nonce ethers can't serialize"],
    [{ value: undefined }, 'no value'],
    [{ max_fee_per_gas: undefined }, 'no fee'],
    [{ to: '0x1234' }, 'a short address'],
  ])('a transaction with %j is refused (%s)', (change) => {
    expect(
      deviationOf({
        operation: 'sign.transaction',
        path: LIVE_0,
        params: { key: KEY, tx: { ...TX, ...change } },
      })
    ).toBe('params');
  });

  test("typed data: the head, the binding's stream, then E0 0C 00 01 P, which waits", () => {
    const admission = new Admission(typed());
    expect(admission.expected).toStrictEqual([...HEAD, ...TYPED_APDUS, SIGN]);
    expect(play(admission, admission.expected)).toStrictEqual([
      { row: 'signature.first', waits: false },
      { row: 'signature.second', waits: false },
      ...Array(4).fill({ row: 'sign.typed_data.definitions', waits: false }),
      ...Array(5).fill({ row: 'sign.typed_data.values', waits: false }),
      { row: 'sign.typed_data.sign', waits: true },
    ]);
    expect(new Admission({ ...typed(), operation: 'x402.settle' }).expected).toStrictEqual(
      admission.expected
    );
  });

  test.each([
    [{ apdus: [] }, 'no APDUs'],
    [{ apdus: undefined }, 'no list'],
    [{ apdus: TYPED_APDUS.slice(1) }, 'a first APDU that is no type name'],
    [{ apdus: [...TYPED_APDUS, TYPED_APDUS[0]] }, 'a definition after the values'],
    [{ apdus: [TYPED_APDUS[0], apdu(HEADERS.signFields, P)] }, 'an E0 0C of its own'],
    [{ apdus: [TYPED_APDUS[0], apdu(HEADERS.address, P)] }, 'an address check of its own'],
    [{ apdus: [TYPED_APDUS[0], hex('e01c00ff0300')] }, 'an Lc past the data'],
    [{ apdus: [TYPED_APDUS[0], 'e01c00ff0100'] }, 'hex, not bytes'],
    [{ domainSeparator: Buffer.alloc(31) }, 'a short domain separator'],
    [{ structHash: '0x' + '22'.repeat(32) }, 'a hash as text'],
  ])('a typed-data stream with %# is refused (%s)', (overrides) => {
    expect(deviationOf(typed(overrides))).toBe('typed-data-stream');
  });

  test('apdu() frames its data and refuses more than 255 bytes', () => {
    expect(apdu(HEADERS.app).toString('hex')).toBe('b001000000');
    expect(apdu(HEADERS.root, Buffer.alloc(255))).toHaveLength(260);
    expect(() => apdu(HEADERS.root, Buffer.alloc(256))).toThrow(GrammarError);
  });
});

describe('the Admission', () => {
  const message = () =>
    new Admission({
      operation: 'sign.message',
      path: LIVE_0,
      params: { key: KEY, message: '0x' + '01'.repeat(200) },
    });

  test('one APDU at a time: the next before the answer is out of order', () => {
    const admission = message();
    const [first, second] = admission.expected;
    expect(admission.admit(first)).toStrictEqual({ row: 'signature.first', waits: false });
    expect(admission.admit(second)).toStrictEqual({ rule: 'order' });
    expect(admission.admit(second)).toStrictEqual({ rule: 'ended' });
  });

  test('an answer with no APDU in flight is the relay fault it is', () => {
    const admission = message();
    expect(() => admission.answered(OK)).toThrow('No APDU of this parent awaits an answer');
  });

  test.each([
    [{ answer: hex('6985') }, 'a rejection'],
    [{ answer: hex('6d00') }, '6D00 outside the gate'],
    [{ answer: hex('90') }, 'a short answer'],
    [{ answer: '9000' }, 'text, not bytes'],
    [{ failed: 'disconnected' }, 'a failure'],
    [null, 'a cancel'],
  ])('an answer of %j ends the operation (%s)', (reply) => {
    const admission = message();
    const [first, second] = admission.expected;
    admission.admit(first);
    admission.answered(reply);
    expect(admission.admit(second)).toStrictEqual({ rule: 'ended' });
  });

  test("the parent's end ends it, an APDU in flight or not", () => {
    for (const inFlight of [false, true]) {
      const admission = message();
      const [first, second] = admission.expected;
      if (inFlight) admission.admit(first);
      admission.end();
      expect(admission.admit(inFlight ? second : first)).toStrictEqual({ rule: 'ended' });
    }
  });

  test('after a refusal, every later APDU of the parent is ended, the right one too', () => {
    const admission = message();
    const [first] = admission.expected;
    expect(admission.admit(apdu(HEADERS.app))).toStrictEqual({ rule: 'order' });
    expect(admission.admit(first)).toStrictEqual({ rule: 'ended' });
  });

  test.each([
    [undefined, 'nothing'],
    ['e002000000', 'text'],
    [hex('e0020000'), 'four bytes'],
    [Buffer.concat([hex('e0020000ff'), Buffer.alloc(256)]), '261 bytes'],
    [hex('e002000016058000002c8000003c800000000000000000000000'), 'an Lc one more'],
    [hex('e002000014058000002c8000003c800000000000000000000000'), 'an Lc one less'],
  ])('%s is refused header (%s)', (bytes) => {
    expect(message().admit(bytes)).toStrictEqual({ rule: 'header' });
  });

  test('a Uint8Array is read as its bytes', () => {
    const admission = message();
    expect(admission.admit(new Uint8Array(admission.expected[0]))).toStrictEqual({
      row: 'signature.first',
      waits: false,
    });
  });

  test('a piece with other bytes is payload, the address check again count', () => {
    const admission = message();
    const stream = admission.expected;
    play(admission, stream.slice(0, 3));
    expect(admission.admit(apdu(HEADERS.messageMore, Buffer.alloc(51, 2)))).toStrictEqual({
      rule: 'payload',
    });
    const again = message();
    play(again, stream.slice(0, 3));
    expect(again.admit(stream[0])).toStrictEqual({ rule: 'count' });
  });

  describe('the hash-only gate (Q23)', () => {
    const toGate = () => {
      const admission = new Admission(typed());
      play(admission, HEAD);
      expect(admission.admit(TYPED_APDUS[0])).toStrictEqual({
        row: 'sign.typed_data.definitions',
        waits: false,
      });
      return admission;
    };

    test("only the first E0 1A's 6D00 can open it", () => {
      const admission = toGate();
      expect(admission.isHashOnlyAnswer(SIX_D)).toBe(true);
      expect(admission.isHashOnlyAnswer(hex('9000'))).toBe(false);
      expect(admission.isHashOnlyAnswer(hex('6d0000'))).toBe(false);
      expect(admission.isHashOnlyAnswer('6d00')).toBe(false);
      // Before the first E0 1A, and at the second.
      const early = new Admission(typed());
      early.admit(HEAD[0]);
      expect(early.isHashOnlyAnswer(SIX_D)).toBe(false);
      expect(() => early.answered({ answer: SIX_D, hashOnly: true })).toThrow('hash_only');
      const late = toGate();
      late.answered(OK);
      late.admit(TYPED_APDUS[1]);
      expect(late.isHashOnlyAnswer(SIX_D)).toBe(false);
      expect(() => late.answered({ answer: SIX_D, hashOnly: true })).toThrow('hash_only');
      // On another status.
      const other = toGate();
      expect(() => other.answered({ answer: hex('9000'), hashOnly: true })).toThrow('hash_only');
      // Nor anything in field mode.
      expect(new Admission(typed()).isHashOnlyAnswer(SIX_D)).toBe(false);
    });

    test('opened, the hash-only APDU is next, and waits; nothing after it', () => {
      const admission = toGate();
      admission.answered({ answer: SIX_D, hashOnly: true });
      expect(admission.expected).toStrictEqual([...HEAD, TYPED_APDUS[0], HASH_ONLY]);
      expect(admission.admit(HASH_ONLY)).toStrictEqual({ row: 'hash-only', waits: true });
      admission.answered(OK);
      expect(admission.admit(HASH_ONLY)).toStrictEqual({ rule: 'ended' });
    });

    test('opened, field mode goes no further: the next definition and E0 0C 00 01 are refused header', () => {
      for (const next of [TYPED_APDUS[1], SIGN]) {
        const admission = toGate();
        admission.answered({ answer: SIX_D, hashOnly: true });
        expect(admission.admit(next)).toStrictEqual({ rule: 'header' });
      }
    });

    test('opened, another path is path and other hashes payload', () => {
      const legacy = apdu(
        HEADERS.signHashes,
        Buffer.concat([pathBytes("44'/60'/1'/0/0"), DOMAIN_SEPARATOR, STRUCT_HASH])
      );
      const otherHash = apdu(
        HEADERS.signHashes,
        Buffer.concat([P, DOMAIN_SEPARATOR, Buffer.alloc(32, 0x23)])
      );
      for (const [bytes, rule] of [
        [legacy, 'path'],
        [otherHash, 'payload'],
      ]) {
        const admission = toGate();
        admission.answered({ answer: SIX_D, hashOnly: true });
        expect(admission.admit(bytes)).toStrictEqual({ rule });
      }
    });

    test('a 6D00 answered without hash_only ends the operation: the core ends it LEDGER_UNKNOWN', () => {
      const admission = toGate();
      admission.answered({ answer: SIX_D });
      expect(admission.admit(HASH_ONLY)).toStrictEqual({ rule: 'ended' });
    });

    test('while main holds the 6D00 for the warning, the hash-only APDU is out of order', () => {
      expect(toGate().admit(HASH_ONLY)).toStrictEqual({ rule: 'order' });
    });

    test('closed, the hash-only APDU is out of order wherever it comes, and the sign APDU too early', () => {
      const atSign = new Admission(typed());
      play(atSign, [...HEAD, ...TYPED_APDUS]);
      expect(atSign.admit(HASH_ONLY)).toStrictEqual({ rule: 'order' });
      const inValues = new Admission(typed());
      play(inValues, [...HEAD, ...TYPED_APDUS.slice(0, 5)]);
      expect(inValues.admit(HASH_ONLY)).toStrictEqual({ rule: 'order' });
      const early = new Admission(typed());
      play(early, [...HEAD, ...TYPED_APDUS.slice(0, 5)]);
      expect(early.admit(SIGN)).toStrictEqual({ rule: 'order' });
      // E0 0C 00 00 with only P isn't the hash-only APDU: the row has no such header there.
      const short = new Admission(typed());
      play(short, [...HEAD, ...TYPED_APDUS]);
      expect(short.admit(apdu(HEADERS.signHashes, P))).toStrictEqual({ rule: 'header' });
    });

    test('the sign APDU again after it is ended; a value byte changed is payload', () => {
      const admission = new Admission(typed());
      play(admission, [...HEAD, ...TYPED_APDUS, SIGN]);
      expect(admission.admit(SIGN)).toStrictEqual({ rule: 'ended' });
      const changed = Buffer.from(TYPED_APDUS[5]);
      changed[6] ^= 0x01;
      const byte = new Admission(typed());
      play(byte, [...HEAD, ...TYPED_APDUS.slice(0, 5)]);
      expect(byte.admit(changed)).toStrictEqual({ rule: 'payload' });
    });
  });
});
