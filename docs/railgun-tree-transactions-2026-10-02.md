# Railgun persisted trees and atomic write groups — October 2, 2026

The engine's separate node, commitment and metadata writes can leave a mixed tree after failure, despite each SQLite batch being atomic and authenticated. The new development bridge stages a complete UTXO write group, then publishes it through one host-owned SQLite transaction. It does not enable a product adapter or qualify full-history scanning.

## Reproducer and measured capacity

[The process report](qualification/railgun-tree-transactions-2026-10-02.json) records fresh Node children with the authenticated engine 9.6.0 fixture. Synthetic leaves contain only a deterministic hash and block number. Root validation compares an independently reduced synthetic reference tree using the same pinned Poseidon primitive; it never accepts arbitrary roots or skips validation. No live contracts, funded profiles, spending keys, wallet decryption or POI are involved.

The original path produces these observations:

- 32 and 256 leaves persist successfully. A new process reconstructs the exact expected root and a membership proof for the last leaf, and reads its commitment.
- A 512-leaf insert emits **1,040 node operations**, exceeding the host's 1,024-operation limit; the frame is only 623,010 bytes. The engine writes more nodes than a minimal-path estimate, so the report's measured count is authoritative.
- Appending leaves 32–63 writes 81 nodes, 32 data records, then one metadata record. A SQLite failure in the data batch leaves nodes for 64 leaves with metadata/data for 32. Failure in the metadata batch leaves nodes/data for 64 with metadata for 32. Both stores authenticate when reopened.
- In those failure states, the engine can return a mathematically consistent proof for position 63 even though its published length is 32. Proof and root APIs can expose nodes beyond that frontier. Consumers must enforce position, completeness and root-history checks; a valid proof alone is insufficient.
- Explicitly asking the cold tree to count its stored commitments costs one iterator round trip per row (257 `next` calls for 256 rows). This count was requested by the probe; normal metadata-based startup did not enumerate the tree.

The slow scanner appears able to replay an interrupted group when storage failures remain fatal and its synced-block cursor has not advanced. The reproducer does not qualify that scanner recovery path. Quick sync remains refused; its skipped root-validation behavior must not be used to bypass host verification.

[The separate volume measurement](qualification/railgun-tree-volume-2026-10-02.json) uses a bounded fixture-only plaintext Map. Direct insertion visits 1,000, 10,000 and 70,000 synthetic leaves, crossing the 65,536-leaf tree boundary. This is neither an RPC/log scan nor a wallet scan, and its new tree wrappers are cold caches, not process restarts.

| Total leaves | Stored keys | Plaintext key/value bytes | Observed RSS      |
| ------------ | ----------- | ------------------------- | ----------------- |
| 1,000        | 3,017       | 1,328,984                 | 175,603,712 bytes |
| 10,000       | 30,015      | 13,226,142                | 272,580,608 bytes |
| 70,000       | 210,032     | 92,553,347                | 783,400,960 bytes |

The largest node batch contains 20,021 operations; the namespace clear deletes all 210,032 keys in one call and is larger still. Peak batch overlap is two and peak live iterator count is one in this workload. Real commitment ciphertext, annotations and memos are absent, so byte sizes are lower-bound synthetic measurements. These timings/RSS values include the fixture backend and reference-root calculations and are not product benchmarks. They establish that the existing 65,536-key / 32 MiB whole-map store needs replacement, not a larger advertised limit. Namespace classification of private wallet records remains separate research; this experiment contains public synthetic UTXO data only.

## Implemented transaction boundary

`railgun-session.js` keeps staged plaintext in main, under the same revocable storage/RPC lifetime. `txBegin`, `txStage`, `txCommit` and `txAbort` admit one group, capped at **32,768 operations / 16 MiB decoded key/value bytes / 30 seconds**. Frames retain the existing **1,024-operation / 2 MiB** bounds. Only commit invokes `store.batch`; node/data/metadata records and the authenticated manifest therefore change in one SQLite transaction. Abort, lock, timeout or protocol/storage failure wipes staging. No disk format or existing store-capacity limit changes.

