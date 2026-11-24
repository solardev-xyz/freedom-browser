/**
 * The fetch contract against freedom-core's COL-1 recording
 * (`vectors/colibri.json`): every data request the JS reference's C core
 * made, as the Colibri service would send it (`shell.colibri_fetch`), for
 * the operation its case opened.
 *
 * - A request the recording names a variant for is admitted as that variant,
 *   with the recorded fields: the verb, the path, the payload, the `Accept`,
 *   `Content-Type` and `Cache-Control` headers, and each server the reference
 *   sent it to, by index (chains 1 and 100, ZK on and off, as the cases
 *   record them).
 * - A checkpoint's own proof request is admitted as `checkpoint_proof`, with
 *   the request today's checkpoint worker made.
 * - A request for an operation the service doesn't serve (the recording's
 *   `colibri-unproofable`, `colibri-no-calls` and `colibri-unbound` cases)
 *   is refused, as the operation admits nothing.
 *
 * Skipped unless the vectors are found (`test/helpers/colibri-vectors.js`).
 */

const {
  admit,
  joinPath,
  CHECKPOINT_PROOF_PAYLOAD,
  COLIBRI_CLIENT_VERSION,
  COLIBRI_FETCH_VARIANTS,
} = require('./colibri-fetch-contract');
const {
  colibriVectors,
  colibriVectorsFile,
  colibriVectorsRequired,
  recordedOperations,
} = require('../../../test/helpers/colibri-vectors');

// Named outright (CI does): they must be there, so these suites can't skip.
(colibriVectorsRequired ? test : test.skip)(
  'the vectors FREEDOM_CORE_COLIBRI_VECTORS names are there',
  () => {
    expect(colibriVectors).not.toBeNull();
    expect(colibriVectorsFile).toBe(process.env.FREEDOM_CORE_COLIBRI_VECTORS);
  }
);

/** The headers `fetch_from_servers` sends for an admitted fetch. */
function headersOf(admitted) {
  return {
    Accept: admitted.accept,
    ...(admitted.payload !== null ? { 'Content-Type': 'application/json' } : {}),
    ...(admitted.maxAge !== null ? { 'Cache-Control': `max-age=${admitted.maxAge}` } : {}),
  };
}

(colibriVectors ? describe : describe.skip)("the COL-1 recording's data requests", () => {
  const operations = colibriVectors ? recordedOperations(colibriVectors) : [];
  const fetches = operations.flatMap((operation) =>
    operation.fetches.map((fetch) => ({ ...fetch, operation }))
  );

  test('the recording is the pinned Colibri, and names a variant or none for every request', () => {
    expect(colibriVectors.reference.client_version).toBe(COLIBRI_CLIENT_VERSION);
    expect(colibriVectors.reference.colibri_version).toBe('3.0.3');
    expect(fetches.length).toBeGreaterThan(0);
    for (const { operation, req, variant } of fetches) {
      expect([operation.case.id, req, variant === undefined]).toEqual([
        operation.case.id,
        req,
        false,
      ]);
    }
  });

  test('every request the recording names a variant for is admitted as it, with the recorded fields', () => {
    const admittedCount = new Map();
    for (const { operation, variant, params, sent, own } of fetches) {
      if (variant === null) continue;
      const { op } = operation;
      const label = `${operation.case.id} ${params.type} ${params.path}`;
      const admitted = admit(op, params);
      expect([label, admitted.refused, admitted.variant]).toEqual([label, undefined, variant]);
      expect(admitted.verb).toBe(params.method.toUpperCase());
      expect(admitted.path).toBe(params.path);
      expect(admitted.maxAge).toBe(params.max_age ?? null);
      expect(admitted.maxBody).toBe(COLIBRI_FETCH_VARIANTS[variant].maxBody);
      if (own) {
        // Main's own request, as today's checkpoint worker made it.
        expect(admitted.payload).toBe(CHECKPOINT_PROOF_PAYLOAD);
        expect(sent).toHaveLength(1);
        expect(sent[0].method).toBe('POST');
        expect(sent[0].url).toBe(joinPath(admitted.servers[0], admitted.path));
        expect(sent[0].body).toBe(admitted.payload);
      } else {
        expect(admitted.payload).toBe(
          params.payload === undefined ? null : JSON.stringify(params.payload)
        );
        for (const request of sent) {
          expect([label, request.url]).toEqual([
            label,
            joinPath(admitted.servers[request.index], admitted.path),
          ]);
          expect(request.method).toBe(admitted.verb);
          expect(request.headers).toEqual(headersOf(admitted));
          if (admitted.payload !== null) expect(request.body).toBe(admitted.payload);
        }
      }
      const key = `${variant} ${op.chain} ${op.kind === 'request' ? `zk=${op.zk}` : 'checkpoint'}`;
      admittedCount.set(key, (admittedCount.get(key) ?? 0) + 1);
    }
    // Every variant is reached on both chains, as the recording lists it.
    for (const [variant, { chains }] of Object.entries(colibriVectors.variants)) {
      for (const chain of chains) {
        const reached = [...admittedCount.keys()].some((key) =>
          key.startsWith(`${variant} ${chain} `)
        );
        expect([variant, chain, reached]).toEqual([variant, chain, true]);
      }
    }
    expect(Object.keys(colibriVectors.variants).sort()).toEqual(
      Object.keys(COLIBRI_FETCH_VARIANTS).sort()
    );
    // ZK on and off, as the cases record them.
    for (const zk of [true, false]) {
      expect([...admittedCount.keys()].some((key) => key.endsWith(`zk=${zk}`))).toBe(true);
    }
    const total = [...admittedCount.values()].reduce((sum, count) => sum + count, 0);
    expect(total).toBe(fetches.filter((fetch) => fetch.variant !== null).length);
  });

  test("every request for a form the service doesn't serve is refused", () => {
    const refused = fetches.filter((fetch) => fetch.variant === null);
    expect(refused.length).toBeGreaterThan(0);
    for (const { operation, params } of refused) {
      expect(operation.case.design?.refused).toEqual(expect.any(String));
      expect([operation.case.id, admit(operation.op, params)]).toEqual([
        operation.case.id,
        { refused: 'operation' },
      ]);
    }
  });

  test('an ended operation admits none of them', () => {
    for (const { operation, params } of fetches) {
      expect(admit({ ...operation.op, ended: true }, params)).toEqual({ refused: 'request' });
    }
  });
});
