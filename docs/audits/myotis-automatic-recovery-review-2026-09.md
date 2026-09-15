# Automatic checkpoint recovery: adversarial review

The user-created Claude reviewer reviewed the complete implementation on 2026-09-14, then reviewed the fixes. Codex independently reviewed lifecycle, verifier, ownership, build and UX paths. This records the disposition, not human approval or a release decision.

| Finding | Resolution |
| --- | --- |
| A verified native exit arriving after the stop deadline left restart blocked | Fixed: late verified exit releases the in-memory gate; repeated stop returns confirmed success. Regression tests cover the deadline/late-receipt/restart ordering. |
| Malformed HTTP-200 service bodies looked like conflicting evidence | Fixed: undecodable proof or metadata is unavailable and receives bounded retries. Decoded invalid signatures, wrong chains and conflicting roots remain verification failures. Real captured WASM proofs and corruption checks still pass. |
| Ordinary process failures and slow-sync Retry unnecessarily fetched a checkpoint and replaced state | Fixed: Retry restarts the same authenticated generation, with ownership checks. Only actual native staleness escalates to checkpoint verification. Cancellation and unconfirmed-exit tests cover this path. |
| Colibri runtime drift could look like a proof attack | Fixed: captured tests assert installed version 2.0.6; missing decoder or a successful verification without an authority lookup reports an incompatible verifier and update guidance. It never releases readiness. |
| A slowly syncing node becoming stale later stayed parked | Fixed: the blocked/stalled state now automatically escalates when native status becomes STALE_ANCHOR. A regression simulates five minutes without read readiness, then expiry, and proves a worker attempt begins. |

The reviewer confirmed the origin/path/method/redirect restrictions, exact root/finality matching, readiness and read-epoch gates, privileged retry IPC, worker termination-before-settlement, and ownership guards. The final narrow stalled-to-stale guard received a separate follow-up review.

## Retained constraints and optional improvements

- Checkpoint publication is a trust assumption. Colibri verifies the proof/committee relationship; the selected authority supplies the finality claim. A compromised authority can undermine the bootstrap. This is not an independent finality quorum.
- Native checkpoint import trusts the host to supply a matching root/slot. Freedom derives both from the same verified header and binds them to the owned generation. A redundant native bootstrap-header slot equality check remains a possible defense-in-depth patch; this implementation does not claim to withstand same-user edits to its trusted local state or code.
- A verified checkpoint is discarded if old-child retirement misses its deadline. After a later confirmed exit, Retry may restart the retained stale state and re-fetch a checkpoint. That adds latency/network work but preserves freshness and ownership checks; retaining an in-memory candidate is an optional optimization.
- Unknown durable ownership cannot be cleared by Retry. It remains quarantined until the existing documented operator procedure establishes that no old child can exist. No new automatic cleanup or unsafe reset was added.
- Worker network traffic uses Node fetch, outside Electron sessions. V8 worker resource limits do not constitute a total WASM-memory cap. Response sizes and deadlines remain bounded; there is no claim of full process-level memory containment.
- The addon manifest is trusted local-build provenance, not a remote publisher signature. Runtime checks ABI/capability; signed full packages and other platforms need their own qualification.

## Evidence scope

The [review-fixed live campaign](evidence/myotis-recovery-integration-2026-09/review-fixed/README.md) passed both chains' real recovery, verified account reads, stop, same-generation restart/read and ownership rejection controls. The [review-fixed ASAR campaign](evidence/myotis-recovery-integration-2026-09/asar/review-fixed/README.md) passed the actual worker/WASM flow on both chains. Restarts rebootstrap from authenticated checkpoints; no persisted committee snapshot was generated.

One two-line manager condition was added after that live capture: automatically escalate blocked/stalled status upon native STALE_ANCHOR. It is covered by the new manager regression and final full suite; the live campaign did not wait for an additional 34-hour expiry. All other live-tested production modules retain their captured hashes.

- Live manager SHA-256: `1339bc0fff7565282ffb4e894c8d8f93c46246508a634330cc8c843a9b8637e3`
- Final manager SHA-256: `527766604458980b4acb0e7d6c8db486b613f7b875736e304d3158142b4eb82b`

The full final unit run is recorded in the PR update. Three unrelated settings/Safe test failures were reproduced on unchanged pre-integration fa750bd8. No signing, broadcasting, merge or release was performed.
