# Railgun retained POI and local TXID history — October 4, 2026

`validateRailgunRetainedPoiHistory` reruns retained-output recovery and fresh
keyless proof verification, then binds the saved TXID root/index to a fresh
checkpoint-only encrypted mirror. It returns a completed local diagnostic. It
cannot restore a proof-registry entry, authorize a disclosure, or enable a sender.
The original `validateRailgunRetainedPoi` export preserves its behavior and shares
the same directory owner with the new fixed export.

## Binding and lifetime

The controller loads the genuine account-owned prepared entry internally. Exact
record, payload digest, revision, account identity, public generation and current
TXID policy remain bound across awaits. Callers cannot supply a record, previous
validation result, root, witness, callback, service URL or substitute payload.
The new path detaches and freezes its record, identity and checkpoint baselines.

After output recovery and the fresh verifier have drained, a separate keyless
selector job derives the own transaction's TXID from the authenticated operation.
A fresh account TXID handle opens with `create:false, checkpointOnly:true`.
It neither advances nor repairs a mirror, and refuses a missing new-policy mirror
or pending journal page. The entire checkpoint is captured before computation.
The own witness must refer to that exact derived TXID and appear no later than the
saved index. The utility receives only the saved index and current state: main
compares its computed historical root with the exact retained root. A second
inspection must match the entire original checkpoint, with no pending page.

The mirror closes and drains before final account recovery. Stable operation
content must match the pre-mirror capture; interstage archival is allowed. The
two explicit final captures additionally use the existing strict archive-anchor
comparison. A subsequent automatic recovery reattestation preserves the stable
projection and may accept later archival representation drift. Final exact record
rereads and policy/identity checks do not establish an atomic cross-store snapshot
or exclude future journal writers.

The new export has a 540-second total admission ceiling. Nonrenewing reservations
allow output recovery up to 240 seconds, verification 35, selector capture 45,
mirror work 180 and final recovery 15. Each receives at most the remaining original
budget after reserving downstream work. The mirror timer includes open, both
inspections, witness, historical computation and close. Earlier source observations
can have the broader total-run age; the diagnostic grants no ongoing freshness.

Account TXID opening has no caller signal. Cancellation stops subsequent admission
but awaits a pending open; a late handle is retained and closed. Once available,
the handle closes on cancellation or mirror timeout. Ignored work and child/worker
exit keep ownership until drain, even past the admission deadline. Ordinary caller
cancellation does not close a healthy enrollment-owned prepared store.

## Exact claims and remaining gates

Success adds only `historicalRootMatchesLocalMirror`,
`ownTxidIncludedBySavedIndex` and `localMirrorCheckpointMatched`. These describe
this completed attempt. Saved index metadata is digest-bound to the verified
payload but is not a SNARK public signal; local comparison does not retroactively
make it one. The historical primitive authenticates a boundary against the current
mirror before reconstructing the prefix, and cannot establish global completeness,
historical publication, independent event coverage or chain canonicality.

`originalRootsAccepted`, `originalTxidRootCanonical`, `rootAccepted`,
`globalTxidCompleteness`, `currentNoteEligibility`, `sourceAuthenticated`,
`membershipAuthenticated`, `disclosureEnabled` and `spendingEnabled` remain false.
Original input witnesses are not reconstructed. A future sender must freshly bind
its own authorized disclosures, source/account/mirror evidence and durable one-use
attempt; neither validation result is a reusable permit.

Historical computation itself is read-only and local. The existing account APIs
still perform current-root observations on open, witness and historicalRoot, in
addition to output recovery's normal preflight. In a live run those calls occur
near a particular retained proof's validation and remain relevant to timing
correlation. They are not acceptance queries for the saved historical root. No
live funded-account invocation, owned/output-note query, proof-specific root
request, private spend or POI submission was performed for this qualification.
The unanswered disclosure approval remains a separate gate.

No dependencies, runtime binary pins, IPC channels or renderer behavior change.
This controller belongs in main alongside the authenticated account and prepared
store owners. It adds no top-level package boundary. The earlier historical-prefix
slice selected a new TXID policy; this composition does not change that policy or
silently rebuild any funded mirror. Earlier whole-source-closure native reports
remain evidence for their dated revisions, not this modified source tree.

## Qualification

