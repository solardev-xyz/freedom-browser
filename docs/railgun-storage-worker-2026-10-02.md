# Railgun host storage worker — October 2, 2026

The development Electron supervisor can now run its trusted database broker in a main-owned worker thread. This moves encrypted database opening, page maintenance and synchronous SQLite operations off the main event loop while reusing the same session, transaction, cursor and frontier implementation. Main retains the network capability; the engine utility process still receives only bounded commands and replies. `storageWorker: true` explicitly selects this path with the paged format. No renderer channel, product enrollment, migration or signing authority is added.

This remains within main's wallet/persistence responsibility. The worker is scheduling isolation for trusted host code, not an OS security boundary. It runs a fixed source entry with an empty environment and a 256 MiB V8 old-space limit; that is not a total RSS cap. It has no engine dependency or transport. Main forwards RPC through its scoped provider and independently checks the read-method allowlist. The provider still must constrain contracts, selectors and log ranges before a live scan.

## Lifetime, keys and ordering

The main-to-worker queue permits eight requests and 8 MiB of pending payload, with the existing 2 MiB frame limit and thirty-second request/startup deadlines. Commands and host inspection requests share one FIFO sequence. Closing sets an atomic shared revocation flag before aborting capabilities, refuses pending calls immediately and drops late replies on both sides. The worker checks that flag through every context/store activity check, including at the start of the SQLite publication transaction. An operation already executing may complete; subsequent queued operations cannot begin with authority.

Shutdown first asks the worker to close its database, then forces termination after a two-second grace period. The worker retains the database ownership slot until observed exit. Electron readiness waits for both broker initialization and the engine's ready/memory checks; shutdown releases the supervisor slot only after both the engine and storage worker have exited. Worker errors, deserialization failures and unexpected exits revoke the session and stop the engine.

A dedicated storage-key copy is transferred to the worker, detaching that copy in main. The worker wipes temporary copies once the store takes ownership. The caller's original key remains caller-owned, and command/result plaintext necessarily crosses main's relay. This does not claim that all key copies or plaintext disappear from main, or that JavaScript erasure protects against physical memory inspection.

## Asynchronous inspection with synchronous freshness

Host-only `inspectFrontier` and `inspectPosition` are asynchronous; the engine cannot invoke them. They still report structural `persisted-unverified` state, never completeness or permission to spend. The worker keeps at most sixteen issued observations, and main deep-freezes received results and registers them in a private WeakMap.

The shared control block holds a closed flag and monotonic revision, advanced before each mutation and transaction begin. Revision overflow refuses the operation. Each worker session has its own block and observation registry. Main additionally invalidates observations as soon as any engine command is accepted, including commands still queued for the worker. Its synchronous `assertFresh` refuses unregistered objects, any pending work, changed dispatch serials or revisions, and closed contexts. Consequently a write that overtakes an asynchronous inspection cannot turn its old result into a fresh observation. This is conservative: even reads invalidate previous observations, so callers retry inspection when the engine is idle.

Consumers must call `assertFresh` immediately before each use with no intervening await, and revalidate after any asynchronous step. These checks bind local state only; canonical chain roots, complete log ranges, wallet ownership and nullifier state require separate evidence.

## Qualification

All new runtime fixtures use public synthetic data and make no live RPC calls:

