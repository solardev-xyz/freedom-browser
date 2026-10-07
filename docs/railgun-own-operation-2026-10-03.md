# Railgun detached own-operation capture — October 3, 2026

`captureRailgunOwnOperation` reads a proved private operation from a genuine
enrolled account under the existing signing-recovery phase. It joins the selected
input reservation, stored capsule/proved transaction and exactly one matching
resolved active or archived EOA submission record. It returns frozen comparison
data only: no receipt, hold ID, writer lease, signing permission, current-finality,
source, TXID-root or POI authority survives the call.

The selector is the existing tree/position/nullifier/note-hash shape and is pinned
before asynchronous work. The capture requires exact receipt-bound stored facts,
the account wallet ID, full submitted-calldata digest and matched journal outcome.
Any unresolved sibling submission or ambiguous candidate refuses. Reads of the
reservation and capsule are sequential, followed by another atomic journal read.
The durable outcome must agree across the reads; normal observation refreshes and
archival may change the original record representation. The returned original
record comes from the latest read and retains its required active/archive metadata
for the own-TXID matcher.

The binding digest uses a sorted-key serialization of account/hold/signing facts,
capsule and authorization digests, exact journal intent and stable outcome. It is
an equality aid, never an authority token. Two agreeing observations do not prove
uninterrupted journal stability or exclude writers. These private associations
remain within main-process wallet logic and must not enter public reports or UI.

Expected missing/incomplete/changed-data refusals return a value from the recovery
callback, preserving healthy reservation storage. The caller's lifetime is checked
again after the recovery callback and final store attestation settle. Cancellation
does not race away from that work. Existing recovery expiry still closes its
stores; reopening authenticates their retained contents.

## Store and comparison prerequisites

`capsules.readSigned(receipt)` requires a live recovery-origin receipt from the
owning reservation store, checks the complete capsule/hold and signing-digest
relations inside the capsule store, requires both signature and proved transaction,
then reattests before returning. Missing signature/proof is a non-destructive
`NOT_READY` refusal; invalid durable bindings still close the store. Callers must
not overlap this read with another reservation call. It does not cryptographically
validate a saved proof or grant fresh signing permission.

`projectRailgunOwnRecord` reuses the own-TXID matcher's active/archive metadata and
matched-resolution validation. It preserves transaction hash, nonce, intent,
included block/status and the full Railgun resolution while excluding volatile
observation/representation fields. Changed inclusion or retained Railgun resolution
fields change the projection; contradictory archived anchors still refuse. The
original record is still required by the matcher.

Claude approved both prerequisites and their expiry regression. Ninety-one tests
pass across the two prerequisite suites. Nineteen capture tests pass, including
coherently changed but independently valid inclusions, refresh/archival between
reads, reordered keys, missing/incomplete operations and cancellation during final
completion. Codex identified the missing direct drift control and approved the
added cases. Disabling only the projection comparison in memory makes the targeted
inclusion-drift regression fail. Lint is clean.

## Actual-store qualification

| Mode | Elapsed | Source hashes | Scenarios |
| --- | ---: | ---: | ---: |
| [Transfer](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-own-operation-transfer-2026-10-03.json) | 1,509 ms | 139 matched | 8 passed |
| [Unshield](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-own-operation-unshield-2026-10-03.json) | 1,512 ms | 139 matched | 8 passed |

The Electron runs create disposable vaults and real enrolled encrypted reservation,
capsule and submission stores. They use the production recovery-permit path to
resolve a synthetic transaction, then cover missing and unresolved journal refusal,
active capture, observation refresh, archival, exact enrollment/store reopen,
wrong selection followed by valid capture, and unresolved-sibling refusal.

Each run records six simulated receipt requests, eleven header requests, six head
requests and two transaction requests during resolution. Capture itself makes zero
RPC requests. External transport attempts and unexpected RPC methods are zero.
The clock is temporarily shifted for the synthetic resolution's archival age.
Reopen is in the same process, not a full application restart. The wide source
inventory binds versions; it is not an execution-coverage claim.

Chain observations, signature and proof fixtures are synthetic/structural. This
qualifies local authenticated storage and composition, not valid spend cryptography,
funded inclusion, trusted finality or new authority. Codex checked both reports,
all recorded hashes, fixture scope and redaction. No live query or transaction
occurred. The frozen tree passes 9,403 tests / 33 skipped across 441 suites in
309.694 seconds with native-process access and the existing OpenLV exclusion.

Next is phase-separated TXID acquisition and a new recovery window that rederives
and compares the account data before fresh source/root composition and ordered
post-transaction POI preparation. Owned-note disclosure remains separately pending.
No existing phase handoff was broadened; no dependency, renderer, IPC or top-level
architecture boundary changed.
