# Freedom subagents: inspections, follow-ups and scoped editing

Branch: `experiment/agent-subagents`, started from
`feature/freedom-automation-kernel` on 2026-09-25. Read-only delegation supports two concurrent helpers, parent continuation,
and follow-up messages. Scoped editing is implemented with one writer; browser ownership remains a later slice.

## User behavior

The main Agent can call `delegate_task` with a short title, focused task and
selected context. A helper can inspect the conversation's granted project and
attachments, or analyze supplied evidence. It returns a report to the main Agent,
which remains responsible for checking findings and answering the user.
For parallel inspection, pass `tasks` containing exactly two independent
`{title, task, context}` assignments instead of the single-task fields. Both
slots and task allowances are reserved before either session starts. Each helper
receives only its own selected context; the parent receives reports in assignment
order after both settle. One failure does not discard the other helper's report.

Set `background: true` to receive task IDs immediately and let the parent do
independent work. `helper_task` accepts `status`, `wait`, or `message` with one of
those IDs. Status and wait return the latest report; retrieving it prevents a
duplicate automatic delivery. A message is queued after the helper's current
pass, or resumes a completed helper in the same isolated Pi session. Follow-ups
are limited to the same user turn and retain the helper's read-only ceiling.
Stopped, failed or expired helpers cannot be resumed.

Reports appear in activity and are persisted as each background helper finishes,
even while its sibling or the parent is working. Freedom automatically delivers
unread reports through Pi custom messages between parent passes, clearly marked
as untrusted evidence, and keeps the user turn alive while helpers remain. The
parent can use `wait` to receive a report sooner. Completed sessions are retained
only until the parent turn ends; they are not durable background jobs.

Successful reports and intentional stops use a neutral summary, such as
“1 report received · 1 task stopped.” Failed, timed-out or limited helpers are
counted as incomplete and retain a caution indicator. Each parallel report has
its own expandable entry in the activity list.

The activity list shows the assignment and an expandable report. Reports are
plain, inert text and explicitly identified as model-generated findings. A
completed report does not imply a verified task result. Failed, stopped and
limited helpers do not count as successful browser actions. Bounded reports and
metadata are retained in the conversation's existing profile-local history.

The helper uses the parent's current model connection and thinking setting.
There is no additional provider setup. Delegation consumes additional model
usage; simple tasks should stay with the parent.

## Scoped editing

Use `mode: "edit"` with `files: ["README.md", "src/example.js"]` for a bounded
implementation. File lists contain 1–20 exact project-relative paths, not globs
or directory grants. Read-only remains the default. An editing helper can use
`read`, `grep`, `find`, `ls`, attachment tools, `write` and `edit`; it cannot use
shell commands, browser tools, history operations, approvals or nested delegation.
The parent handles testing, review and checkpoints/commits after the helper finishes.

Freedom reserves one writer in the workspace controller before creating its
session. Existing project commands, edits and history operations must settle
first. While reserved, competing writes, commands and history operations are
rejected with recovery guidance; ordinary reads remain available. One writer can
run alongside a read-only helper, including in the background. Follow-ups retain
the original file list and acquire fresh ownership when resuming a completed helper.
This first implementation reserves writing across the controller, rather than
allowing simultaneous writers in different projects.

The project must already be enabled and, for external projects, have an active
editing grant. A read-only grant is never upgraded by delegation: the failure tells
the parent to request editing permission and then create a new assignment.
File scope and live grants are checked on every delegated file operation.
Existing files require the helper's own read revision; another reader cannot
refresh its write authority. Both managed and external files reject stale revisions.
Parent directories of assigned new files may be created. Unrelated paths and Git
metadata cannot be written. External editors/processes can still change files;
this is coordination between Freedom agents, not a lock on other applications.

Stop aborts tools and releases model ownership promptly, while the writer reservation
remains until already-started file operations settle. Partial edits are not rolled
back. Receipts persist completed and attempted file paths and indicate pending
operations; the activity view shows recorded changes separately from the model's
report. The parent must inspect current files before retrying, testing or committing.

## Authority and ownership

`pi-subagent-tools.js` owns the bounded helper lifecycle in main, alongside the
existing Pi session factory and Freedom service. No new IPC surface, external
agent package, dependency or process boundary is introduced. Renderer changes
only display the existing activity events and persisted receipts.

