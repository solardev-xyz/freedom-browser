# Railgun own-operation witness capture — October 3, 2026

`captureRailgunOwnWitness` joins a stored private operation to its existing TXID
mirror row without returning ongoing account, source, root, POI or spending
authority. It first captures the proved operation and derives its selector inside
one signing-recovery phase. The keyless utility exits before recovery is released;
receipt/capsule/journal reattestation follows derivation in the same window.

A separate checkpoint-only TXID phase inspects, selects and rechecks one fixed
checkpoint, then fully closes before a new recovery capture. Exact capsule,
submitted transaction, intent and stable account/journal bindings must agree across
phases. Representation-only archival is allowed. Main also checks the row's
Ethereum hash, block, input tree, nullifier, commitment, bound parameters and
transfer output position or full-value WETH unshield metadata. Transaction-index
binding, authenticated source coverage and detached cryptographic path verification
remain for the next composition.

These steps carry detached comparison data, with all authority flags false. They
do not exclude inter-phase activity or journal writers. Cancellation drains late
opens and utility/session closure; it never releases an in-flight phase early.
Behind checkpoints refuse before lookup; a full mirror can still supply a row it
already contains. A same-block lookup miss closes the per-use TXID session. Any
unresolved active EOA submission, including an unrelated ordinary send, prevents
capture. No mirror policy or existing phase-handoff API changes.

The selector has a two-second budget reserve for reattestation. Claude reviewed the
phase boundary and fixed an unnecessary repeated full-archive hashing cost before
qualification. The related six suites pass 110 tests, including changed captures,
metadata mismatch, checkpoint limits and cancellation drain. Lint is clean.

## Actual-store qualification

| Mode | Elapsed | Source hashes | Scenarios |
| --- | ---: | ---: | ---: |
| [Transfer](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-own-witness-transfer-2026-10-03.json) | 9,000 ms | 143 matched | 8 passed |
| [Unshield](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-own-witness-unshield-2026-10-03.json) | 8,947 ms | 143 matched | 8 passed |

Both runs use real disposable vaults, encrypted account/public/TXID stores, actual
guarded utilities and genuine submission-resolution permits. Eight scenarios cover
missing and unresolved journals, active capture, archival, identical capture after
same-process enrollment/mirror reopen, wrong selection, rejected root followed by
successful recapture, and an unresolved sibling.

Public history and services are simulated. Each successful witness capture makes
two latest-root reads and two tip-root validations: at TXID opening and witness
restoration. It makes no page or chain-RPC request. The root-refusal control makes
one latest/root pair; other witness refusals make neither. Counters increment
before lifetime checks and refusal controls assert no hidden RPC/page attempt.
Each complete run records fourteen latest-root reads, thirteen root validations
and one setup page; chain RPC setup/resolution totals are recorded in the reports.
External transport attempts, unexpected RPC methods and live queries are zero.

The source history is deliberately empty: these runs qualify store/utility
composition, not the selected transaction's event coverage. Proof/signature and
chain observations remain structural/synthetic; unshield preimage validity and
independent path/root/finality acceptance are not established. The temporary clock
shift for journal archival and same-process reopen retain the prior capture
fixture's limitations. Wide source inventories bind versions, not code coverage.
Reports contain booleans and counts, never captured account records or selectors.

Next is fresh receipt/finality and source/path/root composition before ordered
post-transaction POI work. No new callback authority, renderer, IPC, dependency or
top-level architectural responsibility was introduced. After merging main `7a1a5c7c` in `74becfaf`, the frozen tree passes 9,481 tests /
33 skipped across 444 suites in 305.069 seconds with native-process access and
the existing OpenLV exclusion. Lint is clean and all 143 qualification source
hashes still match after the merge. Ant 0.5.56, freedom-ipfs 0.4.3, Myotis 0.1.12
and libradicle 0.7.1 installers were rerun; Arti 2.6.0 was rebuilt with the
already-installed Rust 1.99 toolchain after default Rust 1.88 failed its minimum
version check. Binary checks pass.
