## October 5 update: partial withdrawal submission and recovery of its transaction record

Railgun now connects a genuine partial-withdrawal proof and one-use completion to fresh submission checks, vault EOA signing, an encrypted attempted-before-send journal and strict receipt resolution. **Six native cases pass** across deposited and received inputs, including acknowledged sends, lost replies and wrong-verifier rejection. Partial facade exposure, durable combined POI, private-change ingestion/second spend and live private qualification remain open.

### Evidence and limits

Each case uses a fresh disposable public-vector profile. The wallet, protected signing, prover, independent verifier, controller, destination constraints and journals are genuine. External chain/list/service responses and transport are simulated; these runs make no live submission and open no funded profile.

The four submission cases each sign/send exactly once. A lost reply preserves the known hash. Copied/reused completions refuse with no additional activity. Wrong-verifier cases reject 01x01 where 01x02 is required, before additional transaction RPC, review or EOA signing. Their earlier proof preparation still performs three transaction RPC requests.

Strict five-log resolution binds both public token transfers and the ordered private-change/unshield commitments. Reversed logs refuse. Resolved active and archived records yield consistent detached captures after same-process enrollment/store reopening. Those captures grant no POI or spending authority. The partial membership path stops after one keyless selector job, before external work; proof/output negatives prove missing prerequisites, not unreachable inner guards.

Receipt position is supplied by the fixture from the scanned tree length, not independently source-verified. Finality/gas are synthetic and treasury is a named baseline. The archival fixture temporarily advances the process-global clock by two days and explicitly records the resulting future archivedAt. No fresh-process capture, change credit or second spend is claimed. An initial diagnostic failed on missing synthetic gasUsed; all six reported runs use the corrected fixture and fresh profiles.

All six reports share **528 unchanged source hashes**. **2,163 tests across 26 suites pass; lint is clean.** The earlier 15,178-test regression remains historical for its recorded sources and was not repeated. Runtime/dependency/deployment/cache-policy pins remain unchanged; main dbfd0e7d remains current.

Claude reviewed production, fixture corrections and native evidence; independent Codex review strengthened the exact-record tests and constructor assertions. This is engineering review, not an external security audit.

### Next

Submit cold-recovered proofs through fresh reviewed eligibility and an atomic check against prior attempts for the same input; then connect durable combined POI, normal change ingestion, restart/second spend and live private qualification. Recovered-proof diagnostics remain nonauthority. No UI/UX activation is included.

- [Implementation and native evidence](https://github.com/solardev-xyz/freedom-browser/blob/0c792d23677371c01d5545644e6174b074b4fe0e/docs/railgun-partial-submission-2026-10-05.md)
- [Raw-report/hash index](https://github.com/solardev-xyz/freedom-browser/blob/0c792d23677371c01d5545644e6174b074b4fe0e/docs/qualification/railgun-partial-submission-2026-10-05.json)
- [Updated parity plan](https://github.com/solardev-xyz/freedom-browser/blob/0c792d23677371c01d5545644e6174b074b4fe0e/docs/railgun-parity-plan-2026-10-04.md)
- [Previous clean-restart update, preserved verbatim](https://github.com/solardev-xyz/freedom-browser/blob/0c792d23677371c01d5545644e6174b074b4fe0e/docs/privacy-progress-history-2026-10-05-proof-restart.md)

Historical detail follows.

---

