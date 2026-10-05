## October 5 update: normal Railgun change scan and verified test-list membership

This update supersedes the progress summary below. The [preceding combined-proof checkpoint](https://github.com/solardev-xyz/freedom-browser/blob/c6a1336e0933d92d2bef4dce5eb68bcf237efae3/docs/privacy-progress-history-2026-10-05-durable-combined-poi.md) is preserved verbatim, and the complete earlier roadmap remains below.

The controlled Railgun journey now connects an actual partial withdrawal to the ordinary wallet scan of its real private change. The original input is spent by the exact first transaction; the recovered change matches its commitment, coordinates, token, amount and blinded output. The normal membership query first returns Missing. Only after the fixed sender posts the exact retained proof and the disposable service verifies both its cryptography and transaction/change bindings does a fresh normal query verify Valid membership.

**This is a test-service milestone, not a second spend or live acceptance.** The next withdrawal still needs genuine staging of the actual change, a fresh reservation, fresh window-bound membership/root/preflight checks, signing, proving and submission. That implementation is underway. Restart/second spend, partial Kohaku facade integration, live private qualification and eventual portable-adapter extraction remain open; user-facing activation is still disabled.

The [checkpoint report](https://github.com/solardev-xyz/freedom-browser/blob/c6a1336e0933d92d2bef4dce5eb68bcf237efae3/docs/railgun-combined-change-integration-2026-10-05.md) and [evidence index](https://github.com/solardev-xyz/freedom-browser/blob/c6a1336e0933d92d2bef4dce5eb68bcf237efae3/docs/qualification/railgun-combined-change-integration-2026-10-05.json) record exact source inventories, raw reports, diagnostics and limitations. Both input types pass twenty connected stages (97,146/105,876 ms); default first-stage compatibility passes seventeen (95,242 ms). All three share 856 source hashes, with expected utility closures, no fixture violations and all three observed key copies wiped.

The scan changes exactly the active wallet database/coverage and its encrypted scan journal. The subsequent active restores change only that journal. All other files in the measured accounts tree and the privacy-inventory marker stay byte-identical; the EOA submission journal is separately compared logically. This does not claim a byte comparison of vault files or the entire profile.

Focused checks pass 86 tests across five suites, with a subsequent overlapping 38-test check of the corrected mock capture shape; lint is clean. Native bringup found a latent defect in the earlier unit-only test helper: proved transactions store the public sender separately. The helper now uses the authenticated captured sender exactly as production does, and rejects substitution. Failed and superseded runs remain identified in the evidence.

No production, package, dependency or policy bytes changed from c5d75f05, whose frozen regression passed 15,731 tests across 517 suites with the documented skips, OpenLV exclusion and forced-exit limit. That earlier regression is referenced at its actual source snapshot, not relabeled as a new run. The previous retained-store v3 downgrade consequence still applies: older builds refuse the entire retained-POI store after the first combined prepare.

All new chain/list/transport observations remain synthetic, the list uses an explicit disposable signing key and one leaf, and account reopening is same-process. No funded profile or live service was accessed. Claude reviewed the code, native evidence and documentation; independent Codex agents contributed components and controls. This is engineering review, not an external security audit. Main remains dbfd0e7d. Implementation: c6a1336e0933d92d2bef4dce5eb68bcf237efae3.

---

