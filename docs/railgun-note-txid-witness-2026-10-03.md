# Note-to-TXID membership — October 3, 2026

The guarded TXID worker can now locate the creating Railgun transaction for a
public Transact commitment and return its Merkle witness. The enrolled account
exposes diagnostic `witnessNote` and `witness` methods for received outputs and
known Railgun transaction IDs respectively. The latter supports future
post-transaction POI recovery for our own sent transactions.

The note selector contains only type, creating Ethereum transaction hash, block,
commitment hash, tree and position. The lookup checks at most 8,000 authenticated
rows, recomputes each row's digest and cryptographic transaction identity, and
requires exactly one matching output. An unshield's final commitment is excluded
from the inserted UTXO range. Missing, ambiguous or corrupt records refuse the
whole lookup. The selected row must reproduce the checkpoint's Merkle root,
index and transcript through the existing witness verifier. Caller mutation
after invocation cannot change the selected note.

Main independently normalizes every returned witness: exact schemas, row SHA,
index, path length, field encodings, root, transcript, checkpoint and continuity,
plus the selected note/output or requested TXID relationship. It returns a separate
deeply frozen copy. Poseidon hashes, path verification and uniqueness are checked
inside the guarded job; main does not recompute those cryptographic relations.

These are immutable diagnostic values, not spend capabilities. The result does
not assert ownership, event coverage or fresh service-root acceptance. The
account revalidates its journal and authenticates the worker receipt before
returning the value; the receipt itself never leaves this phase. A later spending
operation must independently join a genuine owned-note selection, checked public
events, a freshly accepted service root and a reverified path under its own
lifetime. Ethereum transaction/block metadata is not bound by the TXID Merkle
leaf alone. The known omitted call still has no usable witness, and global TXID
completeness remains false.

TXID and wallet storage phases share the existing worker budget. A plain witness
may survive phase closure as data; its old runner receipt cannot survive as
authority. A future operation must bind the reverified witness to its immutable
intent and preserve the public checkpoint and coverage relationship across that
switch. This composition is still open.

## Qualification

[Guarded Electron projection](qualification/railgun-note-witness-projection-2026-10-03.json)
reconstructs the archived 4,230-row service tree and matches four sampled public
note selectors to existing independently checked paths. A changed note hash
and corrupted root refuse. Three ordinary lookups take about 3.5 seconds each; the first reported
6.9-second interval also includes the negative lookup. Guard violations are zero.

[Encrypted worker qualification](qualification/railgun-note-witness-storage-2026-10-03.json)
reconstructs the same tree, exercises cold reopen and journal-free page replay,
then obtains a note witness through the actual brokered read-only job in 4.421
seconds. Closing the worker revokes its receipt. This uses archived public data
and a fixture encryption key; it does not open an enrolled account, contact a
service, or exercise spending. The account wrapper is unit-tested. Ninety-two
focused tests pass, covering malformed selectors, ambiguous matches, unshield
exclusion, corruption, mutation, stale receipts and denied worker capabilities. The full native regression passes
8,388 tests (33 skipped), and lint passes. Claude reviewed the helper, worker
integration, normalizers, qualification evidence and documentation.

The new helper is part of the TXID cache policy dependency closure. Existing
mirror files remain retained; a fresh mirror is required under the new policy.
The public-history and wallet-derived-cache policies are unchanged. Earlier
qualification reports retain their original source hashes and are historical
evidence, not current-source scan authorization. A subsequent [live policy
refresh](qualification/railgun-witness-policy-refresh-2026-10-03.json) completed the
new retained 4,230-row mirror, event coverage and wallet restore at block
11,834,513, recovering one asset. It makes no owned-note POI requests and does
not call the new account witness methods; those wrappers remain unit-tested.

## Remaining private-operation work

A Shield note has no creating Railgun TXID. Its first spend needs genuine owned
recovery, current unspent/reservation checks, required-list membership and
operation-bound transaction and pre-transaction POI proofs. The engine uses a
dummy transaction-tree path for pre-transaction POI. That does not replace the
real transaction-tree witness required after inclusion.

Every transfer or unshield still needs post-transaction POI handling for protocol
completion, even a full-value unshield with no private change outputs. The
unshield identifier is derived from its Railgun TXID. Contract execution and
POI completion are distinct outcomes; the V2 contract does not enforce POI.
Sent transaction inclusion, fresh root acceptance, proof generation/submission,
service status and cold recovery remain required before declaring the full flow
qualified. Private outputs must become list-valid before dependent spending.
