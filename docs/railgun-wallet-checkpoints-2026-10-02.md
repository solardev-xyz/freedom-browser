# Railgun wallet coverage and durable recovery — October 2, 2026

The main process now records whether a particular derived wallet cache was validated against a particular public-history checkpoint. This remains viewing-only development infrastructure: `wallet-scanned-unverified`, with `spendableGranted: false`. It does not establish consensus, receipt-proven log completeness, POI eligibility, or spending authorization. No Railgun funds moved.

Wallet services and persistence stay under `src/main/wallet/`, within the existing main-process responsibility. There is no new renderer surface, IPC channel, dependency or package boundary. Qualification scripts provide the guarded development runtime; product enrollment and fixed production entries remain open.

## What grants readiness

1. The public scan coordinator grants an exclusive public snapshot window. The wallet journal durably records the intended target before a scan starts.
2. The reviewed utility runner decrypts and checks the exact received/sent note sets against public commitments and nullifiers. Separate authenticated encrypted stores hold public history and wallet-derived records. The engine can only read/write its two wallet namespaces; it cannot write the main-owned coverage manifest/pages, call RPC or use transaction/clear/delete operations.
3. Main waits for router drain and observed utility-process exit. It checks the pinned runtime inventory, guard report, normalized coverage and result status, then registers an opaque receipt in a private WeakMap. The receipt binds the worker session, wallet, policy, public checkpoint, mode and coverage summaries. Restore additionally requires the entire derived store to remain unchanged during the job.
4. The first host action consumes that receipt to write encrypted coverage pages or read them for restore. A preceding host action without the receipt invalidates its use. Receipt replay fails closed. Coverage observations are bound to the receipt and current dispatch generation.
5. A privileged host observation hashes the entire derived store with framed key/value lengths. Inside the journal's atomic update, main requires the current public snapshot token, receipt-bound coverage, exact worker identity and fresh whole-store digest. Any later public work, derived dispatch or context revocation invalidates readiness.

The receipt establishes that the qualified guarded utility completed and reported its checked sets. Main independently checks shape, identity, freshness and public-checkpoint binding; it does not independently reimplement wallet cryptography. The engine/job and the host supervisor remain trusted code. JavaScript egress guards are accidental-egress controls, not an OS sandbox against malicious native code.

A later public apply invalidates completion at the old checkpoint. A second fully revalidated snapshot of the **same content** can replace the earlier public token while retaining the wallet receipt: the public content and exclusively held derived store have not changed. A restore receipt may intentionally complete durable pending work after a crash between the coverage write and journal completion.

## Private coverage and limits

Received, sent, quarantined and unrecoverable-sent positions identify wallet activity and belong in encrypted storage, not operational logs. The host stores up to 10,000 entries per set in 128-entry pages; the journal stores only bounded counts/digests, identities and checkpoints. The maximum four-set fixture exceeds 1 MiB as one JSON value but fits authenticated pages (317 records).

Coverage cannot shrink or reclassify earlier positions under the same policy. Later targets must retain the same source ledger/public store, nondecreasing anchor/counts, unchanged earlier trees and consistent roots for unchanged tree lengths. A policy change needs a fresh cache generation.

The full-cache observation covers at most 32,768 records / 64 MiB of plaintext. These are explicit development limits, not a promise of unlimited wallet history. Rescanning still rewrites SDK metadata; preserving qualified POI state across rescans remains future work. Exact rollback of all encrypted state together is not prevented by an external monotonic authority.

## Cache generations

An encrypted catalog has active and pending generation pointers. Generation directory names contain only random identifiers. A fresh candidate is built separately; publication requires a genuine registered wallet journal with matching wallet, policy, canonical directory and worker-store identity, plus current validated readiness. Replacing an active generation also waits for its journal to close **and** its storage worker's observed exit.

Opening the active generation requires `activeFor(policy)`, a store file inside that directory, and an exact match between its inspected instance ID and the catalog's `storeId` before use. A mismatched policy yields no active selection. Catalog publication is not a durable readiness grant: cold restoration still requires current source and wallet validation.

Development retention is capped at **eight generations per wallet, including abandoned candidates**. Rebuilds preserve older encrypted files; reaching the cap refuses further allocation and needs deliberate maintenance. There is no automatic deletion or key-rotation/erasure claim. Profile-wide deletion, backup and retention/erasure integration remain part of [#124](https://github.com/solardev-xyz/freedom-browser/issues/124) and product policy. If a crash occurs after recording a candidate but before its directory exists, resume refuses; beginning a new candidate safely abandons that reservation and counts it toward the cap.

## Qualification

- [Synthetic real Electron recovery and generation swap](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-wallet-journal-2026-10-02.json): **13 runs: eight completed scans/restores and five interruptions/refusals**, progressing through two received notes, later nullifier spend, then a received/sent self-transfer. Includes cold reopen, termination after the first derived batch, incomplete-restore refusal, close after coverage but before journal completion, restore completion of pending work, stale-public-checkpoint refusal, acceptance of renewed same-content public evidence, receipt replay refusal, first-host-action refusal, and a fresh generation published after the old worker exits. Old cache files remain present. Synthetic values are not a value-conservation or live-funds test.
- [Full archived Sepolia history](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-wallet-journal-history-2026-10-02.json): all 10,194 commitments with a known public viewing vector, fresh scan and cold derived-store restoration (**2.507 / 2.434 seconds**, ten source-header requests each; individual development measurements with other checks running, not performance guarantees). Zero received/sent notes, zero receive quarantine, 70 separately classified unrecoverable-sent entries, agreeing with the prior differential SDK check. No live acquisition, POI request, proof, signature or transaction.
- Unit tests cover opaque receipt/session/mode binding, invalid runtime/exit/guard reports, changed restore digests, durable pending recovery, stale/cloned observations, whole-cache mismatch, namespace/cursor restrictions, maximum-size paged coverage, lineage, generation publication/retention and failed-construction lifetime ownership.

Validation: `npm run lint` passes; full regression is **7,750 passed / 33 skipped across 364 passing suites**, with **six OpenLV integration checks** passing separately. A canonical-path lifetime assertion initially failed and was fixed before the final focused and full runs.

In these reports, `walletCoverageGranted: true` means the development journal reached `wallet-scanned-unverified` readiness; it does not mean product balances, POI eligibility or spendability.

Reports bind their source files and runtime inventory (including the integrity JSON in the policy hash). Only known public-vector positions and synthetic fixture results are published. Private upstream diagnostic material remains outside tracked files.

## Next

Expose current-Kohaku viewing reads only behind these checks; complete live acquisition, real-account enrollment, artifact/deployed-verifier matching, TXID/POI state, operation-bound proving/signing and durable shield/private-transfer/unshield recovery. Then use the authorized Sepolia funding through the existing wallet send journal for a bounded live lifecycle. Production packaging, cross-platform qualification and UX remain separate unfinished work.
