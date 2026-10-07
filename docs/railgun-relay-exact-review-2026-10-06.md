# Exact unsigned Railgun transaction review — October 6, 2026

The new main-only `reviewRailgunAccountRelayIntent(account, owners, request,
review)` prepares and independently reconstructs an unsigned relay transaction,
then asks a trusted callback to review its exact contents while the original
account remains busy and its handoff remains reserved. This is an internal
technical contract, with no renderer, IPC or product flow.

A successful result records a local review only. It cannot authorize later
signing, proving, selected-note POI queries, reservation, persistence or sending.
A future spending path must bind its own fresh review to the actual admitted
operation. The older fee-only receipt and this plain result are not bearer
capabilities.

## Exact binding

The request remains the fixed note ID, original signed quote, bounded gas
parameters, maximum fee and active signal. Callers supply neither a draft nor a
verification receipt. The genuine account selects and binds its owned input,
verifies the quote and runs the existing separate construction/reconstruction
jobs before invoking review.

The callback receives a detached, recursively frozen summary and a cancellation
signal. The summary binds chain, proxy, token, wallet/self/peer public identities,
input/fee/self/cap amounts, exact gas arithmetic, quote hashes and absolute
expiry, required lists, selected note and checkpoint/generations. Separate
intent, draft and calldata digests bind the underlying transaction; the expected
public-input hash is joined to the second viewing process's reconstruction.
No raw draft, membership path, output randomness, signature or viewing secret is
passed to the callback. A domain-separated digest binds the summary itself.

The pure summary helper validates structural consistency. Genuine ownership and
reconstruction come from the account's original checks and its final
reattestation, not from constructing or copying a summary.

## Ownership and callback completion

Ordinary account reads, restore and competing operations refuse while review is
pending. Exact `true` accepts and exact `false` declines. Both outcomes recheck
identity, generations, snapshot evidence and clocks, inspect authenticated
wallet state again, revalidate the journal, compare owned data and summary
bindings, and only then publish the new read view. Decline returns no prepared
transaction and leaves the refreshed account usable.

The callback may return a boolean or a native promise resolving to a boolean.
The implementation observes the original promise using the captured intrinsic
method, ignoring caller replacements for `then` and `catch`. Arbitrary thenables,
truthy objects and boxed booleans are refused. Callback errors are sanitized.

Cancellation or expiry revokes eligibility immediately. The operation retains
its ownership until the original callback and admitted work settle; a late
approval cannot publish a result. A callback that never settles can keep close
pending indefinitely. It must not await its own enclosing operation or account
close, which would create a dependency cycle; it can request close and then
settle itself. These trusted callbacks are not sandboxed JavaScript.

If a malformed native promise's constructor or species prevents observation of
its original settlement, operation and close refuse with
`RAILGUN_RELAY_REVIEW_DRAIN_FAILED`. Busy, handoff and phase exclusion remain held
for the current process. This is not classified as an unknown utility exit and
does not falsely quarantine utility credentials. Neither timeout nor an
unobservable callback grants retry or establishes successful drainage.

## Deadlines and compatibility

The existing unreviewed preparation keeps its 90-second budget and initial
90–300-second quote margin. The reviewed variant requires 120–300 seconds on the
original quote, keeps preparation within 90 seconds, and permits at most 30
seconds for review and final reauthentication, with a 120-second overall cap.
Quote verification and the two viewing jobs retain their 15/30/30-second limits.
Both monotonic and wall clocks are checked after asynchronous boundaries; no
quote expiry is renewed. Timer bounds concern approval eligibility, not forced
completion of arbitrary callback code.

Post-review reauthentication adds local storage reads. It does not require
another viewing process, key loan or public snapshot refresh. The new summary
module joins the derived-wallet policy's source closure. This can require fresh
derived caches; existing reservations, capsules and submission journals retain
their original interpretation. No dependency or runtime pin changes.

## Validation boundary

All 447 focused tests in seven suites pass on the imported source, along with
strict repository lint and six-file formatting. Independent lifecycle and
summary/policy source reviews cleared the exact candidate. Source tests cover
accepted/declined results, exact summary fields and digests,
reentry, cancellation, late approval, state/identity/clock drift, original-promise
observation and retained exclusion. Distinguishing mutations exercise truthy
approval, early busy release, missing post-review authentication and leaked
handoff ownership. These use controlled owners and are not native evidence.

The [two-case native qualification](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-exact-relay-review-2026-10-06/README.md)
now passes at `98cbfd77`. Separate disposable accounts exercise accepted review
and close while the original review callback remains pending. Each uses the
actual engine, three original utility closures, two viewing-key loans, 84 broker
messages and ten synthetic header requests. Accepted review performs one final
wallet-state request/reply and one authenticated journal read; held close performs
none, refuses late approval and releases its genuine phase only after the
original callback and close complete. Both original Electron and launcher
processes exit naturally with zero; source/runtime/SQLite postchecks match.

The callback windows were approximately 0.222 and 0.468 milliseconds. These are
ordering checks, not sustained-hold or live-child cancellation evidence. Only
the accepted case compares protected encrypted files before close and checks the
unchanged owned projection; held-close storage invariance is unclaimed. Source
and outcome reviews are independent engineering checks, not a security audit or
an external cryptographic replay. The fixture adds 207 passing tests in five
suites, strict repository lint and six-file formatting to the separate 447-test
core scope above. Earlier unsigned native evidence remains pinned to `67612a75`.

The next connected slice is a durable relay operation with signing/proof recovery
and explicit handling of locally retained work, followed by uncertain handoff
and confined broadcaster transport. Preparation and diagnostic review stay
nonpersisting: ordinary previews must not create terminal holds or consume
lifetime reservation capacity. Shared holds will be integrated with their actual
operation owner and recovery path. Live qualification and UX remain separate.
