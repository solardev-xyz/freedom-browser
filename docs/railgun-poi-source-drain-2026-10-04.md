# Railgun POI source and membership drain — October 4, 2026

POI source closure now has an explicit completion barrier. A source revokes
immediately on close, but its `closed` promise resolves only after the admitted
acquisition work settles and its owned Tor transport reports actual closure.
Own-membership keeps its directory claim until both its work and that source drain
finish. A new operation cannot take ownership during cleanup.

## Lifetime contract

`createRailgunPoiSource` adds one never-rejecting `closed` promise. Successful
acquisition leaves it pending and preserves existing receipt freshness, retry and
status semantics. A failed admitted acquisition requests terminal close, finishes
its inner request/validation bookkeeping, and only then awaits closure before
returning the sanitized refusal. The barrier depends on that inner work, not the
public promise awaiting it, so there is no self-wait cycle. Invalid admission,
busy calls and invalid budgets retain their previous early-refusal behavior.

The real transport already waits for admitted connection/request work and observed
raw/TLS socket closure. This composition requires that contract; it never replaces a
missing barrier with an already-resolved promise. A rejecting transport barrier is
a contract violation: its rejection is consumed, admission is revoked and source
closure stays pending. A transport that never closes keeps the caller and directory
claim pending indefinitely. There is no deadline escape from admitted cleanup.

Close is synchronous, guarded and idempotent. Constructor failures revoke the scope
and request any available transport cleanup, but a synchronous constructor cannot
promise awaited construction-failure drain. Those failures are not represented as
successful physical closure.

Once verifier work is admitted, its refusal awaits source closure after any
started keyless child has exited. Early argument/receipt admission failures retain
their previous behavior. Successful verification leaves the source open. Own-membership
adds `closed` to successful results; explicit close, timeout or source revocation
invalidates the receipt immediately, while its exact owner token remains held until
both work and source have drained. Failed opens await that same barrier after their
phase/work cleanup. Successful opens return without waiting for terminal closure.

Shared source/verifier failure paths also change account and private-window failure
timing indirectly: those callers now wait for terminal source drain before a failed
acquisition/verification throws. This patch does not yet give those operation
wrappers their own closure barriers or make successful private-window teardown await
them. That explicit integration is the next separately reviewed patch.

## Qualification boundaries

All **172 focused tests across four suites pass in 0.338 seconds**; the separate
private-operation consumer passes **52 tests in 1.411 seconds**. Lint is clean.
Independent source, verifier, own-membership and account consumer tests cover both
request-first and transport-first completion, healthy repeated acquisition, invalid
admission, reentrant/falsy failures, constructor cleanup, rejecting barriers,
independently delayed child/source closure, idle close, owner exclusion and reopen.
Three temporary in-memory guard-removal controls each detect premature release
against three passing baseline controls:
source closure while a request remains active, verifier return before source drain,
and own-operation closure before transport/owner drain.

Native qualification uses genuine encrypted accounts, stores, source/membership
registries and isolated utilities against simulated chain/service/Tor transport.
An intercepted transport has independently controlled request and closure gates;
these qualify barrier consumption and ownership ordering, not physical socket
closure. Actual transport closure is covered separately by the existing transport
implementation and tests. No live owned note, funded account or real service is
queried.

The fixture's successful receipts now await their `closed` barrier. Two cancellation
cases release request and close gates in opposite orders, proving that either
outstanding gate retains ownership and keeps the operation pending. An idle-success
case proves immediate receipt revocation, zero-traffic competing refusal and healthy
reopen only after closure. Existing proof/check modes use explicit request-aware
transport barriers as well.

Final native [transfer](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-poi-source-drain-transfer-2026-10-04.json)
and [unshield](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-poi-source-drain-unshield-2026-10-04.json)
runs pass in **127,010/125,682 ms**, each with **211 matching source hashes**,
19 membership scenarios, seven recovery scenarios, 13 proof scenarios and eight
root-check scenarios. They retain fixture signature trust and synthetic chain
observations. Real guarded proof/verification utilities run, but these fixtures
establish neither live list acceptance nor human consent. The verifier's independent
child-exit versus transport-closure order is unit-level coverage; the native utility
drain case retains its existing immediately available transport barrier.

The first native bring-up pair completed the behavior cases but failed the final
old scenario-list assertion. Only fixture expected modes and aggregate counts were
corrected; production stayed frozen. Those runs are excluded from final evidence.

The full combined regression passes **12,679 tests / 33 skipped**, across **488
passing suites / five skipped**, in **495.621 seconds**. It ran once with native
permissions and the existing OpenLV exclusion, including the private-operation
consumer. The command uses `--forceExit`: test-process completion does not establish
natural drainage of all application handles. All frozen production/test hashes
remain unchanged. Main `6b5c2ea7` was freshly fetched and remains merged with the
previous explicit pinned-node refresh.

## Scope and next work

Source/verifier/own-membership responsibilities remain in the existing main-process
wallet modules. No new IPC, UI, dependency, job/key permission, service method or
policy input is introduced. Account/private-window explicit teardown comes next,
then receiver-only Transact selection, genuine typed membership, actual proof and
intent preparation, and shared Transact output recovery. Neither historical
provenance nor membership establishes which earlier POST was accepted; previous
uncertain attempts remain unresolved and non-retryable. Live disclosure authorization
and production consent/UI remain separate.

Claude reviewed production and fixture behavior; Codex supplied production, independent tests and native qualification.

All 24 public/TXID policy inputs were rehashed unchanged: public `d454092c`,
TXID `03a45fd1`; all 30 wallet policy source entries also match HEAD.

Frozen source/test SHA-256 values:

- `railgun-poi-source.js`: `72d60bd8b12ae1bc1894d0dd198480fb97d4fddc8751e5627626304b75e7e82d`.
- `railgun-poi-source.test.js`: `b2527ebb43617ca4e409e22fd106cb4a22cbc7538fd4059562ed5bd410c543e0`.
- `railgun-poi-membership.js`: `e76086babb7ce17afe730b84985ccda6e8f8bb60898458fd79f9594e139d6199`.
- `railgun-poi-membership.test.js`: `d49a55ad56fa6eb20c228ab3c1abfbd764464893992eb9173a7574929ee878d6`.
- `railgun-own-poi-membership.js`: `fc6c8855ffd02507a39bd88ccdab92f8d22e5e5a104477e30283fd261d1d7493`.
- `railgun-own-poi-membership.test.js`: `e75487246c7a53c0e5048b9a0a7757a688499b0f9d4d8c70ff6899b6bc34dd08`.
