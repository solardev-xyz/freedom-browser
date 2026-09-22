# Merge Process Playbook

Use this playbook when merging one or more approved pull requests into `main`.

## What makes merging slow here

`main` requires branches to be up to date before they merge, and CI is a full
matrix — 41 jobs at 10-14 minutes when this was measured, 2026-09; read
`.github/workflows/ci.yml` for what it runs today. So merging a batch is a
train: the first merge puts every other branch behind, and each one then needs
an update and a full re-run before its turn. Four pull requests cost four CI
cycles.

What keeps that train short is **changelog fragments**:

A pull request adds `changelog.d/<section>--<slug>.md`
and never edits `CHANGELOG.md`, so branches do not conflict over it and an
update-branch is a fast-forward rather than a conflict to resolve by hand.
See `changelog-process.md`.

## Procedure

1. Confirm each pull request is reviewed and its checks are green.
   Step 2 needs _Allow auto-merge_, which is **off** here as of 2026-09 —
   check with `gh api repos/<owner>/<repo> --jq .allow_auto_merge`. Without it
   `gh pr merge --auto` fails with "auto-merge is not allowed for this
   repository"; ask the maintainer to enable it, or merge each pull request by
   hand in turn. Step 3 needs nothing: `allow_update_branch` is off too, but it
   only governs branches that are _not_ required to be up to date, and `main`'s
   protection sets `required_status_checks.strict` — check it with
   `gh api repos/<owner>/<repo>/branches/main/protection` — so both
   `gh pr update-branch` and the web "Update branch" button work regardless.
2. Enable auto-merge on all of them at once:
   `gh pr merge <n> --merge --auto`.
   GitHub then merges each one the moment it is up to date and green, in
   whatever order they become ready — no polling, and no waiting for a human
   between one merge and the next.
3. When a branch falls behind, update it **server-side** first:
   `gh pr update-branch <n>`.
   It works for most branches, but **not** for one whose diff touches
   `.github/workflows/`. The server builds a merge commit, and a token without
   the `workflow` scope is refused for that commit exactly as it is for a
   push — verified on #400 (2026-09-22):

   ```
   GraphQL: refusing to allow an OAuth App to create or update workflow
   `.github/workflows/ci.yml` without `workflow` scope (updatePullRequestBranch)
   ```

   Check your token with `gh auth status`. If `workflow` is missing, a branch
   that touches a workflow file has to be merged with `main` locally and pushed
   over SSH (`git@github.com:...`), which is not subject to the OAuth rule:

   ```
   git fetch origin && git checkout -B upd origin/<branch>
   git merge origin/main -m "Merge branch 'main' into <branch>"
   git push git@github.com:<owner>/<repo>.git HEAD:<branch>
   ```

   Everything else takes the server-side route: no local checkout, no push.
4. If a branch does conflict, resolve it on the branch, push, and let auto-merge
   take it from there. A conflict outside `CHANGELOG.md` is a real one: resolve
   it deliberately, never by preferring one side wholesale.
5. Merge commits, not squash: the history on `main` is `Merge pull request #N`.

## Order

Put the pull request most likely to conflict first, and one that edits
`.github/workflows/` last — a workflow change that has to be re-pushed is the
slowest kind to retry.
