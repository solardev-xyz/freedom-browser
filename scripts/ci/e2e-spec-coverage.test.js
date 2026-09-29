/**
 * Guard: every harness e2e spec runs in CI, or is deliberately left out.
 *
 * CI does not run `playwright test --project=harness` wholesale; each e2e-*
 * job in `.github/workflows/ci.yml` names its own curated list of specs. A
 * spec nobody adds to a list is never run, and its regressions ship green:
 * #319 was exactly that, and by 2026-09-29 twenty-four `test-e2e/*.spec.js`
 * files were in no workflow at all (two of them were failing on `main`).
 *
 * So a spec has to be in one of two places:
 *
 * - run by a pull-request workflow: `test-e2e/<path>.spec.js` as an argument
 *   of a Playwright command — `[npx] playwright test …`, or `npm run
 *   <script> …` where the package.json script is a `playwright test` run (a
 *   spec baked into the script counts too, e.g. `test:e2e:screenshots`) — in
 *   a `run:` step of a `.github/workflows/*.yml` that triggers on
 *   `pull_request`. A workflow that only runs on a tag push, a schedule or a
 *   manual dispatch (`release.yml`'s nightly) never gates a merge, so a spec
 *   that runs only there ships its regressions green exactly like an unrun
 *   one. The reference has to sit outside a comment (whole-line or
 *   trailing ` # ...`, including a `#` line inside a folded `run: >-` block,
 *   which the shell sees mid-line). The same path in a step name, an
 *   `env:`/`with:` value, a `paths:` filter, a gate's `grep -E` pattern or an
 *   `echo` runs nothing and does not count;
 * - on the not-in-CI list: a `# e2e-not-in-ci: <name>.spec.js — <reason>`
 *   comment line in `ci.yml`, next to the jobs, where a reader of the
 *   workflow sees the gap.
 *
 * Both lists are kept honest in the other direction too: an entry naming a
 * spec that does not exist, or a skipped spec that a job runs after all,
 * fails here, so neither list can go stale.
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const workflowDir = path.join(repoRoot, '.github', 'workflows');
const ciPath = path.join(workflowDir, 'ci.yml');
const e2eDir = path.join(repoRoot, 'test-e2e');

const SKIP_LINE = /^\s*#\s*e2e-not-in-ci:\s*(\S+)\s*(?:—|--?)\s*(.*)$/;

// Mirrors the harness project's testMatch in playwright.config.js: any
// `.spec.js` under test-e2e/, at any depth, except under a live/, packaged/
// or packaged-live/ directory (those are other projects).
const OTHER_PROJECT_DIRS = new Set(['live', 'packaged', 'packaged-live']);
const isHarnessPath = (rel) =>
  rel.endsWith('.spec.js') &&
  !rel
    .split('/')
    .slice(0, -1)
    .some((d) => OTHER_PROJECT_DIRS.has(d));

/** Every harness spec, as a test-e2e/-relative path (`wallet/x.spec.js` for a subdirectory). */
const harnessSpecs = (dir = e2eDir, prefix = '') =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const rel = prefix + entry.name;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || OTHER_PROJECT_DIRS.has(entry.name)) return [];
        return harnessSpecs(path.join(dir, entry.name), `${rel}/`);
      }
      return entry.isFile() && isHarnessPath(rel) ? [rel] : [];
    })
    .sort();

