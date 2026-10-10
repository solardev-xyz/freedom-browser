# Private RPC read budgets — October 4, 2026

The RPC prerequisite is implemented, independently reviewed and qualified against
the combined tree, including the latest main watchdog integration.

## Purpose and boundary

Railgun validation needs an operation that can stop further network admission
without closing a healthy shared RPC client. Checking an abort signal only before
`client.request()` is insufficient: that call can await the client's shared lazy
chain-ID check and send its requested method later. The budget therefore lives in
the existing main-process private RPC module, immediately beside transport
admission. No process boundary, dependency, IPC or UI is added.

The new budget is a restriction on an existing genuine client's authority. It
does not establish consent, endpoint trust, circuit isolation, chain correctness,
note ownership or permission to spend. Source/coordinator integration remains a
separate prerequisite. Existing callers without a budget retain their API.

## Contract

`createPrivateRpcReadBudget({ client, handle, destination, signal, deadline,
envelope })` accepts only genuine `protocol-rpc` clients and binds the exact
privacy handle and opaque
destination observation. Creation performs no network query. It returns an
opaque `budget`, operation `signal`, idempotent `close()` and `closed` promise.
`client.request(method, params, validate, budget)` accepts that token as its fourth
argument. Copied tokens and tokens belonging to another client cannot revoke a
healthy operation. Budgeted validators may be asynchronous and must resolve
strictly `true`; unbudgeted validation retains its existing behavior.

The deadline is an absolute monotonic time, at most 180 seconds after creation;
it never renews. Both an idle timer and admission-time checks enforce expiry.
Request parameters and the closed envelope are detached before awaiting the
chain check. The envelope permits at most five exact canonical header selectors,
each up to four times; one exact address/from-block/to-block logs filter; and up
to 512 distinct numbered event-header admissions within a declared range. Exact
header allowances are consumed before overlapping event-header allowances.
The hidden chain-ID request is counted separately, only against its initiator.

Exhausted allowances, out-of-envelope methods and invalid caller parameters
produce terminal `admission-refused` outcomes without an integrity-failure claim.
Each actual transport attempt consumes its allowance even if it fails. There is
no budget retry, replacement endpoint, fallback or automatic allowance renewal.
The fixed envelope does not enforce source-level ordering, bind event heights to
returned logs, or replace header/log result validation; the source must retain
those checks when it adopts this primitive. In particular, the current source
passes `() => true` to private RPC and normalizes results afterwards. The future
budgeted path must perform its actual result-schema validation inside the awaited
validator, so cancellation cannot skip malformed-header/log detection between
RPC completion and source normalization.

## Shared startup and cancellation

The shared chain-check entry is installed before transport initialization can
reenter the client. If its initiating operation becomes invalid before transport
admission, all current joiners receive a terminal authenticated no-admission
outcome. No replacement initiator is elected and no request is retried within
those operations. A subsequent explicit operation may use a healthy client.

Once admitted, shared chain work belongs to the client's lifetime. Cancelling one
operation stops that operation's later method admission but does not abort a
healthy sibling's chain check. The eventual response and chain ID are validated
even after local cancellation. Actual response/chain integrity failure remains
sticky in every joined budget; a cancellation-shaped public error cannot erase
it. Fatal outcomes distinguish `response`, `transport` and `revoked`. Only a
known response/schema/validator/chain failure sets `integrityFailure`; network
errors and owner/Tor revocation must not claim response corruption. Fatal state
takes precedence over local cancellation, and later response failure can upgrade
the recorded category. Legacy client cache reset is preserved separately from
terminal budget state. An unbudgeted caller joining a budget-initiated check that
ends without admission also receives the fixed budget refusal, with no retry.
That mixed-caller case is intentionally documented rather than silently issuing
a replacement query. When a legacy-started check has budgeted joiners, late chain
validation also precedes final revocation refusal; a wrong-chain reply after
revocation therefore reports chain mismatch to that legacy caller. Both paths
refuse the request.

`getPrivateRpcReadBudgetOutcome(budget)` returns a frozen bounded snapshot of
status, reason, fatal failure category, integrity failure, pending work and
admission counts. Reading an unfinished outcome checks currency and can finalize
expiry or record revocation; it is not a side-effect-free historical snapshot.
It remains
available for the genuine token after revocation, without exposing an endpoint,
request ID, account selector or response body. Callers must use this genuine
outcome rather than infer provenance from an error code or aborted signal.

`close()` stops admission immediately. `closed` waits for joined chain work,
admitted responses and result validators to settle; it never rejects. This is a
logical work barrier, not a socket-close guarantee or a hard cleanup deadline.
A validator that ignores cancellation can keep that barrier pending. The shared
transport and healthy sibling operations are not closed as a side effect.

## Qualification status

All 171 tests in four RPC/transaction-network/scan-source suites pass in 1.024
seconds, including 104 new budget cases; existing tests are unchanged. Lint is
clean. Eleven selected control cases pass with the real implementation. Removing
the pending-work barrier causes one failure; removing the deadline check causes
one direct extra-request failure; bypassing the validator-result check causes
two failures; disabling category upgrades causes six failures. These four
controls use a temporary transform and do not mutate the
production tree.

Independent [Node](qualification/private-rpc-read-budget-node-2026-10-04.json) and
[Electron](qualification/private-rpc-read-budget-electron-2026-10-04.json) fixtures
pass 17 groups each with four matching source hashes in 43/54 ms. Each run records
537 synthetic transport requests, including the deliberate 512-header boundary
case. They cover no-query creation/close/expiry, pre-dispatch reentrancy, shared
chain cancellation and failure, detached parameters, validator entry and drain,
copied tokens, overlapping quotas, per-height limits and late response/transport
failure upgrading owner revocation. The qualification fixture uses genuine
privacy contexts and private RPC with simulated registry, Tor endpoint and
transport. It does not qualify live Arti, physical socket closure, funded accounts
or live disclosure permission.

Compatibility reruns exercise the unbudgeted callers through actual private RPC
with simulated transport. Source [transfer](qualification/private-rpc-budget-source-transfer-2026-10-04.json)
and [unshield](qualification/private-rpc-budget-source-unshield-2026-10-04.json)
each pass six existing plus three destination groups with 140 matching hashes in
1,929/2,134 ms. Receipt [transfer](qualification/private-rpc-budget-receipt-transfer-2026-10-04.json)
and [unshield](qualification/private-rpc-budget-receipt-unshield-2026-10-04.json)
each pass nine existing plus seven prepared-reader groups with 146 matching
hashes in 2,332/2,108 ms. Fixtures use disposable enrollments and encrypted stores;
public chain/history observations remain simulated. Their parallel timings are
observations, not latency guarantees. Results match the previous source/receipt
reports apart from timestamps, source hashes and the run-specific source
checkpoint hash reflecting a fresh disposable generation.

Claude reviewed the frozen implementation, tests, documentation and native
fixture, including the correction distinguishing response corruption from
transport failure and revocation. Codex supplied implementation and an independent
fixture review. This is engineering review, not a security audit.

Full combined regression passes 11,994 tests / 33 skipped across 483 passing
suites (five skipped) in 406.285 seconds, with native access and the existing
OpenLV exclusion. Source and tests remained frozen during the run. This also
covers main's watchdog merge and the private-context diagnostics follow-up.
No public/TXID policy input is modified by this RPC prerequisite.

No funded profile is opened or rebuilt by this slice. The previous source
policy-generation migration limitation remains in effect. The completed-only
source/coordinator cancellation path and trusted-main POI controller remain open.
