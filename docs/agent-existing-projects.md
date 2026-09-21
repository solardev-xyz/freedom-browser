# Existing projects in Freedom Agent

Experimental branch: `experiment/agent-existing-projects`, based on `69a7643c`.
This feature is unreleased and has not been merged into the Agent feature branch.

## Using a project

1. In the composer’s Add menu, choose **Open project…** and select a folder.
   Freedom starts a separate conversation with read-only access to that folder.
2. Ask Agent to explain or inspect the project. Existing file tools address the
   selected folder using relative paths.
3. In Workspace, click the project row and choose **Allow editing** when you want
   changes. Edits affect the original files. Commands also require editing
   access; installed executables and networking retain their separate permits.
   Alternatively, after a read-only error Agent can call `request_permissions`
   with `project: "write"` to show an **Allow editing** approval sheet. Approval
   applies to this conversation's attached folder until revoked or Freedom
   restarts. Agent then re-reads/reviews before retrying; declining leaves the
   project read-only. See [tool recovery](agent-tool-errors.md).
4. Review **Changes** and open read-only file/diff tabs. For Git projects this
   includes changes that predate the conversation. “Agent edited” identifies
   direct file writes recorded by this chat, not exclusive authorship of all
   current content. Shell commands can change additional files.
5. For a non-Git folder, **Recorded edits** lists direct edits recorded by this
   conversation. It is not a complete dirty-file inventory or a Git diff.
6. After restarting Freedom, click **Reconnect** and choose the original folder.
   Reconnection starts read-only. A moved folder can reconnect if its filesystem
   identity is preserved; a replacement/copy opens as a new project.

**Read only** and **Remove access** stop new writes or new access, respectively,
and request cancellation of the conversation’s commands. Previously launched
processes may retain their original permissions until they exit. Stop an active
Agent turn before changing access. Deleting a conversation never deletes its
external project.

Existing **Attach files…** and **Add folder…** remain available for reference
material. The first release supports one primary project folder per conversation;
it does not add an editor or individual writable-file grants.

## Authority and storage

- Main process owns the native folder selection, canonical path, device/inode
  identity, and live read/write grant. Renderer/model paths cannot grant access.
- SQLite remembers the association and direct-edit paths in profile storage.
  A remembered association does not restore a live grant after restart.
- Application/profile storage, broad home/system roots, and known credential
  directories cannot be selected as project roots. This is not a secret scanner:
  files inside the selected project can be sent to the configured model when read.
- Overlapping grants involving a writer are refused within this profile’s live
  store. Other profiles, editors, and host processes are not covered by this lock.
- A fresh execution policy is constructed for each external-project operation.
  Folder identity is checked again, symlink traversal is refused by direct file
  tools, and hardlink validation remains enforced. The fixed file helper has a
  writable OS policy; read-only access is enforced by trusted operation gates.
- Direct reads issue internal version fingerprints including file identity,
  mode, timestamps, and bytes. Existing-file writes require a matching version;
  new-file writes use exclusive creation. Arbitrary approved shell commands do
  not provide this optimistic-write protection. These checks are not an atomic
  compare-and-swap against a concurrently malicious same-user host process.
- Existing repositories are the source of truth: Commits reads their real Git
  history and `workspace_history` with `action: commit` writes selected reviewed
  revisions to the current branch. File-edit permission enables this capability;
  the agent commits only when requested or authorized by the task/repository
  instructions. Unrelated edits and staging remain intact. Different staged
  revisions in a selected file must be resolved first.
- New external projects allocate no private Git repository. Plain folders stay
  plain: Git initialization requires an explicit choice in the user's Git client.
  Previously created experimental checkpoint archives are retained under profile
  storage, receive no new writes, and are not displayed as repository commits.
- Managed workspaces retain their own existing Git history and reviewed restore
  mechanism, now described as commits in the UI. Agent proactively saves reviewed
  milestones after meaningful changes (unless the user declines history), without
  a separate commit request. It does not snapshot every write or save generated
  output. History status explicitly distinguishes managed and external workspaces. External commits are view-only
  in that UI; it cannot restore, reset, switch branches, merge, rebase or push.
- The main-owned Git service runs fixed, bounded commands with a constructed
  environment and disabled execution/network features. Ordinary shell commands
  still cannot write `.git`. It requires normal SHA-1 Git directories and refuses
  unsafe metadata, linked worktrees, active hooks, signing requirements, content
  conversion, global ignore rules, includes, advanced indexes and partial/shallow repositories rather
  than bypassing their requirements. Local/global Git identity is read without
  changing configuration. Review limits still apply: 200 files, 64 KiB per file,
  512 KiB total. Unsupported repositories remain editable; commit with a Git
  client when the tool explains a limitation.
