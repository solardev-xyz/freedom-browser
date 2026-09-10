// The screenshot spec skips itself unless it is launched the way its baselines
// were rendered. That keeps a bare `npm run test:e2e` green, but it also means
// a mis-invoked screenshot run *passes* by skipping — so the invocations that
// are supposed to enable it are asserted here alongside the gate itself.

const fs = require('fs');
const path = require('path');

const { screenshotGate, STABLE_TEXT_VAR } = require('./screenshot-gate');
const { SCREENSHOT_DIR, SURFACES, baselineFiles } = require('./screenshot-baselines');

const repoRoot = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

describe('screenshotGate', () => {
  const on = { [STABLE_TEXT_VAR]: '1' };

  it('enables a Linux run launched with stable text', () => {
    expect(screenshotGate(on, 'linux')).toEqual({ enabled: true, reason: '' });
  });

  it('skips a Linux run without stable text, naming the npm script', () => {
    const { enabled, reason } = screenshotGate({}, 'linux');
    expect(enabled).toBe(false);
    expect(reason).toContain('npm run test:e2e:screenshots');
  });

  it('skips off Linux, and lets FREEDOM_SCREENSHOTS=1 opt back in', () => {
    expect(screenshotGate(on, 'darwin').enabled).toBe(false);
    expect(screenshotGate(on, 'darwin').reason).toContain('Linux');
    expect(screenshotGate({ ...on, FREEDOM_SCREENSHOTS: '1' }, 'darwin').enabled).toBe(true);
  });

  it('trims both flags, so `set X=1 && npm run ...` still counts', () => {
    expect(screenshotGate({ [STABLE_TEXT_VAR]: '1 ' }, 'linux').enabled).toBe(true);
    expect(
      screenshotGate({ [STABLE_TEXT_VAR]: '1', FREEDOM_SCREENSHOTS: '1 ' }, 'darwin').enabled
    ).toBe(true);
  });

  it('treats any other value as off', () => {
    for (const value of ['', '0', 'false', 'yes', undefined]) {
      expect(screenshotGate({ [STABLE_TEXT_VAR]: value }, 'linux').enabled).toBe(false);
    }
  });
});

// A workflow with its comments stripped. `ci.yml` documents the local update
// command in prose (`Locally: xvfb-run -a npm run test:e2e:screenshots:update`),
// which contains every substring the assertions below look for — asserting
// against the raw file would pass on a job rewritten to a bare
// `npx playwright test …`, and the spec would then skip itself in CI forever
// while this test stayed green.
const workflowSteps = (relative) =>
  read(relative)
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

const workflowsDir = path.join(repoRoot, '.github/workflows');
const everyWorkflowStep = () =>
  fs
    .readdirSync(workflowsDir)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => workflowSteps(path.join('.github/workflows', name)))
    .join('\n');

// YAML's folded block scalar joins its lines with a space before the shell ever
// sees them, so a step written as
//
//     - run: >
//         npm run test:e2e:screenshots --
//         -u
//
// is the single command `npm run test:e2e:screenshots -- -u` — with no
// backslash for the continuation branch in `ADOPTS_BASELINES` to follow, so the
// ban walked straight past it. Fold those blocks back the way YAML does before
// matching: consecutive lines join with a space, a blank line stays a line
// break (so a legitimate later command in the same block cannot glue its own
// `-u` onto an earlier screenshot run). Literal blocks (`run: |`) keep their
// newlines and are left alone — the runner executes those line by line, which
// is what the backslash branch is for.
//
// The block's indentation is measured from the mapping key, not from the start
// of the line: under `- run: >` the sequence dash is part of the indentation,
// so a sibling key on the *next* line (`  run:` beneath `- name: >`) sits at
// the same level and ends the block rather than folding into it.
//
// YAML allows a comment after the block scalar's indicators (`run: > # why`),
// and the block still folds — so the header is *not* anchored straight to the
// end of the line. `workflowSteps` only strips whole-line comments, so an
// end-of-line one survives to here, and requiring the indicators to be last
// would let `run: >  # regenerate` fold nothing and walk the `-u` on its own
// line past `ADOPTS_BASELINES`. The comment needs a space in front of it, the
// way YAML requires, so this cannot start matching some other `>`-bearing line.
const FOLDED_SCALAR_HEADER = /:[ \t]*>[-+]?\d*[-+]?(?:[ \t]+#[^\n]*)?[ \t]*$/;

const foldBlockScalars = (yaml) => {
  const lines = yaml.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    out.push(lines[i]);
    if (!FOLDED_SCALAR_HEADER.test(lines[i])) continue;

    const keyIndent = lines[i].match(/^[ \t]*(?:-[ \t]+)*/)[0].length;
    const paragraphs = [[]];
    let end = i + 1;
    for (; end < lines.length; end += 1) {
      if (lines[end].trim() === '') {
        paragraphs.push([]);
        continue;
      }
      if (lines[end].match(/^[ \t]*/)[0].length <= keyIndent) break;
      paragraphs[paragraphs.length - 1].push(lines[end].trim());
    }
    if (end === i + 1) continue;

    out.push(paragraphs.map((paragraph) => paragraph.join(' ')).join('\n'));
    i = end - 1;
  }
  return out.join('\n');
};

