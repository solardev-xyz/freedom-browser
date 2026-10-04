## October 4 update: bounded partial-withdrawal records; existing flows preserved

Railgun partial unshield now has a distinct structural model and version-2 capsule. Partial spending is still unavailable: the next stage is actual 01x02 proving and original-change reconstruction, followed by receipt recovery, combined POI and spending the recovered change. Existing Kohaku public deposits and full-note private operations remain available at their previously qualified technical scope; product UI and a portable Host package are separate.

Reviewed checkpoint: `12ac9de4b380ae920a74008af905fb74df1e67f5`. A fresh fetch confirms main `3b4f62df` remains merged, with the prior explicit node refresh current. No dependencies, binaries or deployment pins changed. Four wallet-policy source inputs changed, requiring normal derived-cache rebuilding. Public/TXID policy inputs and runtime archives are unchanged. The funded profile was not opened or refreshed; its pending policy/mirror refresh now also covers this wallet-policy change; no funded/private-service action or PPv2 state change occurred.

### New model and boundaries

- Bind recovered input V, gross withdrawal U and derived change C separately, with 0 < U < V and C = V - U. Public intent binds one nullifier, ordered change/unshield commitments and one ciphertext; it does not add plaintext input/change values.
- Version 2 is exclusive to partial unshield and has its own capsule digest domain. Legacy canonical bytes/digests remain unchanged. Circuit signature-hash semantics stay unchanged; no plaintext output randomness is added.
- Operation, wallet, staging, signing, recovery and POI entry points reject the unfinished flow before sensitive work. Reservations and the public EOA journal remain legacy-only. Mixed encrypted-store tests qualify structural normalization, not a genuine partial hold or signature.
- Before enabling new durable records, handle downgrade compatibility explicitly: older builds may refuse a capsule store or, later, an address's shared journal, including ordinary sends.

### Evidence and limits

Four focused runs total 890 passing tests across 18 suites. Temporary guard-removal controls produce 13 expected failures across seven consumer suites and four across three admission suites; an independent selector still refuses one additional Transact case. Lint is clean.

Six fresh offline native runs pass: Shield transfer/lost acknowledgment (4,502 ms), Shield unshield (4,106), received-Transact transfer (8,351), received-Transact unshield/lost acknowledgment (7,738), held private-review cancellation (3,514), and public Shield acknowledgment (1,874). Each passes 19 enrolled baseline cases. Private inventories contain 133 current hashes; public contains 169. Complete original reports and an index are retained. Real legacy cryptography, signing and journals execute; RPC/POI authority remains synthetic. No version-2 proof or live private flow is claimed.

Full frozen regression: 13,872 tests passed / 33 skipped, 503 suites passed / five skipped, 557.035 seconds; all 1,496 source/test/configuration hashes unchanged. Existing OpenLV exclusion and force-exit apply; natural application-handle drainage is not qualified by that suite.

Claude reviewed source and native evidence; Codex supplied implementation and independent controls. This is engineering review, not an external security audit. Remaining: actual partial proof/recovery, combined POI, second spend, live eligibility/disclosure (awaiting specific disclosure permission) and funded private qualification, portable Host extraction, UX and release readiness.

Audit details: [checkpoint and evidence](https://github.com/solardev-xyz/freedom-browser/blob/12ac9de4b380ae920a74008af905fb74df1e67f5/docs/railgun-partial-structure-2026-10-04.md), [complete partial-withdrawal plan](https://github.com/solardev-xyz/freedom-browser/blob/12ac9de4b380ae920a74008af905fb74df1e67f5/docs/railgun-partial-unshield-plan-2026-10-04.md). The preceding public-Shield update is preserved [verbatim](https://github.com/solardev-xyz/freedom-browser/blob/12ac9de4b380ae920a74008af905fb74df1e67f5/docs/privacy-progress-history-2026-10-04-public-shield.md); earlier history remains below.

---

