# Railgun public-state inspection and scan journal — October 2, 2026

The host can now compare the entire stored public event state with a source-derived plan, and persist pending scan work separately from the engine database. This is preparation for serialized host-controlled scanning; no wallet balance, note selection, spend capability or production enrollment is enabled.

## Implemented boundary

- New paged stores carry a random identity in their authenticated encrypted manifest. The identity survives writes, clearing and reopen. Legacy five-field manifests remain readable but have no identity and cannot enter this scan journal. Copying a whole file preserves its identity: this is recreation detection, not rollback protection.
- One host-only `inspectPublicState()` observes the store identity, tree lengths/roots and exact commitment/nullifier/unshield digests together, with the worker's revision and main dispatch serial. The engine cannot issue this inspection. A later dispatch or mutation invalidates the observation.
- Public digests include all immutable event payload fields: transaction/block identifiers, preimages, token values, fees, ciphertext, blinded keys, annotations, memo and recipients. Declared later timestamp/sender/TXID/POI enrichment is excluded. Hex spelling is normalized. Missing shield fees remain distinct from zero. Required shapes, key/payload agreement, leaf coverage, ordering and duplicates are checked.
- The new encrypted main-owned journal owns its storage scope/path and takes identity from the real store session. It records a contiguous range plan before returning an opaque apply token. Completion requires one fresh registered whole-state observation matching that plan. Reopen requires source and state revalidation, or replay of the exact pending plan; an engine cursor never substitutes for these checks.
- Journal instances use an in-process canonical-path owner and persisted lease/generation/sequence checks. Account lock or session revocation closes the journal. A state change after the journal write reports an uncertain committed outcome and closes the instance. The coordinator must reopen and revalidate rather than retry blindly.

These modules remain under main's wallet authority; crypto formatting stays in guarded child processes and synchronous storage inspection in the trusted storage worker. No renderer IPC, top-level architecture change or dependency change is added.

## Qualification

[Public-state report](qualification/railgun-public-state-2026-10-02.json) records 19 successful real-engine Node-child/trusted-worker runs against the captured Sepolia history, including five interruption phases, restore and cold readback. Expected states are computed in a separate guarded process **before any engine store is created**, and retained only in the parent. Each result, including exact partial crash states, matches those expectations.

The earlier replay report remains bound to `94c50a70` sources; the public-state report supersedes it for this checkpoint.

Complete state: 10,194 commitments, 5,614 nullifiers and 2,546 unshields, with the previously anchored tree root. The 29,188,096-byte database took 162.1 ms to inspect after completion and 177.3 ms after cold reopen; the latter is the maximum observed inspection, about 169 times below the 30-second worker request deadline. These are single-machine Sepolia measurements, not a mainnet/platform performance guarantee. Full sorted-set inspection is O(N); the generous structural caps are refusal ceilings, not a throughput promise. Exceeding the deadline revokes the session. A different scalable design is needed before mainnet-scale enrollment.

The planner and engine share pinned event formatting and Poseidon dependencies. This demonstrates source-to-store fidelity, not independent correctness of every formatting function. Nullifier and unshield payloads are additionally compared field-for-field with ABI-decoded arguments; mutation tests check every projected payload field. The previous offline verifier independently reconstructs commitment leaves/root from contract rules. RPC agreement, header/bloom checks and a reproduced commitment root still do not prove complete nullifier history.

[Padding report](qualification/railgun-padding-2026-10-02.json) checks authenticated engine hash-write groups at 65,536 leaves. The actual `insertLeaves` path produces zero padding one node beyond capacity at levels 1–16, both in 4,096-leaf batches and one batch. The rebuild helper's inclusive end yields padding at levels 1–12 for the smaller schedule and 1–16 for one batch. All schedules have the same root and pass the host node projection. Only the pinned zero is accepted outside capacity; it is allowed, never required. This probe intercepts the write groups; it is not a database or wallet qualification. All 17 pinned zero values are also regenerated and checked during history preparation.

Regression: **7,517 passed, 33 skipped, 350 passing suites**; lint passed. Claude reviewed the journal/worker boundary and source planner, with no remaining blocker for this infrastructure slice. Full-history inspection time and padding semantics were checked in response to that review. Earlier stopped/incomplete runs are excluded from these reports.

## Next and remaining limits

1. Connect prepare/apply/complete with explicit parent acknowledgements, idle engine dispatch and real source registration. The existing replay progress callback acknowledges IPC delivery only; it does not yet provide journal ordering.
2. Acquire bounded public logs through scoped host RPC. Register source evidence by identity, with range digest/count, boundary/anchor hashes, parent links, canonical recheck time and expiry. The journal currently receives the trusted host assertion; no production source issuer is connected.
3. Revalidate on every open, gate reads while pending, and serialize all event categories. `applied-unverified` is diagnostic, never a grant. Treat stale inspections as retry-when-idle, not automatically corrupt storage.
4. Cross-process exclusion relies on Freedom's single-instance/profile locks. Copying both journal and database back to an older consistent state needs an external canonical/freshness check. No automatic reset/migration is provided; rebuilding user state requires a separately reviewed explicit policy.
5. Continue actual wallet decryption/current Kohaku semantics, artifacts matched to deployed verification keys, operation-bound proving/signing, TXID/POI and recoverable shield/private-transfer/unshield with authorized Sepolia funds.

No Railgun funds were moved. Mainnet, product UX and production activation remain outside this qualification.
