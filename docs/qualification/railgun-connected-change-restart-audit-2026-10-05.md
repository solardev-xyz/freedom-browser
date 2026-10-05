# Connected restart evidence audit (complete)

Four primary reports audited: separate setup/resume processes for both original Shield and Transact creators. All 902 source hashes are equal across these reports and match the merged root tree 4ab31ac1. All four unchanged-mode compatibility cases also passed on the same 902 sources; all eight constituent processes have confirmed exit 0.

Each resumed process records 28 observed utility exits, 8 storage workers all exit 0,7 credential loans (two identity derivations, three wallet-viewing, private-operate and spending-sign). All utility exits are observed controlled RAILGUN_PROCESS_CLOSED; exit 15 is the established utility shutdown code, not a missing-exit claim. The one observed storage-key copy is wiped; source assertions additionally require every borrowed loan wiped. No sticky assertion violations, pending transports, unexpected transport failures, EOA retries or new combined POI POST occur.

Bootstrap matches 7 jobs / 17 headers/one logs read/two root-service pairs and drains the mirror before second signing. Fresh second spend matches 11 jobs, exact creator final-unshield verification, current POI/root and two real private preflights; one EOA signature/attempt/send. Four legitimate first-record canonical observation refreshes preserve original attempt identity/intent/resolution; they are not whole-record byte immutability. Original private record and retained POI entry/ciphertext remain preserved.

Terminal ingestion adds 10 jobs and one TXID row from two proxy logs. The selected change becomes spent, original input remains spent, all unrelated notes and balances remain, total unspent decreases by exactly C, and no new UTXO leaf/root is created. This does not claim the whole account has zero funds.

Outer newProcessRestartQualified=true is justified by the enclosing setup/resume process boundary. Nested terminalIngest.newProcessRestartQualified=false is deliberate: that reusable component independently proves only its scan/ingestion work, not an OS process boundary. Scope B cold submission of an already-proved second transaction and scope C its signed-unfinished recovery stay false. Synthetic chain/receipt/finality/list-service trust, no funded wallet, no real service acceptance, no Tor or full host egress proof.

[evidence index](railgun-connected-change-restart-2026-10-05.json) joins exact report hashes and merge/node provenance. COPYPLAN.json includes 8 ready raw reports and 0 pending compatibility reports. No private wire, handoff, profile or second-capture files were copied or included. All eight report audits are complete. Root observed original driver 6174 terminal exit 0 and drained it; six child process.wait exit 0 results plus the independently drained Shield pair account for all eight native processes.

Compatibility measurements:

| Mode                | Elapsed ms | Utilities | Storage workers | Key loans | First-stage groups |
| ------------------- | ---------: | --------: | --------------: | --------: | -----------------: |
| default             |      86849 |       289 |              25 |        15 |                 17 |
| change              |      92488 |       295 |              28 |        18 |                 20 |
| second-spend        |      94476 |       306 |              31 |        22 |                 20 |
| second-spend-ingest |      94632 |       316 |              33 |        23 |                 20 |

First-stage groups are 17 for default and 20 for modes with change. Second-spend and terminal evidence are separate nested components, not extra first-stage groups. All compatibility modes correctly keep newProcessRestartQualified=false. Merge/node-refresh provenance remains linked by exact hashes in [evidence index](railgun-connected-change-restart-2026-10-05.json), published as [main-sync notes](../privacy-main-sync-2026-10-05.md) and [main-sync evidence](privacy-main-sync-2026-10-05.json); the published JSON is semantically identical to the original scratch report; its existing wrong-test-path diagnostic is not relabeled a regression.
