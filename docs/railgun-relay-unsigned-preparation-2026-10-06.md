# Railgun unsigned relay preparation — October 6, 2026

The internal wallet can now construct a fee/self relay draft from a genuine live
account, then reconstruct the serialized result in a second viewing-only utility
process. This is a source and unit-test milestone. Native qualification of this
new composition is the next step; prior public-vector and local-review runs do
not qualify it.

The result is deliberately unreviewed and kept in memory. It grants no signing,
proving, POI-query, reservation, durable-capsule or relay-send authority. The
existing local fee-review receipt is not accepted as approval of this draft.

## Account and process ownership

`prepareRailgunAccountRelayIntent(account, owners, request)` accepts only an
issued live account and its exact identity, enrollment and coordinator owners.
Completed-only accounts refuse. The request contains a selected note ID, exact
signed quote, bounded legacy gas values, maximum fee and an active native signal.
Caller data is detached before suspension; accessor-backed or proxy signals are
refused without invoking them.

The account holds its busy latch and one phase handoff across the entire
operation. Quote admission captures the original input, checkpoint, identity,
public and wallet generations, policy and view. These are checked again after
each asynchronous boundary. Quote signature verification runs through the
existing fixed public-only verifier. Its returned peer keys become the draft's
recipient keys; the caller does not supply trusted peer keys.

The quote starts with 90–300 seconds remaining. The composite has a 90-second
monotonic budget, quote verification a 15-second budget and each wallet job a
30-second budget. Construction and reconstruction require at least 60 and 30
seconds of quote lifetime respectively. Wall-clock rollback, cancellation or
expiry refuses the operation. Cancellation still waits for the original work
and process/storage barriers; a timeout does not prove worker exit.

One public snapshot contains both jobs:

1. `relay-prepare` restores the viewing wallet and constructs two ordered outputs:
   the quoted broadcaster fee, then the remaining value to self. It serializes
   canonical calldata with a zero proof, original quote/gas context, input
   membership path and expected commitments/hash. Main independently joins that
   draft to captured ownership, value, token, nullifier, checkpoint and fee cap.
2. The first opaque coverage receipt is consumed before another restore starts.
   No intermediate journal attestation or read view is published.
3. `relay-reconstruct` starts a fresh utility, restores the wallet again and
   parses only the canonical serialized draft. It recomputes input membership,
   nullifier and hashes, decrypts both outputs in the sender direction, and
   checks fee/self recipients, amounts, source annotation, commitments and
   blinded viewing keys. It generates no replacement outputs or ciphertext.
4. Main compares the second owned read, coverage and wallet state with the
   original, revalidates the journal, then publishes the new receipt and view
   without another suspension.

Snapshot evidence changes during this operation. The original token is valid
before entry; inside the callback only its live snapshot can be checked; after
return, only the newly issued token can be used. The coordinator refuses token
assertion while busy and invalidates the previous token on entry. Its public
header refreshes still run before and after the callback; viewing-only does not
mean that the whole operation performs no public chain reads.

Both wallet jobs use one viewing-key loan each and the fixed relay entrypoint.
Binary-key admission requires the private-account context, engine role and
pinned Sepolia deployment. Each original utility must close with exit 15,
without escalation or peer disconnect. The generic non-binary process interface
retains its existing contract. New relay inputs/results are refused by legacy
wallet job routes, and existing private-signing schemas refuse the relay kind.

## Caller-visible lifecycle contract

Successful preparation supersedes the previous account read view, as an ordinary
restore does. Callers use the returned/current view rather than retaining the old
one. There is no new renderer or IPC surface.

A clean refusal before requesting a public snapshot, including an invalid quote,
releases the handoff and leaves the borrowed account usable. Once the snapshot
callback is entered, any refusal closes the caller's account. This includes
checkpoint or store-freshness failures before the first wallet job: the
coordinator has already invalidated the original snapshot evidence. Cancellation
after entry follows the same rule. The coordinator can also close itself when
its snapshot attempt fails, including before callback entry; the account follows
that aborted signal. Callers must not assume the borrowed coordinator remains
usable after a failed snapshot attempt.

If original quote or wallet worker exit cannot be observed, exclusion and
credential quarantine remain held for the enrollment in the current process.
Opening another account on it must refuse until process restart. Neither a
rejected promise nor a timeout releases uncertain exclusion.

## Validation and scope

Focused tests exercise canonical calldata/fee arithmetic, ownership joins,
actual ABI hashing, sender recovery with explicit engine mocks, fixed key/job
admission, alias resistance, close/drain behavior and original-receipt ordering.
Distinguishing controls cover widened job budgets, premature exit observation,
request aliasing, missing input binding and identity revocation during the final
awaited state inspection. Coordinator tests also enforce its busy window, token rotation and snapshot-signal
revocation. These are unit/source checks, not native cryptographic evidence for
the new account flow.

The explicit wallet policy now covers all 40 local dependencies in the job and
host-validation closure, including the seven relay modules. Source changes rotate
the derived-cache policy. Existing reservations, signed capsules and submission
journals retain their original interpretation; this change provides no migration
or funded-profile qualification. No dependencies, runtime pins, UI or IPC change.

The broader Railgun/Kohaku regression passed 8,752 tests in 180 suites (four
tests and one suite skipped), with a natural zero exit. This run preceded the
final snapshot-token correction; the final affected account/coordinator/journal/
coverage/relay suites then passed 429 tests in six suites, also with a natural
zero exit. Strict whole-repository lint and changed-JavaScript formatting pass.
The broad suite was not rerun after that bounded correction. Independent
engineering review found the coordinator-token bug and the final identity-check
await gap; both were corrected with distinguishing tests. This is not an
external security audit.

The dependent fixture/qualifier regression then passed all 1,434 tests in 67
suites. Its first run exposed two stale test declarations from the earlier quote
review work: a missing provider-import inventory entry and a missing optional
probe variable in an extracted-function VM context. Both declarations were
corrected; no runtime behavior changed for those repairs. The failed first run
is retained separately from the successful rerun.

## Remaining work

First qualify the complete flow with a disposable enrolled account, real engine,
separate observed utility exits and unchanged authenticated storage. Then add a
fresh review bound to the exact prepared transaction, broadcaster, fee cap/net
amount, quote and draft digest before any private operation authority.

Shared input reservations, authenticated durable relay recovery and uncertain
attempt handling come next, using the existing tree/nullifier reservation ledger.
Confined transport, specifically authorized live service tests, generic Kohaku
Host support and product UX remain separate work. A structural draft digest or
successful local reconstruction does not establish operator trust, sufficient
real-world gas payment or deployed broadcaster acceptance.
