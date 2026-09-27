# Freedom subagents: inspections, scoped editing and browser tasks

Branch: `experiment/agent-subagents`, started from
`feature/freedom-automation-kernel` on 2026-09-25. Delegation supports up to six concurrent helpers, parent continuation,
and follow-up messages. Scoped editing uses one writer. Browser helpers use fresh or explicitly assigned existing tabs with the existing approval boundary.

## User behavior

The main Agent can call `delegate_task` with a short title, focused task and
selected context. A helper can inspect the conversation's granted project and
attachments, or analyze supplied evidence. It returns a report to the main Agent,
which remains responsible for checking findings and answering the user.
For parallel work, pass `tasks` containing 2–6 independent
`{title, task, context, mode}` assignments instead of the single-task fields. All
slots are reserved before any session starts. Each helper
receives only its own selected context; the parent receives reports in assignment
order after the batch settles. One failure does not discard sibling reports.

Set `background: true` to receive task IDs immediately and let the parent do
independent work. `helper_task` accepts `status`, `wait`, or `message` with one of
those IDs. Status and wait return the latest report; retrieving it prevents a
duplicate automatic delivery. A message is queued after the helper's current
pass, or resumes a completed helper in the same isolated Pi session. Follow-ups
are limited to the same user turn and retain the helper's original capability ceiling.
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
its own expandable card in the conversation.

Each helper has a card above the collapsible action log, with its assignment,
capability, state and current tool activity. Completed cards show a short report
preview; expanding a card reveals its report and recorded browser/file effects.
Cards update in place, preserving keyboard focus and expanded state.

A running card has an individual Stop button for foreground and background
helpers. It cancels only that owned task, withdraws its pending/queued approvals,
and retains recorded effects; the parent and sibling keep running. It does not
undo edits or page actions. Stopped helpers cannot be resumed. The existing
whole-task Stop still cancels all work. Saved cards have no active Stop control.
The preload uses the existing owner-checked Stop IPC with an exact helper ID;
main validates the run and task, then the helper runtime aborts its scoped tools.
Malformed or stale helper IDs never fall back to whole-task cancellation.

The compact gradient card shows the assignment and an expandable report. Reports
use the same restricted, sanitized Markdown renderer as the main response, with
no active HTML or remote images, and are identified as model-generated findings.
The individual Stop control uses the composer’s square icon with an accessible label. A
completed report does not imply a verified task result. Failed, stopped and
limited helpers do not count as successful browser actions. Compact report references and
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

## Browser helpers

Use `mode: "browser"`. For new pages include starting URLs in the task/context;
for existing pages supply `tabIds` containing 1–4 distinct IDs from the parent's
`browser_list_tabs`. Only tabs already controlled by this conversation can be
assigned. The scope validates the entire list and moves ownership synchronously;
a tab owned by a sibling or with an unfinished parent browser action/approval
cannot be handed over. Errors tell the parent to wait or choose available tabs.
Parallel assignments cannot contain overlapping tab IDs. No new approval is
required merely to hand over a tab within the existing task.

A helper can also create at most four fresh tabs per pass. Its page tools only
see its assigned and newly created tabs. Parent and siblings cannot read, navigate, click
or close them while the helper owns them. User release and tab-close events
revoke ownership; approval-mode changes apply to active helpers too.

This is a separate browser capability, not an addition to editing/read-only mode.
Browser helpers receive semantic, screenshot/visual, frame, navigation, interaction,
WebMCP and native-dialog tools plus their own retained browser evidence. They have
no project tools, commands, direct wallet/node capabilities, file transfers,
publication tools or nested delegation. Page-originated wallet requests still
use Freedom's existing exact approval flow. Separate tabs can share website
cookies/account state: the parent must avoid conflicting account operations.

The existing browser scope enforces approval, origin and freshness checks.
Concurrent parent/helper approvals queue one at a time instead of being silently
declined. Cancellation withdraws a helper's pending sheet and prevents queued
requests from appearing later. A guard at the underlying dispatch boundary
rejects actions after cancellation or tab release, including after an approval
or classification await. Existing external approval barriers also apply.

Completed passes return their tabs to the parent. If the parent's active tab is
assigned, its current tab falls back to another available task tab, or becomes
empty until a tab returns. Handoff does not displace another active parent tab.
Stop preserves tabs and earlier effects for review, stops loading, and holds the
reservation until already-started operations and loading cleanup settle. Late
created tabs are registered and handed back too. The parent should list tabs and
read fresh observations before acting. Tabs require newly observed references
both on entry to the helper and on return to the parent. Observations can be
snapshots, frame reads, screenshots/visual targets or website-tool discovery;
reading a page never requires a preceding `browser_get_tab`. Existing original-user-tab
close protection, origin restrictions and declined-action memory survive handoff.
User-released or closed tabs are never reclaimed. Loading cleanup checks current
ownership before dispatch.

