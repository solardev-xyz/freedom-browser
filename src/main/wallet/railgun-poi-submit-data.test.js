const { createHash } = require('crypto');
const {
  prepareRailgunPoiSubmission: prepare,
  normalizeRailgunPoiSubmission: normalize,
  inspectRailgunPoiResponse: inspectResponse,
} = require('./railgun-poi-submit-data');
const { REQUIRED_LIST } = require('./railgun-poi-records');
const { bindRailgunOwnPoiPayload } = require('./railgun-own-poi-proof-data');
const requestId = 1791086400000;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const hex = (value) => '0x' + value.toString(16).padStart(64, '0');
const copy = (value) => JSON.parse(JSON.stringify(value));
const payload = (unshield = false) => ({
  listKey: REQUIRED_LIST,
  proof: {
    pi_a: ['1', '2'],
    pi_b: [
      ['3', '4'],
      ['5', '6'],
    ],
    pi_c: ['7', '8'],
  },
  poiMerkleroots: [hex(3).slice(2)],
  txidMerkleroot: hex(4).slice(2),
  txidMerklerootIndex: 6,
  blindedCommitmentsOut: unshield ? [] : [hex(5)],
  railgunTxidIfHasUnshield: unshield ? hex(6) : '0x00',
});
test.each([false, true])(
  'pinned SDK field mapping and persistence round trip preserve exact bytes, unshield=%s',
  (unshield) => {
    const input = payload(unshield),
      result = prepare({ requestId, payload: input });
    const wire = JSON.parse(result.body);
    // Contract expectation is the pinned shared-models TransactProofData schema,
    // not Solidity encoding: snarkProof, unchanged pi_b and exact prefixed markers.
    expect(wire).toEqual({
      jsonrpc: '2.0',
      id: requestId,
      method: 'ppoi_submit_transact_proof',
      params: {
        chainType: '0',
        chainID: '11155111',
        txidVersion: 'V2_PoseidonMerkle',
        listKey: REQUIRED_LIST,
        transactProofData: {
          snarkProof: input.proof,
          poiMerkleroots: input.poiMerkleroots,
          txidMerkleroot: input.txidMerkleroot,
          txidMerklerootIndex: 6,
          blindedCommitmentsOut: input.blindedCommitmentsOut,
          railgunTxidIfHasUnshield: input.railgunTxidIfHasUnshield,
        },
      },
    });
    expect(result.endpoint).toBe('https://ppoi.fdi.network');
    expect(result.payloadSha256).toBe(hash(JSON.stringify(result.payload)));
    expect(result.bodySha256).toBe(hash(result.body));
    expect(result.bodySha256).toBe(
      unshield
        ? '4814d74ba6158f891ae553d9f91253119f4ae8d8c3267cdb431033c913be4540'
        : 'ddf57ca3c602d78d229600090a689d153cdfbcf732bfe17f8e301f921c977f7a'
    );
    expect(normalize(copy(result))).toEqual(result);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.payload.proof.pi_b[0])).toBe(true);
    input.proof.pi_b[0][0] = '99';
    expect(result.payload.proof.pi_b[0]).toEqual(['3', '4']);
  }
);
test.each(['', String(requestId), 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null])(
  'invalid request ID refuses %#',
  (id) => {
    expect(() => prepare({ requestId: id, payload: payload() })).toThrow(
      'Railgun POI submission data unavailable'
    );
  }
);
test.each([null, [], {}, { endpoint: 'https://other.invalid' }])(
  'invalid builder options refuse %#',
  (value) => {
    expect(() => prepare(value)).toThrow('Railgun POI submission data unavailable');
  }
);
test('caller cannot introduce endpoint or method options', () => {
  for (const extra of [{ endpoint: 'https://other.invalid' }, { method: 'other' }])
    expect(() => prepare({ requestId, payload: payload(), ...extra })).toThrow();
});
test.each(['method', 'chain', 'version', 'list', 'proof-order', 'request-id', 'extra-witness'])(
  'changed %s wire refuses even with recomputed wire digest',
  (kind) => {
    const value = copy(prepare({ requestId, payload: payload() }));
    const wire = JSON.parse(value.body);
    if (kind === 'method') wire.method = 'ppoi_pois_per_list';
    if (kind === 'chain') wire.params.chainID = '1';
    if (kind === 'version') wire.params.txidVersion = 'V3';
    if (kind === 'list') wire.params.listKey = '0'.repeat(64);
    if (kind === 'proof-order') wire.params.transactProofData.snarkProof.pi_b[0].reverse();
    if (kind === 'request-id') wire.id = requestId + 1;
    if (kind === 'extra-witness') wire.params.transactProofData.privateInputs = 'secret-sentinel';
    value.body = JSON.stringify(wire);
    value.bodySha256 = hash(value.body);
    expect(() => normalize(value)).toThrow('Railgun POI submission data unavailable');
  }
);
test.each([
  'endpoint',
  'record-version',
  'payload-digest',
  'body-digest',
  'extra-key',
  'whitespace',
  'oversize',
])('changed %s record refuses', (kind) => {
  const value = copy(prepare({ requestId, payload: payload() }));
  if (kind === 'endpoint') value.endpoint = 'https://other.invalid';
  if (kind === 'record-version') value.version = 2;
  if (kind === 'payload-digest') value.payloadSha256 = '0'.repeat(64);
  if (kind === 'body-digest') value.bodySha256 = '0'.repeat(64);
  if (kind === 'extra-key') value.secret = 'secret-sentinel';
  if (kind === 'whitespace') {
    value.body = JSON.stringify(JSON.parse(value.body), null, 2);
    value.bodySha256 = hash(value.body);
  }
  if (kind === 'oversize') value.body = 'a'.repeat(40001);
  expect(() => normalize(value)).toThrow('Railgun POI submission data unavailable');
});
test('normalization establishes data shape only and cannot authenticate a proof', () => {
  const input = payload();
  input.proof.pi_a = ['0', '0'];
  const value = prepare({ requestId, payload: input });
  expect(normalize(copy(value)).payload.proof.pi_a).toEqual(['0', '0']);
  expect(value).not.toHaveProperty('proofVerified');
  expect(value).not.toHaveProperty('disclosureEnabled');
});
test.each([false, true])(
  'payload digest agrees with the proof/checks payload binder, unshield=%s',
  (unshield) => {
    const input = payload(unshield);
    const bound = bindRailgunOwnPoiPayload(input, {
      listKey: input.listKey,
      poiMerkleroots: input.poiMerkleroots,
      txidMerkleroot: input.txidMerkleroot,
      txidMerklerootIndex: input.txidMerklerootIndex,
      railgunTxidIfHasUnshield: input.railgunTxidIfHasUnshield,
      outputCount: unshield ? 0 : 1,
    });
    expect(prepare({ requestId, payload: input }).payloadSha256).toBe(hash(JSON.stringify(bound)));
  }
);

