# PPv2 recovered-note emergency exit

Date: 2026-09-27. Continues [reviewed handoff and recovery](ppv2-lifecycle-2026-09-27.md) and [exit-circuit qualification](ppv2-exit-circuits-2026-09-27.md). SDK remains pinned at `fe0244e3`, Kohaku at `6fdc248b` with the existing compatibility patch. This is an experimental, main-only native ragequit bridge through Kohaku. It is the public owner-bound emergency escape path, not an ordinary private withdrawal or transfer.

## Implemented boundary

The session optionally exposes `prepareNativeRagequit(commitment)` when main supplies the reviewed prover factory. It selects a recovered native note and refuses spent, exited or exit-pending notes. Main binds the requested commitment, full value, public owner and configured pool to one proof operation. It then accepts exactly one canonical zero-value `ragequit` call containing that exact issued proof. Extra calls, another target, altered proof/calldata or nonzero transaction value are refused.

The utility-process job accepts only the bounded ragequit witness and three local artifacts pinned by size and SHA-256. It proves and verifies with the qualified single-thread factory under the unchanged 768 MiB sampled RSS limit. The witness necessarily contains the protocol nullifying/revocable keys and note secret; it does not contain the wallet mnemonic or Ethereum signing key. Existing cancellation and network guards apply. These guards are not an OS sandbox, and JavaScript memory clearing is not a secure-erasure guarantee.

Main checks six public signals against the selected note/witness: commitment, keystore root, owner, value, native token and label. The nullifier is verified by the pinned circuit and is not independently derived by main. Proof arrays are frozen, and formatting accepts only the proof issued by the current operation. Keystore root and recovered note state still come from unverified remote observations; proof verification does not authenticate that root as canonical chain state.

Submission uses the existing one-use preparation, explicit review, bounded gas budget, simulation, exact signed-transaction intent fingerprint and encrypted journal persisted before network handoff. Review receives the note commitment and full exit amount. The wallet signer stays in main. The escape path does not introduce a viewing-key registration prerequisite. No relayer submission capability is granted.

## Qualification

The strengthened lifecycle fixture now traverses registration, deposit, uncertain-submission recovery, independent note reconstruction and a native emergency exit. It uses the real pinned SDK/Kohaku implementation, real proofs, the wallet signing service and controlled RPC fixtures only. Registration emits a real-format authorization leaf so the SDK builds the keystore Merkle proof.

After the existing process-restart recovery check, a third Electron process unlocks the same test profile, explicitly reconciles the uncertain deposit, recovers the 10,000-wei note, prepares/proves its ragequit, reviews/signs and submits the transaction to the controlled transport. A subsequent SDK scan observes the corresponding exit event. The resulting `exited` status is an RPC observation, not live execution or independently verified finality. ASP approval is not fabricated or required by this escape fixture.

- Focused bridge/session tests: **47 passed**. Adversarial cases cover witness widening, owner/token/value changes, six altered public signals, changed target/value/proof, extra transactions, trailing calldata, mutable input snapshots and cancellation.
- Full regression: **5,620 passed, 33 skipped, the same 3 baseline failures**: two macOS shortcut-remap cases and the Safe fork integration case.
- Source Electron expanded lifecycle: **1 passed**. Packaged macOS arm64: **3 passed**, including executable preflight, native deposit and expanded lifecycle.
- Seven affected packaged wallet modules match source byte-for-byte. Lint and whitespace checks pass. Application dependency/lock files and product limits are unchanged.

See [the packaged lifecycle and exit report](qualification/ppv2-native-ragequit-2026-09-27.json). Logs: `/private/tmp/ppv2-ragequit-{unit,regression,lint,source,build,packaged}.log`; full packaged results: `/private/tmp/ppv2-ragequit-packaged.json`.

For reproduction, build the pinned scratch SDK ASAR with `scripts/spike-ppv2-process.js /absolute/pinned-ppv2 /absolute/generated-compat-directory --exit-circuits`. Supply it as `FREEDOM_PP_V2_PROCESS_ASAR` when running `test-e2e/ppv2-lifecycle.spec.js` in the harness or packaged project. The expanded lifecycle now requires exit artifacts and the single-thread factory.

## Remaining work

Normal private transfer/unshield still needs final recipient/relayer/payload binding and a durable operation ledger before relayer HTTP submission. The current candidate combines proving, submission and state mutation in its broadcaster, so journaling after it returns is too late. ERC-20 approval sequencing, ASP approval/revocation, additional transact shapes, live matching deployments and broader platform/egress qualification remain open.

Recovery inspection preserves the encrypted cache on conflicting observations. Choosing which remote view can replace local or terminal note state remains a separate trust/recovery decision. Note-specific timestamp queries also expose commitment interests to the RPC despite Tor.

Final upstream identity/distribution, matching audit and deployment, dependency/license review, and product review/recovery UX remain production gates. No production setting, renderer/IPC flow or live transaction was enabled.
