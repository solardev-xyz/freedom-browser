# Connected Railgun Kohaku private operations — October 4, 2026

The main-owned Railgun instance now connects the existing read, staging, proving
and submission controllers through a Kohaku-shaped private operation and
broadcaster. Five controlled native runs and the merged-tree regression pass.
This does not establish a live private transfer, unshield or production activation.

**Later October 4 compatibility checkpoint:** the
[public Shield milestone](railgun-kohaku-public-integration-2026-10-04.md) changes
the shared facade and qualifier. Its five fresh private compatibility runs are
the current evidence for those sources; the five reports below remain historical
for their recorded inventories. No private operation shape or live authority is
expanded by that public lane.

## Interface and ownership

`createRailgunKohakuPlugin` adopts a genuine enrolled account and its lifecycle.
Read mode exposes instance identity, balance and notes. Private mode additionally
exposes `prepareTransfer` and `prepareUnshield`. Requests explicitly identify one
owned note and its exact full WETH amount. The current transfer recipient is the
same private account; unshield goes to the enrolled public Ethereum submitter.
There is no implicit coin selection, partial withdrawal or arbitrary recipient
support in this milestone.

Preparation returns an opaque, frozen private-operation object. Only the genuine
instance's broadcaster can consume it, once. Copying its fields, serializing it,
using another instance or submitting it again cannot create authority. The
private completion receipt stays in a main-owned registry, and raw signed
transactions and signers are not exposed through this interface.

Kohaku's pinned plugin contract permits protocol-specific amount and operation
types. This integration follows the selected instance and private-broadcaster
shapes; it is not yet a portable `createPlugin(host, params)` package. Freedom's
enrollment, coordinator, account phases and proof receipts require an explicit
restricted host contract before extraction. Public Shield needs its own public
operation lane; the private broadcaster does not accept it. No renderer or IPC
activation is added here.

## Review and destination binding

A trusted preparation-review callback runs before note-specific POI disclosure,
Transact staging, private signing or proving. Its immutable summary identifies
the selected note, amount, recipient, account generations and checkpoint, plus
the retained source, protocol RPC, transaction RPC and POI/TXID destinations.
It also discloses that proved calldata is simulated at the transaction RPC before
the later final transaction review. These callbacks are integration contracts,
not a finished user interface or a blanket consent grant.

Both RPC roles use genuine [destination restrictions](private-rpc-destination-constraints-2026-10-04.md).
The preview clients remain alive through preparation and submission. Restrictions
reach both real private-preflight clients, the transaction network, and the
submission controller through the genuine completion registry. They are not
serialized into durable proof evidence. A caller cannot replace them at submit.
Later cold recovery is a separate operation with its own destination review.
Propagation through the real preflight modules is covered by focused tests;
the native fixture substitutes their chain authority as described below. POI and
TXID use fixed pinned origins, separate from these RPC restrictions. The retained
source uses its existing authenticated destination assertion.

Preparation has a monotonic 540-second budget; review callbacks have 30 seconds.
Completion retains its own 120-second lifetime. Destination restrictions extend
through that completion window. Timer delays do not extend the preparation
budget. Expiry may cancel an already admitted request, so durable uncertainty
must remain; expiry is never evidence permitting a resend.

## Account handoff, cancellation and recovery

Received Transact inputs use the real staging controller, which closes and
replaces the account while preserving the authenticated generation and selected
input baseline. Subsequent instance reads use the replacement account. Submission
closes and drains that wallet before entering the exclusive signing-recovery
phase. The actual private and Ethereum signing, proof verification, durable
capsule and attempted-before-send journal remain owned by their existing
controllers.

Cancellation revokes new work promptly. If a review callback ignores abort, the
caller can receive refusal or `recovery-required` while the original callback
remains tracked internally. During preparation review a genuine wallet handoff
reservation keeps the shared account phase exclusive even after wallet workers
close. It releases only after the callback and cleanup finish; successful review
releases it before staging needs its own handoff. During transaction review the
existing signing-recovery window provides exclusion until the callback settles.
Cleanup failure retains exclusion instead of reporting successful drainage.

This fixes a reproduced gap where only the instance's directory map remained
held after preparation cancellation, permitting another main-owned controller
to acquire the underlying account phase. Three direct-phase regressions failed
before the fix. The six higher-level suites now pass 230 tests, including eight
additional lifecycle cases; syntax and full lint pass. These focused tests use
mocked controller joins and do not alone prove the native composition.

Submitted and uncertain controller outcomes remain distinct. An unexpected thrown
error cannot manufacture a submission hash. A signed operation that has not
finished keeps its durable signing hold for recovery; closing the instance does
not clear it or authorize another spend.

## Native qualification scope

The opt-in wallet-journal fixture uses a new disposable profile and public test
vector. The matrix covers Shield-created and received Transact inputs,
each with transfer and full unshield, plus cancellation during a held transaction
review. The production facade, staging, proof, independent verifier, vault
signers, encrypted stores and submission journal execute. POI membership and
private chain preflight are explicitly simulated, and transport is intercepted.
The fixture confirms the genuine protocol restriction reaches each preflight
call and validates a fixture-built constrained client. The real preflight clients
and their chain checks do not execute natively. No physical Tor transport,
live eligibility, mined finality or funded private spend is established.

