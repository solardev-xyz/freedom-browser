# Independent command access review

In **Ask when needed**, Freedom can review a `request_permissions` request for
executable roots and/or direct network access for one exact project command.
The reviewer uses the selected model/provider in a fresh tool-free Pi session
with no skills or acting-agent transcript. No additional provider is required.
Each review is a separate model request and uses that provider's normal usage.

The reviewer receives current and prior user tasks and steering, exact command and
relative directory, executable names/statuses, the complete requested network
scope, and the Agent's stated reason. Host executable/root paths and private
runtime objects are not added to the review. The reason and command are evidence,
not authority. Inputs are bounded without dropping parts of the user's request;
oversized inputs go to human approval.

Only a strictly valid `approve_once` answer with confidence at least 0.95 and no
uncertainties can proceed automatically. Provider errors, malformed/partial
output, timeout, absent context, unavailable executables, and uncertain or
consequential work fall back to the existing sheet. Confidence is a model
judgment, not a calibrated guarantee. The reviewer does not inspect script bytes
or certify packages; when missing evidence matters it must ask the user.

## Scope and enforcement

- Only Freedom's workspace approval producer can enter this review path.
- The decision always requests `once`, never `conversation`. The controller
  consumes the existing non-serializable permit only for the exact command and
  canonical project-relative directory. A different command cannot use it.
- The sandbox and its filesystem protections stay in force. Direct network access
  remains the existing indivisible public/localhost/private-LAN bundle, with
  Linux abstract Unix sockets explicitly included in the review.
- Request mutation, Stop, pause, completion, or new user steering invalidate an
  in-flight decision. Steering also clears unused one-shot permits. It does not
  retroactively stop a command already running; Stop remains available.
- No approval cache is created. A human decline blocks identical access requests
  and disables further automatic access approvals in that turn, so rephrasing
  the command cannot silently override the refusal.
- The activity receipt says **Approved by reviewer**, survives history restore,
  and is counted separately from user approvals. Model-authored reasoning and
  authority objects are not persisted in that receipt.

## Decisions that remain human

Initial workspace enablement, selecting/reconnecting a project, granting project
editing, and broader conversation grants retain their explicit human flows.
Existing authorized file edits and commands already run within their grants.
Downloads, uploads, WebMCP calls, wallet operations, node changes, diagnostics
disclosure, and publishing retain their existing dedicated boundaries. Unknown
future approval kinds do not become eligible by default.

The reviewer must also refer commands that involve payments, messages, publishing,
private-data disclosure, account/legal consent, destructive changes, or global
installation to the human. This semantic policy is not a claim that the runtime
can prove all hidden effects of arbitrary scripts. Existing browser-intent
classification remains separate. **Ask frequently** and **Fewer interruptions**
retain their existing command-access approval behavior.

Full access is deferred. Broader automatic project grants, per-file editing
review, automatic WebMCP consent, and further capability classes are not enabled
by this slice.

Implementation lives in `src/main/agent/`: the service owns the review lifecycle,
the reviewer owns its isolated model request, and the existing controller and
capability store retain grant enforcement. Neither the renderer nor the acting
model receives a new grant API.

## Validation and smoke test

The regression suites cover strict output parsing, provider failure and incomplete
output, initialization/response timeouts, cancellation, late completion, prior user
constraints on later turns, exact request binding, refusal replay, human-only
approval kinds, one-shot grant consumption, history provenance, and UI receipt
copy. The installed Pi SDK is exercised with a fake provider transport; this
checks integration, not the model's judgment quality. Native UI and live-model
acceptance remain to be smoke-tested.

For a non-destructive smoke test, start a fresh project conversation, enable its
workspace explicitly, and select **Ask when needed**. Ask Agent to request the
installed `npm` executable for the exact command `npm --version` in `.` and run
it without networking. If executable access is not already available, a confident
review should show **Approved by reviewer** in activity; uncertain review should
show the usual human sheet. Repeat in **Ask frequently** to check the human path.
Stop during **Reviewing command access…** to verify that no late approval appears.
Initial project editing and publishing should still show their existing sheets.
