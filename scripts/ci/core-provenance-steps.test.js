/**
 * Guard for "CI verifies the build provenance of what it fetches from
 * freedom-core" (freedom-core design 0001, Packaging and release): in every
 * workflow, a step that runs `scripts/fetch-freedom-cored.js` or
 * `scripts/fetch-freedom-ipfsd.js` is followed at once by the step that runs
 * `scripts/ci/verify-core-provenance.js` for the same binary, with a token
 * for `gh`, and nothing marks that step as allowed to fail.
 */

const fs = require('fs');
const path = require('path');

const workflows = path.join(__dirname, '..', '..', '.github', 'workflows');

/** Each step of `text` as its own lines: the `- ` line and what is indented deeper. */
function steps(text) {
  const lines = text.split('\n');
  const found = [];
  lines.forEach((line, index) => {
    const dash = line.match(/^(\s*)- (name|uses|run|id|if):/);
    if (!dash) return;
    const indent = dash[1].length;
    const own = [line];
    for (const next of lines.slice(index + 1)) {
      if (next.trim() && !next.trim().startsWith('#') && next.match(/^ */)[0].length <= indent) {
        break;
      }
      own.push(next);
    }
    found.push({ line: index + 1, text: own.join('\n') });
  });
  return found;
}

const fetchOf = (step) => step.text.match(/node scripts\/fetch-freedom-(cored|ipfsd)\.js/)?.[1];

describe('every freedom-core download has its provenance verified', () => {
  const files = fs.readdirSync(workflows).filter((name) => /\.ya?ml$/.test(name));
  let fetches = 0;

  for (const file of files) {
    const all = steps(fs.readFileSync(path.join(workflows, file), 'utf8'));
    all.forEach((step, index) => {
      const binary = fetchOf(step);
      if (!binary) return;
      fetches += 1;
      test(`${file}:${step.line} (${binary})`, () => {
        const next = all[index + 1];
        expect(next).toBeDefined();
        expect(next.text).toContain(`node scripts/ci/verify-core-provenance.js ${binary}`);
        expect(next.text).toMatch(/GH_TOKEN: \$\{\{ github\.token \}\}/);
        expect(next.text).not.toMatch(/continue-on-error/);
        expect(next.text).not.toMatch(/^\s*if:/m);
      });
    });
  }

  test('the workflows fetch from freedom-core at all', () => {
    expect(fetches).toBeGreaterThan(0);
  });
});
