/**
 * Main's typed-data binding (apdu-binding.js) against the pinned core's
 * Ledger vectors (freedom-core design 0016, Main's typed-data binding and
 * Vectors; LDG-3's row: "for every typed-data case of ledger.json, main's
 * own stream equals the vector's APDUs byte for byte"), every case and every
 * family, not a sample (R6: main's encoder and fc-evm's must not drift):
 * - `vectors/ledger.json`'s 242 `sign.typed_data` cases: the 36 the core
 *   refuses before its first APDU refused too, for the same deviation and
 *   bound; the 82 the grammar file streams honestly (`honest`, the core's
 *   stream, the hash-only ones through their `6D00`) equal byte for byte,
 *   and those without a deviation the recorded APDUs too; the 124 a fault
 *   ends (a status, a disconnect, a faulty answer, another app) a prefix,
 *   every recorded APDU the core would send, and where the reference took
 *   its fallback after a `6D00` elsewhere than the first `E0 1A`
 *   (`blind-typed-data`), its hash-only APDU is main's;
 * - `vectors/ledger-grammar.json`'s typed-data families, each APDU refused
 *   `payload` against main's own stream, before the device: the
 *   `typed-data-byte` family (each data byte of each `E0 1A` and `E0 1C` of
 *   each honest stream, XOR 0x01; 15,620), `same_shape` (76), `name_ascii`
 *   (24) and `safe_changes` (15);
 * - typed data whose ethers hash isn't `expected_hash`, refused before the
 *   first APDU in both branches;
 * - `BOUNDS` and the rows' headers, the file's.
 *
 * What the relay's Admission does with each APDU (PR 1's), main's own here:
 * the APDU at the stream's position equal byte for byte, else `header` for
 * another `CLA INS P1 P2` or an `Lc` that isn't the data's length, else
 * `payload`. Around the binding's definitions and values, the address
 * check and `B0 01` before them, `E0 0C 00 01 P` after them and the
 * hash-only APDU from its two hashes are the Admission's; this suite builds
 * them from the record's path as PR 1's `typedDataStream` does.
 *
 * Skipped unless the vectors are found: FREEDOM_CORE_LEDGER_VECTORS names
 * freedom-core's `vectors` directory, as CI does at the pinned commit, and
 * then a missing file fails the suite; else FREEDOM_CORE_VECTORS's
 * directory, or the one in the freedom-core checkout FREEDOM_CORED_PATH was
 * built in.
 */

const fs = require('fs');
const path = require('path');
const { TypedDataEncoder } = require('ethers');
const { BOUNDS, HEADER, bindTypedData } = require('./apdu-binding');

function ledgerVectorsDir() {
  if (process.env.FREEDOM_CORE_LEDGER_VECTORS) return process.env.FREEDOM_CORE_LEDGER_VECTORS;
  if (process.env.FREEDOM_CORE_VECTORS) return path.dirname(process.env.FREEDOM_CORE_VECTORS);
  const binary = process.env.FREEDOM_CORED_PATH;
  if (!binary) return null;
  for (let dir = path.dirname(path.resolve(binary)); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'vectors');
    if (fs.existsSync(path.join(candidate, 'ledger-grammar.json'))) return candidate;
    if (path.dirname(dir) === dir) return null;
  }
}

const dir = ledgerVectorsDir();
const required = Boolean(process.env.FREEDOM_CORE_LEDGER_VECTORS);
function load(name) {
  const file = dir && path.join(dir, name);
  return file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}
const ledger = load('ledger.json');
const grammar = load('ledger-grammar.json');
const describeIfVectors = ledger && grammar ? describe : describe.skip;

(required ? test : test.skip)('the vectors FREEDOM_CORE_LEDGER_VECTORS names are there', () => {
  expect(ledger?.cases?.length).toBeGreaterThan(0);
  expect(grammar?.honest?.length).toBeGreaterThan(0);
});

/** A record's path as the grammar encodes it: n, then n big-endian elements. */
function encodePath(text) {
  const elements = text.split('/');
  const bytes = Buffer.alloc(1 + 4 * elements.length);
  bytes[0] = elements.length;
  elements.forEach((element, i) => {
    const hardened = element.endsWith("'");
    const index = Number(hardened ? element.slice(0, -1) : element);
    bytes.writeUInt32BE((hardened ? 0x80000000 : 0) + index, 1 + 4 * i);
  });
  return bytes.toString('hex');
}

