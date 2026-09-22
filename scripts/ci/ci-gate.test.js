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

describe('the triggers', () => {
  /**
   * The `branches:` filter under `on: push:`, as the patterns it lists.
   *
   * Read as patterns and matched against real branch names below rather than
   * pinned as text: the list is a claim about which branches keep their push
   * run, and `branches: [main]` looks just as correct as the right answer
   * until you ask it about `release/0.9.0`.
   */
  const pushBranches = () => {
    const on = withoutComments.match(/^on:\n([\s\S]*?)^[a-z]/m);
    expect(on).toBeTruthy();
    const push = on[1].match(/^ {2}push:\n((?: {4,}\S.*\n)*)/m);
    expect(push).toBeTruthy();
    const inline = push[1].match(/^ {4}branches: \[(.*)\]$/m);
    const block = push[1].match(/^ {4}branches:[ \t]*\n((?: {6}- .*\n)+)/m);
    const listed = inline
      ? inline[1].split(',')
      : (block ? block[1].split('\n') : []).map((line) => line.replace(/^ *- */, ''));
    const patterns = listed
      .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    // An unfiltered `push:` (no `branches:` at all) is the state this filter
    // replaced, and would read as "nothing listed" rather than a failure.
    expect(patterns).not.toEqual([]);
    return patterns;
  };

  /** GitHub's branch-filter glob: `*` stops at a `/`, `**` does not. */
  const matches = (pattern, ref) => {
    const literal = (text) => text.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
    const source = pattern
      .split('**')
      .map((between) => between.split('*').map(literal).join('[^/]*'))
      .join('.*');
    return new RegExp(`^${source}$`).test(ref);
  };

  const covers = (ref) => pushBranches().some((pattern) => matches(pattern, ref));

  /** The events under `on:`, as that block's own top-level keys. */
  const triggers = () => {
    const on = withoutComments.match(/^on:\n([\s\S]*?)^[a-z]/m);
    expect(on).toBeTruthy();
    return (on[1].match(/^ {2}([a-z_]+):/gm) || []).map((line) => line.trim().replace(':', ''));
  };

  it('are the whole set, not just the two a pull request sees', () => {
    // Pinned as the exact set, because the failure this exists to catch is a
    // trigger that is *missing*: a `branches:` filter narrow enough to drop
    // the duplicate feature-branch push also drops every ref an automation
    // pushes, and nothing else in this file would notice. Adding a trigger
    // should have to say so here.
    expect(triggers().sort()).toEqual(['merge_group', 'pull_request', 'push', 'workflow_dispatch']);
  });

  it('report on a merge queue head, which no other trigger reaches', () => {
    // A merge queue pushes its candidate head to
    // `gh-readonly-queue/<base>/pr-<n>-<sha>`. That is not a pull request ref,
    // and the `branches:` filter above does not list it — correctly, since a
    // queue branch is machinery nobody develops on. So `merge_group:` is the
    // only trigger that can produce a run there. Without it a queue run
    // reports no `ci-ok` and no `test` on the queue head at all, and every
    // queued pull request waits on checks that cannot arrive until the
    // queue's own timeout evicts it. `release-process.md`'s "Next step: a
    // merge queue" says enabling one is a settings change; this is the half
    // that is not.
    expect(covers('gh-readonly-queue/main/pr-400-0123456789ab')).toBe(false);
    expect(triggers()).toContain('merge_group');
  });

  it('do not run a push that a pull request already covers', () => {
    // A branch push and the `pull_request` run for the same head are two runs
    // of this workflow under two different `github.ref`s, so `concurrency`
    // does not collapse them — and both gates short-circuit to true on a
    // non-pull-request event. An unfiltered `push:` therefore paid the full
    // 10-14 minutes on every same-repo feature-branch push next to the gated
    // PR run, which is the whole saving handed back.
    expect(
      ['chore/ci-gate-ci-ok', 'alan/backdrop-closes-trust-popover', 'fix/kebab'].filter(covers)
    ).toEqual([]);
  });

  it('still run the branches the release process reads CI from', () => {
    // The other half, and the one `branches: [main]` got wrong. A release or
    // hotfix branch has no pull request of its own: `release-process.md` §1
    // puts every `-rc.N` version bump straight onto it, §8 expects same-cycle
    // `fix(build): …` commits there, and a fix that does arrive as a pull
    // request still lands as a merge commit whose tree no `pull_request` run
    // saw. §4 gates the pre-tag "CI is green" check on these runs off the
    // Actions tab precisely because §8 makes the pull request into `main`
    // optional, so there is often no `gh pr checks` to ask instead.
    // release/0.8.0 and release/0.8.5 each took dozens of them. Without them
    // `release.yml`, which does not gate on CI, publishes the tagged
    // pre-release to testers with no CI signal for that tree at all.
    expect(
      ['main', 'release/0.9.0', 'release/cut-0.8.5', 'hotfix/0.8.5.1'].filter((ref) => !covers(ref))
    ).toEqual([]);
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
  /**
   * The gates, read out of the workflow rather than listed here: a job that
   * publishes an `outputs:` block is one.
   *
   * Derived because a hard-coded pair is invisible to its own guard. A third
   * gate added below would not appear in `gatedJobs()` at all, so a consumer
   * carrying `needs: <new gate>` and no `if:` — skipped to Success when that
   * gate fails, the exact shape the fail-open test exists to catch — would
   * pass this suite untouched.
   */
  const GATES = [...jobs()]
    .filter(([, block]) => /^ {4}outputs:[ \t]*$/m.test(block))
    .map(([name]) => name);

  it('are discovered from the workflow, not listed here', () => {
    // A derivation that quietly matched nothing would leave every guard below
    // iterating an empty list, so pin that it still finds the gates in the
    // file today. Containment, not equality: a third gate should inherit these
    // guards without having to edit this line.
    expect(GATES).toEqual(expect.arrayContaining(['code-changed', 'renderer-changed']));
  });

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

  it('run everything on an event that is not a pull request', () => {
    // The other half of the `merge_group:` trigger. A queue run has no
    // `github.base_ref` and no pull request diff to read, and the merged
    // result of a batch is the last tree that should be waved through as
    // prose — so every gate must answer "changed" on any event that is not a
    // `pull_request`, before it reaches the diff at all.
    const defaultsToChanged = (gate) => {
      const block = jobs().get(gate);
      const output = (block.match(/^ {6}([a-z]+): \$\{\{ steps\.filter\.outputs\./m) || [])[1];
      if (!output) return false;
      return new RegExp(
        `if \\[ "\\$EVENT" != "pull_request" \\]; then[\\s\\S]*?` +
          `echo "${output}=true" >> "\\$GITHUB_OUTPUT"[\\s\\S]*?exit 0`
      ).test(block);
    };
    expect(GATES.map((gate) => [gate, defaultsToChanged(gate)])).toEqual(
      GATES.map((gate) => [gate, true])
    );
  });

  it('are themselves ungated, so nothing can skip the gate itself', () => {
    for (const gate of GATES) {
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