- Each helper is a fresh `createIsolatedPiSession`: no ambient extensions,
  external skills, project instruction discovery, host working directory or
  parent assistant/tool transcript. The main service supplies previous user
  requests and non-cancelled guidance to preserve constraints, plus the selected
  assignment/context. Oversized instructions fail closed instead of silently
  dropping constraints.
- Read-only tool access is an explicit allowlist: Freedom's scoped `read`, `grep`, `find`,
  `ls`, attachment reads/listing/PDF rendering, and `workspace_history` **status
  and diff only**. The history schema is narrowed and actions are checked again
  at execution. These are the existing controller-backed tools, never Pi's raw
  host filesystem tools. Child calls have namespaced IDs and separate callbacks.
- Read-only helpers have no shell, writes, history mutations/review-token issuance, browser control,
  approval requests, workspace creation, wallet/node operations or nested
  delegation. Missing access is a blocker for the parent to handle.
- Each invocation captures its owning run and abort generation. Stop, Pause,
  steering, run completion and service disposal cancel the helper. A session
  constructed after cancellation is disposed without being prompted. Late
  messages and reads cannot become a new turn's result.
- Cancellation requests Pi/provider abort and aborts pending read signals;
  it cannot guarantee a remote provider stopped billing immediately. Cleanup
  does not wait indefinitely on an unresponsive provider. A separate context is
  **not** a separate process sandbox.
- Foreground calls wait for all results; background calls return immediately.
  The parent can work concurrently, but up to two helpers may run at a time; no
  detached jobs can outlive a completed parent turn. Files can still change due
  to existing background processes or external editors; reports are not atomic
  project snapshots. The parent can also edit while only read-only helpers run; it must coordinate
  work and verify findings against current file revisions before editing.

## Limits and recovery

Defaults are four helper starts per user turn (resuming a completed helper counts
as another start), two active helpers, 24 tool calls and
12 assistant responses per helper, and a shared ceiling of 48 tool calls per
turn. Time limits are three minutes per helper and six minutes of cumulative
helper time per turn. Simultaneous helpers both consume that time allowance;
active timers rebalance as helpers finish. A shared tool/time/token limit cancels
all still-active helpers; completed reports remain available. Input is capped at 48,000 characters,
streamed text at 32,000 characters, and retained report text at 12,000 characters
with explicit truncation metadata. Reported token usage has a cumulative
120,000-token stop threshold across helpers in the turn. Usage is checked at
message boundaries when available; this is not a guaranteed monetary cap or a
preflight reservation for a provider response. Parent usage is separate.
Per-helper counters and active time accumulate across follow-ups; shared budgets
never reset when a helper resumes. There are at most eight follow-up messages per
user turn, each bounded to 8,000 characters. Idle retained sessions consume no
active time allowance. Messages wait until the current helper pass finishes;
they do not interrupt an in-flight model response.

Results distinguish running, completed, cancelled, timed out, limited and failed.
Errors include a parent-facing next step. Cancellation does not automatically
retry the assignment. Foreground reports are persisted when the call settles;
background reports are persisted individually. Active task labels and running
receipts are saved when delegation starts. After a crash, history preserves
completed sibling reports and labels only unfinished tasks interrupted. No job is replayed
on restart. Full child transcripts, resuming a child after restart and retrieval
of old child reports through a dedicated model tool are not implemented.

## Upstream inspiration

These sources were read, not installed. This delivery uses our existing Pi
factory and controller-backed tools; it copies no upstream implementation.

