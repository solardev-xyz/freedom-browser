# PPv2 empty ASP sets and resumable relay recovery

Date: 2026-09-27. This continues the [native withdrawal milestone](ppv2-native-withdrawal-2026-09-27.md). Controlled development scope only; production remains disabled and no live funds were used.

## Empty association set

The isolated SDK builder now normalizes the empty Merkle root to the same 32-byte hex encoding used by the pinned SDK's RPC interactor. Previously `0x0` and padded zero failed a string comparison, leaving an active note's status unchanged. The real SDK now demotes that note to rejected when the verified association set is empty; withdrawal preparation refuses it and restoration works when membership returns.

The change is a build-time compatibility correction in `scripts/spike-ppv2-process.js`, identified as `empty-asp-root-v1` in its report. It replaces exactly one expected statement in the already pinned SDK and refuses unexpected source. The upstream checkout, application dependencies and proof artifacts are unchanged. This is a local correction, not a claim that upstream has merged a fix. Existing root-mismatch and nonempty-set revocation checks still pass.

## Durable bounded discovery

Each relay observation reads at most one 5,000-block page, capped at 2,048 logs. An empty successful page saves `{nextBlock, blockHash}` in the existing encrypted journal with the observation and revision, atomically. Main retains recovery ownership; no renderer API or top-level package boundary changed.

Before resuming, the prior boundary must still match the RPC response. Each new page's end block is read before and after the log query. Changed or regressed boundaries reset discovery or prevent advancement. RPC failures, invalid/oversized results and concurrent stale updates cannot move the checkpoint. A page reaching the current finalized tip remains unresolved; elapsed time or lack of logs never releases the reservation.

Once an inclusion has been located, subsequent reconciliation checks that exact block and repeats the existing receipt, event, note digest, processor and spent-nullifier checks. It no longer needs to scan every intervening block simply because the wallet was offline. Missing or changed evidence still revokes approval. A later observation can restart paginated discovery if inclusion is lost.

`observeRelayAttempt` returns the journal record, including progress in `scan`. A main-owned coordinator can call it again to continue; one call does not create an unbounded background scan. `resolveRelayAttempt` still requires inclusion, explicit acceptance of **unverified RPC evidence**, and another observation after review. Checkpoint hashes establish response consistency, not cryptographic canonical-chain verification.

## Qualification

- Source Electron: the expanded real-SDK withdrawal flow passes.
- The fixture places withdrawal inclusion 6,000 blocks after preparation and advances another 6,000 before recovery. It saves an empty-page checkpoint, terminates Electron, resumes in a new process, recovers change and completes a second spend. Reorg refusal and re-discovery remain covered.
- Unit coverage adds resumable range boundaries, historical inclusion rechecks, checkpoint reorgs, RPC/oversize/page-boundary failure, finalized-tip behavior and concurrent observers.
- Full regression: **5,688 passed, 33 skipped, the same 3 baseline failures** (two macOS shortcut-remap cases and the Safe fork integration case).
- Packaged results, candidate/compatibility hashes and source-byte comparisons are in [the qualification report](qualification/ppv2-resumable-recovery-2026-09-27.json).

Reproduce with the existing scratch SDK builder and `test-e2e/ppv2-withdrawal.spec.js`; see the previous milestone for environment variables. Logs use `/private/tmp/ppv2-recovery-*`. No public/private wallet traffic or production endpoints are involved.

## Remaining work

The former 5,000-block total recovery horizon is removed; the bound now applies per observation. The 64-attempt development ledger cap and per-page log cap remain. A provider that cannot serve a page still blocks progress; there is no automatic retry fan-out or silent truncation. Failed/replaced transaction resolution and history compaction need their own rules and tests.

The next protocol expansion is ERC-20 approval/deposit qualification, followed by broader withdrawal/transfer shapes. Quote-signature verification, final identity constants, audit/deployment matching, chain-state provenance, platform/egress qualification and product UX remain separate gates. No dependency upgrade or UI decision was required for this milestone.
