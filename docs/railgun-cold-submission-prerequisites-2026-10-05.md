# Cold-submission prerequisites — October 5, 2026

This prerequisite checkpoint is now incorporated into the [qualified cold-submission
host](railgun-cold-submission-2026-10-05.md); the original evidence below remains
scoped to its recorded sources.

Two independently reviewed prerequisites for submitting a saved Railgun proof
are implemented. They do not yet expose a cold-submission entry point or turn
proof-recovery diagnostics into permission to send.

The encrypted submission journal now atomically rejects a second recorded
Railgun attempt for the same input tree/nullifier across active and archived
history. Resolution, a reverted transaction, changed outputs or a different EOA
transaction hash do not release this restriction. Duplicate-hash errors retain
their existing precedence. PPv2, Shield and ordinary transaction behavior is
unchanged. Records and schema versions remain readable without migration.

The guard runs inside the existing authenticated storage update, not a separate
read-then-write check. A refusal preserves encrypted bytes and returns a sanitized
`PRIVATE_RAILGUN_NULLIFIER_RESERVED` error. Its scope is this profile/public-account
journal and the existing fixed Sepolia Railgun deployment; it is not a global
cross-account registry or rollback defense. Any intentional retry after a prior
attempt requires a separately reviewed policy. The future host must also reject
known attempts early, before disclosure or signing, and retain the original
submitter binding. The atomic journal guard alone runs after EOA signing.

`readRailgunCompletedAccountPrivateInput` provides the second prerequisite: a
synchronous, detached read of the original selected input from a genuine
completed-only wallet. It reuses the recovery input binder, checks ownership and
unspent state as of the completed checkpoint, asset, amount and nullifier, and returns only the binding,
canonical owned record, public-through checkpoint and generation ID. All three
operation kinds and both creator types are covered. A newer current tree root is
allowed when the original selected input remains unchanged.

The accessor admits bounded plain capsule data and rejects proxies, accessors,
serialization hooks and substituted array prototypes before normalization. Claude
caught the array-prototype gap during review; its regression proves no hook runs
and a later legitimate read still works. The accessor opens no store, requests no
key or network access, and issues no window, receipt, freshness or spending
authority. Returned data remains historical after closure. The eventual host
must obtain its capsule through authenticated `readSigned` and rejoin this data
to a fresh source snapshot inside the final recovery phase.

## Validation

The [evidence index](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-cold-submission-prerequisites-2026-10-05.json)
records the exact four source/test hashes and root integration logs:

- Journal, PPv2 reservation, retention and submission consumers: **214 tests in
  five suites**, 20.386 seconds.
- Completed account, proof recovery, private operation, staging, provenance and
  Kohaku consumers: **591 tests in six suites**, 7.547 seconds.
- Full repository lint passes after both changes; scoped formatting is clean.

The two test sets are distinct: **805 tests across 11 suites**. Journal tests use
real encrypted storage and canonical decoders with explicitly seeded structural
histories. Account tests use the real registry/binders with controlled issuers;
they do not establish native cold-submission composition. Detached controls show
that removing the journal guard fails twelve resolved-history cases, and removing
the completed-mode, nullifier, lifetime or array-prototype checks fails each
targeted accessor regression. Independent Codex authors supplied those controls;
Claude reviewed both production changes and the final fix. This is engineering
review, not an external security audit.

No new native or full-regression claim is made. The six native partial-submission
runs at `0c792d23` remain evidence for their recorded source state. There are no
dependency, runtime, deployment pin, derived-cache policy, UI or IPC changes.
The changes extend existing main-process journal and account-reader ownership.

Next, the fixed cold-submission host must sequence completed wallet and TXID
reads, drain those phases, then acquire fresh source/POI/root/preflight authority
inside one final recovery phase. Its private shared submission core must preserve
the warm completion's existing lifetime, exact stored proof/signature, live
final-phase authority re-asserted through send without renewal, and durable
uncertainty handling. Three-process native qualification is still pending.
