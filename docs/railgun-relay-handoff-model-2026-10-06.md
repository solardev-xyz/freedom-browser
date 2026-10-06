# Railgun relay handoff: executable design model

The [handoff model](../scripts/fixtures/railgun-relay-handoff-model.js) and its [tests](../scripts/fixtures/railgun-relay-handoff-model.test.js) make the proposed single-attempt relay lifecycle executable. They validate admission ordering and cancellation races using fake ports. The reviewed source is committed at `49cf9e5e`. It introduces no production relay controller, spending authority, durable storage or network transport.

The model follows the [relay integration plan](railgun-relay-integration-plan-2026-10-06.md). Its design was grounded in fourteen pinned local/upstream source files, including the existing [write-before-send path](../src/main/wallet/private-transaction-network.js), [PPv2 handoff](../src/main/wallet/ppv2-relay-handoff.js), and [original-promise recovery ownership](../src/main/wallet/railgun-kohaku-recovery.js). Those are design references, not an execution-coverage inventory.

## Tested contract

Admission latches before calling either fake authority callback. Even a failed currentness check consumes this model object. Currentness is checked after callbacks and after claim, so synchronous reentry or callback-triggered closure cannot admit another attempt or send after closure.

The model snapshots request, key, message and decoded-result data across awaits. It begins the fake journal before sending and conservatively records uncertainty from that boundary, including a journal that commits and then throws. Failure or cancellation does not establish remote nonexecution or permission to retry; the model implements no expiry check.

The caller receives the original send promise and its original value/error. The response wait is separate: transport success is not a broadcaster acknowledgement, and acknowledgement is not canonical chain inclusion. Pending work is registered before invoking journal or decoder callbacks.

`close()` refuses new admissions and message intake. `closed` waits for the original send, admitted callbacks and fake subscription cleanup. A decoder completing after close cannot start persistence; acknowledgement persistence already started may finish and is drained. Cleanup rejection remains observable through the original `closed` promise, which also has an internal rejection observer. Borrowed owners are not closed. This models logical ownership, not physical transport shutdown or remote cancellation.

## Checks and review

The root replay passed **30 tests in one suite**, naturally exiting zero in **0.294 seconds**. Tests hold original promises across closure, exercise journal ambiguity and synchronous reentry, distinguish operation-local fake keys, reject duplicate/malformed/late replies, and simulate restart with retained uncertain records. One strict-unhandled-rejection Node subprocess tests delayed observation of synthetic cleanup failure; no Electron qualifier, crypto or service runs in this suite.

Eleven separately retained detached mutants each fail their named assertion: early send, dropped original-send retention, cross-key acceptance, late callback write, resend on error, aliased input, repeated admission, late admission latch, missing post-claim check, checking closure only before the currentness callback, and missing internal cleanup-rejection observation. These controls were run in scratch; they are not additional checked-in test cases.

Root and Claude review found the admission reentry and callback-close ordering gaps in the first revision. The corrected r2 also handles malformed send-promise accounting and observes cleanup rejection without replacing its public promise. Claude cleared the exact r2 source and evidence. Scratch checks and the root replay both passed strict lint without warnings and explicit two-file formatting. The import preserves the reviewed two source files; this milestone does not claim a full regression or native relay run.

Reproduce the checked-in suite with:

```sh
npm test -- -- --runInBand scripts/fixtures/railgun-relay-handoff-model.test.js
```

## Limits and next steps

Authority functions, the permit and journal are fake. The journal is an array, keys are public labels, and decoding compares labels. Wrong-key input must return `{ authenticated: false }`; a thrown decoder error instead ends the wait uncertain. A rejected send also deliberately ends the response wait and drops later valid replies. Neither choice permits another send or releases the uncertain record.

Restart tests copy primitive records. A fresh explicit admission performs a fresh fake claim before duplicate history refuses transport; no token or key is rehydrated. This does not authenticate storage or bind a genuine production permit to a durable attempt. Controlled inputs and ordinary native promises are assumed; hostile promise subclasses, real cryptographic error classes, quote expiry, conflict diagnostics and transport-negative-ack mapping remain outside this model.

The next integration requires genuine owner/operation authentication and a permit bound to the reviewed intent, proof, peer and durable attempt; an authenticated versioned relay journal with explicit crash/reconciliation semantics; and an operation-local Waku transport with reviewed destinations, key retention and observable cleanup. Existing production policies remain unchanged. These tests authorize no live discovery, owned-note/POI disclosure, funded spending, automatic retry or production activation.
