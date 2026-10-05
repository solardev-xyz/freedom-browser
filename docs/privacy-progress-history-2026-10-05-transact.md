## October 5 update: Railgun partial withdrawals from received funds

Checkpoint `2e4e12a9` qualifies the protected internal partial-withdrawal controller for both Shield-created and received Transact inputs. **The Kohaku facade remains full-only; partial submission, durable combined POI and unfinished-proof resumption remain open.**

### New evidence

- Received-input qualification uses the real public/wallet scanners, persisted TXID checkpoint, five provenance-staging handoffs, independent change verification, account POI, 01x02 preflight, durable reservation, one-use signing, actual proof and fresh independent verification. Missing and copied staging receipts refuse before service traffic.
- Final received/Shield runs pass in 33,497/22,722 ms with the same 522 unchanged source/test/fixture hashes. One spending key is delivered per healthy run, after durable signing. Signed capsules/proofs survive encrypted account reopening in the same process.
- Wrong credential, invalid membership path, wrong verifier and rejected TXID root refuse before signing. The rejected-root case occurs after preflight and therefore discloses one selected nullifier; the other negatives disclose none. Service totals are explicitly asserted: 15 latest-index reads, one indexer page and 14 root validations for Transact; zero for Shield.
- A new recovery-only reader returns an authenticated signed record whose proof slot is empty. It grants no signing or submission authority. All 43 capsule-store tests pass; lint passes. Claude reviewed code, reports and roadmap. This is engineering review, not an external security audit.

Transport, chain/list/indexer responses and root acceptance are simulated. The creator uses the same public test mnemonic, its spend is not proved, and the single-row fixture does not establish global TXID completeness. The Transact duplicate control rejects a consumed staging receipt; held-input exclusion is covered by the Shield run and prior unit tests. These runs do not qualify Tor, live eligibility, deployed verifier equality, a funded private spend, whole-application restart or unfinished-proof resumption.

### Next

Build completed-only read-only wallet restoration with full worker/callback drainage; regenerate proofs from the original authenticated signature for all supported kinds and both creator types. Then connect partial submission/capture, durable combined POI/disclosure, normal change scanning, full restart and second spend. Live private qualification, portable Host extraction, UX and release readiness remain open. Proof regeneration itself will not repeat signing-time disclosures or grant submission authority; submission retains fresh checks.

Main `dbfd0e7d` was fetched and remains current, with its earlier explicit node refresh. This checkpoint changes no dependency, pin, cache-policy input, IPC or renderer surface. The prior full regression remains historical for its recorded sources.

Details: [checkpoint](https://github.com/solardev-xyz/freedom-browser/blob/f47d19801a0f9826007129a26047ae319ef07fa0/docs/railgun-partial-transact-controller-2026-10-05.md), [qualification index](https://github.com/solardev-xyz/freedom-browser/blob/f47d19801a0f9826007129a26047ae319ef07fa0/docs/qualification/railgun-partial-transact-controller-2026-10-05.json), [roadmap](https://github.com/solardev-xyz/freedom-browser/blob/f47d19801a0f9826007129a26047ae319ef07fa0/research/privacy-roadmap.md). The [preceding controller update](https://github.com/solardev-xyz/freedom-browser/blob/f47d19801a0f9826007129a26047ae319ef07fa0/docs/privacy-progress-history-2026-10-05-controller.md) is preserved verbatim, including links to earlier checkpoint histories. Older historical detail follows.

---

