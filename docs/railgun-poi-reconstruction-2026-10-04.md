# Railgun offline POI note reconstruction — October 4, 2026

`reconstructRailgunPoiNotes` rebuilds viewing-tier private inputs for a bounded
Shield-input operation after submission. It decrypts the supplied Shield creator,
checks its net event value, note public key, commitment and nullifier against the
exact capsule, then decrypts the self-transfer output or checks the full-unshield
commitment. It derives no new transaction or randomness and needs no wallet scan.
The earlier spending reconstruction still refuses spent inputs without exception.

This utility-only module acquires no keys and grants no authority. It copies the
caller-owned viewing key before awaiting engine initialization, bounds and detaches
public inputs, checks the full viewing identity, and wipes its working key and
symmetric keys on completion or failure. Returned randoms, values, nullifying key
and output preimages are private witness data that must stay inside the utility.
Immutable JavaScript secrets and engine temporaries are contained by process exit,
not guaranteed memory erasure. This module has no production caller yet; the
fixture is its only consumer. No wallet/TXID policy, binary-key allowlist, dependency,
IPC or renderer changed. Its location preserves existing wallet ownership; a new
controller/key-release surface is deferred until its separate gates are ready.

## Native qualification

The [redacted native report](qualification/railgun-poi-reconstruction-2026-10-04.json)
records fourteen fresh utility processes with twenty matching source hashes. Each
uses production hardened derivation from the public test mnemonic, the pinned
engine ASAR, pinned serial prover and authenticated 01x01/POI_3x3 artifacts. Each
first creates and verifies a real synthetic transaction proof, compares reconstructed
secrets against the original transaction witness, and checks six reconstruction
refusals: position, net value, note hash, viewing key, identity and ciphertext.

Two intended POI proofs verify. Ten fault cases fail with the recognized SDK
cause chain ending in a witness-calculator assertion: wrong randomness, nullifying
key, output public key or nonzero unshield marker, TXID root, and list root.
Each is the first POI proving call in its own process, excluding proof-cache reuse.
Verification-only controls also reject altered list roots and blinded outputs.
Both synthetic paths use index five and sixteen nonzero siblings; input position
is 10,245 and transfer output position is an unrelated 23,456. These are synthetic
paths, not a production TXID projection or authenticated membership handoff.

The host bounds result messages to 16 KiB, validates their exact schema and selects
only counts, booleans, fixed case labels, timing and memory measurements for the
report. It waits for every utility exit. All runs have zero guard attempts, live
queries and submissions. The fixture owns disposable test secrets and performs
preparation and reconstruction in the same process per case; it does not qualify
a production viewing-key release or a cold account restart.

Four unit tests cover cancellation before/after asynchronous work, caller mutation,
working-copy erasure and pre-engine size refusal. These and the existing capsule
and preparation suites pass 48 tests; lint is clean. Claude approved the utility
reconstruction boundary; Codex approved the tests, final native evidence and
prose. The fourteen runs total 46,458 ms; intended transfer/unshield timings and
peak memory are recorded per case. The prior 9,514-test full
regression predates this new module. Native timing and memory figures are in the
report and do not establish Tor performance or deployed node acceptance.

## Artifact behavior: the unshield marker is optional

Two additional characterization cases both produce valid POI proofs with the
pinned artifacts: a transfer carrying its own TXID as an unshield marker, and a
full unshield carrying zero. Their report entries explicitly mark the marker as
not matching the operation's derived kind. A wrong nonzero marker rejects.

These observations show why proof validity alone cannot enforce our intended exit
semantics. They do not establish acceptance by a deployed POI node. The production
input/payload builder must derive the marker from the authenticated transaction:
exactly its TXID for full unshield, zero for transfer. It must also compare the
proof's public signals with that derived payload. This application gate remains
to be implemented; the characterization does not claim it already refused either
case. We have not inspected the circuit source, so this report describes observed
compiled-artifact behavior rather than asserting the precise source constraint.

## Remaining work

Compose production POI inputs from the reconstructed notes, checked own-TXID row
and path, and ordered input membership, deriving the output positions and marker
internally. Then add authenticated Shield/Transact creator capture, viewing-only
key handoff, independently verified public payloads and fresh disclosure gates.
Real membership, node acceptance and proof submission remain unqualified. The
funded note and the pending owned-note disclosure authorization are unchanged.
