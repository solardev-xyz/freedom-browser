/**
 * A prover outage on freedom-colibrid (freedom-core design 0014, A failed
 * remote proof): an HTTP error and a transport error give the reference's
 * adapter outcomes (name, code, message, data) byte for byte, the transport
 * error's URL apart (deviation `fetch-error-text`), including the cases
 * whose completed message crosses the 2,000-unit cut. The reference is the
 * WASM verifier with #1081, which COL-6 removed: its outcomes for this
 * suite's table were recorded before it went
 * (test/fixtures/colibri/reference-outages.json), and freedom-core's vectors
 * record its F-9 cases. The service asks the configured prover once, with
 * the reference's request, and nothing else.
 *
 * test/helpers/colibri-prover-outage.js runs the reads: the real binary
 * through colibri-service.js on a scripted hop. They are skipped without the
 * binary, and fail without it under FREEDOM_COLIBRID_REQUIRED=1
 * (test/helpers/colibri-service-harness.js); the vectors' part is skipped
 * without freedom-core's vectors, and fails without them when
 * FREEDOM_CORE_COLIBRI_VECTORS names the file.
 */

jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const {
  cut,
  deviation,
  outcomeOf,
  serviceTest,
} = require('../../../test/helpers/colibri-service-harness');
const {
  ACCOUNT,
  HTTP_503,
  PROVER,
  TRANSPORT,
  f9Cases,
  proverOutage,
  proverOutageError,
} = require('../../../test/helpers/colibri-prover-outage');
const { colibriVectors, colibriVectorsRequired } = require('../../../test/helpers/colibri-vectors');
const RECORDED = require('../../../test/fixtures/colibri/reference-outages.json');

/** The service asked the prover once, with `body`. */
function expectOneProverRequest(service, prover, body) {
  expect(service.fetched.map(({ url, method }) => [url.replace(/\/$/, ''), method])).toEqual([
    [prover, 'POST'],
  ]);
  expect(service.fetched[0].body).toBe(body);
}

describe('a prover outage', () => {
  const STORAGE = '0x0000000000000000000000000000000000000000000000000000000000000000';
  const BLOCK = `0x${'89'.repeat(32)}`;
  /** Each proofable method the service serves, and params that carry the
   * completed message past 2,000 units. */
  const READS = [
    ['eth_getBalance', [ACCOUNT, 'latest']],
    ['eth_getTransactionCount', [ACCOUNT, 'latest']],
    ['eth_getStorageAt', [ACCOUNT, STORAGE, 'latest']],
    ['eth_getCode', [ACCOUNT, 'latest']],
    ['eth_blockNumber', []],
    ['eth_getBlockByNumber', ['latest', false]],
    ['eth_getBlockByHash', [BLOCK, false]],
    ['eth_maxPriorityFeePerGas', []],
    ['eth_blockNumber', [`0x${'ab'.repeat(500)}`]],
  ];
  const FAILURES = [
    ['an HTTP error', HTTP_503],
    ['an HTTP error past 2,000 units', { status: 503, body: 'z'.repeat(2_100) }],
    ['a transport error', TRANSPORT],
  ];
  const ROWS = READS.flatMap(([method, params]) =>
    FAILURES.map(([failureName, failure]) => [
      `${method}(${params.length ? `${String(params[0]).slice(0, 12)}…` : ''}) with ${failureName}`,
      { method, params, failure, prover: PROVER },
    ])
  );

  test("the recording has every row, the reference's failed remote proof, cut where its worker cut", () => {
    expect(Object.keys(RECORDED).sort()).toEqual(ROWS.map(([name]) => name).sort());
    for (const [name, read] of ROWS) {
      const { outcome, reference, deviation: tag } = RECORDED[name];
      const transport = Boolean(read.failure.transport);
      expect(outcome).toMatchObject({
        name: 'ProviderRpcError',
        code: transport ? -32603 : 4900,
        message: expect.stringContaining(' : remote proof failed (no local proving): '),
      });
      expect(outcome.message.length).toBeLessThanOrEqual(2_000);
      if (transport) {
        // The reference named the prover's URL; the service writes `<url>`.
        expect(tag).toBe('fetch-error-text');
        expect(deviation(tag)).toEqual(expect.any(String));
        expect(reference.message).toContain(PROVER);
        expect(outcome.message).not.toContain(PROVER);
      } else {
        expect(tag).toBeUndefined();
        expect(reference).toBeUndefined();
      }
    }
  });

  serviceTest.each(ROWS)(
    "%s: the reference's recorded outcome",
    async (name, read) => {
      const service = await proverOutage(read);
      expect(service.error).not.toBeNull();
      expect(outcomeOf(service.error)).toEqual({ data: undefined, ...RECORDED[name].outcome });
      expectOneProverRequest(service, read.prover, RECORDED[name].prover_body);
    },
    30_000
  );

  serviceTest(
    "proverOutageError() is the binary's outcome for an HTTP 503",
    async () => {
      const service = await proverOutage({ failure: HTTP_503 });
      expect(outcomeOf(service.error)).toEqual(outcomeOf(proverOutageError()));
    },
    30_000
  );
});

(colibriVectorsRequired ? test : test.skip)(
  "freedom-core's Colibri vectors are found when FREEDOM_CORE_COLIBRI_VECTORS names them",
  () => {
    expect(colibriVectors).not.toBeNull();
  }
);

(colibriVectors ? describe : describe.skip)("the vectors' F-9 cases (COL-1)", () => {
  const cases = colibriVectors ? f9Cases(colibriVectors) : [];

  test('cover every outage, both chains, and the cut', () => {
    const ids = cases.map(({ id }) => id);
    for (const chain of [1, 100]) {
      for (const failure of ['http', 'transport']) {
        expect(ids.filter((id) => id.startsWith(`${chain}-f9-${failure}-`)).length).toBe(8);
      }
    }
    expect(ids).toEqual(
      expect.arrayContaining(['1-f9-cut-message', '1-f9-cut-body', '1-f9-cut-params'])
    );
    // The cut cases' recorded messages are cut.
    for (const id of ['1-f9-cut-message', '1-f9-cut-body', '1-f9-cut-params']) {
      expect(cases.find((entry) => entry.id === id).outcome.message).toHaveLength(2_000);
    }
  });

  test.each(cases.map((entry) => [entry.id, entry]))(
    "%s: the design's outcome is the reference's, but its URL",
    (_id, entry) => {
      if (!entry.deviation) {
        expect(entry.design).toEqual(entry.outcome);
        return;
      }
      // fetch-error-text: URLs as `<url>` in the whole text, then the cut.
      expect(entry.deviation).toBe('fetch-error-text');
      expect(entry.design).toMatchObject({ name: entry.outcome.name, code: entry.outcome.code });
      expect(entry.design.message).toBe(cut(entry.design.message));
      expect(entry.outcome.message).toContain(entry.read.prover.replace(/\/$/, ''));
      expect(entry.design.message).not.toContain(entry.read.prover.replace(/\/$/, ''));
    }
  );

  serviceTest.each(cases.map((entry) => [entry.id, entry]))(
    "%s: freedom-colibrid gives the design's outcome, asking the prover once, as recorded",
    async (_id, entry) => {
      const service = await proverOutage(entry.read);
      expect(outcomeOf(service.error)).toEqual({ data: undefined, ...entry.design });
      expectOneProverRequest(service, entry.read.prover.replace(/\/$/, ''), entry.body);
    },
    30_000
  );
});
