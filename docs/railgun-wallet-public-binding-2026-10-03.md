# Railgun wallet/public generation binding — October 3, 2026

A public cache rebuild could strand an interrupted wallet candidate: its code
policy still matched, so `new` refused it, while its journal referenced the old
public stores, so `pending` could not finish it. Enrolled wallet policy now hashes
the base wallet policy together with the authenticated active public generation,
source ledger and public store identities. The main-owned public registry supplies
those identities only after account, policy, active-catalog and lifetime checks.
The returned identity is an immutable copy; callers cannot supply its values.

After cutover, both old active and pending wallet caches refuse before opening their
stores. A new wallet generation can scan the published public state while retaining
the old files. Reopening the same public generation preserves the effective policy.
Runner receipts, coverage, journal and wallet catalog all use this policy; the
base policy API remains available for low-level qualification. This belongs in
main's account composition; neither the engine nor renderer chooses generations.

[Actual Electron evidence](qualification/railgun-wallet-public-binding-2026-10-03.json)
adds a completed-but-unpublished wallet candidate before public cutover. Its old
journal and SQLite bytes remain unchanged, `active` and `pending` refuse, `new`
recovers the synthetic 2,700-unit balance at block 40, and cold reopen preserves the
new policy. The report retains the 16-case recovery series and viewing-key
cancellation. Validation: 39 focused tests, 7,943 full native regression tests
(33 skipped; OpenLV excluded), and lint pass. All source hashes match the implementation. Claude accepted the fix.

## First live transport baseline

[The live report](qualification/railgun-live-transport-2026-10-03.json) records
actual enrollment and managed Tor RPC acquisition in a separate, newly provisioned
disposable Railgun Sepolia profile. Two ranges, blocks 0–199,999, completed and
persisted. These precede deployment and contain no Railgun events: this qualifies
transport and the empty-range path, not complete history or funded operations.
One RPC provider supplied the evidence; it remains unverified. Authenticated SOCKS
was recorded, but circuit isolation remains unqualified. No signing or submission
occurred, and the funded PPv2 profile was not opened by these scripts.

The development provisioner creates only a new canonical directory, acquires its
profile lock, creates a vault, and protects a random credential with OS safeStorage.
It refuses existing directories and leaves partial failures retained for explicit
recovery. The scanner requires the Railgun disposable marker, refuses the PPv2
marker, checks that its selected anchor is canonical and at or below the finalized head, drains workers on closure,
and records source hashes plus sanitized status. It has no transaction capability.
This test profile has no portable backup; it is suitable only for disposable
Sepolia qualification. Product enrollment and backup remain separate work.

Next: complete live history acquisition, TXID/POI and relay qualification, then
operation-bound proofs/signing and journaled shield/transfer/unshield using the
authorized test funds. No Railgun funds have moved.
