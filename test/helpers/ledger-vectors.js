/**
 * freedom-core's Ledger vectors (design 0016, Vectors): `vectors/ledger.json`
 * (the JS reference's recorded APDU exchanges, each case's request and
 * record) and `vectors/ledger-grammar.json` (the grammar as data: the rows,
 * the rules, the bounds, each case's honest stream as the core sends it, and
 * the forbidden APDUs with the rule that refuses each).
 *
 * Found as the other vector suites find theirs: FREEDOM_CORE_LEDGER_VECTORS
 * names freedom-core's `vectors` directory, or it is FREEDOM_CORE_VECTORS's
 * directory, or the one in the freedom-core checkout FREEDOM_CORED_PATH was
 * built in. `ledgerVectors(name)` is `null` when a file isn't found; the
 * suites skip then, unless FREEDOM_CORE_LEDGER_VECTORS names the directory
 * (`ledgerVectorsRequired`), as CI does at the pinned commit.
 *
 * `admissionOptions(c, apdus)` gives main's Admission (ledger-grammar.js)
 * for a ledger.json case, from what main would hold: the core's params for
 * the case's request (`ledger.add`'s path as `{ scheme, index }`, plan point
 * 9), the case's record path, and discovery's `records` as main's
 * `getLedgerRecordsToCheck` lists them. For typed data it takes a
 * **stand-in for main's typed-data binding** (LDG-3's PR 2): the definitions
 * and values of the case's honest stream, with ethers' two hashes of its
 * typed data. That only exercises the Admission's order, counts and gate
 * around the binding's stream; the binding's own bytes are PR 2's suite.
 *
 * `playHonest` plays a case's honest stream APDU by APDU, answering each
 * `9000` (a hash-only case's first `E0 1A` with `6D00` and
 * `hash_only: "shown"`), and `playForbidden` plays a forbidden entry: the
 * honest APDUs before `at`, then its own, giving the rule.
 */

const fs = require('fs');
const path = require('path');
const { TypedDataEncoder } = require('ethers');
const { Admission, operationOf, parsePath } = require('../../src/main/core/ledger-grammar');

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
const ledgerVectorsRequired = Boolean(process.env.FREEDOM_CORE_LEDGER_VECTORS);
const loaded = new Map();

/** A vectors file by name, parsed once; null when it isn't there. */
function ledgerVectors(name) {
  if (!loaded.has(name)) {
    const file = dir && path.join(dir, name);
    loaded.set(
      name,
      file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
    );
  }
  return loaded.get(name);
}

const OK = Buffer.from('9000', 'hex');
const INS_NOT_SUPPORTED = Buffer.from('6d00', 'hex');
const unhex = (text) => Buffer.from(text, 'hex');
const isTyped = (bytes) => bytes[0] === 0xe0 && (bytes[1] === 0x1a || bytes[1] === 0x1c);

/** ethers' domain separator and hashStruct(message) of a case's typed data, as main's binding computes them. */
function typedHashes(typedData) {
  const types = { ...typedData.types };
  delete types.EIP712Domain;
  return {
    domainSeparator: Buffer.from(TypedDataEncoder.hashDomain(typedData.domain).slice(2), 'hex'),
    structHash: Buffer.from(TypedDataEncoder.from(types).hash(typedData.message).slice(2), 'hex'),
  };
}

/** The stand-in for main's typed-data binding: the honest stream's definitions and values. */
function typedStandIn(c, apdus) {
  return { apdus: apdus.filter(isTyped), ...typedHashes(c.request.typed_data) };
}

/** The Admission's options for a ledger.json case, `apdus` its honest stream (Buffers). */
function admissionOptions(c, apdus = []) {
  const request = c.request;
  switch (c.operation) {
    case 'ledger.accounts':
      return { operation: 'ledger.accounts', params: request, records: c.records || [] };
    case 'ledger.add': {
      const named = parsePath(request.path);
      if (!named) return null;
      return { operation: 'ledger.add', params: { ...named, name: request.name } };
    }
    case 'sign.transaction':
      return {
        operation: 'sign.transaction',
        path: c.record.path,
        params: { key: { kind: 'ledger', index: 0 }, tx: request.tx },
      };
    case 'sign.message':
      return {
        operation: 'sign.message',
        path: c.record.path,
        params: { key: { kind: 'ledger', index: 0 }, message: request.message },
      };
    case 'sign.typed_data':
      return {
        operation: c.family === 'x402' ? 'x402.settle' : 'sign.typed_data',
        path: c.record.path,
        params: { key: { kind: 'ledger', index: 0 }, typed_data: request.typed_data },
        typedData: typedStandIn(c, apdus),
      };
    default:
      throw new Error(`${c.id}: no operation ${c.operation}`);
  }
}

/** Main's answer to an admitted APDU in an honest play. */
function answerFor(c, admission, at) {
  if (c.family === 'hash-only' && at === 2) {
    if (!admission.isHashOnlyAnswer(INS_NOT_SUPPORTED)) {
      throw new Error(`${c.id}: APDU 2's 6D00 can't open the gate`);
    }
    return { answer: INS_NOT_SUPPORTED, hashOnly: true };
  }
  return { answer: OK };
}

/**
 * Plays a case's honest stream: `{ rows, refused }`, `rows` each admitted
 * APDU's row and `refused` the first refusal `{ at, rule }`, or null.
 */
function playHonest(c, entry) {
  const apdus = entry.apdus.map(unhex);
  const admission = new Admission(admissionOptions(c, apdus));
  const rows = [];
  for (const [at, bytes] of apdus.entries()) {
    const verdict = admission.admit(bytes);
    if (verdict.rule) return { rows, refused: { at, rule: verdict.rule }, admission };
    rows.push(verdict);
    admission.answered(answerFor(c, admission, at));
  }
  return { rows, refused: null, admission };
}

/**
 * Plays a forbidden entry: its rule as main gives it. A `parent` entry
 * names a parent main sent; its APDU is refused `parent` when that parent
 * opens no operation (`operationOf`). Otherwise the case's honest APDUs
 * before `at` are admitted and answered (with `state`, the last of them
 * stays unanswered: main holds its answer), then the entry's APDU.
 */
function playForbidden(entry, honestApdus, c) {
  if (entry.parent) {
    const { method, ...params } = entry.parent;
    if (operationOf(method, params) === null) return 'parent';
  }
  const apdus = honestApdus.map(unhex);
  const admission = new Admission(admissionOptions(c, apdus));
  for (let at = 0; at < entry.at; at++) {
    const verdict = admission.admit(apdus[at]);
    if (verdict.rule) throw new Error(`${entry.case}: honest APDU ${at} refused, ${verdict.rule}`);
    const held = entry.state && at === entry.at - 1;
    if (!held) admission.answered(answerFor(c, admission, at));
  }
  const verdict = admission.admit(unhex(entry.apdu));
  return verdict.rule ?? null;
}

module.exports = {
  admissionOptions,
  ledgerVectors,
  ledgerVectorsDir: dir,
  ledgerVectorsRequired,
  playForbidden,
  playHonest,
  typedHashes,
  typedStandIn,
  unhex,
};
