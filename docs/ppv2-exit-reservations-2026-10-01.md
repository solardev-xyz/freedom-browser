# PPv2 durable exit reservations — October 1

The host now reserves an exited note before public broadcast. This addresses the spend-permission gap observed in the [funded lifecycle](ppv2-live-lifecycle-2026-10-01.md). It does not change the pinned SDK, enable production, or submit another live transaction.

## Implemented boundary

- Canonical ragequit calldata supplies the pool and note commitment. The signer boundary derives them again from the signed transaction. Owner, chain, value, signal ranges and native/token kind are checked; the existing intent digest is unchanged.
- The encrypted public journal persists that binding in its atomic write before transport. A crash before send and an unknown delivery outcome both retain the reservation. Duplicate pool/commitment attempts are refused inside the journal update.
- Notes and balances use a validated host projection: reserved nonterminal notes become `exit_pending` and unspendable. SDK terminal statuses remain terminal. Exit preparation, withdrawal preparation, reviewed exit submission and relay handoff check the journal independently of SDK cache state.
- Generic public resolution, reverted receipts, consumed nonces, reorgs and archival do not release reservations. Archival retains intent metadata permanently. No private nullifier lookup was added.
- Independent note recovery remains SDK evidence, explicitly labeled `noteStatusSource: sdk-only` and `spendAuthority: false`.

All state remains in main-owned wallet services. No IPC, renderer, package-boundary or dependency change is needed.

## Compatibility and remaining work

Journal reads accept versions 1–3; any write upgrades to version 3. Older builds intentionally refuse version 3, so downgrading cannot silently discard the binding.

Old two-field exit intents and archived records with no intent remain readable as history but make the spend projection and spend preparation fail with `PRIVATE_PPV2_EXIT_RECOVERY_REQUIRED`. They are not rewritten or matched to notes by amount, ordering, or SDK status. The funded profile is untouched and contains such legacy exits. The [authenticated legacy recovery follow-up](ppv2-legacy-exit-recovery-2026-10-01.md) now supplies a reviewed path for retained two-field exit records; it has not been run against the funded profile. Archived records without intent metadata remain blocked.

A failed or replaced exit is deliberately still reserved. Safe release needs matching finalized evidence, explicit review, and an agreed chain-evidence policy. There is no automatic retry or release timer. The SDK provisional hook is not replayed: the host projection is authoritative. The follow-up also refuses withdrawal preparation before a quote/proof when the SDK still has a reserved ACTIVE input of that asset. This conservatively blocks other notes of that asset until SDK finality, or indefinitely after a failed exit until reviewed release is implemented. Exact post-selection and handoff checks remain necessary if SDK state changes during preparation.

## Verification

Unit coverage includes calldata binding and malformed input; durability before lost broadcast response; attempted/submitted/included/reverted/nonce-consumed/reorged outcomes; reopening; unspendable balances; pending/inactive/rejected SDK states; ambiguous legacy history; permanent archival; and a reservation appearing during exit approval.

Controlled Electron tests use the real pinned SDK and synthetic services/funds. The lifecycle regression resolves the public exit before SDK finality, confirms `exit_pending` and zero spendable balance, reopens, refuses another exit, then observes the SDK terminal state. A second regression prepares a withdrawal, exits and resolves its note, and refuses the prepared withdrawal without a relay journal record or relay POST. No live wallet was accessed for these checks.

Validation at this checkpoint: wallet/provider regression 730 passed and 6 skipped, isolated OpenLV integration 6 passed; repository lint clean. All seven existing withdrawal/cancellation Electron scenarios passed, as did the delayed-finality lifecycle case and the new stale-withdrawal case (including attribution to the exit-reservation guard). Claude completed the read-only review after the controller fixture and approval/handoff regressions were corrected. The first broad run was blocked by sandbox loopback restrictions; the successful rerun allowed local fixture servers. No tests needed a live RPC or funded wallet.
