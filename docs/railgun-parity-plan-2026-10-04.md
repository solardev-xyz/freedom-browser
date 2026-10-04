# Railgun parity and remaining integration work — October 4, 2026

This is the continuation plan after `ba507f73`. It compares Railgun with the
implemented PPv2 backend, rather than treating either protocol as a finished
wallet product. Historical qualification reports remain evidence for their
recorded sources; a later passing unit suite does not refresh their native runs.

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

## Next technical work

1. **Connect the Kohaku private-operation boundary.** The existing
   `railgun-kohaku-read` instance deliberately exposes only reads. Private
   controllers already implement proving and submission separately. Add a
   capability-selected main-owned instance/broadcaster that owns their actual
   lifecycle: replace the account after Transact staging, retain opaque one-use
   completions, and close/drain the wallet before entering submission recovery.
   Do not add preparation methods to an existing viewing-only instance.
2. **Qualify the connected spend lifecycle on current sources.** Existing
   controller, submission and completion reports predate subsequent source
   changes. The controlled Transact-input signing/proving-to-journal refresh
   below now passes; exercise it through the new Kohaku boundary next. Preserve acknowledged and
   uncertain results, journal-before-send ordering, restart recovery and refusal
   of duplicate operations. A mocked-controller test alone is insufficient.
3. **Add partial withdrawal with authenticated change.** PPv2 already has
   withdrawal/change recovery and second-spend evidence. Railgun's current
   one-output policy cannot express the equivalent partial withdrawal. Extending
   it requires coordinated proof shape, amount conservation, output decryption,
   reservation, receipt matching and post-transaction POI handling. Do not merely
   relax the commitment-count check. Received-input support is a prerequisite,
   not evidence that this larger flow is implemented. The `01x02` artifacts are
   already pinned in `railgun-artifacts.js`; the missing work is integration.
   The [bounded partial-unshield plan](railgun-partial-unshield-plan-2026-10-04.md)
   maps the complete change-recovery and second-spend path, including the
   additional creator shape and combined output/unshield POI requirements.
4. **Design a restricted return-to-origin recovery path.** The inspected engine
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
5. **Complete live private qualification.** Refresh the funded profile under
   current policies before spending, then qualify a private transfer, its output
   recovery/POI and a subsequent spend or unshield. Review external disclosures
   before the first query. A self-broadcast consumes public EOA gas and does not
   establish the privacy properties of PPv2's relayed withdrawal; a qualified
   Railgun broadcaster remains part of the intended integration, subject to
   availability on the supported network.

The order above starts with work that does not require funded-profile access.
Partial withdrawal and return-to-origin need their own bounded designs and
qualification; they are not claimed by the current milestone.

## Current-source spend lifecycle refresh

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

The first private instance should require an explicit selected note identifier,
exact asset and full amount; it must not invent coin selection. Preparation
review must precede input-specific POI disclosure and private signing. The later
Ethereum transaction review cannot retroactively authorize those earlier
actions. Denied review must perform no subsequent staging, query or proving.
The retained public source and later private-preflight/submission clients do not
currently share a single reviewed destination constraint. New clients select
their RPC from the registry. The connected boundary must enforce the reviewed
destination at every later acquisition/admission; listing a registry snapshot in
the review is insufficient. This is implementation work, not an established
privacy guarantee.
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
