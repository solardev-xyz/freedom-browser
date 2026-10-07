# Railgun second-spend wallet ingestion — October 5, 2026

This extends the connected second-spend checkpoint at ea63ff6053f3179da6fdf000066053aa833b6af2. It is fixture/documentation work; production and dependency bytes remain unchanged.

The optional `second-spend-ingest` mode appends the actual captured second full-unshield to the existing simulated public history, authenticates the entire prior TXID prefix, advances the genuine public coordinator and existing TXID mirror, then performs an ordinary wallet scan. The scan must mark the selected change spent by the second transaction while preserving all other received notes, private records, retained POI state and resolved EOA records. A full unshield creates no private output, so the existing UTXO root and length remain unchanged.

The actual public-vector account contains unrelated unspent WETH. Shield-first starts with an eligible 2,000 input and an unrelated 700 note; its partial withdrawal creates change of 1,000. Transact-first starts with an eligible 700 input and an unrelated 2,000 note; its change is 350. The terminal assertion preserves those unrelated notes and proves total unspent WETH falls by exactly the selected change amount. It does not claim the whole wallet becomes empty.

The first native Shield-a attempt refused before the second reservation/signature/send because the fixture incorrectly required exactly one unspent WETH note in the whole wallet. Existing first-change qualification had already verified that the selected original input was spent. Code review traced the failed assumption to the source vector's additional owned note; both the pre-spend and terminal balance assertions were corrected, with positives for both histories and negatives for changes to unrelated notes. Production checks were not relaxed. The failed run remains a diagnostic.

After the correction, 158 tests across ten focused suites pass in 8.218 seconds and full lint passes. A detached guard-removal control establishes that the isolated second-capsule nullifier mismatch test reaches that exact guard. Earlier tests and the initial wrong-filename root test invocation remain diagnostic history; test counts overlap and are not added.

| Case | Time | Utility children | Storage workers |
| --- | ---: | ---: | ---: |
| Shield-first terminal ingestion | 99,085 ms | 316 | 33 |
| Transact-first terminal ingestion | 105,041 ms | 359 | 36 |
| Shield second-spend compatibility | 97,197 ms | 306 | 31 |
| Shield change-only compatibility | 89,402 ms | 295 | 28 |
| Shield default compatibility | 84,531 ms | 289 | 25 |

All five runs share 868 exact source hashes. It retains the original twenty
connected groups and separate second-spend section, then adds terminal ingestion.
The terminal delta is exactly ten utilities: one row projector, two public jobs,
six TXID jobs and one wallet scanner. Two storage workers close and one viewing
loan is returned. The new work uses 25 protocol headers, one logs query, four
latest-TXID queries, three root validations and one indexer page. No additional
private signing/proving, POI POST or EOA signing/send occurs during ingestion.
Every utility and storage exit is observed. The only two deliberate revocations
remain the earlier wrong-output controls; other utilities close normally with
exit code 15, while storage workers exit 0. Three observed storage-key copies
are wiped and transport wrappers have no pending work.

Public/TXID advancement can legitimately update its stores and metadata.
The separately measured wallet phase changes exactly wallet/coverage and its
journal, preserving all other filenames and bytes within the account-parent and
profile-inventory scope. EOA records are compared logically, not as a whole-vault
file snapshot. The first attempted POI entry, its two reserves and encrypted
bytes remain unchanged through terminal work.

The [evidence index](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-terminal-ingest-integration-2026-10-05.json)
records source inventories, byte-exact raw reports, command templates,
diagnostics and independent audit. Runtime/input captures are referenced by
local path and hash, not bundled as a standalone reproducer.

The nested `secondSpend.secondSpendIngestedIntoWallet:false` describes the earlier helper's boundary before terminal scanning. The separate `terminalIngest` result and outer `secondSpendWalletIngestionQualified` are only successful after the additional scan and all preservation/drainage checks finish.

All chain observations, finality, external services, list trust and review callbacks remain simulated. No funded profile or live service is used. The connected sequence remains within one OS process; genuine restart, cold second proof recovery/submission, partial Kohaku facade integration, live private qualification, private broadcasting and portable adapter extraction remain open. Historical regression counts retain their original source snapshots.

Claude and independent Codex agents reviewed implementation and evidence; this is engineering review, not an external security audit.