// Every spelling of "rewrite the baselines instead of comparing against them".
// The long-form argument and the two npm/node entry points are plain
// substrings; the short alias is not, because a bare `-u` is a legitimate token
// in a shell step (`set -u`, `sort -u`, `curl -u`) — so it is banned only where
// it is actually an argument to the screenshot run:
//   npm run test:e2e:screenshots -- -u
//   npx playwright test --project=harness -u
// `(?:[^\n]|\\\n)*?` walks the rest of that command, following a backslash line
// continuation inside a block scalar; `[ \t]-u(?![\w-])` requires `-u` to be
// its own argument, so `--update-source-method` or a `-user` flag is not it.
const ADOPTS_BASELINES =
  /test:e2e:screenshots:update|--update-snapshots|apply-screenshot-baselines|(?:test:e2e:screenshots|playwright[^\n]*?\btest\b)(?:[^\n]|\\\n)*?[ \t]-u(?![\w-])/;

describe('the invocations that are meant to enable it', () => {
  const scripts = JSON.parse(read('package.json')).scripts;

  it.each(['test:e2e:screenshots', 'test:e2e:screenshots:update'])(
    '%s sets stable text',
    (name) => {
      expect(scripts[name]).toContain(`${STABLE_TEXT_VAR}=1`);
    }
  );

  it('CI compares through the npm script rather than a bare playwright run', () => {
    // The `run:` step itself, so a job switched to `npx playwright test …`
    // (which would skip every screenshot, silently and greenly) fails here.
    // Anchored to the end of the line, because `test:e2e:screenshots:update`
    // — and any bare `--update-snapshots` argument — starts with the compare
    // script's name: a job pointed at the update variant would rewrite the
    // baselines in the runner's workspace and report success, comparing
    // nothing while this test stayed green on a prefix match.
    expect(workflowSteps('.github/workflows/ci.yml')).toMatch(
      /^\s*run: xvfb-run -a npm run test:e2e:screenshots[ \t]*$/m
    );
    // …and no step in any workflow adopts baselines instead of comparing them,
    // so the compare step can't be sidestepped by an extra update step either.
    // Matched against the whole comment-stripped workflow rather than against a
    // `run:` line: a block scalar puts the command on the *next* line (`run: |`
    // then `xvfb-run -a npm run test:e2e:screenshots:update`), which a
    // `/run:.*update/` pattern never reaches, and the compare-step assertion
    // above stays satisfied by the untouched step. `apply-screenshot-baselines`
    // is the same sidestep by another route, and so is Playwright's short `-u`
    // alias for `--update-snapshots` — see `ADOPTS_BASELINES`. Folded through
    // `foldBlockScalars` first, or a `run: >` step splitting that alias across
    // two lines reads as two commands here and as one to the runner.
    expect(foldBlockScalars(everyWorkflowStep())).not.toMatch(ADOPTS_BASELINES);
  });

  // The assertion above only ever proves a *negative* about today's workflows:
  // it stays green whether the pattern is right or empty. These pin what it
  // actually recognises, so the evasions each round has closed cannot quietly
  // reopen when the pattern is next edited.
  it.each([
    ['the update npm script', '      - run: xvfb-run -a npm run test:e2e:screenshots:update'],
    ['the long-form argument', '      - run: npx playwright test --update-snapshots'],
    ['the baseline-adoption script', '      - run: node scripts/apply-screenshot-baselines.js d'],
    ['the short alias, after the npm script', '      - run: npm run test:e2e:screenshots -- -u'],
    ['the short alias, on a bare playwright run', '      - run: npx playwright test -u'],
    ['the short alias, after other arguments', '      - run: npx playwright test --retries=0 -u'],
    [
      'the short alias, past a line continuation',
      '      - run: |\n          npm run test:e2e:screenshots -- \\\n            -u',
    ],
    [
      'the short alias, folded across a block scalar',
      '      - run: >\n          npm run test:e2e:screenshots --\n          -u',
    ],
    [
      'the short alias, folded across a chomped block scalar',
      '      - run: >-\n          npx playwright test --project=harness\n          -u',
    ],
    [
      // YAML lets a comment follow the fold indicator, and folds the block all
      // the same — so the header cannot be anchored to the end of the line.
      'the short alias, folded across a block scalar with a trailing comment',
      '      - run: >  # regenerate\n          npm run test:e2e:screenshots --\n          -u',
    ],
    [
      'the short alias, folded across a chomped block scalar with a comment',
      '      - run: >- # regenerate\n          npx playwright test --project=harness\n          -u',
    ],
  ])('the adopt-step ban recognises %s', (_what, step) => {
    expect(foldBlockScalars(step)).toMatch(ADOPTS_BASELINES);
  });

  // …and the shell idioms it must not fire on, or a legitimate future step
  // fails this test with a message about screenshot baselines.
  it.each([
    ['a strict-mode bash step', '      - run: |\n          set -u\n          ./scripts/thing.sh'],
    ['a deduplicating pipe', '      - run: git diff --name-only | sort -u'],
    [
      'a longer flag that starts with -u',
      '      - run: npx playwright test --update-source-method',
    ],
    [
      'a -u belonging to an unrelated later command',
      '      - run: npx playwright test\n      - run: sort -u out.txt',
    ],
    [
      // A blank line inside a folded scalar is a line break, not a space, so
      // these stay the two commands the runner executes.
      'a deduplicating pipe after a blank line in the same folded block',
      '      - run: >\n          npm run test:e2e:screenshots\n\n          git diff --name-only | sort -u',
    ],
    [
      // The block ends at the next key at the mapping's own level. Measuring
      // the indent from the start of the line instead of from the key would
      // fold this `run:` into the step's name and fire on the pair.
      'a folded step name above an unrelated -u',
      '      - name: >\n          Run npm run test:e2e:screenshots\n        run: git diff --name-only | sort -u',
    ],
    [
      'a folded step name with a comment above an unrelated -u',
      '      - name: >  # wraps\n          Run npm run test:e2e:screenshots\n        run: git diff --name-only | sort -u',
    ],
  ])('the adopt-step ban does not fire on %s', (_what, step) => {
    expect(foldBlockScalars(step)).not.toMatch(ADOPTS_BASELINES);
  });

  it.each([
    ['the gate itself', 'screenshot-gate'],
    // Spelled with its neighbour in the filter's own alternation, so the
    // unrelated `apply-screenshot-baselines.js` mentioned elsewhere in the
    // workflow cannot satisfy this on a substring.
    ['the declared surface list', 'screenshot-gate|screenshot-baselines'],
    ['the screenshot baselines', 'test-e2e/__screenshots__/'],
    ['the contrast baseline', 'test-e2e/theme-contrast-baseline'],
    ['the npm scripts that launch them', 'package\\.json'],
  ])('a change to %s makes CI run the visual jobs', (_what, pattern) => {
    // `renderer-changed` decides whether the visual jobs run at all. Each of
    // these can decide what those jobs compare against — or turn them into
    // no-ops — so each belongs in that path filter; a baseline-adoption PR
    // touches nothing else at all.
    expect(workflowSteps('.github/workflows/ci.yml')).toContain(pattern);
  });

  it('the default harness suite does not set it, so the spec stays opt-in there', () => {
    expect(scripts['test:e2e']).not.toContain(STABLE_TEXT_VAR);
  });
});

