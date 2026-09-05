# Agent workspace qualification harness

A tracked, reusable harness that qualifies the four Freedom managed Agent workspace capabilities
against the real product objects:

1. **Network permissions** — available by default in the product build, offline until an exact,
   unforgeable, user-approved grant.
2. **Managed processes** — Pi's ordinary `bash` surface modelling long-running commands as standard
   shell sessions continued through `write_stdin`.
3. **Automatic terminal reconciliation** — yielded processes that finish after a turn ends are
   reconciled back onto the original tool call without any model polling.
4. **Managed server previews** — a predeclared managed server reachable only through an isolated
   `freedom-preview://` origin.

Each scenario runs against the **production** `FreedomAgentService`, the real SQLite
`AgentManagedWorkspaceStore` and `AgentSessionHistoryStore`, the production
`ManagedWorkspaceController` and its `ManagedWorkspaceProcessManager`, the real Pi workspace tool
factory (`createWorkspaceTools`), the production `WorkspacePreviewController` and its preview request
handler, and the **real Bubblewrap executor**. Server-preview requests are proxied through the
production preview handler against a real sandboxed HTTP server.

## Layout

```
scripts/qualify-agent-workspace.js        # CLI runner: one group per invocation, or `all`
scripts/qualify-agent-network-product.js  # backwards-compatible network entry point (delegates here)
scripts/agent-qualification/
  harness.js                              # shared composition, context, utilities, finally-cleanup
  scenarios/
    network.js                            # network-permission scenario (product + disabled modes)
    processes.js                          # managed-process scenario
    reconciliation.js                     # automatic terminal reconciliation scenario
    previews.js                           # managed server-preview scenario (enabled + disabled modes)
    self-test-fault.js                    # controlled-failure self-test for the cleanup path
```

## Deterministic seams (disclosed)

The composition is production code with only observability wrappers around the executor and the tool
factory. Three deterministic seams remain, and none substitutes for a production authority, executor,
store, policy, or capability object:

- **Pi session** — a scripted fake session drives the tools directly. There is no model provider, no
  credentials, and no network originates from the harness process itself.
- **Browser tabs** — a minimal in-memory stub records the tab navigations the preview controller
  requests, so the opaque preview origin can be read back.
- **Preview protocol registration** — a stub captures the production preview request handler and the
  storage clears the controller asks for. The handler logic itself is the real controller.

## Prerequisites

- **Linux** with an unprivileged-user-namespace-capable kernel. On any other platform every group
  prints an explicit `skip` and exits 0. (macOS Seatbelt sandboxing is qualified separately by the
  `test:agent-sandbox:macos*` scripts.)
- **Bubblewrap** (`bwrap`) on `PATH`. Missing `bwrap` on Linux **fails** qualification rather than
  skipping it.
- An **ordinary non-root user**. Running as root is refused.
- `npm ci` completed, so `node_modules/electron` and the native SQLite modules are materialized for
  Electron's ABI.
- The runner must launch through the checkout's Electron binary in **Node mode**
  (`ELECTRON_RUN_AS_NODE=1`); the npm scripts below do this.

## Commands

Aggregate (both network modes, both preview modes, plus processes, reconciliation, and the
trusted-chrome process controls, each in its own isolated process, with a summary matrix):

```
npm run test:agent-sandbox:workspace
```

Independently runnable scenario groups:

```
npm run test:agent-sandbox:workspace:network              # network permissions, product build
npm run test:agent-sandbox:network:disabled               # network permissions, capability-disabled regression
npm run test:agent-sandbox:network:product                # alias: network permissions, product build
npm run test:agent-sandbox:workspace:processes            # managed processes (fast cases)
npm run test:agent-sandbox:workspace:processes:slow       # also the 5-minute terminal-handle expiry case
npm run test:agent-sandbox:workspace:reconciliation       # automatic terminal reconciliation
npm run test:agent-sandbox:workspace:previews             # managed server previews, gate enabled
npm run test:agent-sandbox:workspace:previews:disabled    # managed server previews, gate-absent regression
npm run test:agent-sandbox:workspace:process-controls     # trusted-chrome running-process controls (list, stop, preview)
npm run test:agent-sandbox:workspace:self-test-fault      # controlled-failure cleanup self-test (exits non-zero by design)
```

