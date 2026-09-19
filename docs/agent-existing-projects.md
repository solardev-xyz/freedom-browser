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
- Freedom’s reviewed checkpoints use private managed metadata under profile
  storage. The selected project’s Git index, configuration, refs, and objects are
  not used for Freedom checkpoint writes. Existing review, exclusion, size,
  backup, and partial-restore limitations still apply.
- Supported Git inspection uses bounded fixed commands with hooks, external
  diffs, text conversion, and optional locks disabled. Unsafe/external Git layouts
  fail closed. Git commits, branches, remotes, and pushes remain outside this UI.
- Previews validate current project access. Removing access blocks new static,
  server, and preview-socket requests; it does not erase already rendered content.

## Qualification and limits

Initial target is macOS. Ordinary repositories and non-Git folders are supported
by the macOS policy; non-Git Linux projects currently fail closed because no
safe missing-metadata mount has been qualified. Windows workspace execution
retains its existing unavailable behavior. Linked Git worktrees, external gitdir
authorization, and cross-platform release qualification remain follow-up work.

`scripts/qualify-agent-existing-projects.js` exercises the production controller,
store, sandbox, checkpoints, and previews using synthetic external folders. Run
it with the matching Electron binary in Node mode on the designated disposable
testing machine, with an independent watchdog and external canary. It never uses
a real user project. The bounded server has its own exit deadline. Hostile
detached-process and application-exit experiments are separate qualifications.

The Mac mini’s final v3 snapshot passed 11 production checkpoints, 292 focused
unit tests across nine suites, lint, and the native picker/access/reconnect UI
flow in both layouts and themes. The preceding v2 pass covered 332 tests across
13 suites. Six absent-`.git` creation-denial probes and four selected Seatbelt
integration tests passed on the unchanged OS boundary. Runtime: macOS 15.6 arm64,
Electron 44.3.0 / Chromium 152.0.7977.78. No watchdog fired, external canaries
remained intact, and the final process check found no disposable app/server
processes. Exact manifests and logs are preserved in the Mac mini evidence
directory recorded in the roadmap. Only documentation changed after v3 testing.

User smoke testing with a configured model is still pending. These results do
not establish full descendant termination, aggregate resource limits, or absence
of same-user filesystem races. The UI screenshots demonstrate access controls;
background Changes/Checkpoints rows can still be loading when a screenshot is
captured.
