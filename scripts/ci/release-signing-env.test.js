/**
 * Guard for "the macOS signing secrets are scoped to the `release-signing`
 * environment" (#657).
 *
 * The five Developer ID / notarization secrets live in the GitHub Environment
 * `release-signing`, whose deployment policy admits only `main`, `release/*`
 * and `v*` tags by name (docs/agent-playbooks/release-process.md, Appendix B,
 * covers the rulesets that decide who may create those refs). That only protects
 * them if every job that reads them is a job that asks for that environment:
 * a job without one reads the repository-level secret of the same name, and
 * once those are deleted it reads an empty string, so a misplaced reference
 * either leaks (before the move) or silently builds unsigned (after it).
 * zizmor's `secrets-outside-env` audit only runs under `--persona=auditor`,
 * which CI does not use, so it is pinned here instead:
 *
 * 1. across every workflow and local action, `release.yml`'s `mac-arm64` job
 *    is the only place that names a `CSC_*` or `APPLE_*` secret, and every
 *    `secrets` reference anywhere is a plain `secrets.NAME` this check can see
 *    (no `secrets[...]`, `toJSON(secrets)` or `secrets: inherit`, which would
 *    hand the whole context over without naming it);
 * 2. `mac-arm64` carries the `release-signing` environment exactly when the
 *    run is signed — the same condition as its `SIGNED` env, so a signed run
 *    can never go without the environment and an unsigned one (a pipeline
 *    test from a feature branch) never needs it;
 * 3. no other job mentions `release-signing` (an environment, or anything
 *    else), and every other job's `environment:` is a plain literal name, so
 *    one built at runtime (`vars.*`, `format()`) cannot name it unseen.
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');

const SIGNING_SECRETS = [
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_ID',
  'APPLE_TEAM_ID',
  'CSC_KEY_PASSWORD',
  'CSC_LINK',
];
const isSigningSecret = (name) => /^(CSC|APPLE)_/i.test(name);
const SIGNED_CONDITION = "github.event_name != 'workflow_dispatch' || inputs.signed";

// Whole-line comments blanked (not dropped) so line numbers and offsets match.
const withoutComments = (text) =>
  text
    .split('\n')
    .map((line) => (/^\s*#/.test(line) ? '' : line))
    .join('\n');

/** Every workflow and local action file, relative to the repo root. */
const yamlFiles = () => {
  const out = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(repoRoot, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (/\.ya?ml$/i.test(entry.name)) out.push(child);
    }
  };
  walk('.github/workflows');
  walk('.github/actions');
  return out.sort();
};

/** `[start, end)` offsets of every `${{ … }}` expression, multi-line ones included. */
const expressionSpans = (text) => {
  const spans = [];
  let at = text.indexOf('${{');
  while (at !== -1) {
    const end = text.indexOf('}}', at);
    if (end === -1) throw new Error(`unterminated expression at offset ${at}`);
    spans.push([at, end + 2]);
    at = text.indexOf('${{', end + 2);
  }
  return spans;
};

/** The job each line of a workflow belongs to (null outside `jobs:`). */
const jobOfLine = (text) => {
  let current = null;
  let inJobs = false;
  return text.split('\n').map((line) => {
    if (/^\S/.test(line)) {
      inJobs = /^jobs:\s*$/.test(line);
      current = null;
      return null;
    }
    const header = inJobs && line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (header) current = header[1];
    return inJobs ? current : null;
  });
};

/** Every `secrets` mention in an expression or a `secrets:` key, classified. */
const secretReferences = () => {
  const refs = [];
  for (const file of yamlFiles()) {
    const text = withoutComments(fs.readFileSync(path.join(repoRoot, file), 'utf8'));
    const jobs = jobOfLine(text);
    const lineAt = (offset) => text.slice(0, offset).split('\n').length;
    for (const [start, end] of expressionSpans(text)) {
      const expr = text.slice(start, end);
      for (const m of expr.matchAll(/\bsecrets\b(\s*\.\s*([A-Za-z_][A-Za-z0-9_-]*))?/g)) {
        const line = lineAt(start + m.index);
        refs.push({ file, line, job: jobs[line - 1], name: m[2] ?? null, raw: m[0] });
      }
    }
    text.split('\n').forEach((l, i) => {
      if (/^\s*secrets:\s*inherit\b/.test(l)) {
        refs.push({ file, line: i + 1, job: jobs[i], name: null, raw: l.trim() });
      }
    });
  }
  return refs;
};

/** The lines of one job's own block in a workflow. */
const jobBlock = (file, job) => {
  const text = withoutComments(fs.readFileSync(path.join(repoRoot, file), 'utf8'));
  const owners = jobOfLine(text);
  return text.split('\n').filter((_, i) => owners[i] === job);
};

const normalise = (s) => s.replace(/\s+/g, ' ').trim();

