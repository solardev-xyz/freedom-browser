/**
 * Guard for the aggregate mechanisms in `.github/workflows/ci.yml`: the
 * `code-changed` and `renderer-changed` gates that decide which suites a
 * prose-only pull request skips, and the `ci-ok` job branch protection
 * requires in place of the individual job contexts.
 *
 * Both are "never under-test" claims, and both fail silently when they are
 * wrong — a skipped job and a job nobody waits on are indistinguishable from a
 * green one on the pull request page. So they are pinned here:
 *
 * 1. Prose is an input to the jest suite. The doc<->code guards read
 *    `docs/features.md`, `CHANGELOG.md`, `docs/agent-playbooks/`
 *    and `docs/audits/evidence/`, and two `*.test.js` files live under
 *    `docs/` outright — every one of those paths is what the filter calls
 *    prose. Gating the `test` job on `code-changed` would let a docs edit that
 *    breaks one of them merge green and leave `main` red, which is the exact
 *    drift those guards exist to catch. So `test` must run unconditionally
 *    for as long as any jest file reads a prose path, and this derives both
 *    halves of that from the workflow and the tree rather than restating them.
 * 2. A gate that *fails* must run the suites it gates, not skip them. GitHub
 *    reports a job skipped by its own `if` — or skipped because a job it
 *    `needs` failed — as Success to branch protection, so a `code-changed`
 *    that died on a transient checkout/fetch error would, under the obvious
 *    `== 'true'`, hand a code pull request a green merge button with no
 *    Playwright or native-addon job having run. Every gated job must read
 *    `!= 'false'` behind `!cancelled()`, and a copy-pasted `== 'true'` on the
 *    next one has to fail here.
 * 3. `ci-ok` is only as complete as its `needs:` list. A job added to the
 *    workflow and forgotten there stops gating merges the moment branch
 *    protection names `ci-ok` alone.
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const workflowPath = '.github/workflows/ci.yml';
const workflow = fs.readFileSync(path.join(repoRoot, workflowPath), 'utf8');

// Whole-line comments carry example paths and job names in prose; every
// assertion below is about what the runner does, so they go first.
const withoutComments = workflow
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

/** Every job in the workflow, mapped to its own block of the file. */
const jobs = () => {
  const body = withoutComments.split(/^jobs:[ \t]*$/m)[1];
  const blocks = new Map();
  let current = null;
  for (const line of body.split('\n')) {
    const header = line.match(/^ {2}([A-Za-z0-9_-]+):[ \t]*$/);
    if (header) {
      current = header[1];
      blocks.set(current, []);
      continue;
    }
    if (current) blocks.get(current).push(line);
  }
  return new Map([...blocks].map(([name, lines]) => [name, lines.join('\n')]));
};

/** The job names a job waits on, inline (`needs: a`) or as a flow sequence. */
const needsOf = (block) => {
  const chunk = block.match(/^ {4}needs:[ \t]*([\s\S]*?)(?=^ {4}[A-Za-z]|$(?![\s\S]))/m);
  if (!chunk) return [];
  return chunk[1].match(/[A-Za-z0-9_-]+/g) || [];
};

// The filter the `code-changed` step actually runs, read out of the step
// rather than restated: a narrowed or widened prose list has to move this
// whole test with it.
const proseFilter = () => {
  // `-q?` so a reintroduced `grep -q` fails the drain guard below with its
  // own message rather than blanking every test that reads the filter.
  const found = withoutComments.match(/grep -q?vE '(\^\([^']+\))'/);
  expect(found).toBeTruthy();
  return new RegExp(found[1]);
};

/** How the gate classifies one changed path. */
const isProse = (relative) => proseFilter().test(relative);

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  'ant-bin',
  'ipfs-bin',
  'myotis-bin',
  'radicle-bin',
  'arti-bin',
]);

// Every file jest's `**/*.test.js` testMatch picks up, repo-relative.
const jestFiles = (dir = repoRoot, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      jestFiles(path.join(dir, entry.name), out);
    } else if (entry.name.endsWith('.test.js')) {
      out.push(path.relative(repoRoot, path.join(dir, entry.name)).split(path.sep).join('/'));
    }
  }
  return out;
};

