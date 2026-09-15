# Colibri → Myotis checkpoint recovery spike

This standalone experiment demonstrates the **fresh-checkpoint recovery route**:
Colibri authenticates recent committee/checkpoint evidence, an explicitly selected
external checkpoint authority confirms the exact root is finalized, and Myotis
bootstraps a fresh store from that root. Ethereum and Gnosis both reached live
sync and advanced finalized state. Separate cold Colibri proofs then matched the
recovered Myotis beacon root, execution block hash, and execution state root at
the same execution height.

This does not accept an old store's committee lineage after one matching block.
It establishes a fresh trusted starting point. It also does not eliminate the
external weak-subjectivity trust source: that role belongs to the selected
checkpoint authority. Swarm distribution operated by Freedom is not necessary
for this route.

No Freedom application behavior, dependencies, native addon exports, or shipping
defaults change in this experiment. The Rust harness uses existing public
`ChainConfig.checkpoint_root` and `checkpoint_slot` fields. The Node addon does
not yet expose those fields.

## Tested versions and evidence

- Myotis v0.1.9, commit
  [`b3c1fd0ff2ebd6c1df593fca40a46c22fa506f4e`](https://github.com/biafra23/myotis/tree/b3c1fd0ff2ebd6c1df593fca40a46c22fa506f4e).
- Colibri npm 2.0.6, WASM runtime, source
  [`2fae243d57cc67cef1ba7ee2bef8390fcd22efd0`](https://github.com/corpus-core/colibri-stateless/tree/2fae243d57cc67cef1ba7ee2bef8390fcd22efd0).
- macOS arm64, Node 24.18.1, Rust 1.94.0; upstream locked Rust dependencies.
- Ethereum trust authority: `https://mainnet.checkpoint.sigp.io`.
- Gnosis trust authority: `https://checkpoint.gnosischain.com`.
- Provers: `https://mainnet1.colibri-proof.tech` and
  `https://gnosis.colibri-proof.tech`, respectively.

| Observation                                                         | Ethereum       | Gnosis         |
| ------------------------------------------------------------------- | -------------- | -------------- |
| Imported, independently authenticated finalized checkpoint slot     | 15,215,808     | 30,084,208     |
| Later Myotis finalized slot independently cross-checked             | 15,215,840     | 30,084,271     |
| Corresponding execution block                                       | 25,977,785     | 48,251,432     |
| Beacon slot/root and execution number/hash/state root match Colibri | Pass           | Pass           |
| Authentic August 9 checkpoint with default age guard                | `STALE_ANCHOR` | `STALE_ANCHOR` |
| Wrong checkpoint root supplied to Colibri                           | Rejected       | Rejected       |
| Selected checkpoint authority unavailable                           | Rejected       | Rejected       |

Restart results and final run summaries are recorded in `summary.json`.

Instrumentation note: the first fresh-run executable incorrectly required an
internal marker that is only set when catching up across periods. Its final
`synced: false` records that harness mistake, despite the logged native bootstrap,
`SYNCED` state, and subsequent finalized advancement. The condition was corrected;
the restart runs use the published harness and require an explicit
`qualified-live-advancement` event plus orderly shutdown. First-run evidence is
preserved with this explanation, not relabeled as a successful process exit.

`captures/` contains raw public proof bytes, checkpoint/finality responses, and
verification results. `native/` contains status observations and summaries without
peer addresses or the test machine's network address. Raw native stderr logs are
retained locally, not published. The captured extractor metadata field
`proofRequestLatestBlock` describes the original latest-block request, **not** the
execution payload of the older checkpoint header; the final comparison captures
contain the correctly matched native tuple.

The authentic stale root/slot pairs came from Myotis v0.1.7 commit
[`d53e4e2d6de29308fba398a2b28c3c070bbc426c`](https://github.com/biafra23/myotis/blob/d53e4e2d6de29308fba398a2b28c3c070bbc426c/rust/myotis-net/src/sync.rs).
Both 15-second controls remained blocked, with no finalized root or execution
state, and stopped orderly. The spike never invokes stale-anchor acceptance.

## Scripts

- `checkpoint.cjs`: obtain a fresh full-block proof; verify the exact bytes with
  a cold Colibri verifier; derive the checkpoint header root; require equality
  with the selected authority's slot/root response and explicit finalized root;
  enforce a one-hour maximum header age and no future finalized epoch; export
  root and the header's actual slot. The proof includes 512 committee public keys.
- `checkpoint_spike.rs`: start the real Myotis consensus networking engine using
  that root/slot and fresh storage, preserving default weak-subjectivity guards.
  Success requires initialized sync followed by a later finalized slot. A
  `--resume` mode accepts only a directory bearing the same spike chain/root/slot
  marker. It refuses symlink state files and mismatched markers.
- `compare.cjs`: obtain and locally verify a separate Colibri proof for an actual
  Myotis observation's exact execution height; compare both consensus and execution
  identifiers. This records agreement for that observation; it is not a production
  read-authorizing mechanism.

All trust lookups are restricted to the selected origin, redirects are refused,
and prover/beacon fallback for those lookups is disabled. Missing or mismatched
evidence produces no new checkpoint export. Output directories must be new.

## Reproduce

Use an isolated checkout of the pinned Myotis commit above, existing Freedom npm
dependencies, and Rust 1.94.0. Copy only the example into the upstream checkout;
no Cargo dependency changes are needed. Commands below run Gnosis; use chain ID
`1` and network `mainnet` for Ethereum.

```sh
SPIKE_DIR="$PWD/docs/audits/evidence/myotis-recovery-spike-2026-09"
SPIKE_RUN=$(mktemp -d)
MYOTIS_SOURCE=/absolute/path/to/pinned/myotis
cp "$SPIKE_DIR/checkpoint_spike.rs" "$MYOTIS_SOURCE/rust/myotis-net/examples/checkpoint_spike.rs"
cargo +1.94 build --locked --manifest-path "$MYOTIS_SOURCE/rust/Cargo.toml" -p myotis-net --example checkpoint_spike --target-dir "$SPIKE_RUN/build"

node "$SPIKE_DIR/checkpoint.cjs" 100 live "$SPIKE_RUN/colibri"
SPIKE_ROOT=$(node -p 'require(process.argv[1]).root' "$SPIKE_RUN/colibri/verified-checkpoint.json")
SPIKE_SLOT=$(node -p 'require(process.argv[1]).slot' "$SPIKE_RUN/colibri/verified-checkpoint.json")
"$SPIKE_RUN/build/debug/examples/checkpoint_spike" gnosis "$SPIKE_ROOT" "$SPIKE_SLOT" "$SPIKE_RUN/native" 600 > "$SPIKE_RUN/native.jsonl" 2> "$SPIKE_RUN/native.stderr.log"
node "$SPIKE_DIR/compare.cjs" 100 "$SPIKE_RUN/native.jsonl" "$SPIKE_RUN/comparison"

node "$SPIKE_DIR/checkpoint.cjs" 100 wrong-root "$SPIKE_RUN/wrong-root"
node "$SPIKE_DIR/checkpoint.cjs" 100 unavailable "$SPIKE_RUN/unavailable"
```

For the restart and native stale-anchor controls:

```sh
"$SPIKE_RUN/build/debug/examples/checkpoint_spike" gnosis "$SPIKE_ROOT" "$SPIKE_SLOT" "$SPIKE_RUN/native" 600 --resume > "$SPIKE_RUN/restart.jsonl" 2> "$SPIKE_RUN/restart.stderr.log"

SPIKE_OLD_ROOT=$(node -p 'require(process.argv[1]).gnosis.root' "$SPIKE_DIR/native/stale-checkpoints.json")
SPIKE_OLD_SLOT=$(node -p 'require(process.argv[1]).gnosis.slot' "$SPIKE_DIR/native/stale-checkpoints.json")
"$SPIKE_RUN/build/debug/examples/checkpoint_spike" gnosis "$SPIKE_OLD_ROOT" "$SPIKE_OLD_SLOT" "$SPIKE_RUN/stale-native" 15 > "$SPIKE_RUN/stale.jsonl" 2> "$SPIKE_RUN/stale.stderr.log"
```

The native stale control is expected to exit **1** after remaining in
`STALE_ANCHOR`; that expected refusal is the passing observation. For Ethereum,
select `.mainnet` from the stale-checkpoint file and use network `mainnet`.

Run each command only after the previous command succeeds. A finalized-root
change between proof acquisition and the authority query is an ordinary race:
the extractor refuses export; repeat with a new output directory. Do not interpret
that alone as an attack. Use fresh live evidence, not these aging captures, for a
new native bootstrap. An optional `COLIBRI_PACKAGE` selects an absolute path to
the exact installed 2.0.6 package when running the scripts outside this layout.

## What remains for a product integration

1. Expose checkpoint creation through the Myotis Node/host API, carrying the exact
   chain, root, and slot. The spike's raw-argument CLI is not a secure import API.
2. Bind successful verification to the active profile/run and handle replacement
   of stale state through a new store generation. Persist the authenticated
   checkpoint and define refresh behavior across restarts and extended absence.
3. Choose the product's checkpoint authority/witness policy, availability strategy,
   bounded retries, and user-visible behavior when recovery cannot complete.
4. Integrate and test Freedom's supervisor lifecycle and actual routed reads.
   This harness runs Myotis consensus networking and observes execution anchors;
   it does not start the execution peer pool or test wallet/account calls.

These are integration tasks after a successful feasibility spike. Long offline
periods, committee-period transitions, persisted-store resume, adversarial source
behavior beyond the listed controls, and production availability are not certified
by a short live run. Myotis v0.1.9 only persists/resumes a snapshot whose committee
period is newer than the imported checkpoint's period, so a same-period restart
can correctly rebootstrap rather than resume a stored committee.

The proof mechanism is documented in Colibri's
[SyncCommittee Proof](https://corpus-core.gitbook.io/specification-colibri-stateless/specifications/ethereum/proofs/synccommittee-proof)
and
[EthCheckpointProof](https://corpus-core.gitbook.io/specification-colibri-stateless/specifications/ethereum/proofs/consensus-layer-header-proof#ethcheckpointproof)
specifications. Finality in this bridge additionally relies on the selected
authority's explicit assertion; these endpoint responses do not expose an
`execution_optimistic` field, so the spike does not claim to verify that flag.
