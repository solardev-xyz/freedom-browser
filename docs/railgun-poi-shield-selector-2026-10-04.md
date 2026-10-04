# Keyless Railgun Shield POI selector — October 4, 2026

`deriveRailgunPoiShieldSelector` derives the membership lookup value for a
captured Shield input without receiving a viewing key. It snapshots and normalizes
the recovery capsule and exact creator, compares tree/position, pinned WETH and
net value, and binds the complete normalized input, including ciphertext, with a
domain-separated digest. The guarded utility independently validates the minimal
facts, recomputes the public Shield preimage hash and derives the blinded
commitment using the global tree position. The host checks the exact job digest,
result schema, pin and guards, and waits for utility exit even after cancellation.

This remains detached private data. The public NPK is not proven to belong to the
account; the supplied Shield classification is not proof that a Shield event
occurred. Ciphertext is included in the binding digest but is not decrypted or
authenticated. The worker echoes the full-input binding digest; main supplies
that binding and checks the hash of the exact worker input. Consistently changed
facts with a newly computed input hash are another request, not a binding failure.
All ownership, source, membership, disclosure and spending authority flags remain
false. Neither the selector nor its association digests belong in public reports.

The main wrapper and utility entry fit the existing wallet process boundary.
No key-release allowlist, policy, dependency, renderer or IPC changed. Later
composition must obtain inputs from genuine account preflight, hold its process
phase until exit and recheck account/source/root state before authorizing any
owned disclosure. Transact inputs require a viewing-key path and are refused here.

## Evidence

The [native report](qualification/railgun-poi-shield-selector-2026-10-04.json)
records three vectors with 27 matching source hashes: tree 0/position 10,245,
tree 1/position 65,535 and tree 65,535/position 65,535. The fixture performs actual
Shield encryption and a randomness-decryption round trip, then compares the new
selector with the production pre-spend owned-note projection. Capsules/calldata
are structural fixtures; no creating transaction, account enrollment, spending
signature or proof is authenticated by this qualification.

Each vector passes seven refusals. Altered NPK and another real note's hash at
the same position first pass main normalization, then fail cryptographic hash
comparison. Changed creator position/tree, declared Transact type, missing hash
prefix and wrong token refuse at the data boundary. Mutating ciphertext leaves
the selector unchanged while changing both binding and job digests, explicitly
showing the limit of this keyless check. Each vector’s positive/refusal sequence
takes 944, 870 or 843 ms, excluding fixture construction. Reports
contain no selector, association digest, capsule or ciphertext, and record zero
live queries, submissions and authority granted.

All 164 focused tests across five suites pass and lint is clean. The new tests
exercise strict uint120/scalar bounds, canonical detached data, argument binding,
exact result admission, and timeout/caller/parent revocation before a result and
while exit is deferred afterward. Mock engine tests qualify validation and
lifecycle; the native fixture qualifies cryptographic calculations.

Claude and Codex approved production, tests, native evidence and the documented
limits. The frozen full regression passes 9,814 tests with 33 skipped across 458
passing suites in 306.561 seconds, with native-process access and the existing
OpenLV exclusion.

Next: derive this selector from genuine post-transaction preflight and compose
receipt-bound membership acquisition against a simulated service; then controlled
viewing-only proving and final disclosure checks. The pending live owned-note
query authorization is unchanged.
