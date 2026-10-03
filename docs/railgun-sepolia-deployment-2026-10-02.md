# Railgun Sepolia deployment capture — October 2, 2026

[The read-only probe](../scripts/inspect-railgun-sepolia.js) captures candidate deployment state through Sentio and Tenderly over direct HTTPS. Both providers agree at finalized block **11,829,346**, hash `0xbac192ba1a044d54ba19764c6e48eadb0b6a46e0a7631d32fa3c3236cbcc7065`. Every code, storage and contract read uses EIP-1898 with that block hash and `requireCanonical: true`; both providers must still return that hash at the selected height afterward. This is corroborated RPC data, not a verified chain proof or a complete scan.

The [source-hashed report](qualification/railgun-sepolia-deployment-2026-10-02.json) records:

| Candidate | Address |
| --- | --- |
| Smart wallet proxy | `0xeCFCf3b4eC647c4Ca6D49108b311b7a7C9543fea` |
| Proxy implementation | `0x16dc2574cc30e4deecfb9ba22d95e5126a2fc0b3` |
| Relay Adapt | `0x7e3d929EbD5bDC84d02Bd3205c777578f33A214D` |
| Wrapped Sepolia ETH | `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14` |

The proxy is unpaused. Tree zero has **10,194 leaves**, with root `0x23bbe9f01d6f06e47cffa08b31836ea8ee26c48cb7f959ffd70a5840c7910098`; the last event block is 11,828,978. Shield and unshield fee getters each return raw value 25. Verification keys for 1×1, 1×2 and 2×2 are captured, with IC lengths 5, 6 and 7. These keys have **not yet been compared to authenticated circuit artifacts or derived from a pinned proving key**. The deployment-start candidate, block 5,784,866, also remains unverified. This report does not enroll or enable a deployment.

The ABI comes from the authenticated engine 9.6.0 fixture. Candidate network configuration is from shared-models commit `b37e643ef38e3df554deffa33f40530b20ce9065`. The proxy slot derivations were checked against [Proxy.sol at contract commit 36bcf5ed](https://github.com/Railgun-Privacy/contract/blob/36bcf5ed7cf94bfafb6e1a303e1832c769c16780/contracts/proxy/Proxy.sol). The recorded SHA-256 `619709609e7030ee551072221e837a6b905dcb58e152478cd7ddcc3ebac88c9c` was computed from that file in a local clone at that exact commit; it is a documented provenance constant, not a fresh source download performed by the probe. The report includes the three slot preimages and resulting storage positions.

An initial larger RPC batch received HTTP 429 and supplied no evidence. The final probe uses batches of at most four calls with one-second pacing between batches. HTTP failures, redirects, timeouts, malformed JSON-RPC, mismatched state and responses above 2 MiB fail the run; they never become missing/empty chain data. A successful capture does not qualify availability or throughput for historical scanning.

Claude accepted the corrected probe, canonical-anchor checks and capture-only scope. No identity, spending key, funds, proof or transaction submission was used. Next work must authenticate circuit artifacts, verify deployment compatibility, fetch and validate complete event ranges, recompute trees, and qualify wallet/nullifier/POI recovery before an operation can be prepared.
