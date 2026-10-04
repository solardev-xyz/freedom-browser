# Enrolled local Railgun POI proving — October 4, 2026

`proveRailgunOwnPoi` connects a genuine post-spend Shield membership receipt to
one viewing-key handoff, a real local POI proof and verification in a fresh
keyless process. It supports the existing single-input WETH self-transfer and
full-unshield scope. The result stays in private main-process memory and grants
no disclosure, spending, current-source, membership or finality authority.
There is no renderer, IPC or production caller, live request or submission.

The controller accepts proof preparation only from the registered membership
receipt. It binds the current identity, enrollment and public coordinator, then
opens the existing authenticated recovery window. The account capture must
match the membership baseline, including active/archive representation and its
finality anchor. At the exact purpose-and-input-digest key request, it consumes
the receipt before any asynchronous work. Refusals before a valid request leave
it reusable; any failure after that request consumes the attempt.

Fresh private reattestation runs before derivation and again inside the viewing
credential callback. Identity, generation, cancellation and remaining-deadline
checks repeat synchronously immediately before copying the 32-byte viewing key.
No spending private key is requested. The utility authenticates the engine,
prover and artifacts before requesting its key; it reconstructs the witness
internally and makes one proof per process. Main derives and compares the list
root, TXID root/checkpoint index, unshield marker and output count, reconstructs
the canonical payload and checks its digest. Only the proof and blinded outputs
come from the utility. These fields remain privacy-sensitive even though they
are circuit public inputs.

The controller admission deadline is at most 175 seconds. Cleanup can extend
beyond that deadline while borrowed work drains. Recovery receives at most 120
seconds; the viewing job stops ten seconds before that deadline, with at least
ten seconds remaining required at key admission. The ten-second cleanup reserve
covers drain, final reattestation and recovery completion. A separate 35-second
budget covers keyless verification (at most 30 seconds) and controller checks. The process has
an explicit 256 MiB heap and 768 MiB RSS limit. Its startup timer covers the
whole job, so both process timers use the same bounded job budget.

Every host key copy is wiped, and both child exit and borrowed asynchronous
broker work drain before recovery releases its phase. A derivation or store
read that never settles can retain the phase indefinitely: cancellation revokes
further admission but cannot make that borrowed work complete. This is a
fail-closed hold, not an automatic release after a timer. SDK strings and
private witnesses disappear with utility exit; JavaScript heap erasure is not
claimed. The general recovery post-attestation retains its existing comparison
policy and does not exclude concurrent EOA journal writers.

Only after that recovery window closes does a separate recovery-phase claim
allow the existing keyless POI verifier to run. It verifies the exact payload
digest and all eight proof signals, rejects an altered-root control, and must
exit before success is returned. This is a fresh process using the same pinned
cryptographic implementation, not an independent cryptographic implementation.

The binary-key allowlist adds only the exact `engine/poi-prove` context and
dedicated job filename pair. Enrollment adds only the keyless `prover/poi-verify`
context alongside its existing verifier; no wildcard capability is introduced.

Membership data is historical preparation after admission. It can expire while
proving; that is acceptable for this local diagnostic and cannot authorize
later disclosure. Fresh account/source/finality and root checks, authorization,
durable POI submission and uncertain-response recovery remain separate work.
Transact-created input provenance and foreign-recipient transfers also remain
outside this controller's supported scope.

## Qualification scope

The native fixture uses genuine disposable enrollment, encrypted stores,
reservations, capsules, journals, source receipts and membership receipts. A
setup-only utility derives the viewing key from a published test mnemonic and
checks its full public descriptor against enrollment. SDK-generated nullifiers,
output ciphertext, commitments and bound parameters match the transaction;
production reconstruction checks the private values inside the setup process.
The spending signature and spend proof remain structural. Chain/root services
are simulated, and service signatures use the explicitly substituted fixture
Ed25519 key; real required-list authentication is not qualified.

This integrated fixture uses input tree zero and position zero. Nonzero input
position 10,245, unrelated output position 23,456, and paths with index five and
sixteen nonzero siblings were exercised separately in the earlier
[standalone reconstruction qualification](railgun-poi-reconstruction-2026-10-04.md).
Those runs do not substitute for an integrated nonzero-position run.

The final [self-transfer report](qualification/railgun-own-poi-proof-transfer-2026-10-04.json)
and [unshield report](qualification/railgun-own-poi-proof-unshield-2026-10-04.json)
each pass 13 proof scenarios, the seven retained-recovery scenarios and the 17
membership scenarios. All 183 recorded source hashes match the frozen tree.
The runs take 97,895 and 97,358 ms, respectively; prover peak RSS is 487,473,152
and 427,343,872 bytes, below 768 MiB, and maximum result wires are 3,842 and 3,838
bytes, below 32 KiB.

Each run observes 11 viewing-job exits, seven production key handoffs and two
keyless verifier exits. Forged and consumed receipts start no job. Four malformed
initial requests start a utility but release no key; that same receipt then
proves successfully. Other cases change a bound root, negate an on-curve proof
point, request a second key, close the supervisor after key release, cancel the
caller, or withhold readiness after result admission until the early deadline.
The altered proof reaches the fresh verifier and refuses. Supervisor closure
is not an unexpected native crash test. Key-time account drift and pending
broker callbacks that outlive utility exit are covered by unit tests.

The early-deadline exits report session revocation at 24,988/24,995 ms against
actual job budgets of 24,967/24,973 ms. Every proof attempt asserts zero RPC,
public-service and POI activity or transport changes, unchanged journal state,
healthy account recapture after drain, all utility exits and zeroed host key
replies. Overall service calls belong to membership/preflight qualification,
not proving; they are counted simulated calls. No live queries or submissions
occur. The report separates one setup viewing derivation from production
handoffs and two enrollment setup key jobs.

All 261 focused tests across six suites pass, including 81 controller tests.
Lint passes. The first transfer run passed before the final no-service and
deadline-cause assertions; these final reports supersede that earlier run.
The frozen full regression passes 10,037 tests with 33 skipped across 462
passing suites in 312.34 seconds, with native access and the existing OpenLV
exclusion. Claude and Codex reviewed production, tests, native evidence and
documented limits; this is engineering review, not an independent security audit.
