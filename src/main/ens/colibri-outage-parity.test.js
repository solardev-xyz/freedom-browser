/**
 * A prover outage on both Colibri backends (freedom-core design 0014, A
 * failed remote proof; COL-5's acceptance): an HTTP error and a transport
 * error give byte-identical adapter outcomes (name, code, message, data) on
 * the WASM verifier with #1081 and on freedom-colibrid, the transport
 * error's URL apart (deviation `fetch-error-text`), including the vectors'
 * cases whose completed message crosses the 2,000-unit cut. Each backend
 * asks the configured prover once, and nothing else.
 *
 * test/helpers/colibri-prover-outage.js runs the reads: the real WASM path
 * in a child, the real binary through colibri-service.js on a scripted hop.
 * The service's parts are skipped without the binary, and fail without it
 * under FREEDOM_COLIBRID_REQUIRED=1 (test/helpers/colibri-backends.js); the
 * vectors' part is skipped without freedom-core's vectors, and fails without
 * them when FREEDOM_CORE_COLIBRI_VECTORS names the file.
 */

jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const {
  backendOf,
  colibridRequired,
  cut,
  deviation,
  outcomeOf,
} = require('../../../test/helpers/colibri-backends');
const {
  ACCOUNT,
  HTTP_503,
  PROVER,
  TRANSPORT,
  f9Cases,
  proverOutage,
  wasmOutages,
} = require('../../../test/helpers/colibri-prover-outage');
const { colibriVectors, colibriVectorsRequired } = require('../../../test/helpers/colibri-vectors');

const WASM = backendOf('wasm');
const SERVICE = backendOf('service');

/** A test that needs the binary: skipped without it, or failed under
 * FREEDOM_COLIBRID_REQUIRED=1. */
function serviceTest(name, fn, timeout) {
  if (SERVICE.available) return test(name, fn, timeout);
  if (colibridRequired) {
    return test(`${name} (FREEDOM_COLIBRID_REQUIRED=1)`, () => {
      throw new Error(SERVICE.missing);
    });
  }
  return test.skip(`${name}: ${SERVICE.missing}`, fn);
}
serviceTest.each = (rows) => (name, fn, timeout) => {
  for (const row of rows) {
    const title = name.replace('%s', row[0]);
    serviceTest(title, () => fn(...row), timeout);
  }
};

/** What `fetch-error-text` makes of the WASM path's error for the service:
 * URLs as `<url>` in the whole text, then the 2,000-unit cut. */
function asService(wasm, raw, prover) {
  return { ...outcomeOf(wasm), message: cut(raw.split(prover).join('<url>')) };
}

/**
 * Both backends' outcomes for one read, compared: identical, or for a
 * transport failure the WASM text with its prover URL as `<url>` and cut
 * after. Each asked the prover once, with the same request.
 */
function expectParity(wasm, service, read) {
  expect(wasm.error).not.toBeNull();
  expect(service.error).not.toBeNull();
  expect(outcomeOf(wasm.error).message).toBe(cut(wasm.raw));
  const transport = Boolean(read.failure.transport);
  expect(outcomeOf(service.error)).toEqual(
    transport
      ? deviation('fetch-error-text', SERVICE, {
          wasm: outcomeOf(wasm.error),
          service: asService(wasm.error, wasm.raw, read.prover),
        })
      : outcomeOf(wasm.error)
  );
  expect(wasm.fetched.map(({ url, method }) => [url, method])).toEqual([[read.prover, 'POST']]);
  expect(service.fetched.map(({ url, method }) => [url.replace(/\/$/, ''), method])).toEqual([
    [read.prover, 'POST'],
  ]);
  expect(service.fetched[0].body).toBe(wasm.fetched[0].body);
}

describe('a prover outage on both backends', () => {
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
  let wasm;

  beforeAll(async () => {
    wasm = await wasmOutages(ROWS.map(([, read]) => read));
  }, 120_000);

  test('the WASM path ends each with the prover\'s error, cut where the worker cuts', () => {
    ROWS.forEach(([, read], at) => {
      const { error, raw } = wasm[at];
      expect(error).toMatchObject({ name: 'ProviderRpcError' });
      expect(raw).toContain(': remote proof failed (no local proving): ');
      expect(error.message).toBe(cut(raw));
      expect(error.code).toBe(read.failure.transport ? -32603 : 4900);
    });
  });

  serviceTest.each(ROWS)(
    '%s: the same outcome on freedom-colibrid',
    async (_name, read) => {
      const at = ROWS.findIndex(([, row]) => row === read);
      expectParity(wasm[at], await proverOutage(SERVICE.kind, read), read);
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
  let wasm;

  beforeAll(async () => {
    wasm = await wasmOutages(cases.map(({ read }) => read));
  }, 120_000);

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
    '%s: the WASM path gives the recorded outcome',
    (_id, entry) => {
      const { error, fetched } = wasm[cases.indexOf(entry)];
      expect(outcomeOf(error)).toEqual({ data: undefined, ...entry.outcome });
      expect(fetched.map(({ url }) => url)).toEqual([entry.read.prover]);
    }
  );

  serviceTest.each(cases.map((entry) => [entry.id, entry]))(
    '%s: freedom-colibrid gives the design\'s outcome, the WASM one but its URL',
    async (_id, entry) => {
      const service = await proverOutage(SERVICE.kind, entry.read);
      expect(outcomeOf(service.error)).toEqual({ data: undefined, ...entry.design });
      if (entry.deviation) expect(entry.deviation).toBe('fetch-error-text');
      expectParity(wasm[cases.indexOf(entry)], service, entry.read);
    },
    30_000
  );
});

// The WASM backend is the reference: it deviates from nothing.
test('the WASM backend is its own reference', () => {
  expect(deviation('fetch-error-text', WASM, { wasm: 'raw', service: '<url>' })).toBe('raw');
});