| Source, pinned revision | Pattern used / decision |
| --- | --- |
| [Nico Bailon's pi-subagents](https://github.com/nicobailon/pi-subagents/tree/2e9c51bada2da6a9ba73b6973e1545a9afa0d057), MIT | Foreground in-process child sessions, explicit capability ceilings, bounded context/results, terminal ownership and cancellation races. Translate the concepts into Freedom's per-conversation controllers rather than adopting terminal configuration/resource discovery. |
| [pi-subagents-j0k3r](https://github.com/j0k3r-dev-rgl/pi-subagents-j0k3r/tree/66f562ef7e15bc3fc1f9136d1b31faf4c20fb214), MIT | Independent SDK sessions and explicit lifecycle/results. Freedom's existing history stores the visible projection; no second persistence system. |
| [pi-herdsman](https://github.com/boadij/pi-herdsman/tree/7faf5a311fc20b49ac8a45cb83f73f40db1061ce), Apache-2.0 | Parent ownership and attributable results; future logical ownership should stay independent of physical placement. Herdr/remote placement is deferred. |

## Validation and smoke test

Automated coverage includes real installed Pi parent/child execution against a
deterministic in-memory provider transport, trusted-tool isolation, history
action restrictions, same model/runtime, cancellation before/during session
creation, unresponsive providers, late callbacks, read aborts, two-helper
enforcement, atomic batch admission, disjoint contexts, shared live time/token/tool
budgets, sibling failures, Stop/Pause/steering,
parent transcript isolation, history normalization and crash interruption.
Renderer coverage checks inert expandable reports; disposable Electron coverage
exercises both layouts and themes, plus real SQLite persistence and interrupted
task recovery. Background coverage adds parent continuation, automatic delivery,
same-session follow-ups with refreshed scoped tool closures, message limits,
shared budget preservation, interruption while waiting, and stale task IDs.
The installed-SDK fixture holds background helpers at a transport barrier until
the parent reaches its own next response, proving parent continuation.
It also verifies two foreground helpers reach the transport concurrently. Provider scheduling may
still serialize requests, especially for local models.

Validation for this slice: 355 targeted tests across seven suites, both affected
Electron checks, and lint passed. These deterministic checks do not establish a
real model's delegation judgment or report quality.

**User acceptance, 2026-09-25:** single-helper project review, steering to a new
assignment, standalone Stop and two parallel read-only helpers all passed manual
smoke tests. Background continuation and same-session messaging passed user smoke tests on 2026-09-26, including the running Freedom checkout after the external-project fixes.

Manual smoke:

1. Attach a project and ask: “Start two read-only helpers in the background:
   one reviews structure, one reviews accessibility. While they work, inspect the
   README yourself. Combine the findings without changing files.”
2. Ask within the same task: “Start a background helper to review this project.
   After its report, send that helper a follow-up asking it to support its most
   important finding with file references. Summarize the revised report.”
3. Confirm reports update separately, expanded reports stay open when a sibling
   finishes, and the parent combines findings. Reopen the chat to check history.
4. Repeat a long background task with Stop, Pause and steering, including while
   the parent says it is waiting for reports. Old helpers should stop; steering
   should continue with the new request rather than end the turn or replay work.
5. With no project attached, request inspection: the helper reports the access
   blocker and cannot create a replacement project or grant itself access.

Editing smoke (new slice):

1. In an enabled managed workspace, ask: “Delegate improving README.md to a helper.
   Let it edit only README.md. Review the result and save a checkpoint.”
2. On an external read-only project, request the same change. The parent should
   request editing permission, then delegate; no helper can approve itself.
3. Ask for a background editing helper and a read-only reviewer. The parent can
   inspect other files; competing commands/edits must wait for the writer.
4. Stop an editing task partway through. Inspect the recorded changed/attempted
   paths and actual files; no automatic rollback or replay should be claimed.
5. Reopen the chat and confirm the editing receipt and file paths remain visible.

Validation: 451 targeted tests across eight suites, four Electron checks and lint passed. Scoped tools were exercised through installed Pi file tools and real
macOS sandbox execution on disposable managed and external projects, including
permission denial, explicit path bounds, competing-parent denial and stale-write
protection. UI receipts are checked in both themes/layouts. Unit coverage includes
ownership through unsettled operations, cancellation, late setup and read-only
regressions.

**User acceptance, 2026-09-26:** the fresh-workspace personal-website prompt
(create assigned files, parent review/preview and checkpoint) and the external
read-only project's editing-permission flow both passed user smoke tests.
Manual background-edit/reviewer overlap, Stop during editing and reopening the
editing receipt remain separate checks; these are not implied by those two passes.

Next development slice: define browser tab ownership for browser-capable helpers. Broader writer
concurrency, model/role selection, nested delegation, remote execution and optional
Jev workers remain later work. No claim of complete provider/platform qualification.
