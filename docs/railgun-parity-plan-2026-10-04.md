# Railgun parity and remaining integration work — October 4, 2026

This is the continuation plan after `ba507f73`. It compares Railgun with the
implemented PPv2 backend, rather than treating either protocol as a finished
wallet product. Historical qualification reports remain evidence for their
recorded sources; a later passing unit suite does not refresh their native runs.

## Latest checkpoint

The [public proof-to-wire composition](qualification/railgun-relay-proof-wire-2026-10-06/OVERVIEW.md) now passes one native four-utility run at `41472ed4`: synthetic quote admission precedes proving, actual fee/pre-transaction POI data travels through selected upstream COMMON encryption, and a separate verifier checks reconstructed decrypted input. Exact public proof/calldata and quote bytes are retained. Root checks pass 276 tests in eight suites and strict lint; no full regression or live relay qualification follows. The standalone public cryptographic reverifier remains pending.

The [handoff model](railgun-relay-handoff-model-2026-10-06.md) at `49cf9e5e` separately passes 30 unit tests and eleven detached distinguishing mutants. Its fake ports model a single uncertain attempt and original-promise drainage. Genuine fee/operation authority, an authenticated durable attempt journal, confined transport and specifically authorized live qualification remain to be implemented or qualified.

A separate [mathematical key-admission candidate](railgun-relay-key-admission-2026-10-06.md)
passes 17 offline checks, including a genuine key outside the earlier fixture
registry, torsion/mixed-torsion refusals, separate signature R/S checks and actual
shared-key exchange. Its hardened R policy deliberately rejects one mathematically
valid zero-nonce signature. This is a qualified experimental predicate, not
operator trust or integration into production relay admission. Its [checked-in replay](qualification/railgun-relay-keys-recipe-2026-10-06/OVERVIEW.md)
now independently reproduces all seventeen cases at `6bc9456e`, with exact
source/runtime bindings, 133 affected tests and strict lint.

The [offline wire checkpoint](railgun-relay-wire-2026-10-06.md) now passes 39
checks against selected pinned upstream functions: original-byte signatures,
encrypted COMMON messages, expiry, context snapshots and per-operation replies.
It uses public synthetic identities and dummy calldata. Arbitrary broadcaster-key
admission, real fee/proof-to-wire composition, durable relay authority and live
transport remain open. Both signature libraries accepted the adversarial
low-order key diagnostics; the fixture refuses those keys through its pinned
genuine-key registry. The [checked-in reproduction recipe](qualification/railgun-relay-wire-recipe-2026-10-06/OVERVIEW.md)
now passes a fresh 39-case replay at `258bbee2`, with 114 focused tests and
strict lint. Source/tool pins and independent review bind that separate run;
the admitted builder currently targets darwin-arm64.

The [controlled fee/pre-transaction proof checkpoint](railgun-relay-proof-2026-10-06.md)
now passes at `0cc74e6c`: a synthetic 1000-unit input produces fee 100 first and
self 900 second, with independent transaction/pre-POI verification for minimum
gas 0 and 1 and thirteen altered-signal refusals per case. This is a cryptographic
prerequisite using fixed public keys; production policy remains closed to this
shape. The archive records results and provenance but does not retain proofs or
calldata for third-party cryptographic reverification. Failed entrypoint attempt
a remains separately recorded. The [relay integration plan](railgun-relay-integration-plan-2026-10-06.md)
records the pinned upstream contracts and remaining implementation sequence.

[Authenticated history and the fixed recovery companion](railgun-recovery-companion-2026-10-06.md)
now pass one fresh four-process Shield chain at `cf25d54c`: setup, signature stop,
recovery stop and recovered submission. Recovery cancels held delivery of an
exited verifier's result, preserves the original signature and empty proof slot,
authentically reopens stores and explicitly recovers. A separate process submits
once and refuses two prior attempts. All original processes and the driver exit 0.
The recovery process uses twelve utilities, four workers and six key loans.
Only the signature-stop to recovery-stop boundary adds a new semantic physical
storage check: seven changed account files among seventeen tracked files, with
no additions or removals. Other stage boundaries are hash-only observations.

Two focused root runs pass 506 tests in ten suites and 113 tests in six suites,
with natural exits, strict lint and explicit formatting. Their 619-test sum is
not a full regression. Independent engineering review revalidated all four
archived stages and a flipped-flag refusal control; it is not an external security
audit. External services remain synthetic. This qualifies callback cancellation
after verifier exit, not live-child cancellation or physical transport drainage.
The standalone trusted-host package does not export this recovery authority.