All five native processes exited successfully. Each report records the same 133
source hashes, rechecked against the final tree. Every run also executes the
qualifier's 19 existing enrolled scenarios. Component timings below are measured
locally alongside regression work, not total process time or Tor latency promises.

| Input and operation                   | Outcome                           | Facade time | Evidence                                                                             |
| ------------------------------------- | --------------------------------- | ----------: | ------------------------------------------------------------------------------------ |
| Shield input, self-transfer           | Lost acknowledgment retained      |    4,512 ms | [Report](qualification/railgun-kohaku-shield-transfer-lostack-2026-10-04.json)       |
| Shield input, full unshield           | Acknowledged                      |    4,246 ms | [Report](qualification/railgun-kohaku-shield-unshield-2026-10-04.json)               |
| Transact input, self-transfer         | Acknowledged                      |    8,096 ms | [Report](qualification/railgun-kohaku-transact-transfer-2026-10-04.json)             |
| Transact input, full unshield         | Lost acknowledgment retained      |    7,921 ms | [Report](qualification/railgun-kohaku-transact-unshield-lostack-2026-10-04.json)     |
| Shield input, held transaction review | Cancelled; private proof retained |    3,723 ms | [Report](qualification/railgun-kohaku-shield-transfer-review-cancel-2026-10-04.json) |

Each primary facade run releases one private spending key, makes one Ethereum
signature and one simulated raw send, and checks the exact attempted journal
entry before transport. Two preflight acquisitions validate the same genuine
protocol restriction. The transaction review observes exactly one estimate and
one simulation beforehand. Copied and repeated operations do no additional work.
Fresh-context journal reopening retains submitted/attempted state and blocks a
second send; the encrypted private proof and signing hold remain unchanged.
Both Transact cases use actual staging and replacement-account reads. All four
primary runs also cancel a separate held preparation review, drain its wallet,
prove that a direct recovery-phase claim is still refused, then reopen after the
callback settles.

The fifth run proves first and cancels while the transaction review is held.
The caller receives `recovery-required` promptly while competing signing recovery
remains refused. A late approval makes no EOA signing attempt and no send. The
EOA journal is empty, and later genuine signing recovery finds the unchanged
signed/proved private capsule. Transport, signer, POI-acquisition and preflight
wrapper-entry counters increment before fixture currency checks; their counts
do not change after cancellation or late approval. An isolated inert-signer
mutation control detects the former counter ordering that could hide attempted
calls. These observations do not prove absence of an internal send attempt
refused before transport entry; that limitation is explicit in the report.

The initial successful Shield-transfer run used an earlier fixture without the
new attempt counters. It is superseded by the final run above; no production fix
was needed to pass the native matrix. Recorded private jobs close without forced
escalation. Journal reopening is in the same process with a fresh context, not
an application restart. Lost acknowledgment is injected, not a mined outcome.

The [merged-tree regression](qualification/railgun-kohaku-regression-2026-10-04.json)
passes **13,496 tests / 33 skipped**, across **500 passing suites / five skipped**,
in **520.067 seconds**. All 1,487 recorded source/test/config files stayed unchanged
through that run. It uses native permissions, the existing OpenLV exclusion and
explicit `--forceExit`; natural application-handle drainage is not established.
The 191 lower-layer and 230 higher-layer focused tests and full lint also pass.
All 24 public/TXID and 30 wallet policy inputs remain unchanged from `ba507f73`.

In particular, the ten retained-input reports at `ba507f73` and the two spend
lifecycle refresh reports committed in `5effd124` predate changes to the shared
RPC, network and controller files. They are historical evidence, not final-tree
native coverage. The new Kohaku matrix replaces the spend-lifecycle
refresh through the connected facade. It does not rerun the entire retained POI
qualification. Legacy unrestricted paths retain focused and full-regression
coverage; the new last-admission currency check also applies to them.

## Reproduction and next work

Run `scripts/qualify-railgun-wallet-journal.js` under Electron with six arguments:
the disposable WETH public-vector JSON, a new absolute output directory, the
pinned engine archive, `enrolled`, the pinned prover archive and artifact directory.
The input SHA256 is `bfa8684f50b2bb838b026f2c4972653bfc4503d9fd15182c6c5b219ce1bc1e41`.
The engine and prover archives are verified against their existing manifests.
Never use a funded or existing profile for this fixture.

Set `FREEDOM_RAILGUN_KOHAKU` to `shield-transfer`, `shield-unshield`,
`transact-transfer` or `transact-unshield`. The first and fourth reports add
`FREEDOM_RAILGUN_KOHAKU_LOST_ACK=1`. For the fifth, use `shield-transfer` with
`FREEDOM_RAILGUN_KOHAKU_CANCEL_TRANSACTION_REVIEW=1`, without lost acknowledgment.
Other private-operation/staging mode variables must be absent. Each case requires
its own fresh directory.

Next is the [separate public Shield lane](railgun-kohaku-public-shield-plan-2026-10-04.md),
then [partial withdrawal with authenticated change](railgun-partial-unshield-plan-2026-10-04.md).
Live private qualification remains pending disclosure authorization and the
required funded-profile policy refresh. UI/UX and portable package extraction
remain separate, unfinished work.