// Comments carry spec names in prose (and the not-in-CI list itself); a
// reference only counts where the runner would execute it. YAML and shell
// both start a comment at a `#` that begins the line or follows whitespace,
// so a trailing `  # test-e2e/x.spec.js` after a `\` continuation is dropped
// too. (A ` #` inside a quoted string is cut as well; that can only hide a
// reference and fail this guard, never make an unrun spec pass.)
const stripLineComment = (line) => line.replace(/(^|\s)#.*$/, '');

// A block scalar (`run: |`, `run: >-`) is not YAML any more: a `#` line inside
// it is content handed to the shell, not a YAML comment. That is harmless in a
// literal `|` block, where every line stays its own shell line — but a folded
// `>` block joins its lines with spaces first, so one `# note` line in the
// middle of a spec list becomes a shell comment that swallows every spec after
// it, and bash exits 0 having run only the ones before. So a folded block is
// folded the way YAML folds it before comments are cut, and a reference behind
// such a `#` drops out and fails this guard instead of counting as run.
const BLOCK_SCALAR = /^(\s*)(?:-\s+)?([A-Za-z0-9_.-]+):\s*([|>])[-+0-9]*\s*(?:#.*)?$/;

/** YAML folding of a `>` block's lines (block indentation already removed). */
const fold = (lines) => {
  let out = '';
  lines.forEach((line, i) => {
    if (i === 0) {
      out = line;
      return;
    }
    const prev = lines[i - 1];
    // Two adjacent plain (non-empty, not more-indented) lines fold into one;
    // empty and more-indented lines keep their line break.
    const joins = prev !== '' && line !== '' && !/^\s/.test(prev) && !/^\s/.test(line);
    out += (joins ? ' ' : '\n') + line;
  });
  return out;
};

/**
 * The shell scripts of every `run:` step in a workflow, as the shell sees
 * them: comments gone, folded blocks folded. Nothing else in the file is
 * shell — a `name:`, an `env:`/`with:` value or a `paths:` filter can spell a
 * spec path without anything ever running it — so only `run:` values come
 * back, one string per step.
 */
const runScripts = (text) => {
  const lines = text.split('\n');
  const scripts = [];
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i].match(BLOCK_SCALAR);
    if (!header) {
      const inline = lines[i].match(/^\s*(?:-\s+)?run:\s*(.*)$/);
      if (inline) scripts.push(stripLineComment(inline[1]));
      continue;
    }
    // Content is every following line indented past the key (or empty).
    const keyColumn = lines[i].indexOf(header[2]);
    const body = [];
    while (
      i + 1 < lines.length &&
      (lines[i + 1].trim() === '' || lines[i + 1].search(/\S/) > keyColumn)
    )
      body.push(lines[++i]);
    if (header[2] !== 'run') continue;
    while (body.length && body[body.length - 1].trim() === '') body.pop();
    const nonEmpty = body.filter((l) => l.trim() !== '');
    const indent = nonEmpty.length ? Math.min(...nonEmpty.map((l) => l.search(/\S/))) : 0;
    const content = body.map((l) => (l.trim() === '' ? '' : l.slice(indent)));
    const shellLines = header[3] === '>' ? fold(content).split('\n') : content;
    scripts.push(shellLines.map(stripLineComment).join('\n'));
  }
  return scripts;
};

/**
 * The simple commands in a shell script, each as a list of words. A line
 * ending in a bare `\` continues onto the next (after a trailing comment has
 * been cut, `\ ` is an escaped space, not a continuation — bash agrees), and
 * `;`, `&`, `&&`, `|` and `||` end a command. Quotes are only peeled off
 * whole words; a spec path inside a longer quoted word (a grep pattern's
 * `a|test-e2e/x.spec.js`) never becomes a word of its own.
 */
const shellCommands = (script) =>
  script
    .replace(/\\\n/g, ' ')
    .split(/\n|;|&&?|\|\|?/)
    .map((cmd) =>
      cmd
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => w.replace(/^(['"])(.*)\1$/, '$2'))
    )
    .filter((words) => words.length);

// `<path>` is relative to test-e2e/ and may name subdirectories.
const SPEC_WORD = /^test-e2e\/((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.spec\.js)$/;

/**
 * Specs a script hands to Playwright: words after `playwright test` (bare or
 * under `npx`) or after `npm run <script>` where that package.json script is
 * itself a Playwright run — plus any spec baked into that script. The command
 * word has to be the runner, so an `echo`/`grep`/`test -f` naming a spec does
 * not count; only env assignments, `xvfb-run` and its flags, and the shell's
 * `then`/`else`/`do` may come before it. A run pinned to projects that do not
 * include `harness` does not run a harness spec either. Anything this does not
 * recognise counts as not run, so an unfamiliar spelling fails the guard
 * rather than passing a spec no job runs.
 */
const leadingWords = (words) => {
  let i = 0;
  for (;;) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] || '')) i++;
    else if (['then', 'else', 'do'].includes(words[i])) i++;
    else if (words[i] === 'xvfb-run') {
      i++;
      while (/^-/.test(words[i] || '')) i++;
    } else return i;
  }
};

/** The arguments a command hands to `playwright test`, or null if it is not a Playwright run. */
const playwrightArgs = (words, npmScripts, depth = 0) => {
  let i = leadingWords(words);
  if (words[i] === 'npx') i++;
  if (words[i] === 'playwright' && words[i + 1] === 'test') return words.slice(i + 2);
  if (words[i] === 'npm' && words[i + 1] === 'run' && depth < 3) {
    const body = npmScripts[words[i + 2]];
    if (typeof body !== 'string') return null;
    for (const inner of shellCommands(body)) {
      const args = playwrightArgs(inner, npmScripts, depth + 1);
      // `npm run x -- a b` appends a b to the script's own words.
      if (args) return [...args, ...words.slice(i + 3)];
    }
  }
  return null;
};

