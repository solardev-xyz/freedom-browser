# Claude subscription connection

Experimental branch: `experiment/agent-claude-subscription`.

In **Models & providers → Add provider → Anthropic**, choose **Claude subscription**,
then **Connect installed Claude**. Freedom checks the native Claude Code installation
and its existing login. It never reads, copies or stores the CLI's OAuth credentials.
Disconnecting in Freedom removes its connection metadata; it does not log the CLI out.

Requirements: Claude Code **2.1.290 or newer**, signed in with a personal **Pro or Max**
account using `claude auth login`. Sonnet, Opus and Haiku are CLI aliases; Claude resolves
them to the models available to that account. Usage consumes that account's allowance.
Freedom does not turn the CLI's estimated API costs into a subscription bill.
The Anthropic API-key connection remains separate.

## Runtime and authority

The main-process `claude-session` adapter implements the session interface used by
Freedom Agent, helpers and permission classifiers. Pi continues to serve the other
providers and supplies the existing codemode sandbox and schema validator. This keeps
provider execution in the main process without moving UI, permission or workspace
responsibilities or adding dependencies.

Each live session has an unmodified native CLI child, an empty private working directory
and an authenticated loopback MCP bridge. Claude's built-in tools are disabled. The bridge
exposes only that session's Freedom tools, including codemode when enabled. Direct and
nested calls retain argument validation, scoped executors, approvals, cancellation and
activity events. Tool errors remain errors. Only the app-issued bridge capability can
call this endpoint; requests from browser origins are rejected. Calls cannot execute
before the CLI's init inventory and subscription authentication checks pass.

The child receives an allowlisted environment without API keys, OAuth overrides,
provider-routing variables, injected runtimes or inherited Claude configuration paths.
No shell is used to start it. Native installation discovery excludes script shims.
`--restricted`, empty setting sources, explicit settings, an exclusive MCP configuration,
and disabled hooks/memory/Chrome/slash commands suppress ordinary local customization.
Unexpected tool inventories or API-key authentication stop the connection.

Managed policies can install hooks that command-line settings cannot disable. This
version therefore refuses known managed files, managed preferences/registry settings,
cached remote policies, and Team/Enterprise accounts. It does not override organization
policy. This is a compatibility boundary, not an OS sandbox around the installed CLI;
users still trust their locally installed Claude executable. Policies or installations
changed externally during a running session remain outside Freedom's control.

## Conversation lifecycle

Streaming JSON input keeps the live conversation in Claude's memory. Freedom maps
streaming responses and tool events into its existing chat and helper cards. Guidance
is queued for the next response pass. Helpers, tool-free classifiers, attachments and
images use the same adapter with their own assigned tools. Claude manages its live
context compaction; Freedom retains visible history and its separate evidence/report
stores for recovery.

Stop aborts scoped tools and terminates the owned CLI process, with a kill fallback.
It does not undo earlier tool effects. A later turn creates a fresh child and supplies
historical visible conversation text, clearly labeled as evidence rather than renewed
authorization. Reopening after an app restart uses the existing saved conversation
history. Raw tool output and screenshots are not duplicated in this restart transcript.

The CLI runs with `--no-session-persistence`. Freedom still saves its normal conversation
history. Claude can keep separate diagnostics under its own data policy. The private MCP
configuration and system-prompt scratch files are emptied when the child closes; the
loopback server and its capability are retired. Crash leftovers have no live server.

## Privacy and evidence limits

The privacy panel identifies Claude as the transport owner. Freedom records visible
model-response starts separately for Agent, helpers and classifiers; it cannot observe
all CLI network attempts, retries or internal compaction requests. It does not claim to
verify the CLI's TLS connection, model hardware or response signatures. Provider model
badges follow the existing Anthropic presentation.

Lint and the full unit suite passed (9,505 tests; 129 skipped). Three live Electron
scenarios passed, with the approval/Stop/helper scenario repeated successfully after
shutdown hardening.

Live qualification on macOS with Claude Code 2.1.290 covers the normal provider UI in
both themes, two chat turns, privacy reporting, approved and declined browser clicks,
Stop at approval, helper delegation, and creating/checkpointing/previewing a static
workspace through codemode. Deterministic tests cover schema errors, scoped nested
calls, guidance, interruption, restart context, image serialization, authentication
refusal and managed-policy refusal.

Native Windows/Linux Claude login and packaged-app qualification remain outstanding.
The connection is ready for the user's macOS smoke test; that does not constitute
cross-platform release qualification. Optional future work: managed-account support
with a qualified policy boundary and richer CLI failure/usage diagnostics.

Run live checks only with a locally authenticated personal account:

```sh
FREEDOM_CLAUDE_LIVE=1 npx playwright test test-e2e/claude-subscription.spec.js --project=harness --workers=1
```

## Primary references

- [CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Programmatic execution](https://code.claude.com/docs/en/headless)
- [Subscription SDK usage](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- [Managed policy delivery](https://code.claude.com/docs/en/managed-settings)
- [Server-managed policy](https://code.claude.com/docs/en/server-managed-settings)
- [Hook precedence](https://code.claude.com/docs/en/hooks)

The [earlier spike](agent-claude-subscription-spike.md) retains feasibility evidence and
its historical limitations; this document describes the integrated implementation.