Next are production key and fee admission, pre-transaction POI authority,
durable uncertainty and confined transport. The local composition above supplies
the earlier missing proof-to-wire prerequisite. The existing
broadcaster still delegates to EOA self-broadcast. Specifically authorized
live private/service qualification, return-to-origin spending policy, generic
Host support, platform/release work and product UX remain separate gates.

## Earlier public adapter, package and transport checkpoint

The [restricted public Shield adapter and fixed Freedom host](railgun-kohaku-public-adapter-2026-10-06.md)
now pass three fresh native cases at `0645ab59`: acknowledgement, lost response
and cancellation during held final review. Original results/errors and one-use
admission are preserved; cancellation signs and sends nothing. All original
children and the driver exit 0. Combined root checks pass 823 tests in 24 suites,
strict lint and changed-source formatting. The same implementation corrects
malformed Promise observation in both transaction adapters. Earlier private
native reports remain pinned to their old source; these public runs do not
refresh them. External services remain synthetic.

The [five-factory Node prototype](railgun-kohaku-public-node-prototype-2026-10-06.md)
adds public preparation/submission and the private correction to the portable
snapshot/private runtime. Its exact 29-file final package passes fresh bare-package
CJS/ESM/mixed smokes. Runtime evidence has 137 case executions and three
forbidden-work controls; separate declarations have 3 positives/11 negatives,
four distinguishing controls and one actual-upstream specialization check.
This is an unpublished restricted trusted-host prototype, not generic Host support.

The [private-RPC/transport composition](railgun-private-rpc-transport-2026-10-06.md)
adds ten tests using genuine destination constraints and actual loopback SOCKS,
TLS and HTTP. All 153 tests in four suites pass with natural exit, strict lint
and formatting. Four detached controls distinguish URL binding, queued
cancellation, direct dialing and target DNS. Existing clients keep their reviewed
pinned URL; new derivations cannot silently follow a changed registry destination.
This is Node loopback coverage, not live Tor circuit-isolation qualification.

Next is a separately reviewed recovery companion with bounded authenticated
history summaries, original-signature proof recovery and fresh cold-submission authority. A hold ID is a selector,
never a reconstructed operation token or permission to retry. Live disclosures,
private spending, uncertain-hold release, broader assets/recipients, release/platform
qualification and UI/product decisions retain their separate gates.

## Earlier private-adapter and package checkpoint

The [restricted private adapter and fixed Freedom host](railgun-kohaku-private-adapter-2026-10-06.md)
now pass five fresh native cases at `f84da57a`: acknowledged self-transfer, full
withdrawal with a lost response, partial withdrawal, cancellation during held
final review and denied preparation. All original children and the driver exit 0.
The source passes 664 focused tests in 19 suites with natural exit, strict lint
and changed-file formatting. Actual local crypto/controllers use synthetic
services; live private spending and physical transport drainage remain unqualified.
The separate strict declaration campaign passes one positive and 23 negatives
against actual pinned Kohaku sources. Earlier failed fixture campaigns stay excluded.

A [standalone restricted Node prototype](railgun-kohaku-node-prototype-2026-10-06.md)
now packages the snapshot/private adapters without Freedom hosts, account authority,
engine, prover, storage or RPC clients. Two identical final 30-file assemblies pass
fresh CJS/ESM/mixed runtime and type consumers. Expanded runtime checks cover 100
case executions and seven distinguishing controls; portable declarations pass
3 positives/34 negatives and a separate actual-upstream bridge passes 1/6.
This is an unpublished trusted-host prototype, not generic Host support or a release.
Its exact runtime/type evidence and normalized audit copies retain separate scopes.

Next autonomous technical slices are a reusable public Shield host/adapter for the
existing native ETH deposit lane; genuine destination-constraint composition with
loopback SOCKS/TLS; and a separate recovery companion around existing original-
signature recovery. Public submission errors must retain their own contract,
separate from private fulfilled uncertainty. Recovery never reconstructs an
operation token from a hold ID or authorizes automatic retry. Broader assets,
recipients, live disclosures/spending, release packaging and UI/product decisions
retain their existing gates.

## Earlier checkpoints

