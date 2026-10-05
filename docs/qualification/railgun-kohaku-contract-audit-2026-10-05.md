# Kohaku contract campaign — independent evidence audit

All nine disposable Electron processes passed. Eight adapter cases are qualified alongside one default-wallet compatibility case. Original drivers 52467, 12796, 93974 and 68597 were observed terminal exit 0 and drained by the parent; their progress files independently record the nine child PIDs/exit codes. This auditor read reports/source/logs, opened no profile and launched no tests/native processes.

## Exact results

| Case | Selected sources | Checked reads | EOA sign/send | Checked forwarding | Utility / worker pre-cleanup starts:settlements |
| --- | ---: | ---: | --- | --- | --- |
| shield-transfer-lost | 142 | 122 | 1/1 | uncertain | 108:108 / 80:79 |
| shield-unshield | 142 | 122 | 1/1 | acknowledged | 107:107 / 80:80 |
| transact-transfer | 142 | 122 | 1/1 | acknowledged | 121:121 / 85:83 |
| transact-unshield-lost | 142 | 122 | 1/1 | uncertain | 120:120 / 85:85 |
| shield-transfer-cancel | 142 | 109 | 0/0 | refused | 106:106 / 78:78 |
| acknowledged | 177 | 109 | 1/1 | acknowledged | 97:97 / 81:79 |
| lost-response | 177 | 109 | 1/1 | uncertain | 97:97 / 81:79 |
| review-cancelled | 177 | 109 | 0/0 | refused | 98:98 / 82:80 |
| default-wallet | 139 | 0 | 0/0 | none; default compatibility | not instrumented |

Total: 924 checked read calls, including four prior post-reopen instanceId reads replaced by the new conformance sequence: 920 net additional calls. Eight forwarding settlements are identity-checked: three acknowledged, three uncertain, two refused. Six actual vault EOA signatures and simulated raw sends occur. The default run has 19 base groups, no Kohaku qualification/contract meter and zero submissions; it is not a ninth adapter case.

Eight owned-view windows each use [11,11,11,11,13,13,13,13]. Four ordinary private cases add private/read 13+13 (122 each); private cancellation adds private13 (109); three public cases add public13 (109 each). Balance conservation, spent filtering and identity match genuine current owned snapshots. Measured RPC/key/authority/resource counters remain unchanged by these reads; this is not SQL/filesystem/OS-wide zero-work evidence.

Private cases check one forwarding result out of five genuine delegate entries/settlements; public cases one out of seven. Private uncertainty is a fulfilled specialized value; public uncertainty is the original typed rejection. Other delegate calls exercise existing refusal controls and must not be presented as additional independently checked outcomes. Cancellation in the private lane follows one private signature/proof and retains its signed hold while preventing EOA signing/sending; public cancellation has no private signature/prover and no EOA sign/send. Wrapper counters cannot prove absence of attempts rejected below those seams.

Private native fixtures retain synthetic account POI and private-preflight authority. Transact creators run genuine staging over synthetic services (latest/page/root 6/1/5); Shield private cases use 0/0/0. Public cases execute genuine Shield hosts and preflight with pinned code bytes but synthetic headers/storage/getters; each uses one viewing callback and two Shield utilities, with zero private spending keys or added POI traffic. Cold public resolution/credit, unconsumed foreign-token native checks and physical Tor qualification remain false.

## Sources, cleanup and publication

Per-report selected inventories are 142 private, 177 public, 139 default; their consistent union is 178 files. Every selected hash matches the broader/current freeze of 5,778 source files and nine external inputs. These maps are not execution coverage or a transitive dependency closure. INDEX records exact before/after freeze digest, all external-input digests, reviewed ten-fixture manifest/bases and candidate-freeze digest for reproduction. No production modules/dependencies/pins were changed by this contract slice.

Report resource counters precede final cleanup. Some worker settlements therefore trail starts. The entrypoint finally closes owners in dependency order, awaits observers/meters, records cleanup failures and passes the sticky gate before explicit app.exit(0). Exit/drain evidence does not relabel pre-cleanup counters as final totals or establish natural event-loop exhaustion/physical socket closure. The inherited root submissions:0 field is base-wallet scope; nested adapter rpc.sends records actual simulated sends.

All raw reports were inspected for sensitive/raw payload fields. Ciphertext/raw-send-named fields found are booleans/counters, not wire payloads. Reports contain aggregate/public-vector synthetic history and source hashes; no mnemonic, key, raw signed transaction, note ciphertext, private proof or profile copy is included. COPYPLAN permits only the nine byte-exact aggregate reports plus audit/source artifacts; synthetic wire and disposable profiles stay outside publication.

Root validation: 312 tests/seven suites in 0.623s, full lint and scoped formatting passed. Logs and hashes are in INDEX; auditor did not rerun them. Earlier first/private/public audit snapshots remain preserved. No live funded/service, TypeScript compilation, generic Kohaku Host, portable backend, release approval, UI activation or public cold-credit claim follows from this campaign.
