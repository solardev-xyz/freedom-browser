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

Wide `eth_getLogs` scans get a 60 s per-URL budget on the direct tier (never
less than the chain's configured timeout). With the default Gnosis policy the
RPC quorum tier asks the first `k` (3) endpoints first, at the configured 5 s.
The direct tier then tries, in registry order, the endpoints quorum never
asked, and only after those retries the quorum members that never answered,
now with 60 s. An endpoint that answered quorum with an error (for example a
range limit) is not asked again. Once any endpoint has answered with an error
Ant acts on (its message matches one of Ant's range-limit or `query timeout`
needles, the bridge's `actionableError` predicate) the retries are skipped
altogether: that verdict reaches Ant after quorum's ~5 s instead of after a
hung endpoint's 60 s retry, and a later timeout never replaces it. Any other
JSON-RPC error (for example `-32601` method not found on one endpoint) is
endpoint-specific: it does not stop the retries or outrank their timeout,
since reaching Ant it would abort the scan where a result or a `query timeout`
lets it continue. Wallet reads and broadcasts pass no predicate, so for them no
reply stops the retries and the last endpoint's error (a broadcast's uncertain
timeout included) is the one reported. Every attempt still sits inside the bridge's
120 s per-request deadline, which fits only about two full 60 s attempts
after quorum: with several endpoints hanging, the later ones are not reached
before the deadline and Ant gets a query timeout, shrinks its window and
retries. Putting untried endpoints first means a healthy one is reached right
after quorum instead of behind retries of endpoints that just failed.

If no quorum member returned a result, quorum keeps the first member's
upstream error, preferring one Ant acts on over another member's timeout. Only
log scans opt into it (`upstreamQuorumError`), so its
wording still reaches Ant when no endpoint is left untried; wallet and app
reads keep the aggregate "all chain sources failed" error rather than one
unverified endpoint's reply.

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
the same reason. In particular `-32000` remains an error on this ordinary HTTP
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
`ant-chain-bridge.router.test.js` runs the real router behind the real bridge
with three RPC endpoints (all used by quorum). It checks that a range-limit
error still reaches Ant, that endpoints cut off by quorum's timeout get the
longer log-scan budget, and (with four endpoints, the first three hanging)
that the healthy fourth is reached before the bridge deadline.

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