Resuming a user turn resets observation freshness separately for each owned tab.
Opening or navigating to an explicit URL remains available, followed directly by
a read. Reading one tab cannot refresh another tab's references. A stale action
returns retryable `OBSERVATION_REQUIRED` with the appropriate observation tool;
a helper-owned tab returns `TAB_BUSY` with wait/use-another-tab guidance. Neither
is a permission refusal. Origin restrictions, action approvals and cancellation
remain enforced. Activity summaries report failed actions without assuming recovery.

A resumed completed helper reacquires its original explicit tab assignment only
if those tabs are still available; otherwise it reports the blocker and disposes
its retained session. Without `tabIds`, each pass starts with an empty scope.
Earlier action references must not be reused. Separate browser sessions remain
outside this slice.

Receipts keep bounded host-recorded action statuses, page titles/origins and assigned/created
tab IDs alongside the model report, including an uncertainty flag for operations
still pending at interruption. They do not persist full page content or screenshots
in helper metadata. Result summaries use these action receipts; a model report
alone is not verified browser evidence. The activity details identify browser
helpers and show their recorded actions as inert text.

## Authority and ownership

`pi-subagent-tools.js` owns the bounded helper lifecycle in main, alongside the
existing Pi session factory and Freedom service. No new IPC channel, external
agent package, dependency or process boundary is introduced. Renderer changes
display existing activity events and persisted receipts, and send owner-checked
individual Stop requests. No process responsibility or top-level boundary changes.

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
  The parent can work concurrently, but up to six helpers may run at a time; no
  detached jobs can outlive a completed parent turn. Files can still change due
  to existing background processes or external editors; reports are not atomic
  project snapshots. The parent can also edit while only read-only helpers run; it must coordinate
  work and verify findings against current file revisions before editing.

## Limits and recovery

At most six helpers run concurrently, in addition to the parent. Batch size, admission and receipt validation share one main-process ceiling; the renderer displays every validated receipt. If a batch does not fit, none of it starts and the error gives occupied/free slots and instructions to wait or submit a smaller batch. Helpers have no separate token, elapsed-time,
model-response, tool-call, generated-text, task-start or follow-up-count budget.
They continue until they finish, fail, or are cancelled by Stop, Pause, steering,
parent completion or disposal. Token counts, tool calls and elapsed time are
retained as receipt metadata, not enforcement thresholds. Ordinary provider and
individual tool constraints still apply, just as they do for the parent.

The Mercury/Venus smoke on 2026-09-26 exposed the old shared 120,000-token cutoff:
both helpers stopped after about 20 seconds, with 81,806 and 47,594 reported tokens.
Repeated input context contributes to this usage. On 2026-09-27 the user directed
removal of helper-specific execution budgets; any future user-facing cost budget
should cover the whole task consistently rather than silently stopping helpers.

Transport bounds remain: combined assignment input is capped at 48,000
characters, each follow-up at 8,000 characters, and pending follow-ups at the
input-size bound. Completed report text is preserved in full; previews and retrieval
pages bound transport rather than permanently truncating findings. Messages wait
until the current pass finishes and do not interrupt an in-flight model response. These bounds do not ration turns or cumulative usage.

Results distinguish running, completed, cancelled, limited admission and failed.
Historical timed-out/limited receipts remain readable.
Errors include a parent-facing next step. Cancellation does not automatically
retry the assignment. Foreground reports are persisted when the call settles;
background reports are persisted individually. Active task labels and running
receipts are saved when delegation starts. After a crash, history preserves
completed sibling reports and labels only unfinished tasks interrupted. No job is replayed
on restart. Full child transcripts and resuming a child after restart are not implemented.

### Saved report retrieval (2026-09-27)

Full helper reports live in `agent_helper_reports` inside the active profile's
`agent-history.sqlite`. Activity JSON carries a report ID and a 600-character
preview. Identical task/report versions are stored once; changed follow-up reports
get immutable IDs, preserving earlier findings. Reports follow conversation
retention and are removed with its history; there is no automatic expiry.

The parent has a `helper_reports` tool: `list` searches titles and report text in
this conversation (20 entries by default, maximum 50, paginated); `read` returns
text using a report ID and Unicode character offset (8,000 characters by default,
maximum 16,000). `nextOffset` retrieves the next page. This works in later turns,
after context compaction and after reopening history without retaining a child
session. Reports remain historical, untrusted model evidence; current files/pages
must be rechecked before acting. Helpers cannot retrieve other helpers' history.

