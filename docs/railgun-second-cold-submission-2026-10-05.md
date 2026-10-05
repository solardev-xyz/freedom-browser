# Railgun second withdrawal submitted after a fresh restart

Both first-input histories (Shield and Transact) pass acknowledged and lost-response recovery through three distinct Electron processes: twelve processes, all observed exit 0 with their original driver handles drained. The same frozen source inventory is used throughout. Six additional compatibility processes pass: the earlier two-process restart and default, change, second-spend and terminal-ingestion modes. All eighteen reports share 913 source hashes.

This extends the connected change lifecycle with a separate process boundary after the second withdrawal has been proved. The earlier restart qualification reopened after the first operation and then proved/submitted the second within one process. Here the proof is persisted, all completion objects and owners are closed, and another process invokes the production recovered-submission host from the encrypted signing record. No production API or policy is widened by this fixture extension.

## Three-process lifecycle

1. A fresh disposable profile executes the actual first partial withdrawal, scans its change, persists its combined POI attempt and receives signed disposable-list acceptance. It drains and seals the existing setup handoff.
2. A different process reopens the profile, checks the first record and retained source, verifies saved list signatures with only the public key, stages the real scanned Transact change and makes the second private signature/proof. It stops before Ethereum review/signing/submission, drains the real account/staging/completion and seals the two-record handoff.
3. Another process reopens the encrypted stores and selects the second hold by its recorded digest. It calls `submitRailgunRecoveredPrivateTransaction`, which reacquires completed-wallet, TXID, creator, verification, list, root, private preflight, review and transaction-journal gates. It does not adopt a serialized completion, stage again or make another private signature/proof. A fresh Ethereum signature is made only after review and the attempt is persisted before its sole simulated send.

The handoff carries hashes, public run/profile identity and the encrypted file inventory. It contains no plaintext capsule, private signature, proof calldata, owned note/witness, hold ID or service signing key. Both earlier PIDs must be absent and every source/runtime/profile/predecessor hash must agree. A later process uses the immediately preceding encrypted snapshot; legitimate journal updates are not suppressed to force equality with an older snapshot.

First-operation canonical observation refreshes are bounded separately: one in the proving process, three in recovered submission. Their immutable identity/intent/resolution remains bound; whole-record byte identity across these legitimate updates is not claimed. Original private records, attempted combined POI state and its remaining reservations are preserved, and no new combined POI POST occurs.

## Submission, recovery and terminal accounting

The lost-response fixture throws only after verifying actual signed transaction bytes, nonce and durable attempt, when the synthetic transaction and receipt already exist. Production returns an uncertain hash; reconciliation proceeds without another send. Both acknowledged and lost paths refuse a repeated submission before and after receipt resolution, without extra reviews, credentials, requests or signing.

After submission, a genuine completed read-only wallet supplies the pre-terminal baseline while the public source still excludes the second receipt. That wallet is closed before normal public/TXID/wallet advancement ingests the actual second capture. The selected change becomes spent, the original input remains spent by the first transaction, unrelated notes remain and total unspent value decreases by exactly the selected change. This is not a whole-wallet-zero claim.

The setup writes the public wallet metadata from the existing genuine signer address lookup, with exclusive creation and mode `0600`; both handoffs hash that file separately from the encrypted vault. Reopened processes never repair missing metadata. This qualifies the fixture setup, not product onboarding.

Duplicate refusal performs exactly two logical context releases on the already-created shared RPC transport. That field is checked explicitly; every other activity field and the complete second-chain report must remain unchanged. These releases do not create a new transport, send a request or claim physical socket drainage.

Source-derived counters bind utility jobs, credential loans, storage workers and complete public/protocol/transaction RPC maps. The first disclosure callback checks all-role counters and the complete second-chain report before allowing work. Independent review identified earlier gaps where balanced missing/extra transaction requests and pre-disclosure reads could escape observation; exact expected maps and distinguishing controls now cover both. These fixture fixes do not assert a production authority defect.

| First input / response | Setup ms | Prove and stop ms | Reopened submit and ingest ms |
| ---------------------- | -------: | ----------------: | ----------------------------: |
| Shield / ack           |   86,078 |             6,837 |                        10,059 |
| Shield / lost          |   86,648 |             6,942 |                         9,993 |
| Transact / ack         |   95,358 |             7,037 |                         9,981 |
| Transact / lost        |   95,314 |             6,871 |                        10,263 |

Every P1 uses 17 utilities, 6 storage workers and 6 utility credential loans, with no second Ethereum signature or send. Every P2 uses 23 utilities, 7 workers and 5 loans: identity bootstrap 2 + recovered host 9 + completed-wallet baseline 2 + terminal ingestion 10. P2 performs one Ethereum signature/send, and no private-operate, receiver or spending-sign job. Utility exits are observed code 15, storage workers exit 0, with no escalation or peer disconnect. The P0 deliberate wrong-output refusals remain explicitly classified. Allocation/guard-hook totals and setup totals are observed evidence, not an exhaustive filesystem-I/O contract.

| Compatibility mode (Shield first input) | Elapsed ms | Utilities | Workers |
| --------------------------------------- | ---------: | --------: | ------: |
| restart-setup                           |     85,940 |       296 |      28 |
| restart-resume                          |     10,195 |        28 |       8 |
| default                                 |     83,875 |       289 |      25 |
| change                                  |     87,869 |       295 |      28 |
| second-spend                            |     91,052 |       306 |      31 |
| second-spend-ingest                     |     94,544 |       316 |      33 |

## Validation and limits

Root targeted verification passes 366 tests across 24 suites (15.625s), with full lint clean and original handles drained. This is engineering review, not an external security audit. Claude reviewed the fixture changes and the two source-backed bring-up corrections; an independent evidence audit reassembled the expected job, request and process maps. There are 913 matching native source hashes, an exact subset of the frozen 5,274-file source inventory. Full production regression remains the earlier 16,276 tests/544 suites at 189c0a31, with six separate OpenLV tests; it is not relabeled as a rerun of these fixture changes.

Two preserved bring-up diagnostics preceded the qualified campaign. Profile-a omitted public vault metadata and refused before disclosure or service activity; the setup and handoff inventory were corrected. Profile-b genuinely submitted once and correctly refused a duplicate, but its fixture incorrectly required logical transport-release accounting to remain unchanged. The corrected assertion derives exactly two releases from production cleanup and retains equality for all other activity. Neither failed profile was reused or labeled a complete qualification.

All service responses, review callbacks, chain receipts and finality remain simulated; account/storage/signing/proving/recovered submission are genuine production paths. The frozen profile transitions are orderly process restarts, not power loss. No funded wallet, live owned selector, real private-service acceptance, Tor transport or on-chain private withdrawal is qualified here. The second-spend creator is Transact for both first-input histories, even when the original first input came from Shield.

Original-signature recovery of a second proof interrupted after signature commit remains a separate next boundary. The genuine second Kohaku facade instance spending this recovered change, live private service/broadcast qualification, portable extraction and UX also remain open. The adapter production milestone and its full 16,276-test regression remain pinned to `189c0a31`; this extension changes qualification fixtures only and does not silently relabel earlier evidence.

The [evidence index](qualification/railgun-second-cold-submission-2026-10-05.json) links exact raw reports and their hashes; the [source inventory](qualification/railgun-second-cold-source-hashes-2026-10-05.json) and [independent audit](qualification/railgun-second-cold-audit-2026-10-05.md) preserve the verification scope.
