# Freedom Agent: feature review guide

Target: `feature/freedom-automation-kernel` → `main`.
Prepared September 29, updated October 10, 2026. This is a review of an unreleased feature, not a
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
workspace/server controls, and Files/Changes/History viewers. Provider connections
include hosted API keys, ChatGPT/Meta sign-in, local Ollama, an installed Claude
Code personal subscription, and custom OpenAI-compatible Chat Completions servers.
Custom connections offer an optional per-model streaming/tool compatibility check.
Conversation privacy distinguishes provider claims, transport observations,
verified evidence and E2EE actually used. Managed workspaces
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
| ChatGPT sign-in | `src/main/agent/chatgpt-login.js`, `provider-resolver.js`, `provider-runtime.test.js` | Freedom owns the name hint, loopback callback pages and initial code exchange because Pi 1.0.2 hardcodes its branding. Pi retains credential storage, refresh and model transport. Compare the adapter with Pi's `auth/oauth/openai-chatgpt.js` when upgrading; preserve PKCE, issued client IDs, direct-token scopes, state checks (including denial callbacks), cancellation and retry. |
| Claude subscription | [Contract and qualification](agent-claude-subscription.md); `src/main/agent/claude-cli.js`, `claude-session.js` (the tool bridge is in `claude-cli.js`) | Are built-in CLI tools disabled, environment/configuration constrained, managed policies refused and only the session's approved Freedom tools exposed? Does cancellation retire the process and bridge? |
| Custom endpoints and credentials | [Connection contract](agent-openai-compatible-spike.md); `src/main/agent/compatible-provider.js`, `provider-resolver.js`, `provider-store.js`; `test-e2e/custom-provider.spec.js` | Can endpoint edits, redirects, model refresh or key rotation misroute a credential or conversation? Are capabilities explicit, checks opt-in and results tied to their model/settings? |
| Conversation privacy | [Privacy contract](agent-session-privacy.md); `src/main/agent/session-privacy.js`, `privacy-request.js`, `privacy-attestation.js`; `src/renderer/lib/agent-privacy.js` | Do displayed guarantees match observed requests? Are encryption fallback, hardware advisories, CLI visibility limits and OpenRouter retention constraints represented accurately? |
| Codemode and connected services | `pi-codemode.js`, `mcp-connections.js`, `pi-mcp-tools.js`; [integration boundaries](agent-codemode-mcp.md) | Do nested calls retain scope, approvals, Stop and partial-effect receipts? Are OAuth credentials isolated and service responses untrusted? |
| Browser authority | `src/main/automation/origin-scoped-controller.js`, `automation-controller.js`, adapters; [WebMCP](webmcp-agent.md) | Are tab/frame ownership, origin, freshness and approval checked at dispatch? Are page-provided descriptions treated as untrusted? |
| Project and command authority | `src/main/agent/managed-workspace-controller.js`, `external-project-access.js`, `workspace-execution/`; [existing projects](agent-existing-projects.md), [access review](agent-access-review.md) | Can read-only access expand accidentally? Are executable/network grants bounded? Do partial edits remain visible after Stop? |
| Windows execution and packaging | `workspace-execution/windows-backend.js`, `windows-sandbox-process.js`, `native/windows/src/main.rs`, `scripts/build-windows-workspace.js` | Are writes scoped, networking enforced, setup explicit, binaries pinned and dependency notices shipped? Are broad reads and best-effort cancellation disclosed? |
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

Current review baseline: `6f139aa5`, integrating `main` at `75cc0d3c`.
The earlier merge `e944cc19` resolved launch URL handoff alongside headless-runtime
profile handling, automation attachment before guest creation, and both Tor status
exports. The final merge adds only main's updater fix and its documentation/tests.
Documentation-only commits after this baseline do not change its code.