The [prepared-operation dispatch checkpoint](railgun-kohaku-operation-dispatch-2026-10-06.md)
passes three targeted native cases at `fd5ac778`: acknowledged private unshield,
public lost response, and private cancellation during held final review. Original
controller outcomes, one-use admission and retained ownership remain intact.
All 558 focused tests pass with natural exit; strict lint and five-file formatting
pass. This is an internal sequencing extraction, not a transaction Host.

Next is a complete restricted private-operation adapter and fixed adopting
Freedom bridge. It will expose the existing self-transfer and full/partial
withdrawal paths through a documented host contract while keeping keys, proofs,
disclosure review and durable authority in the host. The fixed bridge will use
the existing controllers. Its outcomes must match private submissions, whose
acknowledged result omits the ordinary wallet's journal status fields. It remains
separate from generic upstream Host support, live private/service qualification,
relayed broadcast, package/browser qualification and UI/product work.

The [restricted snapshot qualification](railgun-kohaku-snapshot-qualification-2026-10-06.md)
now passes one genuine-account native case at `20560d86`: thirteen successful
reads, mutation isolation, pending-read shutdown, host-abort refusal and continued
borrowed-account usability. All fourteen measured activity deltas and the measured
encrypted files remain unchanged. Root checks pass 544 tests with natural exit,
strict full lint and changed-source formatting. A separate strict declaration check passes one
positive and 24 negative cases against the actual pinned Kohaku graph; its exact
dependency scope and lack of JavaScript implementation typechecking are explicit.
This completes the restricted read-host milestone. Generic upstream Host support,
transaction-capable extraction, package/browser qualification and live private
service/broadcaster qualification remain open. UI/product design is still deferred.

The [restricted completed-snapshot adapter](railgun-kohaku-snapshot-adapter-2026-10-05.md)
now shares read behavior between an independent data host and a fixed borrowed-
account Freedom bridge. Detached mutable results preserve the original facade's
frozen API. All 510 focused tests pass with natural exit, strict full lint and
six-file formatting pass. Independent review corrected non-enumerable asset
copying before import. A focused genuine-account native probe is next; generic
upstream Host, compiler conformance and live/private qualification remain open.

The [internal read-dispatch extraction](railgun-kohaku-read-dispatch-2026-10-05.md)
preserves fixed genuine-account capture, settlement checks and pending-read
retention behind an unchanged facade. All 421 focused tests pass with natural
exit; full lint is warning-free and the five changed JavaScript files pass
formatting. Nine fresh native contract cases now pass on Electron 44.5.1 with
924 checked reads, six synthetic sends and unchanged forwarding/cleanup bounds.
Portable Host and TypeScript conformance remain unclaimed. Next is a restricted
completed-snapshot read adapter with a fixed borrowed-account Freedom bridge.
The origin campaign below predates this extraction.

The [local Shield-origin native checkpoint](railgun-shield-origin-2026-10-05.md)
passes all fifteen fresh processes at `233cac01` on Electron 44.5.1. Four
resolve/restore phases make 24 genuine diagnostic calls: eight matches and
sixteen refusals, with no added RPC/job/worker/signing/Railgun-key activity and
unchanged measured encrypted files. Local journal storage-key derivation is
explicit. Root regression passes 16,986 tests / 33 skipped with natural exit,
plus six OpenLV tests; all 513 focused tests, full lint and changed-source
formatting pass. External
services remain synthetic and every ownership/chain/POI/spending authority flag
stays false. Next: restricted read-dispatch extraction toward portable Host
compatibility, then separately authorized live private/service qualification.
The checkpoints below retain their recorded sources and then-open work.

The [local Shield-origin diagnostic](railgun-shield-origin-diagnostic-2026-10-05.md)
now joins genuine account handles with two existing-only journal reads and
reattests the selected note, view, generations and record before reporting.
Both reviewers cleared the final deadline correction; all 315 combined focused
tests, lint and formatting pass. It remains unconnected to production operations.
Next is disposable native integration and restart qualification; this unit-tested
host grants no ownership, chain, POI or spending authority.

The [existing-only journal reader](railgun-existing-journal-reader-2026-10-05.md)
now authenticates registered encrypted snapshots without storage creation or
adoption. Shared plaintext-buffer cleanup also covers authentication failure.
The exact candidate passes 16,899 tests with 33 skips and natural exit, plus six
OpenLV tests and the documented stable-runtime supplement. Branch import passes
198 focused tests and lint. No host consumer or new native qualification is
claimed. Next: genuine-account origin diagnostics and fresh disposable-profile
qualification on Electron 44.5.1, then portable Host and live-private work.

