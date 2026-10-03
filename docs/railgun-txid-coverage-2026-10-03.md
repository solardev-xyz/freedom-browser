# Railgun TXID event coverage, 2026-10-03

The enrolled TXID mirror can now compare its rows with the retained public-log
ledger inside an exclusive public snapshot. This checks indexer-versus-RPC
consistency before later note-specific POI work. It does not establish global
TXID completeness, verified RPC data or spending permission.

The source ledger rechecks the complete authenticated prefix through the chosen
checkpoint. A bounded, backpressured feed delivers it to a guarded utility
process; closure waits for the producer to drain. The utility merges complete
Ethereum transactions from the ordered logs and TXID rows. It checks nullifiers,
input trees, output commitments and positions, and unshield recipient, token and
gross value. It rejects ambiguous call partitioning. Bound-parameter hashes and
unshield commitment hashes are not checked by these events.

The previously identified missing call is accepted only when its exact complete
event sequence matches the pinned exception in transaction
`0x4b78372a9f06a8ab7ccb8a02373d279fc385515139c6ef157d2fe79ee147e932`
at block 11,816,741. The following indexed call in that same Ethereum transaction
must still match. A changed or foreign omission cannot use this exception.

A discrepancy stops the checked prefix before the affected Ethereum transaction.
Both streams still drain and authenticate: a late source failure or changed TXID
transcript invalidates the run rather than leaving a usable partial result.
Coverage cannot write storage. The account composition checks the registered
compute receipt and fresh public snapshot, plus the exact journal state, source
identity and source digest. Results are diagnostics; they are not retained as
authority for a later operation.

The boundary is the earlier of the public checkpoint and last mirrored row's
block. `uncheckedBeyondBoundary` counts mirrored rows beyond that boundary.
`unindexedTail` records an event group later in the last mirrored row's block
after every mirrored row has been consumed, without assuming whether it is
service lag or an omission. An event group missing rows before the last mirrored
row remains a discrepancy.

The live harness's `independentEventCoverage` flag means every mirrored row up to
the boundary matches its own transaction's events and no event group before the
last mirrored row lacks rows, apart from the exact pinned exception. It does
not mean the service holds every transaction up to that boundary. The
`allMirroredRowsCovered` flag additionally requires zero rows beyond the boundary.
Both flags can be true with an unexplained `unindexedTail`; the whole coverage
object retains that field. Global completeness remains false in every case.

The [actual archived-data qualification](qualification/railgun-txid-coverage-2026-10-03.json)
passes with 4,214 checked rows across 4,103 Ethereum transactions in 5.66 seconds.
Its public capture ends at block 11,829,346, leaving 16 of the 4,230 mirrored rows
unchecked. It finds the one pinned omission, no discrepancy and no unindexed
tail. Removing the known nullifier event stops coverage at 4,188 rows with a
`missing-nullifiers` finding. Cold reopening preserves the result and entire
store digest. Late source failure, changed transcript and stale/forged compute
receipts are refused. This fixture uses real captured logs and rows but a
synthetic source-ledger identity: it does not qualify enrolled live coverage.

Native regression passes **8,101 tests, 33 skipped**, across 391 passing suites;
lint passes. Claude reviewed the matcher, snapshot/source lifetimes, guarded
runner, composition and reporting semantics. New code remains within main-owned
wallet infrastructure; no renderer capability or dependency was added. Source
feed extraction and authenticated snapshot traversal change the public cache
policy, so the next live qualification builds a new retained generation.

The fresh live scan targets finalized block 11,833,631. [Two public RPCs agree](qualification/railgun-sepolia-deployment-2026-10-03.json) on
the anchor, deployed code and verifying keys. A [separate read-only comparison](qualification/railgun-sepolia-governance-2026-10-03.json) of
blocks 11,829,347–11,833,631 found 50 ordinary protocol events and no governance
events. These supporting public-contract reads used direct HTTPS, not Tor.
The first new live run stopped with a coordinator refusal after retaining
block 4,799,999; continuation uses that pending generation. No live coverage
result is claimed here. Account POI, operation-bound witnesses/proofs, signing, recovery journals
and funded shield/transfer/unshield remain next. No Railgun funds moved.
