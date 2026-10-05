## October 5 update: protected internal Railgun partial withdrawals

At `7425293b9f4ea1fbceb024c8ee5099b7d1279958`, a genuinely scanned Shield input now completes the internal partial-withdrawal controller: independent change verification, account POI, anchored 01x02 preflight, durable reservation, one-use signing, actual proving, separate verification and encrypted account reopening. **The Kohaku facade still permits full-note operations only; partial submission and durable combined POI remain closed.**

### Qualified

- Input V, gross withdrawal U and private change C are bound to the original intent. A separate viewing-only job verifies original change ciphertext, self NPK, WETH/value/hash, annotation, memo and final unshield preimage before POI or selected-nullifier disclosure.
- Preflight fixes the circuit choice before asynchronous work, matches `getVerificationKey(1, 2)` against pinned 01x02 artifacts and then checks the selected nullifier. Exact kind binding is repeated at signing gates; legacy observations keep their bytes.
- Final connected native run: 21,678 ms, 522 unchanged source/test/fixture hashes, one spending-key delivery, actual A proof and fresh C verification. Credential mismatch, bad list path and wrong verifier refuse at their intended stages with no spending key, selected-nullifier query or durable state change. Duplicate admission refuses before services. The saved signed capsule/proof survives vault lock/unlock and enrollment reopening in the same process.
- All 689 focused tests across 13 suites pass; lint clean. Detached guard-removal controls distinguish amount and repeated-kind checks. An exact older reservation reader refuses the whole mixed store without changing ciphertext, floor or inventory. The current reader recovers both legacy and partial entries. Older builds cannot use that reservation store after partial records exist.

The native fixture uses real account/POI/preflight/RPC hosts and capability registries, with synthetic chain/list responses, an ephemeral service signing key and simulated transport. Tor availability is forced only for the offline fixture; no real Tor/service/deployment acceptance or funded private spend is claimed. The connected native input is Shield; received-Transact controller admission currently has unit coverage. Same-process encrypted reopening is not a fresh-application restart or resumption of an unfinished proof. Diagnostic runs A-C found a missing fake-transport cleanup method; D passes after correcting the fixture, without weakening production safeguards.

### Next

Qualify the received-Transact input through this controller; implement production recovery for signed-but-unfinished proofs; connect partial submission and own-operation capture; persist/disclose both combined POI outcomes; then scan the actual change, restart and spend it again. Facade activation follows that lifecycle. Live private qualification, portable Host extraction, UX and release readiness remain open.

Main `dbfd0e7d` remains current and already merged with its explicit node refresh. No dependency, runtime/artifact pin, derived-cache policy, IPC or renderer changes. The preceding full repository regression remains historical for its recorded source state. Claude reviewed implementation and evidence; this is engineering review, not an external security audit.

Details: [controller checkpoint](https://github.com/solardev-xyz/freedom-browser/blob/7425293b9f4ea1fbceb024c8ee5099b7d1279958/docs/railgun-partial-controller-2026-10-05.md), [native report](https://github.com/solardev-xyz/freedom-browser/blob/7425293b9f4ea1fbceb024c8ee5099b7d1279958/docs/qualification/railgun-partial-controller-native-2026-10-05.json), [qualification index](https://github.com/solardev-xyz/freedom-browser/blob/7425293b9f4ea1fbceb024c8ee5099b7d1279958/docs/qualification/railgun-partial-controller-2026-10-05.json). The [previous combined-POI update](https://github.com/solardev-xyz/freedom-browser/blob/7425293b9f4ea1fbceb024c8ee5099b7d1279958/docs/privacy-progress-history-2026-10-05-combined-poi.md) is preserved verbatim; older historical detail follows.

---

