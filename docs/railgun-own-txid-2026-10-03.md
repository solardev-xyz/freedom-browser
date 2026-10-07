# Railgun own-transaction TXID comparison — October 3, 2026

`railgun-own-txid.js` adds a bounded, data-only comparison needed before
post-transaction POI preparation. It joins a normalized private capsule, an active
or archived EOA journal record, the full transaction and successful receipt,
and one candidate TXID row. It makes no network call, opens no store and grants
no account capability. These private associations must stay inside the account
boundary; they are not diagnostic log or renderer data.

The capsule's zero-proof intent must match the submitted calldata, while the
journal's full calldata digest also binds the actual proof bytes. Existing direct
proxy, single-item, one-input/one-output, WETH and no-adapter restrictions apply.
The complete receipt inspection must exactly reproduce the persisted matched
resolution. Active record metadata follows the journal's required timestamp,
optional revision and unverified-observation checks. Archived records use their
distinct retained shape; mixed representations refuse. Archival finality cannot
regress below the persisted resolution, and equal-height inclusion, resolution
and archival anchors must have consistent hashes.

The candidate row must match the Ethereum hash, block, independently supplied
transaction index, nullifiers, commitments, recomputed bound-parameter hash and
input tree. Transfers require the event-derived output tree/position and no
unshield field. Full-value unshields require sentinel positions and exact token,
recipient and gross amount; receipt amount plus fee must equal that amount.

The graph ID's third limb is restricted to zero as a narrow admission policy.
The pinned wallet formatter merely copies that ID, so this is not a claim that
the limb is a transaction-wide call ordinal, log index or TXID-tree index.
Producer semantics still need confirmation before broadening support.

Results are detached and deeply frozen. Matching does not authenticate caller
data or establish current canonicality/finality, TXID membership/root acceptance,
timestamp or verification-hash continuity, POI eligibility or spending authority.
Unshield commitment equality with calldata is checked; recomputing that commitment
from its preimage is performed by the detached verifier described below. The structural
test fixture deliberately contains no valid transaction proof.

The matcher and related receipt, resolution and retention tests pass 172 cases
across four suites; lint passes. Codex review identified incomplete active metadata
validation and contradictory archived anchors; both now have explicit negative
cases, alongside proof-byte substitution, graph-index overflow, nonzero slots,
wrong output positions, net-versus-gross unshield amount, malformed records and
post-return mutation. No live query or transaction occurred.

The matcher and detached verifier remain local primitives. Authenticated
account/journal/source capture and current root composition are next, followed by
ordered spent-input/output POI proof preparation. POI disclosure/submission and second-spend qualification remain open.
The location follows existing main-process wallet validation responsibilities;
no renderer, IPC, dependency or top-level boundary changed.


## Detached cryptographic verification

The main-owned verifier invokes the matcher itself and binds its exact row and
comparison digest to the complete detached input. The result-only utility loads
the pinned engine, recomputes the TXID and verifies the sixteen-level path using the supplied siblings, and for
unshield recomputes the commitment from recipient, canonical token data and gross
amount. No fabricated owned note is needed. Its broker accepts one exact result,
checks input/binding digests and engine inventory, and waits for observed child
exit on success and cancellation. Production limits are 64 KiB input and 16 KiB
result; no key, storage or network broker is supplied.

[Actual Electron qualification](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-own-txid-2026-10-03.json)
passes eight synthetic cases in 1,666 ms, with 37 matching source hashes. Transfer,
unshield and archived-unshield pass. A wrong-value commitment passes the structural
matcher but fails real preimage verification; changed sibling, TXID, leaf and row
also refuse. Three positives use synthetic single-row TXID trees and structural
transaction proofs/ciphertexts; this verifies supplied-evidence consistency, not
transaction proof validity, real inclusion or a service-accepted root. All source,
canonicality/finality, metadata-continuity, POI and spending flags stay false.

The combined four-fixture output initially exceeded the qualification's copied
64 KiB result cap. Only that fixture-output cap was raised to 128 KiB; production
limits remain unchanged. The final native report uses the corrected fixture and
records no live query or submission. Codex independently checked all eight cases,
source hashes and scope limits. The final matcher/verifier and related tests pass
192 cases across five suites; lint is clean. The ten targeted matcher regressions
fail when the metadata/archived-anchor fixes are removed in memory.

Authenticated account/journal/source capture, fresh root composition and ordered
spent-input/output POI preparation remain next. The detached result does not mint
an account capability or permit POI disclosure.


## Full regression

The frozen tree at `ecb3033f` passes 9,326 tests / 33 skipped across 438 passing
suites in 293.753 seconds, retaining the existing OpenLV exclusion. An earlier
sandboxed attempt was stopped after native Electron/node startup failures; the
successful run used native-process access. No production, fixture or test files
changed between attempts. Main remains current at `b18d571b` after a fresh fetch.
