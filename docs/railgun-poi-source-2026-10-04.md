# Railgun combined POI source evidence — October 4, 2026

Creator extraction and completed-transaction source comparison now share one
full authenticated ledger visit and one snapshot receipt. Both unchanged collectors
register their visitors synchronously and wait on the same completion promise.
If either refuses before registering, the shared promise is rejected and both
collectors settle without starting a visit. Resource failures propagate through
the real coordinator; ordinary semantic refusal and local cancellation drain it.
No partial observation is returned.

The main-only combination normalizes the capsule and compares its complete prepared
transaction binding with the journal record. It also requires the creator to occur
before the completed transaction by block and transaction order. Both observations
must have the same checkpoint and source. The wrapper sets the top-level and both
nested source-authentication flags only after genuine enrolled snapshot attestation.
The opaque receipt shares the snapshot's expiry, revocation and generation binding.
This avoids the stale-receipt problem caused by taking two sequential snapshots.

These are consistency and retained-byte checks. The capsule still needs genuine
account capture; the Shield hash still needs utility verification; Transact inputs
still need their creating-TXID provenance and reconstruction. No ownership, current
canonicality, finality, POI membership, spending or disclosure authority follows.
All association data remains private. The existing single-purpose wrappers remain
unchanged. Main-wallet ownership, dependencies, policies, renderer and IPC are unchanged.

## Evidence

Four native runs use actual disposable enrollment, encrypted stores and the
production public coordinator with structural synthetic history:

| Operation / creator | Report | Time | Completed source visits |
| --- | --- | ---: | ---: |
| Transfer / Shield | [Report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-poi-source-transfer-shield-2026-10-04.json) | 2,026 ms | 9 |
| Transfer / Transact | [Report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-poi-source-transfer-transact-2026-10-04.json) | 1,944 ms | 9 |
| Unshield / Shield | [Report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-poi-source-unshield-shield-2026-10-04.json) | 1,926 ms | 8 |
| Unshield / Transact | [Report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-poi-source-unshield-transact-2026-10-04.json) | 1,890 ms | 9 |

All match 142 source hashes. Each passes eight scenario groups: ordinary capture,
later-snapshot revocation, three early refusals without a source visit, own-source
semantic refusal and recovery, creator refusal and recovery, cancellation and
recovery, injected post-visit integrity failure, and store reopening within the
same process. Ordinary capture performs exactly one source visit. Each run records
132 simulated block/header requests, two simulated log requests and zero external
transport attempts, live queries or submissions. Reports omit private payloads,
origins, roots and association digests.

The final controls distinguish specific checks: an independently valid capsule
for another prepared transaction refuses against a coherent original journal/receipt;
a transfer selecting its own output reaches and fails temporal composition; an
out-of-checkpoint Shield selector refuses before visiting; a mismatched Transact
creator hash refuses after the visit. Earlier native runs demonstrated refusal but
did not isolate all these checks, so the final reports above supersede them.

Seventy-seven tests across four suites pass, including refusal before either
visitor registers, resource failure, no partial result, and aggregate revocation
after both collectors fulfill. Claude approved production and native evidence;
Codex approved the corrected tests, all four final reports and prose. Lint is clean.
The frozen full regression passes 9,665 tests / 33 skipped across 455 suites in
301.268 seconds with native-process access and the existing OpenLV exclusion.

Next: compose this receipt into account-bound post-transaction preflight, then
controlled viewing-only proving, current membership, final account/source/root
checks and disclosure. No live owned-note query or private spend occurred.
