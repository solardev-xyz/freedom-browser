## October 5 update: completed-wallet restoration and interrupted-proof recovery foundation

Checkpoint `e16a9adb` adds a fixed read-only route for restoring an existing completed Railgun wallet. **Original-signature proof resumption is the next implementation step; partial submission, durable combined POI and live private spending remain open.**

### What changed

- Main authenticates registered existing storage, saved coverage and exact wallet state against the completed journal before contacting the source or lending a viewing key. A distinct cold restore path avoids a writable bootstrap; repeated restores retain genuine receipt checks. Missing, pending, stale and unregistered states refuse without repair or cache advancement.
- SQLite opens read-only, skips retired-page collection and checks file changes on close. The completed journal keeps its existing lease. This is not hostile-filesystem rollback protection.
- The runner drains admitted callbacks, storage and credential work. Unobserved child exits retain account exclusion and quarantine that account's credential issuance until application restart; late loans are wiped. These fault cases have unit coverage.

### Evidence and limits

All 849 focused tests across 14 suites pass; lint is clean. A fresh native run passes 12 measured groups in 26,031 ms with 531 unchanged source hashes. All measured routes preserve account-directory and inventory bytes and filenames. Successful restores use 23 header reads plus one log query each; stale-checkpoint refusal and held-response cancellation have separately recorded traffic. No selected-nullifier, POI, EOA or private-preflight query occurs in that run.

Existing Shield and received-Transact partial-controller compatibility runs pass in 22,910/33,010 ms, each with 522 unchanged hashes. They retain the previous checkpoint's simulated chain/service/list trust and creator limitations. The completed run uses simulated transport/services too: it establishes same-process reopening and logical cancellation drainage, not fresh-process restart, physical Tor/socket behavior or live service acceptance. Snapshots start after ordinary enrollment/public-owner setup. The initial failed native run is diagnostic only. Claude reviewed implementation, evidence and prose; Codex also reviewed storage. This is engineering review, not an external security audit.

### Next and policy impact

Recover all three private kinds and both input creators from the original authenticated capsule/signature, with no new signing or admission, then independently verify and fill only the original proof slot. Continue partial submission/capture, combined POI persistence, actual change ingestion, fresh-process restart/second spend and live qualification. Portable Host extraction, UX and release readiness remain open.

Runner and coverage changes advance the derived-wallet policy to `e8cf7121`; public/TXID policies are unchanged. Existing wallet generations require explicit maintenance; recovery must not silently rebuild them. No funded profile was opened. Main `dbfd0e7d` remains current, with its earlier explicit node refresh. No dependency, runtime pin, IPC or renderer change. The previous full regression remains historical.

Details: [checkpoint](https://github.com/solardev-xyz/freedom-browser/blob/b9158f9b4004e7224be605d336dc9ba8a363677c/docs/railgun-completed-wallet-2026-10-05.md), [qualification index](https://github.com/solardev-xyz/freedom-browser/blob/b9158f9b4004e7224be605d336dc9ba8a363677c/docs/qualification/railgun-completed-wallet-2026-10-05.json), [roadmap](https://github.com/solardev-xyz/freedom-browser/blob/b9158f9b4004e7224be605d336dc9ba8a363677c/research/privacy-roadmap.md). The [preceding received-input update](https://github.com/solardev-xyz/freedom-browser/blob/b9158f9b4004e7224be605d336dc9ba8a363677c/docs/privacy-progress-history-2026-10-05-transact.md) is preserved verbatim with links to earlier checkpoint histories. Older historical detail follows.

---

