# Private RPC destination restrictions — October 4, 2026

Commit `dd6a3ca8` adds a main-owned restriction that keeps later RPC clients on
the destination observed earlier in an operation. It supports the connected
Railgun Kohaku preparation and submission work. The restriction itself grants
neither user consent nor permission to call additional RPC methods.

## Contract

`createPrivateRpcDestinationConstraint({ observation, signal, deadline })`
requires a genuine current destination observation. It returns an opaque token,
an abort signal and a close function. The token binds the normalized URL, profile,
RPC role and subject identity. Operation labels may differ between controller
stages; the underlying subject identity may not. No URL is exposed on the token.

The monotonic deadline is fixed at creation and cannot exceed 900 seconds.
Closing the restriction, revoking its original observation, changing the Tor
endpoint or reaching the deadline revokes derived clients. The originating
preview scope must therefore remain alive throughout the operation.

`createPrivateRpc(handle, role, { destinationConstraint })` validates that
binding before construction and on subsequent activity checks. A final check
after transport construction and request serialization catches synchronous
revocation before transport admission, including the implicit chain-ID request.
Existing method restrictions and read-budget checks still apply.

`getPrivateTransactionNetwork(handle, { destinationConstraint })` retains the
first restriction before attempting client construction. Later calls that omit
the option inherit it, including calls from the transaction service and nested
exit-recovery transaction reads. Failure of the first construction cannot turn
an omitted retry into an unrestricted client. Explicit invalid tokens also leave
that handle refused. A different token, or retrofitting a restriction onto an
existing unrestricted client, is refused; use fresh operation handles.

An endpoint mismatch admits no request to that endpoint. It does not destroy an
otherwise current restriction: a later client selecting the original destination
may still use it. This is a reusable restriction, not a one-use consent receipt.
The higher-level operation is responsible for its own failure and retry policy.

## Cancellation and uncertainty

Expiry revokes already admitted work as well as future admissions. If a transport
ignores cancellation, the caller still observes its original pending response
before refusing it. This does not prove that a remote service received nothing.
An attempted transaction must retain its durable uncertainty and must not be
automatically resent because the restriction expired.

The helper does not establish physical socket drainage, Tor circuit isolation,
RPC response correctness or trusted chain state. Separate cold recovery handles
are not retrospectively covered by an earlier operation's restriction; they need
their own destination review. Legacy callers that supply no restriction keep
their existing behavior.

## Qualification

The three focused suites pass 191 tests: private RPC, private RPC read budgets,
and private transaction networking. Full lint passes. Coverage includes genuine
contexts, forged/copied tokens, role/profile/subject mismatches, registry changes,
preview revocation, expiry, reentrant construction/serialization, sticky failed
construction, inherited transaction-service clients and legacy behavior.

Two independent in-memory mutation controls establish that the regressions detect
the intended failures without changing repository files:

- Removing the last admission check makes two tests fail because an unwanted
  transport call occurs after revocation.
- Moving the handle binding after construction makes six tests fail because an
  omitted retry can build an unrestricted client after the first build fails.

These are controlled transport tests, not live egress or funded-wallet evidence.
The connected Kohaku controller and native qualification results belong to their
own milestone; this lower-layer result alone does not establish those joins.

```sh
npm test -- -- --runInBand --runTestsByPath src/main/networks/private-rpc.test.js src/main/networks/private-rpc-read-budget.test.js src/main/wallet/private-transaction-network.test.js
npm run lint
```
