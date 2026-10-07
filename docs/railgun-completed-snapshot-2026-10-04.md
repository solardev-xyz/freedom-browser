# Railgun completed-checkpoint snapshots — October 4, 2026

Implemented and independently reviewed. Focused, native and full repository
qualification pass on the frozen snapshot.

## Why a separate read path

The ordinary snapshot path may recover a journal, replay pending work and trim
retained source data. A disclosure review cannot promise a bounded completed
read while silently performing those maintenance operations. The new path reads
only an already completed checkpoint, with a fixed request inventory and a
cancellation lifetime separate from the shared source owner.

`coordinator.withCompletedPublicSnapshot({ destination, signal, timeoutMs }, run)`
reserves coordinator exclusion, authenticates the journal and refuses an absent
or pending checkpoint before RPC, planner or callback admission. It clears prior
readiness when the operation is admitted. Success remains `{ value, evidence }`,
compatible with `assertSnapshot`; a refused operation issues no snapshot token.
Any admitted attempt clears prior readiness, including destination mismatch,
provider mismatch and missing checkpoint. Pre-admission invalid arguments, busy
and an already-aborted caller leave the existing owner untouched.

`getRailgunCompletedSnapshotOutcome(coordinator, error)` authenticates the exact
final rejection using private identity, returning frozen `{ fatal, reason,
rpcFailure }`. Copied, unknown and cross-coordinator errors refuse. Registration
occurs after cleanup, so a late integrity failure can upgrade cancellation; the
historical outcome remains readable after fatal owner closure. Successful calls
register no failure outcome. This accessor supplies provenance, not consent.

The source owns a fixed operation returned by
`openCompletedCheckpointRead({ checkpoint, destination, signal, deadline })`:
`prepare()`, an optional single `visitSource(visitor)`, then `finish()`, with
`signal`, `close()` and `closed` for lifetime management. Stage methods cannot
renew the deadline or repeat a consumed stage. Preparation and finish return
source plan/evidence pairs held by the coordinator. Final outcome is private
operation state, not a caller-supplied benign flag or public error code.

## Completed data only

Every operation revalidates from retained data, even if ordinary readiness is
warm. This intentionally pays the cold bound and avoids borrowing uncertain warm
provenance. It does not call ordinary recovery, ledger staging, retention,
`beforeAcquire`, range apply, or journal prepare/complete.

The current provider-host digest must equal the checkpoint's digest before any
query. A mismatch is a benign refusal. The digest covers hosts, not URL paths;
the exact retained RPC client is separately bound by the opaque destination
observation. Changing provider provenance requires a separate ordinary recovery,
which can replay pending work and trim retention. This operation never invokes
that recovery implicitly.

`ledger.hasPrefix(digest)` authenticates retained range metadata under ledger
exclusion. It returns a boolean without reading or returning log payloads and
without writes. A missing target is benign only after a valid complete metadata
walk establishes absence. Missing records, malformed metadata, broken linkage or
inconsistent tail/count are failures. A later full `visitThrough()` still
authenticates the actual prefix logs; presence inspection is not proof of their
contents. A target found present and then absent during that visit is a failure.

Final journal revalidation receives no replacement plan, so it does not rewrite
provider provenance. This is not a claim of disk immutability: journal opening,
leases and existing housekeeping remain separate, and revalidation updates an
in-memory baseline.

## Fixed request schedule and validation

The operation uses one genuine private RPC budget. It performs four canonical
header passes even if the callback never visits source logs: before acquisition,
after planning, before the callback window and after it. There is one exact logs
query and at most one event-header request per distinct event-bearing block.

For `C` canonical selectors and `E` event blocks, the inventory is `4C + E`
headers, one logs request and at most one actually initiated chain-ID check.
`C <= 5` and `E <= 512`, for at most 534 transport admissions. Shared cached
chain checks do not charge a new chain admission. All requests retain the same
client and destination; there is no retry, fallback or deadline renewal.

Actual header/log normalization and independently known checkpoint comparisons
run inside the awaited RPC validator. Normalized facts remain available for
cross-response checks even if RPC subsequently refuses due to cancellation.
After a batch drains, complete observed relationships are checked before local
cancellation is classified. An unadmitted response is not fabricated into a
data mismatch. Malformed data actually observed cannot be hidden by cancellation.

## Cancellation and failure

Local cancellation stops new request/stage admission. An admitted planner still
receives the complete authenticated ledger prefix under the source-owner
lifetime; its projected state and utility-process completion are checked before
cleanup. Truncating its feed would turn ordinary cancellation into a false
projection mismatch.

External callback visits behave differently: after local cancellation they stop
delivering further logs to the callback, while the ledger continues authenticating
the suffix. An already running visitor is awaited. Unknown visitor/callback
exceptions remain fatal, and catching a malformed broker request in the callback
cannot erase its privately latched failure.

