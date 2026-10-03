# Privacy inventory capacity refusal — October 3, 2026

Inventory registration now refuses a new file with
`PRIVATE_PROFILE_INVENTORY_FULL` before crossing the existing 4,096-file limit.
Previously, registration could write a 4,097-entry inventory that every later
read rejected, locking out all privacy stores in that profile. This small shared
persistence fix is needed before Railgun generation retirement increases the
number of retained files.

The inventory stays byte-for-byte unchanged after refusal. Existing registered
stores remain usable; the rejected file remains on disk and is not adopted,
replaced or deleted. Capacity is shared across privacy protocols. This is not a
cleanup/export feature or permission to remove retained recovery files.

A first write at capacity can already have committed its encrypted file before
registration refuses. It reports `storageCommitted: true`; later reads and writes
of that unregistered store also refuse until capacity is recovered, preserving
the ciphertext. The test covers this edge without overwriting or deleting it.

A native filesystem test builds an authenticated 4,096-file fixture around a
real encrypted PPv2 record. It verifies refusal and an unchanged marker, then
reads and updates the PPv2 record and reads it again through a fresh scope.
It also verifies that a first write leaves retained, unregistered ciphertext and
that subsequent reads/writes refuse. All 38 related inventory/storage/enrollment
tests pass, and lint passes.

Closed-generation retirement and public generation rebuilds remain the next
Railgun availability work; there are still no funded Railgun operations.
