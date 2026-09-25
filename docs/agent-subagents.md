# Freedom subagents: bounded parallel inspections

Branch: `experiment/agent-subagents`, started from
`feature/freedom-automation-kernel` on 2026-09-25. Foreground read-only delegation now supports two concurrent helpers. Parent
continuation, messaging and delegated changes remain later slices.

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
- Tool access is an explicit allowlist: Freedom's scoped `read`, `grep`, `find`,
  `ls`, attachment reads/listing/PDF rendering, and `workspace_history` **status
  and diff only**. The history schema is narrowed and actions are checked again
  at execution. These are the existing controller-backed tools, never Pi's raw
  host filesystem tools. Child calls have namespaced IDs and separate callbacks.
- No shell, writes, history mutations/review-token issuance, browser control,
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
- The parent waits for the tool result. Up to two helpers may run at a time; no
  detached jobs can outlive a completed parent turn. Files can still change due
  to existing background processes or external editors; reports are not atomic
  project snapshots.

## Limits and recovery

Defaults are four helpers per user turn, two active helpers, 24 tool calls and
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

Results distinguish completed, cancelled, timed out, limited and failed.
Errors include a parent-facing next step. Cancellation does not automatically
retry the assignment. Reports are delivered and persisted when the whole call
settles; an application crash before that can lose an already-finished sibling
report. Active task labels are saved when delegation starts;
after a crash, history labels unfinished tasks interrupted. No job is replayed
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
task recovery. The initial delivery passed 387 targeted tests; the parallel
update passed 311 tests across six affected suites, both affected Electron checks,
and lint. The installed-SDK fixture
holds each helper at a barrier until both have reached the model transport,
so it verifies concurrency as well as final results. Provider scheduling may
still serialize requests, especially for local models.

**User acceptance, 2026-09-25:** single-helper project review, steering to a new
assignment and standalone Stop all passed manual smoke tests. Parallel behavior
still needs real-model smoke acceptance.

Manual smoke:

1. Attach an existing project with read access and a connected model. Ask:
   “Use two helpers in parallel: one reviews this project's structure, the other
   reviews accessibility. Combine their findings. Do not change files.”
2. Confirm both helper reports appear separately and the parent combines them. Reopen the conversation and check the report is retained.
3. Start a longer review, then Stop. Repeat with a steering instruction changing
   the task. Both old helpers should stop and cannot append late successes. A report that
   finished before Stop should be retained.
4. With no project attached, request a project review: the helper must report the
   access blocker; it must not create a replacement project or grant itself access.

Next: smoke-test parallel assignments with real models, then add parent
continuation/messaging; then define browser tab ownership
and delegated editing with one writer before broader concurrency. Model/role
selection, nested delegation, remote execution and optional Jev workers remain
later work.
