## Latest milestone: recovered change remains spendable after restart - October 5

Both Shield-origin and received-Transact histories now pass the complete two-process lifecycle: partial withdrawal, durable combined POI attempt, change scan and disposable list acceptance; then a fresh process restores the encrypted profile, makes a second withdrawal through the fixture review callback and scans its result. **All eight native processes passed**, including four unchanged-mode compatibility runs, on the same 902-file source inventory at `4ab31ac1`. External chain, receipt, finality and list responses remain simulated; this is not a live private withdrawal.

Each resumed process records 28 controlled utility exits, eight storage-worker exits and seven credential loans, with required wiping and no new combined POI POST or automatic resend. The selected change becomes spent; unrelated notes remain and unspent value falls by exactly the change amount. The nested terminal-only restart flag remains false intentionally: the outer two-process qualifier establishes the process boundary.

Main at `cec2eb79` is merged, with journaled-send single-attempt behavior preserved. Bundled nodes were explicitly refreshed: Ant 0.5.58, IPFS 0.4.3, Radicle 0.7.1 and Myotis 0.1.12 plus its supervisor. Arti remains verified at 2.6.0. Post-merge focused checks passed 251 tests/14 suites plus 199 merge checks/five suites; full lint passed. The older 15,731-test full regression is historical evidence for `c5d75f05`, not a current merged-tree claim.

Compatibility caveat: older builds refuse the entire retained-POI store after its first combined prepare (version 3).

Still open: cold submission of the second already-proved transaction; original-signature recovery of its interrupted proof; native partial Kohaku facade qualification and a second facade instance spending recovered change; live POI acceptance/private transfer/withdrawal, private broadcasting, portable adapter extraction and UI. No funded profile or live private service was accessed in this campaign. Claude and a separate agent reviewed the implementation/evidence; this is engineering review, not an external security audit.

Pinned review entry points at `7fac37222ac9443c00f8ea6d91b4e896c1cf1868`:
- [Milestone and exact evidence](https://github.com/solardev-xyz/freedom-browser/blob/7fac37222ac9443c00f8ea6d91b4e896c1cf1868/docs/railgun-connected-change-restart-2026-10-05.md)
- [Main merge and node refresh](https://github.com/solardev-xyz/freedom-browser/blob/7fac37222ac9443c00f8ea6d91b4e896c1cf1868/docs/privacy-main-sync-2026-10-05.md)
- [Complete roadmap](https://github.com/solardev-xyz/freedom-browser/blob/7fac37222ac9443c00f8ea6d91b4e896c1cf1868/research/privacy-roadmap.md)
- [Previous terminal-ingestion update, preserved verbatim](https://github.com/solardev-xyz/freedom-browser/blob/7fac37222ac9443c00f8ea6d91b4e896c1cf1868/docs/privacy-progress-history-2026-10-05-terminal-ingest.md)

The earlier research and implementation history follows unchanged.

---

