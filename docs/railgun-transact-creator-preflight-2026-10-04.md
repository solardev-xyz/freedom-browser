# Railgun Transact creator preflight — October 4, 2026

The new fixed `preflightRailgunOwnTransactPoiMembership` route joins a spent
received Transact note's creating event and TXID path to the wallet's resolved own
operation. This is a prerequisite for receiver-only selector derivation and genuine
membership/proof preparation. It does not yet acquire membership, release a viewing
credential, prepare an intent or extend the Shield-only output recovery routes.

## Contract and order

The host strictly captures the enrolled own operation and checks its receipt, then
completes one authenticated source visit containing both the selected creator's
complete proxy event group and our own operation. It opens one checkpoint-only TXID
session, restores the own witness and earlier creator witness against the same
state, inspects again and closes the session. Separate keyless utilities verify the
own path and creator path/events. A final accepted-root check and strict recapture
precede the final source, destination, generation and owner checks.

The selected creator is deliberately limited to one Nullified event and one
single-input/single-output Transact event, without Unshield. Its graph transaction
index, transaction/block hashes, log positions, output offset, note hash and common
checkpoint are bound; its TXID index must precede our own. Unknown events, trailing
extras, selected group reappearance and overlarge groups refuse after authenticated
prefix drain. Unrelated group overflow is local to that group. The canonical encoded
Transact event is limited to 4,096 bytes: `576 + pad32(annotation) + pad32(memo)`.
Boundary tests accept exactly 4,096 and refuse 4,128; this is a narrower supported
shape than the whole reconstruction input limit, not a general foreign-note claim.

`creatorProvenance` contains internal comparison facts. Bound-parameter checking,
global TXID completeness, disclosure and spending flags remain false. Ordinary
output/history/sender APIs retain their previous order, traffic and option shapes.
The new route accepts no caller-supplied creator, destination, observation or mode.

## Time, source and traffic bounds

The invocation has a nonrenewing maximum/default 300-second allowance. The fixed
source scope has at most 235 seconds; its cold snapshot has at most 180 seconds and
must leave 55 seconds. After source return, the common tail is at most 55 seconds.
The source's actual canonical timestamp remains authoritative with a strict
60-second age limit; return and cleanup never renew it. Existing source/RPC policy
inputs are unchanged.

Mirror, own verifier, creator verifier, root and recapture caps are respectively
20/10/10/10/10 seconds, constrained by the shared tail and later-stage reserves.
Those caps are not a promise they all fit. Timers stop admission while admitted
source feeds, phases and utility work still drain. Simulated native timing below
does not qualify usable Tor latency or bounded cancellation completion.

A successful capture uses four current-TXID latest/validate pairs: opening the
mirror, restoring the own witness, restoring the creator witness and checking the
final root. There is no second mirror open, TXID page, advance, repair, extra creator
receipt or creator transaction request. Completed source reads do no staging,
retention, before-acquire hook or apply maintenance.

## Qualification and limits

Independent focused tests pass: **283 tests in five suites, 14.056 seconds**; lint
passes. Three temporary guard-removal controls produce four expected failures
against four passing controls: creator-before-own index ordering, refusal of later
verifier admission at source expiry, and the fixed source route for both operation
kinds. The expiry control detects an unwanted verifier call, not accepted stale
authority. Deadline equality, per-stage expiry, late open/close and borrowed-work
drain are unit controls with mocked heavy boundaries.

The full combined regression passes **12,621 tests / 33 skipped, 488 passing suites
/ five skipped, 458.512 seconds**, with native-process permissions and the existing
OpenLV exclusion. The command uses Jest `--forceExit`; it establishes a completed
test process, not natural closure of every application handle.

Four native combinations cover self/foreign creator and own transfer/full unshield.
Each report has 159 matching source hashes and eight healthy captures:

| Operation / sender | Elapsed ms | Report                                                                            |
| ------------------ | ---------: | --------------------------------------------------------------------------------- |
| Transfer / self    |     40,359 | [Native](qualification/railgun-transact-creator-transfer-self-2026-10-04.json)    |
| Transfer / foreign |     44,151 | [Native](qualification/railgun-transact-creator-transfer-foreign-2026-10-04.json) |
| Unshield / self    |     43,551 | [Native](qualification/railgun-transact-creator-unshield-self-2026-10-04.json)    |
| Unshield / foreign |     43,669 | [Native](qualification/railgun-transact-creator-unshield-foreign-2026-10-04.json) |

