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
 * A fragment's bytes as the rest of this script needs them: no UTF-8 BOM, `\n`
 * line ends, and no trailing whitespace on any line.
 *
 * All three are things an editor adds without being asked, and all three land
 * in CHANGELOG.md or break a check without ever looking wrong in the fragment:
 * a BOM on the first line makes `validateBody` refuse a bullet whose quoted
 * text reads byte-for-byte correct; a bare `\r` (an editor writing classic-Mac
 * line ends) leaves the whole file as one line that validates and splices with
 * the `\r` mid-entry; two trailing spaces are a markdown hard break that would
 * be spliced in verbatim, and any trailing whitespace defeats the sub-bullet
 * comparisons below, which are the only thing keeping a second `--write` from
 * duplicating an entry.
 */
function normaliseFragment(text) {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '');
}

/**
 * A fragment body is one tight markdown bullet list and nothing else; throws
 * otherwise.
 *
 * The body is spliced into CHANGELOG.md verbatim, so anything that is not a
 * bullet lands there as-is: a heading line copied along with a fenced example
 * becomes an `# ...` heading inside `## [Unreleased]`, a wrapped line that was
 * not indented becomes a second entry, and an empty file contributes nothing at
 * all. None of that is visible until the releaser assembles, months later —
 * this runs on every pull request instead, through the `changelog.d/` name
 * guard in `assemble-changelog.test.js`.
 *
 * Tight — no blank line inside the body — because that is the shape
 * `locateEntry` reads back out of `## [Unreleased]`: an entry's lines run to
 * the next bullet or the blank line before it. A loose sub-list splices once
 * and then reads back short, so the sub-bullets past the blank look missing
 * and a second `--write` inserts them again, against `changelog.d/README.md`'s
 * promise that the repeat run is harmless. The shipped changelog has never put
 * a blank inside an entry.
 *
 * Two levels deep at most — a bullet and sub-bullets indented two spaces — for
 * the same reason. `locateEntry` reads an entry back as a flat list of
 * sub-lines and folds a missing one in after the last one already there, so a
 * third level (or a sub-bullet mis-indented four spaces) would land under
 * whichever sub-bullet happens to be last rather than under its own parent.
 * The shipped changelog has never carried a third level either, so refusing
 * one here costs nothing and keeps that silent misplacement out of a release.
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
    if (line.trim() === '') {
      throw new Error(
        `${where}: a blank line inside the entry. Write the bullets as one tight ` +
          `list — a loose one splices in fine and then duplicates on the next run.`
      );
    }
    if (/^- \S/.test(line) || /^ {2}\S/.test(line)) continue;
    if (/^\s/.test(line)) {
      throw new Error(
        `${where}: ${JSON.stringify(line)} is indented deeper than one level. ` +
          `An entry is a top-level bullet plus sub-bullets indented two spaces — the only ` +
          `shape CHANGELOG.md has ever carried, and the only one the assembler can place: ` +
          `a deeper line is folded in after the entry's last sub-bullet, under whichever ` +
          `one happens to sit there rather than under its own parent.`
      );
    }
    throw new Error(
      `${where}: ${JSON.stringify(line)} is neither a bullet nor indented. ` +
        `Indent a sub-bullet or a wrapped line; an unindented line becomes its own entry.`
    );
  }
}

/**
 * A body with its own indentation removed: the first line's leading whitespace
 * stripped off every line, and blank lines trimmed from both ends.
 *
 * `bundled-binaries.md` step 7 shows the fragment inside a numbered list, so
 * every line of that fence carries three spaces. Trimming the body dedents its
 * *first* line only, so the sub-bullets land in CHANGELOG.md two spaces too
 * deep — still valid markdown, so nothing downstream notices, and prettier is
 * not in CI to catch it.
 */
function dedent(body) {
  const lines = body.replace(/\s+$/, '').split('\n');
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  const [indent] = /^[ \t]*/.exec(lines[0] ?? '');
  if (indent === '') return lines.join('\n');
  return lines
    .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line.trimStart()))
    .join('\n');
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
    const body = dedent(normaliseFragment(fs.readFileSync(path.join(dir, file), 'utf8')));
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
  // That bullet's own lines run to the next bullet. A blank one inside them is
  // read as part of the entry rather than as its end — `validateBody` refuses
  // to write that shape, but one hand-typed into `## [Unreleased]` would
  // otherwise hide every sub-bullet below it and have the next `--write`
  // splice those in again. `subsEnd` is where a missing sub-bullet goes: the
  // line after the last one actually there, never after a trailing blank.
  let scan = leadAt + 1;
  let subsEnd = leadAt + 1;
  while (scan < range.end && !isTopLevelLine(block[scan])) {
    scan += 1;
    if (block[scan - 1].trim() !== '') subsEnd = scan;
  }
  const present = block.slice(leadAt + 1, scan).map((l) => l.trim());
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
      // An empty block puts the insert point on the line straight after
      // `## [Unreleased]` — the shape step 9 hand-types at release. Every other
      // release heading has a blank line under it; this one gets one too.
      const lead = insertAt === 0 ? [''] : [];
      block.splice(insertAt, 0, ...lead, `### ${section}`, '', ...entries, '');
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
  // Both runs read CHANGELOG.md, so the dry run answers the question the
  // releaser is actually asking — what would `--write` add *now* — instead of
  // re-printing every fragment as pending after a `--write` has already
  // spliced them, while `--write` itself reports nothing to do. The missing
  // `## [Unreleased]` heading fails here too (changelog-process.md step 9 is
  // where it gets re-introduced): surfacing it only on `--write` means the dry
  // run reads as ready when it is not.
  const changelog = fs.readFileSync(CHANGELOG_PATH, 'utf8');
  if (!unreleasedRange(changelog.split('\n'))) {
    throw new Error(`CHANGELOG.md has no '${UNRELEASED_HEADING}' heading to assemble into`);
  }
  const pending = pendingFragments(changelog, bySection);
  const count = [...pending.values()].reduce((n, e) => n + e.length, 0);
  if (count === 0) {
    console.log('CHANGELOG.md already carries every fragment — nothing to splice.');
    console.log('Remove the consumed fragments: git rm changelog.d/*--*.md');
    return 0;
  }
  if (!write) {
    console.log(renderSections(pending));
    console.log('\n(dry run — pass --write to splice this into CHANGELOG.md)');
    return 0;
  }
  fs.writeFileSync(CHANGELOG_PATH, spliceIntoChangelog(changelog, bySection));
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
  normaliseFragment,
  validateBody,
  collectFragments,
  mergeEntries,
  renderSections,
  pendingFragments,
  spliceIntoChangelog,
  main,
};
