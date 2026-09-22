/**
 * Assemble `changelog.d/` fragments into CHANGELOG.md's `## [Unreleased]`.
 *
 * Why this exists: every PR that lands a user-visible change edited
 * CHANGELOG.md directly, and they all edit the same few lines under the same
 * `### Fixed` heading. `main` requires branches to be up to date, so the first
 * merge of a batch left every other open PR conflicting on that one paragraph
 * — each then needed a merge commit and a full CI run (41 jobs at 10-14
 * minutes, measured 2026-09 before this change; see the workflow for what it
 * runs today) to validate a changelog edit. Merging four PRs cost four CI
 * cycles, none of which tested anything that had changed.
 *
 * A fragment is one file per change, so two PRs never write the same bytes and
 * the conflict disappears. The file is named `<section>--<slug>.md`, where the
 * section is one of the Keep a Changelog headings this project already uses;
 * its body is the entry exactly as it should read in the changelog, sub-bullets
 * and all. Release assembles them (see docs/agent-playbooks/changelog-process.md).
 *
 * This script never deletes a fragment: consuming them is an explicit
 * `git rm changelog.d/*--*.md` in the release steps — the `--` keeps
 * `changelog.d/README.md` out of the glob — so a dry run can never lose an
 * unreleased entry.
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

/**
 * A fragment body is a markdown bullet list and nothing else; throws otherwise.
 *
 * The body is spliced into CHANGELOG.md verbatim, so anything that is not a
 * bullet lands there as-is: a heading line copied along with a fenced example
 * becomes an `# ...` heading inside `## [Unreleased]`, a wrapped line that was
 * not indented becomes a second entry, and an empty file contributes nothing at
 * all. None of that is visible until the releaser assembles, months later —
 * this runs on every pull request instead, through the `changelog.d/` name
 * guard in `assemble-changelog.test.js`.
 */
function validateBody(filename, body) {
  const where = `changelog.d/${filename}`;
  if (!body) {
    throw new Error(`${where}: empty. Write the entry as it should read, or delete the file.`);
  }
  const lines = body.split('\n');
  if (!/^- \S/.test(lines[0])) {
    throw new Error(
      `${where}: must start with a top-level bullet ('- ...'), not ${JSON.stringify(lines[0])}. ` +
        `The body is the entry exactly as it reads in CHANGELOG.md — no heading, no file name, no prose.`
    );
  }
  for (const line of lines.slice(1)) {
    if (line.trim() === '' || /^\s/.test(line) || /^- \S/.test(line)) continue;
    throw new Error(
      `${where}: ${JSON.stringify(line)} is neither a bullet nor indented. ` +
        `Indent a sub-bullet or a wrapped line; an unindented line becomes its own entry.`
    );
  }
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
    // CRLF normalised here: a `\r` left on a line end is spliced into
    // CHANGELOG.md with it and breaks every sub-bullet comparison below.
    const body = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n').trim();
    validateBody(file, body);
    if (!bySection.has(section)) bySection.set(section, []);
    bySection.get(section).push(body);
  }
  return bySection;
}

/** A top-level bullet starts at column 0; its sub-bullets are indented. */
function isTopLevelLine(line) {
  return line.trim() !== '' && !/^\s/.test(line);
}

/** A body split into one string per top-level bullet, sub-bullets attached. */
function splitEntries(body) {
  const entries = [];
  for (const line of body.split('\n')) {
    if (entries.length === 0 || isTopLevelLine(line)) entries.push([line]);
    else entries[entries.length - 1].push(line);
  }
  return entries.map((lines) => lines.join('\n').replace(/\s+$/, '')).filter(Boolean);
}

/**
 * Entries that share a top-level bullet folded into one, sub-bullets in order.
 *
 * `changelog-process.md` puts every dependency update under a category lead
 * (`- Updated bundled nodes:`) with one sub-bullet per package, so a release
 * that bumps two of them has two fragments whose first line is the same
 * bullet. They are one entry in the changelog, not two.
 */
function mergeEntries(entries) {
  const byLead = new Map();
  for (const entry of entries.flatMap(splitEntries)) {
    const [lead, ...subs] = entry.split('\n');
    const key = lead.trim();
    if (!byLead.has(key)) byLead.set(key, [lead]);
    const lines = byLead.get(key);
    for (const sub of subs) {
      if (!lines.some((l) => l.trim() === sub.trim())) lines.push(sub);
    }
  }
  return [...byLead.values()].map((lines) => lines.join('\n'));
}

/** The markdown those fragments add, in canonical section order. */
function renderSections(bySection) {
  return SECTIONS.filter((s) => bySection.has(s))
    .map((s) => `### ${s}\n\n${mergeEntries(bySection.get(s)).join('\n')}`)
    .join('\n\n');
}

/** Line range of the `## [Unreleased]` block, or null when it has no heading. */
function unreleasedRange(lines) {
  const start = lines.findIndex((l) => l.trim() === UNRELEASED_HEADING);
  if (start === -1) return null;
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  if (end === -1) end = lines.length;
  return { start, end };
}

