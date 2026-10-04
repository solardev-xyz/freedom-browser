## October 4 update: partial-withdrawal receipt and TXID recovery primitives

Railgun now represents both sides of a partial withdrawal in its public recovery records: the amount sent out and the private change. Versioned intent/receipt/resolution records, exact receipt matching, source comparison and keyless TXID verification are implemented. This follows the real 01x02 proof/reconstruction milestone at `941099ff`; the complete wallet operation remains disabled until actual change ingestion, combined POI, restart and a second spend are connected and qualified.

Reviewed checkpoint: `48119f8662a0a830c5c3f27592d4772c54af6ee0`. Main remains `3b4f62df`, already merged with its explicit node refresh. This slice changes no dependencies, runtime archives, artifact/deployment pins, renderer/IPC or wallet/public/TXID derived-cache policy inputs. The prior cryptographic milestone's wallet-cache rebuild still applies. No funded profile, live RPC/POI query, transaction submission or PPv2 state change occurred.

### Implemented

- Partial public intents use version 2 and a separate journal digest domain, carrying both ordered commitments and gross withdrawal U without input/change values. Legacy canonical bytes and digests remain unchanged.
- Require exactly five receipt logs: Nullified, WETH recipient transfer, WETH treasury transfer, Unshield, Transact. Bind canonical encoding, transaction/block metadata, explicit removed:false, ordered distinct indices, payout conservation and the original change ciphertext. Zero fees and equal recipients still require two separate transfers.
- Check treasury against a named historical two-RPC observation, retain the policy ID in resolutions, and treat deviations as anomalies. This is consistency with a reviewed baseline, not authentication of state at inclusion. Future baseline revisions must preserve historical IDs or migrate records.
- Compare all three proxy events against the retained source prefix. WETH transfers are checked in the supplied RPC receipt; the proxy ledger does not authenticate them.
- Derive the selector from both ordered commitments. Match the capsule/receipt/TXID row, actual ordinary-output coordinates and gross unshield metadata; the isolated pinned engine verifies the path and final commitment's preimage. Main signing, operation, reservation, submission and POI admission remain closed.
- The encrypted public journal accepts the new format. A synthetic unresolved partial intent survives reopening byte-for-byte and keeps nonce/retry exclusion. This is generic journal coverage, not a completed partial wallet operation. Older builds may reject the entire EOA journal once v2 records exist.

### Evidence and remaining work

Four fresh offline native runs pass: partial selector 8 groups / 3,170 ms, partial TXID 10 / 2,620 ms, legacy selector 6 / 2,039 ms and legacy TXID 8 / 1,837 ms. Reports retain 41 selector or 40 verifier source hashes. Coherently wrong final preimages and reversed commitments get different selectors; their valid-path, structurally matching TXID cases are refused by actual engine verification. Coordinates, receipts and paths are synthetic; spend proofs/ciphertexts are dummy. These runs do not prove change ownership, spend-proof validity or chain/list acceptance. Partial fixture messages remain inside the unchanged 128 KiB limit.

All 1,546 targeted tests across 22 suites pass; lint is clean. The public-journal file was rechecked separately (17 tests, not counted twice). The preceding full 13,949-test regression belongs to `941099ff`, not this later source state. Claude reviewed the implementation, native evidence and bytecode event-order trace; this is engineering review, not an external security audit.

The six Kohaku compatibility runs at `941099ff` predate this slice's intent/receipt/resolution changes and were not rerun; legacy behavior here rests on targeted tests and the legacy selector/TXID natives.

Next: authenticate partial creators independently of the next operation's kind, scan the actual encrypted change, construct combined output/unshield POI with durable mixed-format recovery, then spend that recovered change after restart. Main partial admission stays closed until that connected qualification passes. Anchored deployed 01x02 checks, live service eligibility/disclosure permission and funded private Sepolia qualification, portable Host extraction, UX and release readiness remain open.

Audit details: [receipt and TXID milestone](https://github.com/solardev-xyz/freedom-browser/blob/48119f8662a0a830c5c3f27592d4772c54af6ee0/docs/railgun-partial-receipt-2026-10-04.md), [complete partial-withdrawal plan](https://github.com/solardev-xyz/freedom-browser/blob/48119f8662a0a830c5c3f27592d4772c54af6ee0/docs/railgun-partial-unshield-plan-2026-10-04.md). The preceding cryptography update is preserved [verbatim](https://github.com/solardev-xyz/freedom-browser/blob/48119f8662a0a830c5c3f27592d4772c54af6ee0/docs/privacy-progress-history-2026-10-04-partial-crypto.md); earlier history remains below.

---