| Evidence | Scope and limit |
| --- | --- |
| Current merged code, macOS | Lint and full unit suite: **9,684 passed, 129 skipped** on `6f139aa5`. **138 Agent/settings/runtime/profile/update Electron tests passed** on `e944cc19`; all **5 updater Electron tests** passed again after the updater-only final merge. The PR records current-head GitHub checks separately. Skips are not passes. |
| Claude subscription, macOS | Live provider UI, multi-turn chat, approvals/decline/Stop, helpers and a managed build/checkpoint/preview; user smoke passed. Windows/Linux CLI and packaged-app qualification remain open. |
| Custom connections, macOS | Fixture UI covers discovery, two independent connections, keyless/manual models, streaming, tool checks, late-result model attribution, retry and continue. Production adapter/codemode worked against the supplied endpoint; user smoke passed. This is not qualification of every compatible server/model. |
| Core Windows x64, `c717eb65` | Physical standard-user sandbox/controller and packaged NSIS/ZIP checks; 20 repeated parallel-helper cases. [CI](https://github.com/solardev-xyz/freedom-browser/actions/runs/38047194963) and [Windows qualification](https://github.com/solardev-xyz/freedom-browser/actions/runs/38047194934) passed. These predate Claude/custom-provider additions and the latest main merge. Package hashes and scope are retained in the PR's historical evidence. |
| Earlier Linux/macOS containment and September review | Dated evidence remains in the roadmap and [independent audit](audits/freedom-agent-feature-review-2026-09.md). It does not independently review subsequent provider/privacy/UI/Windows additions. |

Never substitute a historical green CI run for the current PR head. The new push
must run its own checks, including the Windows sandbox workflow. The latter uses
an elevated CI runner; the physical Windows evidence used a standard user. Real
administrator provisioning succeeded, but UAC cancellation/retry has controller
test coverage rather than an injected live UAC cancellation.

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

9. Connect an installed, authenticated personal Claude Code account. Check discovered
   model names, a normal chat, an approved browser action and Stop. Follow the CLI
   contract's setup requirements rather than copying its OAuth credentials.
10. Add a custom provider using a disposable fixture or a server you are authorized
    to use. Saving must not send inference. Explicitly run the optional check,
    switch models during it, retry a failure and continue without checking.

## Assigning review passes

This is a large accumulated feature. Start with the contracts and the relevant
entry points in the table, then follow their callers, IPC dispatch and tests.
Suggested independent passes are provider/auth/privacy; browser/MCP authority;
workspace/Git/native execution; and orchestration/persistence/UI. Cross-boundary
findings need a follow-up across the affected passes. The September audit is
prior evidence, not a clean bill of health for the current tree.

A ready-to-use [review task brief](agent-playbooks/freedom-agent-review.md) provides
scope, evidence expectations and a finding format for human or agent reviewers.
The active roadmap contains historical experiments and deferred work; it is not
necessary to read all its chronology before examining the production code.

## Platform boundaries and deferred extensions

Windows x64 now has a pinned native restricted-token backend, separate Freedom
sandbox accounts, explicit administrator setup, scoped writes and network grants.
Reads are deliberately broad, matching the accepted Windows policy. See the
[Windows qualification record](../research/agent-windows-mxc-feasibility.md) for
standard-user execution, packaged-artifact and CI evidence. Linux has earlier
Bubblewrap qualification recorded in the roadmap; macOS and Windows cancellation
remain best-effort for detached descendants. Resource containment, same-user
filesystem races and provider-specific live coverage retain their documented
limits. Windows ARM64 and MXC are future extensions, not shipped alternatives.

Linked Git worktrees, general external rollback/push workflows, recovery-evidence
retention and consolidation, broader scripted-download support, expanded WebMCP
schemas, additional helper models/roles/nesting/remote placement and Jev workers
remain backlog. Full access mode is not being introduced. See the active roadmap
for bounds rather than interpreting this list as implementation authorization.

Broader deferred-tool loading, image generation, model routing/classifiers and
Pi Durable evaluation are also deferred by user choice (October 4).
