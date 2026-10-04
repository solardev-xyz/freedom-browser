# Railgun keyless own-operation broker refusal — October 4, 2026

The own-TXID selector and detached own-TXID verifier now immediately close their
scope and utility whenever a result-only broker dispatch fails validation. The
validation body has no asynchronous operation: refusal is latched before its
rejected promise reaches the supervisor. A later valid message cannot recover
that attempt, and malformed traffic after an accepted result also revokes it.
The existing final cleanup still waits for actual child exit.

This strengthens the helpers' local guarantees. Review demonstrated that a caller
holding the old broker could swallow a rejection and submit a valid message.
It did **not** establish a successful bypass through the real supervisor: that
supervisor observes dispatch rejection, stops the process and preserves a failing
exit cause, while the pinned jobs await result acknowledgement before ready.
Tests deliberately suppress that supervisor behavior to isolate host revocation.
This is not evidence of a previously successful live unauthorized operation.

Only the two dispatch exception paths change. Normal schemas, pinned jobs,
timeouts, bounded messages, context restrictions and false authority flags remain.
Both utilities are keyless and result-only; there is no borrowed asynchronous
storage/feed work needing a new dispatch drain. No dependency, binary pin, TXID
policy, public generation, network operation, IPC channel or renderer change is
introduced. Earlier whole-source-closure reports remain historical for their
captured revision.

## Qualification

All 69 focused tests pass across the two helper suites in 3.029 seconds, including
24 new cases: malformed-then-valid in the same and next tick, valid-then-malformed
before readiness, and delayed exit, using malformed JSON, method and digest
faults. Assertions outside the callbacks verify immediate signal revocation,
rejected later traffic and cleanup that remains pending until exit. All 24 targeted
baseline controls pass; removing only the new `close()` calls through a temporary
in-memory transformer makes every one fail. Repository source is untouched by
these controls. Lint passes.

Both frozen offline native requalifications pass with 202 matching source hashes:
[transfer](qualification/railgun-own-broker-transfer-2026-10-04.json) in 132,465 ms
and [unshield](qualification/railgun-own-broker-unshield-2026-10-04.json) in
130,313 ms. Each preserves 17 membership, seven recovery, 13 proof, eight checks,
six prepared-store cases and the two retained-history attempts (substituted root
refused, healthy retry validated). Prepared records and submission journals remain
unchanged. Transfer releases two viewing keys across the attempts; unshield none.
Each attempt has 34 read-only TXID broker messages and six explicitly current-root
latest/validate pairs, zero pages. Output/history guard reports total 25/23 with
2,275/2,093 canary checks; both runs add two POI verifier reports/182 checks. Their
prior checks stages separately report 14/1,274. All report zero prohibited attempts.
No native counters changed from the preceding history composition.

The frozen full regression passes 11,148 tests / 33 skipped across 471 passing
suites (five skipped) in 387.697 seconds with native access and the existing
OpenLV exclusion. Both reports still match all 202 source hashes after completion.
Command: `npm run test:coverage -- --runInBand --forceExit
--testPathIgnorePatterns=openlv-protocol.test.js`.
The latest fetch still has `HEAD..origin/main = 0` at `f2274ee6`; no further node
installation was needed. The prior manual node refresh remains intact.

The unchanged retained-history fixture ran against the hardened source
closure for transfer and unshield. Its source inventory additionally includes both
helper test files. Native evidence tests the real composed success and existing
historical-root refusal paths; the new broker-ordering negatives are unit tests,
not native adversarial child scheduling. Synthetic service trust, two-row mirror,
disposable public identity and in-process enrollment reopen limits remain as
documented in [retained history](railgun-poi-retained-history-2026-10-04.md).
