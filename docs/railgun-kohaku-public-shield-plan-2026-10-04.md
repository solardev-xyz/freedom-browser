# Railgun Kohaku public Shield implementation plan — October 4, 2026

This is an **unimplemented plan**, not a public Shield capability or new runtime
qualification. The current [Kohaku facade](../src/main/wallet/railgun-kohaku-plugin.js)
offers read and private-operation modes. Its
[private broadcaster](../src/main/wallet/railgun-kohaku-broadcaster.js) deliberately
does not accept public Shield operations. Implementation stays in the existing
main-process wallet boundary; renderer/IPC integration and user-facing UX remain
separate work.

## Compatibility and initial scope

The canonical local Kohaku checkout at
`tmp/privacy-build/pinned-inputs/kohaku` is pinned at
`6fdc248b3d28942d9aaa35c49c1ac76dab89dc0e`. Its locally inspected
[transaction feature interface](https://github.com/ethereum/kohaku/blob/6fdc248b3d28942d9aaa35c49c1ac76dab89dc0e/packages/plugins/src/base.ts)
defines `prepareShield(asset, to?) -> Promise<PublicOperation>`, and its
[shared types](https://github.com/ethereum/kohaku/blob/6fdc248b3d28942d9aaa35c49c1ac76dab89dc0e/packages/plugins/src/shared.ts)
define native assets as `{ __type: 'native' }` and amounts as `bigint`.
Its [broadcaster](https://github.com/ethereum/kohaku/blob/6fdc248b3d28942d9aaa35c49c1ac76dab89dc0e/packages/plugins/src/broadcaster/base.ts)
accepts `PrivateOperation`, not `PublicOperation`. These shapes support a narrow
compatible adapter; they do not establish generic Kohaku Host compatibility.

The first public lane should accept one positive native ETH amount and only the
enrolled recipient: omitted `to`, or exactly its genuine `instanceId`. Return a
frozen `{ __type: 'publicOperation' }` token privately bound to the issuing plugin
and genuine Shield controller. A separate main-owned public submitter should
consume that token; it must not use the private broadcaster or expose arbitrary
transaction signing. Names and facade configuration remain implementation choices.

The existing [pins](../src/main/wallet/railgun-shield-pins.json) and
[calldata policy](../src/main/wallet/railgun-shield-policy.js) restrict this to
Sepolia, at most **0.01 ETH**, with a pinned **25 bps** Shield fee. The exact
RelayAdapt operation wraps ETH and shields WETH; the resulting note value deducts
the integer-rounded protocol fee. Preserve these qualification caps. ERC20
approvals, arbitrary recipients, batches, arbitrary RelayAdapt calls, other chains
and mainnet are outside this slice.

## Existing implementation to reuse

- [Preparation](../src/main/wallet/railgun-shield-prepare.js) issues genuine,
  expiring receipts for exact calldata. Its
  [utility job](../src/main/wallet/railgun-shield-job.js) uses fresh ephemeral
  encryption material without wallet-secret, network or storage access.
- [Receiver verification](../src/main/wallet/railgun-shield-receive.js) uses the
  enrolled identity's viewing credential to check that the prepared note is
  recoverable by that account.
- [Deployment preflight](../src/main/wallet/railgun-shield-preflight.js) checks the
  pinned contracts and fee against a single RPC block. This is RPC consistency,
  not authenticated chain state or a guarantee against later governance changes.
- [The Shield operation](../src/main/wallet/railgun-shield-operation.js) combines
  these receipts with EOA-only funding, simulation, gas/nonce/balance review and
  single-use signing authority. The
  [transaction service](../src/main/wallet/transaction-service.js) and
  [transaction network](../src/main/wallet/private-transaction-network.js) enforce
  its genuine guard at signing and broadcast, with durable journal-before-send.
- [Restart recovery](../src/main/wallet/railgun-shield-recovery.js) reads the
  public-address submission journal independently of expired preparation receipts,
  matches the exact Shield event and requires reviewed, rechecked finality for
  resolution. [PPv2's public handoff](../src/main/wallet/ppv2-public-operations.js)
  provides a local precedent for issued, single-use public operations, not a reason
  to bypass Railgun's own controller.

## Required implementation gaps

1. **Propagate reviewed destinations.** The Shield operation currently constructs
   its deployment preflight and transaction network without the new destination
   restrictions. Add optional caller lifetime and protocol/transaction constraints;
   pass the protocol restriction through every permitted preflight attempt and
   permanently bind the transaction restriction to its transaction handle. The
   preflight already accepts `destinationConstraint`. Use the genuine
   [private-RPC constraint](../src/main/networks/private-rpc.js), covering hidden
   chain-ID, simulation, gas/nonce/balance and raw-send admission. Keep preview
   clients and restriction owners live until cleanup; never retry through an
   unrestricted replacement. Preserve existing unconstrained callers by default.
2. **Complete host lifetime handling.** Preparation and receiver verification
   currently lack caller-signal and explicit closure ownership; their broker and
   cleanup patterns predate the newer sticky-refusal hardening. Add permanent
   refusal, cancellation before further key/result admission, borrowed credential
   callback tracking, unconditional child-closure observation and sanitized
   cleanup failures. Add operation-level `closed` for owned work and review/signer
   callbacks. A child or callback that ignores cancellation retains ownership.
   Neither `rpc.release()` nor such a logical barrier proves physical socket drain.
3. **Use the shared account phase.** An adopted
   [account wallet](../src/main/wallet/railgun-account-wallet.js) already holds the
   [wallet phase](../src/main/wallet/railgun-account-phase.js). Close and await it
   before Shield jobs; claim the shared phase for preparation and receiver
   verification, retaining it through borrowed work and child closure. The gap
   between account closure and the new claim must use a genuine supported phase
   handoff or fail safely on contention, before starting Shield jobs; facade-local
   exclusion does not prevent an external controller from winning that claim.
   The specific phase remains an implementation choice. The existing phase API
   rejects handoff tokens for `recovery`: if using that phase, retain the wallet
   handoff through account closure, then release it and synchronously claim
   recovery before any utility starts. A competing owner must cause a zero-job
   refusal, not an unprotected continuation.
   Release the phase before human transaction review only after the new cleanup
   barriers prove owned work has settled, while retaining facade operation
   exclusion through settlement. Existing Shield-local busy sets are insufficient
   for directory-wide exclusion. Do not allow concurrent private preparation in
   this facade or release a successor's owner during stale cleanup.
4. **Add two bounded review boundaries.** Before admitting new Shield key work or
   RPC requests, review the public funding address, native amount, resulting WETH,
   own recipient, fee and exact destinations. Explicitly disclose that the
   transaction RPC receives the funding EOA, amount and exact RelayAdapt Shield
   calldata, including the encrypted note, through `eth_estimateGas` and `eth_call`
   before the later transaction review. Approving this first review permits those
   simulations, not signing or sending. This is a proposed review boundary, not a
   property of today's controller. Already-admitted work in the adopted account
   has its own drain obligation; a review callback or facade flag cannot establish
   zero traffic or release that work's phase. Then use the existing transaction
   review for exact calldata, gas, balance and nonce. Public preparation needs an
   engine archive, not private spend-prover configuration. Preserve the original
   nonrenewing preparation and deployment freshness limits; time spent reviewing
   must not renew authority.
5. **Issue and consume only genuine public tokens.** Bind each token to its exact
   plugin/controller and reject copies, cross-plugin use, reuse and expired owners
   before signing. Preserve acknowledged or journal-backed uncertain outcomes even
   when later cleanup fails; never turn an attempted send into permission to retry.

Shield does not require input-note selection, a retained-source snapshot, POI
services or private-spend proof machinery. Existing facade owner/currentness checks
can remain without adding source-coordinator queries to this lane.

## Fresh recovery review

Extend the restart recovery entry point with optional caller lifetime and a reviewed
transaction destination constraint. On restart, obtain a fresh genuine observation
and review; do not deserialize old WeakMap tokens or treat a stored URL as authority.
Keep recovery separate from operation preparation and do not silently reprepare or
resubmit an uncertain transaction.

An included transaction without the exact expected Shield event remains unresolved.
An accepted resolution still uses the existing finality and receipt rechecks, whose
chain evidence remains RPC-based. Wallet note ingestion requires a later explicit
scan/account refresh: resolving a journal entry does not itself establish an updated
spendable balance. Recovery closure should observe its own callbacks and requests;
it must not claim a physical transport barrier that the underlying API lacks.

## Sequenced implementation and qualification

1. Harden the two utility hosts and Shield operation lifetime/phase ownership;
   propagate constraints into operation and recovery while preserving legacy
   callers. Test malformed-then-valid broker traffic, late credential callbacks,
   cancellation, throwing cleanup, rejected closure and held child/review barriers.
2. Add the narrow Kohaku `prepareShield` capability and separate public submitter.
   Test exact native/self-recipient validation, fee/cap bounds, genuine token
   identity, reuse refusal, account closure before phase claim and no private
   broadcaster route. First-review denial must cause zero subsequent Shield
   traffic/key work/signing. On approval, assert exactly one `eth_estimateGas` and
   one `eth_call` with the expected Shield calldata before transaction review,
   with zero signatures and raw sends at that boundary. Transaction-review denial
   must still leave signing and raw-send counts at zero; it cannot undo the
   already-approved simulation disclosures.
3. Adapt the existing
   [Shield submission qualifier](../scripts/qualify-railgun-shield-submission.js)
   for an entirely offline run using disposable profiles and intercepted services.
   **Do not run it unchanged for this slice:** it currently performs live
   deployment RPC reads over Tor while simulating transaction RPC. Install
   fail-closed interception for both protocol and transaction RPC before wallet
   modules are imported, with no fallback to the real transport. Exercise real preparation,
   receiver verification, signing and journal persistence; same-host/different-path
   destination switches, hidden chain-ID and reentrant admission; uncertain send
   acknowledgment; and cold journal reopen with fresh recovery review. Assert
   journal-before-send, no automatic retry and ownership through outstanding work.
4. Run focused and relevant legacy tests, lint and the combined regression on the
   frozen implementation; inventory the exact native sources. Label mocked
   transport/service results separately from genuine utility, signing and encrypted
   journal evidence. Live or funded qualification is a separate decision, not
   authorized or performed by this plan.

No implementation, runtime test or new compatibility claim is supplied by this
document. Its validation is limited to source inspection and document formatting.
