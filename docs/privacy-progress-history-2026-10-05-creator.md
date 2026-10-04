## October 5 update: authenticate Railgun change and received-note creators

Railgun now verifies the creating transaction behind a recovered change note or received note before roots or credentials can be used for a later operation. This works without the original sender's private capsule or journal. The complete partial-withdrawal wallet flow remains disabled until combined POI, normal change ingestion, full restart and the second spend are qualified.

Implementation checkpoint: `7295be4c`. Reviewed merge/qualification checkpoint: `527c882623ddf4c459e89b75e6f95b930c90f481`, including main `dbfd0e7d` (#493 RPC log-scan routing). Ant 0.5.58, IPFS 0.4.3, Radicle 0.7.1 and all five Myotis 0.1.12 targets were explicitly refreshed; the host Myotis supervisor was rebuilt and ABI 32 verified. Arti 2.6.0 already matches its unchanged pin. No dependency or privacy runtime/artifact pin was changed. No funded profile, live privacy-service query or transaction submission occurred.

### Implemented and reviewed

- The existing keyless provenance worker verifies the creator's TXID path, then validates and hashes its final unshield preimage with the pinned engine. The host derives the required diagnostic from its own normalized input and waits for child exit.
- Pre-spend and retained recovery require this check before root acquisition. POI proving, proof-history checks and cold output recovery retain their identity/source/checkpoint and genuine-receipt joins.
- Independent review caught an overly narrow generic received-note path. The corrected route preserves supported token types, multiple inputs/outputs and nonzero ordinary-output selection. Retained consumers keep their existing narrower shape.
- No new renderer/IPC surface or main partial-operation admission. A visible change balance still grants no spending authority.

### Evidence and limits

At `7295be4c`, 1,150 tests across nine suites pass; the formatted provenance suite was rechecked separately without double counting. Removing the final-hash comparison in memory makes five targeted tests fail; removing retained diagnostic gates makes nine fail. Real-engine generic/partial/legacy qualification passes 18/12/8 groups, including valid-path wrong-preimage cases, an invalid ERC721 quantity and refusal to select the final unshield as an ordinary note.

The enrolled self-change fixture passes 11 recovery, 11 membership and 17 connected proof/check/output groups. It generates and independently verifies a genuine local POI proof for the legacy second operation, preserves the creator hash check through the real membership registry, rejects copied receipts, reopens encrypted stores and recovers one durably attempted simulated POST. A different account derived from the same public test mnemonic passes 11 retained recovery groups; that foreign run does not include membership, proving or connected output recovery.

The full merged regression passes 14,483 tests / 33 skipped across 507 passing suites / five skipped in 528.133 seconds. All 1,358 recorded JavaScript/JSON hashes and the file set are unchanged before/after; the existing OpenLV exclusion and forced Jest exit remain, so this is not evidence of natural application-handle drainage. The fresh merged self-change run also passes 11 + 11 + 17 groups, with a 4,749 ms genuine local POI proof and all 223 source hashes current. All 230 focused router/bridge tests pass; lint is clean.

Chain and service observations, spend proofs/signatures and review consent are simulated; list signatures use a disposable fixture key. Reopening is within the same parent application, not a complete application restart. These results do not establish combined partial POI, live service acceptance or a completed first/second-spend lifecycle. Earlier broader Kohaku runs remain evidence for their recorded sources.

Next: combined change/unshield POI persistence, normal scan ingestion and selection of the actual change, whole-application restart and the second full withdrawal. Deployed 01x02 selection, live eligibility/disclosure and funded private Sepolia qualification, portable Host extraction, UX and release readiness remain open.

See the [merged qualification](https://github.com/solardev-xyz/freedom-browser/blob/527c882623ddf4c459e89b75e6f95b930c90f481/docs/railgun-creator-merged-qualification-2026-10-05.md), [creator-authentication findings](https://github.com/solardev-xyz/freedom-browser/blob/527c882623ddf4c459e89b75e6f95b930c90f481/docs/railgun-partial-creator-authentication-2026-10-05.md), [qualification index](https://github.com/solardev-xyz/freedom-browser/blob/527c882623ddf4c459e89b75e6f95b930c90f481/docs/qualification/railgun-creator-authentication-2026-10-05.json) and [previous receipt/TXID update, preserved verbatim](https://github.com/solardev-xyz/freedom-browser/blob/527c882623ddf4c459e89b75e6f95b930c90f481/docs/privacy-progress-history-2026-10-04-partial-receipt.md).

---

