/**
 * Guard for "release.yml restores no caches" (#635).
 *
 * The jobs in `.github/workflows/release.yml` build the signed releases and
 * nightlies, so none of their inputs may come from a cache another run (a
 * pull request, say) wrote. zizmor's `cache-poisoning` audit covers the
 * caches it can see, but it does not look inside the local composite action
 * `.github/actions/install-node-deps`, whose Electron download cache is on by
 * default and is switched off only by passing `electron-cache: 'false'`.
 * Deleting or flipping that input on a release.yml step leaves zizmor at
 * "No findings", so it is pinned here instead:
 *
 * 1. every `install-node-deps` step in release.yml passes
 *    `electron-cache: 'false'` (also on the `ignore-scripts` smoke jobs, which
 *    skip the cache today anyway, so a later drop of `ignore-scripts` cannot
 *    quietly turn it back on);
 * 2. the action really does gate every one of its cache steps on that input;
 * 3. release.yml names no `cache:` input and no `actions/cache` itself.
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

// Whole-line comments blanked (not dropped) so reported line numbers match the file.
const withoutComments = (text) =>
  text
    .split('\n')
    .map((line) => (/^\s*#/.test(line) ? '' : line))
    .join('\n');

const indentOf = (line) => line.match(/^ */)[0].length;

/**
 * Every step of `text` as `{ line, lines }`, where `lines` is the step's own
 * block: the `- ` line and everything indented deeper than its dash.
 */
const steps = (text) => {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const dash = lines[i].match(/^( *)- /);
    if (!dash) continue;
    const depth = dash[1].length;
    const block = [lines[i]];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j].trim() !== '' && indentOf(lines[j]) <= depth) break;
      block.push(lines[j]);
    }
    out.push({ line: i + 1, lines: block });
  }
  return out;
};

/** The value of `key:` directly under the step's `with:` block, or undefined. */
const withInput = (step, key) => {
  const at = step.lines.findIndex((l) => /^\s*with:\s*$/.test(l));
  if (at === -1) return undefined;
  const depth = indentOf(step.lines[at]);
  for (const l of step.lines.slice(at + 1)) {
    if (l.trim() === '') continue;
    if (indentOf(l) <= depth) break;
    const m = l.match(new RegExp(`^\\s*${key}:\\s*(.*?)\\s*$`));
    if (m) return m[1];
  }
  return undefined;
};

const releaseYml = withoutComments(read('.github/workflows/release.yml'));
const actionYml = withoutComments(read('.github/actions/install-node-deps/action.yml'));

// Any YAML spelling of the local action: bare, single- or double-quoted, with
// or without a trailing slash, with or without a trailing comment.
const INSTALL =
  /^\s*(?:- )?uses:\s*(['"]?)\.\/\.github\/actions\/install-node-deps\/?\1\s*(?:#.*)?$/;

describe('release.yml restores no caches (#635)', () => {
  const installSteps = steps(releaseYml).filter((s) => s.lines.some((l) => INSTALL.test(l)));

  test('the parser finds the install-node-deps steps', () => {
    // A rename or re-indent of the step must not make every check below vacuous.
    const raw = releaseYml.split('\n').filter((l) => INSTALL.test(l)).length;
    expect(raw).toBeGreaterThan(0);
    expect(installSteps).toHaveLength(raw);
  });

  test('every reference to install-node-deps is one the parser recognises', () => {
    // Allowlist, not denylist: a spelling INSTALL does not know (a new quoting
    // style, a path variant) must fail here rather than silently drop out of
    // both the step filter and the count above.
    const offenders = releaseYml
      .split('\n')
      .map((l, i) => ({ l, n: i + 1 }))
      .filter(({ l }) => /install-node-deps/.test(l) && !INSTALL.test(l))
      .map(({ l, n }) => `release.yml:${n} ${l.trim()}`);
    expect(offenders).toEqual([]);
  });

  test("every install-node-deps step passes electron-cache: 'false'", () => {
    const offenders = installSteps
      .filter((s) => !/^['"]false['"]$/.test(withInput(s, 'electron-cache') ?? ''))
      .map((s) => `release.yml:${s.line} electron-cache=${withInput(s, 'electron-cache')}`);
    expect(offenders).toEqual([]);
  });

  test('install-node-deps gates every cache step on electron-cache', () => {
    const cacheSteps = steps(actionYml).filter((s) =>
      s.lines.some((l) => /electron-cache|actions\/cache/.test(l) && !/^\s*-?\s*name:/.test(l))
    );
    expect(cacheSteps.length).toBeGreaterThan(0);
    for (const s of cacheSteps) {
      const ifLine = s.lines.find((l) => /^\s*(?:- )?if:/.test(l)) ?? '';
      expect(`action.yml:${s.line} ${ifLine.trim()}`).toMatch(/inputs\.electron-cache != 'false'/);
    }
    // And the cache restore itself is among them.
    expect(cacheSteps.some((s) => s.lines.some((l) => /uses:\s*actions\/cache/.test(l)))).toBe(
      true
    );
  });

  test('release.yml names no cache input and no actions/cache of its own', () => {
    const offenders = releaseYml
      .split('\n')
      .map((l, i) => ({ l, n: i + 1 }))
      .filter(({ l }) => /^\s*cache:/.test(l) || /uses:\s*actions\/cache/.test(l))
      .map(({ l, n }) => `release.yml:${n} ${l.trim()}`);
    expect(offenders).toEqual([]);
  });
});
