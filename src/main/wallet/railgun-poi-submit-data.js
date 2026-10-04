/** Fixed POI submission bytes and bounded, non-authorizing response diagnostics.
 * No network, persistence, proof verification or disclosure permission. Payloads
 * and wire bodies are privacy-sensitive; diagnostics expose none of their contents.
 */
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { TextDecoder } = require('util');
const { normalizeRailgunPoiPayload } = require('./railgun-poi-payload');
const POI_URL = 'https://ppoi.fdi.network';
const sha = (value) => createHash('sha256').update(value).digest('hex');
const shape = (value, keys) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
};
const fail = () =>
  Object.assign(new Error('Railgun POI submission data unavailable'), {
    code: 'RAILGUN_POI_SUBMISSION_DATA_REFUSED',
  });
function build(input) {
  shape(input, ['requestId', 'payload']);
  const { requestId } = input;
  assert.ok(Number.isSafeInteger(requestId) && requestId > 0);
  const payload = normalizeRailgunPoiPayload(input.payload);
  // Pinned SDK TransactProofData uses snarkProof with snarkjs coordinate order.
  // Match its field order and numeric ID shape. A controller allocates the
  // timestamp once and persists these bytes; transport fingerprints still differ,
  // and actual service acceptance remains separately unqualified.
  // In particular, do not apply the Solidity pi_b swap or add witness fields.
  const body = JSON.stringify({
    jsonrpc: '2.0',
    method: 'ppoi_submit_transact_proof',
    params: {
      chainType: '0',
      chainID: '11155111',
      txidVersion: 'V2_PoseidonMerkle',
      listKey: payload.listKey,
      transactProofData: {
        snarkProof: payload.proof,
        poiMerkleroots: payload.poiMerkleroots,
        txidMerkleroot: payload.txidMerkleroot,
        txidMerklerootIndex: payload.txidMerklerootIndex,
        blindedCommitmentsOut: payload.blindedCommitmentsOut,
        railgunTxidIfHasUnshield: payload.railgunTxidIfHasUnshield,
      },
    },
    id: requestId,
  });
  assert.ok(Buffer.byteLength(body) <= 18432);
  return Object.freeze({
    version: 1,
    endpoint: POI_URL,
    requestId,
    payload,
    payloadSha256: sha(JSON.stringify(payload)),
    body,
    bodySha256: sha(body),
  });
}
function prepareRailgunPoiSubmission(input) {
  try {
    return build(input);
  } catch {
    throw fail();
  }
}
function normalizeRailgunPoiSubmission(input) {
  try {
    const text = JSON.stringify(input);
    assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 40000);
    const value = JSON.parse(text);
    shape(value, [
      'version',
      'endpoint',
      'requestId',
      'payload',
      'payloadSha256',
      'body',
      'bodySha256',
    ]);
    const expected = build({ requestId: value.requestId, payload: value.payload });
    // Exact body bytes (including ID and ordering) survive persistence. Even a
    // caller-recomputed digest cannot introduce a different method or endpoint.
    assert.deepEqual(value, expected);
    return expected;
  } catch {
    throw fail();
  }
}
// JSON.parse owns grammar validation. This bounded second pass only checks
// decoded duplicate names, container depth, finite numbers and the two integer
// spellings whose numeric values are used to classify the envelope.
function scanResponse(text) {
  let cursor = 0;
  let idToken;
  let codeToken;
  const whitespace = () => {
    while (cursor < text.length && /[ \t\r\n]/.test(text[cursor])) cursor++;
  };
  const string = () => {
    const start = cursor++;
    while (cursor < text.length) {
      if (text[cursor] === '\\') cursor += 2;
      else if (text[cursor++] === '"') return text.slice(start, cursor);
    }
    assert.fail();
  };
  const visit = (depth, location) => {
    whitespace();
    const start = cursor;
    const first = text[cursor];
    if (first === '{' || first === '[') {
      // The root container is depth one; at most 32 containers may nest.
      assert.ok(depth < 32);
      const object = first === '{';
      const end = object ? '}' : ']';
      const names = new Set();
      cursor++;
      whitespace();
      if (text[cursor] !== end) {
        for (;;) {
          let child = null;
          if (object) {
            const name = JSON.parse(string());
            assert.ok(!names.has(name));
            names.add(name);
            if (location === 'root' && name === 'id') child = 'id';
            if (location === 'root' && name === 'error') child = 'error';
            if (location === 'error' && name === 'code') child = 'code';
            whitespace();
            assert.equal(text[cursor++], ':');
          }
          visit(depth + 1, child);
          whitespace();
          if (text[cursor] !== ',') break;
          cursor++;
          whitespace();
        }
      }
      assert.equal(text[cursor++], end);
    } else if (first === '"') {
      string();
    } else {
      while (cursor < text.length && !/[ \t\r\n,}\]]/.test(text[cursor])) cursor++;
      assert.ok(cursor > start);
      if (first === '-' || /[0-9]/.test(first)) {
        assert.ok(Number.isFinite(Number(text.slice(start, cursor))));
      }
    }
    if (location === 'id') idToken = text.slice(start, cursor);
    if (location === 'code') codeToken = text.slice(start, cursor);
  };
  visit(0, 'root');
  whitespace();
  assert.equal(cursor, text.length);
  return { idToken, codeToken };
}

