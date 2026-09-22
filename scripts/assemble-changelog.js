/**
 * Assemble `changelog.d/` fragments into CHANGELOG.md's `## [Unreleased]`.
 *
 * Why this exists: every PR that lands a user-visible change edited
 * CHANGELOG.md directly, and they all edit the same few lines under the same
 * `### Fixed` heading. `main` requires branches to be up to date, so the first
 * merge of a batch left every other open PR conflicting on that one paragraph
 * — each then needed a merge commit and a full CI run (41 jobs, 10-14 minutes)
 * to validate a changelog edit. Merging four PRs cost four CI cycles, none of
 * which tested anything that had changed.
 *
 * A fragment is one file per change, so two PRs never write the same bytes and
 * the conflict disappears. The file is named `<section>--<slug>.md`, where the
 * section is one of the Keep a Changelog headings this project already uses;
 * its body is the entry exactly as it should read in the changelog, sub-bullets
 * and all. Release assembles them (see docs/agent-playbooks/changelog-process.md).
 *
 * This script never deletes a fragment: consuming them is an explicit
 * `git rm changelog.d/*.md` in the release steps, so a dry run can never lose
 * an unreleased entry.
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const FRAGMENT_DIR = path.join(repoRoot, 'changelog.d');
const CHANGELOG_PATH = path.join(repoRoot, 'CHANGELOG.md');

// Keep a Changelog order, matching changelog-process.md and the shipped
// releases. `Security` stays last.
const SECTIONS = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];

const UNRELEASED_HEADING = '## [Unreleased]';

/** `fixed--settings-deeplink.md` -> `Fixed`; throws on anything else. */
function sectionOf(filename) {
  const [prefix] = filename.split('--');
  const section = SECTIONS.find((s) => s.toLowerCase() === prefix.toLowerCase());
  if (!section) {
    throw new Error(
      `changelog.d/${filename}: name must start with one of ` +
        `${SECTIONS.map((s) => s.toLowerCase()).join(', ')} followed by '--', ` +
        `e.g. fixed--settings-deeplink.md`
    );
  }
  return section;
}

/** Fragments on disk, grouped by section, each group sorted by filename. */
function collectFragments(dir = FRAGMENT_DIR) {
  if (!fs.existsSync(dir)) return new Map();
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .sort();
  const bySection = new Map();
  for (const file of files) {
    const section = sectionOf(file);
    const body = fs.readFileSync(path.join(dir, file), 'utf8').trim();
    if (!body) continue;
    if (!bySection.has(section)) bySection.set(section, []);
    bySection.get(section).push(body);
  }
  return bySection;
}

/** The markdown those fragments add, in canonical section order. */
function renderSections(bySection) {
  return SECTIONS.filter((s) => bySection.has(s))
    .map((s) => `### ${s}\n\n${bySection.get(s).join('\n')}`)
    .join('\n\n');
}

/**
 * Splice fragment entries into the `## [Unreleased]` block of `changelog`.
 * Entries join a heading that is already there; a heading that is not gets
 * inserted at its canonical position rather than appended at the end.
 */
function spliceIntoChangelog(changelog, bySection) {
  if (bySection.size === 0) return changelog;
  const lines = changelog.split('\n');
  const start = lines.findIndex((l) => l.trim() === UNRELEASED_HEADING);
  if (start === -1) {
    throw new Error(`CHANGELOG.md has no '${UNRELEASED_HEADING}' heading to assemble into`);
  }
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  if (end === -1) end = lines.length;

  const block = lines.slice(start + 1, end);
  for (const section of SECTIONS) {
    if (!bySection.has(section)) continue;
    const entries = bySection.get(section).join('\n').split('\n');
    const at = block.findIndex((l) => l.trim() === `### ${section}`);
    if (at === -1) {
      // Insert before the first heading that sorts after this one, so the
      // block stays in Keep a Changelog order however it was assembled.
      const later = SECTIONS.slice(SECTIONS.indexOf(section) + 1);
      let insertAt = block.findIndex((l) => later.some((s) => l.trim() === `### ${s}`));
      if (insertAt === -1) insertAt = block.length;
      block.splice(insertAt, 0, `### ${section}`, '', ...entries, '');
    } else {
      // End of that heading's entries: the line before the next heading.
      let next = block.findIndex((l, i) => i > at && l.startsWith('### '));
      if (next === -1) next = block.length;
      let insertAt = next;
      while (insertAt > at + 1 && block[insertAt - 1].trim() === '') insertAt -= 1;
      block.splice(insertAt, 0, ...entries);
    }
  }
  return [...lines.slice(0, start + 1), ...block, ...lines.slice(end)].join('\n');
}

function main(argv) {
  const write = argv.includes('--write');
  const bySection = collectFragments();
  if (bySection.size === 0) {
    console.log('No changelog fragments in changelog.d/.');
    return 0;
  }
  const rendered = renderSections(bySection);
  if (!write) {
    console.log(rendered);
    console.log('\n(dry run — pass --write to splice this into CHANGELOG.md)');
    return 0;
  }
  const changelog = fs.readFileSync(CHANGELOG_PATH, 'utf8');
  fs.writeFileSync(CHANGELOG_PATH, spliceIntoChangelog(changelog, bySection));
  const count = [...bySection.values()].reduce((n, e) => n + e.length, 0);
  console.log(`Assembled ${count} fragment(s) into CHANGELOG.md.`);
  console.log('Now remove the consumed fragments: git rm changelog.d/*--*.md');
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

module.exports = {
  SECTIONS,
  UNRELEASED_HEADING,
  sectionOf,
  collectFragments,
  renderSections,
  spliceIntoChangelog,
  main,
};
