## Latest milestone: Railgun second withdrawal across three processes (October 5, 2026)

Branch checkpoint: 94fc035e0610dfa81da0cb616bd329a3c3185e26. The native campaign is pinned to `7540636842b8e2d746a223ba2444610c42cbd01d`. Main 484bf259 is subsequently merged; all bundled node downloads were rerun, the Myotis supervisor rebuilt, and 57 affected startup/profile tests plus lint and binary checks pass. [Merge/refresh evidence](https://github.com/solardev-xyz/freedom-browser/blob/94fc035e0610dfa81da0cb616bd329a3c3185e26/docs/privacy-main-sync-484bf259-2026-10-05.md). This remains a draft with product activation disabled.

The second withdrawal now crosses a separate prove-then-shutdown boundary. A fresh process reopens two authentic encrypted records and invokes the production recovered-submission host, reacquiring wallet/TXID/creator/proof/list/root/preflight/review/journal authority without another private signature or proof. Both initial input histories and acknowledged/lost-response outcomes pass; duplicate attempts refuse before and after reconciliation, and normal terminal ingestion spends only the selected change while preserving unrelated funds.

All 18 native processes exited 0: four three-process recovery cases plus six compatibility processes, all sharing 913 source hashes. Root checks pass 366 tests/24 suites and full lint. P1 uses 17 utilities/6 workers and no EOA signature/send; P2 uses 23/7 with exactly one journaled EOA signature/send. The earlier full regression remains pinned below.

All network responses, list acceptance, receipts/finality and review decisions remain simulated. This is orderly restart evidence, not power-loss or live-private qualification. The exact two logical RPC-handle releases on duplicate refusal are checked separately; no new requests, keys, reviews, signatures or sends are allowed. Two failed setup/assertion bring-ups remain diagnostics and their profiles were not reused.

Evidence and limits: [second cold submission](https://github.com/solardev-xyz/freedom-browser/blob/94fc035e0610dfa81da0cb616bd329a3c3185e26/docs/railgun-second-cold-submission-2026-10-05.md), [machine-readable index](https://github.com/solardev-xyz/freedom-browser/blob/94fc035e0610dfa81da0cb616bd329a3c3185e26/docs/qualification/railgun-second-cold-submission-2026-10-05.json), [parity plan](https://github.com/solardev-xyz/freedom-browser/blob/94fc035e0610dfa81da0cb616bd329a3c3185e26/docs/railgun-parity-plan-2026-10-04.md), [roadmap](https://github.com/solardev-xyz/freedom-browser/blob/94fc035e0610dfa81da0cb616bd329a3c3185e26/research/privacy-roadmap.md). The production adapter and full 16,276-test regression remain pinned to 189c0a31; this checkpoint extends fixtures only.

Claude and a separate Codex reviewer checked implementation, evidence and publication claims. This is engineering review, not an external security audit. Retained-POI version 3 remains a downgrade boundary: older builds refuse the entire store after its first combined prepare.

Next: original-signature recovery of an interrupted second proof; two actual Kohaku instances consuming scanned change; external-service and live-private qualification; portable adapter extraction; user-facing design and activation. No funded wallet or live owned selector was opened by this campaign.

The preceding current-status prefix is preserved verbatim in [partial-facade history](https://github.com/solardev-xyz/freedom-browser/blob/94fc035e0610dfa81da0cb616bd329a3c3185e26/docs/privacy-progress-history-2026-10-05-partial-facade.md). The detailed issue/PR history below is retained unchanged.

---