const responseShape = (value, keys) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Reflect.ownKeys(value).sort(), [...keys].sort());
};
const responseDiagnostic = (classification, httpStatus, responseBytes) =>
  Object.freeze({
    classification,
    httpStatus,
    responseBytes,
    matchingEnvelope: classification === 'rpc-result' || classification === 'rpc-error',
    transportAuthenticated: false,
    acceptanceVerified: false,
    disclosureEnabled: false,
    spendingEnabled: false,
  });

/** Classifies caller-supplied evidence only; actual service response shape remains
 * unqualified. No classification establishes not-submitted, non-delivery,
 * acceptance or safe retry, including RPC errors, HTTP failures and unavailable.
 * Missing result/error is malformed, even if a service might omit a void result.
 * matchingEnvelope false means a match was not established, not non-delivery.
 * Callers must supply the complete body, never a truncated prefix; this function
 * cannot attest completeness. Any future transport must enforce the byte cap
 * after bounded decompression. This function neither decompresses nor truncates.
 */
function inspectRailgunPoiResponse(input) {
  // Invalid caller arguments are refusals; malformed supplied wire bytes are
  // diagnostics. No response content or identifiers escape either boundary.
  let submission;
  let httpStatus;
  let body;
  try {
    responseShape(input, ['submission', 'evidence']);
    submission = normalizeRailgunPoiSubmission(input.submission);
    const evidence = input.evidence;
    assert.ok(evidence && typeof evidence === 'object');
    const kind = evidence.kind;
    if (kind === 'unavailable') {
      responseShape(evidence, ['kind', 'reason']);
      assert.ok(
        [
          'timeout',
          'cancelled',
          'connection-failure',
          'response-too-large',
          'unavailable',
        ].includes(evidence.reason)
      );
      return responseDiagnostic('unavailable', null, 0);
    }
    assert.equal(kind, 'response');
    responseShape(evidence, ['kind', 'httpStatus', 'body']);
    httpStatus = evidence.httpStatus;
    assert.ok(Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599);
    const supplied = evidence.body;
    assert.ok(Buffer.isBuffer(supplied) && supplied.length <= 2048);
    body = Buffer.from(supplied);
  } catch {
    throw fail();
  }
  if (httpStatus !== 200) return responseDiagnostic('http-failure', httpStatus, body.length);
  let classification;
  try {
    // TextDecoder normally strips a BOM: refuse its bytes explicitly instead.
    assert.ok(!(body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf));
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    const value = JSON.parse(text);
    const { idToken, codeToken } = scanResponse(text);
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    const isError = Object.hasOwn(value, 'error');
    responseShape(value, ['jsonrpc', 'id', isError ? 'error' : 'result']);
    assert.equal(value.jsonrpc, '2.0');
    assert.ok(/^[1-9][0-9]*$/.test(idToken));
    assert.ok(Number.isSafeInteger(value.id) && value.id > 0);
    if (isError) {
      const error = value.error;
      assert.ok(error && typeof error === 'object' && !Array.isArray(error));
      responseShape(
        error,
        Object.hasOwn(error, 'data') ? ['code', 'message', 'data'] : ['code', 'message']
      );
      assert.ok(/^(?:0|-?[1-9][0-9]*)$/.test(codeToken));
      assert.ok(Number.isSafeInteger(error.code));
      assert.equal(typeof error.message, 'string');
    }
    classification =
      idToken !== String(submission.requestId) ? 'unmatched' : isError ? 'rpc-error' : 'rpc-result';
  } catch {
    classification = 'malformed';
  }
  return responseDiagnostic(classification, httpStatus, body.length);
}

module.exports = {
  prepareRailgunPoiSubmission,
  normalizeRailgunPoiSubmission,
  inspectRailgunPoiResponse,
};
