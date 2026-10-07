# Railgun local POI prover and canonical payload — October 4, 2026

`proveRailgunPoi` is a one-attempt utility function that assembles the private
witness internally, loads authenticated POI_3x3 artifacts and the pinned serial
prover, and returns only a canonical public payload. It requires a real prover
and verifier, compares every returned public input with the independently derived
expected value, and directly verifies the normalized proof against all eight
expected signals. A changed-root check must fail. The SDK's missing-verifier
fallback cannot satisfy this path.

The function rejects an initialized SDK debugger before and after proving, because
the SDK's error path can log witness inputs through that debugger. It requires no
live snarkjs curve workers and replaces errors with a fixed code. Artifact buffers
are wiped after work settles, including cancellation. The caller still owns the
original viewing key and must wipe it. Immutable witness values remain inside the
utility until exit. A fresh process is required: the module's one-attempt flag
does not police unrelated SDK callers or clear its process-wide proof cache.

`normalizeRailgunPoiPayload` accepts only the pinned list, one unpadded list root,
the TXID root/checkpoint index, zero or one blinded output, the derived operation
marker, and trimmed Groth16 proof coordinates. Roots/signals use the scalar field;
coordinates use the larger curve base field and canonical decimal strings. It
preserves snarkjs coordinate order. Empty-output/zero-marker and transfer/nonzero-
marker combinations refuse. The detached, frozen payload omits the transaction's
leaf index and all private witness fields. This potentially identifying payload
still belongs in private main/utility state until disclosure is authorized.

No production job, key broker or main controller calls the function yet. Its result
is `locallyVerified`, with independent verification and all source, membership,
root, disclosure and spending authority flags false. No dependency, policy,
renderer, IPC or top-level responsibility changed.

## Evidence

The [native report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-poi-prover-2026-10-04.json) records 37
matching source hashes. Transfer and full unshield complete in 6,593 ms and
6,378 ms. The utility-only production prover runs once per fresh fixture process;
a second attempt refuses. The fixture separately compares the payload with its
assembled expected data and verifies the proof directly. All eight individually
altered public signals refuse. Existing twelve assembly-refusal controls also
pass, with leaf five and root checkpoint six remaining distinct.

These are real proofs over public-test-mnemonic synthetic transactions and simulated
inclusion/list membership. All guard attempts, live queries and submissions are
zero. Report messages have bounded exact schemas; only selected redacted values
are written. Verification performed again in this fixture is still in the same
process, so it does not qualify the future independent verification process.

Forty-five tests across four related suites pass, including missing/vacuous
verifiers, debugger activation, malformed payloads, field distinctions, cancellation,
working-copy ownership and one-attempt refusal. Lint is clean. The frozen full
regression passes 9,559 tests / 33 skipped across 449 suites in 299.107 seconds
with native-process access and the existing OpenLV exclusion. Claude approved
implementation and native reports; Codex approved tests, fixtures, evidence and prose.

## Remaining

Add a fresh keyless verification process for the exact canonical public payload,
then compose authenticated creator/membership evidence, a viewing-only key handoff,
account/source/root reattestation and the final disclosure controller. Local proof
validity is insufficient for real membership, node acceptance, ownership or
permission to disclose. No funded owned-note query or private spend occurred.
