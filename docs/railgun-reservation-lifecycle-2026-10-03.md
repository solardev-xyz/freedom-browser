# Railgun reservation cancellation and recovery — October 3, 2026

The encrypted account reservation document now distinguishes `held`, `signing`,
`abandoned` and `legacy` entries. Only a held entry can transition, either to
signing or abandonment. Every entry remains in the document; abandonment frees
the input for a new entry while preserving the earlier intent and its outcome.
Signing and legacy entries cannot be abandoned or recovered by this API.

Before a future operation releases a spending key, it must durably mark the hold
as signing. That transition captures the submitter EOA, operation ID and digest
of the checked gates. It uses an exact compare-and-set, advances the separate
manifest floor, then authenticates read-back before issuing a fresh receipt.
The former held receipt becomes stale. A failed write or uncertain read-back
closes the store; a committed signing record stays in signing across restart.

This is a storage invariant, not a signing authorization API. The future
operation-owned key-release path must require a genuine current signing receipt,
matching operation and intent, fresh ownership/POI/recipient checks, and the
registered operation's lifetime. No spending-key API is introduced here.

## Cancellation and cold recovery

The operation holding the original receipt can abandon it before signing. Cold
recovery matches the reconstructible owned-note identity (tree, position,
nullifier and note hash) and abandons only an existing held entry. It does not
require the lost randomized intent or prior POI digest. Enrollment supplies an
exclusive `recovery` account-phase claim
through the complete read, write, floor update and read-back. An active wallet
or TXID owner prevents recovery, even after revocation until its workers drain
and it releases its claim. Recovery releases its own phase on success or failure.
It never manufactures a reusable held receipt for another operation.

The in-process operation must hold its wallet phase from reservation through
signing and key release, and drain its workers before abandonment. These are
caller obligations; the low-level reserve/transition methods do not themselves
claim a phase. Key release must accept only enrollment's own reservation store,
not merely any instance branded by the lower-level factory with supplied callbacks.

Version 1 entries migrate to `legacy`, preserving their facts without claiming
that a signing attempt occurred or granting cancellation rights. The storage
path, key purpose and manifest floor record retain their existing identifiers;
the document schema becomes version 2. Sequence counts appends plus transitions,
with an exact maximum of 1,024 for 512 retained entries. Abandoned entries still
consume the lifetime capacity. No deletion or pruning is implemented.
Inspection returns separate counts for held, signing, abandoned and legacy
entries, without disclosing individual records.

File-first/floor-second crash recovery remains: an authenticated file ahead of
the manifest repairs the floor; a file behind it refuses. Coordinated rollback
of the whole profile remains outside this guarantee. Entries contain linkable
nullifiers and operation/submitter metadata and stay encrypted and out of reports.

## Qualification and remaining work

The [enrolled synthetic qualification](qualification/railgun-reservation-lifecycle-2026-10-03.json)
passes nineteen cases with 72 matching source hashes. It opens an actual wallet
to prove recovery exclusion, drains it, abandons the earlier synthetic hold,
reserves the input again, records synthetic signing evidence and cold-reopens
enrollment. Signing remains locked, and prior receipts and duplicate reservation
refuse. No spending key is released. The first harness attempt stopped because
its wallet opener was out of scope; the corrected run passes.

Targeted checks cover concurrent transitions, stale receipts, legacy migration,
invalid state/evidence, both transition rollback cases, interrupted floor writes,
all 512 signing or abandoned entries at sequence 1,024, and actual enrollment
phase exclusion. Wallet/public/TXID cache policies are unchanged by this layer.
All 65 targeted checks and the final native regression pass (8,641 passed,
33 skipped); lint is clean. Claude reviewed the implementation, recovery-selector
correction and documentation.

Signing-state recovery remains deliberately unavailable. Its later design needs
exclusive cold ownership, the recorded submitter's transaction journal, an exact
intent association, and finalized unspent/spend/revert evidence appropriate to
the journal outcome. A leaked proved transaction could be relayed independently
with `adaptContract = 0`, so journal absence alone cannot prove that it will
never appear on-chain. Neither does a finalized unspent observation: accepted
V2 roots remain in root history, so the proof may still be relayed later. Any
future explicit release policy must account for that retained ability to execute
the originally reviewed output, and a competing spend must tolerate the input
having already been spent. Do not automatically release signing holds from a timeout.

This work stays in the main-process wallet persistence and phase modules. It
adds no renderer surface or top-level package responsibility. Operation-bound
key release, proof orchestration, private transaction journaling/reconciliation
and funded transfer/unshield remain open.