Directly (any group; flags are `--network-disabled` and `--include-slow`):

```
ELECTRON_RUN_AS_NODE=1 electron scripts/qualify-agent-workspace.js <group> [flags]
# groups: network | processes | reconciliation | previews | self-test-fault | all
```

### Slow cases

The five-minute terminal-handle expiry case is separately selectable and is **excluded** from the
default `processes` group and from the aggregate. Run it with
`test:agent-sandbox:workspace:processes:slow` (or `processes --include-slow`).

### Destructive / adversarial cases

This harness contains no deliberately destructive cases and is safe to run repeatedly. The hostile
filesystem / descendant / resource corpus remains in the separately gated jest suites
(`test:agent-sandbox:destructive`, gated by `FREEDOM_SANDBOX_DESTRUCTIVE=1`, and the macOS
`*:destructive` scripts gated by `FREEDOM_SANDBOX_VM_ONLY=1`). Those are never part of ordinary
`npm test`, and this harness does not change that.

## Expected output

Each run emits newline-delimited JSON to stdout:

- `{"type":"host",...}` — one host baseline (uid, kernel, bwrap version, AppArmor state, …).
- `{"type":"scenario",...}` — the scenario id, title, and mode.
- `{"type":"assertion","id":"…","status":"passed"|"failed","evidence":{…}}` — one per check.
- `{"type":"cleanup",...}` — post-teardown diagnostic: `rootRemoved`, `survivors`, `cleanupErrors`.
- `{"type":"summary","passed":N,"failed":0,…}` — the final tally.

`all` additionally prints a human-readable **Aggregate qualification matrix** and an
`{"type":"aggregate",...}` line.

**Exit codes:** `0` when every assertion passed and cleanup succeeded (or the platform was skipped);
`1` when any assertion, the scenario, or cleanup failed; `2` on an unexpected runner error. The
`self-test-fault` group exits non-zero **by design** — it injects a failure to prove the finally-based
cleanup still runs.

## What each group asserts

- **network** — request_permissions schema and Agent instructions; workspace-execution enable;
  helper/Agent policies offline; exact allow-once and conversation grants; canonical
  working-directory binding; executable + full-network composition; replay/forge/serialize/rehome
  rejection; incomplete/unknown bundle fail-closed; honest completed/failed/timed-out/cancelled
  receipts with the effective network posture; conversation isolation and deletion; and a leak scan.
- **processes** — write_stdin exposure; short vs yielded commands; the opaque session id; incremental
  output polling; bounded stdin and the 16 KiB input bound; output draining/truncation; the four
  active-process limit; concurrency identity; the retained-terminal single poll; allow-once
  networking bound to its launched process; cross-conversation/unknown/malformed id rejection;
  truthful termination, Stop, and disposal receipts (with `terminationScope`); and a leak scan.
  The five-minute terminal-handle expiry is `--include-slow` only.
- **reconciliation** — the trusted terminal observer is installed; a short command finishes once; a
  yielded natural completion, ordinary failure, and timeout each reconcile automatically in memory,
  durable SQLite, exactly one late `tool_finished`, and the ledger after the turn ended; a late stale
  `running` result cannot downgrade the terminal state; the observer fires at most once per session; a
  throwing observer does not affect completion, cleanup, or receipt truthfulness; a newer active turn
  is unaffected; and a leak scan (over reversed command output).
- **previews** — the previewPort / processId schema; offline and invalid-port rejection before launch
  or grant consumption plus a valid positive control; kernel listener ownership by the sandboxed
  process tree; opaque preview identity and negative identities; credential stripping and response
  header replacement; redirect handling; request/response bounds; safe error responses; pollable
  output; and route revocation on explicit termination, conversation Stop, deletion (with storage
  clearing), and controller disposal. The gate-absent mode proves the parameters are not advertised,
  forged parameters fail closed, and only the offline static preview remains.
