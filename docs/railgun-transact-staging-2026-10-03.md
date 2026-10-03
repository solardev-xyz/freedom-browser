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
with the real witness normalizer; actual Transact staging integration is not yet
qualified.

The Codex reviewer identified a missing operation-selection check in the first
window assertion. The fix compares the actual selection and checkpoint. All five
changed-window regression cases fail if those assertions are removed and pass
with the correction. The reviewer approved the non-admitting slice with no
remaining blocking findings.

No live query, private signing, submission, dependency or renderer channel was
added. The controller composes existing main-owned account services rather than
moving key or storage responsibilities between processes.
