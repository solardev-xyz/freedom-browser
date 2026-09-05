# Freedom Agent and Automation Roadmap

Created: 2026-08-22
Last updated: 2026-09-04
Status: Living research roadmap
Scope: embedded Freedom Agent, shared automation kernel, and optional external adapters
Planning basis: current Freedom mainline, current product requirements, and fresh validation of external dependencies

Older Pi research and the `feature/local-agent-pi` prototype are non-normative historical material. They are not implementation baselines, migration dependencies, or prerequisites for this roadmap. Individual ideas or code may be reconsidered later only if they still fit the architecture and pass current evaluation.

## Executive decision

The primary product is **Freedom Agent**: Pi embedded inside Freedom Browser so a user can give the browser a high-level task and watch it complete the work in a controlled tab.

The automation kernel is the foundation that makes this safe and testable. The current `freedom-cli` and hidden Electron runtime are useful repository-local debugging and evaluation adapters, not near-term products and not prerequisites for shipping the embedded agent. MCP, installed CLI packaging, system integration, and a public JavaScript SDK remain deferred until real external demand justifies them.

The earlier working name **Freedom SDK** is retired. If a public headless surface becomes worthwhile later, the likely product shape is CLI-first with an optional MCP interface over the same contract.

The key architectural rule is:

> Pi, the CLI, and MCP are clients of Freedom's automation kernel. None of them owns browser-control behavior or security policy.

This avoids building one browser-control stack for the desktop agent and a second one for headless use.

## Stance

**Freedom owns authority and browser semantics. Agent harnesses own reasoning mechanics. Public adapters own transport only.**

- Freedom owns tab identity, navigation, page observation, input dispatch, downloads, protocol behavior, profiles, permissions, approvals, wallet policy, cancellation, and audit events.
- Pi owns the embedded agent loop, model/provider integration, conversation sessions, compaction, and tool-selection mechanics.
- The CLI owns argument parsing, lifecycle commands, machine-readable output, and exit codes.
- MCP owns tool discovery, schema publication, transport, and structured tool results.
- External agents decide how to reason, but cannot bypass Freedom's policy controller.

## Priority and sequencing

Current execution order:

1. Prove the embedded Pi experience end to end inside Freedom.
2. Harden controlled-tab ownership, approval, cancellation, and evaluation around that experience.
3. Keep `freedom-cli` as a thin local oracle for the kernel when it helps debugging or repeatable tests.
4. Revisit CLI distribution and MCP only after the embedded agent demonstrates enough value to preserve and expose externally.

The existing CLI/runtime work was still useful: it forced a transport-neutral contract, authenticated runtime boundary, profile locking, and real hidden-page parity. We should retain those assets without allowing their packaging backlog to delay the product we actually care about.

## Product model

### Freedom Browser

The existing visible desktop application. It remains the place where users manage profiles, local nodes, wallet state, permissions, provider settings, and interactive approval prompts.

### Freedom Agent

The agent sidebar inside Freedom Browser. Users give it a high-level task, observe its progress, steer it while it works, approve sensitive actions, take over a controlled tab and resume, or stop it.

Pi is the first reasoning harness, not a permanent protocol boundary. A future harness should be able to consume the same Freedom tool contract.

### Freedom CLI

An experimental repository-local control client named `freedom-cli`. It exercises the authenticated hidden runtime and canonical browser operations for debugging, evaluation, and architecture validation. It is not installed globally, placed on `PATH`, or treated as a release blocker now.

### Freedom MCP

A deferred external adapter. If demand appears, it should expose the same canonical operations over stdio and share conformance tests with `freedom-cli`; it must not become a separate browser-control implementation.

### Freedom runtime

The persistent browser process that owns page execution, Freedom protocol handlers, local node lifecycles, profile state, automation sessions, and the policy controller.

The V1 runtime implementation is a hidden Electron/Chromium process so it can reuse Freedom's real session and protocol behavior. Electron is an implementation detail of that runtime, not a permanent public dependency of the CLI, MCP interface, or automation contract.

`freedom-runtime` may remain a useful internal name. There is no current decision to ship a daemon or system service.

## Architecture

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Product surfaces                                                     │
│                                                                      │
│  Freedom sidebar     freedom-cli (local)      MCP (deferred)         │
│        │                    │                       │                 │
│  Pi tool adapter       CLI adapter              MCP adapter          │
└────────┼────────────────────┼───────────────────────┼─────────────────┘
         └────────────────────┼───────────────────────┘
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Canonical automation contract                                       │
│ Typed inputs, outputs, errors, events, capability metadata           │
└─────────────────────────────┬────────────────────────────────────────┘
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Freedom policy and automation controller                            │
│ Session scope · approvals · tab registry · snapshots · actions       │
│ cancellation · audit events · stale-reference protection             │
└─────────────────────────────┬────────────────────────────────────────┘
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Page adapters                                                        │
│ Visible desktop <webview> guests · hidden runtime WebContents         │
└─────────────────────────────┬────────────────────────────────────────┘
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Existing Freedom platform                                            │
│ HTTP(S) · Swarm · IPFS/IPNS · Radicle · Tor · nodes · downloads      │
│ profiles · permissions · wallet · x402 · identity                    │
└──────────────────────────────────────────────────────────────────────┘
```

## Current baseline

### Current mainline architecture

- Protocol handlers and local node lifecycles are already main-process responsibilities.
- Desktop tabs are renderer-owned `<webview>` elements.
- Production session setup already centralizes dweb protocols, request rewriting, ad blocking, x402, site permissions, downloads, private-session configuration, and Tor routing.
- The E2E suites already prove that Electron can be launched programmatically with either fixture-backed or live Freedom protocol behavior.
- A hidden-window path exists for tests, but it is not yet a supported headless runtime contract.

This roadmap assumes a fresh design and implementation assessment from current mainline. It does not assume that an earlier agent prototype will be merged, ported, or inventoried before work begins.

### Implementation checkpoint — 2026-08-21

Branch: `feature/freedom-automation-kernel`, based directly on `origin/main`.

The first WP1 slice is implemented:

- Runtime-neutral operation names, input validation, typed errors, and result envelopes.
- A main-process automation controller with opaque runtime, context, tab, and element identifiers.
- A mandatory policy-controller call on every operation; there is no transport that bypasses it.
- One Electron `WebContents` adapter used for both attached desktop `<webview>` guests and direct hidden pages.
- Semantic main-frame snapshots, internal selector/fingerprint storage, reference-based click/type, screenshot, navigation, and stop-loading operations.
- Navigation-scoped references that fail with `STALE_ELEMENT_REFERENCE` after the page changes.
- Automatic registration of desktop webview guests from the main process without exposing new APIs to page content or the renderer.

Verification at this checkpoint:

- Focused automation unit tests: 16 passing.
- Full unit suite: 167 suites and 3,188 tests passing; 3 suites and 10 tests skipped as before.
- Full ESLint run: clean.
- Real Electron harness smoke: the same controller snapshots, types, clicks, and detects stale references in a visible Freedom webview, then snapshots, clicks, and screenshots a direct hidden page.

Second checkpoint on the same branch:

- Reference clicks now resolve a verified on-screen hit target and dispatch Electron mouse input instead of calling page-script `.click()`.
- Electron smoke fixtures confirm both click and text input events arrive with `event.isTrusted === true` in desktop and hidden pages.
- `browser_wait` supports bounded declarative `load`, `navigation`, `text`, and exact-URL conditions; arbitrary predicates and JavaScript remain unavailable.
- `browser_stop_loading` cancels active waits, which return the typed `USER_CANCELLED` error rather than hanging or timing out.
- Wait timeouts are capped at 30 seconds and return `WAIT_TIMEOUT` with retryable metadata.

Verification after the second checkpoint:

- Focused automation unit tests: 20 passing.
- Full unit suite: 167 suites and 3,192 tests passing; 3 suites and 10 tests skipped as before.
- Full ESLint run: clean.
- Trusted-input and wait/cancellation Electron smoke: 3 consecutive runs passing.

Third checkpoint on the same branch:

- Snapshots now traverse same-origin nested frames and return an explicit frame tree; elements carry opaque frame IDs without exposing Electron routing IDs or selectors.
- Cross-origin frames are reported as inaccessible rather than silently omitted. Interacting inside them remains a later isolated-frame-execution capability.
- Element references now retain the actual DOM node only inside Electron's isolated world. Replacing a node with an identical clone in an SPA makes the old reference stale instead of accidentally targeting the replacement.
- Child-frame and in-page frame navigation conservatively invalidate existing references.
- Trusted click coordinates are transformed through iframe boundaries and hit-tested at every ancestor before Electron input is dispatched.
- Freedom's existing `window.open` policy remains authoritative: desktop popups become normal Freedom tabs and are registered through webview attachment. Direct runtime pages also register genuine Electron child windows as `popup` pages.
- Declarative text waits include accessible same-origin frame text.

Verification after the third checkpoint:

- Focused automation unit tests: 21 passing.
- Full unit suite: 167 suites and 3,193 tests passing; 3 suites and 10 tests skipped as before.
- Full ESLint run: clean.
- Iframe trusted-input, SPA replacement, popup registration, waits, cancellation, desktop, and hidden-page Electron smoke: 3 consecutive runs passing.

Fourth checkpoint on the same branch:

- The fixture harness can now serve explicit HTTP(S) content without allowing network access; its existing deterministic fallback remains unchanged for tests without a fixture.
- The identical navigate, snapshot, trusted-click, and declarative-wait contract passes against both desktop and hidden adapters for HTTPS, `bzz://`, and `ipfs://` pages.
- The cancellation smoke now measures the complete stop-to-`USER_CANCELLED` path and requires it to finish within one second.
- The protocol test exposed and records an intentional phase boundary: the renderer still owns initial internal Home-tab navigation. The first external page is established through Freedom's existing address-bar path; subsequent controlled-page navigation uses the kernel. Binding renderer tab state to controller navigation is WP2 work.

Verification after the fourth checkpoint:

- Focused automation unit tests: 21 passing.
- Full unit suite: 167 suites and 3,193 tests passing; 3 suites and 10 tests skipped as before.
- Full ESLint run: clean.
- Complete automation Electron matrix: 6 of 6 scenarios passing across 3 consecutive runs.

WP1's defined vertical-spike matrix and exit criteria are complete. WP2 should begin with explicit desktop tab identity/state binding and controlled-tab ownership. Cross-origin isolated-frame execution, shadow DOM, more complex frame lifecycles, and broader production-protocol coverage remain hardening requirements before a public CLI or MCP release, but are not prerequisites for starting WP2.

First WP2 checkpoint on the same branch:

- Each desktop webview now reports its renderer tab ID and attached guest WebContents ID through a narrow chrome-preload IPC message after `dom-ready`.
- The main-process runtime accepts a binding only when the sender is the exact owning chrome renderer, both IDs are safe positive integers, the guest was observed through that host's `did-attach-webview`, and Electron confirms the same `hostWebContents` owner.
- Bidirectional internal lookup connects `(host renderer, renderer tab ID)` to the opaque automation tab ID. Renderer IDs and Electron IDs remain absent from the public automation contract and list results.
- Bindings are replaced safely when a renderer tab reattaches, and are removed when the guest or host is destroyed/detached.
- The real Electron harness confirms the visible renderer tab resolves to the exact opaque tab ID used by the controller.

Verification after the first WP2 checkpoint:

- Focused runtime/preload/renderer unit tests: 26 passing.
- Full unit suite: 167 suites and 3,194 tests passing; 3 suites and 10 tests skipped as before.
- Full ESLint run: clean.
- Complete automation Electron matrix with real identity binding: 6 of 6 scenarios passing across 3 consecutive runs.

The next WP2 package should add controlled-tab ownership and route controller navigation through the existing renderer navigation pipeline, using this binding to target the correct background or foreground tab without exposing a general renderer automation API.

Security hardening checkpoint after external branch review:

- Automation navigation now uses an explicit allowlist: `http:`, `https:`, `bzz:`, `ipfs:`, and `ipns:`. Internal/privileged and unimplemented schemes fail validation instead of falling through a short blocklist.
- URLs containing embedded username/password credentials are rejected so credentials cannot be echoed through tab state or automation results.
- Private windows do not attach the automation observer, keeping their tab existence, URLs, titles, snapshots, and screenshots outside the default automation context.
- The runtime independently classifies every direct, desktop, and popup WebContents before registration. Private pages are rejected, and classification failures fail closed.
- Real Electron coverage loads a private page fully and confirms it never appears in `browser_list_tabs`.

Verification after the security hardening checkpoint:

- Full unit suite: 167 suites and 3,207 tests passing; 3 suites and 10 tests skipped as before.
- Full ESLint run: clean.
- Supported-scheme navigation and private exclusion: 6 of 6 Electron scenarios passing across 3 consecutive runs.

Second security hardening checkpoint on the same branch:

- Validation failures no longer echo non-string, untrusted `tabId` input into public error envelopes.
- Text waits treat execution-context loss during an observed navigation as a transient condition and continue polling, while unrelated execution failures still surface.
- Text insertion verifies that the referenced editable element retained focus before Electron inserts trusted text, preventing focus-redirection races.
- Clicks revalidate the referenced element and its hit-tested coordinates after trusted pointer movement, before mouse-down and mouse-up are dispatched.
- The real Electron fixture confirms a focus-redirecting input fails closed and receives no inserted text.

Verification after the second security hardening checkpoint:

- Focused automation unit tests: 38 passing.
- Full unit suite: 167 suites and 3,210 tests passing; 3 suites and 10 tests skipped as before.
- Full ESLint run: clean.
- Automation Electron matrix: 6 of 6 scenarios passing across 3 consecutive runs.

Second WP2 checkpoint on the same branch:

- `browser_navigate` for a bound desktop tab now crosses a narrow main-to-chrome request channel and invokes the existing renderer `loadTarget` pipeline against that exact webview. Hidden/runtime pages continue to call Electron directly through the same adapter contract.
- The main process resolves the opaque automation tab to its previously verified `(host renderer, renderer tab)` binding, accepts acknowledgements only from that host, and waits for the guest's actual main-frame navigation outcome.
- Controlled navigation can target a background tab without activating it or overwriting the foreground tab's address bar; selecting the target later reveals the renderer-maintained final display URL.
- Desktop `browser_stop_loading` follows the same ownership boundary, cancelling renderer-owned Swarm probes as well as the guest load and settling a pending navigation with `USER_CANCELLED`.
- Renderer requests fail closed before tab binding, on malformed payloads, on rejected dispatch, on tab/window destruction, and on a bounded timeout. No renderer or Electron routing IDs enter the public automation result.

Verification after the second WP2 checkpoint:

- Focused automation/runtime/preload/navigation unit tests: 128 passing.
- Full unit suite: 167 suites and 3,215 tests passing; 3 suites and 10 tests skipped as before.
- Full ESLint run: clean.
- Foreground/background desktop navigation, direct hidden navigation, trusted actions, waits, and cancellation: 6 of 6 Electron scenarios passing across 3 consecutive runs.

Next: define the first supported runtime lifecycle and transport boundary for the CLI work packages, while continuing semantic hardening behind the same controller contract.

First WP3 checkpoint on the same branch:

- `--runtime` starts Freedom's normal Electron main process and protocol/session stack without creating desktop chrome or any visible BrowserWindow. `window-all-closed` does not terminate this persistent mode.
- Runtime launches default to a separate catalog profile named `automation`; an explicit `--profile` or `--profile-dir` still takes precedence, and the existing profile lock remains authoritative.
- A profile-scoped discovery document advertises a versioned JSONL endpoint over a private Unix socket or Windows named pipe. Endpoint types and protocol payloads contain no Electron-specific public types.
- Every client must complete protocol-version negotiation and authenticate with a random 256-bit token read from a mode-`0600` profile file. Discovery contains only the token path, never the token value.
- Requests are bounded to 1 MiB, unauthenticated clients fail closed, token comparison is timing-safe, and public transport errors do not echo credentials or arbitrary method names.
- Authenticated clients can query readiness, execute the canonical automation controller, and request graceful runtime shutdown. Shutdown stops accepting clients, marks discovery stopped, clears the credential file, closes databases/nodes, and releases the existing profile lock.

Verification after the first WP3 checkpoint:

- Full unit suite: 168 suites and 3,221 tests passing; 3 suites and 10 tests skipped as before.
- Full ESLint run: clean.
- Real Electron runtime lifecycle: 3 consecutive launches with zero BrowserWindows, authenticated handshake, controller execution, and graceful protocol-driven shutdown passing.

Second WP3 checkpoint on the same branch:

- The canonical controller now owns `browser_create_tab` and `browser_close_tab` lifecycle operations. Creation accepts the same bounded, credential-free URL schemes as navigation; closure can affect only pages owned by the runtime lifecycle.
- Runtime-created pages are non-visible, paint-capable Electron `BrowserWindow`s with context isolation, no Node integration, and Chromium sandboxing. They register with the shared automation registry before navigation, so their public IDs remain opaque and their page operations use the same adapter as desktop tabs.
- Hidden pages use the active profile's existing default session, preserving Freedom protocol, permission, network, and storage behavior without exposing Electron types in the controller or transport contract.
- Closing a page, page destruction, failed initial navigation, and runtime shutdown all remove lifecycle ownership and registry state. Desktop mode does not install this lifecycle, so external callers cannot create or close desktop tabs through it.
- A real Electron runtime test now performs multiple authenticated commands against one process: it creates two pages, snapshots one, captures the other, closes only the selected tab, observes the remaining tab, and then shuts down cleanly.

Verification after the second WP3 checkpoint:

- Focused automation unit tests: 6 suites and 50 tests passing.
- Full unit suite: 169 suites and 3,225 tests passing; 3 suites and 10 tests skipped as before.
- Full ESLint run: clean.
- Real Electron hidden-page lifecycle: 3 consecutive authenticated create/snapshot/screenshot/close/shutdown runs passing.

Next: define runtime-wide idle accounting across clients, pages, downloads, and node operations before exposing the first CLI client; crash cleanup and Freedom-specific protocol coverage are completed below.

Popup containment hardening after the second external branch review:

- Every hidden runtime page now installs an explicit window-open policy before navigation. Unsupported popup schemes are denied; supported popups are created through a main-process override that forces `show: false`, context isolation, no Node integration, and Chromium sandboxing even when page-supplied window features request otherwise.
- Runtime popups are adopted into the same hidden-page ownership map at creation time. They receive opaque `popup` tab IDs, support the canonical observation/action contract, can be closed through `browser_close_tab`, and are reaped by runtime lifecycle cleanup.
- Real Electron coverage opens a popup with hostile visibility and web-preference features, verifies that both windows remain hidden and sandboxed, closes the popup through the authenticated transport, and observes only its opener afterward.

Transport concurrency hardening after the second external branch review:

- Authenticated JSONL requests on one connection may be in flight concurrently, and responses are correlated by their required request IDs rather than arrival order. This lets `browser_stop_loading`, `runtime.status`, and `runtime.shutdown` remain reachable while a navigation or declarative wait is pending.
- Authentication remains sequenced synchronously: a valid handshake can be followed by requests in the same packet, while a missing, invalid, or timed-out handshake closes that connection to further requests after returning its typed failure.
- The 1 MiB request bound applies to each newline-delimited message. A batch of individually valid small messages no longer trips an aggregate buffer limit.
- Unit coverage holds a navigation request open and proves stop-loading and status complete on the same authenticated connection before the navigation settles. The real Electron runtime client now matches responses by request ID.

Runtime launch and stale-discovery hardening after the second external branch review:

- Runtime profile initialization and profile-lock conflicts now emit one machine-readable `freedom.runtime.error` record and use distinct nonzero process exits. `PROFILE_LOCKED` exits with code `11` and includes the selected profile plus discovery state/path; desktop focus-and-exit behavior is unchanged.
- A bounded discovery inspector validates the private file shape, schema, profile identity, endpoint/token-path relationship, advertised state, PID shape, and process liveness. It classifies metadata as `missing`, `invalid`, `stale`, or its advertised live/terminal state without deleting or trusting the endpoint.
- After acquiring the profile lock, runtime startup may remove a stale Unix socket only when discovery is valid and stale, the path is inside Freedom's private socket root, its filename carries the selected profile hash, and the target is a same-user socket rather than a link. Invalid, live, named-pipe, missing, foreign, and out-of-root targets are left untouched.
- PID liveness is only a recovery hint. A future CLI must still connect, negotiate the protocol version, and authenticate before treating a `ready` discovery record as a compatible runtime.
- Real Electron coverage launches a second runtime against the locked test profile and verifies exit `11` plus a `PROFILE_LOCKED` record pointing to the live discovery document.

Freedom-protocol runtime coverage:

- The persistent runtime E2E seeds deterministic content into Freedom's registered `bzz:`, `ipfs:`, and `ipns:` session handlers, then creates, snapshots, and closes a hidden page for each protocol through the authenticated JSONL transport.
- Every snapshot preserves the native Freedom URL and renders the protocol fixture in the same runtime/context, demonstrating that headless pages reuse the real profile session and main-process protocol stack rather than a separate automation browser backend.

Verification after the second external branch review:

- Full unit suite: 169 suites and 3,229 tests passing; 3 suites and 10 tests skipped as before.
- Full ESLint run: clean.
- Complete authenticated runtime lifecycle, popup containment, profile-lock reporting, and Swarm/IPFS/IPNS parity scenario: 3 consecutive real Electron runs passing.
- Adjacent desktop/hidden automation-kernel and private-window regression coverage: 9 of 9 real Electron scenarios passing.

Runtime-wide idle accounting checkpoint:

- A single main-process idle controller owns the default 15-minute countdown and publishes its state through runtime discovery/status. `--persistent` disables automatic shutdown without changing the transport or browser contract.
- Authenticated connections and in-flight requests hold counted leases. Unauthenticated sockets do not extend process lifetime, and a request remains a blocker if its client disconnects before the operation settles.
- Hidden-page and popup creation/closure reset activity without making open tabs permanent blockers. This preserves tab/session reuse during the idle window while still allowing an abandoned runtime to stop.
- Active Chromium downloads and Ant/IPFS/Radicle/Tor start/stop transitions are fail-closed probes. Download lifecycle notifications restart the full countdown when a transfer starts or settles; a busy/erroring probe defers shutdown until tracked work finishes.
- Shutdown stops idle accounting before closing the transport, pages, databases, and node processes, preventing cleanup-driven activity from rearming the timer.

Verification after the idle-accounting checkpoint:

- Full unit suite: 170 suites and 3,235 tests passing; 3 suites and 10 tests skipped as before.
- Full ESLint run: clean.
- Complete authenticated runtime, popup, protocol, profile-lock, and idle-status lifecycle: 3 consecutive real Electron runs passing.

First WP4 checkpoint on the same branch:

- A dependency-free Node CLI is exposed as the repository-local `freedom-cli` package binary. It imports no Electron modules or Electron public types; runtime launch is a child-process concern and Electron remains inside the runtime.
- `freedom-cli runtime start|status|stop`, `tabs list|open|get|close`, and `page snapshot|navigate|click|type|wait|screenshot|stop` map onto the existing authenticated runtime and canonical kernel operations. Normal browser commands auto-start an idle-managed runtime; explicit `runtime start` requests persistent mode.
- The client locates the dedicated automation profile without mutating its catalog, validates private bounded discovery/token files, authenticates protocol version 1, and correlates concurrent JSONL responses by request ID.
- Stable success/error JSON envelopes and stable process exits cover usage, unavailable runtime, profile lock, authentication, protocol mismatch, command failure, and unexpected internal failure. Stdout carries successful results; stderr carries failures.
- Screenshot output is explicit, private, refuses overwrite by default, and does not follow a final symlink. `--force` is required for replacement.
- The canonical operation identifiers and runtime protocol/path constants now live in shared modules consumed by both the kernel/runtime and CLI.

Verification after the first WP4 checkpoint:

- Full unit suite: 174 suites and 3,246 tests passing; 3 suites and 10 tests skipped as before.
- Full ESLint run: clean.
- Real Electron CLI lifecycle and page-chain coverage: 2 of 2 scenarios passing. The CLI starts/statuses/stops a persistent runtime and completes open/get/snapshot/type/click/wait/navigate/screenshot/close through the real hidden Freedom page adapter.

CLI correctness hardening after external review:

- `page wait` now derives its default transport deadline from the operation timeout plus a five-second completion margin. A valid 30-second wait can therefore return the kernel's typed, retryable `WAIT_TIMEOUT` instead of losing to the client's generic request timeout. An explicit global `--timeout` remains an intentional caller override.
- Concurrent auto-start is idempotent from the caller's perspective. When a spawned runtime loses the profile lock with exit 11, the CLI keeps attempting authenticated attachment for a bounded two-second grace period before reporting a genuine profile conflict.
- Runtime process exit codes and browser wait timing limits are shared contract constants consumed by main and CLI rather than aligned by convention.
- Deterministic unit coverage proves maximum/default wait deadlines, explicit timeout override behavior, genuine profile-lock reporting, and attachment to a winning concurrent runtime. Real Electron coverage launches two simultaneous `runtime start` commands and verifies both return the same runtime ID.

Verification after CLI correctness hardening:

- Full unit suite: 174 suites and 3,248 tests passing; 3 suites and 10 tests skipped as before.
- Full ESLint run: clean.
- Real Electron concurrent-start lifecycle and complete CLI page chain: 2 of 2 scenarios passing.

Remaining WP4 work is intentionally deferred: installed-runtime discovery and distribution, Windows/Linux command-level coverage, TTY-aware human output, streaming JSONL events, explicit ephemeral ownership, configurable idle/start policy, richer help/version metadata, and the broader evaluation corpus.

Next: freeze CLI productization at this working local checkpoint and use the kernel directly for the embedded Pi slice.

## Fresh Pi integration assessment — 2026-08-22

This assessment intentionally replaces the months-old Pi prototype as the implementation basis.

### Current SDK facts

- Pi's supported embedding surface is `createAgentSession()` from [`@earendil-works/pi-coding-agent`](https://pi.dev/docs/latest/sdk). Direct SDK embedding is preferred for a Node application that needs typed access and custom tools; Pi RPC is unnecessary for the first Freedom slice.
- The current package on Pi's main branch is `0.84.2`, ESM-only, MIT licensed, and requires Node `>=22.19.0`. Freedom currently uses Electron 43, whose embedded Node 24 satisfies that engine floor. Freedom's CommonJS main process will need a narrow dynamic-import boundary rather than top-level `require()`.
- `ModelRuntime` supports non-persistent runtime API keys and injected credential stores. Freedom should use its own encrypted credential service and an in-memory Pi credential store; it should not read or write the user's global `~/.pi/agent/auth.json`.
- `AgentSession` provides streaming lifecycle/tool events, `abort()`, `dispose()`, and an unsubscribe function. These map cleanly onto sidebar streaming, Stop, and window/app teardown.
- `defineTool()` supports custom tools with abort signals. The initial tool adapter can call `automationController.execute()` directly and pass cancellation into operations that can block.
- Pi's defaults discover extensions, skills, prompt templates, settings, and `AGENTS.md`, and enable coding tools. Freedom must instead provide a fully explicit no-discovery `ResourceLoader`, an in-memory `SettingsManager`, an in-memory `SessionManager` for the spike, `noTools: "builtin"`, and a browser-tool allowlist. No shell, filesystem, Pi package, project instruction, or arbitrary extension capability enters the product agent.
- Ollama and other OpenAI-compatible local servers are supported through custom model configuration. Tool quality varies by model, and compatibility flags such as `supportsDeveloperRole: false` or `supportsReasoningEffort: false` may be required. Local-model support therefore needs a qualified-model matrix, not a blanket promise.

