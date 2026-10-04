# Railgun partial withdrawal: receipt and TXID recovery primitives

October 4, 2026. This follows the [real partial proof and reconstruction
milestone](railgun-partial-crypto-2026-10-04.md) at `941099ff`. Public intent,
receipt/resolution, source comparison and keyless TXID verification now represent
both the withdrawal and its private change. Main partial signing and submission
remain closed pending the complete change-ingestion/POI/restart/second-spend flow.

## Exact public outcome

The new public intent uses version 2 and a separate journal digest domain. It
binds ordered change/unshield commitments and gross `unshieldAmount`; input and
change values stay out of the public journal. Legacy intent and resolution bytes
remain unchanged, including property ordering and digest domains.

Partial receipt matching requires exactly five logs in order: proxy Nullified,
WETH recipient Transfer, WETH treasury Transfer, proxy Unshield, proxy Transact.
Every log must have canonical encoding, matching transaction/block metadata,
explicit `removed: false` and a distinct increasing index. The change event must
contain exactly the first commitment and original ciphertext; the final unshield
commitment is never inserted as a UTXO leaf. Net received plus fee must equal the
public gross withdrawal. Both token transfers are required even for a zero fee
or when recipient equals treasury.

The [captured bytecode analysis](railgun-partial-receipt-bytecode-2026-10-04.md)
and retained [raw capture](qualification/railgun-public-contract-bytecodes-2026-10-04.json)
support this bounded event policy. They are static inspection, not EVM execution,
canonical inclusion or a source-recompilation equivalence claim.

The named `railgun-sepolia-partial-receipt-v1` policy requires the treasury from
the historical October 2 two-RPC deployment observation at block 11829346.
Matched resolutions retain that policy ID and destination. A different treasury
is an anomaly requiring separate review; the baseline is not authenticated state
at receipt inclusion and does not alter runtime/deployment pins. Fee conservation
is mandatory; deviation from the historical 25 bps is recorded separately.

The source comparator matches only the three proxy events against the complete
retained source prefix. Its two WETH transfer checks come from the supplied RPC
receipt, not from the proxy ledger. A match grants neither finality nor balance,
ownership, POI, retry or spending authority. Visibility of a decrypted change
note alone must not make it eligible for the later second spend.

## TXID and compatibility

The partial selector uses a version-2 binding domain and an explicit utility
input tag. It hashes both ordered commitments with the nullifier and bound
parameters. The own-TXID matcher joins the exact capsule, intent, receipt,
resolution and row; change coordinates are ordinary tree/position coordinates,
while the final unshield preimage separately binds recipient, WETH and gross U.
The isolated engine verifies the TXID path and hashes that final preimage at
commitment index one. The host requires an affirmative unshield-verification
result for partial and full withdrawals. Legacy transfer/full-unshield results
remain byte-compatible.

The first native partial-TXID run exposed a remaining full-only host result
expectation. Its [refusal report](qualification/railgun-partial-own-txid-initial-refusal-2026-10-04.json)
is retained. The fixed host has positive and false-result refusal tests for both
withdrawal shapes, followed by fresh passing native runs.

Public journal readers now understand partial v2 records. Older readers can
reject the entire shared EOA journal once it contains such a record; this is an
explicit downgrade limitation. Main operation admission is still closed, so this
does not claim a genuine completed partial wallet operation has been journaled.
The generic encrypted journal's synthetic unresolved v2 intent survives reopening
byte-for-byte, remains immutable and blocks nonce reuse or a second attempt.
Future receipt-policy revisions need a historical-ID registry or explicit
migration; simply changing the current baseline would invalidate old resolutions.

## Qualification

The [native index](qualification/railgun-partial-receipt-native-2026-10-04.json)
links complete byte-exact reports:

| Run                       | Groups |     Time | Source hashes |
| ------------------------- | -----: | -------: | ------------: |
| Partial selector          |      8 | 3,170 ms |            41 |
| Partial TXID verification |     10 | 2,620 ms |            40 |
| Legacy selector           |      6 | 2,039 ms |            41 |
| Legacy TXID verification  |      8 | 1,837 ms |            40 |

Partial fixtures cover active/archive records, zero fee, equal recipient/treasury,
wrong final preimage and reversed commitments. Every fixture path is verified
with the pinned engine before host admission. Mutated commitments produce a
different selector; the selector does not validate their meaning. The TXID
verifier rejects wrong final preimages and reversed commitments after structural
matching and genuine path construction. Additional path/row mutations refuse.
All utilities are drained and exit observations awaited.

These are real engine hashing/path checks over synthetic receipts, coordinates
(tree 1, position 123), commitments and paths. The fixture proof/ciphertext are
dummy data: no spend-proof validity, change ownership, authenticated chain/list
state or funded operation is claimed. The earlier cryptography milestone remains
separate evidence. Partial fixture messages are 129,854 bytes, within the unchanged
131,072-byte limit; production message limits are unchanged.

The targeted regression passes **1,546 tests across 22 suites**: 922 across 19
receipt/operation suites, plus 624 across three journal/retained-consumer suites.
The final public-journal test file was rechecked separately (17 tests), without
counting those tests twice. Lint is clean. The full 13,949-test regression belongs to
the preceding `941099ff` milestone, not this later source state.

The six Kohaku compatibility runs at `941099ff` predate this slice's intent/receipt/resolution changes and were not rerun; legacy behavior here rests on targeted tests and the legacy selector/TXID natives.

## Remaining work

Authenticate partial creators independently of the next operation's kind, ingest
and scan the actual encrypted change, generate the combined output/unshield POI,
retain and recover mixed-format evidence, then fully withdraw the recovered
change after restart. POI cold validation must adopt the same partial selector
domain; today it still refuses partial operations. Reservations, identity,
account/staging/operation and submission admission stay closed until the complete
connected qualification passes. Anchored deployed 01x02 verification and live
service eligibility/funded Sepolia qualification remain separate requirements.

Main `3b4f62df` remains merged after a fresh fetch, with its explicit node refresh
current. No dependency, runtime archive, artifact pin, renderer or IPC changes
are involved. Wallet/public/TXID derived-cache policy inputs are unchanged by
this receipt/TXID slice; the prior cryptographic slice still requires its documented
wallet-cache rebuild.