The coordinator retains the actual callback promise and every borrowed broker
request and ledger visit. Both coordinator and source exclusion remain held until
planner, callback, ledger and RPC budget work drain. Benign cancellation, expiry,
allowance refusal, provider mismatch and genuine prefix absence preserve healthy
shared resources. Response, storage, projection, journal and owner failures remain
fatal. For RPC failures, the budget's authenticated response/transport/revoked
category is preserved. Non-RPC failures remain fatal with `rpcFailure: null`;
this interface does not classify them as response corruption or distinguish
individual storage, planner, journal and callback causes.

There is no physical socket-drain or hard cleanup-time guarantee. A callback that
ignores cancellation may keep exclusion held until it settles. No cancelled or
failed operation may restore earlier readiness or publish final evidence.
Cancellation or expiry during final cleanup discards the candidate snapshot even
when its earlier checks succeeded.

## Qualification

- 175 focused tests pass across six suites, including 103 new cases, in 25.498
  seconds. Lint is clean. Real encrypted suffix corruption remains fatal after
  cancellation; the healthy counterpart preserves the source. Pending journals,
  missing prefix, metadata corruption, held borrowed work, falsy throws, final
  drift, deadlines and outcome identity are covered. A boundary/event overlap
  case admits exactly `4 * 3 + 2 = 14` headers.
- Four temporary in-memory guard-removal controls produce ten direct failures
  against eleven passing baseline tests: planner feed drain (2), final headers
  (2), falsy visitor exceptions (5), and corrupt ledger suffix (1). The healthy
  suffix counterpart still passes. The first suffix mutation matched two sites
  and refused to run; only the corrected single-site control is counted.
- Native Electron [transfer](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-completed-source-transfer-2026-10-04.json)
  and [unshield](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-completed-source-unshield-2026-10-04.json)
  each pass 19 groups: six existing source, three destination and ten completed
  snapshot groups. They retain 140 matching source hashes, taking 3,658/3,088 ms.
  Actual enrollment, encrypted storage, journal, public planner and coordinator
  run with real private RPC over simulated transport/registry/Tor. Each run has
  four client constructions and 179 requests: two chain-ID, 170 headers and seven
  log queries across all scenarios; no external request or submission occurs.
- Completed successes use exactly `4C + E` headers and one logs request, with an
  initial chain-ID request only for the fresh client. Their full journal records,
  including checkpoint/provider provenance, remain equal before and after.
  Empty checkpoint, pre-abort, copied destination and changed provider host
  refuse without RPC/planner work. Planner cancellation delivers the complete
  prefix; callback cancellation suppresses later delivery while authenticating
  the suffix and holding exclusion. Reuse succeeds. A caught malformed broker
  request stays fatal. Native exact/copy/cross-owner outcome checks pass.
  Each completed group's work delta has zero stage, retain, `beforeAcquire` and
  apply calls; the aggregate counters include the ordinary initial advance.
  The provider-mismatch and final zero-query reopen clients perform no chain-ID
  check, explaining two handshakes across four constructions.
- The pending-checkpoint, expiry, event-boundary overlap and RPC fatal-category
  cases are unit-level evidence. Native fatal coverage is the broker case with
  `rpcFailure: null`; no native response-corruption category claim is made.
- Fresh-policy retained-history [transfer](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-completed-history-transfer-2026-10-04.json)
  and [unshield](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-completed-history-unshield-2026-10-04.json)
  preserve 17 cases and 204 hashes in 130,246/128,196 ms. These compatibility
  fixtures explicitly simulate destination binding and services; they do not
  exercise the new completed-only path or real chain-ID handshakes.
- Fresh enrolled [staging](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-completed-staging-2026-10-04.json)
  preserves 19 surrounding cases and 130 hashes; its handoff takes 4,198 ms with
  no spending key, signer or external transport admission in that stage.
- All five report inventories were rehashed and copied byte-for-byte. Initial
  native setup failures (relative archive path, then missing fixture source
  handle) are not counted as passes. Claude reviewed production and native
  coverage; Codex supplied implementation and independent regression tests.

The frozen full regression passes **12,097 tests / 33 skipped**, across 486
passing suites in 440.466 seconds, with native-process access and the established
OpenLV exclusion. None of these results establishes live service acceptance,
human consent, cryptographic chain trust or spend authority.

## Policy and next steps

Source, coordinator and ledger are public-policy inputs. This slice changes that
policy from `9cd0ea7d300f2df40073d6a77c81e8f601280c0230fd905fc6ac0739bef33727`
to `d454092c2a951aca09b6f8b6d84196a947c3ae77a003f86e6aed9dd7d0f1b477`.
TXID policy inputs and hash stay unchanged at
`03a45fd173ed2c639b314abde9547f469ac25ef255a12e4e974a935bef1c73c7`,
freshly computed with `getRailgunTxidPolicy()` against the pinned engine archive,
but the new public generation changes mirror bindings, keys and directories.
Old generation reports are historical. Fresh disposable generations were
qualified above; existing encrypted files are retained.
It does not authorize a funded-profile rebuild, owned-note query, proof-specific
root check or POI submission. The trusted-main disclosure controller remains a
subsequent task; no new UI or consent capability is introduced here.