The [read-data extraction and diagnostic checkpoint](railgun-read-data-and-origin-2026-10-05.md)
separates pure Kohaku projections while retaining genuine account admission.
Its changed policy is qualified with fresh generations: nine adapter/ordinary
wallet processes plus six public cold-credit processes all pass at `6c845e5c`.
There are 924 adapter read checks and eight synthetic sends across the campaign.
The broad regression passes 16,826 tests with natural runner exit, plus six
OpenLV cases separately; focused wallet/fixture checks pass 9,741 with force-exit.
Selected report maps and the 11,522-file outer freeze retain their distinct
scope. Origin matching remains dormant supplied-data diagnostics with every
authority flag false. Next: an existing-only journal reader and restricted
host diagnostics, then portable-host and live-private qualification. The subsequent
[main e98e2dd5 synchronization](privacy-main-sync-e98e2dd5-2026-10-05.md) installs
Electron 44.5.1 and refreshes the nodes, passing 332 affected tests, lint and seven
Electron harness cases. The fifteen native reports keep their prior runtime
scope. Earlier checkpoints below also retain their original sources and versions.

The [public-facade cold-credit checkpoint](railgun-public-facade-cold-credit-2026-10-05.md)
passes acknowledged and lost-response deposit, receipt-resolution/normal-scan and
completed-only restore in six fresh processes. Each sequence signs and sends once,
credits exactly one net-WETH note and preserves it through the third process.
Root checks pass 684 tests/13 suites plus lint. Exact maps observe 36 utility and
26 storage-worker closures, with the documented logical-drain limits. A separately
mutated source ciphertext applies the public leaf but yields no owned credit;
its exact assertion failure is expected negative evidence, not healthy cleanup.
The broad 5,545-report/5,795-outer source inventories are not execution coverage.
External services remain synthetic, and no funded profile was used. Native evidence
is committed as `7baac5e5`. The later [main b0fa12ac synchronization](privacy-main-sync-b0fa12ac-2026-10-05.md)
refreshes installed nodes and passes 381 affected unit tests, lint and seven fake-node
UI cases; the earlier native reports retain their source scope. Next are the reviewed read-data extraction, restricted own-origin diagnostic prerequisite and
live private qualification. The following checkpoints retain their source scope.

The [pinned runtime contract checkpoint](railgun-kohaku-contract-2026-10-05.md)
passes eight real adapter cases and ordinary-wallet compatibility: nine fresh
exit-zero native processes, 924 checked reads and eight exact forwarding checks.
Private/public acknowledged, uncertain and held-review outcomes retain their
original settlement semantics. Root checks pass 312 tests/seven suites and full
lint. Test cleanup preserves dependency order, records all failures and has
labelled observer/public drainage timeouts. Source inventories and pre-cleanup
resource counters retain their explicit limits; external services remain synthetic.
This is not generic Host or TypeScript compatibility. Native evidence is pinned to
`c45fc866`; the later [main 9f6fec8d synchronization](privacy-main-sync-9f6fec8d-2026-10-05.md)
refreshes bundled nodes, passes 330 affected tests plus lint and checks IPFS async
lifecycle under network denial. All 178 selected Railgun hashes remain unchanged;
seven broad-freeze IPFS entries changed. Next is the reviewed
[public-facade cold-credit plan](railgun-public-facade-cold-credit-plan-2026-10-05.md),
followed by restricted host extraction and live private qualification. The
following checkpoints retain their historical scope.

The [interrupted-proof and sequential Kohaku checkpoint](railgun-second-proof-recovery-and-kohaku-2026-10-05.md)
passes four four-process original-signature recovery cases, two sequential real
adapter cases and seven compatibility processes: 25 native processes on 928
identical source hashes. The second original signature survives restart; a fresh
process fills its missing proof once and another submits through fresh authority.
A separate same-process pair of actual Kohaku instances consumes normally scanned
change. Both initial histories and acknowledged/lost-response recovery outcomes
pass. Root checks pass 719 tests/36 suites and full lint. These are controlled
fixtures with simulated external services, not live private or power-loss evidence.
Native evidence is pinned to `b4e85dbb`; the subsequent
[main a1438027 synchronization](privacy-main-sync-a1438027-2026-10-05.md) refreshes
bundled nodes and passes 709 affected tests/20 suites with four skips plus lint.
It does not relabel the original native campaign.
At that checkpoint, next were pinned Kohaku contract checks/extraction preparation,
public-facade cold resolution/ingestion, and external-service/live-private qualification. The historical
checkpoints below retain their recorded sources and then-open work.

