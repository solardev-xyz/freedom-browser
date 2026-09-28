// `ipfs-gateway-form.cases.js` holds the only real-Chromium check that a
// gateway-form `ipfs:` frame commits on its own canonical origin (O-3,
// #430). It is not a `.spec.js`, so Playwright only runs it through the spec
// that requires it — and CI only runs specs named in a job's curated list.
// Pin both links of that chain so the check can't silently stop running.

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

const HOST_SPEC = 'test-e2e/address-bar.spec.js';

describe('ipfs-gateway-form.cases.js CI wiring', () => {
  it('is required by the host spec', () => {
    expect(read(HOST_SPEC)).toMatch(/^require\(\s*'\.\/ipfs-gateway-form\.cases'\s*\);?\s*$/m);
  });

  it('host spec is run by a harness E2E job in ci.yml', () => {
    const ci = read('.github/workflows/ci.yml');
    // Every `npm run test:e2e -- …` (harness) invocation, continuation lines
    // included; `test:e2e:live` and friends are other projects.
    const runs = [...ci.matchAll(/npm run test:e2e --((?:[^\n]*\\\n)*[^\n]*)/g)].map((m) => m[1]);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.some((args) => args.split(/[\s\\]+/).includes(HOST_SPEC))).toBe(true);
  });

  it('is not itself a spec file (would run twice in a full harness run)', () => {
    expect(fs.existsSync(path.join(repoRoot, 'test-e2e/ipfs-gateway-form.spec.js'))).toBe(false);
  });
});
