# Railgun Transact witness staging — October 3, 2026

The main-owned staging controller now performs the wallet → existing TXID
checkpoint → wallet handoff under a directory reservation. It captures the
original public identity, wallet generation and policies, exact request,
checkpoint and complete selected owned/received records before closing the
wallet. Each old phase is fully drained before the next starts.

TXID access uses checkpoint-only mode. The controller normalizes the selected
note witness against the captured TXID state and confirms that the entire
checkpoint remains unchanged after lookup. It carries immutable data, not the
closed TXID runner's receipt. After closing that phase, it reopens only the active
wallet with the original policy/generation and rederives the same complete note,
including amount, asset, nullifier and unspent status.

The opaque staging receipt binds the replacement account, owners and exact
request. Its static data remain valid only while caller/account/identity/
enrollment/coordinator lifetimes and selected-state bindings remain current.
Within an operation, assertion requires the actual window's selection and
checkpoint as well as its captured owned note. A transfer's staging cannot be
reused for an unshield window or a different destination/position.

No private-operation controller consumes this receipt yet. It is not accepted
creator provenance, fresh service-root evidence, POI or permission to sign. All
admission flags remain false; Transact spending is still refused. One-operation
consumption and composition with the independent verifier, creator receipt and
fresh root/POI gates remain next.

## Cancellation and failures

Intentional closure of the original wallet does not cancel staging. The caller's
signal and account-owner lifetimes do. If cancellation occurs during opening,
the controller awaits settlement, retains any returned handle before checking
cancellation, then closes and drains it. It starts no following phase and issues
no receipt. The acquisition deadline prevents later progress/admission; it is not
a promised end-to-end cancellation latency bound. Already-running opening work
may continue until settlement.

A refusal reports whether the original account is still reusable; this becomes
false before closure starts. Normal failures drain temporary resources before
releasing the reservation. An explicit cleanup failure preserves exclusion
instead of silently unlocking the account. On success, the caller owns the
replacement wallet; closing the staging receipt alone revokes its evidence.

## Validation

Twenty-two staging cases and 157 related tests across five suites pass; lint is
clean. Tests cover altered restored note/generation/checkpoint, mismatched TXID
state, foreign receipts/owners/requests, late opening cancellation, failed drains
and exact operation-window binding. They use controlled account/phase handles
with the real witness normalizer. The actual enrolled qualification below now
checks their composition against synthetic history.

The Codex reviewer identified a missing operation-selection check in the first
window assertion. The fix compares the actual selection and checkpoint. All five
changed-window regression cases fail if those assertions are removed and pass
with the correction. The reviewer approved the non-admitting slice with no
remaining blocking findings.

No live query, private signing, submission, dependency or renderer channel was
added. The controller composes existing main-owned account services rather than
moving key or storage responsibilities between processes.

## Actual enrolled qualification

The [October 3 report](qualification/railgun-transact-staging-enrolled-2026-10-03.json)
records 19 existing recovery runs and 129 matching before/after source hashes.
The new staging slice takes 3,788 ms in this single local measurement. It creates
and closes an actual encrypted enrolled TXID mirror, then uses checkpoint-only
staging to restore its one-row witness and reopen the same owned note. One real
A callback captures the authenticated creator prefix and invokes the detached
pinned-engine verifier; utility exit is observed before returning refusal. The
window and creator receipts refuse after the callback's lifetime.

Four independently revocable simulated public-service instances supply five
latest-root observations, one row page and four root validations. The history is
a separate derived copy of the existing public-test-mnemonic vector, adding an
unrelated synthetic Nullified event to its owned Transact creator. Original and
derived input hashes are recorded. The added nullifier is distinct from every
owned note's derived nullifier; prior balances and recovery cases still pass.
This constructed history does not demonstrate a valid on-chain spend. The
original generator's guard report describes only the original source generation.

The row's boundParamsHash and timestamp are synthetic choices, not independently
authenticated creator facts. Bound-parameter verification, global TXID
completeness and spending admission remain false. Public root acceptance is
simulated; creator authentication means the retained source prefix, not consensus
or independently verified chain completeness.

Pre-dispatch guards record zero staging signer launches, spending-key requests,
external transports and non-header/log RPC attempts. These counts apply to the
new slice: surrounding existing qualification cases still sign and prove with
public synthetic test keys. No live service, owned-note POI disclosure or
submission is performed anywhere in this run.

The Codex reviewer identified fixture identity/result-shape mistakes and guard/
cleanup gaps, which were corrected before the successful frozen-source run.
Consumer module caches are isolated without replacing authority singletons;
cleanup attempts every handle and unconditionally revokes fixture services and
restores exports/caches. Lint passes. The production controller still refuses
Transact inputs; one-operation consumption, fresh operation-root/POI evidence and
signing-gate composition remain next.
