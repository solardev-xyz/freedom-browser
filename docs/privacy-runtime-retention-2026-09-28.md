# PPv2 runtime integrity and reviewed history retention

This continuation follows the [independent branch review](privacy-review-fixes-2026-09-28.md). All new capabilities remain main-only, development-gated and Sepolia-only. No renderer flow, IPC channel, dependency or production activation is added.

## Runtime identity

`ppv2-runtime` verifies the complete packed SDK archive against a source-controlled size and SHA-256 before loading its plugin. It checks candidate revisions and the compatibility-patch digest, then issues an immutable candidate whose identity is tracked in a WeakMap. Sessions refuse caller-constructed candidates or proving paths from another archive. Each of the three proof jobs verifies the archive again before requiring SDK/prover code.

The experimental archive is 46,915,303 bytes with SHA-256 `ce18c67a40fa0c72593bb1e851a995951afe7371b0ddd88dfee16d1ffa8e2cb7`. It contains the already-qualified SDK, patched Kohaku plugin, nested worker dependency, serial prover, circuits and synthetic qualification helpers. The pin authenticates selected bytes, not an audited release, reproducible build or redistribution permission. Plugin code still receives main-process authority; hashing does not reduce that authority.

Symlinks at the archive path, non-files, size/digest mismatches and unpacked sidecars are refused. Verification uses Electron's original filesystem API to hash the actual container and bigint file identifiers. It does not protect against a privileged concurrent filesystem writer or compromised main code. Node/Electron caches may predate a verification; application callers must use the loader rather than directly preloading external entries. Production distribution still needs immutable signed resources or an equivalently reviewed installation design.

`scripts/inspect-ppv2-runtime.js` records archive structure, candidate identity, module digests and literal imports without executing SDK code or changing the pin. It rejects unpacked entries, links, native addons and discovered external module specifiers. Literal import inspection is a review aid; computed imports and behavioral authority still require source review. The current pinned exposed module graph has been independently inspected by Claude.

## Retention contract

The previous 64-entry journal limit could eventually prevent further operations, including a public emergency exit. Both journals now support explicit archival of an old, resolved prefix. Archival is never automatic.

- At most **64 live records and 1,024 permanent tombstones** per journal. A batch contains at most 16 records.
- Only resolved records at least 24 hours past their resolution review qualify. Relay records must contain settlement metadata. The age is a local-clock policy delay, not chain evidence.
- The host reads latest/finalized heights and brackets the recorded canonical block and finalized anchor. It repeats the checks after review. Missing, unavailable or lagging evidence writes nothing. A confirmed canonical conflict revokes the existing resolution and archives nothing.
- The review explicitly states the record count, block range, finalized anchors and that these records will no longer be revalidated. Acceptance requires `archiveResolvedHistory: true`, `stopRevalidating: true` and `acceptedEvidence: 'unverified-rpc'`.
- Every selected revision and the live-prefix position are compared again in the atomic storage update. A stale review, changed anchor, lifetime cancellation or expired deadline cannot commit later.
- Public tombstones retain exact hashes and monotonically increasing nonces. Relay tombstones retain exact attempt IDs, nullifiers and commitments. Reuse checks cover live and archived state together. Emergency-exit preparation and submission also refuse a commitment already resolved or archived by the relay journal.
- Successful session archival closes that session and reports `sessionClosed: true`. Reopening reconstructs state, invalidates old prepared operations and starts a fresh bounded set of operation contexts.

**The trust tradeoff is deliberate:** archived records stop automatic revalidation. An honest RPC encountered later cannot contradict a resolution accepted from an earlier dishonest RPC through that retired record. Finality claims, two bracketed observations and the age delay do not remove this risk. Reuse guards remain permanent; old detailed reconciliation metadata is compacted away. There is no restore-to-live or unarchive flow yet.

Both evidence passes and the human review share a maximum 120-second deadline. With up to 16 records and five RPC calls per record per pass, slow Tor/service responses or changing finality can require retrying a smaller batch. No partial batch is archived. Actual archival latency remains a live-qualification item. A long-lived session can also reach the existing 256-context limit before archival; closing and reopening is required.

The archive has a permanent bound, not unlimited capacity. Once no archival room remains and all 64 live slots are occupied, further sends—including the public transaction used for in-app ragequit—remain refused. No record is silently evicted. Portable backup/migration and a policy beyond this bound remain release work. Archival also queries historical block heights in a burst, retaining the documented RPC timing-correlation risk.

## Storage and compatibility

Archival moves records and tombstones together within one authenticated encrypted storage value and one atomic file replacement. The existing profile inventory continues to cover the same files; there is no separate archive file or crash window between two keys. Unresolved state is never compacted. Whole-profile rollback remains undetectable without an independent trust root.

Version 1 is readable. Any new journal write produces version 2, even before the first archival; version 2 is never downgraded. **This is a one-way experimental state-format migration:** older branch builds refuse these journals. The application does not silently reset them. Qualification uses disposable profiles, not existing user funds or profiles.

These modules remain in `src/main/wallet`, which already owns privacy storage, SDK boundaries and transaction policy. No module responsibility moves between main, renderer, identity or network layers.

## Validation and remaining gates

Validation uses synthetic keys and controlled services. The real Electron integrity scenario proves successfully, then mutates a copy of the archive and observes rejection in main, for a previously issued candidate, and in the utility process before proving. Withdrawal qualification uses the authenticated archive plus main-only pass-through instrumentation for synthetic ASP labels; it does not claim protection against compromised main code. The separate raw-source derivation spike explicitly substitutes the validator and reports that runtime integrity was not tested there.

The tightened negative scenarios require specific host refusals for an inactive note, reorged relay evidence and insufficient/excess token allowance, with no unintended send or reservation. Retention tests cover capacity past 64 total operations, permanent reuse/exit guards, prefix and revision races, interrupted writes, legacy migration, archive bounds, unavailable/conflicting evidence and cancellation.

Implementation is committed as `bfa75b22ec0c68646ecf7ee5ad3f46178545ec79`. The [qualification record](qualification/privacy-runtime-retention-2026-09-28.json) preserves the test reports, pinned runtime inspection and source/package digests. Full lint is clean. The full unit regression has **5,834 passed, 33 skipped and the same three baseline failures** (two macOS shortcut-remap cases and one Safe fork case). Claude independently ran 239 related tests, then reran the final 53 retention/session tests after hardening; these counts overlap.

The final unsigned macOS arm64 package passed **all 11 checks in one run**, with no skips, failures or flaky outcomes: the nine existing PPv2 scenarios, runtime integrity and package preflight. Every one of the 54 changed main-process modules matches its committed blob. Claude also independently compared all 640 packaged `src/` files with the commit. The [reviewer-owned report](../research/privacy-runtime-retention-review-2026-09-28-reviewer.md) records findings, accepted limitations and final closeout. Earlier source checks were incremental; the packaged run covers the committed code together.

Production remains disabled. The [live qualification handoff](ppv2-live-qualification-prerequisites.md) records the exact upstream information and test sequence still required. Backup/recovery UX, final identity and deployment/audit provenance, full-value withdrawals/private transfers, realistic Tor timing and supported-platform containment remain open.
