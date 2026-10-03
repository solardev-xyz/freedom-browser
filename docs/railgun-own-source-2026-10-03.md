# Railgun own-transaction source capture — October 3, 2026

The main-owned collector compares a supplied private transaction receipt with
its exact two proxy logs in the complete retained source prefix. The capture
wrapper binds the result to a genuine enrolled public coordinator, its store
generation, policy and completed snapshot. This is a prerequisite for joining a
submitted private operation to TXID evidence and post-transaction POI preparation.

The collector pins bounded caller data before awaiting work. It checks receipt
consistency, canonical integer quantities, source ordering, block/transaction
identity and complete raw event payloads, including encrypted fields. It selects
by transaction hash across the entire prefix, so contradictory occurrences cannot
be hidden by filtering to the expected block. Semantic mismatches are latched
while the ledger finishes authenticating the prefix; cancellation and resource
limits may abort without publishing partial evidence.

The wrapper waits for the coordinator's final source, header and store checks
before issuing an opaque receipt. Caller cancellation, enrollment closure, policy
or generation changes, a later coordinator snapshot, and the monotonic deadline
invalidate it. Cancellation revokes admission while retaining exclusion until
the in-flight coordinator call settles. No account phase or handoff permission
is broadened.

`sourceAuthenticated` means the bytes came from the current authenticated local
source ledger. Its chain-data trust remains `unverified-rpc`. It does not establish
receipt status, calldata authenticity, account ownership of the operation,
current canonicality/finality, TXID membership or root acceptance, POI eligibility,
or spending permission. Receipt-status, account, finality and spending flags
remain explicitly false. Captured associations stay inside main-process wallet
logic; there is no renderer or IPC surface.

## Qualification

Actual disposable-vault Electron runs use real enrollment, encrypted source/public
stores, the pinned engine and the genuine public coordinator. Public history and
RPC responses are synthetic; proof/ciphertext fixtures are structural and do not
represent a valid private spend.

| Mode | Elapsed | Source hashes | Scenarios |
| --- | ---: | ---: | ---: |
| [Transfer](qualification/railgun-own-source-transfer-2026-10-03.json) | 2,478 ms | 136 matched | 4 passed |
| [Unshield](qualification/railgun-own-source-unshield-2026-10-03.json) | 2,569 ms | 136 matched | 4 passed |

Each run covers genuine capture, invalidation by a later snapshot, refusal after
an injected failure following the real authenticated ledger visit, and exact
checkpoint/group recovery after closing and reopening the public stores. Reopen
is within one process, not a complete application restart. Initial and reopened
authority flags are asserted explicitly. Each records three source visits, one
injected post-visit failure, 60 simulated header requests and two simulated log
requests, with zero external transport attempts or unexpected RPC methods.

Earlier fixture attempts refused during public-history advance and produced no
passing reports. Corrections fixed the synthetic genesis parent and added a
separate earlier Shield commitment to establish tree 0 before its Nullified
event; transfer now appends at position 1. Production validation stayed intact.
Codex independently checked the corrected fixture and both reports. The collector,
capture and related creator tests pass 53 cases across three suites; lint is clean.
The previous 9,326-test full regression predates this new slice.

Authenticated private capsule/reservation and active/archived submission-journal
capture, phase-separated TXID acquisition, reattestation and fresh root composition
remain next. No live owned-note query, proof disclosure or transaction occurred.
The files follow existing main-process wallet/storage boundaries; no new IPC,
dependency or top-level responsibility was introduced.