Cards fetch the first page only when expanded, render restricted Markdown, and
provide Show more for subsequent pages. The main process owns persistence and
conversation scoping; the existing trusted chrome preload/IPC boundary serves
bounded report pages. No new persistence system or process responsibility is added.
Legacy inline reports migrate transactionally; an old truncation flag stays visible
because already-lost text cannot be recovered. If report storage fails during a
run, the original inline result is retained rather than silently discarding text.

Smoke: delegate a review, then in a later turn ask “Find the helper's earlier
review using saved reports and quote its final recommendation.” Reopen the chat
and expand the card. A long report should offer Show more and retain its ending.

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
creation, unresponsive providers, late callbacks, read aborts, concurrency
enforcement, atomic batch admission, disjoint contexts, continuation beyond former time/token/tool
ceilings, sibling failures, Stop/Pause/steering,
parent transcript isolation, history normalization and crash interruption.
Renderer coverage checks inert expandable reports; disposable Electron coverage
exercises both layouts and themes, plus real SQLite persistence and interrupted
task recovery. Background coverage adds parent continuation, automatic delivery,
same-session follow-ups with refreshed scoped tool closures, message-size validation,
usage accounting across follow-ups, interruption while waiting, and stale task IDs.
The installed-SDK fixture holds background helpers at a transport barrier until
the parent reaches its own next response, proving parent continuation.
It also verifies two foreground helpers reach the transport concurrently and
complete with reported usage above the former token cutoff. Sequential background
tasks share one owner cleanup listener; Stop disposes all retained sessions.
Budget-removal validation (2026-09-27): 232 tests across the helper, service,
progress and history suites passed, along with `npm run lint`.
Provider scheduling may
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

**User acceptance, 2026-09-27:** the Mercury/Venus/Earth browser comparison passed
after removing helper execution budgets.

Browser smoke:

1. With no project attached, ask: “Start two browser helpers in the background.
   One reads https://en.wikipedia.org/wiki/Mercury_(planet), the other reads
   https://en.wikipedia.org/wiki/Venus. Meanwhile read
   https://en.wikipedia.org/wiki/Earth yourself. Each helper must use its own
   tabs. Compare the three planets with source links.”
2. Confirm independent helper reports and their browser action details. After
   completion, the parent should be able to list and inspect the returned tabs.
3. Try a harmless interaction task in Ask every action. Decline an action;
   it must remain unapplied. Concurrent approval requests should appear in sequence.
4. Repeat a longer browsing assignment and press Stop during a pending approval.
   No late action should run; earlier page effects and tabs remain available to review.
5. Reopen the conversation and check the browser receipts.

Browser ownership, approval queueing and cancellation are covered by targeted
unit tests and a disposable Electron fixture using real pages and Pi browser
tools. The fixture checks parallel helpers alongside a parent read, cross-owner
access denial, approved/declined clicks, tab handoff and Stop during approval.
SQLite persistence and both themes/layouts are also checked. Validation: 454
targeted tests across seven suites, three Electron checks and lint passed.

Helper cards and individual Stop are implemented on 2026-09-27. Validation:
412 tests across eight suites and lint passed. Three disposable Electron checks
cover saved receipts, card rendering in both themes/layouts, and real-page
ownership/approval cancellation. Individual Stop preserves parent operation and
prevents a late-approved click. Focus and expanded cards survive live updates.

Smoke: start two
background browser helpers, stop one using its card, and confirm the sibling and
parent continue. Expand the stopped card to review retained actions, then reopen
the conversation to check its saved status. Repeat Stop while a helper awaits a
browser approval; its action must not execute later.

The user accepted the helper-card UI, including the compact Markdown refinement.
Existing-tab handoff passed the user smoke (2026-09-27).
Saved-report retrieval passed the user smoke (2026-09-27). Remaining acceptance checks: Stop during editing and background editing/reviewer overlap, including reopening the editing receipt; then reassess readiness to merge the experiment.
Broader writer concurrency,
model/role selection, nested delegation, remote execution and optional Jev workers
remain later work. No claim of complete provider/platform qualification.


Existing-tab smoke: on an ordinary website, ask “Delegate reviewing this current
page to a browser helper using the existing tab. Do not open a replacement page.
Summarize its findings.” Confirm it uses the same tab and returns a report; then
ask the parent to inspect that page. Repeat with individual Stop. Page state
should remain, and the parent must observe it again before acting. The controller
owns tab transfer and freshness; the Pi tool only validates assignments and asks
for that scope. No renderer, IPC, provider or process boundary changes are needed.

