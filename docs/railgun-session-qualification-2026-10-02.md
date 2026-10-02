# Railgun host storage and revocable process session

The approved engine fixture now runs in a separate Node child while encrypted storage and RPC authority stay in the parent. A wallet lock or SQLite write failure revokes both capabilities before the parent terminates the child. This is development infrastructure, not an enabled Kohaku protocol adapter or an Electron release runtime.

The [previous engine milestone](railgun-engine-qualification-2026-10-02.md) established actual engine identity, database encoding and provider behavior with its store in the fixture child. This continuation moves storage out of that child and qualifies a shared lifetime. The engine package, its installed-file inventory, application dependencies and PPv2 runtime are unchanged.

## Implemented boundary

- `src/main/wallet/railgun-session.js` lives with main-owned wallet persistence and capabilities. It requires a private-account Railgun/Sepolia engine context, creates a subordinate scope and encrypted store, and gives a trusted provider factory a protocol-RPC context with the exact same lifetime. The engine cannot select the database path, encryption key, compatibility binding, account or deployment.
- A strict JSON command protocol admits byte reads, atomic batches, range clear, bounded iterator operations and allowlisted read-only RPC. Multi-key reads use one synchronous host snapshot with an aggregate reply bound. Requests have consecutive IDs; responses carry their matching ID. Envelopes are limited to 2 MiB, requests to eight in flight, batches to 1,024 operations, RPC input to 64 KiB and each request to 30 seconds. Canonical base64 avoids pooled-buffer backing stores crossing IPC.
- Main owns at most two immutable iterator snapshots and sends one bounded row per request. Range filtering, ordering, reverse iteration, seek, limits and atomic clear preserve the tested LevelDOWN behavior. The snapshots are wiped on end or revocation. They inherit the store's 32 MiB / 65,536-key limits; this still cannot claim full-history capacity or performance.
- `src/main/wallet/railgun-remote.js` injects the actual engine's AbstractLevelDOWN/AbstractIterator classes in the child. Storage callbacks are asynchronous; queued seek/end wait for iterator creation. Ordinary NotFound does not revoke access. Malformed replies, transport expiry and cancellation do. Neither bridge grants signing, proof artifacts, POI, quick-sync or broadcasting.
- Fatal host errors close storage and the shared scope, cancel waiting operations and suppress late results before notifying the process owner to terminate. The production owner must still hold its process slot until actual exit. A child database close revokes its local bridge; the owner must also revoke the host session when the channel/process ends.

The provider factory is trusted main code: the session's method allowlist is not a contract/selector/event/range policy. A live factory must wrap reviewed Kohaku RPC grants with the session signal. No URL transport or permissive default provider is supplied here.

## Actual-engine process qualification

Run after installing the approved scripts-disabled fixture:

```sh
node scripts/qualify-railgun-session.js /absolute/fresh/output-directory
```

[The committed report](qualification/railgun-session-runtime-2026-10-02.json) records source hashes and four separate engine 9.6.0 processes on macOS arm64, each with the authenticated installed-tree digest `d46dbb16c9161c25baffe12701b2efdb844cb788f7e083d610729973d009e420`:

| Process       | Observation                                                                                                                                                                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create        | Constructs a HardwareWallet from public test viewing material and a spending public key; writes through the real engine database to parent-owned encrypted SQLite; exercises ordered snapshots and host-only provider/network initialization. |
| Lock          | Reopens the same parent database, holds a remote iterator and an unresolved RPC, then the parent scope closes. The pending response is never delivered and the child is terminated.                                                           |
| Write failure | Reopens committed state and leaves RPC pending; parent SQLite insertion is deliberately failed during a two-operation batch. Storage and RPC revoke together before termination.                                                              |
| Restore       | A fresh child observes the original address and JSON record, with neither the failed batch's new key nor its overwrite committed.                                                                                                             |

Every process passes four grouped actual-engine checks; these 16 check results are separate from unit tests. The child receives no mnemonic, spending private key or database encryption key. The HardwareWallet's zero dummy spending key is checked and its external signing connector refuses. The spending public key is a fixed upstream test vector; this is not production public-key derivation or a signer-process qualification. SQLite and the store module must be absent from the child's CommonJS cache, and fixture dependency edges must stay inside the authenticated fixture.

All four children deliberately ignore SIGTERM. The parent revokes first, escalates to SIGKILL after 250 ms, observes the exit and only then credits the run. This directly exercises an uncooperative process; it does not depend on the upstream engine's incomplete unload behavior or lingering timers. The fault/lock host RPC promise is resolved only after exit and its request ID must never appear among delivered replies.

Before the terminal report, all 87 direct-egress hooks have passing refusal canaries and zero observed engine attempts. This measures JavaScript hooks up to that checkpoint; it is not an OS/network sandbox or a claim of observing every instruction between the checkpoint and SIGKILL. Synthetic contracts and RPC responses are used. Network initialization runs, but no contract history, live RPC, POI proof, funds or transaction signing/broadcast is exercised.

## Validation and remaining work

The host and remote boundary suites pass 30 cases, including genuine SQLite failure with a pending RPC, durable rollback, cancellation, deadlines, request replay, capacity limits, malformed envelopes, iterator ordering, response correlation, atomic multi-key reads, bounded aggregate replies, NotFound and late-response refusal. An initial fake-timer test stalled its own callback microtask; returning that test to real timers after the deadline assertion fixed the harness. The final four-process qualification passed; it uses the corrected full upstream spending-public-key literal and verifies child module boundaries. Lint and formatting pass. Final full regression passes **6,940 tests / 33 skipped** across 332 passing suites, with **six OpenLV cases separately**. The full tests needed local loopback access after the sandbox refused existing test listeners; the first OpenLV command also used a nonexistent path and supplied no evidence before the corrected command passed.

Claude accepted the preceding engine/store milestone. Its session hit its usage limit before reviewing this new session slice; **this continuation awaits Claude review**. No claim of reviewer approval or security audit is made for it.

Next infrastructure gates:

1. Review this broker and remote bridge, then qualify the actual Electron utility-process transport, resource limits, private channel ownership, startup failure/disconnect handling, profile enrollment and shutdown. The Node supervisor here is a qualification script, not a product supervisor. IPC size checks occur after the runtime has received a message; they do not bound a malicious sender's pre-validation allocation.
2. Replace the bounded development store with qualified full-history capacity/performance and recovery semantics. Complete-file rollback, crash-time incomplete-file classification and profile backup enrollment remain open.
3. Bind reviewed live deployment/contract grants, history synchronization and POI verification to the host. An unscanned wallet must not appear as a zero/spendable balance. Implement current Kohaku `instanceId`, `balance` and `notes` only when their semantics can be demonstrated.
4. Qualify pinned artifacts/proving and an independent operation-bound signing process. No generic hash-signing RPC is introduced. Maintain the existing uncertainty/submission journal requirements.
5. Resolve the existing engine dependency advisories, distribution licenses and native-platform crypto qualification before shipping. Installing with lifecycle scripts disabled did not clear those gates.

The process still has ordinary filesystem/native-code authority; the viewing key necessarily exposes private history. JSON/base64 strings cannot be reliably wiped, and the host snapshot/engine heap can retain sensitive material until process lifetime ends. The development harness uses only public fixtures. None of this enables Railgun in the app, changes PPv2's funded profile, or requests user-facing UX decisions.
