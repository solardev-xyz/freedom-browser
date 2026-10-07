# Fresh checks for a local Railgun POI proof — October 4, 2026

`openRailgunOwnPoiChecks` binds a genuine locally proved POI payload to a fresh
account/source preflight, observations of its exact original list and TXID roots,
and final private account reattestation. Its receipt is diagnostic and revocable;
it cannot submit a proof, disclose a note or authorize spending. This remains
main-owned wallet infrastructure without a renderer capability, IPC channel,
production caller or dependency change.

## Proof history and current evidence

The proving controller now registers successful results in a private WeakMap
only after separate keyless verification succeeds. At most 128 KiB of detached,
deeply frozen preparation and payload history is retained. A copied result,
different enrollment/coordinator, revoked identity or changed public generation
cannot retrieve it. Membership expiry and the completed prover's local cleanup
do not invalidate this historical result. It establishes local origin, not
current membership or chain truth. Registration is process-local: a persisted
JSON copy cannot be used after restart.

The checks controller rebuilds the payload from that history and compares its
digest. Fresh `preflightRailgunOwnPoi` evidence must agree on the transaction,
creator, original TXID row and leaf position, account capture and public identity.
A mirror checkpoint may advance. An active record may become archived only when
the fresh preflight has checked that archive anchor; archive rollback or an
altered existing archive anchor refuses. No representation change is accepted
between that preflight and the final recovery window.

The two root readers query the original proof roots, even if the public mirror
has advanced. They share a fresh private-account POI operation context and have
separate child scopes. The fixed list reader checks the required list; the new
TXID reader checks only tree zero and an index below the existing 8,000-row mirror
cap. Neither accepts arbitrary methods or endpoints. Exact response shape, ID,
Boolean result, HTTP status and the 4 KiB response bound are enforced. A current,
well-formed rejection is distinguished from an unavailable observation.

There is deliberately no repeated input-note lookup in this stage. Such a query
immediately before proof submission could link the input lookup to the output
proof by timing, including across separate Tor circuits. Root acceptance does
not establish that the input has not subsequently been blocked. The observation
therefore explicitly retains `noteStatusChecked: false`, and current per-note
eligibility is not claimed. A future submission can still be rejected.

## Lifetimes and cancellation

The default and maximum total admission budget is 240 seconds. It starts after
synchronous runtime/history validation, immediately before preflight. Preflight
receives at most 180 seconds and ends with its own fresh recapture and source/root receipt
checks. After it completes, the roots and final account checks share at most 60
seconds, capped by the original total deadline. The preflight duration is recorded
separately. Each root reader also limits acquisition to 45 seconds and receipt age
to 60 seconds measured from acquisition start. Slow responses do not reset that
age. Final recovery receives at most 15 seconds of the remaining budget; success
requires at least a one-second margin inside and after reattestation.

These limits do not give every observation a 60-second age. The preflight's
current-checkpoint TXID-root receipt is reasserted when preflight returns. Its
source snapshot must still be the coordinator's current authenticated snapshot
then, within the capture deadline, but has no independent age token. Chain
receipt/finality observations are taken earlier in preflight without a
reassertable age token. Their age is bounded by this run's total 240-second
deadline. They describe observed historical anchors; they do not establish
current chain authority. The recorded duration makes preflight latency visible.

Both root requests settle before the final recovery window. That window compares
its initial and reattested account captures against the fresh preflight. A checks
receipt remains bound to the exact proof, enrollment and coordinator and rechecks
both root receipts, identity/generation and the deadline. Reassertion does not
perform a new account read or exclude journal writers. Top-level authority flags
remain false; nested `accepted: true` values are explicitly unverified service
observations, not authenticated root acceptance.