- **process-controls** — the user-visible trusted-chrome controls through the real service path that
  backs the `agent:process:stop` / `agent:process:preview-open` IPC handlers
  (`FreedomAgentService.stopWorkspaceProcess` / `openWorkspaceProcessPreview` →
  `ManagedWorkspaceController.terminateProcess` / `listProcesses` →
  `ManagedWorkspaceProcessManager.terminate` / `list` → Bubblewrap). Reads the renderer-facing
  `service.getState().workspace.processes` projection: only yielded, still-running commands appear;
  short commands never do; the projection is bounded to opaque id, command summary,
  workspace-relative directory, state, backend, network posture, and optional declared preview port,
  with no host path, buffered output, capability, authority, or private data. Chrome Stop terminates
  the exact conversation-owned process with the truthful SIGKILL / namespace_scoped / pid_namespace
  receipt, drops it from the live projection while its terminal ledger evidence remains, and does not
  consume the process's Pi `write_stdin` output cursor (the exact unread tail survives Stop with no
  gap and no duplication). A declared server reopens through the chrome preview action via the
  isolated preview controller; another conversation, an unknown id, and a malformed id are refused
  and cannot affect a live process; natural completion during a newer turn emits the independent
  `workspace_processes_changed` refresh. A second part (`PCI*`) registers the production
  `registerFreedomAgentIpc` against the same real service and Bubblewrap composition, establishes a
  chrome-owned run through the real `agent:start` handler, and drives the registered
  `agent:process:stop` / `agent:process:preview-open` handlers directly — proving the owning sender
  succeeds (real Bubblewrap SIGKILL), another renderer and a malformed id are rejected `AGENT_NOT_OWNER`
  before reaching the service, and a cross-conversation id is rejected `INVALID_ARGUMENT`, each leaving
  the live process untouched. The `preload.test.js` suite additionally covers the preload exposure
  shape.

## Reliability

- Every run creates a uniquely owned temporary fixture directory (`freedom-agent-qual-<random>`), and
  a `finally`-based teardown disposes the service, preview controller, and controller (terminating
  live namespaces), drains in-flight terminal writes, closes the stores, runs scenario cleanups, and
  removes the fixture directory. Cleanup validates its own success (`cleanup-root`,
  `cleanup-survivors`, `cleanup-errors`) and never removes leftovers from previous runs.
- Survivor scans are **read-only** (`pgrep`, never a kill) and matched narrowly; cleanup happens
  through namespace teardown, not process-name kills.
- Unexpected scenario errors and cleanup failures produce a non-zero exit with bounded diagnostics.
- Run `test:agent-sandbox:workspace:self-test-fault` to confirm the cleanup path on a controlled
  failure: it launches a live process, throws, and the `cleanup` diagnostic must still show
  `rootRemoved: true` and no survivors while the process exits non-zero.

## Troubleshooting

- **Every group skips.** You are not on Linux, or `process.platform !== 'linux'`. The harness is
  Linux-only by design.
- **`Bubblewrap is required on Linux …`.** Install `bwrap` (`apt-get install bubblewrap`) and ensure
  unprivileged user namespaces are permitted (`kernel.apparmor_restrict_unprivileged_userns`,
  `kernel.unprivileged_userns_clone`, `user.max_user_namespaces`). The `host` line reports these.
- **`Refusing to qualify the sandbox as root`.** Run as an ordinary user.
- **`Launch through Electron in Node mode …`.** Use the npm scripts, or
  `ELECTRON_RUN_AS_NODE=1 electron scripts/qualify-agent-workspace.js <group>`. Plain `node` cannot
  load the Electron-ABI native SQLite modules.
- **A `previews` port assertion fails.** `pickFreePort` avoids in-use loopback ports, but a busy host
  can still race; re-run. The scenario reads `ss`/`/proc` for listener ownership, so those must be
  available.
- **Cleanup reports `ENOTEMPTY` / survivors.** A genuine teardown regression. The `cleanup` line and
  the `cleanupErrors` array carry bounded diagnostics.
