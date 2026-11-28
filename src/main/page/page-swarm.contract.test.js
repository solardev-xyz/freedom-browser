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
 * - **The provider suites' behaviour the vectors lack**
 *   (test/helpers/swarm-contract-cases.js `contractCases`): feed writes to
 *   one feed at once and to two, every subscription frame delivered, the
 *   node's subscription limit, GSOC's per-origin topic budget and its cache,
 *   a feed read on a node that is down, and two blob reads at once past the
 *   read budget: both backends must pass each with the same answers.
 * - **SW-1 through the pipe** (`SW1`): the vectors' raw-SOC cases under the
 *   Bee wallet, a shared index, an index only this site holds, a missing
 *   index and an Ethereum wallet identity first, each held to its recorded
 *   answer, and each reaching the backend; on `core` as one `swarm.request`
 *   the core answered, so the answer is the core's own check's.
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
  timeFixer,
} = require('../../../test/helpers/swarm-contract-compare');
const { SW1, contractCases } = require('../../../test/helpers/swarm-contract-cases');

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

describeIf(`window.swarm's contract on the ${BACKEND} backend: the provider suites' behaviour beyond the vectors`, () => {
  let extra;

  beforeAll(async () => {
    extra = await contractCases(vectors.swarm);
  });

  afterAll(() => {
    removeCoreTemplate();
    process.stdout.write(`[swarm contract] ${BACKEND}: ${extra?.length ?? 0} behaviour cases played\n`);
  });

  test.each([
    'contract/feed-writes-one-feed-at-once',
    'contract/feed-writes-two-feeds-at-once',
    'contract/subscribe-frames-delivered',
    'contract/subscribe-node-limit',
    'contract/gsoc-budget-cache-hit-and-other-site',
    'contract/read-feed-node-unreachable',
    'contract/read-data-two-at-once-past-the-budget',
  ])('%s', async (id) => {
    const kase = extra.find((one) => one.id === id);
    const record = await runCase(BACKEND, kase, env);
    const problems = kase.check(record, { fixAt: timeFixer(BACKEND, kase, record) });
    if (record.exits?.length) problems.push(`the core exited: ${JSON.stringify(record.exits)}`);
    expect(problems).toEqual([]);
  });

  test('every behaviour case is played', () => {
    expect(extra.map((kase) => kase.id).sort()).toEqual(
      [
        'contract/feed-writes-one-feed-at-once',
        'contract/feed-writes-two-feeds-at-once',
        'contract/subscribe-frames-delivered',
        'contract/subscribe-node-limit',
        'contract/gsoc-budget-cache-hit-and-other-site',
        'contract/read-feed-node-unreachable',
        'contract/read-data-two-at-once-past-the-budget',
      ].sort()
    );
  });
});

describeIf(`window.swarm's contract on the ${BACKEND} backend: SW-1 through the pipe`, () => {
  afterAll(() => removeCoreTemplate());

  test.each(Object.entries(SW1))('%s (%s)', async (id) => {
    const kase = vectors.swarm.methods.find((one) => one.id === id);
    const record = await runCase(BACKEND, kase, env);
    const verdict = compareCase(BACKEND, kase, record);
    const step = record.steps[0];
    // It reached the backend: the refusal is the backend's own.
    expect(step.events.filter((e) => e.service)).toEqual([{ service: 'swarm_writeSingleOwnerChunk' }]);
    if (BACKEND === 'core') {
      // One swarm.request, which the core answered.
      expect(step.sent).toEqual([
        { method: 'swarm_writeSingleOwnerChunk', answer: 'error' in step ? 'error_typed' : 'result_typed' },
      ]);
    }
    expect(verdict.problems).toEqual([]);
  });
});