Recorded source-return-to-completion times across healthy and refusal invocations
range from 121 to 1,553 ms. These are intercepted-fixture measurements.

Each uses genuine encrypted vault/enrollment/capsule/hold/journal/source stores,
real private-RPC destination/read-budget identities, actual current-format input
encryption, one shared two-row TXID projection and guarded keyless workers.
“Foreign” is another account index of the same public fixture mnemonic, not an
independently random seed. Setup derives fixture viewing material; every measured
new preflight has zero key handoffs. The spend signature/proof is structural only.
Chain, service, registry, Tor endpoint and transport are simulated and intercepted;
there is no owned-note query, real Tor connection or live service acceptance.

Each run asserts eleven scenario groups: missing/unresolved journal, active and
archived witness, cold enrollment/mirror reopen, wrong selector, corrupted creator
and own utility paths, initial and final root refusal, and unresolved sibling.
Following healthy captures prove recovery after each injected refusal. Actual
corrupted workers start, emit no result and close. Host-only provenance mismatch
and all real-age expiry schedules are covered by unit tests, not represented as
native cryptographic attacks.

Every healthy native capture asserts ordered completed source/open/own-verifier/
creator-verifier/recapture timing entries and a tail below 55 seconds. Its exact
transaction-RPC delta is one chain handshake, transaction and receipt; two height
reads; eleven headers for an active record or twelve when archived. Protocol RPC
uses four five-header canonical passes plus three event-block headers (23), one
log request and a fresh chain handshake only after enrollment reopen. Both roles'
complete method deltas are compared. Initial/final root refusals also assert their
reached RPC and service counts. These are fixture-specific wire counts, not a
universal packet, connection, Tor circuit or minimum recovery-cost bound.

The existing Shield base membership [transfer](qualification/railgun-transact-creator-shield-transfer-2026-10-04.json) / [unshield](qualification/railgun-transact-creator-shield-unshield-2026-10-04.json) pair passes 17 membership plus seven recovery
scenarios with 209 matching hashes each (44,825/44,109 ms). The legacy attempted-output
[transfer](qualification/railgun-transact-creator-attempt-transfer-2026-10-04.json) / [unshield](qualification/railgun-transact-creator-attempt-unshield-2026-10-04.json) pair passes in 125,778/120,606 ms with 209 hashes each, retaining exactly 34 block
headers, one receipt/transaction/log request, two height reads and three latest /
three validate requests per attempted-output invocation. Transfer retains one
viewing release; unshield retains none. Prepared-entry refusal performs zero work.
The existing enrolled Transact [staging fixture](qualification/railgun-transact-creator-staging-2026-10-04.json) also passes 19 scenarios with 130 matching hashes, including two controlled refusals and two synthetic operation proofs. Its spending keys are synthetic fixture keys, not vault spending keys.
These compatibility reports retain their own fixture/signature-trust limitations.

Bring-up runs are excluded: initial missing inventory and unsorted expected-key
fixtures, the oversized setup range, run f's incorrect three-pair expectation,
run g's final inventory drift while tests were edited, and final-a's accidental
unshield metadata in the creator fixture row. The final-b runs predate the tighter
RPC/timing assertions and are superseded. Only final-c supplies the new preflight
evidence. Production stayed frozen throughout these native fixture corrections.
Initial legacy attempt launches with relative artifact paths failed before profile
creation; only the corrected absolute-path -b pair is included. An initial staging
launch used an obsolete source fixture; only the corrected final-b run is included.

## Architecture and remaining work

This stays inside the existing main-process wallet/source/verifier responsibilities;
no package boundary, renderer, IPC, dependency or engine/prover pin changes. All 24 public/TXID policy inputs were rehashed unchanged: public `d454092c`,
TXID `03a45fd1`. Wallet policy inputs also match HEAD unchanged. Main `6b5c2ea7` and the explicit
pinned node refresh remain current. Earlier reports with changed source hashes are
historical; they are not represented as qualification of this tree.

Next is the dedicated receiver-only viewing selector, genuine typed membership,
actual proof and intent preparation, followed by Transact output recovery. The
source/root lifetime needed during membership construction is a separate reviewed
contract; this detached preflight cannot impersonate a current receipt later.
Membership must never resolve an earlier uncertain POST or consume its remaining
recovery reserves. No funded profile was opened. Live selector disclosure, exact
service acceptance, second spend, production consent/UI and platform coverage
remain open. Independent engineering review is not a security audit.

Claude reviewed implementation and evidence; Codex supplied production, independent tests and native qualification.