Cancellation revokes admission immediately. Both readers and any borrowed
preflight/recovery work must drain before the per-enrollment owner is released.
Even a refusal waits for that drain. A transport or store read that ignores
cancellation can retain the hold indefinitely; the deadline is not a promise
that cleanup will finish within a fixed time. A concurrent call refuses without
disturbing the current operation.
A successful result retains that owner until the caller closes it or its
freshness deadline expires; no second checks operation can start while its
receipt remains open. Release still waits for pending cleanup to finish.

## Remaining work

Proof-specific historical root checks can reveal correlated timing and remain
behind the pending live-disclosure authorization. This implementation does not
make a live request. A one-use authorized handoff, durable submission intent,
uncertain-response handling, restart/status recovery and second-spend qualification
remain separate work. The process-local proof registry is intentionally not a
restart recovery design. Transact-created input provenance and broader operation
scope also remain open.

## Qualification

The [self-transfer report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-own-poi-checks-transfer-2026-10-04.json)
and [full-unshield report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-own-poi-checks-unshield-2026-10-04.json)
each pass eight checks scenarios, alongside the existing 13 proof, seven recovery
and 17 membership scenarios. Both match all 187 frozen source hashes. Total host
work takes 113,623 and 114,001 ms, respectively, excluding Electron startup. Prover
peak RSS is 478,429,184 and 431,013,888 bytes; maximum prover result wires are 3,844
and 3,837 bytes. These measurements include the prior proof qualification, not
just the new checks.

Each run refuses a copied proof without starting preflight or root requests.
The seven genuine-proof cases each run one keyless selector and one keyless TXID
verifier, then make exactly one original-list-root and one original-TXID-root
request. All 14 requests pass the complete wire assertions, and all 14 transports
close. All 14 additional keyless jobs exit. Their guard reports record 1,274
canary checks with zero capability attempts. This checks stage adds no viewing
key, POI proof, POI verifier or owned-note query. Its preflights do make counted
synthetic chain and public-service requests; this is not a zero-network-work claim.

**October 4 count clarification from the later output-recovery qualification:** those 14 jobs
and 1,274 canary checks cover the instrumented selector/TXID verifier jobs only.
Preflight also uses keyless TXID mirror inspect/witness utilities; they were not
included in those counters. A cold public coordinator can additionally reconstruct
its checkpoint with a public-plan utility. The earlier figures are not a census
of every utility process used by preflight; the original reports remain unchanged.

The scenarios cover valid checks and forged/cross-owner/closed receipts, owner
exclusion, list rejection, TXID rejection, malformed list response, caller
cancellation, timeout and healthy reuse after failures. Cancellation and timeout
hold both transports despite abort, release them separately and prove that the
owner remains excluded until both drain. Both eight-second controls observe
revocation at 8,031 ms before releasing either transport. Every case preserves
the journal and allows a healthy account recapture after drain. Independent
fixture review found and fixed a harness deadlock when a wire assertion failed
before held-request registration; a separate failure signal now reaches cleanup.

The composed fixture uses genuine disposable enrollment, encrypted stores,
account/source/membership receipts and real local POI proofs. Its coherent SDK
note and transaction data use a published test mnemonic. Spend proofs/signatures
remain structural; chain/root services and fixture-key service-signature trust
are simulated. The integrated input is tree zero, position zero. The earlier
standalone nonzero-position/path qualification remains separate. Host services
are intercepted before consumers load, and utility capability guards are tested;
this is not operating-system-wide host egress tracing or a live Tor test.

All 339 focused tests across five suites and repository lint pass. Unit coverage
also exercises advanced mirror checkpoints, checked archival transitions,
identity/generation revocation, long preflight, strict remaining-time margins,
total-deadline limits and final account drift. Those broader timing and archival
cases are not claimed as additional native scenarios. Earlier root-reader and
enrolled-proof reports retain their earlier exact source snapshots. The frozen
full regression passes 10,255 tests / 33 skipped across 464 passing suites in
314.331 seconds, with native process/loopback access and the existing OpenLV
exclusion. Claude and Codex reviewed production, tests, fixture and evidence.
This is engineering review, not an independent security audit.
