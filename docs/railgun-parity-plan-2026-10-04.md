# Railgun parity and remaining integration work — October 4, 2026

This is the continuation plan after `ba507f73`. It compares Railgun with the
implemented PPv2 backend, rather than treating either protocol as a finished
wallet product. Historical qualification reports remain evidence for their
recorded sources; a later passing unit suite does not refresh their native runs.

## Latest checkpoint

The [submission-after-restart checkpoint](railgun-cold-submission-2026-10-05.md)
qualifies the fixed cold host across fourteen three-process cases, with fresh
final-phase eligibility, original proof/signature reuse, exact submitter binding
and atomic prior-attempt protection. Two default proof-recovery and six warm
partial-submission cases also pass. The frozen regression passes 15,457 tests
across 512 suites, retaining the documented exclusion/skips/forced-exit limits.
Services and transport remain synthetic; no funded profile was opened. The
[earlier prerequisites](railgun-cold-submission-prerequisites-2026-10-05.md) remain
part of this host. Next are durable combined POI, normal change ingestion,
restart/second spend, partial facade integration and live private qualification.
Real transport latency still needs measurement under the 50-second margin.
The [durable combined-POI plan](railgun-durable-combined-poi-plan-2026-10-05.md)
records the producer/consumer changes, lazy version-3 migration and connected
change/second-spend qualification required next.

The [partial submission and capture checkpoint](railgun-partial-submission-2026-10-05.md) connects the genuine 01x02 controller/completion to fresh submission checks, real vault EOA signing and durable attempted-before-send journals. Six controlled native cases cover both input creators and acknowledged, lost-reply and wrong-verifier outcomes; the four submitted cases reach strict resolution and active/archive/same-process reopened capture. All cases use simulated external services and share 528 source hashes; 2,163 affected tests pass and lint is clean. Partial facade, durable combined POI and change credit remain closed. The preceding [fresh-process proof recovery](railgun-proof-restart-2026-10-05.md) remains separately qualified; its diagnostics do not authorize submission. Its cold-submission successor is described above; durable combined POI, actual change ingestion, restart/second spend and live private qualification remain open.

## Established baseline

PPv2 has a funded native Sepolia journey through registration, deposits, a
finalized relayed withdrawal, restart/change recovery and exits. Controlled
native and allowlisted ERC-20 lifecycles cover additional recovery and proof
paths. User-facing activation, broader live coverage and production release
qualification remain open.

Railgun has an isolated pinned engine, supervised proving, encrypted account
storage, authenticated scan generations, balance/note reads and operation-bound
private signing. A funded Sepolia Shield and restart recovery have run. The
[retained-input integration](railgun-retained-transact-integration-2026-10-04.md)
qualifies both Shield-created and received Transact inputs across ten controlled
native runs. Those runs include real POI proofs and durable recovery, but their
spend transactions and external service observations have the explicit simulated
boundaries recorded there. They do not prove a live private transfer or unshield.

The supported private operation shape is presently one pinned-WETH input and
one self-transfer output, or a full-value unshield to the enrolled Ethereum
submitter. This is an integration restriction, not a statement about Railgun's
general capabilities. Balance reads continue to report unverified amounts;
reading a note never authorizes spending it.

The [connected Kohaku private instance](railgun-kohaku-private-integration-2026-10-04.md)
now owns account replacement, one-use completion and wallet drainage before
submission. Five native controlled runs cover both input types and operations,
two lost acknowledgments and held transaction-review cancellation. They pass
with the real controllers/provers/signers but simulated POI, preflight and RPC
authority. The merged regression passes 13,496 tests. The original read-only
instance remains read-only; no generic Host or user-facing activation is added.

The [public Shield milestone](railgun-kohaku-public-integration-2026-10-04.md)
adds three controlled public-flow runs and requalifies the five private cases
against the shared facade at that checkpoint (13,736 regression tests).
The [partial-unshield structural checkpoint](railgun-partial-structure-2026-10-04.md)
adds the bounded version-2 model while refusing partial admission. Six fresh
native runs preserve the existing private/public flows; the current frozen
regression at that checkpoint passes 13,872 tests. The later
[native partial proof and recovery](railgun-partial-crypto-2026-10-04.md)
qualifies 01x02 cryptography and stored-signature reconstruction with a synthetic
account/scan, and requalifies the six existing wallet flows. Its current frozen
regression passes 13,949 tests at `941099ff`. The subsequent
[receipt/TXID primitives](railgun-partial-receipt-2026-10-04.md) bind versioned
public outcomes, both token transfers and ordered change/unshield commitments,
with real engine hashing/path qualification over synthetic evidence. Main
partial admission remains closed; earlier counts belong to their recorded sources.
The [creator-authentication checkpoint](railgun-partial-creator-authentication-2026-10-05.md)
now verifies the final unshield preimage for generic received-note provenance
and bounded retained change recovery. Its self-change fixture reaches genuine
local POI proving and encrypted recovery with simulated chain/services; it does
not establish combined partial POI or the complete second-spend lifecycle.
The subsequent [combined local POI checkpoint](railgun-combined-poi-2026-10-05.md)
qualifies one actual proof for change plus withdrawal, both input creator types
and exact application marker binding. The subsequent
[protected internal controller](railgun-partial-controller-2026-10-05.md) qualifies
a genuine Shield-input hold/sign/prove/verify and encrypted account reopen, with
real POI/preflight hosts over simulated services. That controller checkpoint did not yet qualify submission or combined POI
persistence. Submission is now qualified above; combined persistence remains
open and the facade stays full-only.