// The other half of the screenshot guard. Playwright only ever fails on a
// baseline that is *missing*, so a surface cannot ship uncompared — but a
// baseline that is still committed and no longer taken fails nothing at all.
// Rename or delete a `snap()` name and its two PNGs stay in the tree for good,
// present in every listing and every baseline diff, reading as regression
// coverage the surface silently lost.
//
// `screenshot-baselines.js` is the list both sides answer to: the spec takes
// every shot through `declared()`, and the committed files are checked against
// it here — in a jest test rather than in the spec, so it runs on every `npm
// test` instead of only on the Linux-and-stable-text runs the spec gates
// itself to.
// The declared→taken check lives inside the spec, one test at a time, so it can
// only fire on a test that still runs. Deleting a whole `test(...)` block would
// take its check with it and strand every baseline in its group silently —
// which is the same failure one deleted `shot()` call would have been. So the
// group titles are pinned here too, in jest, where they are checked on every
// `npm test` rather than only on the Linux-and-stable-text runs.
describe('the surface groups', () => {
  const spec = read('test-e2e/renderer-screenshots.spec.js');

  it.each(Object.keys(SURFACES))('%s is a test the spec still declares', (group) => {
    expect(spec).toContain(`test(\`${group} (\${theme})\``);
  });

  it('and every test in the spec answers to a group', () => {
    const titles = [...spec.matchAll(/\n\s*test\(`(.+?) \(\$\{theme\}\)`/g)].map((m) => m[1]);
    expect(titles.filter((title) => !SURFACES[title])).toEqual([]);
  });
});

describe('the committed baselines', () => {
  const committed = () =>
    fs
      .readdirSync(path.join(repoRoot, SCREENSHOT_DIR))
      .filter((name) => name.endsWith('.png'))
      .sort();

  it('are the directory the config actually writes and compares', () => {
    // Or both assertions below read an empty directory and agree about nothing.
    expect(read('playwright.config.js')).toContain(
      `snapshotPathTemplate: '${SCREENSHOT_DIR}/{arg}{ext}'`
    );
    expect(committed().length).toBeGreaterThan(0);
  });

  it('strand nothing: every committed file is a surface the spec still takes', () => {
    const declared = new Set(baselineFiles());
    // Named individually rather than as a length: the failure is "these files
    // are no longer compared — delete them, or restore the surface".
    expect(committed().filter((file) => !declared.has(file))).toEqual([]);
  });

  it('cover every declared surface in both themes', () => {
    const present = new Set(committed());
    expect(baselineFiles().filter((file) => !present.has(file))).toEqual([]);
  });
});
