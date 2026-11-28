/**
 * Main's typed calls to the Swarm stores (swarm-stores.js; freedom-core
 * design 0015, D5, D7 and D12) against the pinned core's
 * `vectors/swarm.json`: every `shell` case of `swarm.identities`,
 * `swarm.history` and `swarm.manifest`, step by step, through the calls.
 * For each step:
 * - **encode:** the step's members, read back as JavaScript held them
 *   (`readTyped`), passed to the call for the step's caller, give the
 *   step's params exactly, in the wire form (`{ op, ...typed members }`),
 *   sent as `{ caller }` with `requires: swarm_stores` and its op's
 *   watchdog;
 * - **decode:** the core's answer (the step's, or the case's `core.answers`
 *   where it marks a deviation) comes back as JavaScript holds it: a
 *   result equal to the reference's own, or what the reference threw,
 *   thrown again with its class, message and code; and, where the case
 *   marks no deviation, the chrome's history handlers' wrap around it
 *   (`{ success, entries }`) is the step's `handler` answer.
 *
 * Skipped unless the vectors are found (test/helpers/swarm-vectors.js):
 * FREEDOM_CORE_SWARM_VECTORS names freedom-core's `vectors` directory, as
 * CI does at the pinned commit, and then a missing file fails the suite.
 */

const { swarmVectors, swarmVectorsRequired } = require('../../../test/helpers/swarm-vectors');
const { SWARM_STORES } = require('./core-client');
const { createSwarmStores, storeWatchdogMs } = require('./swarm-stores');
const { readTyped } = require('./swarm-typed');

const swarm = swarmVectors('swarm.json');
const describeIfVectors = swarm ? describe : describe.skip;

const CALLS = Object.freeze({
  'swarm.identities': 'identities',
  'swarm.history': 'history',
  'swarm.manifest': 'manifest',
});

const cases = (swarm?.shell || []).filter((c) => Object.hasOwn(CALLS, c.method));

(swarmVectorsRequired ? test : test.skip)(
  'the vectors FREEDOM_CORE_SWARM_VECTORS names are there',
  () => {
    expect(swarm?.shell?.length).toBeGreaterThan(0);
  }
);

/** A step's members, as JavaScript held them: every param but `op`, read back. */
function membersOf(params) {
  const out = {};
  for (const [key, typed] of Object.entries(params)) {
    if (key !== 'op') out[key] = readTyped(typed);
  }
  return out;
}

/** What the reference returned or threw, as `{ result }` or `{ error }`. */
function referenceOutcome(reference) {
  if (Object.hasOwn(reference, 'result')) return { result: reference.result };
  if (Object.hasOwn(reference, 'result_typed'))
    return { result: readTyped(reference.result_typed) };
  return { error: reference.error };
}

/**
 * The chrome's handler's answer around a step: `answer`, or `answer_typed`
 * read back (the generator's `handler { channel, answer | answer_typed }`;
 * core PR K1's cases give the typed form).
 */
function handlerAnswer(handler) {
  return Object.hasOwn(handler, 'answer_typed') ? readTyped(handler.answer_typed) : handler.answer;
}

/** The core's answer for step `i`: the case's own where it marks a deviation. */
function coreAnswer(testCase, i) {
  const answers = testCase.core?.answers;
  return answers ? answers[i] : testCase.steps[i].answer;
}

/** A call's outcome: `{ result }`, or `{ thrown }` with its class's name, message and code. */
async function outcomeOf(promise) {
  try {
    return { result: await promise };
  } catch (err) {
    return {
      thrown: { name: err.name, message: err.message, ...(err.code ? { code: err.code } : {}) },
      ctor: err.constructor,
    };
  }
}

describeIfVectors("the Swarm store calls against vectors/swarm.json's shell cases", () => {
  test('the identities, history and manifest cases are all here', () => {
    const counts = {};
    for (const c of cases) counts[c.method] = (counts[c.method] || 0) + 1;
    // cored 0.33.0's (core PR K1): history-add-update and
    // history-update-blob join the history's two.
    expect(counts).toEqual({ 'swarm.identities': 21, 'swarm.history': 4, 'swarm.manifest': 15 });
    expect(cases).toHaveLength(40);
  });

  test.each(cases.map((c) => [c.id, c]))('%s', async (_id, testCase) => {
    const sent = [];
    let answer = null;
    const stores = createSwarmStores({
      request: async (method, params, context, options) => {
        sent.push({ method, params, context, options });
        return answer;
      },
    });
    const call = stores[CALLS[testCase.method]];
    const deviation = Boolean(testCase.core?.answers);
    if (deviation) expect(testCase.core.answers).toHaveLength(testCase.steps.length);

    for (const [i, step] of testCase.steps.entries()) {
      answer = coreAnswer(testCase, i);
      const outcome = await outcomeOf(
        call(step.params.op, membersOf(step.params), { caller: step.caller })
      );
      const label = `${testCase.id} step ${i} (${step.params.op})`;

      // Encode: what main sent is the step's params, in the wire form.
      expect([label, sent.length]).toEqual([label, i + 1]);
      const request = sent[i];
      expect([label, request.method]).toEqual([label, testCase.method]);
      expect([label, request.params]).toEqual([label, step.params]);
      expect(Object.keys(request.params)[0]).toBe('op');
      expect([label, request.context]).toEqual([label, { caller: step.caller }]);
      expect(request.options.watchdogMs).toBe(storeWatchdogMs(testCase.method, step.params.op));
      expect(request.options.requires({ store_moved: [SWARM_STORES] })).toBe(true);
      expect(request.options.requires({ store_moved: ['vault_meta'] })).toBe(false);

      // Decode: the core's answer as JavaScript holds it.
      if (Object.hasOwn(answer, 'result_typed')) {
        expect([label, outcome]).toEqual([label, { result: readTyped(answer.result_typed) }]);
      } else {
        const thrown = readTyped(answer.error_typed);
        expect([label, outcome.thrown]).toEqual([label, thrown]);
        expect(outcome.ctor).toBe({ Error, TypeError, RangeError }[thrown.name]);
      }
      // Parity: where the case marks no deviation, it is the reference's own.
      if (!deviation) {
        const reference = referenceOutcome(step.reference);
        if (reference.error) {
          expect([label, outcome.thrown]).toEqual([label, reference.error]);
        } else {
          expect([label, outcome.result]).toEqual([label, reference.result]);
        }
      }
      // The chrome's history handlers keep their wrap around the answer
      // (the reference's, so where the case marks no deviation).
      if (step.handler && !deviation) {
        const wrapped = outcome.thrown
          ? { success: false, error: outcome.thrown.message }
          : step.params.op === 'list'
            ? { success: true, entries: outcome.result }
            : { success: true };
        expect([label, wrapped]).toEqual([label, handlerAnswer(step.handler)]);
      }
    }
  });
});
