# Retained Railgun recovery window — October 4, 2026

`withRailgunOwnOperationRecovery` keeps the existing authenticated recovery
window open while a trusted main-process callback runs. It shares the capture
and reattestation implementation with `captureRailgunOwnOperation`; no second
capsule, reservation or journal interpretation is introduced.

The callback receives a frozen initial capture, a lifetime signal,
`assertCurrent(minimumRemainingMs)` and `reattest()`. The synchronous assertion
checks the live context and remaining deadline; it does not reread storage.
Reattestation sequentially rereads the authenticated hold, signed capsule and
atomic journal snapshot, compares the original stable operation, and returns a
fresh frozen capture with the latest journal record. It never claims another
recovery phase or exposes the underlying receipt or stores.

Only one reattestation can run at a time. Its promise is observed internally,
including when the callback abandons it. Callback settlement immediately revokes
the window, and pending store work drains before the recovery phase is released.
Overlap and closed-window preconditions throw synchronously; store-read failures
reject the returned promise. Overlap leaves the existing read and window usable.
A failed or abandoned read makes the whole window refuse even if the callback
catches the error and returns a value.
A successful callback result is bounded to 32 KiB of plain detached JSON and
passes a final private reattestation plus the existing recovery post-attestation
before it is returned. Semantic failures return sanitized refusal values inside
the recovery callback, allowing healthy stores to remain usable. Caller
cancellation also leaves the stores open. Existing recovery expiry remains
fail-closed and requires reopening the reservation stores. A single budget of at
most 175 seconds covers capture, callback, final reattestation and recovery
completion; this wrapper does not extend it.

The trusted callback must cancel and drain any other child work it starts before
settling. The window tracks its own reattestation work, not arbitrary caller
promises. Reattestation does not exclude EOA journal writers. Existing detached
capture comparison semantics are preserved: changes that retain the stable
projection may be accepted. POI-specific comparison of active/archive
representation and finality anchors remains a responsibility of the POI
controller, as already implemented in membership composition. A caller requiring
that stricter comparison must explicitly reattest and compare those fields
inside its callback; the final private check preserves the general capture policy.

This is main-owned wallet infrastructure without a new renderer surface, IPC
channel, dependency, policy or key-release permission. A future proof controller
can use the short window to recheck the account at viewing-key handoff and hold
recovery until the isolated prover exits. Membership acquisition, separate
keyless verification and final disclosure checks remain outside that window.
No live query or transaction is introduced here.

## Qualification

The final [transfer report](qualification/railgun-own-recovery-transfer-2026-10-04.json)
and [unshield report](qualification/railgun-own-recovery-unshield-2026-10-04.json)
each pass seven retained-recovery scenarios and all 17 existing membership
scenarios, with 169 matching source hashes. They complete in 42,310 and 41,575
ms. The new cases exercise fresh reattestation, revoked methods, routine journal
refresh, callback failure, oversized output, cancellation with the phase held
until the callback drains, abandoned read drain and a final private reattestation
failure. The latter deliberately adds an unresolved sibling journal entry after
the callback starts; the callback completes normally, but the window and later
membership recapture both refuse.

These runs retain genuine disposable enrollment, encrypted stores and recovery
receipts. The chain/service observations, fixture-key signature trust and
structural spending evidence have the same limits as the earlier
[membership qualification](railgun-own-poi-membership-2026-10-04.md). No live
queries, transaction submissions or operation-time key jobs occur. Recovery
scenarios add only local store work; the exact POI method, signature and utility
counts remain unchanged. Native expiry is not claimed.

All 162 focused tests across the final three suites pass, including 67 tests in
the own-operation suite. The earlier compatibility run passed 221 tests across
five suites before the final finite-deadline hardening; the final focused tests
cover that hardening, shorter recovery deadlines and seven malformed/missing
deadline cases. Expiry during callback, explicit reattestation and final
reattestation is covered using a modeled recovery-store boundary. Independent
valid-inclusion drift is refused, while an archive transition with the same
stable projection remains available for the caller's stricter comparison. Lint
is clean.

The frozen full regression passes 9,911 tests with 33 skipped across 459 passing
suites in 311.983 seconds, with native-process access and the existing OpenLV
exclusion. Claude and Codex reviewed the implementation, tests, native evidence
and documented limits.
