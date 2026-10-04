# Fixed-root Railgun POI observation — October 4, 2026

`createRailgunPoiRootSource` checks whether the fixed Sepolia POI service accepts
one specified required-list root. It accepts only a private-account POI context
and one canonical field element. Its only request is
`ppoi_validate_poi_merkleroots`; callers cannot supply a method, endpoint, list,
note selector or proof payload. A separate reader keeps the existing fixed-note
status/path/signature composition unchanged. This is main-owned wallet service
infrastructure without a production caller, renderer capability or new dependency.

The host creates a fresh privacy scope tied to the caller and current wallet
Tor endpoint. Each acquisition has a default 15-second budget, capped at 45
seconds. Exact JSON-RPC shape, request ID, Boolean result, HTTP status and a
4 KiB body limit are checked. A current, well-formed `false` produces the fixed
`RAILGUN_POI_ROOT_REJECTED` code. Transport, format, expiry and revocation failures
produce `RAILGUN_POI_ROOT_REFUSED`; a transport cannot forge rejection by throwing
an error with that code. Both are sanitized and close the reader. Invalid options
or overlapping calls refuse without disturbing an existing acquisition.

An opaque receipt binds the accepted root and observation to this reader and
acquisition sequence. Its 60-second age begins before the request, with optional
remaining-lifetime margins. Starting a new acquisition invalidates previous
receipts; concurrent, stale, forged and cross-reader assertions refuse. Closing
revokes admission immediately, but `closed` settles only after pending transport
work drains. A transport that ignores cancellation can therefore retain that
drain indefinitely; this is not a bounded cleanup guarantee.

The result is an unverified service observation, not proof binding, authenticated
membership, current per-note status, or disclosure/spending authority. A caller
must bind the exact root to a registered proof and use a fresh operation context.
A historical root can correlate timing even without a note selector, so any live
proof-specific list/TXID-root checks belong behind the same pending disclosure
authorization. Root acceptance must not be assumed to establish that an input
note has not subsequently been blocked. The final controller and durable
submission/recovery policy remain separate work; no live query occurs here.

## Qualification

The [native report](qualification/railgun-poi-root-2026-10-04.json) passes 13
scenarios with seven matching source hashes. The measured host work takes 69 ms;
Electron startup is outside that measurement. Fourteen simulated requests pass
all wire assertions, and all 13 transports close. Accepted/renewed receipts,
forgery, explicit rejection, malformed/error/oversized/non-200 responses,
overlap, explicit close, parent revocation, endpoint abort/change and real
timeout with ignored-signal transport drain are exercised. The 30 ms timeout
revokes at 32 ms, before the fixture releases its pending transport.

Existing canaried egress guards are installed before wallet module imports. All
92 canaries pass with zero capability attempts. The counted in-memory service
factory is installed before the reader loads; a post-assertion request counter
prevents a bad wire assertion from being mistaken for an expected service
refusal. This exercises real privacy scopes and timers, not Tor sockets,
enrollment, live service acceptance or cryptographic membership. Reports contain
no root, note selector or proof payload.

All 157 tests across the root reader and related POI/TXID-source suites pass,
including 115 reader tests; lint is clean. Receipt expiry/margins, non-Boolean
results, invalid options, acquire-after-close and broader malformed-context
cases are unit-tested. The first native run predates the final validated-request
counter and abort-timestamp assertions and is superseded by this report.
The 10,037-test full regression in the preceding proof milestone predates this
new unconnected reader; no new full-regression result is claimed.
