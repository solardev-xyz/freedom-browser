# Merge Process Playbook

Use this playbook when merging one or more approved pull requests into `main`.

## What makes merging slow here

`main` requires branches to be up to date before they merge, and CI is a full
matrix — 41 jobs at 10-14 minutes when this was measured, 2026-09; read
`.github/workflows/ci.yml` for what it runs today. So merging a batch is a
train: the first merge puts every other branch behind, and each one then needs
an update and a full re-run before its turn. Four pull requests cost four CI
cycles.

Two things keep that train short:

1. **Changelog fragments.** A pull request adds `changelog.d/<section>--<slug>.md`
   and never edits `CHANGELOG.md`, so branches do not conflict over it and an
   update-branch is a fast-forward rather than a conflict to resolve by hand.
   See `changelog-process.md`.
2. **The `code-changed` gate.** A pull request whose whole diff against `main`
   is prose skips the Playwright, native-addon and cross-platform suites and
   runs in about two minutes. That is the whole pull request, not the
   update-branch commit: the filter diffs `origin/$BASE...HEAD`, so any branch
   that has code in it is `code=true` on every push, update-branch commits
   included, and runs the full matrix exactly as it does today. What the train
   saves is the hand-resolved conflict (item 1), not a CI cycle — budget one
   cycle per code pull request. Lint and the jest suite (the `test` job) still
   run even on a prose-only branch:
   prose is an input there — `shortcuts.test.js` and `settings-search.test.js`
   read `docs/features.md`, `renderer-copy.test.js` reads
   `ui-consistency.md`, and two `*.test.js` files live under `docs/` — so a
   docs edit can genuinely break it. `scripts/ci/ci-gate.test.js` keeps that
   job ungated, and keeps `ci-ok` waiting on every job in the workflow.

## Procedure

1. Confirm each pull request is reviewed and its checks are green.
   Steps 2 and 3 need two repository settings that are **off** here as of
   2026-09 — check with `gh api repos/<owner>/<repo>` and read
   `allow_auto_merge` / `allow_update_branch`. Without _Allow auto-merge_,
   `gh pr merge --auto` fails with "auto-merge is not allowed for this
   repository"; without _Allow update branch_, step 3's API call still works
   but the web "Update branch" button does not appear. Ask the maintainer to
   enable them, or merge each pull request by hand in turn.
2. Enable auto-merge on all of them at once:
   `gh pr merge <n> --merge --auto`.
   GitHub then merges each one the moment it is up to date and green, in
   whatever order they become ready — no polling, and no waiting for a human
   between one merge and the next.
3. When a branch falls behind, update it **server-side**:
   `gh pr update-branch <n>`.
   Do not merge `main` in locally unless there is a conflict to resolve: the
   local route needs a push, and a GitHub token without the `workflow` scope
   is refused on any push that touches `.github/workflows/`. Check yours with
   `gh auth status`; if `workflow` is missing, push those branches over SSH
   (`git@github.com:...`) instead. The server-side update has no such limit.
4. If a branch does conflict, resolve it on the branch, push, and let auto-merge
   take it from there. A conflict outside `CHANGELOG.md` is a real one: resolve
   it deliberately, never by preferring one side wholesale.
5. Merge commits, not squash: the history on `main` is `Merge pull request #N`.

## Order

Put the pull request most likely to conflict first, and one that edits
`.github/workflows/` last — a workflow change that has to be re-pushed is the
slowest kind to retry.
