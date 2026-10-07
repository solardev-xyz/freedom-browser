# Railgun coordinated Electron replay — October 2, 2026

The real engine9.6 and the independent source-only planner now run as separate
short-lived Electron utility processes under the existing heap, sampled RSS,
egress and lifetime guards. Main owns the source ledger, storage worker and scan
journal throughout. This extends the [Node coordinator qualification](railgun-coordinated-replay-2026-10-02.md).

[The source-bound report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-coordinated-electron-2026-10-02.json)
records all 121 archived Sepolia ranges and exact final/cold public state:
10,194 commitments, 5,614 nullifiers and 2,546 unshields. The engine is killed after
nullifier writes in the range ending at block7,099,999; reopening with a different
archived provider identity completes the durable pending range. The final tree
root and all public payload digests match the independently verified capture.
Fifty-nine pre-UTXO apply callbacks intentionally skip the engine and journal the
empty state. This run is macOS arm64 only, with one coordinated crash phase.

The planner can request only bounded source chunks and return a result; it has
no database or RPC route. The engine receives its current range in chunks, then
accesses storage only through the coordinator's temporary dispatch. Messages have
separate monotonic job/storage sequences. The source producer holds one pending
chunk, capped at128 logs or1MiB; the child acknowledges consumption by requesting
the next one. Both sides honor revocation. Host completion waits for the engine's
result and observed process exit before inspecting storage or completing the
journal. Successful shutdown never closes the coordinator-owned store.

The historical governance boundary comes from the verified history report and is
recorded as qualifiedThrough=11,829,346. Unknown events and governance events after
that boundary are refused. Engine input contains public data only in this run;
no viewing/spending secrets or user funds are involved.

## Limits and next work

These entries remain qualification tooling under scripts/fixtures, with duplicated
Node/Electron harness code to preserve each source-bound experiment. They are not
packaged production entries or a new ASAR qualification. The report covers archived
RPC responses, fixed partitions and one source identity at a time; it makes no
live acquisition, proof-of-completeness, platform-portability or wallet-readiness
claim. Guarding JavaScript egress is not an operating-system sandbox. The fixture's
SIGKILL label is inferred from the supervisor exit code by the harness; the
interrupted row retains that label and phase but not the raw supervisor close
record. This inference must be qualified independently on other platforms. Recorded range timings include source
checks, both child startups, fixture hashing and state inspection; individual
startup latency and planner RSS are not separately recorded. Summed range times
were348.3seconds in this one run; maximum sampled RSS across the62 completed
apply jobs was250.9MiB, excluding the interrupted job and all planner processes.

Planner failure currently closes the source ledger worker fail-closed. Recovery
reopens its authenticated existing cache; it does not require rebuilding sound
history. Automatic retry policy, dedicated planner subject identity, the borrowed
path's additional interruption matrix and fixed production runtime packaging are
still open. Existing supervisor lifecycle qualifications remain separate evidence.

Claude reviewed the transport and lifecycle as engineering review, not a security
audit. Lint and49 focused projector/supervisor/feed checks pass (including blocked
producer cancellation and source failure propagation); the preceding
regression run passed7,585 tests /33 skipped. Next is actual wallet decryption,
conservative current-Kohaku balance/note semantics, live acquisition, artifacts and
verification-key binding, operation-bound proofs/signing, POI/relay transport,
and funded recoverable shield/transfer/unshield. No Railgun funds have moved.
