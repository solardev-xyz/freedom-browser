# Ant chain transport through Freedom

Freedom runs Ant v0.5.59 as a separate `antd` process. The host callback added
in ant#77 is for embedded FFI consumers; the daemon can already use an HTTP
JSON-RPC endpoint. The main-process Swarm service therefore owns a private
loopback bridge to the existing chain-data router. No native patch, dependency
upgrade, renderer capability, or public IPC channel is needed.

## Routing and authority

Every bundled daemon start receives a fresh `127.0.0.1` ephemeral port and a
256-bit random URL capability. Both `--gnosis-logs-rpc-url` (startup discovery)
and `--gnosis-rpc-url` (normal reads and transaction broadcasts) point at that
endpoint: there is no browse-only mode, so the node can always buy storage and
settle, and the bridge always forwards its signed Gnosis transactions. Freedom
writes no chain RPC URL into the YAML config at all; the capability is never
persisted. External, disabled and reused nodes are not reconfigured.

The bridge fixes the chain to Gnosis (100) and accepts the nine methods Ant's
chain module issues. It forwards eight of them (seven reads plus
`eth_sendRawTransaction`) with the original params and JSON-RPC id, and
answers the ninth, `eth_chainId`, itself (`0x64`): Ant v0.5.58+ keys its saved
wallet scan by the chain id and asks for it before every scan. Reads
follow the network's configured policy (default Myotis → Colibri → RPC quorum
→ direct RPC), with one exception: `eth_getLogs` never reaches Colibri, for
Ant or any other caller (Colibri's entry in the router's
`SOURCE_CAPABILITIES`, below). Colibri proves that each log it returns is real,
not that none is missing, and the public Gnosis RPCs behind it cut a large log
answer short without an error, so a partial answer would come back marked
verified ([#496](https://github.com/solardev-xyz/freedom-browser/issues/496)).
(Its verification used to run on the main thread too, where a wide log range
froze the whole browser for 20-30 s; since
[#495](https://github.com/solardev-xyz/freedom-browser/issues/495) it runs in a
worker thread.) A page's `eth_getLogs` therefore comes back `verified: true`
when RPC quorum agrees and `verified: false` only when it falls through to
direct RPC. Ant's log scans go to the RPC quorum only (below). Ant's reads are
background work: they use Myotis only when its single in-flight slot is idle
and never queue for it, so the node's polling cannot push interactive
wallet/app reads into queue-full fallback.

### What each source can serve

The router (`chain-data-router.js`) keeps one capability descriptor per read
source, `SOURCE_CAPABILITIES`, and consults it before trying a source
([#497](https://github.com/solardev-xyz/freedom-browser/issues/497)):

| | Myotis | Colibri | RPC quorum | direct RPC |
|---|---|---|---|---|
| never serves | filters, `web3_*` | filters, `web3_*`, `eth_getLogs` | filters, `web3_*` | — |
| `eth_getLogs` span | — | 10,000 (upstream; unused) | learned per endpoint | not tracked |
| log answer may be cut short | — | yes | yes | yes |
| cost | serialized | proof | fan-out | single |

- **Methods.** A source that never serves a method is left out of that
  request before routing starts, together with the caller's own
  `excludeSources`; an error names both as `excluded for this request`.
  `excludeSources` is caller policy (Ant's log scans ask the quorum only), the
  descriptor is the source's capability. Filters (`eth_newFilter` and its
  siblings) live on one node and `web3_*` answers describe one node, so only
  direct RPC serves them. What depends on the request rather than the method
  is still refused by the source's adapter and reported as that source's
  failure: Myotis serves only the methods its addon version implements, at
  `latest`, with the call fields it can honour.
- **Limits.** The quorum asks a range-capped log scan only of endpoints whose
  learned cap covers its span (below). Colibri's upstream cap is recorded but
  not consulted while `eth_getLogs` stays off Colibri.
- **Cost.** Myotis is serialized (one native read per chain at a time), so
  background callers such as Ant take it only when idle and never queue.
  Colibri verifies proofs in a worker thread with a bounded number in flight.
- **Cut-short log answers.** For a source marked as possibly cutting a log
  answer short, the router checks each `eth_getLogs` answer over a numeric
  block range at least 2,000 blocks wide whose logs all fall in the last
  1,000 blocks of the range: the shape #496 measured on 2026-10-04, where
  `rpc.gnosischain.com` and `gateway.fm` both answered a query matching more
  than ~50k logs with only the latest ~474 blocks' logs and no error. A
  genuinely sparse answer looks the same (a wallet funded minutes ago, scanned
  from the token's deployment), so the shape alone fails nothing: the same
  source is asked once more for the blocks before the oldest returned log. Any
  log there proves the first answer incomplete, and the request fails at once
  with `-32005 query matched too many logs ...; narrow the block range`; no
  later source is asked, since the RPCs behind it cut the answer the same way.
  Ant ranks that as a range limit and halves its window until the answer is
  complete. An empty or failed check accepts the answer as before. A range
  ending at a tag (`latest`) is not checked: its end is unknown without
  another request. The cut depends on how many logs match, not on the span, so
  a window Ant halved after one such error is checked the same way; only a
  range under 2,000 blocks goes unchecked, since all its logs fall in the last
  1,000 blocks whether or not it was cut. A failed check is not counted
  against the endpoints: it neither cools them down nor bounds their span.

### Log scans: the RPC quorum only, within each endpoint's range cap

Ant finds its batches and chequebook by scanning the wallet's xBZZ `Transfer`
logs (`eth_getLogs`), and re-reads everything it finds (owner, balance,
factory, issuer) with ordinary verified reads. A log it never receives is the
one failure it cannot detect: a missing chequebook transfer would make it
deploy a second chequebook. So only the RPC quorum answers these scans (the
bridge passes `excludeSources: ['myotis', 'colibri', 'direct']`): no single
endpoint's answer settles a range. Myotis serves no logs, and Colibri proves
the logs it returns but not that none are missing (its completeness proofs did
not answer on the Gnosis prover, #484). The quorum budget is widened to 30 s
for them, since a full-history answer can take seconds.

Public RPCs cap the block span of one `eth_getLogs` differently (measured for
#484: `rpc.gnosischain.com`, Tenderly, serves the full history; the
`gateway.fm` and `swiftnodes` hostnames are the same backend; publicnode and
dRPC's free plan serve 10,000 blocks). The router learns each endpoint's cap
from the number its refusal names (`logScanRangeCap` in the bridge; a range
limit without one bounds the span it was asked), in memory only, for 30
minutes, after which the endpoint is asked again. Two refusals are not read as
block-range caps:

- an upstream `query timeout` reply bounds the endpoint below the span it timed
  out on for 30 s only: a busy server is no range limit to hold every later
  scan window to for half an hour;
- a cap on results, logs or response size (`query returned more than 10000
  results`) is not learned at all. It depends on the filter, not on the
  endpoint, so a sparse filter over the same range is still asked. Ant still
  halves the window it was refused.

A scan asks the first `k` endpoints whose cap covers its span. If that round
fails, the endpoints it just learned about are taken out (capped, or cooling
down for 30 s after a hang, refused connection, throttle or other endpoint
failure) and, if another quorum can serve the same span, it is asked straight
away. When none can, Ant is told the widest span a quorum can still verify, as
`-32005 query exceeds max block range N`, without any endpoint being asked, and
halves its window towards it. Only when no quorum can serve any span does Ant
get an error it does not halve on, and it resumes the scan later from its
saved progress.

**A quorum is required.** Since no single endpoint's answer is accepted for a
log scan, a node configured with fewer Gnosis RPC endpoints than the quorum
size `m` (default 2 of `k` = 3), or with a read order that leaves out
`quorum`, cannot complete Ant's log scans at all: every `eth_getLogs` fails
(`RPC quorum needs m endpoints` / `No chain source left`), Ant ends the scan
and retries it later, and its postage batches and chequebook are not found
until the configuration changes. Ant's other reads and broadcasts are not
affected. The bridge logs `eth_getLogs is answered by the RPC quorum only,
and none is configured for Gnosis` once per node start when this happens. A
user with a single custom Gnosis RPC must add a second, independent one (two
hostnames of the same backend agree with each other by construction and are
no independent check).

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
     reply that matches them without naming the query's size is at most a
     possible range cap (below).
   - _Timeout_: a client timeout (`RPC query timeout after Nms`), a source
     deadline (quorum) or an upstream `query timeout` reply. Ant
     halves on it too, but another endpoint or a longer attempt may answer.
   - _Possible range cap_: any other coded reply whose text matches Ant's
     needles and names neither a throttle nor a lagging endpoint, e.g. a cap
     worded outside the list above (`-32005 query exceeds limit of 10000
logs`, `ranges over 10000 blocks are not supported`) or EIP-1474's
     ambiguous `-32005 limit exceeded`. It may be a throttle, so later
     endpoints are still asked, but no endpoint-dependent failure replaces
     it: if nothing better turns up Ant gets it with its code and text and
     halves, as it would against that RPC directly.
   - _Endpoint-dependent_ (lowest): everything else, which Ant cannot act on:
     `-32601` method not found, `-32603` internal error, rate limits and
     throttles (`-32005 rate limit exceeded`, Infura's `-32005 project ID
request rate exceeded`), an endpoint behind the chain head (reth's `block
range extends beyond current head block`, Erigon's `... is beyond latest
executed block N (node is still syncing)` — they name a range but a synced
     endpoint may answer), HTTP 429/5xx, transport failures, a source that is
     not ready or does not serve logs. If such an error is what finally
     reaches Ant, the bridge keeps its code and text, except that a
     recognised throttle, or a source/transport failure with no JSON-RPC
     code, whose text would match Ant's needles is replaced with `endpoint
unavailable`, so Ant does not halve its window on a throttle.
2. **Keep the most useful failure seen so far**, across the quorum's members
   and rounds (Ant's log scans ask no other source). A later
   failure replaces it only if it ranks strictly higher, so a range limit
   survives a later timeout or 429, a timeout survives a later `-32601`, and
   a possible range cap survives a later 429 or refused connection.
   The one exception is timeout by timeout: the later one replaces the
   earlier, since it is the attempt that actually ended the request.
   When every source fails Ant gets the kept error object itself, with its
   original code and text (URLs redacted, see below). If nothing better than
   endpoint-dependent was seen, the router's usual error is reported and Ant
   gives up, as it would against a single failing RPC.
3. **Only a range limit ends the request early.** As soon as one is seen and
   the quorum can no longer agree on a result, the router stops and Ant gets
   it within the time of that answer. Any other failure leaves the quorum
   waiting for its remaining members, up to its budget.

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
capacity and split-log redaction. Manager tests cover starting the daemon with
its write-capable chain transport, close, bind/spawn failure and stop during
startup. Router tests ensure cancellation
prevents later fallback or a second direct broadcaster.
`ant-log-scan-routing.test.js` pins the log-scan routing over the real router
with the bridge's own options and error mapping, under fake timers: that only
the quorum is asked (Myotis and Colibri never, whatever they would answer), the ranking rule as a matrix of quorum members (all,
two or one of three) × error class (range limit, timeout reply,
endpoint-dependent, hang, success) plus arrival-order cases, the PR #419
review findings that still apply, and the range caps, replaying the endpoint
behaviour measured for #484 through Ant's halving. Each case asserts what Ant
receives, whether Ant's needles match it, the elapsed time and which RPCs were
asked. Its `silent truncation (#496)` cases replay the measured cut-short answer
through Ant's halving down to a complete one, and a recent-only sparse
answer being accepted. `ant-chain-bridge.router.test.js` runs the real router behind the real
bridge over loopback sockets with real timers for the same paths end to end
(range limit, slow members inside the scan budget, a lone answer not
settling a scan, a fourth endpoint joining, an endpoint-dependent error).

The live check uses a newly generated, unfunded temporary managed profile,
real Electron, Ant v0.5.45 and checksum-verified Myotis v0.1.11 / ABI 29. No
existing user profile is touched and no transaction is submitted. The first
probe observed Ant's normal `chain init in progress` response; the completed
probe waited for `chainReady`, then exercised `/wallet`, `/chainstate` and a
stop/restart. See the PR for measurements and current test results.

### macOS arm64 observations, 2026-09-25

The completed live run used the actual managed daemon, not an external node.
Startup log scans (`eth_getLogs`) and `eth_blockNumber` went through Colibri
(log scans no longer do since PR #494; see *Routing and authority*).
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
