# Merge Process Playbook

Use this playbook when merging one or more approved pull requests into `main`,
and when opening or merging a stack of pull requests that build on each other.

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

## Stacked pull requests

A stack is a chain of pull requests that build on each other: the bottom one
targets the stack's base, usually `main`, and each one above targets the branch
below it. GitHub shows the chain on a stack page and in each layer's merge box.
The first one here is
[#1149](https://github.com/solardev-xyz/freedom-browser/stack/1149): #1147 at
the bottom, #1148 on top (2026-11).

A pull request whose base is not `main` is either a stack layer or an ordinary
pull request into another branch. Ask GitHub which:

```
gh api repos/<owner>/<repo>/pulls/<n> --jq .stack
```

`null` means no stack. Otherwise it gives the stack's `number`, the layer's
`position` (1 is the bottom) and the stack's `size`.

### Merging a stack

Layers merge bottom up. Merging a layer also merges every unmerged layer below
it, in one all-or-nothing operation, and `main` gets the same history as
merging each in turn: one `Merge pull request #N` per layer. The procedure above
changes in five places:

- **`main` merges through a merge queue.** Since 2026-11-19 the ruleset
  "main merge queue" requires one for `main`, with merge commits and `ci-ok`
  required; check with `gh api repos/<owner>/<repo>/rulesets`. The queue runs
  `ci-ok` on the merged result itself (`ci.yml` has a `merge_group:` trigger).
  The one stack merge so far went through it: #1147, the bottom layer of
  #1149, was added to the queue from its own merge box (2026-11-23) and merged
  from there (2026-11-24). Merging a whole stack from the top layer's merge box
  or with `gh stack merge` has not been tried here since the queue was turned
  on, so whether that queues every layer, or merges them past the queue, is
  unknown: watch the first one and record what happens here.
- **Merge from the top layer you want to land.** Use its merge box, or
  `gh stack merge <stack-number> --merge --yes` for the whole stack (a pull
  request number in place of the stack number merges up to that layer). Don't
  use `gh pr merge` on a layer, and don't enable auto-merge on one: GitHub's
  docs say a stack merges only through its asynchronous merge API, and an upper
  layer's base is the branch below it, not `main`. `gh stack merge` comes from
  the `github/gh-stack` extension (`gh extension install github/gh-stack`;
  other extensions share the name). Without `--merge` it uses the method you
  last picked.
- **Each layer meets the stack base's rules.** Every layer is held to the
  protection of the stack's base (`main` here), not its own base's, so each
  needs its own green `ci-ok`. CI runs on every layer, because `ci.yml`'s
  `pull_request` trigger has no branch filter.
- **Rebase the stack instead of updating a branch.** A stack must be linear:
  the bottom layer contains `main`, and each layer contains the tip of the one
  below. `gh pr update-branch` on the bottom layer adds a merge commit the
  layers above lack, and the merge box then asks for a **Rebase stack**. Use
  that button, which rebases every layer on the server, or run
  `gh stack rebase` and then `gh stack push` locally. `gh stack push` pushes
  through the git remote, so a layer that touches `.github/workflows/` needs
  the SSH remote, as in step 3. Either way every layer re-runs CI at the same
  time, so the stack costs one cycle.
- **A stack is one merge in a batch.** Give it the place its most
  conflict-prone layer would have.

After a partial merge, the layers above stay open, and GitHub only retargets
the next one to `main`; it does **not** rebase it. When #1147 merged
(2026-11-24), #1148's timeline got an `automatic_base_change_succeeded` to
`main`, but its branch stayed on #1147's old tip, 330 commits behind `main`,
and conflicting (`mergeable_state` `dirty`). Nothing on the server fixes that,
so bring the next layer up to date yourself straight after a partial merge.
Check with `gh api repos/<owner>/<repo>/pulls/<n> --jq .mergeable_state` and
`gh api repos/<owner>/<repo>/compare/main...<head-sha>`. If **Rebase stack**
is offered and there is no conflict, use it; otherwise rebase the layer's own
commits onto `main` locally, dropping the merged layer's. Note every open
layer's current tip (`git rev-parse origin/<branch>`) before you start, since
each rebase moves the base of the layer above it:

```
git fetch origin && git checkout -B upd origin/<branch>
git rebase --onto origin/main <old-tip-of-merged-layer> upd
git push --force-with-lease=<branch>:origin/<branch> \
  git@github.com:<owner>/<repo>.git HEAD:<branch>
```

In a stack of three or more layers, the layers above the one you just rebased
are still built on its old tip, so the stack is not linear yet. Run `git fetch
origin` (the push above goes to a URL, so it does not move `origin/<branch>`),
then repeat the three commands for each layer above, bottom up: that layer's
own branch, `origin/<branch-below>` (the layer you just rebased) in place of
`origin/main`, and the noted old tip of that layer below in place of
`<old-tip-of-merged-layer>`. Check each with the `compare` call above before
moving on.

If a rebase stops on a conflict, resolve it as in step 4 (deliberately, never
by taking one side wholesale), `git add` the files and `git rebase --continue`.
Run the layer's tests before pushing. `git rebase --abort` puts the branch back
where it was, and nothing reaches GitHub until the push.

Pushing over SSH, as in step 3, is needed when a layer touches
`.github/workflows/` (#1148 does).

The rest of this section comes from GitHub's docs on stacked pull requests,
read 2026-11-10, and from #1147, the first layer merged here (2026-11-24).
Correct it as more stacks merge.

### Opening a stack

When work depends on another open pull request, stack it rather than waiting
for the lower one to merge and rebasing by hand:

1. Commit each layer on its own branch, branched from the layer below.
2. Push the branches and open each pull request with `gh pr create`, an upper
   one with `--base <branch-below>`.
3. In that checkout, `gh stack init --base <trunk> <bottom-branch> ... <top-branch>`
   adopts the branches, and `gh stack submit --auto` then links the open pull
   requests into a stack without opening new ones. This is how #1149 was made.
   `<trunk>` is the bottom pull request's base: `main`, or `release/<version>`
   for a release fix. Always pass it. Without `--base`, `init` assumes `main`,
   and `submit` then moves the bottom pull request onto `main`.

Say in each description which layer it is and what the others do. Each layer
that makes a user-visible change carries its own changelog fragment.
