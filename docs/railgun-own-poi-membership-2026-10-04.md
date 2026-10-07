# Account-bound post-spend Shield membership — October 4, 2026

`openRailgunOwnPoiMembership` composes the existing account preflight, keyless
Shield selector, POI source and isolated membership verifier. It accepts a
genuine enrollment, its public coordinator and a recovery selector. The caller
cannot supply a replacement capsule, preparation or list proof. Preflight must
capture the account operation, check its archive anchor and classify the input
as a non-legacy Shield. The keyless utility then recomputes the Shield note hash
and blinded lookup value from that captured input.

The controller recaptures the account immediately before querying and again
after verification. It compares the stable operation binding, capsule, intent,
transaction and projection, plus active/archive representation and the archived
finality anchor. Routine confirmation/revision refreshes are accepted; a new
archive transition or anchor requires another preflight. These checks do not
lock the journal against writers or renew source/finality evidence.

The query uses a fresh operation-scoped private-account POI context and exactly
one derived Shield value. The existing source checks the required list, status,
signed event and service root acceptance. A keyless utility verifies the actual
Merkle path. The returned opaque receipt retains both underlying receipts, the
account/coordinator identity and a lifetime of at most 60 seconds from the start
of acquisition, never beyond the operation deadline. Requested remaining-time
margins must fit both limits. Caller cancellation,
account/coordinator revocation, source closure or expiry invalidates it. An
in-flight utility keeps its recovery phase until exit; cancellation cannot admit
a competing operation before the original work drains.

This receipt attests membership and how its query was derived. It grants no
viewing-key release, current account/source/finality authority, permission to
disclose a POI payload, or spending authority. The private preparation, selector,
association digests and proofs remain main-only in memory. A later controller
must freshly authenticate the account at key handoff and recheck current
source/root/finality before any external payload submission.

The new module fits the existing main-owned wallet boundary. No production
caller, renderer API, IPC channel, key-release allowlist, policy or dependency
changed. Only tests and the offline qualifier invoke it. A future production
caller must establish authorization for the membership query, which itself
reveals the derived blinded input to the service. The pending live owned-note
query has not been sent. Transact-created and legacy inputs refuse before query.

## Qualification scope

The native fixture uses a new disposable profile, the public test mnemonic,
genuine enrollment, encrypted reservation/capsule stores, journal recovery and
source/membership receipts. It builds a real Shield hash and Poseidon membership
path at the launch-block boundary, then runs the actual selector and membership
utilities. Simulated public history advances through the production ledger in
60 bounded ranges, without patching the launch constant or fabricating a stored
checkpoint.

Chain and root services are simulated, and the recovered spending proof and
signature are structural fixtures. Service events use real Ed25519 signatures
under a disposable fixture key. A narrowly scoped test seam substitutes only
the service key during the records module's import and immediately restores
global verification. Every fixture signature is independently required to fail
under the real required-list key. This qualifies parsing and signature checking,
not authentication of the real service. The earlier
[public-note qualification](railgun-poi-read-2026-10-03.md) checked a separate
real signed event under the actual list key; it does not authenticate this
fixture or the funded account.

Transport consumers must be absent from the module cache before the counted
simulation is installed. Even their original factories capture that simulation.
Only the four expected POI methods and five expected RPC methods are accepted;
all operation-time key-bearing jobs are refused. Reports omit selectors,
association digests, note hashes, capsules and proofs. No live query or
transaction submission is part of this qualification.

Controlled viewing-only proving, separate keyless proof verification, fresh
pre-disclosure checks and actual service acceptance remain subsequent work.

## Results

The final [transfer report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-own-poi-membership-transfer-2026-10-04.json)
and [unshield report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-own-poi-membership-unshield-2026-10-04.json)
each pass 17 scenarios with 168 matching source hashes, in 41,184 and 40,943 ms.
They cover active and archived operations, routine journal refresh, archive
transition, reopening stores, injected caller proofs, forged enrollment, wrong
selection, invalid status/signature/root/path/index, cancellation with deferred
transport or utility exit, healthy reopening after refusal, and final journal
drift. In each run, all 14 selector and ten membership processes exit; all 14
transports close. The four simulated POI methods are called 14/13/12/11 times,
with 12 actual signature checks under the fixture key. Operation-time key jobs,
unexpected RPC/transport, live queries and submissions are all zero.
Network acquisition holds no account phase; its cancellation retains the
operation owner until drain. The utility additionally retains its recovery phase
until exit, explaining the different phase flags in the two drain scenarios.

All 168 focused tests across six suites pass and lint is clean. Unit coverage
also checks source expiry, caller/coordinator revocation, owner exclusion through
drain, keyless selector failures, recovery-phase refusal and the requested
remaining-time margin against the overall operation deadline. The witness test
checks proof-format compatibility only; it deliberately stops at reconstruction
and makes no additional cryptographic claim. The previous full regression of
9,814 passing tests predates this slice.
Claude and Codex approved the implementation, tests, native evidence and scope.
