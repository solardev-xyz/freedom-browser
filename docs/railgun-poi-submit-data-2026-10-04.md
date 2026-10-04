# Canonical Railgun POI submission data — October 4, 2026

`railgun-poi-submit-data.js` builds and validates a bounded, immutable submission
envelope for the fixed Sepolia required-list POI service. It has no sender,
storage, proof verifier or permission capability. Payload and wire data remain
privacy-sensitive and belong in encrypted main-owned state.

The mapping follows the pinned
[wallet interface](https://github.com/Railgun-Community/wallet/blob/5c9d04c844879b8377d91775052e88c836b48730/src/services/poi/wallet-poi-node-interface.ts),
[request wrapper](https://github.com/Railgun-Community/wallet/blob/5c9d04c844879b8377d91775052e88c836b48730/src/services/poi/poi-node-request.ts)
and [shared schema](https://github.com/Railgun-Community/shared-models/blob/b37e643ef38e3df554deffa33f40530b20ce9065/src/models/proof-of-innocence.ts):
`ppoi_submit_transact_proof`, fixed chain/version/list fields and six
`transactProofData` fields. Local `proof` becomes `snarkProof`. Coordinates keep
snarkjs order, including `pi_b`; the Solidity swap is not used. Roots retain bare
32-byte hex, output commitments/unshield markers retain their prefixes, and the
transfer marker stays exactly `0x00`.

The JSON field order and numeric ID shape match the SDK wrapper. A future
controller must allocate the timestamp ID once when preparing the durable
attempt, then preserve it with the exact body. The serializer accepts a positive
safe integer; it does not establish when that value was generated or guarantee
global uniqueness. Headers, TLS and Tor behavior still distinguish this transport
from ordinary SDK clients. Matching these body fields is not an anonymity claim,
and live acceptance of the envelope remains unqualified.

The returned record contains version, fixed endpoint, request ID, normalized
payload and its SHA-256, exact JSON body and its SHA-256. Body size is capped at
18 KiB and the serialized record at 40,000 bytes. Restoring a record reconstructs
the expected body and compares every field. Altered methods, endpoints, chain or
list identifiers, proof order, IDs, added fields and even reformatted body
whitespace refuse, including when the caller recomputes the body digest.

Those digests establish internal consistency only. A wholly rebuilt envelope
containing another structurally valid payload can normalize. The future durable
store and handoff must separately bind the payload to the genuine local proof,
account and operation, revalidate after restart and retain attempted-state
uncertainty. No automatic retries or SDK endpoint fallback loop are introduced.

## Validation

All 76 focused tests across the new data module and existing payload/proof-data
suites pass, including 33 new envelope tests. Golden transfer/unshield body hashes
pin canonical bytes with asymmetric `pi_b` coordinates. JSON persistence round
trips, immutable detached data, malformed input, size limits, digest and wire
mutations, and digest agreement with the actual proof/checks payload binder are
covered. A zero-point proof deliberately normalizes, demonstrating that this
module does not verify proofs or authorize disclosure.

These are data-format and persistence-serialization tests, not an encrypted-store
restart, native-process run, sender or live service test. The 10,255-test full
regression and native reports from the preceding checks milestone predate this
new, unconnected data module. Store ownership, attempt persistence, authorized
handoff and uncertain-response recovery remain the next steps.
