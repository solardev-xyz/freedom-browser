# Railgun source ledger and scan coordination — October 2, 2026

Main now owns acquisition, an independent encrypted source ledger, and acknowledged scan scheduling. Engine storage dispatch is disabled outside the coordinator's apply window. This checkpoint qualifies the boundary with controlled RPC/planner/application callbacks and real encrypted storage workers; **actual-engine replay through this coordinator and live scoped acquisition are next**, not results claimed here.

## Flow and ownership

1. The source issuer uses Freedom's existing account-scoped `createPrivateRpc` for Sepolia. Only the fixed public Railgun proxy's complete-topic logs and public block headers are requested. No wallet-specific unpublished nullifier query is added.
2. The issuer checks the finalized anchor, range boundaries, the previous-block parent link and every event block's reported hash. It normalizes ordering and refuses duplicates, conflicting transaction positions and malformed payloads. These are single-provider RPC observations, explicitly **unverified**, not receipt proofs or independently established ancestry/completeness.
3. Main appends the acquired logs to a separate encrypted paged source ledger in its own trusted worker. Each range, its logs and the ledger metadata are one atomic transaction. The engine receives neither this worker nor its storage capability. The source planner streams the prefix through and including the target range from this ledger; it cannot derive its expected state from the engine database. The production guarded planner wrapper still needs connection and qualification.
4. Source evidence is an opaque, session-bound registered object. It binds the exact plan, range digest/count, boundary/anchor hashes and current provider provenance. It expires 60 seconds after the start of its canonical recheck, measured with a monotonic clock. Refresh rechecks canonical boundaries without downloading the same logs or recomputing the plan.
5. The coordinator claims the engine storage worker before its first dispatch, opens the separate journal, revalidates a completed checkpoint or resumes its exact pending range, then durably prepares new work. Only then does it call the engine application callback with public logs and a temporary dispatch capability.
6. Engine RPC, clears and deletes are refused in this window. Request IDs are checked per apply and mapped onto the persistent storage session's sequence. Late dispatch is fatal. The coordinator closes the window, drains outstanding calls, refreshes source evidence, inspects the entire public state and completes the journal only on exact agreement.

A retained reference to the worker's original `dispatch` cannot bypass a claim: using it closes the session. Other main-owned holders may still inspect or revoke the worker; exclusivity concerns storage dispatch. The existing Electron supervisor still forwards directly to a session, so it must be connected to the coordinator before this route is used there. There is no new renderer IPC, product enrollment or dependency.

## Recovery and provenance

The journal is now schema 2 and binds both engine-store and source-ledger identities at open. Schema 1 is refused without migration. No user profile has been enrolled in either development schema.

The ledger's cumulative hash covers content: ranges, boundary hashes and canonical log digests. Original acquisition providers are recorded separately. Fresh plans record the current provider set's digest. A provider-only change can renew a checkpoint after fresh source and state checks, or a pending plan after a fresh source check, with state checked at completion; every content field, identity, anchor and expected-state digest must remain identical. This permits recovery through a changed endpoint without silently relaxing source trust.

A crash after caching logs but before journal preparation leaves an unapplied tail. On recovery, the journal issues an opaque retention authority tied to its current sequence, ledger identity and lifetime. It holds a retention lock while the ledger preserves the checkpoint and pending range and removes only unreferenced cache rows, newest range first, atomically per range. Authority is checked before and after each write and revoked when the callback ends. No files are deleted. Pending/applied records cannot be discarded this way.

Missing or rolled-back committed ledger state fails closed. The content hash no longer depends on provider choice, but automatic reconstruction of vanished range partitions and user-approved rebuild policy remain open. Copying the journal and both stores back together is not externally anchored rollback protection. Cross-process exclusion still depends on Freedom's single-instance/profile locks.

## Bounds and qualification

- Acquisition: at most 100,000 blocks, 4,096 logs, 4 MiB response/log-set data and 512 distinct event blocks per request. Source acquisition and engine apply each have a 180-second deadline. Profile lock cancels even silent planner/application callbacks. Storage requests retain their 30-second deadline. Range/provider capacity errors currently revoke the source; adaptive sizing/retry needs connection before a broad live scan.
- Ledger: 10,000 ranges, 100,000 logs and 128 MiB total source payload; the underlying record limit is 1 MiB. The planner streams the complete retained prefix for each plan, so this is deliberately an O(N) Sepolia design, with measured actual-engine performance still pending for this path.
- Public state: the previous [source-to-store qualification](railgun-scan-journal-2026-10-02.md) remains evidence for the inspected record format and full history. It does not automatically qualify this new scheduling path.
- Focused tests: **89 passed**, including real two-worker encrypted storage, interrupted apply/reopen, provider-change recovery, orphan-cache retention, opaque authority, forbidden/late/bypass dispatch, concurrent work, maximum-sized hex parsing and cancellation of silent callbacks.
- Full regression: **7,565 passed, 33 skipped, 353 passing suites**. Lint passed.

Claude reviewed the implementation and requested the enforced dispatch claim, apply deadline, retention lock, provider-independent content hashing and safe hex validation. Those fixes are included. This is engineering review, not a security audit.

Next: run real Railgun events through this coordinator using the captured source, connect the bounded guarded planner and Electron supervisor, qualify live scoped scanning, then actual wallet decryption/current Kohaku balance and notes, deployment-bound artifacts/proofs/signing/POI, and funded recoverable shield/private-transfer/unshield. No Railgun funds have moved.

## Main compatibility and local nodes

Main `d8f1d3be` (Ant 0.5.54) merged cleanly as `22956c0d`, after implementation commit `ad32b170`. Claude accepted the compatibility diff. The merged branch again passed 7,565 tests / 33 skips / 353 suites and lint; package-lock.json is unchanged. Pinned installs were explicitly refreshed: Ant 0.5.54, freedom-ipfs 0.4.3, libradicle 0.7.1, Myotis 0.1.12 plus rebuilt supervisor, and Arti 2.6.0. `npm run check-binaries` passes.

Arti was built with the already installed `RUSTUP_TOOLCHAIN=1.99.0`; the machine's default cargo 1.88 was too old. The overwritten destination was killed by macOS despite passing code-signature verification. A fresh file containing identical bytes launched successfully and reports Arti 2.6.0; the prior inode was retained in temporary storage. No fetch script or toolchain pin changed. This is a local refresh observation, not a cross-platform binary qualification.
