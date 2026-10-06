# Exact unsigned relay review: native evidence

Two disposable, synthetic enrolled-account cases passed at commit `98cbfd775b51b729763b552744cba4a6572c0604`. Both used genuine account owners, the actual engine and three fresh utility jobs: signed public-test quote verification, unsigned fee/self construction, then independent reconstruction from the exact serialized draft. The trusted review callback ran only after all three original utilities had closed.

| Observation | Accept | Close while callback is pending |
| --- | --- | --- |
| Review result | Accepted local review | Late approval refused |
| Original callback settlement observed | Yes | Yes; close waited for it |
| Post-review authenticated wallet-state request/reply and journal read | One each | None |
| Read view replaced; borrowed account remains usable | Yes | No |
| Protected encrypted files compared before close | Yes | Not claimed |
| Owned projection/generations unchanged | Checked | Not claimed |
| Account phase reusable after original close | Not this case's assertion | Checked |

Each case selected 700 synthetic WETH base units, allocated 100 to the quoted peer and 600 to self, and recovered both outputs. The quote/construction/reconstruction jobs reported 1/50/33 broker messages, two viewing-key loans in total, and one result each. Each original job closed with exit code 15, without escalation or disconnect, after observing the exact 91 guard hooks/canaries with zero attempts. Two canonical refreshes made ten synthetic header requests. Three pre-admission and four competing-admission refusals were checked. The held-close case settled one pre-existing worker during account close; it did not start a new worker.

The original Electron PIDs were 78915 and 79247; each exited naturally with code 0. Root observed the original preparation and launcher handles exiting naturally with code 0. Both launcher result validations passed, and pre/post source/runtime/SQLite checks were unchanged. These are original root observations, not executions repeated during publication. Independent outcome review cleared both runs against their pinned records; it did not rerun cryptography, native execution or profile work.

Acceptance records `reviewedPreparation:true` locally. It grants no durable reservation, capsule persistence, spend-signing, proof, selected-note POI query or relay-send authority. The held-close case records `reviewedPreparation:false`. Neither plain result is a bearer capability for a future operation. No funded account, deployed broadcaster, live RPC, real gas estimate or operator trust was qualified. Public-test quote signing/address construction occurred in fixture main outside guarded utilities.

The measured callback windows were approximately 0.222 ms for acceptance and 0.468 ms for held-close. This demonstrates completion ordering and late-approval refusal, not sustained or long-held callback behavior. The cancellation case concerns an observed original callback after utilities had already closed. It is not live-child cancellation, forced completion of arbitrary callbacks, OS-sandbox evidence or whole-profile byte identity. Accepted protected-file comparisons occur before account close and cover named encrypted areas only. Storage invariance and unchanged owned generations are deliberately not claimed for held-close. The surrounding journal qualifier also runs historical synthetic checks; the new `exactRelayReviewQualification` hook and its deltas identify this milestone's scope. Source inventories are not execution coverage.

## Archive and source checks

`accept-report.json` and `held-close-report.json` are exact original report bytes. `provenance.json` binds their original root observations, two source freezes/requests, original-process records, result/postcheck records, child-log hashes, and root source-check records. It explicitly labels normalized or projected metadata and omitted fields; original hashes always refer to the unmodified local records. `source-hashes.json` contains 167 committed source hashes: the 166 selected in each report plus the separately checked private-native test. The full 11,649-source/15-symlink inventory is pinned but not duplicated here. Runtime identities include the engine archive, Electron executable/framework, synthetic input and 17 SQLite files.

Root's native-fixture checks passed 207 tests in five suites (1.103 seconds), strict repository lint and six-file formatting. Provenance separately records the actual commands and file lists supplied by root because the original lint/format logs alone do not distinguish their arguments. Earlier core validation remains documented at [the source design](../../railgun-relay-exact-review-2026-10-06.md), with its separate 447-test scope. This archive does not claim a fresh full regression or external security audit.

## Diagnostic reproduction

Use the checked-in [public synthetic input](../railgun-unsigned-relay-preparation-2026-10-06/public-source.json): exactly 8,466 bytes, SHA256 `bfa8684f50b2bb838b026f2c4972653bfc4503d9fd15182c6c5b219ce1bc1e41`. It is the same input named by both original freezes. No duplicate input or private wallet material is included here.

Check out the source commit above and supply matching pinned engine, Electron and installed SQLite inputs from provenance. Clear all other `FREEDOM_RAILGUN_*` flags and Node/Electron injection overrides. Run each scenario separately with its own new absolute output directory:

```sh
FREEDOM_RAILGUN_EXACT_RELAY_REVIEW=accept \
  /absolute/path/to/Electron \
  /absolute/checkout/scripts/qualify-railgun-wallet-journal.js \
  /absolute/checkout/docs/qualification/railgun-unsigned-relay-preparation-2026-10-06/public-source.json \
  /absolute/path/to/fresh-accept-output \
  /absolute/path/to/railgun-engine.asar enrolled
```

For the second case, use `FREEDOM_RAILGUN_EXACT_RELAY_REVIEW=held-close` and a distinct fresh output directory. Every argument path must be absolute. Outputs must not exist and should be outside the checkout and separate from all inputs. The fixture creates a disposable profile; use only the public synthetic input above. No prover or proving-artifact arguments belong to this mode.

This direct invocation is a diagnostic rerun. It does not automatically reproduce the archived external launcher's frozen source/runtime/SQLite verification, strict report validation or original-parent-process observations. That separately reviewed launcher and runtime payloads are not distributed here. The reports omit the plaintext quote and encrypted draft; digests cannot independently replay their original reconstruction. A rerun constructs a fresh quote and draft.
