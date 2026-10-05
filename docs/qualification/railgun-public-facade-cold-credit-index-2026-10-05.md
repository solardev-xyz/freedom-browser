# Public Shield facade: cold resolution and ordinary credit, 2026-10-05

The acknowledged and lost-response campaigns each completed setup, independent cold receipt resolution plus ordinary scan, and a third-process completed restore. All six distinct main processes exited 0 with predecessor PID links matching the driver progress records. The lost-response setup sent once to the synthetic service, then withheld the reply; later phases did not resend or sign. This qualifies the disposable intercepted flow, not live service behavior.

Final outer freeze-e SHA-256: `d1f29026b06eeb2c4dab9a1ac07f94112186610a09caf1e8d032087bc8b867c8`. Source baseline: `db8cfd7c1af668f99fb200dfb4b078548dde5e27` plus the reviewed fixture files captured in that freeze. Pending newer-main/Ant updates are outside this evidence.

## Exact report copies

The JSON files below are byte-for-byte copies of the six original reports, matched to driver-recorded hashes. Elapsed values are the reports' phase timings, not total launcher or end-to-end wall time. RPC columns are source/deployment/transaction calls to intercepted synthetic services.

| Mode | Phase | Reported ms | RPC S/D/T | Utility jobs | Store workers | Exact report |
| --- | --- | ---: | --- | ---: | ---: | --- |
| acknowledged | setup | 3234 | 49/13/10 | 8 | 7 | [railgun-public-facade-cold-credit-acknowledged-setup-2026-10-05.json](railgun-public-facade-cold-credit-acknowledged-setup-2026-10-05.json) |
| acknowledged | resolve | 2177 | 39/0/41 | 6 | 3 | [railgun-public-facade-cold-credit-acknowledged-resolve-2026-10-05.json](railgun-public-facade-cold-credit-acknowledged-resolve-2026-10-05.json) |
| acknowledged | restore | 2911 | 19/0/0 | 4 | 3 | [railgun-public-facade-cold-credit-acknowledged-restore-2026-10-05.json](railgun-public-facade-cold-credit-acknowledged-restore-2026-10-05.json) |
| lost-response | setup | 3083 | 49/13/10 | 8 | 7 | [railgun-public-facade-cold-credit-lost-response-setup-2026-10-05.json](railgun-public-facade-cold-credit-lost-response-setup-2026-10-05.json) |
| lost-response | resolve | 2221 | 39/0/41 | 6 | 3 | [railgun-public-facade-cold-credit-lost-response-resolve-2026-10-05.json](railgun-public-facade-cold-credit-lost-response-resolve-2026-10-05.json) |
| lost-response | restore | 2860 | 19/0/0 | 4 | 3 | [railgun-public-facade-cold-credit-lost-response-restore-2026-10-05.json](railgun-public-facade-cold-credit-lost-response-restore-2026-10-05.json) |

Acknowledged reported phase sum: 8,322 ms. Lost-response sum: 8,164 ms. Combined totals: 342 synthetic RPC calls (214 source, 26 deployment, 102 transaction), 36 utility jobs and guard reports, 26 storage workers, 10 viewing callbacks, 22 fixed-purpose credential messages, two EOA signatures and two synthetic sends. Exactly one response was deliberately lost. Later resolve/restore phases perform zero signing/sending. All six reports record zero unexpected transport requests and wiped observed credential buffers.

The 36 utilities report `RAILGUN_PROCESS_CLOSED`, observed exit 15, no escalation and no peer disconnect. These are intentional host closures, not six additional main-process failures. Every storage worker reports exit 0. The main-process exit-zero evidence comes from the independent driver progress records, not a claimed zero utility exit. Logical synthetic transport creates/closes are 6/6, releases 16 and revoked groups 12; no physical Tor/socket-drain claim follows.

## Hash inventory is not executed coverage

