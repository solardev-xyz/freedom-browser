# PPv2 controlled native withdrawal and change recovery

**Historical checkpoint:** [September 28 review fixes](privacy-review-fixes-2026-09-28.md) update the status of the recovery, registration, quote and proof-verification limits described below. Session verification runs in the producer process; the standalone relay fixture separately qualifies an independent verifier.

Date: 2026-09-27. Scope: main-process development/Sepolia session, synthetic chain and HTTP services, actual pinned Kohaku/SDK code and Groth16 circuits. Production remains disabled. No live transaction, new application dependency, renderer flow or IPC channel was added.

## Implemented boundary

The session now connects `prepareNativeWithdrawal` to the Kohaku plugin and shared broadcaster. The SDK produces a preliminary proof, then a second proof incorporating the selected relayer fee. A capture-only network wrapper intercepts the final relay request before transmission; the SDK cannot send it or optimistically persist its receipt. Main validates the captured endpoint against the configured selected relayer, checks the exact final proof and independently decrypts/recomputes the change commitment with this account's viewing key. Review and the existing handoff send those exact bytes once.

The new managed transact job accepts only the pinned native 1-input/1-change-output witness. It checks the selected input commitment, verifies the real proof, binds the output commitment/nullifier and checks roots, amount, asset and context. Witness shape, tree bounds and circuit hashes are constrained; artifact and utility-process budgets remain unchanged. The child receives protocol witness secrets, never the mnemonic or public transaction signing key. A failed final proof cannot substitute the preliminary proof.

This belongs in `src/main/wallet/`: the existing main-owned session holds keys, persistence, proof processes and network authority. Giving the renderer or the upstream broadcaster submission authority would bypass that boundary.

## Recovery and reservation

The encrypted relay ledger records settlement fingerprints before HTTP: pool, processor, output commitment, withdrawn amount, note-data digest and scan start. It retains history after resolution and rejects reuse of a prior commitment/nullifier. Older records without these fields remain readable and blocked; missing evidence never becomes permission to retry.

Reconciliation discovers a possibly submitted withdrawal from its nullifier even when the relay acknowledgement was lost. It matches the Transacted event, successful receipt, processor, asset/amount, change announcement digest, canonical block response and spent-nullifier mapping. A finalized-block response bounds discovery. These are mutually checked **unverified RPC observations**, not a cryptographically verified canonical chain. The main-only review callback must explicitly accept that provenance before another operation is allowed, and the evidence is fetched again after review.

Public and private submissions share the session's busy guard and consult both journals. Prior resolutions are refreshed before later sends and again after approval. A reorg, disappearing receipt or changed evidence revokes the next-operation permission. Public emergency exits also refuse commitments already recorded in the relay ledger. SDK change/spent state comes from discovery after chain inclusion, not manual insertion after an HTTP response.

## Qualification

The controlled lifecycle registers the keystore, proves and deposits 10,000 synthetic native units, restores the note, qualifies ASP membership against the RPC root, withdraws 5,900 with a 100 fee, loses the relay response, restarts Electron and independently recovers the 4,000-unit change. Explicit reconciliation then permits a second 1,000 withdrawal plus 100 fee, leaving 2,900. A reorg blocks the second spend until re-observation and review.

Unit coverage includes altered witness/signals/circuit, changed routing/fees/assets, failed final proof, lock cancellation, review rejection, durable-write failure, lost acknowledgements, malformed evidence, reorg during review, legacy records and input reuse. The real SDK's checksummed native-token spelling is accepted by address value while the reviewed payload stays byte-identical.

- Full unit regression: **5,681 passed, 33 skipped, the same 3 baseline failures** (two macOS shortcut-remap tests and the Safe fork integration test).
- Source Electron lifecycle: passed with actual deposit and both withdrawal proofs.
- Packaged qualification and module byte comparisons are recorded in [the evidence report](qualification/ppv2-native-withdrawal-2026-09-27.json).
- Lint and whitespace checks pass.

Pinned sources remain Kohaku `6fdc248b3d28942d9aaa35c49c1ac76dab89dc0e` and SDK `fe0244e3f14110efd83db02c60c96517dea9cd5a`, with the existing compatibility patch. The scratch bundle additionally exports the actual Kohaku broadcaster and a narrow change-inspection helper. No upstream package was installed into the app.

Reproduce the scratch bundle using `scripts/spike-ppv2-process.js /absolute/pinned-sdk /absolute/generated-compat-directory --exit-circuits`. Set `FREEDOM_PP_V2_PROCESS_ASAR` when running `test-e2e/ppv2-withdrawal.spec.js`. For packaged tests also set `FREEDOM_E2E_EXECUTABLE` and select the `packaged` project. Logs/results are `/private/tmp/ppv2-withdraw-{source,regression,lint,build,packaged}.log` and `/private/tmp/ppv2-withdraw-packaged.json`.

## Remaining limits and next work

The later [resumable recovery milestone](ppv2-resumable-recovery-2026-09-27.md) supersedes the empty-root issue and total 5,000-block horizon below; other limits remain.

1. **Empty ASP set bug in the pinned SDK.** `MerkleService.computeRoot([])` returns `0x0`; `ASPRegistryInteractor` returns a 32-byte padded zero via `bigintToHex`. `ASPClient.assertLeavesMatchChainRoot` compares lowercase strings, so an empty set fails root comparison. An active note retains its previous status on this failed read. The qualification test records that behavior and proves withdrawal preparation still refuses it. Nonempty-set revocation/restoration works. Fix and requalify upstream normalization before product use; do not label all ASP states complete.
2. **Long absence and ambiguous failures.** Discovery deliberately refuses gaps of 5,000 blocks or more and responses above 2,048 logs. The development ledger caps history at 64 attempts. A durable paginated scan cursor, bounded historical revalidation and explicit failed/replaced-operation recovery are needed before normal use. There is no timeout-based release or blind retry.
3. **Protocol scope.** Only native 1×1 withdrawal with positive change is granted. Full withdrawal, multiple inputs/outputs, private transfers, ERC-20 approvals/transacts and relayer fallback still need separate qualification.
4. **Production gates.** Final derivation identifiers, source/artifact distribution, audit/deployment matching, signed-quote verification, chain-state provenance, end-to-end egress and supported-platform qualification remain open. This controlled test does not establish network anonymity or a production trust policy.
5. **Product work.** Account setup, pending/rejected status wording, review/recovery screens and policy choices still require UI/UX discussion. The current callbacks are engineering seams, not a user flow.

The next autonomous infrastructure work should address empty-root normalization and durable long-gap recovery, then expand protocol coverage. Live qualification and user-facing design remain separate milestones.
