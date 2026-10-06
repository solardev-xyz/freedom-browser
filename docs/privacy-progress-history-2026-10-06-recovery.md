## Current checkpoint: authenticated recovery after restart

PPv2 has a bounded live native Sepolia journey; Railgun has a funded public Shield/restart milestone and controlled private/recovery infrastructure. User-facing privacy features remain disabled. Research: #475; implementation: draft #476.

The new fixed Freedom recovery companion discovers authenticated local history in pages of sixteen records, explicitly resumes the original signed proof, and separately requests cold submission. History states describe retained data; fresh controller authority and prior-attempt protection remain necessary. A selector never recreates an in-memory operation token.

One fresh four-process Shield chain at `cf25d54c` passed setup, signature stop, recovery stop and recovered submission. Recovery cancelled held delivery of an actual exited verifier result, preserved the original signature and empty proof slot, authentically reopened stores and then explicitly recovered. A separate process submitted once and refused two prior attempts. All four original processes and the driver exited 0; frozen report, handoff and source/runtime checks passed without changing expectations after execution. The recovery process recorded 12 utilities, four workers and six key loans. Exactly seven existing account files changed between signature stop and recovery stop; overlapping reopen and proof writes are subsets of that set. Other stage changes are recorded separately.

Two focused root runs passed 506 tests/10 suites and 113 tests/6 suites with natural exits, strict lint and explicit formatting. Their 619-test sum is not a full-repository regression. Claude and Codex reviewed implementation, fixtures, acceptance criteria and evidence within their stated scopes; this is engineering review. Services remain synthetic, cancellation covers a held callback after verifier exit, and no live private spending or physical Tor-drainage claim follows.

The earlier restricted public/private adapters, five-factory Node prototype and loopback transport campaign retain their own evidence and source pins. This recovery companion is main-owned; the standalone package does not export its account authority. See the [recovery report and audit evidence](https://github.com/solardev-xyz/freedom-browser/blob/f0fe14f4049416b594f0430563a827e43bdfa8d6/docs/railgun-recovery-companion-2026-10-06.md), [parity plan](https://github.com/solardev-xyz/freedom-browser/blob/f0fe14f4049416b594f0430563a827e43bdfa8d6/docs/railgun-parity-plan-2026-10-04.md) and [full roadmap](https://github.com/solardev-xyz/freedom-browser/blob/f0fe14f4049416b594f0430563a827e43bdfa8d6/research/privacy-roadmap.md).

Next autonomous work is source-pinned Railgun gas-relay feasibility and design: the current adapter broadcaster delegates to EOA self-broadcast. Production relay implementation requires exact quote, transport and service contracts. Live owned-note/service disclosures still require specific authorization following the earlier automatic-review rejection. Return-to-origin spending policy, generic Host support, broader operation scope, platform/release qualification and the deferred product UX remain distinct gates.

The previous public Shield/package/transport checkpoint is [archived verbatim](https://github.com/solardev-xyz/freedom-browser/blob/f0fe14f4049416b594f0430563a827e43bdfa8d6/docs/privacy-progress-history-2026-10-06-public-node.md). Earlier research and implementation detail remains below unchanged.

---

