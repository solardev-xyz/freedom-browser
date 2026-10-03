# Railgun POI creator-source capture — October 4, 2026

The main-only collector derives a tree, position and expected note hash from a
normalized capsule, then finds the corresponding Shield or Transact event during
a complete source-prefix visit. It checks ordered metadata, canonical ABI encoding,
batch-array alignment and commitment-range continuity through the checkpoint's
final tree lengths. Exactly the selected offset supplies its preimage/ciphertext.
The result is detached, frozen private data, including the event origin and digest;
none of those associations belongs in operational reports.

Shield values are already net of fees. This bounded path requires WETH and the
capsule's amount, but does not assume today's fee schedule applied historically.
The Shield note hash still needs cryptographic comparison in the viewing/keyless
utility. A Transact event supplies a hash that main compares directly. Extraction
of a Transact creator does not enable Transact-input POI reconstruction or replace
creating-TXID provenance. The helper ignores unrelated event topics; the genuine
public coordinator retains responsibility for the full pinned event/projector gate.

`captureRailgunPoiCreator` wraps this extraction in a genuine enrolled public
snapshot. Only after the full visit, refresh and final snapshot assertion succeed
does it issue an opaque source-only receipt. Semantic refusal and local cancellation
drain the visit and preserve a healthy coordinator; actual integrity failures close
it. Receipts are bound to enrollment, coordinator, generation, source and lifetime.
They authenticate retained bytes, not the supplied capsule, ownership, current
canonicality, membership, spending or disclosure. No key, dependency, policy,
renderer/IPC or top-level responsibility changes.

**Composition constraint:** taking another snapshot invalidates this receipt.
Separate creator and own-transaction captures cannot both remain current. The
next controller prerequisite is a combined visit with one source receipt, followed
by account/root reattestation. The collector is not a chain-completeness verifier.

## Evidence

Actual disposable enrollment, encrypted source/public stores and the production
coordinator pass six scenarios for [Shield](qualification/railgun-poi-creator-shield-2026-10-04.json)
and [Transact](qualification/railgun-poi-creator-transact-2026-10-04.json): capture,
later-snapshot revocation, semantic refusal followed by recovery, mid-visit
cancellation followed by recovery, injected post-visit integrity failure, and
store reopening within the same process with identical private extraction. Each selects offset one from
a batch with distinct ciphertexts; a later commitment also tests final coverage.
All exact payload comparisons stay in memory. Reports expose booleans/counts only.

Each report matches 138 source hashes. Shield takes 1,832 ms and Transact 1,957 ms;
each records seven completed source visits, 94 simulated block requests and two
simulated log requests, with zero external transport attempts or submissions.
The history and ciphertext are structural synthetic fixtures, not decryptable
owned notes or proof of membership. The first Shield attempt was rejected before
capture because its fixture batch arrays had inconsistent lengths; the corrected
runs above are the qualified evidence.

Claude approved production and native evidence; Codex approved the corrected
test and both native reports. Seventy-nine tests across four suites pass, with clean lint. The capture-exclusion
test uses a fresh competing signal after cancellation, then verifies a new capture
can enter only after the earlier one drains. The prior 9,559-test full regression
predates the separate verifier and these creator modules. Funded owned-note
queries and private spending remain outstanding.
