# Railgun public generation recovery — October 3, 2026

**Follow-up:** [Wallet/public generation binding](railgun-wallet-public-binding-2026-10-03.md) now rejects both active and pending old wallet caches by effective policy before opening their stores. It also qualifies replacement of an interrupted wallet candidate across public cutover. The original evidence below remains tied to its recorded revision.

Railgun can now rebuild public scan state after a policy change without replacing
its previous ledger, cache or journal. Each public generation has its own source
ledger, public store and policy-bound journal under `railgun-public-<id>/`, with
separate vault-derived keys. The encrypted catalog records the active and pending
generations; previous directories remain protected by the profile inventory.

This deliberately reacquires history over RPC. Giving each journal its own ledger
prevents a fresh journal's source retention from truncating another generation's
history. Rebuilds cost network requests, disk space and time; offline replay and
shared source-cache optimization are later work. Main owns this composition because
it owns storage keys, canonical paths, account lifetimes and publication authority.
The engine and renderer cannot select generations or publish a cache.

## Publication and recovery

Before an active generation acquires logs, the host persists its highest canonical
target attempted. The request is bounded and its headers checked before this
write; the write precedes log acquisition and ledger staging. An interrupted scan
can leave this height above its last completed checkpoint. A target with unsupported
governance events can therefore prevent replacement until that history is
requalified. This height is unverified RPC evidence, not a chain proof or an
assertion that scanning completed. Unpublished candidate attempts do not raise it.

Publication requires a fresh genuine coordinator snapshot at or above that height,
the matching directory, account binding and policy, and a closed previous generation.
The pointer, public/source store identities and height change atomically. Checks
run before and during the write and again after it; uncertain committed failures
remain classified. Later opens enforce both stored identities. A failed catalog
write immediately revokes the public lifetime and drains the workers.

A pending candidate resumes across restart, including a journal completed before
catalog publication. Same-policy duplicate rebuilds return
`RAILGUN_PUBLIC_PENDING_REQUIRES_RESUME`; obsolete candidates remain retained while
a new one is built. Candidates cannot grant wallet reads. After cutover, the old
wallet checkpoint refuses the new public/source identities even if its policy is
unchanged: the caller opens a new wallet generation against the published state.
This is a trusted host operation; no automatic product UI has been added.

A legacy root-level version-3 journal is inspected through authenticated read-only
storage using its recorded policy. The initial catalog protects the higher of its
completed and pending heights. Legacy source/public/journal files remain unchanged;
new accounts initialize directly inside a generation directory. Root stores without
a journal, missing inventoried files, moved state and unsupported journal formats
refuse. An upgraded account has no readable public state until its first new public
generation is published.

## Bounds and evidence

The catalog retains at most 72 generation identities; only active/pending entries
carry full metadata, keeping the encoded catalog within 16 KiB. Capacity refusal
precedes mutation and leaves the active catalog usable. Every generation retains
its full source/public data, so disk usage can become the practical limit first.
Cleanup/export is not implemented; removal would require explicit user authorization.

[The actual Electron report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-public-generations-2026-10-03.json)
contains 16 recorded cases plus viewing-key cancellation. It covers the previous
scan/recovery and twelve-wallet-rebuild series, an interrupted public rebuild below
its protected height, cold candidate resume, completion-before-publication recovery,
old-wallet refusal followed by new-wallet recovery, public/wallet cold restoration,
and migration from a real legacy encrypted layout under a synthetic prior policy.
Legacy read-only inspection leaves the inventory marker unchanged; old root
source/public/journal and old generation files remain byte-for-byte unchanged after
rebuilding. Recovered synthetic balance remains 2,700 units at block 40.
All recorded source hashes match the tested implementation.

Validation: 164 focused tests pass, including active-directory ownership refusal
and immutable catalog inspection. Full native regression: 7,939 passed, 33 skipped
across 380 passing suites (the command excludes `openlv-protocol.test.js`). Final
Electron run `e` includes all implementation and qualifier fixes. Lint passes.
Claude reviewed the implementation and the expanded recovery cases.

The public data policy now pins 12 source modules. Account composition and catalog
are explicit infrastructure boundaries rather than data-format pins; edits there
alone need not trigger full history reacquisition. Coordinator/source changes in
this slice still change the public policy. Earlier enrolled/full-history reports
remain evidence for their recorded revisions, not this revision's entire history.

No live acquisition or Railgun transaction occurred in this qualification. Next are
live source/governance advancement, TXID/POI/relay service qualification,
operation-bound proofs/signing, durable reservations and funded recoverable
shield/private-transfer/unshield. Distribution and production activation remain
separate gates.
