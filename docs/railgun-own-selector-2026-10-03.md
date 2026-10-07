# Railgun detached TXID selector — October 3, 2026

`deriveRailgunOwnSelector` extracts the one-input/one-output facts from submitted
calldata and derives its Railgun TXID in a guarded keyless utility using the pinned
engine. The bare field value selects a row in the existing mirror for both transfer
and unshield. It stays inside main-process wallet logic, out of public reports.
The input digest and domain-separated transaction binding cover the exact submitted
calldata. Only a bounded result message is accepted; every authority flag remains
false and the host waits for observed utility exit, including on cancellation.

Claude approved the boundary and lifecycle. Eighty-one related tests pass, including
wrong operation, non-1x1 and out-of-field inputs, pre-abort, unauthorized broker
methods, malformed/duplicate results, and cancellation drain. Lint is clean.

The [actual Electron qualification](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-own-selector-2026-10-03.json)
passes six scenarios in 1,843 ms with 38 matching source hashes. Four synthetic
calldata samples agree with the mirror's lookup keys; replacing proof bytes preserves
the TXID while changing the transaction binding and input digest. Malformed calldata
and a closed context refuse. The report contains booleans and counts, with no derived
TXID or binding digest. Codex reviewed the fixture and evidence; its suggested exact
sample inventory is asserted in this final run.

The wrong-preimage sample intentionally derives successfully: lookup-key derivation
does not verify an unshield preimage, proof or path. The archived sample supplies
calldata only and does not qualify archive authentication. Mirror agreement uses the
same pinned engine and establishes compatibility, not independent cryptographic
validation. No keys, storage requests, live queries or submissions occur. The last
full regression (9,403 tests) predates these new selector modules.

This adds main-process wallet computation without renderer, IPC, dependency or
architecture changes. TXID and wallet mirror policies are unchanged. Next is the
phase-separated existing-checkpoint lookup, followed by new recovery capture and
fresh source/root composition; no ongoing account or spending authority is returned.