## Next technical work

1. **Public Shield lane — implemented with controlled native qualification.**
   The [public instance and separate submitter](railgun-kohaku-public-integration-2026-10-04.md)
   issue genuine one-use public tokens, review simulation disclosure before keys
   or RPC admission, and retain reviewed destination restrictions. Acknowledged,
   lost-response and held-review cancellation cases pass with genuine hosts,
   preflight, vault signer and journals, but synthetic RPC. The private broadcaster
   refuses Shield. Live public-facade qualification and cold resolution/note
   ingestion through this facade remain distinct from these tests.
2. **Add partial withdrawal with authenticated change.** PPv2 already has
   withdrawal/change recovery and second-spend evidence. Railgun's facade
   remains limited to full-note spends; its internal partial controller is now
   connected and natively qualified for Shield input. The new structural
   records express partial withdrawal, and native utility qualification now covers
   proof shape, amount conservation, change decryption and cold reconstruction.
   Receipt/TXID primitives, creator authentication and standalone combined POI
   are implemented and qualified independently.
   Both Shield and received-input connected controller qualification now pass.
   Partial submission and authenticated capture now pass six controlled native
   cases across both input creators. Completing it still requires live deployed
   verifier checks, connected change recovery,
   normal change ingestion and durable post-transaction POI.
   Signed-but-unfinished proof resumption now has a production recovery host and
   six warm native cases plus twelve genuine fresh-process cases, including
   explicitly advanced trees. The fixed recovered-proof submission host now has fourteen three-process
   native cases; it remains an internal entry point with synthetic service evidence. Do not merely
   relax the commitment-count check. Received-input support is a prerequisite,
   not evidence that this larger flow is implemented. The `01x02` artifacts are
   already pinned in `railgun-artifacts.js`; the missing work is integration.
   The [bounded partial-unshield plan](railgun-partial-unshield-plan-2026-10-04.md)
   maps the complete change-recovery and second-spend path, including the
   additional creator shape and combined output/unshield POI requirements.
3. **Design a restricted return-to-origin recovery path.** The inspected engine
   and wallet SDK implement origin selection as client policy. The inspected
   contract's `validateTransaction` checks the ordinary unshield proof and
   recipient commitment, without an origin or POI field/check. This source
   finding is not verification of the deployed implementation. Do not adopt the
   SDK's first-token-transfer/fallback origin heuristic. A Freedom implementation
   should admit only an unspent Shield note matched to its own authenticated,
   finalized Shield submission, with recorded sender and unshield recipient both
   equal to the enrolled EOA. It must exclude third-party shields, preserve all
   reservation/proof/preflight/submission gates, and explicitly disclose the
   resulting public linkage. It would still query the selected nullifier and
   simulate the unshield at the RPC; it does not avoid disclosure review. This
   follows partial withdrawal in priority. No POI bypass is enabled.
4. **Complete live private qualification.** Refresh the funded profile under
   current policies before spending, then qualify a private transfer, its output
   recovery/POI and a subsequent spend or unshield. Review external disclosures
   before the first query. A self-broadcast consumes public EOA gas and does not
   establish the privacy properties of PPv2's relayed withdrawal; a qualified
   Railgun broadcaster remains part of the intended integration, subject to
   availability on the supported network.

The order above starts with work that does not require funded-profile access.
Partial withdrawal and return-to-origin need their own bounded designs and
qualification; they are not claimed by the current milestone.

## Historical spend lifecycle refresh at `ba507f73`

The two reports below were current when committed in `5effd124`. The later
destination-restriction and Kohaku-controller changes alter their source
inventories, so they are now historical. The connected Kohaku native matrix
qualifies the new controller composition separately; it does not refresh the
entire retained POI native matrix from `ba507f73`.

