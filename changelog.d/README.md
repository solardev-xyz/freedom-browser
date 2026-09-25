# Changelog fragments

One file per user-visible change, so two pull requests never edit the same
lines of `CHANGELOG.md` and never conflict over it.

## Writing one

Name the file `<section>--<slug>.md`:

- `<section>` is one of `added`, `changed`, `deprecated`, `removed`, `fixed`,
  `security` — the Keep a Changelog headings this project already uses.
- `<slug>` is anything that makes the file unique and readable in a diff;
  the issue or PR number works well: `fixed--280-settings-deeplink.md`.

The body is the entry exactly as it should appear under that heading, written
to the voice rules in `docs/agent-playbooks/changelog-process.md`, ending in a
link to its issue, or to the pull request when there is none:

```markdown
- A Settings address that names a section Freedom does not have no longer stands over a different one ([#280](https://github.com/solardev-xyz/freedom-browser/issues/280))
  - `freedom://settings/privacy` opened Appearance and left its own name in the address bar
```

Bullets and nothing else: the body is spliced into `## [Unreleased]` verbatim,
so a heading line or a bare paragraph lands there as one. Sub-bullets and
wrapped lines are indented two spaces — an unindented continuation becomes its
own entry, and a deeper indent is refused: the assembler folds a missing line
in after an entry's last sub-bullet, so a third level would land under
whichever sub-bullet happens to sit there rather than under its own parent.
The list is tight, with no blank line between the bullets. The file's own
indentation does not matter: a fragment pasted out of an indented fence (the
one in `docs/agent-playbooks/bundled-binaries.md` step 7 sits inside a numbered
list) is dedented by its first line's whitespace. `npm run changelog:assemble`
refuses anything else, and the `changelog.d/` guard in
`scripts/assemble-changelog.test.js` runs that check on every pull request
rather than leaving it for the releaser.

Not every change needs one. The same exclusions apply as before — developer-only
fixes, in-release polish, test-only and internal work stay out of the changelog,
and so stay out of `changelog.d/`.

## Assembling them

`npm run changelog:assemble` prints what the fragments still add to
`## [Unreleased]` — after a `--write`, that is nothing;
`npm run changelog:assemble -- --write` splices them into the
`## [Unreleased]` block, joining headings that are already there and inserting
missing ones in Keep a Changelog order. The `--` is not optional: npm swallows
`npm run changelog:assemble --write`, which then silently dry-runs.

Fragments that open with the same top-level bullet are one entry, not two:
their sub-bullets are folded under that one bullet, whether the bullet comes
from another fragment in the same release or is already under
`## [Unreleased]` from an earlier one. That is what makes the category leads
`changelog-process.md` prescribes — `- Updated bundled nodes:` and friends —
writable one bump per fragment.

It never deletes a fragment: removing the consumed ones is an explicit
`git rm changelog.d/*--*.md` in the release steps, so a dry run cannot lose an
unreleased entry. Running `--write` twice before that `git rm` is harmless —
a sub-bullet the `## [Unreleased]` block already carries is left alone. What it
compares is the text, so a line edited in `CHANGELOG.md` after assembling no
longer matches its fragment and a further `--write` inserts the original beside
it: edit the fragment, or `git rm` it first.
