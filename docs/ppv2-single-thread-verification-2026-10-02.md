# PPv2 single-thread public-proof verification

This continuation removes worker-per-core verification from the fresh public-only proof verifier. It uses the same pinned snarkjs 0.7.5 implementation and the same BN254 curve arithmetic, with one narrowly scoped local build adaptation. There is no dependency upgrade, circuit/key change, new cryptographic algorithm or production activation.

## Exact adaptation and runtime

The source file `snarkjs/build/main.cjs` must have SHA-256 `e99bbb85ee536fd64476f87492665d1a382e930e4e412278a3fd8e2f987c283f`. Only inside its uniquely identified `groth16Verify` function, the builder changes `getCurveFromName(vk_verifier.curve)` to `getCurveFromName(vk_verifier.curve, { singleThread: true })`. This snarkjs-local helper forwards the option to `ffjavascript.buildBn128`. It is not a public `groth16.verify` option, and it is not the differently shaped helper in ffjavascript's other module closures. The matching call in PLONK remains untouched.

The transform is attached only to the `serial-prover.cjs` build. The file digest, unique function signature, bounded body and exactly-one call checks all fail closed; missing or repeated adaptation also fails the build. `build-inventory.json` records `snarkjsAdaptation: groth16-verify-single-thread-v1`. The dependency inventory continues to hash the original inputs; the committed recipe identifies the local modification. This is a **locally modified GPL-3.0 build output**, and the existing complete-closure licence/provenance and distribution gates remain in force.

Two independent output directories produced the same **47,806,955-byte** archive, SHA-256 **`eacc32476b2fc3be0344e1c9b341a9964e405f59703604385b29307350bcca7a`**, from recipe `e673d45abbe5e983d41a60bb9b6d4b039c75bea8`. The checker reverses exactly the anchored generated Groth16 call change and the previously reviewed plugin helper additions, then compares every remaining bundle byte with the normalized historical runtime. The other three bundles, PLONK call and all 20 artifact/worker/metadata files remain unchanged. The current loader rejects the historical `ce18c67a…`, `fa71e37d…` and `a7327fce…` archives. None was deleted or installed into the funded profile.

## Scope and enforcement

Before loading the serial verifier, the fresh verification job replaces `worker_threads.Worker` with a refusing constructor and refreshes the built-in ESM exports. A successful valid-proof check therefore cannot depend on creating a worker through that path. After verification, the job requires the shared `curve_bn128` cache to remain empty. ffjavascript initializes that cache to null; its single-thread path creates a fresh curve without populating it. The dedicated process then exits, reclaiming its WASM memory. The 30-second, 256 MiB heap and 768 MiB sampled RSS budgets are unchanged.

The same serial bundle also makes the in-process verification in the withdrawal and emergency-exit prover jobs single-threaded. **The deposit job's original in-process verification still uses the unchanged `sdk.cjs` implementation and can create workers.** Its additional fresh public-only verification uses the new single-thread path. This closes the fresh-verifier core-count dependency, not all proving/runtime platform qualification. JavaScript worker hooks are not an OS sandbox or protection against malicious native code.

## Qualification

The new real-SDK process case creates genuine synthetic proofs for deposit, ragequit and transact_1x1. Each is checked in a fresh verifier process, followed by a second fresh process with public signal zero changed to another valid field element. The expected outcomes are exactly three true and three false. Crashes, timeouts, malformed results and key-validation failures do not count as negative-control passes. Existing operation cases also exercise the production verification wrapper and its reviewed transaction paths.

The complete seven-spec real-SDK run passed **22 cases**, without skips or retries, in 598.5 seconds. Full unit regression passed **6,894 tests / 33 skipped**, with six OpenLV cases passing separately. Lint passed. The rebuild checker verified both independent archives and the full SDK report’s runtime-integrity attachment.

| Circuit        | Control        | Result | Sampled working-set peak |
| -------------- | -------------- | ------ | ------------------------ |
| `deposit`      | valid          | true   | 86.03 MiB                |
| `deposit`      | changed-signal | false  | 86.42 MiB                |
| `ragequit`     | valid          | true   | 85.75 MiB                |
| `ragequit`     | changed-signal | false  | 85.58 MiB                |
| `transact_1x1` | valid          | true   | 85.59 MiB                |
| `transact_1x1` | changed-signal | false  | 85.59 MiB                |

These fresh-process observations are roughly 86 MiB on this 14-core darwin-arm64 host, compared with the earlier 226,181,120-byte (about 216 MiB) relay-verifier observation. This is not a statistical performance benchmark or a cross-platform bound. Worker refusal and empty-cache requirements are enforced job conditions, not separate operating-system measurements.

After the full run, two report-only flags were renamed to `enforcedByJobGuards` for clarity. The affected three-circuit test passed again; proof generation, verification and assertions did not change. [Machine-readable evidence](qualification/ppv2-single-thread-verification-2026-10-02.json) preserves both test-source hashes, both run statistics, individual memory observations, exact rebuild comparisons and the license/coverage limitations. Claude reviewed the source adaptation, process guards, checker and real-proof controls. The funded profile is unchanged and no live transaction was submitted by this qualification.
