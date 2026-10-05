## October 5 update: proof recovery across a clean application restart

Original-signature proof recovery now passes **twelve separate-process cases**: transfer, full withdrawal and partial withdrawal, with both deposited and received inputs, against unchanged and explicitly advanced trees. Two warm compatibility cases also pass. **Partial submission, durable combined POI, change/second-spend and live private lifecycle qualification remain open.**

### Evidence

Each disposable public-vector setup persists a genuine signature before an injected broker refusal, drains its children and storage, releases the profile lock and exits. A separate Electron process observes the old PID absent, unlocks the existing vault and reopens genuine storage. No capability or receipt crosses the process boundary.

Cold bootstrap permits exactly seven lease/floor updates across six files, preserving authenticated contents and every other account/inventory byte. It explicitly derives the public identity using spending-public and viewing-identity material; it does not sign a new operation. The recovery host then uses those opened stores, two viewing-only jobs and a fresh independent verifier. The original capsule/signature stay unchanged; the proof is written once, and a duplicate performs no new work or writes. Submission stays disabled.

Advanced cases explicitly grow the tree before setup shutdown, preserve the original unspent input, and prove against the saved original root/path after restart. Current roots and checkpoints come from authenticated storage. Recovery performs no maintenance or repair. All fourteen cases share 532 unchanged source hashes. Restart recovery takes 5,480-5,876 ms, excluding setup. Recovery RPC totals are 41 for unchanged roots, 45 for advanced Shield inputs and 37 for advanced received inputs; there are no recovery POI, private-preflight or EOA calls.

### Scope and next steps

These are clean restarts after an injected utility fault, with simulated external chain/list/transport responses. Power-loss recovery, a third-process duplicate, physical Tor drainage and live acceptance are not established. The setup handoffs committed as evidence contain only public-vector metadata and hashes, not plaintext keys, signatures, capsules or opaque authority.

Production code and tests are unchanged from `ba44c1b4`; only the qualifier and documentation changed. Its 15,178-test regression was not repeated; all production and test hashes still match that recorded baseline (33 tests skipped, 511 suites passed/5 skipped; OpenLV exclusion and forced-exit caveat retained). Full lint and the native matrix pass. Claude and Codex reviewed the qualifier; Claude audited the native evidence and prose. This is engineering review, not an external security audit.

Next: connect partial withdrawals to genuine one-use submission/capture with 01x02 preflight. Cold-recovered proofs need a separately reviewed submission bridge; stored proof data is not a completion token. Continue combined POI persistence, normal change ingestion, restart/second spend and live qualification, then portable Host extraction and user-facing work. Wallet policy remains `e7671ac4`; earlier generations still need explicit maintenance. Main `dbfd0e7d` remains current. No funded profile was opened or new dependency/runtime pin introduced.

Details: [checkpoint](https://github.com/solardev-xyz/freedom-browser/blob/eb166a6c3205c9c04a4ed43bc6469454d2a94f9d/docs/railgun-proof-restart-2026-10-05.md), [qualification index](https://github.com/solardev-xyz/freedom-browser/blob/eb166a6c3205c9c04a4ed43bc6469454d2a94f9d/docs/qualification/railgun-proof-restart-2026-10-05.json), [roadmap](https://github.com/solardev-xyz/freedom-browser/blob/eb166a6c3205c9c04a4ed43bc6469454d2a94f9d/research/privacy-roadmap.md). The [preceding proof-recovery update](https://github.com/solardev-xyz/freedom-browser/blob/eb166a6c3205c9c04a4ed43bc6469454d2a94f9d/docs/privacy-progress-history-2026-10-05-proof-recovery.md) is preserved verbatim and links earlier checkpoints. Older historical detail follows.

---

