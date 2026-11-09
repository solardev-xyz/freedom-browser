# Claude subscription connection

The Claude subscription transport uses the installed native Claude Code CLI.

In **Settings → AI → Add provider → Anthropic**, choose **Claude subscription**,
then **Connect installed Claude**. Freedom checks the native Claude Code installation
and its existing login. It never reads, copies or stores the CLI's OAuth credentials.
Disconnecting in Freedom removes its connection metadata; it does not log the CLI out.

Requirements: Claude Code **2.1.290 or newer**, signed in with a **Pro, Max, Team or Enterprise**
account using `claude auth login`. Freedom discovers model choices and versioned names
through the CLI's SDK initialization protocol, without sending an inference prompt.
Before connecting, Freedom shows CLI-default aliases without launching Claude.
Connecting discovers versioned models; the catalogue is cached for five minutes and can be refreshed in provider settings.
Alias IDs stay stable so existing selections and favourites survive CLI updates.
If discovery is unavailable, the three original aliases are labelled “CLI default”
rather than showing guessed versions. Additional models are selectable when the CLI
reports them. Availability and billing remain subject to the account's plan; some
models can require usage credits instead of drawing from included limits.
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

Team and Enterprise subscriptions are supported without overriding organization policy.
The connection screen discloses, before connecting and in connected-provider settings:
“Your organization’s Claude policies and automation also apply. Organization scripts
may run outside Freedom’s approval controls and receive your messages and the content
Agent reads.” This also covers personal subscriptions
used with a managed CLI installation; the plan name does not establish whether hooks
are configured.

Freedom disables ordinary user/project hooks, but organization-managed hooks and
force-enabled automation can still run inside the CLI, including during initialization.
They are trusted organization automation, outside Freedom’s scoped tool approvals and
workspace sandbox. Their filesystem/network access and retention follow the CLI and
organization policy; Freedom does not claim to mediate them or to override those policies.
Users trust both the installed Claude executable and its organization-managed automation.
Existing connections require a one-time reconnect to review this disclosure. The saved
acknowledgment applies to organization policy, including later account or policy changes.
Before that reconnect, catalogue listing, refresh, model selection and chat do not start Claude.

Freedom still requires first-party subscription authentication, disables built-in model
tools, and checks that the initialized tool inventory matches the session’s Freedom
bridge. Model discovery also checks the CLI’s MCP connection status without inference,
so a blocked Freedom bridge is detected when connecting. Additional tools, missing
required tools, or API authentication produce a
configuration-conflict error. Managed files or policy refreshes alone no longer revoke
connections. No organization policies are edited, hidden or bypassed.

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
history. Claude can keep separate diagnostics under its own data policy. Login/version probes run from a private directory with restricted settings. The private MCP
configuration and system-prompt scratch files are emptied and their owned directories
removed when the child closes; the
loopback server and its capability are retired. Crash leftovers have no live server.

## Privacy and evidence limits

The privacy panel identifies Claude as the transport owner. Freedom records visible
model-response starts separately for Agent, helpers and classifiers; it cannot observe
all CLI network attempts, retries or internal compaction requests. It does not claim to
verify the CLI's TLS connection, model hardware or response signatures. Provider model
badges follow the existing Anthropic presentation.

Lint and the full unit suite passed (9,509 tests; 129 skipped). Three live Electron
scenarios passed, with the approval/Stop/helper scenario repeated successfully after
shutdown hardening.

Live qualification on macOS with Claude Code 2.1.290 covers the normal provider UI in
both themes, two chat turns, privacy reporting, approved and declined browser clicks,
Stop at approval, helper delegation, and creating/checkpointing/previewing a static
workspace through codemode. Deterministic tests cover schema errors, scoped nested
calls, guidance, interruption, restart context, image serialization, authentication
refusal and incompatible tool-inventory refusal.

Native Windows/Linux Claude login and packaged-app qualification remain outstanding.
The user confirmed the macOS smoke test passed. Versioned catalogue discovery and
the connection/chat UI were subsequently checked live in both themes; this does not
constitute cross-platform release qualification. Team/Enterprise plan acceptance, disclosure migration, bridge compatibility and scoped
tool dispatch are covered by deterministic fixtures. A real Team/Enterprise account
and organization-managed hook smoke test remains required. Optional future
work: richer CLI failure/usage diagnostics.

Run live checks only with a locally authenticated account whose Claude installation
and organization automation you trust:

```sh
FREEDOM_CLAUDE_LIVE=1 npx playwright test test-e2e/claude-subscription.spec.js --project=harness --workers=1
```

## Primary references

- [CLI reference](https://code.claude.com/docs/en/cli-reference)
- [SDK model discovery](https://code.claude.com/docs/en/agent-sdk/typescript#modelinfo)
- [Programmatic execution](https://code.claude.com/docs/en/headless)
- [Subscription SDK usage](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- [Managed policy delivery](https://code.claude.com/docs/en/managed-settings)
- [Server-managed policy](https://code.claude.com/docs/en/server-managed-settings)
- [Hook precedence](https://code.claude.com/docs/en/hooks)

The [earlier spike](agent-claude-subscription-spike.md) retains feasibility evidence and
its historical limitations; this document describes the integrated implementation.
