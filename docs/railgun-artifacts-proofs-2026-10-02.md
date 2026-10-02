# Railgun artifacts and offline proofs — October 2, 2026

Five transaction circuit shapes and the small POI circuit now generate and verify real proofs inside guarded Electron utility processes. This is synthetic/public-vector qualification, not a prepared user operation or a live Railgun transaction. No funds moved.

## Artifact authority

`railgun-artifacts.js` uses the existing main-selected local artifact loader. Every WASM, proving key and verification key is pinned by exact size and SHA-256; unsupported shapes fail. There is no download fallback. The allowed transaction shapes are **1×1, 1×2, 1×3, 2×2 and 2×3**; POI is **3×3**. Three-output capacity allows future recipient/change/broadcaster-fee layouts, but actual note selection and relay construction are not implemented by this qualification. Shapes outside these limits must be refused until separately qualified.

WASM/zkey pins come from the [upstream wallet artifact manifest](https://github.com/Railgun-Community/wallet/blob/5c9d04c844879b8377d91775052e88c836b48730/src/services/artifacts/json/artifact-v2-hashes.json). Research downloads used the upstream public IPFS CIDs and were decompressed with explicit size limits. Verification keys were derived locally from every pinned zkey using snarkjs 0.7.5 from the locally pinned PPv2 input tree (`tmp/privacy-build/pinned-inputs/ppv2/node_modules/.pnpm/snarkjs@0.7.5/node_modules/snarkjs`), then compared to the pinned vkey files. The checked-in [artifact report](qualification/railgun-artifacts-2026-10-02.json) records six successful derivations, exact byte hashes, source hashes and the loaded Node module hashes. The input tree is an ignored local build workspace, not a repository dependency or durable distribution artifact. Reproduction must restore those pinned build inputs; loaded-module hashes in the report bind the exact code used. Binaries remain outside Git; no dependency was installed or upgraded.

A [fresh public deployment capture](qualification/railgun-sepolia-verifiers-2026-10-02.json) reads all five transaction verifier shapes through two agreeing RPCs at finalized block **11,831,583**, hash `0x315398267a3283c5eccae3b5e33846536f5603806666567212433bf3f57956f3`. Every derived alpha/beta/gamma/delta and IC point matches its captured `getVerificationKey` result, including the contract's G2 coordinate ordering. The comparator accepts only an issued artifact object under a live context and exact canonical re-encoding. It treats the contract's artifact CID as descriptive metadata, not authority.

The encoded verifier supplied to that comparator must come from the selected deployment and anchor. Here it comes from the captured evidence; future operations need a current, deployment-bound, block-hash-bound read under the host's chain-trust policy. The comparator itself cannot authenticate arbitrary RPC data. Two-provider agreement is corroboration, not independently verified consensus or proof of current canonical state.

The verifier anchor is newer than the replayed public history/governance boundary at block **11,829,346**. The earlier 1×1, 1×2 and 2×2 encoded keys match the fresh capture exactly, but the intervening governance-event range has not yet been replayed. Matching endpoint snapshots do not prove that no intermediate change occurred. The historical deployment report is source-bound to its earlier commit; the current inspector additionally requests 1×3 and 2×3 and produces the new verifier report.

**POI has no smart-wallet on-chain verifier anchor.** Its authority here is the pinned upstream artifact plus locally derived verification key. Successful local verification does not establish acceptance by a POI service, root validity or eligibility of any user's notes.

## Proof qualification

The [Electron report](qualification/railgun-proofs-2026-10-02.json) covers six separately supervised jobs:

| Circuit | Inputs | Result | Observed proof/check time |
| --- | --- | --- | --- |
| 1×1 | Synthetic transaction | Valid; changed root and bound-parameters hash rejected | 1.789 s |
| 1×2 | Synthetic transaction | Valid; changed root and bound-parameters hash rejected | 1.804 s |
| 1×3 | Synthetic transaction | Valid; changed root and bound-parameters hash rejected | 1.924 s |
| 2×2 | Synthetic transaction | Valid; changed root and bound-parameters hash rejected | 2.303 s |
| 2×3 | Synthetic transaction | Valid; changed root and bound-parameters hash rejected | 2.335 s |
| POI 3×3 | Pinned upstream public vector | Valid; changed POI root rejected | 3.585 s |

Transaction fixtures use a deliberately public synthetic key (`Uint8Array(32)` filled with `7`, never a user credential), synthetic commitments/Merkle paths and arbitrary synthetic bound parameters. They are not spendable deployed notes, approved intents or chain-accepted transactions; their arbitrary roots have not been accepted in the deployed root history. The synthetic key is intentionally non-secret test data under the security checklist. The actual pinned engine derives the fixture's keys, commitments, nullifiers and signature; no new cryptographic implementation was introduced.

Every job had zero guard-refused egress attempts, no POI-service calls and no submissions. The supervisor observed exit before recording completion. Configuration: 256 MiB V8 heap, **768 MiB sampled RSS ceiling**, 120-second startup and 180-second lifetime. Maximum observed utility RSS was **425,803,776 bytes (about 406 MiB)**. RSS includes WASM/native memory beyond the JavaScript heap; sampling is a soft bound, and this one-machine run is not a cross-platform capacity guarantee. Parent/worker memory is not included.

## Temporary prover reuse and remaining work

This qualification reuses only `serial-prover.cjs` from the already authenticated PPv2 archive (`eacc32476b2fc3be0344e1c9b341a9964e405f59703604385b29307350bcca7a`). That is the existing snarkjs 0.7.5 bundle with reviewed single-thread prove/verify paths; it does not run PPv2 protocol logic. It temporarily couples qualification to that archive's pin and packaging. snarkjs is GPL-3.0; the Railgun engine is MIT. The existing archive's full source/license inventory and PPv2 distribution gates still apply; this experiment does not approve distribution or copy confidential PPv2 source into Railgun.

Before product use, give Railgun an independently authenticated prover closure with its own reproducible inventory, reusing existing installed sources where appropriate. Also still required: independent operation-bound proof verification, main-owned input/output/fee/recipient checks and spending-key isolation, current root/deployment checks, POI/TXID service qualification, note reservations and replay-safe transaction journals, live acquisition, and funded shield/transfer/unshield tests. Proof success alone grants none of those capabilities.

## Validation and main integration

Eight focused artifact/loader tests and lint pass. The six real Electron proof jobs are separate from those unit checks. The complete merged-tree regression for this slice passes **7,753 tests / 33 skipped across 365 passing suites**; six OpenLV integration checks also passed separately.

Main `834409b1` was merged in `073301e7` without conflicts. After that merge, all pinned node refresh commands were run explicitly: Ant 0.5.54, freedom-ipfs 0.4.3, libradicle 0.7.1, Myotis 0.1.12 (all provided platforms, official ABI 32 constructor check), and Arti 2.6.0. The Myotis supervisor was rebuilt; Arti used Rust toolchain 1.99.0. All installers exited successfully, `npm run check-binaries` passed, and Ant/Arti reported the expected versions. Main's changed onboarding Electron E2E test passed (one test, 5.5 seconds) using its temporary profile. No root package lock or dependency version changed.