Both offline native runs pass with 200 source hashes matching the frozen tree:
[transfer](qualification/railgun-poi-retained-history-transfer-2026-10-04.json)
in 132,029 ms and
[unshield](qualification/railgun-poi-retained-history-unshield-2026-10-04.json)
in 130,003 ms. Each retains 17 membership, seven recovery, 13 proof, eight checks
and six prepared-store scenarios, and adds substituted-root refusal followed by a
healthy history validation after enrollment/store reopen.

Per retained-history attempt, the fixture observes two selector jobs, one own-TXID
verifier, five mirror inspections, two mirror witnesses and one historical job.
The TXID broker admits exactly eight inputs, 18 gets and eight results, with zero
forbidden operations. Six latest/validate pairs all explicitly target the current
index-one root during validation; zero pages are requested. The first attempt also
restores the cold public coordinator via one plan job. Transfer adds one existing
viewing job per attempt; unshield adds none. Every attempt adds one fresh keyless
POI verifier and no prover/spending-key work. Prepared entries and submission
journals remain unchanged; public source/catalog reconstruction may still write.

Across two attempts the transfer output/history utilities record 25 guard reports
and 2,275 canary checks; unshield records 23 and 2,093. Each run additionally has two
POI verifier reports and 182 checks. All record zero prohibited attempts. The
retained earlier checks stage has its separate 14 reports/1,274 checks. These
counts are observed guard reports, not an unqualified count of every fixture or
storage worker in the entire harness.

The first transfer run passed before an evidence review tightened the simulated
service to demand the exact current root during validation. It was rerun after
that assertion changed; only the frozen rerun is committed. The earlier
cold-validation mode is not separately rerun here, and its prior report remains
historical; all 122 original controller tests remain covered.

The frozen full regression passes 11,124 tests / 33 skipped across 471 passing
suites (five skipped) in 381.013 seconds, with native access and the existing
OpenLV exclusion. Both native reports still match all 200 source hashes afterward.
The command was `npm run test:coverage -- --runInBand --forceExit
--testPathIgnorePatterns=openlv-protocol.test.js`; the local log is
`/private/tmp/railgun-retained-history-full-native-tests.log`.

The focused `npm test` controller run passes 287 cases in 30.809 seconds: all 122 prior validation cases and 165
history cases. Account/crypto helpers are mocked while structural normalizers,
privacy contexts and account phase leases remain real. Cases cover exact records,
selector bindings, own-leaf ordering, payload/root/checkpoint/policy drift,
interstage archival, every asynchronous lifetime boundary, pending open,
ignored method/close work and shared-owner exclusion. Temporary in-memory
controls each fail their targeted test when the stored-root comparison,
own-index bound, whole-checkpoint equality, checkpoint snapshot, close-drain awaits
or late-open handle retention are removed.
These controls do not modify production files. Lint passes.

The native fixture uses only two TXID rows, with the own leaf and retained index
both zero. It computes the expected later state in a keyless fixture job, then
advances the real encrypted mirror through the production account/journal path.
Only after that does it reopen enrollment and the prepared store. A valid-field
historical-root substitution is made in transit after the genuine utility result:
account normalization accepts its shape and checkpoint bindings, leaving the
controller's exact comparison to refuse it. The following invocation uses genuine
results. Both invocations reverify the original SNARK and recover its output.
Main trusts the pinned utility for Poseidon; it does not repeat that computation.

The tiny native prefix discards one real right sibling at level zero. The
own-leaf-after-saved-index refusal and false checkpoint metadata controls are unit
checks; native tampering there would break earlier path validation rather than
isolate ordering. Broader computation evidence comes from the separate
[4,230-row historical-prefix run](railgun-txid-historical-root-2026-10-04.md),
including 21 checkpoints across the documented public omission. This composition
fixture does not qualify global event coverage or erase that omission.

Synthetic chain/root services, known disposable fixture keys and fixture service
signature trust remain explicit. No external transport runs. Enrollment/store
reopen occurs in one harness process, not a full browser restart. Guard canaries
are instrumentation evidence, not OS-wide egress isolation. The extra mirror
computation is keyless; self-transfer still releases one viewing key per invocation
through the existing output stage, while unshield releases none.

A refused native attempt has already matched the output and verified its SNARK
before root substitution. The report's `outputMatched:false` on that row denotes
overall diagnostic refusal, not an output mismatch. Both verifier children exit
normally and emit verified results in this control; the refusal is in main.

Claude and Codex reviewed the implementation, test boundaries, native evidence
and prose with no remaining blocking findings. Claude additionally verified the
completed full-regression and controller logs. This is engineering peer review,
not an independent protocol or cryptographic security audit.
