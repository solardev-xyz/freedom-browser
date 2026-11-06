/**
 * Main's `{ verify }` plans against fc-dweb's vectors (freedom-core
 * `vectors/dweb-verify-plans.json`, design 0009 "Verify plans"):
 *
 * - `validation`: every plan the design names, valid or refused, and the
 *   refusal each gets, through `validatePlan`;
 * - `requests`: the plans `test/helpers/fake-dweb-core.js` makes with main's
 *   copy of the planning (`dweb-open.js`, `verify-plan.js`), so the stand-in
 *   the real-handler tests use plans as the core does.
 *
 * Strict mode's cases (a backend with `strict: true`) run with the rest:
 * its 403s, the fetch refused at `trust`, and its messages, which must be
 * the core's word for word.
 *
 * Skipped unless the vectors are found: FREEDOM_CORE_DWEB_VECTORS names
 * freedom-core's `vectors` directory or its `dweb.json`, or the file sits
 * beside FREEDOM_CORE_VECTORS.
 */

const fs = require('fs');
const path = require('path');
const { validatePlan } = require('./plan-validation');
const { STRICT_MESSAGE, STRICT_MESSAGES } = require('./verify-plan');
const { planDweb } = require('../../../test/helpers/fake-dweb-core');

function vectorsPath() {
  const named = process.env.FREEDOM_CORE_DWEB_VECTORS || process.env.FREEDOM_CORE_VECTORS;
  if (!named) return null;
  const dir =
    fs.existsSync(named) && fs.statSync(named).isDirectory() ? named : path.dirname(named);
  return path.join(dir, 'dweb-verify-plans.json');
}

const file = vectorsPath();
const vectors = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
const describeIfVectors = vectors ? describe : describe.skip;

const strict = (request) => request.backend.strict === true;

describeIfVectors("fc-dweb's verify plan vectors through main", () => {
  test('validation: every plan gets the refusal the design gives it', () => {
    const requests = new Map(vectors.requests.map((entry) => [entry.id, entry]));
    const cases = [
      ...vectors.validation.map((entry) => {
        const source = entry.request_id ? requests.get(entry.request_id) : entry;
        return [entry.id, source.plan, source.request, entry.expect];
      }),
      ...vectors.requests.map((entry) => [entry.id, entry.plan, entry.request, entry.validation]),
    ];
    const got = cases.map(([id, plan, request]) => [id, validatePlan(plan, request) ?? 'valid']);
    expect(got).toEqual(cases.map(([id, , , want]) => [id, want]));
    expect(cases.length).toBeGreaterThan(2000);
    // Every refusal a verify plan can get is exercised.
    const refusals = new Set(cases.map(([, , , want]) => want));
    for (const refusal of ['shape', 'node', 'root', 'path', 'query', 'header', 'trust', 'error']) {
      expect(refusals).toContain(refusal);
    }
    // Strict mode's checks among them: a fetch refused at `trust`, and its
    // 403s, valid only against a strict backend.
    const strictCases = cases.filter(([, , request]) => strict(request));
    expect(strictCases.length).toBeGreaterThan(500);
    const strictFetch = strictCases.filter(([, plan]) => plan?.fetch);
    expect(strictFetch.length).toBeGreaterThan(0);
    expect(new Set(strictFetch.map(([, , , want]) => want))).toContain('trust');
    const refused403 = cases.filter(
      ([, plan, request]) => plan?.error?.status === 403 && !strict(request)
    );
    expect(refused403.length).toBeGreaterThan(0);
    expect(new Set(refused403.map(([, , , want]) => want))).toEqual(new Set(['error']));
  });

  test("strict mode's messages are the core's, in its order", () => {
    expect(vectors.constants.strict_messages).toEqual(STRICT_MESSAGE);
    expect(Object.values(vectors.constants.strict_messages)).toEqual(STRICT_MESSAGES);
  });

  test("requests: the real-handler tests' stand-in plans as the core does", async () => {
    const entries = vectors.requests;
    expect(entries.length).toBeGreaterThan(1000);
    const got = [];
    for (const entry of entries) {
      const resolver = async () => {
        if (Object.hasOwn(entry.resolution || {}, 'threw')) throw new Error(entry.resolution.threw);
        return entry.resolution?.value;
      };
      const plan = await planDweb(entry.request, {
        resolveContent: resolver,
        resolveTezos: resolver,
      });
      got.push({ id: entry.id, plan });
    }
    expect(got).toEqual(entries.map((entry) => ({ id: entry.id, plan: entry.plan })));
    expect(got.filter(({ plan }) => plan.verify).length).toBeGreaterThan(50);
    // Each of strict mode's five causes is planned, and nothing strict is
    // a fetch.
    const strictPlans = got.filter((_, i) => strict(entries[i].request)).map(({ plan }) => plan);
    expect(strictPlans.filter((plan) => plan.fetch)).toEqual([]);
    const messages = new Set(
      strictPlans.filter((plan) => plan.error?.status === 403).map((plan) => plan.error.message)
    );
    expect(messages).toEqual(new Set(STRICT_MESSAGES));
  });
});
