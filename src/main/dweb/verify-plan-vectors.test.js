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
 * Strict mode isn't main's yet (it comes with its profile setting): the
 * cases whose backend is strict are left out, and counted.
 *
 * Skipped unless the vectors are found: FREEDOM_CORE_DWEB_VECTORS names
 * freedom-core's `vectors` directory or its `dweb.json`, or the file sits
 * beside FREEDOM_CORE_VECTORS.
 */

const fs = require('fs');
const path = require('path');
const { validatePlan } = require('./plan-validation');
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
    const kept = cases.filter(([, , request]) => !strict(request));
    const got = kept.map(([id, plan, request]) => [id, validatePlan(plan, request) ?? 'valid']);
    expect(got).toEqual(kept.map(([id, , , want]) => [id, want]));
    expect(kept.length).toBeGreaterThan(300);
    // Every refusal a non-strict verify plan can get is exercised.
    const refusals = new Set(kept.map(([, , , want]) => want));
    for (const refusal of ['shape', 'node', 'root', 'path', 'query', 'header', 'trust']) {
      expect(refusals).toContain(refusal);
    }
  });

  test("requests: the real-handler tests' stand-in plans as the core does", async () => {
    const entries = vectors.requests.filter((entry) => !strict(entry.request));
    expect(entries.length).toBeGreaterThan(200);
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
  });
});
