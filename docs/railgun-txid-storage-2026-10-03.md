# Railgun TXID projection and encrypted storage, 2026-10-03

The host can now reconstruct the public service's TXID tree, persist its rows and
Merkle nodes through an encrypted storage worker, and produce locally checked
membership paths using the pinned Railgun engine. This is computation and storage
infrastructure. It does not yet authorize a wallet note, POI eligibility or spend.

The projector processes at most 100 normalized rows / 1 MiB per page. It checks
ordering, duplicate TXIDs, exact row shapes, field bounds, verification-hash
continuity and the investigated service omission. It retains rows, row-content
hashes, TXID lookups, tree nodes, a frontier and a cumulative transcript. A witness
recomputes the row's transaction hash and its entire depth-16 Merkle path.

The omission exception is the exact eight-field occurrence investigated in
[the public-service research](railgun-public-services-2026-10-03.md), including the
root immediately before it. Any changed or additional break refuses. A stream
past index 4,188 without that break also refuses: a service repair/reindex needs
fresh qualification. The classifier never repairs the service's tree or grants
global completeness. Omitted outputs at UTXO positions 10,136–10,137 remain
explicitly recorded and cannot be inferred eligible from a matching service root.

The guarded job has separate inspect, project, apply and witness modes. The main
runner requires a genuine storage worker for the exact `txid.sqlite` path and
binding. It owns exclusive dispatch: non-apply modes may only read, while apply
may also use the transaction API. It restricts all keys to the TXID namespace,
permits puts through that API only, and rejects a result while a transaction remains open. Each receipt binds
the input, mode, runner lifetime, store revision and a 60-second freshness window.
It remains a local computation observation, not a POI-node attestation.

Apply requires stored state to equal the supplied base, checks again immediately
before staging under exclusive dispatch, and commits every page write together. If a
crash left the expected state already committed, replay checks every page row's
content, position and membership, then recomputes the page from its supplied base
to bind the frontier, cursor, continuity and transcript. Any other state refuses.

Actual-engine evidence:

- [Projection and paths](qualification/railgun-txid-projection-2026-10-03.json):
  4,230 captured rows reproduce root
  `17a4f2743ea1be1c9560f9c4ac55030916860d9c2784b0cf3df58cfef637e7da`.
  The engine's independent proof verifier accepts paths at indices 0, 4,187,
  4,188 and 4,229. Page replay, fresh projection instances and corrupt-root
  refusal are exercised with zero guard violations.
- [Encrypted storage](qualification/railgun-txid-storage-2026-10-03.json):
  all 43 captured pages run through actual guarded project/apply jobs and the
  encrypted worker. The 16,932-record, 6.3 MB logical store survives cold worker
  reopen with an identical digest, root and transcript. Recovery after an applied
  page checks replay and refuses old receipts. Wrong expected roots and altered
  replay bases refuse without changing the store. The SQLite file does not
  contain the sampled public row's graph ID in plaintext.

The report's `wallet-store-v1` digest schema is the existing shared whole-store
observer's label; this file is the dedicated TXID store.

The durable job currently caps the mirror at **8,000 leaves**, below the shared
whole-store observer's 32,768-record limit. Sync refuses at that boundary; funded
operations will need an explicit headroom check for their post-transaction POI
work. The pure projector supports one 65,536-leaf tree, but that does not widen
the durable limit. A future packed-record format or separate reviewed observer
is needed to lift it. Multi-tree history remains unqualified.

Still required before consuming these witnesses: an encrypted host journal and
enrolled public-generation binding; exclusive TXID/wallet phases within the
three-worker limit; fresh POI-node root validation; comparison against independently
acquired public events; per-owned-note and required-list POI checks; intent-bound
proofs/signing and recoverable funded operations. The qualification uses captured
public rows and a synthetic storage key, not an enrolled wallet's TXID database.
Neither fixture performs live root validation or establishes global history
completeness. Replacing an entire store and its authenticated journal together is
outside the existing local rollback guarantees.

Claude reviewed the implementation and qualification semantics. This engineering
review is not a security audit. Thirty-six focused tests and lint pass; the full
native suite passes 8,018 tests / 33 skipped across 384 passing suites. No
dependencies were changed and no Railgun funds have moved.
