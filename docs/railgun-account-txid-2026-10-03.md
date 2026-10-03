# Enrolled Railgun TXID mirror, 2026-10-03

The main process now composes the TXID runner, encrypted journal and live root
validator with an enrolled account. The caller supplies an authenticated public
coordinator and the pinned engine archive. The composition acquires its own
public indexer pages and POI-node root observations through managed Tor; callers
cannot inject rows, roots, service URLs or storage keys. It exposes bounded
advance, diagnostic inspection and closure, with no spending or witness grant.

Each active public generation can retain eight TXID policy versions. A version
uses `txid-<policy>.sqlite` and a separate encrypted journal whose operation is
`railgun-txid-v1:<policy>`. Keys are separated by purpose, public generation ID,
authenticated public store ID and TXID policy. The store binding is also
separated from the ordinary account store binding. The profile inventory tracks
both initialized files. Old files remain in place when a new TXID policy selects
a new mirror, without rebuilding unchanged public history.

The policy pins TXID computation, persistence, service normalization and root
validation sources plus the authenticated engine inventory. The filename and
journal operation must match that exact policy. The eight-policy allocation
limit includes policies found in interrupted staging files; each policy also
has the existing eight-initializer limit. This deliberately bounds failed
allocation attempts as well as successful mirrors. Each completed version adds
two inventory entries, within the existing 4,096-entry inventory limit.

Wallet and TXID lifetimes exclude one another. The source and public workers
remain open, while either wallet or TXID owns the third slot. Revocation alone
does not release the phase: outstanding compute work and the storage worker
must finish first. A late worker arriving after public revocation is closed and
drained. The existing three-worker limit remains unchanged.

Opening revalidates a checkpoint against a fresh live root or recovers its
pending page. Advancement fetches at most 100 rows, bounded by the service's
validated index and the qualified 8,000-row storage capacity. It projects the
page, obtains root acceptance, refreshes the projection receipt and records
the pending write before applying it. It then refreshes root acceptance and
replays the page idempotently to obtain a fresh compute receipt before completing
the journal. This ordering handles a root request taking longer than the
60-second receipt lifetime. A still-too-slow or failed operation closes the
lifetime and leaves durable recovery state.

At capacity, the diagnostic reports `capacityReached` and the last observed
service index. It does not silently widen storage limits. A service advancing
beyond capacity still permits syncing the supported prefix.

Tests cover policy and key separation, inventory names, retained allocation
bounds, both pending-store recovery states, slow root acquisition, phase
exclusion in both directions, in-flight cancellation and late-worker closure.
Claude reviewed the implementation, qualification harness and recovery tests.

The [live scan qualification](railgun-live-scan-2026-10-03.md) establishes the
public and wallet acquisition baseline. The optional TXID phase in
`scripts/qualify-railgun-live.js` additionally checks live roots for each enrolled
page, cold reopens after two early pages and at the final checkpoint, then closes
TXID before opening the wallet again. Each open, advance and close has a
qualification-only ten-minute watchdog.

The [enrolled live run](qualification/railgun-account-txid-live-2026-10-03.json)
passed all 43 pages / 4,230 rows, reaching the live service index 4,229 and root
`17a4f2743ea1be1c9560f9c4ac55030916860d9c2784b0cf3df58cfef637e7da`.
Its row transcript matches the earlier independently reconstructed capture.
All three cold reopens preserved the exact checkpoint and store digest. The
enrolled store's 16,932 records / 6,315,819 bytes and content digest also match
both independently created offline storage/journal qualification stores. The
known break at index 4,188 was classified as expected. After the TXID phase
closed, the wallet scan completed at block 11,832,799 with zero assets and
unverified POI. The public root check and all pinned source hashes passed.
No signing or submission was enabled. Final native regression: **8,060 passed,
33 skipped** across 389 passing suites; lint passed.

Independent event coverage, account POI, operation-bound proofs and funded flows
remain separate work. The known TXID service omission remains explicitly
classified. Root acceptance and encrypted persistence do not establish global
TXID completeness or spendability.
