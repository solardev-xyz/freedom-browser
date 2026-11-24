/**
 * Successful reads replayed on both Colibri backends (freedom-core design
 * 0014, COL-5), from freedom-core's recordings (COL-1): for each case, a
 * scripted prover, beacon and checkpoint world answers every fetch with the
 * body the live servers gave at capture, at the case's recorded clock. The
 * WASM verifier and freedom-colibrid must each give the recorded outcome,
 * the same result, through the recorded fetches (URL, verb, headers and
 * body), leaving the recorded store. Where the design says the service's
 * outcome differs, the case is marked with its deviation, and the service
 * must give the design's.
 *
 * test/helpers/colibri-replay.js runs the cases: the real WASM path in a
 * child, the real binary through colibri-service.js on a scripted hop. A
 * released binary's C core reads the system clock, and only for its
 * transaction cache; the cases that depend on it (`cCoreClock`) run on
 * a binary built with the `testhooks` feature, which fixes it
 * (FREEDOM_COLIBRID_TESTHOOKS_PATH), and are skipped on the released one.
 * With that binary every case runs on it too, as freedom-core's own replay
 * does.
 *
 * The service's parts are skipped without the binary, and fail without it
 * under FREEDOM_COLIBRID_REQUIRED=1 (test/helpers/colibri-backends.js). The
 * suite is skipped without freedom-core's vectors and their fixtures
 * (`vectors/fixtures/colibri/` beside the file), and fails without them when
 * FREEDOM_CORE_COLIBRI_VECTORS names the file.
 */

jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const {
  COLIBRID_TESTHOOKS,
  backendOf,
  deviation,
  serviceTest,
} = require('../../../test/helpers/colibri-backends');
const {
  colibriFixturesDir,
  colibriVectors,
  colibriVectorsRequired,
} = require('../../../test/helpers/colibri-vectors');
const replay = require('../../../test/helpers/colibri-replay');
const { COLIBRI_SERVED_METHODS } = require('./colibri-served');

const SERVICE = backendOf('service');
/** The released binary (or FREEDOM_COLIBRID_PATH): its C core on the
 * system clock. */
const RELEASED = Object.freeze({ label: 'service' });
/** A `testhooks` build: its C core at each request's recorded instant. */
const TESTHOOKS = Object.freeze({
  label: 'testhooks',
  command: COLIBRID_TESTHOOKS,
  serviceVersion: null,
  testClock: true,
});
const TIMEOUT_MS = 180_000;

/** A test on the `testhooks` build: skipped, its reason in the title,
 * unless FREEDOM_COLIBRID_TESTHOOKS_PATH names one. */
function testhooksTest(name, fn, timeout) {
  if (COLIBRID_TESTHOOKS) return test(name, fn, timeout);
  return test.skip(`${name}: needs a testhooks build (FREEDOM_COLIBRID_TESTHOOKS_PATH)`, fn);
}

/** A recorded outcome in the form `replay.asRecorded` writes a result. */
function recordedForm(outcome) {
  if (outcome.result_undefined) return { result_undefined: true };
  if (outcome.result_json) return { result_json: outcome.result_json };
  return { result: outcome.result };
}

/** Each outcome is the recorded success. */
function expectRecorded(outcomes, recorded) {
  expect(outcomes.map((outcome) => outcome?.ok)).toEqual(recorded.map(() => true));
  outcomes.forEach((outcome, index) => {
    expect(replay.asRecorded(outcome.result, recorded[index])).toEqual(
      recordedForm(recorded[index])
    );
  });
}

/** The recorded outcomes (`ok` and result, or the error's fields), as both
 * backends' runs give them. */
const asOutcomes = (outcomes) =>
  outcomes.map(({ ok, error, ...rest }) => (ok ? { ok, ...rest } : { ok, error }));

/**
 * The service's run against the WASM path's and the recording: the same
 * result through the same fetches, leaving the same store; or, for a case
 * marked with a deviation, the design's outcome with no fetch.
 */
