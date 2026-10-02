# Railgun account enrollment — October 3, 2026

The main wallet layer now durably enrolls a vault-derived Railgun account and
opens its encrypted generation catalog. The stable account slot authenticates
the same identity after vault lock/unlock. A missing initialized file, changed
seed, changed descriptor or moved profile requires recovery rather than being
interpreted as an empty account.

This is development infrastructure. It adds no renderer channel or product UI,
performs no live scan or transaction, and grants no spending permission. The
funded Sepolia profile is not opened by the qualification.

## Enrollment and recovery

`openRailgunAccountEnrollment({ identity, create })` requires a genuine current
identity from the vault-bound engine path. First enrollment requires explicit
`create: true` and an unused stable account slot. It writes an authenticated
pending manifest before creating its account directory and catalog, then marks
the manifest active. Reopening uses `create: false` (the default), including to
resume an interrupted pending enrollment. Calling create again is not recovery.

Pending reopening can initialize its missing directory/catalog, or authenticate
an already-written catalog. An active enrollment never recreates a missing
catalog. Profile inventory also refuses any previously remembered missing file,
even during pending recovery. Encrypted temporary JSON files remain on disk;
nothing is automatically deleted. This state machine currently initializes the
manifest and catalog only. Staged initial SQLite creation and composition of the
public coordinator, active derived generation and wallet journal remain next.

The manifest binds the account schema, protocol, Sepolia chain/deployment and
vault-derived public descriptor. Runtime and scan policy are intentionally not
account compatibility gates: those belong to catalog generations. A policy
change can require a new validated generation without changing account identity.
The existing catalog retains at most eight generations, including abandoned
candidates; publication still requires current journal readiness and old-worker
exit. This slice does not loosen those conditions.

## Keys and storage inventory

The manifest filename hashes the profile/account scope and stays independent of
seed, runtime and scan policy. Its key derives from the vault seed. Importing a
different seed into the same profile therefore fails authentication of the old
slot; it does not silently enroll a replacement. Reset, erasure, backup and key
rotation policy remain tracked separately in #124.

A versioned HMAC root separates profile, account index, chain and deployment.
Further labels separate account manifest, catalog, source ledger, public store,
scan journal, wallet store and wallet journal. Wallet keys also bind the catalog
generation ID. Coverage pages use the wallet store's encryption. Keys are
deterministic; rotation requires a reviewed schema/generation transition.

The root remains in main memory for the open enrollment's lifetime and is wiped
on close, identity revocation or vault lock. Temporary seed/manifest/catalog keys
are wiped after use. Main-only key callbacks lend purpose-specific buffers,
wiping them on completion, exceptions and lock. Trusted host callers must not
retain copies; workers must explicitly own and wipe any necessary copies. This
is not a claim of complete erasure of all transient memory or an OS sandbox.

The existing authenticated profile inventory now accepts a constrained Railgun
layout: the top-level encrypted manifest, account-level JSON and source/public
SQLite files, and generation-level wallet SQLite/JSON files. Arbitrary nesting,
other filenames and path traversal are not accepted. In this slice the qualification script registers SQLite files only after
authenticating their initialized stores; reusable host registration is next. The qualification records
five files: manifest, catalog and three stores. A complete wallet composition
will also register its scan/wallet journals when they are durably written.

Directories must be canonical real directories; manifest/catalog files must be
regular files without symbolic or hard links. Current inventory is local
missing-file/move detection, not protection against restoring an entire older
profile and its marker. SQLite transaction sidecars and retained encrypted
staging files are not inventory records; deletion/backup policy must account for
them. No automatic deletion is introduced here.

Public history remains per account for the first controlled Sepolia composition.
This preserves current account-scoped source and evidence semantics, at the cost
of repeated downloads/storage. A shared profile/chain scanner is a later reviewed
optimization, including its scheduling and traffic-correlation implications.

## Evidence

[The source-bound Electron report](qualification/railgun-enrollment-2026-10-03.json)
uses a fresh disposable vault with an explicitly public mnemonic. It derives the
real engine identity, enrolls it, creates actual encrypted source/public/wallet
paged stores, observes worker closure, locks/unlocks the vault, re-derives the
identity and reopens all three stores with the same store IDs and deterministic
keys. All borrowed buffers are wiped. Removing a registered wallet file from its
expected path by preserving it under a different name makes both open and create
refuse; no missing file is recreated. This is empty-store lifecycle evidence,
not scan coverage or proof of funded recovery.

The report is copied byte-for-byte from the successful run; every recorded source
SHA-256 was checked against the working files before copying. Forty-eight focused
tests pass across enrollment, inventory, catalog and encrypted storage. They
exercise pending-directory/activation crashes, changed seed/descriptor, duplicate
and concurrent initialization, lock-time wiping, moved/missing state, symlink
substitution and exact inventory path constraints. Lint passes.

The final native regression passes 7,835 tests / 33 skipped across 372 passing
suites. Claude reviewed the code, crash ordering, key lifetimes and source-bound
Electron evidence, with no remaining finding for this slice. Engineering review
is not a security audit. Prior identity commit `2dba1f0d` passed CI; no CI result
is claimed here for the later enrollment commit.
