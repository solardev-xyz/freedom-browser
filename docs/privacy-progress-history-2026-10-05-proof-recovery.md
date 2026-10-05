## October 5 update: original-signature proof recovery

The new trusted-main recovery host finishes an interrupted Railgun proof using its saved capsule and original signature. It verifies the result independently and fills only the original proof slot. **All three private kinds and both input creators now pass controlled native recovery; full fresh-process and live private lifecycle qualification remain open.**

### What changed

- Existing-only recovery storage refuses missing or unregistered history. A dedicated viewing-only utility restores the completed wallet and reconstructs the original witness without signing another operation.
- The host drains wallet work before reacquiring recovery ownership, compares the saved record before and after independent verification, writes once and checks authenticated readback. Cancellation, drift and competing updates refuse.
- A retry returns stored `proof-present` data without more proving or writes. It does not claim fresh verification or create completion/submission authority. The partial Kohaku facade remains closed.

### Evidence and limits

Six separate public-vector profiles pass transfer, full withdrawal and partial withdrawal for both Shield-created and received Transact inputs (21,406-25,516 ms; 532 unchanged hashes each). Each recovery uses two viewing-only jobs and one fresh verifier, with no new signing, private-service query or EOA call. RPC is exactly one chain-ID handshake, 38 header reads and two log reads. Only the capsule proof slot/sequence and its enrollment floor change; wallet state, inventory and the original signature remain unchanged. A duplicate performs no additional job, key loan, RPC or write.

The fixture replaces a broker reply after a genuine durable signature; the resulting revocation exit is observed. This is warm cached-store recovery within one application process, not a natural crash or power-loss test. Chain/list/transport responses are simulated; no live acceptance, physical Tor drainage or advanced-root native recovery is claimed. Cold opening can legitimately refresh leases and floors.

Direct and dependent suites pass 921 tests across 16 suites; lint is clean. Repository coverage: 15,178 passed/33 skipped; 511 suites passed/5 skipped in 611.319s. The 1,371-file manifest is unchanged. Existing OpenLV exclusion and forced Jest exit retained; this is not a natural handle-drain result. Claude reviewed implementation, the six reports and documentation; an independent Codex reviewer authored host tests and checked guard-removal controls. This is engineering review, not an external security audit.

### Next and policy impact

Qualify genuine fresh-process recovery and explicitly advance the tree before resuming the original signed operation. Continue partial submission/capture, durable combined POI, change ingestion, restart/second spend and the live private journey. Portable Host extraction, UX and release readiness remain open.

Wallet policy advances to `e7671ac4`; existing derived wallet generations need explicit maintenance. Recovery must not silently rebuild them. Public/TXID policies and pinned runtimes are unchanged. No funded profile was opened. Main `dbfd0e7d` remains current; no new dependency, IPC or renderer change.

Details: [checkpoint](https://github.com/solardev-xyz/freedom-browser/blob/ba44c1b4dc711fb84d0c9eec22d3f9f587d77838/docs/railgun-proof-recovery-2026-10-05.md), [qualification index](https://github.com/solardev-xyz/freedom-browser/blob/ba44c1b4dc711fb84d0c9eec22d3f9f587d77838/docs/qualification/railgun-proof-recovery-2026-10-05.json), [roadmap](https://github.com/solardev-xyz/freedom-browser/blob/ba44c1b4dc711fb84d0c9eec22d3f9f587d77838/research/privacy-roadmap.md). The [preceding completed-wallet update](https://github.com/solardev-xyz/freedom-browser/blob/ba44c1b4dc711fb84d0c9eec22d3f9f587d77838/docs/privacy-progress-history-2026-10-05-completed.md) is preserved verbatim, with earlier history linked there. Older historical detail follows.

---

