# Railgun derived POI witness assembly — October 4, 2026

`prepareRailgunPoiWitness` derives the bounded 1×1 POI witness inside a viewing
utility. It copies bounded public inputs once, matches the capsule to supplied
transaction/journal/receipt/row data, verifies the exact TXID row and path with the
production projection, reconstructs the Shield input and output notes, and checks
one list proof against the derived blinded input commitment. This compares data;
it authenticates neither the caller nor the source of those observations.

Output positions come only from the compared row. The unshield marker comes only
from the matched output kind and the recomputed TXID. Caller marker, output-position
and list-key overrides refuse. The list key is pinned. The circuit inputs and all
eight expected public signals are assembled explicitly, including the engine's
correct padding. The converted TXID path is independently checked in its circuit
format. The selected leaf index and the root checkpoint index remain distinct.

The function returns private witness data for use inside that utility and expected
public inputs for later verification. It does not prove, release keys, export a
submission payload or disclose anything. All authority flags remain false. The
working key copy is wiped on failure/cancellation; errors are sanitized. Main-owned
wallet boundaries remain unchanged, and no wallet/TXID policy, dependency, renderer,
IPC or production key-release allowlist changed.

## Evidence

The [native report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-poi-witness-2026-10-04.json) has 33 matching
source hashes. Transfer and full unshield pass in 6,289 ms and 6,215 ms respectively.
Both use a real synthetic transaction proof and a seven-row production TXID
projection, selecting leaf five under checkpoint six. The simulated mined receipt
and journal resolution contain the actual fixture calldata and ciphertext. Input
membership remains synthetic; no enrollment or network is involved.

Each operation refuses twelve changes before its only POI proving call: caller
marker/position overrides, wrong list leaf/root, out-of-range list index, an extra
list proof, wrong output row/kind, wrong checkpoint index/path, capsule disagreement
and extra evidence. Repeating assembly with the identical supplied data returns
equal data; this is not authenticated account recapture.

The fixture proves the assembled witness and compares every returned public input
with the independently assembled expected value. It requires the pinned serial
runtime's verifier to exist, then verifies directly against the pinned vkey and
all eight expected signals. Changing any one signal makes verification fail.
This avoids relying on the engine's permissive fallback when its verifier is
absent. Both utilities exit before success is recorded, with zero guard attempts,
live requests or submissions. The host validates bounded exact results and writes
only selected redacted fields.

Nine new unit tests cover captured inputs, key-copy ownership and wiping after
cancellation, caller overrides, input limits and sanitized errors. Four related
suites pass 113 tests; lint is clean. Claude approved assembly and suggested the
added circuit-format path cross-check. Codex approved the tests and corrected the
fixture's repeated-assembly label. The earlier 9,514-test full regression predates
the new reconstruction/assembly modules.

## Remaining

Add guarded POI proving and strict public-payload verification that consume this
assembly, retaining the root checkpoint index for submission. Then compose
source-authenticated Shield/Transact creators, current membership evidence,
viewing-only key handoff, final account/root checks and explicit disclosure gates.
This slice enforces marker derivation during assembly; it does not yet enforce a
production proof-submission gate. Funded private operations remain unqualified,
and the owned-note disclosure authorization remains pending.
