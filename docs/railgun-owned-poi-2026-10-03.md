# Owned-note POI composition — October 3, 2026

The guarded wallet scan now derives an internal POI projection from each accepted
owned note. The projection stays in memory behind the authenticated scan receipt;
it is not exposed by Kohaku balance/notes or written to operational reports.
This adds a main-owned account composition around the previously qualified
[service reader and membership verifier](railgun-poi-read-2026-10-03.md).

## Ownership and lifetime

Inside the existing validated-record loop, the helper recomputes the commitment
from the recovered note public key, token hash and value. It matches the public
leaf and, for shields, its public note key. The engine's Poseidon helper computes
the blinded commitment from that hash, note key and global tree position, then
checks the SDK's cached value. Type, position, creating Ethereum transaction and
block come from the public leaf already checked by the wallet scan. Main enforces
a bounded, exact correspondence with normalized received notes, field encodings,
unique blinded commitments and a block within the captured checkpoint. The
guarded job remains the source of type/block facts; this is not independent
consensus verification.

A private registration accepts only the genuine opened account wallet and the
same identity, enrollment and public coordinator. Every use rechecks the wallet
phase, lifetime, public generation and journal/scan receipt. Forged copies,
closed wallets and changed snapshots cannot retain ownership authority.

The POI operation selects one to three explicit, positive, unspent notes at that
snapshot. Notes before Sepolia POI launch block 5,944,700 are refused for this
path. The account operation ID binds the enrollment, public checkpoint and
selected internal records. Only selected blinded commitments and their types
reach the POI service; the rest of the wallet is not queried.

Valid statuses trigger signed-event/root checks and isolated local membership
verification. Missing, ShieldBlocked and ProofSubmitted remain observations
without membership. Unrecognized statuses fail schema validation. Every result
is bound to the original source and wallet lifetime; later acquisition, expiry,
wallet closure or snapshot changes revoke it. No serialized boolean can recreate
that authority.

Even a valid result explicitly leaves TXID provenance, reservations and spending
permission false. Unspent means unspent in this RPC-derived snapshot, not proof
of the latest canonical state. A future spending operation must check fresh
public evidence, unresolved input reservations, applicable creating-TXID
witnesses and operation-bound transaction/POI proofs. The current result alone
cannot authorize a spend.

The POI node sees queried blinded commitments and their grouping. Querying this
first Shield can correlate the request with its public deposit. Tor does not
provide PIR. Private note keys, blinded commitments, proofs and events are
excluded from the live qualification report; only aggregate status/verification
flags, public anchors and the already public shield hash are recorded.

## Qualification

[The real public vector](qualification/railgun-owned-poi-vector-2026-10-03.json)
uses the integrity-checked engine fixture whose inventory matches the packed
runtime. It reproduces the blinded commitment in the existing signed list event
from an archived public Shield, and rejects changed note key, position and
cached blinding. This script runs in Node, not guarded Electron. The transaction,
block and log provenance are metadata from the two-RPC capture; the script checks
the commitment relation, not that capture again. Signature verification is covered
by the existing POI fixture tests.

[Sixteen enrolled Electron recovery cases](qualification/railgun-owned-wallet-recovery-2026-10-03.json)
exercise the new projection through real guarded scans, cold restores and retained
wallet-generation rebuilds. Synthetic balances progress through 3,000, 2,000 and
2,700 units; the rebuild preserves the final amount. Cancellation and closed-read
refusals remain intact. These cases use a public viewing vector and simulated
public history, with zero submissions; they do not qualify live owned-note POI.
The account registration and POI operation are covered by unit tests only;
their first Electron run is the pending live owned-note qualification.

All 8,341 native regression tests pass (33 skipped), and lint passes. The first
regression run found the dependency-closure test's expected count still at 15;
the new pinned helper makes 16. Updating that expectation preserves the test's
per-dependency policy checks. Claude reviewed the projection, lifetime composition
and public-vector qualifier.

The wallet cache policy changes, requiring a retained new wallet generation;
the public-history policy is unchanged. The first funded Shield is now
finalized and explicitly reconciled. Its subsequent public and wallet
scan recovers one asset; see [the funded results](railgun-funded-qualification-2026-10-03.md).
The live owned-note POI qualification remains the next check. The live harness pins
the completed scan report, rechecks its current source hashes and exact public
generation/anchor/store state, then matches the recovered note to the finalized
shield journal. `passed` denotes a completed read pipeline; `poi.allValid` requires
Valid statuses, accepted roots and verified membership. Neither grants spending.
