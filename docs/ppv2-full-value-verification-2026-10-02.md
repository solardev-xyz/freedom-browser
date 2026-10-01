# Full-value withdrawals and separate public-proof verification

The development session now permits a single selected note to be consumed exactly by recipient amount plus the signed relayer fee. This covers native ETH and the existing allowlisted token path. It does not introduce an automatic maximum-amount quote algorithm, combine notes, expand circuit sizes or add a user interface.

The pinned SDK always emits one change note for the qualified `transact_1x1` circuit, including when its value is zero. That circuit range-checks the output and enforces conservation and label inheritance; it does not require a positive output. Main retains those checks and now allows equality at the prover intent, signed quote and durable settlement boundaries. An amount exceeding the input remains refused. The circuit, key derivation and deployment pins are unchanged. The separate selected-note binding fix below changes the runtime archive pin.

Zero-value notes remain in encrypted SDK history and are visible in note inspection, contributing zero to balance. Main refuses their selection for withdrawal or emergency exit before invoking the SDK operation/prover. They are not deleted or silently pruned; they still consume storage capacity. Older host versions with the strict positive-remainder settlement validator refuse journals containing a full-value record, rather than treating them as empty. Do not downgrade a profile that has used the new flow.

The controlled native and token cases exercise deposit, partial withdrawal with lost-response recovery, restart, change-note recovery, then withdrawal of that change note's full value. They observe the zero-value output and test both subsequent withdrawal and emergency-exit refusal. The initial run exposed a second strict guard in the relay journal, now fixed with an encrypted reopen/overspend regression. A later fixture mismatch concerned the sanitized empty-note exit error; the session now returns the explicit safe note-unavailable code. These failed intermediate runs are not qualification evidence for the final code.

## Selected-note binding and runtime pin

Main now derives the selected note’s nullifier through the authenticated adapter as `Poseidon(privateNullifyingKey, selectedCommitment)`, before proving. The selected commitment and derived nullifier must be canonical field elements. The prover result must contain exactly that nullifier as public signal zero before fresh verification. This closes the possibility of accepting an otherwise valid proof for a different same-value, same-label note. The private nullifying key stays inside the existing trusted main-process SDK capability; only the resulting hash crosses the proof-intent boundary.

The runtime adds the main-only `inspectNullifier` export. Recipe `d8fe7b706a52e42cf4761cd9d16958f49603e35f` produced two byte-identical archives in independent output directories: **47,806,767 bytes**, SHA-256 **`a7327fce6acde362b05e439c0db579c06fdc87272feaaa21046b0b34dd182f34`**. The rebuild checker accepts precisely three generated additions to `plugin.cjs`, each required exactly once; after removing those exact additions it matches the normalized historical bundle. All four other bundles and all 20 preserved artifact/metadata files match. Dependency inputs, circuits and the upstream compatibility patch remain unchanged. The old `ce18c67a…` and `fa71e37d…` archives remain preserved, and neither is accepted by the new loader. The funded profile has not been migrated.

## Fresh verification process

Deposit, ragequit and every transact proof receive another cryptographic verification after the witness-bearing prover process exits. The controlled withdrawal cases cover both the partial and the full-value withdrawal, each with preliminary and final proof preparation. The fresh verifier receives only the circuit name, public proof/signals, pinned verification-key bytes and authenticated runtime paths. It cannot receive a witness, proving key or note secrets through its strict job input shape. Main and the job authenticate the runtime; the job verifies the key's exact size and digest before loading the verifier.

Main's intent/public-signal checks, including the selected-note nullifier binding above, run before this step. Only a strictly true verification result permits the same proof object to be frozen and formatted. Calldata and relay-payload comparisons continue binding submitted bytes to that issued object. Failure, crash, timeout or vault/profile revocation refuses preparation before review or journal handoff. A verifier does not turn an RPC observation into verified chain state.

The verifier uses a fresh utility process with a 30-second deadline and the existing 256 MiB heap / 768 MiB RSS limits. RSS enforcement is a soft sampled limit. The pinned verification implementation can create workers, so broader hardware/core-count qualification remains necessary; this change does not promise single-threaded verification. No public proof is sent to an RPC for verification. Network-denial controls remain in the process host.

This is separation of witness-bearing proving from public-proof verification using the **same pinned cryptographic implementation**, not independent cryptography, an OS sandbox or an external security audit. A compromised build or shared cryptographic defect is outside the assurance this additional process provides. The main-process intent checks and their existing trust assumptions still matter.

## Upstream and remaining work

At Kohaku `92fb3a8a2d482ea9582402531e60f4b5131fd6ad`, [the PPv2 source](https://github.com/ethereum/kohaku/blob/92fb3a8a2d482ea9582402531e60f4b5131fd6ad/packages/privacy-pools/src/v2/index.ts) is still a TODO factory returning empty operations. Current batch/paymaster changes belong to PPv1. There is no maintained master-branch PPv2 implementation to replace our PR #258 pin and compatibility patch. Current plugin-interface changes still require compatibility review; do not supply an uncontrolled external sync provider.

Larger input/output circuits, private payments, portable backups and whole-profile rollback recovery remain open. Larger circuit qualification requires a separately pinned runtime/artifact closure and resource measurements. Recovery must preserve every unresolved journal and cannot enable spending from an old backup without fresh reconciliation. Live performance/Tor-relayer behavior, distribution/licensing, audited upstream release/deployment provenance and supported platforms also remain gates. The funded profile is unchanged and its historical archive is still refused by the current runtime pin.

## Qualification

The complete seven-spec real-SDK Electron run passed **21 cases**, with no skips, failures or retries, in 610.6 seconds. The full unit run passed **6,892 tests**, with 33 skipped, across 328 passing suites; the unchanged OpenLV suite had six separate passing cases in the preceding scan qualification. Lint passed. The rebuild checker verified both independent archives and the SDK report’s runtime-integrity attachment.

The fresh verifier’s valid relay-proof run recorded a sampled working-set peak of 226,181,120 bytes (about 216 MiB) on this 14-core darwin-arm64 host with Electron 44.4.5. Altered proofs and a wrong verification key were refused. This is local hardware evidence, not a cross-platform bound.

[Machine-readable evidence and source hashes](qualification/ppv2-full-value-verification-2026-10-02.json) preserve the final SDK statistics and rebuild inventory. Claude reviewed the binding, process wiring, zero-change policy and exact rebuild comparison; the required documentation corrections are incorporated. No live transaction was submitted and the funded profile was not changed.
