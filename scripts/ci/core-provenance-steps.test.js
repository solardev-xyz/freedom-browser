/**
 * Guard for "CI verifies the build provenance of what it fetches from
 * freedom-core" (freedom-core design 0001, Packaging and release): in every
 * workflow, a step that downloads freedom-cored or freedom-ipfsd
 * (`scripts/fetch-freedom-cored.js` or `scripts/fetch-freedom-ipfsd.js`, or
 * the npm scripts that run them) is followed at once by the step that
 * verifies that binary's release, and that step is exactly:
 *
 * - `run:` the verifier's invocation and nothing else: no wrapper, no
 *   `|| true`, no comment, no multi-line script;
 * - `shell: bash`, and `env:` with `GH_TOKEN` alone;
 * - no other key: no `if:`, `continue-on-error:`, `working-directory:` or
 *   `uses:`, so nothing can skip it or let it fail.
 *
 * The workflows are read line by line, as release-caches.test.js reads
 * them: a step is its `- ` line and what is indented deeper, and its keys
 * are the lines at its own indentation. Each key's value is taken as the
 * single-line scalar it must be.
 */

const fs = require('fs');
const path = require('path');

const workflows = path.join(__dirname, '..', '..', '.github', 'workflows');

const VERIFY = (binary) =>
  `bash scripts/ci/hang-watchdog.sh 300 node scripts/ci/verify-core-provenance.js ${binary}`;
const ALLOWED = new Set(['name', 'timeout-minutes', 'shell', 'run', 'env']);

/**
 * Each step of `text`: its first line's number, its text, and its keys as
 * `{ key: value }`, each value the line's scalar (`env` as its own map).
 */
function steps(text) {
  const lines = text.split('\n');
  const found = [];
  lines.forEach((line, index) => {
    const dash = line.match(/^(\s*)- ([a-z-]+):/);
    if (!dash) return;
    const indent = dash[1].length;
    const own = [line];
    for (const next of lines.slice(index + 1)) {
      if (next.trim() && !next.trim().startsWith('#') && next.match(/^ */)[0].length <= indent) {
        break;
      }
      own.push(next);
    }
    const keys = {};
    let map = null;
    for (const [at, raw] of own.entries()) {
      if (!raw.trim() || raw.trim().startsWith('#')) continue;
      const body = at === 0 ? raw.replace(/^(\s*)- /, '$1  ') : raw;
      const depth = body.match(/^ */)[0].length;
      const pair = body.trim().match(/^([A-Za-z_-]+):(?:\s+(.*))?$/);
      if (depth === indent + 2 && pair) {
        keys[pair[1]] = pair[2] ?? '';
        map = pair[2] === undefined ? (keys[pair[1]] = {}) : null;
      } else if (map && depth > indent + 2 && pair) {
        map[pair[1]] = pair[2] ?? '';
      } else {
        // A continuation: a block scalar or a nested structure other than
        // `env`'s one level of pairs.
        keys['(continuation)'] = true;
      }
    }
    found.push({ line: index + 1, text: own.join('\n'), keys });
  });
  return found;
}

/** The binary a step downloads, if it downloads one. */
function fetchOf(step) {
  const match = step.text.match(
    /node scripts\/fetch-freedom-(cored|ipfsd)\.js|npm run (core|ipfsd):download/
  );
  if (!match) return null;
  return match[1] || (match[2] === 'core' ? 'cored' : 'ipfsd');
}

/** Why `step` isn't exactly `binary`'s verification step, or null. */
function notVerification(step, binary) {
  if (!step) return 'no step follows the download';
  const { keys } = step;
  const extra = Object.keys(keys).filter((key) => !ALLOWED.has(key));
  if (extra.length) return `keys beyond the verification step's: ${extra.join(', ')}`;
  if (keys.run !== VERIFY(binary)) return `run is not exactly the verifier: ${keys.run}`;
  if (keys.shell !== 'bash') return `shell is not bash: ${keys.shell}`;
  const env = keys.env;
  if (
    typeof env !== 'object' ||
    Object.keys(env).length !== 1 ||
    env.GH_TOKEN !== '${{ github.token }}'
  ) {
    return 'env is not GH_TOKEN alone';
  }
  return null;
}

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
        expect(notVerification(all[index + 1], binary)).toBeNull();
      });
    });
  }

  test('the workflows fetch from freedom-core at all', () => {
    expect(fetches).toBeGreaterThan(0);
  });
});

// Review of #796, round 1: steps that look like verification but verify
// nothing, or let a failure pass, are refused.
describe('the guard refuses a verification step that could pass without verifying', () => {
  const fetchStep = `
      - name: Download freedom-cored binaries
        timeout-minutes: 7
        shell: bash
        run: bash scripts/ci/hang-watchdog.sh 300 node scripts/fetch-freedom-cored.js
        env:
          GITHUB_TOKEN: \${{ github.token }}
`;
  const verifyStep = (overrides = {}) => {
    const keys = {
      name: "Verify freedom-cored's build provenance",
      'timeout-minutes': '7',
      shell: 'bash',
      run: VERIFY('cored'),
      ...overrides,
    };
    const lines = Object.entries(keys)
      .filter(([, value]) => value !== null)
      .map(([key, value], index) => `${index === 0 ? '      - ' : '        '}${key}: ${value}`);
    return `${lines.join('\n')}\n        env:\n          GH_TOKEN: \${{ github.token }}\n`;
  };
  const judge = (text) => {
    const all = steps(text);
    const at = all.findIndex((step) => fetchOf(step));
    return notVerification(all[at + 1], fetchOf(all[at]));
  };

  test('the real step passes', () => {
    expect(judge(fetchStep + verifyStep())).toBeNull();
  });

  test.each([
    ['an echo of the command', { run: `echo "${VERIFY('cored')}"` }],
    ['the command, or true', { run: `${VERIFY('cored')} || true` }],
    ['the command, then true', { run: `${VERIFY('cored')}; true` }],
    ['the command with a comment', { run: `${VERIFY('cored')} # verified` }],
    ['the other binary', { run: VERIFY('ipfsd') }],
    ['a block script', { run: '|' }],
    ['another shell', { shell: 'sh' }],
    ['a condition', { if: 'false' }],
    ['continue-on-error', { 'continue-on-error': 'true' }],
  ])('%s is refused', (_label, overrides) => {
    expect(judge(fetchStep + verifyStep(overrides))).not.toBeNull();
  });

  test('a download through npm is caught too', () => {
    expect(fetchOf({ text: 'run: npm run ipfsd:download' })).toBe('ipfsd');
    expect(fetchOf({ text: 'run: npm run core:download' })).toBe('cored');
  });

  test('a download with no step after it is refused', () => {
    expect(judge(fetchStep)).not.toBeNull();
  });
});
