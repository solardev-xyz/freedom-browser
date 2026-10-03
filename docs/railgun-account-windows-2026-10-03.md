# Account-owned Railgun restoration windows — October 3, 2026

The enrolled wallet now owns repeated read-only restoration and atomically
replaces its receipt and Kohaku view after successful re-attestation. This
composes the earlier [storage grants](railgun-readonly-wallet-windows-2026-10-03.md)
without exposing storage, a callback or a signing capability to callers.

`restoreRailgunAccountWallet` accepts only a genuine open wallet and its exact
identity, enrollment and public coordinator. It captures the current checkpoint,
blocks concurrent owned reads and restoration, restores in an exclusive public
window, then reads coverage, inspects unchanged wallet state and revalidates the
journal. Only then does it replace the receipt and view in one synchronous turn.
Callers must fetch `account.view` again: previous views and note-selection
references stay invalid even when the checkpoint and balances are unchanged.

The wallet phase remains claimed while the whole restoration and its utility
process drain. A refusal before entering the window, such as coordinator
contention, preserves a still-live wallet. A failure inside the window closes
both the wallet and shared public coordinator; recovery must reopen both.
Future expected private-preparation refusals should return a result inside the
window rather than throw through that destructive failure path.

## Evidence

The [enrolled Electron qualification](qualification/railgun-account-windows-2026-10-03.json)
passes 17 cases. Six additional account windows across receive, spent and
self-transfer states preserve owned projections, tree roots and balances while
refusing busy reads and old views. A forced interruption before the viewing-key
reply closes both owners; cold recovery restores the 2,700-unit synthetic
balance. Reports retain aggregate assertions, not private note projections.

The [live Sepolia run](qualification/railgun-account-windows-live-2026-10-03.json)
also passes two account windows at block 11,834,513 over 10,246 public commitments.
They take 3,921 and 3,960 ms, including two RPC header refreshes and post-window
re-attestation. These totals are upper bounds on the work covered by the
coordinator's 180-second timer; they leave room to test combined preparation and
proving, but do not qualify that combined workload yet. The recovered asset,
owned projection and roots remain unchanged, and old views refuse. All 4,230
mirrored TXID rows retain coverage. Transport is managed Tor with one unverified
RPC provider and unqualified circuit isolation. An initial attempt refused
during public recovery, before wallet startup; a cold retry passed. The precise
cause of that first refusal was not established.

The application native regression passes 8,541 tests, with 33 skipped; all 96
focused account/coverage/runner/journal checks and lint pass. Claude reviewed the
atomic replacement, close/drain ordering, phase lifetime and qualification flow.
Wallet responsibilities remain in main, with no renderer or IPC changes.

## Remaining private-operation work

This API restores a wallet; it does not prepare a transaction or grant signing.
Private preparation still needs captured selection and fresh POI evidence,
durable account-level reservations, a separate vault-bound signer, proof and
recipient verification, deployment checks and recoverable transaction handoff.
Combined live-history restoration and proving must fit the coordinator window.
No owned-note POI request, signature or submission is introduced here.