Validation for existing-tab delegation: 295 targeted tests across four suites,
lint and the disposable Electron browser-helper fixture passed. Coverage includes
exclusive transfer, busy-tab rejection, fresh observations, original-tab close
protection, origin restrictions, retained declines, Stop/release races, closed tabs,
follow-up scope failure cleanup and use of the same existing Electron page.


Validation for saved reports: 424 targeted tests across eight suites, lint, and
two disposable Electron checks passed. Real SQLite tests cover complete long
reports, Unicode pagination, legacy migration, deduplication, follow-up versions,
conversation isolation, reopening and deletion. Tool coverage checks lookup from
a new parent context; card coverage checks lazy loading, additional pages, retries,
and stale responses. Electron verifies persisted history and report rendering in
both themes/layouts. Real-model retrieval passed user acceptance on 2026-09-27.

Startup migration correction: the populated schema-4 upgrade originally used an
active `iterate()` cursor while writing, which Electron's `better-sqlite3` rejects
as a busy connection. The earlier Node SQLite migration test did not catch that
driver-specific constraint. Migration now reads finalized batches of 100 turns
before writing, within the same transaction, and closes a failed connection so
retry cannot skip migration. An Electron regression covers 205 legacy turns,
mid-migration failure, full rollback, retry, report preservation and reopening.
Validation: 10 history tests, lint and three Electron checks passed.

Validation for resumed browsing: 570 targeted unit tests across eight suites, lint,
and the isolated Electron browser-helper regression pass. Coverage includes
per-tab freshness, semantic/frame/visual/page-tool observations, stale references,
failed reads, approvals, ownership, Stop, and opening/reading a new page on the
next user turn after delegation. Manual smoke: open a random Wikipedia article,
delegate its summary, then ask to open and summarize another random article;
reading the second page should not require another user message.

Result presentation (2026-09-27): routine browser/project/source inspection and
helper-count summaries no longer render a result card. Individual helper cards,
expandable activity and internal verification receipts remain. Downloads and
publications retain their actionable artifact cards; transaction receipts,
connection failures and unresolved effects remain visible. Interrupted editing
helpers surface a short partial-changes notice, and uncertain browser actions
surface a notice until a fresh observation of the same page. A normal new-tab
operation does not warn merely because it was not followed by a second read.


Delegation guidance (2026-09-27): the main Agent autonomously organizes substantial tasks, uses delegation as a
normal workflow without asking users to request helpers, delegates clear independent assignments,
and owns verification, integration and completion. Simple requests stay direct.
The active supported provider selects scheduling guidance: hosted connections
default to useful parallel work for independent workstreams; Ollama prefers direct work or a single foreground
helper for focused context/review. This is a heuristic, not a hardware benchmark
or concurrency restriction. Explicit requests for helpers, including parallel
ones on Ollama, remain supported. No provider switching, new settings or capability
grants are introduced. The six-helper ceiling and one-writer rule remain. Child prompts
stay role-specific and cannot delegate. The guidance is built with the parent
session, including a reconstructed session after reopening history.

Acceptance prompts for orchestration: on a hosted connection, ask for a comparison
of several independently researched topics without mentioning helpers; check that
delegation is useful and findings are reviewed. On Ollama, try a small task and a
focused project review; direct/sequential work should be preferred. Then explicitly
request two parallel helpers on Ollama to check the preference is overridable.
These are judgment/performance smokes; deterministic tests establish instruction
wiring and preserved tool availability, not real-model delegation quality or speed.


Larger orchestration batches (2026-09-27): the Wikipedia smoke delegated only
one article while the parent read two. The previous runtime ceiling, batch schema,
receipt normalization and UI truncation all assumed two helpers. Batches now
support 2–6 assignments, with up to six active helpers plus the parent. Three
independent articles can each have their own browser helper in one call. Hosted
model guidance makes this decomposition explicit and keeps source review and
synthesis with the parent; larger tasks use later batches as capacity frees.
Simple/tightly coupled tasks still stay direct and Ollama scheduling remains
preferentially direct/sequential. No quota on total helpers, turns or tokens is
introduced. One writer, exclusive tab ownership, normal approvals and Stop remain.

The main process owns admission and receipt validation in the existing delegation
modules; the renderer consumes the complete trusted batch instead of maintaining
its own two-card limit. No new IPC or process responsibility is introduced.
Validation covers three/six foreground and background helpers, atomic admission,
slot reuse, context separation, individual/parent Stop and late results. Installed
Pi sessions exercise three and six concurrent transports without an external
provider. Electron checks three real browser helpers, six-receipt SQLite crash
recovery, and all six cards in both themes/layouts. The next real-model smoke is
simply “Open three random Wikipedia articles and summarize them for me,” without
any instruction to delegate.
