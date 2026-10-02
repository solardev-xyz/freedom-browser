# Privacy implementation progress history — October 2, 2026

This preserves the previously published issue #475 / draft PR #476 continuation
that was replaced by the wallet-snapshot update. CI status and remaining work
below describe that earlier checkpoint, not the current branch. Later updates
are linked from the issue, PR and research roadmap.

## October 2 continuation: source ledger and real-engine scan coordination

Implemented and reviewed on the feature branch: independent encrypted public-log storage, scoped range acquisition, expiring source evidence, exclusive engine dispatch, journal-authorized cache retention, and exact fresh public-state checks before scan completion. [Source/coordinator design](https://github.com/solardev-xyz/freedom-browser/blob/ad32b17022064ed99711af9171ab775a3afe55a1/docs/railgun-source-coordinator-2026-10-02.md).

[Real-engine coordinator qualification at 4eed1568](https://github.com/solardev-xyz/freedom-browser/blob/4eed1568c0913b246148db74c65a354d4fa8cb47/docs/railgun-coordinated-replay-2026-10-02.md) passes 121 archived-history ranges, a forced termination after nullifier writes, recovery with a changed archived provider identity, and exact cold restart. Final public state: 10,194 commitments / 5,614 nullifiers / 2,546 unshields. The source-only planner independently checks roots and every canonical event field, including encrypted payloads. Empty Shields are handled; unknown events and post-baseline governance changes stop the scan. The Electron supervisor can borrow the coordinator permission without owning its persistent store; [actual Electron coordinated replay](https://github.com/solardev-xyz/freedom-browser/blob/cd8fd962c00a3dbdbc936f7ef61e7b4b8e67e3af/docs/railgun-coordinated-electron-2026-10-02.md) also passes all121 ranges, after-nullifier termination/recovery and exact cold restart on macOS arm64. This uses qualification entries, not a packaged product runtime. Forty-nine focused projector/supervisor/feed checks pass.

Validation: 7,585 regression tests passed /33 skipped; 12 projector and 33 supervisor tests pass; lint passes. Claude reviewed code and evidence as engineering review, not a security audit. This is archived public-data qualification with one coordinated crash phase, not live acquisition, wallet balances, receipt-proven completeness or funded Railgun operations. Remaining: production runtime packaging, Electron interruption coverage, adaptive live acquisition, wallet/Kohaku balance and notes, artifacts/deployed verification keys, proofs/signing, POI/relay transport and recoverable funded shield/transfer/unshield. No Railgun funds have moved.

Main d8f1d3be was merged in 22956c0d. All pinned nodes were explicitly refreshed: Ant0.5.54, freedom-ipfs0.4.3, libradicle0.7.1, Myotis0.1.12 with rebuilt supervisor, Arti2.6.0 built using the already-installed Rust1.99.0; binary checks pass and the dependency lock is unchanged. [Compatibility evidence](https://github.com/solardev-xyz/freedom-browser/commit/5cda967f6f3300cd683465c85cfccb5ca9f80f32). Historical 94c50a70 CI passed on attempt3 after license-download and live-onboarding failures; 74d8269f and 5cda967f retain live-onboarding E2E failures, and the merge run was cancelled by the subsequent push. Those runs are not reported as green. Main itself also failed the Windows onboarding job in [run37034707244](https://github.com/solardev-xyz/freedom-browser/actions/runs/37034707244) (tracked in #479). 4eed1568 first failed only onboarding-identity live E2E (Ubuntu/macOS); its rerun was then cancelled by the next push. cd8fd962 CI remains queued, independently of the local results above.

Earlier checkpoints below remain historical evidence; the latest state and remaining gates are maintained in the linked roadmap and qualification documents.

---

## Superseded wallet-snapshot coordination update

The following was the issue/PR status before durable wallet checkpoints and proof qualification. It is retained verbatim as historical evidence; later checkpoint documents supersede its next-step list.

## October 2 continuation: isolated Railgun wallet scans

[Wallet snapshot checkpoint 103a9db2](https://github.com/solardev-xyz/freedom-browser/blob/103a9db284cbbfcaf400aed7998b177422d0dc77/docs/railgun-wallet-snapshot-2026-10-02.md) adds exclusive, read-only access to completed public checkpoints and a separate encrypted derived-wallet store. The host restricts each storage namespace, revalidates public source/state before and after the utility job, and invalidates prior snapshot evidence on subsequent public work. Wallet construction does not persist the viewing key; token lookup uses checked public preimages without wallet RPC. [Earlier guarded note qualification](https://github.com/solardev-xyz/freedom-browser/blob/c1a224600a3104fcb0c791cf98d35e10c575318f/docs/railgun-wallet-notes-2026-10-02.md) covers malformed notes, local NFTs, exact received/sent sets and incomplete-scan refusal.

Actual Electron evidence: all 10,194 captured Sepolia commitments traversed in 2.529 seconds, then 2.409 seconds with a fresh utility/cache worker; positive synthetic receive, spent-note and self-transfer cases; controlled termination after the first derived batch, incomplete-cache refusal and successful rebuild. The public test vector has 70 unrecoverable sent-history entries, separate from receive quarantine. A differential check confirms the pinned SDK computes the same mismatching hashes and stores no notes for those entries; no origin/intent claim is made. No wallet RPC, POI, prover, signer or transaction submission was granted. All values and viewing material in these tests are public fixtures. These results extend the [121-range Electron public replay and crash/recovery evidence](https://github.com/solardev-xyz/freedom-browser/blob/cd8fd962c00a3dbdbc936f7ef61e7b4b8e67e3af/docs/railgun-coordinated-electron-2026-10-02.md).

At the wallet snapshot checkpoint, local regression passes 7,662 tests /33 skipped; lint and 73 focused boundary tests plus 25 note-validation cases pass. Claude reviewed code and evidence as engineering review, not a security audit. This is qualification infrastructure, not product balances or a durable wallet-coverage grant. Next: main-owned durable derived coverage and current Kohaku reads; live acquisition; artifact/deployed-key binding, proofs, POI/relay transport and operation-bound recoverable funded shield/transfer/unshield; production runtime packaging and broader platform/interruption coverage. No Railgun funds have moved.

[Main 0fa5c440 is merged in e69d1f89](https://github.com/solardev-xyz/freedom-browser/commit/e69d1f892eb5f46b9cd81f5de0b9d7b85e454cfd), including the CCIP validation fix and macOS15 CI runners. All pinned nodes were explicitly refreshed: Ant0.5.54, freedom-ipfs0.4.3, libradicle0.7.1, Myotis0.1.12 plus rebuilt supervisor, Arti2.6.0 built with installed Rust1.99.0. Binary checks pass and the dependency lock is unchanged. The post-merge working-tree regression passes7,684 /33 skipped, including eight separate in-progress cache-observation tests. Historical cd8fd962 CI passed; c1a22460 failed Windows onboarding-identity E2E (the area tracked in #479). Newer heads have no completed CI result cited here.

The replaced source/coordinator, Node replay, earlier main/node-refresh and CI record is preserved in the [dated progress history](https://github.com/solardev-xyz/freedom-browser/blob/a68fe76a6c71a2d45e99c17fb3cd2896125e51b9/docs/privacy-progress-history-2026-10-02.md).

Earlier checkpoints below remain historical evidence; linked documents record exact source pins and remaining gates.

---
