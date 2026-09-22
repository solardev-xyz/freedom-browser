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
to the voice rules in `docs/agent-playbooks/changelog-process.md`:

```markdown
- A Settings address that names a section Freedom does not have no longer stands over a different one
  - `freedom://settings/privacy` opened Appearance and left its own name in the address bar
```

Not every change needs one. The same exclusions apply as before — developer-only
fixes, in-release polish, test-only and internal work stay out of the changelog,
and so stay out of `changelog.d/`.

## Assembling them

`npm run changelog:assemble` prints what the fragments add;
`npm run changelog:assemble -- --write` splices them into the
`## [Unreleased]` block, joining headings that are already there and inserting
missing ones in Keep a Changelog order. The `--` is not optional: npm swallows
`npm run changelog:assemble --write`, which then silently dry-runs.

It never deletes a fragment: removing the consumed ones is an explicit
`git rm changelog.d/*--*.md` in the release steps, so a dry run cannot lose an
unreleased entry. Running `--write` twice before that `git rm` is harmless —
an entry the `## [Unreleased]` block already carries is left alone.