const runSpecsIn = (script, npmScripts = {}) => {
  const specs = [];
  for (const words of shellCommands(script)) {
    const args = playwrightArgs(words, npmScripts);
    if (!args) continue;
    const projects = [];
    args.forEach((w, k) => {
      const m = w.match(/^--project(?:=(.*))?$/);
      if (m) projects.push(m[1] ?? args[k + 1]);
    });
    if (projects.length && !projects.includes('harness')) continue;
    for (const w of args) {
      const m = w.match(SPEC_WORD);
      if (m && isHarnessPath(m[1])) specs.push(m[1]);
    }
  }
  return specs;
};

/**
 * The event names in a workflow's top-level `on:` — `on: pull_request`,
 * `on: [push, pull_request]`, or a block of `event:` keys (the key may be
 * quoted, since YAML 1.1 reads a bare `on` as a boolean).
 */
const workflowEvents = (text) => {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /^(?:on|'on'|"on"):/.test(l));
  if (at === -1) return [];
  const inline = stripLineComment(lines[at].replace(/^[^:]*:/, '')).trim();
  if (inline)
    return inline
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((e) => e.trim().replace(/^(['"])(.*)\1$/, '$2'))
      .filter(Boolean);
  const events = [];
  let indent;
  for (const line of lines.slice(at + 1)) {
    // A comment (at any column, column 0 included) or a blank line does not
    // end the block in YAML; only the next top-level key does.
    if (/^\s*(?:#|$)/.test(line)) continue;
    if (/^\S/.test(line)) break; // next top-level key
    const m = line.match(/^( +)(['"]?)([A-Za-z_]+)\2:/);
    // Only keys at the block's first indentation level are events.
    if (m && (indent === undefined || m[1].length === indent)) {
      indent = m[1].length;
      events.push(m[3]);
    }
  }
  return events;
};

/** Whether a workflow runs on pull requests, i.e. can hold a regression back from `main`. */
const gatesPullRequests = (text) => workflowEvents(text).includes('pull_request');

/** Every workflow file, as `[file, text]`. */
const readWorkflows = () =>
  fs
    .readdirSync(workflowDir)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => [f, fs.readFileSync(path.join(workflowDir, f), 'utf8')]);

/** spec name → where it is run, across every pull-request workflow. */
const referencedSpecs = (
  workflows = readWorkflows(),
  npmScripts = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts
) => {
  const refs = new Map();
  for (const [file, text] of workflows) {
    if (!gatesPullRequests(text)) continue;
    for (const script of runScripts(text)) {
      for (const spec of runSpecsIn(script, npmScripts)) {
        if (!refs.has(spec)) refs.set(spec, []);
        refs.get(spec).push(file);
      }
    }
  }
  return refs;
};

/** spec name → reason, from the `# e2e-not-in-ci:` lines in ci.yml. */
const skipList = () => {
  const entries = new Map();
  for (const line of fs.readFileSync(ciPath, 'utf8').split('\n')) {
    const m = line.match(SKIP_LINE);
    if (m) entries.set(m[1], m[2].trim());
  }
  return entries;
};

describe('harness e2e specs in CI', () => {
  it('finds the specs, the workflow references and the skip list it checks', () => {
    // A parser that silently returns nothing would pass every test below.
    expect(harnessSpecs().length).toBeGreaterThan(20);
    expect(referencedSpecs().size).toBeGreaterThan(20);
    expect(referencedSpecs().has('renderer-screenshots.spec.js')).toBe(true); // via npm run
    expect(skipList().size).toBeGreaterThan(0);
  });

  it('runs every spec in some workflow job, or lists why not', () => {
    const refs = referencedSpecs();
    const skips = skipList();
    const unrun = harnessSpecs().filter((spec) => !refs.has(spec) && !skips.has(spec));
    // Add the spec to the e2e-* job in ci.yml that fits its area, or — if it
    // cannot run in CI yet — add a `# e2e-not-in-ci: <spec> — <reason>` line
    // to the list above the e2e jobs in ci.yml.
    expect(unrun).toEqual([]);
  });

  it('gives every skipped spec a reason', () => {
    const vague = [...skipList()].filter(([, reason]) => reason.length < 20).map(([spec]) => spec);
    expect(vague).toEqual([]);
  });

  it('lists only specs that exist', () => {
    const specs = new Set(harnessSpecs());
    expect([...skipList().keys()].filter((spec) => !specs.has(spec))).toEqual([]);
    expect([...referencedSpecs().keys()].filter((spec) => !specs.has(spec))).toEqual([]);
  });

  it('does not list a spec as skipped that a job runs', () => {
    const refs = referencedSpecs();
    const both = [...skipList().keys()].filter((spec) => refs.has(spec));
    // Wired back in: drop its `e2e-not-in-ci:` line.
    expect(both).toEqual([]);
  });
});

describe('the guard parsers', () => {
  // Specs a workflow text runs, the way referencedSpecs() reads a file.
  const NPM = {
    'test:e2e': 'playwright test --project=harness',
    'test:e2e:live': 'playwright test --project=live',
    'test:e2e:shots': 'FOO=1 playwright test --project=harness test-e2e/shots.spec.js',
    lint: 'eslint test-e2e/lint.spec.js',
  };
  const runs = (text) => runScripts(text).flatMap((script) => runSpecsIn(script, NPM));

  it('drops whole-line and trailing comments, keeps real references', () => {
    const refs = runs(
      [
        '# run: npx playwright test test-e2e/a.spec.js is prose',
        '        run: |',
        '          npx playwright test test-e2e/b.spec.js \\',
        '            test-e2e/c.spec.js \\',
        '            test-e2e/g.spec.js # test-e2e/d.spec.js',
        '          npx playwright test test-e2e/h.spec.js \\  # cut: \\ is now an escaped space',
        '            test-e2e/i.spec.js',
        '        with:',
        '          key: value # test-e2e/e.spec.js',
      ].join('\n')
    );
    expect(refs).toEqual(['b.spec.js', 'c.spec.js', 'g.spec.js', 'h.spec.js']);
  });

  it('counts only specs handed to a Playwright command in a `run:` step', () => {
    const refs = runs(
      [
        '      - name: npx playwright test test-e2e/name.spec.js',
        '        run: xvfb-run -a npm run test:e2e -- test-e2e/a.spec.js',
        '        env:',
        '          SPEC: test-e2e/env.spec.js',
        '        with:',
        '          path: test-e2e/with.spec.js',
        '      - run: npm run test:e2e:shots',
        '      - run: npm run lint -- test-e2e/lint2.spec.js',
        '      - run: npm run test:e2e:live -- test-e2e/live-project.spec.js',
        '      - run: npx playwright test --project harness test-e2e/b.spec.js',
        '      - run: echo npx playwright test test-e2e/echo.spec.js',
        '      - name: gate',
        '        run: |',
        '          changed="$(git diff --name-only)"',
        '          if echo "$changed" | grep -E \'^(src/|test-e2e/grep.spec.js)\' >/dev/null; then',
        '            echo "changed=true test-e2e/out.spec.js" >> "$GITHUB_OUTPUT"',
        '          fi',
        '          test -f test-e2e/testf.spec.js && npx playwright test test-e2e/c.spec.js',
        '          if [ "$RUNNER_OS" = Linux ]; then xvfb-run -a npm run test:e2e -- test-e2e/d.spec.js; fi',
        '    paths:',
        "      - 'test-e2e/paths.spec.js'",
      ].join('\n')
    );
    expect(refs).toEqual(['a.spec.js', 'shots.spec.js', 'b.spec.js', 'c.spec.js', 'd.spec.js']);
  });

  it('folds a `>-` block before cutting comments: specs after a `#` line are not run', () => {
    // The shell sees `... settings.spec.js a.spec.js # note b.spec.js c.spec.js`.
    const folded = runs(
      [
        '      - name: Run settings E2E',
        '        run: >-',
        '          xvfb-run -a npm run test:e2e --',
        '          test-e2e/a.spec.js',
        '          # b needs the synthetic checkpoint states',
        '          test-e2e/b.spec.js',
        '          test-e2e/c.spec.js',
        '      - name: next',
        '        run: npx playwright test test-e2e/d.spec.js',
      ].join('\n')
    );
    expect(folded).toEqual(['a.spec.js', 'd.spec.js']);

    // In a literal `|` block the same `#` line is its own shell line and
    // leaves the next command alone.
    const literal = runs(
      [
        '        run: |',
        '          npx playwright test test-e2e/a.spec.js',
        '          # b.spec.js runs in the next command',
        '          npx playwright test test-e2e/b.spec.js # test-e2e/c.spec.js',
        '        env:',
        '          X: test-e2e/e.spec.js',
      ].join('\n')
    );
    expect(literal).toEqual(['a.spec.js', 'b.spec.js']);
  });

  // The two tests below mutate the real ci.yml, but locate what they mutate
  // from its structure rather than from literal lines, so moving a spec to
  // another job or reordering a list does not break them.
  const ci = () => fs.readFileSync(ciPath, 'utf8');
  const ciLines = () => ci().split('\n');

  it('folds the real folded e2e job lists: a comment line there hides the specs after it', () => {
    // Every `run: >` block in ci.yml with at least two spec lines: a `#` line
    // after its first spec must hide every spec listed after it.
    const lines = ciLines();
    const blocks = [];
    lines.forEach((line, i) => {
      const header = line.match(BLOCK_SCALAR);
      if (!header || header[2] !== 'run' || header[3] !== '>') return;
      const keyColumn = line.indexOf('run');
      const specLines = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() !== '' && lines[j].search(/\S/) <= keyColumn) break;
        const m = lines[j].match(/^\s*test-e2e\/(\S+\.spec\.js)\s*$/);
        if (m) specLines.push([j, m[1]]);
      }
      if (specLines.length >= 2) blocks.push(specLines);
    });
    for (const [[first, firstSpec], ...rest] of blocks) {
      const indent = lines[first].match(/^\s*/)[0];
      const mutated = [...lines];
      mutated.splice(first + 1, 0, `${indent}# a note between the specs`);
      const before = new Set(runs(lines.join('\n')));
      const after = new Set(runs(mutated.join('\n')));
      expect(after.has(firstSpec)).toBe(true);
      for (const [, spec] of rest) {
        expect(before.has(spec)).toBe(true);
        // Unless another job also runs it, the spec is now run nowhere.
        const elsewhere = lines.filter((l) => l.includes(`test-e2e/${spec}`)).length > 1;
        if (!elsewhere) expect(after.has(spec)).toBe(false);
      }
    }
  });

  it('does not count a spec dropped from its job but named in the gate grep pattern', () => {
    // R3-M1: the spec leaves its job and survives only as text in a gate's
    // `grep -E` path pattern — it runs nowhere.
    const lines = ciLines();
    // Any spec run exactly once in ci.yml, from a list line of its own.
    const runOnce = [...referencedSpecs([['ci.yml', ci()]])].filter(([, f]) => f.length === 1);
    const pick = runOnce
      .map(([spec]) => [
        spec,
        lines.findIndex((l) =>
          new RegExp(`^\\s*test-e2e/${spec.replace(/\./g, '\\.')}\\s*(\\\\)?\\s*$`).test(l)
        ),
      ])
      .find(([, at]) => at !== -1);
    expect(pick).toBeDefined();
    const [spec, at] = pick;
    const mutated = [...lines];
    // Dropping a list's last entry leaves the previous line's `\` dangling;
    // move the continuation off it so the command still ends where it did.
    if (!/\\\s*$/.test(mutated[at]) && /\\\s*$/.test(mutated[at - 1]))
      mutated[at - 1] = mutated[at - 1].replace(/\s*\\\s*$/, '');
    mutated.splice(at, 1);
    // Name it in the gate's grep pattern, or in a stand-in gate step if
    // ci.yml has none of that shape any more.
    const gate = mutated.findIndex((l) => /grep -E '\^\(/.test(l));
    const ref = `test-e2e/${spec}`;
    if (gate !== -1) mutated[gate] = mutated[gate].replace("grep -E '^(", `grep -E '^(${ref}|`);
    else mutated.push(`      - run: git diff --name-only | grep -E '^(${ref}|src/)'`);
    const text = mutated.join('\n');
    expect(text).toContain(ref);
    expect(referencedSpecs([['ci.yml', ci()]]).has(spec)).toBe(true);
    expect(referencedSpecs([['ci.yml', text]]).has(spec)).toBe(false);
  });

  it('counts only workflows that run on pull requests', () => {
    // R4-M1: release.yml runs e2e only on a tag push or the nightly schedule;
    // a spec that runs only there never gates a pull request.
    const release = [
      'on:',
      '  push:',
      "    tags: ['v*']",
      '  schedule:',
      "    - cron: '7 22 * * *'",
      '  workflow_dispatch:',
      '    inputs:',
      '      pull_request:',
      '        type: boolean',
      'jobs:',
      '  e2e-full:',
      '    steps:',
      '      - run: npm run test:e2e -- test-e2e/nightly.spec.js',
    ].join('\n');
    const pr = (on) =>
      `${on}\njobs:\n  e2e:\n    steps:\n      - run: npx playwright test test-e2e/pr.spec.js\n`;
    expect(workflowEvents(release)).toEqual(['push', 'schedule', 'workflow_dispatch']);
    expect(workflowEvents(pr('on: pull_request'))).toEqual(['pull_request']);
    expect(workflowEvents(pr("'on': [push, pull_request]"))).toEqual(['push', 'pull_request']);
    expect(workflowEvents(pr('on:\n  pull_request:\n    branches: [main]'))).toEqual([
      'pull_request',
    ]);
    // Comments (column 0 or indented) and blank lines inside the block don't end it.
    expect(
      workflowEvents(pr('on:\n# note\n  push:\n\n    # indented\n#\n  pull_request:'))
    ).toEqual(['push', 'pull_request']);
    const commented = ci().replace(/^on:\n/m, 'on:\n# note\n');
    expect(commented).toContain('on:\n# note\n');
    expect(gatesPullRequests(commented)).toBe(true);
    const refs = referencedSpecs(
      [
        ['release.yml', release],
        ['pr.yml', pr('on:\n  push:\n  pull_request:')],
      ],
      NPM
    );
    expect([...refs.keys()]).toEqual(['pr.spec.js']);
    // The real ones: ci.yml gates pull requests, release.yml does not.
    expect(gatesPullRequests(ci())).toBe(true);
    const releaseYml = path.join(workflowDir, 'release.yml');
    if (fs.existsSync(releaseYml))
      expect(gatesPullRequests(fs.readFileSync(releaseYml, 'utf8'))).toBe(false);
  });

  it('matches the harness project testMatch, subdirectories included', () => {
    expect(isHarnessPath('tabs.spec.js')).toBe(true);
    expect(isHarnessPath('wallet/new.spec.js')).toBe(true);
    expect(isHarnessPath('a/b/c.spec.js')).toBe(true);
    expect(isHarnessPath('live/adblock.spec.js')).toBe(false);
    expect(isHarnessPath('packaged/launch.spec.js')).toBe(false);
    expect(isHarnessPath('packaged-live/nodes.spec.js')).toBe(false);
    expect(isHarnessPath('wallet/live/x.spec.js')).toBe(false);
    expect(isHarnessPath('fixtures.js')).toBe(false);
    expect(
      runSpecsIn('npx playwright test test-e2e/wallet/new.spec.js test-e2e/live/adblock.spec.js')
    ).toEqual(['wallet/new.spec.js']);
  });

  it('walks subdirectories and skips the other projects', () => {
    const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'e2e-cov-'));
    try {
      for (const rel of [
        'top.spec.js',
        'fixtures.js',
        'wallet/new.spec.js',
        'wallet/deep/more.spec.js',
        'live/a.spec.js',
        'packaged/b.spec.js',
        'packaged-live/c.spec.js',
        'node_modules/pkg/d.spec.js',
      ]) {
        fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), '');
      }
      expect(harnessSpecs(root)).toEqual([
        'top.spec.js',
        'wallet/deep/more.spec.js',
        'wallet/new.spec.js',
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('agrees with playwright.config.js on which files the harness project runs', () => {
    // The config's own regex, applied the way Playwright applies it (to the
    // absolute path), must pick exactly the files harnessSpecs() walks.
    const config = fs.readFileSync(path.join(repoRoot, 'playwright.config.js'), 'utf8');
    const m = config.match(/name: 'harness',\s*testMatch: \/(.*)\/,/);
    expect(m).not.toBeNull();
    const testMatch = new RegExp(m[1]);
    const all = [];
    const walk = (dir, prefix) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory() && e.name !== 'node_modules')
          walk(path.join(dir, e.name), `${prefix}${e.name}/`);
        else if (e.isFile()) all.push(`${prefix}${e.name}`);
      }
    };
    walk(e2eDir, '');
    const byConfig = all.filter((rel) => testMatch.test(`/r/test-e2e/${rel}`)).sort();
    expect(harnessSpecs()).toEqual(byConfig);
  });
});
