# Railgun change recovery and second spend across restart

Both original input histories now pass the complete two-process lifecycle on merged commit `4ab31ac1bc88a8e7e07475d5a2ea62e5c9d425fd`: a partial withdrawal, durable combined POI attempt, normal change scan and disposable list acceptance in the first process; restoration, a fresh second spend and terminal balance ingestion in the next. All four compatibility modes also pass. Every run uses the same 902 source hashes. External chain, receipt, finality and list-service responses remain simulated; this is not a live private withdrawal.

The [evidence index](qualification/railgun-connected-change-restart-2026-10-05.json) and [independent audit](qualification/railgun-connected-change-restart-audit-2026-10-05.md) link the exact raw reports. The earlier [implementation checkpoint](railgun-connected-restart-implementation-2026-10-05.md) records failed bringup separately. The [main synchronization report](privacy-main-sync-2026-10-05.md) records the merge and explicit bundled-node refresh.

## Native results

| Case                             | Setup ms | Resume ms | Setup utilities / workers | Resume utilities / workers |
| -------------------------------- | -------: | --------: | ------------------------- | -------------------------- |
| Original Shield input            |   88,890 |    10,324 | 296 / 28                  | 28 / 8                     |
| Original received Transact input |   97,795 |    10,479 | 339 / 31                  | 28 / 8                     |

Setup and resume are distinct OS processes. The root runner confirmed the Shield setup exit; the sequential driver waited for the Transact setup exit. Each exited zero before its resume started; resume independently required its recorded setup PID to be absent. Both original histories retain their unrelated notes. The selected change becomes spent by the second transaction, while the original input remains spent by the first. Total unspent WETH falls by precisely the change amount; this is not a whole-wallet-zero claim.

| Shield compatibility mode            | Elapsed ms | Utilities | Storage workers |
| ------------------------------------ | ---------: | --------: | --------------: |
| Default retained-POI lifecycle       |     86,849 |       289 |              25 |
| Change scan                          |     92,488 |       295 |              28 |
| Second spend                         |     94,476 |       306 |              31 |
| Second spend plus terminal ingestion |     94,632 |       316 |              33 |

All eight processes exited zero. Each resumed process has zero expected utility failures, 28 observed controlled utility exits, eight storage-worker exits and no sticky fixture violations. The seven observed credential loans comprise two identity derivations, three wallet-viewing loans, one private-operation loan and one spending-signature loan. The harness requires every loan wiped; the separately observed storage-key copy is also wiped. This does not claim that cold opening is credential-free or byte-read-only.

## What the process boundary proves

The first process closes its owners, utilities, storage workers and simulated transports, locks the vault and releases its profile lock before sealing a handoff. The handoff binds the public vector, runtime archives, all nine 01x01/01x02/POI_3x3 artifacts, source hashes, saved report, public wire and selected encrypted-profile files. Profile equality covers the account-store tree, transaction-journal tree, inventory marker and actual `identity/identity-vault.json`, not the entire Electron profile. Only an accepted-request digest is exported; the actual body is re-derived from the encrypted retained record in resume.

Resume opens existing generations with creation disabled. It verifies the original signature/capsule/proof, resolved first Ethereum record, attempted POI entry and its remaining reservations, completed source checkpoint, public identity, canonical history and TXID witness. The witness is selected with the Railgun Poseidon transaction identifier and must return the exact independently reprojected row. The Ethereum hash is a separate identifier.

Saved disposable-list responses are replayed with their actual public key and verified signature. There is no service private key, signing API, reissued acceptance constructor or new combined POI POST in resume. The event does not cryptographically sign its root or chain; exact saved-root/path/output joins remain required, and service trust remains synthetic. Replayed wire is never treated as production spending authority.

Bootstrap performs the predicted seven utility jobs, 17 canonical/header reads, one log read and two latest/root-validation pairs. The existing mirror closes before second-operation ownership. Ten observed constructor records undergo only their permitted lease/sequence/generation or unchanged-floor bookkeeping; normal operation updates afterward use the genuine storage implementation.

The second operation uses fresh production staging, creator authentication, typed list membership, root and preflight checks, a new signature/proof, a reviewed Ethereum transaction and an attempt persisted before its sole simulated send. Four legitimate canonical observation refreshes preserve the first Ethereum record's identity, intent and resolution; its whole record is not claimed byte-identical. The terminal phase appends the actual second row and advances the ordinary public/TXID/wallet scanners without creating a new UTXO leaf. Original private records, retained POI state and unrelated balances remain preserved.

The outer `newProcessRestartQualified: true` describes this enclosing process boundary. The reusable terminal component still reports its own `newProcessRestartQualified: false`, because it does not independently establish that boundary. Its separate `secondSpendIngestedIntoWallet: true` establishes its scan result.

## Validation, review and remaining work

Post-merge focused tests pass 251 tests across 14 suites in 9.528 seconds; merge-focused router/private-transaction/profile/Tor checks pass 199 across five suites in 3.694 seconds. Full lint passes. Changed restart files and the new documentation pass formatting checks. The merge preserves upstream formatting outside the resolved logic. The earlier 15,731-test full regression remains historical evidence for `c5d75f05`; it is not relabeled as a current merged-tree regression.

Claude reviewed the implementation, fixture repairs, router merge and primary native evidence. A separate agent independently checked report/source hashes, counters and node provenance. This is engineering review, not an external security audit. Failed native profiles remain preserved and were never retried after partial restoration; their failures are described in the implementation checkpoint rather than counted as passing cases.

Still open: cold submission of the second already-proved transaction, original-signature recovery of its interrupted proof, native qualification of the partial Kohaku facade and an actual second facade instance spending recovered change. Live POI acceptance, private transfer/withdrawal, a suitable private broadcaster and portable adapter extraction remain separate goals. No funded profile was opened, no live private service request or transaction was made, and no user interface or production activation is introduced by this milestone.
