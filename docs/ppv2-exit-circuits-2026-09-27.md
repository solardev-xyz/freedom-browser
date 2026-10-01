# PPv2 exit circuit and resource qualification

Date: 2026-09-27. Continues [reviewed deposit handoff and note recovery](ppv2-lifecycle-2026-09-27.md). SDK source remains pinned at `fe0244e3`, Kohaku at `6fdc248b` plus the existing compatibility patch. Main was fetched again and is still fully merged at `2983dc62`. No application dependency, node pin, product prover budget or production gate changed.

## What was exercised

Hydrated only the pinned Git LFS WASM/proving-key objects for `ragequit` and `transact_1x1`; verification keys were already present. The qualification builder checks every artifact against the SDK's SHA-256 manifest and records size/digest in the isolated ASAR. No setup ceremony, substitute key generation or runtime download was performed.

The new scratch job constructs public synthetic notes, real Poseidon commitments, keystore/state/association-set trees, and SDK witnesses. It runs the SDK `ProofService` through the existing main-owned utility-process host:

- Ragequit binds all seven public signals: nullifier, commitment, keystore root, owner, full note value, token and label.
- The 1×1 transact case spends a synthetic 10,000-unit note into a 6,000-unit public withdrawal and 4,000-unit private change. All eight public signals are checked, including the three roots and context.
- Both proofs verify with the pinned verification keys. Changing the public amount causes verification to fail.
- Locking the real test vault after proof work starts terminates the job; no surviving prover PID is observed. A fresh unlock completes another proof.

These are actual offline circuit proofs in Electron, not a full relayed withdrawal or on-chain contract execution. Recipient/relayer/calldata binding at the wallet boundary still needs implementation. Only the 1×1 transact shape was qualified; this does not qualify the other 24 transact shapes.

## Memory result and available configuration

The default SDK prover crossed the unchanged **768 MiB** sampled RSS limit for both circuits. Both completed with a **test-only 2,048 MiB** ceiling. The underlying pinned `snarkjs@0.7.5` supports `{ singleThread: true }` as the sixth `groth16.fullProve` argument, although the SDK's thin `Groth16Prover` wrapper does not expose it.

The scratch builder now emits a separate `serial-prover.cjs` factory using that supported option from the SDK's existing locked dependency. It does not patch the SDK, add a dependency, change versions or replace cryptographic artifacts. Proof verification still uses snarkjs's ordinary verifier. With this factory, both jobs fit within the existing 768 MiB ceiling.

Packaged macOS arm64 measurements from one run:

| Circuit      | Factory       | Proving time | Sampled peak RSS |
| ------------ | ------------- | -----------: | ---------------: |
| ragequit     | SDK default   |       382 ms |          980 MiB |
| ragequit     | single-thread |     1,637 ms |          539 MiB |
| transact_1x1 | SDK default   |       849 ms |        1,476 MiB |
| transact_1x1 | single-thread |     4,596 ms |          599 MiB |

Times measure proof generation, excluding process startup, witness construction and verification. Memory is sampled process RSS, not a hard OS allocation quota or total application memory. These synthetic, single-note measurements are not a device-support or latency guarantee. The default worker pool scales with reported CPU count, so repeat on other hardware before choosing product limits. Larger note sets/shapes remain unmeasured.

**Recommended next implementation:** inject the qualified single-thread prover through the existing proof-service factory for a narrow first exit bridge, retaining the 768 MiB default and existing cancellation. Do not globally raise the host budget based on a fixture pass.

## Validation and reproduction

Source Electron passes both circuits with both factories (separate default and single-thread runs). Packaged Electron: **5 passed**, including executable preflight and all four circuit/factory combinations. Lint and whitespace checks pass. This slice changes qualification scripts/tests/docs only; the preceding full application regression remains 5,605 pass, 33 skip and the same 3 baseline failures.

See [the packaged measurements and artifact hashes](qualification/ppv2-exit-circuits-2026-09-27.json). Build the scratch ASAR with:

```sh
node scripts/spike-ppv2-process.js /absolute/pinned-ppv2 /absolute/generated-compat-directory --exit-circuits
```

Use its output as `FREEDOM_PP_V2_PROCESS_ASAR` for `test-e2e/ppv2-exit-circuits.spec.js`. The final scratch report is `/private/tmp/ppv2-exit-asar.json`; source logs are `/private/tmp/ppv2-exit-source.log` and `/private/tmp/ppv2-exit-serial-source.log`; packaged results are `/private/tmp/ppv2-exit-packaged.{log,json}`. No witness/proof material is included in the checked-in report.

## Remaining integration boundary

The Kohaku candidate's private operation is a chosen relay quote/argument set, not a final proved payload. Its broadcaster calls the shared SDK session, which re-proves, submits and updates note state. Simply wrapping `broadcast()` after it returns would journal too late. A wallet integration must bind review to the exact final payload and persist an attempt before the relayer HTTP submission; a lost response must stay unresolved across restart. No relayer submission capability was enabled by this work.

Escape/ragequit can use the reviewed public transaction lifecycle once the main bridge binds owner, note commitment, asset/value, proof and target. Final upstream identity/distribution, matching audit/deployment, remote-state trust, supported platforms and UI/recovery decisions remain production gates.
