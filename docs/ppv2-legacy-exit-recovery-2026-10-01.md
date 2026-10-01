# PPv2 authenticated legacy exit recovery — October 1

Retained legacy exit records can now acquire the pool/commitment binding required by [host reservations](ppv2-exit-reservations-2026-10-01.md). This is a main-only development API, with no UI, production activation or funded-profile migration.

## Evidence and review

Only an existing live journal record with a two-field exit intent is eligible. Main requests its transaction by hash through the owner transaction context, reconstructs the signed Sepolia legacy transaction and verifies its exact journal hash, recovered sender, nonce, pool and original intent digest. Canonical ragequit calldata supplies the commitment. Unpadded RPC signature numbers and fixed-width words both reconstruct the same signed bytes. Invalid, absent, unsigned, different-chain or changed transactions are refused.

The review explicitly accepts `signed-transaction-hash` evidence. Its main-only summary reports `inclusionVerified: false` and `releasesReservation: false`; note identifiers are not public diagnostics. A revision-checked encrypted update adds only the binding and increments the revision. Observation, resolution and submission state are preserved. Timeout, lock, stale review and storage failure cannot produce a late write. The default deadline is 60 seconds, capped at 120 seconds.

Recovering the last ambiguous exit removes the global ambiguity block for other notes. The recovered note itself remains reserved, even after generic public resolution or a reverted receipt. Another ambiguous record keeps the global block in place. Signed bytes authenticate what was attempted; they do not establish chain inclusion, finality or permission to retry.

## Deliberate limits

- Archived records without intent metadata and unclassified live records remain blocked. No classification is guessed from amount, ordering or SDK status.
- Archival stops before an unclassified or unbound exit record, before RPC checks or review. Eligible earlier records can still archive. The storage update independently enforces this rule.
- If RPC cannot supply a retained legacy transaction, that record stays live. The 64-record live journal limit can eventually block new public sends. This is an explicit development-profile limitation; manual deletion or silent pruning is not a recovery procedure.
- Known reserved SDK-ACTIVE notes block all withdrawal preparation for that asset before quote/proof, including requests for a different note. After a successful exit this lasts until SDK finality; after a failed exit it can persist until a separately reviewed release feature exists. Other assets and SDK `exit_pending` notes do not trigger that pre-selection guard. Exact post-selection and handoff guards still apply.

## Validation

Synthetic signed-transaction tests cover exact reconstruction, leading-zero signature components, tampering, restart persistence, duplicate exit refusal, declined/stale reviews, cancellation, deadline, disk failure, unsupported archival and multiple ambiguous records. A network-level test exercises the owner RPC route and encrypted journal update. Session tests verify that the selection guard prevents quote/prover calls. Claude reviewed the implementation read-only and approved after the signature-encoding and archival-prefix corrections.

No live transaction, external service lookup, dependency change or mutation of the funded profile was needed.
