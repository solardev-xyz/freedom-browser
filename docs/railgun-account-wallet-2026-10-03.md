# Enrolled Railgun wallet scans and recovery — October 3, 2026

A single main-owned entry now composes an enrolled wallet generation, authenticated
store, encrypted coverage, journal, engine scan receipt and Kohaku viewing API.
`openRailgunAccountWallet` returns a view only after completing or revalidating
the journal; a new generation is published only after readiness is established.
The view still reports unverified balances and grants no spending or POI authority.

## Modes and lifetime

- `active` cold-restores the active generation for the current policy. It requires
  a completed journal with no pending work.
- `advance` performs a full in-place rescan of the active generation. It persists
  pending work before starting the utility. An interrupted advance makes `active`
  refuse; another `advance` can reconcile the pending state. Reads are unavailable
  until that succeeds. This is not incremental scanning or a parallel readable
  old-generation snapshot.
- `pending` resumes an unpublished candidate. A completed candidate restores and
  publishes; unfinished work scans and completes before publication.
- `new` builds a new candidate. It refuses to abandon a same-policy pending
  candidate, which must be recovered with `pending`. An obsolete-policy candidate
  can be replaced because the current runtime cannot complete it. Its directory
  is retained, and the catalog's eight-generation limit still applies.

Store opening checks the active catalog ID before journal construction. Missing
initialized stores/journals remain guarded by inventory; only an unpublished
candidate can initialize a missing unregistered component. Expected publication
refusals, such as a still-open old generation, are checked before catalog writes
and leave the catalog usable for retry. The same checks run again during the
actual update to protect against races.

Closing a view drains both the storage worker and any still-finishing scan
utility. A coordinator, journal, coverage, enrollment or worker revocation
invalidates the combined lifetime and automatically closes journal/coverage/store
resources. This avoids leaving a worker slot occupied after source revocation.
There is no new renderer channel or user-facing product flow.

## Authority and cache compatibility

The account entry requires a registered live coordinator with the same profile,
account principal, protocol, deployment and chain. Clones, foreign accounts and
closed coordinators refuse. The lower-level journal still accepts trusted main
callbacks for controlled fixtures; its composed account entry enforces the
coordinator authority. Full enrollment binding to the source/public store keys is
part of the next public-layer composition, not established by this brand alone.

Main derives the wallet policy from the authenticated engine archive/inventory,
a versioned Sepolia domain and exact bytes of 15 scan, storage-format, validation
and read modules. This includes the host runner and job-input builder. A supplied
expected policy can only confirm that value, never override it. A dependency
closure test walks the job and host validation roots, with explicit infrastructure
boundaries for engine loading, identity/process machinery, journals and generic
privacy storage. This is a cache compatibility policy, not a hash of every
application dependency or a security attestation of the entire host.

Any edit to a pinned file, including whitespace, changes the policy and requires
a fresh generation/full rescan. Account enrollment itself remains stable. The
archive is currently verified separately by policy, runner and job setup; this
is conservative and has avoidable hashing cost to optimize after qualification.
The viewing job retains its fixture wallet-source label; a deliberate sending
label must be selected before transaction construction.

## Evidence and remaining work

[The actual Electron report](qualification/railgun-account-wallet-2026-10-03.json)
uses a disposable public vault and synthetic public history. Eight windows cover
receive/spent/self-transfer, cold restores and rebuild, with observed balances
3,000 → 2,000 → 2,700 fixture units. Closed views refuse subsequent reads.
Three additional cases cover interruption after journal completion but before
publication, an interrupted advance recovered through block 40, and replacement
of an obsolete-policy candidate while preserving its directory. Viewing-key
handoff cancellation is also retained in the harness. The composed API does not
expose receipts; the report records its explicit receipt-replay probe as null,
rather than claiming that older manual probe ran on this path. The field
`explicitlyCheckedRebuildDirectories` counts only the directory checked by the
explicit stage-30 rebuild probe; it is not the total number of retained generations.

The public source ledger, public store and coordinator in this qualification are
still fixture-managed; the derived wallet and its journal use enrolled keys and
the reusable composition. No live acquisition, POI-service request or transaction
is performed. These runs do not establish complete funded-account recovery.

The report is copied byte-for-byte from the successful run, with every recorded
source hash verified. Fifty-three focused tests pass across composition, policy,
catalog and coordinator authority; lint passes. The full native regression passes 7,864 tests with 33 skipped. The separate
[13-case lower-level wallet recovery baseline](qualification/railgun-account-wallet-baseline-2026-10-03.json) also passes. Earlier reports remain
historical evidence for their exact sources, including the coordinator/catalog
versions that predate this slice.

The catalog currently retains at most eight generations with no retirement path.
Repeated policy-changing upgrades or interrupted candidates can exhaust that
capacity. This is a release blocker: the next catalog task must provide reviewed
retirement of closed, superseded generations while preserving recovery and profile
inventory consistency. No files are deleted automatically.

Next: enrolled public source/ledger/coordinator composition with matched bindings
and store IDs, authenticated packed public planner/apply jobs, live acquisition
and governance advancement, TXID/POI/relay qualification and intent-bound funded
operations. No Railgun funds have moved.
