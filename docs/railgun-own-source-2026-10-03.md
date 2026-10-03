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
while the ledger finishes authenticating the prefix. Capture-local cancellation
also latches and drains; the coordinator's own cancellation, ledger integrity
failure or resource limits still abort without publishing partial evidence.

The wrapper waits for the coordinator's final source, header and store checks
before issuing an opaque receipt. Caller cancellation, enrollment closure, policy
or generation changes, a later coordinator snapshot, and the monotonic deadline
invalidate it. The coordinator also expires evidence 60 seconds after its last
canonical refresh, which may be earlier than a configured capture deadline.
Cancellation revokes admission while retaining exclusion until the in-flight
coordinator call settles. No account phase or handoff permission is broadened.
Expected comparison refusals are returned through the snapshot callback and
rejected only after coordinator completion, preserving a healthy public session.
The controller must serialize capture with public advance/publication.

`sourceAuthenticated` means the bytes came from the current authenticated local
source ledger. Its chain-data trust remains `unverified-rpc`. It does not establish
receipt status, calldata authenticity, account ownership of the operation,
current canonicality/finality, TXID membership or root acceptance, POI eligibility,
or spending permission. Receipt-status, account, finality and spending flags
remain explicitly false. Captured associations stay inside main-process wallet
logic; there is no renderer or IPC surface.
`suppliedOutcome` also contains calldata-derived fields; source capture alone
does not authenticate its bound-parameter hash, intent digest or unshield
commitment. Deterministic log digests in the synthetic reports below must not be
copied into live owned-transaction reports: they can identify public transactions.

## Qualification

Actual disposable-vault Electron runs use real enrollment, encrypted source/public
stores, the pinned engine and the genuine public coordinator. Public history and
RPC responses are synthetic; proof/ciphertext fixtures are structural and do not
represent a valid private spend.

| Mode | Elapsed | Source hashes | Scenarios |
| --- | ---: | ---: | ---: |
| [Transfer](qualification/railgun-own-source-transfer-2026-10-03.json) | 1,982 ms | 136 matched | 6 passed |
| [Unshield](qualification/railgun-own-source-unshield-2026-10-03.json) | 2,068 ms | 136 matched | 6 passed |

Each run covers genuine capture, invalidation by a later snapshot, refusal after
an injected failure following the real authenticated ledger visit, and exact
checkpoint/group recovery after closing and reopening the public stores. Added
controls refuse a mismatching receipt and cancel a capture during traversal,
then successfully capture again without reopening the coordinator. The injected
post-visit ledger failure still closes the coordinator. Reopen
is within one process, not a complete application restart. Initial and reopened
authority flags are asserted explicitly. Each records seven source visits, one
injected post-visit failure, one capture cancellation, 92 simulated header requests and two simulated log
requests, with zero external transport attempts or unexpected RPC methods.

Earlier fixture attempts refused during public-history advance and produced no
passing reports. Corrections fixed the synthetic genesis parent and added a
separate earlier Shield commitment to establish tree 0 before its Nullified
event; transfer now appends at position 1. Production validation stayed intact.
Codex independently checked the initial corrected fixture and both four-case reports.
Claude's subsequent review found that semantic refusals escaped the snapshot
callback and closed the shared coordinator. The follow-up isolates those refusals,
latches capture-local cancellation, and adds an explicit enrolled source-ID check.
The collector, capture and related creator tests pass 56 cases across three suites;
including submission-journal snapshot tests, 72 pass across four suites. Lint is clean.
Claude approved the corrected production boundary and both six-case native reports;
Codex approved the journal change and final documentation. The frozen follow-up
tree passes 9,371 tests / 33 skipped across 440 passing suites in 299.351 seconds
with native-process access and the existing OpenLV exclusion. A fresh fetch
confirms main remains current at `b18d571b`.

Authenticated private capsule/reservation and active/archived submission-journal
capture, phase-separated TXID acquisition, reattestation and fresh root composition
remain next. No live owned-note query, proof disclosure or transaction occurred.
The files follow existing main-process wallet/storage boundaries; no new IPC,
dependency or top-level responsibility was introduced.

## Consistent submission-journal reads

`private-submission-journal.readSnapshot()` returns active records and archived
records from one authenticated storage read and one shared decoder invocation.
It rechecks the context after the await and recursively freezes the detached
result, including archived nested outcomes. It does not initialize, migrate,
reconcile or archive data and does not confer a lease or ongoing authority.

The journal suite passes 16 tests. New cases exercise a concurrent archival
transition, nested mutation refusal, revocation while a read is pending, all four
retained schema versions without rewriting bytes, cross-list hash uniqueness,
archive ordering and corrupt encrypted data. Codex reviewed the implementation
and identified a negative fixture whose duplicate hash also violated nonce
ordering; the fixture now isolates the hash constraint.

Later composition must bind the selected record and its active/archive
representation and reattest at use. Recovery-phase exclusion alone does not lock
EOA journal writers; equality at two reads does not prove uninterrupted stability.
