# Railgun wallet snapshots — October 2, 2026

A guarded Electron wallet job can now read a completed public checkpoint while
writing decrypted notes to a separate encrypted cache. The public store remains
read-only. This is development infrastructure with public test viewing material,
not product balances, a durable wallet-coverage grant or a funded Railgun run.

## Qualified behavior

[Full-history evidence](qualification/railgun-wallet-snapshot-2026-10-02.json)
records a scan of all 10,194 commitments in the previously qualified Sepolia
capture, followed by a fresh wallet utility and derived-store worker reopening
that cache. Both runs scan the complete public history and validate the recovered
record sets. No received/sent records are accepted for this public viewing vector. Seventy
Transact ciphertexts authenticate only in the sent direction but do not match
their public commitments. They are recorded separately as unrecoverable sent
history, with zero receive-note quarantine entries. A [differential check](qualification/railgun-transact-classification-2026-10-02.json)
compares every one with the pinned SDK: its reconstructed hashes equal the
preflight hashes, all differ from their commitments, and its own unguarded
`scanLeaves` emits zero record writes to an isolated in-memory sink. None
authenticates in the receive direction. Sixty-nine annotations do not decode;
one decodes with a sender random. This establishes agreement with this pinned
SDK, not the origin or intent of those ciphertexts. The report records positions, transaction ids and boolean outcomes; it excludes
decrypted key material, amounts, tokens and memo contents. These history runs
qualify traversal, classification and isolation, not real-user discovery.
They take 2.529 and 2.409 seconds on this macOS arm64/Electron 44.4.5 runtime,
with ten public header requests per window. Maximum sampled utility RSS is about
170.5 MiB; that excludes main and the three storage workers.

[Positive synthetic evidence](qualification/railgun-wallet-synthetic-2026-10-02.json)
uses [public-vector events](qualification/railgun-wallet-synthetic-source-2026-10-02.json)
through the real source ledger, independent planner, coordinator, public engine
apply and guarded wallet utility. Six successful windows cover:

- Two received notes with values 1,000 and 2,000, then cold-cache restoration.
- A public nullifier for the first note, leaving an observed unspent total of 2,000,
  including after reopening the cache.
- A self-transfer of 700, found in both received and sent sets, and another reopen.

These are synthetic event semantics, not validated transactions or a demonstration
of value conservation. The final observed unspent total is 2,700 in this fixture.
No amount is classified spendable. The next public apply invalidates the previous
snapshot evidence.

Two additional cases terminate the utility after the first acknowledged derived
batch (the wallet history marker), then refuse cold restoration of that incomplete
cache. The supervisor observes exit in both cases. Reopening the coordinator and
rescanning rebuilds the cache before later windows succeed. The termination is a
controlled process close, not a SIGKILL or a power-loss test. Received-note batches
are not individually crash-injected here.

All successful wallet jobs record zero direct-egress guard attempts and zero POI
calls. No wallet RPC, prover, signer or transaction submission is granted.

## Authority and storage

`withPublicSnapshot` exclusively owns the public store's dispatch window. It
requires a scanned journal checkpoint, refreshes public headers and checks store
freshness before running. Only get/getMany and bounded cursor operations are
allowed. It drains reads, revokes the window and rechecks headers and the complete
public-state digest before returning opaque evidence. Open cursors, forbidden or
late requests, profile lock, source failure and deadline expiry refuse completion.
Any subsequent snapshot, recover, public apply or store dispatch invalidates the
previous evidence. Evidence also expires with its source observation.

The two database objects are attached separately to the pinned engine's wallet
and UTXO tree. Main restricts public reads to that tree's namespace and derived
reads/writes to this wallet's receive/sent namespaces. Only puts are allowed on the
derived write channel. The utility verifies both granted prefix sets against the
pinned SDK's own path functions, including its unusual sent-prefix truncation.
No NFT cache, global namespace, transaction-control command or RPC is exposed.

Token preimages come from Shield records in the checked public snapshot. Its
canonical digest covers those token fields. A source-only resolver replaces the
SDK getter before scanning; its identity is checked after attachment, scanning
and received/sent enumeration. Wallet construction uses `createWallet`, which
does not persist the shareable viewing key. The cache contains derived records;
this qualification uses only the already-public upstream viewing vector.

The bounded worker limit is now three: source ledger, public engine store and
derived wallet store. A fourth or duplicate owner is refused. No top-level package
boundary, renderer flow, public IPC or dependency changes are introduced.

## Limits and next work

This is a two-pass full rescan at Sepolia scale. It recomputes cumulative expected
received/sent sets and quarantine positions from the checkpoint on each run. The
sets are not yet committed in a main-owned durable coverage journal. A plain job
result is provisional and must only be used after synchronously checking its
snapshot evidence; no product API currently exposes it.

Rescanning rewrites received records, including their POI metadata. TXOs recomputes
spent status, but preserving separately qualified POI state needs an explicit design
before enabling POI. Any wallet failure currently closes the public coordinator as
well; reopening revalidates its checkpoint. More selective recovery can follow once
derived readiness is journaled. Imported/restored wallets start from the beginning.

Next: persist derived coverage and expected/quarantine sets against both store
identities and the public checkpoint; expose current-Kohaku read semantics through
that authority; qualify live source acquisition, artifacts, proofs, POI transport
and operation-bound recoverable shield/transfer/unshield. Fixed production entries,
packaging and other platforms remain open. No Railgun funds moved.

Claude reviewed the snapshot, dual-store boundary and SDK assumptions. This is
engineering review, not a security audit. The 73 focused boundary checks and 25 note-validation cases pass, as does lint;
the full regression passes 7,662 tests with 33 skipped across 358 passing suites.
