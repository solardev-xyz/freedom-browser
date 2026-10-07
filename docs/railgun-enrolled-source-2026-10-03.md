# Enrolled Railgun source ledger — October 3, 2026

The enrolled source store now opens as a source ledger, with its domain-specific
binding and required metadata. Initialization completes in the temporary encrypted
file before publication. Final-file authentication and metadata validation precede
inventory registration. A crash after publication but before registration can be
recovered by reopening; missing or invalid metadata refuses without replacing the
file. Interrupted staging files remain retained.

The storage worker has a main-owned identity record binding its exact object to
the profile, account subject, filename and store binding. The ledger rejects
clones, foreign accounts/profiles, mismatched paths/bindings and closed workers.
Authority or dispatch-claim refusal leaves a supplied worker with its existing
owner. A successful exclusive dispatch claim transfers lifetime ownership to the
ledger. Subsequent direct dispatch refuses and revokes the session; a second
claim refuses without disturbing the current ledger. Ledger closure drains the
worker before the account store releases its file owner.

`openRailgunAccountStore` returns the source ledger alongside the session and
identity. Callers must use the ledger for source access. Public/wallet stores
retain their previous binding and do not acquire a source ledger. All of this is
main-process wallet persistence; no renderer or generic RPC capability is added.

[The actual Electron report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-enrolled-source-2026-10-03.json)
uses a disposable public vault, the authenticated engine archive and real encrypted
workers. Source, public and wallet IDs survive vault lock/reopen. A synthetic
empty-log range survives source-ledger reopening and repeats with the same
reference. No chain acquisition, wallet scan, POI or transaction is performed.
The report is copied without modification and all recorded source hashes match.
Forty-four focused native tests pass; lint passes. Full native regression passes
7,871 tests with 33 skipped. Claude reviewed the implementation, tests and report;
the staging-metadata claim follows from the required authenticated final reopen,
not an independent inspection of the temporary file.

The earlier [generic store qualification](railgun-account-stores-2026-10-03.md)
is historical for its exact sources. Source files produced by that version use
the account binding and lack ledger metadata: this version refuses them. Those
were disposable development fixtures; there is no automatic migration, deletion
or recreation. The funded PPv2 profile remains untouched.

Next: authenticated packed public planner/apply jobs, enrolled source/coordinator
and scan journal with pinned policy and source/public store identities. Creating a
missing unregistered scan journal must require both stores to be logically empty.
The three-worker limit supports one full Railgun account at a time (source,
public state, wallet); a live wallet view retains its worker until closed.
