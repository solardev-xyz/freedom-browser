# Railgun Sepolia public history and restart qualification

This continuation moves from synthetic trees to the public Sepolia deployment’s actual event history. It reconstructs the captured commitment tree, corroborates event-block hashes and bloom membership using two RPC services, and exercises ordered recovery in the pinned engine and encrypted storage worker. It does not yet grant a wallet balance, note list or spend operation.

The committed [capture manifest](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-sepolia-logs-2026-10-02.json), [header report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-sepolia-headers-2026-10-02.json), [offline history report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-sepolia-history-2026-10-02.json) and [19-run recovery report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-history-replay-2026-10-02.json) record the evidence and source hashes. History links to the header report by SHA-256; headers and replay link to the exact capture manifest and canonical log digest. All recorded source hashes match this checkpoint. Raw log pages and header JSONL remain local, with their digests in these reports.

All **19 Node/worker runs pass**, including five acknowledged crash boundaries, independent restore/cold comparisons against a three-chunk reference, and complete **49-chunk** history plus cold readback. The full continuation from three already applied chunks took **71.2 seconds**, and cold full readback **14.9 seconds** on this Mac; one run each, not a general latency guarantee. The final encrypted database is **29,188,096 bytes**. Full regression passes **7,438 tests / 33 skipped across 348 passing suites**, plus 59 focused capture/header/history cases within that total; lint passes. Main remains at already merged `495aa3d8`, with its pinned nodes refreshed. Claude reviewed implementation and evidence as engineering review, not a security audit.

## Captured deployment and event history

The [deployment capture](railgun-sepolia-deployment-2026-10-02.md) fixes Sepolia block **11,829,346**, hash `0xbac192ba1a044d54ba19764c6e48eadb0b6a46e0a7631d32fa3c3236cbcc7065`, and proxy `0xeCFCf3b4eC647c4Ca6D49108b311b7a7C9543fea`. The new capture reads from genesis through that anchor using direct HTTPS to Sentio and Tenderly. Every range must agree on all normalized proxy logs and both range-boundary hashes. Provider disagreement, malformed data or a changed final anchor is terminal. This is an intentionally direct public-data experiment, not network-anonymity evidence.

The capture contains **14,822 logs in 119 contiguous ranges**, occupying **19,889,554 bytes**. Its canonical log-set SHA-256 is `5ea1a7c8f307dcae2f8bbec85200410392b14d1db356f8b2b7d396e656c9d10c`. Raw pages are retained locally; their individual digests and total byte count are in the committed capture manifest. They are not bundled in the repository. The commands below recreate the input through public RPC, subject to historical-data availability. Recreated observations/timestamps may change manifest hashes; the canonical log digest is independent of pagination.

The source-configured scan start, **5,784,866**, is later than the first captured proxy event at **5,784,776**. That does **not** mean it misses shielded commitments: the first Shield is at **5,944,769**, and the first Nullified, Transact and Unshield are at **5,963,806**. It misses earlier governance and verification-key events. Genesis acquisition avoids silently treating that source value as a proven deployment boundary.

| Event | Count |
| --- | ---: |
| Shield | 4,333 |
| Transact | 3,575 |
| Nullified | 4,215 |
| Unshield | 2,546 |
| VerifyingKeySet | 145 |
| Proxy/governance/initialization | 8 |

The strict reader checks bounded nonsymlink files, contiguous genesis-to-anchor coverage, per-page digests, normalized schemas and totals. Every subsequent iterator read rechecks the page digest. Acquisition caps each response at 4 MiB, pages at 4,096 logs, all data at 128 MiB / 100,000 logs / 10,000 pages, and wall time at 30 minutes. Capacity errors split ranges; transient failures retry the same range with bounded backoff. The successful final capture had no failed requests. Error metadata contains classifications and hashes, not arbitrary provider messages.

## What the history establishes

The offline verifier applies contract-derived leaf rules and tree placement, while sharing the authenticated engine’s Poseidon implementation. It also checks each commitment against engine 9.6.0’s own V2 event formatter. **4,525 Shield leaves plus 5,669 Transact leaves yield 10,194 leaves**, and the computed tree-0 root exactly equals the captured on-chain root:

`0x23bbe9f01d6f06e47cffa08b31836ea8ee26c48cb7f959ffd70a5840c7910098`

Shield preimages cover **4,314 ERC-20 and 211 ERC-721 commitments**. There are no ERC-1155 examples in this capture. Synthetic tests cover an underfull-tree rollover, exact fit, empty Shield behavior, gaps, overlaps and invalid rollover. The contract moves a complete insertion to a new tree if it cannot fit; an earlier tree need not have 65,536 leaves. An empty Shield is accepted because the contract emits Shield unconditionally. Empty Transact events are refused because the pinned contract only emits Transact when it adds commitments. This live capture has one tree; future earlier-tree roots also need anchored `rootHistory` checks.

