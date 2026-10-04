## October 4 update: Shield lifecycle prerequisites qualified

Railgun's lower-level deposit controllers now carry reviewed RPC restrictions and cancellation through preparation, receiver verification, signing and durable recovery. This prepares the separate Kohaku public deposit lane; `prepareShield` and its public submitter are still the next implementation step. No UI activation or funded private spend is claimed. This work has not reserved or spent the funded Shield note or changed PPv2 state; funded-profile policy/mirror refresh remains pending.

Implementation: `b86c6dad`; main `3b4f62df` merged in `08eb732c`. Current reviewed checkpoint: `a9419975f87ca60f48da54a9425ec2643b5efd3a`.

### What this adds

- Preparation and receiver utilities synchronously claim the genuine shared account phase, permanently refuse after invalid broker traffic, track borrowed credential work, wipe copied keys and observe actual child closure before releasing ownership.
- The operation validates genuine protocol and transaction destination constraints before either host runs. Every deployment-preflight attempt and the transaction handle stay bound to those destinations, including hidden chain checks and simulation. Journal recovery takes a fresh transaction restriction.
- Cancellation revokes new admission while original review/signer work drains. Failed cleanup leaves closure pending; it cannot create a safe handoff. Acknowledged results and genuine uncertain/unresolved journal outcomes survive, while callback-forged errors cannot imitate them.
- A fully offline qualifier intercepts both RPC roles before clients load. Exact signed target, amount, calldata, gas and intent must match the operation and attempted journal. Unexpected transport failures remain counted even across retries.

### Evidence and its limits

Four native cases pass: acknowledged deposit, lost acknowledgment recovered after reopening, cancellation during a held transaction review followed by late approval, and a dropped send that remains unresolved and blocks another submission. The run records 60 matching source hashes, three real signatures by an unfunded synthetic EOA, three simulated raw-send attempts, two simulated acceptances, four reviews and zero unexpected transport failures. The cancellation case signs and sends nothing.

The Railgun engine, vault-backed viewing identity, receiver cryptography, actual deployment-check code and encrypted journal execute. The four public bytecodes match production pins; headers, storage/getter replies, funding RPC and receipt/finality evidence are synthetic. Reopening means vault/session reopening in the same process. This is not live deployment, mined finality, application restart, physical Tor, vault funding-signer or private-spend qualification. The standalone operation still simulates before its only transaction review; the future public facade must add the earlier disclosure review.

Focused qualification: **346 tests / eight suites**, lint clean. Frozen full regression: **13,658 passed / 33 skipped**, **501 passing suites / five skipped**, **510.538 seconds**, all **1,489** source/test/configuration hashes unchanged. The existing OpenLV exclusion and explicit force-exit remain; this does not prove natural application-handle drainage. The later Ant/license-only main merge passes 230 focused tests; nodes were explicitly refreshed (Ant 0.5.58), matching Arti retained and binary checks pass.

[Implementation and native evidence](https://github.com/solardev-xyz/freedom-browser/blob/a9419975f87ca60f48da54a9425ec2643b5efd3a/docs/railgun-shield-prerequisites-2026-10-04.md) | [Public-lane plan](https://github.com/solardev-xyz/freedom-browser/blob/a9419975f87ca60f48da54a9425ec2643b5efd3a/docs/railgun-kohaku-public-shield-plan-2026-10-04.md) | [Full parity roadmap](https://github.com/solardev-xyz/freedom-browser/blob/a9419975f87ca60f48da54a9425ec2643b5efd3a/docs/railgun-parity-plan-2026-10-04.md)

### Next and still open

1. Connect genuine Kohaku public tokens and a separate submitter, with disclosure review before new key/RPC work, safe adopted-account handoff and nonrenewing authority.
2. Implement partial withdrawal, authenticated change recovery and a second spend, then the bounded return-to-origin recovery design.
3. Complete authorized live private transfer/output recovery/unshield and qualify a suitable broadcaster. The funded-note POI disclosure still awaits specific permission; general autonomy is not that permission.

The existing private Kohaku lane already connects full-note transfer/unshield in controlled native tests. Those five reports are historical only for the shared process file's narrower Shield receiver admission; private-operation job admission is unchanged. Portable Host extraction, UX/IPC, platform egress/packaging and release gates remain open. Claude reviewed implementation, tests, native evidence and documentation; this is engineering review, not an external security audit.

The preceding complete progress prefix is preserved [verbatim in the repository](https://github.com/solardev-xyz/freedom-browser/blob/a9419975f87ca60f48da54a9425ec2643b5efd3a/docs/privacy-progress-history-2026-10-04-kohaku-private.md). Earlier entries below retain their original checkpoint meaning and are superseded by newer evidence.

---