Two unchanged enrolled native fixtures pass against the 130-file source
inventories recorded in the [transfer report](qualification/railgun-spend-lifecycle-transact-transfer-2026-10-04.json)
and [uncertain unshield report](qualification/railgun-spend-lifecycle-transact-unshield-uncertain-2026-10-04.json).
Each runs 19 enrolled scenarios, with genuine Transact staging, vault private
signing, proving, independent verification, encrypted proof/capsule persistence,
wallet closure, single-claim completion, the submission controller and vault EOA
signing. Each makes exactly one simulated raw send; the exact attempted journal
record is checked before transport. Completion reuse performs no acquisition or
signing. The unshield run loses its acknowledgment, preserves the uncertain hash
and attempted record, and refuses another transaction after journal reopen.

Staging/controller component durations are 6,875/3,530 ms for transfer and
6,589/3,198 ms for unshield. Both native processes exited successfully. Their
entire recorded inventories were rechecked after both runs; no fixture repair or
production change was required. Full regression was not repeated for this
evidence/documentation refresh.

The fixture uses disposable public vault vectors and intercepted services. POI,
chain preflight and RPC observations remain simulated; creator bound-parameter
checking and global TXID completeness remain false. Journal reopen uses a fresh
context in the same process, not an application restart. These runs do not cover
mined resolution/finality, physical transport drainage, a separate Shield-input
submission refresh, or the complete post-transaction POI-to-second-spend chain.
They add no live eligibility, acceptance or spendability claim.

Reproduce with `scripts/qualify-railgun-wallet-journal.js`, passing the synthetic
WETH source, a new disposable output directory, pinned engine archive,
`enrolled`, pinned prover archive and artifact directory. Both runs set
`FREEDOM_RAILGUN_TRANSACT_STAGING=1` and
`FREEDOM_RAILGUN_PRIVATE_SUBMISSION=1`. Set
`FREEDOM_RAILGUN_TRANSACT_CONTROLLER=railgun-private-transfer` for transfer;
use `railgun-token-unshield` with `FREEDOM_RAILGUN_SIMULATE_LOST_ACK=1` for the
uncertain unshield. The input hash is
`bfa8684f50b2bb838b026f2c4972653bfc4503d9fd15182c6c5b219ce1bc1e41`.

## Kohaku contract and ownership

The inspected local Kohaku checkout, `tmp/privacy-build/pinned-inputs/kohaku`, is
`6fdc248b3d28942d9aaa35c49c1ac76dab89dc0e`. Its plugin types select preparation
methods through capabilities and permit protocol-specific opaque public/private
operations. Its separate broadcaster interface accepts a private operation and a
specialized result. This is a pinned local source check, not a claim about the
latest upstream revision.

The private instance requires an explicit selected note identifier,
exact asset and full amount; it does not invent coin selection. Preparation
review precedes input-specific POI disclosure and private signing. The later
Ethereum transaction review cannot retroactively authorize those earlier
actions. Denied review performs no subsequent staging, query or proving.
The retained public source keeps its authenticated destination assertion. New
private-preflight and submission clients now carry genuine protocol/transaction
restrictions from the reviewed previews, enforced at construction and admission.
The pair remains private to the genuine completion registry. POI/TXID origins are
pinned separately, and later cold recovery requires a fresh destination review.
This establishes endpoint restriction under the stated controlled qualification;
it does not establish authenticated chain state or physical Tor isolation.
Cancellation must revoke new admissions while already admitted work and
callbacks drain. Expiry, a copied operation or a restart cannot mint another
completion, discard a signing hold or permit an automatic retry.

Kohaku's generic Host object does not authenticate Freedom's enrollment,
coordinator, account phases or proof receipts. Matching the selected instance and
broadcaster shapes is not yet a portable `createPlugin(host, params)` package.
Extraction still needs an explicit restricted host contract. Native Shield uses
a public-operation lane and must not be passed to the private broadcaster.

## Live permission and shared product gates

The funded owned-note lookup at `ppoi.fdi.network` remains pending explicit user
permission after automatic approval review rejected its disclosure: the selector
can associate the query with the public deposit, including through Tor. The
current continuation uses disposable controlled fixtures and does not treat
general autonomy or another goal continuation as that specific permission.
Output-note queries, proof-specific service-root checks, live nullifier preflight
and transaction simulation also require their appropriate disclosure review;
permission for the owned-note lookup alone would not establish approval of every
later operation. Return-to-origin still has the RPC disclosures above.

Both protocols still need product UX/IPC integration, production transport and
OS egress qualification, supported-platform packaging, broader live outage and
performance tests, and release/deployment review. These shared gates should not
obscure the concrete Railgun gaps above or be mistaken for completed work.
