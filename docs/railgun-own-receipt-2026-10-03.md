# Railgun own receipt and finality observations — October 3, 2026

`observeRailgunOwnReceipt` is a read-only RPC comparison step for detached
own-operation data. It checks the record projection and exact submitted intent,
derives an EOA context from that submitter under the genuine enrollment lifetime,
and fetches the journal-known transaction and receipt once. The network's existing
journal gate includes archived hashes; no reconciler or submission method runs.
The supplied capture is comparison data, not an authentication capability. A
composition must derive it from the live account and recapture before use.

The receipt outcome must exactly match the retained resolution. Two internally
consistent finality observations bracket explicit numbered-header reads for the
included block, original resolution anchor and optional archive anchor. A final
inclusion-header read detects contradictory responses after that bracket. The old
anchors must remain canonical according to the same unverified RPC provider; the
finalized height cannot regress or trail those anchors. This does not verify
ancestry, consensus or finality cryptographically.

The frozen result includes the bounded transaction/receipt, observed representation,
anchors actually checked, and monotonic/wall-clock times. All authority flags remain
false. It returns no ongoing receipt or writer lease. Cancellation revokes the EOA
scope and awaits the outstanding request promise before returning. A 60-second
deadline bounds acceptance of the observation; draining an outstanding request may
take longer. Fifteen active or sixteen archived sequential requests may refuse
over a slow Tor circuit. Synthetic timing does not
qualify live Tor performance. Downstream source/verifier bounds still apply to their
larger combined inputs.

Claude approved the production boundary. The related five suites pass 113 tests,
including contradictory inclusion/resolution/archive anchors, moving finality,
malformed replies and cancellation. Disabling the inclusion-header hash comparison
in memory makes its targeted regression fail (one expected failure); production
files were not modified for that control. Lint is clean.

## Actual-store qualification

| Mode | Elapsed | Source hashes | Scenarios |
| --- | ---: | ---: | ---: |
| [Transfer](qualification/railgun-own-receipt-transfer-2026-10-03.json) | 1,667 ms | 142 matched | 9 passed |
| [Unshield](qualification/railgun-own-receipt-unshield-2026-10-03.json) | 1,619 ms | 142 matched | 9 passed |

Both runs use disposable vaults, real encrypted reservation/capsule/EOA stores and
genuine resolution permits, with simulated RPC and structural proof/signature data.
Nine scenarios include missing/unresolved journal capture, active observation,
archived observation with both stored anchors, enrollment reopen, three distinct
header-reorg refusals followed by successful observation, and unresolved-sibling
capture refusal. Successful observations make exactly fifteen/sixteen requests,
then preserve the atomic journal snapshot and exactly recapture account data.
Refusals also preserve the journal snapshot. This demonstrates agreeing observations,
not uninterrupted stability or exclusion of writers.

Each complete run records fifteen receipt reads, eleven transaction reads,
ninety-seven header reads and twenty-one head reads, including initial resolution
and failure controls. External transport attempts and unexpected methods are zero.
Reopen occurs in the same process; the archival-age clock shift remains synthetic.
The reports contain counts/booleans and source hashes, not private associations.
Codex reviewed tests and native evidence. No live query, POI disclosure or submission
occurred. The earlier 9,481-test full regression predates this reader.

Next is composition with retained-source capture and independent TXID/path/root
observations. An active record may become archived between phases; a future
composition must identify any new archival anchor it has not checked. No new
callback authority, dependency, renderer, IPC or top-level responsibility changed.
