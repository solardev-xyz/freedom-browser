# PPv2 controlled ERC-20 lifecycle

Date: 2026-09-28. The main-only development session now covers allowlisted ERC-20 approvals, deposit, ordinary 1×1 withdrawal, change recovery, second spend and public emergency exit. All qualification uses synthetic accounts/services with the actual pinned Kohaku/SDK and Groth16 circuits. Production remains disabled; no application dependency, IPC channel, renderer flow or live transaction was added.

## Approval and deposit ownership

Main configuration supplies `erc20Tokens`, and each address must also have an existing restricted contract-read grant. No arbitrary token address can widen the SDK provider. Amounts and fees are raw token units; token discovery, symbols and decimals are not inferred or fetched from third parties.

`prepareTokenApproval({token,amount,maxFee})` checks pool enablement/minimum, the token fee, balance and allowance. It returns one reviewed transaction at a time:

- Exact allowance equal to deposit plus fee: no approval needed (`null`).
- Zero allowance: approve exactly deposit plus fee.
- Any other allowance, including an oversized/unlimited one: first reset it to zero, then prepare the exact replacement after reconciliation.

The zero-reset and set are separately reviewed, signed and durably journaled. Lost responses preserve their transaction hashes and block further sends until explicit reconciliation. Reopening reads the current allowance and journal; there is no persisted automatic approval batch or blind retry. A false/malformed approval simulation is refused; the empty-return convention is accepted, with the actual allowance checked before deposit.

This sequencing deliberately stays in main. The pinned SDK exposes `approvalTxs`, including a zero reset, while the pinned Kohaku adapter forwards only its final `approvalTx`. Our deposit path requires exact allowance before invoking the adapter and refuses an SDK result containing any approval transaction. It does not depend on the incomplete batch mapping.

`prepareTokenDeposit` binds the verified proof to the configured asset and raw deposit amount, requires zero native value and checks the note-data context/calldata. Allowance, balance and fee are rechecked before review and again after approval. Exact allowance bounds the token debit even if the entrypoint fee rises before inclusion, assuming standard ERC-20 transfer/allowance behavior. An existing larger allowance is therefore not treated as sufficient. Sender, spender, asset, approved amount, token fee and native gas budget are available to the main-owned review callback.

SDK configuration objects are separate copies: candidate mutation cannot change the main-owned deployment targets or service configuration. Keys, signing, proof processes, journal and policy remain in main, following the existing architecture; the renderer receives no new authority.

## Withdrawal, recovery and exit

The existing 1×1 transact bridge now binds an explicitly selected asset throughout the witness, verified public signals, final quote/payload, change-note decryption and settlement journal. Native behavior keeps its previous default; token operations require the main allowlist. Reconciliation matches the recorded token against the included event instead of assuming native ETH. Older native journal records remain readable.

The controlled withdrawal test now runs for both native ETH and a synthetic ERC-20: 10,000-unit deposit, 5,900 withdrawal plus 100 fee, lost response, a 12,000-block gap, durable scan checkpoint, Electron restart, 4,000-unit change recovery, reorg refusal and another 1,000 withdrawal plus 100 fee leaving 2,900.

A separate token lifecycle loses responses after zero-reset, exact approval and deposit, reopening Electron after each. It independently reconstructs the 10,000-unit encrypted note without the SDK cache, proves an owner/asset-bound emergency exit and observes the exited note. The synthetic public balance ends at 19,900 after the 100-unit deposit fee. Emergency exit is a public operation, not a privacy-preserving withdrawal.

## Validation

- Source Electron token approval/deposit/exit lifecycle and token withdrawal/recovery both pass with real proofs.
- Full unit regression: **5,711 passed, 33 skipped, the same 3 baseline failures** (two macOS shortcut-remap tests and the Safe fork integration case).
- Targeted coverage includes allowance reset/exactness, insufficient balance, disabled token, excessive/changed fee, false simulation, post-review changes, wrong asset in witness/proof/relay/event, and SDK configuration mutation.
- Packaged results and module byte comparisons are in [the evidence report](qualification/ppv2-token-lifecycle-2026-09-28.json). Lint and whitespace checks pass.

Reproduction uses the existing `empty-asp-root-v1` scratch bundle, SDK `fe0244e3f14110efd83db02c60c96517dea9cd5a`, Kohaku `6fdc248b3d28942d9aaa35c49c1ac76dab89dc0e` and unchanged circuit hashes. Run `ppv2-token-deposit.spec.js` and `ppv2-withdrawal.spec.js` with `FREEDOM_PP_V2_PROCESS_ASAR`; packaged runs additionally use `FREEDOM_E2E_EXECUTABLE`. Logs/results use `/private/tmp/ppv2-token-*`.

## Remaining boundaries

This does not qualify a named production token or arbitrary ERC-20 behavior. Fee-on-transfer, rebasing, callback-bearing and otherwise nonstandard assets remain unsupported unless separately reviewed and tested. Configured token grants are an engineering allowlist, not a production token catalog.

Private transfers, multiple input/output circuits and zero-change/full withdrawal remain unqualified. Receipt/ASP/root evidence is still explicitly unverified RPC state. Signed-quote verification, failed/replaced-operation recovery, ledger capacity, final identity constants, matching audit/deployment/artifact provenance, full egress and supported-platform qualification remain open. None is bypassed by the new token support.

The usable wallet still needs product decisions and UI for selecting a private account, approval/deposit review, ASP status, private withdrawal versus public emergency exit, recovery and trust policy. This milestone supplies the main-owned transaction/recovery primitives for those decisions; it does not claim a finished wallet product.

## Upstream revision check

Read-only authenticated checks on September 28 confirmed continued repository access. `v2.0` now points to `e5c13cd124cf8fbb8c9e487db91d1c6ce131f70d`, 48 commits beyond the qualified SDK revision. It replaces `packages/sdk` with core/EVM/other-chain packages; a 404 for the old file path does not indicate lost repository access. The current [core key-derivation constants](https://github.com/0xbow-io/v2-monorepo/blob/e5c13cd124cf8fbb8c9e487db91d1c6ce131f70d/packages/core-sdk/src/constant/KeyDerivation.ts) still use `TODO-privacy-pools-v2` and warn that changing it invalidates derived keys. This milestone does not adopt or qualify the newer revision. A separate adapter/deployment/artifact review and definitive identity constants are required before durable real accounts.
