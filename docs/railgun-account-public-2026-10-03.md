# Enrolled Railgun public scanning — October 3, 2026

Later October 3 work closes the inventory, wallet-retirement and public-generation availability gaps described below; see [public generation recovery](railgun-public-generations-2026-10-03.md). The measurements here remain tied to their recorded source revisions.

Main now composes an enrolled source ledger, public store, policy-bound scan
journal and authenticated public planner/apply jobs. The wallet entry requires
this composition's live coordinator for the same account binding and public
policy before opening a wallet store. All source/public/wallet storage keys in
the composed qualification come from the disposable test vault's enrollment.
Balances remain unverified; no spending authority or new renderer API is added.

## Public runtime and policy

Public jobs load the pinned engine archive and explicitly require engine, ethers
and abstract-leveldown resolutions to remain inside it. ABI and proxy-event
decoding, and NFT token hashing, use the archive's ethers 6.14.3. The earlier
fixture used the application's ethers 6.17.0. Apply results record actual decoder
version and archive-relative module paths. The utility receives public log batches
and constrained storage dispatch only during apply, after the complete log input
has been delivered. RPC, store clearing,
keys and signing are not granted. Runtime refusal tests cover malformed inputs,
the governance ceiling, oversized batches/counts/bytes and inherited environment.

The public compatibility policy hashes the engine/inventory and 13 host/job
source files, including the coordinator, source, ledger, journal and account
composition. Dependency tests require local additions to be pinned or classified
at explicit infrastructure boundaries. The wallet policy includes this public
policy. These hashes are cache compatibility gates, not full host dependency or
OS security attestations. Repeated archive authentication remains a performance
cost to optimize after qualification.

The reviewed governance ceiling remains block 11,829,346. Later ProxyUpgrade,
ProxyOwnershipTransfer, ProxyPause, ProxyUnpause, OwnershipTransferred,
TreasuryChange, FeeChange, Initialized and VerifyingKeySet events stop scanning
until host requalification. Unknown event types also refuse. Later ordinary
Shield, Transact, Nullified and Unshield events can be projected subject to the
existing source and state checks. Live governance advancement is still required.

## Enrollment, recovery and lifetime

An explicit initial open may finish missing, unregistered components; existing
components are authenticated, never replaced. Creating a missing scan journal
requires an empty source ledger and an empty whole public store, including unknown
namespaces. Registered missing files remain an inventory error. Journal version 3
records the exact public policy and requires explicit create/reopen semantics.
Legacy version 2 remains only for lower-level fixtures; there is no silent upgrade
or policy-mismatch migration.

The composed coordinator brand records the account, source/public identities and
policy; the wallet checks account binding and policy, and the journal enforces
the store identities. Worker, enrollment,
scope or coordinator revocation closes the public lifetime. Shutdown drains both
jobs and in-flight openers, closes late-returning workers, and waits for worker
exit before releasing the account owner. Repeated old closes cannot release a new
owner. Public and viewing jobs wrap shared/frozen failures without mutating their
causes. One full account uses all three current storage-worker slots.

[The twelve-case enrolled Electron report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-account-public-2026-10-03.json)
covers eight scan/restore/rebuild windows and four recovery cases: interruption after the first acknowledged storage commit
in the stage-30 public apply, journal-complete-before-wallet-publication,
interrupted wallet advance, and obsolete wallet candidate replacement. The first
case is an injected broker error after a real commit, followed by utility error
exit and full cold reopen; it is not SIGKILL or exhaustive multi-phase crash
coverage. Viewing-key handoff cancellation also passes. Public fixture balances
remain 3,000 → 2,000 → 2,700 units.

The full native regression passes 7,904 tests with 33 skipped; 97 focused tests
and lint pass. Claude reviewed the implementation and interruption semantics.
[The full archived replay](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-packed-public-history-2026-10-03.json)
passes all 121 ranges and matches the earlier independently projected 14,822-log
history: 10,194 leaves, 5,614 nullifiers, 2,546 unshields, the exact tree root and
full cold-restored state. This confirms equivalent decoding with the archive
version. This run explicitly records `interruptionQualified: false`; it does not
repeat the earlier fixture’s multi-phase crash tests. This is controlled
archived RPC evidence, not live acquisition or receipt-proven log completeness.

## Required before funded Railgun testing or release

Public-policy changes currently refuse the enrolled version-3 journal, with no
public generation/rebuild path. Wallet catalogs also retain at most eight listed
generations without retirement. Both availability gaps must be solved before
funding a Railgun profile: an upgrade must not strand its recoverable state. The
inventory must also refuse before exceeding its shared 4,096-file limit; the
current unchecked registration could otherwise write an invalid inventory and
lock out all privacy stores. The next work is non-destructive retirement of
closed inactive wallet generations and fresh public generations rebuilt from
the retained source ledger. Files and
inventory entries remain protected; no automatic deletion is authorized.

Then continue live acquisition/governance advancement, TXID/POI/relay service
qualification, operation-bound proofs/signing, reservations and funded recoverable
shield/private-transfer/unshield. No Railgun funds have moved.