const lc = (hex) => (hex.length / 2).toString(16).padStart(2, '0');

/** The Admission's head: the address check at the record's path, then B0 01. */
function head(P) {
  return ['e0020000' + lc(P) + P, 'b001000000'];
}

/**
 * The operation's stream around a binding, as the Admission builds it, in
 * hex: the head, the definitions and values, then `E0 0C 00 01 P`; or, past
 * Q23's gate, the head, the first `E0 1A` and `E0 0C 00 00 P ‖ both hashes`.
 */
function operationStream(binding, P, hashOnly) {
  const apdus = binding.apdus.map((a) => a.toString('hex'));
  const hashes = binding.domainSeparator.toString('hex') + binding.structHash.toString('hex');
  return hashOnly
    ? [...head(P), apdus[0], 'e00c0000' + lc(P + hashes) + P + hashes]
    : [...head(P), ...apdus, 'e00c0001' + lc(P) + P];
}

/** The rule an APDU gets against the one main expects at its place. */
function ruleFor(expected, sent) {
  if (sent === expected) return null;
  const lc = parseInt(sent.slice(8, 10), 16);
  if (sent.slice(0, 8) !== expected.slice(0, 8) || lc !== (sent.length - 10) / 2) return 'header';
  return 'payload';
}

function isTypedApdu(apdu) {
  return apdu.startsWith('e01a') || apdu.startsWith('e01c');
}

/**
 * Whether a case takes Q23's branch: the device answered `6D00` to the
 * operation's first `E0 1A` (a Nano S, `fields: false`, or a scripted status
 * there).
 */
function takesHashOnly(c) {
  const first = c.exchanges.find((e) => e.apdu.startsWith('e01a'));
  return Boolean(first && typeof first.answer === 'string' && first.answer.endsWith('6d00'));
}

/**
 * Main's whole expected stream for a ledger.json case: the head, then the
 * binding's, in the branch the case's device takes.
 */
function mainStream(c, { hashOnly = takesHashOnly(c), typedData, expectedHash } = {}) {
  const binding = bindTypedData({
    typedData: typedData ?? c.request.typed_data,
    expectedHash: expectedHash ?? c.request.expected_hash,
  });
  if (binding.rule) return binding;
  return { apdus: operationStream(binding, encodePath(c.record.path), hashOnly) };
}

/** A typed data's own ethers hash, for main holding that typed data. */
function ownHash(typedData) {
  return TypedDataEncoder.hash(typedData.domain, typedData.types, typedData.message);
}

function marksOf(c) {
  return new Set([...(c.also ?? []), ...(c.deviation ? [c.deviation] : [])]);
}