// Responses are unauthenticated caller-supplied evidence. A syntactically valid
// JSON-RPC result is deliberately not proof of acceptance or permission to retry.
const response = (body, httpStatus = 200) => ({
  kind: 'response',
  httpStatus,
  body: Buffer.isBuffer(body) ? body : Buffer.from(body),
});
const resultWire = (value = null, id = requestId) =>
  JSON.stringify({ jsonrpc: '2.0', id, result: value });
const expectedInspection = (classification, evidence) => ({
  classification,
  httpStatus: evidence.kind === 'response' ? evidence.httpStatus : null,
  responseBytes: evidence.kind === 'response' ? evidence.body.length : 0,
  matchingEnvelope: classification === 'rpc-result' || classification === 'rpc-error',
  transportAuthenticated: false,
  acceptanceVerified: false,
  disclosureEnabled: false,
  spendingEnabled: false,
});
const classify = (evidence, submission = prepare({ requestId, payload: payload() })) =>
  inspectResponse({ submission, evidence });
const expectClass = (classification, evidence, submission) => {
  const observed = classify(evidence, submission);
  expect(observed).toEqual(expectedInspection(classification, evidence));
  expect(Object.isFrozen(observed)).toBe(true);
  expect(observed).not.toBeInstanceOf(Promise);
  return observed;
};
const expectRefusal = (input) => {
  let error;
  try {
    inspectResponse(input);
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({
    code: 'RAILGUN_POI_SUBMISSION_DATA_REFUSED',
    message: 'Railgun POI submission data unavailable',
  });
  expect(error).not.toHaveProperty('cause');
};

describe('bounded redacted POI response inspection', () => {
  test.each([
    null,
    false,
    true,
    0,
    '',
    'PRIVATE_RESULT',
    [],
    {},
    { accepted: true },
    { error: 'nested value' },
  ])('matching result %# has identical non-authoritative classification', (result) => {
    expectClass('rpc-result', response(resultWire(result)));
  });
  test.each([0, -1, 1, -32600, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER])(
    'valid canonical integer error code %p remains a redacted RPC error',
    (code) => {
      const wire = JSON.stringify({
        jsonrpc: '2.0',
        id: requestId,
        error: { code, message: 'PRIVATE_ERROR_MESSAGE' },
      });
      expectClass('rpc-error', response(wire));
    }
  );
  test.each([null, false, 0, '', [], { detail: 'PRIVATE_ERROR_DATA' }])(
    'valid optional error data %# never escapes',
    (data) => {
      const wire = JSON.stringify({
        jsonrpc: '2.0',
        id: requestId,
        error: { code: -32000, message: '', data },
      });
      expectClass('rpc-error', response(wire));
    }
  );
  test.each(['timeout', 'cancelled', 'connection-failure', 'response-too-large', 'unavailable'])(
    'unavailable %s is reduced to the same bounded record',
    (reason) => {
      const evidence = { kind: 'unavailable', reason };
      expectClass('unavailable', evidence);
    }
  );
  test.each([100, 199, 201, 204, 299, 301, 400, 401, 429, 500, 599])(
    'HTTP %i cannot become RPC success even with a matching result',
    (status) => {
      expectClass('http-failure', response(resultWire({ accepted: true }), status));
    }
  );
  test('non-200 classification precedes malformed UTF-8, BOM and JSON parsing', () => {
    for (const body of [
      Buffer.from([0xff]),
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('{'),
      Buffer.alloc(0),
    ])
      expectClass('http-failure', response(body, 503));
  });
  test.each([1, requestId + 1, Number.MAX_SAFE_INTEGER])(
    'different canonical ID %i is unmatched',
    (id) => {
      expectClass('unmatched', response(resultWire(null, id)));
      expectClass(
        'unmatched',
        response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: 0, message: '' } }))
      );
    }
  );
  test('maximum safe integer request ID matches exactly when the canonical submission has it', () => {
    const submission = prepare({ requestId: Number.MAX_SAFE_INTEGER, payload: payload() });
    expectClass('rpc-result', response(resultWire(null, Number.MAX_SAFE_INTEGER)), submission);
  });
  test.each([
    String(requestId) + '.00001',
    String(requestId) + '.0',
    String(requestId) + 'e0',
    '1.7910864e12',
    '1791086399999.99999',
    '9007199254740992',
    '9007199254740993',
    '-0',
    '0',
    '-1',
    '1.5',
    '1e400',
    '01',
    '+1',
    'null',
    'true',
    '[]',
    '{}',
    '"' + requestId + '"',
  ])('noncanonical or invalid raw ID %s is malformed', (raw) => {
    expectClass('malformed', response('{"jsonrpc":"2.0","id":' + raw + ',"result":null}'));
  });
  test('rounding-alias control actually collides with the request ID under JSON.parse', () => {
    const wire = '{"jsonrpc":"2.0","id":' + requestId + '.00001,"result":null}';
    expect(JSON.parse(wire).id).toBe(requestId);
    expectClass('malformed', response(wire));
  });
  test.each([
    '-0',
    '0.0',
    '-32000.0',
    '-32000e0',
    '1e3',
    '1.00000000000000001',
    '9007199254740992',
    '-9007199254740992',
    '1e400',
    'null',
    'true',
    '"-32600"',
  ])('noncanonical or invalid raw error code %s is malformed', (raw) => {
    const wire =
      '{"jsonrpc":"2.0","id":' + requestId + ',"error":{"code":' + raw + ',"message":"secret"}}';
    expectClass('malformed', response(wire));
  });
  test.each([
    null,
    [],
    {},
    { code: -32000 },
    { message: 'secret' },
    { code: -32000, message: null },
    { code: -32000, message: 1 },
    { code: -32000, message: [] },
    { code: -32000, message: 'secret', extra: true },
  ])('invalid error schema %# is malformed', (error) => {
    expectClass('malformed', response(JSON.stringify({ jsonrpc: '2.0', id: requestId, error })));
  });
  test.each([
    '{}',
    'null',
    '[]',
    '[{"jsonrpc":"2.0","id":1,"result":null}]',
    'true',
    '42',
    '"text"',
    '{"id":ID,"result":null}',
    '{"jsonrpc":2,"id":ID,"result":null}',
    '{"jsonrpc":"1.0","id":ID,"result":null}',
    '{"jsonrpc":"2.0","result":null}',
    '{"jsonrpc":"2.0","id":ID}',
    '{"jsonrpc":"2.0","id":ID,"result":null,"error":{"code":0,"message":""}}',
    '{"jsonrpc":"2.0","id":ID,"result":null,"extra":true}',
    '{"jsonrpc":"2.0","id":ID,"result":null,"__proto__":{}}',
  ])('invalid envelope %# is malformed', (text) => {
    expectClass('malformed', response(text.replaceAll('ID', String(requestId))));
  });
  test('malformed envelope has precedence over a different otherwise valid ID', () => {
    expectClass(
      'malformed',
      response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null, extra: true }))
    );
    expectClass(
      'malformed',
      response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 'wrong', message: '' } }))
    );
  });
  test.each([
    '{"jsonrpc":"2.0","jsonrpc":"2.0","id":ID,"result":null}',
    '{"jsonrpc":"2.0","json\\u0072pc":"2.0","id":ID,"result":null}',
    '{"jsonrpc":"2.0","id":1,"id":ID,"result":null}',
    '{"jsonrpc":"2.0","id":ID,"\\u0069d":ID,"result":null}',
    '{"jsonrpc":"2.0","id":ID,"result":false,"result":true}',
    '{"jsonrpc":"2.0","id":ID,"result":{"a":1,"\\u0061":2}}',
    '{"jsonrpc":"2.0","id":ID,"result":[{"a":1,"a":2}]}',
    '{"jsonrpc":"2.0","id":ID,"error":{"code":1,"code":2,"message":""}}',
    '{"jsonrpc":"2.0","id":ID,"error":{"code":1,"message":"a","message":"b"}}',
    '{"jsonrpc":"2.0","id":ID,"error":{"code":1,"message":"","data":{"x":1,"x":2}}}',
    '{"jsonrpc":"2.0","id":ID,"result":{"__proto__":1,"__proto__":2}}',
    '{"jsonrpc":"2.0","id":ID,"result":{"😀":1,"\\ud83d\\ude00":2}}',
  ])('duplicate decoded member names %# are malformed at every depth', (text) => {
    expectClass('malformed', response(text.replaceAll('ID', String(requestId))));
  });
  test('escaped member names without duplication and repeated names in separate objects are valid', () => {
    expectClass(
      'rpc-result',
      response(
        '{"json\\u0072pc":"2.0","\\u0069d":' + requestId + ',"res\\u0075lt":[{"x":1},{"x":2}]}'
      )
    );
  });
  describe.each(['outer-first', 'nested-first'])(
    'numeric field scope with %s ordering',
    (order) => {
      const members = (outer, nested) =>
        order === 'outer-first' ? outer + ',' + nested : nested + ',' + outer;
      test.each(['1.25', '1e3'])('nested result.id %s does not replace the root ID', (raw) => {
        const wire =
          '{"jsonrpc":"2.0",' + members('"id":' + requestId, '"result":{"id":' + raw + '}') + '}';
        expectClass('rpc-result', response(wire));
      });
      test.each(['-1.25', '-32e3'])(
        'nested error.data.code %s does not replace error.code',
        (raw) => {
          const wire =
            '{"jsonrpc":"2.0","id":' +
            requestId +
            ',"error":{"message":"",' +
            members('"code":-32000', '"data":{"code":' + raw + '}') +
            '}}';
          expectClass('rpc-error', response(wire));
        }
      );
      test('a matching nested ID cannot rescue a different root ID', () => {
        const result =
          '{"jsonrpc":"2.0",' + members('"id":1', '"result":{"id":' + requestId + '}') + '}';
        expectClass('unmatched', response(result));
        const error =
          '{"jsonrpc":"2.0",' +
          members(
            '"id":1',
            '"error":{"code":-32000,"message":"","data":{"id":' + requestId + ',"code":0}}'
          ) +
          '}';
        expectClass('unmatched', response(error));
      });
      test('a canonical nested code cannot rescue a noncanonical error code', () => {
        const wire =
          '{"jsonrpc":"2.0","id":' +
          requestId +
          ',"error":{"message":"",' +
          members('"code":-32e3', '"data":{"code":-32000}') +
          '}}';
        expectClass('malformed', response(wire));
      });
    }
  );
  test.each([
    ['FF', '\f'],
    ['VT', '\v'],
    ['NBSP', '\u00a0'],
    ['line separator', '\u2028'],
  ])('non-JSON %s whitespace between tokens is malformed', (_name, space) => {
    for (const wire of [
      '{' + space + '"jsonrpc":"2.0","id":' + requestId + ',"result":null}',
      '{"jsonrpc"' + space + ':"2.0","id":' + requestId + ',"result":null}',
      '{"jsonrpc":"2.0",' + space + '"id":' + requestId + ',"result":null}',
      '{"jsonrpc":"2.0","id":' + requestId + ',"result":' + space + 'null}',
    ])
      expectClass('malformed', response(wire));
  });
  test('nested prototype-like keys do not mutate prototypes or create envelope fields', () => {
    const wire =
      '{"jsonrpc":"2.0","id":' +
      requestId +
      ',"result":{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}}';
    expectClass('rpc-result', response(wire));
    expect({}.polluted).toBeUndefined();
  });
  test.each([
    '',
    ' ',
    '{',
    '{}{}',
    '{"jsonrpc":"2.0","id":ID,"result":null} trailing',
    '{"jsonrpc":"2.0","id":ID,"result":null,}',
    '{"jsonrpc":"2.0","id":ID,"result":undefined}',
    '{"jsonrpc":"2.0","id":ID,"result":NaN}',
    '{"jsonrpc":"2.0","id":ID,"result":Infinity}',
    '{"jsonrpc":"2.0","id":ID,"result":1e400}',
    '{"jsonrpc":"2.0","id":ID,"result":[-1e400]}',
    '{"jsonrpc":"2.0","id":ID,"result":"\\x41"}',
    '{"jsonrpc":"2.0","id":ID,"result":"line\nbreak"}',
    '{"jsonrpc":"2.0","id":ID,"result":/* comment */null}',
    '{"jsonrpc":"2.0","id":ID,"result":[1,]}',
  ])('invalid or nonfinite nested JSON %# is malformed', (text) => {
    expectClass('malformed', response(text.replaceAll('ID', String(requestId))));
  });
  test('valid escaped delimiters and multibyte string content cannot confuse structural scanning', () => {
    const value = 'PRIVATE } ] : , " \\ \b \f \n \r \t 😀 é 中文 \uFEFF';
    expectClass('rpc-result', response(' \n\t' + resultWire({ value, a: -0, b: 1.25e-5 }) + '\r '));
  });
  test.each(
    [
      [0xff],
      [0xc0, 0xaf],
      [0xe0, 0x80, 0xaf],
      [0xf0, 0x80, 0x80, 0xaf],
      [0xc2],
      [0xe2, 0x82],
      [0xf0, 0x9f, 0x98],
      [0xed, 0xa0, 0x80],
      [0xed, 0xbf, 0xbf],
      [0xf4, 0x90, 0x80, 0x80],
      [0x80],
    ].map((bytes) => [bytes])
  )('invalid UTF-8 %# is never silently replaced', (invalid) => {
    const body = Buffer.concat([
      Buffer.from('{"jsonrpc":"2.0","id":' + requestId + ',"result":"'),
      Buffer.from(invalid),
      Buffer.from('"}'),
    ]);
    expectClass('malformed', response(body));
  });
  test.each(['leading', 'after-whitespace', 'double'])(
    '%s BOM is malformed rather than silently removed',
    (where) => {
      const bom = Buffer.from([0xef, 0xbb, 0xbf]),
        wire = Buffer.from(resultWire());
      const body = Buffer.concat(
        where === 'leading'
          ? [bom, wire]
          : where === 'double'
            ? [bom, bom, wire]
            : [Buffer.from(' '), bom, wire]
      );
      expectClass('malformed', response(body));
    }
  );
  test.each([31, 32])('result array container nesting %i respects root depth one', (count) => {
    const wire =
      '{"jsonrpc":"2.0","id":' +
      requestId +
      ',"result":' +
      '['.repeat(count) +
      'null' +
      ']'.repeat(count) +
      '}';
    expectClass(count === 31 ? 'rpc-result' : 'malformed', response(wire));
  });
  test.each([30, 31])('error.data nesting %i counts the root and error containers', (count) => {
    const wire =
      '{"jsonrpc":"2.0","id":' +
      requestId +
      ',"error":{"code":0,"message":"","data":' +
      '['.repeat(count) +
      'null' +
      ']'.repeat(count) +
      '}}';
    expectClass(count === 30 ? 'rpc-error' : 'malformed', response(wire));
  });
  test('wide shallow objects are bounded by bytes, not a mistaken aggregate depth counter', () => {
    expectClass(
      'rpc-result',
      response(resultWire(Array.from({ length: 32 }, () => ({ value: [] }))))
    );
  });
  test('exact 2048-byte UTF-8 response is admitted and 2049 bytes refuses input', () => {
    const base = resultWire('');
    const wire = resultWire('é'.repeat(Math.floor((2048 - Buffer.byteLength(base)) / 2)));
    const body = Buffer.concat([
      Buffer.from(wire),
      Buffer.alloc(2048 - Buffer.byteLength(wire), 32),
    ]);
    expect(body.length).toBe(2048);
    expectClass('rpc-result', response(body));
    expectRefusal({
      submission: prepare({ requestId, payload: payload() }),
      evidence: response(Buffer.concat([body, Buffer.from(' ')])),
    });
  });
  test('a bounded Buffer slice uses only its own byte range', () => {
    const body = Buffer.from(resultWire());
    const backing = Buffer.concat([Buffer.alloc(4096, 0xff), body, Buffer.alloc(4096, 0xff)]);
    expectClass('rpc-result', response(backing.subarray(4096, 4096 + body.length)));
  });

  test.each([null, undefined, [], {}, 'PRIVATE_INPUT', 1])(
    'invalid caller options %# are sanitized refusals',
    (input) => expectRefusal(input)
  );
  test.each(['extra', 'missing-submission', 'missing-evidence'])(
    'invalid top-level %s is refused',
    (fault) => {
      const input = {
        submission: prepare({ requestId, payload: payload() }),
        evidence: response(resultWire()),
      };
      if (fault === 'extra') input.secret = 'PRIVATE_OPTIONS';
      else delete input[fault === 'missing-submission' ? 'submission' : 'evidence'];
      expectRefusal(input);
    }
  );
  test.each([
    null,
    undefined,
    [],
    {},
    { kind: 'other' },
    { kind: 'unavailable' },
    { kind: 'unavailable', reason: 'PRIVATE_REASON' },
    { kind: 'unavailable', reason: 'timeout', httpStatus: 200 },
  ])('invalid evidence %# is refused', (evidence) => {
    expectRefusal({ submission: prepare({ requestId, payload: payload() }), evidence });
  });
  test.each([0, 99, 600, -1, 200.5, NaN, Infinity, '200', null, undefined])(
    'invalid HTTP status %p refuses',
    (httpStatus) => {
      expectRefusal({
        submission: prepare({ requestId, payload: payload() }),
        evidence: { ...response(resultWire()), httpStatus },
      });
    }
  );
  test.each([
    undefined,
    null,
    '',
    new Uint8Array([123, 125]),
    new ArrayBuffer(2),
    {},
    Buffer.alloc(2049),
  ])('non-buffer or oversized body %# refuses', (body) => {
    expectRefusal({
      submission: prepare({ requestId, payload: payload() }),
      evidence: { kind: 'response', httpStatus: 200, body },
    });
  });
  test('extra response properties refuse and non-200 does not bypass the byte cap', () => {
    const submission = prepare({ requestId, payload: payload() });
    expectRefusal({ submission, evidence: { ...response(resultWire()), reason: 'PRIVATE' } });
    expectRefusal({ submission, evidence: response(Buffer.alloc(2049), 500) });
  });
  test.each(['payload', 'body', 'hash', 'endpoint', 'request-id'])(
    'noncanonical submission %s refuses even for unavailable evidence',
    (fault) => {
      const submission = copy(prepare({ requestId, payload: payload() }));
      if (fault === 'payload') submission.payload.proof.pi_a[0] = '99';
      if (fault === 'body') submission.body += ' ';
      if (fault === 'hash') submission.bodySha256 = '0'.repeat(64);
      if (fault === 'endpoint') submission.endpoint = 'https://PRIVATE.invalid';
      if (fault === 'request-id') submission.requestId++;
      expectRefusal({ submission, evidence: { kind: 'unavailable', reason: 'timeout' } });
    }
  );
  test('all outcomes redact raw content, errors, IDs, payload and body hashes', () => {
    const submission = prepare({ requestId, payload: payload() });
    const cases = [
      ['rpc-result', response(resultWire({ message: 'PRIVATE_SENTINEL', accepted: true }))],
      [
        'rpc-error',
        response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: requestId,
            error: { code: -32077, message: 'PRIVATE_SENTINEL', data: submission.payloadSha256 },
          })
        ),
      ],
      ['malformed', response('{PRIVATE_SENTINEL')],
      ['unmatched', response(resultWire('PRIVATE_SENTINEL', requestId + 1))],
      ['http-failure', response('PRIVATE_SENTINEL', 503)],
      ['unavailable', { kind: 'unavailable', reason: 'connection-failure' }],
    ];
    const logs = ['log', 'warn', 'error'].map((method) =>
      jest.spyOn(console, method).mockImplementation(() => {})
    );
    try {
      for (const [kind, evidence] of cases) {
        const text = JSON.stringify(expectClass(kind, evidence, submission));
        for (const secret of [
          'PRIVATE_SENTINEL',
          String(requestId),
          submission.bodySha256,
          submission.payloadSha256,
          '-32077',
        ])
          expect(text).not.toContain(secret);
      }
      for (const log of logs) expect(log).not.toHaveBeenCalled();
    } finally {
      logs.forEach((log) => log.mockRestore());
    }
  });
  test('throwing caller accessors expose only the fixed refusal', () => {
    const evidence = {
      kind: 'response',
      httpStatus: 200,
      get body() {
        throw Error('PRIVATE_ACCESSOR');
      },
    };
    expectRefusal({ submission: prepare({ requestId, payload: payload() }), evidence });
  });
  test('classification does not mutate its caller-owned submission or Buffer', () => {
    const submission = copy(prepare({ requestId, payload: payload() }));
    const original = copy(submission),
      evidence = response(resultWire({ accepted: true })),
      before = Buffer.from(evidence.body);
    const observed = expectClass('rpc-result', evidence, submission);
    expect(submission).toEqual(original);
    expect(evidence.body).toEqual(before);
    evidence.body.fill(0);
    expect(observed).toEqual(expectedInspection('rpc-result', { ...evidence, body: before }));
  });
});

test('cold response inspection loads no network, store, identity or utility boundary', () => {
  const forbidden = [
    '../networks/private-rpc',
    './privacy-storage',
    './railgun-poi-intent-store',
    './railgun-identity',
    './railgun-process',
    './railgun-poi-root',
  ];
  const touched = [];
  for (const name of forbidden)
    jest.doMock(name, () => {
      touched.push(name);
      throw Error('PRIVATE forbidden dependency');
    });
  try {
    jest.isolateModules(() => {
      const fresh = require('./railgun-poi-submit-data');
      const submission = fresh.prepareRailgunPoiSubmission({ requestId, payload: payload() });
      const evidence = response(resultWire({ accepted: true }));
      expect(fresh.inspectRailgunPoiResponse({ submission, evidence })).toEqual(
        expectedInspection('rpc-result', evidence)
      );
    });
    expect(touched).toEqual([]);
  } finally {
    for (const name of forbidden) jest.dontMock(name);
  }
});