- Commit preparation uses exact reviewed bytes, a separate temporary index for
  the commit tree and another preserving unrelated staging. It locks the real
  index, rechecks file/grant/HEAD/index state and performs a branch CAS using
  Git’s own ref locks. HEAD is checked again before reporting success. Direct
  concurrent ref edits by another host process can still require recovery.
  Branch and index updates are not one atomic filesystem transaction. An uncertain
  update retains `git-commit-pending.json`, its temporary indexes and an owned lock
  under/alongside the affected repository. Further commits refuse until inspected;
  there is no automatic retry or rollback. Recovery details are below.
- Previews validate current project access. Removing access blocks new static,
  server, and preview-socket requests; it does not erase already rendered content.

## Qualification and limits

Initial target is macOS. Ordinary repositories and non-Git folders are supported
by the macOS policy; non-Git Linux projects currently fail closed because no
safe missing-metadata mount has been qualified. Windows workspace execution
retains its existing unavailable behavior. Linked Git worktrees, external gitdir
authorization, and cross-platform release qualification remain follow-up work.

`scripts/qualify-agent-existing-projects.js` exercises the production controller,
store, sandbox, repository commits, and previews using synthetic external folders. Run
it with the matching Electron binary in Node mode on the designated disposable
testing machine, with an independent watchdog and external canary. It never uses
a real user project. The bounded server has its own exit deadline. Hostile
detached-process and application-exit experiments are separate qualifications.

The September 19 Mac mini project-access v3 snapshot passed 11 production checkpoints, 292 focused
unit tests across nine suites, lint, and the native picker/access/reconnect UI
flow in both layouts and themes. The preceding v2 pass covered 332 tests across
13 suites. Six absent-`.git` creation-denial probes and four selected Seatbelt
integration tests passed on the unchanged OS boundary. Runtime: macOS 15.6 arm64,
Electron 44.3.0 / Chromium 152.0.7977.78. No watchdog fired, external canaries
remained intact, and the final process check found no disposable app/server
processes. Exact manifests and logs are preserved in the Mac mini evidence
directory recorded in the roadmap. Only documentation changed after that
September 19 v3 pass, before the separate September 20 Git revision below.

The user successfully smoke-tested reading and editing an external README with a configured model. That test exposed the separate-history mismatch; the repository-commit revision requires a fresh smoke test. These results do
not establish full descendant termination, aggregate resource limits, or absence
of same-user filesystem races. The UI screenshots demonstrate access controls;
background Changes/Checkpoints rows can still be loading when a screenshot is
captured.

## Interrupted commit recovery

A failed operation before the branch update cleans up only its own temporary
files and locks. Once a ref update is attempted, an uncertain response preserves
recovery evidence in `<profile>/agent-workspaces/<workspace-id>/git-commit-pending.json`
and its referenced temporary directory. The record contains the original branch,
HEAD/index fingerprint, candidate commit and prepared index fingerprint. The
project's `index.lock` may contain the prepared index; never blindly delete it or
retry the commit. Inspect actual HEAD, log, status, index and candidate tree in a
Git client. Repair staging deliberately without overwriting newer user changes.
Only after reconciliation should the user archive the recovery record and remove
confirmed stale owned locks. This experimental version has no automatic repair
UI. Deleting its conversation waits for its active history operation to settle and
preserves private pending recovery evidence at the original path. It removes the
conversation association and access grant, not that unresolved recovery record. Existing same-user filesystem races remain a
limitation; this is not isolation from a malicious host process.

The September 20 Git v3 revision passed 265 tests across 11 suites, all 11
production checks, lint, and nine supplemental regression probes on the Mac mini.
These cover actual commits, preserved unrelated staging, unusual filenames,
configuration refusals, changed metadata/locks, branch changes and uncertain
commit recovery across conversation deletion. The successful Git v2 native UI
run is reused: renderer, preload, shared IPC and E2E sources are byte-identical;
this was not a new v3 UI run. No watchdog or canary failed, and no disposable
app/server remained. Exact source manifests and results are preserved under
`/private/tmp/freedom-external-git-test-20260920/evidence/` on the Mac mini.
Only documentation changed after this Git v3 qualification. The earlier
September 19 results do not certify the new Git writer.

For a user smoke test, open a disposable normal Git repository, allow editing,
ask for a small edit, then ask “commit this.” Confirm the returned hash with
`git log -1` in that repository and inspect `git status`. Include an unrelated
staged file to confirm it remains staged rather than entering the Agent commit.
The Commits popover should show the same new commit and the repository’s earlier
history. A plain folder should stay without `.git` after reading/editing.

The follow-up user smoke test exposed a reporting defect: committing while the
project was read-only produced a generic Git failure and a misleading browser
error. History tools now preserve actionable project-access errors for both the
model and activity UI. Reconnection still starts read-only; choose **Allow
editing** before requesting a commit. The attached-project prompt now agrees
with repository-native history. This reporting-only follow-up passed 255 focused
tests across four suites and lint; it did not change Git mutation or access rules.
The subsequent approval-sheet flow adds an in-turn request for the same editing
grant. The main process validates the exact grant again after the user decides.
