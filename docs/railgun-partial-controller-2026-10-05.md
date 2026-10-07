# Protected internal partial withdrawal — October 5, 2026

The internal Railgun controller now admits bounded partial WETH withdrawals through
the existing enrolled wallet, independent change check, input POI, anchored
preflight, durable reservation, one-use signer and separate proof verifier.
The Kohaku facade still accepts full-note operations only. Partial submission,
post-spend recovery and durable combined POI admission remain closed.

This extends existing main-process wallet responsibilities. No renderer, IPC,
dependency, runtime/artifact pin or derived-cache policy input changed. Main
`dbfd0e7d` is still current and already merged; its prior explicit node refresh
remains applicable. This checkpoint does not refresh the older full regression.

## What the controller checks

The selected recovered note supplies input value V. The request supplies gross
withdrawal U, with `0 < U < V`; change C must equal `V - U`. The public recipient
remains the enrolled qualification EOA. A separate viewing-only job decrypts the
original change ciphertext, verifies its self note public key, WETH/value/hash,
Change annotation, null sender randomness and absent memo, and checks the final
unshield preimage. Its digest and all three amounts must match the controller's
offer before input POI or nullifier queries.

Preflight snapshots the kind before asynchronous work, loads `01x02`, and compares
the anchored `getVerificationKey(1, 2)` result before checking the selected
nullifier. Only partial observations contain `intentKind`; the controller checks
its exact presence and value initially and at every signing gate. Legacy
observations retain their exact bytes.

The durable sequence remains reserve, store original capsule, mark signing,
re-attest, issue the one-use signing permit, save signature, prove, independently
verify, save proved calldata. Failure after attempting the signing transition
retains the input. The receiver now also drains borrowed credential work and the
child even when close throws. An unobservable child exit keeps that identity's
receiver unavailable; a fresh identity/application lifetime is needed rather
than admitting another child over an uncertain one.

## Connected native evidence

The committed [native report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-partial-controller-native-2026-10-05.json)
comes from `scripts/qualify-railgun-partial-controller.js`, final run D, **21,678 ms**.
Its **522 source/test/fixture hashes** remained unchanged throughout the run.
The disposable public-mnemonic history is replayed above the POI launch block
through the real public scanner and wallet scanner. The selected input is a
genuinely recovered Shield note. The real account-POI source, signature parser,
membership verifier, preflight, RPC client and their capability registries run.

- A mismatching viewing credential refuses at `receiver`, before POI. This is a
  credential/order control, not a native malformed-change-content test.
- A corrupted list Merkle path refuses at `poi` through the actual Poseidon job.
- A `01x01` verifier returned to the actual `(1, 2)` query refuses at `preflight`.
- All three refuse with no spending key, selected-nullifier query or durable
  reservation/capsule change, and no unexpected fixture transport failure.
- The healthy run queries `(1, 2)` and then exactly one selected nullifier. One
  spending key is delivered after the durable signing state is observed. Actual
  A proving and fresh C verification both exit successfully. Four receive jobs
  run overall; the deliberate credential mismatch is the one expected failure.
- A duplicate refuses before services or another key. The signed version-2
  capsule and proof remain readable under a real recovery receipt, including
  after vault lock/unlock and identity/enrollment reopening from encrypted disk.
  This is same-process reopening, not a fresh-application restart or unfinished
  proof resumption.

The process launcher is instrumented for key delivery, wiping and child-exit
evidence. It deliberately corrupts one disposable receive credential. Network
registry, Tor availability and transport are fixtures; there are no real sockets.
The public bytecodes and verification artifacts match pins, but headers, getters,
list acceptance and roots are simulated. An ephemeral Ed25519 service key replaces
the list key for the fixture. These checks do **not** establish live deployed-key
equality, live POI eligibility, Tor operation, broadcast or a funded private spend.
The staged received-Transact controller path has unit coverage here, not a
connected native run. Earlier standalone crypto evidence is separately scoped.

Diagnostic runs A–C exposed a missing `release(handle)` method in the fake
transport. Real preflight cleanup threw, so the controller conservatively kept
the signed operation unfinished. Correcting the fixture's release contract made
D pass; no production safeguard was weakened. Only D is qualification evidence.

## Validation

Final focused regression: **689 tests across 13 suites passed in 157.921 seconds**;
`npm run lint` passed. The [qualification index](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-partial-controller-2026-10-05.json)
records all changed JavaScript hashes, the native report hash and local evidence
hashes. The exact test command was:

```sh
npm test -- -- --runInBand --runTestsByPath src/main/wallet/railgun-account-wallet.test.js src/main/wallet/railgun-identity.test.js src/main/wallet/railgun-private-operation.test.js src/main/wallet/railgun-private-preflight.test.js src/main/wallet/railgun-private-receive.test.js src/main/wallet/railgun-private-receive-job.test.js src/main/wallet/railgun-private-results.test.js src/main/wallet/railgun-private-reservations.test.js src/main/wallet/railgun-transact-staging.test.js src/main/wallet/railgun-kohaku-plugin.test.js src/main/wallet/railgun-private-submission.test.js src/main/wallet/railgun-own-operation.test.js src/main/wallet/railgun-private-capsule-store.test.js
```

Earlier author checks passed 249 controller/account/storage tests in five suites,
122 receiver tests in three suites and 52 preflight tests. These overlap the final
689 and are not additional coverage counts. The first umbrella had 686 passes
and one obsolete capsule-store assertion that partial holds must refuse. It was
replaced with genuine partial reservation/signature/recovery persistence and
copied/foreign receipt refusal tests: all three pass and are included in the
final umbrella.

Detached in-memory controller mutations distinguish the checks: 11 baseline
controls pass, removing V/U/C comparisons produces three intended failures, and
removing the repeated kind assertion produces two. Preflight mutations produce
two failures for mutable kind selection, one for omitted artifact-variant binding,
and four for a `(1, 1)` getter. These are unit-boundary controls, not native
cryptographic failures. The exact historical reservation reader control passes
one test; extracted source SHA-256 is
`7ae97c148320787afe3d63b226573557efbfc4975c90ac1e862d34bf41c195c5`.
The old-reader control preserves ciphertext, floor and directory inventory on
refusal, then a current reader successfully reopens both entries.

## Compatibility and remaining work

Reservations retain document version 2 with an additional closed kind. An exact
reader extracted from parent `8682764e` opens legacy data, then refuses the entire
mixed reservation file after a partial entry exists, without modifying its
ciphertext, floor or inventory. A current reader reopens both entries. Older
builds cannot use that reservation store, including its legacy entries; this is
a downgrade limitation, not a migration. Current capsule tests use real reserve,
put, signing and recovery receipts instead of inserting structural records.

The facade's partial-amount refusals and reviewed production importers are
regression-tested. There is one production proving caller, the Kohaku facade;
the internal controller is not exposed through a new IPC or renderer path.

Next: qualify staged received-Transact input through this real controller; add
production recovery for signed-but-unfinished proofs; connect partial submission
and exact own-operation capture; then persist/disclose both combined POI outcomes,
scan the actual change, restart and spend that change. Facade activation follows
that connected lifecycle. Live service eligibility and funded private tests remain
separate requirements for Railgun to reach PPv2 parity.
