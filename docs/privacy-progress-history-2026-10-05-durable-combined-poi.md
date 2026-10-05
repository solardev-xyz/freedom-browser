## October 5 update: durable combined Railgun proof

This update supersedes the progress summary below; the complete earlier roadmap and evidence remain preserved. The preceding [submission-after-restart update](https://github.com/solardev-xyz/freedom-browser/blob/c5d75f05972b1f255c82b6e9cd8d5003ff3f76ff/docs/privacy-progress-history-2026-10-05-cold-submission.md) is archived byte for byte.

The internal Railgun host now generates, saves, recovers, validates and submits one combined privacy proof for a partial withdrawal and its private change. The genuine operation, exact transaction ID, ordered commitments, amounts, creator and source/root history remain bound throughout. Recovery reconstructs change with one viewing credential; a full withdrawal remains keyless. A response to the proof POST does not establish service acceptance or make change spendable.

**This is the first stage of the full change lifecycle.** Normal wallet change ingestion, verified list acceptance, restart and second spend, partial Kohaku facade integration and live private qualification remain open. The partial user flow remains disabled. The next stage connects the actual scanned change to a fresh ordinary membership check and a second withdrawal; it must not use a fabricated note or a successful POST as spending authority.

The [checkpoint report](https://github.com/solardev-xyz/freedom-browser/blob/c5d75f05972b1f255c82b6e9cd8d5003ff3f76ff/docs/railgun-combined-poi-integration-2026-10-05.md), [raw evidence index](https://github.com/solardev-xyz/freedom-browser/blob/c5d75f05972b1f255c82b6e9cd8d5003ff3f76ff/docs/qualification/railgun-combined-poi-integration-2026-10-05.json), [implementation plan](https://github.com/solardev-xyz/freedom-browser/blob/c5d75f05972b1f255c82b6e9cd8d5003ff3f76ff/docs/railgun-durable-combined-poi-plan-2026-10-05.md) and [parity ledger](https://github.com/solardev-xyz/freedom-browser/blob/c5d75f05972b1f255c82b6e9cd8d5003ff3f76ff/docs/railgun-parity-plan-2026-10-04.md) describe the code, reproducible qualifier arguments and remaining work.

Validation:

- Shield and received-Transact native cases pass with 851 identical source hashes. Both connect actual partial proving/signing and journal capture to seventeen combined-proof stages, including copied-authority refusal, prepared/attempted recovery, wrong-output refusal, denied reviews and one fixed POST.
- All utility/worker exits are observed; each run has exactly two intentional wrong-output revocations, no fixture violations and all observer key copies wiped. The held POST excludes concurrent attempted recovery.
- Eight compatibility invocations pass: six warm partial-submission cases and two default warm proof-recovery cases. Their common 1,392-file repository inventory is unchanged.
- Focused and dependent checks pass 3,357 distinct tests across 39 suites. The separate disposable-list helper has 49 mocked unit tests; it is not exercised by this native pair. Lint is clean.
- The frozen 1,392-file regression passes 15,731 tests across 517 suites in 719.744 seconds (33 tests/five suites skipped). The earlier restricted run is retained as a failed environment diagnostic: local listeners/probes were blocked. The regression retains the existing OpenLV exclusion and forced-exit limitation.

The account's first combined prepare upgrades retained POI history to document version 3. **Older builds refuse the entire retained-POI store, including its earlier legacy entries and recovery paths.** Unrelated wallet stores are not migrated. Existing legacy canonical records remain unchanged; there is no downgrade writer or extra rollback protection. A user-facing changelog entry is required when the partial flow is activated.

All chain, receipt/finality, list and transport observations in these new native runs are synthetic. Account reopen is within one process. The runs do not qualify real service acceptance, normal change eligibility, a second spend, new-process combined recovery, mixed legacy native migration, partial facade use or live submission. No funded profile was opened. The future list helper is unit-qualified only; the change-scan composition remains under development.

Claude reviewed the production stack, fixtures, native evidence and this documentation; independent Codex agents contributed components and controls. This is engineering review, not an external security audit. Main remains at dbfd0e7d; runtime, dependency and policy pins are unchanged. c5d75f05972b1f255c82b6e9cd8d5003ff3f76ff.

---

