# Codemode and connected MCP services

Implemented on `experiment/agent-codemode-mcp`. These are capabilities of the
embedded Freedom Agent runtime, without another model-provider requirement.

## Using it

Codemode is available automatically to the main agent and its read-only, editing
and browser helpers, alongside ordinary tools. Ask Agent to do a
multi-step task; it can use a short JavaScript script to chain tools and filter
results. Small models may continue using ordinary tools.

Open **composer + → Connected services** in a new or existing chat. The list shows
your connections, status and available tools; reconnect and disconnect live here.
Choose **Add service**, enter a name and the service's MCP endpoint, and connect. Connecting returns to the service list; Back returns
to your conversation without clearing the draft. Model settings remain separate.

If authentication is required, choose **Sign in** and finish in the browser. The connection card lists available tools. Reconnect
refreshes discovery; Disconnect removes the configuration and stored credentials.
Saved connections connect lazily after restarting Freedom.

Ask Agent to discover your connected services and use one of their tools. Freedom
shows the service, destination and exact arguments for approval before sending a
tool or resource request. Connecting a server does not grant blanket permission
to use its account. This applies in all three current permission modes.

The initial transport is Streamable HTTP with public access or browser OAuth.
HTTPS is required except for explicit loopback endpoints. URLs cannot embed
credentials or query tokens. Local stdio processes, arbitrary headers/API keys,
and pre-registered OAuth clients are not part of this first implementation.

## Ownership and boundaries

The main process owns `McpConnectionManager`, Pi's protocol client and OAuth
provider, and profile storage. The renderer only manages connections through a
chrome-only IPC channel. Webviews cannot configure or call MCP through IPC.
The agent's `mcp_discover` and `mcp_request` tools resolve opaque connection IDs;
they cannot supply a new URL, transport, executable or credential.

`mcp-connections.json` is stored alongside the profile's agent provider settings.
Only connection names and endpoint URLs are plaintext. OAuth state—including
refresh tokens, registration and pending PKCE values—is encrypted by Electron's
safeStorage. Plaintext keyring fallback is rejected. The store is bound to its
profile directory, rejects symlinks and writes atomically. Credential state is
also bound to the exact endpoint. Nothing imports global or project `mcp.json`.
Browser/model-provider credentials are never shared with MCP.

OAuth uses Pi's PKCE/state/issuer checks and a loopback callback. Reauthentication
reuses the registered callback port. Cancel closes the listener and prevents
late writes; a subsequent sign-in remains possible. HTTP redirects are refused
so transport credentials cannot be forwarded to another endpoint. Remote service
metadata cannot downgrade OAuth into plaintext or loopback HTTP endpoints. Connections
make direct network requests, without using the current webpage's cookies.

MCP schemas, descriptions, annotations and results are untrusted service data.
The client does not advertise sampling, roots or elicitation capabilities.
Remote annotations cannot opt into Freedom's automatic permission review.
Invocations are never automatically replayed after an uncertain failure. Stop
cancels the client request; it cannot undo effects already applied by a service.

## Codemode integration

`pi-codemode.js` obtains Pi's native tool definition through its factory, using
only session-owned tool lookup and custom-entry storage. It does not enable Pi's
filesystem resource loader. The QuickJS worker has no Node, filesystem or network
APIs. `models` globals are disabled; all external work goes through the same
Freedom tools available outside codemode.

A per-session queue allows known project/attachment readers to overlap, while
preserving ordering of browser calls and writes even inside `Promise.all`. Writes
wait for earlier reads; later reads wait for those writes. The agent uses background helpers for
parallel work in independent scopes. Nested tool execution events retain their
own approvals and receipts. If a script fails after a successful edit, that edit
remains recorded; retrying the whole script is not a recovery strategy.

MCP tools expose a structured `{ result }` to codemode; ordinary model calls see
text content. Discovery initially returns server/tool summaries; specifying a
server ID and query returns matching schemas. Output is bounded and reports
truncation explicitly. Script `store/load` values are live-session state; they
are not restored from Freedom's visible conversation history.

Helper codemode is added after the mode-specific tool filter and uses each helper's
scoped executors. Read-only helpers cannot write; editing helpers retain exact
file ownership and read-before-write checks; browser helpers retain assigned tabs
and normal approval/freshness checks. Independent reads may overlap inside a
helper; browser calls and writes stay ordered. Nested calls contribute to helper
activity and receipts, including partial changes if a script fails. Stop cancels
the helper's script and prevents queued actions without stopping siblings.
Retained background sessions use fresh executor bindings on follow-up passes.
Helpers still cannot delegate, run commands, expand access or use connected MCP
services. The main agent handles those capabilities.

## Qualification

The unit integration uses the actual pinned Pi packages and a disposable local
HTTP/OAuth server. It covers encrypted state, sign-in cancellation and retry,
approval refusal, cancellation before and during requests, no mutation replay,
parallel read batches, ordered nested writes, partial effects and interruption of a looping script.
Service and IPC tests cover all permission modes and untrusted senders.
Native Pi helper tests cover scoped tools, parallel reads, follow-up bindings,
refusal, partial edits and Stop using a deterministic model transport.

`test-e2e/agent-mcp.spec.js` exercises the connection UI in dark/light themes,
inert service descriptions, real Electron codemode execution, and a worker/WASM
round-trip from an ASAR archive. It runs in the Agent CI group. This is not a
claim that every external MCP service or full packaged OS build is qualified.
