# Railgun retained POI proof validation — October 4, 2026

This main-owned controller combines retained-output recovery with fresh keyless
verification of the exact encrypted prepared payload. It then reattests the
account and rereads the same stored revision. It returns a completed-attempt
diagnostic, with no receipt/assertion API, sender, proof-registry restoration,
renderer channel or enrollment API change.

The controller accepts only a genuine enrollment, identity and public coordinator,
pinned engine/prover archives, local artifact directory, capsule digest and
lifetime. It opens the account's own POI store internally. There is no route for
caller-supplied records, payloads, recovered output, root observations, verifier
results, callbacks or credentials. Options used after awaits are captured before
work starts.

## Sequence and ownership

1. Authenticate the identity, enrollment, public generation and exact prepared
   record. Normalize the retained payload and compare its digest. One directory
   owner excludes another invocation until every owned stage settles.
2. Invoke the existing output-recovery controller once. Its fresh own-operation,
   source and TXID evidence independently binds the self-transfer blinded output,
   or the full-unshield marker. Compare the returned capsule, revision and payload
   digest, then reread the exact full stored record. Self-transfer releases one
   viewing key to its dedicated child; unshield releases none.
3. After output recovery drains, take a separate account `recovery` phase lease
   for a fresh keyless POI verifier. It uses the pinned prover/verifying artifacts
   and the exact retained payload, requires proof verification, digest agreement
   and actual child exit, then releases the phase. It generates no new proof.
   Reread the exact store snapshot after that stage.
4. Enter a new final account recovery window. Compare its capsule digest, stable
   binding digest and selector with the retained entry, reattest, and strictly
   compare the captures within this window. Reread the prepared entry inside the
   window and again after recovery completes. Identity and coordinator generation
   checks surround asynchronous boundaries.

Archival between stages is allowed when the stable operation binding is unchanged.
Representation/anchor changes between the two explicitly compared captures are
refused. The recovery wrapper subsequently reattests the stable operation binding;
an archival transition after the explicit comparison can therefore be accepted.
The controller does not claim the earlier source capture remains continuously
current, nor does the final reread prevent later external journal writers.

The single overall admission ceiling is 300 seconds. Output recovery receives at
most 240 seconds after reserving 35 for verification and 15 for final recovery;
verification also preserves the final 15-second reserve. Each stage is capped by
the remaining original deadline. These are admission budgets, not guaranteed
completion times. Ignored callbacks and child exit may keep cleanup and ownership
pending beyond the deadline. Earlier source observations can have the broader
total-run age; this creates no short-lived freshness receipt.

The verifier now immediately closes its scope/task on any invalid broker message.
Its validation body contains no await, so refusal becomes permanent before a
second dispatch can advance. Later valid messages cannot recover the attempt,
and even a previously accepted result is refused after subsequent bad traffic.
Closure still waits for actual child exit. This supplements the existing process
supervisor's refusal behavior.

## Exact meaning and limits

`proofVerified` and `independentlyVerified` describe a fresh process using the
same pinned verification implementation. Combined with recovered-output agreement,
they bind the verified retained payload to the account's own operation. This is
not a second cryptographic implementation or an independent security audit.

The original list/TXID roots and checkpoint index stay exactly as stored.
`originalRootsAccepted`, `originalTxidRootCanonical`, `rootAccepted`,
`originalInputReconstructed`, `currentNoteEligibility`, `sourceAuthenticated`,
`membershipAuthenticated`, `disclosureEnabled` and `spendingEnabled` remain false.
Canonicality of the historical root at the saved index is not established: the
index and list key are not SNARK public signals. The original proving witness is
not reconstructed and current note eligibility is not queried.

No additional proof-specific root, owned-note or output-note query is introduced.
Output recovery still performs its existing public/source/TXID preflight, including
TXID-root observations, so the overall operation is not wholly offline in a live
application. A cold public coordinator may reconstruct its checkpoint and write
local public source/catalog data. Prepared records and submission journals are
compared separately. No live funded-account invocation is added; the outstanding
disclosure authorization continues to govern those operations.

A future sender must perform its own authorized one-use handoff and durable
attempt transition. This diagnostic cannot be saved, copied or asserted as a send
permit. Repeated diagnostics are separate invocations and may each perform one
self-transfer viewing-key handoff.