describeIfVectors(
  "main's typed-data binding against vectors/ledger.json and ledger-grammar.json",
  () => {
    // jest reads a skipped describe's body too: nothing here without the files.
    const typedCases = (ledger?.cases ?? []).filter((c) => c.operation === 'sign.typed_data');
    const caseById = new Map(typedCases.map((c) => [c.id, c]));
    const honest = new Map(
      (grammar?.honest ?? [])
        .filter((h) => h.operation === 'sign.typed_data')
        .map((h) => [h.case, h.apdus])
    );
    const refused = new Map(
      (grammar?.refused ?? [])
        .filter((r) => r.operation === 'sign.typed_data')
        .map((r) => [r.case, r])
    );

    test("BOUNDS and the typed-data rows' headers are the file's", () => {
      expect(BOUNDS).toStrictEqual(grammar.bounds);
      const headers = (row) => grammar.rows.find((r) => r.row === row).apdus.map((a) => a.header);
      expect(headers('sign.typed_data.definitions')).toStrictEqual([
        HEADER.TYPE_NAME,
        HEADER.TYPE_FIELD,
      ]);
      expect(headers('sign.typed_data.values')).toStrictEqual([
        HEADER.ROOT,
        HEADER.ARRAY,
        HEADER.VALUE_MORE,
        HEADER.VALUE_LAST,
      ]);
      // The two this suite puts around the binding, as the Admission does.
      expect(headers('sign.typed_data.sign')).toStrictEqual(['e00c0001']);
      expect(headers('hash-only')).toStrictEqual(['e00c0000']);
      expect(grammar.rules.payload).toBeDefined();
    });

    test('every typed-data case: refused where the core refuses, else its APDUs byte for byte', () => {
      const wrong = [];
      const tally = { refused: 0, honest: 0, recorded: 0, fault: 0, fallback: 0 };
      for (const c of typedCases) {
        const marks = marksOf(c);
        const ours = mainStream(c);
        if (refused.has(c.id)) {
          // The core's refusal before its first APDU, for the same deviation and bound.
          const want = refused.get(c.id);
          const words = ours.bound && boundWords(ours.bound);
          if (ours.rule !== 'payload' || ours.apdus || ours.reason !== want.deviation) {
            wrong.push({ id: c.id, want: want.deviation, got: ours });
          } else if (want.deviation === 'device-bounds' && words !== want.reason) {
            wrong.push({ id: c.id, want: want.reason, got: words });
          }
          tally.refused += 1;
          continue;
        }
        if (ours.rule) {
          wrong.push({ id: c.id, refused: ours });
          continue;
        }
        const recorded = c.exchanges.map((e) => e.apdu);
        if (honest.has(c.id)) {
          // The core's stream, through the 6D00 for a hash-only case.
          if (!equal(ours.apdus, honest.get(c.id)))
            wrong.push({ id: c.id, ...diff(ours.apdus, honest.get(c.id)) });
          // The reference's too, but where a deviation names the difference.
          if (marks.size === 0) {
            if (!equal(ours.apdus, recorded))
              wrong.push({ id: c.id, recorded: diff(ours.apdus, recorded) });
            tally.recorded += 1;
          } else if (!equal([...marks], ['field-pieces']) || equal(ours.apdus, recorded)) {
            wrong.push({ id: c.id, marks: [...marks] });
          }
          tally.honest += 1;
          continue;
        }
        // A fault ends the case: every APDU recorded up to it is the core's,
        // as main encodes it. Where the reference fell back after a 6D00 at
        // any other APDU (blind-typed-data), the core ends there instead.
        const blind = c.exchanges.findIndex(
          (e) => typeof e.answer === 'string' && e.answer.endsWith('6d00')
        );
        const sent = marks.has('blind-typed-data') ? recorded.slice(0, blind + 1) : recorded;
        if (marks.has('blind-typed-data')) {
          if (blind === -1 || recorded.length !== blind + 2) {
            wrong.push({ id: c.id, fallback: recorded.length });
          } else {
            // The reference's hash-only APDU, ethers' hashes: main's.
            const fallback = mainStream(c, { hashOnly: true });
            if (fallback.apdus.at(-1) !== recorded.at(-1))
              wrong.push({ id: c.id, hashOnly: recorded.at(-1) });
            tally.fallback += 1;
          }
        }
        const extra = [...marks].filter(
          (m) => !['blind-typed-data', 'app-check', 'key-check', 'signature-check'].includes(m)
        );
        if (extra.length || sent.length === 0 || !equal(ours.apdus.slice(0, sent.length), sent)) {
          wrong.push({ id: c.id, extra, prefix: diff(ours.apdus, sent) });
        }
        tally.fault += 1;
      }
      expect(wrong).toStrictEqual([]);
      expect(tally).toStrictEqual({
        refused: 36,
        honest: 82,
        recorded: 78,
        fault: 124,
        fallback: 7,
      });
      expect(typedCases).toHaveLength(242);
      expect(honest.size).toBe(82);
    });

    test("every honest typed-data stream's typed APDUs with one data byte changed: refused payload (typed-data-byte)", () => {
      const family = grammar.byte_families.find((f) => f.family === 'typed-data-byte');
      expect(family.rule).toBe('payload');
      let count = 0;
      const wrong = [];
      for (const [id, stream] of honest) {
        const ours = mainStream(caseById.get(id)).apdus;
        expect(ours).toStrictEqual(stream);
        stream.forEach((apdu, at) => {
          if (!isTypedApdu(apdu)) return;
          const bytes = Buffer.from(apdu, 'hex');
          for (let k = 5; k < bytes.length; k += 1) {
            bytes[k] ^= 0x01;
            const rule = ruleFor(ours[at], bytes.toString('hex'));
            bytes[k] ^= 0x01;
            if (rule !== family.rule) wrong.push({ id, at, byte: k - 5, rule });
            count += 1;
          }
        });
      }
      expect(wrong).toStrictEqual([]);
      expect(count).toBe(family.count);
      expect(count).toBe(15620);
    });

    test('another schema and message of the same shape: refused payload at its first typed APDU (same_shape)', () => {
      const wrong = [];
      for (const s of grammar.same_shape) {
        const c = caseById.get(s.case);
        const ours = mainStream(c).apdus;
        // The same headers and counts, other bytes.
        expect(s.apdus).toHaveLength(ours.length);
        const at = s.apdus.findIndex((apdu, i) => apdu !== ours[i]);
        const rule = at === -1 ? null : ruleFor(ours[at], s.apdus[at]);
        if (rule !== s.rule || !isTypedApdu(s.apdus[at])) wrong.push({ id: s.case, at, rule });
        // And main, holding the other typed data, encodes the core's stream for it.
        const own = mainStream(c, { typedData: s.typed_data, expectedHash: ownHash(s.typed_data) });
        if (own.rule || !equal(own.apdus, s.apdus)) {
          wrong.push({ id: s.case, own: own.rule ? own : diff(own.apdus, s.apdus) });
        }
      }
      expect(wrong).toStrictEqual([]);
      expect(grammar.same_shape).toHaveLength(76);
    });

    test("the reference's definitions for the name-ascii cases (UTF-16 lengths): refused payload, main has no stream (name_ascii)", () => {
      const wrong = [];
      for (const n of grammar.name_ascii) {
        const ours = mainStream(caseById.get(n.case));
        if (ours.rule !== n.rule || ours.reason !== 'name-ascii' || ours.apdus)
          wrong.push({ id: n.case, ours });
        expect(n.apdus.length).toBeGreaterThan(0);
        expect(n.apdus.every((apdu) => apdu.startsWith('e01a'))).toBe(true);
      }
      expect(wrong).toStrictEqual([]);
      expect(grammar.name_ascii).toHaveLength(24);
    });

    test("a SafeTx's or SafeMessage's field, address, chain or digest changed: refused payload where it leaves main's stream (safe_changes)", () => {
      const wrong = [];
      for (const s of grammar.safe_changes) {
        const c = caseById.get(s.case);
        const ours = mainStream(c).apdus;
        const { at, apdu } = s.first_difference;
        if (ruleFor(ours[at], apdu) !== s.rule || !isTypedApdu(apdu))
          wrong.push({ id: s.case, change: s.change, at });
        // The changed typed data's own stream leaves main's there, and not before.
        const changed = mainStream(c, {
          typedData: s.typed_data,
          expectedHash: ownHash(s.typed_data),
        }).apdus;
        if (!changed || changed[at] !== apdu || !equal(changed.slice(0, at), ours.slice(0, at))) {
          wrong.push({ id: s.case, change: s.change, stream: changed && diff(changed, ours) });
        }
      }
      expect(wrong).toStrictEqual([]);
      expect(grammar.safe_changes).toHaveLength(15);
    });

    test("typed data whose ethers hash isn't expected_hash: refused before the first APDU, in both branches", () => {
      const wrong = [];
      const ids = [...honest.keys()];
      ids.forEach((id, i) => {
        const c = caseById.get(id);
        const hash = c.request.expected_hash;
        const flipped = hash.slice(0, -1) + (parseInt(hash.at(-1), 16) ^ 1).toString(16);
        // Another case's confirmed hash, for typed data other than this one.
        const other = ids
          .map((j) => caseById.get(j).request.expected_hash)
          .find((h, k) => k !== i && h !== hash);
        for (const expectedHash of [flipped, other]) {
          for (const hashOnly of [false, true]) {
            const ours = mainStream(c, { expectedHash, hashOnly });
            if (ours.rule !== 'payload' || ours.reason !== 'hash-mismatch' || ours.apdus)
              wrong.push({ id, hashOnly });
          }
        }
      });
      expect(wrong).toStrictEqual([]);
    });
  }
);

function equal(a, b) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function diff(ours, theirs) {
  const at = ours.findIndex((x, i) => x !== theirs[i]);
  return { at, ours: ours[at], theirs: theirs[at], lengths: [ours.length, theirs.length] };
}

/** A device-bounds refusal as the grammar file words the core's. */
function boundWords({ name, size }) {
  return {
    name_bytes: `a name of ${size} characters`,
    definition: `an APDU's data of ${size} bytes`,
    array_entries: `an array of length of ${size}`,
    fixed_size: `a fixed size of ${size}`,
  }[name];
}
