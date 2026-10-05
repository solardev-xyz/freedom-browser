# Connected Railgun restart implementation — qualification pending

The public-vector lifecycle qualifier now has separate `restart-setup` and `restart-resume` modes. This is an implementation checkpoint, **not a passing complete restart qualification**. Production code, runtime/policy pins, dependencies and user interfaces are unchanged.

Setup executes the genuine partial-withdrawal proof, retained combined POI attempt, disposable list acceptance and normal change scan. After all owners drain and the profile lock is released, it seals a bounded handoff containing public service wire and hashes. Resume requires the setup PID to be absent, verifies the same source/runtime/artifact/vector and encrypted-profile bytes, and opens the existing account without creating replacement generations. Only the disposable service public key is replayed; no signing API or acceptance constructor is restored. The accepted request is represented by `acceptedBodySha256`, not a plaintext request body.

The fresh process authenticates the original private records, first resolved Ethereum record, retained POI attempt, complete source history and existing TXID mirror. It then invokes the genuine second-spend and terminal-scanning paths. These continue to preserve unrelated notes and require the selected change to become spent; they never assert that the entire wallet balance becomes zero.

## Evidence at this checkpoint

- Root's final pre-native focused run passed 250 tests in 14 suites in 9.258 seconds; lint passed. The later storage-observer repair passed all 13 tests in its suite in 0.354 seconds and full lint. These counts are not added to the author's overlapping scratch tests.
- Shield setup-a completed its main work but exited 1 while sealing: the fixture expected the wrong vault filename. It is a failed diagnostic, despite the early success line emitted by that older source.
- Shield setup-b sealed successfully in 90,847 ms. Its separate resume failed before second signing because the fixture passed an Ethereum transaction hash to a mirror API indexed by the Railgun Poseidon transaction ID.
- Shield setup-c sealed successfully in 88,125 ms. Its fresh resume passed restoration and reached the actual second transaction: one Ethereum review, one signature, one journal-before-send observation and one simulated send. It then failed during terminal TXID advancement because a bootstrap-only pending-state assertion remained active during an ordinary pending update. This is still a failed complete run, not terminal balance evidence.
- Setup-b and setup-c each recorded 880 source hashes, but those source inventories differ. Neither is evidence for later repaired or merged sources. No failed profile will be reused.

The fixed vault snapshot hashes `identity/identity-vault.json` as `encryptedVault`; unlocking does not rewrite it. Witness lookup uses the authenticated retained proof's `railgunTxidIfHasUnshield` without its hex prefix, and still requires the returned row to equal the independently reprojected original row. The unit mock now distinguishes that identifier from the Ethereum hash. Abnormal child outcomes are retained before audit assertions, and setup prints success only after sealing.

Reviewer-requested improvements also bind all nine artifacts for 01x01, 01x02 and POI_3x3; reject instrumentation installed after privacy-storage was imported; and remove unrelated formatting changes. Claude reviewed these repairs and the authority/cleanup boundaries. This is engineering review, not an external security audit. The bootstrap observer now limits enrollment/pending-state checks to restart bootstrap phases. A separate real encrypted-storage test verifies bootstrap refusal and ordinary later pending/update/set delegation without bypassing the import-order guard. This repair has not yet passed a complete native restart.

## Remaining acceptance work

Run both original input creators through fresh setup/resume process pairs on the final merged source inventory, then rerun default/change/second-spend/terminal compatibility. Verify predicted bootstrap and operation counters, actual process exits, worker drainage, key wiping, unchanged original records and final selected-change accounting. A setup report alone never qualifies the complete sequence.

Cold submission of the second already-proved transaction and original-signature recovery of its interrupted proof are separate next stages. The partial Kohaku facade and its genuine native qualification remain scratch candidates under review. Live list acceptance, live private transfer/withdrawal, private broadcasting and portable adapter extraction remain open. All work described here uses public vectors and synthetic external services; no funded profile was opened and no live private transaction occurred.

## Local diagnostic provenance

Private disposable profiles and handoffs are deliberately not published. Local evidence is retained under `/private/tmp/railgun-connected-restart-native-shield-oct5-{a,b,c}` with separate setup/resume logs. Root test/lint logs use `/private/tmp/railgun-connected-restart-root-oct5-*`; `freeze-c.json` identifies the sources used by setup/resume-c. The frozen author package remains `/private/tmp/railgun-combined-change-restart-draft-oct5`; it predates the documented root repairs and is not the final source manifest.