The [second cold-submission checkpoint](railgun-second-cold-submission-2026-10-05.md)
now passes both original input histories through separate setup, prove-and-stop,
and reopened submission processes, including acknowledged and lost-response
outcomes. Twelve processes plus six compatibility processes pass with 913 identical
source hashes; 366 focused tests and full lint pass. The recovered host reuses the
original second private signature/proof, sends once and ingests the selected change
without disturbing unrelated balances. All external services remain simulated.
Original-signature recovery of an interrupted second proof and a second genuine
Kohaku instance remain next; the full production regression stays pinned to 189c0a31.
The native matrix is pinned to `7540636842b8e2d746a223ba2444610c42cbd01d`. The later
[main 484bf259 synchronization](privacy-main-sync-484bf259-2026-10-05.md) refreshed
the bundled nodes and passes 57 affected startup/profile tests plus lint; it does
not relabel the original native reports.
The checkpoints below retain their historical scope.

The [partial Kohaku facade checkpoint](railgun-kohaku-partial-facade-2026-10-05.md)
now qualifies partial withdrawal through the actual adapter, across both input
histories, failures, cancellation and compatibility (17 native processes).
Main 758c98b0 is merged; full regression passes 16,276 tests/544 suites, plus
six OpenLV tests separately. Synthetic-service and explicit test-force-exit limits
remain. Actual second facade on scanned change and cold second recovery remain next.

The [complete connected restart checkpoint](railgun-connected-change-restart-2026-10-05.md)
now passes both original input histories through separate setup/resume processes,
including genuine encrypted restoration, fresh second proof/signature and terminal
balance ingestion. Four compatibility modes pass on the same 902 source hashes
at merged commit `4ab31ac1`; bundled nodes were explicitly refreshed. External
services remain simulated. Cold second-operation submission/recovery, partial
Kohaku facade and live private qualification remain next. The prior checkpoints
below retain their historical scope.

The [terminal second-spend checkpoint](railgun-terminal-ingest-integration-2026-10-05.md)
now advances the actual second withdrawal through the existing public/TXID history
and ordinary wallet scanner. Both initial histories pass with the same 868-source
inventory. The selected change becomes spent while unrelated notes and balances
remain intact; total unspent WETH falls by exactly the change amount. Private and
resolved EOA records, first retained-POI state and prior canonical prefixes remain
preserved through terminal work. Second-spend, change-only and default compatibility pass against the same sources in 97,197/89,402/84,531 ms.
External services remain simulated and composition is same-process. Full process
restart, cold second submission/recovery, partial facade and live qualification
remain open. The checkpoints below retain their historical scope.

The [connected second-spend checkpoint](railgun-combined-second-spend-integration-2026-10-05.md)
now spends actual first-transaction change through fresh production staging,
creator/list/root/preflight authority, signing/proving, second journaled Ethereum
submission and receipt capture. Both initial input histories pass with identical
860-source inventories and simulated external services. Terminal wallet ingestion,
full process restart, cold second submission/recovery, partial facade and live
qualification remain open. The following checkpoints retain their historical scope.

The [normal change checkpoint](railgun-combined-change-integration-2026-10-05.md)
connects actual first-transaction change to the ordinary wallet scan and
Missing-to-Valid membership through a disposable proof-verifying list service.
Both input types pass twenty native stages; default compatibility passes
seventeen. All three share 856 source hashes. Only fixture/documentation bytes
change from the preceding production checkpoint. Actual second spending,
new-process combined recovery, partial facade and live qualification remain
open. The next step stages and spends the actual change with fresh authority.

The following checkpoints retain their historical evidence and limitations.

The [durable combined-proof checkpoint](railgun-combined-poi-integration-2026-10-05.md)
connects genuine partial capture to one combined proof, retained version-3 data,
recovery, cold validation and one fixed proof POST. Shield and received-Transact
native runs pass against identical source inventories, as do eight compatibility
cases. Services remain simulated. The POST does not establish list acceptance;
normal change ingestion, a second spend, new-process combined recovery, partial
facade integration and live private qualification remain open. The frozen regression passes 15,731 tests across 517 suites (33 tests/five
suites skipped), retaining the existing OpenLV exclusion and forced-exit limit. This is progress toward the full change lifecycle, not
completion of it.

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

