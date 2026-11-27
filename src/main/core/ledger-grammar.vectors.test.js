/**
 * Main's APDU grammar (ledger-grammar.js) against the pinned core's
 * `vectors/ledger-grammar.json` and `vectors/ledger.json` (freedom-core
 * design 0016, The APDU grammar: "the core's tests and main's relay suite
 * both read it"; LDG-3's PR 1):
 * - the rows, rules and bounds are the file's, as main ships them (plan
 *   point 1: JavaScript, checked here, never loaded at runtime);
 * - main's own stream for every honest non-typed case (discovery with its
 *   records, adding, transactions, messages) is the core's, byte for byte,
 *   and is admitted APDU by APDU, and nothing after it;
 * - every forbidden APDU, all 152, is refused by its rule;
 * - the piece-byte family: each byte of an `E0 04` or `E0 08` piece changed
 *   is `payload`, all of the file's count, or `path` for a byte of the first
 *   piece's `P`;
 * - the 2,048-APDU bound is the file's `bounds.apdus_per_operation`: a
 *   message, a transaction and a typed-data stream at it are admitted, one
 *   APDU past it refused before the first;
 * - typed data's honest streams are admitted around a stand-in for main's
 *   typed-data binding (test/helpers/ledger-vectors.js; the binding itself
 *   is PR 2's), so every row is reached as often as the file counts.
 *
 * Skipped unless the vectors are found (test/helpers/ledger-vectors.js):
 * FREEDOM_CORE_LEDGER_VECTORS names freedom-core's `vectors` directory, as
 * CI does at the pinned commit, and then a missing file fails the suite.
 */

const {
  Admission,
  BOUNDS,
  GrammarError,
  HEADERS,
  ROWS,
  RULES,
  apdu,
  checkedRecords,
  parsePath,
  pathBytes,
  unsignedTransaction,
} = require('./ledger-grammar');
const {
  admissionOptions,
  ledgerVectors,
  ledgerVectorsRequired,
  playForbidden,
  playHonest,
  typedHashes,
  unhex,
} = require('../../../test/helpers/ledger-vectors');

const grammar = ledgerVectors('ledger-grammar.json');
const ledger = ledgerVectors('ledger.json');
const found = Boolean(grammar && ledger);
const describeIfVectors = found ? describe : describe.skip;

(ledgerVectorsRequired ? test : test.skip)(
  'the vectors FREEDOM_CORE_LEDGER_VECTORS names are there',
  () => {
    expect(grammar?.honest?.length).toBeGreaterThan(0);
    expect(ledger?.cases?.length).toBeGreaterThan(0);
  }
);