Each report carries the same **5,545** broad JS/JSON source/config/package-file hashes, including **4,352** nested `scripts/fixtures/railgun-engine/node_modules` entries found by the directory walk. All 5,545 match the corresponding entries in the outer **5,795**-entry freeze; there are zero conflicts and 250 additional outer entries. Neither number is an executed-file count, and these inventories do not measure test or authority coverage. The earlier scratch import-only probe's 1,190 entries were a different copied-tree observation and are not the native inventory count.

[Source inventory](railgun-public-facade-cold-credit-source-inventory-2026-10-05.json) preserves both mappings and labels ten external pins. The selected engine archive, public source capture, bytecode input, Electron executable and Electron Framework are distinguished from the unused prover archive and four Kohaku interface-reference pins. No prover or generic Kohaku Host integration is qualified here. This read-only audit compares recorded manifests and report hashes; it does not claim a fresh rehash of every current repository/runtime file.

## What the assertions establish

Setup checks denied first review, copied/replayed token refusal and encrypted journal attempt before the actual synthetic send. The worker inventory specifically records three initialize-then-publish store lifecycles plus one active wallet reopen: 7 workers. Resolve and restore each have 3 workers; restore's wallet worker is read-only.

Resolution uses a fresh process/owner and explicitly unverified RPC evidence, exercises missing and corrupt receipt paths, then resolves the exact original intent. Ordinary scan independently establishes a single received credit and preservation of unrelated notes. The third process retains that same credit without duplication using completed-only restore. The report flags do not establish consensus finality, POI eligibility, spendability, private-operation authority or a retry permission. No POI/TXID queries or private-operation jobs occur.

The profile seal binds the previous process's state. It is not an allowlist of every ordinary-scan write or a whole-browser-profile byte-identity claim. Exact wallet-generation comparisons have their narrower resolution/completed-restore scope. No profile contents, private handoff, public wire file, raw transaction, address, note/ciphertext snapshot or key material is included in this publication package. Raw progress files contain local path metadata and are retained only in the local audit area, outside the copy plan.

## Excluded and separate evidence

- `a`: setup exit 1 at the lowercase-only nonce-address fixture check, before signing/sending. Excluded.
- `b`: setup flow/drain completed but final worker count omitted staging initializers; exit 1. Excluded.
- `c`: final inventory check treated Electron virtual cache aliases as project files; exit 1. Excluded.
- `d`: preparatory runtime freeze with nine external pins, before Framework inclusion. It is not credited as a healthy campaign.
- The separately rebased negative control is not included or relabeled healthy. Its evidence must be reviewed and published separately.

The independently read focused-test log records 684 tests in 13 suites passing in 10.635 s. Root reports lint pass; no full-regression claim is added here. Native report audit details and progress/log digests are in [the audit summary](railgun-public-facade-cold-credit-audit-2026-10-05.json).

## Report SHA-256

- `railgun-public-facade-cold-credit-acknowledged-setup-2026-10-05.json`: `79b2f26d5aabbc8083b0532be77ecfcad7e620d55c6b90c10edab7f463346000`
- `railgun-public-facade-cold-credit-acknowledged-resolve-2026-10-05.json`: `f481ad6526551b76ce07ddadcc12887b05f916f60edb4b2d1002a4ea4fc599ac`
- `railgun-public-facade-cold-credit-acknowledged-restore-2026-10-05.json`: `a7983b50914c815801e95757b47db2d8ca0247af1ccc750b010d2657fda9d7a1`
- `railgun-public-facade-cold-credit-lost-response-setup-2026-10-05.json`: `a0a127ef8666ee75879fd5d3c1aceee6ded1818e6678b3b57811e4d6f2f870ab`
- `railgun-public-facade-cold-credit-lost-response-resolve-2026-10-05.json`: `5ea9983b4d5ca75301aeafbea379433481bfb248676931a96c7c13091b85a91b`
- `railgun-public-facade-cold-credit-lost-response-restore-2026-10-05.json`: `9ff366dc2200d39181d172f5438f2a0632d5b71fdf57ff15ae4c9a047a3bd892`
