# Local Claude subscription integration spike

Date: 2026-10-10. Branch: `experiment/agent-claude-subscription`, based on
`c717eb65`. This is opt-in qualification tooling, not a shipped provider.

## Result and architecture

An authenticated, unmodified local Claude Code binary can run a streaming turn
and call Freedom's existing browser tools over an ephemeral loopback MCP bridge.
The tools retain the real origin-scoped controller, observation references,
action inspection and exact-interaction approval. Claude's built-in file/shell
tools are absent. No API key, copied OAuth token, new dependency, provider-picker
entry or production IPC channel was added.

The adapter is in `scripts/` because it is a qualification experiment. Live
Electron tests load it into main, where Freedom's existing automation controller
already lives. No renderer authority or top-level package boundary changes.

This uses Claude's own agent loop. It does **not** prove Claude Code can serve as
a drop-in Pi model transport. The likely production design is a Claude session
adapter beside the Pi session adapter, with shared Freedom tool/controller and
event contracts. Keep Pi for all current API/subscription providers. A synthetic
JSON tool-call protocol through a tool-free CLI might preserve Pi's outer loop,
but was not implemented or qualified; it would add parsing, context replay and
two competing runtime assumptions rather than reuse native tool calls.

## Official documentation studied

- [CLI reference](https://code.claude.com/docs/en/cli-reference): `--tools ""`
  removes built-ins, `--strict-mcp-config` limits MCP discovery, `--restricted`
  ignores user/project/local settings, and print mode provides JSON streaming.
- [Programmatic execution](https://code.claude.com/docs/en/headless): the CLI
  is an Agent SDK entry point. `--bare` skips OAuth/keychain authentication, so
  it cannot supply the requested subscription connection. SIGTERM stops a run.
- [SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) and
  [custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools): the SDK
  embeds Claude Code's loop; custom tools are exposed through MCP.
- [Permissions](https://code.claude.com/docs/en/agent-sdk/permissions): an allow
  list pre-approves named tools, but is not a complete tool allowlist. We remove
  built-ins and retain approval inside the Freedom tool, not a Claude callback
  that earlier approvals can bypass.
- [Streaming](https://code.claude.com/docs/en/agent-sdk/streaming-output): partial
  message events provide text deltas in addition to terminal result messages.
- [Memory](https://code.claude.com/docs/en/memory) and
  [hooks](https://code.claude.com/docs/en/hooks): memory exclusions, disabled auto
  memory and `disableAllHooks` prevent ordinary customization loading/execution;
  managed policy has higher precedence and cannot generally be switched off by
  an application.
- [Authentication and integration rules](https://code.claude.com/docs/en/legal-and-compliance):
  users may authenticate the unmodified binary themselves; applications must not
  collect/intermediate their Claude subscription credentials. Its embedded-product
  conditions and branding rules need to be followed before distribution.
- [Subscription help, updated October 7](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan):
  subscription-limit usage remains available for SDK/CLI/third-party apps.

The SDK overview still contains broader restrictive sign-in wording than the
updated integration section and Help Center. This spike uses the user's existing
local binary/login; it does not introduce a Freedom-branded Claude OAuth flow.
Confirm the production distribution/account UX against the then-current terms.

## Actual local observations

- macOS, installed Claude Code **2.1.290**. `claude auth status` reported
  `loggedIn: true`, `authMethod: claude.ai`, `apiProvider: firstParty`, `Max`.
  Only those non-identifying fields were retained; no credentials were extracted.
- `sonnet` resolved to **claude-sonnet-5-5**. Init reported `apiKeySource: none`.
- A tool-free subscription query and partial text streaming succeeded.
- `--safe-mode` also suppressed the explicitly configured MCP server. The
  inventory check rejected that run before it could proceed with a missing tool.
- Restricted mode with an empty setting-source list, explicit settings disabling
  hooks/memory, a scratch working directory, and strict MCP configuration exposed
  only `mcp__freedom__browser_snapshot` and `mcp__freedom__browser_click`.
- In a disposable Freedom Electron profile, Claude read a synthetic page heading
  `ORBIT-731`, requested a click and waited. The page remained unchanged until
  the host test supplied a decision. Approval performed the click and a subsequent
  snapshot confirmed it; denial and Stop left the page unchanged.
- Approval decisions were supplied by the **test harness**, through the real
  controller callback. This is not evidence of the shipped approval sheet or
  provider picker working with Claude; neither is wired in this spike.
- Stop aborted the Freedom operation and closed the owned CLI process. This does
  not establish cross-platform process-tree cleanup or cancellation at every
  lifecycle boundary.

Final validation: lint and `git diff --check` passed; full unit suite **9,493
passed / 129 skipped** (436 passing suites, 10 skipped). The three live Electron
cases passed in **25.1 seconds** after preserving the controller's cancellation
code. Earlier denial output had hidden that code behind a generic error; the
final run tells Claude the action was declined/cancelled and was not performed.

## Reproduce

With an already installed and authenticated Claude CLI:

```sh
FREEDOM_CLAUDE_SPIKE_EXECUTABLE="$(command -v claude)" \
  npx playwright test test-e2e/claude-subscription-spike.spec.js --project=harness --workers=1
```

The executable must resolve to an absolute path. These tests use subscription
quota and synthetic content only. They are explicitly excluded from normal CI.
The CLI retains its normal authentication files/keychain. The subprocess receives
an allowlisted environment without API keys, OAuth overrides or Node injection.
Transcript persistence is disabled for these single-turn runs. Temporary bridge
configuration is owner-only and its capability is overwritten after shutdown;
synthetic scratch directories remain for inspection.

## Work before a product connection

1. Select the production interface (official SDK vs documented CLI), discover
   and version-check the installed executable, validate subscription state, and
   expose an explicit setup/reconnect flow using Claude's own authentication.
2. Implement a session adapter with streaming, real approval-sheet integration,
   multi-turn input, Stop/steering, compaction, resume/reopen and durable history.
   Do not translate Claude's estimated API cost into a claimed subscription bill.
3. Reuse the Freedom tools and scope checks for workspace operations, MCP, helpers,
   codemode and privileged actions. Qualify classifiers/context-management requests
   through this same selected backend; never silently use another paid provider.
4. Harden the experimental bridge: schema/output validation, concurrency and
   resource bounds, cancellation on startup/connection loss, process ownership,
   explicit protocol compatibility and adversarial transport tests. The current
   minimal HTTP implementation is not a production MCP server.
5. Resolve managed-policy compatibility. Managed hooks, settings or memory can
   survive ordinary discovery switches; the init inventory check does not prove
   nothing ran before init. Do not promise complete isolation from an enterprise
   Claude configuration without qualifying or refusing that configuration.
6. Update privacy reporting for CLI-managed authentication, runtime data handling,
   diagnostics and any additional local persistence; test macOS, Windows and Linux.

The current feature branch and PR remain separate. This experimental branch must
not be merged as a completed subscription feature on the strength of these tests.
