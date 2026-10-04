# Freedom Agent: feature review guide

Target: `feature/freedom-automation-kernel` → `main`.
Prepared September 29, updated October 4, 2026. This is a review of an unreleased feature, not a
claim that every provider, operating system or deployment path is qualified.

## What the branch delivers

Freedom gains an embedded Pi agent for browsing and project work, using the
user's connected model provider. One conversation can research in browser tabs,
use website-provided WebMCP tools, work in a managed workspace or an explicitly
attached local project, build and preview an app, and publish approved content
to Swarm. Background helpers share existing capabilities through bounded scopes;
the user still interacts with one main agent. Pi is pinned to 1.0.2. Main and helper
sessions can use sandboxed codemode scripts through their existing scoped tools;
remote MCP services have independent connection management in the composer + menu.

The UI includes provider/model discovery, searchable model selection, permission
controls, approvals, live activity and helper cards, durable conversations,
workspace/server controls, and Files/Changes/History viewers. Managed workspaces
save reviewed milestones; external repositories use their own Git history and
commit only within the user's task authorization.

Main retains authority over permissions, execution, persistence and privileged
operations. The renderer presents state and collects user decisions. Browser
adapters own observation and interaction. No top-level package boundary changes.

## Suggested reading order

Review by responsibility rather than by the full commit sequence. Experimental
branches were merged as development progressed; historical research is not the
current implementation contract.

| Pass | Start here | Questions to check |
| --- | --- | --- |
| Product behavior and deliberate limits | [Active roadmap](../research/freedom-agent-cli-roadmap.md), this guide | Does the shipped scope match the user-facing claims? Are unqualified paths explicit? |
| Runtime and orchestration | `src/main/agent/runtime.js`, `freedom-agent-service.js`, `pi-session-factory.js`; [subagents](agent-subagents.md) | Are turns, steering, Stop, provider changes and helper ownership coherent? Can late work escape its original run? |
| Codemode and connected services | `pi-codemode.js`, `mcp-connections.js`, `pi-mcp-tools.js`; [integration boundaries](agent-codemode-mcp.md) | Do nested calls retain scope, approvals, Stop and partial-effect receipts? Are OAuth credentials isolated and service responses untrusted? |
| Browser authority | `src/main/automation/origin-scoped-controller.js`, `automation-controller.js`, adapters; [WebMCP](webmcp-agent.md) | Are tab/frame ownership, origin, freshness and approval checked at dispatch? Are page-provided descriptions treated as untrusted? |
| Project and command authority | `src/main/agent/managed-workspace-controller.js`, `external-project-access.js`, `workspace-execution/`; [existing projects](agent-existing-projects.md), [access review](agent-access-review.md) | Can read-only access expand accidentally? Are executable/network grants bounded? Do partial edits remain visible after Stop? |
| Git, recovery and persistence | `external-project-git.js`, `managed-workspace-history.js`, `session-history-store.js`; [viewers/recovery](agent-project-viewer.md) | Are unrelated files/staging preserved? Can uncertain operations be replayed? Are persisted receipts distinguished from current evidence? |
| Privileged operations | `src/main/node-request-controller.js`, wallet and publication controllers; [Swarm lifecycle](agent-swarm-publication-lifecycle.md) | Are payment/publication approvals bound to exact operations/content? Are retries distinguished from new operations? |
| Renderer and IPC | `src/renderer/lib/agent-ui.js`, `src/main/agent/ipc.js`, `src/main/ipc-sender-policy.js`, `src/shared/ipc-channels.js` | Are requests bound to the displayed approval? Can web content reach privileged channels? Are model/page strings inert and reviewable? |

Paths in the table are starting points, not an exhaustive file inventory. The
[September 28 independent review](audits/freedom-agent-feature-review-2026-09.md)
records earlier findings, fixes and limitations. September 29 recovery and
stabilization changes received a separate focused Claude re-review, with no
concrete remaining finding. Test names and executable fixtures are better
evidence than model reports.

