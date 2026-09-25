# Seven-candidate pool verification — 2026-09-15

`reserve-recovery.json` records a real Colibri WASM proof verification with availability faults injected for the original three Ethereum candidates. The proof and all reserve responses are live, unmodified public-service responses. Attestant, beaconcha.in and PietjePuk agreed; neither an unavailable candidate nor the prover supplied an authority vote. This specifically demonstrates recovery even when **all three** original candidates are unavailable.

Reproduce from the repo root: `node docs/audits/evidence/myotis-checkpoint-quorum-2026-09/candidate-pool/reserve-recovery.cjs /private/tmp/pool-live-result-new.json`. The retained harness differs only in accepting cwd/output arguments instead of the original absolute paths.

`asar-results.jsonl` records successful verification on Ethereum and Gnosis using actual Electron workers and Colibri WASM from an ASAR archive containing the new pool code. Production source hashes are included. The preceding native recovery/read/restart campaign remains recorded in the parent directory; native code, lifecycle and UI were not changed by this follow-up.

## Published captures

Both files below are generated run output, so they are published in the public [alan-artifacts](https://github.com/solardev-xyz/alan-artifacts) evidence repository instead of this source tree. Nothing in the analysis above changed; `source-hashes.json` stays here so the sources behind these captures remain pinned in-repo. `reserve-recovery.cjs` takes its output path as its first argument, so it never reads or writes a committed capture.

| Generation     | File                    | Link                                                                                                                                                                       |
| -------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| candidate pool | `reserve-recovery.json` | [download](https://raw.githubusercontent.com/solardev-xyz/alan-artifacts/main/solardev-xyz/freedom-browser/pr353/evidence/myotis-checkpoint-quorum-2026-09/candidate-pool/reserve-recovery.json) |
| candidate pool | `asar-results.jsonl`    | [download](https://raw.githubusercontent.com/solardev-xyz/alan-artifacts/main/solardev-xyz/freedom-browser/pr353/evidence/myotis-checkpoint-quorum-2026-09/candidate-pool/asar-results.jsonl) |

Deterministic tests cover reserve replacement, exhaustion of all seven candidates, retaining dissent during replacement, stopping after three conflicting participants, preserving contradictory evidence, and rejecting records with more than three voter origins. HTTPS, request limits and the 90-second total worker deadline still apply. There is no guarantee that all seven services are continuously available or operationally independent.
