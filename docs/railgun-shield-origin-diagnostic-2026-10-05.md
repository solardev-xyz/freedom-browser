# Local Shield-origin diagnostic — October 5, 2026

The main-process `diagnoseRailgunShieldOrigin` joins an already-open genuine
Railgun account with its existing encrypted EOA submission journal. It requires
one selected unspent Shield note and exactly one matching active resolved deposit
record, with every active journal record resolved. It makes no RPC, opens no
account and creates or repairs no storage. It has no production caller or IPC.
This belongs in the main wallet layer because it borrows privileged account and
journal handles; exposing those handles to the renderer would break that boundary.

The host checks exact owner references, genuine enrollment and identity, the
account's current view and generation, public generation/source IDs, selected
note and checkpoint, and public funding metadata. It reads the journal twice
through the [existing-only reader](railgun-existing-journal-reader-2026-10-05.md)
and requires the selected record and captured account bindings to remain the
same. All borrowed owners remain caller-owned; only its child scope closes.

Cancellation and a fixed ten-second deadline suppress results while still
awaiting admitted reads. The deadline bounds acceptance, not drainage of a stuck
callback. Independent review found and fixed a missing final elapsed-time check:
synchronous matching could exhaust the budget before a delayed timer ran.

The small frozen result exposes no account, note, address or journal details.
`trust: 'supplied-data'` describes public transaction/receipt/checkpoint hints.
The two local-authentication flags identify authenticated local evidence sources;
ownership, canonicality, spending and POI-bypass flags remain false. Funding
metadata is not a key-possession proof. Checkpoint hashing excludes provider
provenance; the matcher does not recompute the Poseidon note commitment.
Endpoint checks do not provide cross-file atomicity or continuing permission.

## Validation

The two exact r2 files were independently reviewed by Claude and Codex. The
candidate passes 117 host/matcher tests; seven detached mutations demonstrate
that removed checks fail, including the final deadline check. Tests use genuine
privacy contexts and the real matcher but mock owner registries and the journal
reader; they do not qualify genuine enrollment or encrypted native integration.
After import, all 315 host/matcher/reader tests pass in 11.53 seconds with natural
exit. Full lint and two-file formatting pass. No dependencies or source policies
changed. A later policy-bound consumer needs its own dependency/policy review.

Candidate freeze: `7c3de717ecc893af6e4f9c327084976e3199774d4f2e54f8cdcf81d861b84e08`.
Host source: `f2a12e52735b11bccc0eeba7ddb833780bd0102a988c51e3c7984e5e25a5b8c8`.
Test source: `22c588540d46e4150394e210718f90e846efedce33106ed4a8cb4ee788684c90`.

Native integration remains pending. The next controlled campaign will use fresh
disposable profiles, actual persisted journals and ordinary scanning/restoration,
measure file and activity changes at the diagnostic boundary, and test refusals
without revoking borrowed owners. Earlier native reports retain their recorded
source/runtime scope. No funded profile, live POI query, private broadcast,
return-to-origin spending permission or product activation is added.
