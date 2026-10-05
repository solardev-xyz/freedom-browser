## October 5 update: Railgun submission after restart

Railgun can now submit an authenticated saved private proof after a clean restart, reusing its original signature and calldata while acquiring fresh source, membership, root and preflight authority. **Fourteen three-process native cases pass**, covering both deposited and received inputs, transfers/full/partial withdrawals, advanced/unchanged roots and acknowledged/lost replies. Partial facade exposure, durable combined POI, normal change ingestion/second spend and live private qualification remain open.

### Evidence and limits

Every case uses a fresh disposable public-vector profile. The account, storage, proof, signer and journal implementations are genuine; chain/list/service responses and broadcast transport are simulated. No funded profile is opened. Public submitter metadata is fixture-written, so production metadata onboarding is not qualified.

Each cold case signs/sends once, with its attempt durable before transport. A lost reply retains the known hash and forbids automatic retry. Duplicates refuse before new disclosure, keys or network work. The received-partial case also holds actual review beyond its deadlines: no signing/sending occurs, and account exclusion lasts until the callback drains. That test does not isolate which lifetime expired. The genuine POI verifier's deliberate failure on invalid membership proofs is an exact, drained exception; other utilities close normally.

All cold cases share **538 source hashes** checked against the final tree. Two default warm proof-recovery and six existing partial-submission/capture cases also pass. The focused suites pass 465 tests; the frozen **1,378-file repository regression passes 15,457 tests across 512 suites** in 606.564 seconds (33 tests/five suites skipped). The established OpenLV exclusion and forced Jest exit remain explicit limits. Native child/worker drainage is checked separately.

Cold review admission requires 50 seconds remaining on its fresh proof-verification, preflight, POI and root receipts; setup has roughly ten seconds under their 60-second lifetimes. Real transport latency still needs qualification. The existing review deadline is not renewed. Clean restart is not power-loss evidence, and fresh receipts over simulated services are not live acceptance. No UI, IPC, dependency, runtime or policy change; main dbfd0e7d remains current.

Claude reviewed the production changes, native evidence and documentation; independent Codex reviewers authored controls and fixture corrections. This is engineering review, not an external security audit.

### Next

Connect durable combined POI, normal change ingestion, restart and a second spend of that actual change; then qualify live private flows. The reviewed next-stage design includes a one-transition version-3 retained-store migration and its whole-store downgrade consequence. Missing-explorer URLs and the conservative journal-begin/pretransport no-send window remain separately tracked.

- [Implementation and limits](https://github.com/solardev-xyz/freedom-browser/blob/0e7751c6668de47b3846445e5531871ffd47af8f/docs/railgun-cold-submission-2026-10-05.md)
- [Native evidence index](https://github.com/solardev-xyz/freedom-browser/blob/0e7751c6668de47b3846445e5531871ffd47af8f/docs/qualification/railgun-cold-submission-2026-10-05.json)
- [Next-stage design](https://github.com/solardev-xyz/freedom-browser/blob/0e7751c6668de47b3846445e5531871ffd47af8f/docs/railgun-durable-combined-poi-plan-2026-10-05.md)
- [Previous partial-submission update, preserved verbatim](https://github.com/solardev-xyz/freedom-browser/blob/0e7751c6668de47b3846445e5531871ffd47af8f/docs/privacy-progress-history-2026-10-05-partial-submission.md)

Historical detail follows.

---