The group has exclusive storage access. Untagged reads/writes, iterators and clears fail closed while it is open. Tagged `txRead` permits only bounded point/multi-key reads of committed keys that have not been staged; duplicate staged keys are refused. RPC remains available so polling does not collide with a tree write. RPC failures remain fatal under the existing policy. Staging buffers and the encoded child queue are separately bounded; the decoded-byte ceiling does not equal total process memory.

`railgun-remote.js` captures an AsyncLocalStorage group at write invocation and tags reads before FIFO admission. It starts the host transaction at the first write, after any engine update-lock wait. The child exclusive scope starts earlier, at wrapper entry, so unrelated storage calls are already fatal during that lock wait. Concurrent node/data batches can interleave bounded frames, but all their promises must complete before commit. Late writes from a completed scope fail. Tagged reads await an in-progress begin rather than escaping untagged. A callback error aborts the group and closes the local bridge; the process owner remains responsible for revoking host authority and observing exit.

`railgun-tree-transactions.js` binds that operation to the exact engine 9.6.0 `Merkletree.prototype.writeTreeToDB` function, SHA-256 `c448db4b9f802f66876146bb8df1f2bbf26e6a03ac47903714ad236dfc09f88f`. The full authenticated fixture inventory pins its metadata/path helpers and subclass hooks; the function hash alone does not. This wrapper admits only Sepolia UTXO V2 and refuses TXID/V3/other chains. TXID lookup writes outside this method need their own qualification. Nothing installs the wrapper in an enabled product runtime.

## Failure qualification and remaining gates

All 53 fresh-child cases pass. The atomic path admits the previously refused 512-leaf insertion, while four synthetic RPCs run sequentially between its stages. This process case exercises host acceptance during an open transaction; polling from an unrelated async context is separately covered by a child-bridge unit test. Fresh processes verify the complete persisted root, length, row count and commitment. The append fault matrix interrupts each of three staged frames, injects SQLite errors at node/data/metadata insertion inside commit, and kills the child before commit. Every fresh inspection observes the complete old frontier; replay and another cold inspection observe the complete new frontier. Killing after commit but before its acknowledgement observes the complete new frontier. Harness interruptions are recorded separately from actual broker refusals; they are not evidence that a rejected dispatch occurred. The process report checks actual SIGKILL for the two kill cases.

The host/remote unit suites cover staged visibility, snapshots, durable rollback, timeout, limits, duplicate keys, wrong transaction IDs, untagged/staged-key read refusal, frame sizing, scoped writes and concurrent RPC. All [13 original Electron supervisor scenarios](qualification/railgun-electron-transactions-2026-10-02.json) pass against the extended broker, but the new atomic tree workload itself is a Node-process qualification. The host/remote suites pass 56 tests. Final regression passes **6,991 tests / 33 skipped** across 334 passing suites, with **six OpenLV tests separately**; lint and scoped formatting pass. Claude accepted the protocol changes, measurements and failure evidence after review-driven corrections to polling, read isolation, duplicate keys and interruption reporting. This is engineering review, not an independent security audit.

Before any live scan or balance claim, remaining work includes:

1. A disk-backed full-history layout, bounded pages/iterators and atomic namespace clears; representative shield/transact records and memo sizes; performance/recovery qualification beyond this synthetic tree.
2. Scanner/wallet scheduling around exclusive write groups. Concurrent untagged storage work currently fails rather than queues. Cache-only engine APIs are outside this protocol; main must own completeness and frontier publication and reject positions beyond it before proof/balance use.
3. Pinned metadata/synced-block interpretation in main, canonical finalized anchors, independently constrained RPC arguments and contract-root checks, and complete/retryable log acquisition. An empty or partial scan cannot be advertised as zero balance.
4. Actual Electron atomic-tree workload and cross-platform packaging; real log ingestion, reorg handling, scan replay, TXID/POI and root-source qualification. The 16 MiB group limit is provisional, not proof that real 10,000-leaf batches fit.
5. Current Kohaku balance/notes semantics, independently approved operation-bound signing and existing dependency/licensing/release gates.

Storage failures stay fatal. The upstream write-queue retry behavior and zero-on-error node reads make process termination and independent liveness/frontier checks necessary. Mainnet and UI activation remain disabled.
