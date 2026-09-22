# Merge Process Playbook

Use this playbook when merging one or more approved pull requests into `main`.

## What makes merging slow here

`main` requires branches to be up to date before they merge, and CI is 41 jobs
at 10-14 minutes. So merging a batch is a train: the first merge puts every
other branch behind, and each one then needs an update and a full re-run before
its turn. Four pull requests cost four CI cycles.

Two things keep that train short:

1. **Changelog fragments.** A pull request adds `changelog.d/<section>--<slug>.md`
   and never edits `CHANGELOG.md`, so branches do not conflict over it and an
   update-branch is a fast-forward rather than a conflict to resolve by hand.
   See `changelog-process.md`.
2. **The `code-changed` gate.** A pull request that touches only prose skips the
   Playwright, native-addon and cross-platform suites, so the update-branch
   commit that a train forces onto the next branch costs about two minutes
   instead of a full run. Lint and the jest suite (the `test` job) still run:
   prose is an input there — `shortcuts.test.js` and `settings-search.test.js`
   read `docs/features.md`, `renderer-copy.test.js` reads
   `ui-consistency.md`, and two `*.test.js` files live under `docs/` — so a
   docs edit can genuinely break it. `scripts/ci/ci-gate.test.js` keeps that
   job ungated, and keeps `ci-ok` waiting on every job in the workflow.

## Procedure

1. Confirm each pull request is reviewed and its checks are green.
2. Enable auto-merge on all of them at once:
   `gh pr merge <n> --merge --auto`.
   GitHub then merges each one the moment it is up to date and green, in
   whatever order they become ready — no polling, and no waiting for a human
   between one merge and the next.
3. When a branch falls behind, update it **server-side**:
   `gh pr update-branch <n>`.
   Do not merge `main` in locally unless there is a conflict to resolve: the
   local route needs a push, and the `gh` token on this machine carries only
   `gist, read:org, repo`. A push that touches `.github/workflows/` is refused
   without the `workflow` scope, so those branches must be pushed over SSH
   (`git@github.com:...`). The server-side update has no such limit.
4. If a branch does conflict, resolve it on the branch, push, and let auto-merge
   take it from there. A conflict outside `CHANGELOG.md` is a real one: resolve
   it deliberately, never by preferring one side wholesale.
5. Merge commits, not squash: the history on `main` is `Merge pull request #N`.

## Order

Put the pull request most likely to conflict first, and one that edits
`.github/workflows/` last — a workflow change that has to be re-pushed is the
slowest kind to retry.
