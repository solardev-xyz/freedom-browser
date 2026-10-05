# Durable combined POI integration — October 5, 2026

The internal Railgun host now generates, retains, recovers, validates and submits
a combined proof for a partial withdrawal and its private change. Both Shield
and received-Transact input cases pass native qualification with actual
cryptography and simulated external services. This does not yet qualify normal
change ingestion, a second spend, live service acceptance or partial withdrawals
through the Kohaku facade. It builds on
[submission after restart](railgun-cold-submission-2026-10-05.md); its own account
reopening is within one process, not a new-process restart.

The integrated producer, retained store, output recovery, cold validation and
fixed sender now admit one combined proof for a partial withdrawal and its
private change. They derive the operation shape from the authenticated capsule;
shape alone grants no ownership or permission. The actual own TXID, ordered
change/unshield commitments, input and withdrawal amounts, creator, source,
root, index and account remain independently bound by the existing hosts.
Partial output recovery uses one viewing credential and reconstructs the actual
self-owned change before comparing it with saved blinded output data. Full
withdrawal recovery stays keyless. Disclosure explains that the combined proof
links blinded change to the public withdrawal recipient and amount at the
aggregator. Sending still records a single attempt before one POST; a response
does not establish acceptance or make change spendable.

## Retained proof history and older builds

The first successful combined-proof prepare upgrades this account's retained
POI document to version 3 inside the ordinary prepare write. It consumes one
normal sequence transition; there is no separate migration write. New legacy
stores remain version 1, and legacy attempts retain their existing version-2
transition. Once a store reaches version 3, every later write keeps version 3,
including an attempt for a legacy transfer or full withdrawal.

**Older builds refuse the entire version-3 retained-POI store**, including its
earlier prepared and attempted legacy records and their recovery paths. The
upgrade does not migrate unrelated wallet stores. A user-facing changelog entry
must accompany eventual partial-POI activation; this internal qualification
does not activate that user flow. Planned changelog text for that activation:
“Saving recovery data for a partial Railgun withdrawal makes all retained proof
history unreadable by older builds.” Existing canonical legacy
records, envelopes, request IDs and payload hashes are preserved. No record
stripping, empty-store fallback or downgrade writer is provided. Use a current
build to continue recovering that history.

Version 3 adds no rollback protection. Encrypted data rename and manifest-floor
advancement remain separate writes. Before a failed floor advance is repaired,
restoring older ciphertext can still replay prepared state; after repair the
old ciphertext refuses. A successful current-reader reopen may rotate lease
and floor housekeeping; that is distinct from preserving canonical entries.

## Connecting the second spend

The next full withdrawal spends the actual scanned change with a version-1
capsule and the existing 01x01 circuit. Its creator is independently the first
partial withdrawal: a TXID row with ordered change and unshield commitments.
Source review indicates the ordinary and recovered submission hosts already
require genuine Transact staging, provenance and verification of that creator's
final unshield hash, without a wider admission rule. This partial-creator path
has not yet been exercised natively; that is part of the second-spend stage.

Qualification must append the actual first transaction's events and TXID row,
advance public and TXID scans, and then scan the ordinary wallet. A prior
Transact creator stays in the transcript; resetting to a singleton fabricated
row would not qualify this connection. The original input must be spent, and
the recovered change must match the first capsule's commitment and input minus
withdrawal amount. Existing single-row and one-selection service fixtures need
bounded extensions for this history.

A disposable list service has been reviewed separately at unit-test level. It must bind the exact
POST to genuine registered proof history and the actual scanned change, verify
the submitted combined proof, and independently recompute the TXID path,
unshield hash and change commitment/blinding before issuing a simulated signed
membership. The controller must obtain new typed membership through the normal
query path. A successful POST response cannot unlock change. This one-leaf list
simulation will not establish real service acceptance or realistic list state.

The reviewed list helper now takes a genuine registered proof instead of
caller-supplied historical facts. It obtains its exact payload, input-list root,
TXID state and witness from that history, and compares the entire submitted
payload. The normal-scan composition will additionally join the prepared store's
capsule and binding digests before closing the wallet. The simulator's lifetime
must outlive intentional account reopen; detached history grants no renewed
wallet authority.

## Qualification

The [qualification index](qualification/railgun-combined-poi-integration-2026-10-05.json)
links the unchanged raw reports, source inventories, runtime pins, command
templates and local diagnostic hashes.

The integrated focused suites pass **2,326 tests across 16 suites** in 226.533
seconds; full lint is clean. Independent scratch guard-removal controls accompany
each component. Cross-module review found and corrected a packaging issue: the
exact old-reader fixture is excluded from app files without changing its pinned
bytes. A test using the actual Electron Builder file matcher verifies exclusion
of the obsolete reader and tests while retaining the current store/helper.

