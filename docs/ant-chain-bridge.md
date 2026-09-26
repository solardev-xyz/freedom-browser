# Ant chain transport through Freedom

Freedom runs Ant v0.5.45 as a separate `antd` process. The host callback added
in ant#77 is for embedded FFI consumers; the daemon can already use an HTTP
JSON-RPC endpoint. The main-process Swarm service therefore owns a private
loopback bridge to the existing chain-data router. No native patch, dependency
upgrade, renderer capability, or public IPC channel is needed.

## Routing and authority

Every bundled daemon start receives a fresh `127.0.0.1` ephemeral port and a
256-bit random URL capability. `--gnosis-logs-rpc-url` points at that endpoint
for startup discovery and ultra-light fallback reads. Light mode also sets
`--gnosis-rpc-url` to it for normal reads and transaction broadcasts. CLI flags
override the existing config URLs; the capability is never persisted in YAML.
Ultra-light still has no explicit write RPC and the bridge refuses broadcasts.
External, disabled and reused nodes are not reconfigured.

The bridge fixes the chain to Gnosis (100), accepts the eight methods Ant's
chain module issues, and forwards the original params and JSON-RPC id. Reads
follow the network's configured policy (default Myotis → Colibri → RPC quorum
→ direct RPC). Ant's reads are background work: they use Myotis only when its
single in-flight slot is idle and never queue for it, so the node's polling
cannot push interactive wallet/app reads into queue-full fallback.

### Which error Ant sees: one ranking rule

Ant's `scan_logs` halves its `eth_getLogs` window when the error text matches
one of its `is_range_limit_error` needles (a range limit or `query timeout`)
and abandons batch/chequebook recovery on anything else. Behind a multi-source
router, several endpoints fail in different ways for one request, so the
router applies a single rule to log scans (`rankError`, supplied by the bridge
as `rankLogScanError`; the router side is `createErrorKeeper` in
`chain-data-router.js`):

