/**
 * Guard that the raw evidence an audit cites is actually in the repo.
 *
 * PR #806's Windows standard-user audit cited `logs/s8.log`, `logs/final.log`
 * and the rest, but the root `.gitignore`'s `*.log` rule silently kept the
 * whole `logs/` directory out of the commit. The VM that produced them was
 * destroyed, so a merged audit would have pointed at evidence nobody could
 * recover. A file-existence check alone can't see that locally (the ignored
 * files are still on the author's disk), so this asks git directly too.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const EVIDENCE_ROOT = __dirname;
const AUDITS_ROOT = path.dirname(EVIDENCE_ROOT);
const REPO_ROOT = path.resolve(AUDITS_ROOT, '../..');

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
}

describe('docs/audits evidence citations', () => {
  test('no file under docs/audits/evidence is git-ignored', () => {
    const ignored = git(['ls-files', '--others', '--ignored', '--exclude-standard', '--', 'docs/audits/evidence'])
      .split('\n').filter(Boolean);
    expect(ignored).toEqual([]);
  });

  const audits = fs.readdirSync(AUDITS_ROOT).filter(name => name.endsWith('.md'));
  const cases = [];
  for (const name of audits) {
    const text = fs.readFileSync(path.join(AUDITS_ROOT, name), 'utf8');
    const dirs = [...new Set([...text.matchAll(/\]\(evidence\/([^/)]+)\/?\)/g)].map(m => m[1]))];
    const logs = [...new Set([...text.matchAll(/`(logs\/[^`\s]+)`/g)].map(m => m[1]))];
    if (dirs.length === 1 && logs.length) cases.push([name, dirs[0], logs]);
  }

  test('the Windows standard-user audit is among the checked documents', () => {
    expect(cases.map(([name]) => name)).toContain('windows-standard-user-validation-2026-10.md');
  });

  test.each(cases)('%s: every cited log exists in evidence/%s', (_name, dir, logs) => {
    // `logs/qualify-NN-*.log` names a series: NN is two digits, * anything.
    const matches = log => {
      if (!/NN|\*/.test(log)) return fs.existsSync(path.join(EVIDENCE_ROOT, dir, log));
      const pattern = new RegExp(`^${path.basename(log).replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace('NN', '\\d{2}').replace(/\*/g, '.+')}$`);
      const parent = path.join(EVIDENCE_ROOT, dir, path.dirname(log));
      return fs.existsSync(parent) && fs.readdirSync(parent).some(name => pattern.test(name));
    };
    const missing = logs.filter(log => !matches(log));
    expect(missing).toEqual([]);
  });

  test('windows-standard-user-2026-10: the README log list matches logs/', () => {
    const dir = path.join(EVIDENCE_ROOT, 'windows-standard-user-2026-10');
    const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
    const section = readme.slice(readme.indexOf('## Logs'));
    // Each bullet names its files before the colon (`a.log`, `b.log`: …).
    const listed = section.split('\n').filter(line => line.startsWith('- '))
      .flatMap(line => [...line.split(':')[0].matchAll(/`([\w.-]+\.log)`/g)].map(m => m[1]));
    expect(listed).toContain('s8.log');
    const present = fs.readdirSync(path.join(dir, 'logs'));
    expect(listed.filter(name => !present.includes(name))).toEqual([]);
    // "the 13 full qualification runs, in order"
    expect(present.filter(name => /^qualify-\d{2}-.+\.log$/.test(name))).toHaveLength(13);
  });
});
