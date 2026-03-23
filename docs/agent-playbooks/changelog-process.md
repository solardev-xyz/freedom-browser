# Changelog Process Playbook

Use this playbook when asked to update `CHANGELOG.md` for a new version.

## Procedure

1. Find the baseline commit:
   - `git log --oneline -p -- package.json`
2. Gather all commits since baseline:
   - `git log --pretty=format:"%H%n%s%n%b%n---" <baseline>..HEAD`
3. Get the release date from git history:
   - `git show -s --format="%ad" --date=short HEAD`
4. Categorize entries using Keep a Changelog headings:
   - `### Added`
   - `### Changed`
   - `### Fixed`
   - `### Security`
   - (also `### Deprecated` and `### Removed` when applicable)
5. Skip housekeeping commits:
   - TODO/changelog/version-bump commits
   - dependency lock-only updates
   - README/docs rewrites
   - internal refactors without user impact
   - test-only commits
6. Merge related commits into a single user-facing entry.
7. Inspect PR merge commits by reviewing underlying commits.
8. Re-run the git log before editing to catch late commits.
9. Prepend the new version section above the previous one.

## Output Style

- Write user-facing outcomes, not implementation noise.
- Prefer concise bullets that explain impact.