1. **Rank each failure by how useful it is to Ant.**
   - _Range limit_ (highest): an endpoint answered with a JSON-RPC error whose
     text matches Ant's needles _and_ names the query's size (its block range,
     result count or response size), e.g. `-32005 query exceeds max block
range 50000`, `query returned more than 10000 results`, `response size
exceeded`. It depends on the query, not the endpoint. Ant's needles alone
     are too broad to decide this (`limit`, `exceed`, `more than`), so a coded
     reply that matches them without naming the query's size is
     endpoint-dependent.
   - _Timeout_: a client timeout (`RPC query timeout after Nms`), a source
     deadline (Colibri, quorum) or an upstream `query timeout` reply. Ant
     halves on it too, but another endpoint or a longer attempt may answer.
   - _Endpoint-dependent_ (lowest): everything else, which Ant cannot act on:
     `-32601` method not found, `-32603` internal error, rate limits and
     throttles (`-32005 rate limit exceeded`, Infura's `-32005 project ID
request rate exceeded`), an endpoint behind the chain head (reth's `block
range extends beyond current head block`, Erigon's `... is beyond latest
executed block N (node is still syncing)` — they name a range but a synced
     endpoint may answer), a coded reply whose wording names neither a throttle
     nor the query's size (EIP-1474's `-32005 limit exceeded`), HTTP 429/5xx,
     transport failures, a source that is not ready or does not serve logs.
     If such an error is what finally reaches Ant, the bridge keeps its code
     and text, except that a recognised throttle, or a source/transport failure
     with no JSON-RPC code, whose text would match Ant's needles is replaced
     with `endpoint unavailable`, so Ant does not halve its window on a
     throttle. Any other wording is forwarded, so a range cap worded outside
     the list above (`query exceeds limit of 10000 logs`) still makes Ant halve
     once no endpoint answered better, as it would against that RPC directly.
2. **Keep the most useful failure seen so far**, across every tier (Myotis,
   Colibri, each quorum member, each Direct attempt and retry). A later
   failure replaces it only if it ranks strictly higher, so a range limit
   survives a later timeout or 429, and a timeout survives a later `-32601`.
   The one exception is timeout by timeout: the later one replaces the
   earlier, since it is the attempt that actually ended the request (Direct's
   60 s widened retry after quorum's 5 s cut reports `after 60000ms`).
   When every source fails Ant gets the kept error object itself, with its
   original code and text (URLs redacted, see below). If nothing better than
   endpoint-dependent was seen, the router's usual error is reported and Ant
   gives up, as it would against a single failing RPC.
3. **Only a range limit ends the request early.** As soon as one is seen (and
   quorum can no longer agree on a result) the router stops: no later source,
   untried endpoint or retry is asked, and Ant gets it within the time of that
   answer. Every other failure falls through to the next source, endpoint or
   retry exactly like an unavailable source, so a healthy later endpoint stays
   reachable whatever the earlier ones answered.

Wide scans get a 60 s per-URL budget on the direct tier (never less than the
chain's configured timeout). With the default Gnosis policy the RPC quorum
tier asks the first `k` (3) endpoints at the configured 5 s. The direct tier
then tries, in registry order, the endpoints quorum never asked, and after
those the quorum members that never answered, now with 60 s. An endpoint that
answered quorum (with any error) is not asked again. Every attempt sits inside
the bridge's 120 s per-request deadline, which fits only about two full 60 s
attempts after quorum: with several endpoints hanging, the later ones are not
reached and Ant gets the bridge's `query timeout`, halves and retries. Putting
untried endpoints first means a healthy one is reached right after quorum.

Only `eth_getLogs` is ranked. Ant's other reads and all wallet/app reads and
broadcasts pass no `rankError`, so for them nothing is kept or ends early: a
quorum member's own error never replaces the aggregate "all chain sources
failed" error, and a broadcast reports the last endpoint's error (an uncertain
client timeout included). One change does reach every direct/quorum caller:
an RPC client timeout now reads `RPC query timeout after Nms` instead of the
platform's `AbortError` text (its `failureKind` is still `timeout`, so adaptive
routing is unaffected).

Broadcasts use the separate configured broadcast policy and
require an already-signed, chain-bound Gnosis transaction. Ant retains signing;
this endpoint cannot sign, unlock an account or send an unsigned transaction.

This PR is independent of Myotis v0.1.12 / PR #416. Main's v0.1.11 adapter can
serve latest balance, nonce and contract-call reads; logs, receipts, code and
block numbers proceed to later sources. Historical Myotis log-index seeding is
not implemented here. A working bridge does not make every response
cryptographically verified: source-only log entries distinguish `myotis`,
`colibri`, `quorum` and `direct`, and the bridge adds no new UI trust badge.

An unavailable source is handled by the existing router. Exhausted sources
return an error, never fabricated empty logs, zero balance or absent receipts.
Genuine error codes and hex revert data are preserved. The upstream error text
is forwarded to Ant (never logged by the bridge) with URLs replaced by `[url]`,
control characters removed and length capped at 500 characters: Ant's
`scan_logs` halves its `eth_getLogs` window only when that text matches a
range-limit or `query timeout` pattern, so replacing it with a generic message
would abort batch/chequebook recovery on a range-capped RPC. A direct per-URL
client timeout and the bridge's own deadline both report `query timeout` for
the same reason, and a log-scan timeout worded without it (a source deadline)
is prefixed with `query timeout` by the bridge. In particular `-32000` remains an error on this ordinary HTTP
transport. The special FFI callback interpretation of that code does not apply.
The bridge adds no independent transaction retry. An uncertain broadcast must
be reconciled using the original signed transaction, not signed again.

## Lifecycle and access

Stop, unexpected child exit and spawn errors revoke the listener. Stop during
asynchronous startup closes the late bridge instead of spawning a daemon.
Restart creates a new capability. A failed listener bind is surfaced through
the existing Ant startup-error state, not a silent bypass of configured policy.

Requests require the exact loopback Host and secret path, JSON POST and no
Origin or Fetch Metadata. There is no CORS response or OPTIONS support. Batch
requests and notifications are refused. The bridge bounds bodies at 256 KiB,
responses at 16 MiB, active requests at eight, sockets at sixteen and request
lifetime at two minutes. Capacity remains occupied until routed work settles,
even if its client has disconnected. Abort prevents further source fallback;
direct HTTP requests are cancelled. Already-running native/Colibri operations
may settle later under their own bounds; a submitted transaction cannot be
recalled by closing the connection.

The URL is excluded from the manager's startup log. Child output is buffered by
line before capability redaction (a line over 64 KiB is redacted, then cut with a `[truncated N chars]` marker
rather than dropped), including when
a token is split between chunks. URLs, request params and signed transactions
are never logged by the bridge. A process with access to the user's process
arguments can still obtain the capability; it is a boundary against websites
and accidental local access, not hostile software running as the same user.

## Validation

`ant-chain-bridge.test.js` exercises the HTTP boundary with real loopback sockets:
authorization/Origin/Host checks, request limits, exact forwarding, source
reporting, error/revert propagation, broadcast restrictions, cancellation,
capacity and split-log redaction. Manager tests cover mode selection, close,
bind/spawn failure and stop during startup. Router tests ensure cancellation
prevents later fallback or a second direct broadcaster.
`ant-log-scan-routing.test.js` pins the ranking rule as a matrix over the
real router with the bridge's own options and error mapping, under fake
timers: tier (Myotis, Colibri, quorum with all or one of three members, Direct
untried endpoint, Direct widened retry) × error class (range limit, timeout
reply, endpoint-dependent, hang, success), plus arrival-order cases. Each case
asserts what Ant receives, whether Ant's needles match it and the elapsed
time. The review findings that led to the rule (PR #419 R1-F1 … R6-F1) are
named cases there. `ant-chain-bridge.router.test.js` runs the real router
behind the real bridge over loopback sockets with real timers for the same
paths end to end (range limit with three endpoints, widened retry, healthy
fourth endpoint before the bridge deadline, endpoint-dependent error).

The live check uses a newly generated, unfunded temporary managed profile,
real Electron, Ant v0.5.45 and checksum-verified Myotis v0.1.11 / ABI 29. No
existing user profile is touched and no transaction is submitted. The first
probe observed Ant's normal `chain init in progress` response; the completed
probe waited for `chainReady`, then exercised `/wallet`, `/chainstate` and a
stop/restart. See the PR for measurements and current test results.

### macOS arm64 observations, 2026-09-25

The completed live run used the actual managed daemon, not an external node.
Startup log scans (`eth_getLogs`) and `eth_blockNumber` went through Colibri.
`/wallet` returned HTTP 200 in **699 ms** using Colibri balance/contract calls;
`/chainstate` returned HTTP 200 in **436 ms** using Colibri and RPC quorum.
After stop/start, `/wallet` again returned HTTP 200. The whole campaign,
including verified native retirement, finished in **7.406 s**.

Myotis v0.1.11 / ABI 29 was still recovering from a stale anchor with
`quorum-unavailable`. Thus this run qualifies fallback while Myotis is
unavailable; it is **not** a live Myotis-served Ant-read claim. That path is
covered by the router and bridge tests. No light-mode purchase/deposit or live
broadcast was performed. Broadcast validation and failure handling use
locally generated test transactions and a mocked broadcaster.

Original local log SHA-256:
`aaa168e0f50afb9a2fbadd815909cef84cd74a937c92693309cfbfd83837d768`.
The temporary driver and logs are not committed; the repeatable transport and
lifecycle checks live in the test files above.