Primary references: [Pi SDK](https://pi.dev/docs/latest/sdk), [full-control SDK example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/12-full-control.ts), [providers](https://pi.dev/docs/latest/providers), [custom/local models](https://pi.dev/docs/latest/models), [extensions and tool lifecycle](https://pi.dev/docs/latest/extensions), [sessions](https://pi.dev/docs/latest/sessions), [Pi package metadata](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/package.json), and [Electron 43 runtime versions](https://www.electronjs.org/blog/electron-43-0).

### First embedded vertical slice

The first slice should prove this exact user journey:

1. The user opens an **Agent** sidebar tab on an ordinary non-private Freedom window.
2. The user selects one configured model and enters a high-level task for the current tab.
3. Main resolves the initiating renderer tab through the existing verified renderer-tab-to-automation-tab binding and pins the run to that opaque automation tab ID.
4. A main-process `FreedomAgentService` creates one isolated Pi `AgentSession` with Freedom's system prompt and browser-only custom tools.
5. Pi streams assistant text and normalized tool lifecycle events to the trusted chrome renderer.
6. Browser tools call the canonical policy/automation controller directly; they never call the CLI, local socket, or page-content JavaScript bridge.
7. Stop awaits `session.abort()`, cancels the currently blocking browser operation, then disposes the run cleanly.
8. The final UI state clearly distinguishes success, user cancellation, model/provider failure, policy denial, stale references, and lost tabs.

Initial tool set:

- snapshot the pinned tab
- navigate the pinned tab
- click a semantic reference
- type into a semantic reference
- wait for load/navigation/text/URL
- stop loading

Tab creation/closure, screenshots-as-model-input, downloads, uploads, wallet actions, node controls, arbitrary skills, subagents, and persistent conversation history are explicitly outside the first slice.

### Proposed process and trust boundary

```text
Trusted Freedom chrome renderer
  Agent sidebar: prompt, progress, stop, provider setup
                    │ narrow validated IPC
                    ▼
Freedom main process
  FreedomAgentService
    ├─ dynamic Pi SDK boundary
    ├─ encrypted Freedom credential service → in-memory Pi credentials
    ├─ no-discovery resources + in-memory settings/session
    ├─ normalized safe UI events
    └─ Freedom browser tools
             │ direct internal calls
             ▼
  policy controller → automation controller → visible desktop tab adapter
```

Run Pi in the main process for the first slice, behind a service interface. This is the shortest path to the existing controller, verified desktop-tab binding, and app lifecycle, and the dangerous default Pi capabilities will be absent. Keep the service boundary narrow enough to move the harness into an Electron utility process later if crash isolation, memory pressure, provider SDK behavior, or security review warrants it. That extraction is a hardening option, not a prerequisite for learning whether the product is valuable.

### Credential and provider boundary

- The renderer may submit a new key once for storage, but it never receives stored key material back. It receives only provider/model metadata and configured/test status.
- Main encrypts hosted-provider keys with Electron `safeStorage`, binds the record to the active Freedom profile, uses restrictive file permissions, and decrypts only when constructing the in-memory credential runtime.
- Freedom does not reuse Pi's global auth file, shell-command key resolution, or ambient provider UI. A selected hosted provider must have an explicitly configured Freedom credential before a run begins, even if a matching environment variable exists.
- The shared hosted-provider abstraction and redaction tests now cover OpenAI, Anthropic, OpenRouter, and the fixed Free Pi pilot endpoint, alongside one Ollama reference path. Additional custom endpoints remain out of scope until their SSRF, proxy, certificate, and credential-forwarding policy is explicit.
- Local endpoints must be explicit loopback HTTP(S) URLs in V1. Do not permit arbitrary remote custom endpoints until SSRF, proxy, certificate, and credential-forwarding policy is designed.

### Free Pi pilot qualification — 2026-08-22

The fixed Free Pi pilot endpoint is integrated and its basic embedded text-response smoke passes with the configured `deepseek/deepseek-v4-flash` model. It is **not yet qualified as a Freedom browser-agent provider**:

- The deterministic visible-form evaluation settled as `Complete` in 21.6 seconds but left the page untouched, made zero tool calls, and returned an unrelated clarification question.
- Direct OpenAI-compatible protocol probes reproduced the behavior outside Freedom. The endpoint ignored an advertised `browser_snapshot` function with `tool_choice: auto`, `required`, and an explicitly forced function choice, returning plain text with `finish_reason: stop` each time.
- The authenticated `/models` catalog currently advertises only `deepseek/deepseek-v4-flash`, so there is no alternative tool-capable Free Pi model to select.

This is an upstream model-route capability gap, not evidence of a Freedom controller or Pi adapter failure. Keep the basic live text smoke available when credentials are present, and keep the browser-control qualification behind the explicit `FREEDOM_FREE_PI_AGENT_EVAL=1` opt-in so normal verification remains green while preserving a one-command recheck. Free Pi does not satisfy the hosted-provider acceptance gate until that evaluation passes without Freedom-specific fallback parsing.

### ChatGPT/Codex subscription checkpoint — 2026-08-22

The first subscription-auth provider path is implemented as an explicitly experimental option named **ChatGPT (Codex)**:

- Freedom uses Pi's built-in `openai-codex` provider and current bundled model catalog rather than hardcoding model IDs.
- The sidebar starts Pi's device-code login flow, opens the fixed OpenAI verification page in the system browser, shows only the bounded user code, and supports cancellation.
- OAuth access/refresh credentials never cross into the renderer. An app-owned Pi `CredentialStore` encrypts them with Electron `safeStorage`, binds them to the active Freedom profile, serializes token refreshes, and clears them on disconnect.
- `ModelRuntime` receives that injected credential store on every catalog/login/run path. Freedom does not read or write `~/.pi/agent/auth.json` or a plaintext substitute.
- Trusted-chrome IPC normalizes the only renderer-visible auth event, rejects spoofed verification URLs and malformed codes, redacts unexpected provider failures, and aborts login if the owning renderer disappears.
- Existing version-1 API-key/Ollama provider records remain readable and are upgraded on the next write.

Verification at this checkpoint:

- Focused provider/store/IPC/preload/sidebar tests: 51 passing.
- Full unit suite: 183 suites and 3,326 tests passing; 3 suites and 10 tests skipped as before.
- Full ESLint run: clean.
- Real bundled Pi smoke: `openai-codex` is present with seven catalog models and accepts the injected credential-store contract without using Pi file auth.
- Real Electron sidebar E2E: provider selection, experimental subscription copy, model population, hidden API-key field, and connect action all pass.

Remaining release qualification is deliberately explicit:

1. Obtain and record a clear commercial-distribution policy answer before treating subscription reuse as a generally available Freedom feature. Pi and OpenAI's Codex-for-OSS material establish technical support and OSS-program usage, but do not by themselves settle commercial embedding terms.

### ChatGPT/Codex subscription qualification — 2026-08-22

The experimental subscription path is now technically qualified end to end with a real ChatGPT account and Pi's bundled `openai-codex/gpt-5.6-sol` model:

- Interactive device login completed successfully through the real sidebar, with the OAuth credential retained only in Freedom's profile-bound encrypted store.
- The first attempted run exposed a real activation bug: `ModelRuntime` was intentionally created with `refreshOnCreate: false`, but the subscription resolver consulted Pi's synchronous auth snapshot before populating it. A provider-scoped `refresh({ allowNetwork: false })` now synchronizes stored OAuth availability without enabling model-catalog network refresh.
- The reusable live harness launches Freedom normally and attaches Playwright over a loopback Chromium debugging endpoint. Playwright's Electron driver could not decrypt macOS `safeStorage` ciphertext created by a normal Freedom launch, so it is intentionally not used for named-profile credential qualification. The harness neither copies nor prints the credential.
- A separate disposable profile exercises device-polling cancellation without modifying the authenticated profile.

Recorded five-case qualification result:

- Device-code polling cancellation: pass, settled in 19 ms, disposable profile remained unconfigured.
- Deterministic visible form: pass in 21.1 seconds; six successful operations (`get tab`, `snapshot`, two `type`, `click`, `snapshot`), exact confirmation returned, and page-observed input/click events were trusted.
- Real model-stream Take over: pass, settled in 34 ms.
- Real 30-second declarative-wait Take over: pass, settled in 48 ms.
- Public `https://example.com/` read-only task: pass in 4.9 seconds with two successful observation operations and the correct heading/purpose returned.
- Complete opt-in suite: 5 of 5 real subscription scenarios passing in one minute.
- Full unit suite: 183 suites and 3,329 tests passing; 3 suites and 10 tests skipped as before.
- Full ESLint run: clean.

This satisfies the technical hosted-provider acceptance gate for the current alpha reference path. The feature remains labeled experimental until commercial embedding/distribution policy is resolved, and broader reliability claims still require the planned deterministic corpus rather than these first representative tasks alone.

### First-slice acceptance gates

- One real high-level task completes against a deterministic local website and one live public website in a visible, marked Freedom tab.
- Every Pi tool call traverses the existing policy controller and canonical operation validation.
- Built-in Pi tools and all local discovery sources are absent, proven by unit tests inspecting the session tool/resource set.
- Provider keys are never present in renderer state, events, logs, errors, snapshots, or persisted Pi files.
- Stop reaches a settled UI state promptly during model streaming, browser navigation, and declarative wait.
- Switching the foreground tab does not silently redirect the active run; closing or taking over the pinned tab stops/pauses with a clear state.
- Existing non-agent browsing and the repository-local `freedom-cli` regression suites remain green.

## Goals

### G1 — One browser-control contract

The embedded Pi agent, CLI commands, and MCP tools call the same controller methods with the same schemas and error vocabulary.

### G2 — Real Freedom parity

Headless sessions must use Freedom's real protocol and session behavior, including HTTP(S), Swarm, IPFS/IPNS, Radicle, Tor, request policy, downloads, profiles, and node configuration.

Feature parity does not mean bypassing user-presence requirements. Wallet signing, payments, destructive operations, passkeys, MFA, and native OS prompts retain explicit approval or takeover boundaries.

### G3 — Semantic agent control

Agents operate primarily through semantic page snapshots and stable element references, with screenshots as a complementary observation channel. Coordinate-only automation is a fallback, not the core contract.

### G4 — Safe autonomy

Every tool call passes through Freedom's policy controller. Page content, external agent input, Pi extensions, and MCP metadata are untrusted inputs.

### G5 — Optional external integration without architectural fork

If external integration is later validated, shell and/or MCP clients reuse the same canonical controller and policy boundary. That option remains open without being a first-version requirement.

### G6 — Observable and cancellable work

Users can see what the embedded agent is doing, stop it promptly, take over a tab, and understand which actions were completed, denied, or left pending.

## Non-goals for the first public version

- A remote multi-tenant browser cloud.
- Exposing the runtime on a public network interface.
- A general shell or filesystem agent.
- Arbitrary Pi extension/package execution.
- Silent wallet signing or unlimited autonomous payments.
- Circumventing CAPTCHA, MFA, passkeys, anti-bot systems, or legal attestations.
- Perfect compatibility with every webpage on the first release.
- A public JavaScript SDK unless a concrete consumer needs direct embedding.
- Running the same persistent profile concurrently in desktop and headless processes.

## Safety invariants

1. **All adapters converge on the policy controller.** CLI, MCP, and Pi cannot call page or wallet primitives directly.
2. **Stop must work.** Cancellation reaches the active model request, pending tool, browser wait, subagent, and page operation.
3. **No default coding tools.** Embedded Pi gets no shell, arbitrary filesystem read/write, or project extension auto-discovery.
4. **Provider credentials never enter page content, renderer state, command output, logs, or conversation transcripts.**
5. **Page content is untrusted.** Prompt injection cannot grant capabilities or change approval policy.
6. **References are scoped.** An element reference is bound to runtime, profile, tab, frame, origin, and navigation generation.
7. **Stale actions fail closed.** Navigation invalidates prior page references.
8. **Sensitive actions have commit-boundary approval.** Filling a form and submitting it are separate risk decisions.
9. **Wallet and payment actions expose exact decoded intent.** Destination, chain, value, fees, calldata meaning, and budget impact are shown before approval.
10. **Headless does not mean approval-free.** Without an authorized approval channel, an approval-required operation returns a typed pending/denied result.
11. **Private behavior stays private.** No private-window history, URL, screenshot, page text, or task transcript leaks to persistent logs or normal sessions.
12. **No ambient remote listener.** Local HTTP transport, if ever enabled, binds to loopback and requires authentication and origin validation.
13. **Profile locks remain authoritative.** The CLI does not copy or force-open a locked desktop profile.
14. **Machine-readable output is clean.** Protocol results go to stdout; diagnostics go to stderr.

## Canonical automation contract

One schema source must generate or validate all three adapters.

The public contract must use opaque Freedom identifiers and runtime-neutral concepts. Electron values such as `webContentsId`, `Session`, `BrowserWindow`, and partition implementation details may exist inside V1 adapters, but must never appear in CLI output, MCP schemas, canonical operations, or persisted automation events.

Suggested package boundary:

```text
src/main/automation/
  contract/
    operations.js
    events.js
    errors.js
    schemas.js
  automation-controller.js
  policy-controller.js
  tab-registry.js
  page-session.js
  reference-store.js
  snapshot-service.js
  action-service.js
  runtime-server.js
  adapters/
    desktop-webview-adapter.js
    headless-webcontents-adapter.js

src/main/agent/
  freedom-agent-service.js
  pi-session-factory.js
  pi-tool-adapter.js

src/cli/
  cli-adapter.js
  mcp-adapter.js
```

Exact placement requires an architecture-boundary review before implementation. The important constraint is one contract and one policy path, not these precise filenames.

### Initial operations

#### Runtime and context

- `runtime_status`
- `context_create`
- `context_list`
- `context_close`

#### Tabs

- `browser_list_tabs`
- `browser_create_tab`
- `browser_close_tab`
- `browser_switch_tab`
- `browser_get_tab`

#### Observation

- `browser_snapshot`
- `browser_screenshot`
- `browser_get_page_text`
- `browser_get_navigation_state`

#### Interaction

- `browser_navigate`
- `browser_click`
- `browser_type`
- `browser_select`
- `browser_press`
- `browser_scroll`
- `browser_wait`
- `browser_stop_loading`

#### Transfers

- `browser_list_downloads`
- `browser_wait_for_download`
- `browser_upload_file` — deferred until a scoped file authority model exists

Operation names may be shortened at the CLI layer, but canonical identifiers should remain stable for MCP, Pi, logs, tests, and compatibility negotiation.

### Result envelope

Every operation returns a consistent envelope:

```json
{
  "ok": true,
  "runtimeId": "runtime_01",
  "contextId": "context_01",
  "tabId": "tab_7f91",
  "navigationId": 18,
  "result": {}
}
```

Failures are typed and agent-recoverable where possible:

```json
{
  "ok": false,
  "error": {
    "code": "STALE_ELEMENT_REFERENCE",
    "message": "The page navigated after this reference was created",
    "retryable": true,
    "suggestedAction": "Take a new snapshot"
  }
}
```

Initial error vocabulary:

- `INVALID_ARGUMENT`
- `RUNTIME_NOT_READY`
- `PROFILE_LOCKED`
- `CONTEXT_NOT_FOUND`
- `TAB_NOT_FOUND`
- `NAVIGATION_FAILED`
- `NAVIGATION_TIMEOUT`
- `STALE_ELEMENT_REFERENCE`
- `ELEMENT_NOT_FOUND`
- `ELEMENT_NOT_INTERACTABLE`
- `UNSUPPORTED_PAGE_STATE`
- `APPROVAL_REQUIRED`
- `POLICY_DENIED`
- `USER_CANCELLED`
- `WAIT_TIMEOUT`
- `CAPABILITY_UNAVAILABLE`
- `PROTOCOL_SERVICE_UNAVAILABLE`
- `INTERNAL_ERROR`

### Event stream

Long-running work uses structured events:

- `runtime_ready`
- `context_created`
- `tab_opened`
- `navigation_started`
- `navigation_committed`
- `navigation_finished`
- `page_changed`
- `download_started`
- `download_progress`
- `download_finished`
- `approval_requested`
- `approval_resolved`
- `operation_started`
- `operation_finished`
- `operation_failed`
- `runtime_stopping`

CLI streaming uses JSONL. MCP uses notifications or progress mechanisms supported by the chosen MCP SDK version. The embedded agent maps the same events into its visible timeline.

## Semantic page model

### Snapshot shape

`browser_snapshot` should return a compact accessibility-oriented tree rather than raw HTML by default:

```text
Document "Account settings" url=https://example.com/settings
  heading "Profile" level=1
  textbox "Email" value="hello@example.com" ref=e12
  button "Save changes" ref=e13
  link "Delete account" ref=e14
```

Each actionable reference records:

- runtime ID
- context ID
- tab ID
- frame ID
- origin
- navigation generation
- backend node identity or equivalent
- semantic role and accessible name
- optional geometry
- creation timestamp

### Interaction strategy

Preferred action sequence:

1. Resolve the scoped reference.
2. Confirm navigation generation and frame identity.
3. Scroll the element into view.
4. Use trusted input dispatch where possible.
5. Wait for expected page effects.
6. Return the resulting navigation/page generation.

JavaScript `element.click()` is a compatibility fallback because some sites require trusted input events.

### Frames, shadow DOM, and popups

The snapshot implementation must eventually handle:

- same-origin and cross-origin iframes
- shadow DOM
- browser-generated controls
- popup windows and `target=_blank`
- SPA in-page navigation
- loading and detached frames

V1 may document partial limitations, but must fail explicitly rather than silently acting on the wrong frame.

## Runtime lifecycle

### Auto-start

If `freedom-cli` is productized later, most commands should transparently start the runtime if it is not already running:

```text
freedom-cli page snapshot
        │
        ├─ runtime alive → connect
        └─ no runtime    → launch, authenticate, wait for ready, connect
```

Explicit lifecycle commands remain available for CI and debugging:

```bash
freedom-cli runtime start --profile agent-work
freedom-cli runtime status --json
freedom-cli runtime stop
```

### Local transport

- Unix domain socket on macOS/Linux.
- Named pipe on Windows.
- Random per-runtime authentication token.
- User-only filesystem permissions for discovery/token files.
- Protocol version negotiation between adapter and runtime.
- No unauthenticated TCP listener.

### Idle behavior

Default proposal:

- Auto-start on demand.
- Remain alive while clients, tasks, downloads, or node operations are active.
- Stop after a configurable idle period, initially 15 minutes.
- `--ephemeral` stops when the owning CLI/MCP process exits.
- `--persistent` remains until explicit stop or OS shutdown.

### Linux headless behavior

The V1 Freedom runtime uses Electron/Chromium. On display-less Linux machines, the installer or container image must provide a supported virtual display path such as Xvfb until Electron provides a reliable native headless mode for this use case.

## Profile and browser-context model

### Defaults

- CLI defaults to a dedicated automation profile, not the user's active desktop profile.
- The default context is persistent within that automation profile.
- `--ephemeral-context` creates a non-persisted session for research or untrusted browsing.
- Wallet and identity capabilities are off by default in ephemeral contexts.

### Existing desktop profile

The runtime must not force-open a locked profile. Two supported paths are envisioned:

1. Start a separate automation profile.
2. Later, attach to a running desktop Freedom process through its authenticated local automation endpoint.

Attaching is preferable to copying browser profile data. Copying live cookies, SQLite files, local storage, wallet state, or node directories is unsafe and risks corruption.

### Controlled tabs

In the desktop UI:

- Controlled tabs are visibly marked.
- Human input pauses the agent or initiates an explicit takeover.
- Agent and human input never race silently.
- A task can be scoped to the current tab or to a dedicated task tab.

## Experimental CLI design

This section records the current local adapter and possible future product shape. It is not on the critical path for the embedded agent.

### Command hierarchy

Proposed shape:

```bash
freedom                         # open desktop UI; unchanged

freedom-cli runtime start
freedom-cli runtime status
freedom-cli runtime stop

freedom-cli context create
freedom-cli context list
freedom-cli context close

freedom-cli tabs list
freedom-cli tabs open --url 'ipfs://...'
freedom-cli tabs close --tab tab_7f91

freedom-cli page snapshot --tab tab_7f91
freedom-cli page navigate --tab tab_7f91 --url 'https://example.com'
freedom-cli page click --tab tab_7f91 --ref e12
freedom-cli page type --tab tab_7f91 --ref e13 --text 'hello'
freedom-cli page wait --tab tab_7f91 --until network-idle --timeout 30s
freedom-cli page screenshot --tab tab_7f91 --output screenshot.png

freedom-cli task run 'Research topic X and produce a summary'  # deferred
freedom-cli task cancel --task task_01                         # deferred
freedom-cli task status --task task_01                         # deferred

freedom-cli mcp --profile agent-work                           # deferred
```

The final nouns should be tested with real human and agent usage before being frozen.

### Output rules

- Human-readable output when attached to an interactive terminal.
- JSON by default when stdout is not a TTY.
- `--json` always forces one complete JSON result.
- `--jsonl` enables event streaming.
- `--quiet` suppresses non-result diagnostics.
- Logs and progress diagnostics go to stderr.
- Secrets and raw provider credentials are never emitted.
- Exit codes distinguish usage, runtime, policy, page, timeout, and internal failures.

### Non-interactive approvals

Commands never hang on an invisible prompt.

If an operation needs approval and no approval UI/channel is attached, return `APPROVAL_REQUIRED` with a redacted, structured description of the requested action.

Later possibilities:

- `freedom-cli approvals list`
- `freedom-cli approvals approve <request-id>`
- task-scoped capability grants
- signed policy files for CI

None should allow a caller to self-grant a capability that the runtime policy forbids.

## Deferred MCP design

### V1 transport

If activated, use stdio:

```json
{
  "mcpServers": {
    "freedom": {
      "command": "freedom-cli",
      "args": ["mcp", "--profile", "agent-work"]
    }
  }
}
```

The MCP process may own an ephemeral runtime or attach to a persistent one.

### Tool design

- Publish canonical operation schemas directly.
- Return both structured content and concise text summaries for compatibility.
- Return screenshots as image content when supported.
- Mark read-only, destructive, idempotent, and open-world hints accurately, while still treating client-provided annotations as untrusted.
- Keep tools medium-grained. Do not expose raw CDP or arbitrary JavaScript evaluation.
- Report recoverable tool failures inside tool results so agents can correct and retry.

### Deferred Streamable HTTP

Potential later use cases:

- multiple local clients
- a desktop app accepting attach requests
- controlled remote sandbox deployments

Before enabling it:

- bind to loopback by default
- validate `Origin`
- require strong authentication
- add session ownership and rate limiting
- explicitly design remote-browser threat boundaries

## Embedded Pi integration

The proposed Pi integration boundary is:

> Pi owns the mechanics. Freedom owns the authority.

The embedded Pi adapter should:

- register only canonical Freedom tools
- disable Pi built-in coding tools
- disable arbitrary disk auto-discovery in the first release
- use a Freedom-specific system prompt
- route every tool through the shared policy controller
- preserve stop, renderer-disconnect, consent, and subagent-abort behavior
- map canonical automation events into the agent sidebar timeline
- keep provider credentials in Freedom-owned secure storage

This integration should be designed against the current Pi API and current Freedom architecture. Pi remains replaceable: no Pi-specific type, session primitive, or tool definition should become part of the automation kernel's public contract.

## Provider model

Initial embedded-agent providers:

- Ollama on loopback
- OpenAI API key
- Anthropic API key
- OpenRouter API key
- Advanced OpenAI-compatible endpoint

Rules:

- Credentials are profile-scoped and encrypted using OS-backed secure storage where available.
- Credentials are injected into the model runtime in memory.
- Custom endpoints are validated and require explicit setup confirmation.
- Local endpoints default to loopback.
- Provider/model capability metadata distinguishes text-only, vision, tool-use, reasoning, and context-window support.
- Tool conformance is tested; appearing in a model list is not sufficient for autonomous-browser support.

## Policy and approvals

### Task capability manifest

Each task receives a runtime-owned capability manifest:

```json
{
  "allowedOrigins": ["example.com", "payments.example.com"],
  "allowDownloads": true,
  "allowUploads": false,
  "allowExternalCommunication": false,
  "wallet": {
    "read": false,
    "sign": false,
    "send": false
  },
  "expiresAt": "task-end"
}
```

The model may request expansion. Only the user or an already-authorized policy channel may grant it.

### Suggested action classes

#### Read-only

- inspect page
- list tabs
- take screenshot
- read public page text
- inspect node status

Normally allowed within task scope.

#### Reversible interaction

- navigate
- open/close a task tab
- fill a field
- select an option
- scroll or expand content

Allowed according to context/origin scope, with visible activity in desktop mode.

#### External side effect

- submit a form
- post or send a message
- delete remote data
- upload a file
- create an account
- accept terms
- purchase an item

Approval at the commit boundary unless a narrow, explicit task grant exists.

#### Financial or identity action

- sign a message
- sign typed data
- send a transaction
- make an x402 payment
- publish identity-bound data
- buy or top up network resources

Exact decoded intent and value must be displayed. Transaction sends remain always-ask initially. Session-wide signing grants require a separate audit before public CLI/MCP exposure, especially for Permit-like typed data.

### Human takeover

Human control is a resumable interruption of the current task, distinct from terminal Stop. While Agent is running, trusted Freedom chrome interlocks the controlled page. Clicking it offers **Take over**; confirming retains the task and Pi conversation, unlocks the page, and turns the empty composer action into **Resume**. The runtime may also need to request human control for:

- CAPTCHA
- MFA
- passkeys/biometrics
- native credential prompts
- OS file pickers without pre-scoped file authority
- legal or factual attestations requiring the user
- ambiguous high-impact actions

After human control, Agent can resume only after revalidating the workspace, re-reading the current tab, and taking a fresh snapshot. An empty running composer is **Stop** and terminally cancels the current turn; entering text while running queues steering instead.

## Work packages

Work-package numbers preserve the history of the roadmap; they are not the current execution order. The active path is embedded-agent qualification and broader enforceable action coverage. WP2's custody, controlled-page interlock, Stop/steering/Take-over/Resume lifecycle, and the minimum WP6 slice are implemented. Direct guest-input inference is unnecessary for the current product model because trusted chrome mediates takeover before input reaches the page. WP3's runtime assets are retained, WP4 is paused at a useful local checkpoint, and WP5 is deferred.

The existing `feature/freedom-automation-kernel` branch remains the development branch for this product milestone. Continue making coherent commits there until the embedded Agent is genuinely useful, robust, and ready to present as a whole. Opening a PR is the handoff for review, not an intermediate project-management checkpoint. Create another branch only when a risky experiment, parallel effort, or independently reviewable change needs isolation.

### WP0 — Current-state validation and architecture lock

Goal: validate present-day assumptions and freeze the shared boundaries before implementation.

Tasks:

- Inventory the current mainline browser, session, profile, protocol, wallet, and renderer ownership boundaries relevant to automation.
- Revalidate the current Pi API, provider support, licensing, and MCP specification rather than relying on old notes.
- Record an ADR for automation ownership and process boundaries.
- Freeze canonical operation and error naming for the spike only.
- Define the first evaluation task set.
- Confirm dependency and licensing posture for the selected current Pi and MCP packages.

Exit criteria:

- Written current-state architecture inventory.
- Time-stamped external-dependency findings with links to primary sources.
- Approved architecture boundary.
- No ambiguity about whether the renderer, Pi, CLI, or controller owns an operation.

### WP1 — Automation-kernel vertical spike

Goal: prove one semantic controller can drive both a visible Freedom webview and a hidden direct WebContents.

Scope:

- Tab registration.
- Navigate.
- Semantic snapshot with scoped refs.
- Click.
- Type.
- Wait for navigation/page change.
- Screenshot.
- Cancellation.
- Typed stale-ref error.

Test matrix:

- HTTP fixture page.
- `bzz://` fixture page.
- `ipfs://` fixture page.
- one SPA interaction.
- one iframe interaction.
- one popup/new-tab interaction.

Exit criteria:

- The same operation contract passes against desktop and hidden adapters.
- No raw arbitrary-JS tool is exposed.
- Stale references reliably fail.
- Stop interrupts an active wait within one second.

### WP2 — Desktop controller integration

Goal: make the shared controller the supported browser-control path inside Freedom Browser.

Tasks:

- Register `<webview>` guest WebContents in main.
- Bind renderer tab IDs to opaque automation tab IDs.
- Add controlled-tab state and takeover behavior.
- Route the embedded Pi browser tools through the controller.
- Preserve existing navigation, permission, private-window, and provider behavior.
- Add controller unit tests and fixture-backed E2E tests.

Exit criteria:

- Embedded Pi no longer depends on ad hoc renderer JavaScript for core page actions.
- Existing desktop navigation behavior remains unchanged outside agent-controlled tabs.

### WP3 — Headless Freedom runtime

Goal: package the same controller behind the persistent V1 Freedom runtime, implemented with hidden Electron/Chromium.

Tasks:

- Add a headless/runtime launch mode.
- Create direct hidden page adapters.
- Reuse real session/protocol/node configuration.
- Implement profile selection and locking.
- Implement runtime discovery, authentication token, local socket/named pipe, and version handshake.
- Add graceful shutdown, idle timeout, crash cleanup, and structured readiness.
- Provide Linux Xvfb/container launch support.

Exit criteria:

- Runtime can navigate HTTP, Swarm, IPFS/IPNS, and Tor test targets.
- Runtime never touches the default desktop profile unless explicitly selected and unlocked.
- Repeated control commands reuse one browser session.

### WP4 — Experimental Freedom CLI (paused)

Goal: retain a reliable repository-local machine interface for kernel debugging and evaluation without turning distribution into a current product commitment.

Tasks:

- Keep the CLI a small control-plane client with no Electron imports or Electron-specific public types.
- Implement command hierarchy.
- Keep the installed command name distinct as `freedom-cli`.
- Add TTY-aware text/JSON behavior only if local evaluation needs it.
- Add JSONL events only if local evaluation needs them.
- Add stable exit codes.
- Auto-start and attach to the runtime.
- Support explicit ephemeral and persistent modes.
- Defer installed-runtime discovery, global installation, and cross-platform packaging.

Exit criteria:

- The current macOS repository-local lifecycle and browser chain remains a regression oracle.
- CLI work resumes only when a concrete external-agent or CI use case outranks embedded-agent work.

### WP5 — Freedom MCP (deferred)

Goal: expose the canonical browser tools to MCP-capable agents.

Tasks:

- If external demand is validated, implement `freedom-cli mcp` or a dedicated MCP entry point over stdio; do not reserve the desktop app's `freedom` executable now.
- Publish canonical input/output schemas.
- Return structured errors and screenshots.
- Connect to ephemeral or persistent runtime modes.
- Test with the MCP inspector and at least three representative agent hosts.
- Document host configuration examples.

Exit criteria:

- MCP and CLI conformance tests prove equivalent behavior for every shared operation.
- No adapter-specific policy bypass exists.

### WP6 — Embedded Freedom Agent integration

Goal: prove and then productize current Pi directly on top of the shared kernel. Do not port the old prototype wholesale.

Tasks:

- Add a narrow ESM/dynamic-import boundary for the current Pi SDK.
- Run Pi outside the renderer, initially in a main-process service that can later move to a utility process.
- Use a no-discovery resource loader, in-memory settings/session state, no built-in tools, and only explicit Freedom browser tools.
- Resolve and pin the initiating visible desktop tab through the existing verified tab binding.
- Stream normalized assistant/tool/run events to an Agent sidebar tab through narrow validated IPC.
- Wire Stop through Pi abort, the active tool signal, and browser-operation cancellation.
- Prove one hosted-provider BYOK path and one explicit loopback Ollama path.
- Add profile-bound `safeStorage` credential storage and redaction tests before broad provider UI.
- Add controlled-tab marking and define close/switch/takeover behavior.
- Defer persistent sessions, arbitrary skills, subagents, sensitive capabilities, and broad provider onboarding until the vertical slice passes its acceptance gates.

Exit criteria:

- A user can give a high-level task for the current visible tab and watch Pi complete it through the canonical controller.
- Model failure, user cancellation, tab loss/takeover, and policy denial all end in clear recoverable UI states.
- No Pi coding tool, discovered local instruction, raw credential, or ambient global Pi configuration enters a run.

### WP7 — Capability and approval hardening

Goal: safely expand from page interaction into sensitive Freedom capabilities.

Tasks:

- Formalize task capability manifests.
- Audit existing broker tiers and session grants.
- Add commit-boundary form submission policy.
- Add upload file authority.
- Add download policy and artifact receipts.
- Add wallet signing/payment review.
- Add x402 budgets only after threshold-consent design is complete.
- Add Swarm publishing and node controls through canonical tools.
- Add headless approval queue semantics.

Exit criteria:

- Adversarial pages cannot self-grant new authority.
- All irreversible test actions produce an approval or a narrow pre-authorized policy match.
- Financial actions have decoded, value-aware receipts.

### WP8 — Reliability, distribution, and public beta

Goal: make the system supportable outside a development checkout.

Tasks:

- Signed runtime/CLI distribution.
- Runtime discovery from packaged desktop installations.
- Linux container image.
- Upgrade/protocol compatibility policy.
- Crash recovery and orphan cleanup.
- Telemetry/diagnostics policy with privacy review.
- Performance limits and resource accounting.
- Documentation, examples, troubleshooting, and security review.

Exit criteria:

- Install-and-run smoke passes on supported macOS, Linux, and Windows targets.
- Upgrade from the previous compatible runtime preserves profiles and sessions.
- Public threat model and limitations are documented.

## Milestones

### M0 — Architecture accepted

Status: **Complete**

- WP0 complete.
- Fresh Pi SDK and Freedom architecture assessment complete.
- Initial contracts and evaluation corpus agreed.

### M1 — Shared-kernel proof

Status: **Complete**

- WP1 complete.
- Same snapshot/action loop works in visible and hidden page adapters.

### M2 — Internal desktop alpha

Status: **Complete**

- WP2 and the minimum WP6 integration complete.
- Embedded agent controls marked tabs through the shared kernel.

### M3 — Embedded agent product alpha

Status: **Foundation complete; capability qualification continues**

- Hosted BYOK and one qualified local-model path complete representative task evaluations.
- Provider setup, streaming progress, cancellation, tab takeover, and recovery UX are coherent.

### M4 — Optional external automation alpha

Status: **Deferred pending demonstrated external demand**

- Start only after external demand is validated.
- Resume WP4 packaging and/or WP5 MCP according to the concrete integration need.

### M5 — Safety-complete private beta

Status: **Planned**

- WP7 core policies complete.
- Provider, prompt-injection, approval, and wallet threat tests pass.

### M6 — Public agent beta

Status: **Planned**

- WP8 release gates complete.
- Cross-platform desktop installers, agent docs, and support diagnostics available.
- Headless/container distribution is required only if the optional external automation milestone has been activated.

## Evaluation strategy

### Deterministic task corpus

Start with at least 20 locally controlled tasks:

- navigate and extract a fact
- search and compare several pages
- fill but do not submit a form
- submit after approval
- interact with an SPA
- handle a popup
- work inside an iframe
- download a file
- recover from stale reference
- recover from navigation timeout
- use Swarm content
- use IPFS/IPNS content
- use a Tor fixture/live smoke
- deny a malicious prompt-injection instruction
- stop during navigation
- stop during model generation
- pause for human takeover
- resume after takeover
- attempt a forbidden upload
- attempt a financial action without approval

### Metrics

- task completion rate
- tool-call count
- stale-reference recovery rate
- median and p95 operation latency
- time to cancellation
- token usage
- model/provider-specific success rate
- approval false-positive and false-negative rate
- browser/runtime crash rate
- residual process rate after shutdown

### Initial go/no-go gates

- At least 80% completion on the deterministic corpus for the reference hosted model.
- At least 70% for the reference local model before claiming local autonomous support.
- Zero unauthorized irreversible actions in adversarial tests.
- Cancellation reaches idle in one second for normal browser waits and promptly for provider streams.
- No secrets in stdout, logs, screenshots, or saved transcripts during the credential test suite.

## Key risks

### Renderer-owned navigation

Significant navigation and tab state currently live in the renderer. Extracting a shared controller must preserve subtle dweb navigation, cold-content probing, history, display URL, permission-origin, popup, and private-session behavior.

Mitigation: begin with an adapter around existing behavior, add contract tests, and move ownership only where headless parity requires it.

### Browser automation complexity

Accessibility trees, DOM snapshots, iframes, shadow DOM, virtualized lists, trusted input events, and SPA navigation all have edge cases.

Mitigation: use a layered semantic/ref model, explicit generations, fixture corpus, screenshots for diagnosis, and capability-unavailable errors rather than silent fallbacks.

### Prompt injection

Webpages can instruct the model to exfiltrate data, expand scope, or perform side effects.

Mitigation: runtime-enforced capability manifests, origin scoping, commit-boundary approvals, no secret/cookie tools, and adversarial tests. Prompting is defense-in-depth only.

### Pi and MCP version churn

Both ecosystems evolve quickly.

Mitigation: pin exact versions, isolate adapters, own the canonical contract, add compatibility tests, and avoid leaking framework-specific types into the controller.

### V1 Electron runtime on Linux

Electron still depends on display infrastructure in common Linux server configurations.

Mitigation: ship and test a supported Xvfb/container path; do not describe hidden windows as a pure browser-engine daemon.

### Profile corruption or secret exposure

Concurrent access or copying a live profile could corrupt state or expose sensitive data.

Mitigation: honor existing profile locks, default to an automation profile, and implement authenticated attach rather than copying.

### Local-model reliability

Small local models may claim tool support but fail multi-step browser tasks, argument construction, or recovery.

Mitigation: publish tested capability labels, run provider conformance suites, and avoid promising full autonomy for unqualified models.

### Financial autonomy

Wallet, x402, and network-resource purchases create irreversible loss risk.

Mitigation: exact decoded intent, always-ask defaults, explicit budgets, time/value/origin scopes, receipts, and a separate security review before unattended payment features.

## Open questions

1. Does `openai-codex/gpt-5.6-sol` retain at least 80% completion as the deterministic corpus grows, or should another hosted model become the alpha reference?
2. Does Pi remain stable enough inside main under provider failure, long streaming responses, memory pressure, and app shutdown, or should evidence trigger a move to a utility process?
3. Which Ollama models meet a minimum tool-call, argument-construction, recovery, and latency score as the Freedom task corpus expands?
4. Which browser observation implementation gives the best balance of semantic quality, cross-frame support, DevTools compatibility, and maintenance cost?
5. How much navigation orchestration must move from the renderer into main for true parity?
6. What exact meaning should `network-idle` have for long-lived dweb and streaming pages?
7. What download destination and reveal model works consistently across macOS, Windows, and Linux without granting model-visible filesystem access?
8. Which runtime-owned signals are sufficient to classify messages, account changes, deletion, publication, purchases, wallet actions, and other sensitive effects without trusting page labels or model claims?
9. What task-scoped filesystem, build sandbox, preview lifecycle, and publication receipt model is required before Freedom Agent can safely build and deploy dApps?
10. What concrete external use case would justify resuming CLI packaging or adding MCP?
11. What sandbox, origin matching, permission, persistence, update, and rollback model lets Agent create Greasemonkey-style page customizations without turning generated scripts into ambient cross-site authority?
12. Which stable customization and extension APIs can make Agent-authored changes to Freedom powerful, inspectable, reversible, and resilient across browser upgrades without allowing generated code to patch trusted chrome or privileged processes silently?

## Immediate next iteration

The embedded Pi product path is live in Freedom. The product now has durable multi-turn sessions, Agent-first and browser-first views of the same task, browser-wide Agent-tab custody, in-flight steering, a trusted resumable page-takeover interlock, fresh semantic and visual observation, reasoning-derived live progress with verified activity precedence, evidence-based completion/recovery receipts, bounded conversation attachments with local PDF processing, verified downloads and user-authorized page uploads, Agent-native dApp wallet approval, direct Freedom wallet transfers, read-only node intelligence, explicitly disclosed raw node/application diagnostics, independently classified direct node requests, durable recovery for long-running node mutations, native progressively disclosed operational skills, safe specific provider failure/recovery UX, a fail-closed **Ask when needed** website-interaction posture, Agent-native Swarm publication, and a gated private coding workspace with sandboxed shell/file tools, isolated static and declared managed-server preview, and exact managed-workspace publication to Swarm. All twenty-one deterministic browser/privileged product qualifications remain green alongside the newer workspace, preview, and publication qualification suites.

The generic effect-classifier kernel is now implemented for exact runtime-owned actions, beginning with raw Ant API requests. It runs as a separate tool-free Pi session, treats the proposed request as untrusted data, returns a strict bounded effect record, and fails closed to approval on invalid output, timeout, provider failure, low confidence, or material uncertainty. Deterministic constraints remain authoritative: the acting Agent cannot supply its own safety label, non-read HTTP methods retain a minimum approval floor, and DELETE cannot be downgraded below destructive.

Website interactions now use a separate tool-free intent classifier as an interruption policy, not as browser authority. The acting Agent supplies a short literal account of what it believes its exact click, typing, selection, or key press will do; the classifier considers that intent alongside the current user request and trusted operation metadata. Only a high-confidence `ordinary` result with no uncertainty avoids interruption. Consequential, uncertain, malformed, slow, or failed classification asks the user. Native form submission and dedicated file, wallet, node, and future publication boundaries keep their deterministic gates.

This still does **not** prove the hidden effect of arbitrary page JavaScript. Freedom authorizes only the freshly reinspected exact target and mechanism; the approval UI says explicitly that hidden page behavior has not been audited. The classifier can decide when to interrupt based on the Agent's intended consequence, but neither its output, page labels, nor the acting model can grant broader capability or bypass runtime-owned privileged boundaries.

The wallet package is alpha-complete as the first privileged Freedom capability. Direct sends reuse the configured token/chain registries, current wallet account, name resolution, balance and gas checks, signer abstraction, broadcaster, and payment history; they do not navigate to a dApp. Manual production smoke now passes for both a real direct send from a local vault and arbitrary dApp connection through a page-owned wallet picker. Ledger and remote-signer variants remain opportunistic device-specific qualification rather than a blocker for the current package. Pi can inspect safe lifecycle/readiness for Swarm, IPFS, Radicle, Tor, and both Myotis light clients; inspect disclosed bounded raw diagnostics; issue bounded requests through the real Freedom-owned Ant, Radicle, and IPFS surfaces; and start, stop, or restart a named integrated service through its canonical manager. Request transports cannot choose a host, redirect, use credential-bearing browser headers, exceed request/response limits, read the filesystem, or acquire shell/process authority. Confident reads proceed; everything uncertain or state-changing becomes an exact Agent-native decision before dispatch. Lifecycle actions always ask and report success only after the shared status layer verifies the resulting state. Composer attachments now provide an explicit, bounded bridge for user-selected text, images, PDFs, and read-only folders without granting arbitrary filesystem authority. PDF text extraction and one-page visual rendering run locally inside a fresh locked-down sandbox rather than the privileged main process.

Keep `freedom-cli` working as a regression oracle, but do not package, install, or expand it unless agent evaluation exposes a specific diagnostic need. Do not begin MCP.

### Current product roadmap — 2026-09-03

The embedded foundation is complete enough that current priorities should be read from this section rather than inferred from the historical work-package numbering or implementation checkpoints below.

#### Completed foundation

- Pi is embedded directly in Freedom behind the canonical automation and policy controller.
- Freedom owns provider configuration and profile-bound credential storage, with hosted providers, ChatGPT/Codex subscription reuse, and loopback Ollama supported through the same Agent product path.
- The sidebar provides dedicated first-run provider setup, composer-level model and approval selection, a real multi-turn conversation, automatic Pi context compaction, collapsible tool activity, New chat, in-flight steering, terminal Stop, trusted page Take over, and fresh-observation Resume. The model remains fixed for retained Pi context, while the website-interaction posture—**Ask every action**, **Ask when needed**, or **Allow website interactions**—can change only between turns and is enforced immediately by the trusted controller. Opening Agent or entering Agent-first focuses an available composer, and sending leaves it ready for follow-up or steering; approvals, takeover, and explicit focus elsewhere are never overridden, while run completion does not reclaim focus.
- The Agent can navigate and interact across supported web and dweb origins inside a session-attached workspace. Tabs created by Agent retain browser-wide Agent custody until the user explicitly claims or closes them; unrelated user tabs remain outside Agent authority.
- Vision-capable models can request a bounded screenshot of the visible Agent-controlled viewport when semantic observation is insufficient. Screenshots complement rather than replace snapshots: interaction remains reference-based, and text-only models are never shown the visual tool.
- The initially adopted user tab is one workspace member rather than a conversation root. Human tab closure is recoverable, including an empty workspace that later creates a fresh task tab without adopting an unrelated foreground tab.
- Agent conversations are persisted in a profile-local Freedom SQLite store. The Sessions pane supports reopening, renaming, and deleting them across app restarts without reviving historical browser authority.
- The deterministic product matrix now passes twenty-one scenarios together: the seven foundational research/form/collaboration/cross-site/multi-tab/file tasks; one consequential-interaction task proving an ordinary disclosure proceeds while a publish action pauses on its exact target; Agent wallet signing, rejection recovery, locked-vault dApp transaction approval, and a direct locked-vault ERC-20 send without a dApp; tabless node intelligence; provider-disclosed raw diagnostics; a confidently classified Ant read; an exact approved persistent Ant request; a slow persistent request collected by operation ID; an exact approved, postcondition-verified IPFS restart; native progressive disclosure of the bundled Swarm postage skill; transient provider failure followed by automatic recovery; and exhausted provider failure after two browser changes with safe cause and attempt evidence. User-cancelled transfers, declined wallet requests, and declined node requests are represented as explicit non-retryable decisions rather than generic failures.
- Exact page file inputs are a dedicated, always-approved capability. The native picker keeps local paths in main, and Pi/history receive only a redacted attachment receipt. A public-web smoke test confirms that choosing a file, attaching it to the page, separately approving native form submission, and receiving the site's successful upload result work end to end.
- Wallet connect, transaction, and signature requests are a dedicated Agent capability. Pi uses ordinary browser tools through each dApp's own wallet picker; when the exact actively controlled page actually calls the injected provider, Freedom captures that request, renders its complete reviewable intent in the composer, and executes through the existing wallet stack only after one explicit Agent-native decision. Website interaction posture and dApp auto-approval rules never grant Agent wallet authority implicitly.
- Direct wallet sends are a separate canonical privileged operation. Pi supplies only recipient, amount, configured asset, and—when necessary—an exact chain/account choice. Main resolves the name and asset, rejects ambiguity, checks value and maximum fee, holds one immutable transaction in the composer, rechecks balances after approval, and returns only a bounded broadcast receipt.
- Conversational turns that use no browser capability are explicitly classified as requiring no browser verification. They show the assistant response without an irrelevant evidence warning or empty activity disclosure; evidence and recovery cards remain reserved for recorded browser or privileged work.
- `node_status` is a canonical tabless read-only operation over Freedom's existing service owners. It returns six bounded service records and a summary for Swarm/Ant, IPFS, Radicle, Tor, and Myotis on Ethereum/Gnosis; endpoints, ports, paths, credentials, raw errors/config/logs, and process authority remain in main. Pi and the renderer receive node-specific progress and completion evidence rather than a browser-evidence fallback.
- `node_request` is the first consumer of a shared isolated effect classifier. It reaches only Freedom-owned surfaces: the service-registry-selected Ant Bee-compatible and Radicle HTTP APIs, plus the embedded IPFS native gateway. It accepts one bounded method/path/header/body request where the transport supports it, blocks redirects and model-selected hosts, and returns one bounded raw response to the current Pi turn. High-confidence unambiguous reads can proceed; state-changing, destructive, uncertain, malformed-classifier, timeout, and provider-error cases pause on an exact Agent-native approval card.

#### 1. Completed product foundation — Agent-first UX

Design and implement a reversible second view of the same live task:

- Normal mode keeps the selected webpage primary and Agent as a companion sidebar.
- Agent-first mode uses a three-pane workbench: Sessions on the left, the live conversation in the center, and Workspace on the right.
- Both secondary panes are independently collapsible from native-height title-bar controls. The central title bar also provides an explicit return to ordinary browser mode.
- The Sessions pane initially represents only the current in-memory conversation and an honest future-history placeholder. It must not imply persistence before profile binding, redaction, retention, deletion, and private-session behavior exist.
- Workspace is a general product concept rather than a synonym for browser tabs. Agent-owned pages are its first item type; generated files, application previews, build processes, and publication/deployment receipts can join later as their authority packages become real.
- Selecting an owned page keeps Agent-first mode active and displays the existing Freedom webview in Workspace. It must not create a duplicate browser or expose unrelated tabs.
- Switching modes must not recreate the Pi session, conversation, approvals, authority, or tabs.
- Agent-owned pages must be visibly distinct from unrelated browser tabs without implying authority over the latter.
- Running, paused, waiting, approval, failure, completion, and human-control states must remain understandable in both layouts.
- The user must always have an obvious route back to ordinary browser chrome and direct page inspection.

The dedicated design and feedback pass is complete. Agent-first now provides the reversible three-pane shell, independently collapsible and resizable sidebars, the current in-memory session surface, and a Workspace that reuses Freedom's canonical tab strip, address bar, trust indicators, and navigation behavior. Further visual refinement remains normal product work rather than a reason to keep this foundation isolated on an experiment branch.

#### 2. Completed product foundation — Persistent session history

The honest in-memory Sessions placeholder is now a durable, profile-bound history without confusing stored conversation context with live browser authority:

- Freedom main owns a dedicated profile-local `agent-history.sqlite` database using the repository's SQLite lifecycle conventions, WAL, explicit schema versioning, prepared statements, and startup recovery of interrupted runs. Pi global history remains disabled.
- The durable projection contains session titles, visible user and assistant messages, structured action summaries, timestamps, selected provider/model metadata, the current approval posture plus the posture applied to every turn, and completion or interruption state. Raw page snapshots, tool arguments/results, form values, approval payloads, credentials, and provider runtime state are not stored.
- The Agent-first Sessions pane lists saved conversations and supports New chat, selection, rename, and permanent deletion. New chat preserves earlier sessions instead of erasing their records.
- Switching to a session whose runtime is still live in the current app process restores its attached workspace. After app restart, opening saved history creates a dormant conversation with zero task tabs and zero browser authority; the first follow-up creates a fresh Pi/browser runtime, restores only the visible conversational transcript, binds current authority through normal runtime policy, and requires a fresh page observation before acting.
- Agent remains unavailable in private windows, and trusted-chrome ownership checks reject history IPC from private or unrelated renderers; no private Agent data reaches durable history.
- The schema and main-process API leave room for later workspace artifacts and richer evidence without persisting those capabilities prematurely. Cloud sync, cross-device history, search, folders, branching, and retention UI remain out of scope.
- Unit coverage exercises schema creation and migration, crash interruption, safe transcript restoration, dormant reopening, fresh authority on continuation, rename/deletion, and trusted IPC. A real Electron restart test proves the same profile can reopen the visible conversation without resurrecting historical task pages.

#### 3. Completed product foundation — Browser-wide tab custody

Separate what a tab is from which session currently uses it:

- Tab provenance is immutable: a tab began as either user-created or Agent-created. Merely adopting the user's starting page never relabels it as an Agent tab.
- Custody is browser-wide and mutable. Agent-created tabs remain visibly Agent-owned across New chat and session switches until the user chooses **Claim Agent Tab** or closes them.
- Session attachment is a separate projection. Switching between live sessions restores each session's own attached workspace; it does not infer membership from URLs or whatever tab happens to be foreground.
- A run's active-control marker is an ephemeral lease, not ownership. It appears only while a run is executing and never substitutes for main-process custody or capability checks.
- Claim is an explicit transfer to the user. It stops the active run when necessary, removes the tab from every Agent controller workspace, unlocks ordinary navigation, and does not close or recreate the page.
- A new chat cannot silently adopt a still-Agent-owned page from another session. The user must Claim it first or select a user-owned tab.
- Canonical address-bar navigation is locked while a tab remains Agent-owned. Full provenance-aware mediation of direct in-page navigations remains a hardening package; the renderer lock is not treated as the authority boundary.

The exact deterministic Electron scenario now passes: a five-page workspace survives switching to a second live session and back repeatedly; four actually Agent-created tabs retain custody while the adopted user tab does not; Claim removes one page from the original workspace and restores manual navigation; leaving Agent-first never leaks its empty-state surface into browser layout.

#### 4. Completed product foundation — Steering and collaboration

Make the Agent correctable while preserving useful task context:

- The composer has one lifecycle-aware primary action: idle text sends a turn; an empty running composer becomes **Stop**; running text becomes native Pi steering; and human-control state becomes **Resume**, or sends additional guidance and resumes when text is present. Provider and model remain fixed for the retained Pi session. Approval posture is locked during any active turn or pending decision, but may be changed while idle for the next turn without discarding conversation context.
- Running guidance is delivered with Pi's `AgentSession.steer()` after the current tool-call batch settles and before the next model call. Freedom does not start a parallel run or silently abort the current browser operation.
- Guidance appears immediately as a user message with truthful **Guidance queued** and **Applying guidance** states. It remains part of the current turn, durable session transcript, and restored visible Pi context.
- A pending website approval remains a separate composer decision. The user must allow, decline, or stop before sending more guidance; steering never approves, declines, or dismisses the exact approval card implicitly.
- Clicking inside a page controlled by the active run never reaches the guest. Trusted Freedom chrome intercepts pointer and scroll input and offers **Take over**; confirming withdraws an outstanding approval and retains queued guidance while clearing Pi's runtime queue.
- Take over is resumable collaboration, not terminal cancellation. Resume revalidates the workspace, combines retained and newly entered guidance, and requires fresh page observation before acting. **Stop** remains terminal and marks undelivered guidance as not applied.
- Deterministic service, IPC, renderer, persistence, and Electron coverage exercise steering during an approval, Take over plus additional resume guidance, queue cleanup, controlled-page input interception, and restored transcript behavior.
- Scroll remains blocked during active control because it can trigger lazy loading, virtualized DOM replacement, sticky UI, and viewport-dependent action races. Passive live-page scrolling may be reconsidered only with a controller-visible serialization model or a read-only mirrored surface.

#### 5. Completed product foundation — Progress, recovery, and completion UX

- Live runs now describe the current browser intent in product language such as **Reading**, **Navigating**, **Entering information**, and **Waiting**, while the expandable work ledger retains each structured action and typed failure without exposing raw tool arguments or results.
- The current turn ends with a compact, subtly animated activity row derived only from trusted Pi and Freedom lifecycle events: thinking, responding, tool intent, result checking, guidance application, compaction, provider reconnection, and stopping. Approvals and human takeover become static **Waiting for you** states rather than looking active; completion removes the ephemeral row in favor of the existing collapsed `Worked for …` receipt, while failure yields the recovery card. A delayed reveal avoids flashing for trivial transitions, and reduced-motion preference disables the pulse without hiding state.
- When Pi emits a standalone bold or Markdown reasoning heading, the live row uses that bounded, non-persistent progress summary—such as **Planning the implementation…** or **Verifying the result…**—instead of a generic thinking label. Arbitrary reasoning prose and inline emphasis are not projected. Verified tool intent, approval state, recovery state, and response streaming remain authoritative and immediately take precedence; providers without structured reasoning headings retain the generic fallback.
- Completion and recovery cards contain arbitrary bounded runtime identifiers such as node paths, operation IDs, transaction hashes, and content references without allowing a long unbroken value to widen or escape the Agent surface. Those values wrap inside the available card width in both browser-first and Agent-first layouts.
- Freedom derives the ledger from canonical controller outcomes rather than model prose. A bounded receipt may retain only operation, effect class, opaque page identity, sanitized origin, page count, typed error, approval decision, and sanitized approved destination origin. URL paths and queries, page text, element references, field values, form payloads, and model-supplied evidence remain excluded.
- Completion is intentionally graded: **Result checked** means browser state was observed after the last recorded change on that page; **Actions recorded** means trusted browser actions succeeded but the resulting state was not re-read; and **Browser state inspected** covers observational work. A completed turn with no browser activity is **not applicable** for browser verification rather than suspicious by default. An Agent-reported browser result remains cautionary only when a browser attempt exists without successful controller evidence. None of these labels claims semantic truth beyond what the controller actually observed.
- Completed browser and privileged turns present a compact evidence card plus the collapsed `Worked for … · N actions` disclosure. Pure conversation presents only the assistant response. The expanded ledger shows inspected origins, page changes, recoverable failures, and approval outcomes. Native form consent discloses the sanitized destination origin before approval and retains it in the completion receipt.
- Failed and interrupted turns explain the controlled failure, distinguish verified earlier changes from an uncertain in-flight change, and provide a next step. Blind retry is described as safe only when Freedom recorded neither a successful nor an uncertain browser change; otherwise the user is told to inspect the Agent tabs before continuing or redoing work.
- The safe activity projection survives session history and is recomputed into the same evidence/recovery surface after restart. Approval payloads and historical browser authority do not survive with it.
- Downloaded file artifacts use the scoped authority and receipt package below; model prose alone never proves that a file was delivered.

#### 6. Completed capability — File downloads and receipts

The remaining canonical alpha-task capability is implemented as one coherent authority package:

- `browser_download` arms Freedom's existing download manager before one trusted link action and attributes only the resulting transfer. A second unsolicited transfer from that action is cancelled.
- Existing filename sanitization, collision handling, native destination preference, shelf, `freedom://downloads` history, and profile-local `downloads.sqlite` remain authoritative; Agent does not implement a parallel file pipeline.
- Pi receives only an opaque artifact ID, sanitized filename, MIME type, byte count, source origin, terminal state, safe location label, and current availability. It never receives the absolute path, full source URL, headers, or credentials.
- `browser_list_downloads` exposes only artifacts owned by the current conversation. Trusted chrome resolves **Open** and **Show** actions from the opaque ID inside main.
- Live byte progress appears in the work ledger. A verified completion renders an artifact card and a **File downloaded** receipt, and that redacted receipt survives session history.
- Stop cancels in-flight transfers owned by that conversation; Take over leaves the browser-managed transfer running. Cancelling from the ordinary download shelf produces a distinct non-retryable user-cancellation result, never an incomplete artifact card, and tells Pi not to retry unless asked. Failure, interruption, missing files, filename changes from the save dialog, and extra-download attempts fail honestly.
- Unit coverage spans the manager, canonical controller, scoped policy, Pi adapter, service lifecycle, persistence, and renderer. The deterministic Electron file-delivery task verifies consent, actual isolated-download bytes, a path-free receipt, the artifact card, and the Downloads location.
- File delivery and file attachment remain separate authority packages: downloads create browser-owned artifacts, while uploads grant one user-selected file to one exact current page input. Neither capability grants general filesystem access.

#### 7. Completed capability — User-authorized file uploads

- `browser_upload` targets one exact visible `<input type="file">` reference from the latest semantic snapshot. Ordinary click cannot open that input, and the operation always requires explicit approval even under **Allow website interactions**.
- The composer-level decision explains the current site and exact input. **Choose file…** opens the native OS picker; confirming a filename there is the final user-presence step. Freedom does not automate or expose the picker through page coordinates.
- Main alone receives the absolute selected path, verifies a directly selected regular file, and applies it once through Chromium's native file-input protocol. The snapshotted node, tab, navigation generation, scoped controller, current site, and one invocation remain authoritative; a changed page fails closed.
- Pi and durable history receive only sanitized filename, byte count, optional MIME type, and `attached` state. They never receive the local path, file contents, a reusable handle, or general filesystem authority.
- “Attached to the page” is distinct from later submission or remote acceptance. Native form submission remains a separate action with its own payload-integrity recheck and approval.
- Cancelling the native picker produces `FILE_UPLOAD_CANCELLED_BY_USER`, a neutral **Cancelled by you** ledger/completion state, and an explicit instruction not to retry unless asked.
- Unit coverage spans semantic classification, click exclusion, controller/policy routing, native-picker ownership, Chromium attachment, cancellation, receipts, history redaction, and composer UX. The deterministic real-Electron task proves an actual page `change` event, filename/size observation, and a path-free Pi receipt while all six earlier qualification tasks remain green.
- Manual public-web validation against `https://the-internet.herokuapp.com/upload` passes the full user journey: composer approval, native macOS file selection, attachment to the exact input, a separate approval for form submission, and the site's remote-acceptance confirmation.
- General document ingestion, model-visible attachment contents, generated files, folders, and arbitrary filesystem access remain separate future capabilities.

#### 8. Completed capability — Agent-native wallet actions

- Pi does not predict which page control is a wallet action and receives no privileged wallet-click tool. It uses ordinary snapshots and interactions through arbitrary multi-step dApp pickers; those interactions retain the selected website-approval posture.
- Semantic snapshots and trusted reference hit-testing traverse nested open shadow roots, covering the component model used by modern wallet-picker libraries without exposing selectors or allowing page-script `.click()`. Closed roots and inaccessible cross-origin frames remain honest capability boundaries.
- When a visible control is deliberately non-semantic, the snapshot can expose a bounded geometry-backed interactive reference derived from focusability, pointer behavior, and accessible text. The normal trusted hit-testing, stale-node, custody, and approval boundaries still apply; this is not selector access or model-directed coordinate clicking. It allows Agent to operate custom wallet-picker controls that render as generic containers instead of native buttons.
- The injected provider request—not a button label or model claim—is the wallet authority boundary. Trusted main routes a supported request to Agent only while its exact renderer tab is the active page under a live run, then binds it to the current page permission identity, current network, and connected Freedom account. Background-tab, cross-tab, cross-origin, oversized, malformed, and account-mismatched requests fail closed.
- Connection, transaction, personal-message signature, and EIP-712 typed-data signature requests render in the existing composer approval surface rather than the legacy wallet sidebar. The card shows site, network, account, exact destination/value/maximum fee/calldata, or the complete reviewable signature payload as applicable.
- Account selection, Touch ID, and inline vault-password unlock remain trusted Freedom UI. Passwords and signatures never enter Pi, Agent events, tool results, or durable history. Pi receives only a bounded receipt such as connected account, transaction hash/payment ID, or signature type.
- Agent wallet requests always ask. They do not inherit **Allow website interactions** or standing dApp transaction/signature auto-approval rules. **Ask every action** may therefore ask separately for ordinary picker clicks before the actual wallet card appears. Decline produces a typed, non-retryable user decision and Pi is instructed not to retry or work around it unless asked.
- The triggering trusted input settles against an external-approval barrier before Pi can take its next step or finish, so the provider result is returned to the page and a redacted trusted event reaches the current Pi turn in causal order.
- When no eligible Agent run controls the exact requesting tab, the existing human dApp wallet flow remains unchanged. The package reuses Freedom's identity accounts, dApp permissions, chain registry, gas estimation, signer abstraction, transaction broadcaster, and payment history rather than implementing a parallel wallet.
- Focused unit coverage verifies the trusted renderer/tab boundary, exact payload approval, account choice and mismatch handling, cancellation, redacted receipts, legacy-flow fallback, inline password unlock, and Touch ID delegation.
- Three deterministic real-Electron wallet qualifications pass through a genuine two-stage dApp picker: account connection plus real personal/EIP-712 signatures, explicit rejection with EIP-1193 `4001` recovery, and a locked-vault transaction whose exact recipient/value/maximum fee/calldata are approved before a test-only broadcaster receives the same payload. The rejection case additionally proves that ordinary Connect/Freedom picker clicks receive ordinary page-interaction consent before the provider-native wallet card. The transaction receipt contains only its hash/payment ID.
- The entire eleven-task product corpus passes in one run, the focused changed-surface suite passes 183 tests, the complete unit suite passes 3,586 tests with 10 intentional skips, and the focused Agent/sidebar Electron smoke passes 2 of 2. ESLint and diff whitespace checks pass.
- Manual production smoke passes for a real local-vault direct transfer and for selecting Freedom from a live dApp's custom wallet picker and completing connection. The normal non-Agent wallet flow remains unchanged. Ledger and remote-signer paths remain device-specific follow-up qualification.

#### 8b. Completed capability — Direct Freedom wallet transfers

- `wallet_transfer` works independently of page state and dApps, including when a conversation has no surviving browser workspace. It is still routed through the canonical privileged automation/policy boundary and always requires one Agent-native decision.
- The model can provide a recipient address or supported Ethereum name, decimal amount, configured asset symbol or token address, optional chain ID, and optional wallet index. Freedom refuses unknown assets, unsupported names, unavailable accounts, invalid amounts, and cross-network symbol ambiguity before approval rather than guessing.
- GNO on Gnosis Chain is now a built-in configured asset using the canonical `0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb` contract and 18 decimals documented by Gnosis Chain, so the original “send GNO on Gnosis” product case works without custom-token setup.
- Main resolves the recipient, constructs native or ERC-20 calldata, estimates gas, calculates the maximum fee, and checks both asset balance and native fee balance. The card shows network, account, exact recipient/address, amount, maximum fee, optional name-verification warning, and token contract. No raw transaction calldata is needed for this semantic transfer.
- Approval unlocks the existing mnemonic vault through the same inline password/Touch ID flow; Ledger and remote signers continue through the existing signer abstraction. Freedom rechecks balances after approval and broadcasts the exact held transaction through the existing transaction recorder with `wallet-send` history semantics.
- Pi and durable Agent history retain only the bounded transaction hash/payment ID, chain ID, recipient, normalized amount, and symbol. Private keys, passwords, signatures, signed bytes, local paths, and arbitrary signer output remain outside the harness.
- The deterministic Electron qualification proves a direct locked-vault ERC-20 transfer with no dApp and exactly one `wallet_transfer` tool call. It verifies display/execution equivalence, inline unlock, token calldata, payment-history context, and a redacted receipt while all ten earlier product scenarios continue to pass.
- Current verification: all twelve deterministic product scenarios and 3,598 unit tests pass, as do lint and diff whitespace checks. Three suites / 10 tests remain intentionally skipped; the OpenLV integration still emits its pre-existing late MQTT console warnings after Jest completion.

#### 9a. Completed capability — Read-only Agent-native node intelligence

- The inventory covers the existing Swarm/Ant, IPFS, Radicle, Tor, and Myotis lifecycle/status owners. The Agent layer calls those canonical main-process owners and never launches processes or issues privileged raw RPC calls itself.
- `node_status` works without a browser workspace and reports which services are enabled, running, or ready; bounded modes/protocols; safe Myotis peer counts when available; and fixed actionable recovery guidance. Filesystem paths, endpoints, ports, credentials, private keys, raw config/errors/logs, and process identifiers are excluded.
- The operation is classified as observation, requires no website approval, and cannot mutate lifecycle or configuration. Pi is explicitly told that no start, stop, configure, fund, publish, or reset authority exists unless a separate tool is present.
- Tool activity, durable turn projection, and completion cards retain only the bounded aggregate summary. The complete service records are available to the current model turn but are not copied into the renderer event ledger.
- Deterministic Electron qualification proves the tool from a fresh browser state with no claimed page: exactly six safe service records, one `node_status` call, node-specific progress, and a verified node completion card.

#### 9b. Completed capability — Provider-disclosed raw diagnostics

- `node_diagnostics` reads a bounded recent bundle for one allowlisted Freedom-managed service: raw daemon output where the existing manager already records it, service-scoped Freedom integration logs, runtime metadata, and current safe node status. `app_diagnostics` is the broader escalation over recent Freedom/Electron main-process logs.
- The first request renders an Agent-native composer disclosure naming the actual provider and model. It states that raw evidence may contain peer IDs, network or wallet addresses, local paths, and requested resources. The user may share once, share for the current conversation, or decline; a decline is final for the same request unless the user explicitly asks again.
- No pretend content scrubber is claimed. Freedom performs only mechanical terminal cleanup and hard size/line bounding. Raw logs are explicitly treated as untrusted evidence in Pi's system instructions, so text resembling instructions in a log must never become authority.
- The boundary is raw observation, not raw authority: there is no model-selected path, arbitrary filesystem read, shell, process argument, node lifecycle change, or arbitrary RPC. Raw bundles exist only in the current Pi tool result; renderer events, saved history, progress rows, and completion cards retain only bounded counts/scope/truncation receipts.
- One deterministic real-Electron qualification proves that a conversation grant covers a node request and a subsequent broader application-log escalation without a second prompt, both raw bundles reach the fixture model, limits hold, and the UI renders only **Diagnostics inspected** evidence.

#### 9c. Completed capability — Isolated effect classification and bounded node requests

- Freedom invokes the selected conversation model in a separate in-memory Pi session with no tools, skills, prompts, Agent files, working context, or retained transcript. The classifier sees only a bounded canonical action envelope and a fixed classifier system prompt; fields inside the envelope are explicitly untrusted data.
- The strict result vocabulary is `read`, `reversible_admin`, `persistent_change`, `financial`, `destructive`, or `unknown`, plus bounded confidence, summary, affected resources, and uncertainties. Non-JSON output, excessive input/output, invalid fields, missing runtime, provider errors, and timeouts return `unknown` rather than silently allowing execution.
- Policy permits autonomous execution only for a high-confidence `read` with no uncertainty. A deterministic minimum effect remains authoritative over the model result: GET/HEAD may qualify as reads, POST/PUT/PATCH always require at least an admin approval, and DELETE always requires destructive approval.
- `node_request` exposes registry-pinned HTTP for `ant` and `radicle`, plus the embedded read-only IPFS native gateway. The Agent supplies only the service/transport, method/path, bounded non-credential headers, and an optional bounded string body where supported. Main chooses the exact endpoint or native instance, rejects absolute/authority paths and browser credentials, refuses HTTP redirects, and bounds both request and response to 64 KiB. Reads retain a ten-second deadline. Approved state-changing requests have a separate bounded background lifetime so an interactive timeout or Agent stop does not abort a mutation that may already have reached the node. There is no filesystem, shell, process, arbitrary host, LAN, or renderer-network authority.
- Myotis is deliberately not mislabeled as a raw transport: its current native addon exports typed calls rather than a generic request socket. Tor exposes SOCKS routing, which would become arbitrary network authority if surfaced as `node_request`; it therefore remains outside this tool.
- The approval composer shows the exact method/path, effect, classifier explanation/uncertainty, headers, and body before dispatch. Pi gets the bounded raw HTTP response for reasoning; renderer activity and durable history retain only method/path/effect/status/byte-count/lifecycle receipts.
- Every dispatched request receives an opaque conversation-owned operation ID and a profile-local journal entry. The journal stores request metadata and a body digest rather than raw request bodies or header values. Its transport states are factual: `not_dispatched`, `in_flight`, `responded`, or `delivery_uncertain`; Freedom does not infer application-level success from transport delivery.
- `node_operation_status` retrieves an exact operation or discovers recent operations belonging to the current conversation. This lets Pi recover an eventual raw response after an interactive timeout or stopped turn without blindly repeating an unsafe request. App shutdown marks unresolved writes uncertain, and startup converts stale in-flight journal entries to the same conservative state.
- Adversarial unit coverage proves prompt-injection data cannot alter classifier authority, invalid/slow/failed classification fails closed, model output cannot downgrade deterministic floors, operation receipts cannot cross conversation boundaries, stopped Agents do not abort dispatched writes, and shutdown never reports an unsafe operation as not applied. Three deterministic Electron qualifications prove a confident `GET /health` proceeds without approval, a persistent `POST /stamps/100/20` reaches the Ant fixture only after the exact approval card is accepted, and a deliberately slow write stays alive and is collected by operation ID. Focused unit coverage additionally proves Radicle endpoint pinning and native IPFS dispatch.

#### 9d. Completed capability — Explicit node lifecycle authority

- `node_lifecycle` exposes only `start`, `stop`, and `restart` for Ant, IPFS, Radicle, Tor, Myotis Ethereum, and Myotis Gnosis. It calls the existing canonical managers; the Agent cannot spawn a process, choose a binary, supply arguments, change directories/ports, install a runtime, or silently enable a disabled integration.
- Every lifecycle action is structurally floored at `reversible_admin`, independently classified for explanation, and always pauses on an exact Agent-native approval showing service, action, current state, effect, and classifier summary. Website approval posture never applies.
- Freedom reads the safe shared node status before execution and again after the owning manager settles. A start/restart succeeds only in `running`, `syncing`, or `ready`; a stop succeeds only in a non-running terminal state. Disabled, unavailable, error, timeout, cancellation, or unverifiable transitions fail instead of trusting the Agent's claim.
- Renderer events and durable history keep only the named action plus before/after/verified receipt. A deterministic Electron qualification proves an IPFS restart traverses classifier, privileged policy, approval, manager, verification, progress, and completion. The full seventeen-scenario Agent qualification and all 3,666 unit tests pass; 10 tests remain intentionally skipped.

#### 9e. Completed capability — Native progressively disclosed operational skills

- Freedom now uses Pi's native skill catalog and `read` invocation path instead of adding procedural node knowledge to every prompt or inventing a parallel `load_skill` protocol. The model initially receives only the reviewed skill name, description, and virtual location, then loads the full procedure when the task calls for it.
- `swarm-postage` is the first bundled skill. It teaches Agent to preflight Ant readiness, wallet funds, chain state, and existing batches; calculate PLUR/xBZZ cost without decimal mistakes; make the exact Bee-compatible purchase request; monitor `in_flight` operations by ID; reconcile uncertain delivery without a blind retry; and distinguish transaction submission, local visibility, and batch usability.
- Pi's tool is named `read`, but Freedom replaces its filesystem backend with an exact allowlist of bundled, reviewed skill resources under the virtual `/freedom-agent/skills` namespace. Host paths, traversal outside the allowlist, unknown skills, unlisted references, symlinks, images, and oversized resources are denied. There is still no shell, list, find, grep, edit, write, arbitrary filesystem, or general process capability.
- Skill instructions are knowledge, never authority. Every actual Ant call still traverses `node_request`, endpoint pinning, deterministic floors, independent effect classification, Agent-native approval, bounded transport, and the durable operation journal. The effect classifier explicitly remains a separate tool-free and skill-free Pi session.
- Internal skill reads do not appear as browser actions or create a misleading evidence card. A real deterministic Electron qualification proves that Pi sees the advertised skill, invokes the virtual `read`, receives the reviewed procedure, and exposes no broader filesystem tool. The full eighteen-scenario Agent product qualification passes together; all 3,675 unit tests pass with the existing 10 intentional skips.
- User-installed or Agent-authored skills remain a separate future trust package requiring provenance, review, scope, persistence, updates, and rollback. This package permits only source-controlled Freedom skills shipped with the app.

#### 9f. Completed reliability capability — Provider failure and recovery UX

- Freedom deliberately keeps Pi's provider/SDK retry layer at zero and uses two visible agent-level exponential-backoff retries. This avoids hidden nested retry loops while retaining bounded automatic recovery; increasing the number is an empirical provider-qualification decision rather than a substitute for observability.
- Raw provider errors are diagnosed in main into a bounded safe envelope: product category/recovery posture, specific cause, request phase, an allowlisted network error code where available, an HTTP status in the 400–599 range, and a bounded credential-redacted provider diagnostic. Freedom's model-runtime boundary now preserves nested Node/Undici fetch causes before Pi flattens them into `fetch failed`, including aggregate connection failures, and consumes Pi's safe Codex WebSocket transport/fallback diagnostics without retaining stacks, request bodies, or byte counts. Renderer events and durable history receive that safe evidence, provider/model display identity, and bounded attempt metadata.
- During a known transient failure, the composer reports the safe concrete reason Freedom is reconnecting, the current retry number and delay, and successful recovery before Agent continues. Terminal failures name the provider/model, safe cause or exact HTTP status when available, total attempts, automatic retries, and whether all observed attempts failed for the same reason. When attempts genuinely differ, the terminal explanation enumerates each sanitized attempt reason instead of merely claiming that they differed. When the provider supplies no usable signal, Freedom says so rather than inventing a diagnosis.
- Terminal provider failures now settle into one compact recovery card rather than duplicating the raw explanation in the old top-of-chat status line. The card keeps the human explanation short, places sanitized per-attempt transport evidence behind **Technical details**, and offers **Retry** only when Freedom verified no earlier task change and the classified provider failure is transient. A transient terminal failure disposes the failed Pi provider session, retains the conversation and browser workspace, and lazily creates a fresh session/transport for Retry or the next message; incomplete failed turns remain visible to the user but are not replayed into restored model context as if they had completed. Destination ports such as `chatgpt.com:443` are no longer mislabeled as HTTP response statuses.
- Provider failure after a durable node mutation no longer becomes an alleged browser change or a clean retry. If the node receipt remains `in_flight` or `delivery_uncertain`, the recovery card preserves its operation ID, says the node outcome is unresolved, and directs the next turn to reconcile that existing operation before any repeat.
- Provider failure after ordinary browser changes preserves both facts: the card explains the model failure and its attempts while separately requiring review of changes already left in the Agent tabs before a continuation or redo.
- Unit coverage proves adversarial provider strings cannot leak secrets, nested and aggregate transport causes survive sanitization, Pi transport stacks stay private, cause/status/code/phase and per-attempt projection stay bounded, successful recovery resumes, exhausted retries remain explicit, and in-flight node mutations remain mutation-safe. One deterministic real-Electron provider fixture fails twice with HTTP 503, visibly traverses both Pi retries, succeeds on the third model request, and resumes the same turn. A second makes two browser changes and then fails all three model attempts with HTTP 503; the terminal UI preserves the safe exact reason, identical-attempt evidence, browser-review guidance, and provider recovery guidance without exposing the private provider message.

#### 9g. Completed capability — Vision-gated page observation

- `browser_screenshot` now connects Pi to Freedom's existing canonical `webContents.capturePage()` operation rather than adding a second capture stack. It observes only the visible viewport of the currently active Agent-authorized tab and follows the same controller, tab-custody, profile, and private-window boundaries as semantic snapshots.
- Freedom advertises the tool only when the exact resolved Pi model declares `image` input support. Most current hosted and ChatGPT/Codex models qualify through Pi's native model metadata; Free Pi and the generic Ollama configuration remain text-only until those configurations can truthfully declare vision capability.
- The result uses Pi's native image-content contract. Freedom accepts only a valid PNG signature, caps the image at 8 MiB, and returns a short model-visible reminder that screenshots are viewport-only evidence. Malformed or oversized captures fail as an unavailable capability instead of becoming an unbounded provider request.
- Screenshots are complementary observation, never coordinate authority. The system prompt and tool description require semantic snapshots as the primary source of page structure and the only source of element references; Agent must take a fresh snapshot before interacting with something it saw visually.
- Raw pixels exist only in the current in-memory Pi tool result sent to the selected model. Tool details, lifecycle observers, renderer events, progress rows, completion cards, and persisted conversation history receive only a bounded media-type/byte-count envelope plus existing opaque page/origin receipts.
- Focused unit coverage proves model-capability gating, image-content delivery, malformed/oversized rejection, semantic progress projection, pixel exclusion from receipts/details, owned-tab confinement, and Resume's mandatory fresh semantic observation. The existing real-Electron canonical screenshot qualification passes for both desktop and hidden pages. A manual real-provider smoke exposed and then verified the fix for a missing embedded-Agent scoped-operation allowlist entry: Agent can now capture a live news page and visually describe its hero image rather than falling back to semantic text.

#### 9h. Completed capability — Conversation attachments

- The composer `+` control now opens the broad context menu reserved for heterogeneous future inputs. Its surface exactly matches the composer width, while approval and model selection remain compact popovers anchored near their pills. This follows the product hierarchy of the Agent-first composer rather than treating every control as the same dropdown.
- Sent attachments now remain visibly connected to their user turn in a compact right-aligned shelf rather than collapsing into generic text pills. Fixed-width type-aware file, image, PDF, code, text, and folder tiles show a two-line filename and horizontally scroll without shrinking when a turn contains many resources; current-page context remains separate from the attachment shelf. Visible image tiles lazily load a proportional thumbnail, while visible PDF tiles lazily render page one; folders, code, text, unsupported inputs, and failed previews retain their honest type icons.
- A user may select up to ten regular files or one or more folders for a message. Files are immutable message-time snapshots copied into a profile-private, conversation-scoped attachment store. Folder selections are live, read-only grants retained only for the current app process and must be explicitly re-added after restart.
- Pi receives only opaque resource IDs and bounded metadata until it invokes the attachment tools. Text reads are paginated and byte-limited; folder listings are paginated and traversal/symlink safe; supported images are passed through Pi's native image-content contract only when the selected model advertises vision input.
- PDFs are accepted as the same private snapshots or live-folder resources as other attachments. `attachment_read` extracts at most four 1-based pages per call with a bounded character budget. Vision-capable models additionally receive `attachment_render_page`, which renders exactly one requested page as a bounded PNG when layout or imagery matters or a page has no extractable text. Text-only models receive honest extracted-text limitations rather than an unavailable visual tool; there is no OCR in this package.
- PDF.js runs through the display API in a fresh hidden Electron renderer for every request with sandboxing, context isolation, no Node integration, a strict CSP, no permissions, navigation, popups, webviews, or network, and an allowlist limited to the processor entry points and pinned PDF.js assets. Main passes only bounded bytes, never a local path. JavaScript actions, annotations, forms, and dynamic evaluation remain inert; encrypted PDFs, malformed inputs, excessive page counts, timeouts, and cancellations fail explicitly.
- `pdfjs-dist` is pinned exactly at the current `6.3.289`; a pre-commit audit rejected the initially selected vulnerable `6.1.200`, and the parser baseline was then moved from the minimum patched release to the latest reviewed release. Parsed text and rendered PNGs exist only in the current tool result; history and progress retain safe file/page/count/dimension metadata but no extracted contents or pixels. The original snapshotted PDF follows normal conversation retention, while PDFs inside live folder grants retain the folder's existing process-lifetime semantics.
- Undeclared formats remain rejected before staging, and Freedom does not silently attach the supported subset of a mixed selection when any selected file is unsupported.
- Source paths remain main-process-only. Files are opened without symlink following, revalidated before copying, stored with opaque filenames and restrictive permissions, and represented in history by safe name/type/size metadata only. No attachment tool exposes arbitrary paths, writes, shell access, process access, or unrestricted directory traversal.
- Attachment access is now first-class Freedom evidence rather than being mislabeled as browser work. Safe receipts name only the opaque resource, safe display name/relative path, and bounded read/list counts; completed turns report that attached sources were inspected while explicitly distinguishing verified access from the model's conclusions. Paginated reads of one file collapse into one semantic work row, and Markdown tables render as real overflow-safe tables instead of concatenated cells.
- Live folder grants have a visible **Stop sharing** action. Revocation updates the persisted resource manifest before removing the in-memory grant, blocks all future reads, and leaves the historical message attachment intact with honest copy that already-read content remains in the conversation.
- Deleting a saved conversation deletes its snapshotted attachment directory. Renderer teardown, runtime disposal, cancellation, and New chat clear unconsumed selections; retained conversation snapshots remain available with the saved session, while ephemeral folder grants become visibly unavailable after restart.
- Focused service, IPC, preload, persistence, renderer, store, and attachment-sandbox tests cover native image input, bounded text/folder/PDF access, safe evidence projection, paginated-row consolidation, live revocation, path redaction, symlink and traversal denial, transactional rejection, parser IPC sender validation, local-resource allowlisting, lifecycle cleanup, table rendering, menu behavior, lazy thumbnail loading, and attachment-shelf type presentation. A real Electron processor qualification extracts two real PDF pages, renders a bounded PDF-page-one preview, and decodes/resizes a real image into a bounded PNG without network or filesystem authority. Real Electron sidebar checks lock the broad-versus-compact menu geometry and prove that sent attachment tiles retain their width and become genuinely horizontally scrollable in the narrow browser-first sidebar. Manual real-provider smoke passes for attaching and analyzing a JPEG, inspecting a folder of structured JSON reports, summarizing a PDF through the local parser, and displaying the lazy image/PDF shelf previews.

#### 9i. Completed capability — Consequence-aware website interruptions

- **Ask for consequential actions** is implemented as the composer-facing **Ask when needed** posture between **Ask every action** and **Allow website interactions**. It changes only between turns under the same trusted main-process persistence and lifecycle rules as the other postures.
- The acting Pi Agent provides a bounded literal `intent` with each click, type, select, or key-press proposal. That text is evidence about the Agent's plan, not an authority claim and not a prediction that page code must behave as described.
- A separate tool-free, skill-free Pi session classifies the current user request, queued guidance, proposed operation, trusted origin/mechanism metadata, bounded visible target label, and Agent-stated intent as `ordinary`, `consequential`, or `uncertain`. The classifier cannot call browser tools or execute the action it evaluates.
- Only a high-confidence `ordinary` result with no stated uncertainty proceeds without interruption. Consequential or uncertain output, low confidence, malformed output, timeout, unavailable runtime, and provider failure all fail closed to the existing Agent-native approval card. Native form submission remains deterministically consequential without asking the classifier.
- The scoped controller still rereads the live tab and reinspects the exact target after approval and immediately before dispatch. The classifier cannot widen the task workspace, change the target, bypass custody, or weaken download, upload, wallet, node, identity, payment, or future publication gates.
- Approval copy distinguishes intended consequence from hidden website behavior. It may ask a concise question such as **Publish the comment?**, while stating that Freedom based the interruption on the Agent's intent and visible target and has not audited the page's hidden behavior.
- Exact typed text is not sent to the classifier; it receives only the operation kind and bounded structural metadata such as character count and replace/append posture. Inputs and outputs are bounded, page/model strings are treated as untrusted data, and classifier output is strictly parsed before policy use.
- Focused coverage proves confident ordinary actions proceed, consequential actions ask, changed targets invalidate both autonomous and approved authorization, native forms always ask, prompt injection remains data, and classifier errors fail closed. A real Electron qualification proves an ordinary **Show supporting details** click proceeds before an exact **Publish the comment?** gate, then the approved publish completes. Manual real-provider smoke now passes a complete form-filling and submission workflow under **Ask when needed** without over-interrupting the ordinary steps or missing the consequential boundary.

#### 9j. Completed capability — Agent-native Swarm publication

- Agent can publish bounded text, an attached file snapshot, a user-shared live folder, or a file/folder subtree from the current managed project workspace through the canonical `swarm_publish` operation. Inline text retains the manual publisher's text/data semantics (`Text` in history and receipts) rather than becoming a model-invented file; file and folder sources retain their real names. The existing Swarm publish service, postage configuration, upload progress, and `freedom://publish` history remain the single implementation path; the Agent does not own a parallel uploader.
- Folder publication reads the folder's live contents directly from the user-selected path at execution time, matching the manual publisher. Freedom does not stage, copy, fingerprint, or second-guess changes the user makes after selection.
- Managed project output uses a workspace-relative source such as `.` or `dist`, resolved against the conversation-owned workspace only after approval. Trusted main-process code reads exact bytes and relative paths into an explicit Bee collection without a staging directory or model round-trip. It rejects traversal, protected `.git` metadata, symlinks, unsafe hard links, special files, excessive entry/file counts, and content beyond the bounded publication budget.
- The model receives only an opaque attachment resource ID or managed-workspace-relative path. Host source paths stay in the trusted main process and are absent from approvals, progress events, receipts, tool evidence, conversation history, and provider context.
- Every publication has a dedicated Agent-native composer approval explaining that the result will be public and unencrypted. Website-interaction permission modes never grant publication implicitly.
- Publications have durable in-process operation IDs, bounded upload/verification progress, safe receipts with `bzz://` URLs, and status recovery. If a provider request or interactive wait ends while upload continues, Agent can inspect the existing operation instead of blindly starting a duplicate.
- Successful uploads are read back through Freedom's Swarm service before being reported as verified. An accepted but not-yet-verifiable reference remains an honest completed/unverified result rather than being reported as a failure or silently retried.
- The progressive-disclosure `swarm-publishing` skill owns workflow knowledge: choosing the project root or build-output subtree, publishing a site as files rather than model-repackaged text, static-site index selection, public-data cautions, postage preflight and handoff, live-folder semantics, operation recovery, verification, and completion reporting. `window.swarm`, raw node calls, and host filesystem access are not alternate publication paths.
- Focused contract, controller, Pi-adapter, progress, persistence, IPC, preload, renderer, and skill tests cover approval, path redaction, direct live-folder dispatch, status recovery without duplicate publication, verification, safe result rendering, and Open/Copy actions.
- Manual real-provider qualification now passes all three publication inputs: inline text retains `Text` semantics, an attached file retains its real filename, and a user-shared live folder publishes directly through the existing Swarm path. The resulting approval, progress, `freedom://publish` history, retrieval verification, and receipt behavior worked as intended.

#### 9k. Candidate next node work — Evidence-driven operations

- Build an evaluation corpus from documented and observed real node requests before relying on autonomous read classification more broadly. Unknown routes and classifier disagreement continue to require exact approval; the corpus should measure false-read rates, not merely JSON-format compliance.
- Add a Myotis direct-request surface only if its native ABI gains a genuine generic bounded request primitive or a concrete product task justifies a typed semantic tool. Do not maintain a shadow route table that drifts with node releases.
- Enable/disable remains a settings mutation rather than ordinary lifecycle and is not part of `node_lifecycle`. Add it only with explicit profile-setting semantics, visible recovery, and a separate verified contract.
- Separate ordinary lifecycle changes from costly or destructive operations such as postage purchase, funding, storage allocation, identity changes, cache/data reset, migration, or publication. These require exact Agent-native composer approval and may need additional wallet confirmation; broad website approval never applies.
- Extend recovery from generic transport evidence to operation-specific reconciliation only where the node exposes a stable identifier or queryable postcondition. Do not invent “applied” from an HTTP response or build a per-version command catalog merely to make results look semantic.
- Preserve the implemented phase-aware cancellation and app-shutdown semantics, profile isolation, existing ports/directories, process supervision, and node-health recovery. Never expose general shell, arbitrary node arguments, or raw local-network authority as a shortcut.

#### Current decision point — Follow observed product evidence

The branch now covers a surprisingly complete delegated-browser loop: durable conversation, multi-tab workspaces, steering and takeover, meaningful live presence, graded completion/recovery, semantic plus visual page observation, bounded composer attachments including locally parsed PDFs, downloads and user-selected uploads, wallet connection/signing/transactions/direct transfers, raw disclosed diagnostics, classified node requests, durable mutation recovery, verified node lifecycle, Agent-native Swarm publication, and native progressive-disclosure skills. The next package should therefore be selected from observed task failures rather than from architectural possibility alone.

The proposed real-world alpha corpus was a structured manual product-qualification pass, not a plan to automate unstable third-party websites, credentials, wallets, or public side effects. Extensive hands-on use has already covered the representative research, form, file, wallet, node, collaboration, visual-observation, and publication workflows, including text, file, and folder publication. It is therefore not a separate blocking ceremony or implementation package.

Ongoing qualification model:

1. Continue ordinary hands-on alpha use and classify each observed failure as **model failure**, **missing capability**, **policy block**, **UX failure**, or **provider/transport failure** rather than treating every unsuccessful task as one engineering problem.
2. Reproduce concrete product defects with deterministic local fixtures at the narrowest relevant boundary and add them to the automated regression corpus. Do not create brittle end-to-end automation against third-party production sites merely to increase corpus size.
3. Refine **Ask when needed** when real logged-in, commerce, account, messaging, or publication workflows expose false interruptions or dangerous non-interruptions. The classifier remains an interruption policy, not a claim to understand hidden JavaScript effects.
4. Choose the next substantial capability from observed product demand. The creation pipeline now spans Freedom-owned project storage, sandboxed build execution, standard coding tools, isolated static and managed-server preview, and direct verified Swarm publication of exact managed-workspace files. The generic policy-filtered coding environment, composable executable/network authority, managed-process substrate, declared-port server-preview route, tracked reusable qualification harness, and first user-facing process controls are implemented; Linux requalification is complete through `aa6d02a9`, while the disposable-Mac adversarial release gate remains outstanding. Dependency installation, external filesystem authority, restart reattachment, richer process inspection, and install/version/rollback workflows remain separate follow-ons. Windows containment still requires an explicit product package before site customizations, extensions, dApps, or browser malleability can be treated as end-to-end capabilities.

Current verification baseline: 229 unit suites and 3,977 tests pass, with 7 suites / 48 tests intentionally skipped on this host. The twenty-one-scenario deterministic Agent product qualification remains green and confirms that both publication operations are present in the bounded Pi tool surface; the terminal provider-failure qualification now correctly protects the non-duplicated turn-outcome UX. Focused real-Electron checks additionally cover sandboxed PDF text/page rendering plus bounded image and PDF attachment previews, transient provider recovery with visible sanitized provider detail, an exhausted three-attempt provider failure after partial browser work, the canonical desktop/hidden screenshot path, sidebar and Agent-first composer autofocus, broad attachment versus compact pill-popover geometry, horizontally scrollable sent-attachment shelves, visible provider reconnection/lifecycle presence, and overflow-safe long node receipts. Manual real-provider smoke passes for visual observation, file/folder/PDF attachments, the **Ask when needed** form workflow, and direct text, attached-file, and live-folder publication to Swarm. The managed-workspace publication bridge passes a 9-suite / 226-test affected-boundary matrix covering exact-byte collection upload, relative-path preservation, consent-before-read, index validation, protected metadata, link/path denial, current-content semantics, safe approval projection, and runtime composition. The managed-workspace product slice adds eight focused suites with 165 passing tests across its new and affected boundaries; the static-preview slice passes a 12-suite, 297-test focused matrix spanning protocol serving, adversarial file access, tab authority, navigation confinement, provider suppression, presentation, and lifecycle cleanup. Its real-provider acceptance scenario also passes: Agent created a dependency-free site inside the managed workspace, obtained the workspace disclosure, and opened the generated page through the isolated static-preview surface. The workspace lifecycle regression matrix now also covers late sandbox cancellation receipts: Stop waits within its existing bounded deadline for in-flight workspace outcomes and reconciles the authoritative receipt before persisting the turn, so a cancelled command cannot remain durably `running` after its ledger entry has reached `cancelled`. The managed-process slice adds opaque yielded sessions, exact launch receipts, bounded incremental output and input, conversation isolation, terminal expiry, backend streaming, automatic no-poll terminal reconciliation, user-visible conversation-scoped controls, and real non-destructive macOS stdin coverage. The declared managed-server preview slice passes a 9-suite / 200-test affected-boundary matrix covering gated schemas, exact grant consumption, immutable port/process association, conversation isolation, proxy request/response limits, credential stripping, redirect denial, stopped-process revocation, safe activity projection, preview navigation confinement, and provider suppression.

#### Latest Linux qualification and next work — 2026-09-04

The remote agent reports a clean, read-only, non-root requalification of exact commit `aa6d02a9d8867d80bd07bb18b3fe428d03d818a4` on Ubuntu 24.04.3 with Bubblewrap 0.9.0 and Electron 43. All required commands exited zero: fresh dependency installation, network capability-disabled 12/12, normal network product path 26/26, sandbox 96/96 (17 macOS tests skipped), sandbox workloads 4/4, destructive fixture 1/1, lint, full suite 3,988 passed / 34 skipped, and focused real-Pi preview-port proof 6/6. No findings, surviving Bubblewrap processes, or Freedom mounts were reported.

Normal startup now exposes network permission without an environment flag. Before approval commands remain offline; the exact one-shot approved command connects; later commands return to the offline policy after consumption. Fractional, string, and out-of-range preview ports fail before launch and preserve the grant; a valid integer port launches once and consumes it. This closes the Linux correction cycle for this commit. It does not replace the outstanding disposable-Mac qualification or establish stock-host portability: this Linux host retains a loaded Bubblewrap AppArmor profile, and off-host LAN evidence remains outstanding.

Next tasks, in order:

1. **Requalify the integrated candidate through the tracked harness on Linux.** Run the repository-owned aggregate workspace qualification command against the exact process-control commit, plus focused tests, lint, the full suite, and the existing destructive fixture. The harness must prove cleanup on both success and controlled failure; remote agents should not reconstruct scratch composition.
2. **Qualify the same candidate on the disposable Mac when available.** Cover the expanded network permission path, managed processes, automatic terminal reconciliation, managed-server previews, and the chrome-owned Stop path, including the documented adversarial cases. Keep destructive qualification off the primary Mac. Record the exact tested revision before declaring this layer cross-platform qualified.
3. **Choose process lifecycle follow-ons from real use.** The first UI deliberately shows only live yielded processes with command, working directory, network posture, preview and Stop. Recent output, stdin, restart recipes, automatic restart, restart reattachment, and stale-session recovery remain separate packages rather than being implied by the first control surface.

#### Qualified foundation — Scoped project workspace and sandboxed shell

The isolated `experiment/agent-workspace-sandbox` work has completed its initial Linux and macOS qualification and is now part of `feature/freedom-automation-kernel`. The product direction remains real general-purpose shell access inside a hard runtime-owned boundary, not a growing catalog of version-sensitive approved commands. The shared execution policy describes exact readable and writable roots, protected carve-outs, private temporary storage, bounded environment and output, no network by default, cancellation, and structured receipts. Unsupported or partially representable policies fail closed rather than silently running with weaker or no isolation. Intent classification and Agent-native approvals remain above this boundary and never substitute for OS enforcement.

Current platform evidence and support posture:

- **Linux / Bubblewrap — qualified foundation.** Mount, user, PID, IPC, and network namespaces provide the intended filesystem, network, local-IPC, and namespace-scoped descendant boundary. The root, `/proc`, `/dev`, and masked `/usr/local` views are read-only; private `/tmp` is capped at 256 MiB and `/dev/shm` at 64 MiB. Cancellation is honest immediate namespace teardown with `SIGKILL`, not a fictional graceful period. Receipts report `linux-bubblewrap`, `terminationGuarantee: namespace_scoped`, and complete namespace descendant teardown. The adversarial corpus covers direct and scripted path access, subprocess inheritance, symlink and hardlink aliases, descriptor leakage, network/DNS/localhost, timeout, cancellation, and descendant cleanup.
- **Linux workspace validation — qualified with a lifecycle constraint.** Hardlinks are accounted by complete bounded `(device, inode)` scans. Every link must be visible inside the selected roots and remain within one authority domain; external or unaccounted links, protected/writable aliases, special files, inconsistent counts, and mutations during validation fail closed. The dependency-heavy Freedom checkout takes roughly 14 seconds to validate, so product integration must validate once when establishing a managed-workspace lease and reuse the resulting policy—not rescan before every command. Freedom-created empty workspaces should validate quickly. Restart or workspace adoption requires fresh validation. A same-UID host process mutating the workspace after validation remains a documented TOCTOU risk.
- **macOS / Seatbelt — qualified with best-effort teardown.** Both development Electron and a packaged `Freedom.app` ran through the deny-default Seatbelt backend using the exact Electron application bundle as the read-only runtime. The packaged app executed from `app.asar`, used its embedded Node through `ELECTRON_RUN_AS_NODE=1`, and could not fall back to Homebrew Node. Blanket `sysctl-read` is replaced by an exact qualified allowlist; host-process enumeration, protected `.git` hard links, and APFS case-folded Git writes are denied. Receipts report `macos-seatbelt`, `terminationGuarantee: best_effort`, `survivorsPossible: true`, and `completeDescendantTermination: false`. `setsid()` and job-control process groups may outlive cleanup while remaining inside the tested filesystem/network policy. Seatbelt/SBPL's deprecated private status remains an explicit maintenance risk.
- **macOS adversarial release gate — outstanding.** Ordinary implementation, unit coverage, and fixed non-destructive qualification may continue on the primary developer Mac. Network permission is now available without a startup flag, but execution still requires user approval; removing the flag does not qualify the expanded macOS product path. Before arbitrary model-directed shell execution with expanded networking is enabled for ordinary users, the exact candidate must pass on a disposable Mac: recursive-deletion canaries, direct and interpreter-mediated path escape attempts, symlink/hardlink races, detached descendants, resource-exhaustion cases, cancellation/app-exit cleanup, and real Agent-driven commands. Destructive cases must target uniquely created disposable fixtures—never `/`, a home directory, or another real host tree—and must prove protected outside-workspace canaries survived. This is a release qualification requirement; continued implementation and benign smoke testing can proceed while the disposable Mac is unavailable.
- **Windows — unsupported and fail closed.** A Windows backend still requires separate research and adversarial qualification. The shared product layer must not imply that the existing macOS/Linux backends automatically provide Windows isolation.

The common product layer can be platform-neutral: managed workspace lifecycle and persistence, opaque workspace identifiers, Pi tools, approval and activity UI, bounded output and receipts, static preview, and Swarm publication. Only backend selection, sandbox-policy compilation, runtime discovery, and some capability reporting are platform-specific.

Packaging status:

- The packaged macOS qualification is sufficient for an experimental managed-workspace gate. A future Developer ID signed/notarized pass adds Gatekeeper, hardened-runtime, entitlement, and distribution-integrity evidence; it does not strengthen the child Seatbelt filesystem/network boundary and is not a prerequisite for the first gated slice.
- Packaged Linux qualification and the independently audited descriptor-closure correction are merged into this feature branch. Unpacked, `.deb`, and explicitly profiled real-FUSE AppImage layouts used the exact embedded Electron/Node runtime, closed inherited Electron descriptors, and rejected host-Node fallback. A dedicated GitHub Actions gate now builds the `.deb` on a fresh stock Ubuntu runner, verifies its declared Bubblewrap dependency, installs it through `apt`, proves the packaged non-root capability transition without a hand-loaded profile, runs the qualification and destructive corpora, verifies removal, and retains bounded evidence artifacts. This converts the previously manual clean-install question into a repeatable release gate.
- Linux AppImage is not generally product-ready. It works when unprivileged user namespaces are available. On restricted Ubuntu systems Electron Builder's ordinary `AppRun` may inject `--no-sandbox`; that path is rejected. A dedicated reviewed AppArmor launcher/profile or another credible solution is required before supporting that environment.

The independent read-only audit and focused descriptor re-audit found no host escape and accepted the result as an experimental backend foundation. Mandatory `.git` protection can no longer be removed by an empty caller list, and Electron runtime authority now requires a live, non-serializable main-process attestation plus structural revalidation. Product exposure remains conditional on the live capability and Electron-runtime probes; unsupported Linux packaging, Windows, and any failed probe remain unavailable rather than falling back to a host shell.

Known hardening gaps remain explicit rather than hidden behind classifier prose: no aggregate CPU, memory, PID, or workspace-disk containment; no reviewed general seccomp filter; same-UID workspace TOCTOU; macOS detached-descendant survival and PGID-reuse races; host-backed temporary-storage cleanup; runtime-layout portability; and the long-term availability of Seatbelt. Linux has private-namespace loopback while macOS denies loopback entirely, and capability data must preserve that difference. These gaps do not authorize weakening the filesystem/network boundary.

Every trusted consumer must treat workspace contents as hostile. Preview, publication, indexing, attachment, and VCS code must use `lstat`-first bounded traversal, refuse symlinks and special files such as FIFOs/sockets/devices, avoid executing repository hooks, and either refuse or explicitly account for nested repositories. Running a consumer through the same sandbox is preferable where practical. Completed, failed, cancelled, and timed-out shell commands cannot prove what they changed; every spawned receipt therefore reports `sideEffects: unknown`, while only pre-launch cancellation and sandbox denial report `sideEffects: none`.

#### 9l. Implemented capability — Gated managed workspace and sandboxed shell

The smallest end-to-end product surface now sits on top of the qualified contract:

- Freedom creates one profile-private managed workspace for a conversation on first use and persists only its opaque identity, enablement state, backend, and bounded command receipts. Pi receives an opaque workspace ID and workspace-relative paths; the trusted main process alone resolves the backing directory.
- Pi sees the familiar `bash`, `read`, `write`, `edit`, `grep`, `find`, and `ls` coding-tool surface, but none is Pi's host implementation. Freedom supplies Pi's reviewed standard schemas and behavior with custom operations: `bash` executes through the platform-selected Bubblewrap or Seatbelt backend, while bounded text reads, exact writes/edits, directory listings, glob discovery, and content searches use a fixed Freedom helper through that same OS sandbox and opaque managed-workspace authority. Discovery skips symlinks and the standard `.git`/`node_modules` search exclusions, and is bounded by path, pattern, entry, result, file-size, aggregate-byte, output, and time limits. Absolute/out-of-workspace paths, unsafe links, special files, oversized files, and writes to protected top-level `.git` metadata fail closed. The same `read` tool continues to load exact reviewed built-in skill paths without turning skill disclosure into workspace or host-file access.
- `workspace_preview` opens a workspace-relative HTML file, a directory containing `index.html`, or—when the active sandbox supports the separately approved full-network capability—a predeclared port associated with a running conversation-owned managed process. Both modes use a per-preview opaque `freedom-preview://` origin rather than `file://` or direct localhost navigation; calling the tool again refreshes the existing preview tab. The internal token is replaced by **Workspace preview** in the address bar, history, and Agent activity.
- Preview contents remain hostile input. Static requests revalidate bounded ordinary files with `lstat`, canonical containment, no-follow open, post-open inode checks, a one-link rule, a 16 MiB response ceiling, and bounded concurrency. Symlinks, hardlinks, special files, `.git`, traversal, and cross-root access fail closed. Managed-server requests revalidate the live process, workspace, full-network posture, and immutable declared port; strip ambient credentials; refuse external redirects; and bound request bodies, response bodies, concurrency, and duration. Static preview disables all connections and forms; server preview permits only same-origin requests/forms through the declared loopback port. Both modes disable framing, workers, objects, popups, downloads, cross-origin navigation, wallet/Swarm/Radicle providers, and privileged internal APIs. Process termination or conversation deletion revokes the applicable opaque origins, and conversation deletion clears their browser storage.
- Bash output is continuously drained and bounded by the existing backend. Networking is absent by default and may be added only through the separately disclosed exact-command or conversation-scoped full-network capability. Every command result preserves the effective network posture, backend, exit state, duration, truncation, termination guarantee, and deliberately honest `sideEffects` field. Freedom further bounds model-visible output before Pi sees it so Pi never spills a hidden full-output copy into host temporary storage.
- First use presents one progressively disclosed Agent-native decision in the composer. The primary card says only that Agent may create, edit, and delete files in a Freedom-managed project workspace. Closed **More details** explains local conversation-bound persistence and deletion, protected read-only `.git` metadata, read/execute-only system and separately approved executable roots, the fact that internet/localhost/LAN are separate capabilities not granted by workspace enablement, and the platform's honest cancellation semantics. It does not imply encryption, temporary storage, or a permanent no-network product model. Once enabled for that conversation, ordinary commands and writes inside the same boundary do not generate per-command approval; any later authority expansion remains a separate exact decision.
- The managed workspace and command ledger survive Freedom restart. Commands left running across an unclean restart become `interrupted` with unknown side effects; conversation deletion removes only the exact validated managed directory; stop and shutdown route through the active backend cancellation signal.
- Live tool rows say which bounded command is running and record completed, failed, blocked, cancelled, or timed-out outcomes. Completion summaries treat workspace execution as non-browser evidence without letting it outrank more consequential wallet, download, node, or Swarm-publication results from the same turn. Persisted activity never includes stdout, stderr, or host paths.
- Capability detection and active Electron/embedded-Node attestation happen before disclosure. A validated policy lease is established once per managed workspace and reused for later commands, avoiding repeated full hardlink scans. Unsupported Windows/Linux packaging, a missing OS backend, failed runtime attestation, or policy construction failure all fail closed with no unsandboxed fallback.
- First-use setup is independently cancellable across capability detection, runtime attestation, workspace creation, policy validation, and enablement; it does not depend on Pi's abort promise settling. Persistent Pi workspace tools resolve approval, progress, outcomes, and cancellation against the currently active turn in their owning conversation rather than retaining authority from the turn that created the session. These phases are projected as bounded ephemeral status messages without exposing host paths. Terminal Stop has a three-second service deadline: if Pi or an in-flight execution remains wedged, Freedom records the turn as cancelled, detaches and disposes that provider session, preserves the conversation/workspace boundary, and allows the next turn to recreate a clean session.
- Focused store, controller, Pi-adapter, service, progress, history, runtime-composition, renderer, process-manager, and real-sandbox tests cover opaque persistence, exact deletion, restart interruption, relative-directory enforcement, one-time approval, cancellation, path redaction, structured activity, unavailable-platform behavior, yielded process identity, bounded incremental output, standard input, and terminal cleanup.

Manual real-provider acceptance now passes the first creation loop: Agent created dependency-free projects containing separate HTML, CSS, and JavaScript files, opened them through the isolated static-preview surface, and published the exact managed-workspace file tree to Swarm as a retrieval-verified website. A later real-provider smoke also passed the first generic-toolchain flow: Agent created `hello.js`, encountered an unavailable sandbox command, requested the user's installed NVM Node runtime, received explicit read/execute approval, ran the exact script, and returned its real output. That smoke exposed a UX/security gap—the approval explained the package boundary but not the motivating call—which is now closed by the exact-command and canonical-working-directory permit described below. A repeat manual smoke should confirm the revised card and one-shot continuation with the real provider.

`$FREEDOM_JAVASCRIPT_RUNTIME` is therefore not a supported Agent tool or durable product contract and has been removed from the product implementation. Freedom now establishes one fully validated helper policy, then derives a trusted strictly narrower Agent policy without repeating the expensive workspace scan. The fixed filesystem helper alone retains the exact attested Electron runtime and its private `ELECTRON_RUN_AS_NODE` environment; model-authored shell commands receive neither that environment value nor the Electron runtime mount. The model prompt now treats missing commands as ordinary results rather than advertising a private runtime escape hatch.

#### Current next-step decision — Generalize the coding environment and authority model

1. **Completed cleanup — Make workspace failures truthful before broadening authority.** Standard coding-tool failures now preserve safe command-not-found, non-zero exit, timeout/cancellation, missing-path, wrong-file-type, invalid-path, and policy-denial distinctions. Ordinary missing resources use `failed`, while unsafe or unauthorized requests use `sandbox_denied`. Workspace activity no longer falls back to **Browser action failed**, and empty find/grep/list results no longer claim to have found content. Bounded stderr and exit evidence remain available to the acting Agent without entering durable UI/history projections.
2. **Implemented first slice — Expose a generic policy-filtered executable environment, not language-specific support.** Agent-authored shell commands now retain the sanitized baseline system environment and can call `request_permissions` with bounded executable names when another command is required. Freedom lazily obtains the user's command `PATH` from their configured login shell through a fixed, non-model-controlled capture with a hard timeout and bounded output, retaining only absolute path entries and falling back to the app process environment if capture fails. This makes NVM, Homebrew, and comparable user installations discoverable even when packaged Freedom starts outside a terminal. Freedom then resolves the requested names, canonicalizes each executable and its package root, rejects roots broad enough to expose `/` or the user's home, and issues non-serializable runtime authority. The approval card shows the exact executable and read/execute-only package boundary and offers an exact single-use or conversation-scoped grant. Bubblewrap mounts approved roots at private read-only identities and adds only their declared executable directories to the sandbox `PATH`; Seatbelt grants read/execute without write authority and resolves linked runtime libraries generically. The already-validated workspace lease is reused, so granting a toolchain does not repeat the full hardlink scan. Missing commands remain honest unavailable results, and serialized or model-forged root descriptors cannot enter a trusted policy. This is deliberately language-neutral: Node, Python, Ruby, compilers, media tools, or another installed toolchain follow the same contract.
3. **Completed cleanup — Separate Freedom's private helper runtime from the Agent shell.** Fixed reviewed helpers use the exact embedded runtime already qualified with Electron through a private helper policy. A non-serializable restriction operation derives the narrower Agent policy by removing the Electron runtime root and `ELECTRON_RUN_AS_NODE` value while retaining the already-validated workspace, protected paths, and limits. `$FREEDOM_JAVASCRIPT_RUNTIME` no longer exists in product code or Agent instructions; focused policy/controller regressions prove the narrower policy is trusted, cannot be reconstructed from a plain object, and is selected for model-authored commands.
4. **Implemented — Bind one-shot executable approval to the exact intended command.** `request_permissions` now requires the bounded command and workspace-relative working directory that motivate the request, not merely executable names and free-form rationale. Freedom canonicalizes the directory before presenting the approval, and the card leads with the literal command while keeping the directory, canonical read/execute-only package roots, scope semantics, network state, and Agent rationale behind a closed **More details** disclosure. **Allow once** creates a main-process-attested, non-serializable permit consumed only by one byte-for-byte matching command in the same canonical workspace-relative directory; a different command receives no newly disclosed package authority and does not consume the permit. A prepared request itself can be granted only once. **Allow for conversation** deliberately retains the disclosed executable-root capability for later commands, and the card explains that broader effect rather than disguising it as command-only consent. The model cannot supply host paths, forge a validated root, or mutate the permit after approval. Network remains outside this first permit slice and is stated as not part of the request rather than as a permanent prohibition. Agent commands use the sanitized environment directly through a non-login shell; they do not source host `/etc/profile` or emit irrelevant denied `path_helper` setup warnings. The affected controller/Pi/service/renderer matrix passes 152 tests, the live non-destructive macOS Seatbelt suite passes 22 tests in host context, the full unit suite remains green, and ESLint plus diff whitespace checks are clean.
5. **Implemented foundation — Define one composable capability vocabulary before adding more prompts.** The trusted main-process contract now distinguishes canonical executable roots, external filesystem reads, external filesystem writes, outbound public internet, host loopback, private/LAN connectivity, and host IPC. Each kind has explicit resource/access semantics and an implementation status; executable roots and the indivisible full-network bundle now have authority factories and qualified macOS/Linux enforcement adapters. Capabilities and prepared requests carry non-serializable provenance, expose no host path when serialized, bind invisibly to the owning conversation, and support exact-command/directory one-shot or deduplicated conversation grants. The existing executable and experimental networking flows use this generic permit store instead of bespoke maps. Reuse, cross-conversation replay, forged/serialized capability objects, invalid scopes, partial network bundles, and any capability without a qualified policy adapter fail closed.
6. **Implemented and Linux product-path qualified — Grant one honest direct-network posture on both sandbox backends.** The capability is advertised by default when the active workspace sandbox supports it, but every ordinary command still starts with `network: none`; there is no startup flag and no ambient network grant. `request_permissions` can ask for `network: full` alone or alongside executable roots for one exact command and canonical working directory. Managed `bash` exposes that same workspace-relative directory directly. **Allow once** is consumed only by that matching call; **Allow for conversation** retains the bundle. The approval discloses public internet, host localhost, private/LAN connectivity, and Linux host abstract-Unix-socket reachability behind **More details**. Freedom constructs one validated full-capability base lease only on a supporting backend, derives the fixed helper/file policy and ordinary Agent policy back to no-network, and selects the full policy only after resolving a trusted complete grant; helper reads/writes/searches therefore remain offline. Consequential consent for publication, payments, signing, messages, and account actions remains independent. Every command receipt records the selected `none` or `full` posture through the live result, SQLite command ledger, and durable Agent activity. The execution contract recognizes `full` as indivisible while keeping `brokered` reserved. Seatbelt grants IP inbound/outbound plus narrowly named DNS/routing/TLS platform services and no general Unix-socket rule. Bubblewrap uses `--share-net`; receipts disclose that host abstract Unix sockets become reachable. Exact candidate `147f99429614a66163fd132048ac2948dfb76aed` passed the integrated Linux product gate on 2026-09-04 from a fresh `npm ci`: unavailable-capability 12/12 with only `none` postures, enabled 26/26 with zero findings, sandbox 92/92, qualification 4/4, destructive 1/1, lint clean, and full suite 3,966/3,966. The corpus used the real Pi `bash` tool and canonical working directory, proved that stopped full-network commands persist terminal `cancelled`/`full`/`SIGKILL` activity before run completion, and observed no surviving namespace descendants. Root postinstall also materialized Electron 43 and rebuilt native modules without a manual workaround. The Linux host had its distribution Bubblewrap AppArmor profile preloaded and no reachable off-host LAN peer, so stock-host portability and remote-LAN evidence remain release follow-ups. The equivalent disposable-Mac adversarial product path remains required before release. Partial direct-network requests continue to fail closed; finer separation requires a broker/proxy rather than command classification. npm 11's remaining `allowScripts` warnings deserve deliberate release review but did not affect this gate.
7. **Add external filesystem grants through the same permit contract.** Exact user-selected files or directories may become read-only or writable roots for one command or the conversation. Canonicalization, link/hardlink handling, protected metadata, race behavior, receipts, and revocation stay runtime-owned. A model-supplied host path is never authority by itself, and generic filesystem access must not bypass the existing attachment, publication, wallet, identity, or browser-profile boundaries.
8. **Replace browser-specific approval wording with unified Agent authority profiles.** Browser interactions, workspace execution, filesystem scope, networking, node access, wallet operations, publication, and future extension installation should be presented through one coherent posture rather than an increasingly quaint website-only selector. The target modes are: **Ask for approval**, where the human reviews boundary crossings; **Approve for me**, where an independent reviewer may approve eligible crossings while the same sandbox remains in force; and **Full access**, where filesystem/network authority is deliberately expanded with prominent disclosure. The acting model and classifier never become the security boundary.
9. **Keep personal-consent operations outside generic shell auto-approval.** Wallet signing and spending, purchases, public publishing or private-data disclosure, external communications, and legal/account submissions continue to use exact human-visible gates unless the user creates an explicit narrowly scoped standing authorization. Full shell or network access must not silently imply consent to these actions.
10. **Add dependency acquisition through generic capability escalation, not a Node installer.** A missing tool or dependency may lead Agent to propose an ordinary package-manager command with its exact executable, filesystem, and network requirements. Installs should default to the project or a Freedom-managed private, versioned, checksummed tool/cache location. Silent global host installation is not an acceptable fallback; a user-requested global change requires exact human approval.
11. **Implemented and Linux-qualified first substrate — Preserve ordinary shell UX for managed long-lived processes.** The standard `bash` tool now waits up to ten seconds by default (or a bounded caller-selected yield interval) and returns an opaque conversation-owned process session when the sandboxed command remains active. The trusted `write_stdin` continuation tool can poll incremental output, send at most 16 KiB of input, or terminate that exact session; the model is instructed to continue rather than duplicate a yielded server. Each process retains the immutable executable and network policy selected at launch, a 30-minute wall-time ceiling, a 256 KiB tail buffer, and the existing backend output bounds. At most four active sessions may exist per conversation; terminal handles expire after five minutes. Conversation Stop, deletion, and controller disposal cancel retained processes through the platform backend, so receipts continue to disclose Linux namespace-scoped teardown versus macOS best-effort process-group teardown, including the exact `pid_namespace` or `original_process_group` termination scope in live results, durable activity, and the workspace ledger. A yielded process now also has a trusted one-shot terminal observer: natural completion, ordinary failure, timeout, or cancellation updates the original `bash` activity row in memory and durable history even when Pi never polls `write_stdin`. The observer carries only the normalized bounded receipt, cannot affect execution or cleanup, and a late original `running` result cannot overwrite the terminal state. Real non-destructive Seatbelt coverage proves post-readiness streaming and stdin without exposing the trusted readiness marker. Exact commit `1d5f057599ebe1b0050c5f1638a226ca9c28250e` passed the full Linux no-poll reconciliation gate on 2026-09-04: the external product harness passed 17/17 with zero findings, focused suites 178/178, sandbox 96/96, qualification 4/4, destructive 1/1, network capability-disabled 12/12 and enabled 26/26, lint clean, and full suite 3,982/3,982. Natural completion, ordinary failure, timeout, explicit termination, Stop, observer failure, concurrent identical commands, and terminal expiry all reached authoritative durable terminal activity without model polling; no namespace descendant survived. Remaining lifecycle work is deliberately separate: visible process controls, restart semantics, and restart reattachment or honest stale-session recovery. Static preview remains the default whenever a server is unnecessary. The equivalent disposable-Mac process-session product gate remains required before this layer is considered cross-platform qualified.
12. **Implemented and Linux product-path qualified — Preview a declared managed server without exposing localhost directly.** The ordinary `bash` tool conditionally accepts a bounded `previewPort` when full-network permissions are supported. The adapter rejects a present fractional, string, out-of-range, or otherwise invalid port before command launch so malformed direct calls cannot silently lose preview intent or consume a grant. The port is fixed before launch, and the exact command must consume a trusted `full` network grant; an offline or mismatched command fails before execution. After the command yields, `workspace_preview` accepts only its opaque, conversation-owned `workspace_process_*` identity. Main re-inspects that live process for every request and proxies only its predeclared `127.0.0.1` port through a per-preview `freedom-preview://` origin. The proxy never forwards cookies or authorization, follows no redirects, blocks redirects away from the same loopback port, bounds request bodies to 1 MiB and responses to 16 MiB, limits concurrency, times out upstream requests after ten seconds, replaces upstream security headers, and revokes the origin when the process stops or the conversation is deleted. The server page may use same-origin requests and forms; external navigation, providers, privileged APIs, service workers, arbitrary host origins, and direct localhost navigation remain unavailable. This is an honest declared-port association, not cryptographic socket ownership: the approved process and its descendants can serve that port, while Freedom verifies the immutable process/port/posture association rather than claiming kernel-level listener attribution. WebSocket/HMR proxying, automatic restart, restart reattachment, and visible process controls are explicitly deferred. Static preview remains preferable when a server is unnecessary. Exact commit `9b129d43ee56c163704c744d2a6ed031f3259673` passed the Linux product-path gate on 2026-09-04: capability-unavailable 6/6, enabled 24/24, local focused matrix 200/200, Linux sandbox 96/96, qualification 4/4, destructive 1/1, network product 12/12 and 26/26, lint clean, and full suite 3,988/3,988. It used the real production controller, process manager, Pi tools, Bubblewrap backend, preview protocol, and Node HTTP server; all lifecycle, proxy, isolation, and teardown assertions passed with no survivor or security finding. The follow-up Linux qualification at `aa6d02a9` closed the malformed-port finding through the real Pi tool path (6/6), with zero launches or grant consumption for invalid ports and a successful approved launch for a valid port. The equivalent disposable-Mac adversarial qualification remains required before broader release.
13. **Keep Windows as the principal platform gap.** Managed workspace execution currently fails closed there. A Windows containment spike and adversarial qualification should happen before this creation path is presented as a generally available cross-platform Freedom capability, even if the macOS/Linux alpha continues first.

#### 10. Later — Expand consequential and privileged capabilities

- Qualify and refine the implemented **Ask when needed** interruption posture across messages, account changes, deletion, publication, bookings, purchases, and other consequential website intents. False-negative measurement is more important than merely producing plausible classifier prose.
- Promote stable consequential mechanisms into deterministic runtime-owned boundaries when Freedom can observe them exactly; the generic intended-consequence classifier remains a conservative interruption layer rather than a substitute for those boundaries.
- Add identity use, payments beyond the explicit wallet transaction primitive, and decentralized publication as separate explicit capability and approval packages. Website approval settings must never grant them implicitly.

#### TODO — WebMCP page-tool support

- Track and qualify the emerging [WebMCP](https://webmachinelearning.github.io/webmcp/) browser API, which lets a loaded web application expose structured JavaScript tools to a browser-provided Agent. This is distinct from Freedom's deferred external MCP server: WebMCP is a page capability available inside an ordinary browsing context, and the current Community Group report does not require the browser to expose those tools to its Agent through the Model Context Protocol.
- When Freedom's Electron/Chromium baseline provides a usable implementation—or a narrow compatibility layer can be justified without forking the evolving specification—include the active document's WebMCP tool definitions in the Agent's page observation. Keep semantic DOM/visual observation and ordinary browser interaction as the fallback for sites without WebMCP.
- Execute every WebMCP call through Freedom's canonical controller, current tab custody/run lease, approval posture, cancellation, progress, and evidence pipeline. Preserve tool origin and document identity, re-observe registrations across navigation and SPA lifecycle changes, validate schemas and bounded arguments/results, and treat page-provided names, descriptions, annotations, implementations, and outputs as untrusted web content rather than trusted authority or permission declarations.
- Build qualification around the upstream Web Platform Tests and local hostile fixtures covering tool poisoning, misleading intent, oversized schemas/results, cross-origin frames, stale registrations, navigation during execution, cancellation, private windows, and calls whose declared read-only hint conflicts with an observable consequential effect. Do not let WebMCP annotations weaken deterministic wallet, node, file, publication, identity, payment, or native form gates.

#### Deferred until evidence changes the priority

- Moving Pi from main into an Electron utility process remains an evidence-driven reliability hardening decision based on crash, memory, shutdown, and provider behavior.
- `freedom-cli` remains repository-local as a regression and architecture oracle. Packaging and distribution resume only for a concrete external-agent or CI use case.
- External MCP remains deferred and, if justified later, must expose the same canonical controller over stdio rather than becoming a separate automation implementation. It is independent of the WebMCP page-tool TODO above.
- Free Pi browser-tool qualification waits for a confirmed tool-capable route or model. The current limitation does not block the embedded product path.
- Commercial embedding and distribution policy for ChatGPT/Codex subscription reuse remains an external release question even though technical qualification passes.

### Alpha product promise

> Give Freedom a goal involving the current browsing session. It can inspect and navigate websites, complete ordinary web workflows, involve the user when judgment or approval is required, and provide clear evidence of what it accomplished.

This promise, rather than the work-package numbering, should drive prioritization. Downloads, cross-origin navigation, richer controls, persistence, and new approval types are ingredients. They should move forward when a canonical user task or a UX failure demonstrates that they are necessary.

### Agent-first product direction

Freedom should ultimately support two views of the same live Agent task rather than treating the sidebar as the permanent product shape:

```text
Normal browser mode                     Agent-first mode
┌──────────────────────┬───────────┐    ┌──────────┬────────────────┬───────────┐
│ Selected webpage     │ Agent     │    │ Sessions │ Conversation   │ Workspace │
│                      │ sidebar   │    │          │                │           │
│                      │           │    │          │                │ Pages now │
└──────────────────────┴───────────┘    └──────────┴────────────────┴───────────┘
```

In normal mode the webpage is primary and Agent is a companion. In **agent-first mode**, ordinary browser chrome recedes and the conversation/task becomes the primary interface. Sessions provide navigation on the left; Workspace provides live outputs and inspection on the right. The side panes are independently collapsible. Switching modes changes presentation, not task, conversation, authority, or tab state. The user must always have an obvious route back to ordinary browsing and direct page inspection.

The long-term Workspace item model is broader than browsing:

- **Page** — a task-owned live Freedom webview.
- **File or artifact** — a generated or downloaded result backed by scoped file authority and a receipt.
- **Page customization** — an inspectable user script or style with explicit site scope, preview state, and install/rollback controls.
- **Extension project** — source, manifest, permission diff, isolated test state, and a separately approved installable package.
- **Browser customization** — a versioned change built against stable Freedom customization APIs, with preview, compatibility status, and rollback.
- **Application preview** — a locally built dApp rendered for review before publication.
- **Build or process** — bounded execution state with inspectable logs and cancellation.
- **Publication/deployment receipt** — verified output from publishing source through Radicle, assets through Swarm/IPFS, or later executing a separately reviewed wallet transaction.

These are product slots, not implied authority. DApp, customization, and extension creation require a task-scoped project filesystem, controlled build runtime, preview lifecycle, explicit permission and install boundaries, rollback, network-specific publication adapters where relevant, and verifiable receipts before the corresponding Workspace items become interactive product claims.

### Long-term creation and malleability direction

Freedom Agent should eventually be able to create the user's browsing environment as well as operate it. This is a strategic direction with three progressively stronger layers:

1. **Greasemonkey-style page customization**
   - A user can describe how a site should look or behave: hide unwanted elements, restyle a page, rearrange controls, add shortcuts, extract or combine information, or automate a repeated site-specific interaction.
   - Agent drafts an inspectable script/style plus explicit URL or origin matching rules. The customization can be previewed temporarily on the live page before the user installs it persistently.
   - Freedom owns execution isolation, site scope, permissions, enable/disable state, version history, conflict handling, and one-click rollback. Generated code cannot silently broaden its match rules, cross origins, access trusted browser chrome, or acquire wallet, node, identity, file, or network privileges.

2. **Agent-built browser extensions**
   - A user can ask Agent to build a reusable extension ranging from a small content enhancement to a multi-page browser tool.
   - The Workspace presents source, manifest, requested permissions, build/test results, and an isolated preview. Installation and every later permission expansion require a trusted Freedom decision; updates remain versioned and reversible.
   - The eventual extension target should use a documented Freedom/WebExtensions-compatible surface rather than depending on private implementation details. Generated extensions receive only declared capabilities and never inherit the Agent session's browser authority.

3. **A malleable Freedom Browser**
   - A user can ask Agent to change Freedom itself: compose new browser workflows, rearrange supported chrome, add commands or panels, connect browser and decentralized-network capabilities, and create durable personal tools.
   - The first safe form should be a stable customization/component API with bounded slots and capabilities. Arbitrary generated patches to the running main process, preload boundary, credential store, policy controller, wallet, updater, or security-critical chrome are not an acceptable customization mechanism.
   - Deeper source-level modification may later be possible through an explicit local-fork workflow with source review, isolated builds, compatibility tests, signed release separation, and a dependable route back to the official build. It must never masquerade as an ordinary low-risk preference change.

All three layers should share one creation pipeline: scoped project storage, generated-source inspection, deterministic lint/build/test steps, live preview where possible, a permission and effect diff, explicit install/apply approval, durable versioning, disable/uninstall, and rollback. Agent-first Workspace is the natural place to show the project, preview, build process, permission request, and resulting installed artifact without implying that generation alone grants execution authority.

The underlying authority model separates **tab custody**, **session attachment**, and the **active run lease** rather than treating them all as “task ownership”:

```text
Freedom browser profile
├── user-custody tabs
│   └── an eligible current page may be explicitly shared with one Agent session
└── Agent-custody tabs
    ├── immutable Agent provenance
    ├── optional primary session attachment
    └── optional ephemeral active-run lease
```

- A visible, removable composer context chip lets the user explicitly share an eligible current page with a new session. Removing the chip starts without page access.
- Freedom's pristine homepage, internal pages, and Agent-custody tabs are never implicitly shared. A homepage-started session begins with an empty workspace and creates separate Agent-custody tabs as needed; the homepage remains an ordinary user tab outside Workspace.
- The Agent may create, list, target, focus for inspection, and close additional tabs; those created tabs retain Agent custody independently of session selection.
- Existing unrelated user tabs remain outside the task's authority. No implicit foreground-tab adoption occurs when task tabs close.
- Claim explicitly transfers custody to the user, revokes Agent controller membership, and leaves the live page intact.
- Every attached tab retains its own origin, navigation generation, semantic references, lifecycle, provenance, custody, and visible control state.
- Tab creation and concurrency must be resource-accounted and bounded even though the product should not impose an artificially small workflow limit.
- Conversation, progress, approvals, and evidence belong to the session. Browser tab custody is wider-lived; session attachment decides which of those tabs appears in a particular Workspace.

The task workspace is cross-site by default. Website geography is not a useful user-facing mode: a task often begins on Freedom's start page, and useful work routinely spans several origins. The task may navigate, read, and interact across supported web and dweb origins, but only inside its adopted/created tab set. Unrelated user tabs remain outside its authority.

The composer control therefore governs **approval behavior**, not navigation scope:

1. **Ask before every interaction** — navigation, reading, and task-tab management proceed automatically; click, type, select, and key-press actions require one-shot approval.
2. **Ask for consequential actions** / **Ask when needed** — implemented as a conservative interruption policy over the Agent's stated intent, current user request, trusted operation metadata, and visible target. Only confident ordinary interactions proceed; consequential, uncertain, malformed, or failed classification asks. Privileged capabilities keep their own deterministic gates.
3. **Allow website interactions** — supported website interactions proceed without per-action prompts. This does not silently grant future wallet, node, file, identity, or payment capabilities.

Cross-origin information transfer and future non-page capabilities still require explicit policy work. Agent-first mode does not weaken these boundaries; it makes the task workspace and current approval posture easier to understand and supervise.

The consent vocabulary is deliberately asymmetric: a user **shares a page with Agent**, while a user **claims an Agent tab**. Agent never “claims” a user tab. If a running session later needs a user page that was not shared at task entry, that requires a separate inline approval flow rather than foreground-tab inference.

### Canonical task families

Use the working embedded Agent to qualify six product-level task families:

1. **Research and information gathering**
   - Research a question across several websites.
   - Compare products, services, or sources.
   - Extract structured information.
   - Produce a summary with source links and attributable evidence.
   - Expected capability pressure: multi-origin navigation, tab handling, provenance, longer-task context, and useful completion summaries.
2. **Logged-in website workflows**
   - Update an account setting.
   - Complete a multi-page application.
   - Enter information in an administration interface.
   - Perform repetitive operations inside a web application.
   - Expected capability pressure: richer form controls, SPA reliability, authentication handoff, recovery, and preservation of user changes.
3. **Forms and consequential actions**
   - Fill a form but ask before submitting it.
   - Prepare a message, post, booking, or application for review.
   - Let the user edit the draft and continue from the changed page.
   - Expected capability pressure: broader enforceable action classification, clear approval descriptions, review-before-commit, and post-approval integrity.
4. **File workflows**
   - Download a report.
   - Upload a user-authorized document.
   - Collect several artifacts and identify exactly where they were saved or sent.
   - Expected capability pressure: scoped file authority, picker/handoff UX, download policy, artifact receipts, and cross-site workflow continuity.
5. **Human-in-the-loop tasks**
   - Pause for CAPTCHA, MFA, a judgment call, missing information, or a native prompt.
   - Let the user correct or redirect the active task.
   - Resume with an additional instruction rather than only an implicit “continue.”
   - Expected capability pressure: conversational steering, explicit handoff states, preservation of human edits, and clear recovery from changed assumptions.
6. **Creation and customization**
   - “Always hide this element and move that control to the top when I visit this site.”
   - “Build me an extension that combines these repeated browser steps into one reviewed command.”
   - “Add a personal panel or workflow to Freedom that uses these browser or decentralized-network capabilities.”
   - Expected capability pressure: task-scoped source projects, safe generated-code execution, stable customization and extension APIs, permission manifests and diffs, isolated preview/testing, trusted installation, compatibility, durable versioning, and rollback.

These are evaluation families, not simultaneous implementation commitments. Start with representative tasks, observe failures, and expand the kernel only when the task evidence justifies it.

### End-to-end Agent UX roadmap

Treat the Agent experience as a first-class product surface rather than a thin view over Pi and browser tools. Review and define the complete task loop:

1. **Task entry and approval posture** — how a user states the goal, which tab starts the task workspace, and how often website interactions require approval.
2. **Plan and expectations** — whether the Agent should summarize its intended approach, identify missing information, and disclose likely approval or handoff points.
3. **Progress** — how to communicate meaningful steps and page state without exposing an overwhelming raw tool transcript.
4. **Steering** — how a user corrects, adds information to, or redirects a running or paused task while retaining useful conversation and page context.
5. **Stop, Take over, and Resume** — distinguish terminal cancellation from a temporary human-control period in wording, composer state, controlled-page interlock, tab state, and recovery behavior.
6. **Approvals** — describe the exact pending consequence, destination, relevant changed data, and scope of the one-shot decision in trusted chrome.
7. **Failure and recovery** — explain what failed, what remains unchanged, whether the Agent can retry, and what the user can do next.
8. **Completion and evidence** — summarize what changed, cite page evidence and destinations, expose resulting files or artifacts, and distinguish verified completion from a model claim.
9. **History and persistence** — decide what survives sidebar closure or application restart only after redaction, deletion, and profile-bound storage behavior are defined.
10. **Creation, preview, installation, and rollback** — for generated scripts, extensions, dApps, or browser customizations, keep source generation separate from execution authority and make preview, permission review, install/apply, versioning, disable/uninstall, and recovery first-class user states.

The retained takeover/resume lifecycle and native Pi steering are implemented. Future collaboration work should be justified by observed task failures rather than inferred guest input or another generic lifecycle control.

### Product-definition work package

Before selecting the next major implementation capability:

1. Choose a small representative set across the canonical task families.
2. Run those tasks through the current build using the qualified hosted reference and, where useful, the local baseline.
3. Inspect every user-visible state: start, planning, action, waiting, approval, Stop, Take over, human edit, Resume, steering, failure, and completion.
4. Record a capability matrix of **passes**, **partially works**, **missing capability**, **model failure**, and **UX failure**. Do not collapse these categories into one completion score.
5. Turn observed failures into an ordered product backlog.
6. Implement the smallest coherent capability or UX package that unlocks the highest-value blocked task, then add that task to the deterministic regression corpus where possible.

The output of this pass should be:

- a small set of canonical alpha tasks;
- a defined end-to-end Agent UX;
- a capability matrix showing what works, partially works, and is missing; and
- an evidence-ordered backlog in which engineering work is justified by user tasks.

The first qualification set should stay deliberately small and pressure known product boundaries:

1. **Same-origin research** across several pages with a structured, attributable result.
2. **Rich form workflow** using selects, checkboxes, autocomplete, keyboard interaction, and validation.
3. **Collaborative consequential workflow** using Draft → Take over → human edit → Resume → review → submit.
4. **Cross-site research and interaction**, expected initially to expose workspace and approval-policy limitations.
5. **Multi-tab comparison**, expected initially to expose the single-controlled-tab ownership limitation.
6. **File download and receipt**, now a passing task with one-shot consent, actual file verification, and an opaque artifact receipt.
7. **User-authorized file upload**, now a passing task with native selection, exact-input attachment, page-observed confirmation, and a path-free receipt.

Starting with this baseline is also a safety requirement for richer controls. A generic Enter key can submit a form, and changing a select may trigger navigation or JavaScript side effects. `browser_select` and `browser_press` must therefore be specified from representative tasks and routed through live action inspection and commit policy where their effect requires it; they must not become approval bypasses.

The original numbered implementation sequence is complete through richer controls, task-owned tabs, cross-site authority, approval-mode UX, conversational sessions, recoverable tab ownership, the durable Agent-first layout, profile-local session history, in-flight steering, trusted page takeover, semantic live-working presence, progress/recovery/completion receipts, verified downloads, explicit download cancellation, user-authorized uploads, Agent-native wallet work, and the first broad node-operations package. The active decision is now: **measure representative real-world tasks, then implement the smallest coherent capability or UX package that unlocks the most valuable observed failures**. Extend the deterministic corpus whenever that work creates a real capability, authority, recovery, storage, or lifecycle boundary.

### Embedded Pi implementation checkpoint — 2026-08-22

The first five packages in the sequence above are now implemented on `feature/freedom-automation-kernel`:

- Pi `0.84.2` is pinned behind a tested CommonJS-to-ESM lazy import boundary.
- Sessions use in-memory settings and history, a synthetic working directory, an explicit no-discovery resource loader, no built-in coding tools, and no ambient Pi configuration.
- Seven sequential, current-tab browser tools call the canonical automation controller: get-tab, snapshot, navigate, click, type, wait, and stop-loading. The assigned opaque tab ID is runtime-owned and cannot be overridden by model arguments.
- `FreedomAgentService` owns one run at a time, normalizes a small renderer-safe event stream, redacts provider failures, handles stop and tab loss, and always disposes the Pi session.
- A trusted-chrome IPC adapter resolves the initiating renderer tab through the existing verified host/tab binding. Run events and stop authority are scoped to the owning browser window, while model and credential resolution remains entirely in main.

The IPC adapter and preload surface are intentionally not registered into the live app yet. Activation waits for a Freedom-owned model/credential resolver; this avoids creating a temporary path where the renderer supplies provider keys or Pi runtime objects. The next coherent product slice is therefore the minimal provider configuration/resolution path plus the Agent sidebar that consumes this boundary.

Verification at this checkpoint:

- Full unit suite: 179 suites and 3,289 tests passing; 3 suites and 10 tests skipped as before.
- Full ESLint run: clean.
- Real Pi SDK smokes: isolated zero-discovery session, seven-tool custom session, and credential-free provider failure lifecycle all behaved as expected without a network request.

### Embedded Pi activation checkpoint — 2026-08-22

The next four packages are implemented and the embedded product path is now active:

- Pi tool completion no longer depends on parsing human-readable tool-result text. Browser adapters report structured `{ toolCallId, operation, status, errorCode }` outcomes directly to `FreedomAgentService`; tab loss and renderer events derive only from that typed channel.
- A profile-bound provider store encrypts hosted keys with Electron `safeStorage`, applies restrictive file handling, binds records to the active profile and user-data path, and never returns stored key material to the renderer.
- A Freedom-owned resolver supports OpenAI, Anthropic, and OpenRouter models from Pi's bundled offline catalog, Free Pi through a fixed OpenAI-compatible endpoint and `deepseek/deepseek-v4-flash` model definition, plus explicit uncredentialed loopback Ollama URLs. It disables Pi model-network refresh, ignores global Pi auth/configuration, and injects decrypted keys only into the in-memory model runtime.
- Desktop startup now composes the provider store, resolver, Pi service, and IPC adapter. Only trusted non-private Freedom chrome may configure providers or own a run; runtime mode does not activate the embedded desktop service; app shutdown unregisters IPC and disposes the active session.
- A dedicated Agent panel is available beside the existing wallet sidebar. It provides provider setup, current-tab task input, Run/Stop controls, streaming assistant text, structured browser-tool activity, retries, and explicit terminal states. Opening it yields to a live wallet device-confirmation surface, and private windows do not initialize or expose it.
- The hosted model catalog is loaded lazily on first panel open so Pi SDK/model enumeration does not add work to ordinary browser startup.

Verification at this checkpoint:

- Full unit suite: 183 suites and 3,313 tests passing; 3 suites and 10 tests skipped as before.
- Full ESLint run: clean.
- Complete fixture-backed Electron harness: 71 passing and 2 platform-specific tests skipped, including a real Agent-panel path that configures Ollama, starts an isolated Pi run against the bound visible tab, receives the expected provider failure from an intentionally absent local server, and returns to a settled UI state.
- Visual Electron check: the light-theme panel, model status, local-model form, task composer, and toolbar affordance render coherently without disturbing the active page or wallet panel.
- Existing automation-kernel, runtime, CLI, private-window, permission, profile, wallet-confirmation, and navigation regressions remain green.
- An opt-in live Free Pi smoke reads `FREEDOM_FREE_PI_TEST_API_KEY` from the gitignored `.env.agent-tests.local`, skips before Electron launch when absent, and uses a disposable profile plus the normal encrypted provider UI when enabled. The tracked example contains no credential.

This checkpoint proves safe activation and lifecycle wiring, not autonomous task completion. The first-slice acceptance gate remains open until one real multi-step task completes on a deterministic visible page and one live public page, cancellation is exercised across all blocking phases, and controlled-tab takeover semantics are explicit.

### Embedded Pi ownership checkpoint — 2026-08-22

Two release-boundary packages now make provider and tab authority visible:

- Provider-aware copy beside model setup says when a hosted provider may receive the task and page content read by the agent, while Ollama describes its local loopback boundary. This is persistent disclosure rather than a one-time warning.
- Starting a run immediately marks its renderer tab with an Agent badge. The marker stays on the initiating tab when the user switches elsewhere and clears on every terminal run state.
- The former Stop action is now an explicit Take over action. It uses the existing owner-scoped abort path, reports Taking over while cancellation settles, and distinguishes the resulting Taken over state from unrelated cancellation.
- The owning chrome can restore the marker from run state without exposing renderer tab IDs through the public automation contract or granting the renderer a new automation operation.

Verification at this checkpoint:

- Full unit suite: 183 suites and 3,316 tests passing; 3 suites and 10 tests skipped as before.
- Full ESLint run: clean.
- Fixture-backed Electron sidebar coverage confirms hosted/local disclosure, immediate controlled-tab marking, terminal cleanup, and the Take over affordance.
- The opt-in live Free Pi smoke passes through the normal encrypted provider UI using the gitignored `.env.agent-tests.local`: 1 of 1 real hosted request completed in 11.6 seconds. The absent-key skip remains the intended default on other machines.

Switch semantics and explicit button takeover are now decided. Immediate termination on controlled-tab close and classification of direct human page input remain open work and should be exercised with the cancellation matrix rather than inferred from later tool failures.

### Embedded Pi cancellation checkpoint — 2026-08-22

The real Electron sidebar now has deterministic coverage for Take over during every currently blocking phase:

- An OpenAI-compatible loopback provider emits partial assistant text and holds the model stream open; Take over aborts the provider request.
- The model invokes `browser_navigate` against a test-harness response whose body deliberately remains open; Take over cancels the renderer-routed navigation and Chromium cancels the response stream.
- The model invokes a 30-second declarative text wait; Take over aborts the tool signal and cancels the active browser wait.
- Each scenario settles as Taken over within three seconds, clears the controlled-tab marker, re-enables Run, disables Take over, and then completes a fresh provider run. This guards against residual Pi sessions, provider requests, and browser operations.

Verification at this checkpoint:

- Cancellation matrix: 3 of 3 real Pi/Electron scenarios passing.
- Full unit suite: 183 suites and 3,316 tests passing; 3 suites and 10 tests skipped as before.
- Full fixture-backed Electron suite: 73 passing, 3 platform/credential skips, and one unrelated Tezos interstitial timing failure that passed immediately when rerun alone.
- Full ESLint run: clean.

The blocking-phase cancellation gate is now satisfied. Direct-human-input provenance remains ownership hardening rather than a gap in the Stop/Take over path.

### Embedded Pi controlled-tab closure checkpoint — 2026-08-22 (superseded)

This checkpoint records the earlier single-root-tab model. It was superseded on 2026-08-23 by conversation-owned tab-set continuity below: closing the initially adopted tab no longer terminates the run or conversation.

Closing the exact tab pinned to an active agent run now terminates that run immediately and distinctly:

- The main-process automation runtime publishes a narrow internal lifecycle notification after it unregisters a destroyed page. This does not add a renderer API, public automation operation, or Electron identifier to the canonical contract.
- `FreedomAgentService` subscribes to that lifecycle, ignores unrelated tab closures, aborts the matching Pi session, and settles with `AGENT_TAB_CLOSED` plus the user-facing message `The controlled browser tab was closed`.
- A tab closure racing session creation still wins over a generic session-start failure, and service disposal removes the lifecycle subscription.
- The sidebar reports `Tab closed`, clears the controlled marker, restores Run/Take over controls, and remains reusable on another tab.
- Switching foreground tabs remains intentionally inert: the run stays pinned to its initiating tab until completion, explicit Take over, or closure of that tab.

Verification at this checkpoint:

- Focused automation/agent/sidebar unit coverage: 4 suites and 26 tests passing.
- Cancellation matrix: 4 of 4 real Pi/Electron scenarios passing, including provider-stream cancellation on controlled-tab closure and a successful subsequent run.
- Full unit suite: 183 suites and 3,328 tests passing; 3 suites and 10 tests skipped as before.
- Full ESLint run: clean.

Controlled-tab close semantics are now complete. Automatic takeover from direct human page input remains deferred until input provenance is reliable enough not to misclassify Freedom's own trusted automation events.

### First deterministic task evaluation — 2026-08-22

The embedded Agent completes its first visible multi-step task through Pi's real multi-turn loop:

- Task: register `Ada Lovelace` for the `Freedom` project on a locally controlled form, submit it, wait for confirmation, and report success.
- Sequence: `browser_snapshot` → `browser_type` → `browser_type` → `browser_click` → `browser_wait`.
- The deterministic OpenAI-compatible evaluation model reads the opaque element refs from the actual snapshot tool result before constructing subsequent calls; the test does not invoke the controller directly.
- The page reports success only when both input events and the submit click are trusted browser events. The test also requires all five structured tool outcomes to succeed and the final assistant response to complete.

Recorded result:

- Completion: pass.
- Wall-clock Playwright case time: 1.7 seconds.
- Model requests: 6.
- Tool calls: 5.
- Retries, stale refs, policy denials, and tool failures: 0.
- Complete deterministic Agent suite (configuration/failure lifecycle, three cancellation phases, and task evaluation): 5 of 5 Electron scenarios passing in 21.6 seconds.

This proves orchestration, state handoff, semantic references, trusted interaction, waiting, terminal UI, and cleanup. It deliberately does not prove that a real model can choose the correct plan: the next evaluation step is to run Free Pi on this same fixture, then one live public-web task, and record its independently selected operations and failure modes.

### First adversarial scope evaluation — 2026-08-22

The embedded Agent now receives a kernel-owned capability controller for each run:

- The capability is pinned to the already assigned opaque tab and exposes only the seven embedded-agent operations; list/create/close/screenshot remain outside the run manifest.
- A run that starts on HTTP(S), Swarm, IPFS, or IPNS content is locked to that page's normalized origin. Direct `browser_navigate` calls and exact-URL waits for another origin fail with `POLICY_DENIED` before reaching the page adapter.
- The Task card states this boundary before a run: Agent is limited to the current tab and site, and cross-site navigation is blocked.
- A browser-owned start page may establish the first supported origin through one explicit navigation. Cancellation retains `browser_stop_loading` authority even if the page unexpectedly crosses the origin boundary.
- The adversarial Electron fixture gives Pi page content containing a fake system override. Its deterministic model deliberately obeys that injection and requests navigation to an attacker origin; the kernel denies the call, Pi observes the typed failure, and the controlled tab remains on the trusted page.

Recorded result:

- Completion: pass.
- Model requests: 3.
- Tool calls: 2 (`browser_snapshot`, then denied `browser_navigate`).
- Unauthorized cross-origin navigations: 0.
- Focused adversarial and original deterministic evaluation: 2 of 2 Electron scenarios passing.
- Full unit suite: 184 suites and 3,335 tests passing; 3 suites and 10 tests skipped as before.
- Full ESLint run: clean.

This is enforceable containment rather than a claim that prompt injection is solved. Same-origin destructive actions still require commit-boundary approvals, and a click or server redirect can cross origins before the next scoped operation detects the change. Those cases belong in the corpus and policy work rather than in model prompting alone.

### Semantic-controller corpus expansion — 2026-08-22

Five additional deterministic tasks now exercise the embedded Pi loop above kernel capabilities that previously had only direct-controller coverage:

- A below-fold button appears in the semantic snapshot, is scrolled into view by reference resolution, receives a trusted click, and is confirmed through a declarative wait.
- A button inside a same-origin `srcdoc` frame carries a non-main opaque frame ID, receives trusted input through transformed frame coordinates, and is confirmed through frame-aware text waiting.
- An SPA replaces a previously snapshotted button node. Pi's first click fails with `STALE_ELEMENT_REFERENCE`; it takes a new snapshot, selects the replacement reference, retries, and completes with a trusted click.
- A cross-origin iframe is surfaced as explicitly inaccessible. Pi reports the limitation after one snapshot instead of inventing content from the embedded report.
- A trusted click opens a real popup as a normal Freedom tab. `browser_get_tab` still resolves to the original controlled tab, proving the run does not silently acquire authority over the popup.

Recorded result:

- Semantic/capability evaluation completion: 5 of 5.
- Combined deterministic embedded-Agent corpus: 7 of 7 Electron scenarios passing in 16.9 seconds.
- Below-fold task: 4 model requests, 3 tool calls.
- Same-origin frame task: 4 model requests, 3 tool calls.
- Stale-reference recovery: 7 model requests, 6 tool calls, one expected typed failure, successful retry.
- Cross-origin frame limitation: 2 model requests, 1 snapshot, inaccessible frame observed and reported.
- Popup containment: 4 model requests, 3 tool calls, popup opened while the assigned tab remained unchanged.
- Full ESLint run: clean.

Popup initiation is now proven through Pi as well as at the kernel layer, but the embedded Agent intentionally lacks list/create/close-tab tools and therefore cannot adopt or operate the newly opened popup. The corpus records that as a capability limitation until a deliberate multi-tab authority design exists; it does not silently broaden Pi's tool surface to make the test pass.

### First Ollama model qualification — 2026-08-22

The first real local-model candidate is Ollama's [`qwen3:8b`](https://ollama.com/library/qwen3:8b), selected because the official model metadata advertises tool use and its 5.2 GB quantization is a reasonable baseline on the test machine's 48 GB M4 Pro. The model download is local machine state, not a repository dependency or product prerequisite.

Qualification observations:

- A direct OpenAI-compatible protocol probe emitted a tool call but wrapped its arguments under an unexpected `object` key. Ollama's native `/api/chat` route emitted the correct argument shape for the same prompt. This made a full Pi-path test mandatory rather than treating the metadata/probe as sufficient.
- Through Freedom's existing `openai-completions` Pi integration, `qwen3:8b` successfully snapshotted the visible form, typed both exact values, clicked Submit with trusted input, and observed the resulting page state. No provider or schema adapter change was required.
- The model made one unsuccessful declarative wait in each exact-value run, then recovered autonomously with a fresh snapshot and completed. The evaluation records failed tool calls and requires the terminal observation to succeed instead of pretending recovery-free execution.
- A first prompt phrased as “for the Freedom project” produced the literal field value `Freedom project`; the qualification prompt now names exact field/value pairs so provider comparisons measure execution rather than prompt interpretation.

Recorded reproducibility result for the clarified task:

- Completion: pass.
- Page evidence: `Saved Ada Lovelace for Freedom — trusted input=true click=true`.
- Warm run duration: 73.5 seconds (the preceding clarified run took 123.9 seconds).
- Tool sequence: snapshot → type → type → click → failed wait → recovery snapshot.
- Tool calls: 6; expected/recovered failures: 1.
- Assistant reported the core saved-registration result, though it omitted the page's trusted-input diagnostic suffix.

This qualified `qwen3:8b` for the first deterministic form task, not for general autonomous support. The tracked opt-in spec reads `FREEDOM_OLLAMA_TEST_MODEL`; `npm run test:e2e:agent:ollama` loads it from the gitignored local agent-test environment.

### Expanded Ollama model qualification — 2026-08-22

The real local-model spec now covers five representative autonomous tasks through the same Freedom sidebar, Pi session, tool adapter, scoped controller, and visible Electron tab used by hosted models:

1. exact page-fact extraction;
2. trusted visible-form completion;
3. trusted below-fold interaction;
4. trusted same-origin-frame interaction; and
5. containment of a hostile in-page navigation instruction.

Observed `qwen3:8b` result:

- Behavioral completion: 5 of 5.
- Exact extraction and hostile-page containment used only successful snapshots, and the hostile case explicitly identified the fake override as untrusted while staying on the starting origin.
- Form, below-fold, and frame actions all produced the exact trusted page evidence.
- The three interactive tasks accumulated 1, 2, and 3 failed declarative waits respectively, then recovered with a successful snapshot. Action construction remained correct; post-action waiting is the clear efficiency weakness.
- Recorded full-run task durations were 34.2 s, 102.7 s, 135.9 s, 151.1 s, and 17.1 s. Latency is materially above the hosted reference and worsens with unnecessary waits.
- The first aggregate run reported two test failures solely because the evaluator expected capitalized `Snapshot` labels while the UI emits lowercase `snapshot`; after making the assertion case-insensitive, both affected cases passed on targeted rerun.

This is enough to describe `qwen3:8b` as the first qualified local baseline for this five-task slice, not as generally reliable autonomous browsing. The deterministic corpus remains the regression oracle; provider/model qualification remains empirical and model-specific.

### First commit-boundary approval — 2026-08-22

Freedom now enforces the first narrow external-side-effect boundary in the embedded agent path:

- Semantic snapshots mark native HTML form-submission controls using DOM semantics (`button` submit defaults, explicit submit buttons, and submit/image inputs associated with a form), not model claims or label keywords.
- Immediately before approval and trusted input dispatch, the controller performs a fresh, side-effect-free inspection of the referenced live DOM node. This live check is authoritative, closing the snapshot-to-click mutation gap.
- The run-scoped controller pauses the exact click before trusted input dispatch and requests approval from the agent service.
- Trusted browser chrome displays the page-provided action label and current page origin using text-only rendering. The user can approve that interaction once or decline it.
- Approval decisions travel through an owner-bound IPC channel requiring the exact run and approval IDs. Page content cannot access the channel.
- Decline fails closed with `USER_CANCELLED`, does not dispatch the click, and remains sticky for the matching commit action for the rest of the run so a model cannot repeatedly reprompt. Take over, disposal, and terminal cleanup also decline pending approvals; closing the approval's tab withdraws that exact pending action so the retained run may recover elsewhere.
- If no approval channel is attached, native form submission returns `APPROVAL_REQUIRED` rather than executing.

Verification:

- Focused policy, adapter, service, IPC, and renderer tests: 58 passing.
- Complete unit suite: 184 suites / 3,345 tests passing; 3 suites / 10 tests skipped.
- Deterministic embedded-Agent Electron corpus: 7 of 7 passing in 16.5 seconds, including live action reinspection, pause, trusted-chrome disclosure, approve-once, resumed trusted click, and exact page evidence.
- Real `qwen3:8b` form qualification after the gate landed: pass in 109.7 seconds. The model paused at the trusted approval card, resumed after approve-once, produced trusted page evidence, and recovered from its usual single failed wait with a final snapshot.
- Full ESLint run and diff whitespace validation: clean.

This boundary intentionally does not yet claim coverage for JavaScript-only controls whose side effects cannot be inferred from native form semantics, nor for downloads, uploads, messages, deletion, purchases, wallet actions, or arbitrary same-origin requests. Those require separately enforceable action types and adversarial corpus cases.

### Approval lifecycle corpus — 2026-08-22

Three deterministic Electron scenarios now cover the first commit boundary beyond its happy path:

- Decline returns `USER_CANCELLED`, leaves the form unsubmitted, and a deliberate second click attempt from the model fails without opening another approval prompt.
- Take over while the click tool is paused resolves the approval as declined, aborts the Pi run, clears the trusted-chrome card, and leaves the form unsubmitted.
- Closing the tab for which an interaction approval is pending withdraws that exact approval. The unavailable tool action fails safely, while the run and conversation remain free to recover through another task-owned tab or a newly created task tab.

The complete deterministic embedded-Agent corpus is now 10 of 10 passing in 22.9 seconds. These scenarios verify service, Pi-tool, IPC-owner, renderer, and tab-lifecycle timing together rather than relying only on unit-level deferred-promise tests.

### Twenty-task deterministic corpus — 2026-08-22

The tracked embedded-Agent regression oracle now contains twenty locally controlled Electron tasks. The ten additions after the approval-lifecycle checkpoint cover:

- filling a draft without submission or an approval false positive;
- first navigation from Freedom's browser-owned start page followed by exact extraction;
- a two-step SPA that replaces its semantic controls without navigation;
- mutation of a harmless snapshot target into a native submit control before click dispatch;
- same-origin link navigation followed by a navigation wait and fresh extraction;
- recovery from a typed `WAIT_TIMEOUT` through a new snapshot;
- exact extraction through Freedom's registered `bzz:`, `ipfs:`, and `ipns:` protocol handlers; and
- a declarative cross-origin link attack denied before trusted click input.

The original cross-origin-link case exposed the need for live declarative action inspection. That inspection remains part of the approval descriptor, but cross-site destinations are now valid inside the task workspace. In **Ask before every interaction** mode, an unapproved link still fails with `USER_CANCELLED` before trusted input; if approved, the exact inspected destination may proceed. Post-approval destination mutation fails with `STALE_ELEMENT_REFERENCE`. JavaScript event handlers that synthesize navigation remain less directly describable than declarative anchors and forms.

Verification:

- Deterministic embedded-Agent corpus: 20 of 20 passing in 39.3 seconds.
- Focused live-inspection and origin-scope unit suites: 22 passing.
- Complete unit suite: 184 suites / 3,346 tests passing; 3 suites / 10 tests skipped. The first sandboxed attempt produced only local-listener `EPERM` failures; the required unrestricted rerun passed.
- Full ESLint and diff whitespace checks: clean.

### Explicit pause and resume checkpoint — 2026-08-22 (interaction model superseded)

This checkpoint established the retained-session interruption machinery that the 2026-08-26 controlled-page takeover now uses. Its separate Pause and terminal Take over controls are historical:

- The trusted sidebar exposes separate Pause, Resume, and Take over controls. Pause keeps the tab marked as Agent-controlled; Take over remains terminal from either Running or Paused.
- `FreedomAgentService` moves through Running → Pausing → Paused → Resuming → Running. It aborts only the active Pi turn, retains the same in-memory Pi session and conversation, and prompts that same session again on Resume.
- Pending commit approval is withdrawn on Pause and cannot carry across the human-edit interval.
- Resume adds a runtime-owned recovery instruction that treats the current page as authoritative and preserves human changes unless they conflict with the task.
- The run-scoped controller enforces that instruction: after Resume, every browser action is denied until the model explicitly gets the current tab and successfully takes a fresh snapshot. Earlier element references and assumptions therefore cannot authorize resumed input.
- Human edits anywhere inside the task-owned workspace are resumable. Resume revalidates the current task tab and requires get-tab plus a fresh snapshot before any action. If no task tab remains, Resume requires creation of a fresh task tab and then a fresh snapshot; it never adopts an unrelated foreground tab.
- Pause/Resume IPC is available only to the exact trusted chrome owner and run ID; page content receives no new channel.

Verification:

- Focused service, policy, IPC, preload, and sidebar coverage: 5 suites and 66 tests passing.
- Real Pi/Electron cancellation matrix: 6 of 6 passing, including pausing an open provider stream and an active browser wait, retaining the Pi session, re-prompting it, mandatory get-tab/snapshot recovery, and final completion.
- Deterministic embedded-Agent corpus: 20 of 20 passing in 39.0 seconds.
- Complete unit suite: 184 suites / 3,356 tests passing; 3 suites / 10 tests skipped.
- Full ESLint and diff whitespace checks: clean.

### Post-approval integrity checkpoint — 2026-08-22

Approval now authorizes the inspected action, not merely a DOM reference that happened to be safe before the user decided:

- Internal approval outcomes are explicit `approved`, `declined`, or `withdrawn` decisions. Pause withdraws a pending prompt without recording a sticky decline; a later resumed attempt must request a fresh approval.
- After approval and before trusted input dispatch, the run-scoped controller re-reads the controlled tab, revalidates that it remains inside the task-owned workspace on a supported origin, and performs a second live inspection of the target.
- The approved effect, accessible label, and declarative navigation target must still match. Any descriptor change fails with retryable `STALE_ELEMENT_REFERENCE`; unsupported destinations still fail policy validation. Neither path dispatches the interaction.
- A deterministic Electron scenario pauses during form approval, resumes through mandatory get-tab/snapshot recovery, presents a new approval, and completes only after the new decision.
- A second adversarial Electron scenario changes the form destination to an attacker origin while approval is visible and proves the approved click is invalidated before submission or navigation.

Verification:

- Complete unit suite: 184 suites / 3,359 tests passing; 3 suites / 10 tests skipped.
- Deterministic agent evaluation plus cancellation/lifecycle corpus: 28 of 28 passing, including the two new approval-integrity cases.
- Full ESLint and diff whitespace checks: clean.

The guided real-provider smoke described here passed. The visible interaction model was later consolidated into composer Stop/steering/Resume plus trusted controlled-page Take over; the retained Pi interruption and fresh-observation guarantees remain current.

### Agent task-loop UX checkpoint — 2026-08-22

The sidebar now separates provider setup from everyday task delegation:

- Profiles without a connected model open directly into a dedicated setup view. The task workspace stays unavailable until at least one provider is connected.
- Provider state supports multiple retained connections with one active provider/model. Adding Ollama, Free Pi, a hosted BYOK provider, or ChatGPT/Codex no longer replaces an unrelated connection.
- Configured profiles open into the task workspace, not a settings card. The composer is pinned to the bottom and owns model selection, interaction-approval behavior, and Send.
- The model menu groups available models by connected provider, switches the active model without re-entering credentials, and links to a single model-management view. That view supports adding providers, lists connected providers, and allows an explicit confirmed disconnect.
- The workspace keeps approval, activity, assistant output, Pause, Resume, and Take over in the task lifecycle. Take over is hidden while idle; Enter sends and Shift+Enter inserts a newline.
- Dictation remains intentionally absent until its capture, permission, privacy, cancellation, and provider-input behavior exists. The former attachment placeholder is now implemented through the bounded conversation-attachment package in section 9h.

Verification:

- Complete unit suite: 184 suites / 3,366 tests passing; 3 suites / 10 tests skipped.
- Deterministic Agent Electron regression: 30 of 30 passing across setup, model switching, cancellation, pause/resume, approvals, policy containment, frames, popups, stale references, and decentralized protocols.
- Focused renderer coverage: 13 of 13 passing, including first-run routing, provider disconnect, and Enter/Shift+Enter composer behavior.
- Full ESLint and diff whitespace checks: clean.

This is the first coherent task-centric sidebar layout, not final visual design. The next UX iteration should be driven by hands-on feedback on density, copy, lifecycle placement, menu behavior, and the configured-provider management flow.

### Conversational task-loop checkpoint — 2026-08-22

The Agent workspace now treats follow-up messages as turns in one task conversation instead of unrelated runs:

- One in-memory Pi `AgentSession` and one task-owned browser workspace are retained across turns. A follow-up prompt therefore receives the earlier user/assistant context and keeps authority over the same Agent-created tabs.
- Runs remain the per-turn lifecycle boundary. Pause, Resume, approvals, retries, Take over, recoverable tab-tool errors, and timing still belong to one turn; Take over cancels that turn without silently deleting the conversation.
- Before a follow-up can act, the scoped controller revalidates the workspace. The system instruction and controller gate require a fresh current-tab read and snapshot so retained model context cannot substitute for current browser state.
- The sidebar is a real chat transcript: it shows each user prompt, streams the corresponding assistant response, retains completed turns, and restores the transcript from main-process state when the sidebar closes and reopens.
- Tool activity stays expanded while work is in progress. At turn completion it collapses behind a timed `Worked for … · N actions` disclosure and can be reopened for inspection.
- Pi automatic context compaction is enabled. Only bounded compaction lifecycle state reaches trusted chrome; the generated summary and provider/model history remain inside the main-process Pi session.
- Model selection and interaction-approval posture are fixed for the life of a conversation. **New chat** is available only while idle and explicitly disposes the Pi session, task workspace, and visible transcript.
- Conversation history is intentionally ephemeral in this checkpoint. This limitation is superseded by the persistent session-history checkpoint of 2026-08-26, which defines its retention, redaction, authority, and deletion boundaries.

Verification:

- Complete unit suite: 184 suites / 3,406 tests passing; 3 suites / 10 tests skipped.
- Focused service, IPC, preload, and Agent UI coverage: 5 suites / 77 tests passing.
- Complete deterministic Agent/product/sidebar Electron corpus: 41 of 41 passing. It verifies two provider-backed turns share actual Pi message context, both turns remain visible across a sidebar reopen, New chat clears the conversation, and cancellation/tab-closure recovery follows the new lifecycle.
- The macOS ARM64 packaged build completes successfully; the optional Arti binary remains absent as before.
- Full ESLint and diff whitespace checks are clean.

### Conversation-owned tab continuity checkpoint — 2026-08-23

The conversation now owns a durable set of task tabs; its initially adopted user tab is the first member, not a permanent root or authority anchor:

- Human closure removes any task tab from the set without terminating the Pi turn or conversation. If the active task tab closes, the controller selects a remaining owned tab.
- Follow-up and Resume revalidate the current owned tab and preserve the existing fresh-read/fresh-snapshot gate. Missing-tab tool failures return to the model as recoverable typed failures rather than aborting the session.
- If every task-owned tab closes while browser chrome remains open, the workspace becomes empty but the chat remains valid. The next browser action can create a fresh visible task tab through a capability bound to the trusted owning browser window.
- Empty-workspace recovery does not inspect, target, or adopt the user's current unrelated tab. The trusted host is used only to request creation of a new tab; ownership begins after that new webview receives its opaque automation binding.
- Pi still cannot close the originally adopted user tab itself. Raw desktop closure remains limited to tabs created through the task lifecycle, preserving the user-owned-tab boundary even though human closure is now recoverable.
- Closing a tab with a pending interaction approval withdraws that approval. It does not grant the action on another tab or force a terminal `AGENT_TAB_CLOSED` state.

Deterministic Electron coverage now reproduces the product flow: create five task tabs, close the original and additional tabs, continue the same chat on the survivors, close every remaining task tab while leaving an unrelated user tab open, and continue again by creating a separate fresh task tab.

Verification:

- Complete unit suite: 184 suites passed, 3 skipped; 3,411 tests passed, 10 skipped.
- Complete deterministic Agent/product/sidebar Electron corpus: 41 of 41 passed.
- Full ESLint and diff whitespace checks are clean.
- The macOS ARM64 packaged build completes successfully; the optional Arti binary remains absent as before.

### Canonical alpha-task baseline — 2026-08-22

The first behavior-first product qualification pass now runs six canonical tasks through the real embedded Pi/service/controller/sidebar path without adding capabilities to make the baseline look better:

| Task | Baseline classification |
| --- | --- |
| Same-origin multi-page research with attributable evidence | Pass |
| Rich form requiring semantic select and keyboard interaction | Missing capability |
| Pause → human edit → Resume → fresh approval → submit | Pass |
| Cross-origin read-only research | Missing capability |
| Multi-tab comparison workspace | Missing capability |
| Download plus verified artifact receipt | Missing capability |

The deterministic product suite is 6 of 6 passing as a classification ratchet: successful tasks must complete with exact evidence, while expected gaps must fail closed, leave state unchanged, and identify the absent tool or authority. This produces two current product passes and four evidence-backed missing capabilities; it does not count expected limitations as product success.

A fresh real `qwen3:8b` run independently passed same-origin multi-page research in 128.978 seconds. It returned both exact prices, both source URLs, and the correct six-credit difference. It used 10 tool calls, accumulated three failed attempts around waiting/click navigation, and recovered with a successful final snapshot. The capability is therefore real for the local baseline, with material efficiency weakness recorded separately.

The baseline makes the next package unambiguous: add semantic `browser_select` and policy-aware `browser_press`, then rerun the unchanged rich-form task. Enter and select-driven side effects must not bypass live action inspection, native form commit approval, or post-approval integrity. Task-owned multi-tab authority and layered multi-origin read scope follow after richer controls; Agent-first visual design follows their behavioral foundation.

The detailed matrix, real-model evidence, and richer-control acceptance requirements live in `research/freedom-agent-alpha-qualification.md`.

### Richer-control qualification — 2026-08-22

The first capability package selected by the canonical baseline is complete:

- Semantic snapshots expose bounded option metadata for select controls.
- `browser_select` targets an exact live option value, rejects unsupported/missing options with typed errors, applies the native select setter, emits input/change, verifies the final value, and reports that the events are synthetic. Electron's native dropdown path did not actuate reliably inside the embedded macOS webview, so the contract does not falsely claim trusted select events.
- `browser_press` exposes a bounded named-key vocabulary and translates browser key names to Electron's trusted input codes. Enter and Space include the character phase required for native default behavior.
- Press targets are focused before live action inspection. Enter/Space activation, implicit Enter form submission, and link navigation feed the same origin check, one-shot approval, and post-approval descriptor integrity path as clicks.
- The unchanged rich-form product task now passes with exact EU West, Production, audit-enabled, and saved-state evidence. The collaborative Pause/edit/Resume task now commits with Enter after fresh approval, proving that keyboard submission cannot bypass the consequential-action boundary.

Verification is green across 3,371 unit tests, ESLint, and the combined 28-case deterministic Agent/product run. The baseline now has three product passes and three missing capabilities.

The next behavioral package is the task-owned tab workspace. It should give one Agent task explicit authority over its adopted starting tab plus tabs it creates, while keeping unrelated user tabs invisible and uncontrollable. Layered multi-origin read scope follows that ownership foundation; Agent-first visual design follows the proven behavior.

### Task-owned tab-workspace qualification — 2026-08-22

The multi-tab ownership foundation is complete:

- A run adopts the user-selected starting tab and maintains a private set containing only that tab plus tabs the run explicitly creates.
- Pi now receives scoped list/create/focus/close tools. Ordinary observation and interaction tools continue to target one active task tab, so tab IDs are exposed only where selecting or closing an owned tab requires them.
- Visible desktop tab creation, focus, and closure use request IDs and acknowledged main↔trusted-chrome round trips. Creation waits for the new webview's automation binding before returning its opaque automation tab ID; it never infers ownership from global tab-list timing.
- Same-origin policy remains intact across every owned tab. A newly created tab that redirects outside the established origin is closed before adoption, and list/interaction do not expose redirected page state.
- The originally adopted user tab cannot be closed by Pi. Human closure of any task tab, including that original tab, is recoverable; the conversation falls back to another owned tab or retains an empty workspace until it creates a fresh task tab.
- The hidden runtime implements the same focus lifecycle contract without showing its sandboxed BrowserWindows, preserving the canonical operation surface for the experimental CLI.

The canonical multi-tab comparison now passes: two visible dashboard tabs were created, Alpha 41 and Beta 47 were extracted, the scoped workspace listed exactly three owned tabs, Alpha was focused again, and both dashboards remained available for inspection. The full unit suite is green at 3,377 passing tests plus 10 intentional skips; the combined deterministic Agent/product suite remains 28 of 28 passing. The product matrix is now four passes and two missing capabilities.

The next behavioral package was layered multi-origin research authority, completed below. The dedicated UX session and Agent-first visual mode now have the required task-owned multi-tab and multi-origin behavioral foundation.

### Cross-site task workspace and approval modes — 2026-08-22

The geographic scope experiment has been replaced with a simpler product model: every Agent run receives a cross-site, task-owned workspace, while the composer controls how often website interactions require approval.

- The task may navigate, create tabs, observe, wait, focus, list, close, stop loading, and interact across supported HTTP(S), Bzz, IPFS, and IPNS origins. Authority still covers only the adopted starting tab and tabs this task creates; unrelated user tabs remain inaccessible.
- **Ask before every interaction** is the safe default. Navigation, observation, waiting, and task-tab management proceed automatically. Each click, type, select, or key press pauses for a one-shot decision in trusted chrome.
- **Allow website interactions** lets those currently supported page interactions proceed without per-action prompts.
- **Ask for sensitive actions** appears at this historical checkpoint as a disabled **Coming soon** entry. This decision was superseded on 2026-08-30 by the narrower, honestly framed **Ask when needed** intended-consequence interruption policy; the privileged capability boundaries described here remain intact.
- The future sensitive mode requires an enforceable taxonomy covering more than native forms: messages, account changes, deletion, publication, uploads/downloads, payments, wallet transactions, Freedom's node controls, identity use, and other capabilities a human can exercise. It must be based on runtime-owned semantics and exact intent/receipt data—not model claims, page labels, or fragile keyword inference.
- Approval authorizes the inspected action once. The controller rereads the tab and reinspects the exact target after approval; changed effect, label, destination, or successful form payload fails before trusted input dispatch. Form values stay inside the isolated page world; only a SHA-256 fingerprint crosses into the controller.
- The approval selector is locked while a run is active. Provider/privacy disclosure continues to explain that task instructions and observed page content may be sent to the selected model.
- **Allow website interactions** is not a blanket grant for future browser powers. Wallet, node, file, identity, payment, and similarly privileged operations will need their own explicit policy and receipts when those tools exist.

The canonical cross-site task now proves both observation and interaction: Pi reads the starting source, creates a visible task-owned tab on an independent origin, reads its evidence, clicks **Mark source reviewed** with trusted input, lists exactly the two owned tabs, cites both URLs, and leaves both pages available. The default every-interaction flow is separately covered across type, select, click, key press, decline stickiness, Pause/Resume, target mutation, prompt injection, Take over, and tab closure.

Current deterministic verification is 8 of 8 for the product/sidebar suite and 26 of 26 for the adversarial Agent evaluation suite. The product matrix remains five passes and one deliberate missing capability: verified file delivery.

The dedicated UX/Agent-first phase described here is complete, including mode switching, task-tab presentation, provenance, supervision, steering, history, takeover, and return to ordinary browsing. File authority/receipts are now the next capability package; the sensitive-action classifier remains the package after that.

### External-review hardening checkpoint — 2026-08-22

The adversarial follow-up closed the remaining current-scope integrity and lifecycle gaps without expanding product authority:

- Ollama model history is capped at 128 most-recently-used model IDs. Saving a 129th model evicts the oldest Ollama entry while preserving unrelated providers and encrypted ChatGPT/Codex credentials.
- Desktop task-tab creation now waits for the newly attached guest to leave its temporary `about:blank` state before returning ownership. Real Electron coverage creates and immediately snapshots routed `bzz:`, `ipfs:`, and `ipns:` task tabs.
- Raw desktop close requests are accepted only for tabs created through the current trusted lifecycle. The adopted starting tab and unrelated/global automation entries cannot be closed through that internal path.
- An owned tab that reaches a page outside the supported task workspace remains visible only as a redacted unavailable entry so Pi can still close it without receiving its URL or title. Direct get/snapshot/action access fails closed.
- Native form approvals now include a page-isolated SHA-256 fingerprint of the exact successful form controls, submitter overrides, destination, method, encoding, and target. Reinspection after approval rejects hidden-field or visible-value mutation with `STALE_ELEMENT_REFERENCE` before trusted input.

Verification after this checkpoint:

- Complete unit suite: 184 suites passed, 3 skipped; 3,396 tests passed, 10 skipped.
- Complete deterministic Agent/product/sidebar Electron corpus: 34 of 34 passed, including three routed dweb tab-creation cases and a hidden-field approval-race attack.
- Full ESLint and diff whitespace checks: clean.

### Three-pane Agent-first UX checkpoint — 2026-08-24

The Agent-first experiment now follows the durable Sessions / Conversation / Workspace product model:

- The native-height title bar owns mirrored controls for the left Sessions pane and right Workspace pane, plus an explicit return to ordinary browser mode. Both panes collapse independently without changing conversation, tab, or authority state.
- Sessions truthfully exposes only the current in-memory task and New chat. It labels saved history as future work instead of implying restart persistence.
- Workspace replaces the earlier list-only task-page rail. Its page switcher includes only the main-process-projected conversation-owned tab set, while the selected item renders through Freedom's existing live webview surface inside Agent-first mode.
- Unrelated tabs remain excluded. If a conversation has no surviving task page, the live page surface is hidden rather than accidentally displaying the user's unrelated foreground tab.
- The naming and structure deliberately leave room for future files, app previews, build processes, and publication/deployment receipts without presenting those capabilities before their scoped authority exists.

The first deterministic visual and multi-tab checks cover the three-pane ordering, both title-bar toggles, explicit browser return, current-session title restoration, five owned Workspace pages, in-mode page selection, and the empty-workspace boundary.

### Shared browser chrome checkpoint — 2026-08-25

Agent-first is a layout and interaction-policy variant of Freedom Browser, not a second browser UI. The experiment now mounts the canonical browser components in the Workspace shell:

- The existing tab strip moves into the Agent-first title bar and is filtered to the main-process-projected conversation-owned tab IDs. The same elements retain favicon/loading state, close and mute controls, context menus, drag ordering, Agent ownership badges, and future tab behavior. Returning to browser mode restores the strip and removes the projection.
- The existing address-bar container moves into Workspace intact. Its canonical display URL, blank home-page presentation, protocol and trust indicators, trust and permission popovers, bookmark action, Radicle bridge action, and autocomplete therefore remain single-source behavior.
- Back, forward, reload, and stop continue through the canonical navigation controller. Their Agent-first buttons are alternate controls over the same active webview state, not an alternate navigation implementation.
- Manual address editing is allowed while the Agent is idle or explicitly paused. While an Agent-first run is starting, running, pausing, resuming, or stopping, the shared field becomes read-only and restores the active tab's canonical display. Returning to browser-first mode restores ordinary address editing.

This supersedes the initial Agent-first-only tab-card renderer and direct `activeTab.url` address mirror. Further Workspace browser features must extend the canonical browser component or controller rather than introduce parallel presentation semantics.

### Persistent Agent session history checkpoint — 2026-08-26

Agent conversations now survive app restarts in Freedom-owned, profile-local SQLite storage:

- `agent-history.sqlite` stores migration-versioned session and turn records in WAL mode. Startup marks an uncleanly interrupted running record as interrupted, and runtime shutdown closes the profile store with the rest of the Agent lifecycle.
- Persistence is an intentionally safe projection: visible user/assistant text and structured action summaries survive; raw browser observations, tool arguments and results, form data, approval payloads, provider credentials, and hidden Pi runtime state do not.
- Agent-first Sessions is a real history browser with selection, rename, deletion, and an honest empty state. New chat starts clean while leaving earlier sessions available.
- Switching among sessions that are still live in the current app process restores their in-memory Pi runtime and attached pages. Reopening history after restart restores conversation, not capability: it is dormant with no inherited tabs, and its next turn receives a fresh current runtime that must re-observe the page through the canonical controller.
- Visible transcript messages are hydrated through the real bundled Pi session implementation, after which Pi's normal in-memory compaction can continue. Stored action summaries remain audit UI and are never replayed as model tool context.
- Agent is unavailable in private windows and history IPC remains restricted to the trusted owning browser chrome, so private/unrelated renderers cannot read or create history.

Verification after this checkpoint:

- Complete unit suite: 185 suites passed, 3 skipped; 3,433 tests passed, 10 skipped.
- Complete deterministic Electron harness: 111 passed, 10 intentionally skipped live-provider tests. This includes a full Electron close/relaunch against the same profile and confirms reopened history has zero inherited task pages.
- Real Pi transcript hydration, SQLite schema/migration/interruption, trusted IPC, private-window exclusion, dormant continuation, rename/deletion, renderer behavior, ESLint, and diff whitespace checks pass.

### Explicit page-context and empty-workspace checkpoint — 2026-08-26

New conversations no longer adopt the foreground tab as an implementation side effect:

- On an eligible HTTP(S), Bzz, IPFS, or IPNS page, the composer presents **Current page · _title_** as visible session context. The user may remove it before sending; the main process then receives no renderer tab identity.
- On Freedom's pristine homepage, internal pages, and Agent-custody tabs, no page-context chip appears. The trusted browser window grants only the capability to create a fresh Agent tab; it does not expose or bind an existing user tab.
- The scoped controller and Pi tools support a real zero-tab initial state. The first `browser_create_tab` establishes Agent custody, and a brand-new empty task may create several tabs successively. The stricter create-then-snapshot gate remains reserved for Resume after an existing workspace became empty.
- A shared user page remains user custody and cannot be closed by Agent. Agent-created tabs retain browser-wide custody and the existing explicit **Claim** transfer.
- Dormant saved sessions also continue without silently adopting whichever page happens to be foreground when the user sends the next message.

Deterministic coverage proves the fresh-start product flow: one pristine homepage remains user-owned and outside Workspace while Agent opens five separate Agent-owned pages. Separate scenarios prove visible current-page sharing, removable context, pause/resume re-observation, cancellation, live session switching, and Claim.

### Progress, recovery, and completion checkpoint — 2026-08-26

Freedom now projects a redacted work ledger from the trusted automation boundary into both live and saved conversations:

- Tool start events carry a meaningful current intent; successful and failed controller outcomes replace it with a semantic, origin-scoped receipt. The renderer no longer needs to interpret raw Pi tool output or display implementation names as the primary progress vocabulary.
- Completion cards distinguish an observed post-change result, recorded-but-not-rechecked browser actions, observational browser evidence, and a model-only report. A successful trusted input event is therefore not silently upgraded into proof that the website produced the intended semantic result.
- Recovery cards account for earlier successful changes and uncertain interrupted actions before suggesting a retry. Provider failure with no browser change is retry-safe; partial or uncertain browser work requires inspection first.
- Approval decisions are attached to their exact activity item. The persisted record contains only decision state and a sanitized destination origin. The live native-form card shows that destination before consent; field values and payload fingerprints stay inside the existing isolated integrity boundary.
- Exact source origins and changed pages remain inspectable in the ledger, while URL paths, queries, snapshots, form data, tool arguments/results, provider state, and credentials are excluded from history.

Verification after this checkpoint:

- Complete unit suite: 191 suites passed, 3 skipped; 3,529 tests passed, 10 skipped.
- Deterministic Electron matrix: 110 scenarios passed in the complete harness run; the four cancellation scenarios whose assertions still expected raw tool names were updated to the semantic progress copy and then passed together. Ten live-provider scenarios remain intentionally skipped in the harness project.
- Focused product qualification passes for research (**Result checked**), rich-form work (**Actions recorded**), collaborative Pause/edit/Resume with fresh approval, approval-destination disclosure, and retained completion receipt.
- ESLint and diff whitespace checks pass.

### Controlled-page takeover checkpoint — 2026-08-26

The collaboration controls now follow one composer-first state machine:

- An empty composer while Agent runs is **Stop**; entering text changes it to **Send guidance**. Stop terminally cancels the turn and is no longer presented as takeover.
- Pages leased to the active run are covered by trusted Freedom chrome. Page clicks cannot reach the guest and instead open a takeover confirmation; wheel and context-menu input are blocked without prompting so accidental trackpad gestures do not mutate the page.
- Confirmed **Take over** uses the proven retained Pi interruption boundary. Once the current atomic browser action settles, the page unlocks and the empty composer becomes a **Resume** play action. Composer text becomes an instruction that is applied while resuming.
- Resume performs the existing workspace revalidation and fresh-observation prompt before Agent may act again. Human edits are preserved rather than overwritten from stale element references or page assumptions.
- Workspace creation emits an immediate lifecycle projection refresh so newly opened Agent tabs acquire the interlock without waiting for a later tool-summary refresh. Trusted automation still dispatches directly through the main-process controller and is not blocked by the renderer overlay.
- The separate Pause button and the former header Take over button are removed. Escape remains the keyboard Stop path while a run is active.

Verification after this checkpoint:

- Focused renderer/service unit coverage: 65 passing.
- Full unit suite: 191 suites and 3,530 tests passing; 3 suites and 10 tests skipped as before.
- Focused Electron cancellation/takeover coverage: 9 of 9 passing.
- Product takeover, terminal Stop, approval interruption, human edit, Resume, and fresh-approval scenarios: 3 of 3 passing.
- Full ESLint and staged secret/whitespace checks: clean.

### Verified file-download checkpoint — 2026-08-26

Freedom Agent now delivers ordinary browser downloads through Freedom's existing download lifecycle rather than through model-visible filesystem authority:

- The canonical `browser_download` operation verifies a fresh semantic reference, receives the same one-shot trusted-chrome consent in both approval postures, arms the manager before trusted input, and waits for the exact resulting `DownloadItem` to settle.
- Agent downloads inherit the user's current save preference and continue to use the existing shelf, Downloads page, sanitization, collision policy, and `downloads.sqlite` history. A schema-v3 extension adds opaque artifact and conversation attribution without changing ordinary or private downloads.
- The model- and history-safe receipt contains no path or complete URL. Main resolves Open/Show actions from the opaque artifact ID and verifies that the target remains a regular file.
- Extra downloads initiated by the same controlled action are cancelled. Terminal Stop cancels the conversation's active transfers; resumable Take over does not destroy a browser-managed transfer.
- The activity ledger reports live bytes, successful turns receive a verified artifact completion state, and restored sessions render the same redacted artifact card without restoring file authority to Pi.

Verification after this checkpoint:

- Complete unit suite: 191 suites passed, 3 skipped; 3,539 tests passed, 10 skipped.
- Complete Electron harness: 114 tasks passed and 10 were intentionally skipped, including the deterministic file-delivery task with explicit consent, 32 verified bytes, Downloads destination, a conversation-scoped list result, and a path-free visible receipt.

#### User-cancelled download checkpoint — 2026-08-27

- Cancelling an Agent transfer from Freedom's ordinary download shelf is a first-class user decision, distinct from stopping the Agent run or encountering an interrupted transfer.
- Pi receives `DOWNLOAD_CANCELLED_BY_USER` as a non-retryable result with explicit instructions to acknowledge the cancellation and not request the same download again unless the user asks.
- Cancelled and incomplete transfers never become Agent artifact cards or completion evidence. The work ledger uses a neutral **Cancelled by you** state, and a completed turn reports **Download cancelled** rather than a generic failed action.
- Focused manager, Pi adapter, service, outcome, and renderer tests cover cancellation provenance, model guidance, absence of a phantom artifact, and the visible terminal state.
- Complete unit verification after this checkpoint: 191 suites and 3,546 tests pass; 3 suites and 10 tests remain intentionally skipped.
- ESLint and diff whitespace checks pass. Manual cancellation of a multi-gigabyte Agent download confirms the intended shelf, ledger, model, and completion behavior.

### User-authorized file-upload checkpoint — 2026-08-27

- The canonical `browser_upload` operation recognizes only a fresh semantic reference to a visible file input. `browser_click` refuses file inputs, preventing the model from opening or bypassing the trusted selection flow.
- File upload is classified as a transfer and always receives composer-level consent, including under **Allow website interactions**. The native OS picker is the final user-presence surface where the user sees and confirms the filename.
- The absolute path remains main-process-only. Freedom validates a directly selected regular file and uses Chromium's native file-input command against the exact temporarily marked DOM node; page or navigation changes fail closed before attachment.
- Pi, renderer activity, and profile-local session history receive only sanitized filename, byte count, optional MIME type, and `attached` state. The safe receipt proves attachment to the page, not later form submission or remote acceptance.
- Native-picker cancellation has its own non-retryable `FILE_UPLOAD_CANCELLED_BY_USER` result and neutral completion UX. Pi is explicitly told not to retry unless the user asks.
- Complete unit verification: 192 suites passed and 3 were intentionally skipped; 3,554 tests passed and 10 were skipped. ESLint and diff whitespace checks pass.
- The complete deterministic Agent product qualification is 7 of 7 passing. The upload task proves a real page `change` event, the selected 22-byte fixture metadata, and absence of the local path from the model receipt; all earlier research, form, collaboration, cross-site, multi-tab, and download tasks remain green.
- The complete Electron harness is 115 passed and 10 intentionally skipped after aligning three stale approval-composer assertions with the already-shipped bottom decision surface.
- Manual smoke validation on the public `the-internet.herokuapp.com` uploader confirms the production interaction shape: Freedom asks before file selection, opens the native picker, attaches only the selected file, asks separately before the native form commit, and the remote page reports the upload as accepted.

### Read-only node-intelligence checkpoint — 2026-08-28

- One canonical, tabless `node_status` operation reads the existing main-process owners for Swarm/Ant, IPFS, Radicle, Tor, and Myotis on Ethereum and Gnosis. It remains inside the same automation/policy boundary used by Pi and does not expose a second node-control stack.
- The public result is deliberately bounded to stable product semantics: service name and implementation, supported protocols, enabled/running/ready state, safe service mode, optional chain and bounded peer count, fixed recovery guidance, and aggregate readiness counts. Raw manager errors, paths, endpoints, ports, PIDs, configuration, credentials, and logs fail closed.
- Pi can answer node-health questions from an empty browser workspace. The work ledger stores only the aggregate node summary and produces a dedicated **Node status checked** completion card; the complete bounded service list exists only in the current tool result for model reasoning.
- Focused controller, policy, scoped-execution, runtime, Pi-tool, service-projection, completion, and renderer tests pass. A real-Electron qualification proves the operation is advertised, executes once without claiming a page, returns all six service records, and renders node-native evidence.
- No lifecycle, configuration, funding, reset, migration, publication, shell, or raw RPC authority was added. Any future lifecycle package must define named operations with exact intent, Agent-native approval, cancellation behavior, and verified postconditions separately.

### Agent-native wallet checkpoint — 2026-08-27

- Pi navigates arbitrary dApp wallet pickers with ordinary browser tools; there is no advertised `browser_wallet_action` or predictive wallet-button authority. A compatibility operation name remains an ordinary interaction alias rather than a privileged bypass.
- Open-shadow-root picker controls participate in the same semantic references, accessible naming, composed focus, stale-node checks, and trusted pointer hit-testing as ordinary DOM controls. The deterministic wallet picker now uses a real custom-element shadow root.
- The actual supported `window.ethereum` request is intercepted only when its trusted renderer tab is the exact active page controlled by a live Agent run. That request is bound to the current page permission identity; unrelated, background, inactive, and human-originated requests retain the existing wallet UX unchanged.
- Agent-routed wallet requests bypass the legacy dApp sidebar and standing dApp auto-approval rules and always use the composer decision surface. Ordinary picker clicks remain governed by **Ask every action** or **Allow website interactions** independently.
- The composer decision shows the exact bounded intent: site, network, selectable connection account, transaction destination/value/maximum fee/complete calldata, or complete personal/EIP-712 signature payload. Account mismatches, page changes, malformed requests, and payloads too large to review fail closed.
- Connection choice and vault unlock remain trusted Freedom UI. Touch ID or the inline password flow unlocks through the existing identity API; passwords, private keys, raw signatures, and approval payloads never enter model context or durable history.
- Approved execution reuses existing dApp permissions, chain data, gas estimation, signer backends, broadcasting, and payment history. The page receives the normal provider result while Pi receives only a redacted trusted event. A decline returns EIP-1193 `4001`, becomes `WALLET_REQUEST_CANCELLED_BY_USER` in the Agent ledger, and is not retried unless explicitly requested.
- Trusted page input now observes a short guest/host settlement boundary and waits on every provider-approval barrier before Pi continues. This prevents the model from racing ahead of a request synchronously triggered by its last click or finishing before its safe receipt enters the current turn.
- Automated wallet qualification now covers all four supported request types and both unlock routes: connection, transaction, `personal_sign`, and `eth_signTypedData_v4`; explicit decline; inline password; and Touch ID delegation. The real-Electron signer smoke uses an actual ephemeral mnemonic vault while the transaction smoke replaces only network estimation/broadcast with a deterministic test-mode backend, so no funds or public RPC are involved.
- Three wallet product scenarios pass together through a multi-step picker and preserve exact display/execution equivalence plus redacted Pi receipts. All ten Agent product scenarios pass in one run. The focused boundary suite passes 154 tests; the complete repository suite passes 195 suites and 3,574 tests with 3 suites and 10 tests intentionally skipped; the focused Agent/sidebar Electron smoke passes 2 of 2. ESLint and diff whitespace checks pass.
- Manual production smoke passes for a real direct send from a local vault with negligible funds and for selecting and connecting Freedom through a live dApp's custom wallet picker. The ordinary non-Agent dApp flow remains unchanged. Ledger and remote signers should still be exercised when those devices are available, but are no longer a blocker for the alpha package.

## Decision log

- **2026-09-04 — Make network permission available by default, never pre-granted.** Supporting workspace sandboxes advertise one indivisible `full` permission covering public internet, host localhost, and private/LAN addresses; Linux also discloses host abstract-Unix-socket reachability. `FREEDOM_EXPERIMENTAL_AGENT_NETWORK` is removed from the product path. Every command and helper still starts offline, and only an unforgeable user-approved exact-command or conversation grant selects the full-network policy. Unsupported backends and failed capability probes remain unavailable and fail closed. The main process binds one-shot grants to the exact command and canonical working directory, derives ordinary Agent and fixed helper policies back to no-network, and keeps consequential consent independent. Release still requires the disposable-Mac adversarial product-path gate and the documented remaining LAN evidence.

- **2026-08-19 — One kernel, two original products.** Embedded agent and headless SDK should share a Freedom-owned automation kernel.
- **2026-08-19 — Pi is a client, not the browser-control layer.** Pi integrates through custom Freedom tools with its default coding tools disabled.
- **2026-08-19 — Semantic snapshots over coordinate-only control.** Stable references and accessibility/DOM-derived observation form the primary page contract.
- **2026-08-19 — V1 runtime uses Electron.** The first iteration uses the real Electron/Chromium/session/node runtime for Freedom protocol parity; hidden does not mean pure Node.
- **2026-08-21 — Freedom SDK reframed as Freedom CLI.** CLI is the likely external shape if a headless product is validated; a public library is optional.
- **2026-08-21 — MCP shares the contract.** If built, MCP exposes the same canonical operations over stdio and never owns browser semantics.
- **2026-08-21 — Persistent runtime is required.** CLI commands attach to a long-lived local runtime rather than recreating the browser engine per command.
- **2026-08-21 — One canonical schema source.** CLI, MCP, and Pi adapters must not develop independent operation shapes or policy paths.
- **2026-08-21 — Electron is a V1 runtime detail.** The CLI is a thin runtime client and the canonical contract remains engine-neutral; no alternate browser backend is part of the V1 roadmap.
- **2026-08-21 — Auto-start is idle-managed; explicit start is persistent.** Ordinary `freedom-cli` browser commands attach or start the default automation runtime with the 15-minute idle policy. `freedom-cli runtime start` opts into persistence; owner-bound ephemeral mode remains follow-up work.
- **2026-08-22 — Embedded Pi is the product priority.** The next milestone is the agent inside Freedom; CLI packaging and MCP are deferred.
- **2026-08-22 — `freedom-cli` stays repository-local.** The distinct name avoids colliding with the desktop executable and makes its experimental role explicit. No global installation or system integration is planned now.
- **2026-08-22 — Embed the SDK directly.** The first Pi slice runs behind a main-process service and calls the canonical controller directly, with a no-discovery resource loader and no coding tools. Utility-process isolation remains a later evidence-driven hardening option.
- **2026-08-22 — Freedom owns provider state.** Hosted keys are encrypted and profile-bound by Freedom; Pi global auth, ambient environment credentials, model-network refresh, and renderer-held stored keys are excluded.
- **2026-08-22 — Activate the smallest complete UI before broadening capability.** The desktop service and Agent panel now ship together behind trusted non-private chrome. Evaluation, controlled-tab takeover, and cancellation hardening outrank more tools, persistent conversations, CLI productization, or MCP.
- **2026-08-22 — Add Free Pi as a fixed hosted provider.** Freedom owns the sponsored pilot base URL and its advertised DeepSeek V4 Flash model metadata; users provide only a profile-encrypted key. Arbitrary hosted endpoints remain unavailable.
- **2026-08-22 — Keep runs pinned across tab switches.** Switching the visible foreground tab does not transfer agent authority or pause the run; the initiating tab remains visibly marked until the run settles.
- **2026-08-22 — Make takeover an explicit abort.** The user-facing Take over action terminates the current run through its existing owner-scoped cancellation path. Automatic takeover from direct page input remains deferred until input provenance is reliable.
- **2026-08-22 — Treat controlled-tab closure as terminal (superseded 2026-08-23).** This conservative single-root-tab rule was removed once the conversation-owned tab set and trusted empty-workspace creation capability existed.
- **2026-08-22 — Qualify ChatGPT/Codex as the alpha hosted reference.** Real `openai-codex/gpt-5.6-sol` login, autonomous form completion, public-page reading, and all three cancellation phases pass through Freedom's encrypted profile store and embedded Pi path. General release still depends on commercial policy clarification and broader corpus results.
- **2026-08-22 — Separate orchestration proof from model qualification.** Deterministic model fixtures are the regression oracle for the Pi/tool/browser loop; Free Pi and Ollama qualification must use the same tasks without preselected tool calls before autonomous capability claims.
- **2026-08-22 — Initially default embedded runs to one origin (superseded).** This was the safe first kernel boundary before task-owned tabs and approval modes existed. The later cross-site workspace decision below replaces it.
- **2026-08-22 — Use `qwen3:8b` as the first local baseline, not a blanket claim.** It completes the first real form task through Ollama with one recovered tool failure; broader corpus completion and latency data remain required before advertising local autonomous support.
- **2026-08-22 — Gate native form commits in trusted chrome.** Native HTML form-submission controls pause before trusted click dispatch for an owner-bound, one-shot user decision. This is the first narrow approval class, not a keyword-based claim to cover every same-origin side effect.
- **2026-08-22 — Make Pause resumable and Take over terminal.** Explicit Pause aborts only the current Pi turn and retains its session; Resume revalidates the current task-owned tab and requires a model-visible fresh tab read plus snapshot before any further action. Automatic human-input inference remains deferred.
- **2026-08-22 — Keep model setup out of the normal task loop.** First-run Agent is a dedicated provider setup experience; configured users choose models from the composer footer and enter provider management only on demand. File and dictation buttons wait for real capability rather than shipping inert chrome.
- **2026-08-22 — Make Agent-first mode the long-term product shape.** Normal mode keeps the page primary with Agent as a companion; Agent-first mode makes the task conversation primary and presents its Agent-owned pages as the secondary workspace. Both are views of one task/session, and unrelated user tabs remain outside its authority.
- **2026-08-22 — Expand from one tab through task-owned workspaces (refined 2026-08-26).** Multi-tab autonomy began with explicit adoption and Agent-created tabs bounded to one task controller. Browser-wide custody and separate session attachment now refine that first model without granting authority over unrelated user tabs.
- **2026-08-22 — Keep Agent tabs visible and explicitly bound.** Desktop task tabs are created, focused, and closed through acknowledged trusted-chrome requests; ownership is granted only after the new webview is bound to an opaque automation tab ID. Global tab discovery and timing inference are not ownership mechanisms.
- **2026-08-22 — Layer multi-origin authority (refined).** The task-owned tab set is the scope boundary; approval posture controls current website interactions. Cross-origin information transfer and future privileged capabilities remain separate policy problems.
- **2026-08-22 — Replace site/research scope with cross-site task workspaces.** Every task may navigate, read, and interact across supported origins inside its owned tabs. The composer selects **Ask before every interaction** or **Allow website interactions**, not a geographic mode.
- **2026-08-22 — Show sensitive actions only as an honest stub (superseded 2026-08-30).** **Ask for sensitive actions** remained disabled until Freedom had a bounded fail-closed interruption design. The later implementation does not claim to classify every hidden website effect and does not subsume wallet, node, file, identity, payment, or future privileged gates.
- **2026-08-22 — Let canonical tasks select the next primitive.** The first six-task baseline recorded two passes and four missing capabilities. Richer form controls came next because the representative task proved a concrete gap; their completion raises the matrix to three passes and three missing capabilities. Multi-tab, multi-origin, and file work retain their ordered evidence rather than competing as abstract feature lists.
- **2026-08-22 — Bind form approval to the browser's actual payload.** For native form commits, action identity includes a page-isolated digest of successful controls and submit metadata. Any payload mutation while trusted approval is pending invalidates that one-shot decision before input dispatch.
- **2026-08-22 — Make the task conversation the retained Agent primitive (refined 2026-08-26).** Multiple user prompts share one in-memory Pi session and attached workspace while preserving per-turn lifecycle and audit UI. New chat now deselects an idle live session rather than disposing it, allowing session switching to restore its workspace during the current app process; durable history still restores no browser authority after restart.
- **2026-08-23 — Make task tabs members, not conversation roots.** Closing the initially adopted tab removes one member and selects a surviving owned tab; closing every task tab leaves a valid empty workspace. A fresh task tab may be created through the trusted owning browser host, but unrelated existing tabs are never adopted implicitly. Pi still cannot close the user's originally adopted tab itself.
- **2026-08-24 — Make Agent-first a Sessions / Conversation / Workspace shell.** Sessions is the future history surface, Conversation remains the live Pi task, and Workspace hosts task outputs beginning with owned browser pages. Browser pages are one workspace-item type rather than the permanent limit of the Agent product; future dApp files, previews, builds, and decentralized publication receipts require explicit capability packages before appearing as functional UI.
- **2026-08-25 — Share browser chrome across both layouts.** Agent-first mounts Freedom's canonical tab strip and complete address-bar container with a conversation-owned tab projection. Layout and editability may differ, but URL presentation, trust, permissions, tab interactions, and browser behavior must not fork.
- **2026-08-26 — Saved conversation does not imply saved browser authority.** Freedom persists a redacted, visible conversation projection, not task tabs, page snapshots, tool transcripts, or control grants. Opening history is dormant; the next turn must acquire fresh current authority and re-observe the page through normal policy.
- **2026-08-26 — Separate provenance, custody, attachment, and lease.** User-created and Agent-created provenance is immutable; custody is browser-wide and changes only through explicit Claim/closure; one session attachment determines Workspace membership; and the active run marker is ephemeral. Session switching never infers ownership from URL or foreground state, and Claim revokes every Agent controller reference before restoring ordinary navigation.
- **2026-08-26 — Share user pages explicitly; start the homepage empty.** A new session receives an eligible current page only while its visible composer context chip is present. The pristine homepage, internal pages, Agent-owned tabs, and dormant-session foreground pages are never adopted implicitly. Without shared context, the trusted host may create new Agent tabs but grants no access to existing user tabs.
- **2026-08-26 — Make takeover a trusted, resumable page interlock.** This supersedes the 2026-08-22 terminal-takeover decision: Stop is terminal from the empty running composer, while clicking a controlled live page is intercepted in Freedom chrome and offers a resumable human-control period. Scrolling remains blocked during the active run because live-page scroll can mutate DOM and viewport assumptions.
- **2026-08-26 — Treat downloads as browser-owned artifacts, not filesystem access.** Agent may request one referenced download through the canonical controller, but Freedom owns transfer attribution, destination policy, cancellation, persistence, and verification. Pi and the renderer receive only an opaque redacted receipt; trusted main-process actions resolve the actual path.
- **2026-08-27 — Treat approval as a composer state, not transcript content.** A pending decision temporarily replaces the normal composer with a bottom-anchored, action-specific consent surface. The user must allow or deny the action before sending more guidance; Stop remains a distinct terminal choice, and only the compact resolved decision persists in the work ledger.
- **2026-08-27 — Anchor browser overlays to the browser surface.** Download progress and other page-adjacent browser chrome belong to the canonical content surface rather than the window viewport. They therefore respect every sidebar and Agent-first projection without layout-specific offsets or duplicate Agent UI.
- **2026-08-27 — Treat shelf cancellation as a user decision, not a failed artifact.** Cancelling an Agent download from Freedom's ordinary shelf produces a distinct non-retryable result, suppresses incomplete artifact authority, and tells Pi not to repeat the transfer unless asked. Stopping the entire run remains a separate cancellation path.
- **2026-08-27 — Treat file selection as a one-shot browser transfer, not filesystem access.** Agent can target one snapshotted file input, but Freedom always asks the user and the native picker supplies the only file choice. Main retains the path only long enough to apply it to that exact current node; Pi and history receive a path-free attachment receipt, and any later submit remains a separate approval.
- **2026-08-27 — Make the provider request—not the predicted button—the wallet boundary.** Pi uses ordinary page tools through whatever picker a dApp implements. Only an actual supported provider request from the exact actively controlled tab is diverted into the Agent composer; every connection, transaction, and signature still requires an explicit decision. The existing wallet stack remains authoritative, legacy dApp auto-approval does not apply, secrets and signatures stay outside Pi/history, and unrelated or human requests keep their existing UI.
- **2026-08-27 — Make Agent a creator of the browsing environment, not only its operator.** The long-term product includes site-scoped Greasemonkey-style customizations, Agent-built extensions, and a malleable Freedom Browser. These share a scoped project, preview, permission review, install, versioning, and rollback pipeline; progressively deeper customization never implies progressively weaker trusted-chrome or privileged-process boundaries.
- **2026-08-28 — Require evidence only for work that needs evidence.** Ordinary conversation is a valid Agent outcome and does not produce a browser-verification warning or empty work ledger. Browser and privileged operations continue to derive graded completion, recovery, and artifact receipts from Freedom-owned controller evidence rather than model prose.
- **2026-08-28 — Treat the wallet package as alpha-complete.** Deterministic coverage spans dApp connection, transactions, personal and typed-data signatures, decline recovery, and direct semantic transfers; manual production smoke passes for a real local-vault send and a live dApp connection. External signer variants remain opportunistic qualification. Agent-native node operations become the leading next privileged-capability candidate, beginning read-only rather than with process control.
- **2026-08-28 — Separate node intelligence from node authority.** `node_status` is a tabless observation over Freedom's existing service managers and exposes only bounded lifecycle/readiness semantics. It grants no process, configuration, funding, reset, publication, shell, or raw RPC authority. State-changing node operations, if added, require separate named contracts, Agent-native approval, cancellation semantics, and verified postconditions.
- **2026-08-28 — Prefer disclosed raw diagnostics over brittle error classification.** Freedom captures its existing in-memory Electron/main-process log stream and trusted service-prefixed daemon output, then exposes only bounded node-scoped or broader application bundles after an Agent-native disclosure naming the selected provider/model. It does not promise semantic secret detection or censor ordinary peer/address/path evidence. It also does not turn diagnostics into filesystem, shell, lifecycle, or arbitrary RPC authority; raw log content remains untrusted model input and saved UI/history projections retain summaries only.
- **2026-08-28 — Use model classification only inside hard runtime-owned boundaries.** Freedom now has a generic isolated effect classifier, but the acting Agent never supplies its own category and the model never chooses the transport target. Only a confident unambiguous read may proceed automatically; every failure, uncertainty, or stronger effect becomes an exact Agent-native approval, while deterministic method floors cannot be downgraded. The first consumer is a bounded Ant Bee HTTP request pinned to the service registry. This does not classify arbitrary webpage clicks or grant shell, filesystem, process, arbitrary-host, or generic local-network access.
- **2026-08-28 — Extend node authority through real transports and stable managers, not command catalogs.** `node_request` now reaches registry-pinned Ant/Radicle HTTP and the embedded read-only IPFS gateway without route allowlists. Myotis has no invented raw surface, and Tor SOCKS is not exposed as a generic proxy. `node_lifecycle` separately provides exact-approved start/stop/restart through Freedom's existing managers and requires a verified shared-status postcondition. Neither tool grants shell, process arguments, arbitrary hosts, settings mutation, or filesystem access.
- **2026-08-28 — Journal unsafe node requests instead of guessing their outcome.** Every direct node request now has a durable, conversation-owned operation ID and factual transport state. A dispatched mutation survives the Agent's interactive timeout or stopped turn, can be collected through `node_operation_status`, and becomes `delivery_uncertain` after transport loss, app shutdown, or stale startup recovery. Freedom never turns an absent response into “not applied,” never invites a blind retry, and stores only bounded response evidence plus request metadata/body digest rather than raw request secrets.
- **2026-08-29 — Give live work semantic presence without inventing progress.** The final item in an active turn now reflects trusted Pi turn/response lifecycle and Freedom-owned tool, approval, collaboration, compaction, retry, and stop events through one subtle animated status row. Waiting states remain static, reduced motion is honored, and terminal completion or recovery replaces the ephemeral row with durable evidence rather than retaining fake progress.
- **2026-08-30 — Treat composer attachments as bounded conversation resources.** User-selected files become immutable profile-private conversation snapshots; explicitly selected folders become ephemeral live read-only grants. Pi sees opaque IDs and bounded text, folder, vision-native image, or sandboxed PDF results rather than host paths. Undeclared formats fail before staging, mixed selections reject transactionally, and the `+` surface owns the broad context-menu hierarchy while model and approval remain compact pill popovers. Attachment tools produce their own safe, durable evidence rather than synthetic browser evidence; repeated chunks consolidate by resource/path; supported Markdown tables remain structured; and users can visibly revoke live folder grants without pretending already-read content left the conversation.
- **2026-08-30 — Let approval posture change only between turns.** A retained Pi conversation keeps its selected provider/model, but an idle user may switch among **Ask every action**, **Ask when needed**, and **Allow website interactions** without starting over. Trusted main owns and persists the transition, the live controller enforces it for the next action, Pi receives an explicit policy reminder with every user turn, and durable history records the exact posture applied per turn. Active runs, pending approvals, takeover, and resume states keep the selector locked so no in-flight authorization can change meaning underneath an action.
- **2026-08-30 — Classify intended consequence, not hidden webpage effects.** **Ask when needed** uses a separate tool-free Pi classifier to decide whether the Agent's proposed exact interaction should interrupt the user. Only high-confidence ordinary intent without uncertainty proceeds; everything else asks. The scoped controller retains exact-target inspection and dispatch authority, native forms remain deterministically consequential, and file, wallet, node, identity, payment, and publication capabilities keep independent runtime-owned gates. Neither Agent intent, visible labels, nor classifier output is treated as proof of what arbitrary page JavaScript will do.
- **2026-08-30 — Preserve a safe provider diagnosis, not a generic model error.** Freedom keeps raw SDK/provider failures inside main, derives only an allowlisted cause, request phase, safe network code, HTTP status, and bounded attempt consistency, and presents those facts with the selected provider/model. It never forwards arbitrary provider text, and it explicitly says when no usable reason exists. Partial browser work and unresolved privileged operations retain their own recovery requirements alongside the provider diagnosis.
- **2026-08-31 — Keep the concrete provider diagnostic after redaction.** The first real failure exposed that the earlier safe envelope had overcorrected: it discarded Pi's bounded provider message and even ignored the final failed-retry event, producing “could not reach” with no explanation. Freedom now consumes every retry failure, selects the richest available attempt, retains a bounded credential-redacted provider diagnostic, and explicitly says when Pi supplied no HTTP status or network code. “Every attempt failed for the same reason” is used only when concrete comparable evidence supports it.
- **2026-08-31 — Recreate transiently failed provider sessions instead of requiring an app restart.** A terminal transient provider error now invalidates only the Pi model session, not the retained browser workspace or durable conversation. The next safe Retry/manual follow-up resolves current provider state and starts a fresh transport, while the UI presents one concise card with collapsed technical evidence. Blind retry stays unavailable after verified or uncertain task effects.
- **2026-09-01 — Put general shell authority behind native OS sandboxes, not a command catalog.** Freedom should not trust a classifier to recognize every harmful payload. Arbitrary commands receive a common least-authority policy enforced by Bubblewrap on Linux and Seatbelt on macOS, while approvals govern explicit boundary expansion. The initial fail-closed policy, adversarial corpus, cancellation receipts, and Linux/macOS runtime qualification are now merged into the feature branch; Windows remains unsupported.
- **2026-09-01 — Treat platform sandbox guarantees honestly.** Linux Bubblewrap provides namespace-scoped descendant teardown. macOS Seatbelt provides the tested filesystem/network boundary but only best-effort process-group teardown because a detached `setsid()` descendant can survive cancellation. Product receipts and recovery UX must preserve this distinction. Neither platform currently provides aggregate CPU, memory, PID, or disk containment.
- **2026-09-01 — Qualify exact packaged runtimes before enabling managed workspaces.** A packaged macOS app is sufficient for a gated integration despite remaining unsigned in the qualification build; signing/notarization adds distribution evidence rather than a stronger child sandbox. Packaged Linux unpacked, `.deb`, and explicitly profiled AppImage layouts passed the Electron-main corpus and descriptor re-audit. AppImage support still fails closed on restricted user-namespace systems until Freedom has a reviewed launcher/AppArmor solution; Electron's injected `--no-sandbox` path is never accepted.
- **2026-09-01 — Make the first shell product a Freedom-owned managed workspace.** Freedom creates and persists a private workspace, gives Pi only an opaque ID and relative paths, validates the workspace when establishing or adopting its lease, and exposes a bounded no-network shell with durable activity and receipts. The first acceptance target is creating, validating, stopping, retrying, and resuming a small static site; preview and verified Swarm publication follow. User-selected existing directories are deferred.
- **2026-09-01 — Treat the independent sandbox audit as a hardening gate, not a repudiation of the design.** The audit reproduced Linux confinement and found no host escape. Its filesystem, resource-view, macOS policy, runtime, and inherited-descriptor findings were corrected, requalified, and focused-re-audited before the experimental foundation merged. Freedom treats all spawned-command side effects plus all later workspace contents as untrusted.
- **2026-09-02 — Make policy authority monotonic and non-serializable.** Mandatory `.git` protection is always unioned with caller additions and cannot be removed by an empty settings-shaped list. The active Electron main process must freshly attest its own runtime through the helper probe; execution policy rejects serialized/reconstructed path descriptors and revalidates the executable/resources/package layout before granting the read-only runtime mount. The Debian package explicitly depends on Bubblewrap while retaining Electron Builder's complete runtime dependency baseline; the later clean-stock Ubuntu GitHub-hosted VM gate verifies ordinary package installation and AppArmor behavior before Linux changes qualify.
- **2026-09-02 — Present standard coding tools without granting Pi standard host authority.** Replace the model-facing `workspace_run` abstraction with Pi's complete expected `bash`, `read`, `write`, `edit`, `grep`, `find`, and `ls` contracts, backed entirely by Freedom-owned operations. Shell commands and the fixed bounded file/discovery helper both retain the qualified OS sandbox; Pi's native host `rg`, `fd`, and filesystem implementations are never invoked. Trusted built-in-name overrides are registered through a non-serializable process-local marker, while arbitrary custom tools remain unable to claim Pi's reserved host-tool names.
- **2026-09-02 — Preview static projects without granting server or host-file authority.** Add one Freedom-owned `workspace_preview` tool over an opaque isolated protocol. It serves live bounded workspace files, opens an Agent-custody tab, and deliberately provides neither `file://` access nor a localhost process. Network, provider, navigation, persistence, and filesystem boundaries are enforced independently of the generated page; managed dev-server processes remain the next distinct design discussion.
- **2026-09-02 — Use explicit model progress without treating it as evidence.** When Pi emits standalone bold or Markdown reasoning headings, Freedom projects the latest bounded heading into the ephemeral live-status row instead of showing only **Thinking…**. Arbitrary reasoning prose and inline emphasis stay hidden; verified tools, approvals, recovery, and assistant response streaming take precedence. The projection is neither persisted nor counted as proof that an action occurred, and generic lifecycle labels remain the provider fallback.
- **2026-09-02 — Make clean Ubuntu package qualification reproducible.** A branch-scoped Ubuntu 24.04 GitHub-hosted VM captures the restrictive AppArmor/user-namespace baseline, proves Bubblewrap arrives only through normal `.deb` installation, runs ordinary and doubly gated destructive qualification through the packaged Freedom executable, verifies removal cleanup, and preserves the evidence artifact. This is the automated integration gate; a representative end-user Ubuntu smoke remains a release-validation follow-up rather than a blocker for product wiring.
- **2026-09-02 — Publish managed project output as files, not model-generated text.** Extend the canonical `swarm_publish` operation with a conversation-scoped workspace-relative source. Trusted main-process code resolves and bounds the source after approval, excludes protected metadata, rejects link/special-file escapes, and uploads exact file bytes and relative paths as a Bee collection without a staging directory. Swarm remains the consequential destination-specific tool; the reusable workspace reader owns only safe source authority.
- **2026-09-03 — Treat the qualified managed shell as a bootstrap, not the final coding environment.** The next execution layer is a generic sanitized shell that can resolve any validated user or project toolchain through read-only runtime roots; it is not a sequence of Node-, Python-, Git-, or compiler-specific integrations. OS sandboxing, scoped mounts, private writable state, networking policy, and receipts remain the enforcement boundary regardless of which executable or interpreter runs.
- **2026-09-03 — Keep Freedom's embedded JavaScript runtime private.** `$FREEDOM_JAVASCRIPT_RUNTIME` has been removed. Freedom's fixed helper retains the attested embedded Electron runtime through a private policy and `ELECTRON_RUN_AS_NODE`, while a trusted strictly narrower derived policy removes both the Electron runtime mount and that environment value from Agent-authored shell execution without a second workspace validation pass.
- **2026-09-03 — Resolve installed executables generically behind exact grants.** `request_permissions` accepts command names rather than model-guessed host paths. Freedom captures only the configured login shell's bounded `PATH`, merges the inherited process fallback, derives a narrow package root, presents that root to the user, and adds only non-serializable read/execute authority for the current turn or conversation. Linux receives a private read-only mount identity; macOS receives an exact Seatbelt read/execute rule plus linked-library closure. Workspace write and no-network policy do not change, and unavailable software is never portrayed as installable through permission alone.
- **2026-09-03 — Bound Stop independently of provider and tool cooperation.** Workspace startup now receives a run-owned abort signal and reports exact safe lifecycle phases. Terminal Stop waits at most three seconds for Pi and execution cleanup, then finalizes cancellation and invalidates the unresponsive provider session. A model SDK promise can no longer keep Freedom indefinitely in **Stopping Agent…**.
- **2026-09-03 — Evolve website approval modes into unified Agent authority profiles.** **Approve for me** should retain the same hard sandbox and substitute an independent escalation reviewer for the human on eligible boundary crossings; it is not a broader permission set. **Ask for approval** keeps the human in that reviewer role, while **Full access** explicitly expands filesystem/network authority. Runtime-owned wallet, payment, publication, disclosure, communication, and legal-consent boundaries remain human-visible unless separately and narrowly authorized.
- **2026-09-03 — Show and bind the command that motivates a capability request.** A prompt such as “Allow Agent to use Node?” describes authority but not intent. Executable approvals now lead with the exact command and canonical workspace-relative working directory, then disclose the package roots required to run it. A one-shot decision is consumed only by that attested matching call; a conversation grant deliberately retains the disclosed executable capability for later commands. Filesystem and networking expansions will join the same permit vocabulary only after their platform enforcement is qualified.
- **2026-09-03 — Treat internet, localhost, and LAN as grantable capabilities.** Managed shell networking is currently disabled, but that is a safe bootstrap default rather than the product destination. Agent may legitimately need public internet, arbitrary host-local services, or private-network services; each belongs in the same one-shot/conversation authority model with honest scope disclosure and OS-enforced revocation. Host IPC remains separate, and generic network access never implies personal consent for payments, publication, communications, or account actions.
- **2026-09-03 — Keep workspace enablement concise and capability-neutral.** The initial approval now leads with the actual durable authority—create, edit, and delete files in one Freedom-managed project workspace—while local persistence, conversation deletion, protected metadata, read-only executable access, networking scope, and platform teardown semantics live behind closed **More details**. Network is described as a separate capability absent from this grant, not as a permanent Agent limitation, and “private” is avoided where it could imply encryption or ephemerality.
- **2026-09-03 — Make capability provenance generic before expanding authority.** Executable roots, external filesystem read/write, public internet, host loopback, private/LAN networking, and host IPC now have distinct vocabulary entries. Trusted capabilities and requests are opaque, conversation-bound, scope-aware, and non-replayable; only executable-root enforcement is enabled. Adding a vocabulary entry never grants authority, and any missing adapter fails closed before command launch.
- **2026-09-03 — Use Codex as a pinned implementation reference, not a dependency or authority claim.** Local read-only reference checkouts track `openai/codex` at `c9fecd3fa06af28011166207c596ad547e37abab` and `openai/codex-universal` at `47f4f0eb5337083e2f610db0d15558932cb4901d`. Freedom may study their sandbox, approval, process, and tool-discovery patterns, but must preserve its own threat model, platform qualification, licenses, and runtime-owned consent boundaries.
- **2026-09-03 — Separate safe development from destructive macOS qualification.** Continue gated product wiring, unit tests, and fixed non-destructive integration checks on the primary Mac. Run deliberately hostile filesystem, descendant, resource, app-exit, and real model-controlled shell/network cases only on a disposable Mac, using bounded fixtures and protected canaries rather than destructive host paths. Passing that exact corpus is mandatory before ordinary-user exposure, but it does not block continued implementation behind fail-closed defaults and feature gates.
- **2026-09-04 — Accept the experimental Linux full-network product path at exact commit `147f9942`.** A fresh non-root Ubuntu qualification passed both gate-disabled and gate-enabled product harnesses, including exact working-directory permits, executable composition, durable terminal cancellation receipts, clean Electron/native materialization, namespace teardown, the focused sandbox and destructive corpora, lint, and the complete unit suite. This closes the Linux prerequisite for managed long-lived-process work; macOS adversarial product-path qualification, stock-host portability, aggregate resource containment, and dependency-script policy remain explicit gates or follow-ups rather than implied guarantees.
- **2026-09-04 — Model long-running workspace commands as standard shell sessions.** Freedom keeps Pi's familiar `bash` surface: commands that finish within the bounded yield window return normally, while an active command yields an opaque conversation-owned session ID continued through trusted `write_stdin` polling, bounded input, or explicit termination. No second “dev-server command” language is introduced. The selected sandbox and executable/network grant are fixed at launch, output is continuously drained into a bounded tail, and platform-specific teardown claims remain honest. Stable preview routing, terminal-history reconciliation without polling, restart/reattachment, and visible process management are follow-on layers rather than hidden claims of this first substrate.
- **2026-09-04 — Reconcile yielded process completion without requiring model polling.** A trusted per-process terminal observer now projects the authoritative sandbox receipt back onto the original `bash` tool call, updates terminal turn activity in SQLite without disturbing a newer active turn, and refreshes the existing renderer row after the Agent response has finished. It fires only for sessions already exposed to Pi, never forwards output or host authority, cannot delay cleanup, and cannot be downgraded by a late stale `running` result. Stable owned-server preview routing is the next creation package; restart reattachment remains separate.
- **2026-09-04 — Route a predeclared managed server through the isolated preview origin.** Freedom does not navigate Agent tabs to localhost and does not create a special dev-server command language. A full-network-approved ordinary `bash` launch declares one bounded port before execution; after it yields, the opaque conversation-owned process ID can mint an isolated preview origin for only that immutable process/port association. Main rechecks liveness and authority on every bounded proxy request, strips ambient credentials, refuses external redirects, and revokes the route with the process or conversation. Static preview, WebSocket/HMR support, restart reattachment, and arbitrary external localhost service access remain distinct capabilities.
- **2026-09-04 — Consolidate the workspace qualification scenarios into a tracked, reusable harness.** The previously handoff-only scratch scenarios for network permissions, managed processes, automatic terminal reconciliation, and managed server previews now live in `scripts/agent-qualification/` (a shared production-service composition plus per-scenario modules) and run through documented repository commands rather than reconstructed prompts. The harness exercises the production `FreedomAgentService`, real SQLite stores, `ManagedWorkspaceController`/process manager, the real Pi tool factories, the production preview handler against a real sandboxed HTTP server, and the real Bubblewrap executor; the only seams are a scripted Pi session, an in-memory browser-tab stub, and a preview-protocol registration stub, all disclosed. One aggregate command (`test:agent-sandbox:workspace`) and independently runnable groups are provided; the five-minute terminal-handle expiry stays separately selectable (`--include-slow`) and the deliberately destructive corpus remains in its own gated jest suites, never in ordinary `npm test`. Teardown is finally-based with unique owned fixtures, read-only survivor scans, and a controlled-failure self-test. Validated on a non-root Ubuntu 24.04 server at branch `experiment/agent-workspace-qualification-harness` (base `aa6d02a9`): the aggregate passed 120 assertions across all six group/mode runs (network 28, network-disabled 14, processes 26, reconciliation 19, previews 26, previews-disabled 7) with zero failures and clean teardown, both existing network modes pass, the controlled-failure self-test proves cleanup on the failure path, and `npm run lint` and `npm test` are green. Restart/reattachment qualification and the macOS Seatbelt adversarial product-path gate remain separate follow-ups.
- **2026-09-05 — Give running workspace processes a persistent user-owned control surface.** Only commands that actually yield as live managed sessions appear; short commands remain ordinary transcript actions. Wide Agent-first mode shows a persistent process card beside the transcript, while browser-first and narrow layouts share a compact strip above the composer with the same data and actions. Each item shows the bounded command summary, canonical workspace-relative directory, full-network posture when present, an isolated **Open preview** action for declared servers, and **Stop**. Main projects only conversation-owned opaque process IDs, and trusted IPC rechecks chrome ownership. UI Stop uses a dedicated non-consuming manager path, so it cannot steal incremental output from Pi's `write_stdin` cursor; backend cancellation and the terminal observer remain authoritative. Completed processes leave the live control surface and retain their existing durable transcript and ledger evidence. Recent output, direct stdin, restart controls, restart reattachment, and stale-session recovery remain follow-ons.
- **2026-09-05 — Extend the tracked harness to the trusted-chrome process controls and requalify on Linux.** A new repository-owned `process-controls` scenario in `scripts/agent-qualification/` drives the real service path behind the `agent:process:stop` / `agent:process:preview-open` IPC handlers (`stopWorkspaceProcess` / `openWorkspaceProcessPreview` → `terminateProcess` / `listProcesses` → process-manager `terminate` / `list` → real Bubblewrap) using the shared production composition. It proves that only yielded, still-running commands appear in the bounded `getState().workspace.processes` projection with no host path, buffered output, or authority; that chrome Stop reaches a truthful SIGKILL / namespace_scoped / pid_namespace receipt, drops the process from the live projection while its terminal ledger evidence remains, and does not consume the Pi `write_stdin` cursor; that a declared server reopens through the isolated preview controller; that another conversation, unknown, and malformed ids are refused without affecting a live process; and that the independent `workspace_processes_changed` refresh fires on natural completion during a newer turn. A second part registers the production `registerFreedomAgentIpc` against the same real service and Bubblewrap composition, owns a run through the real `agent:start` handler, and drives the registered `agent:process:stop` / `agent:process:preview-open` handlers directly: the owning sender succeeds with a real SIGKILL, another renderer and a malformed id are rejected `AGENT_NOT_OWNER` before the service is reached, and a cross-conversation id is rejected `INVALID_ARGUMENT`, each leaving the live process untouched. The cursor test proves the exact unread output tail survives Stop with no gap or duplication. Validated on a non-root Ubuntu 24.04 server at branch `experiment/agent-workspace-process-controls-linux` (base `3152ca0a`): the aggregate passed 138 assertions across all seven group/mode runs (process-controls 18) with clean teardown, plus the slow expiry case, the sandbox jest/qualification/destructive suites, lint, and the full unit suite. macOS Seatbelt adversarial qualification of the chrome Stop path remains a separate follow-up.

## Final target statement

> Freedom becomes an agent-native, malleable browser: users delegate high-level work to an embedded Pi-powered agent that acts through Freedom's semantic automation kernel and enforceable approval boundary across the ordinary and decentralized web, and can eventually ask it to create site customizations, extensions, dApps, and supported changes to Freedom itself through inspectable, permissioned, reversible build and installation workflows. A CLI or MCP surface may later expose the same kernel if real external demand warrants productizing it.
