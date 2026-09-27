# PPv2 reviewed public transactions and note recovery

Date: 2026-09-27. Continues [controlled native deposit preparation](ppv2-controlled-deposit-2026-09-27.md). Main remains already merged at `2983dc62`; no dependency or node refresh was needed. No SDK dependency, renderer API or production activation was added.

## Implemented boundary

The main-owned PPv2 session now connects issued registration/deposit preparations to the existing private transaction service. The SDK still receives only read, derivation, storage and proving capabilities. Wallet transaction review/signing stays in `src/main/wallet/`; no renderer or top-level responsibility changes were needed.

Registration accepts only canonical `setAuthPolicy(uint256,uint256)` and `setViewingKey(bytes32)` calldata to the configured keystore, zero value, bounded nonzero keys, and the expected order. A partial SDK preparation can contain just the missing call. The reviewed SDK remains responsible for deriving the correct key values; these syntax/target checks are not an independent derivation proof.

`submitPublicOperation(prepared, options)` requires the exact session-issued object, one explicit step, matching sender, positive bounded gas limit, maximum gas budget and a main-owned review callback. Each preparation expires after two minutes and each step is consumed before review/signing. It never loops through a batch or automatically retries. The next registration step requires explicitly reconciled successful inclusion of its predecessor. After restart, the SDK re-reads registration and prepares only what remains; the durable account journal blocks sends while any earlier attempt is unresolved.

Before a deposit handoff, both authorization and viewing-key slots must be nonzero; the SDK's `isRegistered()` alone checks only authorization. Each transaction is simulated through the public owner's isolated transaction context. Final review binds the exact populated transaction, sender, nonce, gas budget, protocol fee and absolute preparation deadline. Remote registration, simulation and inclusion observations remain **unverified**. Neither a successful simulation nor nonzero slots authenticate deployment or key correctness.

The encrypted submission journal now optionally records an operation kind and a fingerprint over kind/chain/from/to/value/calldata. The transport recomputes it from signed bytes, then durably stores it before transport handoff. Older journal entries remain readable. No signed transaction, proof, witness, calldata or note secret is added to the journal. The metadata supports correlation after restart; it does not authorize a replacement or retry.

## Recovery inspection

Normal SDK discovery now has controlled real-note qualification. The new main-only `inspectNoteRecovery()` additionally instantiates the real candidate with an empty, bounded, temporary store and scans from the configured deployment block. It compares recovered commitments against the current SDK export, which remains inside main. The returned notes are reduced to commitment, asset, value and status fields; SDK note secrets are never returned by the diagnostic.

A missing commitment is reported as `missingFromScan`, not deleted. The original encrypted cache is not replaced, and both chain correctness and history completeness remain explicitly unverified. Temporary storage is revoked and cleared on completion/failure. Vault cancellation invalidates the scan. This is a recovery diagnostic, not automatic reorg repair or a backup/restore product policy. Fresh scans do not recover payment-request metadata known only to an old local cache.

## Qualification

The Electron fixture uses only the established public test mnemonic, synthetic contracts, and controlled RPC responses. It drives the real Kohaku plugin, pinned SDK, native proof process, wallet signing service and encrypted journal:

1. Send authorization after review; refuse the viewing-key step while inclusion is unresolved.
2. Lock/reopen the vault, explicitly reconcile inclusion, and prepare/send only the remaining viewing-key call.
3. Prepare a real 10,000-wei native deposit with a 100-wei protocol fee, review/sign it, and inject a lost response after controlled submission.
4. Reopen and recover the attempted transaction and its operation fingerprint. Withhold the commitment timestamp; no note is counted. Restore the timestamp and discover/decrypt the announcement, matching the recovered commitment to the verified deposit proof.
5. Restore the pending 10,000-wei note from encrypted state. A fresh empty-cache scan independently recovers the same note. ASP approval is not fabricated: spendable balance stays zero and unspendable balance is 10,000.
6. Omit the note announcement to model a conflicting/reorged remote view. Recovery inspection reports the discrepancy while preserving the encrypted cache byte-for-byte. Restore the announcement and rescan successfully.
7. Close Electron and launch a **new process** against the same test profile. Recover both the note and uncertain submission, independently rescan again, and refuse another deposit submission pending reconciliation. No extra transaction is sent.

The SDK's `POOL_VAULT_ALL_EVENTS_ABI` covers tree mutations and does not include `Note`/`Deposited`. The lifecycle fixture grants those exact events explicitly; the read provider continues to reject ungranted events. Real deployment grants must include the required discovery events deliberately.

Validation:

- 56 focused unit tests pass, including handoff, recovery, journal, private network and transaction service suites.
- Full regression: **5,605 passed, 33 skipped, the same 3 baseline failures** (two macOS shortcut-remap cases and the Safe fork integration case). The first sandboxed attempt could not open local test sockets and was stopped; these counts are from the permitted rerun. Final deadline/descriptor refinements passed the focused suites afterward.
- Source Electron: deposit and lifecycle tests pass; the strengthened lifecycle also passes with a real process restart.
- Packaged macOS arm64: **3 passed**, including executable preflight, deposit and lifecycle/process restart. Seven affected packaged wallet modules match source byte-for-byte.
- Lint and whitespace checks pass. Application package/lock files are unchanged.

See [the packaged report](qualification/ppv2-lifecycle-2026-09-27.json). Logs: `/private/tmp/ppv2-{handoff-unit,lifecycle-regression-approved,lifecycle-lint,lifecycle-build,lifecycle-electron,lifecycle-restart,lifecycle-packaged}.log`. Reproduce with the SDK ASAR from `scripts/spike-ppv2-process.js`, then run `test-e2e/ppv2-lifecycle.spec.js` in the harness/packaged projects. No live Sepolia transaction or Tor measurement was made by this fixture.

## Remaining gates

Next are private transfer/unshield/ragequit circuit and intent qualification, durable relayer operation tracking, ERC-20 approval sequencing, ASP approval/revocation coverage, and a recoverable live Sepolia flow. The rescan diagnostic deliberately does not decide which remote view may replace local state. Note-specific commitment/timestamp queries are visible to the RPC despite Tor; query-content exposure needs explicit review before privacy claims.

Final identity constants, audit/deployment/artifact matching, maintained adapter distribution, license/dependency review, supported platforms, complete SDK egress tracing and product approval/recovery UX remain release gates. The production experiment gate stays closed.
