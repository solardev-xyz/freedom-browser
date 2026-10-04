## October 4 update: Kohaku public deposits connected and qualified offline

Railgun now has a separate Kohaku-shaped public deposit capability alongside its existing read and private-operation modes. Native ETH-to-WETH Shield uses the genuine controllers, vault signer and durable journal. This is technical integration, not UI activation, a generic portable Host package or a new live deposit. No funded profile, owned-note service query or live submission was opened by this milestone; it has not reserved or spent the funded Shield note or changed PPv2 state. Funded-profile policy/mirror refresh remains pending.

Reviewed checkpoint: `3e68ccb9320c7ce7f42473680cb4788e4f6486e9`. Current main remains `3b4f62df`, merged in `08eb732c`; a fresh fetch found no newer commit. The earlier explicit node refresh remains current. Dependencies, runtime archives, policies and deployment pins are unchanged by this slice.

### What this adds

- `mode: 'public'` and native `prepareShield` produce a genuine one-use public operation. A separate main-owned public submitter consumes it; the private broadcaster refuses it. Initial scope stays Sepolia, at most 0.01 ETH, pinned 25 bps fee, and the enrolled private recipient.
- A first review uses stored public wallet metadata, without deriving an address from a key. It names both RPC destinations and discloses that simulation reveals the funding EOA, amount and exact encrypted-note calldata before final transaction review. Approval permits simulation, not signing or sending. Genuine destination restrictions remain in force.
- The wallet handoff survives preparation review and wallet drainage. Late-returned controllers and original callbacks stay owned through cleanup. Final public review retains facade exclusion after shared phases have released; generic wallet/recovery entry points may proceed. Unconfirmed cleanup cannot release ownership.
- A nonrenewing 120-second public budget covers review, token waiting and submission. Known acknowledgments and genuine uncertain/unresolved journal outcomes survive closure. Both acknowledged and lost-response attempts block another submission until resolution; there is no automatic retry.

### Evidence and limits

Three fresh offline Electron processes pass acknowledged, lost-response and held-transaction-review cancellation cases: 1,839 / 1,854 / 2,149 ms for the public flow. Each also passes 19 enrolled baseline cases and records 169 current source hashes. Each uses two actual Shield utility jobs and one viewing callback. Acknowledged/lost-response each make one real vault EOA signature and one simulated send; cancellation makes neither, including after late approval. All report zero private spending keys, added POI traffic and unexpected transport failures.

Real pinned public bytecodes feed actual deployment-check code, but headers, slots, getters, balances and transaction responses are synthetic. The native evidence is not physical Tor, mined chain state, cold resolution, new-note ingestion or live eligibility. Source inventories are not execution coverage. Setup and wallet reopens are outside the zero-added-source-query claim. The native foreign-token control uses a consumed token; other token cases have focused coverage.

Five fresh private compatibility processes also pass: Shield transfer/lost acknowledgment, Shield unshield, received-Transact transfer, received-Transact unshield/lost acknowledgment, and held private transaction-review cancellation. Each has 19 baseline cases and 133 current source hashes. Real proofs, verification, signatures and journals execute; POI/preflight authority and transport remain synthetic. The four sending cases each sign once privately and once with the EOA and simulate one send. Cancellation retains the private proof for recovery with no EOA signature or send. Full originals and a compact index are retained for audit.

Focused tests: 162 pass across three suites. Full regression: 13,736 pass / 33 skipped, 502 suites / five skipped, 521.36 s; all 1,494 hashes unchanged. Existing OpenLV exclusion and force-exit; lint clean.

Claude and an independent Codex reviewer reviewed source, native evidence and prose: engineering review, not an external security audit. No live private transfer, unshield or full PPv2 parity is claimed. Next: partial WETH withdrawal, authenticated change recovery, combined output/unshield POI, and a second spend of that actual change. Live private qualification (awaiting specific disclosure permission), restricted Host extraction, product UX and release checks remain open.

Audit details: [public integration and reports](https://github.com/solardev-xyz/freedom-browser/blob/3e68ccb9320c7ce7f42473680cb4788e4f6486e9/docs/railgun-kohaku-public-integration-2026-10-04.md), [remaining parity work](https://github.com/solardev-xyz/freedom-browser/blob/3e68ccb9320c7ce7f42473680cb4788e4f6486e9/docs/railgun-parity-plan-2026-10-04.md), [partial-withdrawal plan](https://github.com/solardev-xyz/freedom-browser/blob/3e68ccb9320c7ce7f42473680cb4788e4f6486e9/docs/railgun-partial-unshield-plan-2026-10-04.md). The previous Shield-prerequisite update is preserved [verbatim](https://github.com/solardev-xyz/freedom-browser/blob/3e68ccb9320c7ce7f42473680cb4788e4f6486e9/docs/privacy-progress-history-2026-10-04-shield-prerequisites.md); older history remains below.

---

