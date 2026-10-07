# Enrolled live event coverage — October 3, 2026

[The completed report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-live-event-coverage-2026-10-03.json)
qualifies the current enrolled public/TXID/wallet composition through block
11,833,631. Source acquisition used managed Tor and one RPC provider, Sentio.
The public generation reconstructed 10,245 commitments, 5,635 nullifiers and
2,549 unshields. Its root matched the provider's anchored contract read.

The new public generation resumed across four refused runs before run `e`
completed. Runs `a`, `b` and `d` stopped with `RAILGUN_SCAN_COORDINATOR_REFUSED`
at retained checkpoints 4,799,999, 8,299,999 and 10,339,999;
run `c` refused while opening public state. Run `e` resumed from 10,339,999. The failed runs remain local evidence.
No directory, vault or historical state was replaced. Source hashes remained
unchanged throughout the successful run.

The enrolled TXID mirror acquired all 4,230 service rows across 43 pages,
with three identical cold reopens. The guarded comparison checked every mirrored
row against complete public Ethereum transaction groups: 4,230 rows in 4,119
transactions, no discrepancy, no unchecked rows beyond the boundary, and no
unindexed tail. Comparison took 8.981 seconds. The one precisely pinned omitted
call at block 11,816,741 remains reported. Global TXID completeness is therefore
still false; the wallet never repairs the service tree to hide that omission.

The latest mirrored root is
`0x17a4f2743ea1be1c9560f9c4ac55030916860d9c2784b0cf3df58cfef637e7da`.
After TXID workers drained, the enrolled wallet completed its scan and reported
zero asset balances. These results are consistency checks against unverified
RPC and indexer data, not independently verified canonical chain history.
The coverage check does not verify bound parameters or unshield commitment
hashes, issue per-note TXID witnesses, prove ownership to a POI list, or grant
spending. Circuit isolation was not independently observed.

This report is the pinned pre-funding-operation baseline used by the bounded
[live shield controller](railgun-funded-qualification-2026-10-03.md). It contains
no shield submission. New funded notes require a later finalized public scan,
wallet recovery and their own POI/provenance evidence.