function expectService(service, wasm, entry) {
  expect(service.unscripted).toEqual([]);
  if (entry.deviation) {
    expect(asOutcomes(service.outcomes)).toEqual(
      deviation(entry.deviation, SERVICE, {
        wasm: asOutcomes(entry.outcomes),
        service: asOutcomes(entry.design),
      })
    );
    expect(service.fetched).toEqual([]);
    if (entry.storeAfter) expect(service.store).toEqual(entry.seed);
    return;
  }
  expectRecorded(service.outcomes, entry.outcomes);
  expect(service.outcomes).toEqual(wasm.outcomes);
  expect(replay.madeFetches(service.fetched)).toEqual(replay.recordedFetches(entry));
  if (entry.storeAfter) expect(service.store).toEqual(entry.storeAfter);
  // A private session's process has no directory: nothing reaches the disk.
  if (entry.private) expect(service.written).toEqual([]);
}

(colibriVectorsRequired ? test : test.skip)(
  "freedom-core's Colibri fixtures are found beside the vectors FREEDOM_CORE_COLIBRI_VECTORS names",
  () => {
    expect(colibriFixturesDir).not.toBeNull();
  }
);

const READY = Boolean(colibriVectors && colibriFixturesDir);

(READY ? describe : describe.skip)(
  "successful reads replayed on both backends (COL-1's recordings)",
  () => {
    const cases = READY ? replay.replayCases(colibriVectors) : [];
    const byId = new Map(cases.map((entry) => [entry.id, entry]));
    const title = (entry) =>
      entry.deviation ? `${entry.id} [deviation ${entry.deviation}]` : entry.id;
    const rows = cases.map((entry) => [title(entry), entry]);

    afterAll(() => replay.cleanup());

    test('cover every served method on both chains, and each deviation of a recorded success', () => {
      for (const chain of [1, 100]) {
        const methods = new Set(
          cases
            .filter((entry) => entry.chain === chain && !entry.deviation)
            .flatMap((entry) => entry.requests.map((request) => request.method))
        );
        expect([...methods].sort()).toEqual([...COLIBRI_SERVED_METHODS].sort());
      }
      expect(new Set(cases.map((entry) => entry.deviation).filter(Boolean))).toEqual(
        new Set(['colibri-unproofable', 'colibri-no-calls', 'colibri-unbound'])
      );
      for (const entry of cases) {
        // Every one a success in the recording, and a warm one's source here.
        expect(entry.outcomes.every((outcome) => outcome.ok)).toBe(true);
        if (entry.source) expect(byId.has(entry.source)).toBe(true);
      }
    });

    test.each(rows)(
      '%s: the WASM path gives the recorded outcome',
      async (_title, entry) => {
        const wasm = await replay.wasmReplay(entry, byId, colibriFixturesDir);
        expect(wasm.unscripted).toEqual([]);
        expectRecorded(wasm.outcomes, entry.outcomes);
        expect(replay.madeFetches(wasm.fetched)).toEqual(replay.recordedFetches(entry));
        if (entry.storeAfter) expect(wasm.store).toEqual(entry.storeAfter);
      },
      TIMEOUT_MS
    );

    // On the released binary, the cases whose fetches depend on the C core's
    // clock can't be replayed.
    for (const [name, entry] of rows.filter(([, entry]) => entry.cCoreClock)) {
      test.skip(
        `${name}: freedom-colibrid gives the WASM path's outcome: the C core's clock is the ` +
          "system's (a testhooks build fixes it)",
        () => entry
      );
    }

    serviceTest.each(rows.filter(([, entry]) => !entry.cCoreClock))(
      "%s: freedom-colibrid gives the WASM path's outcome",
      async (_title, entry) => {
        const service = await replay.serviceReplay(entry, byId, colibriFixturesDir, RELEASED);
        const wasm = await replay.wasmReplay(entry, byId, colibriFixturesDir);
        expectService(service, wasm, entry);
      },
      TIMEOUT_MS
    );

    for (const [name, entry] of rows) {
      testhooksTest(
        `${name}: freedom-colibrid with its C core at the recorded clock gives the WASM path's outcome`,
        async () => {
          const service = await replay.serviceReplay(entry, byId, colibriFixturesDir, TESTHOOKS);
          const wasm = await replay.wasmReplay(entry, byId, colibriFixturesDir);
          expectService(service, wasm, entry);
        },
        TIMEOUT_MS
      );
    }
  }
);
