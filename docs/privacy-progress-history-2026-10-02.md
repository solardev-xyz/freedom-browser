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