Dependent-caller and policy/facade suites also pass **1,031 tests across 23
suites** in 20.740 seconds, including the packaging matcher test. Together with
the focused run, that is 3,357 distinct tests across 39 suites. The native pair and eight compatibility cases also pass, as detailed below. The
older partial-submission qualifier now checks only its intended submission/capture
scope and missing POI prerequisites; it no longer expects an obsolete early
partial-membership refusal. No previous native report is relabeled as current. The
[reviewed plan](railgun-durable-combined-poi-plan-2026-10-05.md) defines the required
producer/consumer joins, migration limits and connected second-spend evidence.

The list helper's additional **49 tests across two suites** pass in the root
worktree (5.941 seconds), with clean full lint. They mock native cryptography
and account/proof registries, so native verification and the second spend remain
pending. First-stage native bringup caught fixture serialization, call-shape and creator
checkpoint mismatches; the existing complete TXID-state and admission checks
remain in place. Failed disposable runs are retained separately and are not
completion evidence.

The final native pair is **Shield-f and Transact-b**, with 851 identical current
source hashes. The runs took 90,587 and 90,480 ms, respectively. Each connects the
genuine partial controller, proof, vault signing and submission journal to a
strict synthetic receipt, the actual first transaction's protocol logs and TXID
row, original-input membership, combined POI proving, version-3 preparation,
recovery, cold validation and one fixed proof POST. Received-Transact history
retains its genuine creator checkpoint before appending the new transaction.

Both runs cover seventeen stages. Copied proof authority, wrong output, wrong
route and denied reviews refuse. Identical preparation preserves bytes. The
pinned previous reader refuses both prepared and attempted version-3 stores
without floor writes or file changes. A held POST excludes concurrent attempted
recovery. The saved original capsule, private signature and spending hold remain
unchanged; output recovery reconstructs change instead of receiving saved
blinded outputs as an answer.

Shield-f observes 289 utility children and 25 workers; Transact-b observes 332
children and 28 workers. Every worker exits successfully. Each case has exactly
two expected wrong-output utility revocations (exit 15, neither escalated nor
peer-disconnected); all other utility exits are observed as closed. There are
no fixture assertion violations, and all three storage-observer key copies are
wiped. This establishes closure for these measured runs, not unrestricted
operating-system egress tracing.

The compatibility runner completes eight separate Electron invocations: six
warm partial-submission cases across both input creators and acknowledged,
lost-response and wrong-verifier outcomes, plus two default proof-recovery
cases. All exit successfully. Its 1,392-file source inventory is identical
before and after. Existing legacy native reports remain historical evidence.

The first full regression attempt exited unsuccessfully under the restricted
sandbox: local listeners returned EPERM, Electron probes failed to produce a
result, and native Radicle/Colibri tests could not complete. Its 1,392-file
inventory was unchanged. That diagnostic log and result are retained separately.
The authorized rerun outside the sandbox passes **15,731 tests across 517
suites**, with 33 tests and five suites skipped, in 719.744 seconds. Its exact
1,392-file source inventory is unchanged before and after. The existing OpenLV
suite exclusion and forced Jest exit remain explicit limits; this run does not
prove natural test-runner handle drainage.

The evidence remains deliberately bounded: chain, finality, original-input list
membership and transport are simulated; the one POST does not establish service
acceptance. No normal change scan, change eligibility, second spend, new-process
restart, mixed legacy native migration, live submission or partial Kohaku facade
is claimed. The reviewed disposable-list helper is unit-qualified only and is
not used by this native pair.

## Review and reproducibility

Claude reviewed the production changes, fixtures and native evidence.
Independent Codex agents authored and reviewed components and distinguishing
controls. This is engineering review, not an external security audit.

The temporary compatibility launcher is not committed. Its recorded SHA-256 is
`c516c358dd8178c52e716b4bd99b8e0e7636659e05512ff94b5fcee24c6e6a9d`;
the qualification index records the individual committed qualifier commands,
report hashes and launcher results. Inventory sizes differ by qualifier scope:
851 files for each combined native run, 544 for warm partial submission, 548 for
default proof recovery and 1,392 for the repository-wide source snapshot. They
were independently checked against the same source tree.

Bringup diagnostics are preserved but excluded from the final native pair:
Shield-a/b exposed canonical TXID row serialization order and its transcript
hash, Shield-c exposed the fixture's Shield/Transact API call-shape difference,
Shield-d exposed its graph-ID index mismatch, and Transact-a exposed the missing
creator-prefix root response. Shield-e passed an earlier diagnostic run but was
superseded after the prefix repair and stricter exact utility-exit checks.
These repairs were in fixtures; production admission checks stayed in place.