- [Ten actual Electron tree runs with worker storage](qualification/railgun-worker-electron-tree-2026-10-02.json) pass creation, update, cold restoration, lock during staging, child death before commit and child death after acknowledged commit. Fresh engine processes independently recompute the synthetic roots. The chain binding remains unverified.
- [Thirteen Electron supervisor cases](qualification/railgun-worker-electron-2026-10-02.json) pass with the worker enabled, including initialization, restore, lock, quit, memory/egress refusal and forced engine termination.
- [The 55-case Node reference matrix](qualification/railgun-worker-reference-tree-2026-10-02.json) passes against the shared session/store implementation. These are reference-broker cases, **not 55 worker-thread cases**.
- Fifteen real-worker unit cases cover ordered persistence, cursors, restoration, wrong-key startup refusal, late RPC, queue overflow, a real worker thread exhausting an 8 MiB test heap (synthetic allocation code, not the storage entry), and host-only frontier/position freshness. A test-only worker wrapper pauses after the SQLite manifest update but before commit, then separately after commit but before acknowledgement. Forced termination followed by a fresh worker in the same main process recovers the exact old/new revision without a retained SQLite lock. Main refuses a second queued call immediately. In forced cases the worker dies before processing it; additional cooperative-resume variants let the in-flight transaction finish, observe the revoked lifetime, and exit cleanly while the already-posted queued write remains absent. The production worker accepts no instrumentation or executable input.
- [Minimal ASAR qualification](qualification/railgun-worker-asar-2026-10-02.json) loads both host and worker code from an archive outside the repository, creates and reopens an encrypted store, and checks a fresh host observation. It records Electron 44.4.5 / module ABI 149 and hashes the selected unpacked Darwin ARM64 SQLite binary. Only Darwin ARM64 ran. The selected prebuild uses N-API; Electron module ABI 149 is informational, not a binary compatibility claim. This is not a full packaged-app run, ASAR-integrity-fuse test, or evidence for another platform.

Full local regression passes **7,379 tests / 33 skipped** across 344 passing suites; lint passes. The earlier main-merge checkpoint additionally passed all six OpenLV integration tests. Claude accepted the worker lifetime, freshness rules, failure tests and corrected ASAR approach as engineering review, not an independent security audit.

## Main-loop measurements

The final source was measured sequentially, once per mode, on Darwin ARM64 with Electron 44.4.5. Each mode writes 70,000 public synthetic leaves in 4,096-leaf groups, then cold-starts a new engine and reopens the store. The resulting 210,035 records occupy 1,456 pages. Both tree roots and final membership proofs match independently reduced synthetic leaves. Main's event-loop measurement stops before post-exit synchronous inspection.

| Mode | Write elapsed | Write maximum delay | Cold elapsed | Cold maximum delay |
| --- | ---: | ---: | ---: | ---: |
| [Worker](qualification/railgun-worker-electron-volume-2026-10-02.json) | 43.473 s | 3.488 ms | 4.665 s | 2.150 ms |
| [Synchronous reference](qualification/railgun-sync-electron-volume-2026-10-02.json) | 42.857 s | 68.157 ms | 4.883 s | 171.049 ms |

Both modes meet the declared 20 ms p99 target, with p99 values approximately 1.33–1.60 ms, close to the histogram's one-millisecond resolution floor. The maximum delays expose the occasional synchronous storage stall; p99 alone does not distinguish these runs. Worker write elapsed time is about 1.4% higher; the single cold run is about 4.5% faster. Neither difference establishes a general throughput improvement. These are main-loop measurements, not worker/engine CPU or memory measurements, and they do not establish behavior at maximum configured capacity, under concurrency or on other platforms.

## Remaining work

This closes the main-thread storage scheduling gap for the measured development workload. It does not yet qualify a full scan, complete nullifier history, wallet decryption, POI, proofs or spending. Scanner/wallet concurrency still needs scheduling around exclusive tree groups. Upstream's historical scanner explicitly warns that commitment-based resumption can miss nullifiers and display spent notes as available; independent, contiguous Nullified-event coverage at a canonical finalized anchor remains a prerequisite for balance and spend selection. Ordinary balance refreshes must not query unpublished per-note nullifiers: doing so exposes values that link queries to later spends, even through Tor. Any future pre-submission check needs a deliberate exposure policy; none is implemented or authorized by this checkpoint.

Further platform, full packaged-app, profile-enrollment and heavy-commit application-quit checks remain open. Whole-file rollback needs external recovery policy; the bounded paged-store resource refusal rules remain unchanged. The next technical work is constrained historical event acquisition, root reconstruction and nullifier coverage, followed by current Kohaku balance/notes and operation-bound proving/signing. No live Railgun operation or funding transfer has occurred.
