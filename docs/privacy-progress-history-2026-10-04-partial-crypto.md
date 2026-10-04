## October 4 update: real partial-withdrawal proof and cold recovery

Railgun now generates an actual bounded 01x02 partial-unshield proof and reconstructs it from the original encrypted change and stored signature. Fresh independent verification passes. Cold recovery uses a fresh generic encrypted-storage reader and utility, not a whole-wallet restart. This is utility-level qualification with synthetic notes, account and scan. Main partial operation admission is still closed; receipt recovery, authenticated change ingestion, combined POI and spending that recovered change remain next.

Reviewed checkpoint: `941099ff0033662b0a8768ffcf00af60b443272b`. Main remains `3b4f62df`, already merged with the explicit node refresh. Dependencies, runtime archives, artifact/deployment pins and public/TXID policy inputs are unchanged. Four wallet-policy source inputs change again (witness, reconstruction, prover and operate job), extending the pending derived-cache rebuild. No funded profile, live RPC/POI query, submission or PPv2 state change occurred.

### Implemented

- Derive change C = V - U from the recovered input V and gross withdrawal U. Construct the engine's self-owned Change output, then unshield. Receiver-only decryption binds self NPK, pinned WETH, C, commitment, annotation and absent memo.
- Reconstruct the original ciphertext without new randomness or encryption. Compare private/public witness fields and canonical ABI bound-parameter bytes before requesting a signature.
- Bind artifact selection to a closed intent kind before signing. Partial uses 01x02; omitted kind remains legacy-only 01x01. The signer validates the final unshield preimage and all five ordered public inputs; a fresh keyless verifier checks them independently.
- Utility signing/reconstruction now support partial, superseding the earlier structural-only utility refusals. Main identity/account/staging/operation, reservation, submission, journal and POI boundaries remain closed. Structural data or a valid primitive proof does not grant operation authority.

### Evidence and limits

The partial native proof passes in 3,716 ms; stored-signature cold recovery passes in 3,378 ms with zero additional spending-key transfers. Each of five public signals and reversed output order is coherently changed while retaining the proof: structural matching passes, actual verification refuses. Nineteen recovery controls refuse; same-viewing-key foreign change decrypts before ownership mismatch is detected. Randomness/encryption hooks record zero calls. Three successful signer invocations across the whole partial fixture include control/interrupted-preparation work, not extra cold-recovery signing.

Legacy transfer/unshield native proofs and four cold-recovery cases also pass. Both complete reports retain 27 current source hashes. Six fresh Kohaku compatibility runs preserve Shield/Transact private operations, lost acknowledgments, cancellation and public Shield; each passes 19 baseline cases, with 133 private / 169 public hashes. RPC/POI authority in those wallet flows remains simulated. Reports identify supervised exits and callback drainage without claiming natural self-exit. Inventories are version evidence, not execution coverage.

Focused: 306 tests/10 suites pass; lint clean. Full frozen regression: 13,949 tests passed / 33 skipped, 504 suites passed / five skipped, 504.063 seconds; all 1,497 source/test/configuration hashes unchanged. Existing OpenLV exclusion and force-exit apply; this suite does not establish natural application-handle drainage.

Claude reviewed production, fixtures and native evidence; this is engineering review, not an external security audit. Still open: anchored deployed 01x02 verifier equality, exact receipt/TXID recovery, normal scan ingestion and eligibility of change, combined POI, actual second spend, live disclosure permission/funded private qualification, portable Host extraction, UX and release readiness.

Audit details: [native proof and recovery](https://github.com/solardev-xyz/freedom-browser/blob/941099ff0033662b0a8768ffcf00af60b443272b/docs/railgun-partial-crypto-2026-10-04.md), [complete partial-withdrawal plan](https://github.com/solardev-xyz/freedom-browser/blob/941099ff0033662b0a8768ffcf00af60b443272b/docs/railgun-partial-unshield-plan-2026-10-04.md). The previous structural update is preserved [verbatim](https://github.com/solardev-xyz/freedom-browser/blob/941099ff0033662b0a8768ffcf00af60b443272b/docs/privacy-progress-history-2026-10-04-partial-structure.md); earlier history remains below.

---