describe('macOS signing secrets are scoped to release-signing (#657)', () => {
  const refs = secretReferences();
  const where = (r) => `${r.file}:${r.line} [${r.job ?? '-'}] ${r.raw}`;

  test('every secrets reference is a plain secrets.NAME', () => {
    // Allowlist: anything but a named property (bracket access, toJSON(secrets),
    // secrets: inherit) could reach a signing secret without naming it.
    expect(refs.filter((r) => r.name === null).map(where)).toEqual([]);
  });

  test('the scan finds the signing secrets where they are used', () => {
    // A parser regression must not make the check below pass vacuously.
    const names = [
      ...new Set(refs.filter((r) => isSigningSecret(r.name ?? '')).map((r) => r.name)),
    ];
    expect(names.sort()).toEqual(SIGNING_SECRETS);
  });

  test("release.yml's mac-arm64 is the only job naming a CSC_*/APPLE_* secret", () => {
    const offenders = refs
      .filter((r) => r.name && isSigningSecret(r.name))
      .filter((r) => !(r.file === '.github/workflows/release.yml' && r.job === 'mac-arm64'))
      .map(where);
    expect(offenders).toEqual([]);
  });

  describe('mac-arm64', () => {
    const block = jobBlock('.github/workflows/release.yml', 'mac-arm64');

    test('takes the release-signing environment exactly when the run is signed', () => {
      const at = block.findIndex((l) => /^ {4}environment:/.test(l));
      expect(at).toBeGreaterThan(-1);
      // Object form, `name:` on the next line (a bare string would also work,
      // but one spelling keeps this check exact).
      expect(block[at].trim()).toBe('environment:');
      const name = block[at + 1].match(/^ {6}name:\s*(.*)$/);
      expect(name).not.toBeNull();
      expect(normalise(name[1])).toBe(`\${{ (${SIGNED_CONDITION}) && 'release-signing' || '' }}`);
    });

    test('its SIGNED env uses the same condition', () => {
      // If SIGNED and the environment ever disagree, a signed build runs
      // without the environment (no secrets once they are moved) or an
      // unsigned one demands it (feature-branch pipeline tests break).
      const signed = block.find((l) => /^ {6}SIGNED:/.test(l));
      expect(signed && normalise(signed.replace(/^\s*SIGNED:\s*/, ''))).toBe(
        `\${{ ${SIGNED_CONDITION} }}`
      );
    });
  });

  test('no other job asks for release-signing', () => {
    // Inside a job, not in prose such as the `signed` input's description.
    // A literal mention anywhere in another job is an offender outright.
    const offenders = [];
    for (const file of yamlFiles()) {
      const text = withoutComments(fs.readFileSync(path.join(repoRoot, file), 'utf8'));
      const jobs = jobOfLine(text);
      text.split('\n').forEach((l, i) => {
        if (!/release-signing/.test(l) || jobs[i] === null) return;
        if (file === '.github/workflows/release.yml' && jobs[i] === 'mac-arm64') return;
        offenders.push(`${file}:${i + 1} [${jobs[i] ?? '-'}] ${l.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  test('every other job environment is a plain literal name', () => {
    // The substring check above cannot see a name built at runtime
    // (`${{ vars.SIGNING_ENV }}`, `format('release-{0}', 'signing')`, a block
    // scalar). So allowlist the shape instead: outside mac-arm64, a job's
    // `environment:` (string form, or the object form's `name:`) must be a
    // plain literal this test can read, and not release-signing. That fails
    // closed at runtime anyway (the branch policy still applies), so this
    // pins the invariant "only mac-arm64 uses the environment", not a hole.
    const LITERAL = /^(['"]?)([A-Za-z0-9_.-]+)\1$/;
    const offenders = [];
    let seen = 0;
    for (const file of yamlFiles()) {
      const lines = withoutComments(fs.readFileSync(path.join(repoRoot, file), 'utf8')).split('\n');
      const jobs = jobOfLine(lines.join('\n'));
      lines.forEach((l, i) => {
        const env = jobs[i] !== null && l.match(/^ {4}environment:\s*(.*)$/);
        if (!env) return;
        seen += 1;
        if (file === '.github/workflows/release.yml' && jobs[i] === 'mac-arm64') return;
        let value = env[1].trim();
        if (value === '') {
          // Object form: the name is the `name:` key in the indented block.
          const nameLine = lines
            .slice(i + 1)
            .filter((x) => x.trim() !== '')
            .find((x) => /^ {6}name:/.test(x) || !/^ {6}/.test(x));
          const name = nameLine && nameLine.match(/^ {6}name:\s*(.*)$/);
          value = name ? name[1].trim() : '';
        }
        const literal = value.match(LITERAL);
        if (!literal || literal[2] === 'release-signing') {
          offenders.push(`${file}:${i + 1} [${jobs[i]}] environment: ${value || '(no name)'}`);
        }
      });
    }
    expect(seen).toBeGreaterThan(0); // mac-arm64's own; the scan must not go blind
    expect(offenders).toEqual([]);
  });
});
