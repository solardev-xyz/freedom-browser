# Railgun wallet generation retirement — October 3, 2026

Closed inactive wallet generations can now leave the eight-entry working catalog
without removing their directories, encrypted files or profile inventory entries.
A rebuild automatically performs this retirement only when all eight working
slots are occupied. Active and pending generations remain protected. Expected
capacity or busy refusals happen before catalog mutation and leave it usable.

The authenticated version-2 catalog preserves version-1 active/pending pointers
and generation identities on upgrade. It records up to 64 retired identities,
with oldest eligible generations retired first when only some slots remain.
Together with eight listed generations this permits roughly 70 successive
generations, not unlimited rebuilds. Once retirement capacity is exhausted,
further rebuilds refuse until an explicit cleanup/export mechanism is provided.
Disk use grows with retained generations; cleanup/export is not implemented and
this change deletes no files. Older builds refuse the version-2 catalog.

Retirement checks the profile inventory, canonical directory, wallet journal,
storage workers and logical account-store ownership both before and inside the
catalog update. Shared ownership spans staging-worker exit, publication and
final-worker reopen, closing the gap where no worker temporarily owns the file.
An old release cannot relinquish a newer owner. Busy workers have a distinct
`RAILGUN_SESSION_DIRECTORY_BUSY` error. Catalog changes invalidate older pending
candidate tokens; an explicit resume issues a fresh token.

These checks belong to the main-process wallet persistence layer because main
owns paths, keys and process lifetimes; no renderer or protocol SDK authority is
introduced.

[The Electron report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-wallet-retirement-2026-10-03.json)
contains the earlier twelve scan/recovery cases plus a twelve-rebuild series and
viewing-key cancellation. The series finishes with 14 retired and 3 listed
generations, retains every retired directory and validates the profile inventory.
Each rebuilt view still observes 2,700 synthetic units at block 40. Source hashes
were checked against the final report. No live acquisition or Railgun transaction
was performed.

Validation: 70 focused tests pass, including version-1 upgrade, worker-opening and
logical-owner races, partial retirement at 63/64, pre-mutation capacity refusal,
and a candidate recorded before directory creation. Full native regression:
7,914 passed, 33 skipped; OpenLV is isolated from that command. The full regression
preceded only the final busy-error classification change, which the final focused
suite and Electron run include. Lint passes.

Next: public generation rebuild with protected source-ledger retention, then live
source/governance advancement, TXID/POI/relay qualification and recoverable funded
shield/private-transfer/unshield. The shared inventory overflow bug is separately
fixed in [the inventory report](privacy-inventory-capacity-2026-10-03.md).