## Validation and remaining checks

The active roadmap records dated test counts and runtime versions. Local unit
and Electron results, remote real-Git fault checks, and GitHub CI results must be
reported separately; a partial rerun is not a fresh full-platform qualification.
Do not use a live user profile for automated failure injection. Risky Git fixtures
belong on the designated disposable testing machine.

[CI run 36561402138](https://github.com/solardev-xyz/freedom-browser/actions/runs/36561402138)
passed on code commit `bd67be70`: 48 jobs succeeded; opt-in live Myotis was skipped.
The automation job passed all 84 tests. The Agent job passed 81 tests and one
wallet approval test on retry; retain that test-reliability caveat. The final
local unit run passed 7,898 tests (129 skipped). Mac mini qualification passed
91 focused tests plus seven recovery probes with Node 24 and locked dependencies.
Those results describe the September baseline, not the newer provider,
codemode or MCP additions. The October 4 Pi 1.0.2 run passed 8,181 tests (129
skipped), lint and four disposable Electron scenarios covering ChatGPT/Meta
sign-in, existing-chat MCP management, native codemode and ASAR worker/WASM
execution. A bounded native output-flood probe also passed. Human smoke tests
confirmed MCP and autonomous codemode/delegation use. September's Claude review
does not cover these later changes; current PR checks must qualify the pushed head.

The following manual checks remain explicitly unconfirmed and were not selected
for this preparation pass:

- Publish an approved static build against a real Swarm node. Confirm readiness,
  propagation retry and final upload outcome use the same batch and content,
  without a duplicate purchase or upload. No new purchase is implied by this guide.
- Stop one editing helper partway through, inspect retained partial edits, then
  reopen the conversation and check its saved receipt. Parent/sibling work should
  remain coherent.

Useful reviewer smoke tests, in disposable projects:

1. Connect an available provider; select a model and ask for an ordinary browsing
   task. Try a WebMCP demo and check the page-action discovery UI.
2. Ask for three independent article summaries. Check separate helper tabs,
   synthesis, individual Stop, and absence of redundant parent rereads.
3. Build a small website in a new managed workspace. Inspect permissions, build,
   preview, checkpoint, files/diff/history and an explicit saved-server restart.
4. Attach a disposable Git repo read-only. Summarize changes, then request an edit
   and commit. Check that editing requires a grant and unrelated staging survives.
5. Decline an approval, then explicitly ask to try again. Verify that stale
   approvals or delayed classifier results cannot authorize a different action.
6. Reopen a completed conversation and retrieve an earlier helper report. Check
   that stopped work stays stopped and historical claims stay distinguishable
   from fresh inspection.

7. In an existing chat, open **+ → Connected services**, add a test MCP endpoint,
   invoke a tool and inspect its approval. Decline once, then explicitly retry.
   Check reconnect, disconnect, and preservation of the current chat/draft.
8. Ask for a source-only architecture/accessibility review without mentioning
   codemode. Check recorded tool-script usage and helper counts, then Stop a
   helper and reopen the conversation to inspect its saved receipt.

## Intentionally outside this PR preparation

Windows/Linux containment qualification remains deferred by user choice. macOS
process-group termination is best-effort for detached descendants; resource
containment and same-user filesystem races retain their documented limits.
Packaged-release/native lifecycle qualification and provider-specific live
coverage remain separate gates.

Linked Git worktrees, general external rollback/push workflows, recovery-evidence
retention and consolidation, broader scripted-download support, expanded WebMCP
schemas, additional helper models/roles/nesting/remote placement and Jev workers
remain backlog. Full access mode is not being introduced. See the active roadmap
for bounds rather than interpreting this list as implementation authorization.

Broader deferred-tool loading, image generation, model routing/classifiers and
Pi Durable evaluation are also deferred by user choice (October 4).
