# Enrolled Railgun store initialization — October 3, 2026

`openRailgunAccountStore` now creates and reopens source, public and derived wallet
stores through a genuine current enrollment. Main owns their paths, keys and
workers. Inventory registration is performed by this reusable composition after
authenticating the initialized store, replacing the earlier qualifier-owned step.

New stores initialize in a randomly named encrypted staging file beside the final
file. The helper observes the initialized store ID, closes and waits for the
worker, checks the final path is absent, renames and fsyncs the directory, then
reopens the final file and requires the same authenticated ID. Only then does it
register the file and return the session. A single in-process owner is retained
through final worker exit; the existing three-worker limit remains.

Interrupted initializers are retained, with at most eight matching staging entries
before creation refuses for review. No file is automatically deleted. A crash
before publication can be retried with explicit creation. After publication but
before inventory registration, reopen with `create: false` authenticates and
registers the existing file; create refuses it. Existing initialized files are
never implicitly recreated. Symbolic links, hard links, noncanonical directories
and missing inventoried files refuse. SQLite transaction sidecars may remain
after interruption and are part of future backup/erasure policy.

Publication is serialized under the application's profile lock and target owner.
Node's portable rename does not provide a no-replace guarantee against a racing
external filesystem writer. This retains the existing trusted-local-OS model;
it is not a filesystem sandbox or whole-profile rollback protection.

Wallet stores must belong to the current active or pending generation. Active
generations cannot initialize a fresh store: their opened ID must equal the
catalog's stored ID. The generation entry must remain unchanged across opening.
This check precedes any later wallet-journal construction. A pending generation
has no stored ID; publication binds it to the validated wallet journal's store ID. Public/source IDs are
still bound by the scan journal before a coordinator is granted. Opening a store
alone gives no scan readiness, balance, POI, signing or spending authorization.

[The source-bound Electron report](qualification/railgun-account-store-2026-10-03.json)
uses a disposable public vault and the real engine identity. The helper initializes
all three encrypted stores, automatically registers them, closes workers, then
reopens after vault lock/unlock with matching IDs. The fresh run leaves no staging
files after successful publication. Borrowed keys are wiped and a removed
registered wallet store makes enrollment reopening and re-enrollment refuse
with `PRIVATE_PROFILE_STORE_MISSING`; unit coverage also checks the store
helper itself refuses missing inventoried files. The report is byte-identical to
the run, with every recorded source SHA-256 checked before copying. It performs
no wallet scan and no transaction.

Eight real-worker store tests cover creation/cold reopen, owner exclusion, active
ID mismatch, retained interrupted staging, staging limits, missing state,
symlink substitution and scope revocation. Sixty-two focused tests pass across
store composition, enrollment, inventory and worker lifetime; lint passes.
Earlier enrollment reports remain historical evidence for their recorded sources.

Next: compose the public coordinator and wallet journal with these openers,
restore or rebuild a generation into receipt-backed Kohaku reads, then advance
live source/governance coverage and qualify TXID/POI/relay and funded operations.
No Railgun funds have moved.

Claude reviewed the helper, source-bound report and recovery/trust limits.
This is engineering review, not a security audit.
