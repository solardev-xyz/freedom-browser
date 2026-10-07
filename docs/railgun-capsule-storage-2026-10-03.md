# Railgun account recovery storage — October 3, 2026

Recovery capsules now have a separate encrypted account store, opened lazily by
enrollment with its own derived key, storage subject and profile inventory entry.
It survives wallet cache replacement. The store accepts only its account's genuine
reservation instance, matching profile, principal, directory, wallet and binding.
No renderer interface or dependency is added; persistence remains in the existing
main-process wallet subsystem.

The bounded document retains up to 32 records, including unused attempts. Each
record is limited to 24 KiB, the document to 800 KiB, and the sequence to 96 (one
append, signature fill and transaction fill per record). Writes compare the whole
old state, preserve every other record, advance a separate account-manifest floor,
and authenticate read-back. Reopening can repair a floor left behind by an
interrupted update; replay below the floor refuses. Restoring both the manifest
and data from an old backup is outside this rollback guarantee.

Each immutable record binds the hold ID, exact reservation facts, capsule digest
and original authorization digest. Optional signature and proved transaction fields
can be filled once; identical retries are no-ops. A proved transaction must match
the saved intent except for its proof coordinates. That structural check grants
no cryptographic validity: the controller must independently verify the proof
before calling the store. Submission must independently verify the exact saved
transaction again and require a fresh main-owned proof receipt; a stored
transaction alone never grants proof or submission authority.

## Signing order

The enrolled reservation store refuses a direct signing transition. Its account's
capsule store issues a one-use permit only after checking the persisted capsule
and current held receipt. The signing evidence commits to both the capsule digest
and original authorization digest, so recovery can recompute that binding. The
controller must still establish fresh ownership, recipient, POI, private preflight,
operation lifetime and submission gates before this transition; the store itself
does not grant key release.

The required order is:

1. Complete all operation gates and remaining-time checks.
2. Persist and authenticate the capsule immediately before marking signing.
3. Mark signing through the capsule store; recheck the live operation before key release.
4. Persist B's signature before handing it to the preparer.
5. Independently verify and persist the proved transaction before the EOA journal and transport.

An unsigned retry with different authorization evidence needs a new hold after
explicitly abandoning the old unsigned hold. Its old capsule remains as history
and consumes capacity. Signing holds are never automatically abandoned or replaced.
Repeated interruptions can therefore exhaust the 32-record capacity; cleanup/export
is not implemented and exhaustion refuses new operations.

## Recovery and remaining work

Cold recovery enumerates signing records under the account's exclusive recovery
phase. Its receipts are revoked when the callback ends and distinguish recovery
from normal operation receipts. The callback receives an abort signal and monotonic
deadline (45 seconds by default, at most 175 seconds). Expiry revokes receipt use
immediately, while the phase remains held until the callback and its children
drain. These receipts are for recovery data access, never stand-alone spending
authority. Recovery must check fresh on-chain nullifier state and reconcile any
existing transaction before re-signing the exact original message. Expected network
refusals must return normally. Integrity failures and deadline expiry terminate
both storage sessions; reopening is required before retrying. A normal operation
receipt still needs a genuine live operation window and the full key-release gates.

The production private-operation controller, vault spending-key release, capsule
handoff from a real restored wallet, and funded transfer/unshield remain unfinished.
The existing guarded proof fixture qualifies exact-intent reconstruction separately;
this storage layer supplies the durable ordering needed to compose it safely.

## Qualification

[The actual Electron report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-capsule-storage-2026-10-03.json)
records 85 matching source hashes and 19 recovery runs over a disposable enrolled
vault and archived synthetic public history. The added capsule lifecycle persists
before the signing marker, preserves both across enrollment restart, binds the gates
digest and revokes the cold recovery receipt after its phase. That held intent is
structural fixture data and releases no spending key. Existing synthetic operation
windows separately prove transfer/unshield and pass independent verification.

Focused storage tests cover file-before-floor interruption for capsule, signature
and transaction writes; live replay and stale-file rollback; owner/receipt mismatch;
per-field intent binding; duplicate/concurrent writes; a hold abandoned during
persistence; phase deadline/drain; and 32 fully filled records reopening at sequence 96. No live POI query, live input reservation or funded private transaction occurred.

Final full regression: 8,799 passed / 33 skipped across 422 passing suites; lint
is clean. Claude reviewed the implementation, qualification and prose. This is
engineering review, not an external security audit.