/** The `### <section>` line in `block`, or -1; and where that section ends. */
function sectionRange(block, section) {
  const start = block.findIndex((l) => l.trim() === `### ${section}`);
  if (start === -1) return null;
  let end = block.findIndex((l, i) => i > start && l.startsWith('### '));
  if (end === -1) end = block.length;
  return { start, end };
}

/**
 * Where an entry's lead bullet already sits in a section, and which of its
 * lines are missing under it.
 *
 * Matching whole entries, not just their first line: a fragment's lead bullet
 * can be one the block already carries — `- Updated bundled nodes:` is written
 * by every bundled-binary bump (`bundled-binaries.md` step 7) and is already
 * under `## [Unreleased]` the moment one of them has landed. Such a fragment
 * is not a duplicate; its sub-bullets belong under that bullet, and keying the
 * check on the first line alone dropped the whole entry on the floor.
 */
function locateEntry(block, section, entry) {
  const range = sectionRange(block, section);
  const [lead, ...subs] = entry.split('\n');
  if (!range) return { leadAt: -1, subsEnd: -1, missing: [lead, ...subs] };
  let leadAt = -1;
  for (let i = range.start + 1; i < range.end; i += 1) {
    if (isTopLevelLine(block[i]) && block[i].trim() === lead.trim()) {
      leadAt = i;
      break;
    }
  }
  if (leadAt === -1) return { leadAt, subsEnd: -1, missing: [lead, ...subs] };
  // That bullet's own lines run to the next bullet or the blank line before it.
  let subsEnd = leadAt + 1;
  while (subsEnd < range.end && block[subsEnd].trim() !== '' && !isTopLevelLine(block[subsEnd])) {
    subsEnd += 1;
  }
  const present = block.slice(leadAt + 1, subsEnd).map((l) => l.trim());
  const missing = subs.filter((l) => l.trim() !== '' && !present.includes(l.trim()));
  return { leadAt, subsEnd, missing };
}

/**
 * The fragments that would still add something to `## [Unreleased]`.
 *
 * The script never deletes a fragment, so the easy mistake is running
 * `--write` twice before the `git rm` that consumes them — which used to
 * duplicate every entry. An entry the block carries in full is skipped, which
 * makes a repeat run a no-op instead.
 */
function pendingFragments(changelog, bySection) {
  const lines = changelog.split('\n');
  const range = unreleasedRange(lines);
  if (!range) return bySection;
  const block = lines.slice(range.start + 1, range.end);
  const pending = new Map();
  for (const [section, entries] of bySection) {
    const fresh = mergeEntries(entries).filter((entry) => {
      const { leadAt, missing } = locateEntry(block, section, entry);
      return leadAt === -1 || missing.length > 0;
    });
    if (fresh.length > 0) pending.set(section, fresh);
  }
  return pending;
}

/**
 * Splice fragment entries into the `## [Unreleased]` block of `changelog`.
 * Entries join a heading that is already there; a heading that is not gets
 * inserted at its canonical position rather than appended at the end. An entry
 * whose lead bullet is already in the block has its own sub-bullets folded
 * under it rather than being appended a second time — or dropped. An entry the
 * block carries in full adds nothing, so a second `--write` is a no-op.
 */
function spliceIntoChangelog(changelog, bySection) {
  if (bySection.size === 0) return changelog;
  const lines = changelog.split('\n');
  const range = unreleasedRange(lines);
  if (!range) {
    throw new Error(`CHANGELOG.md has no '${UNRELEASED_HEADING}' heading to assemble into`);
  }
  const { start, end } = range;

  const block = lines.slice(start + 1, end);
  for (const section of SECTIONS) {
    if (!bySection.has(section)) continue;
    // Fold the fragments' own shared lead bullets together first, so two
    // bumps in one release land under one `- Updated bundled nodes:`.
    const fresh = [];
    for (const entry of mergeEntries(bySection.get(section))) {
      const { leadAt, subsEnd, missing } = locateEntry(block, section, entry);
      if (leadAt === -1) fresh.push(entry);
      else if (missing.length > 0) block.splice(subsEnd, 0, ...missing);
    }
    if (fresh.length === 0) continue;
    const entries = fresh.join('\n').split('\n');
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
      // A heading with no entries yet leaves the insert point on the heading's
      // own line; every other section has a blank line under its heading.
      const lead = insertAt === at + 1 ? [''] : [];
      block.splice(insertAt, 0, ...lead, ...entries);
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
  const updated = spliceIntoChangelog(changelog, bySection);
  if (updated === changelog) {
    console.log('CHANGELOG.md already carries every fragment — nothing to splice.');
    console.log('Remove the consumed fragments: git rm changelog.d/*--*.md');
    return 0;
  }
  fs.writeFileSync(CHANGELOG_PATH, updated);
  const count = [...pendingFragments(changelog, bySection).values()].reduce(
    (n, e) => n + e.length,
    0
  );
  console.log(`Assembled ${count} entr${count === 1 ? 'y' : 'ies'} into CHANGELOG.md.`);
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
  validateBody,
  collectFragments,
  mergeEntries,
  renderSections,
  pendingFragments,
  spliceIntoChangelog,
  main,
};
