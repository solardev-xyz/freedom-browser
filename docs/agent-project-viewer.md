# Project viewers and recovery

Files, Changes and History share a read-only viewer in ordinary browser tabs.
The viewer belongs to its conversation: switching conversations closes its tabs
and discards pending responses. It does not load project HTML or execute scripts.

## Browsing and comparisons

- **Files** opens from Workspace and browses directories, including unchanged
  source files. Search project filenames with Enter; filter the listed files
  separately. Generated/private paths, links and credential files are excluded.
- **Changes** distinguishes all, staged and unstaged changes. An external folder
  without Git shows only directly recorded edits, explicitly labelled as such.
- **History** is available from the Commits menu's **Browse history** entry or
  the viewer header. Load older commits and open file-specific history. A commit
  opens on its changes against its first parent (or an empty tree for the first
  commit); choose another loaded commit as the base, or browse its saved files.
- Text comparisons support unified and side-by-side views, old/new line numbers,
  next/previous change, collapsed unchanged context, search and wrapping. Exact,
  unambiguous same-content renames are recognized in commit comparisons; more
  complex renames remain additions/deletions. Git status supplies working-tree
  rename information. Merge commits default to their first parent.
- Plain text has line numbers and lightweight syntax highlighting for common
  source extensions. Markdown preview supports headings, paragraphs and fenced
  code; raw HTML, links and image syntax stay literal. PNG/JPEG/GIF/WebP previews
  load only explicit bounded local image bytes, never project URLs or SVG code.
- **Compare with current** compares a historical file to the current complete
  text preview. Missing/binary/oversized files are reported, not treated as empty.
- Resizable navigation, keyboard file-list movement and Cmd/Ctrl+F are local to
  the viewer. Refresh retains file selection and document scroll. Switching
  views retains their selections; conversation changes do not retain authority.

## Bounds

Text reads return 64 KiB character pages, up to a 1 MiB source-file limit;
working-file continuation is bound to a content digest and refuses changed bytes.
Git patch output is bounded by the existing 512 KiB subprocess-output limit.
Historical managed files retain their existing 64 KiB storage limit. Larger
historical external files and comparisons can load further bounded pages.
Rendering is paginated at 2,000 rows. Very large changed blocks use a bounded
replacement diff rather than unbounded quadratic alignment. Find and change
navigation operate on the loaded/rendered content.

Directory listings page 200 entries within a 10,000-name scan. Filename search
returns up to 200 matches within the existing workspace scan limits. External
commit file lists page 200 entries; underlying Git output remains bounded.
History pages contain up to 100 commits, with managed file-history traversal
limited to 1,000 records per page and owned-history lookup to 10,000 records.
Raster image previews are limited to 384 KiB. Limits and unsupported content are
shown in the viewer. These changes do not increase checkpoint ingestion limits.

## Reviewed restoration in managed workspaces

**Restore file…** reviews the selected file; **Restore…** reviews the saved
version. Both show actual before/after content and permit selecting files. Changing
that selection prepares a fresh preview; a second confirmation applies that
exact plan. Current affected files must already be reviewed and saved; restoring selected
files does not require saving unrelated dirty files. The Agent
must be idle and project processes stopped. Plans expire after five minutes and
are consumed once; history, exclusions and file fingerprints are rechecked.

Before writing files, Freedom saves a reviewed backup and durably writes
`.git/freedom-history/restore-recovery.json`. A failed or interrupted restore
leaves that record available after restart. History offers **Review recovery**.
Recovery accepts only known pre-restore or intended post-restore revisions of
the affected files. Later unrelated contents are refused; a user must inspect
and reconcile them. Recovery itself gets a fresh plan and confirmation, saves a
backup, and clears the pending record only after verified completion. Unrelated
working files remain outside the operation.

## Interrupted commits in external repositories

History inspects the existing private `git-commit-pending.json` record against
current branch and index state. It reports a landed candidate, a branch still
at the starting revision, or an uncertain/diverged state. Inspection is read-only
and exposes no host paths, index bytes or credentials to the renderer.

**Review finalization** appears only when the original branch points to the
candidate and either (a) the unchanged original index and exact owned lock still
match the prepared index, or (b) the prepared index is already installed and no
lock remains. After explicit confirmation, editing access, idle state, metadata
identity, cancellation and a digest-bound state token are rechecked. Finalization
installs only the prepared index where needed and archives the journal in private
storage. It never edits working files or changes branch refs. Unrelated staging
prepared by the original commit operation is preserved.

Changed/foreign locks, changed staging, moved branches, missing authority and
ambiguous outcomes require deliberate Git-client reconciliation. No automatic
lock deletion, commit retry, reset, rebase or external-project rollback is added.
The existing same-user filesystem race limitation still applies; this is not
isolation against a malicious host process.

## Validation

Local validation passed: lint, 302 tests across 12 focused Jest suites, and all
four disposable-Electron viewer cases. Native external-Git fault qualification
on the Mac mini remains pending approval to transfer the candidate source and
fixtures; the mocked protocol and renderer checks do not replace that step.

Focused Jest checks cover tree/text comparison, selected restores, durable
partial-restore recovery and intervening edits, preview freshness, IPC ownership
and input bounds, renderer races and literal content rendering. Pure protocol
checks cover external repair tokens, permissions, cancellation, changed indexes
and replaced locks. The real-Git fault fixtures remain explicitly gated by
`FREEDOM_PROJECT_GIT_TESTS=1` for the designated disposable test machine.

`test-e2e/workspace-viewers.spec.js` runs the product renderer with deterministic
API fixtures inside disposable Electron profiles in dark/light and browser/agent
layouts. It checks actual computed header/tab colors, comparisons, restore
review, inert Markdown and narrow-pane geometry; screenshots are retained in
Playwright output. This is renderer qualification, not a real filesystem restore.