The history has **5,614 unique `(tree, nullifier)` values** and **2,546 unshield events**. Nullifiers must be field elements in an already existing tree. Per Ethereum transaction, nullifier presence must agree with the presence of a Transact or Unshield event. This catches total omission of a transaction’s nullifier events; it does **not** prove individual event completeness when several private transactions share an Ethereum transaction. An omitted whole transaction containing only an unshield can also escape the commitment-root check.

The latest implementation, paused state, owner, treasury and shield/unshield fees match the captured state. Proxy admin has no transfer event in this history and is known from the anchor’s storage-slot read; `nftFee` was not compared. The 145 verification-key events define **91 distinct shapes**. For **three selected shapes** (1×1, 1×2 and 2×2), the latest key event, ABI-encoded, is byte-identical to the anchored contract read. This does not yet bind downloaded proving artifacts to those keys.

**8,459 headers** were corroborated: **8,221 event blocks** and **238 range boundaries**, with **118 boundary parent links**, **14,822 log bloom checks** and **zero failed attempts**. Header corroboration requests every captured event block and range boundary, compares number/hash/parent/receipt-root/timestamp/bloom across both providers, checks each captured event-block hash at its height, checks adjacent range-boundary parents, and tests each log’s address and topics against its block bloom. A final anchor recheck precedes publication of the complete report. Bloom membership is a necessary consistency check with false positives, **not an inclusion proof**. Header hashes are not locally recomputed, receipts are not proved, and provider independence is assumed. Nullifier completeness therefore remains based on provider agreement and the stated consistency checks, not a cryptographic completeness proof.

## Ordered replay and recovery

The replay runs engine 9.6.0 in a separate **Node child**, with empty environment, a 256 MiB V8 heap limit, direct-egress guards and the already qualified trusted storage worker. The engine has no database path/key, wallet material or network route. The explicitly public capture path is supplied to the research job. No RPC requests are made during replay.

Chunks end at complete block boundaries and aim for 256 commitments, 256 nullifiers or 64 unshields, with hard per-block caps. Each chunk writes commitments, then public nullifiers, then unshields, then the engine’s last-synced block, then a replay cursor bound to the capture digest. Prefix roots are independently reduced from captured leaves and checked by the engine’s root-validator callback; intermediate roots are not separately queried on-chain. The final root is anchored as above.

Each tree publication is atomic, but **the whole chunk is not atomic**. A crash can leave commitments ahead of the replay cursor and without their nullifier records. The cursor remains behind, and replay repairs the partial chunk. This is a recovery technique, not permission to show balances during repair. Production balance, note-list and spend-selection capabilities must remain unavailable until a main-owned coverage check establishes that every started chunk is fully applied and canonically anchored. Neither the engine’s last-synced block nor the job’s replay cursor (both stored in the engine database) is such a capability.

The recovery matrix starts from two completed chunks, continues uninterrupted to three as a reference, and independently crashes the third chunk after each acknowledged phase: commitments, nullifiers, unshields, engine scan cursor and replay cursor. Each reopened and subsequently cold store must match the uninterrupted prefix’s records, digests and main-inspected frontier. It then continues through the complete public history and repeats a cold readback. Checks include every commitment, exact nullifier and unshield key sets, every record value, tree length/root and last-synced block. These are acknowledged phase-boundary crashes; crashes inside a tree publication are covered by the earlier [tree transaction](railgun-tree-transactions-2026-10-02.md) and [storage worker](railgun-storage-worker-2026-10-02.md) qualification.

The job deliberately serializes `insertLeaves`, `nullify` and `addUnshieldEvents`. It does **not** exercise upstream scanner scheduling or its concurrent listeners, nor the Electron utility supervisor with this particular real-history workload. A production scan coordinator must enforce serialization and own coverage independently. The engine’s commitment-derived scan resume is insufficient for nullifier/unshield completeness.

Ordinary refreshes must never query unpublished per-note nullifiers at an RPC endpoint: that would disclose values which can link future or aborted spends. The complete public Nullified history is the starting point for spent-note detection. No private-nullifier query, funding transfer, proof, signature or transaction was performed by this work.

## Reproduction and remaining work

The scripts use the approved isolated engine fixture and existing application dependencies; no dependencies were added or upgraded. Use new absolute output paths for each run; incomplete runs retain their files and never publish a completion manifest.

```sh
node scripts/capture-railgun-sepolia-logs.js /absolute/new/capture
node scripts/verify-railgun-sepolia-headers.js /absolute/new/capture /absolute/new/headers
node scripts/verify-railgun-sepolia-history.js /absolute/new/capture /absolute/new/history.json /absolute/new/headers
node scripts/qualify-railgun-history-replay.js /absolute/new/capture /absolute/new/replay
```

Next comes main-owned canonical coverage and scan scheduling, wallet decryption with current Kohaku balance/notes semantics, authenticated artifacts and operation-bound proving/signing, and durable shield/private-transfer/unshield attempts. TXID/POI and broadcaster qualification remain necessary for parity with PPv2’s relayed path. The already authorized Sepolia funds have not been used for Railgun yet. Product UI and mainnet activation remain separate work.