describeIfVectors("main's APDU grammar against vectors/ledger-grammar.json", () => {
  const cases = new Map(found ? ledger.cases.map((c) => [c.id, c]) : []);
  const honest = new Map(found ? grammar.honest.map((e) => [e.case, e]) : []);
  const TYPED = 'sign.typed_data';
  const OK = { answer: Buffer.from('9000', 'hex') };

  test("the rows, rules and bounds are the file's", () => {
    expect(ROWS).toStrictEqual(grammar.rows);
    expect(RULES).toStrictEqual(grammar.rules);
    expect(BOUNDS).toStrictEqual(grammar.bounds);
  });

  test("every honest non-typed stream is main's own and is admitted, APDU by APDU, and nothing after it", () => {
    const refused = [];
    const played = {};
    for (const entry of grammar.honest.filter((e) => e.operation !== TYPED)) {
      const c = cases.get(entry.case);
      const built = new Admission(admissionOptions(c));
      const ours = built.expected.map((b) => b.toString('hex'));
      expect({ id: entry.case, apdus: ours }).toStrictEqual({ id: entry.case, apdus: entry.apdus });
      const { refused: verdict, rows, admission } = playHonest(c, entry);
      if (verdict) refused.push({ id: entry.case, ...verdict });
      expect(rows).toHaveLength(entry.apdus.length);
      const last = unhex(entry.apdus[entry.apdus.length - 1]);
      expect({ id: entry.case, after: admission.admit(last) }).toStrictEqual({
        id: entry.case,
        after: { rule: 'ended' },
      });
      played[entry.operation] = (played[entry.operation] || 0) + 1;
    }
    expect(refused).toStrictEqual([]);
    expect(played).toStrictEqual({
      'ledger.accounts': 15,
      'ledger.add': 3,
      'sign.transaction': 36,
      'sign.message': 11,
    });
  });

  test("discovery checks main's records after its paths: each discovery-records case's stream", () => {
    const records = grammar.honest.filter((e) => e.case.startsWith('discovery-records-'));
    expect(records.map((e) => e.case)).toStrictEqual([
      'discovery-records-mixed',
      'discovery-records-all-matched',
      'discovery-records-20',
      'discovery-records-21',
      'discovery-records-25',
      'discovery-records-path-outside-schemes',
      'discovery-records-core-fails',
    ]);
    for (const entry of records) {
      const c = cases.get(entry.case);
      // After the scheme's paths, main's list as checkedRecords picks it.
      const checks = checkedRecords(c.records).map((r) =>
        apdu(HEADERS.address, pathBytes(r.path)).toString('hex')
      );
      expect({ id: entry.case, checks }).toStrictEqual({
        id: entry.case,
        checks: entry.apdus.slice(c.request.count),
      });
      const rows = playHonest(c, entry).rows;
      expect(rows).toHaveLength(entry.apdus.length);
      expect(rows.every((r) => r.row === 'ledger.accounts' && r.waits === false)).toBe(true);
    }
    // The 25 records are checked to the 20th (check-bound), the outside path not at all.
    expect(cases.get('discovery-records-25').records.length).toBeGreaterThan(20);
    expect(honest.get('discovery-records-25').apdus).toHaveLength(22);
    expect(honest.get('discovery-records-path-outside-schemes').apdus).toHaveLength(3);
  });

  test('every row is reached as often as the file counts, typed data around the stand-in binding', () => {
    const reached = {};
    const refused = [];
    const add = (row, n) => {
      reached[row] = (reached[row] || 0) + n;
    };
    for (const entry of grammar.honest) {
      const c = cases.get(entry.case);
      const { rows, refused: verdict } = playHonest(c, entry);
      if (verdict) refused.push({ id: entry.case, ...verdict });
      for (const { row } of rows) add(row, 1);
      if (c.family === 'x402') add('x402.settle', rows.length);
      if (entry.case === 'typed-safe-tx') add('safe.sign_owner', rows.length);
      if (entry.case === 'typed-safe-message') add('safe.message_sign', rows.length);
    }
    expect(refused).toStrictEqual([]);
    expect(reached).toStrictEqual(grammar.checked.reached);
    expect(Object.keys(reached).sort()).toStrictEqual(ROWS.map((r) => r.row).sort());
  });

  test("the hash-only cases' E0 0C 00 00 carries ethers' two hashes, as main's binding computes them", () => {
    const hashOnly = grammar.honest.filter((e) => cases.get(e.case).family === 'hash-only');
    expect(hashOnly).toHaveLength(2);
    for (const entry of hashOnly) {
      const c = cases.get(entry.case);
      const { domainSeparator, structHash } = typedHashes(c.request.typed_data);
      const last = unhex(entry.apdus[entry.apdus.length - 1]);
      const p = pathBytes(c.record.path);
      expect(last.subarray(0, 4)).toStrictEqual(HEADERS.signHashes);
      expect(last.subarray(5)).toStrictEqual(Buffer.concat([p, domainSeparator, structHash]));
    }
  });

  test('all 152 forbidden APDUs are refused by their rule', () => {
    const wrong = [];
    const rules = new Set();
    for (const entry of grammar.forbidden) {
      const got = playForbidden(entry, honest.get(entry.case).apdus, cases.get(entry.case));
      rules.add(got);
      if (got !== entry.rule) {
        wrong.push({ case: entry.case, at: entry.at, what: entry.what, want: entry.rule, got });
      }
    }
    expect(wrong).toStrictEqual([]);
    expect(grammar.forbidden).toHaveLength(152);
    expect([...rules].sort()).toStrictEqual(Object.keys(RULES).sort());
  });

  test("the piece-byte family: each byte of an E0 04 or E0 08 piece changed is payload, the file's count, or path for a byte of P", () => {
    const family = grammar.byte_families.find((f) => f.family === 'piece-byte');
    expect(family.rule).toBe('payload');
    const tally = { payload: 0, path: 0 };
    const wrong = [];
    for (const entry of grammar.honest) {
      if (entry.operation !== 'sign.transaction' && entry.operation !== 'sign.message') continue;
      const c = cases.get(entry.case);
      const options = admissionOptions(c);
      const apdus = entry.apdus.map(unhex);
      const pathLength = pathBytes(c.record.path).length;
      apdus.forEach((bytes, i) => {
        if (bytes[0] !== 0xe0 || (bytes[1] !== 0x04 && bytes[1] !== 0x08)) return;
        const first = bytes[2] === 0x00;
        for (let j = 5; j < bytes.length; j++) {
          const changed = Buffer.from(bytes);
          changed[j] ^= 0x01;
          const want = first && j - 5 < pathLength ? 'path' : 'payload';
          const admission = new Admission(options);
          for (let k = 0; k < i; k++) {
            admission.admit(apdus[k]);
            admission.answered(OK);
          }
          const got = admission.admit(changed).rule;
          if (got !== want) wrong.push({ case: entry.case, apdu: i, byte: j - 5, want, got });
          else tally[got] += 1;
        }
      });
    }
    expect(wrong).toStrictEqual([]);
    expect(tally.payload).toBe(family.count);
    expect(tally.payload).toBe(6507);
    expect(tally.path).toBeGreaterThan(0);
  });

  test("the cases the core refuses before the first APDU, but typed data's, are main's GrammarErrors with their deviation", () => {
    const refused = grammar.refused.filter((r) => r.operation !== TYPED);
    expect(refused.map((r) => r.case)).toStrictEqual([
      'discovery-live-2147483647-2',
      'add-path-outside-schemes',
      'msg-empty',
    ]);
    for (const entry of refused) {
      const c = cases.get(entry.case);
      const options = admissionOptions(c);
      if (entry.operation === 'ledger.add') {
        // ledger.add takes { scheme, index } (plan point 9): main can't name this path at all.
        expect(options).toBeNull();
        expect(parsePath(c.request.path)).toBeNull();
        continue;
      }
      let error;
      try {
        new Admission(options);
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(GrammarError);
      expect({ id: entry.case, deviation: error.deviation }).toStrictEqual({
        id: entry.case,
        deviation: entry.deviation,
      });
    }
  });

  describe("the 2,048-APDU bound, from the file's bounds.apdus_per_operation", () => {
    const path = "44'/60'/0'/0/0";
    const key = { kind: 'ledger', index: 0 };
    const bound = () => grammar.bounds.apdus_per_operation;

    /** The operation's stream, or the deviation that refused it. */
    function built(options) {
      try {
        return new Admission(options).expected;
      } catch (err) {
        if (err instanceof GrammarError) return err.deviation;
        throw err;
      }
    }

    test('a message: one at the bound is admitted to its last piece, one byte more is refused', () => {
      const max = bound();
      // P ‖ len(m) ‖ 125 bytes in the first piece (a live path), then 150 each.
      const length = 125 + (max - 3) * 150;
      const message = (n) => ({
        operation: 'sign.message',
        path,
        params: { key, message: '0x' + 'ab'.repeat(n) },
      });
      const stream = built(message(length));
      expect(stream).toHaveLength(max);
      const admission = new Admission(message(length));
      for (const bytes of stream) {
        expect(admission.admit(bytes).rule).toBeUndefined();
        admission.answered(OK);
      }
      expect(built(message(length + 1))).toBe('device-bounds');
    });

    test('a transaction: P ‖ T of (bound − 2) · 255 bytes is admitted, one byte more is refused', () => {
      const max = bound();
      const p = pathBytes(path);
      const tx = (n) => ({
        type: 2,
        chain_id: '100',
        nonce: '0',
        gas_limit: '21000',
        to: '0x8ba1f109551bD432803012645Ac136ddd64DBA72',
        value: '0',
        data: '0x' + 'cd'.repeat(n),
        max_fee_per_gas: '2',
        max_priority_fee_per_gas: '1',
      });
      const target = (max - 2) * 255;
      let n = target;
      n -= p.length + unsignedTransaction(tx(n)).length - target;
      expect(p.length + unsignedTransaction(tx(n)).length).toBe(target);
      const options = (m) => ({ operation: 'sign.transaction', path, params: { key, tx: tx(m) } });
      const stream = built(options(n));
      expect(stream).toHaveLength(max);
      const admission = new Admission(options(n));
      stream.forEach((bytes, i) => {
        expect(admission.admit(bytes)).toStrictEqual({
          row: i === 0 ? 'signature.first' : i === 1 ? 'signature.second' : 'sign.transaction',
          waits: i === max - 1,
        });
        admission.answered(OK);
      });
      expect(built(options(n + 1))).toBe('device-bounds');
    });

    test('typed data: a binding stream of bound − 3 APDUs is admitted, one more is refused', () => {
      const max = bound();
      const typed = (values) => ({
        operation: 'sign.typed_data',
        path,
        params: { key },
        typedData: {
          apdus: [
            apdu(HEADERS.typeName, Buffer.from('EIP712Domain')),
            ...Array.from({ length: values }, () =>
              apdu(HEADERS.valueLast, Buffer.from([0, 1, 7]))
            ),
          ],
          domainSeparator: Buffer.alloc(32, 1),
          structHash: Buffer.alloc(32, 2),
        },
      });
      const stream = built(typed(max - 4));
      expect(stream).toHaveLength(max);
      const admission = new Admission(typed(max - 4));
      for (const bytes of stream) {
        expect(admission.admit(bytes).rule).toBeUndefined();
        admission.answered(OK);
      }
      expect(built(typed(max - 3))).toBe('device-bounds');
    });
  });
});
