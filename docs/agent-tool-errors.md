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
| Read-only attached project | Call `request_permissions` with `project: "write"` and a task-specific `reason`. |
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
converted to exceptions before the wrapper. These adapters do not return a
separate unhandled `isError` result path. Attachment error codes previously lost
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