// A `path.join(__dirname, …)`/`path.resolve(__dirname, …)` built from string
// literals — the one shape every doc<->code guard in this repo uses to reach
// out of its own directory. Only the literal head of the expression is read,
// so `'…/captures/' + network` still resolves to the directory it walks into,
// and a path built from a variable resolves to nothing rather than to a guess.
const DIRNAME_PATH = /path\.(?:join|resolve)\(\s*__dirname\s*,((?:\s*(?:'[^']*'|"[^"]*")\s*,?)+)/g;

/** The prose paths a source file reads, if any. */
const proseReadsIn = (source, fromDir) => {
  const hits = new Set();
  for (const [, args] of source.matchAll(DIRNAME_PATH)) {
    const parts = (args.match(/'[^']*'|"[^"]*"/g) || []).map((literal) => literal.slice(1, -1));
    const resolved = path.resolve(fromDir, ...parts);
    if (!resolved.startsWith(repoRoot + path.sep) || !fs.existsSync(resolved)) continue;
    const relative = path.relative(repoRoot, resolved).split(path.sep).join('/');
    if (isProse(relative)) hits.add(relative);
  }
  return [...hits];
};

// This file's own detector tests name real docs, so it would answer the sweep
// below all by itself — and keep answering it after the last real guard was
// deleted. It is evidence about the detector, not about the suite.
const SELF = 'scripts/ci/ci-gate.test.js';

/** Jest files the gate would classify as prose, or that read prose. */
const jestFilesTiedToProse = () =>
  jestFiles()
    .filter((file) => file !== SELF)
    .map((file) => ({
      file,
      reads: isProse(file)
        ? [file]
        : proseReadsIn(
            fs.readFileSync(path.join(repoRoot, file), 'utf8'),
            path.dirname(path.join(repoRoot, file))
          ),
    }))
    .filter(({ reads }) => reads.length > 0);

describe('the code-changed prose filter', () => {
  it.each([
    'CHANGELOG.md',
    'changelog.d/fixed--a-thing.md',
    'docs/features.md',
    'docs/agent-playbooks/merge-process.md',
    'AGENTS.md',
    'CONTRIBUTING.md',
  ])('classifies %s as prose', (file) => {
    expect(isProse(file)).toBe(true);
  });

  it.each([
    'src/shared/shortcuts.js',
    'package.json',
    'scripts/assemble-changelog.js',
    '.github/workflows/ci.yml',
    'test-e2e/settings.spec.js',
    'src/renderer/pages/settings.html',
  ])('classifies %s as code', (file) => {
    expect(isProse(file)).toBe(false);
  });
});

// The sweep below only ever proves a positive about today's tree. These pin
// what the detector actually recognises, so it cannot quietly stop seeing the
// reads that justify the ungated `test` job.
describe('the prose-read detector', () => {
  it('sees a doc reached through path.join segments', () => {
    expect(proseReadsIn(`path.join(__dirname, 'docs', 'features.md')`, repoRoot)).toEqual([
      'docs/features.md',
    ]);
  });

  it('sees a doc reached through a relative path.resolve', () => {
    expect(
      proseReadsIn(
        `path.resolve(__dirname, '../../docs/features.md')`,
        path.join(repoRoot, 'src/shared')
      )
    ).toEqual(['docs/features.md']);
  });

  it('sees the directory a concatenated path walks into', () => {
    expect(
      proseReadsIn(
        `path.resolve(__dirname, '../../../docs/audits/evidence/' + network)`,
        path.join(repoRoot, 'src/main/myotis')
      )
    ).toEqual(['docs/audits/evidence']);
  });

  it('does not fire on a code path, or on a path that does not exist', () => {
    expect(proseReadsIn(`path.join(__dirname, 'src', 'shared', 'shortcuts.js')`, repoRoot)).toEqual(
      []
    );
    expect(proseReadsIn(`path.join(__dirname, 'docs', 'no-such-doc.md')`, repoRoot)).toEqual([]);
  });
});

describe('the test job', () => {
  it('has prose in its own input: the doc<->code guards read it', () => {
    // Named individually rather than as a count, so the failure reads as
    // "these guards are what makes the assertion below load-bearing".
    expect(
      jestFilesTiedToProse()
        .map(({ file }) => file)
        .sort()
    ).not.toEqual([]);
  });

  it('runs on every pull request, because of that', () => {
    const block = jobs().get('test');
    expect(block).toBeTruthy();
    // The message a re-gate should read: the jest suite is where this repo's
    // doc<->code guards live, so skipping it on a prose-only pull request is
    // under-testing, not saving 100 seconds.
    expect({
      tiedToProse: jestFilesTiedToProse().length > 0,
      gated: needsOf(block).includes('code-changed') || /code-changed\.outputs/.test(block),
    }).toEqual({ tiedToProse: true, gated: false });
  });

  it('still runs the whole jest suite, not a subset', () => {
    // A `test` job narrowed to named files would drop the guards out of CI
    // just as effectively as the gate would.
    expect(jobs().get('test')).toContain('run: npm run test:coverage');
  });
});

describe('the path filters', () => {
  /** The `if echo "$changed" | grep …` line of each filter step. */
  const filterLines = () => withoutComments.match(/^.*\| grep .*$/gm) || [];

  it('drain their input instead of exiting at the first hit', () => {
    // `grep -q` exits as soon as it has an answer; with `set -o pipefail` the
    // still-writing `echo` then dies of SIGPIPE, the pipeline returns 141 and
    // the `else` branch writes a positive `code=false` / `renderer=false` for
    // a pull request full of code. Reproduced with the step's own line: 1 500
    // paths (46 KB) answer `true`, 2 500 (79 KB) answer `false`. It is the one
    // shape the fail-open `if` below cannot cover, because the gate concluded.
    expect(filterLines()).toHaveLength(2);
    expect(filterLines().filter((line) => /grep -[A-Za-z]*q/.test(line))).toEqual([]);
  });

  it('read both sides of a rename', () => {
    // `git diff --name-only` with rename detection prints only a rename's
    // destination, so `git mv src/x.js docs/x.js` reads as a prose-only pull
    // request that deleted nothing.
    const diffs = withoutComments.match(/^.*git diff .*--name-only.*$/gm) || [];
    expect(diffs).toHaveLength(2);
    expect(diffs.filter((line) => !line.includes('--no-renames'))).toEqual([]);
  });
});

describe('the gate jobs', () => {
  const GATES = ['code-changed', 'renderer-changed'];

  /**
   * Every job that waits on a gate, as `[name, condition, needs]`.
   *
   * Keyed on `needs:`, not on the condition: a job that `needs` a gate and
   * carries no `if:` at all is gated too — GitHub skips it through the
   * implicit `success()` when the gate fails, and reports that skip as
   * Success. Reading only the conditions would give this guard the same blind
   * spot it exists to close. `ci-ok` is the one deliberate exception; it waits
   * on every job by design and its `always()` is pinned in its own block.
   */
  const gatedJobs = () =>
    [...jobs()]
      .filter(([name]) => name !== 'ci-ok')
      .map(([name, block]) => [
        name,
        (block.match(/^ {4}if:[ \t]*(.*)$/m) || [])[1] || '',
        needsOf(block),
      ])
      .filter(
        ([, condition, needs]) =>
          needs.some((job) => GATES.includes(job)) ||
          /needs\.[A-Za-z0-9_-]+\.outputs\./.test(condition)
      );

  it.each(GATES)('%s has consumers to protect', (gate) => {
    expect(
      gatedJobs().filter(
        ([, c, needs]) => needs.includes(gate) || c.includes(`needs.${gate}.outputs.`)
      )
    ).not.toEqual([]);
  });

  // The failure message to read here: `== 'true'` skips on a gate that never
  // concluded, and a skipped job reports Success to branch protection — so a
  // transient failure of a five-minute filter job is enough to make an
  // untested code change mergeable. Fail open on anything but a positive
  // "prose only".
  it('fail open on a gate that did not conclude, and only then', () => {
    // A missing `if:` fails this too: an empty condition matches nothing, and
    // a job that `needs` a gate without one is skipped-to-Success on a gate
    // failure exactly as `== 'true'` would be.
    const failsOpen = (condition, needs) =>
      needs.some((gate) =>
        new RegExp(
          `^\\$\\{\\{ !cancelled\\(\\) && needs\\.${gate}\\.outputs\\.[A-Za-z0-9_-]+ != 'false' \\}\\}$`
        ).test(condition)
      );
    expect(
      gatedJobs().map(([name, condition, needs]) => [name, failsOpen(condition, needs)])
    ).toEqual(gatedJobs().map(([name]) => [name, true]));
  });

  it("never gate on a positive == 'true', which skips a failed gate", () => {
    expect(gatedJobs().filter(([, condition]) => /==\s*'true'/.test(condition))).toEqual([]);
  });

  it('are themselves ungated, so nothing can skip the gate itself', () => {
    for (const gate of ['code-changed', 'renderer-changed']) {
      const block = jobs().get(gate);
      expect(block).toBeTruthy();
      expect(needsOf(block)).toEqual([]);
      expect(block).not.toMatch(/^ {4}if:/m);
    }
  });
});

describe('ci-ok', () => {
  it('waits on every other job in the workflow', () => {
    const all = [...jobs().keys()].filter((name) => name !== 'ci-ok').sort();
    expect(needsOf(jobs().get('ci-ok')).sort()).toEqual(all);
  });

  it('runs whatever else happened, since a gate failure skips its consumers', () => {
    // `always()` is why `ci-ok` may be left out of the gated-job guard above.
    expect(jobs().get('ci-ok')).toMatch(/^ {4}if: always\(\)$/m);
  });

  it('goes red on a job that failed or was cancelled', () => {
    expect(jobs().get('ci-ok')).toContain('join(needs.*.result');
    expect(jobs().get('ci-ok')).toMatch(/"failure"[\s\S]*"cancelled"/);
  });
});
