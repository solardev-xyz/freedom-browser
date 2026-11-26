/**
 * Guard for the aggregate mechanisms in `.github/workflows/ci.yml`: the
 * `code-changed` and `renderer-changed` gates that decide which suites a
 * prose-only pull request skips, and the `ci-ok` job that is meant to
 * replace those individual job contexts in branch protection. As of
 * 2026-11-24 it has: the `main` ruleset requires `ci-ok` alone and puts pull
 * requests through a merge queue.
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
    // queue's own timeout evicts it. `release-process.md`'s "The merge
    // queue" says enabling one was a settings change; this is the half that
    // is not.
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
    // Counted 2026-09-22 over the runs still in Actions retention,
    // release/0.8.5 took 13 of these runs and release/0.8.0 took 8. Without
    // them `release.yml`, which does not gate on CI, publishes the tagged
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
    // Every output, not just the first: `code-changed` publishes both
    // `code` and `full_matrix`, and a queue run that skipped the macOS jobs
    // would be exactly as wrong as one that skipped everything.
    const defaultsToChanged = (gate) => {
      const block = jobs().get(gate);
      const outputs = [...block.matchAll(/^ {6}([a-z_]+): \$\{\{ steps\.filter\.outputs\./gm)].map(
        (m) => m[1]
      );
      if (outputs.length === 0) return false;
      const early = block.match(/if \[ "\$EVENT" != "pull_request" \]; then([\s\S]*?)exit 0/);
      if (!early) return false;
      return outputs.every((output) =>
        early[1].includes(`echo "${output}=true" >> "$GITHUB_OUTPUT"`)
      );
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

describe('the macOS/Windows jobs on a pull request', () => {
  // macOS runners are the workflow's bottleneck, so a pull request into `main`
  // without the `full-ci` label runs only the Linux leg of `e2e-desktop` and skips the
  // macOS-only jobs; the merge queue runs all of it. These pin that the
  // narrowing is opt-out-able, fails open, and never reaches a queue run.
  const block = (name) => {
    const found = jobs().get(name);
    expect(found).toBeTruthy();
    return found;
  };
  const gateScript = () => block('code-changed');

  it('skip the macOS-only jobs on the full_matrix output', () => {
    for (const name of ['e2e-agent', 'e2e-automation']) {
      expect(block(name)).toMatch(
        /^ {4}if: \$\{\{ !cancelled\(\) && needs\.code-changed\.outputs\.full_matrix != 'false' \}\}$/m
      );
    }
  });

  it("narrow e2e-desktop to Linux only on a positive full_matrix == 'false'", () => {
    const os = block('e2e-desktop').match(/^ {8}os: (.*)$/m);
    expect(os).toBeTruthy();
    expect(os[1]).toBe(
      `\${{ fromJSON(needs.code-changed.outputs.full_matrix == 'false' && '["ubuntu-latest"]' || '["ubuntu-latest", "windows-latest", "macos-latest"]') }}`
    );
  });

  it('read the full-ci label live, so a re-run after labelling picks it up', () => {
    // A re-run replays the original event payload; only an API read sees a
    // label added since.
    expect(gateScript()).toMatch(/gh api "repos\/\$GH_REPO\/pulls\/\$PR_NUMBER"/);
    expect(gateScript()).toContain(`any(.labels[]; .name == "full-ci")`);
    expect(gateScript()).toMatch(/^ {6}pull-requests: read$/m);
  });

  it('fail open when the label lookup errors', () => {
    expect(gateScript()).toMatch(/else\n\s+echo "::warning::[^\n]*"\n\s+labelled=true\n/);
  });

  it('keep labelled prose-only pull requests skipping the macOS jobs', () => {
    expect(gateScript()).toMatch(
      /echo "code=false" >> "\$GITHUB_OUTPUT"\n(?:\s+#.*\n)*\s+labelled=false\n/
    );
  });

  // Run the gate's real script under bash with `gh` and `git` stubbed, so the
  // decision table is pinned by what the script does, not by its text.
  const runGate = ({
    event = 'pull_request',
    base,
    label = false,
    labelError = false,
    changed,
  }) => {
    const { spawnSync } = require('child_process');
    const os = require('os');
    const script = workflow.match(
      /^ {6}- name: Decide whether anything outside the docs changed\n[\s\S]*?^ {8}run: \|\n((?: {10}.*\n|\n)+)/m
    );
    expect(script).toBeTruthy();
    const body = script[1].replace(/^ {10}/gm, '');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-gate-'));
    try {
      const bin = path.join(dir, 'bin');
      fs.mkdirSync(bin);
      fs.writeFileSync(
        path.join(bin, 'gh'),
        labelError ? '#!/bin/sh\nexit 1\n' : `#!/bin/sh\necho ${label}\n`,
        { mode: 0o755 }
      );
      fs.writeFileSync(
        path.join(bin, 'git'),
        `#!/bin/sh\n[ "$1" = diff ] && printf '%s\\n' ${changed.map((f) => `'${f}'`).join(' ')}\nexit 0\n`,
        { mode: 0o755 }
      );
      const output = path.join(dir, 'output');
      fs.writeFileSync(output, '');
      const result = spawnSync('bash', ['-c', body], {
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          EVENT: event,
          BASE: base,
          PR_NUMBER: '1',
          GH_REPO: 'o/r',
          GITHUB_OUTPUT: output,
        },
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      return Object.fromEntries(
        fs
          .readFileSync(output, 'utf8')
          .trim()
          .split('\n')
          .map((line) => line.split('='))
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  (process.platform === 'win32' ? it.skip : it)(
    'narrow only a pull request into main, the one base with a merge queue',
    () => {
      const code = ['src/main/index.js'];
      expect(runGate({ base: 'main', changed: code }).full_matrix).toBe('false');
      expect(runGate({ base: 'main', label: true, changed: code }).full_matrix).toBe('true');
      expect(runGate({ base: 'main', labelError: true, changed: code }).full_matrix).toBe('true');
      // `release/**` and `hotfix/**` have no queue and `release.yml` does not
      // gate on CI, so their pull requests keep macOS/Windows on their own run.
      for (const base of ['release/0.9.0', 'hotfix/0.8.5.1']) {
        expect(runGate({ base, changed: code })).toEqual({ code: 'true', full_matrix: 'true' });
      }
      // Prose only still skips everything, whatever the base.
      expect(runGate({ base: 'release/0.9.0', changed: ['docs/x.md'] })).toEqual({
        code: 'false',
        full_matrix: 'false',
      });
      expect(runGate({ event: 'merge_group', base: '', changed: [] })).toEqual({
        code: 'true',
        full_matrix: 'true',
      });
    }
  );

  it('do not trigger on labeled, which would cancel the run in flight', () => {
    // `labeled` fires for any label and shares the concurrency group with the
    // run for the head commit, so adding one would cancel and duplicate it.
    const on = withoutComments.match(/^on:\n([\s\S]*?)^[a-z]/m);
    const pr = on[1].match(/^ {2}pull_request:[ \t]*\n((?: {4,}\S.*\n)*)/m);
    expect(pr ? pr[1] : '').not.toMatch(/labeled/);
  });
});

describe('the self-hosted Linux runners', () => {
  // The project's own runners (`freedom-linux`) take the Linux jobs only on
  // trusted events. This is a public repository: a `pull_request` run can
  // carry a fork's code, and that must never resolve to a self-hosted label.
  const SELF_HOSTED_JOBS = [
    'code-changed',
    'ci-ok',
    'e2e-browser',
    'e2e-live',
    'e2e-renderer',
    'e2e-settings-wallet',
    'packed-asar-contents',
    'renderer-changed',
    'test',
  ];
  const SELF_HOSTED_MATRIX_JOBS = ['myotis-native-e2e', 'native-addons'];
  // The container cannot host these: an AppArmor profile load on the host,
  // user namespaces for the preview-network-isolation qualification, and
  // `pip` for zizmor-action's install.
  const HOSTED_ONLY_JOBS = ['e2e-agent-linux', 'e2e-desktop', 'zizmor'];
  const TRUSTED = ['merge_group', 'push', 'workflow_dispatch'];

  const runsOn = (name) => {
    const block = jobs().get(name);
    expect(block).toBeTruthy();
    const found = block.match(/^ {4}runs-on: (.*)$/m);
    expect(found).toBeTruthy();
    return found[1];
  };

  // Evaluates the small subset of the Actions expression language the
  // runs-on lines use (`contains`, `fromJSON`, `&&`, `||`, `==`, string
  // literals, `github.event_name`, `matrix.os`), so the test checks what each
  // line resolves to rather than only its text. Anything outside the subset
  // throws instead of evaluating to something plausible.
  const resolve = (value, { event, os }) => {
    const expr = value.match(/^\$\{\{ (.*) \}\}$/);
    if (!expr) return value;
    const js = expr[1]
      .replace(/\bfromJSON\(('[^']*')\)/g, 'JSON.parse($1)')
      .replace(/\bcontains\(/g, 'contains(')
      .replace(/\bgithub\.event_name\b/g, 'event')
      .replace(/\bmatrix\.os\b/g, 'os');
    const leftover = js
      .replace(/'[^']*'/g, '')
      .replace(/\b(JSON\.parse|contains|event|os)\b/g, '')
      .replace(/&&|\|\||==|[(),\s]/g, '');
    if (leftover) throw new Error(`unsupported expression: ${expr[1]}`);
    const contains = (list, item) => Array.isArray(list) && list.includes(item);
    return new Function('contains', 'event', 'os', `return (${js});`)(contains, event, os);
  };

  const EVENTS = [...TRUSTED, 'pull_request', 'pull_request_target', 'schedule', 'workflow_run'];
  const isSelfHosted = (label) => Array.isArray(label) && label.includes('self-hosted');

  it('are named by exactly the jobs the containers were qualified for', () => {
    const named = [...jobs().keys()].filter((name) => /self-hosted/.test(jobs().get(name)));
    expect(named.sort()).toEqual([...SELF_HOSTED_JOBS, ...SELF_HOSTED_MATRIX_JOBS].sort());
  });

  it.each(SELF_HOSTED_JOBS)('%s runs on freedom-linux only for trusted events', (name) => {
    for (const event of EVENTS) {
      const label = resolve(runsOn(name), { event });
      if (TRUSTED.includes(event)) expect(label).toEqual(['self-hosted', 'freedom-linux']);
      else expect(label).toBe('ubuntu-latest');
    }
  });

  it.each(SELF_HOSTED_MATRIX_JOBS)(
    '%s switches only its ubuntu-latest entry, and only for trusted events',
    (name) => {
      const oses = [
        ...jobs()
          .get(name)
          .matchAll(/^ {10,12}(?:- )?os: (.*)$/gm),
      ].map((m) => m[1]);
      expect(oses).toContain('ubuntu-latest');
      for (const os of oses) {
        for (const event of EVENTS) {
          const label = resolve(runsOn(name), { event, os });
          if (os === 'ubuntu-latest' && TRUSTED.includes(event)) {
            expect(label).toEqual(['self-hosted', 'freedom-linux']);
          } else {
            expect(label).toBe(os);
          }
        }
      }
    }
  );

  it.each(HOSTED_ONLY_JOBS)('%s stays on GitHub-hosted runners', (name) => {
    expect(jobs().get(name)).not.toMatch(/self-hosted|freedom-linux/);
  });

  it('never resolve to a self-hosted label on a pull_request run', () => {
    for (const name of jobs().keys()) {
      const value = runsOn(name);
      const oses = [
        ...jobs()
          .get(name)
          .matchAll(/^ {8,12}(?:- )?os: (.*)$/gm),
      ].map((m) => m[1]);
      for (const os of oses.length ? oses : [undefined]) {
        let label;
        try {
          label = resolve(value, { event: 'pull_request', os });
        } catch {
          // e2e-desktop's matrix is itself an expression; it names no
          // self-hosted label (pinned above), so there is nothing to resolve.
          expect(value).not.toMatch(/self-hosted/);
          continue;
        }
        expect(isSelfHosted(label)).toBe(false);
      }
    }
  });

  it('are used by no other workflow', () => {
    const dir = path.join(repoRoot, '.github/workflows');
    for (const file of fs.readdirSync(dir)) {
      if (file === 'ci.yml') continue;
      // Only the runs-on lines: an artifact may well be named `freedom-linux-…`.
      const text = fs
        .readFileSync(path.join(dir, file), 'utf8')
        .split('\n')
        .filter((line) => /^\s*runs-on:/.test(line))
        .join('\n');
      expect([file, /self-hosted|freedom-linux/.test(text)]).toEqual([file, false]);
    }
  });
});
