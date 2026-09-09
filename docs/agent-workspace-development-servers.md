# Workspace development servers

Agent can keep a development server definition, restart it with current permissions,
and reopen its isolated preview. Server previews also provide a bounded WebSocket
adapter for HMR and same-server application messages. Static previews remain the
simpler choice for projects that do not need a server.

## User and Agent workflow

1. Launch the exact server command with its workspace-relative directory and a
   declared numeric `previewPort`, using the existing executable/full-network
   permission flow. The server must keep that port rather than silently choosing
   another occupied port.
2. A command that yields while still running is saved automatically. Use
   `workspace_preview` for the first preview, or `workspace_server` with `list`
   to find its saved ID and exact command.
3. `workspace_server` with `reattach` opens the current owned process's preview.
   `restart` checks current authority, stops the previous process, checks the
   declared port, and launches the exact saved command through ordinary `bash`.
   Reattach is a separate tool call so launch and preview outcomes retain their
   separate receipts.
4. The workspace panel offers **Start with Agent** or **Restart with Agent**.
   These visibly start an Agent turn; they do not silently approve execution.
   Running servers retain **Open preview** and **Stop**.

Eight definitions per conversation are retained in the profile's workspace
SQLite database: command, relative directory, port, opaque server ID and preview
origin token. They contain no process ID or permission grant. On app restart
they show **Needs restart**. Restart obtains current permissions and launches a
fresh owned process; it never adopts a discovered PID or arbitrary port listener.
An occupied port refuses launch, including a possible survivor from a previous
application lifetime. Existing platform cleanup limitations still apply.

Saved preview origins remain stable. Within the current browser lifetime an
existing page detects a replacement process and reloads; old socket credentials
and connections are revoked. After reopening Freedom, use the saved server's
start/reattach flow to register its preview again. An old restored URL alone does
not recreate authority or a live preview mapping. A stopped/unavailable HTML
page offers **Try again** and thirty bounded retries; these only observe the
preview and never launch commands. There is no automatic crash-restart loop.

## WebSocket transport and limits

`protocol.handle` serves Fetch responses rather than browser WebSocket upgrades.
Main injects `/.freedom-preview/client.js` before application scripts in server
HTML. It replaces the page's `WebSocket` with an event-compatible adapter using
same-origin POSTs to `/.freedom-preview/socket`. Main's existing `ws` dependency
opens the actual upstream connection. No additional local listener is created.

Only the preview's hostname or loopback at its declared port is accepted, then
rewritten to `ws://127.0.0.1:<declared-port>`. Path, query token and subprotocols
are retained. Credentials, cookies and authorization are not forwarded; redirects
and compression are disabled. This is the same declared-process/port association
as HTTP previews, not kernel proof of listener ownership.

Every request checks the current conversation, enabled workspace, process,
network posture, port, preview generation, random per-generation key and opaque
socket ownership. Stop, replacement, deletion or idle expiry revokes connections.
The preview CSP still permits only same-origin connections; external origins,
providers, frames and workers remain unavailable. Static previews receive no
adapter and retain their no-network policy.

| Resource | Bound |
| --- | --- |
| Sockets | 4 per preview, 32 total |
| Frame / queued payload | 1 MiB; at most 128 queued events |
| Protocol names | 8 names, 128 characters each |
| Socket POSTs | 96 simultaneous; separate from 8 ordinary HTTP slots |
| Socket POST body | 1500 KiB including binary base64 envelope |
| Handshake / send | 5 seconds each |
| Long poll / request / abandoned socket | 15 / 20 / 30 seconds |
| Process-generation observation | one bounded request every 5 seconds |

Only pre-admission HTTP 503 refusals are retried (three backoffs). Ambiguous
network/send failures are never replayed. Text, binary, subprotocol, close and
ready-state events are supported. `extensions` is empty; `bufferedAmount` tracks
the adapter's pending sends. Overflow or stalled transport may terminate a socket
without a graceful close handshake. This is bounded preview compatibility, not
a general-purpose proxy or a promise of every native WebSocket edge case.

## Validation and remaining scope

Focused tests cover ownership, destination rejection, generation rotation,
concurrency, cancellation, text/binary events, copying mutable send buffers,
permissions before Stop, duplicate restart, exact directories, lost-process
refusal, SQLite migration/reopen and renderer controls. Light/dark static UI
checks use the existing Chromium installation. No Freedom app, native sandbox
or process-loss fixture ran on the primary development Mac.

Actual Electron custom-scheme/Vite compatibility and real sandboxed restart are
separate disposable-host checks; record their exact candidate/runtime when run.
Existing Linux/macOS substrate results do not qualify these new paths. Separate
HMR ports, SSE, workers/service workers, automatic crash restarts, saved-server
editing/removal UI and live model behavior are not established by this change.
