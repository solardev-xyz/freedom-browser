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
 *   reference's (test/helpers/swarm-contract-compare.js). On `core` the
 *   cases in the file's `deviations` map are asserted as the deviation each
 *   names, and only there (`subscribe-proxy` is main's own route test, so
 *   on both); main's executor sends its own headers first, which aren't
 *   compared; the core's clock writes its times (store timestamps, a tar's
 *   mtimes, a feed update's time and so its signature, which the node
 *   checks), held to the run's window; and the core's vault always holds
 *   its main wallet, which the generator's listed none of.
 * - **Known core-vectors differences** (`KNOWN_CORE_VECTOR_DIFFERENCES`):
 *   a case whose recorded `core` answer main's own route test now reads
 *   otherwise is held to the reference on both backends; the test below
 *   fails once freedom-core's vectors change it, so the entry goes then.
 * - **Left out on `core`** (`LEFT_OUT_ON_CORE`), each with why, and on
 *   both the cases that call `executeSwarmMethod` with no page.
 *
 * The provider suites' behaviour the vectors lack, and SW-1's cases, are
 * contract cases in the same form (PR 7.6b).
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
const {
  KNOWN_CORE_VECTOR_DIFFERENCES,
  LEFT_OUT_ON_CORE,
  compareCase,
  summary,
} = require('../../../test/helpers/swarm-contract-compare');

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

  test("each known core-vectors difference is still the vectors' refusal", () => {
    for (const id of Object.keys(KNOWN_CORE_VECTOR_DIFFERENCES)) {
      const kase = vectors.swarm.methods.find((one) => one.id === id);
      expect(kase?.deviation).toBe('subscribe-proxy');
      expect(kase.core?.error?.data).toEqual({ reason: 'proxy-or-tor' });
    }
  });

  test('each case left out on the core is in the vectors', () => {
    const ids = new Set(vectors.swarm.methods.map((kase) => kase.id));
    expect(Object.keys(LEFT_OUT_ON_CORE).filter((id) => !ids.has(id))).toEqual([]);
  });

  test.each(cases.map((kase) => [kase.id, kase]))('%s', async (_id, kase) => {
    const record = await runCase(BACKEND, kase, env);
    const verdict = compareCase(BACKEND, kase, record);
    seen.played += 1;
    for (const id of verdict.deviations) seen.deviations.set(id, (seen.deviations.get(id) || 0) + 1);
    expect(verdict.problems).toEqual([]);
  });
});