## Qualification

The verifier, proof and checks suites pass 182 tests after the refusal latch;
four added race cases fail when only that latch is removed through an in-memory
module override. Production files remain untouched by that control.

All 454 focused tests pass across five suites in 21.67 seconds, including 122
controller cases; lint is clean.

The native [transfer report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-poi-cold-transfer-2026-10-04.json)
passes in 124,579 ms with 199 matching source hashes. After genuine enrollment and
prepared-store reopen, the fixture changes only the verifier input's on-curve
`pi_a` y coordinate after the host hashes its original input. The encrypted record
remains genuine. The output stage has already completed and matched. The fresh verifier emits no
result and exits with
`RAILGUN_PROCESS_FAILED`; the host refuses at `verify`. A following healthy
attempt validates the original stored payload, with one exact-digest result and
observed normal exit. Both attempts retain the exact record and journal, release
ownership and permit healthy account recapture.

The negative and healthy transfer verifier jobs take 138 and 171 ms. The negative
job has no positive memory sample before exit: its recorded zero is not zero
memory usage. The healthy job's sampled RSS peak is 131,268,608 bytes. Both
attempts first finish output recovery, each releasing one viewing key. Output
utilities provide 13 guard reports / 1,183 canary checks; the healthy verifier
provides one report / 91 checks, all with zero prohibited attempts. The refused
verifier sends no result and consequently supplies no guard report. These are
instrumented broker/process observations, not an OS-wide egress assertion.

The native [unshield report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-poi-cold-unshield-2026-10-04.json)
passes in 123,059 ms with the same 199 matching hashes. It repeats the invalid
proof then healthy retry, releasing zero viewing keys. The verifier jobs take
139 and 174 ms; the negative job again has no positive RSS sample, while the
healthy peak is 130,957,312 bytes. Output utilities provide 11 guard reports /
1,001 canary checks and the healthy verifier one report / 91 checks, all with
zero prohibited attempts. No guard report exists for the refused verifier.
These local measurements are observations, not performance guarantees.

Both kinds retain 17 membership, seven recovery, 13 proof, eight checks and six
prepared-store scenarios, plus two new cold-validation attempts. Each attempt
counts two mirror inspect jobs and one witness job (11 admitted broker messages,
zero forbidden methods). The first attempt additionally restores the public
checkpoint with one public-plan job (three admitted broker messages), 34 header
reads and one log read; the warm retry has no plan job, 22 header reads and no
log read. Existing public latest/root validation calls remain three each per
attempt. There are no new owned-note or proof-specific root queries, proving
jobs or spending-key derivations in the validation stage.

The invalid run's report field `outputMatched: false` describes the refused
overall diagnostic, not an output mismatch; `outputStageCompletedBeforeVerifier`
and the admitted output result record the earlier successful output stage.
The native inventory includes the controller test but not the verifier race test
file. The latter's evidence is the focused/control logs and full regression.

The frozen full regression passes 10,788 tests / 33 skipped across 470 passing
suites in 344.719 seconds, with native access and the existing OpenLV exclusion.
All 199 hashes in both native reports still match after the run. Main remains
synchronized at `f2274ee6` after a fresh fetch; no newer node pins required a
refresh. Claude and Codex reviewed implementation, tests, fixture, evidence and
claims; this is engineering review, not an independent security audit.

Fixtures use synthetic chain/root services, fixture-key service-signature trust,
a disposable public test identity and structural spend proofs/signatures. The
POI proof is generated and verified with the actual pinned local runtimes.
Integrated input position is zero. Enrollment/store reopen happens within one
harness process, not a full browser restart. No live acceptance, Tor socket or
funded operation is qualified. Cold public-plan and TXID mirror broker activity
is counted separately from viewing and verification jobs; prepared records and
submission journals are unchanged even when public checkpoint restoration writes
local source/catalog data.

The first transfer attempt stopped at the fixture's requirement for a positive
RSS sample from the refused verifier. Its preceding no-result/failed-exit checks
passed. Only the measurement assertion was corrected to allow an explicitly
unsampled zero for that negative job; healthy verification still requires a
positive sample. The passing report uses the final frozen qualifier.

The preceding output-recovery reports remain historical at `c8da5b32`; the
verifier source hash changed in this slice. Fresh reports attest this composition.
