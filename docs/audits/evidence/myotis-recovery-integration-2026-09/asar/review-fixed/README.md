# ASAR verification after adversarial-review fixes

Repeated the parent ASAR campaign on 2026-09-14 after response classification and runtime-compatibility checks changed. Real Electron 44.3.0 loaded the production parent and worker from ASAR, used Colibri 2.0.6 WASM, verified both chains, and exited 0. `result.jsonl` contains only public checkpoint metadata. `source-hashes.json` identifies the exact verified source. Use the parent `prepare.js` to reproduce; its staging process copies the checkout source and installed Colibri package unchanged. `result.jsonl` is generated run output, so it is published in the public [alan-artifacts](https://github.com/solardev-xyz/alan-artifacts) evidence repository instead of this source tree; check a download against this directory's retained `SHA256SUMS` before relying on it.

| Generation        | File           | Link                                                                                                                                                                       |
| ----------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ASAR review-fixed | `result.jsonl` | [download](https://raw.githubusercontent.com/solardev-xyz/alan-artifacts/main/solardev-xyz/freedom-browser/pr353/evidence/myotis-recovery-integration-2026-09/asar/review-fixed/result.jsonl) |

The same scope limits apply: targeted ASAR/worker/WASM loading, not a full signed package or cross-platform qualification. Prior evidence is preserved.
