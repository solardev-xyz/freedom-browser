/**
 * window.swarm's contract, at main's dispatcher, on both Swarm backends
 * (freedom-core design 0015, SWM-7's Done-when: "the provider suites pass
 * against both backends as one contract suite, deviations marked", and its
 * 2026-11-28 amendment: "SWM-7's contract suite sits at the dispatcher";
 * the SWM-6 to SWM-9 plan's point 9 and PR 7.6).
 *
 * The backend is FREEDOM_SWARM_CONTRACT_BACKEND (`js` or `core`,
 * test/helpers/swarm-contract-backends.js); unset, the suite is skipped.
 *
 * - **The vectors' `methods` cases** (the pinned core's
 *   `vectors/swarm.json`, recorded from the JS reference through this same
 *   dispatcher): every case whose steps are page requests through main's
 *   dispatcher, each step's answer, the node requests it made (method,
 *   path, query, body, headers as the caller set them, status), the
 *   prompts it showed, the WebSockets opened, and the stores after (the
 *   feed store's text, the publish history's rows), against the
 *   reference's. On `core` the cases in the file's `deviations` map are
 *   asserted as the deviation each names (`deviationHolds`), and only
 *   there; the core's own clock writes its timestamps, which are held to
 *   the run's window.
 * - **The provider suites' behaviour the vectors lack** (swarm-provider-ipc,
 *   feed-service, chunk-service, messaging-service, publish-service):
 *   contract cases in the vectors' form (test/helpers/swarm-contract-cases.js),
 *   which both backends must pass with the same answers.
 * - **SW-1** (design 0015, "SW-1 in the core"): a raw SOC under the Bee
 *   wallet, a shared index, an exclusive index, a missing index, and an
 *   `ethereum-wallet` identity first, through the dispatcher on both
 *   backends (on `core`, through the pipe: the core's own check).
 *
 * The vectors are found as the other Swarm vector suites find them
 * (test/helpers/swarm-vectors.js): FREEDOM_CORE_SWARM_VECTORS names
 * freedom-core's `vectors` directory, as CI does at the pinned commit.
 */

const {
  BACKEND,
  contractVectors,
  coredBinary,
  removeCoreTemplate,
  runCase,
  viaDispatcher,
} = require('../../../test/helpers/swarm-contract-backends');
const { LEFT_OUT_ON_CORE, compareCase, summary } = require('../../../test/helpers/swarm-contract-compare');

const vectors = BACKEND ? contractVectors() : null;
if (BACKEND && process.env.FREEDOM_CORE_SWARM_VECTORS && !vectors) {
  throw new Error('FREEDOM_CORE_SWARM_VECTORS names no directory with swarm.json and keys.json');
}
const binary = BACKEND === 'core' ? coredBinary() : null;
const describeIf =
  BACKEND && vectors
    ? describe
    : (name, fn) => describe.skip(`${name} (skipped: no FREEDOM_SWARM_CONTRACT_BACKEND or no vectors)`, fn);

// A core per case, and 10 MiB uploads.
jest.setTimeout(120_000);

const env = vectors ? { keys: vectors.keys, trees: new Map(), binary } : null;
const cases = (vectors?.swarm.methods || []).filter(
  (kase) => kase.steps.some(viaDispatcher) && !(BACKEND === 'core' && Object.hasOwn(LEFT_OUT_ON_CORE, kase.id))
);
const outside = (vectors?.swarm.methods || []).filter((kase) => !kase.steps.some(viaDispatcher));
const seen = { played: 0, deviations: new Map() };

describeIf(`window.swarm's contract on the ${BACKEND} backend: vectors/swarm.json's methods`, () => {
  afterAll(() => {
    removeCoreTemplate();
    process.stdout.write(`${summary(BACKEND, seen, outside)}\n`);
  });

  test('the cases outside the dispatcher are only executeSwarmMethod with no page', () => {
    expect(outside.every((kase) => kase.steps.every((step) => step.page === false))).toBe(true);
  });

  test.each(cases.map((kase) => [kase.id, kase]))('%s', async (_id, kase) => {
    const record = await runCase(BACKEND, kase, env);
    const verdict = compareCase(BACKEND, kase, record);
    seen.played += 1;
    for (const id of verdict.deviations) seen.deviations.set(id, (seen.deviations.get(id) || 0) + 1);
    expect(verdict.problems).toEqual([]);
  });
});
