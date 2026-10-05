## October 5 update: one Railgun POI proof for withdrawal and private change

At `8682764e120ec1d04cb786f05a7770c251569773`, standalone local cryptography now proves a bounded partial WETH withdrawal and its private change together. Both Shield and received-Transact inputs pass real signed spend proofs, combined POI proofs and separate keyless verification. This does **not** yet enable partial operations through the protected wallet controller, POI persistence, the Kohaku facade or a user interface.

### Implemented and qualified

- Original change ciphertext is reconstructed with same-account NPK, WETH, value conservation, Change annotation, null sender random and absent memo. Both ordered commitments belong to one existing POI_3x3 proof; no new artifact or dependency.
- The seven-field proof payload and legacy canonical bytes/hashes are preserved. The application binds output count and the exact own-TXID marker. Real proofs with deliberately wrong markers verify cryptographically but fail application binding, demonstrating why proof validity alone cannot authorize an operation.
- Membership, proof, storage and cold recovery keep explicit legacy-only bounds. Current POI documents reject combined records, including matching attempted envelopes, without changing encrypted bytes, inventory or floors. Existing disclosure and output recovery remain closed to this new operation.
- Four native cases cover partial Shield/received-Transact inputs and legacy Shield transfer/full withdrawal. Each checks eight public-signal mutations and 12 assembly refusals. Partial cases add seven change/preimage controls. The complete report inventories 465 unchanged source/test files.
- 1,697 focused tests across 14 suites passed; the strengthened Transact membership suite was rerun afterwards (37 passed). Lint is clean. Detached guard-removal controls verify the rejection checks. Full repository regression was not repeated here; the preceding 14,483-test run belongs to `527c8826` and its recorded source state.

Native receipts, inclusion and list membership are synthetic. The foreign input creator is another account from the same public test mnemonic; its creating spend is not proved or mined. These runs grant no genuine partial hold, durable prepare, live eligibility or submission authority. No funded profile or live privacy service was used. Claude reviewed implementation and evidence; this is engineering review, not an external security audit.

### Next

Enable the normal protected internal partial-operation path coherently: intent-bound deployed 01x02 checks, independent change verification before a spending key, real reservation/signature/proof storage and received-note staging. The existing facade constructs only transfer and full-note withdrawal requests; preserve that boundary until connected qualification. Then add combined POI persistence/recovery, normal change scanning, full restart and a second spend. A production host for resuming a signed but unfinished proof is a separate open recovery task. Live private qualification, portable Host extraction, UX and release readiness remain open.

Main `dbfd0e7d` remains merged, with the explicit bundled-node refresh recorded at the preceding checkpoint. Privacy runtimes/artifacts, dependencies and derived-cache policy inputs are unchanged by this slice.

Details: [combined proof checkpoint](https://github.com/solardev-xyz/freedom-browser/blob/8682764e120ec1d04cb786f05a7770c251569773/docs/railgun-combined-poi-2026-10-05.md), [native evidence](https://github.com/solardev-xyz/freedom-browser/blob/8682764e120ec1d04cb786f05a7770c251569773/docs/qualification/railgun-combined-poi-native-2026-10-05.json), [qualification index](https://github.com/solardev-xyz/freedom-browser/blob/8682764e120ec1d04cb786f05a7770c251569773/docs/qualification/railgun-combined-poi-2026-10-05.json). The [previous creator-authentication update](https://github.com/solardev-xyz/freedom-browser/blob/8682764e120ec1d04cb786f05a7770c251569773/docs/privacy-progress-history-2026-10-05-creator.md) is preserved verbatim; older historical detail follows.

---

