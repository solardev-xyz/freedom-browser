# Independent command access review

In **Ask when needed**, Freedom can review a `request_permissions` request for
executable roots and/or direct network access for one exact project command.
The reviewer uses the selected model/provider in a fresh tool-free Pi session
with no skills or acting-agent transcript. No additional provider is required.
Each review is a separate model request and uses that provider's normal usage.

The reviewer receives current and prior user tasks and steering, exact command and
relative directory, executable names/statuses, the complete requested network
scope, the Agent's stated reason, and bounded main-collected npm project evidence.
That evidence includes manifests in the command directory and its project ancestors,
script definitions, dependencies and overrides, and up to four directly referenced
project scripts. Reads use the existing sandbox/project boundary. npm configuration
contents are never disclosed; only presence or absence is reported. Oversized,
unavailable or sensitive evidence is explicitly marked. Host executable/root paths and private
runtime objects are not added to the review. The reason and command are evidence,
not authority. Inputs are bounded without dropping parts of the user's request;
oversized inputs go to human approval.

Only a strictly valid `approve_once` answer with confidence at least 0.95 and no
uncertainties can proceed automatically. Provider errors, malformed/partial
output, timeout, absent context, unavailable executables, and uncertain or
consequential work fall back to the existing sheet. Confidence is a model
judgment about task authorization, not a calibrated guarantee of software safety.
Ordinary project-local installation, compatible dependency fixes, audits and previews
can be implied by a request to build an app. The reviewer sees relevant script bytes
but does not certify transitive package code or inspect lockfiles; when missing
evidence matters it must ask the user. The 240-character explanation target is
editorial, not an approval gate; a bounded longer explanation cannot invalidate
an otherwise valid decision.

Diagnostics record a fixed outcome category and elapsed time: model-requested human
review, low confidence, uncertainties, invalid response, timeout, cancellation,
provider failure, or approval. They never log model explanations or project bytes.

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
- Reviewed evidence is fingerprinted and rechecked after review and immediately
  before command execution. Changed or unreadable evidence invalidates unused
  one-shot permissions and tells Agent to request a fresh review. This bounds stale
  grants; it is not an atomic snapshot of all files or dependency code.
- No approval cache is created. A human decline blocks identical access requests
  and disables further automatic access approvals in that turn, so rephrasing
  the command cannot silently override the refusal.
- The activity receipt says **Approved by reviewer**, survives history restore,
  and is counted separately from user approvals. Model-authored reasoning and
  authority objects are not persisted in that receipt.

## Decisions that remain human

In **Ask when needed**, creating Freedom's private offline workspace is automatic
when a project tool first needs it. This is a deterministic mode policy, not a
model-review decision. Sandbox availability, runtime attestation, filesystem
validation, and cancellation checks still run before enabling the workspace.
It grants no additional executable or network access and never applies to an
attached external project. The other two modes retain the workspace prompt.

Selecting/reconnecting an existing project, granting its
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
checks integration, not the model's judgment quality. A live evaluation on 2026-09-21 with the configured OpenAI Codex / GPT-6 Astra
model approved all six synthetic normal commands: npm install, npm audit --json,
a pinned Next.js update, npm run dev, npm audit fix, and npm run start. Both
negative cases (publication forbidden and inspection-only installation) requested
human review. No commands were executed by the evaluation. A complete in-app
project-building smoke test remains useful; this small sample does not guarantee
future model decisions.

For a non-destructive smoke test, start a fresh project conversation and select
**Ask when needed**. Its private workspace should start without a permission
sheet when needed. Ask Agent to request the
installed `npm` executable for the exact command `npm --version` in `.` and run
it without networking. If executable access is not already available, a confident
review should show **Approved by reviewer** in activity; uncertain review should
show the usual human sheet. Repeat in **Ask frequently** to check the human path.
Stop during **Reviewing command access…** to verify that no late approval appears.
Initial project editing and publishing should still show their existing sheets.

## Related smoke-test corrections (2026-09-21)

Diagnostic refusals suppress agent retries within a user turn. A new user message
allows a fresh approval sheet; automatic resume and agent retries do not reset the
refusal. Existing conversation diagnostic grants remain valid. The sheet explains
that a bounded log excerpt is sent to the selected model in this conversation for
troubleshooting, rather than submitted as a feedback report.

Swarm publication now distinguishes no usable stamps from insufficient effective
capacity and reports upload bytes, the safety-margin requirement, and the largest
available batch. A usable depth-17 stamp is not a 512-MiB effective allocation.
The postage skill requires effective sizing before recommending another purchase
or a depth increase. Purchases and publication still require explicit approval.

Valid npm audit JSON with a nonzero vulnerability count is described as audit
findings while retaining its exit status and output. Invalid or incomplete reports
remain command failures. Repeated process polls share one activity row per owned
process ID; separate executions remain separate. Preview adapters without WebMCP
report an empty tool list rather than throwing a discovery exception.