The detailed checkpoints below describe their recorded versions. The latest
checkpoint and next-work section distinguish the current partial-withdrawal
support from these earlier integration restrictions.

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

At that baseline the supported private operation shape was one pinned-WETH input
and one self-transfer output, or a full-value unshield to the enrolled Ethereum
submitter. The latest checkpoints additionally qualify bounded partial withdrawal. This is an integration restriction, not a statement about Railgun's
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
with real engine hashing/path qualification over synthetic evidence. At that checkpoint, main
partial admission remained closed; earlier counts belong to their recorded sources.
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
persistence. At that controller checkpoint, normal change ingestion, list
acceptance and second spend remained open, and the facade was full-only.
Later checkpoints above supersede those restrictions within their stated scope.

## Next technical work

1. **Public Shield lane — implemented with controlled native qualification.**
   The [public instance and separate submitter](railgun-kohaku-public-integration-2026-10-04.md)
   issue genuine one-use public tokens, review simulation disclosure before keys
   or RPC admission, and retain reviewed destination restrictions. Acknowledged,
   lost-response and held-review cancellation cases pass with genuine hosts,
   preflight, vault signer and journals, but synthetic RPC. The private broadcaster
   refuses Shield. The reviewed [cold-credit plan](railgun-public-facade-cold-credit-plan-2026-10-05.md)
   connects a real adapter deposit to separate-process receipt resolution, normal
   scan credit and another completed restore. This controlled composition now passes
   both response outcomes in the [cold-credit checkpoint](railgun-public-facade-cold-credit-2026-10-05.md).
   Live public-facade qualification remains separate.
2. **Finish the remaining partial-withdrawal composition boundaries.**
   The actual Kohaku adapter now supports partial withdrawal with immutable
   input/withdrawal/change review. Genuine change scanning, disposable-list
   acceptance, second spending, terminal ingestion, two-process restart and
   three-process second recovered submission are qualified in controlled runs.
   Original-signature recovery after the second signature commits but before
   its proof is made, and
   a fresh second Kohaku instance spending scanned change now pass separate
   controlled native campaigns. Pinned runtime contract checks now pass for
   private/public/read instances and their original settlement forwarding.
   Restricted transaction preparation and fixed authenticated recovery access
   are implemented. The recovery companion discovers bounded retained-operation
   summaries and delegates explicit proof recovery and cold submission without
   recreating operation tokens. Its fresh four-process Shield campaign qualifies
   held post-verifier callback cancellation, genuine phase exclusion, authentic
   store reopening, original-signature preservation and later submission with
   prior-attempt refusal. Services remain synthetic; live-child cancellation is
   not qualified. Platform, release and live-service gates remain open. The
   restricted snapshot
   host/read adapter now has genuine native and strict declaration qualification;
   its separate evidence does not type-check the current transaction facade or
   implement generic upstream Host. The transaction facade remains Freedom-owned.
   Real deployed verifier checks, service list acceptance and private broadcasts
   remain separate live qualification. Earlier warm and advanced-root recovery
   evidence retains its own source inventory. The
   [bounded partial-unshield plan](railgun-partial-unshield-plan-2026-10-04.md)
   records the creator shapes and combined output/unshield POI requirements;
   the latest checkpoints above distinguish implemented and still-open work.
3. **Local origin diagnostics qualified; spending policy remains separate.**
   The existing-only journal reader and main-only genuine-account host now pass
   the [fresh native recovery campaign](railgun-shield-origin-2026-10-05.md).
   They authenticate local evidence only, grant no ownership or chain authority,
   and remain unconnected to production operations. Any future return-to-origin
   spending path still needs its own bounded design and qualification. The inspected engine
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
exact asset and an explicit full or bounded partial amount; it does not invent coin selection. Preparation
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
broadcaster shapes does not establish a generic `createPlugin(host, params)` package.
Restricted snapshot and private-operation adapters now have separate host contracts,
fixed Freedom bridges and native/type evidence. The standalone Node prototype
packages their trusted-host interfaces without exporting genuine Freedom authority.
The reusable public Shield adapter now has its own qualified public-operation
lane and separate submitter; it must not be passed to the private broadcaster.
Authenticated bounded history and explicit recovery actions now have a fixed
main-owned companion and controlled native evidence. The standalone trusted-host
package does not export that recovery authority; a history selector is not a
submission grant. Generic recovery-host portability requires a separate contract
and ownership review.

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
