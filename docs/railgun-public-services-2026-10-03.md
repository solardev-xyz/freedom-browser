# Railgun public sources and TXID omissions — October 3, 2026

Railgun's public service client now reads bounded Sepolia TXID pages and POI
checkpoints through managed Tor. The fixed indexer and POI endpoints use separate
service contexts with the fixed public-sync principal; account contexts cannot use
this client. Parent revocation, Tor replacement, invalid responses or transport
failure close it. It serializes requests, bounds replies to 1 MiB and pages to 100
rows, checks exact schemas, and freezes normalized V2 records. Its `validateTxidRoot` method accepts only a bounded tree/index and field-element
root and requires an exact boolean service reply. It exposes no wallet filters,
proof submission, signing or broadcasting.

Main owns this boundary because it owns transport lifetimes and input validation.
The guarded engine receives captured public rows only. This does not move
responsibilities to the renderer, change dependencies or enable product UI.

## What the live sources established

The [official engine guide](https://docs.railgun.org/developer-guide/wallet/getting-started/5.-start-the-railgun-privacy-engine)
currently names `https://ppoi.fdi.network` as a community aggregator. Its public
status includes Ethereum Sepolia. Health, checkpoint and indexer requests passed
through bundled Arti without account data. The previously referenced
`ppoi-agg.horsewithsixlegs.xyz` did not resolve during this investigation.

The deployed aggregator returns `validatedTxidMerkleroot`; the inspected public
[node source](https://github.com/Railgun-Community/private-proof-of-innocence/blob/4b1eaf6ef19099dbfd6b43b1ca78d2ce0132a752/packages/node/src/railgun-txids/railgun-txid-merkletree-manager.ts)
and pinned wallet SDK instead return/type `validatedMerkleroot`. We cannot establish
the deployed implementation from that public source. The parser accepts either
exact shape and rejects ambiguous aliases. The service remains an unverified
third party; documented provenance is not an audit of its deployment.

Captured pages contain 4,230 transactions through block 11,832,810. The guarded
packed engine recomputes the exact POI checkpoint root at index 4,229:
`17a4f2743ea1be1c9560f9c4ac55030916860d9c2784b0cf3df58cfef637e7da`.
However, the indexer's verification-hash chain breaks once at index 4,188.
**Root agreement does not establish complete chain history.**

[The final public capture](qualification/railgun-public-services-2026-10-03.json)
also records the node accepting the independently computed root at index 4,187,
immediately before the break, and at index 4,229. The 43 public page files remain
local and are bound by hashes in that report. The [pre-break reconstruction](qualification/railgun-txid-prebreak-root-2026-10-03.json)
is its root-validation input; [recomputation against the final capture](qualification/railgun-txid-tree-2026-10-03.json)
reproduces the same result. Both tree reports explicitly record `passed: false`
and `globalTxidCompleteness: false` because the hash chain is incomplete.

[The independent RPC-event comparison](qualification/railgun-txid-history-2026-10-03.json) covers 4,214 indexed rows through archived
anchor 11,829,346; 16 newer rows remain outside that comparison. All compared rows
match the checked nullifier groups, inserted commitments and positions, and
unshield recipient/token/amount-plus-fee. The reverse comparison finds one omitted
nullifier group and two omitted inserted commitments, with no omitted unshields.
These are agreements and discrepancies between services and header-checked but
unverified RPC data, not chain proofs.

## The concrete omission

At block **11,816,741**, Ethereum transaction
`0x4b78372a9f06a8ab7ccb8a02373d279fc385515139c6ef157d2fe79ee147e932`
contains two Railgun calls. The indexed stream omits the first call and retains the
second. The verification hash still accounts for the first. The missing Nullified
log has index 98, three nullifiers, and first nullifier
`0x0e751f51883b1120214ad87f5307782e32f7098f0bd71f2f8bfdd478065b0089`.
Its two inserted commitments occupy UTXO positions 10,136–10,137.

At stream index 4,188, the hash derived without that call is
`0xfbd11184128f1161139df47f15f76a22a3c64dd6fb8dc656421d7133fce42b0a`;
the declared hash is
`0x39dc4b897e3739eb2793437d1e272514314e08dc9e494d859da6a058d005ada8`.
The chain is consistent again after this row. Claude independently decoded the
archived transaction and reproduced the finding.

The full-tree and reverse-history qualifiers therefore exit nonzero and explicitly
withhold completeness/readiness. We preserve the service tree as supplied. Inserting
the omitted row locally would change its root and invalidate membership against the
service's actual tree. No general exception for mismatches has been added.

V2 also permits an unshield-only row to carry an ordinary batch position when its
Ethereum transaction inserts other commitments. Examples at blocks 9,084,211 and
9,084,221 use positions 1,448 and 1,449. A call inserting nothing uses the reserved
99999/99999 pair. The parser permits this pair only for an unshield-only row; it
does not rewrite ordinary positions. The offline comparison checks such ordinary
zero-output positions lie within a same-tree batch range, not their exact cumulative
offset. It does not check calldata-bound parameters or recompute unshield commitment
hashes. Offline ABI decoding uses app ethers 6.17; production jobs use packed 6.14.3.

## Gates for the remaining operation work

The omission affects notes whose provenance requires the missing transaction. It
need not prevent controlled operations involving unrelated notes, provided the
following predicates are implemented and qualified. These are a design reviewed
with Claude, **not capabilities granted by the current client**:

- **P0 — service tree:** mirror a root that matches the node, with exact recorded
  omission evidence and `globalTxidCompleteness: false`. Any new, unqualified
  discrepancy stops synchronization. Never infer TXID positions from canonical
  transaction counts or repair the node's tree locally.
- **P1 — owned note:** decrypt the note, match its commitment and position in the
  RPC-derived public tree, and check its nullifier against that public scan.
- **P2 — Transact provenance:** locate the creating row by content, match its public
  events and prove its leaf's membership under an accepted TXID root. Missing
  provenance prevents using the affected note; no status string overrides this.
- **P3 — list membership:** require local verification of blinded-commitment
  inclusion proofs for every required POI list against accepted roots. These later
  account-linked requests need separate account contexts.
- **P4 — spend:** every input satisfies the note/list predicates, and the
  pre-transaction POI proof is generated and verified against pinned artifacts.
  Require this even for a controlled self-broadcast. This is wallet policy; the
  V2 on-chain transaction verifier does not itself enforce POI.
- **P5 — resulting outputs:** require our transaction to appear correctly in the
  service tree, submit its post-transaction POI proof, and withhold dependent spends
  while inclusion or POI is unresolved. Our own test transaction should contain
  only one Railgun `transact()` call. Missing inclusion is durable uncertainty,
  not permission to retry the transaction.

No Railgun funds have moved. Complete live RPC acquisition, durable TXID/POI state,
per-note predicates, operation-bound construction/proofs/signing, reservations,
submission/reconciliation and funded shield/transfer/unshield remain open.

## Acquisition and test evidence

The source scanner now groups up to eight header tasks, aborts on first failure
and drains every in-flight task before returning. Canonical boundary reads are
concurrent and deduplicated; the before/after checks remain separate. The existing
transport still permits only two sockets per context: eight queued tasks is not
eight active connections. All event headers must validate before ledger staging;
range/deadline/evidence-age limits remain unchanged. There is no automatic retry or
direct fallback.

[A separate disposable Railgun profile completed 65 live ranges](qualification/railgun-live-deployment-ranges-2026-10-03.json)
through block 5,859,999. It opened a fresh public generation because the scanner
source change altered the public data policy. Run `c` continues the full scan from
that persisted active generation; at this documentation checkpoint it is beyond
9.2 million blocks, not yet complete. [The actual-engine recovery series](qualification/railgun-source-concurrency-2026-10-03.json)
also passes with the concurrent source. The
original funded PPv2 profile remains untouched by Railgun qualifications.

The Node service qualifier uses a dedicated bundled Arti process and explicitly
recorded qualification-only Tor-manager/settings shims. It does not qualify
Electron's manager or account lifecycle. Captures contain public chain data only.
The tree calculation runs in the actual guarded Electron utility using the pinned
engine archive with no account keys, network or storage capability.

The native regression initially exposed a Tor test assuming port 19150 was free
while the live scanner occupied it. The test now compares its wallet endpoint with
the port written to its own managed Arti configuration, preserving crash/revocation
assertions. This changes test setup expectations, not production Tor behavior.

Validation: 7,970 full native regression tests pass, 33 skipped (OpenLV excluded),
plus 24 public-service tests and 53 scanner/coordinator tests. Lint passes. Claude
reviewed the code, qualifier boundaries, historical batch cases and omission.
Earlier failed captures remain retained: one exposed the now-corrected sentinel
assumption, and a later attempt refused its first indexer response without a
specific classified cause. A fresh explicit read-only run succeeded; no automatic
fallback or resubmission occurred.
