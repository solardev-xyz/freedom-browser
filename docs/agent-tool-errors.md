# Agent tool errors and recovery

Freedom's model-facing tools report errors with a stable code, an explanation,
and main-owned recovery guidance. `tool-error-recovery.js` wraps browser,
workspace and attachment tools, and the final Pi session tool list also wraps
future tools and built-in skill reads. Wrapping is idempotent and preserves
trusted built-in overrides, arguments, signals, successful results and error
codes. It never retries or executes the proposed recovery itself.

The error carries a `recovery` object with `action`, `instruction`, and optional
`tool`/`arguments`. Because Pi turns thrown errors into text for the model, the
message includes both `[CODE]` and `Recovery: { ... }`. Safe specialized
controller guidance is also included unless the recovery requires stopping.
Website prose and command output do not choose the recovery or confer authority.
Existing adapters continue to sanitize sensitive infrastructure errors before
this layer. Unknown failures receive a stable fallback code and an instruction
to inspect current state or ask for help, never an invented repair.

| Failure | Recovery |
| --- | --- |
| Read-only attached project | Prefer read-only inspection tools, including `workspace_history` `diff`, for inspection. When the task needs changes or shell execution, call `request_permissions` with `project: "write"` and a task-specific `reason`. |
| Missing executable access | Request the exact executable/command/directory through the same permission tool. |
| Disconnected or replaced project | Ask the user to reconnect the original folder using the native project menu. |
| Stale file revision | Read again, reconsider the edit, then retry against current contents. |
| Stale page or frame reference | Obtain current observations and references before acting. |
| Missing tab or attachment | List current task tabs or attached resources; use observed identifiers. |
| Invalid input or exceeded bounds | Correct arguments using the schema and observed state, or reduce the request within supported limits. |
| Unsupported capability | Explain the limit; use an authorized supported alternative or ask for manual help. |
| Declined, cancelled or policy-blocked action | Stop. Do not bypass the decision or repeatedly ask for the same access. |
| Uncertain Git or website-tool outcome | Inspect recorded/current results first; no blind replay, rollback or lock removal. |
| Unknown failure | Inspect state with read-only tools; if the cause remains unclear, explain and ask for help. |

## Project editing approval

The normal flow is a failed write/commit returning `PROJECT_READ_ONLY`, then a
separate call such as:

```json
{"project":"write","reason":"Commit the reviewed cookbook changes"}
```

Freedom shows its existing approval sheet with the attached project's name and
the scope: file changes and local Git commits, for this conversation until
revocation or application restart. The request contains no model-supplied path.
Project access cannot be bundled with executable or network access. Approval
does not imply pushing or publishing and does not automatically retry the
original operation. The agent re-reads files and obtains fresh commit review
tokens afterward.

The controller prepares a single-use, expiring token bound to the conversation
and exact live grant. The store checks the same grant and cancellation after
asynchronous identity validation, immediately before changing access. A changed,
revoked or replaced project, wrong conversation, expired/reused token, decline or
Stop cannot grant editing. The existing overlap checks and restart revocation
remain in force. Previously reviewed files are invalidated when access changes.

## Audit scope and verification

The boundary audit covered the Pi browser adapter (including page tools, frames,
wallet/node/publication operations and evidence recall), workspace adapters
(files, processes, previews, history and permissions), attachment/PDF adapters,
and session assembly including built-in skill reads. Browser error envelopes are
converted to exceptions before the wrapper. The September 20 follow-up audit
also covers non-throwing failure results: terminal process polling now throws a
sanitized error with bounded diagnostics; unsuccessful/uncertain WebMCP results
retain their evidence and receive `isError` plus recovery text. Future canonical
`isError` results receive generic guidance without interpreting codes or proposed
recovery inside untrusted result data. Successful results stay unchanged.
Pi's result hook carries these adapter-marked failures into the model transcript
as errors while retaining the SDK's existing hook and the original evidence.
Pi's edit preflight can rewrite errors, so the adapter retains the original
controller failure separately. Untyped cancellation receives stop guidance. Attachment error codes previously lost
by sanitization are retained from a fixed allowlist.

This contract covers failures delivered to a running model through tool
execution. Pi validates tool schemas before execution; its validation details
and the session instruction direct argument correction. Provider failures which
prevent model inference and renderer/IPC errors addressed to the user remain
separate concerns. Recovery guidance does not establish that any failed action
had no side effects, nor does it override operation-specific safety rules.

Unit coverage checks actionable errors, successful result preservation, no
automatic replay, trusted overrides, permission decisions and stale/cancelled
grant rejection. The external-project production qualification includes the
read-only-commit → permission request → fresh review → real commit flow. Native
sheet presentation tests use synthetic main-process events and are explicitly
separate from authority validation. Remote results are recorded in the roadmap.


## September 20 follow-up audit

The earlier thrown-error audit missed returned failure states and upstream error
rewriting. The regression corpus now checks the real installed Pi bash/edit
adapters, terminal process failures/timeouts/cancellation, returned `isError`
results, and WebMCP failed/cancelled/timed-out/unknown outcomes. Read-only shell
refusals already carried model-facing recovery in the current build; the visible
project-menu advice was a separate stale UI mapping. A model is not guaranteed
to follow guidance, and older running app instances may have older code.

`workspace_history` now exposes `action: diff` and an exact project-relative path
through the existing bounded, sandboxed inspection helper. It requires no editing
grant, applies history exclusions and checks removed as well as added text for
secrets, and returns no commit review token. It compares working files with HEAD,
including untracked additions, rather than separately reporting index-only edits.
The history skill and project prompt direct change summaries to this path.

| Boundary | Handling |
| --- | --- |
| Browser/controller error envelopes | Sanitized exception plus shared recovery. |
| WebMCP failed or uncertain execution result | Preserve receipt; mark error; inspect outcome before replay. Cancellation says stop. |
| Workspace controller exceptions, including Pi edit preflight | Preserve trusted code through SDK rewriting, sanitize infrastructure details, then add recovery. |
| Shell exit and terminal process polling | Classify trusted receipt state/code; bound diagnostics; no parsing stdout into permission authority. |
| Attachment/PDF and built-in skill tools | Shared exception/result wrapper; missing-resource and bounds guidance; untyped cancellation says stop. |
| Unknown or future tool failure | Generic read-only inspection/help guidance; no fabricated repair or automatic retry. |
| Pi argument validation before execution | SDK schema diagnostics and system instructions; outside the execute wrapper. |
| Provider inference failure and user-facing IPC/UI errors | Separate from model-facing tool recovery; no claim that an unavailable model can act on guidance. |

Activity summaries no longer say a project command completed when the latest
project operation failed. User-facing project errors mention the agent's editing
request flow; they do not imply that read-only inspection needs editing access.
